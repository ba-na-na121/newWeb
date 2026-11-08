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
  return `${y}年${m}月${d}日`;
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
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 9.1 4.7 4.7 0 0 0 7 18.5z"/>',
  'cloud-sun': '<path d="M8 3.5v1.2M3.9 5.2l.9.9M2.5 9.5h1.2M12.1 5.2l-.9.9"/><path d="M5.3 11.6A3.3 3.3 0 1 1 10.9 7.7"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .5-6.96 4.8 4.8 0 0 0-9.2-1.2A4.1 4.1 0 0 0 9 20z"/>',
  rain: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 5.1 4.7 4.7 0 0 0 7 14.5z"/><path d="M8.5 17.5 7.5 20M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/>',
  snow: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 5.1 4.7 4.7 0 0 0 7 14.5z"/><path d="M8 18.5h.01M12 20.5h.01M16 18.5h.01M10 17.5h.01M14 17.5h.01"/>',
  fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
  storm: '<path d="M7 14.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 5.1 4.7 4.7 0 0 0 7 14.5z"/><path d="M12.5 15.5 10.5 19h3l-2 3"/>',
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
const CATEGORY_LABELS = {
  Daily: '日常', Travel: '旅行', Food: '美食', Friends: '朋友', Creative: '创作', Study: '学习', Other: '其他', Saved: '收藏',
};
const labelOf = (cat) => CATEGORY_LABELS[cat] || cat;
const BAND_COLORS = ['#FFD43B', '#C8B9B3', '#FFB8EC', '#7C9CF0', '#93AE6B', '#FF8A3D', '#B9A8FF'];
// An entry can sit in several folders (a trip with friends → 旅行 + 朋友). The first one is the main
// category: it sets the entry's colour. Older entries only have "category".
const catsOf = (p) => (p.categories?.length ? p.categories : [p.category || 'Other']);
const catOf = (p) => catsOf(p)[0];

// Short city name shown before card titles ("迈阿密 · 海边日落").
function cityOf(p) {
  if (p.place?.city) return cleanCity(p.place.city);
  const name = (p.place?.name || '').trim();
  if (!name) return '';
  const last = name.split(/[,，·]/).map(s => s.trim()).filter(Boolean).pop() || '';
  return last.length <= 8 ? last : '';
}

// Tap-to-toggle category chips. The first one picked is the main category.
function catPicker(selected, onChange) {
  const sel = [...selected];
  const wrap = h('div', { class: 'cat-chips', role: 'group', 'aria-label': '分类（可多选，第一个是主分类）' });
  const paint = () => wrap.replaceChildren(...[...new Set([...CATEGORIES, ...sel])].map(c => {
    const i = sel.indexOf(c);
    return h('button', {
      type: 'button', class: 'cat-chip' + (i >= 0 ? ' on' : '') + (i === 0 ? ' main' : ''),
      style: `--c:${colorOf(c)}`, 'aria-pressed': String(i >= 0),
      title: i === 0 ? '主分类（决定颜色）' : '',
      onclick: () => { i >= 0 ? sel.splice(i, 1) : sel.push(c); paint(); onChange([...sel]); },
    }, h('i'), labelOf(c));
  }));
  paint();
  return wrap;
}
const colorOf = (cat) => CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other;
const UNITS = { entry: '条记录', place: '个地点', photo: '张照片', result: '条结果' };
const plural = (n, unit) => `${n} ${UNITS[unit] || unit}`;
const byNewest = (a, b) => entryDate(b).localeCompare(entryDate(a)) || (b.createdAt || '').localeCompare(a.createdAt || '');
const coverSrc = (p) => {
  const f = (p.files || []).find(x => x.thumb || x.type === 'image');
  return f ? (f.thumb || f.url) : null;
};
const monthName = (y, m) => `${+m}月`;

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
  document.body.classList.toggle('immersive', view === 'browse' && name === 'entry');
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
  return h('nav', { class: 'switch', 'aria-label': '浏览方式' },
    h('a', { href: '#/folders', 'aria-current': active === 'folders' ? 'page' : null }, icon('folder'), '分类'),
    h('a', { href: '#/timeline', 'aria-current': active === 'timeline' ? 'page' : null }, icon('timeline'), '时间线'));
}

function pageHead(title, backHref, sub, color) {
  return [
    h('div', { class: 'page-head' },
      h('a', { class: 'back', href: backHref, 'aria-label': '返回' }, icon('chevron-left')),
      color && h('span', { class: 'title-chip', style: `background:${color}` }),
      h('h1', { class: 'page-title', text: title })),
    sub && h('p', { class: 'page-sub', text: sub }),
  ].filter(Boolean);
}

function emptyEl(text) {
  return h('div', { class: 'empty' },
    h('p', { text }),
    owner && h('a', { class: 'btn primary', href: '#/add' }, icon('plus'), '添加照片'));
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
      getSaved().has(p.id) && h('span', { class: 'card-saved', 'aria-label': '已收藏' }, icon('star', { filled: true }))),
    h('div', { class: 'card-title' },
      h('span', { class: 'card-dots' }, catsOf(p).map(c => h('span', { class: 'card-dot', style: `background:${colorOf(c)}` }))),
      cityOf(p) && entryTitle(p) && h('span', { class: 'card-city', text: cityOf(p) }),
      entryTitle(p) || p.place?.name || '无标题'),
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
      out.push(h('h2', { class: 'month-head', text: `${y}年${m}月` }));
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
  if (name === 'timeline' && rest[0]) { v.replaceChildren(...yearPage(rest[0])); return requestAnimationFrame(fitBands); }
  const mode = name === 'timeline' || name === 'folders' ? name : getMode();
  setMode(mode);
  // Keep the reel playing if it's already on screen (e.g. the page refreshes after city names load).
  const reel = v.querySelector(':scope > .reel') || (posts.length > 0 && reelEl());
  v.replaceChildren(...[reel, ...(mode === 'timeline' ? timelineRoot() : foldersRoot())].filter(Boolean));
  requestAnimationFrame(fitBands);
}

