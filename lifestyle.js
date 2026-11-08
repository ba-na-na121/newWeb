// Lifestyle — a private life archive.
// Data lives in Firestore (collection "posts") and Firebase Storage (folder "posts/").
// Friends (shared account) can browse; only the owner account can add, edit and delete.

import { auth, db, storage, isOwner, FB_SDK, getAiApp } from "./firebase-config.js";

const { onAuthStateChanged, signOut } = await import(`${FB_SDK}/firebase-auth.js`);
const { collection, addDoc, getDocs, doc, updateDoc, deleteDoc } =
  await import(`${FB_SDK}/firebase-firestore.js`);
const { ref, uploadBytesResumable, getDownloadURL, deleteObject } =
  await import(`${FB_SDK}/firebase-storage.js`);

// ---------- Settings you may want to change ----------
const CATEGORIES = ['Daily', 'Travel', 'Food', 'Friends', 'Creative', 'Study', 'Other'];
const AI_MODEL = 'gemini-3.5-flash-lite';   // Gemini model used for auto-tagging
const DISPLAY_MAX = 2000;                   // longest side of the website copy, px
const THUMB_MAX = 480;                      // longest side of grid thumbnails, px
const MAX_VIDEO_MB = 500;                   // keep in sync with storage.rules

// ---------- Small helpers ----------
const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  if (value !== undefined) el.value = value;
  return el;
}

