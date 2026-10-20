/*!
 * Drive to MEGA — copies files from Google Drive to MEGA entirely in the browser.
 * https://github.com/DriveToMega/DriveToMega.github.io
 *
 * Security notes
 *  - All dynamic text goes through textContent / setAttribute via h(); innerHTML is only used for
 *    constant icon markup defined in this file.
 *  - The Google access token and the MEGA session live in memory only. Only preferences are persisted.
 *  - Every value interpolated into a Drive query or URL is validated or escaped.
 */
(() => {
'use strict';

const VERSION = '2.2.0';
const CONFIG = window.D2M_CONFIG || {};

/* ================================================================== helpers */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = (attempt, retryAfter) => {
  const ra = Number(retryAfter);
  if (ra > 0 && ra < 120) return ra * 1000;
  return Math.min(30000, 1500 * 2 ** attempt) + Math.random() * 600;
};

/** Safe element builder: strings become text nodes, never HTML. */
function h(tag, props, ...kids){
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)){
    if (v == null || v === false && !(k in el)) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean' && !k.includes('-')) el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)){
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function fmtBytes(n){
  if (n == null || n === '' || isNaN(n)) return '—';
  const u = ['B','KB','MB','GB','TB','PB']; let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
}
function fmtDate(iso){
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDuration(s){
  if (!isFinite(s) || s <= 0) return '';
  if (s >= 3600) return (s / 3600).toFixed(1) + ' h';
  if (s >= 60) return Math.round(s / 60) + ' min';
  return Math.max(1, Math.round(s)) + ' s';
}
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Strip control characters and cap length while keeping the extension. */
function cleanName(name){
  let s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s || s === '.' || s === '..') s = 'untitled';
  if (s.length > 240){
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, 240 - ext.length) + ext;
  }
  return s;
}

function err(message, extra){ return Object.assign(new Error(message), extra); }

/* ================================================================== icons (constant markup only) */
const page = (c, glyph = '') => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="${c}" d="M6.5 2.5h8l5 5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20.5V4a1.5 1.5 0 0 1 1.5-1.5z"/><path fill="#fff" opacity=".45" d="M14.5 2.5v5h5"/>${glyph}</svg>`;
const LINES = '<path fill="#fff" opacity=".9" d="M8 12h8v1.4H8zm0 3h8v1.4H8zm0 3h5v1.4H8z"/>';
const ICONS = {
  folder: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="#f2b33d" d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path fill="#fff" opacity=".25" d="M3 9h18v1H3z"/></svg>',
  drive: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2.5" fill="#4285f4"/><circle cx="16.5" cy="12" r="1.4" fill="#fff"/><path fill="#fff" opacity=".7" d="M6 11h6v2H6z"/></svg>',
  file: page('#94a3b8'),
  gdoc: page('#4285f4', LINES), gsheet: page('#0f9d58', LINES), gslides: page('#f4b400', LINES), gdraw: page('#db4437', LINES),
  pdf: page('#e5484d', '<path fill="#fff" d="M8 13h8v5H8z" opacity=".9"/>'),
  image: page('#8b5cf6', '<path fill="#fff" opacity=".9" d="M7.5 18l3-4 2 2.5 1.5-2 2.5 3.5z"/><circle cx="10" cy="11.5" r="1.3" fill="#fff"/>'),
  video: page('#ef4444', '<path fill="#fff" d="M10 11.5v6l5-3z"/>'),
  audio: page('#f97316', '<path fill="#fff" d="M14 10v6.2a2 2 0 1 1-1.4-1.9V11l-3 .8v5.4a2 2 0 1 1-1.4-1.9V10.6z"/>'),
  archive: page('#a16207', '<path fill="#fff" opacity=".85" d="M11 9h2v1.5h-2zm0 2.5h2V13h-2zm-.5 2.5h3v3h-3z"/>'),
  code: page('#0ea5e9', '<path fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="m10 12-2 2.5 2 2.5m4-5 2 2.5-2 2.5"/>'),
  cloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.5A3.75 3.75 0 0 1 17.5 18z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4"/></svg>',
  refresh: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>',
  x: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>',
  retry: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5"/></svg>',
  eye: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'
};
const iconCache = new Map();
function icon(name){
  if (!iconCache.has(name)){
    const t = document.createElement('template');
    t.innerHTML = ICONS[name] || ICONS.file; // constant markup from ICONS only
    iconCache.set(name, t.content.firstElementChild);
  }
  return iconCache.get(name).cloneNode(true);
}

const FOLDER = 'application/vnd.google-apps.folder';
function iconNameFor(f){
  const m = f.mimeType || '', n = (f.name || '').toLowerCase();
  if (f.isDrive) return 'drive';
  if (m === FOLDER) return 'folder';
  if (m === 'application/vnd.google-apps.document') return 'gdoc';
  if (m === 'application/vnd.google-apps.spreadsheet') return 'gsheet';
  if (m === 'application/vnd.google-apps.presentation') return 'gslides';
  if (m === 'application/vnd.google-apps.drawing') return 'gdraw';
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|avif|bmp|tiff?|svg|raw|dng)$/.test(n)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv|3gp)$/.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/.test(n)) return 'audio';
  if (/\.docx?$/.test(n)) return 'gdoc';
  if (/\.(xlsx?|csv|ods)$/.test(n)) return 'gsheet';
  if (/\.(pptx?|odp|key)$/.test(n)) return 'gslides';
  if (/zip|rar|7z|tar|gzip|compressed/.test(m) || /\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(n)) return 'archive';
  if (/javascript|json|xml|x-python|x-sh|text\/x-|google-apps\.script/.test(m)) return 'code';
  return 'file';
}
function megaIconName(node){
  if (node.directory) return 'folder';
  return iconNameFor({ name: node.name, mimeType: '' });
}

/* ================================================================== preferences */
const CLIENT_ID_RE = /^[0-9]{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com$/;
const DEFAULT_PREFS = { theme: '', export: 'office', exists: 'skip', parallel: 2, conn: 4, notify: true, wake: true, fast: true, sort: 'name', clientId: '' };
const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('d2m-prefs') || '{}') || {}; } catch {}
  try { // migrate v1 keys
    const oldId = localStorage.getItem('d2m-client-id'), oldTheme = localStorage.getItem('d2m-theme');
    if (oldId && !p.clientId) p.clientId = oldId;
    if (oldTheme && !p.theme) p.theme = oldTheme;
    localStorage.removeItem('d2m-client-id'); localStorage.removeItem('d2m-theme');
  } catch {}
  const out = { ...DEFAULT_PREFS };
  if (['', 'light', 'dark'].includes(p.theme)) out.theme = p.theme;
  if (['office', 'pdf', 'skip'].includes(p.export)) out.export = p.export;
  if (['skip', 'rename', 'copy'].includes(p.exists)) out.exists = p.exists;
  if ([1, 2, 3, 4, 6].includes(p.parallel)) out.parallel = p.parallel;
  if ([1, 2, 4, 6, 8].includes(p.conn)) out.conn = p.conn;
  if (typeof p.notify === 'boolean') out.notify = p.notify;
  if (typeof p.wake === 'boolean') out.wake = p.wake;
  if (typeof p.fast === 'boolean') out.fast = p.fast;
  if (['name', 'size', 'modified'].includes(p.sort)) out.sort = p.sort;
  if (typeof p.clientId === 'string' && CLIENT_ID_RE.test(p.clientId)) out.clientId = p.clientId;
  return out;
})();
function savePrefs(){ try { localStorage.setItem('d2m-prefs', JSON.stringify(prefs)); } catch {} }
const siteClientId = typeof CONFIG.googleClientId === 'string' && CLIENT_ID_RE.test(CONFIG.googleClientId) ? CONFIG.googleClientId : '';
const clientId = () => prefs.clientId || siteClientId;

/* ================================================================== toasts & dialogs */
function toast(msg, { ms = 3800, action } = {}){
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  const el = h('div', { class: 'toast', role: 'status' },
    h('span', { class: 'sp' }, msg),
    action && h('button', { type: 'button', onclick: () => { close(); action.fn(); } }, action.label));
  box.append(el);
  if (ms) setTimeout(close, ms);
  return close;
}

/** Promise-based confirm/prompt on a native <dialog>. Resolves to true/false, or the text / null. */
function ask({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, input = null }){
  const d = $('#dlgAsk');
  $('#askTitle').textContent = title;
  $('#askText').textContent = text; $('#askText').hidden = !text;
  $('#askField').hidden = !input;
  $('#askOk').textContent = ok; $('#askCancel').textContent = cancel;
  $('#askOk').classList.toggle('danger', danger);
  if (input){ $('#askLabel').textContent = input.label; $('#askInput').value = input.value || ''; $('#askInput').placeholder = input.placeholder || ''; }
  return new Promise(resolve => {
    d.returnValue = 'cancel';
    d.addEventListener('close', () => {
      const yes = d.returnValue === 'ok';
      resolve(input ? (yes ? $('#askInput').value : null) : yes);
    }, { once: true });
    d.showModal();
    if (input) setTimeout(() => $('#askInput').select(), 0);
  });
}

/* ================================================================== theme */
function applyTheme(){
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;
}
$('#btnTheme').addEventListener('click', () => {
  const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  prefs.theme = dark ? 'light' : 'dark'; savePrefs(); applyTheme();
});

/* ================================================================== script loader */
const scripts = new Map();
function loadScript(src, integrity){
  if (!scripts.has(src)){
    scripts.set(src, new Promise((resolve, reject) => {
      const s = h('script', { src, async: true });
      if (integrity){ s.integrity = integrity; s.crossOrigin = 'anonymous'; }
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); s.remove(); reject(new Error('Could not load ' + src.replace(/^https?:\/\/|[?#].*$/g, '') + ' — check your connection or ad-blocker.')); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const MEGA_SRC = '/assets/vendor/megajs-1.3.10.min.js';
const MEGA_SRI = 'sha384-llDu8qfyuqbEdb9RM8PJjPuwpreOeGxBt4X8PlVVI+9lAUXJiMdH7mhTQUHWqU4v';
const loadGis = () => loadScript(GIS_SRC).then(() => {
  if (!window.google?.accounts?.oauth2) throw new Error('Google sign-in library failed to initialise.');
});
const loadMega = () => loadScript(MEGA_SRC, MEGA_SRI).then(() => {
  if (!window.mega?.Storage) throw new Error('MEGA library failed to initialise.');
});

/* ================================================================== Google Drive */
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,driveId,shortcutDetails(targetId,targetMimeType)';
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const EXPORTS = {
  'application/vnd.google-apps.document':     ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  'application/vnd.google-apps.spreadsheet':  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.drawing':      ['image/png', '.png'],
  'application/vnd.google-apps.script':       ['application/vnd.google-apps.script+json', '.json'],
};
const VIEWS = {
  mine:    { label: 'My Drive',       root: { id: 'root', name: 'My Drive' } },
  shared:  { label: 'Shared with me', root: { id: 'shared', name: 'Shared with me' } },
  starred: { label: 'Starred',        root: { id: 'starred', name: 'Starred' } },
  recent:  { label: 'Recent',         root: { id: 'recent', name: 'Recent' } },
  drives:  { label: 'Shared drives',  root: { id: 'drives', name: 'Shared drives' } },
};

const G = {
  token: null, expiry: 0, client: null, clientFor: '', waiters: null, user: null, quota: null,
  view: 'mine', path: [VIEWS.mine.root], items: [], selected: new Map(),
  loading: false, error: '', filter: '', anchor: -1, loadSeq: 0, shell: null, expiryTimer: 0
};
const qEsc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const validId = id => { if (!ID_RE.test(id)) throw err('Unexpected Drive item id.'); return id; };

function friendlyDriveError(status, reason, msg){
  const map = {
    cannotDownloadAbusiveFile: 'Google flagged this file as malware or spam, so it can’t be downloaded.',
    exportSizeLimitExceeded: 'Too large for Google to export (≈10 MB limit). Try the PDF option, or download it from Drive manually.',
    downloadQuotaExceeded: 'Google’s download quota for this file is used up. Try again in ~24 hours.',
    cannotDownloadFile: 'The owner has disabled downloading for this file.',
    fileNotDownloadable: 'This file type can’t be downloaded directly.',
    insufficientFilePermissions: 'You don’t have permission to download this file.',
    notFound: 'File not found, or you no longer have access to it.',
  };
  return map[reason] || (status === 404 ? map.notFound : 'Google Drive: ' + msg);
}

async function gfetch(url, opts = {}, tries = 5){
  for (let attempt = 0; ; attempt++){
    if (!G.token) throw err('Not connected to Google Drive.', { auth: true });
    let r;
    try {
      r = await fetch(url, { ...opts, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + G.token } });
    } catch (e){
      if (opts.signal?.aborted) throw e;
      if (attempt < tries - 1){ await sleep(backoff(attempt)); continue; }
      throw err('Network error while talking to Google Drive.', { retryable: true });
    }
    if (r.ok) return r;
    if (r.status === 401){ tokenExpired(); throw err('Google session expired — renew it to continue.', { auth: true }); }
    let body = {};
    try { body = await r.json(); } catch {}
    const reason = body.error?.errors?.[0]?.reason || '';
    const msg = body.error?.message || `${r.status} ${r.statusText}`;
    const retryable = r.status === 429 || r.status >= 500 || /^(rateLimitExceeded|userRateLimitExceeded|backendError|internalError)$/.test(reason);
    if (retryable && attempt < tries - 1){ await sleep(backoff(attempt, r.headers.get('retry-after'))); continue; }
    throw err(friendlyDriveError(r.status, reason, msg), { retryable, status: r.status, reason });
  }
}

const resolveShortcut = f => f.shortcutDetails && ID_RE.test(f.shortcutDetails.targetId || '')
  ? { ...f, id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType, shortcut: true, size: undefined }
  : f;

async function listFiles({ q, driveId, orderBy = 'folder,name_natural', corpora, limit = Infinity, signal }){
  const p = new URLSearchParams({ pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', fields: `nextPageToken,files(${FILE_FIELDS})`, q });
  if (orderBy) p.set('orderBy', orderBy);
  if (driveId){ p.set('corpora', 'drive'); p.set('driveId', validId(driveId)); }
  else if (corpora) p.set('corpora', corpora);
  let out = [], token;
  do {
    if (token) p.set('pageToken', token);
    const j = await (await gfetch(`${DRIVE}/files?${p}`, { signal })).json();
    out = out.concat(j.files || []); token = j.nextPageToken;
  } while (token && out.length < limit);
  return out.slice(0, limit).map(resolveShortcut);
}
const listChildren = (folder, signal) =>
  listFiles({ q: `'${qEsc(validId(folder.id))}' in parents and trashed = false`, driveId: folder.driveId, signal });

async function listSharedDrives(){
  let out = [], token;
  do {
    const p = new URLSearchParams({ pageSize: '100' }); if (token) p.set('pageToken', token);
    const j = await (await gfetch(`${DRIVE}/drives?${p}`)).json();
    out = out.concat((j.drives || []).map(d => ({ id: d.id, name: d.name, mimeType: FOLDER, driveId: d.id, isDrive: true })));
    token = j.nextPageToken;
  } while (token);
  return out;
}

function listCurrent(){
  const cur = G.path[G.path.length - 1];
  switch (cur.id){
    case 'drives': return listSharedDrives();
    case 'shared': return listFiles({ q: 'sharedWithMe = true and trashed = false' });
    case 'starred': return listFiles({ q: 'starred = true and trashed = false' });
    case 'recent': return listFiles({ q: `trashed = false and mimeType != '${FOLDER}'`, orderBy: 'viewedByMeTime desc', limit: 200 });
    case 'search': return listFiles({ q: `name contains '${qEsc(cur.query)}' and trashed = false`, orderBy: 'folder,modifiedTime desc', corpora: 'allDrives', limit: 1000 });
    default: return listChildren(cur);
  }
}

async function loadDrive(){
  const seq = ++G.loadSeq;
  G.loading = true; G.error = ''; G.anchor = -1; renderDrive();
  try {
    const items = await listCurrent();
    if (seq !== G.loadSeq) return;
    G.items = items;
  } catch (e){
    if (seq !== G.loadSeq) return;
    G.error = e.message; G.items = [];
  }
  G.loading = false; renderDrive();
}

function setView(v){
  G.view = v; G.path = [VIEWS[v].root]; G.filter = '';
  if (G.shell) G.shell.search.value = '';
  loadDrive();
}
function openFolder(f){
  G.path.push({ id: f.id, name: f.name, driveId: f.driveId || G.path[G.path.length - 1].driveId });
  G.filter = ''; if (G.shell) G.shell.search.value = '';
  loadDrive();
}
function goUp(){ if (G.path.length > 1){ G.path.pop(); loadDrive(); } }
function searchDrive(text){
  const query = text.trim().slice(0, 200);
  if (!query) return;
  G.view = 'search'; G.path = [{ id: 'search', name: `Search: “${query}”`, query }]; G.filter = '';
  G.shell.search.value = '';
  loadDrive();
}

/* ---------- auth (Google Identity Services token model; no client secret, token in memory only) */
function tokenClient(){
  const cid = clientId();
  if (G.client && G.clientFor === cid) return G.client;
  G.clientFor = cid;
  G.client = google.accounts.oauth2.initTokenClient({
    client_id: cid, scope: SCOPE, include_granted_scopes: false,
    callback: r => {
      const w = G.waiters; G.waiters = null;
      if (r.error) return w?.reject(err(r.error_description || r.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE))
        return w?.reject(err('Drive access wasn’t granted. Sign in again and tick “See and download all your Google Drive files”.'));
      G.token = r.access_token;
      G.expiry = Date.now() + (Number(r.expires_in) || 3600) * 1000;
      clearTimeout(G.expiryTimer);
      G.expiryTimer = setTimeout(() => { if (Q.running || pendingCount()) $('#renewBanner').hidden = false; }, Math.max(0, G.expiry - Date.now() - 4 * 60 * 1000));
      $('#renewBanner').hidden = true;
      w?.resolve();
    },
    error_callback: e => {
      const w = G.waiters; G.waiters = null;
      w?.reject(err(e?.type === 'popup_closed' ? 'The Google sign-in window was closed.'
        : e?.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in pop-up. Allow pop-ups for this site and try again.'
        : 'Google sign-in failed.'));
    }
  });
  return G.client;
}

async function googleAuth(prompt){
  if (!clientId()){ openSettings(); throw err('Add a Google OAuth Client ID first (Settings).'); }
  await loadGis();
  return new Promise((resolve, reject) => {
    G.waiters?.reject(err('Superseded'));
    G.waiters = { resolve, reject };
    const o = { prompt };
    if (G.user?.emailAddress) o.login_hint = G.user.emailAddress;
    tokenClient().requestAccessToken(o);
  });
}

async function connectGoogle(){
  try {
    await googleAuth('select_account');
    loadAbout();
    setView('mine');
    toast('Google Drive connected');
  } catch (e){ if (e.message !== 'Superseded') toast(e.message, { ms: 6000 }); }
}

async function loadAbout(){
  try {
    const j = await (await gfetch(`${DRIVE}/about?fields=user(displayName,emailAddress,photoLink),storageQuota(limit,usage)`)).json();
    G.user = j.user || null; G.quota = j.storageQuota || null;
  } catch {}
  renderDriveHeader();
}

function tokenExpired(){
  G.expiry = 0;
  $('#renewBanner').hidden = false;
  if (document.hidden) notify('Google session expired', 'Open Drive to MEGA and tap “Renew” to keep transferring.');
}
$('#btnRenew').addEventListener('click', async () => {
  try { await googleAuth(''); toast('Google session renewed'); pump(); }
  catch (e){ if (e.message !== 'Superseded') toast(e.message, { ms: 6000 }); }
});
const tokenFresh = () => G.token && G.expiry - Date.now() > 3 * 60 * 1000;

$('#btnGoogleOut').addEventListener('click', async () => {
  if ((Q.running || pendingCount()) && !await ask({ title: 'Disconnect Google Drive?', text: 'Transfers in progress will fail and queued ones won’t start.', ok: 'Disconnect', danger: true })) return;
  if (G.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(G.token, () => {});
  G.token = null; G.expiry = 0; G.user = null; G.quota = null; G.items = []; G.selected.clear();
  clearTimeout(G.expiryTimer); $('#renewBanner').hidden = true;
  renderDrive(); toast('Disconnected from Google Drive');
});

/* ---------- Drive rendering */
function visibleItems(){
  const f = G.filter.trim().toLowerCase();
  let items = f ? G.items.filter(i => i.name.toLowerCase().includes(f)) : G.items.slice();
  const cur = G.path[G.path.length - 1].id;
  if (cur === 'recent' || cur === 'search') return items; // keep Google's relevance/recency order
  const by = prefs.sort;
  items.sort((a, b) => ((b.mimeType === FOLDER) - (a.mimeType === FOLDER))
    || (by === 'size' ? (Number(b.size) || 0) - (Number(a.size) || 0)
      : by === 'modified' ? String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || ''))
      : 0)
    || natural.compare(a.name, b.name));
  return items;
}

function renderDriveHeader(){
  const on = !!G.token;
  $('#gBadge').textContent = on ? 'Connected' : 'Not connected';
  $('#gBadge').classList.toggle('on', on);
  $('#btnGoogleOut').hidden = !on;
  const who = $('#gWho');
  who.hidden = !(on && G.user);
  if (on && G.user){
    const photo = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//.test(G.user.photoLink || '') ? G.user.photoLink : null;
    who.replaceChildren(...[
      photo && h('img', { src: photo, alt: '', width: 24, height: 24, referrerpolicy: 'no-referrer' }),
      h('span', { title: G.user.emailAddress || '' }, G.user.emailAddress || G.user.displayName || '')].filter(Boolean));
  }
}

function driveShell(){
  if (G.shell) return G.shell;
  const search = h('input', { type: 'search', placeholder: 'Search files… (Enter searches all of Drive)', title: 'Type to filter this folder. Press Enter to search all of Google Drive.', 'aria-label': 'Search Google Drive', enterkeyhint: 'search', autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', () => { G.filter = search.value; G.anchor = -1; renderDriveList(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); searchDrive(search.value); }
    if (e.key === 'Escape' && search.value){ e.stopPropagation(); search.value = ''; G.filter = ''; renderDriveList(); }
  });
  const sort = h('select', { 'aria-label': 'Sort by', onchange: e => { prefs.sort = e.target.value; savePrefs(); renderDriveList(); } },
    h('option', { value: 'name' }, 'Name'), h('option', { value: 'modified' }, 'Newest'), h('option', { value: 'size' }, 'Largest'));
  sort.value = prefs.sort;
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Drive sections' },
    Object.entries(VIEWS).map(([k, v]) => h('button', { class: 'tab', role: 'tab', type: 'button', dataset: { v: k }, onclick: () => setView(k) }, v.label)));
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder path' });
  const list = h('div', { class: 'list', id: 'gList', role: 'list' });
  const all = h('input', { type: 'checkbox', id: 'gAll' });
  all.addEventListener('change', () => {
    visibleItems().forEach(f => all.checked ? G.selected.set(f.id, f) : G.selected.delete(f.id));
    renderDriveList();
  });
  const count = h('span');
  const foot = h('div', { class: 'pane-f' },
    h('label', { class: 'opt' }, all, ' Select all'), h('div', { class: 'sp' }), count,
    h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Refresh', 'aria-label': 'Refresh', onclick: loadDrive }, icon('refresh')));
  const tools = h('div', { class: 'tools' }, h('div', { class: 'search' }, icon('search'), search), sort);
  const root = h('div', { class: 'pane-inner' }, tabs, tools, crumbs, list, foot);
  list.addEventListener('click', onDriveListClick);
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('.row'); if (!row || e.target.matches('input')) return;
    const f = G.visible[+row.dataset.i]; if (f?.mimeType === FOLDER) openFolder(f);
  });
  G.shell = { root, tabs, search, sort, crumbs, list, all, count };
  return G.shell;
}

function onDriveListClick(e){
  const row = e.target.closest('.row'); if (!row) return;
  const i = +row.dataset.i, f = G.visible[i]; if (!f) return;
  const isBox = e.target.matches('input[type=checkbox]');
  if (!isBox && !e.target.closest('.name')) return;
  if (!isBox && f.mimeType === FOLDER && !e.shiftKey) return openFolder(f);
  if (e.shiftKey && G.anchor >= 0 && G.visible[G.anchor]){
    const on = G.selected.has(G.visible[G.anchor].id);
    const [a, b] = G.anchor < i ? [G.anchor, i] : [i, G.anchor];
    for (let k = a; k <= b; k++) on ? G.selected.set(G.visible[k].id, G.visible[k]) : G.selected.delete(G.visible[k].id);
    return renderDriveList();
  }
  const on = isBox ? e.target.checked : !G.selected.has(f.id);
  on ? G.selected.set(f.id, f) : G.selected.delete(f.id);
  row.querySelector('input').checked = on;
  row.classList.toggle('sel', on);
  G.anchor = i; syncSelectAll(); updateSummary();
}

function syncSelectAll(){
  const v = G.visible || [];
  const n = v.filter(f => G.selected.has(f.id)).length;
  G.shell.all.checked = v.length > 0 && n === v.length;
  G.shell.all.indeterminate = n > 0 && n < v.length;
  G.shell.all.disabled = !v.length;
}

function renderDriveList(){
  const s = G.shell; if (!s) return;
  const cur = G.path[G.path.length - 1];
  s.tabs.querySelectorAll('.tab').forEach(b => { const on = b.dataset.v === G.view; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  s.sort.disabled = cur.id === 'recent' || cur.id === 'search';
  s.crumbs.replaceChildren(...G.path.flatMap((p, i) => [
    i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '/') : null,
    h('button', { type: 'button', title: p.name, onclick: () => { G.path = G.path.slice(0, i + 1); loadDrive(); } }, p.name)
  ]).filter(Boolean));

  const files = G.visible = visibleItems();
  let content;
  if (G.loading) content = Array.from({ length: 8 }, () => h('div', { class: 'skel' }));
  else if (G.error) content = h('div', { class: 'empty' }, h('b', null, 'Couldn’t load this folder'), G.error, h('br'),
    h('button', { class: 'btn sm', type: 'button', onclick: loadDrive }, 'Try again'));
  else if (!files.length) content = h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('cloud')),
    h('b', null, G.filter ? 'No matches here' : cur.id === 'search' ? 'No results' : 'Nothing here'),
    G.filter ? 'Press Enter to search all of Drive.' : cur.id === 'drives' ? 'You’re not a member of any shared drives.' : 'This folder is empty.');
  else {
    const frag = document.createDocumentFragment();
    const LIMIT = 3000;
    files.slice(0, LIMIT).forEach((f, i) => {
      const isFolder = f.mimeType === FOLDER, sel = G.selected.has(f.id);
      const size = isFolder ? (f.isDrive ? 'shared drive' : 'folder') : f.size ? fmtBytes(f.size) : EXPORTS[f.mimeType] ? 'Google file' : '—';
      frag.append(h('div', { class: `row${isFolder ? ' folder' : ''}${sel ? ' sel' : ''}`, role: 'listitem', dataset: { i } },
        h('input', { type: 'checkbox', checked: sel, 'aria-label': 'Select ' + f.name }),
        icon(iconNameFor(f)),
        h('button', { class: 'name', type: 'button', title: f.name }, f.name, f.shortcut ? h('span', { class: 'tag' }, 'shortcut') : null),
        h('span', { class: 'meta' }, size, f.modifiedTime ? h('small', null, fmtDate(f.modifiedTime)) : null)));
    });
    if (files.length > LIMIT) frag.append(h('div', { class: 'empty' }, `+ ${files.length - LIMIT} more — use the filter to narrow down.`));
    content = frag;
  }
  s.list.replaceChildren(...(Array.isArray(content) ? content : [content]));
  s.count.textContent = G.loading ? '' : `${files.length} item${files.length === 1 ? '' : 's'}`;
  syncSelectAll();
  updateSummary();
}

function renderDrive(){
  renderDriveHeader();
  const body = $('#driveBody');
  if (!G.token){
    G.shell = null;
    const cid = clientId();
    body.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'art' }, icon('cloud')),
      h('b', null, 'Connect Google Drive'),
      'Read-only access — this app can list and download your files, never change or delete them.',
      h('br'),
      cid
        ? h('button', { class: 'btn primary', type: 'button', id: 'btnGoogle', onclick: connectGoogle, onpointerenter: () => loadGis().catch(() => {}), onfocus: () => loadGis().catch(() => {}) }, 'Sign in with Google')
        : h('button', { class: 'btn primary', type: 'button', onclick: openSettings }, 'Set up Google sign-in'),
      cid ? null : h('div', { class: 'hint' }, 'One-time step: this copy of the app needs a Google OAuth Client ID.')));
    updateSummary();
    return;
  }
  const s = driveShell();
  if (s.root.parentNode !== body) body.replaceChildren(s.root);
  renderDriveList();
}

/* ================================================================== MEGA */
const M = { storage: null, path: [], loggingIn: false, error: '', needs2fa: false, email: '', free: null, pendingPw: '',
  loginSeq: 0, loginAbort: null, loginStarted: 0, step: '', stepSticky: false };

function megaError(e, withCode){
  const msg = String(e?.message || e);
  if (/EMFAREQUIRED|\(-26\)|-26\b/.test(msg)) return { need2fa: true, text: 'Enter the 6-digit code from your authenticator app.' };
  if (withCode && /EFAILED|EEXPIRED|-9\b|-11\b|-26\b/.test(msg)) return { text: 'Login failed — check your password and use the current 2FA code.' };
  if (/ENOENT|EACCESS|-9\b|-11\b/.test(msg)) return { text: 'Wrong email or password.' };
  if (/EBLOCKED|-16\b/.test(msg)) return { text: 'This MEGA account is blocked. Log in on mega.nz to resolve it.' };
  if (/ETOOMANY|-6\b|ERATELIMIT|-4\b/.test(msg)) return { text: 'Too many attempts — wait a few minutes and try again.' };
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return { text: 'Couldn’t reach MEGA. Check your connection.' };
  return { text: msg };
}

// MEGA API commands we can name while logging in (megajs gives no progress events of its own).
const MEGA_STEPS = { us0: 'Contacting MEGA…', us: 'Checking your password…', ug: 'Opening your account…', f: 'Downloading your file list…' };

/** fetch() for megajs: reports login progress, notices MEGA's proof-of-work challenge, supports cancel,
 *  and patches file-tree responses that megajs 1.3.10 can't parse. */
function megaFetch(signal){
  return async (url, init = {}) => {
    let cmd = '';
    if (typeof init.body === 'string' && init.body.length < 4096){
      try { cmd = JSON.parse(init.body)[0]?.a || ''; } catch {}
      if (MEGA_STEPS[cmd]) setMegaStep(MEGA_STEPS[cmd]);
    }
    const sig = init.signal && AbortSignal.any ? AbortSignal.any([init.signal, signal]) : init.signal || signal;
    const res = await fetch(url, { ...init, signal: sig, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.headers.get('X-Hashcash')){
      setMegaStep('MEGA asked this browser to solve an anti-abuse check. This can take a few minutes — keep this tab open.', true);
      return res;
    }
    if (cmd !== 'f' || !res.ok) return res;
    // megajs calls a.ok.reduce() / iterates a.f unconditionally; MEGA omits them for some accounts,
    // which throws inside megajs and leaves login hanging forever. Default them to empty arrays.
    const data = await res.json();
    const tree = Array.isArray(data) ? data[0] : null;
    if (tree && typeof tree === 'object'){
      if (!Array.isArray(tree.ok)) tree.ok = [];
      if (!Array.isArray(tree.f)) tree.f = [];
    }
    return new Response(JSON.stringify(data), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** Rejects if megajs throws somewhere its own promises can't see (otherwise login would spin forever). */
function megaCrashGuard(){
  let off;
  const p = new Promise((_, reject) => {
    const onErr = ev => {
      const e = ev.reason || ev.error;
      if (/megajs/.test(String(e?.stack || '') + (ev.filename || ''))){ ev.preventDefault?.(); reject(err('MEGA library error: ' + (e?.message || 'unknown') + '. Please report this on GitHub.')); }
    };
    addEventListener('unhandledrejection', onErr);
    addEventListener('error', onErr);
    off = () => { removeEventListener('unhandledrejection', onErr); removeEventListener('error', onErr); };
  });
  p.catch(() => {});
  return { promise: p, off };
}

function setMegaStep(text, sticky = false){
  if (!M.loggingIn || (M.stepSticky && !sticky && text !== MEGA_STEPS.f)) return;
  M.step = text; M.stepSticky = sticky;
  paintMegaStep();
}
function paintMegaStep(){
  const el = $('#mStep'), btn = $('#mSubmit');
  if (!el || !M.loggingIn) return;
  const secs = Math.floor((Date.now() - M.loginStarted) / 1000);
  el.textContent = M.step + (secs >= 25 && !M.stepSticky && M.step === MEGA_STEPS.f ? ' Large accounts can take a minute or two.' : '');
  btn.replaceChildren(h('span', { class: 'spin' }), ` Logging in… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
}
setInterval(paintMegaStep, 1000);