// ---------- "最近" reel: the newest entries play like episodes ----------
// Each episode: the photo cuts in, the city types in letter by letter in a tall condensed face, a small
// line (number · date · title) sits under it in the entry's colour, other photos from the same entry pop
// up as small frames like a collage, then the word leaves (backspaced, or tracked out letter by letter).
const REEL_COUNT = 6;
const REEL_MS = 6200;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const imgSrcs = (p) => (p.files || []).map(f => f.type === 'video' ? f.thumb : (f.url || f.thumb)).filter(Boolean);
const thumbSrcs = (p) => (p.files || []).map(f => f.thumb || (f.type === 'image' ? f.url : null)).filter(Boolean);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function reelEl() {
  const list = [...posts].sort(byNewest).filter(p => imgSrcs(p).length).slice(0, REEL_COUNT);
  if (!list.length) return null;
  const bg = h('img', { class: 'reel-bg', alt: '' });
  const pips = h('div', { class: 'reel-pips', 'aria-hidden': 'true' });
  const word = h('div', { class: 'reel-word', 'aria-hidden': 'true' });
  const sub = h('div', { class: 'reel-sub', 'aria-hidden': 'true' });
  const count = h('div', { class: 'reel-count', 'aria-hidden': 'true' });
  const bars = h('div', { class: 'reel-bars', 'aria-hidden': 'true' }, list.map(() => h('i', {}, h('b'))));
  const link = h('a', { class: 'reel', href: '#/' }, bg, h('div', { class: 'reel-shade' }), pips, word, sub, count, bars,
    h('span', { class: 'reel-label', text: '最近' }));

  // Preload the photos so cuts are instant.
  list.forEach(p => imgSrcs(p).slice(0, 4).forEach(s => { const i = new Image(); i.src = s; }));

  const alive = () => link.isConnected || !started;
  let started = false;
  let i = 0;

  const typeIn = async (letters, ep) => {
    word.replaceChildren();
    for (const ch of letters) {
      if (ep !== epoch) return;
      word.append(h('span', { text: ch }));
      await wait(ch === ' ' ? 40 : 85);
    }
  };
  const backspace = async (ep) => {
    const spans = [...word.children];
    await wait(140);
    word.classList.add('flash');               // two-frame colour flash, then delete letter by letter
    await wait(160);
    word.classList.remove('flash');
    for (let k = spans.length - 1; k >= 0; k--) { if (ep !== epoch) return; spans[k].remove(); await wait(55); }
  };
  const trackOut = async (ep) => {
    word.classList.add('tracking');            // letters spread wide, then vanish in random order
    await wait(700);
    const spans = [...word.children].sort(() => Math.random() - 0.5);
    for (const s of spans) { if (ep !== epoch) return; s.classList.add('gone'); await wait(70); }
  };
  const popPips = async (p, ep) => {
    let srcs = thumbSrcs(p).slice(1, 4);
    if (srcs.length < 2) srcs = [...srcs, ...list.filter(x => x !== p).map(x => thumbSrcs(x)[0]).filter(Boolean)].slice(0, 2);
    // Corners only, so the frames never cover the word in the middle.
    const spots = [[5, 13], [64, 12], [66, 66], [6, 68]].sort(() => Math.random() - 0.5);
    for (const [k, src] of srcs.entries()) {
      if (ep !== epoch) return;
      const [x, y] = spots[k];
      const w = 20 + Math.random() * 9;
      const el = h('img', { src, alt: '', style: `left:${x}%;top:${y}%;width:${w}%` });
      pips.append(el);
      setTimeout(() => el.remove(), 1500 + Math.random() * 600);
      await wait(420);
    }
  };

  let epoch = 0;
  const show = async (n) => {
    const ep = ++epoch;
    i = (n + list.length) % list.length;
    const p = list[i];
    const color = colorOf(catOf(p));
    link.href = `#/entry/${p.id}`;
    link.setAttribute('aria-label', `最近：${entryTitle(p) || cityOf(p) || '无标题'}，${fmtDate(entryDate(p))}`);
    link.style.setProperty('--c', color);
    pips.replaceChildren();
    word.className = 'reel-word';
    bg.classList.remove('in'); void bg.offsetWidth;
    bg.src = imgSrcs(p)[0];
    bg.classList.add('in');
    count.textContent = `${String(i + 1).padStart(2, '0')} / ${String(list.length).padStart(2, '0')}`;
    sub.replaceChildren(
      h('span', { text: `#${String(posts.length - posts.slice().sort(byNewest).indexOf(p)).padStart(2, '0')}` }),
      h('span', { text: entryDate(p).replaceAll('-', '.') }),
      cityOf(p) && entryTitle(p) && h('span', { text: entryTitle(p) }));
    [...bars.children].forEach((b, k) => { b.className = k < i ? 'done' : k === i ? 'now' : ''; });
    bars.style.setProperty('--dur', `${REEL_MS}ms`);

    const big = cityOf(p) || entryTitle(p) || labelOf(catOf(p));
    // Shrink the word until it fits on one line.
    word.style.fontSize = '';
    word.replaceChildren(h('span', { text: big }));
    for (let k = 0; k < 30 && word.scrollWidth > word.clientWidth && parseFloat(getComputedStyle(word).fontSize) > 30; k++) {
      word.style.fontSize = parseFloat(getComputedStyle(word).fontSize) * 0.92 + 'px';
    }
    if (reduceMotion()) return;
    word.replaceChildren();
    await wait(250);
    await typeIn([...big], ep);
    if (ep !== epoch) return;
    sub.classList.add('in');
    await popPips(p, ep);
    await wait(Math.max(0, REEL_MS - 250 - big.length * 85 - 1300 - 1200));
    if (ep !== epoch) return;
    sub.classList.remove('in');
    await (i % 2 ? trackOut(ep) : backspace(ep));
    if (ep !== epoch || !alive()) return;
    if (document.hidden) {
      document.addEventListener('visibilitychange', () => { if (ep === epoch && link.isConnected) show(i + 1); }, { once: true });
      return;
    }
    show(i + 1);
  };

  // Tap the left edge to go back, the right edge to skip; anywhere else opens the entry.
  link.addEventListener('click', (e) => {
    const r = link.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.18 || x > 0.82) { e.preventDefault(); show(i + (x < 0.5 ? -1 : 1)); }
  });
  requestAnimationFrame(() => { started = true; show(0); });
  return link;
}