const localDay = (d) => new Date(d).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const entryDate = (p) => p.date || (p.createdAt || '').slice(0, 10) || '1970-01-01';
const entryTitle = (p) => p.title || (p.text || '').split('\n')[0] || '';
const parseTags = (s) => [...new Set(String(s || '')
  .split(/[,，#\n]+/).map(t => t.trim().toLowerCase()).filter(Boolean))];
const fmtDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
};

function toast(msg, ms = 3000) {
  const t = h('div', { class: 'toast', role: 'status', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} (${ms / 1000}s)`)), ms); })])
    .finally(() => clearTimeout(t));
}

// On-screen log for the Add page, so problems on a phone (no developer tools there) can be seen and screenshotted.
const logStart = Date.now();
function logLine(msg) {
  const el = document.getElementById('log');
  if (!el) return;
  const t = ((Date.now() - logStart) / 1000).toFixed(1).padStart(6);
  el.textContent = (el.textContent + `${t}s  ${msg}\n`).split('\n').slice(-300).join('\n');
  if (/^(↻|✕|AI ✕)/.test(msg)) el.closest('details')?.setAttribute('open', '');
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// Cancelling: "Clear" stops reading files; while uploading it becomes "Cancel" and stops the upload.
let readGen = 0;              // bumped by Clear, so files still being read are dropped
let readingNow = 0;           // how many addFiles() runs are in progress
let uploading = false;
let cancelRequested = false;
let currentConversion = null; // video compression in progress, so it can be stopped
const cancelledError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

// ---------- Icons: one consistent set on a 24px grid (replaces all emoji in the interface) ----------
const ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  map: '<path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8 9 4.5z"/><path d="M9 4.5v12.7M15 6.8v12.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  timeline: '<path d="M4 6.5h16M4 12h16M4 17.5h9"/>',
  star: '<path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  images: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 16l5-5 4 4 3-3 5 5"/><circle cx="15.5" cy="9.5" r="1.5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  upload: '<path d="M12 15V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v3A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
};

function icon(name, { filled = false } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="icon${filled ? ' filled' : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return tpl.content.firstChild;
}
document.querySelectorAll('[data-icon]').forEach(el => el.prepend(icon(el.dataset.icon)));

// ---------- Colours: one per category (black text sits on these) ----------
const CATEGORY_COLORS = {
  Daily: '#FFD43B', Travel: '#7C9CF0', Food: '#FF8A3D', Friends: '#FFB8EC',
  Creative: '#B9A8FF', Study: '#93AE6B', Other: '#C8B9B3',
};
const SAVED_COLOR = '#F3EFE6';
const BAND_COLORS = ['#FFD43B', '#C8B9B3', '#FFB8EC', '#7C9CF0', '#93AE6B', '#FF8A3D', '#B9A8FF'];
const catOf = (p) => p.category || 'Other';
const colorOf = (cat) => CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const byNewest = (a, b) => entryDate(b).localeCompare(entryDate(a)) || (b.createdAt || '').localeCompare(a.createdAt || '');
const coverSrc = (p) => {
  const f = (p.files || []).find(x => x.thumb || x.type === 'image');
  return f ? (f.thumb || f.url) : null;
};
const monthName = (y, m, style = 'long') => new Date(y, m - 1).toLocaleString('en', { month: style });

// ---------- Saved — remembered on this device ----------
const SAVED_KEY = 'lifestyle-likes';
function getSaved() {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')); } catch { return new Set(); }
}
function toggleSaved(id) {
  const s = getSaved();
  s.has(id) ? s.delete(id) : s.add(id);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify([...s])); } catch {}
}

// ---------- State ----------
let posts = [];
let owner = false;
let loaded = false;
let cameFromApp = false;     // so "back" on an entry returns to where you were

// ---------- Routes (the address bar keeps your place, so the phone's back gesture works) ----------
//  #/folders  #/folders/Travel  #/timeline  #/timeline/2025  #/timeline/2025/07
//  #/entry/<id>  #/search/<words>  #/map  #/add
const MODE_KEY = 'lifestyle-browse';
const getMode = () => { try { return localStorage.getItem(MODE_KEY) === 'timeline' ? 'timeline' : 'folders'; } catch { return 'folders'; } };
const setMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch {} };
const go = (hash) => { location.hash = hash; };

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name = '', ...rest] = raw.split('/');
  return { name, rest: rest.map(decodeURIComponent) };
}

function route({ keepScroll = false } = {}) {
  const { name, rest } = parseRoute();
  const view = name === 'map' ? 'map' : (name === 'add' && owner) ? 'add' : 'browse';
  $('#browseView').hidden = view !== 'browse';
  $('#mapView').hidden = view !== 'map';
  $('#addView').hidden = view !== 'add';
  document.querySelectorAll('.actions a.icon-btn').forEach(a =>
    a.toggleAttribute('aria-current', a.getAttribute('href') === `#/${name}`));
  if (view === 'map') renderMap();
  if (view === 'browse' && loaded) renderBrowse(name, rest);
  if (!keepScroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { cameFromApp = true; route(); });

// Older code calls these after uploading or deleting.
function showView(name) { go(name === 'archive' ? '#/' : `#/${name}`); }
function renderArchive() { if (!$('#browseView').hidden) route({ keepScroll: true }); }

$('#logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
  location.replace('index.html');
});

// ---------- Shared pieces ----------
function switchEl(active) {
  return h('nav', { class: 'switch', 'aria-label': 'Browse by' },
    h('a', { href: '#/folders', 'aria-current': active === 'folders' ? 'page' : null }, icon('folder'), 'Folders'),
    h('a', { href: '#/timeline', 'aria-current': active === 'timeline' ? 'page' : null }, icon('timeline'), 'Timeline'));
}

function pageHead(title, backHref, sub, color) {
  return [
    h('div', { class: 'page-head' },
      h('a', { class: 'back', href: backHref, 'aria-label': 'Back' }, icon('chevron-left')),
      color && h('span', { class: 'title-chip', style: `background:${color}` }),
      h('h1', { class: 'page-title', text: title })),
    sub && h('p', { class: 'page-sub', text: sub }),
  ].filter(Boolean);
}

function emptyEl(text) {
  return h('div', { class: 'empty' },
    h('p', { text }),
    owner && h('a', { class: 'btn primary', href: '#/add' }, icon('plus'), 'Add photos'));
}

function cardEl(p) {
  const files = p.files || [];
  const first = files[0];
  const src = coverSrc(p);
  const videos = files.filter(f => f.type === 'video').length;
  const media = src ? h('img', { src, alt: '', loading: 'lazy' })
    : first?.type === 'video' ? h('video', { src: first.url + '#t=0.1', muted: true, playsInline: true, preload: 'metadata' })
      : h('div', { class: 'nomedia', text: p.text || '' });
  return h('a', { class: 'card', href: `#/entry/${p.id}` },
    h('div', { class: 'card-media' },
      media,
      (files.length > 1 || videos > 0) && h('span', { class: 'card-chip' },
        icon(videos ? 'play' : 'images', { filled: !!videos }), files.length > 1 ? String(files.length) : ''),
      getSaved().has(p.id) && h('span', { class: 'card-saved', 'aria-label': 'Saved' }, icon('star', { filled: true }))),
    h('div', { class: 'card-title' },
      h('span', { class: 'card-dot', style: `background:${colorOf(catOf(p))}` }),
      entryTitle(p) || p.place?.name || 'Untitled'),
    h('div', { class: 'card-date', text: fmtDate(entryDate(p)) }));
}

// A grid of entries, newest first, with a small heading at each new month.
function entryGrid(list, { months = true } = {}) {
  const sorted = [...list].sort(byNewest);
  if (!months) return [h('div', { class: 'grid' }, sorted.map(cardEl))];
  const out = [];
  let key = null, grid = null;
  for (const p of sorted) {
    const k = entryDate(p).slice(0, 7);
    if (k !== key) {
      key = k;
      const [y, m] = k.split('-').map(Number);
      out.push(h('h2', { class: 'month-head', text: `${monthName(y, m)} ${y}` }));
      grid = h('div', { class: 'grid' });
      out.push(grid);
    }
    grid.append(cardEl(p));
  }
  return out;
}

// ---------- Browse ----------
function renderBrowse(name, rest) {
  const v = $('#browseView');
  if (name === 'entry') return v.replaceChildren(entryPage(rest[0]));
  if (name === 'search') return v.replaceChildren(...searchPage(rest.join('/')));
  if (name === 'folders' && rest[0]) return v.replaceChildren(...folderPage(rest[0]));
  if (name === 'timeline' && rest[1]) return v.replaceChildren(...monthPage(rest[0], rest[1]));
  if (name === 'timeline' && rest[0]) return v.replaceChildren(...yearPage(rest[0]));
  const mode = name === 'timeline' || name === 'folders' ? name : getMode();
  setMode(mode);
  v.replaceChildren(...(mode === 'timeline' ? timelineRoot() : foldersRoot()));
}

// Folders (reference 1): one folder per category, photos sticking out of the top.
function folderEl(name, list, color, iconName) {
  const pics = [...list].sort(byNewest).map(coverSrc).filter(Boolean).slice(0, 3);
  return h('a', {
    class: 'folder', href: `#/folders/${encodeURIComponent(name)}`, style: `--c:${color}`,
    'aria-label': `${name}, ${plural(list.length, 'entry', 'entries')}`,
  },
    h('span', { class: 'folder-back' }),
    h('span', { class: 'folder-peek' }, pics.map(src => h('img', { src, alt: '', loading: 'lazy' }))),
    h('span', { class: 'folder-front' },
      iconName && icon(iconName, { filled: true }),
      h('span', { class: 'folder-name', text: name }),
      h('span', { class: 'folder-count', text: plural(list.length, 'entry', 'entries') })));
}

function foldersRoot() {
  if (!posts.length) return [switchEl('folders'), emptyEl('Nothing here yet.')];
  const byCat = new Map();
  posts.forEach(p => { const c = catOf(p); byCat.set(c, [...(byCat.get(c) || []), p]); });
  const order = [...CATEGORIES, ...[...byCat.keys()].filter(c => !CATEGORIES.includes(c))];
  const saved = getSaved();
  const savedList = posts.filter(p => saved.has(p.id));
  return [
    switchEl('folders'),
    h('div', { class: 'folders' },
      savedList.length > 0 && folderEl('Saved', savedList, SAVED_COLOR, 'star'),
      order.filter(c => byCat.has(c)).map(c => folderEl(c, byCat.get(c), colorOf(c)))),
  ];
}

function folderPage(name) {
  const saved = getSaved();
  const list = name === 'Saved' ? posts.filter(p => saved.has(p.id)) : posts.filter(p => catOf(p) === name);
  return [
    ...pageHead(name, '#/folders', plural(list.length, 'entry', 'entries'), name === 'Saved' ? SAVED_COLOR : colorOf(name)),
    ...(list.length ? entryGrid(list) : [emptyEl(name === 'Saved' ? 'Tap the star on an entry to keep it here.' : 'Nothing here yet.')]),
  ];
}

// Timeline (reference 3): coloured bands, years first, then months.
function bandEl(title, short, list, color, href) {
  const places = new Set(list.map(p => p.place?.name).filter(Boolean)).size;
  const files = list.reduce((n, p) => n + (p.files || []).length, 0);
  const pics = [...list].sort(byNewest).map(coverSrc).filter(Boolean).slice(0, 3);
  return h('a', { class: 'band', href, style: `--c:${color}`, 'aria-label': `${title}, ${plural(list.length, 'entry', 'entries')}` },
    h('span', { class: 'band-go' }, icon('arrow-right')),
    h('span', { class: 'band-title' },
      h('span', { class: 'full', text: title }),
      h('span', { class: 'short', text: short || title })),
    h('span', { class: 'band-side' },
      h('b', { text: plural(list.length, 'entry', 'entries') }),
      h('span', { class: 'band-meta', text: places ? plural(places, 'place') : plural(files, 'photo') }),
      pics.length > 0 && h('span', { class: 'band-thumbs' }, pics.map(src => h('img', { src, alt: '', loading: 'lazy' })))));
}

function timelineRoot() {
  if (!posts.length) return [switchEl('timeline'), emptyEl('Nothing here yet.')];
  const years = new Map();
  posts.forEach(p => { const y = entryDate(p).slice(0, 4); years.set(y, [...(years.get(y) || []), p]); });
  const keys = [...years.keys()].sort().reverse();
  return [
    switchEl('timeline'),
    h('div', { class: 'bands' }, keys.map((y, i) => bandEl(y, y, years.get(y), BAND_COLORS[i % BAND_COLORS.length], `#/timeline/${y}`))),
  ];
}

function yearPage(y) {
  const list = posts.filter(p => entryDate(p).startsWith(y));
  const months = new Map();
  list.forEach(p => { const m = entryDate(p).slice(5, 7); months.set(m, [...(months.get(m) || []), p]); });
  const keys = [...months.keys()].sort().reverse();
  return [
    ...pageHead(y, '#/timeline', plural(list.length, 'entry', 'entries')),
    keys.length
      ? h('div', { class: 'bands' }, keys.map((m, i) => bandEl(monthName(y, +m), monthName(y, +m, 'short'), months.get(m),
        BAND_COLORS[i % BAND_COLORS.length], `#/timeline/${y}/${m}`)))
      : emptyEl('Nothing from this year.'),
  ];
}

function monthPage(y, m) {
  const list = posts.filter(p => entryDate(p).startsWith(`${y}-${m}`));
  return [
    ...pageHead(`${monthName(y, +m)} ${y}`, `#/timeline/${y}`, plural(list.length, 'entry', 'entries')),
    ...(list.length ? entryGrid(list, { months: false }) : [emptyEl('Nothing from this month.')]),
  ];
}

// Search: words match titles, text, places, categories and dates; "#tag" matches a tag exactly.
function searchMatches(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  if (q.startsWith('#')) return posts.filter(p => (p.tags || []).includes(q.slice(1)));
  return posts.filter(p => [p.title, p.text, catOf(p), (p.tags || []).join(' '), p.place?.name, entryDate(p), fmtDate(entryDate(p))]
    .join(' ').toLowerCase().includes(q));
}

function searchPage(q) {
  const results = h('div');
  const show = (text) => {
    const list = searchMatches(text);
    results.replaceChildren(...(text.trim()
      ? (list.length ? [h('p', { class: 'page-sub', text: plural(list.length, 'result') }), ...entryGrid(list)]
        : [h('p', { class: 'empty', text: `Nothing matches “${text.trim()}”.` })])
      : [h('p', { class: 'page-sub', text: 'Search titles, places, tags and dates.' })]));
  };
  const input = h('input', {
    type: 'search', value: q, placeholder: 'Search the archive', 'aria-label': 'Search the archive', enterkeyhint: 'search',
    oninput: (e) => {
      history.replaceState(null, '', `#/search/${encodeURIComponent(e.target.value)}`);
      show(e.target.value);
    },
  });
  show(q);
  setTimeout(() => input.focus(), 0);
  return [...pageHead('Search', '#/'), h('label', { class: 'search-box' }, icon('search'), input), results];
}

// One entry (reference 2): big media on top, a card in the category colour below.
function entryPage(id) {
  const p = posts.find(x => x.id === id);
  if (!p) return h('div', {}, ...pageHead('Not found', '#/'), emptyEl('This entry was deleted or the link is wrong.'));

  const cat = catOf(p);
  const color = colorOf(cat);
  const files = p.files || [];
  const d = entryDate(p);
  const [yy, mm, dd] = d.split('-').map(Number);
  const back = () => (cameFromApp ? history.back() : go('#/'));

  const saveBtn = h('button', { class: 'media-btn right', type: 'button' });
  const paintSave = () => {
    const on = getSaved().has(p.id);
    saveBtn.classList.toggle('on', on);
    saveBtn.setAttribute('aria-label', on ? 'Remove from Saved' : 'Save');
    saveBtn.setAttribute('aria-pressed', String(on));
    saveBtn.replaceChildren(icon('star', { filled: on }));
  };
  saveBtn.addEventListener('click', () => { toggleSaved(p.id); paintSave(); });
  paintSave();

  let media = null;
  if (files.length) {
    const slides = h('div', { class: 'slides' }, files.map((f, i) => h('div', { class: 'slide' },
      f.type === 'video'
        ? h('video', { src: f.url, controls: true, playsInline: true, preload: 'metadata', poster: f.thumb })
        : h('img', { src: f.url, alt: entryTitle(p) || '', loading: i ? 'lazy' : 'eager' }))));
    const dots = files.length > 1 ? h('div', { class: 'dots' }, files.map((_, i) => h('i', { class: i ? '' : 'on' }))) : null;
    if (dots) slides.addEventListener('scroll', () => {
      const i = Math.round(slides.scrollLeft / slides.clientWidth);
      [...dots.children].forEach((dot, k) => dot.classList.toggle('on', k === i));
    }, { passive: true });
    media = h('div', { class: 'entry-media' },
      slides,
      h('button', { class: 'media-btn left', type: 'button', 'aria-label': 'Back', onclick: back }, icon('chevron-left')),
      saveBtn,
      dots);
  }

  const placeName = p.place?.name || (p.place?.lat != null ? `${p.place.lat.toFixed(2)}, ${p.place.lng.toFixed(2)}` : '');
  const kinds = new Set(files.map(f => f.type));
  const filesLabel = kinds.size === 1 ? (kinds.has('video') ? 'Videos' : 'Photos') : 'Photos & videos';

  const body = h('div', {},
    h('a', { class: 'entry-when', href: `#/folders/${encodeURIComponent(cat)}`, text: cat, style: 'text-decoration:none' }),
    h('h1', { class: 'entry-title', text: entryTitle(p) || placeName || fmtDate(d) }),
    h('dl', { class: 'stats' },
      h('div', {}, h('dt', { text: 'Date' }), h('dd', {}, `${monthName(yy, mm, 'short')} ${dd}`, h('small', { text: String(yy) }))),
      h('div', {}, h('dt', { text: 'Place' }), h('dd', { text: placeName || 'Not set' })),
      h('div', {}, h('dt', { text: filesLabel }), h('dd', { text: String(files.length) }))),
    p.text && h('p', { class: 'entry-text', text: p.text }),
    (p.tags || []).length > 0 && h('div', { class: 'tags' },
      p.tags.map(t => h('a', { class: 'tag', href: `#/search/${encodeURIComponent('#' + t)}`, text: t }))),
    h('div', { class: 'entry-actions' },
      !media && h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => { toggleSaved(p.id); renderArchive(); } },
        icon('star', { filled: getSaved().has(p.id) }), getSaved().has(p.id) ? 'Saved' : 'Save'),
      owner && h('button', { class: 'pill-btn', type: 'button', onclick: () => editForm(p, card) }, icon('edit'), 'Edit'),
      owner && h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => removeEntry(p) }, icon('trash'), 'Delete')));

  const others = posts.filter(x => x.id !== p.id && catOf(x) === cat).sort(byNewest).slice(0, 9);
  const more = others.length > 0 && h('section', { class: 'more' },
    h('h2', { text: `More in ${cat}` }),
    h('div', { class: 'more-row' }, others.map(x => h('a', { href: `#/entry/${x.id}`, 'aria-label': entryTitle(x) || fmtDate(entryDate(x)) },
      coverSrc(x) ? h('img', { src: coverSrc(x), alt: '', loading: 'lazy' }) : null))));

  const card = h('div', { class: 'entry-card', style: media ? '' : 'margin-top:0' }, body, more);
  const page = h('article', { class: 'entry', style: `--c:${color}` },
    !media && pageHead('', '#/')[0],
    media, card);
  page.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) back(); });
  return page;
}