function cancelMegaLogin(){
  M.loginSeq++; M.loginAbort?.abort();
  M.loggingIn = false; M.error = 'Login cancelled.';
  renderMega();
}

async function megaLogin(email, password, code){
  const seq = ++M.loginSeq;
  M.loginAbort = new AbortController();
  Object.assign(M, { loggingIn: true, error: '', email, step: 'Loading MEGA library…', stepSticky: false, loginStarted: Date.now() });
  renderMega();
  let s;
  const guard = megaCrashGuard();
  try {
    await loadMega();
    // Log in first, then load the tree separately so each phase can be reported.
    const opts = { email, password, keepalive: false, autoload: false, fetch: megaFetch(M.loginAbort.signal) };
    if (code) opts.secondFactorCode = code;
    s = new mega.Storage(opts);
    await Promise.race([s.ready, guard.promise]);
    if (seq !== M.loginSeq) return s.close();
    setMegaStep(MEGA_STEPS.f);
    await Promise.race([new Promise((resolve, reject) => s.reload(true, e => e ? reject(e) : resolve())), guard.promise]);
    if (seq !== M.loginSeq) return s.close();
    M.storage = s; M.path = [s.root]; M.needs2fa = false; M.pendingPw = '';
    toast(`Logged in to MEGA · ${Object.keys(s.files).length} items`);
    refreshQuota();
  } catch (e){
    if (seq !== M.loginSeq) return;
    try { s?.close(); } catch {}
    const m = megaError(e, !!code);
    // MEGA asks for the 2FA code only after checking the password; hold it in memory for that one retry.
    M.pendingPw = m.need2fa && !code ? password : '';
    if (m.need2fa) M.needs2fa = true;
    M.error = m.text;
  } finally {
    guard.off();
    if (seq === M.loginSeq) M.loggingIn = false;
  }
  if (seq === M.loginSeq) renderMega();
}