// Folders (reference 1): one folder per category, photos sticking out of the top.
function folderEl(name, list, color, iconName) {
  const pics = [...list].sort(byNewest).map(coverSrc).filter(Boolean).slice(0, 3);
  return h('a', {
    class: 'folder', href: `#/folders/${encodeURIComponent(name)}`, style: `--c:${color}`,
    'aria-label': `${labelOf(name)}，${plural(list.length, 'entry')}`,
  },
    h('span', { class: 'folder-back' }),
    h('span', { class: 'folder-peek' }, pics.map(src => h('img', { src, alt: '', loading: 'lazy' }))),
    h('span', { class: 'folder-front' },
      iconName && icon(iconName, { filled: true }),
      h('span', { class: 'folder-name', text: labelOf(name) }),
      h('span', { class: 'folder-count', text: plural(list.length, 'entry') })));
}

function foldersRoot() {
  if (!posts.length) return [switchEl('folders'), emptyEl('这里还没有内容。')];
  const byCat = new Map();
  posts.forEach(p => catsOf(p).forEach(c => byCat.set(c, [...(byCat.get(c) || []), p])));
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
  const list = name === 'Saved' ? posts.filter(p => saved.has(p.id)) : posts.filter(p => catsOf(p).includes(name));
  return [
    ...pageHead(labelOf(name), '#/folders', plural(list.length, 'entry'), name === 'Saved' ? SAVED_COLOR : colorOf(name)),
    ...(list.length ? entryGrid(list) : [emptyEl(name === 'Saved' ? '在记录里点星标，就会收进这里。' : '这里还没有内容。')]),
  ];
}

// Timeline (reference 3): coloured bands, years first, then months.
function bandEl(title, short, list, color, href) {
  const places = new Set(list.map(p => p.place?.name).filter(Boolean)).size;
  const files = list.reduce((n, p) => n + (p.files || []).length, 0);
  const pics = [...list].sort(byNewest).map(coverSrc).filter(Boolean).slice(0, 3);
  return h('a', { class: 'band', href, style: `--c:${color}`, 'aria-label': `${title}, ${plural(list.length, 'entry')}` },
    h('span', { class: 'band-go' }, icon('arrow-right')),
    h('span', { class: 'band-title', text: title }),
    h('span', { class: 'band-side' },
      h('b', { text: plural(list.length, 'entry') }),
      h('span', { class: 'band-meta', text: places ? plural(places, 'place') : plural(files, 'photo') }),
      pics.length > 0 && h('span', { class: 'band-thumbs' }, pics.map(src => h('img', { src, alt: '', loading: 'lazy' })))));
}

function timelineRoot() {
  if (!posts.length) return [switchEl('timeline'), emptyEl('这里还没有内容。')];
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
    ...pageHead(y, '#/timeline', plural(list.length, 'entry')),
    keys.length
      ? h('div', { class: 'bands' }, keys.map((m, i) => bandEl(monthName(y, +m), null, months.get(m),
        BAND_COLORS[i % BAND_COLORS.length], `#/timeline/${y}/${m}`)))
      : emptyEl('这一年还没有内容。'),
  ];
}

function monthPage(y, m) {
  const list = posts.filter(p => entryDate(p).startsWith(`${y}-${m}`));
  return [
    ...pageHead(`${y}年${+m}月`, `#/timeline/${y}`, plural(list.length, 'entry')),
    ...(list.length ? entryGrid(list, { months: false }) : [emptyEl('这个月还没有内容。')]),
  ];
}

// Search: words match titles, text, places, categories and dates; "#tag" matches a tag exactly.
function searchMatches(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  if (q.startsWith('#')) return posts.filter(p => (p.tags || []).includes(q.slice(1)));
  return posts.filter(p => [p.title, p.text, ...catsOf(p), ...catsOf(p).map(labelOf), (p.tags || []).join(' '), p.place?.name, entryDate(p), fmtDate(entryDate(p))]
    .join(' ').toLowerCase().includes(q));
}

function searchPage(q) {
  const results = h('div');
  const show = (text) => {
    const list = searchMatches(text);
    results.replaceChildren(...(text.trim()
      ? (list.length ? [h('p', { class: 'page-sub', text: plural(list.length, 'result') }), ...entryGrid(list)]
        : [h('p', { class: 'empty', text: `没有找到和“${text.trim()}”相关的内容。` })])
      : [h('p', { class: 'page-sub', text: '可以搜索标题、地点、标签和日期。' })]));
  };
  const input = h('input', {
    type: 'search', value: q, placeholder: '搜索档案', 'aria-label': '搜索档案', enterkeyhint: 'search',
    oninput: (e) => {
      history.replaceState(null, '', `#/search/${encodeURIComponent(e.target.value)}`);
      show(e.target.value);
    },
  });
  show(q);
  setTimeout(() => input.focus(), 0);
  return [...pageHead('搜索', '#/'), h('label', { class: 'search-box' }, icon('search'), input), results];
}