function editForm(p, card) {
  if (card.querySelector('.edit-form')) return;
  const title = h('input', { class: 'field', value: p.title || '', placeholder: 'Title', 'aria-label': 'Title' });
  const date = h('input', { class: 'field', type: 'date', value: entryDate(p), 'aria-label': 'Date' });
  const cat = h('select', { class: 'field', value: p.category || '', 'aria-label': 'Category' },
    h('option', { value: '', text: 'No category' }),
    ...[...new Set([...CATEGORIES, p.category].filter(Boolean))].map(c => h('option', { value: c, text: c })));
  const tags = h('input', { class: 'field', value: (p.tags || []).join(', '), placeholder: 'Tags, separated by commas', 'aria-label': 'Tags' });
  const place = h('input', { class: 'field', value: p.place?.name || '', placeholder: 'Place', 'aria-label': 'Place' });
  const text = h('textarea', { class: 'field', placeholder: 'Write something', 'aria-label': 'Text' });
  text.value = p.text || '';

  const save = h('button', {
    class: 'pill-btn', type: 'button', onclick: async () => {
      const update = {
        title: title.value.trim(),
        date: date.value || entryDate(p),
        category: cat.value,
        tags: parseTags(tags.value),
        text: text.value,
        place: place.value.trim()
          ? { ...(p.place || {}), name: place.value.trim() }
          : (p.place?.lat != null ? { lat: p.place.lat, lng: p.place.lng, name: '' } : null),
      };
      save.disabled = true;
      try {
        await updateDoc(doc(db, 'posts', p.id), update);
        Object.assign(p, update);
        renderArchive();
        toast('Changes saved');
      } catch (err) {
        console.error(err);
        toast('Changes not saved: ' + (err.code || err.message));
        save.disabled = false;
      }
    },
  }, icon('check'), 'Save changes');
  const cancel = h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => form.remove() }, 'Cancel');

  const form = h('div', { class: 'edit-form' },
    h('div', { class: 'two' }, title, date),
    h('div', { class: 'two' }, cat, place),
    tags, text,
    h('div', { class: 'entry-actions' }, save, cancel));
  card.querySelector('.entry-actions').after(form);
  title.focus();
}

async function removeEntry(p) {
  if (!confirm('Delete this entry and its photos for good? This can’t be undone.')) return;
  try {
    await deleteDoc(doc(db, 'posts', p.id));
    await Promise.allSettled((p.files || []).flatMap(f =>
      [f.path || f.url, f.thumbPath].filter(Boolean).map(x => deleteObject(ref(storage, x)))));
    posts = posts.filter(x => x.id !== p.id);
    toast('Entry deleted');
    go(`#/folders/${encodeURIComponent(catOf(p))}`);
  } catch (err) {
    console.error(err);
    toast('Entry not deleted: ' + (err.code || err.message));
  }
}

// ---------- Map: one dot per entry with a place, in its category colour ----------
let map = null, mapLayer = null, leafletPromise = null;
function loadLeaflet() {
  leafletPromise ||= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' }));
    const s = h('script', { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' });
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.append(s);
  });
  return leafletPromise;
}

