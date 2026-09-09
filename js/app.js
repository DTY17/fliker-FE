const API_BASE = 'http://localhost:8080'; // same-origin as the Spring Boot app, e.g. '' or 'http://localhost:8080'
let USING_DEMO_DATA = false;

// ---- session (persisted to localStorage so the login survives a refresh) ----
const SESSION_KEY = 'flicker_session';
let session = { user: null, token: null };

function persistSession(){
  try{ localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }catch(e){ console.log(e)}
}
function loadPersistedSession(){
  try{
    const raw = localStorage.getItem(SESSION_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && parsed.token && parsed.user) session = parsed;
    }
  }catch(e){ /* ignore corrupt/blocked storage */ }
}
function clearPersistedSession(){
  try{ localStorage.removeItem(SESSION_KEY); }catch(e){ /* ignore */ }
}

// ---- app state ----
let state = {
  view: 'home',
  query: '',
  page: 1,
  pageSize: 12,
  sort: 'relevance',
  filters: { genre: new Set(), type: '', country: '', yearMin: '', yearMax: '' },
  watchMovieId: null,
  authMode: 'login',
};
let watchReturnState = null;

let ALL_MOVIES = [];
let MOVIE_COMMENTS_CACHE = {};

const DEMO_CLIPS = [
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
];

// ---------------- demo data ----------------
function buildDemoMovies(){
  const seeds = [
    ["The Salt Mile","2023","USA","Drama","Movie"],
    ["Nine Red Doors","2022","South Korea","Thriller","Movie"],
    ["Paper Kites","2021","Japan","Animation","Movie"],
    ["Low Tide","2024","UK","Drama","Movie"],
    ["Static & Bone","2020","USA","Sci-Fi","Movie"],
    ["The Long Recess","2019","France","Comedy","Movie"],
    ["Harbor Season","2023","Canada","Series","Series"],
    ["Glasswing","2024","Spain","Fantasy","Movie"],
    ["Midnight Ferry","2018","Norway","Thriller","Movie"],
    ["Copper & Ash","2022","Germany","War","Movie"],
    ["The Quiet Ward","2021","USA","Horror","Movie"],
    ["Blue Hour Diner","2023","USA","Romance","Movie"],
    ["Sundown Motel","2020","Mexico","Horror","Series"],
    ["Wolf Weather","2024","Sweden","Drama","Movie"],
    ["The Cartographers","2017","Italy","Adventure","Movie"],
    ["Neon Orchard","2022","China","Sci-Fi","Movie"],
    ["Six Degrees North","2019","Iceland","Documentary","Movie"],
    ["Paper Crown","2023","India","Drama","Movie"],
    ["The Last Reel","2016","USA","Drama","Movie"],
    ["Ordinary Ghosts","2024","Ireland","Fantasy","Series"],
    ["Salt & Static","2021","Australia","Thriller","Movie"],
    ["Tin Can Serenade","2020","Brazil","Comedy","Movie"],
    ["The Frost Line","2022","Finland","Drama","Movie"],
    ["Departure Gate","2023","USA","Action","Movie"],
  ];
  return seeds.map((s,i)=>{
    const id = i+1;
    return {
      id, name:s[0], year:Number(s[1]), country:s[2], genre:s[3], type:s[4],
      poster:`https://picsum.photos/seed/flicker${id}/500/750`,
      backdrop:`https://picsum.photos/seed/flickerbg${id}/1400/800`,
      videoUrl: DEMO_CLIPS[id % DEMO_CLIPS.length],
      synopsis: "A close, unhurried story that lingers on the small decisions its characters make when no one else is watching.",
    };
  });
}

// ---- auth expiry handling ----
// Any API call that gets a 401/403 back while we believed we had a valid token calls this.
// Guarded by checking session.token first, so if several requests fail around the same
// time (e.g. comments + users fetched in parallel), only the first one actually logs out.
async function handleSessionExpired(){
  if(!session.token && !session.user) return; // already signed out
  session = { user:null, token:null };
  clearPersistedSession();
  ALL_USERS_CACHE = null;
  ALL_MOVIES = [];
  MOVIE_COMMENTS_CACHE = {};
  state.authMode = 'login';
  render();
  showToast('Your session has expired — please sign in again.');
}