async function refreshQuota(){
  if (!M.storage) return;
  try {
    const a = await M.storage.getAccountInfo();
    M.free = a.spaceTotal - a.spaceUsed;
    $('#mQuota').hidden = false;
    $('#mQuotaText').textContent = `${fmtBytes(a.spaceUsed)} / ${fmtBytes(a.spaceTotal)}`;
    $('#mQuotaBar').style.width = Math.min(100, a.spaceUsed / a.spaceTotal * 100) + '%';
    $('#mQuota').title = `${fmtBytes(M.free)} free on MEGA`;
  } catch {}
}

const megaChildren = node => (node.children || []).slice().sort((a, b) =>
  (b.directory - a.directory) || natural.compare(a.name || '', b.name || ''));
const megaPathText = () => M.path.map((n, i) => i ? n.name : 'Cloud Drive').join(' / ');

function renderMegaLogin(body){
  const email = h('input', { id: 'mEmail', type: 'email', required: true, placeholder: 'you@example.com', autocomplete: 'username', value: M.email, inputmode: 'email', autocapitalize: 'off', spellcheck: 'false' });
  const kept = M.needs2fa && M.pendingPw;
  const pass = h('input', { id: 'mPass', type: 'password', required: !kept, autocomplete: 'current-password', placeholder: kept ? 'Password kept for this step' : 'Your MEGA password' });
  const eye = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false' }, icon('eye'));
  eye.addEventListener('click', () => { const show = pass.type === 'password'; pass.type = show ? 'text' : 'password'; eye.setAttribute('aria-pressed', show); eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
  const code = h('input', { id: 'm2fa', placeholder: '123456', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, autocomplete: 'one-time-code', required: M.needs2fa });
  const codeWrap = h('div', { class: 'field', hidden: !M.needs2fa }, h('label', { for: 'm2fa' }, '2FA code'), code);
  const toggle2fa = h('a', { href: '#', class: 'muted' }, 'I use two-factor authentication');
  toggle2fa.addEventListener('click', e => { e.preventDefault(); M.needs2fa = true; codeWrap.hidden = false; code.required = true; toggle2fa.parentElement.remove(); code.focus(); });
  const form = h('form', { class: 'form' },
    h('p', { class: 'hint' }, 'Your password goes only to MEGA, from this browser. It is never saved.'),
    h('div', { class: 'field' }, h('label', { for: 'mEmail' }, 'Email'), email),
    h('div', { class: 'field' }, h('label', { for: 'mPass' }, 'Password'), h('div', { class: 'pw' }, pass, eye)),
    codeWrap,
    M.error ? h('div', { class: 'err', role: 'alert' }, M.error) : null,
    h('button', { class: 'btn primary lg', type: 'submit', disabled: M.loggingIn, id: 'mSubmit' },
      M.loggingIn ? [h('span', { class: 'spin' }), ' Logging in…'] : 'Log in to MEGA'),
    M.loggingIn ? h('p', { class: 'hint center-text', id: 'mStep', role: 'status', 'aria-live': 'polite' }, M.step) : null,
    M.loggingIn ? h('div', { class: 'center-text' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: cancelMegaLogin }, 'Cancel')) : null,
    M.needs2fa || M.loggingIn ? null : h('div', { class: 'hint center-text' }, toggle2fa),
    h('p', { class: 'hint' }, 'No account? ', h('a', { href: 'https://mega.nz/register', target: '_blank', rel: 'noopener noreferrer' }, 'Create one free on mega.nz'), '.'));
  $('#mSubmit', form).classList.add('full');
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (M.loggingIn) return;
    const pw = pass.value || M.pendingPw || ''; pass.value = ''; // don't keep the password in the DOM
    if (!email.value.trim() || !pw){ M.error = 'Enter your email and password.'; renderMega(); return; }
    if (M.needs2fa && code.value && !/^\d{6}$/.test(code.value.trim())){ M.error = 'The 2FA code is 6 digits.'; renderMega(); return; }
    megaLogin(email.value.trim(), pw, code.value.trim());
  });
  body.replaceChildren(form);
  paintMegaStep();
  if (M.needs2fa && !M.loggingIn) setTimeout(() => (kept ? code : pass).focus(), 0);
}