async function renderMap() {
  let L;
  try { L = await loadLeaflet(); } catch { $('#map').textContent = 'The map could not load. Check your connection and open it again.'; return; }
  if (!map) {
    map = L.map('map', { worldCopyJump: true }).setView([30, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 50);
  mapLayer.clearLayers();
  const located = posts.filter(p => p.place && typeof p.place.lat === 'number');
  located.forEach((p) => {
    const src = coverSrc(p);
    const pop = h('a', { class: 'map-pop', href: `#/entry/${p.id}` },
      src && h('img', { src, alt: '' }),
      h('strong', { text: entryTitle(p) || p.place.name || '' }), h('br'),
      h('span', { text: fmtDate(entryDate(p)) }));
    L.circleMarker([p.place.lat, p.place.lng], {
      radius: 8, color: '#000', weight: 2, fillColor: colorOf(catOf(p)), fillOpacity: 1,
    }).bindPopup(pop).addTo(mapLayer);
  });
  if (located.length) {
    map.fitBounds(L.latLngBounds(located.map(p => [p.place.lat, p.place.lng])).pad(0.3), { maxZoom: 12 });
  } else {
    toast('No entries have a place yet. Photos with location get one automatically.', 4000);
  }
}

// ---------- Add: read files, group, upload ----------
let exifrPromise = null;
const loadExifr = () => (exifrPromise ||= import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs')
  .then(m => m.default).catch(() => null));

// Is this picture (almost) completely black? Checks a 16×16 shrunken copy.
function isDark(source) {
  try {
    const c = h('canvas', { width: 16, height: 16 });
    const x = c.getContext('2d');
    x.drawImage(source, 0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (d.length / 4) / 3 < 14;
  } catch { return false; }
}
const canvasToJpeg = (c) => c.convertToBlob
  ? c.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
  : new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));

// Grab one still frame from a video as a small JPEG, skipping black frames (fade-ins, black first second).
// Used as the video's cover image, its preview, and the picture the AI looks at. Returns null on failure.
async function videoFrame(file) {
  // 1) Decode the frame directly (WebCodecs). Works the same on iPhone and computers. On iPhone, drawing
  //    a <video> element that isn't playing gives a black picture, which is what this avoids.
  const mbLib = 'VideoDecoder' in window ? await loadMediabunny() : null;
  if (mbLib) {
    let input = null;
    try {
      input = new mbLib.Input({ source: new mbLib.BlobSource(file), formats: mbLib.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (track && await track.canDecode()) {
        const dur = await input.computeDuration().catch(() => 0);
        const w = track.displayWidth, ht = track.displayHeight;
        const s = Math.min(1, THUMB_MAX / Math.max(w, ht));
        const sink = new mbLib.CanvasSink(track, { width: Math.round(w * s), height: Math.round(ht * s), fit: 'contain' });
        const times = [Math.min(1, dur / 2), dur * 0.3, dur * 0.6, dur * 0.85].filter((t, i, a) => t >= 0 && a.indexOf(t) === i);
        let fallback = null;
        for (const t of times) {
          const wc = await sink.getCanvas(t);
          if (!wc) continue;
          if (!isDark(wc.canvas)) {
            logLine(`cover for ${file.name}: frame at ${t.toFixed(1)}s`);
            return await canvasToJpeg(wc.canvas);
          }
          fallback ||= wc.canvas;
        }
        if (fallback) { logLine(`cover for ${file.name}: whole video is dark`); return await canvasToJpeg(fallback); }
      }
    } catch (err) {
      logLine(`cover for ${file.name}: decoder failed (${String(err?.message || err).slice(0, 80)}), trying the player`);
    } finally {
      try { input?.dispose?.(); } catch {}
    }
  }
  // 2) Fallback for browsers without a video decoder: the <video> element. A black result is thrown away.
  const blob = await videoFrameFromElement(file);
  logLine(`cover for ${file.name}: ${blob ? 'from player' : 'none (could not get a picture)'}`);
  return blob;
}

function videoFrameFromElement(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'metadata';
    let done = false;
    const finish = (blob) => { if (done) return; done = true; clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(blob); };
    const timer = setTimeout(() => finish(null), 8000);
    v.addEventListener('error', () => finish(null));
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); }, { once: true });
    v.addEventListener('seeked', () => {
      if (!v.videoWidth || isDark(v)) return finish(null);
      const s = Math.min(1, THUMB_MAX / Math.max(v.videoWidth, v.videoHeight));
      const c = h('canvas', { width: Math.round(v.videoWidth * s), height: Math.round(v.videoHeight * s) });
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => finish(b), 'image/jpeg', 0.75);
    }, { once: true });
    v.src = url;
  });
}

// Shrink a video to 720p MP4 in the browser (hardware encoder, nothing to install).
// Returns null when the browser can't do it or the result isn't smaller; the original is uploaded then.
let mediabunnyPromise = null;
const loadMediabunny = () => (mediabunnyPromise ||=
  import('https://cdn.jsdelivr.net/npm/mediabunny@1.61.4/dist/bundles/mediabunny.min.mjs').catch(() => null));

