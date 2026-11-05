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
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// ---------- Saved (★) — remembered on this device ----------
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
const filters = { q: '', year: '', category: '', tag: '', saved: false };

// ---------- Views ----------
function showView(name) {
  for (const v of ['archive', 'map', 'add']) $(`#${v}View`).hidden = v !== name;
  document.querySelectorAll('.tab[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'map') renderMap();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

$('#logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
  location.replace('index.html');
});

// ---------- Archive ----------
function filtered() {
  const saved = getSaved();
  const q = filters.q.trim().toLowerCase();
  return posts.filter(p => {
    const d = entryDate(p);
    if (filters.year && !d.startsWith(filters.year)) return false;
    if (filters.category && p.category !== filters.category) return false;
    if (filters.tag && !(p.tags || []).includes(filters.tag)) return false;
    if (filters.saved && !saved.has(p.id)) return false;
    if (q) {
      const hay = [p.title, p.text, p.category, (p.tags || []).join(' '), p.place?.name, d, fmtDate(d)]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderFilters() {
  const years = [...new Set(posts.map(p => entryDate(p).slice(0, 4)))].sort().reverse();
  const yearSel = $('#year');
  yearSel.replaceChildren(h('option', { value: '', text: 'All years' }),
    ...years.map(y => h('option', { value: y, text: y })));
  yearSel.value = filters.year;

  const cats = [...new Set([...CATEGORIES, ...posts.map(p => p.category).filter(Boolean)])];
  const catSel = $('#category');
  catSel.replaceChildren(h('option', { value: '', text: 'All categories' }),
    ...cats.map(c => h('option', { value: c, text: c })));
  catSel.value = filters.category;

  const counts = new Map();
  posts.forEach(p => (p.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  $('#tagChips').replaceChildren(...top.map(([t, n]) => h('button', {
    class: 'chip' + (filters.tag === t ? ' on' : ''),
    text: `#${t} ${n}`,
    onclick: () => { filters.tag = filters.tag === t ? '' : t; renderArchive(); },
  })));
}

function thumbEl(file) {
  if (!file) return null;
  // Videos uploaded after the archive update have a stored cover image; older ones fall back to the video itself.
  if (file.type === 'video' && !file.thumb) {
    return h('video', { src: file.url + '#t=0.1', muted: true, playsInline: true, preload: 'metadata' });
  }
  return h('img', { src: file.thumb || file.url, loading: 'lazy', alt: '' });
}

function cardEl(p) {
  const files = p.files || [];
  const saved = getSaved().has(p.id);
  const star = h('button', {
    class: 'star' + (saved ? ' on' : ''), text: saved ? '★' : '☆', 'aria-label': 'Save',
    onclick: (e) => { e.stopPropagation(); toggleSaved(p.id); renderArchive(); },
  });
  const videos = files.filter(f => f.type === 'video').length;
  const badge = files.length > 1 ? `${files.length}` + (videos ? ' ▶' : '') : (videos ? '▶' : null);
  return h('div', {
    class: 'card', tabindex: '0',
    onclick: () => openEntry(p),
    onkeydown: (e) => { if (e.key === 'Enter') openEntry(p); },
  },
    files.length ? thumbEl(files[0]) : h('div', { class: 'nomedia', text: p.text || '' }),
    star,
    badge && h('span', { class: 'badge', text: badge }),
    h('div', { class: 'card-meta' },
      h('div', { class: 'd', text: fmtDate(entryDate(p)) }),
      h('div', { class: 't', text: entryTitle(p) })));
}

function renderArchive() {
  renderFilters();
  const list = filtered().sort((a, b) =>
    entryDate(b).localeCompare(entryDate(a)) || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const years = new Set(posts.map(p => entryDate(p).slice(0, 4)));
  const photos = posts.reduce((n, p) => n + (p.files || []).length, 0);
  $('#stats').replaceChildren(
    h('b', { text: posts.length }), ' entries · ',
    h('b', { text: photos }), ' photos & videos · ',
    h('b', { text: years.size }), years.size === 1 ? ' year' : ' years',
    list.length !== posts.length ? ` · showing ${list.length}` : '');

  const tl = $('#timeline');
  if (!list.length) {
    tl.replaceChildren(h('div', {
      class: 'empty',
      text: posts.length ? 'Nothing matches these filters.' :
        owner ? 'Nothing here yet. Use “+ Add” to start the archive.' : 'Nothing here yet.',
    }));
    return;
  }

  const out = [];
  let key = null, grid = null, count = 0, countEl = null;
  for (const p of list) {
    const k = entryDate(p).slice(0, 7);
    if (k !== key) {
      if (countEl) countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
      key = k; count = 0;
      const [y, m] = k.split('-').map(Number);
      countEl = h('span');
      out.push(h('div', { class: 'month' },
        h('h2', { text: new Date(y, m - 1).toLocaleString('en', { month: 'long', year: 'numeric' }) }), countEl));
      grid = h('div', { class: 'grid' });
      out.push(grid);
    }
    grid.append(cardEl(p));
    count++;
  }
  if (countEl) countEl.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
  tl.replaceChildren(...out);
}

$('#q').addEventListener('input', (e) => { filters.q = e.target.value; renderArchive(); });
$('#year').addEventListener('change', (e) => { filters.year = e.target.value; renderArchive(); });
$('#category').addEventListener('change', (e) => { filters.category = e.target.value; renderArchive(); });
$('#savedOnly').addEventListener('change', (e) => { filters.saved = e.target.checked; renderArchive(); });

// ---------- One entry, full screen ----------
function openEntry(p) {
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const media = (p.files || []).map(f => f.type === 'video'
    ? h('video', { src: f.url, controls: true, playsInline: true, preload: 'metadata', poster: f.thumb })
    : h('img', { src: f.url, loading: 'lazy', alt: '' }));

  const facts = h('div', { class: 'modal-facts' },
    h('span', { text: fmtDate(entryDate(p)) }),
    p.category && h('span', { text: p.category }),
    p.place?.name && h('span', { text: '📍 ' + p.place.name }),
    ...(p.tags || []).map(t => h('a', {
      class: 'tag', href: '#', text: '#' + t,
      onclick: (e) => { e.preventDefault(); close(); filters.tag = t; showView('archive'); renderArchive(); },
    })));

  const saved = getSaved().has(p.id);
  const actions = h('div', { class: 'modal-actions' },
    h('button', {
      class: 'btn small', text: saved ? '★ Saved' : '☆ Save',
      onclick: (e) => { toggleSaved(p.id); e.target.textContent = getSaved().has(p.id) ? '★ Saved' : '☆ Save'; renderArchive(); },
    }),
    owner && h('button', { class: 'btn small', text: 'Edit', onclick: () => editForm(p, body, close) }),
    owner && h('button', { class: 'btn small danger', text: 'Delete', onclick: () => removeEntry(p, close) }));

  const body = h('div', {},
    p.title && h('h2', { text: p.title }),
    facts,
    p.text && h('div', { class: 'modal-text', text: p.text }),
    actions);

  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-inner' },
      h('div', { class: 'modal-top' },
        h('span', { class: 'stats', text: `${(p.files || []).length} files` }),
        h('button', { class: 'btn small', text: 'Close ✕', onclick: close })),
      body,
      h('div', { class: 'modal-media' }, media)));
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.body.append(modal);
}

function editForm(p, body, closeModal) {
  if (body.querySelector('.edit-form')) return;
  const title = h('input', { class: 'field', value: p.title || '', placeholder: 'Title' });
  const date = h('input', { class: 'field', type: 'date', value: entryDate(p) });
  const cat = h('select', { class: 'field', value: p.category || '' },
    h('option', { value: '', text: '— category —' }),
    ...[...new Set([...CATEGORIES, p.category].filter(Boolean))].map(c => h('option', { value: c, text: c })));
  const tags = h('input', { class: 'field', value: (p.tags || []).join(', '), placeholder: 'tags, comma separated' });
  const place = h('input', { class: 'field', value: p.place?.name || '', placeholder: 'Place' });
  const text = h('textarea', { class: 'field', placeholder: 'Write something…' });
  text.value = p.text || '';

  const save = h('button', {
    class: 'btn primary small', text: 'Save', onclick: async () => {
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
        closeModal();
        renderArchive();
        openEntry(p);
        toast('Saved');
      } catch (err) {
        console.error(err);
        toast('Could not save: ' + (err.code || err.message));
        save.disabled = false;
      }
    },
  });

  body.append(h('div', { class: 'edit-form' },
    h('div', { class: 'row' }, title, date),
    h('div', { class: 'row' }, cat, place),
    h('div', { class: 'row' }, tags),
    text,
    h('div', { class: 'row' }, save)));
}

async function removeEntry(p, closeModal) {
  if (!confirm('Delete this entry and its files for good?')) return;
  try {
    await deleteDoc(doc(db, 'posts', p.id));
    await Promise.allSettled((p.files || []).flatMap(f =>
      [f.path || f.url, f.thumbPath].filter(Boolean).map(x => deleteObject(ref(storage, x)))));
    posts = posts.filter(x => x.id !== p.id);
    closeModal();
    renderArchive();
    toast('Deleted');
  } catch (err) {
    console.error(err);
    toast('Could not delete: ' + (err.code || err.message));
  }
}

// ---------- Map ----------
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
  try { L = await loadLeaflet(); } catch { $('#map').textContent = 'Map could not load.'; return; }
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
  const colors = ['#00f0ff', '#ff3df2', '#b6ff3b', '#ff5555', '#ffd23d'];
  located.forEach((p, i) => {
    const pop = h('div', { class: 'map-pop' },
      thumbEl((p.files || []).find(f => f.type !== 'video') || (p.files || [])[0]),
      h('div', { text: fmtDate(entryDate(p)) }),
      h('div', { text: entryTitle(p) || p.place.name || '' }));
    pop.addEventListener('click', () => openEntry(p));
    L.circleMarker([p.place.lat, p.place.lng], {
      radius: 7, color: colors[i % colors.length], weight: 2, fillOpacity: 0.6,
    }).bindPopup(pop).addTo(mapLayer);
  });
  if (located.length) {
    map.fitBounds(L.latLngBounds(located.map(p => [p.place.lat, p.place.lng])).pad(0.3), { maxZoom: 12 });
  } else {
    toast('No entries have a location yet. Photos with GPS get one automatically.', 4000);
  }
}

// ---------- Add: read files, group, upload ----------
let exifrPromise = null;
const loadExifr = () => (exifrPromise ||= import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs')
  .then(m => m.default).catch(() => null));

// Grab one still frame from a video (about 1 second in) as a small JPEG.
// Used as the video's cover image and as the picture the AI looks at. Returns null on failure.
function videoFrame(file) {
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
    // iPhones don't load video data until asked, so seek as soon as the duration is known (seeking loads it).
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); }, { once: true });
    v.addEventListener('seeked', () => {
      if (!v.videoWidth) return finish(null);
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
      await conv.execute();
      const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
      return blob.size < file.size * 0.9 ? blob : null;
    } catch (err) {
      console.warn(`Video compression (${hardwareAcceleration}) failed:`, err.message || err);
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
      return new Promise(res => c.toBlob(res, 'image/webp', q));
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
$('#clearBtn').addEventListener('click', () => { clearGroups(); });

function clearGroups() {
  groups.forEach(g => g.items.forEach(i => i.preview && URL.revokeObjectURL(i.preview)));
  groups = [];
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
  let readCount = 0;
  $('#progress').textContent = `Reading 0 of ${files.length}…`;
  await pool(files, 2, async (file) => {
    const t0 = Date.now();
    const meta = await readMeta(file);
    const isImage = file.type.startsWith('image/') || isHeic(file);
    const shrunk = isImage ? await shrink(file) : null;
    const frame = file.type.startsWith('video/') ? await videoFrame(file) : null;
    // Videos preview as their cover frame: iPhones show a <video> as a black box until it's played.
    const preview = shrunk ? URL.createObjectURL(shrunk.thumb)
      : frame ? URL.createObjectURL(frame)
        : file.type.startsWith('video/') ? URL.createObjectURL(file) : null;
    pendingItems.push({ file, meta, shrunk, frame, preview });
    readCount++;
    $('#progress').textContent = readCount < files.length ? `Reading ${readCount} of ${files.length}…` : '';
    logLine(`read ${file.name} · ${file.type || 'no type'} · ${mb(file.size)} · date ${meta.date} from ${meta.dateSource}` +
      ` · ${meta.lat != null ? 'GPS ✓' : 'no GPS'} · ${shrunk ? 'photo ✓' : frame ? 'video cover ✓' : isImage ? 'photo ✕ (could not open)' : 'video cover ✕'}` +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    regroup();
  });
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
      g.place?.lat != null && h('span', { class: 'gps', text: `📍 ${g.place.lat}, ${g.place.lng}` }),
      h('button', {
        class: 'btn small ai', text: g.aiBusy ? '✨ thinking…' : '✨ AI', disabled: !!g.aiBusy,
        onclick: () => suggest(g),
      }),
      h('span', { class: 'count', text: `${g.items.length} file(s)` }),
      h('button', {
        class: 'btn small', text: '✕', 'aria-label': 'Remove',
        onclick: () => { groups = groups.filter(x => x !== g); renderGroups(); },
      })),
    h('div', { class: 'thumbs' }, g.items.map(thumbWithProgress)),
    noPlace && h('p', { class: 'hint', text: 'No location: iPhone leaves it out by default. In the photo picker, tap “Options” at the top and turn on Location, then pick the photos again.' }),
    dateGuessed && h('p', { class: 'hint warn', text: "⚠ Couldn't find when this was taken — the date is just the file's date. Please check it." }),
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

async function suggest(g, { auto = false } = {}) {
  if (g.aiBusy) return;
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
    wait: 'waiting', compress: `compress ${pct}%`, upload: `${pct}%`, done: '✓', error: 'failed', skip: 'too big',
  }[i.phase] || '';
}

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

// One attempt. Progress made by a failed attempt is taken back off the bars.
function putFileOnce(path, blob, onBytes) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), blob, { contentType: blob.type || 'application/octet-stream' });
    const entry = { task, lastChange: Date.now(), stalled: false };
    active.add(entry);
    let last = 0;
    const watchdog = setInterval(() => {
      if (Date.now() - entry.lastChange > STALL_MS) { entry.stalled = true; task.cancel(); }
    }, 3000);
    const end = () => { clearInterval(watchdog); active.delete(entry); };
    task.on('state_changed',
      (s) => {
        if (s.bytesTransferred !== last) { onBytes(s.bytesTransferred - last); last = s.bytesTransferred; entry.lastChange = Date.now(); }
      },
      (err) => {
        end();
        onBytes(-last);
        if (entry.stalled) err = Object.assign(new Error(`no progress for ${STALL_MS / 1000}s`), { code: 'stalled' });
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
      return await putFileOnce(path, blob, onBytes);
    } catch (err) {
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
  if (!groups.length) return;
  const btn = $('#uploadBtn');
  btn.disabled = true;
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
        const small = await oneVideoAtATime(() => shrinkVideo(it.file, (p) => setItem(it, 'compress', p)));
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
      console.error('Upload failed:', it.file.name, err);
      it.error = err;
      setItem(it, 'error');
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
      $('#progress').textContent = `Done — ${saved.length} entr${saved.length === 1 ? 'y' : 'ies'} added.${skipNote}`;
      clearGroups();
      setTimeout(() => showView('archive'), 700);
    } else {
      groups = left;
      renderGroups();
      $('#progress').textContent = `${saved.length} saved, ${left.length} not yet (${firstError?.code || firstError?.message || 'error'}). ` +
        `Tap “Upload all” again to retry — finished files won't be sent twice.${skipNote}`;
    }
  } finally {
    btn.disabled = false;
    $('#barWrap').hidden = true;
    $('#bar').style.width = '0';
    try { await wakeLock?.release(); } catch {}
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
    renderArchive();
  } catch (err) {
    console.error(err);
    $('#stats').textContent = 'Could not load the archive: ' + (err.code || err.message);
  }
});