function renderMega(){
  const body = $('#megaBody');
  const on = !!M.storage;
  $('#mBadge').textContent = on ? 'Connected' : 'Not connected';
  $('#mBadge').classList.toggle('on', on);
  $('#btnMegaOut').hidden = !on;
  if (!on){ $('#mQuota').hidden = true; renderMegaLogin(body); updateSummary(); return; }

  const cur = M.path[M.path.length - 1];
  const kids = megaChildren(cur);
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'MEGA folder path' }, M.path.flatMap((n, i) => [
    i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '/') : null,
    h('button', { type: 'button', title: i ? n.name : 'Cloud Drive', onclick: () => { M.path = M.path.slice(0, i + 1); renderMega(); } }, i ? n.name : 'Cloud Drive')
  ]).filter(Boolean));
  const list = h('div', { class: 'list', role: 'list' });
  if (!kids.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('lock')), h('b', null, 'Empty folder'), 'Transferred files will land here.'));
  else {
    const frag = document.createDocumentFragment();
    kids.slice(0, 3000).forEach(n => {
      const name = h('button', { class: 'name', type: 'button', title: n.name || '' }, n.name || '(undecryptable)');
      if (n.directory) name.addEventListener('click', () => { M.path.push(n); renderMega(); });
      else name.tabIndex = -1;
      frag.append(h('div', { class: `row mrow${n.directory ? ' folder' : ''}`, role: 'listitem' },
        icon(megaIconName(n)), name,
        h('span', { class: 'meta' }, n.directory ? '' : fmtBytes(n.size), n.timestamp ? h('small', null, fmtDate(n.timestamp * 1000)) : null)));
    });
    list.append(frag);
  }
  const foot = h('div', { class: 'pane-f' },
    h('span', null, 'Destination: ', h('b', null, M.path.length === 1 ? 'Cloud Drive' : cur.name)),
    h('div', { class: 'sp' }),
    h('button', { class: 'btn sm', type: 'button', onclick: () => newMegaFolder(cur) }, icon('plus'), 'New folder'),
    h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Refresh', 'aria-label': 'Refresh MEGA', onclick: reloadMega }, icon('refresh')));
  body.replaceChildren(h('div', { class: 'pane-inner' }, crumbs, list, foot));
  updateSummary();
}