function maybeHandleAuthExpiry(res){
  if((res.status === 401 || res.status === 403) && session.token){
    handleSessionExpired();
  }
}

// ---------------- API helpers (real calls, demo fallback) ----------------
async function apiGetMovies(){
  try{
    const token = session.token;
    const res = await fetch(`${API_BASE}/api/movies`, {
      headers: {
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        "Content-Type": "application/json"
      }
    });

    if(!res.ok){
      maybeHandleAuthExpiry(res);
      throw new Error('bad status');
    }
    const data = await res.json();

    if(!Array.isArray(data) || data.length===0) throw new Error('empty');
    USING_DEMO_DATA = false;

    return data.map(m=>({
      ...m,
      poster: m.image || null,
      backdrop: m.image || null,
      videoUrl: m.url,
      synopsis: m.synopsis || '',
    }));
  }catch(e){
    USING_DEMO_DATA = true;
    return buildDemoMovies();
  }
}

// Normalizes whatever shape the backend returns into a plain array. Spring's Pageable
// endpoints commonly wrap results as { content: [...] } instead of a raw array — if we
// don't account for that, renderComments' .map() throws inside a .then() with no catch,
// which fails silently and leaves the UI stuck on "Loading comments…" forever.
function normalizeCommentsResponse(data){
  if(Array.isArray(data)) return data;
  if(data && Array.isArray(data.content)) return data.content; // Spring Page<T> shape
  if(data && Array.isArray(data.comments)) return data.comments;
  console.error('Unexpected comments response shape:', data);
  return [];
}

async function apiGetComments(movieId){
  try{
    const token = session.token;
    const res = await fetch(`${API_BASE}/api/comments/movie/${movieId}`, {
      headers: {
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        "Content-Type": "application/json"
      }
    });
    if(!res.ok){
      maybeHandleAuthExpiry(res);
      throw new Error(`bad status ${res.status}`);
    }
    const data = await res.json();
    return normalizeCommentsResponse(data);
  }catch(e){
    console.error('apiGetComments failed, falling back to local cache:', e);
    return MOVIE_COMMENTS_CACHE[movieId] || [];
  }
}

async function apiPostComment(movieId, text){
  const payload = { userId: session.user?.id ?? 0, movieId, comment: text, date: new Date().toISOString() };
  try{
    const res = await fetch(`${API_BASE}/api/comments`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        ...(session.token ? { "Authorization": `Bearer ${session.token}` } : {}),
      },
      body:JSON.stringify(payload)
    });
    if(!res.ok){
      maybeHandleAuthExpiry(res);
      throw new Error(`bad status ${res.status}`);
    }
    return await res.json();
  }catch(e){
    console.error('apiPostComment failed, saving locally instead:', e);
    const fake = { id: Date.now(), ...payload };
    MOVIE_COMMENTS_CACHE[movieId] = [fake, ...(MOVIE_COMMENTS_CACHE[movieId]||[])];
    return fake;
  }
}

async function apiDeleteComment(commentId){
  const res = await fetch(`${API_BASE}/api/comments/${commentId}`, {
    method: 'DELETE',
    headers: { ...(session.token ? { "Authorization": `Bearer ${session.token}` } : {}) }
  });
  if(!res.ok){
    maybeHandleAuthExpiry(res);
    throw new Error(`bad status ${res.status}`);
  }
  return true;
}

// Cached so we don't re-fetch the full user list on every comment render — cleared on logout.
let ALL_USERS_CACHE = null;
async function apiGetAllUsersCached(token, forceRefresh=false){
  if(ALL_USERS_CACHE && !forceRefresh) return ALL_USERS_CACHE;
  try{
    const res = await fetch(`${API_BASE}/api/users`, {
      headers: { ...(token ? { "Authorization": `Bearer ${token}` } : {}) }
    });
    if(!res.ok){
      maybeHandleAuthExpiry(res);
      throw new Error(`bad status ${res.status}`);
    }
    const users = await res.json();
    ALL_USERS_CACHE = Array.isArray(users) ? users : [];
    return ALL_USERS_CACHE;
  }catch(e){
    console.error('apiGetAllUsersCached failed:', e);
    return ALL_USERS_CACHE || [];
  }
}