// ---------- Weather (Open-Meteo: free, no key) ----------
// WMO weather codes → Chinese label and icon.
function weatherInfo(code) {
  if (code === 0) return ['晴', 'sun'];
  if (code <= 2) return ['多云', 'cloud-sun'];
  if (code === 3) return ['阴', 'cloud'];
  if (code === 45 || code === 48) return ['雾', 'fog'];
  if (code >= 51 && code <= 57) return ['毛毛雨', 'rain'];
  if (code === 61 || code === 80) return ['小雨', 'rain'];
  if (code === 63 || code === 81) return ['中雨', 'rain'];
  if (code === 65 || code === 82) return ['大雨', 'rain'];
  if (code === 66 || code === 67) return ['冻雨', 'rain'];
  if (code >= 71 && code <= 77) return ['雪', 'snow'];
  if (code === 85 || code === 86) return ['阵雪', 'snow'];
  if (code >= 95) return ['雷雨', 'storm'];
  return ['—', 'cloud'];
}

// The day's weather where an entry was taken. Recent days come from the forecast service,
// older ones from the archive. Returns { code, max, min } or null.
async function fetchWeather(lat, lng, date) {
  try {
    const age = (Date.now() - new Date(`${date}T12:00:00`).getTime()) / 864e5;
    if (!(lat != null && lng != null) || age < -1) return null;
    const base = age < 60 ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
    const url = `${base}?latitude=${lat}&longitude=${lng}&start_date=${date}&end_date=${date}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto';
    const r = await withTimeout(fetch(url), 10000, '天气查询超时');
    if (!r.ok) return null;
    const d = (await r.json()).daily;
    if (!d || d.weather_code?.[0] == null) return null;
    return { code: d.weather_code[0], max: Math.round(d.temperature_2m_max[0]), min: Math.round(d.temperature_2m_min[0]) };
  } catch { return null; }
}

function weatherCell(p) {
  const dd = h('dd', {});
  const paint = (w) => {
    if (w) {
      const [label, ic] = weatherInfo(w.code);
      dd.replaceChildren(h('span', { class: 'wx' }, icon(ic), `${w.max}°`), h('small', { text: `${label}，最低 ${w.min}°` }));
    } else {
      dd.replaceChildren(h('span', { class: 'muted', text: p.place?.lat != null ? '查不到' : '无位置' }));
    }
  };
  if (p.weather) paint(p.weather);
  else if (p.place?.lat != null) {
    dd.replaceChildren(h('span', { class: 'muted', text: '查询中…' }));
    fetchWeather(p.place.lat, p.place.lng, entryDate(p)).then(async (w) => {
      paint(w);
      if (w) {
        p.weather = w;
        if (owner) { try { await updateDoc(doc(db, 'posts', p.id), { weather: w }); } catch {} } // remember it for next time
      }
    });
  } else paint(null);
  return h('div', {}, h('dt', { text: '天气' }), dd);
}

// OpenStreetMap sometimes gives several spellings ("纽约;紐約"): keep the first, drop 市/县.
const cleanCity = (s) => String(s || '').split(/[;；]/)[0].trim().replace(/(?<=..)(市|县|縣|區|区)$/, '');

// Place typed by hand (no GPS): find it on the map so it gets a pin and a city.
function findPlace(q) {
  const run = nominatimChain.then(async () => {
    try {
      const r = await withTimeout(fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=zh-CN&q=${encodeURIComponent(q)}`), 8000, 'timeout');
      const hit = r.ok ? (await r.json())[0] : null;
      if (!hit) return null;
      const a = hit.address || {};
      return { lat: +(+hit.lat).toFixed(5), lng: +(+hit.lon).toFixed(5),
        city: cleanCity(a.city || a.town || a.village || a.municipality || a.city_district || '') };
    } catch { return null; }
  });
  nominatimChain = run.then(() => new Promise(r => setTimeout(r, 1100)));
  return run;
}