async function newMegaFolder(parent){
  const raw = await ask({ title: 'New MEGA folder', ok: 'Create', input: { label: 'Folder name', value: '', placeholder: 'e.g. Google Drive backup' } });
  if (raw == null) return;
  const name = cleanName(raw);
  if (!raw.trim()) return toast('Folder name can’t be empty.');
  try { const node = await parent.mkdir(name); M.path.push(node); renderMega(); toast(`Created “${name}”`); }
  catch (e){ toast('Could not create folder: ' + megaError(e).text); }
}

async function reloadMega(){
  if (Q.running) return toast('Wait for transfers to finish before refreshing MEGA.');
  const handles = M.path.slice(1).map(n => n.nodeId);
  try {
    await M.storage.reload(true);
    // Re-walk to the same folder in the fresh tree.
    M.path = [M.storage.root];
    for (const id of handles){ const n = M.storage.files[id]; if (!n?.directory) break; M.path.push(n); }
  } catch (e){ toast('Refresh failed: ' + megaError(e).text); }
  renderMega(); refreshQuota();
}

$('#btnMegaOut').addEventListener('click', async () => {
  if ((Q.running || pendingCount()) && !await ask({ title: 'Log out of MEGA?', text: 'Active transfers will be cancelled.', ok: 'Log out', danger: true })) return;
  if (Q.running || pendingCount()) cancelAll();
  try { M.storage?.close(); } catch {}
  M.storage = null; M.path = []; M.error = ''; M.needs2fa = false; M.free = null; M.pendingPw = '';
  renderMega(); toast('Logged out of MEGA');
});

/* ================================================================== selection summary */
function updateSummary(){
  const sel = [...G.selected.values()];
  const folders = sel.filter(f => f.mimeType === FOLDER).length;
  const files = sel.length - folders;
  const bytes = sel.reduce((a, f) => a + (Number(f.size) || 0), 0);
  $('#selCount').textContent = sel.length
    ? `${files ? `${files} file${files === 1 ? '' : 's'}` : ''}${files && folders ? ' + ' : ''}${folders ? `${folders} folder${folders === 1 ? '' : 's'}` : ''}${bytes ? ' · ' + fmtBytes(bytes) + (folders ? '+' : '') : ''}`
    : 'Nothing selected';
  $('#selDest').textContent = !G.token ? 'Step 1: connect Google Drive.'
    : !M.storage ? 'Step 2: log in to MEGA and choose a folder.'
    : sel.length ? '→ MEGA: ' + megaPathText()
    : 'Tick files or folders on the Drive side.';
  $('#btnClearSel').hidden = !sel.length;
  $('#btnTransfer').disabled = !(sel.length && G.token && M.storage) || Q.planning;
}
$('#btnClearSel').addEventListener('click', () => { G.selected.clear(); renderDriveList(); updateSummary(); });

/* ================================================================== transfer queue */
const Q = {
  items: [], running: 0, planning: false, planCancel: false, paused: false, autoPaused: false,
  controllers: new Map(), started: 0, speed: 0, lastLoaded: 0, lastTick: 0, filter: 'all', wake: null, retryTimer: 0
};
const pendingCount = () => Q.items.filter(i => i.status === 'queued').length;
const MAX_ATTEMPTS = 4;

function exportInfo(f){
  const mode = prefs.export, ex = EXPORTS[f.mimeType];
  if (!String(f.mimeType).startsWith('application/vnd.google-apps.')) return { kind: 'binary' };
  if (!ex) return { kind: 'skip', why: 'Not downloadable (Google ' + String(f.mimeType).split('.').pop() + ')' };
  if (mode === 'skip') return { kind: 'skip', why: 'Google file (skipped by setting)' };
  if (mode === 'pdf' && f.mimeType !== 'application/vnd.google-apps.script' && f.mimeType !== 'application/vnd.google-apps.drawing') return { kind: 'export', mime: 'application/pdf', ext: '.pdf' };
  return { kind: 'export', mime: ex[0], ext: ex[1] };
}