async function shrinkVideo(file, onProgress) {
  if (!('VideoEncoder' in window)) return null;
  const mb = await loadMediabunny();
  if (!mb) return null;
  // Try the hardware encoder first; some machines only offer a software one.
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    if (cancelRequested) return null;
    try {
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
      const conv = await mb.Conversion.init({
        input, output,
        showWarnings: false,
        video: (track) => {
          const w = track.displayWidth, hgt = track.displayHeight;
          const scale = Math.min(1, 1280 / Math.max(w, hgt));
          return {
            width: Math.round((w * scale) / 2) * 2,
            height: Math.round((hgt * scale) / 2) * 2,
            fit: 'contain',
            codec: 'avc',              // H.264 plays everywhere, including iPhones
            bitrate: 2_000_000,        // ~15 MB per minute
            hardwareAcceleration,
            forceTranscode: true,
          };
        },
        audio: { codec: 'aac', bitrate: 128_000 },
      });
      // Never upload a video that silently lost its sound or picture.
      if (!conv.isValid || conv.discardedTracks.length) return null;
      conv.onProgress = onProgress;
      currentConversion = conv;
      try { await conv.execute(); } finally { currentConversion = null; }
      const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
      return blob.size < file.size * 0.9 ? blob : null;
    } catch (err) {
      if (cancelRequested) return null;
      console.warn(`Video compression (${hardwareAcceleration}) failed:`, err.message || err);
      logLine(`compress (${hardwareAcceleration}) failed: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  return null;
}

const isHeic = (f) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);

// When and where a video was filmed. iPhone videos store both; most others at least store a creation time.
async function readVideoMeta(file) {
  const out = {};
  const mb = await loadMediabunny();
  if (mb) {
    try {
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const tags = await input.getMetadataTags();
      if (tags.date instanceof Date && !isNaN(tags.date)) { out.date = localDay(tags.date); out.dateSource = 'video'; }
      const raw = tags.raw || {};
      // iPhone: Apple key; Android (MediaMuxer) and most cameras: ©xyz; some editors: "location"
      let loc = raw['com.apple.quicktime.location.ISO6709'] ?? raw['©xyz'] ?? raw['location'];
      if (Array.isArray(loc)) loc = loc[0];
      const m = typeof loc === 'string' && loc.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
      if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
        out.lat = +(+m[1]).toFixed(5);
        out.lng = +(+m[2]).toFixed(5);
      }
      input.dispose?.();
    } catch {}
  }
  if (!out.date) {
    const t = await mp4CreationTime(file);
    if (t) { out.date = localDay(t); out.dateSource = 'video'; }
  }
  return out;
}

// Fallback: the creation time in the MP4/MOV header ("mvhd" box), seconds since 1904 in UTC.
async function mp4CreationTime(file) {
  try {
    let pos = 0;
    while (pos + 8 <= file.size) {
      const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
      let size = head.getUint32(0);
      const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      let hdr = 8;
      if (size === 1) { size = Number(head.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = file.size - pos;
      if (size < hdr) return null;
      if (type === 'moov') {
        const moov = new Uint8Array(await file.slice(pos + hdr, pos + Math.min(size, hdr + 4e6)).arrayBuffer());
        for (let i = 4; i + 16 < moov.length; i++) {
          if (moov[i] === 0x6d && moov[i + 1] === 0x76 && moov[i + 2] === 0x68 && moov[i + 3] === 0x64) { // "mvhd"
            const dv = new DataView(moov.buffer, moov.byteOffset + i + 4);
            const secs = dv.getUint8(0) === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
            if (!secs) return null;
            const d = new Date((secs - 2082844800) * 1000);
            return d.getFullYear() >= 2000 && d <= new Date() ? d : null;
          }
        }
        return null;
      }
      pos += size;
    }
  } catch {}
  return null;
}

// Pull the raw EXIF (TIFF) block out of a HEIC file. Fallback for HEIC layouts the EXIF library can't walk.
async function heicTiff(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer()); // "meta" sits near the start
    const dv = new DataView(buf.buffer);
    const fourcc = (i) => String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    const boxes = function* (s, e) {
      while (s + 8 <= e) {
        let size = dv.getUint32(s), hdr = 8;
        const type = fourcc(s + 4);
        if (size === 1) { size = Number(dv.getBigUint64(s + 8)); hdr = 16; } else if (size === 0) size = e - s;
        if (size < hdr) return;
        yield { type, start: s + hdr, end: Math.min(s + size, e) };
        s += size;
      }
    };
    const meta = [...boxes(0, buf.length)].find(b => b.type === 'meta');
    if (!meta) return null;
    let exifId = null, iloc = null, idat = null;
    for (const b of boxes(meta.start + 4, meta.end)) {
      if (b.type === 'iinf') {
        for (const e of boxes(b.start + 4 + (buf[b.start] === 0 ? 2 : 4), b.end)) {
          if (e.type !== 'infe') continue;
          const v = buf[e.start];
          const id = v >= 3 ? dv.getUint32(e.start + 4) : dv.getUint16(e.start + 4);
          if (fourcc(e.start + 4 + (v >= 3 ? 4 : 2) + 2) === 'Exif') exifId = id;
        }
      } else if (b.type === 'iloc') iloc = b;
      else if (b.type === 'idat') idat = b;
    }
    if (exifId == null || !iloc) return null;
    const v = buf[iloc.start];
    let p = iloc.start + 4;
    const offSize = buf[p] >> 4, lenSize = buf[p] & 15, baseSize = buf[p + 1] >> 4, idxSize = v ? buf[p + 1] & 15 : 0;
    p += 2;
    const rd = (n) => { let x = 0; for (let k = 0; k < n; k++) x = x * 256 + buf[p + k]; p += n; return x; };
    const count = v < 2 ? rd(2) : rd(4);
    for (let k = 0; k < count; k++) {
      const id = v < 2 ? rd(2) : rd(4);
      const method = v ? rd(2) & 15 : 0;
      rd(2); // data_reference_index
      const base = rd(baseSize);
      const extents = rd(2);
      let first = null;
      for (let x = 0; x < extents; x++) {
        if (idxSize) rd(idxSize);
        const off = rd(offSize), len = rd(lenSize);
        first ??= { off, len };
      }
      if (id !== exifId || !first) continue;
      const at = (method === 1 && idat ? idat.start : 0) + base + first.off;
      const data = new Uint8Array(await file.slice(at, at + first.len).arrayBuffer());
      const isTiff = (i) => (data[i] === 0x49 && data[i + 1] === 0x49 && data[i + 2] === 0x2a) ||
                            (data[i] === 0x4d && data[i + 1] === 0x4d && data[i + 3] === 0x2a);
      let t = 4 + new DataView(data.buffer).getUint32(0);
      if (!isTiff(t)) t = [...Array(Math.min(64, data.length - 4)).keys()].find(isTiff) ?? -1;
      return t >= 0 ? data.slice(t) : null;
    }
  } catch {}
  return null;
}

async function readMeta(file) {
  // dateSource: 'photo' / 'video' = read from the file itself; 'file' = only the file's modified time (a guess)
  const meta = { date: localDay(file.lastModified || Date.now()), dateSource: 'file', lat: null, lng: null };
  if (file.type.startsWith('video/')) return { ...meta, ...await readVideoMeta(file) };
  if (!file.type.startsWith('image/') && !isHeic(file)) return meta; // HEIC from Windows can have an empty type
  const exifr = await loadExifr();
  if (!exifr) return meta;
  try {
    // (Full exifr build: it can also read the bare EXIF block pulled out of HEIC files.)
    let tags = null;
    try { tags = await exifr.parse(file); } catch {}
    if (isHeic(file) && !(tags?.DateTimeOriginal || tags?.CreateDate)) {
      const tiff = await heicTiff(file);
      if (tiff) tags = await exifr.parse(tiff);
    }
    const d = tags?.DateTimeOriginal || tags?.CreateDate;
    if (d instanceof Date && !isNaN(d)) { meta.date = localDay(d); meta.dateSource = 'photo'; }
    if (Number.isFinite(tags?.latitude) && Number.isFinite(tags?.longitude)) {
      meta.lat = +tags.latitude.toFixed(5);
      meta.lng = +tags.longitude.toFixed(5);
    }
  } catch {}
  return meta;
}

// Decode any photo, including iPhone HEIC. Safari (iPhone, Mac) reads HEIC itself; other browsers
// get a HEIC decoder (~3 MB) that is only downloaded the first time it's needed.
let heicPromise = null;
const loadHeic = () => (heicPromise ||=
  import('https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/heic-to.min.js').catch(() => null));

async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  if (isHeic(file)) {
    const lib = await loadHeic();
    if (lib) { try { return await lib.heicTo({ blob: file, type: 'bitmap' }); } catch {} }
  }
  return null;
}

// Shrink a photo to a website copy and a thumbnail. Returns null if it can't be decoded.
async function shrink(file) {
  try {
    const bmp = await decodeImage(file);
    if (!bmp) return null;
    const draw = (max, q) => {
      const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = h('canvas', { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      // Safari (iPhone) can't make WebP and quietly hands back a huge PNG instead, so use JPEG there.
      return new Promise(res => c.toBlob(b => b && b.type === 'image/webp' ? res(b)
        : c.toBlob(res, 'image/jpeg', q + 0.03), 'image/webp', q));
    };
    const full = await draw(DISPLAY_MAX, 0.82);
    const thumb = await draw(THUMB_MAX, 0.72);
    bmp.close?.();
    return full && thumb ? { full, thumb } : null;
  } catch { return null; }
}

let groups = []; // [{ id, date, title, text, category, tags, place, items: [{ file, meta, preview, shrunk }] }]

$('#bulkCategory').replaceChildren(h('option', { value: '', text: '— let AI choose —' }),
  ...CATEGORIES.map(c => h('option', { value: c, text: c })));

const drop = $('#drop');
$('#files').addEventListener('change', (e) => addFiles([...e.target.files]));
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
$('#groupByDay').addEventListener('change', () => regroup());
$('#clearBtn').addEventListener('click', () => {
  if (uploading) cancelUpload();
  else clearGroups();
});

function cancelUpload() {
  if (cancelRequested) return;
  cancelRequested = true;
  logLine('cancel requested');
  $('#progress').textContent = 'Cancelling…';
  $('#clearBtn').disabled = true;
  try { currentConversion?.cancel(); } catch {}
  for (const entry of active) { entry.byUser = true; entry.task.cancel(); }
}

function clearGroups() {
  readGen++;                       // files still being read are dropped
  pendingItems.forEach(i => i.preview && URL.revokeObjectURL(i.preview));
  pendingItems = [];
  groups.forEach(g => g.items.forEach(i => i.preview && URL.revokeObjectURL(i.preview)));
  groups = [];
  $('#progress').textContent = '';
  $('#files').value = '';
  renderGroups();
}

let pendingItems = [];
async function addFiles(files) {
  files = files.filter(f => /^(image|video)\//.test(f.type) || isHeic(f));
  if (!files.length) return;
  // Originals up to 4 GB are fine: they get compressed before upload.
  const tooBig = files.filter(f => f.type.startsWith('video/') && f.size > 4e9);
  if (tooBig.length) toast(`${tooBig.length} video(s) over 4 GB skipped. Trim them first.`, 5000);
  files = files.filter(f => !tooBig.includes(f));

  // Read two files at a time and show each one as soon as it's ready, instead of waiting for all of them.
  const gen = readGen;
  let readCount = 0;
  readingNow++;
  $('#uploadBtn').disabled = true;            // wait until everything is read
  $('#progress').textContent = `Reading 0 of ${files.length}…`;
  try {
  await pool(files, 2, async (file) => {
    if (gen !== readGen) return;              // Clear was pressed
    const t0 = Date.now();
    const meta = await readMeta(file);
    const isImage = file.type.startsWith('image/') || isHeic(file);
    const shrunk = isImage ? await shrink(file) : null;
    const frame = file.type.startsWith('video/') ? await videoFrame(file) : null;
    // Videos preview as their cover frame: iPhones show a <video> as a black box until it's played.
    const preview = shrunk ? URL.createObjectURL(shrunk.thumb)
      : frame ? URL.createObjectURL(frame)
        : file.type.startsWith('video/') ? URL.createObjectURL(file) : null;
    if (gen !== readGen) { if (preview) URL.revokeObjectURL(preview); return; }
    pendingItems.push({ file, meta, shrunk, frame, preview });
    readCount++;
    $('#progress').textContent = readCount < files.length ? `Reading ${readCount} of ${files.length}…` : '';
    logLine(`read ${file.name} · ${file.type || 'no type'} · ${mb(file.size)} · date ${meta.date} from ${meta.dateSource}` +
      ` · ${meta.lat != null ? 'GPS ✓' : 'no GPS'} · ${shrunk ? 'photo ✓' : frame ? 'video cover ✓' : isImage ? 'photo ✕ (could not open)' : 'video cover ✕'}` +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    regroup();
  });
  } finally {
    readingNow--;
    if (!readingNow && !uploading) $('#uploadBtn').disabled = false;
  }
  if (gen !== readGen) { logLine('reading cancelled'); return; }
  $('#progress').textContent = '';
  if ($('#autoAi').checked) groups.filter(g => !g.aiDone).forEach(g => suggest(g, { auto: true }));
}

function regroup() {
  const old = new Map(groups.map(g => [g.key, g]));
  const all = [...groups.flatMap(g => g.items), ...pendingItems];
  pendingItems = [];
  const byDay = $('#groupByDay').checked;
  const map = new Map();
  all.forEach((it, i) => {
    const key = byDay ? it.meta.date : `${it.meta.date}#${i}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  });
  groups = [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, items]) => {
    const prev = old.get(key);
    const gps = items.find(i => i.meta.lat != null)?.meta;
    return prev && prev.items.length === items.length ? prev : {
      key, items,
      date: items[0].meta.date,
      title: prev?.title || '', text: prev?.text || '',
      category: prev?.category || '', tags: prev?.tags || [],
      place: gps ? { lat: gps.lat, lng: gps.lng, name: prev?.place?.name || '' } : (prev?.place || null),
      aiDone: prev?.aiDone || false,
    };
  });
  renderGroups();
}

