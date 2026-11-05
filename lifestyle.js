// Lifestyle — a private life archive.
// Data lives in Firestore (collection "posts") and Firebase Storage (folder "posts/").
// Friends (shared account) can browse; only the owner account can add, edit and delete.

import { app, auth, db, storage, isOwner, FB_SDK } from "./firebase-config.js";

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
const loadExifr = () => (exifrPromise ||= import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs')
  .then(m => m.default).catch(() => null));

// Grab one still frame from a video (about 1 second in) as a small JPEG.
// Used as the video's cover image and as the picture the AI looks at. Returns null on failure.
function videoFrame(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const finish = (blob) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(blob); };
    const timer = setTimeout(() => finish(null), 10000);
    v.addEventListener('error', () => finish(null));
    v.addEventListener('loadeddata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); });
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

async function readMeta(file) {
  const meta = { date: localDay(file.lastModified || Date.now()), lat: null, lng: null };
  if (!file.type.startsWith('image/')) return meta;
  const exifr = await loadExifr();
  if (!exifr) return meta;
  try {
    // (exifr's "pick" option is broken in the lite build, so read everything — it's small.)
    const tags = await exifr.parse(file);
    const d = tags?.DateTimeOriginal || tags?.CreateDate;
    if (d instanceof Date && !isNaN(d)) meta.date = localDay(d);
    if (Number.isFinite(tags?.latitude) && Number.isFinite(tags?.longitude)) {
      meta.lat = +tags.latitude.toFixed(5);
      meta.lng = +tags.longitude.toFixed(5);
    }
  } catch {}
  return meta;
}

// Shrink an image to a website copy and a thumbnail. Returns null if the browser can't decode it.
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
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

  $('#progress').textContent = `Reading ${files.length} file(s)…`;
  const items = [];
  for (const file of files) {
    const meta = await readMeta(file);
    const shrunk = file.type.startsWith('image/') && !isHeic(file) ? await shrink(file) : null;
    const frame = file.type.startsWith('video/') ? await videoFrame(file) : null;
    const preview = shrunk ? URL.createObjectURL(shrunk.thumb)
      : file.type.startsWith('video/') ? URL.createObjectURL(file) : null;
    items.push({ file, meta, shrunk, frame, preview });
  }
  pendingItems.push(...items);
  $('#progress').textContent = '';
  regroup();
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
  const heic = g.items.filter(i => isHeic(i.file)).length;
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
    h('div', { class: 'thumbs' }, g.items.map(i =>
      i.file.type.startsWith('video/') ? h('video', { src: i.preview, muted: true, preload: 'metadata' })
        : i.preview ? h('img', { src: i.preview, alt: '' })
          : h('div', { class: 'heic', text: 'HEIC' }))),
    heic > 0 && h('p', { class: 'hint', text: `${heic} HEIC photo(s): most browsers can't show these. Export them from iCloud as JPEG (“Most Compatible”) first.` }),
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
    const { getAI, getGenerativeModel, GoogleAIBackend, Schema } = await import(`${FB_SDK}/firebase-ai.js`);
    const ai = getAI(app, { backend: new GoogleAIBackend() });
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
    const result = await model.generateContent(parts);
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
  } catch (err) {
    console.error('AI failed:', err);
    toast('AI could not help this time: ' + (err.code || err.message || err).toString().slice(0, 120), 5000);
  } finally {
    g.aiBusy = false;
    renderGroups();
  }
}

// ---------- Upload ----------
function putFile(path, blob, onBytes) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), blob, { contentType: blob.type || 'application/octet-stream' });
    let last = 0;
    task.on('state_changed',
      (s) => { onBytes(s.bytesTransferred - last); last = s.bytesTransferred; },
      reject,
      async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

const safeName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'file';
const extFor = (type) => ({ 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }[type] || 'bin');

$('#uploadBtn').addEventListener('click', async () => {
  if (!groups.length) return;
  const btn = $('#uploadBtn');
  btn.disabled = true;
  $('#barWrap').hidden = false;

  const bulkTags = parseTags($('#bulkTags').value);
  const bulkCat = $('#bulkCategory').value;
  let total = groups.reduce((n, g) => n + g.items.reduce((m, i) =>
    m + (i.shrunk ? i.shrunk.full.size + i.shrunk.thumb.size : i.file.size + (i.frame?.size || 0)), 0), 0);
  let sent = 0;
  const skipped = [];
  const onBytes = (n) => { sent += n; $('#bar').style.width = `${Math.min(100, (sent / total) * 100).toFixed(1)}%`; };

  const done = [];
  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      $('#progress').textContent = `Uploading entry ${gi + 1} of ${groups.length}…`;
      const files = [];
      for (const it of g.items) {
        const base = `posts/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName(it.file.name)}`;
        if (it.shrunk) {
          const path = `${base}.${extFor(it.shrunk.full.type)}`;
          const thumbPath = `${base}_t.${extFor(it.shrunk.thumb.type)}`;
          const url = await putFile(path, it.shrunk.full, onBytes);
          const thumb = await putFile(thumbPath, it.shrunk.thumb, onBytes);
          files.push({ type: 'image', url, path, thumb, thumbPath });
        } else if (it.file.type.startsWith('video/')) {
          $('#progress').textContent = `Entry ${gi + 1} of ${groups.length}: compressing video to 720p…`;
          const small = await shrinkVideo(it.file, (p) => {
            $('#progress').textContent = `Entry ${gi + 1} of ${groups.length}: compressing video ${Math.round(p * 100)}%`;
          });
          const blob = small || it.file;
          if (small) total -= it.file.size - small.size;
          else toast(`Couldn't compress ${it.file.name} in this browser — uploading the original.`, 4000);
          if (blob.size > MAX_VIDEO_MB * 1e6) {
            skipped.push(it.file.name);
            continue;
          }
          $('#progress').textContent = `Uploading entry ${gi + 1} of ${groups.length}…`;
          const ext = small ? '.mp4' : ((it.file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase());
          const path = base + ext;
          const url = await putFile(path, blob, onBytes);
          const record = { type: 'video', url, path };
          if (it.frame) {            // cover image, so the grid doesn't have to load every video
            record.thumbPath = `${base}_t.jpg`;
            record.thumb = await putFile(record.thumbPath, it.frame, onBytes);
          }
          files.push(record);
        } else {
          const ext = (it.file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
          const path = base + ext;
          const url = await putFile(path, it.file, onBytes);
          files.push({ type: 'image', url, path });
        }
      }
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
      const res = await addDoc(collection(db, 'posts'), entry);
      posts.push({ id: res.id, ...entry });
      done.push(g);
    }
    $('#progress').textContent = `Done — ${done.length} entr${done.length === 1 ? 'y' : 'ies'} added.` +
      (skipped.length ? ` Skipped (still over ${MAX_VIDEO_MB} MB): ${skipped.join(', ')}` : '');
    clearGroups();
    renderArchive();
    setTimeout(() => showView('archive'), 700);
  } catch (err) {
    console.error('Upload failed:', err);
    groups = groups.filter(g => !done.includes(g));
    renderGroups();
    renderArchive();
    $('#progress').textContent = `Upload stopped: ${err.code || err.message}. ${done.length} entr${done.length === 1 ? 'y was' : 'ies were'} saved; the rest are still here to retry.`;
  } finally {
    btn.disabled = false;
    $('#barWrap').hidden = true;
    $('#bar').style.width = '0';
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