async function megaFolder(parent, name){
  const existing = (parent.children || []).find(c => c.directory && c.name === name);
  return existing || await parent.mkdir(name);
}

async function plan(){
  const dest = M.path[M.path.length - 1];
  const sel = [...G.selected.values()];
  const keys = new Set(Q.items.filter(i => i.status === 'queued' || i.status === 'active').map(i => i.key));
  let found = 0, skippedDup = 0;
  Q.planning = true; Q.planCancel = false; updateSummary();
  const btn = $('#btnTransfer'), label = [...btn.childNodes].map(n => n.cloneNode(true));
  const progress = () => btn.replaceChildren(h('span', { class: 'spin' }), ` Scanning… ${found} file${found === 1 ? '' : 's'}`);
  progress();
  $('#queueCard').hidden = false;

  const add = (f, parent, path) => {
    const key = f.id + '>' + parent.nodeId;
    if (keys.has(key)){ skippedDup++; return; }
    keys.add(key);
    const info = exportInfo(f);
    let name = cleanName(f.name);
    if (info.kind === 'export' && !name.toLowerCase().endsWith(info.ext)) name += info.ext;
    Q.items.push({ id: crypto.randomUUID(), key, file: f, info, name, path, parent, size: Number(f.size) || 0, loaded: 0,
      status: info.kind === 'skip' ? 'skipped' : 'queued', note: info.why || '', attempts: 0, retryAt: 0 });
    found++;
    if (found % 25 === 0){ progress(); scheduleRender(); }
  };
  const visited = new Set();
  const walk = async (folder, megaParent, path, depth) => {
    if (Q.planCancel) return;
    if (depth > 64) throw err('Folder nesting is deeper than 64 levels.');
    if (visited.has(folder.id)) return; // a shortcut loop
    visited.add(folder.id);
    const target = await megaFolder(megaParent, cleanName(folder.name));
    const kids = await listChildren(folder);
    for (const k of kids){
      if (Q.planCancel) return;
      if (k.mimeType === FOLDER) await walk({ ...k, driveId: k.driveId || folder.driveId }, target, path + cleanName(folder.name) + '/', depth + 1);
      else add(k, target, path + cleanName(folder.name) + '/');
    }
  };
  try {
    for (const f of sel){
      if (Q.planCancel) break;
      if (f.mimeType === FOLDER) await walk(f, dest, '', 0);
      else add(f, dest, '');
    }
    if (!Q.planCancel){ G.selected.clear(); renderDriveList(); }
  } catch (e){ toast('Scan failed: ' + e.message, { ms: 7000 }); }
  Q.planning = false; btn.replaceChildren(...label); updateSummary();
  if (skippedDup) toast(`${skippedDup} file${skippedDup === 1 ? ' was' : 's were'} already queued.`);
  renderMega();
  if (M.free != null){
    const need = Q.items.filter(i => i.status === 'queued').reduce((a, i) => a + i.size, 0);
    if (need > M.free && !await ask({ title: 'Not enough MEGA space', text: `${fmtBytes(need)} is queued but only ${fmtBytes(M.free)} is free. Uploads will fail once MEGA is full.`, ok: 'Start anyway', cancel: 'Pause queue' })){
      setPaused(true);
    }
  }
  pump();
}

function setPaused(p, auto = false){
  Q.paused = p; Q.autoPaused = p && auto;
  renderQueue();
  if (!p) pump();
}

function pump(){
  clearTimeout(Q.retryTimer);
  const max = prefs.parallel;
  const now = Date.now();
  while (!Q.paused && Q.running < max){
    const next = Q.items.find(i => i.status === 'queued' && i.retryAt <= now);
    if (!next) break;
    if (!Q.started){ Q.started = now; Q.lastLoaded = 0; Q.lastTick = now; Q.speed = 0; }
    Q.running++;
    next.status = 'active'; next.tick = now;
    transferOne(next)
      .then(() => { if (next.status === 'active') next.status = 'done'; next.note = next.note === 'Exporting…' ? '' : next.note; })
      .catch(e => onItemError(next, e))
      .finally(() => {
        Q.running--;
        Q.controllers.delete(next.id);
        scheduleRender();
        if (Q.running === 0 && !pendingCount()) finished(); else pump();
      });
  }
  const waiting = Q.items.filter(i => i.status === 'queued' && i.retryAt > now);
  if (!Q.paused && waiting.length) Q.retryTimer = setTimeout(pump, Math.max(250, Math.min(...waiting.map(i => i.retryAt)) - now));
  updateWakeLock();
  scheduleRender();
}

function onItemError(item, e){
  const msg = e?.message || String(e);
  item.loaded = 0;
  if (item.cancelled){ item.status = 'skipped'; item.note = 'Cancelled'; return; }
  if (e?.auth){ item.status = 'queued'; item.note = 'Waiting for Google session'; return; } // not counted as an attempt
  const retryable = item.stalled || e?.retryable || e instanceof TypeError
    || /EAGAIN|ETEMPUNAVAIL|ERATELIMIT|\(-3\)|\(-4\)|\(-6\)|ended early|larger than Google|network|timed? ?out|Failed to fetch|socket|ECONNRESET/i.test(msg);
  item.stalled = false;
  item.attempts++;
  if (retryable && item.attempts < MAX_ATTEMPTS && navigator.onLine !== false){
    item.status = 'queued';
    item.retryAt = Date.now() + backoff(item.attempts);
    item.note = `Retrying (${item.attempts + 1}/${MAX_ATTEMPTS}) — ${msg}`;
  } else {
    item.status = 'error';
    item.note = /EOVERQUOTA|-17\b/.test(msg) ? 'MEGA storage is full.' : msg;
  }
}

async function waitUntilReady(item){
  // GIS tokens last ~1 h and need a click to renew, so hold here (rather than fail) until renewed and online.
  while (!tokenFresh() || navigator.onLine === false){
    if (item.cancelled) throw err('Cancelled');
    if (!tokenFresh()) $('#renewBanner').hidden = false;
    item.note = navigator.onLine === false ? 'Waiting for network' : 'Waiting for Google session';
    scheduleRender();
    await sleep(1000);
  }
  if (item.note.startsWith('Waiting')) item.note = '';
}

function uniqueName(item){
  const { parent, name } = item;
  const taken = new Set((parent.children || []).map(c => c.name));
  for (const i of Q.items) if (i !== item && i.parent === parent && i.status === 'active' && i.finalName) taken.add(i.finalName);
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; n < 10000; n++){ const c = `${base} (${n})${ext}`; if (!taken.has(c)) return c; }
  return `${base} (${Date.now()})${ext}`;
}