// ---------- City name from GPS (OpenStreetMap Nominatim: free, asks for at most 1 request a second) ----------
let nominatimChain = Promise.resolve();
function reverseCity(lat, lng) {
  const run = nominatimChain.then(async () => {
    try {
      const r = await withTimeout(fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=zh-CN&lat=${lat}&lon=${lng}`), 8000, 'timeout');
      if (!r.ok) return '';
      const a = (await r.json()).address || {};
      return cleanCity(a.city || a.town || a.village || a.municipality || a.city_district || '');
    } catch { return ''; }
  });
  nominatimChain = run.then(() => new Promise(r => setTimeout(r, 1100)));
  return run;
}

// Entries saved before city names existed: look them up once (owner only) and remember them.
let cityFillStarted = false;
async function fillMissingCities() {
  if (cityFillStarted || !owner) return;
  cityFillStarted = true;
  const todo = posts.filter(p => p.place?.lat != null && (!p.place.city || /[;；]/.test(p.place.city)));
  for (const p of todo) {
    const city = await reverseCity(p.place.lat, p.place.lng);
    if (!city) continue;
    p.place = { ...p.place, city };
    try { await updateDoc(doc(db, 'posts', p.id), { 'place.city': city }); } catch {}
  }
  const name = parseRoute().name;
  if (todo.length && ['', 'folders', 'timeline', 'search'].includes(name)) route();
}

// ---------- Full-screen photo viewer (tap a photo on an entry) ----------
function openViewer(files, start = 0) {
  const slides = h('div', { class: 'viewer-slides' }, files.map(f => h('div', { class: 'viewer-slide' },
    f.type === 'video'
      ? h('video', { src: f.url, controls: true, playsInline: true, preload: 'metadata', poster: f.thumb })
      : h('img', { src: f.url, alt: '' }))));
  const close = () => { viewer.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const viewer = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '查看原图' },
    slides,
    h('button', { class: 'media-btn viewer-close', type: 'button', 'aria-label': '关闭', onclick: close }, icon('close')));
  document.addEventListener('keydown', onKey);
  document.body.append(viewer);
  slides.scrollLeft = start * slides.clientWidth;
  viewer.querySelector('.viewer-close').focus();
}

// One entry: the photo fills the screen edge to edge and fades into the category colour,
// so photo, title and text read as one piece rather than a picture with a card under it.
function entryPage(id) {
  const p = posts.find(x => x.id === id);
  if (!p) return h('div', {}, ...pageHead('找不到这条记录', '#/'), emptyEl('它可能已被删除，或者链接有误。'));

  const cat = catOf(p);
  const color = colorOf(cat);
  const files = p.files || [];
  const d = entryDate(p);
  const [yy, mm, dd] = d.split('-').map(Number);
  const back = () => (cameFromApp ? history.back() : go('#/'));
  document.body.style.setProperty('--entry-c', color);

  const saveBtn = h('button', { class: 'media-btn right', type: 'button' });
  const paintSave = () => {
    const on = getSaved().has(p.id);
    saveBtn.classList.toggle('on', on);
    saveBtn.setAttribute('aria-label', on ? '取消收藏' : '收藏');
    saveBtn.setAttribute('aria-pressed', String(on));
    saveBtn.replaceChildren(icon('star', { filled: on }));
  };
  saveBtn.addEventListener('click', () => { toggleSaved(p.id); paintSave(); });
  paintSave();

  let hero;
  if (files.length) {
    const slides = h('div', { class: 'slides' }, files.map((f, i) => h('div', { class: 'slide' },
      f.type === 'video'
        ? h('video', { src: f.url, controls: true, playsInline: true, preload: 'metadata', poster: f.thumb })
        : h('img', {
          src: f.url, alt: entryTitle(p) || '', loading: i ? 'lazy' : 'eager',
          onclick: () => openViewer(files, i), style: 'cursor:zoom-in',
        }))));
    const dots = files.length > 1 ? h('div', { class: 'dots' }, files.map((_, i) => h('i', { class: i ? '' : 'on' }))) : null;
    if (dots) slides.addEventListener('scroll', () => {
      const i = Math.round(slides.scrollLeft / slides.clientWidth);
      [...dots.children].forEach((dot, k) => dot.classList.toggle('on', k === i));
    }, { passive: true });
    hero = h('div', { class: 'hero' }, slides, h('div', { class: 'hero-fade' }), dots);
  } else {
    hero = h('div', { class: 'hero hero-empty' });
  }

  const placeName = p.place?.name || (p.place?.lat != null ? `${p.place.lat.toFixed(2)}, ${p.place.lng.toFixed(2)}` : '');
  const kinds = new Set(files.map(f => f.type));
  const filesLabel = kinds.size === 1 ? (kinds.has('video') ? '视频' : '照片') : '照片和视频';

  const body = h('div', { class: 'entry-body' },
    h('div', { class: 'entry-cats' }, catsOf(p).map(c => h('a', { class: 'entry-when', href: `#/folders/${encodeURIComponent(c)}`, text: labelOf(c) }))),
    h('h1', { class: 'entry-title', text: entryTitle(p) || placeName || fmtDate(d) }),
    h('dl', { class: 'stats' },
      h('div', {}, h('dt', { text: '日期' }), h('dd', {}, `${mm}月${dd}日`, h('small', { text: `${yy}年` }))),
      h('div', {}, h('dt', { text: '地点' }), h('dd', {}, cityOf(p) || placeName || '未设置',
        cityOf(p) && placeName && placeName !== cityOf(p) && h('small', { text: placeName }))),
      weatherCell(p),
      h('div', {}, h('dt', { text: filesLabel }), h('dd', { text: String(files.length) }))),
    p.text && h('p', { class: 'entry-text', text: p.text }),
    (p.tags || []).length > 0 && h('div', { class: 'tags' },
      p.tags.map(t => h('a', { class: 'tag', href: `#/search/${encodeURIComponent('#' + t)}`, text: t }))),
    owner && h('div', { class: 'entry-actions' },
      h('button', { class: 'pill-btn', type: 'button', onclick: () => editForm(p, body) }, icon('edit'), '编辑'),
      h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => removeEntry(p) }, icon('trash'), '删除')));

  const others = posts.filter(x => x.id !== p.id && catsOf(x).includes(cat)).sort(byNewest).slice(0, 9);
  if (others.length) body.append(h('section', { class: 'more' },
    h('h2', { text: `更多「${labelOf(cat)}」` }),
    h('div', { class: 'more-row' }, others.map(x => h('a', { href: `#/entry/${x.id}`, 'aria-label': entryTitle(x) || fmtDate(entryDate(x)) },
      coverSrc(x) ? h('img', { src: coverSrc(x), alt: '', loading: 'lazy' }) : null)))));

  const page = h('article', { class: 'entry', style: `--c:${color}` },
    hero,
    h('button', { class: 'media-btn left', type: 'button', 'aria-label': '返回', onclick: back }, icon('chevron-left')),
    saveBtn,
    body);
  page.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) back(); });
  return page;
}

// Big band titles shrink until they fit their space, whatever the screen width.
function fitBands() {
  document.querySelectorAll('.band-title').forEach(el => {
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && size > 22) {
      size -= 2;
      el.style.fontSize = `${size}px`;
    }
  });
}
window.addEventListener('resize', fitBands);
document.fonts?.ready.then(fitBands);