function renderGroups() {
  $('#uploadRow').hidden = !groups.length;
  $('#dropText').textContent = groups.length
    ? `${groups.reduce((n, g) => n + g.items.length, 0)} file(s) ready — tap to add more`
    : 'Tap to choose files, or drop them here';
  $('#groups').replaceChildren(...groups.map(groupEl));
}

function groupEl(g) {
  const bind = (el, key, map = (v) => v) => {
    el.addEventListener('input', () => { g[key] = map(el.value); });
    return el;
  };
  const heic = g.items.filter(i => isHeic(i.file) && !i.shrunk).length; // HEIC we couldn't decode
  const dateGuessed = g.items.every(i => i.meta.dateSource === 'file');
  // iPhones remove location from photos picked in a web page unless it's switched on in the picker.
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const noPlace = isIOS && g.items.some(i => i.shrunk) && g.items.every(i => i.meta.lat == null);
  return h('div', { class: 'group' },
    h('div', { class: 'group-head' },
      bind(h('input', { class: 'field', type: 'date', value: g.date }), 'date'),
      g.place?.lat != null && h('span', { class: 'gps' }, icon('pin'), `${g.place.lat}, ${g.place.lng}`),
      h('button', {
        class: 'btn small ai', disabled: !!g.aiBusy, 'aria-label': 'Let AI fill this in',
        onclick: () => suggest(g),
      }, icon('sparkle'), g.aiBusy ? 'Thinking…' : 'AI'),
      h('span', { class: 'count', text: `${g.items.length} file(s)` }),
      h('button', {
        class: 'btn small icon-only', 'aria-label': 'Remove this entry',
        onclick: () => { groups = groups.filter(x => x !== g); renderGroups(); },
      }, icon('close'))),
    h('div', { class: 'thumbs' }, g.items.map(thumbWithProgress)),
    noPlace && h('p', { class: 'hint', text: 'No location: iPhone leaves it out by default. In the photo picker, tap “Options” at the top and turn on Location, then pick the photos again.' }),
    dateGuessed && h('p', { class: 'hint warn' }, icon('alert'), h('span', { text: "Couldn't find when this was taken, so the date is the file's date. Check it before uploading." })),
    heic > 0 && h('p', { class: 'hint', text: `${heic} HEIC photo(s) couldn't be opened. Try again, or export them from iCloud as JPEG (“Most Compatible”).` }),
    bind(h('input', { class: 'field', value: g.title, placeholder: 'Title', style: 'width:100%;margin-bottom:8px' }), 'title'),
    bind(h('textarea', { class: 'field', placeholder: 'What happened? (optional)', value: g.text }), 'text'),
    h('div', { class: 'line' },
      bind(h('select', { class: 'field', value: g.category },
        h('option', { value: '', text: '— category —' }),
        ...CATEGORIES.map(c => h('option', { value: c, text: c }))), 'category'),
      bind(h('input', { class: 'field', value: g.tags.join(', '), placeholder: 'tags' }), 'tags', parseTags),
      bind(h('input', { class: 'field', value: g.placeName ?? g.place?.name ?? '', placeholder: 'Place' }), 'placeName')));
}

// ---------- AI (Gemini via Firebase AI Logic) ----------
let modelPromise = null;
async function getModel() {
  modelPromise ||= (async () => {
    const aiApp = await withTimeout(getAiApp(), 20000, 'App Check (reCAPTCHA) did not answer');
    const { getAI, getGenerativeModel, GoogleAIBackend, Schema } = await import(`${FB_SDK}/firebase-ai.js`);
    const ai = getAI(aiApp, { backend: new GoogleAIBackend() });
    return getGenerativeModel(ai, {
      model: AI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: Schema.object({
          properties: {
            title: Schema.string(),
            caption: Schema.string(),
            category: Schema.string(),
            tags: Schema.array({ items: Schema.string() }),
            place: Schema.string(),
          },
        }),
      },
    });
  })();
  return modelPromise;
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

// The reCAPTCHA key behind the AI only accepts the live site, so previews on other addresses
// (like http://192.168.x.x from `npx serve` on a phone) can't use it. localhost works with a debug token.
const AI_HOSTS = ['ba-na-na121.github.io', 'localhost', '127.0.0.1'];
let previewNoticeShown = false;

