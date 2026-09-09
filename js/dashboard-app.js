const API_BASE = 'http://localhost:8080'; // your Spring Boot app — must have CORS enabled for this admin site's origin

// ---- Cloudinary config ----
const CLOUD_NAME = "dxxn3lxqw";
const UPLOAD_PRESET = "MovieSite";

// ---- session (persisted so a refresh doesn't log you out) ----
const SESSION_KEY = 'flicker_admin_session';
let session = { user: null, token: null };

function persistSession(){
  try{ localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }catch(e){ /* ignore */ }
}
function loadPersistedSession(){
  try{
    const raw = localStorage.getItem(SESSION_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && parsed.token && parsed.user) session = parsed;
    }
  }catch(e){ /* ignore */ }
}
function clearPersistedSession(){
  try{ localStorage.removeItem(SESSION_KEY); }catch(e){ /* ignore */ }
}

// ---- app state ----
let state = {
  view: 'login', // 'login' | 'dashboard'
  adminTab: 'movies', // 'movies' | 'account'
  editingMovieId: null, // null = list, 'new' = creating, or a movie id = editing
};

let ALL_MOVIES = [];

// ---- movie form state (upload/test gating for the Save button) ----
// videoOk === true only once the current mvUrl value has actually been confirmed to play
// (either freshly uploaded + auto-tested, or manually pasted + Tested, or an existing saved
// value that loaded and played fine). Any edit to the URL, or a new file pick, resets this.
let mvFormState = {
  imageUploading: false,
  videoUploading: false,
  videoTested: false,
  videoOk: false,
};