function editForm(p, card) {
  if (card.querySelector('.edit-form')) return;
  const title = h('input', { class: 'field', value: p.title || '', placeholder: '标题', 'aria-label': '标题' });
  const date = h('input', { class: 'field', type: 'date', value: entryDate(p), 'aria-label': '日期' });
  let cats = p.categories?.length ? [...p.categories] : (p.category ? [p.category] : []);
  const cat = catPicker(cats, (v) => { cats = v; });
  const tags = h('input', { class: 'field', value: (p.tags || []).join(', '), placeholder: '标签，用逗号分隔', 'aria-label': '标签' });
  const place = h('input', { class: 'field', value: p.place?.name || '', placeholder: '地点', 'aria-label': '地点' });
  const city = h('input', { class: 'field', value: cityOf(p), placeholder: '城市简称，如 迈阿密', 'aria-label': '城市简称' });
  const text = h('textarea', { class: 'field', placeholder: '写点什么', 'aria-label': '正文' });
  text.value = p.text || '';

  const save = h('button', {
    class: 'pill-btn', type: 'button', onclick: async () => {
      const update = {
        title: title.value.trim(),
        date: date.value || entryDate(p),
        category: cats[0] || '',
        categories: cats,
        tags: parseTags(tags.value),
        text: text.value,
        place: place.value.trim() || city.value.trim() || p.place?.lat != null
          ? { ...(p.place || {}), name: place.value.trim(), city: city.value.trim() }
          : null,
      };
      save.disabled = true;
      // A new or changed place name: put it on the map and fill the city if it wasn't typed.
      const newName = place.value.trim();
      if (newName && (p.place?.lat == null || newName !== (p.place?.name || ''))) {
        const found = await findPlace(newName);
        if (found) update.place = { ...update.place, lat: found.lat, lng: found.lng,
          city: city.value.trim() && city.value.trim() !== cityOf(p) ? city.value.trim() : (found.city || city.value.trim()) };
      }
      try {
        await updateDoc(doc(db, 'posts', p.id), update);
        Object.assign(p, update);
        renderArchive();
        toast('修改已保存');
      } catch (err) {
        console.error(err);
        toast('修改没有保存：' + (err.code || err.message));
        save.disabled = false;
      }
    },
  }, icon('check'), '保存修改');
  const cancel = h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => form.remove() }, '取消');

  const form = h('div', { class: 'edit-form' },
    h('div', { class: 'two' }, title, date),
    h('div', { class: 'two' }, place, city),
    h('p', { class: 'edit-label', text: '分类（可多选，第一个是主分类，决定颜色）' }), cat,
    tags, text,
    h('div', { class: 'entry-actions' }, save, cancel));
  card.querySelector('.entry-actions').after(form);
  title.focus();
}

async function removeEntry(p) {
  if (!confirm('要永久删除这条记录和它的照片吗？删除后无法恢复。')) return;
  try {
    await deleteDoc(doc(db, 'posts', p.id));
    await Promise.allSettled((p.files || []).flatMap(f =>
      [f.path || f.url, f.thumbPath].filter(Boolean).map(x => deleteObject(ref(storage, x)))));
    posts = posts.filter(x => x.id !== p.id);
    toast('记录已删除');
    go(`#/folders/${encodeURIComponent(catOf(p))}`);
  } catch (err) {
    console.error(err);
    toast('记录没有删除：' + (err.code || err.message));
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
  try { L = await loadLeaflet(); } catch { $('#map').textContent = '地图加载失败，请检查网络后重新打开。'; return; }
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
    toast('还没有带地点的记录。带位置信息的照片会自动标上地点。', 4000);
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
            logLine(`封面 ${file.name}：取第 ${t.toFixed(1)} 秒的画面`);
            return await canvasToJpeg(wc.canvas);
          }
          fallback ||= wc.canvas;
        }
        if (fallback) { logLine(`封面 ${file.name}：整段视频都很暗`); return await canvasToJpeg(fallback); }
      }
    } catch (err) {
      logLine(`封面 ${file.name}：解码失败（${String(err?.message || err).slice(0, 80)}），改用播放器`);
    } finally {
      try { input?.dispose?.(); } catch {}
    }
  }
  // 2) Fallback for browsers without a video decoder: the <video> element. A black result is thrown away.
  const blob = await videoFrameFromElement(file);
  logLine(`封面 ${file.name}：${blob ? '来自播放器' : '无（取不到画面）'}`);
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
      logLine(`压缩（${hardwareAcceleration}）失败：${String(err?.message || err).slice(0, 120)}`);
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
  if (out.lat == null) {
    // Some phones and apps store the location where the library doesn't look. Search the whole header for it.
    const moov = await readMoov(file);
    if (moov) {
      const text = new TextDecoder('latin1').decode(moov);
      const m = text.match(/([+-]\d{1,2}\.\d{2,})([+-]\d{1,3}\.\d{2,})(?:[+-]\d+(?:\.\d+)?)?\//) ||
        text.match(/([+-]\d{1,2}\.\d{3,})([+-]\d{1,3}\.\d{3,})/);
      if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180 && !(+m[1] === 0 && +m[2] === 0)) {
        out.lat = +(+m[1]).toFixed(5);
        out.lng = +(+m[2]).toFixed(5);
      }
    }
  }
  return out;
}

// The "moov" header box of an MP4/MOV (it can sit at the start or the end of the file).
async function readMoov(file) {
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
      if (type === 'moov') return new Uint8Array(await file.slice(pos + hdr, pos + Math.min(size, hdr + 8e6)).arrayBuffer());
      pos += size;
    }
  } catch {}
  return null;
}