async function suggest(g, { auto = false } = {}) {
  if (g.aiBusy) return;
  if (!AI_HOSTS.includes(location.hostname)) {
    if (!auto || !previewNoticeShown) {
      toast('Preview address: AI only works on the live site (ba-na-na121.github.io). Everything else here works.', 6000);
      previewNoticeShown = true;
    }
    return;
  }
  // Photos use their thumbnail; videos use a still frame. HEIC photos can't be read by the browser.
  const images = g.items.map(i => i.shrunk?.thumb || i.frame).filter(Boolean).slice(0, 6);
  if (!images.length && !g.text) {
    if (!auto) toast("AI can't read these files (HEIC photos aren't supported). Add a note and try again.", 5000);
    return;
  }
  g.aiBusy = true;
  renderGroups();
  try {
    const model = await getModel();
    const prompt = [
      'You help organize a private personal life archive. These photos are from one day.',
      `Date: ${g.date}.`,
      g.place?.lat != null ? `GPS: ${g.place.lat}, ${g.place.lng}.` : 'No GPS.',
      g.text ? `The owner's note: "${g.text}"` : '',
      'Return JSON with:',
      '- title: 2 to 6 words, specific to what is shown.',
      '- caption: one or two plain sentences describing the moment. Do not invent names of people.',
      `- category: exactly one of ${CATEGORIES.join(', ')}.`,
      '- tags: 3 to 8 short lowercase tags (things, activities, mood, season).',
      '- place: if GPS is given, the neighborhood and city it points to; otherwise a clearly recognizable landmark or city, else an empty string.',
      'If the owner\'s note is in Chinese, write title, caption and tags in Chinese; otherwise in English.',
    ].filter(Boolean).join('\n');
    const parts = [prompt, ...await Promise.all(images.map(async b =>
      ({ inlineData: { mimeType: b.type, data: await blobToBase64(b) } })))];
    const result = await withTimeout(model.generateContent(parts), 45000, 'AI took too long');
    const out = JSON.parse(result.response.text());
    if (!g.title && out.title) g.title = out.title.trim();
    if (!g.text && out.caption) g.text = out.caption.trim();
    const pick = $('#bulkCategory').value;
    if (!g.category) g.category = pick || (CATEGORIES.includes(out.category) ? out.category : 'Other');
    g.tags = [...new Set([...g.tags, ...parseTags($('#bulkTags').value), ...parseTags((out.tags || []).join(','))])];
    if (out.place && !g.placeName && !g.place?.name) {
      g.place = { ...(g.place || {}), name: out.place.trim() };
    }
    g.aiDone = true;
    logLine(`AI ✓ ${g.date}: "${g.title}"`);
  } catch (err) {
    console.error('AI failed:', err);
    logLine(`AI ✕ ${g.date}: ${err?.code || ''} ${String(err?.message || err).slice(0, 160)}`);
    modelPromise = null; // try a fresh setup next time
    const msg = String(err?.message || err);
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    toast(
      /APP_CHECK_SITE_KEY/.test(msg) ? 'AI is off: the App Check key is not set yet.'
      : /App Check/i.test(msg) && local ? 'AI blocked on this computer: add the App Check debug token from the console (F12) in Firebase → App Check.'
      : /App Check/i.test(msg) ? 'AI blocked by App Check. Check the reCAPTCHA key and its allowed domains.'
      : 'AI could not help this time: ' + (err?.code || msg).slice(0, 120),
      7000);
  } finally {
    g.aiBusy = false;
    renderGroups();
  }
}

// ---------- Per-file progress ----------
// Each thumbnail carries its own bar and label: waiting → compressing → uploading → ✓ (or failed).
function thumbWithProgress(i) {
  const media = i.file.type.startsWith('video/') && !i.frame ? h('video', { src: i.preview, muted: true, preload: 'metadata' })
    : i.preview ? h('img', { src: i.preview, alt: '' })
      : h('div', { class: 'heic', text: 'HEIC' });
  const bar = h('i', { class: 'tbar' });
  const label = h('span', { class: 'tlabel' });
  const wrap = h('div', { class: 'tw' }, media, h('div', { class: 'ttrack' }, bar), label);
  i.ui = { wrap, bar, label };
  paintItem(i);
  return wrap;
}

function setItem(i, phase, pct = 0) {
  if (i.phase !== phase) i.since = Date.now();
  i.phase = phase;
  i.pct = pct;
  paintItem(i);
}

function paintItem(i) {
  if (!i.ui) return;
  const pct = Math.round((i.pct || 0) * 100);
  i.ui.wrap.dataset.phase = i.phase || '';
  i.ui.bar.style.width = `${i.phase === 'done' ? 100 : pct}%`;
  i.ui.label.textContent = {
    wait: 'waiting', compress: `compress ${pct}%`, upload: `${pct}%`, done: 'done', error: 'failed', skip: 'too big', cancel: 'cancelled',
  }[i.phase] || '';
  // Seconds spent at this step, once it's been a while.
  const secs = Math.round((Date.now() - (i.since || Date.now())) / 1000);
  if ((i.phase === 'upload' || i.phase === 'compress') && secs >= 5) i.ui.label.textContent += ` · ${secs}s`;
}
setInterval(() => groups.forEach(g => g.items.forEach(i => {
  if (i.phase === 'upload' || i.phase === 'compress') paintItem(i);
})), 1000);

// Run fn over items with at most `limit` at a time (phones upload faster with a few in parallel).
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// Video compression is heavy, so only one runs at a time even while photos upload in parallel.
let videoQueue = Promise.resolve();
const oneVideoAtATime = (fn) => {
  const run = videoQueue.then(fn, fn);
  videoQueue = run.catch(() => {});
  return run;
};

// ---------- Upload ----------
const STALL_MS = 30000;          // no progress for this long → cancel and try that file again
const active = new Set();        // uploads in flight: { task, lastChange }

// Files up to this size are read into memory before uploading (see putFileOnce).
const IN_MEMORY_MAX = 300 * 1e6;