// ---------------- util ----------------
function esc(str){
  return String(str??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function initials(str){
  return (str||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
}
function showToast(msg){
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  setTimeout(()=>{ if(root.firstChild) root.innerHTML=''; }, 2600);
}
function authHeaders(){
  return session.token ? { "Authorization": `Bearer ${session.token}` } : {};
}

// ---------------- Cloudinary upload ----------------
// resourceType: 'image' | 'video' | 'raw' — must match Cloudinary's upload endpoint
async function uploadToCloudinary(file, resourceType = 'image'){
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`, {
    method: "POST",
    body: formData,
  });
  if(!res.ok) throw new Error(`${resourceType === 'video' ? 'Video' : 'Image'} upload failed.`);
  const data = await res.json();
  if(!data.secure_url) throw new Error('Upload succeeded but no URL was returned.');
  return data.secure_url;
}

// ---------------- API ----------------
// POST /api/users/login expects { email, password, role } and returns a raw JWT string.
// Sending role:'ADMIN' here since LoginRequestDto carries a role field.
async function apiLogin(email, password){
  const res = await fetch(`${API_BASE}/api/users/login`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password, role: 'ADMIN' })
  });
  if(!res.ok) throw new Error('Incorrect email or password.');
  return await res.text();
}

// There's no "get user by email" endpoint, so once we have a token we pull the full
// user list (GET /api/users) and match by email to confirm identity + admin role.
async function apiGetAllUsers(){
  const res = await fetch(`${API_BASE}/api/users`, { headers: authHeaders() });
  if(!res.ok) throw new Error('Could not load user accounts.');
  return await res.json();
}

async function apiGetMovies(){
  const res = await fetch(`${API_BASE}/api/movies`, { headers: authHeaders() });
  if(!res.ok) throw new Error('Could not load movies.');
  return await res.json();
}

async function apiCreateMovie(payload){
  const res = await fetch(`${API_BASE}/api/movies`, {
    method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  if(!res.ok) throw new Error('Could not save the movie.');
  return await res.json();
}
async function apiUpdateMovie(id, payload){
  const res = await fetch(`${API_BASE}/api/movies/${id}`, {
    method:'PUT', headers:{ 'Content-Type':'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  if(!res.ok) throw new Error('Could not update the movie.');
  return await res.json();
}
async function apiDeleteMovie(id){
  const res = await fetch(`${API_BASE}/api/movies/${id}`, {
    method:'DELETE', headers: authHeaders()
  });
  if(!res.ok) throw new Error('Could not delete the movie.');
  return true;
}

async function apiUpdateUser(id, payload){
  const res = await fetch(`${API_BASE}/api/users/${id}`, {
    method:'PUT', headers:{ 'Content-Type':'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  if(!res.ok) throw new Error('Could not update the account.');
  return await res.json();
}

// ---------------- nav ----------------
function renderNavAuth(){
  const el = document.getElementById('navAuth');
  if(session.user){
    el.innerHTML = `
      <div class="user-chip">
        <div class="user-avatar">${esc(initials(session.user.name||session.user.email))}</div>
        <span>${esc(session.user.name || session.user.email)}</span>
      </div>
      <button class="btn ghost small" onclick="logout()">Sign out</button>
    `;
  } else {
    el.innerHTML = '';
  }
}

function logout(){
  session = { user:null, token:null };
  clearPersistedSession();
  state.view = 'login';
  render();
}

// ---------------- login ----------------
function renderLogin(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="gate-shell">
      <div class="gate-card">
        <div class="logo" style="margin-bottom:14px;">Flicker<span class="dot">.</span></div>
        <div class="auth-title">Admin sign in</div>
        <div class="auth-sub">Only accounts with the ADMIN role can access this dashboard.</div>
        <div class="field"><label>Email</label><input id="loginEmail" type="email" placeholder="admin@example.com"></div>
        <div class="field"><label>Password</label><input id="loginPassword" type="password" placeholder="••••••••"></div>
        <div class="form-error" id="authError"></div>
        <button class="btn primary auth-submit" onclick="doLogin()">Sign in</button>
      </div>
    </div>
  `;
}

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const err = document.getElementById('authError');
  err.textContent = '';
  if(!email || !password){ err.textContent = 'Enter your email and password.'; return; }
  try{
    const token = await apiLogin(email, password);
    session.token = token;
    const users = await apiGetAllUsers();
    const match = users.find(u => (u.email||'').toLowerCase() === email.toLowerCase());
    if(!match){ throw new Error('Could not find a matching account.'); }
    if(!(match.role||'').toUpperCase().includes('ADMIN')){
      throw new Error('This account does not have admin access.');
    }
    session.user = match;
    persistSession();
    ALL_MOVIES = await apiGetMovies();
    state.view = 'dashboard';
    render();
    showToast(`Signed in as ${session.user.name || session.user.email}`);
  }catch(e){
    session = { user:null, token:null };
    err.textContent = e.message || 'Could not sign in.';
  }
}

// ---------------- dashboard shell ----------------
function setAdminTab(tab){ state.adminTab = tab; state.editingMovieId = null; renderDashboard(); }

function renderDashboard(){
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="admin-page">
      <h1 class="admin-title">Admin dashboard</h1>
      <div class="admin-tabs">
        <button class="${state.adminTab==='movies'?'active':''}" onclick="setAdminTab('movies')">Movies</button>
        <button class="${state.adminTab==='account'?'active':''}" onclick="setAdminTab('account')">My account</button>
      </div>
      <div id="adminBody"></div>
    </div>
  `;
  if(state.adminTab==='account') renderAccountTab();
  else renderMoviesTab();
}

// ---------------- movies tab ----------------
function openMovieForm(id){ state.editingMovieId = id; renderMoviesTab(); }
function closeMovieForm(){ state.editingMovieId = null; renderMoviesTab(); }

function movieById(id){ return ALL_MOVIES.find(m => String(m.id) === String(id)); }

function videoPreviewHTML(url){
  if(!url) return '';
  return `<video id="mvVideoPreview" src="${esc(url)}" controls playsinline
            style="max-width:260px;border-radius:6px;border:1px solid var(--border-strong);"
            onerror="handleAdminVideoError(this)" oncanplay="handleAdminVideoOk(this)"></video>`;
}

function movieFormHTML(m){
  const imageUrl = m?.image || '';
  const videoUrl = m?.url || '';

  // Reset gating state for this fresh render of the form. A video URL that's already
  // saved still has to prove it plays again (the preview <video> auto-tests it on load
  // via oncanplay/onerror), so Save stays disabled until that resolves.
  mvFormState = { imageUploading:false, videoUploading:false, videoTested:false, videoOk:false };
  const saveLabel = m ? 'Save changes' : 'Add title';
  // Only block Save on video-readiness if there's actually a video URL to check.
  const saveDisabled = !!videoUrl;

  return `
    <div class="admin-form-card">
      <h3>${m ? 'Edit title' : 'Add a new title'}</h3>
      <div class="admin-form-grid">
        <div class="field"><label>Name</label><input id="mvName" value="${esc(m?.name||'')}"></div>
        <div class="field"><label>Year</label><input id="mvYear" type="number" value="${esc(m?.year||'')}"></div>
        <div class="field"><label>Country</label><input id="mvCountry" value="${esc(m?.country||'')}"></div>
        <div class="field"><label>Genre</label><input id="mvGenre" value="${esc(m?.genre||'')}"></div>
        <div class="field"><label>Type</label><input id="mvType" value="${esc(m?.type||'')}" placeholder="Movie / Series"></div>

        <div class="field admin-form-wide">
          <label>Video URL</label>
          <div style="display:flex; gap:8px;">
            <input id="mvUrl" value="${esc(videoUrl)}" placeholder="Paste a URL, or upload a file below"
                   style="flex:1;" oninput="onVideoUrlInput()">
            <button type="button" class="btn ghost small" onclick="testVideoUrl()">Test</button>
          </div>
          <div style="margin-top:8px;">
            <label style="font-size:12.5px;color:var(--text-muted);">Or upload a video file</label><br>
            <input type="file" id="mvVideoFile" accept="video/*" onchange="handleMovieVideoSelect()">
          </div>
          <div id="mvVideoStatus" style="font-size:12.5px;color:var(--text-muted);margin-top:6px;">
            ${videoUrl ? 'Checking playback…' : ''}
          </div>
          <div id="mvVideoPreviewWrap" style="margin-top:8px;">${videoPreviewHTML(videoUrl)}</div>
        </div>

        <div class="field admin-form-wide">
          <label>Poster image</label>
          <input type="file" id="mvImageFile" accept="image/*" onchange="handleMovieImageSelect()">
          <input type="hidden" id="mvImageUrl" value="${esc(imageUrl)}">
          <div id="mvImageStatus" style="font-size:12.5px;color:var(--text-muted);margin-top:6px;"></div>
          <div id="mvImagePreviewWrap" style="margin-top:8px;">
            ${imageUrl ? `<img id="mvImagePreview" src="${esc(imageUrl)}" style="max-width:140px;border-radius:6px;border:1px solid var(--border-strong);">` : ''}
          </div>
        </div>
      </div>
      <div class="form-error" id="mvError"></div>
      <div class="admin-form-actions">
        <button class="btn ghost small" onclick="closeMovieForm()">Cancel</button>
        <button id="mvSaveBtn" class="btn primary small" data-label="${esc(saveLabel)}"
                ${saveDisabled ? 'disabled' : ''}
                onclick="saveMovieForm(${m ? `'${m.id}'` : 'null'})">${saveLabel}</button>
      </div>
    </div>`;
}

// Recomputes whether Save should be enabled, based on upload-in-progress and
// video-playback-confirmed state. Called after every relevant event.
function updateSaveButtonState(){
  const btn = document.getElementById('mvSaveBtn');
  if(!btn) return;
  const label = btn.dataset.label || 'Save changes';
  const urlInput = document.getElementById('mvUrl');
  const url = urlInput ? urlInput.value.trim() : '';

  if(mvFormState.imageUploading || mvFormState.videoUploading){
    btn.disabled = true;
    btn.textContent = mvFormState.videoUploading ? 'Uploading video…' : 'Uploading image…';
    return;
  }
  if(url && !mvFormState.videoOk){
    btn.disabled = true;
    btn.textContent = mvFormState.videoTested ? 'Fix video before saving' : 'Testing video…';
    return;
  }
  btn.disabled = false;
  btn.textContent = label;
}

async function handleMovieImageSelect(){
  const fileInput = document.getElementById('mvImageFile');
  const status = document.getElementById('mvImageStatus');
  const file = fileInput.files[0];
  if(!file) return;

  mvFormState.imageUploading = true;
  updateSaveButtonState();
  status.textContent = 'Uploading…';
  status.style.color = 'var(--text-muted)';

  try{
    const url = await uploadToCloudinary(file, 'image');
    document.getElementById('mvImageUrl').value = url;
    document.getElementById('mvImagePreviewWrap').innerHTML =
      `<img id="mvImagePreview" src="${esc(url)}" style="max-width:140px;border-radius:6px;border:1px solid var(--border-strong);">`;
    status.textContent = 'Image uploaded.';
    status.style.color = 'var(--text-muted)';
  }catch(e){
    status.textContent = e.message || 'Could not upload image.';
    status.style.color = 'var(--crimson)';
  }finally{
    mvFormState.imageUploading = false;
    updateSaveButtonState();
  }
}

// Fired by the preview <video>'s onerror — the URL is unreachable, not a video, or blocked (CORS/hotlink protection).
function handleAdminVideoError(videoEl){
  mvFormState.videoTested = true;
  mvFormState.videoOk = false;
  const status = document.getElementById('mvVideoStatus');
  if(status){
    status.textContent = 'This URL does not play as a video (bad link, wrong format, or CORS-blocked). Fix it before saving.';
    status.style.color = 'var(--crimson)';
  }
  updateSaveButtonState();
}

// Fired by the preview <video>'s oncanplay — the browser buffered enough to actually start playback.
function handleAdminVideoOk(videoEl){
  mvFormState.videoTested = true;
  mvFormState.videoOk = true;
  const status = document.getElementById('mvVideoStatus');
  if(status){
    status.textContent = 'Video plays correctly.';
    status.style.color = 'var(--text-muted)';
  }
  updateSaveButtonState();
}

// User edited the URL by hand — whatever was tested before no longer applies.
function onVideoUrlInput(){
  mvFormState.videoTested = false;
  mvFormState.videoOk = false;
  const wrap = document.getElementById('mvVideoPreviewWrap');
  if(wrap) wrap.innerHTML = '';
  const status = document.getElementById('mvVideoStatus');
  const url = document.getElementById('mvUrl').value.trim();
  if(status){
    status.textContent = url ? 'URL changed — click Test to verify it plays before saving.' : '';
    status.style.color = 'var(--text-muted)';
  }
  updateSaveButtonState();
}

// Re-renders the preview <video> against whatever is currently typed in mvUrl, for manually pasted links.
function testVideoUrl(){
  const url = document.getElementById('mvUrl').value.trim();
  const status = document.getElementById('mvVideoStatus');
  const wrap = document.getElementById('mvVideoPreviewWrap');
  if(!url){ status.textContent = 'Enter a URL first.'; status.style.color = 'var(--crimson)'; return; }

  mvFormState.videoTested = false;
  mvFormState.videoOk = false;
  updateSaveButtonState();
  status.textContent = 'Testing…';
  status.style.color = 'var(--text-muted)';
  wrap.innerHTML = videoPreviewHTML(url);
}

async function handleMovieVideoSelect(){
  const fileInput = document.getElementById('mvVideoFile');
  const status = document.getElementById('mvVideoStatus');
  const wrap = document.getElementById('mvVideoPreviewWrap');
  const file = fileInput.files[0];
  if(!file) return;

  mvFormState.videoUploading = true;
  mvFormState.videoTested = false;
  mvFormState.videoOk = false;
  updateSaveButtonState();
  status.textContent = 'Uploading video… this can take a while for large files.';
  status.style.color = 'var(--text-muted)';

  try{
    // Upload to Cloudinary first — the CLOUDINARY URL is what gets stored in mvUrl and
    // sent to the backend, never the local file itself.
    const url = await uploadToCloudinary(file, 'video');
    document.getElementById('mvUrl').value = url;
    mvFormState.videoUploading = false;
    status.textContent = 'Video uploaded — checking playback…';
    status.style.color = 'var(--text-muted)';
    // Rendering the preview triggers oncanplay/onerror automatically, which is our test.
    wrap.innerHTML = videoPreviewHTML(url);
    updateSaveButtonState();
  }catch(e){
    mvFormState.videoUploading = false;
    status.textContent = e.message || 'Could not upload video.';
    status.style.color = 'var(--crimson)';
    updateSaveButtonState();
  }
}

function renderMoviesTab(){
  const box = document.getElementById('adminBody');
  const editing = state.editingMovieId;
  const editingMovie = editing && editing !== 'new' ? movieById(editing) : null;
  const formBlock = editing ? movieFormHTML(editingMovie) : `<button class="btn primary small" onclick="openMovieForm('new')">+ Add movie</button>`;

  box.innerHTML = `
    ${formBlock}
    <div class="admin-table" style="margin-top:18px;">
      ${ALL_MOVIES.map(m => `
        <div class="admin-row">
          ${m.image ? `<img src="${esc(m.image)}" class="admin-row-thumb" alt="">` : `<div class="admin-row-thumb admin-row-thumb-empty"></div>`}
          <div class="admin-row-info">
            <div class="admin-row-name">${esc(m.name)}</div>
            <div class="admin-row-meta">${m.year} · ${esc(m.country)} · ${esc(m.genre)} · ${esc(m.type)}</div>
          </div>
          <div class="admin-row-actions">
            <button class="btn ghost small" onclick="openMovieForm('${m.id}')">Edit</button>
            <button class="btn ghost small" onclick="deleteMovieRow('${m.id}')">Delete</button>
          </div>
        </div>
      `).join('') || `<div class="empty-state"><div class="em-title">No titles yet</div>Add your first one above.</div>`}
    </div>
  `;
}

async function saveMovieForm(existingId){
  const err = document.getElementById('mvError');
  err.textContent = '';

  // Belt-and-suspenders: even if the button was somehow clicked while disabled
  // (e.g. a stray keyboard Enter), refuse to save mid-upload or with an unverified video.
  if(mvFormState.imageUploading || mvFormState.videoUploading){
    err.textContent = 'Please wait for the upload to finish before saving.';
    return;
  }
  const urlNow = document.getElementById('mvUrl').value.trim();
  if(urlNow && !mvFormState.videoOk){
    err.textContent = 'Please test the video URL and confirm it plays before saving.';
    return;
  }

  const name = document.getElementById('mvName').value.trim();
  const yearVal = Number(document.getElementById('mvYear').value);
  if(!name){ 
    err.textContent = 'Give the title a name.'; 
    return; 
  }
  
  if(!yearVal){ 
    err.textContent = 'Enter a valid year.'; 
    return; 
  }

  const isEditing = existingId && existingId !== 'null';
  const base = isEditing ? (movieById(existingId) || {}) : {};
  const payload = {
    ...base,
    name,
    year: yearVal,
    country: document.getElementById('mvCountry').value.trim(),
    genre: document.getElementById('mvGenre').value.trim(),
    type: document.getElementById('mvType').value.trim(),
    url: urlNow,
    image: document.getElementById('mvImageUrl').value.trim(),
  };

  try{
    if(isEditing) await apiUpdateMovie(existingId, payload);
    else await apiCreateMovie(payload);
    ALL_MOVIES = await apiGetMovies();
    state.editingMovieId = null;
    renderMoviesTab();
    showToast('Movie saved');
  }catch(e){
    err.textContent = e.message || 'Could not save the movie.';
  }
}

async function deleteMovieRow(id){
  if(!confirm('Delete this title? This cannot be undone.')) return;
  try{
    await apiDeleteMovie(id);
    ALL_MOVIES = await apiGetMovies();
    renderMoviesTab();
    showToast('Movie deleted');
  }catch(e){
    showToast(e.message || 'Could not delete the movie.');
  }
}

// ---------------- account tab ----------------
function renderAccountTab(){
  const box = document.getElementById('adminBody');
  const u = session.user || {};
  box.innerHTML = `
    <div class="admin-form-card" style="max-width:440px;">
      <h3>Change your login details</h3>
      <div class="field"><label>Name</label><input id="accName" value="${esc(u.name||'')}"></div>
      <div class="field"><label>Email</label><input id="accEmail" type="email" value="${esc(u.email||'')}"></div>
      <div class="field"><label>New password</label><input id="accPassword" type="password" placeholder="Leave blank to keep current password"></div>
      <div class="form-error" id="accError"></div>
      <button class="btn primary small" onclick="saveAccountForm()">Save changes</button>
    </div>
  `;
}

async function saveAccountForm(){
  const err = document.getElementById('accError');
  err.textContent = '';
  const name = document.getElementById('accName').value.trim();
  const email = document.getElementById('accEmail').value.trim();
  const password = document.getElementById('accPassword').value;
  if(!name || !email){ err.textContent = 'Name and email are required.'; return; }

  // Send the full existing user record with just the changed fields overlaid, so role
  // and other fields the form doesn't expose aren't accidentally wiped out by the PUT.
  const payload = {
    ...session.user,
    name,
    email,
    ...(password ? { password } : {}),
  };

  try{
    const updated = await apiUpdateUser(session.user.id, payload);
    session.user = updated;
    persistSession();
    renderNavAuth();
    document.getElementById('accPassword').value = '';
    showToast('Account updated');
  }catch(e){
    err.textContent = e.message || 'Could not update your account.';
  }
}

// ---------------- router ----------------
async function render(){
  renderNavAuth();
  if(!session.user){ state.view = 'login'; renderLogin(); return; }
  renderDashboard();
}

// ---------------- boot ----------------
(async function init(){
  loadPersistedSession();
  if(session.user && session.token){
    try{ ALL_MOVIES = await apiGetMovies(); }
    catch(e){ /* token may have expired; user can still view dashboard shell and retry actions */ }
  }
  render();
})();