// Login only returns a token, not the user's real id/name — but comments need a real
// userId to attribute correctly. We pull the full user list (same approach the admin
// site uses) and match by email so the comment shows their actual name, not "Member #X".
async function apiFetchUserByEmail(email, token){
  try{
    const users = await apiGetAllUsersCached(token, true); // fresh fetch at login time
    return users.find(u => (u.email||'').toLowerCase() === email.toLowerCase()) || null;
  }catch(e){
    console.error('apiFetchUserByEmail failed:', e);
    return null;
  }
}

async function apiLogin(email, password){
  const res = await fetch(`${API_BASE}/api/users/login`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password})
  });
  if(!res.ok) throw new Error('Incorrect email or password');
  const token = await res.text();
  const matchedUser = await apiFetchUserByEmail(email, token);
  const user = matchedUser || { email, id: 0, name: email.split('@')[0] };
  return { token, user };
}

async function apiSignup(name, email, password){
  const role = "USER"
  const res = await fetch(`${API_BASE}/api/users/signup`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, email, password, role })
  });
  if(!res.ok) throw new Error('Could not create that account');
  return await res.json();
}

// ---------------- util ----------------
function esc(str){
  return String(str??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function initials(str){
  return (str||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
}
function timeAgo(iso){
  if(!iso) return '';
  const d = new Date(iso); if(isNaN(d)) return '';
  const diff = (Date.now()-d.getTime())/1000;
  if(diff<60) return 'just now';
  if(diff<3600) return Math.floor(diff/60)+'m ago';
  if(diff<86400) return Math.floor(diff/3600)+'h ago';
  return Math.floor(diff/86400)+'d ago';
}
function showToast(msg){
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  setTimeout(()=>{ if(root.firstChild) root.innerHTML=''; }, 2600);
}
function go(view, params={}){
  state.view = view;
  Object.assign(state, params);
  render();
  window.scrollTo({top:0, behavior:'smooth'});
}
function submitSearch(){
  if(!session.user) return; // gate: nothing to search until logged in
  const q = document.getElementById('headerSearch').value.trim();
  go('search', { query:q, page:1 });
}
function snapshotState(){
  return {
    view: state.view, query: state.query, page: state.page, pageSize: state.pageSize, sort: state.sort,
    filters: {
      genre: new Set(state.filters.genre), type: state.filters.type,
      country: state.filters.country, yearMin: state.filters.yearMin, yearMax: state.filters.yearMax,
    },
  };
}
function goBack(){
  if(watchReturnState){
    Object.assign(state, watchReturnState);
    watchReturnState = null;
    render();
  } else {
    go('home');
  }
  window.scrollTo({top:0, behavior:'smooth'});
}

// ---------------- rendering: shell ----------------
function renderNavAuth(){
  const el = document.getElementById('navAuth');
  const searchShell = document.querySelector('.search-shell');
  if(session.user){
    el.innerHTML = `
      <div class="user-chip">
        <div class="user-avatar">${esc(initials(session.user.name||session.user.email))}</div>
        <span>${esc(session.user.name || session.user.email)}</span>
      </div>
      <button class="btn ghost small" onclick="logout()">Sign out</button>
    `;
    if(searchShell) searchShell.style.display = 'flex';
  } else {
    el.innerHTML = '';
    if(searchShell) searchShell.style.display = 'none';
  }
  document.getElementById('demoFlag').textContent = USING_DEMO_DATA ? '— showing demo data (API not connected)' : '';
}

function logout(){
  session = { user:null, token:null };
  clearPersistedSession();
  ALL_USERS_CACHE = null;
  ALL_MOVIES = [];
  MOVIE_COMMENTS_CACHE = {};
  state.authMode = 'login';
  render();
  showToast('Signed out');
}

// ---------------- shared media helpers ----------------
function movieById(id){ return ALL_MOVIES.find(m=>String(m.id)===String(id)); }

function tileGradientStyle(m){
  const hue = ((m.id||1)*47)%360;
  return `background:linear-gradient(135deg, hsl(${hue},34%,20%), hsl(${(hue+42)%360},40%,12%));`;
}

function posterMedia(m){
  if(m.poster){
    return `<img src="${m.poster}" alt="${esc(m.name)} poster" loading="lazy">`;
  }
  return `<div class="tile-fallback" style="position:absolute;inset:0;${tileGradientStyle(m)}">
      <div class="tile-glyph">${esc(initials(m.name))}</div>
    </div>`;
}

// ---------------- rendering: home ----------------
function posterCard(m){
  return `
    <div class="poster-card" onclick="openWatch(${m.id})">
      <div class="poster-frame">
        ${posterMedia(m)}
        <div class="play-hint"><div class="circle">▶</div></div>
      </div>
      <div class="poster-meta">
        <div class="poster-name">${esc(m.name)}</div>
        <div class="poster-year">${m.year} · ${esc(m.genre)}</div>
      </div>
    </div>`;
}

// Each rendered shelf gets a fresh, deterministic id (reset per renderHome call) so the
// nav-arrow buttons and scroll listeners below know exactly which row to control.
let shelfIdCounter = 0;

function shelfHTML(title, sub, movies){
  const id = `shelf-${shelfIdCounter++}`;
  return `
    <section class="shelf">
      <div class="shelf-head">
        <div>
          <h2 class="shelf-title">${title}</h2>
          <div class="shelf-sub">${sub}</div>
        </div>
      </div>
      <div class="shelf-scroll-wrap">
        <button class="shelf-nav prev" id="${id}-prev" onclick="scrollShelf('${id}',-1)" aria-label="Scroll left">‹</button>
        <div class="shelf-scroll" id="${id}">
          ${movies.map(m=>posterCard(m)).join('')}
        </div>
        <button class="shelf-nav next" id="${id}-next" onclick="scrollShelf('${id}',1)" aria-label="Scroll right">›</button>
      </div>
    </section>`;
}

function scrollShelf(id, dir){
  const el = document.getElementById(id);
  if(!el) return;
  const amount = Math.max(300, el.clientWidth * 0.85) * dir;
  el.scrollBy({ left: amount, behavior:'smooth' });
}

// Disables + hides an arrow once there's nothing left to scroll in that direction,
// and hides both arrows entirely if the row doesn't overflow (e.g. a short library).
function updateShelfNavButtons(id){
  const el = document.getElementById(id);
  const prev = document.getElementById(id+'-prev');
  const next = document.getElementById(id+'-next');
  if(!el || !prev || !next) return;
  const maxScroll = el.scrollWidth - el.clientWidth;
  const hasOverflow = maxScroll > 4;
  prev.style.display = hasOverflow ? '' : 'none';
  next.style.display = hasOverflow ? '' : 'none';
  prev.disabled = el.scrollLeft <= 4;
  next.disabled = el.scrollLeft >= maxScroll - 4;
}

function initShelfNav(){
  document.querySelectorAll('.shelf-scroll').forEach(el=>{
    updateShelfNavButtons(el.id);
    el.addEventListener('scroll', ()=>updateShelfNavButtons(el.id), { passive:true });
  });
}
window.addEventListener('resize', ()=>{ if(state.view==='home') initShelfNav(); });

function renderHome(){
  shelfIdCounter = 0;
  const newest = [...ALL_MOVIES].sort((a,b)=>b.id-a.id);
  const byGenreMix = [...ALL_MOVIES].sort(()=>0.5-Math.random()).slice(0,8);
  const feature = newest[0] || ALL_MOVIES[0];

  const app = document.getElementById('app');
  app.innerHTML = `
    ${feature ? `
    <section class="hero">
      <div class="sprockets">${Array(10).fill('<span></span>').join('')}</div>
      ${feature.backdrop
        ? `<div class="hero-bg" style="background-image:url('${feature.backdrop}')"></div>`
        : `<div class="hero-bg" style="${tileGradientStyle(feature)}"></div>`}
      <div class="hero-scrim"></div>
      <div class="hero-content">
        <h1 class="hero-title">${esc(feature.name)}</h1>
        <div class="hero-meta">
          <span>${feature.year}</span><span class="sep">·</span>
          <span>${esc(feature.country)}</span><span class="sep">·</span>
          <span class="hero-tag">${esc(feature.genre)}</span>
        </div>
        <p class="hero-synopsis">${esc(feature.synopsis||'')}</p>
        <div class="hero-actions">
          <button class="btn primary" onclick="openWatch(${feature.id})">▶ Watch now</button>
          <button class="btn" onclick="go('search',{query:'',page:1})">Browse everything</button>
        </div>
      </div>
    </section>` : ''}

    ${shelfHTML('Newest arrivals', 'Recently added to the library', newest.slice(0,8))}
    ${shelfHTML('Discover something', 'A rotating pick from across the library', byGenreMix)}
  `;
  initShelfNav();
}

// ---------------- rendering: search ----------------
const GENRES = () => [...new Set(ALL_MOVIES.map(m=>m.genre))].sort();
const COUNTRIES = () => [...new Set(ALL_MOVIES.map(m=>m.country))].sort();
const TYPES = () => [...new Set(ALL_MOVIES.map(m=>m.type))].sort();

function applyFiltersAndSort(){
  const q = (state.query||'').toLowerCase().trim();
  let list = ALL_MOVIES.filter(m=>{
    if(q && !(m.name.toLowerCase().includes(q) || m.genre.toLowerCase().includes(q) || m.country.toLowerCase().includes(q))) return false;
    if(state.filters.genre.size && !state.filters.genre.has(m.genre)) return false;
    if(state.filters.type && m.type !== state.filters.type) return false;
    if(state.filters.country && m.country !== state.filters.country) return false;
    if(state.filters.yearMin && m.year < Number(state.filters.yearMin)) return false;
    if(state.filters.yearMax && m.year > Number(state.filters.yearMax)) return false;
    return true;
  });
  switch(state.sort){
    case 'newest': list.sort((a,b)=>b.id-a.id); break;
    case 'year_desc': list.sort((a,b)=>b.year-a.year); break;
    case 'year_asc': list.sort((a,b)=>a.year-b.year); break;
    case 'name_asc': list.sort((a,b)=>a.name.localeCompare(b.name)); break;
    default: break;
  }
  return list;
}

function pagerHTML(total, page, pageSize){
  const pages = Math.max(1, Math.ceil(total/pageSize));
  page = Math.min(Math.max(1,page), pages);
  let btns = [];
  const add = (p)=>btns.push(`<button class="${p===page?'active':''}" onclick="changePage(${p})">${p}</button>`);
  const gap = ()=>btns.push(`<span class="gap">…</span>`);
  add(1);
  if(page>3) gap();
  for(let p=Math.max(2,page-1); p<=Math.min(pages-1,page+1); p++) add(p);
  if(page<pages-2) gap();
  if(pages>1) add(pages);
  return `
    <div class="pager">
      <button ${page<=1?'disabled':''} onclick="changePage(${page-1})">‹</button>
      ${btns.join('')}
      <button ${page>=pages?'disabled':''} onclick="changePage(${page+1})">›</button>
    </div>`;
}
function changePage(p){ state.page = p; renderSearchResultsOnly(); window.scrollTo({top:0,behavior:'smooth'}); }

function toggleGenre(g){
  if(state.filters.genre.has(g)) state.filters.genre.delete(g); else state.filters.genre.add(g);
  state.page = 1;
  renderSearchResultsOnly();
}
function setFilter(key, val){
  state.filters[key] = val;
  state.page = 1;
  renderSearchResultsOnly();
}
function setSort(val){ state.sort = val; state.page = 1; renderSearchResultsOnly(); }
function clearFilters(){
  state.filters = { genre:new Set(), type:'', country:'', yearMin:'', yearMax:'' };
  state.page = 1;
  render();
}

function resultCard(m){
  return `
    <div class="poster-card" onclick="openWatch(${m.id})">
      <div class="poster-frame result-frame">
        ${posterMedia(m)}
        <div class="play-hint"><div class="circle">▶</div></div>
      </div>
      <div class="poster-meta">
        <div class="poster-name">${esc(m.name)}</div>
        <div class="poster-year">${m.year} · ${esc(m.genre)}</div>
      </div>
    </div>`;
}

function renderSearchResultsOnly(){
  const list = applyFiltersAndSort();
  const start = (state.page-1)*state.pageSize;
  const pageItems = list.slice(start, start+state.pageSize);
  const box = document.getElementById('resultsCol');
  if(!box) return;
  box.innerHTML = `
    <div class="results-head">
      <div class="results-count">
        ${state.query ? `Results for <strong>&ldquo;${esc(state.query)}&rdquo;</strong> — ` : ''}
        <strong>${list.length}</strong> title${list.length===1?'':'s'}
      </div>
      <div class="sort-shell">
        Sort by
        <select onchange="setSort(this.value)">
          <option value="relevance" ${state.sort==='relevance'?'selected':''}>Relevance</option>
          <option value="newest" ${state.sort==='newest'?'selected':''}>Newest</option>
          <option value="name_asc" ${state.sort==='name_asc'?'selected':''}>Title (A–Z)</option>
          <option value="year_desc" ${state.sort==='year_desc'?'selected':''}>Release year (newest)</option>
          <option value="year_asc" ${state.sort==='year_asc'?'selected':''}>Release year (oldest)</option>
        </select>
      </div>
    </div>
    ${pageItems.length ? `
      <div class="result-grid">${pageItems.map(resultCard).join('')}</div>
      ${pagerHTML(list.length, state.page, state.pageSize)}
    ` : `
      <div class="empty-state">
        <div class="em-title">No films match these filters</div>
        <div>Try widening your search or clearing a filter.</div>
      </div>
    `}
  `;
}

function renderSearch(){
  document.getElementById('headerSearch').value = state.query || '';
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="search-page">
      <aside class="filters">
        <h3>Filters</h3>
        <div class="filter-group">
          <label class="group-label">Genre</label>
          <div class="genre-list">
            ${GENRES().map(g=>`
              <label class="filter-check">
                <input type="checkbox" ${state.filters.genre.has(g)?'checked':''} onchange="toggleGenre('${g.replace(/'/g,"\\'")}')">
                ${esc(g)}
              </label>`).join('')}
          </div>
        </div>
        <div class="filter-group">
          <label class="group-label">Type</label>
          <select class="filter-select" onchange="setFilter('type', this.value)">
            <option value="">All types</option>
            ${TYPES().map(t=>`<option value="${esc(t)}" ${state.filters.type===t?'selected':''}>${esc(t)}</option>`).join('')}
          </select>
        </div>
        <div class="filter-group">
          <label class="group-label">Country</label>
          <select class="filter-select" onchange="setFilter('country', this.value)">
            <option value="">All countries</option>
            ${COUNTRIES().map(c=>`<option value="${esc(c)}" ${state.filters.country===c?'selected':''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="filter-group">
          <label class="group-label">Release year</label>
          <div class="year-range">
            <input class="filter-input" type="number" placeholder="From" value="${esc(state.filters.yearMin)}" onchange="setFilter('yearMin', this.value)">
            <input class="filter-input" type="number" placeholder="To" value="${esc(state.filters.yearMax)}" onchange="setFilter('yearMax', this.value)">
          </div>
        </div>
        <button class="filter-clear" onclick="clearFilters()">Clear filters</button>
      </aside>
      <div class="results-col" id="resultsCol"></div>
    </div>
  `;
  renderSearchResultsOnly();
}

// ---------------- watch page ----------------
function openWatch(id){
  watchReturnState = snapshotState();
  go('watch', { watchMovieId: id });
}

function handleVideoError(el){
  const shell = el.closest('.player-shell');
  if(!shell) return;
  shell.innerHTML = `
    <div class="video-fallback">
      <div class="glyph">▶</div>
      <p>Playback unavailable right now — the video couldn't be loaded.</p>
    </div>`;
}

function extractYouTubeId(url){
  const match = url.match(/(?:youtu\.be\/|v=)([^&]+)/);
  return match ? match[1] : '';
}

// Builds the player markup: YouTube embed, direct <video> source, or a "no video" fallback.
function playerShellHTML(m){
  if(!m.videoUrl){
    return `
      <div class="video-fallback">
        <div class="glyph">▶</div>
        <p>No video source is set for this title yet.</p>
      </div>`;
  }
  const isYouTube = m.videoUrl.includes("youtube.com") || m.videoUrl.includes("youtu.be");
  if(isYouTube){
    return `
      <iframe width="100%" height="500"
        src="https://www.youtube.com/embed/${extractYouTubeId(m.videoUrl)}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen>
      </iframe>`;
  }
  return `
    <video id="moviePlayer" controls playsinline ${m.poster?`poster="${m.poster}"`:''} onerror="handleVideoError(this)">
      <source src="${m.videoUrl}" type="video/mp4">
      Your browser doesn't support embedded video.
    </video>`;
}

function renderWatch(){
  const m = movieById(state.watchMovieId);
  const app = document.getElementById('app');
  if(!m){
    app.innerHTML = `<div class="empty-state" style="margin-top:32px;"><div class="em-title">Title not found</div><div>It may have been removed from the library.</div></div>`;
    return;
  }
  const related = ALL_MOVIES.filter(x=>x.id!==m.id && x.genre===m.genre).slice(0,6);
  const fallbackRelated = related.length ? related : ALL_MOVIES.filter(x=>x.id!==m.id).slice(0,6);

  app.innerHTML = `
    <button class="btn ghost small back-btn" onclick="goBack()">‹ Back</button>
    <div class="watch-layout">
      <div class="player-col">
        <div class="player-shell">
          ${playerShellHTML(m)}
        </div>
        <h1 class="watch-title">${esc(m.name)}</h1>
        <div class="movie-meta">
          <span>${m.year}</span><span>·</span>
          <span>${esc(m.country)}</span><span>·</span>
          <span>${esc(m.genre)}</span><span>·</span>
          <span>${esc(m.type)}</span>
        </div>
        <p class="synopsis">${esc(m.synopsis||'')}</p>
        <div class="divider"></div>
        <div class="comments">
          <h4>Comments</h4>
          <div class="comment-form">
            <textarea id="commentInput" placeholder="Share a thought on ${esc(m.name)}…"></textarea>
            <button class="btn primary small" style="align-self:flex-start;" onclick="submitComment(${m.id})">Post</button>
          </div>
          <div class="comment-list" id="commentList">
            <div class="comment-empty">Loading comments…</div>
          </div>
        </div>
      </div>
      <aside class="related-col">
        <h3>More like this</h3>
        <div class="related-list">
          ${fallbackRelated.map(r=>`
            <div class="related-item" onclick="openWatch(${r.id})">
              <div class="related-thumb">${posterMedia(r)}</div>
              <div class="related-info">
                <div class="rel-name">${esc(r.name)}</div>
                <div class="rel-meta">${r.year} · ${esc(r.genre)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </aside>
    </div>
  `;
  loadAndRenderComments(m.id);
}

// Fetches comments and the user list together (so we can show real names) and renders them.
// Reused after posting and after deleting, so the list always reflects the current state.
async function loadAndRenderComments(movieId){
  const box = document.getElementById('commentList');
  if(box) box.innerHTML = `<div class="comment-empty">Loading comments…</div>`;
  try{
    const [list, users] = await Promise.all([
      apiGetComments(movieId),
      apiGetAllUsersCached(session.token),
    ]);
    renderComments(list, users);
  }catch(e){
    console.error('Failed to load/render comments:', e);
    if(box) box.innerHTML = `<div class="comment-empty">Couldn't load comments right now.</div>`;
  }
}

function renderComments(list, users){
  const box = document.getElementById('commentList');
  if(!box) return;
  if(!list || list.length===0){
    box.innerHTML = `<div class="comment-empty">No comments yet — be the first to say something.</div>`;
    return;
  }
  const userMap = new Map((users||[]).map(u=>[String(u.id), u]));
  const currentUserId = session.user?.id;

  box.innerHTML = list.map(c=>{
    const matchedUser = c.userId!=null ? userMap.get(String(c.userId)) : null;
    const displayName = matchedUser ? (matchedUser.name || matchedUser.email) : (c.userId!=null ? `Member #${c.userId}` : 'Guest');
    const isOwnComment = currentUserId!=null && c.userId!=null && String(c.userId) === String(currentUserId);
    return `
    <div class="comment-item">
      <div class="comment-avatar">${initials(displayName)}</div>
      <div class="comment-body">
        <div class="comment-meta">
          <strong>${esc(displayName)}</strong> · ${timeAgo(c.date)}
          ${isOwnComment ? `<button class="btn ghost small comment-delete-btn" onclick='deleteComment(${JSON.stringify(String(c.id))})'>Delete</button>` : ''}
        </div>
        <div class="comment-text">${esc(c.comment)}</div>
      </div>
    </div>`;
  }).join('');
}

async function submitComment(movieId){
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if(!text) return;
  input.value='';
  input.disabled = true;
  await apiPostComment(movieId, text);
  await loadAndRenderComments(movieId);
  input.disabled = false;
  showToast('Comment posted');
}

async function deleteComment(commentId){
  if(!confirm('Delete this comment?')) return;
  const movieId = state.watchMovieId;
  try{
    await apiDeleteComment(commentId);
    if(MOVIE_COMMENTS_CACHE[movieId]){
      MOVIE_COMMENTS_CACHE[movieId] = MOVIE_COMMENTS_CACHE[movieId].filter(c => String(c.id) !== String(commentId));
    }
    await loadAndRenderComments(movieId);
    showToast('Comment deleted');
  }catch(e){
    console.error('Failed to delete comment:', e);
    showToast('Could not delete the comment.');
  }
}

// ---------------- auth gate (must sign in to use the app) ----------------
function setGateMode(mode){ state.authMode = mode; renderAuthGate(); }

function renderAuthGate(){
  const app = document.getElementById('app');
  const mode = state.authMode || 'login';
  app.innerHTML = `
    <div class="gate-shell">
      <div class="gate-card">
        <div class="logo" style="margin-bottom:14px;">Flicker<span class="dot">.</span></div>
        <div class="auth-title">${mode==='login' ? 'Welcome back' : 'Create an account'}</div>
        <div class="auth-sub">${mode==='login' ? 'Sign in to browse the library and join the conversation.' : 'Sign up to browse the library and join the conversation.'}</div>
        <div class="auth-tabs">
          <button class="${mode==='login'?'active':''}" onclick="setGateMode('login')">Sign in</button>
          <button class="${mode==='signup'?'active':''}" onclick="setGateMode('signup')">Sign up</button>
        </div>
        <div id="authFormBox"></div>
      </div>
    </div>
  `;
  renderAuthForm(mode);
}

function renderAuthForm(mode){
  const box = document.getElementById('authFormBox');
  box.innerHTML = mode==='login' ? `
    <div class="field"><label>Email</label><input id="loginEmail" type="email" placeholder="you@example.com"></div>
    <div class="field"><label>Password</label><input id="loginPassword" type="password" placeholder="••••••••"></div>
    <div class="form-error" id="authError"></div>
    <button class="btn primary auth-submit" onclick="doLogin()">Sign in</button>
  ` : `
    <div class="field"><label>Name</label><input id="signupName" type="text" placeholder="Jamie Rivera"></div>
    <div class="field"><label>Email</label><input id="signupEmail" type="email" placeholder="you@example.com"></div>
    <div class="field"><label>Password</label><input id="signupPassword" type="password" placeholder="At least 8 characters"></div>
    <div class="form-error" id="authError"></div>
    <button class="btn primary auth-submit" onclick="doSignup()">Create account</button>
  `;
}

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const err = document.getElementById('authError');
  err.textContent='';
  if(!email || !password){ err.textContent='Enter your email and password.'; return; }
  try{
    let result;
    try{ result = await apiLogin(email, password); }
    catch(e){ throw e; }
    session = result;
    persistSession();
    ALL_MOVIES = await apiGetMovies();
    render();
    showToast(`Signed in as ${session.user.name || session.user.email}`);
  }catch(e){ err.textContent = e.message || 'Could not sign in.'; }
}

async function doSignup(){
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const err = document.getElementById('authError');
  err.textContent='';
  if(!name || !email || !password){ err.textContent='Fill in every field to continue.'; return; }
  if(password.length<8){ err.textContent='Password should be at least 8 characters.'; return; }
  try{
    const user = await apiSignup(name, email, password);
    let result;
    try{ result = await apiLogin(email, password); }
    catch(e){ result = { token:null, user }; }
    session = result;
    persistSession();
    ALL_MOVIES = await apiGetMovies();
    render();
    showToast(`Welcome, ${session.user.name || session.user.email}`);
  }catch(e){ err.textContent = e.message || 'Could not create that account.'; }
}

// ---------------- router ----------------
function render(){
  renderNavAuth();
  if(!session.user){ renderAuthGate(); return; }
  if(state.view==='search') renderSearch();
  else if(state.view==='watch') renderWatch();
  else renderHome();
}

// ---------------- boot ----------------
(async function init(){
  loadPersistedSession();
  ALL_MOVIES = await apiGetMovies();
  render();
})();