// One attempt. Progress made by a failed attempt is taken back off the bars.
async function putFileOnce(path, blob, onBytes, label) {
  // Read the file into memory first. On iPhones, uploading straight from a file picked in the photo library
  // can hang forever with no error; reading it first either works or fails with a clear error.
  let data = blob;
  if (blob.size <= IN_MEMORY_MAX) {
    data = new Uint8Array(await withTimeout(blob.arrayBuffer(), 60000, 'reading the file from the phone took too long'));
  }
  if (cancelRequested) throw cancelledError();
  const t0 = Date.now();
  logLine(`↑ ${label}: sending ${mb(blob.size)} (${blob.type || 'no type'})`);
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), data, { contentType: blob.type || 'application/octet-stream' });
    const entry = { task, lastChange: Date.now(), stalled: false, byUser: false };
    active.add(entry);
    let last = 0;
    const watchdog = setInterval(() => {
      if (Date.now() - entry.lastChange > STALL_MS) { entry.stalled = true; task.cancel(); }
    }, 3000);
    const end = () => { clearInterval(watchdog); active.delete(entry); };
    task.on('state_changed',
      (s) => {
        if (s.bytesTransferred !== last) {
          if (!last) logLine(`  ${label}: first bytes reached the server after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          onBytes(s.bytesTransferred - last); last = s.bytesTransferred; entry.lastChange = Date.now();
        }
      },
      (err) => {
        end();
        onBytes(-last);
        if (entry.byUser) err = cancelledError();
        else if (entry.stalled) err = Object.assign(new Error(`no progress for ${STALL_MS / 1000}s`), { code: 'stalled' });
        else {
          const server = err?.customData?.serverResponse;
          if (server) logLine(`  server said: ${String(server).replace(/\s+/g, ' ').slice(0, 300)}`);
        }
        reject(err);
      },
      async () => {
        end();
        try { resolve(await getDownloadURL(task.snapshot.ref)); } catch (e) { reject(e); }
      });
  });
}

// Up to 4 attempts per file, with a short pause between them. Permission errors are not retried.
async function putFile(path, blob, onBytes, label = path) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await putFileOnce(path, blob, onBytes, label);
    } catch (err) {
      if (cancelRequested || err.code === 'cancelled') throw cancelledError();
      const why = err.code === 'stalled' ? err.message : (err.code || err.message);
      if (attempt >= 4 || err.code === 'storage/unauthorized' || err.code === 'storage/unauthenticated') {
        logLine(`✕ ${label}: ${why} (gave up after ${attempt} tries)`);
        throw err;
      }
      logLine(`↻ ${label}: ${why} — trying again (${attempt + 1}/4)`);
      await sleep(1500 * attempt);
    }
  }
}

// Phones pause web pages that are in the background. When the page comes back, restart any upload that
// stopped moving instead of waiting for the stall timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !active.size) return;
  logLine(`page visible again — checking ${active.size} upload(s)`);
  for (const entry of active) {
    if (Date.now() - entry.lastChange > 4000) { entry.stalled = true; entry.task.cancel(); }
  }
});

const safeName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'file';
const extFor = (type) => ({ 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }[type] || 'bin');

$('#uploadBtn').addEventListener('click', async () => {
  if (!groups.length || uploading || readingNow) return;
  const btn = $('#uploadBtn');
  btn.disabled = true;
  uploading = true;
  cancelRequested = false;
  $('#clearBtn').textContent = 'Cancel';
  $('#clearBtn').disabled = false;
  document.querySelector('details.log')?.setAttribute('open', '');
  $('#barWrap').hidden = false;

  // Keep the phone screen on while uploading: iPhones pause uploads when the screen locks.
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  const bulkTags = parseTags($('#bulkTags').value);
  const bulkCat = $('#bulkCategory').value;
  const items = groups.flatMap(g => g.items);
  const sizeOf = (i) => i.shrunk ? i.shrunk.full.size + i.shrunk.thumb.size : i.file.size + (i.frame?.size || 0);
  let total = items.reduce((n, i) => n + (i.record !== undefined ? 0 : sizeOf(i)), 0) || 1;
  let sent = 0;
  const paintTotal = () => { $('#bar').style.width = `${Math.min(100, (sent / total) * 100).toFixed(1)}%`; };
  const skipped = [];
  items.forEach(i => { if (i.record === undefined) setItem(i, 'wait'); });
  $('#progress').textContent = `Uploading ${items.length} file(s)… if you switch apps it will continue when you come back.`;
  logLine(`upload started: ${items.filter(i => i.record === undefined).length} file(s), ${mb(total)}`);

  // Upload one file (plus its thumbnail). Stores the result on the item, so a retry skips finished files.
  const uploadItem = async (it) => {
    if (it.record !== undefined) return;
    if (cancelRequested) { it.error = cancelledError(); setItem(it, 'cancel'); return; }
    it.error = null;
    const base = `posts/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName(it.file.name)}`;
    let itemTotal = sizeOf(it), itemSent = 0;
    const onBytes = (n) => {
      itemSent += n; sent += n;
      setItem(it, 'upload', Math.min(1, itemSent / itemTotal));
      paintTotal();
    };
    try {
      if (it.shrunk) {
        setItem(it, 'upload', 0);
        const path = `${base}.${extFor(it.shrunk.full.type)}`;
        const thumbPath = `${base}_t.${extFor(it.shrunk.thumb.type)}`;
        const [url, thumb] = await Promise.all([
          putFile(path, it.shrunk.full, onBytes, it.file.name),
          putFile(thumbPath, it.shrunk.thumb, onBytes, `${it.file.name} (thumbnail)`),
        ]);
        it.record = { type: 'image', url, path, thumb, thumbPath };
      } else if (it.file.type.startsWith('video/')) {
        setItem(it, 'compress', 0);
        const small = await oneVideoAtATime(() => cancelRequested ? null : shrinkVideo(it.file, (p) => setItem(it, 'compress', p)));
        if (cancelRequested) throw cancelledError();
        const blob = small || it.file;
        if (small) { total -= it.file.size - small.size; itemTotal -= it.file.size - small.size; paintTotal(); }
        else toast(`Couldn't compress ${it.file.name} in this browser — uploading the original.`, 4000);
        logLine(small ? `compressed ${it.file.name}: ${mb(it.file.size)} → ${mb(small.size)}` : `could not compress ${it.file.name} — sending original ${mb(it.file.size)}`);
        if (blob.size > MAX_VIDEO_MB * 1e6) {
          skipped.push(it.file.name);
          it.record = null;
          setItem(it, 'skip');
          return;
        }
        setItem(it, 'upload', 0);
        const ext = small ? '.mp4' : ((it.file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase());
        const path = base + ext;
        const thumbPath = it.frame ? `${base}_t.jpg` : null;  // cover image for the grid
        const [url, thumb] = await Promise.all([
          putFile(path, blob, onBytes, it.file.name),
          thumbPath ? putFile(thumbPath, it.frame, onBytes, `${it.file.name} (cover)`) : null,
        ]);
        it.record = thumb ? { type: 'video', url, path, thumb, thumbPath } : { type: 'video', url, path };
      } else {
        setItem(it, 'upload', 0);
        const ext = (it.file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        const path = base + ext;
        it.record = { type: 'image', url: await putFile(path, it.file, onBytes, it.file.name), path };
      }
      setItem(it, 'done');
      logLine(`✓ ${it.file.name} uploaded`);
    } catch (err) {
      it.error = err;
      if (err.code === 'cancelled') { setItem(it, 'cancel'); return; }
      console.error('Upload failed:', it.file.name, err);
      setItem(it, 'error');
      logLine(`✕ ${it.file.name}: ${err.code || ''} ${String(err.message || err).slice(0, 160)}`);
    }
  };

  try {
    await pool(items, 3, uploadItem);

    // Save an entry once all of its files are up. Entries with a failed file stay here to retry.
    const saved = [];
    let firstError = null;
    for (const g of groups) {
      const failed = g.items.find(i => i.error);
      if (failed) { firstError ||= failed.error; continue; }
      const files = g.items.map(i => i.record).filter(Boolean);
      if (!files.length) { saved.push(g); continue; } // everything was skipped
      const placeName = (g.placeName ?? g.place?.name ?? '').trim();
      const place = g.place?.lat != null ? { lat: g.place.lat, lng: g.place.lng, name: placeName }
        : placeName ? { name: placeName } : null;
      const entry = {
        title: (g.title || '').trim(),
        text: g.text || '',
        date: g.date,
        category: g.category || bulkCat || '',
        tags: [...new Set([...(g.tags || []), ...bulkTags])],
        place,
        files,
        createdAt: new Date().toISOString(),
      };
      try {
        const res = await addDoc(collection(db, 'posts'), entry);
        posts.push({ id: res.id, ...entry });
        saved.push(g);
      } catch (err) {
        console.error('Saving entry failed:', err);
        firstError ||= err;
      }
    }

    const left = groups.filter(g => !saved.includes(g));
    const skipNote = skipped.length ? ` Skipped (still over ${MAX_VIDEO_MB} MB): ${skipped.join(', ')}.` : '';
    renderArchive();
    if (!left.length) {
      clearGroups();   // (clears the status line too, so set the message after)
      $('#progress').textContent = `Done — ${saved.length} entr${saved.length === 1 ? 'y' : 'ies'} added.${skipNote}`;
      setTimeout(() => showView('archive'), 700);
    } else {
      groups = left;
      renderGroups();
      $('#progress').textContent = cancelRequested
        ? `Cancelled. ${saved.length} saved; ${left.length} still here. Tap “Upload all” to continue — finished files won't be sent twice.`
        : `${saved.length} saved, ${left.length} not yet (${firstError?.code || firstError?.message || 'error'}). ` +
          `Tap “Upload all” again to retry — finished files won't be sent twice.${skipNote}`;
      if (cancelRequested) logLine('upload cancelled');
    }
  } finally {
    uploading = false;
    cancelRequested = false;
    $('#clearBtn').textContent = 'Clear';
    $('#clearBtn').disabled = false;
    btn.disabled = false;
    $('#barWrap').hidden = true;
    $('#bar').style.width = '0';
    try { await wakeLock?.release(); } catch {}
  }
});

// "Copy details": the whole log as text, so it can be pasted into a message from a phone.
$('#copyLog')?.addEventListener('click', async () => {
  const text = `${navigator.userAgent}\n${location.href}\n\n${$('#log').textContent}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Details copied — paste them into your message.');
  } catch {
    const range = document.createRange();             // fallback: select it so it can be copied by hand
    range.selectNodeContents($('#log'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    toast('Text selected — tap Copy.');
  }
});

// ---------- Start: only signed-in visitors get in ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace('password.html'); return; }
  owner = isOwner(user);
  $('#addTab').hidden = !owner;
  try {
    const snap = await getDocs(collection(db, 'posts'));
    posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loaded = true;
    route();
  } catch (err) {
    console.error(err);
    $('#browseView').replaceChildren(h('p', { class: 'empty',
      text: `The archive didn't load (${err.code || err.message}). Check your connection and reload the page.` }));
  }
});
