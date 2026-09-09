# Flicker

A small movie/series streaming front end with a public site and a separate admin dashboard, backed by a Spring Boot REST API. Posters and video files are hosted on Cloudinary.

## Project structure

```
├── index.js       # Public site: browse, search, watch, comment
├── dashboard.js      # Admin dashboard: manage movies, manage own account

```

The two JS files are independent single-page apps that each expect their own `index.html` shell with a matching set of DOM ids (see below). They talk to the same backend but are meant to be deployed/served separately (e.g. `/` for the public site, `/admin` for the dashboard).

## Requirements

- A running Spring Boot backend exposing the API described below (default expected at `http://localhost:8080`, configurable via the `API_BASE` constant at the top of each JS file).
- CORS enabled on the backend for whatever origin serves these static files.
- A Cloudinary account with an **unsigned** upload preset (used by the admin dashboard for poster/video uploads).

No build step or framework — plain HTML/CSS/JS, loaded directly by the browser.

## Configuration

At the top of `index.js` and `dashboard.js`:

```js
const API_BASE = 'http://localhost:8080';
```

At the top of `dashboard.js` only:

```js
const CLOUD_NAME = 'your_cloudinary_cloud_name';
const UPLOAD_PRESET = 'your_unsigned_upload_preset';
```

## HTML shell requirements

### Public site (`site.js`) expects these ids/classes in its HTML:

| id/class            | purpose                                      |
|----------------------|-----------------------------------------------|
| `#app`               | main content mount point                     |
| `#navAuth`           | header auth area (sign in chip / sign out)   |
| `#headerSearch`      | search `<input>` in the header               |
| `.search-shell`      | wrapper around the header search bar         |
| `#demoFlag`          | small text label, shows when running on demo data |
| `#toastRoot`         | toast notification mount point               |

Calling `submitSearch()` (e.g. on a search button `onclick`) reads `#headerSearch` and navigates to the results page.

### Admin dashboard (`admin.js`) expects:

| id/class      | purpose                          |
|----------------|-----------------------------------|
| `#app`         | main content mount point         |
| `#navAuth`     | header auth area                 |
| `#toastRoot`   | toast notification mount point   |

## Features

### Public site
- **Auth gate** — the whole app is hidden behind sign in/sign up; nothing is browsable while signed out.
- **Home** — a hero for the newest title, plus "Newest arrivals" and "Discover something" shelves (8 titles each), each with prev/next scroll arrows, edge fades, and a hidden-but-functional scrollbar.
- **Search** — filter by genre (multi-select), type, country, release year range; sort by relevance/newest/title/year; paginated results.
- **Watch page** — plays either a direct video URL or a YouTube embed (auto-detected), falls back to a friendly message if playback fails or no video is set. Shows synopsis, metadata, related titles, and comments.
- **Comments** — post a comment, see everyone's comments under their real name (fetched from the backend user list), and delete your own comments.
- **Session handling** — login persists across refreshes via `localStorage`. If the backend ever returns 401/403 on an authenticated call (expired/invalid token), the app automatically signs the user out and returns them to the login screen.
- **Demo fallback** — if `/api/movies` is unreachable or returns no data, the site silently falls back to a small built-in demo catalog (with sample video clips) so the UI is still browsable/demoable without a backend running. A small "showing demo data" flag appears in the header when this happens.

### Admin dashboard
- **Admin-only login** — signs in the same way as the public site, then cross-checks the account's role via `GET /api/users` and refuses entry if the role isn't `ADMIN`.
- **Movie management** — add, edit, delete titles. Poster images and video files can be uploaded directly to Cloudinary from the form, or a URL can be pasted in manually.
- **Video playback verification** — pasted or uploaded video URLs are tested with a live preview before the Save button unlocks, so a broken link can't be saved without the admin noticing.
- **Account tab** — the signed-in admin can update their own name, email, and password.

## Expected backend API

These endpoints are assumed to exist on the Spring Boot backend. Adjust `API_BASE` and the calls in the JS if your actual routes differ.

| Method | Path                          | Auth | Notes |
|--------|-------------------------------|------|-------|
| POST   | `/api/users/login`            | —    | Body: `{ email, password }` (admin login also sends `role: 'ADMIN'`). Returns a raw JWT string. |
| POST   | `/api/users/signup`           | —    | Body: `{ name, email, password, role }`. Returns the created user. |
| GET    | `/api/users`                  | Bearer | Returns all users — used to look up the current user's real id/name/role (no "get by email" endpoint exists). |
| PUT    | `/api/users/{id}`             | Bearer | Update a user's own account. |
| GET    | `/api/movies`                 | Bearer (optional) | Returns all movies. Expected shape includes `id, name, year, country, genre, type, image, url`. |
| POST   | `/api/movies`                 | Bearer | Create a movie. |
| PUT    | `/api/movies/{id}`            | Bearer | Update a movie. |
| DELETE | `/api/movies/{id}`            | Bearer | Delete a movie. |
| GET    | `/api/comments/movie/{id}`    | Bearer (optional) | Returns comments for a movie. Accepts either a plain array or a Spring `Page`-style `{ content: [...] }` wrapper. |
| POST   | `/api/comments`                | Bearer | Body: `{ userId, movieId, comment, date }`. |
| DELETE | `/api/comments/{id}`           | Bearer | Delete a comment (should be restricted server-side to the comment's owner). |

**Auth header format:** `Authorization: Bearer <token>` on every authenticated request.

**Session expiry:** any `401` or `403` from an authenticated call triggers an automatic client-side logout on the public site.

## Known caveats / things worth double-checking against your actual backend

- There's no dedicated "get user by email" or "get current user" endpoint, so the app fetches the entire user list and filters client-side — fine for small user bases, but won't scale to a large table without a real endpoint.
- Comment ownership/display assumes each comment object has a flat `userId` field. If your backend nests it differently (e.g. `comment.user.id`), the name lookup and "delete own comment" check will need adjusting.
- `DELETE /api/comments/{id}` is called with no body — if your backend needs the comment to be scoped by movie or user in the URL/body, update `apiDeleteComment` in `site.js`.
- The Cloudinary upload preset used by the admin dashboard must be **unsigned** and allow both `image` and `video` resource types.