async function transferOne(item){
  await waitUntilReady(item);
  const f = item.file;
  const ac = new AbortController(); Q.controllers.set(item.id, ac);
  const fid = encodeURIComponent(validId(f.id));

  // Shortcut targets (and some listings) don't carry a size; we need it before uploading to MEGA.
  if (item.info.kind === 'binary' && !item.size){
    const j = await (await gfetch(`${DRIVE}/files/${fid}?fields=size&supportsAllDrives=true`, { signal: ac.signal })).json();
    item.size = Number(j.size) || 0;
  }

  item.finalName = item.name;
  if (prefs.exists !== 'copy'){
    const dup = (item.parent.children || []).find(c => !c.directory && c.name === item.name);
    if (dup && prefs.exists === 'skip' && (item.info.kind === 'export' || dup.size === item.size)){
      item.status = 'skipped'; item.note = 'Already in MEGA'; return;
    }
    if (dup && prefs.exists === 'rename') item.finalName = uniqueName(item);
  }

  let source, size;
  if (item.info.kind === 'export'){
    // Exports have no size up front, so fetch them whole (Google caps exports at ~10 MB).
    item.note = 'Exporting…'; scheduleRender();
    const r = await gfetch(`${DRIVE}/files/${fid}/export?mimeType=${encodeURIComponent(item.info.mime)}`, { signal: ac.signal });
    const buf = new Uint8Array(await r.arrayBuffer());
    size = item.size = buf.length; item.note = '';
    source = (async function* (){ yield buf; })();
  } else {
    const r = await gfetch(`${DRIVE}/files/${fid}?alt=media&supportsAllDrives=true`, { signal: ac.signal });
    size = item.size || Number(r.headers.get('content-length')) || 0;
    item.size = size;
    const reader = r.body.getReader();
    ac.signal.addEventListener('abort', () => reader.cancel().catch(() => {}));
    source = (async function* (){ for (;;){ const { done, value } = await reader.read(); if (done) return; yield value; } })();
  }

  // Fast path: encrypt on all CPU cores with hardware AES (mega-fast-crypto.js) and hand megajs ready-made
  // ciphertext. megajs reads the 32-byte file key only when the upload completes, so it is filled in late.
  const Buf = M.storage?.key?.constructor;
  const fast = prefs.fast && !Q.fastDisabled && size > 0 && window.MegaFastCrypto?.supported() && typeof Buf?.alloc === 'function';
  const key32 = fast ? Buf.alloc(32) : null;
  const up = item.parent.upload(fast
    ? { name: item.finalName, size, maxConnections: prefs.conn, uploadCiphertext: true, key: key32 }
    : { name: item.finalName, size, maxConnections: prefs.conn });
  up.on('progress', p => { item.loaded = p.bytesLoaded; item.tick = Date.now(); scheduleRender(); });
  let cancelReject;
  const cancelled = new Promise((_, rej) => { cancelReject = rej; });
  ac.signal.addEventListener('abort', () => { try { up.destroy(err('Cancelled')); } catch {} cancelReject(err(item.stalled ? 'Transfer stalled' : 'Cancelled')); });
  const failed = new Promise((_, rej) => up.on('error', rej));

  const feed = fast ? (async () => {
    try {
      await window.MegaFastCrypto.encryptStream({
        pool: window.MegaFastCrypto.pool(), size, key24: crypto.getRandomValues(new Uint8Array(24)), signal: ac.signal,
        source: (async function* (){ for await (const chunk of source){ if (ac.signal.aborted) throw err('Cancelled'); item.tick = Date.now(); yield chunk; } })(),
        write: u => up.write(u) ? undefined : new Promise(r => up.once('drain', r)),
        beforeLast: k => key32.set(k)
      });
    } catch (e){
      if (/^Encryption worker/.test(e.message)){ Q.fastDisabled = true; e.retryable = true; toast('Fast encryption isn’t available here; using standard mode.'); }
      throw e;
    }
    up.end();
  })() : (async () => {
    let sent = 0;
    for await (const chunk of source){
      if (ac.signal.aborted) throw err('Cancelled');
      sent += chunk.length; item.tick = Date.now();
      if (sent > size) throw err('File is larger than Google reported.', { retryable: true });
      if (!up.write(chunk)) await new Promise(r => up.once('drain', r));
    }
    if (sent !== size) throw err(`Download ended early (${fmtBytes(sent)} of ${fmtBytes(size)}).`, { retryable: true });
    if (size > 0) up.end(); // zero-byte uploads are ended by the library itself
  })();
  feed.catch(() => {}); // surfaced through Promise.race below

  await Promise.race([Promise.all([feed, up.complete]), cancelled, failed]);
  item.loaded = item.size;
  if (item.finalName !== item.name) item.note = `Saved as “${item.finalName}”`;
}

function cancelItem(item){
  item.cancelled = true;
  if (item.status === 'queued'){ item.status = 'skipped'; item.note = 'Cancelled'; }
  Q.controllers.get(item.id)?.abort();
  scheduleRender();
}
function cancelAll(){
  Q.planCancel = true;
  Q.items.forEach(i => { if (i.status === 'queued' || i.status === 'active') cancelItem(i); });
  renderQueue();
}

function finished(){
  if (!Q.started) return renderQueue();
  $('#renewBanner').hidden = true;
  const done = Q.items.filter(i => i.status === 'done').length;
  const failed = Q.items.filter(i => i.status === 'error').length;
  const msg = `${done} file${done === 1 ? '' : 's'} uploaded${failed ? `, ${failed} failed` : ''}.`;
  toast('Transfer finished — ' + msg, { ms: 7000, action: failed ? { label: 'Retry failed', fn: retryFailed } : null });
  notify('Transfer finished', msg);
  Q.started = 0; document.title = baseTitle;
  updateWakeLock(); refreshQuota(); renderMega(); renderQueue();
}

function retryFailed(){
  Q.items.forEach(i => { if (i.status === 'error'){ i.status = 'queued'; i.loaded = 0; i.note = ''; i.attempts = 0; i.retryAt = 0; i.cancelled = false; } });
  pump();
}

/* ---------- queue rendering (throttled) */
let renderTimer = 0;
function scheduleRender(){ if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; requestAnimationFrame(renderQueue); }, 200); }

const baseTitle = document.title;
const STATUS_LABEL = { queued: 'Queued', active: '', done: 'Done', error: 'Failed', skipped: 'Skipped' };
const ORDER = { active: 0, error: 1, queued: 2, done: 3, skipped: 4 };

function queueTotals(){
  let total = 0, loaded = 0;
  for (const i of Q.items){
    if (i.status === 'skipped') continue;
    total += i.size; loaded += i.status === 'done' ? i.size : i.loaded;
  }
  return { total, loaded };
}