// Fallback: the creation time in the MP4/MOV header ("mvhd" box), seconds since 1904 in UTC.
async function mp4CreationTime(file) {
  try {
    const moov = await readMoov(file);
    if (moov) {
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

$('#bulkCategory').replaceChildren(h('option', { value: '', text: '— 让 AI 选择 —' }),
  ...CATEGORIES.map(c => h('option', { value: c, text: labelOf(c) })));

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
  logLine('已请求取消');
  $('#progress').textContent = '正在取消…';
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
  if (tooBig.length) toast(`有 ${tooBig.length} 个视频超过 4 GB，已跳过，请先剪短。`, 5000);
  files = files.filter(f => !tooBig.includes(f));

  // Read two files at a time and show each one as soon as it's ready, instead of waiting for all of them.
  const gen = readGen;
  let readCount = 0;
  readingNow++;
  $('#uploadBtn').disabled = true;            // wait until everything is read
  $('#progress').textContent = `正在读取 0/${files.length}…`;
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
    $('#progress').textContent = readCount < files.length ? `正在读取 ${readCount}/${files.length}…` : '';
    logLine(`读取 ${file.name} · ${file.type || '无类型'} · ${mb(file.size)} · 日期 ${meta.date}（来源：${{ photo: '照片信息', video: '视频信息', file: '文件日期' }[meta.dateSource]}）` +
      ` · ${meta.lat != null ? 'GPS ✓' : file.type.startsWith('video/') ? '无 GPS（视频文件里没有位置）' : '无 GPS'} · ${shrunk ? '照片 ✓' : frame ? '视频封面 ✓' : isImage ? '照片 ✕（打不开）' : '视频封面 ✕'}` +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    regroup();
  });
  } finally {
    readingNow--;
    if (!readingNow && !uploading) $('#uploadBtn').disabled = false;
  }
  if (gen !== readGen) { logLine('已取消读取'); return; }
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
    const gps = items.find(i => i.meta.lat != null)?.meta || all.find(i => i.meta.date === items[0].meta.date && i.meta.lat != null)?.meta;
    return prev && prev.items.length === items.length ? prev : {
      key, items,
      date: items[0].meta.date,
      title: prev?.title || '', text: prev?.text || '',
      categories: prev?.categories || [], tags: prev?.tags || [],
      place: gps ? { lat: gps.lat, lng: gps.lng, name: prev?.place?.name || '' } : (prev?.place || null),
      aiDone: prev?.aiDone || false,
    };
  });
  renderGroups();
}

function renderGroups() {
  $('#uploadRow').hidden = !groups.length;
  $('#dropText').textContent = groups.length
    ? `${groups.reduce((n, g) => n + g.items.length, 0)} 个文件已选好，点这里继续添加`
    : '选择照片和视频，或拖到这里';
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
        class: 'btn small ai', disabled: !!g.aiBusy, 'aria-label': '让 AI 填写',
        onclick: () => suggest(g),
      }, icon('sparkle'), g.aiBusy ? '思考中…' : 'AI 填写'),
      h('span', { class: 'count', text: `${g.items.length} 个文件` }),
      h('button', {
        class: 'btn small icon-only', 'aria-label': '移除这一条',
        onclick: () => { groups = groups.filter(x => x !== g); renderGroups(); },
      }, icon('close'))),
    h('div', { class: 'thumbs' }, g.items.map(thumbWithProgress)),
    noPlace && h('p', { class: 'hint', text: '没有位置信息：iPhone 默认不提供。在选照片的界面点顶部的“选项”，打开“位置”，再重新选一次。' }),
    dateGuessed && h('p', { class: 'hint warn' }, icon('alert'), h('span', { text: '找不到拍摄时间，现在显示的是文件日期，上传前请检查。' })),
    heic > 0 && h('p', { class: 'hint', text: `有 ${heic} 张 HEIC 照片打不开。请重试，或在 iCloud 里导出为 JPEG（“兼容性最佳”）。` }),
    bind(h('input', { class: 'field', value: g.title, placeholder: '标题', style: 'width:100%;margin-bottom:8px' }), 'title'),
    bind(h('textarea', { class: 'field', placeholder: '发生了什么？（可不填）', value: g.text }), 'text'),
    catPicker(g.categories, (v) => { g.categories = v; }),
    h('div', { class: 'line' },
      bind(h('input', { class: 'field', value: g.tags.join(', '), placeholder: '标签' }), 'tags', parseTags),
      bind(h('input', { class: 'field', value: g.placeName ?? g.place?.name ?? '', placeholder: '地点' }), 'placeName')));
}