function renderQueue(){
  const items = Q.items;
  const pending = pendingCount();
  $('#mqEmpty').hidden = items.length > 0;
  $('#mtabCount').hidden = !(Q.running + pending);
  $('#mtabCount').textContent = Q.running + pending;
  if (!items.length){ $('#queueCard').hidden = true; return; }
  $('#queueCard').hidden = false;

  const count = {}; for (const k of Object.keys(ORDER)) count[k] = 0;
  for (const i of items) count[i.status]++;
  const { total, loaded } = queueTotals();
  const active = Q.running || pending;
  const eta = Q.speed > 0 && active ? fmtDuration((total - loaded) / Q.speed) : '';
  $('#qStats').textContent = [
    Q.planning ? 'Scanning…' : `${count.done}/${items.length - count.skipped} done`,
    `${fmtBytes(loaded)} of ${fmtBytes(total)}`,
    Q.running && Q.speed ? fmtBytes(Q.speed) + '/s' : '',
    eta ? '~' + eta + ' left' : '',
    Q.paused ? (Q.autoPaused ? 'paused (offline)' : 'paused') : ''
  ].filter(Boolean).join(' · ');
  const pct = total ? loaded / total * 100 : 0;
  $('#overallBar').style.width = pct + '%';
  document.title = Q.started && active ? `${Math.floor(pct)}% · ${baseTitle}` : baseTitle;

  $('#btnRetry').hidden = !count.error;
  $('#btnCancel').hidden = !(Q.running || pending || Q.planning);
  $('#btnPause').hidden = !(Q.running || pending);
  $('#btnPause').textContent = Q.paused ? 'Resume' : 'Pause';
  $('#btnClear').hidden = !(count.done || count.skipped);

  const chips = [['all', 'All', items.length], ['active', 'Active', count.active], ['queued', 'Queued', count.queued], ['error', 'Failed', count.error], ['done', 'Done', count.done], ['skipped', 'Skipped', count.skipped]];
  if (Q.filter !== 'all' && !count[Q.filter]) Q.filter = 'all';
  $('#qChips').replaceChildren(...chips.filter(([k, , n]) => k === 'all' || n).map(([k, label, n]) =>
    h('button', { class: 'chip' + (Q.filter === k ? ' active' : ''), type: 'button', 'aria-pressed': Q.filter === k, onclick: () => { Q.filter = k; renderQueue(); } }, `${label} ${n}`)));

  const shown = items.filter(i => Q.filter === 'all' || i.status === Q.filter).sort((a, b) => ORDER[a.status] - ORDER[b.status]).slice(0, 400);
  const frag = document.createDocumentFragment();
  for (const i of shown){
    const p = i.status === 'done' ? 100 : i.size ? Math.min(100, i.loaded / i.size * 100) : 0;
    const st = i.status === 'active' ? (i.note && !i.loaded ? i.note : Math.floor(p) + '%') : STATUS_LABEL[i.status];
    const bar = h('i'); bar.style.width = p + '%';
    const action = i.status === 'error'
      ? h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Retry', 'aria-label': 'Retry ' + i.name, onclick: () => { Object.assign(i, { status: 'queued', attempts: 0, retryAt: 0, note: '', loaded: 0, cancelled: false }); pump(); } }, icon('retry'))
      : i.status === 'active' || i.status === 'queued'
        ? h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Cancel', 'aria-label': 'Cancel ' + i.name, onclick: () => cancelItem(i) }, icon('x'))
        : h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Remove from list', 'aria-label': 'Remove ' + i.name, onclick: () => { Q.items = Q.items.filter(x => x !== i); renderQueue(); } }, icon('x'));
    frag.append(h('div', { class: 'qi' },
      icon(iconNameFor(i.file)),
      h('div', { class: 'n' }, h('div', { title: i.name }, i.finalName || i.name),
        h('small', { title: i.note || '' }, [i.path ? '/' + i.path : '', i.size ? fmtBytes(i.size) : '', i.status !== 'active' ? i.note : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'pbw' }, h('div', { class: 'pb ' + i.status }, bar)),
      h('div', { class: 'st ' + i.status }, st),
      action));
  }
  const hiddenN = items.filter(i => Q.filter === 'all' || i.status === Q.filter).length - shown.length;
  if (hiddenN > 0) frag.append(h('div', { class: 'empty' }, `+ ${hiddenN} more`));
  $('#qList').replaceChildren(frag);
}

/* ---------- queue controls */
$('#btnTransfer').addEventListener('click', () => {
  if (!M.storage) return toast('Log in to MEGA first.');
  if (!G.token) return toast('Connect Google Drive first.');
  if (prefs.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  if (matchMedia('(max-width: 860px)').matches) setTab('queue');
  plan();
});
$('#btnCancel').addEventListener('click', async () => {
  if (await ask({ title: 'Cancel all transfers?', text: 'Files that are uploading now will be stopped. Completed uploads stay in MEGA.', ok: 'Cancel transfers', cancel: 'Keep going', danger: true })) cancelAll();
});
$('#btnPause').addEventListener('click', () => setPaused(!Q.paused));
$('#btnRetry').addEventListener('click', retryFailed);
$('#btnClear').addEventListener('click', () => { Q.items = Q.items.filter(i => i.status !== 'done' && i.status !== 'skipped'); renderQueue(); });
$('#btnExport').addEventListener('click', () => {
  // Neutralise spreadsheet formula injection from file names (=, +, -, @ prefixes).
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = [['Name', 'Saved as', 'Drive path', 'Size (bytes)', 'Status', 'Note', 'Drive file id']]
    .concat(Q.items.map(i => [i.name, i.finalName || i.name, i.path, i.size, i.status, i.note, i.file.id]));
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `drive-to-mega-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

const bindPref = (sel, key, parse = v => v, after) => {
  const el = $(sel); el.value = String(prefs[key]);
  el.addEventListener('change', () => { prefs[key] = parse(el.value); savePrefs(); after?.(); });
};
bindPref('#optExport', 'export');
bindPref('#optExists', 'exists');
bindPref('#optParallel', 'parallel', Number, pump);

/* ---------- speed sampling + stall watchdog */
setInterval(() => {
  if (!Q.running) return;
  const now = Date.now(), { loaded } = queueTotals();
  const dt = (now - Q.lastTick) / 1000;
  if (dt > 0){
    const inst = Math.max(0, loaded - Q.lastLoaded) / dt;
    Q.speed = Q.speed ? Q.speed * 0.8 + inst * 0.2 : inst;
  }
  Q.lastLoaded = loaded; Q.lastTick = now;
  for (const i of Q.items){
    if (i.status === 'active' && i.tick && now - i.tick > 120000 && navigator.onLine !== false && tokenFresh()){
      i.stalled = true; Q.controllers.get(i.id)?.abort();
    }
  }
  scheduleRender();
}, 1000);

/* ---------- wake lock & notifications */
async function updateWakeLock(){
  const want = prefs.wake && Q.running > 0 && document.visibilityState === 'visible';
  try {
    if (want && !Q.wake && 'wakeLock' in navigator){
      Q.wake = await navigator.wakeLock.request('screen');
      Q.wake.addEventListener('release', () => { Q.wake = null; });
    } else if (!want && Q.wake){ await Q.wake.release(); Q.wake = null; }
  } catch { Q.wake = null; }
}
document.addEventListener('visibilitychange', updateWakeLock);

async function notify(title, body){
  if (!prefs.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: '/assets/icons/icon-192.png', badge: '/assets/icons/badge-96.png', tag: 'd2m' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch {}
}

/* ---------- network status */
function onNetwork(){
  const online = navigator.onLine !== false;
  $('#netBadge').hidden = online;
  $('#offlineBanner').hidden = online || !(Q.running || pendingCount());
  if (!online && (Q.running || pendingCount()) && !Q.paused) setPaused(true, true);
  if (online && Q.autoPaused){ setPaused(false); toast('Back online — resuming transfers'); }
}
addEventListener('online', onNetwork);
addEventListener('offline', onNetwork);

addEventListener('beforeunload', e => {
  if (Q.running || pendingCount() || Q.planning){ e.preventDefault(); e.returnValue = ''; }
});

/* ================================================================== settings */
function openSettings(){
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  $('#originHint').textContent = secure ? location.origin : '(host this page on https:// first)';
  $('#inClientId').value = prefs.clientId;
  $('#inClientId').placeholder = siteClientId || '1234567890-abc123.apps.googleusercontent.com';
  $('#cidSource').textContent = siteClientId
    ? 'This site ships with a Client ID, so sign-in works out of the box. Enter your own only if you want to use your own Google Cloud project.'
    : 'This copy of the app has no built-in Client ID yet. Create one (free, ~5 minutes) and paste it below.';
  $('#cidHelp').open = !siteClientId && !prefs.clientId;
  $('#inConn').value = String(prefs.conn);
  $('#inNotify').checked = prefs.notify;
  $('#inWake').checked = prefs.wake;
  $('#inFast').checked = prefs.fast;
  $('#inFast').disabled = !window.MegaFastCrypto?.supported();
  $('#inTheme').value = prefs.theme;
  $('#iosHint').hidden = !(/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone);
  $('#dlgSettings').showModal();
}
$('#btnSettings').addEventListener('click', openSettings);
$('#dlgCancel').addEventListener('click', () => $('#dlgSettings').close());
$('#dlgSave').addEventListener('click', () => {
  const v = $('#inClientId').value.trim();
  if (v && !CLIENT_ID_RE.test(v)){
    toast(/secret|GOCSPX/i.test(v) ? 'That looks like a client SECRET. Never paste secrets here — use the Client ID.' : 'That doesn’t look like an OAuth Client ID (it ends in .apps.googleusercontent.com).', { ms: 7000 });
    return;
  }
  const changed = v !== prefs.clientId;
  prefs.clientId = v;
  prefs.conn = Number($('#inConn').value);
  prefs.notify = $('#inNotify').checked;
  prefs.wake = $('#inWake').checked;
  prefs.fast = $('#inFast').checked;
  prefs.theme = $('#inTheme').value;
  savePrefs(); applyTheme(); updateWakeLock();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  $('#dlgSettings').close();
  if (changed){
    if (G.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(G.token, () => {});
    G.token = null; G.client = null; G.user = null; renderDrive();
  }
  toast('Settings saved');
});
$('#btnReset').addEventListener('click', async () => {
  if (!await ask({ title: 'Erase all local data?', text: 'Removes saved preferences, your Client ID, the offline cache and the installed service worker from this browser, then reloads.', ok: 'Erase', danger: true })) return;
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
  if (G.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(G.token, () => {});
  try { M.storage?.close(); } catch {}
  location.reload();
});

$('#btnOpts').addEventListener('click', () => {
  const open = $('.actions').classList.toggle('open');
  $('#btnOpts').setAttribute('aria-expanded', open);
});

/* ================================================================== mobile tabs */
function setTab(tab){
  if (!['drive', 'mega', 'queue'].includes(tab)) return;
  $('#workspace').dataset.tab = tab;
  $$('#mtabs button').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
}
$$('#mtabs button').forEach(b => b.addEventListener('click', () => { setTab(b.dataset.tab); $('#workspace').scrollIntoView({ block: 'start' }); }));

/* ================================================================== keyboard shortcuts */
$('#btnShortcuts').addEventListener('click', () => $('#dlgKeys').showModal());
$('#keysClose').addEventListener('click', () => $('#dlgKeys').close());
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  const typing = e.target.closest?.('input, select, textarea, [contenteditable="true"]');
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === '/' && G.shell){ e.preventDefault(); G.shell.search.focus(); }
  else if (e.key === '?'){ e.preventDefault(); $('#dlgKeys').showModal(); }
  else if (e.key === 'Escape' && G.selected.size){ G.selected.clear(); renderDriveList(); }
  else if (mod && e.key.toLowerCase() === 'a' && G.shell && G.visible?.length){ e.preventDefault(); G.visible.forEach(f => G.selected.set(f.id, f)); renderDriveList(); }
  else if (e.key === 'Backspace' && G.shell){ e.preventDefault(); goUp(); }
  else if (!mod && e.key.toLowerCase() === 't' && !$('#btnTransfer').disabled){ $('#btnTransfer').click(); }
  else if (!mod && e.key.toLowerCase() === 'p' && (Q.running || pendingCount())) setPaused(!Q.paused);
});

/* ================================================================== PWA: install + updates */
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false; });
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch {}
  installEvt = null; $('#btnInstall').hidden = true;
});
addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('Drive to MEGA installed 🎉'); });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  // Reload only when the user accepted an update — not when a first-time worker claims the page.
  let updateAccepted = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateAccepted){ updateAccepted = false; location.reload(); } });
  const offerUpdate = worker => toast('A new version of Drive to MEGA is available.', { ms: 0, action: { label: 'Update', fn: async () => {
    if ((Q.running || pendingCount()) && !await ask({ title: 'Update now?', text: 'Reloading will stop the transfers in progress.', ok: 'Update', danger: true })) return;
    updateAccepted = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  } } });
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
}

/* ================================================================== boot */
applyTheme();
const params = new URLSearchParams(location.search);
if (params.get('tab')) setTab(params.get('tab'));
renderDrive(); renderMega(); renderQueue(); onNetwork();
if (clientId()) (window.requestIdleCallback || setTimeout)(() => loadGis().catch(() => {}), { timeout: 3000 });

// Dismiss the preloader (keep it at least ~450 ms so it doesn't just flash).
const pre = $('#preloader');
if (pre){
  setTimeout(() => {
    pre.classList.add('done');
    pre.addEventListener('animationend', () => pre.remove(), { once: true });
    setTimeout(() => pre.remove(), 800);
  }, Math.max(0, 450 - performance.now()));
}
window.D2M = Object.freeze({ version: VERSION });
})();