// ---------- AI (Gemini via Firebase AI Logic) ----------
let modelPromise = null;
async function getModel() {
  modelPromise ||= (async () => {
    const aiApp = await withTimeout(getAiApp(), 20000, 'App Check（reCAPTCHA）没有响应');
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
            categories: Schema.array({ items: Schema.string() }),
            city: Schema.string(),
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
      toast('预览地址：AI 只在正式网站（ba-na-na121.github.io）上可用，其他功能都正常。', 6000);
      previewNoticeShown = true;
    }
    return;
  }
  // Photos use their thumbnail; videos use a still frame. HEIC photos can't be read by the browser.
  const images = g.items.map(i => i.shrunk?.thumb || i.frame).filter(Boolean).slice(0, 6);
  if (!images.length && !g.text) {
    if (!auto) toast('AI 读不了这些文件（不支持 HEIC 照片）。加一句备注再试试。', 5000);
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
      '- title: 4 to 12 Chinese characters, specific to what is shown.',
      '- caption: one or two plain sentences describing the moment. Do not invent names of people.',
      `- categories: 1 or 2 of ${CATEGORIES.join(', ')}, best fit first. Add a second only when it clearly also fits (a trip with friends → Travel, Friends; a meal while traveling → Travel, Food).`,
      '- city: the short city name only, in Simplified Chinese when it has a common Chinese name (迈阿密, 纽约, 东京), else empty.',
      '- tags: 3 to 8 short lowercase tags (things, activities, mood, season).',
      '- place: if GPS is given, the neighborhood and city it points to; otherwise a clearly recognizable landmark or city, else an empty string.',
      'Write title, caption, tags and place in Simplified Chinese (keep well-known English place names like SoHo as they are).',
    ].filter(Boolean).join('\n');
    const parts = [prompt, ...await Promise.all(images.map(async b =>
      ({ inlineData: { mimeType: b.type, data: await blobToBase64(b) } })))];
    const result = await withTimeout(model.generateContent(parts), 45000, 'AI 响应超时');
    const out = JSON.parse(result.response.text());
    if (!g.title && out.title) g.title = out.title.trim();
    if (!g.text && out.caption) g.text = out.caption.trim();
    const pick = $('#bulkCategory').value;
    if (!g.categories.length) {
      const ai = (out.categories || []).filter(c => CATEGORIES.includes(c)).slice(0, 2);
      g.categories = [...new Set([pick, ...ai].filter(Boolean))];
      if (!g.categories.length) g.categories = ['Other'];
    }
    if (out.city && !g.city) g.city = out.city.trim();
    g.tags = [...new Set([...g.tags, ...parseTags($('#bulkTags').value), ...parseTags((out.tags || []).join(','))])];
    if (out.place && !g.placeName && !g.place?.name) {
      g.place = { ...(g.place || {}), name: out.place.trim() };
    }
    g.aiDone = true;
    logLine(`AI ✓ ${g.date}：“${g.title}”`);
  } catch (err) {
    console.error('AI failed:', err);
    logLine(`AI ✕ ${g.date}: ${err?.code || ''} ${String(err?.message || err).slice(0, 160)}`);
    modelPromise = null; // try a fresh setup next time
    const msg = String(err?.message || err);
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    toast(
      /APP_CHECK_SITE_KEY/.test(msg) ? 'AI 未开启：还没有设置 App Check 密钥。'
      : /App Check/i.test(msg) && local ? 'AI 在这台电脑上被拦截：请把控制台（F12）里的 App Check 调试令牌添加到 Firebase → App Check。'
      : /App Check/i.test(msg) ? 'AI 被 App Check 拦截，请检查 reCAPTCHA 密钥和允许的网域。'
      : 'AI 这次没能完成：' + (err?.code || msg).slice(0, 120),
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
    wait: '等待', compress: `压缩 ${pct}%`, upload: `${pct}%`, done: '完成', error: '失败', skip: '太大', cancel: '已取消',
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
    data = new Uint8Array(await withTimeout(blob.arrayBuffer(), 60000, '从手机读取文件超时'));
  }
  if (cancelRequested) throw cancelledError();
  const t0 = Date.now();
  logLine(`↑ ${label}：发送 ${mb(blob.size)}（${blob.type || '无类型'}）`);
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
          if (!last) logLine(`  ${label}：${((Date.now() - t0) / 1000).toFixed(1)} 秒后第一批数据到达服务器`);
          onBytes(s.bytesTransferred - last); last = s.bytesTransferred; entry.lastChange = Date.now();
        }
      },
      (err) => {
        end();
        onBytes(-last);
        if (entry.byUser) err = cancelledError();
        else if (entry.stalled) err = Object.assign(new Error(`${STALL_MS / 1000} 秒没有进展`), { code: 'stalled' });
        else {
          const server = err?.customData?.serverResponse;
          if (server) logLine(`  服务器返回：${String(server).replace(/\s+/g, ' ').slice(0, 300)}`);
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
        logLine(`✕ ${label}：${why}（试了 ${attempt} 次，放弃）`);
        throw err;
      }
      logLine(`↻ ${label}：${why}，正在重试（${attempt + 1}/4）`);
      await sleep(1500 * attempt);
    }
  }
}

// Phones pause web pages that are in the background. When the page comes back, restart any upload that
// stopped moving instead of waiting for the stall timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !active.size) return;
  logLine(`回到页面，检查 ${active.size} 个上传`);
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
  $('#clearBtn').textContent = '取消';
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
  $('#progress').textContent = `正在上传 ${items.length} 个文件…切到别的 App 也没关系，回来后会自动继续。`;
  logLine(`开始上传：${items.filter(i => i.record === undefined).length} 个文件，${mb(total)}`);

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
        else toast(`这个浏览器压缩不了 ${it.file.name}，改为上传原文件。`, 4000);
        logLine(small ? `已压缩 ${it.file.name}：${mb(it.file.size)} → ${mb(small.size)}` : `无法压缩 ${it.file.name}，上传原文件 ${mb(it.file.size)}`);
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
      logLine(`✓ ${it.file.name} 上传完成`);
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
      const found = g.place?.lat == null && placeName ? await findPlace(placeName) : null;
      const gps = g.place?.lat != null ? g.place : found;
      const city = (g.place?.lat != null ? await reverseCity(g.place.lat, g.place.lng) : found?.city) || cleanCity(g.city) || '';
      const place = gps ? { lat: gps.lat, lng: gps.lng, name: placeName, city }
        : placeName || city ? { name: placeName, city } : null;
      const weather = place?.lat != null ? await fetchWeather(place.lat, place.lng, g.date) : null;
      const entry = {
        weather,
        title: (g.title || '').trim(),
        text: g.text || '',
        date: g.date,
        ...(() => {
          const cats = g.categories.length ? g.categories : bulkCat ? [bulkCat] : [];
          return { category: cats[0] || '', categories: cats };
        })(),
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
    const skipNote = skipped.length ? ` 已跳过（压缩后仍超过 ${MAX_VIDEO_MB} MB）：${skipped.join('、')}。` : '';
    renderArchive();
    if (!left.length) {
      clearGroups();   // (clears the status line too, so set the message after)
      $('#progress').textContent = `完成，新增了 ${saved.length} 条记录。${skipNote}`;
      setTimeout(() => showView('archive'), 700);
    } else {
      groups = left;
      renderGroups();
      $('#progress').textContent = cancelRequested
        ? `已取消。保存了 ${saved.length} 条，还有 ${left.length} 条没传完。点“全部上传”继续，已传完的文件不会重复上传。`
        : `${saved.length} 条已保存，${left.length} 条还没有（${firstError?.code || firstError?.message || '出错'}）。` +
          `再点一次“全部上传”重试，已传完的文件不会重复上传。${skipNote}`;
      if (cancelRequested) logLine('上传已取消');
    }
  } finally {
    uploading = false;
    cancelRequested = false;
    $('#clearBtn').textContent = '清空';
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
    toast('记录已复制，可以直接粘贴。');
  } catch {
    const range = document.createRange();             // fallback: select it so it can be copied by hand
    range.selectNodeContents($('#log'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    toast('已选中文字，点“拷贝”即可。');
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
    fillMissingCities();
  } catch (err) {
    console.error(err);
    $('#browseView').replaceChildren(h('p', { class: 'empty',
      text: `档案没有加载出来（${err.code || err.message}）。请检查网络后刷新页面。` }));
  }
});
