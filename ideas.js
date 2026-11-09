// Ideas — a private inspiration board.
// Each uploaded picture becomes one card. AI analyses it once at upload and the result is saved:
// title, one of five categories, tags, the aesthetic ("-core") it belongs to, its cultural background
// (researched with Google Search, with sources), two related open-access images from museum collections,
// and search words for Pinterest. Fashion items can be added to a private shopping list by hand.
//
// Firestore: ideas/{id} (everyone signed in can read), ideaSrc/{id} (owner: small copy for re-analysis),
//            shopping/{id} (owner only). Storage: ideas/ (pictures).

import { auth, db, storage, isOwner, FB_SDK, getAiApp } from "./firebase-config.js";

const { onAuthStateChanged, signOut } = await import(`${FB_SDK}/firebase-auth.js`);
const { collection, addDoc, getDocs, getDoc, setDoc, doc, updateDoc, deleteDoc } =
  await import(`${FB_SDK}/firebase-firestore.js`);
const { ref, uploadBytesResumable, getDownloadURL, deleteObject } =
  await import(`${FB_SDK}/firebase-storage.js`);

// ---------- Settings ----------
const CATS = ['Fashion', 'Visuals', 'Digital', 'AI', 'Business'];
const CAT_LABEL = { Fashion: '时尚', Visuals: '视觉', Digital: '数字设计', AI: 'AI', Business: '商业' };
const CAT_COLOR = { Fashion: '#FF8AB8', Visuals: '#FFD43B', Digital: '#5FD3C6', AI: '#B9A8FF', Business: '#7C9CF0' };
const AI_MODEL = 'gemini-3.5-flash-lite';
const AI_HOSTS = ['ba-na-na121.github.io', 'localhost', '127.0.0.1'];
const DISPLAY_MAX = 1800;
const THUMB_MAX = 520;
const AI_MAX = 768;          // the small copy the AI looks at (also kept for "重新分析")

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}（${ms / 1000} 秒）`)), ms); })])
    .finally(() => clearTimeout(t));
}
function toast(msg, ms = 3200) {
  const t = h('div', { class: 'toast', role: 'status', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
const parseTags = (s) => [...new Set(String(s || '').split(/[,，#\n]+/).map(t => t.trim().toLowerCase()).filter(Boolean))];
const labelOf = (c) => CAT_LABEL[c] || c;
const colorOf = (c) => CAT_COLOR[c] || '#C8B9B3';
const fmtDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };

// ---------- Icons (same set as lifestyle, plus a few) ----------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  bag: '<path d="M5.5 8h13l-1 12h-11z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'arrow-up-right': '<path d="M7 17 17 7M9 7h8v8"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  pin: '<path d="M12 3.5c-3.4 0-6 2.5-6 5.8 0 2.4 1.4 4.3 3.4 5.1L8.6 20.5l3.4-3.8 3.4 3.8-.8-6.1c2-.8 3.4-2.7 3.4-5.1 0-3.3-2.6-5.8-6-5.8z"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}
document.querySelectorAll('[data-icon]').forEach(el => el.prepend(icon(el.dataset.icon)));

// ---------- State ----------
let ideas = [];          // newest first
let shopping = new Map(); // ideaId → shopping item (owner only)
let owner = false;
let loaded = false;

// ---------- Routing ----------
// #/            all          #/c/Fashion   one category     #/tag/xyz   one tag
// #/idea/<id>   one idea     #/shopping    shopping list (owner)
// #/grid  masonry   #/index  drawer of aesthetics (the last one you picked opens by default)
// #/core/<name>  one aesthetic
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { name: parts[0] || '', arg: parts[1] || '' };
}
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
window.addEventListener('hashchange', route);
function route() {
  if (!loaded) return;
  const { name, arg } = parseRoute();
  document.body.classList.toggle('immersive', name === 'idea');
  if (name !== 'idea') document.body.style.removeProperty('--entry-c');
  const v = $('#view');
  if (name === 'idea') {
    const it = ideas.find(x => x.id === arg);
    v.replaceChildren(...(it ? ideaPage(it) : [h('p', { class: 'empty', text: '找不到这张灵感图。' })]));
  } else if (name === 'shopping' && owner) {
    v.replaceChildren(...shoppingPage());
  } else if (name === 'index' || (name === '' && store.get('ideas.view') === 'index')) {
    store.set('ideas.view', 'index');
    v.replaceChildren(...indexPage());
  } else {
    if (name === 'grid') store.set('ideas.view', 'grid');
    v.replaceChildren(...boardPage(name === 'c' ? arg : '', name === 'tag' ? arg : '', name === 'core' ? arg : ''));
  }
  window.scrollTo(0, 0);
}

// ---------- Board (masonry, like Pinterest) ----------
// Each idea gets a running number in upload order, shown like a catalogue entry (No.026).
function numberOf(it) {
  const sorted = [...ideas].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return String(sorted.indexOf(it) + 1).padStart(3, '0');
}
const coreKey = (it) => (it.core?.name || '').trim();
const viewSwitch = (current) => h('div', { class: 'seg', role: 'tablist', 'aria-label': '视图' },
  h('a', { href: '#/grid', class: current === 'grid' ? 'on' : '', role: 'tab', 'aria-selected': String(current === 'grid') }, '瀑布流'),
  h('a', { href: '#/index', class: current === 'index' ? 'on' : '', role: 'tab', 'aria-selected': String(current === 'index') }, '索引'));

function boardPage(cat, tag, core) {
  const list = ideas.filter(x => (!cat || x.category === cat) && (!tag || (x.tags || []).includes(tag))
    && (!core || coreKey(x).toLowerCase() === core.toLowerCase()));
  const chip = (href, text, on, color) => h('a', { class: 'filter' + (on ? ' on' : ''), href, style: color ? `--c:${color}` : null },
    color && h('i'), text);
  const filters = h('nav', { class: 'filters', 'aria-label': '分类' },
    chip('#/grid', '全部', !cat && !tag && !core),
    CATS.map(c => chip(`#/c/${c}`, labelOf(c), cat === c, colorOf(c))),
    tag && chip(`#/tag/${encodeURIComponent(tag)}`, `#${tag}`, true),
    core && chip(`#/core/${encodeURIComponent(core)}`, core, true));
  const head = h('div', { class: 'board-head' },
    h('h1', { class: 'page-title', text: tag ? `#${tag}` : core || (cat ? labelOf(cat) : '灵感') }),
    h('span', { class: 'count', text: `${list.length} 张` }),
    viewSwitch('grid'));
  if (!list.length) {
    return [head, filters, h('div', { class: 'empty' },
      h('p', { text: ideas.length ? '这里还没有内容。' : '还没有灵感图。' }),
      owner && h('button', { class: 'pill-btn solid', type: 'button', onclick: () => $('#files').click() }, icon('plus'), '上传第一张'))];
  }
  return [head, filters, h('div', { class: 'masonry' }, list.map(pinEl)), owner && upgradeButton()];
}

// Ideas analysed before the three similar rows and the meters existed: fill them in, one by one.
function upgradeButton() {
  const todo = ideas.filter(x => !x.rows && x.status !== 'analyzing');
  if (!todo.length) return null;
  const btn = h('button', { class: 'chip-btn', type: 'button' }, icon('sparkle'), `补全分析（${todo.length} 张）`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let k = 0;
    for (const it of todo) {
      btn.lastChild.textContent = `正在补全 ${++k} / ${todo.length}…`;
      const snap = await getDoc(doc(db, 'ideaSrc', it.id)).catch(() => null);
      if (snap?.exists()) await analyze(it, snap.data());
    }
    toast('补全完成');
    route();
  });
  return h('div', { class: 'upgrade' }, btn, h('small', { text: '给旧的图补上三排相似灵感和风格刻度，已经改过的标题和分类不会变。' }));
}

// ---------- Index: a drawer of tabbed cards, one per aesthetic ----------
function indexPage() {
  const groups = new Map();
  for (const it of ideas) {
    const k = coreKey(it) || '未分析';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const list = [...groups.entries()].sort((a, b) => (a[0] === '未分析') - (b[0] === '未分析') || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const head = h('div', { class: 'board-head' },
    h('h1', { class: 'page-title', text: '索引' }),
    h('span', { class: 'count', text: `${list.length} 种风格` }),
    viewSwitch('index'));
  if (!list.length) return [head, h('div', { class: 'empty' }, h('p', { text: '还没有灵感图。' }))];
  const drawer = h('div', { class: 'drawer' },
    list.map(([name, items], i) => {
      const zh = items.find(x => x.core?.nameZh)?.core.nameZh || '';
      const cover = items[0].file?.thumb || items[0].file?.url;
      return h('a', {
        class: 'tabcard', href: `#/core/${encodeURIComponent(name)}`,
        style: `--x:${(i * 29) % 58}%;--z:${i}`,
        'aria-label': `${name}${zh ? '，' + zh : ''}，${items.length} 张`,
      },
        h('span', { class: 'tab' }, h('b', { text: name }), h('small', { text: [zh, items.length].filter(Boolean).join(' · ') })),
        h('span', { class: 'strip' }, cover && h('img', { src: cover, alt: '', loading: 'lazy' })));
    }),
    h('div', { class: 'drawer-base', 'aria-hidden': 'true' }, h('i')));
  return [head, drawer];
}

function pinEl(it) {
  const f = it.file || {};
  const ratio = f.w && f.h ? `${f.w} / ${f.h}` : '4 / 5';
  return h('a', { class: 'pin', href: `#/idea/${it.id}`, style: `--c:${colorOf(it.category)}` },
    h('div', { class: 'pin-img', style: `aspect-ratio:${ratio};background:${(it.palette || [])[0] || '#1a1a1a'}` },
      h('img', { src: f.thumb || f.url, alt: it.title || '', loading: 'lazy' }),
      it.status === 'analyzing' && h('span', { class: 'pin-badge' }, icon('sparkle'), '分析中'),
      shopping.has(it.id) && h('span', { class: 'pin-badge shop' }, icon('bag'))),
    h('div', { class: 'pin-meta' },
      h('i', { class: 'dot' }),
      h('span', { class: 'pin-title', text: it.title || '未命名' })),
    h('div', { class: 'pin-code', text: [coreKey(it).toUpperCase(), numberOf(it)].filter(Boolean).join(' · ') }));
}

// ---------- One idea ----------
const PAPER = '#F2EFE8';
function ideaPage(it) {
  const c = colorOf(it.category);
  document.body.style.setProperty('--entry-c', PAPER);
  const f = it.file || {};
  // The photo fills the top and dissolves into the paper-white sheet; tap it to see the whole picture.
  const hero = h('div', { class: 'hero idea-hero' },
    h('img', { class: 'idea-img', src: f.url, alt: it.title || '', onclick: () => openViewer(f.url) }),
    h('div', { class: 'hero-fade' }));
  const back = h('a', { class: 'media-btn left', href: it.category ? `#/c/${it.category}` : '#/', 'aria-label': '返回' }, icon('chevron-left'));
  const body = h('div', { class: 'entry-body idea-body' });
  const paint = () => body.replaceChildren(...ideaBody(it, body, paint));
  paint();
  return [h('article', { class: 'entry idea', style: `--c:${PAPER};--accent:${c}` }, hero, back, body)];
}

// The five style meters (0 = left word, 1 = right word).
const AXES = [['ornate', '极简', '繁复'], ['warm', '冷', '暖'], ['hard', '柔', '硬'], ['futuristic', '复古', '未来'], ['digital', '手作', '数字']];

// Pictures from your own board that are similar, put first in each row.
function ownSimilar(it, kind) {
  const others = ideas.filter(x => x !== it && x.file);
  const tags = new Set(it.tags || []);
  const overlap = (x) => (x.tags || []).filter(t => tags.has(t)).length;
  let list = [];
  if (kind === 'style') list = others.filter(x => coreKey(x) && coreKey(x).toLowerCase() === coreKey(it).toLowerCase());
  if (kind === 'culture') list = others.filter(x => overlap(x) >= 2).sort((a, b) => overlap(b) - overlap(a));
  if (kind === 'type') list = others.filter(x => (it.labels?.type && x.labels?.type === it.labels.type) || x.category === it.category)
    .sort((a, b) => (b.labels?.type === it.labels?.type) - (a.labels?.type === it.labels?.type));
  return list.slice(0, 4).map(x => ({ own: true, id: x.id, title: x.title, img: x.file.thumb || x.file.url, sub: coreKey(x) || labelOf(x.category) }));
}

function rail(title, sub, items) {
  if (!items.length) return null;
  return h('section', { class: 'idea-sec rail-sec' },
    h('h2', {}, title, sub && h('span', { text: sub })),
    h('div', { class: 'rail' }, items.map(x => h('a', x.own
      ? { class: 'rail-item own', href: `#/idea/${x.id}` }
      : { class: 'rail-item', href: x.link, target: '_blank', rel: 'noopener' },
      h('span', { class: 'rail-img' }, h('img', { src: x.img, alt: x.title || '', loading: 'lazy' }), x.own && h('em', { text: '我的' })),
      h('b', { text: x.title || '' }),
      h('small', { text: x.own ? x.sub : [x.creator, x.date, x.source].filter(Boolean).join(' · ') })))));
}

function ideaBody(it, body, repaint) {
  const core = it.core || {};
  const cul = it.culture || {};
  const pending = it.status === 'analyzing';
  const failed = it.status === 'failed' || (!it.core && !pending);
  const section = (title, ...kids) => h('section', { class: 'idea-sec' }, h('h2', { text: title }), ...kids);
  const copy = async (hex) => { try { await navigator.clipboard.writeText(hex); toast(`已复制 ${hex}`); } catch { toast(hex); } };

  // Spec sheet, after the specimen cards you liked: year and number, big title, then a table and meters.
  const specRows = [
    ['风格', [core.name, core.nameZh].filter(Boolean).join(' / ')],
    ['分类', labelOf(it.category)],
    ['类型', it.labels?.type],
    ['文化', it.labels?.culture],
    ['构图', core.composition],
    ['色彩', core.color],
    ['材质', core.material],
  ].filter(x => x[1]);
  const spec = specRows.length > 0 && h('dl', { class: 'spec' }, specRows.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }))));
  const meters = it.scores && h('div', { class: 'meters', 'aria-label': '风格刻度' }, AXES.map(([key, l, r]) => {
    const v = Math.max(0, Math.min(1, Number(it.scores[key]) || 0));
    return h('div', { class: 'meter' }, h('span', { text: l }),
      h('span', { class: 'meter-track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(v * 100)), 'aria-label': `${l}到${r}` },
        h('i', { style: `left:${(v * 100).toFixed(1)}%` })),
      h('span', { text: r }));
  }));
  const swatches = (it.palette || []).length > 0 && h('div', { class: 'swatches', 'aria-label': '色板' },
    it.palette.map(hex => h('button', { type: 'button', class: 'swatch', style: `--s:${hex}`, title: `复制 ${hex}`, onclick: () => copy(hex) },
      h('i'), h('span', { text: hex }))));

  // Three rows of similar pictures: your own board first, then museum open-access collections.
  const rows = it.rows || (it.inspo ? { style: it.inspo } : null);
  const rails = [
    rail('同一风格', core.name, [...ownSimilar(it, 'style'), ...(rows?.style || [])]),
    rail('相同文化元素', it.labels?.culture, [...ownSimilar(it, 'culture'), ...(rows?.culture || [])]),
    rail('相同类型', it.labels?.type, [...ownSimilar(it, 'type'), ...(rows?.type || [])]),
  ].filter(Boolean);

  const culture = (cul.summary || (cul.works || []).length) && section('文化背景',
    cul.summary && h('p', { class: 'idea-text', text: cul.summary }),
    (cul.works || []).length > 0 && h('div', { class: 'works' }, cul.works.map(w => h('a', {
      class: 'work', target: '_blank', rel: 'noopener',
      href: `https://www.google.com/search?q=${encodeURIComponent([w.title, w.creator].filter(Boolean).join(' '))}`,
    },
      h('div', { class: 'work-top' }, h('b', { text: w.title }), icon('arrow-up-right')),
      h('small', { text: [w.creator, w.year, w.type].filter(Boolean).join(' · ') }),
      w.why && h('p', { text: w.why })))),
    (cul.sources || []).length > 0 && h('details', { class: 'sources' },
      h('summary', { text: `来源（${cul.sources.length}）` }),
      h('ol', {}, cul.sources.map(s => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title || s.url }))))),
    cul.searchHtml && searchChips(cul.searchHtml));

  const pinterest = it.pinterestQuery && h('a', {
    class: 'pill-btn solid wide', target: '_blank', rel: 'noopener',
    href: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(it.pinterestQuery)}`,
  }, icon('search'), `在 Pinterest 看更多：${it.pinterestQuery}`);

  const inCart = shopping.get(it.id);
  const actions = owner && h('div', { class: 'entry-actions' },
    it.category === 'Fashion' && h('button', {
      class: 'pill-btn' + (inCart ? ' ghost' : ''), type: 'button',
      onclick: async (e) => { e.currentTarget.disabled = true; await toggleShopping(it); repaint(); },
    }, icon(inCart ? 'check' : 'bag'), inCart ? '已在购物清单' : '加入购物清单'),
    h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => editForm(it, body, repaint) }, icon('edit'), '编辑'),
    h('button', { class: 'pill-btn ghost', type: 'button', disabled: pending, onclick: () => reanalyze(it, repaint) }, icon('refresh'), '重新分析'),
    h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => removeIdea(it) }, icon('trash'), '删除'));

  return [
    h('div', { class: 'spec-top' },
      h('span', { text: (it.createdAt || '').slice(0, 4) }),
      h('a', { class: 'spec-cat', href: `#/c/${it.category || ''}` }, h('i'), labelOf(it.category) || '未分类'),
      h('span', { text: `No.${numberOf(it)}` })),
    h('h1', { class: 'entry-title spec-title', text: it.title || '未命名' }),
    core.name && h('a', { class: 'spec-core', href: `#/core/${encodeURIComponent(core.name)}` }, core.name.toUpperCase()),
    pending && h('p', { class: 'status-note' }, icon('sparkle'), 'AI 正在分析这张图，完成后会自动显示。'),
    failed && !pending && h('p', { class: 'status-note' }, icon('alert'), owner ? '还没有分析结果，点下面的「重新分析」。' : '还没有分析结果。'),
    spec, meters, swatches,
    core.summary && h('p', { class: 'idea-text', text: core.summary }),
    it.note && h('p', { class: 'idea-note', text: it.note }),
    (it.tags || []).length > 0 && h('div', { class: 'tags' }, it.tags.map(t => h('a', { class: 'tag', href: `#/tag/${encodeURIComponent(t)}`, text: `#${t}` }))),
    ...rails,
    rails.length > 0 && h('p', { class: 'fine', text: '标「我的」的来自你的灵感墙，其余来自博物馆开放馆藏，点开可看出处。' }),
    culture, pinterest, actions,
    h('p', { class: 'fine', text: `上传于 ${fmtDay(it.createdAt)}${it.analyzedAt ? ' · AI 分析，内容仅供参考' : ''}` }),
  ].filter(Boolean);
}

// Google requires its search suggestions to be shown wherever search-grounded answers are shown.
function searchChips(html) {
  const host = h('div', { class: 'search-chips' });
  host.attachShadow({ mode: 'open' }).innerHTML = html;
  return host;
}

function openViewer(src) {
  const close = () => v.remove();
  const v = h('div', { class: 'viewer', role: 'dialog', 'aria-label': '查看大图', onclick: close },
    h('div', { class: 'viewer-slide' }, h('img', { src, alt: '' })),
    h('button', { class: 'media-btn viewer-close', type: 'button', 'aria-label': '关闭', onclick: close }, icon('close')));
  document.body.append(v);
}

function editForm(it, body, repaint) {
  body.querySelector('.edit-form')?.remove();
  const title = h('input', { class: 'field', value: it.title || '', 'aria-label': '标题', placeholder: '标题' });
  const cat = h('select', { class: 'field', 'aria-label': '分类' }, CATS.map(c => h('option', { value: c, text: labelOf(c), selected: c === it.category })));
  const tags = h('input', { class: 'field', value: (it.tags || []).join(', '), 'aria-label': '标签', placeholder: '标签，用逗号分隔' });
  const note = h('textarea', { class: 'field', value: it.note || '', 'aria-label': '备注', placeholder: '你的备注（可不填）' });
  const form = h('form', { class: 'edit-form' }, title, cat, tags, note,
    h('div', { class: 'entry-actions' },
      h('button', { class: 'pill-btn', type: 'submit' }, icon('check'), '保存'),
      h('button', { class: 'pill-btn ghost', type: 'button', onclick: () => form.remove() }, '取消')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const update = { title: title.value.trim(), category: cat.value, tags: parseTags(tags.value), note: note.value.trim(), edited: true };
    try {
      await updateDoc(doc(db, 'ideas', it.id), update);
      Object.assign(it, update);
      document.body.style.setProperty('--entry-c', colorOf(it.category));
      body.closest('.entry').style.setProperty('--c', colorOf(it.category));
      repaint();
      toast('已保存');
    } catch (err) { toast('保存失败：' + (err.code || err.message)); }
  });
  body.querySelector('.entry-actions')?.after(form);
  title.focus();
}

async function removeIdea(it) {
  if (!confirm('删除这张灵感图？删除后不能恢复。')) return;
  try {
    for (const p of [it.file?.path, it.file?.thumbPath]) if (p) await deleteObject(ref(storage, p)).catch(() => {});
    await deleteDoc(doc(db, 'ideas', it.id));
    await deleteDoc(doc(db, 'ideaSrc', it.id)).catch(() => {});
    if (shopping.has(it.id)) { await deleteDoc(doc(db, 'shopping', it.id)).catch(() => {}); shopping.delete(it.id); }
    ideas = ideas.filter(x => x !== it);
    location.hash = it.category ? `#/c/${it.category}` : '#/';
    toast('已删除');
  } catch (err) { toast('删除失败：' + (err.code || err.message)); }
}

// ---------- Shopping list (owner only, never filled automatically) ----------
async function toggleShopping(it) {
  try {
    if (shopping.has(it.id)) {
      await deleteDoc(doc(db, 'shopping', it.id));
      shopping.delete(it.id);
      toast('已从购物清单移除');
    } else {
      const item = { ideaId: it.id, title: it.title || '', thumb: it.file?.thumb || '', price: '', link: '', size: '', note: '', status: 'want', addedAt: new Date().toISOString() };
      await setDoc(doc(db, 'shopping', it.id), item);
      shopping.set(it.id, item);
      toast('已加入购物清单');
    }
  } catch (err) { toast('没有成功：' + (err.code || err.message)); }
}

function shoppingPage() {
  const items = [...shopping.values()].sort((a, b) => (a.status === 'bought') - (b.status === 'bought') || b.addedAt.localeCompare(a.addedAt));
  const want = items.filter(x => x.status !== 'bought');
  const total = want.reduce((s, x) => s + (parseFloat(String(x.price).replace(/[^\d.]/g, '')) || 0), 0);
  const save = async (x, patch, row) => {
    Object.assign(x, patch);
    try { await updateDoc(doc(db, 'shopping', x.ideaId), patch); } catch (err) { toast('保存失败：' + (err.code || err.message)); }
    if ('status' in patch) route();
    else row?.classList.add('saved');
  };
  const rowEl = (x) => {
    const idea = ideas.find(i => i.id === x.ideaId);
    const field = (key, ph, type = 'text') => {
      const el = h('input', { class: 'field', type, value: x[key] || '', placeholder: ph, 'aria-label': ph });
      el.addEventListener('change', () => save(x, { [key]: el.value.trim() }, row));
      return el;
    };
    const row = h('li', { class: 'shop-item' + (x.status === 'bought' ? ' bought' : '') },
      h('a', { class: 'shop-thumb', href: `#/idea/${x.ideaId}` }, h('img', { src: idea?.file?.thumb || x.thumb, alt: '' })),
      h('div', { class: 'shop-main' },
        h('a', { class: 'shop-title', href: `#/idea/${x.ideaId}`, text: idea?.title || x.title || '未命名' }),
        h('div', { class: 'shop-fields' }, field('price', '价格'), field('size', '尺码'), field('link', '购买链接', 'url'), field('note', '备注')),
        h('div', { class: 'shop-actions' },
          h('button', {
            class: 'chip-btn' + (x.status === 'bought' ? ' on' : ''), type: 'button',
            onclick: () => save(x, { status: x.status === 'bought' ? 'want' : 'bought' }),
          }, icon('check'), x.status === 'bought' ? '已买' : '标记为已买'),
          x.link && h('a', { class: 'chip-btn', href: x.link, target: '_blank', rel: 'noopener' }, icon('arrow-up-right'), '去购买'),
          h('button', {
            class: 'chip-btn', type: 'button', 'aria-label': '从清单移除',
            onclick: async () => { await deleteDoc(doc(db, 'shopping', x.ideaId)); shopping.delete(x.ideaId); route(); },
          }, icon('trash')))));
    return row;
  };
  return [
    h('div', { class: 'page-head' },
      h('a', { class: 'back', href: '#/', 'aria-label': '返回' }, icon('chevron-left')),
      h('h1', { class: 'page-title', text: '购物清单' })),
    h('p', { class: 'shop-summary', text: items.length ? `想要 ${want.length} 件${total ? ` · 合计约 ${total.toLocaleString()}` : ''} · 已买 ${items.length - want.length} 件` : '' }),
    items.length ? h('ul', { class: 'shop-list' }, items.map(rowEl))
      : h('div', { class: 'empty' }, h('p', { text: '清单是空的。在「时尚」分类的灵感图里点「加入购物清单」。' })),
  ];
}

// ---------- Image processing ----------
const isHeic = (f) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
let heicPromise = null;
const loadHeic = () => (heicPromise ||= import('https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/heic-to.min.js').catch(() => null));
async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  if (isHeic(file)) {
    const lib = await loadHeic();
    if (lib) { try { return await lib.heicTo({ blob: file, type: 'bitmap' }); } catch {} }
  }
  return null;
}
function drawTo(bmp, max) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = h('canvas', { width: Math.max(1, Math.round(bmp.width * s)), height: Math.max(1, Math.round(bmp.height * s)) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
// Safari can't make WebP and quietly returns a big PNG, so fall back to JPEG.
const toBlob = (c, q) => new Promise(res => c.toBlob(b => b && b.type === 'image/webp' ? res(b) : c.toBlob(res, 'image/jpeg', q + 0.03), 'image/webp', q));

// Five main colours, found with a small k-means on the thumbnail's pixels.
function paletteOf(canvas, k = 5) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const px = [];
  const step = Math.max(1, Math.floor(data.length / 4 / 3000));
  for (let i = 0; i < data.length; i += 4 * step) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
  if (!px.length) return [];
  let centers = Array.from({ length: k }, (_, i) => px[Math.floor((i + 0.5) * px.length / k)].slice());
  let counts = [];
  for (let iter = 0; iter < 10; iter++) {
    const sums = centers.map(() => [0, 0, 0]); counts = centers.map(() => 0);
    for (const p of px) {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } });
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; counts[best]++;
    }
    centers = centers.map((c, j) => counts[j] ? sums[j].map(s => s / counts[j]) : c);
  }
  const hex = (c) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const out = centers.map((c, j) => ({ hex: hex(c), n: counts[j] })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).map(x => x.hex);
  return [...new Set(out)];
}
const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

// ---------- Upload ----------
async function putFile(path, blob, onPct) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = new Uint8Array(await blob.arrayBuffer()); // iPhones can hang uploading straight from a picked file
      return await new Promise((resolve, reject) => {
        const task = uploadBytesResumable(ref(storage, path), data, { contentType: blob.type });
        let lastChange = Date.now();
        const watchdog = setInterval(() => { if (Date.now() - lastChange > 30000) task.cancel(); }, 3000);
        task.on('state_changed',
          (s) => { lastChange = Date.now(); onPct?.(s.bytesTransferred / s.totalBytes); },
          (err) => { clearInterval(watchdog); reject(err); },
          async () => { clearInterval(watchdog); try { resolve(await getDownloadURL(task.snapshot.ref)); } catch (e) { reject(e); } });
      });
    } catch (err) {
      if (attempt >= 4 || /unauthori[sz]ed|unauthenticated/.test(err.code || '')) throw err;
      await sleep(1500 * attempt);
    }
  }
}

const trayRows = new Map();
function trayRow(key, name) {
  $('#tray').hidden = false;
  const thumb = h('span', { class: 'tray-thumb' });
  const label = h('span', { class: 'tray-label', text: '读取中…' });
  const bar = h('i');
  const row = h('li', { class: 'tray-row' }, thumb, h('div', { class: 'tray-info' }, h('b', { text: name }), label, h('span', { class: 'tray-bar' }, bar)));
  $('#trayList').prepend(row);
  const api = {
    thumb: (src) => thumb.replaceChildren(h('img', { src, alt: '' })),
    set: (text, pct, state) => {
      label.textContent = text;
      if (pct != null) bar.style.width = `${Math.round(pct * 100)}%`;
      row.dataset.state = state || '';
      updateTrayTitle();
    },
  };
  trayRows.set(key, row);
  return api;
}
function updateTrayTitle() {
  const rows = [...$('#trayList').children];
  const busy = rows.filter(r => !['done', 'failed'].includes(r.dataset.state)).length;
  $('#trayTitle').textContent = busy ? `正在处理 ${busy} 张` : `完成 ${rows.filter(r => r.dataset.state === 'done').length} 张`;
  // Close by itself a few seconds after everything is finished (unless something failed, so you can read it).
  clearTimeout(trayTimer);
  if (!busy && rows.every(r => r.dataset.state === 'done')) trayTimer = setTimeout(closeTray, 5000);
}
let trayTimer = null;
function closeTray() { $('#tray').hidden = true; $('#trayList').replaceChildren(); }
$('#trayClose').addEventListener('click', closeTray);
$('#addBtn').addEventListener('click', () => { $('#files').value = ''; $('#files').click(); });
$('#files').addEventListener('change', (e) => addFiles([...e.target.files]));
document.addEventListener('dragover', (e) => { if (owner) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!owner) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('image/') || isHeic(f)));
});

let queue = Promise.resolve();
const running = new Set();
function addFiles(files) {
  if (!files.length) return;
  // Up to two pictures at a time.
  const lanes = [[], []];
  files.forEach((f, i) => lanes[i % 2].push(f));
  for (const lane of lanes) {
    const p = lane.reduce((chain, f) => chain.then(() => processFile(f)), Promise.resolve());
    running.add(p); p.finally(() => running.delete(p));
  }
}

const safeName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'img';
const extFor = (type) => ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[type] || 'bin');

async function processFile(file) {
  const key = `${file.name}-${Math.random()}`;
  const row = trayRow(key, file.name);
  try {
    const bmp = await decodeImage(file);
    if (!bmp) throw new Error('这张图打不开（HEIC 请重试，或在相册里导出为 JPEG）');
    const fullC = drawTo(bmp, DISPLAY_MAX), thumbC = drawTo(bmp, THUMB_MAX), aiC = drawTo(bmp, AI_MAX);
    const [w, hgt] = [bmp.width, bmp.height];
    bmp.close?.();
    const [full, thumb, aiBlob] = await Promise.all([toBlob(fullC, 0.84), toBlob(thumbC, 0.74), toBlob(aiC, 0.8)]);
    const palette = paletteOf(thumbC);
    row.thumb(URL.createObjectURL(thumb));

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeName(file.name)}`;
    const path = `ideas/${stamp}.${extFor(full.type)}`;
    const thumbPath = `ideas/${stamp}_t.${extFor(thumb.type)}`;
    let a = 0, b = 0;
    const show = () => row.set(`上传中 ${Math.round((a * full.size + b * thumb.size) / (full.size + thumb.size) * 100)}%`, (a * full.size + b * thumb.size) / (full.size + thumb.size) * 0.7, 'uploading');
    const [url, thumbUrl] = await Promise.all([
      putFile(path, full, (p) => { a = p; show(); }),
      putFile(thumbPath, thumb, (p) => { b = p; show(); }),
    ]);
    const it = {
      createdAt: new Date().toISOString(),
      file: { url, thumb: thumbUrl, path, thumbPath, w, h: hgt },
      palette, title: '', category: '', tags: [], note: '', status: 'analyzing',
    };
    const created = await addDoc(collection(db, 'ideas'), it);
    it.id = created.id;
    ideas.unshift(it);
    // Keep the small copy so "重新分析" works later without downloading from Storage.
    const b64 = await blobToBase64(aiBlob);
    await setDoc(doc(db, 'ideaSrc', it.id), { mime: aiBlob.type, data: b64 }).catch(() => {});
    refreshIfBoard();
    row.set('AI 分析中…', 0.8, 'analyzing');
    await analyze(it, { mime: aiBlob.type, data: b64 }, (msg) => row.set(msg, null, 'analyzing'));
    row.set(it.status === 'done' ? `完成：${it.title}` : '已上传，AI 没分析成功（可在详情页重试）', 1, it.status === 'done' ? 'done' : 'failed');
  } catch (err) {
    console.error(err);
    row.set('失败：' + String(err.code || err.message || err).slice(0, 80), null, 'failed');
  }
  refreshIfBoard();
}
function refreshIfBoard() {
  const { name } = parseRoute();
  if (['', 'c', 'tag', 'grid', 'index', 'core'].includes(name)) route();
}

// ---------- AI ----------
let modelP = null, searchModelP = null;
async function models() {
  const aiApp = await withTimeout(getAiApp(), 20000, 'App Check（reCAPTCHA）没有响应');
  const { getAI, getGenerativeModel, GoogleAIBackend, Schema } = await import(`${FB_SDK}/firebase-ai.js`);
  const ai = getAI(aiApp, { backend: new GoogleAIBackend() });
  modelP ||= getGenerativeModel(ai, {
    model: AI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: Schema.object({
        properties: {
          title: Schema.string(),
          category: Schema.string(),
          tags: Schema.array({ items: Schema.string() }),
          coreName: Schema.string(),
          coreNameZh: Schema.string(),
          coreSummary: Schema.string(),
          composition: Schema.string(),
          color: Schema.string(),
          material: Schema.string(),
          pinterestQuery: Schema.string(),
          styleQuery: Schema.string(),
          cultureQuery: Schema.string(),
          typeQuery: Schema.string(),
          cultureName: Schema.string(),
          typeName: Schema.string(),
          researchTopic: Schema.string(),
          scores: Schema.object({ properties: {
            ornate: Schema.number(), warm: Schema.number(), hard: Schema.number(), futuristic: Schema.number(), digital: Schema.number(),
          } }),
        },
      }),
    },
  });
  // A second model that may search Google. It can't also use the JSON schema, so it answers in a JSON block.
  searchModelP ||= getGenerativeModel(ai, { model: AI_MODEL, tools: [{ googleSearch: {} }] });
  return [modelP, searchModelP];
}

const ANALYSIS_PROMPT = [
  'IDEA_ANALYSIS. You are a sharp creative director helping a design student (fashion, visuals, digital design) build an inspiration board.',
  'Look at the image and return JSON:',
  '- title: 4 to 12 Chinese characters naming what makes this image interesting.',
  '- category: exactly one of Fashion, Visuals, Digital, AI, Business.',
  '    Fashion = clothing, outfits, accessories, styling, runway, fashion photography.',
  '    Visuals = graphic design, posters, typography, photography, art, illustration, color, branding visuals.',
  '    Digital = UI/UX, websites, apps, 3D, motion, interactive or screen-based design.',
  '    AI = AI-generated imagery, AI products and tools, AI art, generative work.',
  '    Business = brands, marketing, retail, packaging strategy, business models, campaigns, data.',
  '- tags: 4 to 8 short tags in Simplified Chinese (style, material, era, technique, mood).',
  '- coreName: the aesthetic it belongs to, as people name it online (e.g. Gorpcore, Balletcore, Y2K, Old Money, Brutalism, Swiss Style, Vaporwave, Wabi-sabi). Pick the closest real one.',
  '- coreNameZh: its common Chinese name (e.g. 山系, 芭蕾风, 千禧风, 老钱风, 粗野主义, 瑞士风格), or empty.',
  '- coreSummary: 2 to 3 sentences in Simplified Chinese: why this image belongs to that aesthetic.',
  '- composition, color, material: one sentence each in Simplified Chinese, concrete and specific to this image (for non-physical work, material = texture/medium).',
  '- pinterestQuery: 2 to 5 English words that would find similar pins on Pinterest.',
  'Three searches in an art museum collection (1 to 3 English words each, words a museum catalogue would use):',
  '- styleQuery: works sharing the same aesthetic or art movement.',
  '- cultureQuery: works from the same cultural roots (a subculture, region, tradition, era or craft).',
  '- typeQuery: the same kind of thing (garment, object, medium or format, e.g. coat, poster, chair, textile).',
  '- cultureName: those cultural roots in 2 to 8 Chinese characters (e.g. 户外运动文化, 日本侘寂).',
  '- typeName: the kind of thing in 2 to 6 Chinese characters (e.g. 外套, 海报, 界面).',
  '- scores: five numbers from 0 to 1. ornate (0 minimal, 1 ornate), warm (0 cold, 1 warm), hard (0 soft, 1 hard),',
  '  futuristic (0 retro, 1 futuristic), digital (0 handmade, 1 digital).',
  '- researchTopic: one English sentence describing the aesthetic/culture to research further.',
].join('\n');

async function analyze(it, src, onStep = () => {}) {
  if (!AI_HOSTS.includes(location.hostname)) {
    it.status = 'failed';
    await updateDoc(doc(db, 'ideas', it.id), { status: 'failed' }).catch(() => {});
    toast('预览地址不能用 AI，只有正式网站可以。', 5000);
    return;
  }
  try {
    const [model, searchModel] = await models();
    onStep('AI 正在看图…');
    const r1 = await withTimeout(model.generateContent([ANALYSIS_PROMPT, { inlineData: { mimeType: src.mime, data: src.data } }]), 60000, 'AI 响应超时');
    const a = JSON.parse(r1.response.text());
    const category = CATS.includes(a.category) ? a.category : 'Visuals';
    const update = {
      title: it.title || (a.title || '').trim(),
      category: it.category || category,
      tags: [...new Set([...(it.tags || []), ...(a.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean)])].slice(0, 10),
      core: { name: a.coreName || '', nameZh: a.coreNameZh || '', summary: a.coreSummary || '', composition: a.composition || '', color: a.color || '', material: a.material || '' },
      pinterestQuery: (a.pinterestQuery || '').trim(),
      labels: { culture: (a.cultureName || '').trim(), type: (a.typeName || '').trim() },
      scores: a.scores || null,
    };
    Object.assign(it, update);
    await updateDoc(doc(db, 'ideas', it.id), update);
    repaintIfOpen(it);

    onStep('正在联网查文化背景…');
    const [culture, rows] = await Promise.all([
      research(searchModel, a).catch(err => { console.warn('research failed', err); return null; }),
      findRows(a, category).catch(() => ({ style: [], culture: [], type: [] })),
    ]);
    const done = { culture: culture || null, rows, inspo: null, status: 'done', analyzedAt: new Date().toISOString() };
    Object.assign(it, done);
    await updateDoc(doc(db, 'ideas', it.id), done);
  } catch (err) {
    console.error('AI failed', err);
    it.status = 'failed';
    await updateDoc(doc(db, 'ideas', it.id), { status: 'failed' }).catch(() => {});
    const msg = String(err?.message || err);
    toast(/App Check/i.test(msg) ? 'AI 被 App Check 拦截了。' : 'AI 这次没能完成：' + (err?.code || msg).slice(0, 100), 6000);
  }
  repaintIfOpen(it);
}

// Culture summary + related works, researched with Google Search. Sources come from Google, not from the AI.
async function research(searchModel, a) {
  const prompt = [
    `Research this aesthetic with Google Search: ${a.coreName}${a.coreNameZh ? ` (${a.coreNameZh})` : ''}. ${a.researchTopic || ''}`,
    'Answer ONLY with a JSON object inside a ```json code block:',
    '{"summary": "4 to 6 sentences in Simplified Chinese on where this aesthetic comes from, the culture and people behind it, and why it matters now",',
    ' "works": [{"title": "...", "creator": "...", "year": "...", "type": "designer collection / artwork / film / book / brand / project", "why": "one sentence in Simplified Chinese on how it relates"}]}',
    'Give 3 to 5 real, well-documented works found in your search results. Use their original titles. Do not invent anything.',
  ].join('\n');
  const r = await withTimeout(searchModel.generateContent(prompt), 90000, '联网搜索超时');
  const text = r.response.text();
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  const out = m ? JSON.parse(m[1]) : {};
  const meta = r.response.candidates?.[0]?.groundingMetadata || {};
  const sources = (meta.groundingChunks || []).map(c => c.web).filter(w => w?.uri)
    .map(w => ({ title: w.title || w.domain || '', url: w.uri })).slice(0, 8);
  return {
    summary: String(out.summary || '').trim(),
    works: (out.works || []).filter(w => w?.title).slice(0, 5).map(w => ({
      title: String(w.title), creator: String(w.creator || ''), year: String(w.year || ''), type: String(w.type || ''), why: String(w.why || ''),
    })),
    sources,
    searchHtml: meta.searchEntryPoint?.renderedContent || '',
  };
}

// Three rows of related pictures from museum open-access collections (free, no key, allowed to show).
// A picture appears in only one row.
async function findRows(a, category) {
  const [style, culture, type] = await Promise.all([
    findMuseum(a.styleQuery || a.coreName, category),
    findMuseum(a.cultureQuery, category),
    findMuseum(a.typeQuery, category),
  ]);
  const seen = new Set();
  const uniq = (list) => list.filter(x => !seen.has(x.link) && seen.add(x.link)).slice(0, 6);
  return { style: uniq(style), culture: uniq(culture), type: uniq(type) };
}
async function findMuseum(q, category) {
  if (!q) return [];
  const [met, aic] = await Promise.all([searchMet(q, category).catch(() => []), searchArtic(q).catch(() => [])]);
  const first = category === 'Fashion' ? met : aic, second = category === 'Fashion' ? aic : met;
  const out = [];
  for (let i = 0; i < 8; i++) { if (first[i]) out.push(first[i]); if (second[i]) out.push(second[i]); }
  return out.slice(0, 8);
}
async function searchMet(q, category) {
  const dept = category === 'Fashion' ? '&departmentId=8' : ''; // 8 = The Costume Institute
  const r = await withTimeout(fetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true${dept}&q=${encodeURIComponent(q)}`), 10000, 'Met');
  const ids = ((await r.json()).objectIDs || []).slice(0, 10);
  const objs = await Promise.all(ids.map(id => withTimeout(fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`), 8000, 'Met')
    .then(x => x.json()).catch(() => null)));
  return objs.filter(o => o?.primaryImageSmall && o.isPublicDomain).slice(0, 5)
    .map(o => ({ title: o.title, creator: o.artistDisplayName || o.culture || '', date: o.objectDate || '', img: o.primaryImageSmall, link: o.objectURL, source: '大都会博物馆' }));
}
async function searchArtic(q) {
  const r = await withTimeout(fetch(`https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(q)}&limit=12&fields=id,title,artist_title,date_display,image_id,is_public_domain`), 10000, 'AIC');
  return ((await r.json()).data || []).filter(x => x.image_id && x.is_public_domain).slice(0, 5).map(x => ({
    title: x.title, creator: x.artist_title || '', date: x.date_display || '',
    img: `https://www.artic.edu/iiif/2/${x.image_id}/full/600,/0/default.jpg`,
    link: `https://www.artic.edu/artworks/${x.id}`, source: '芝加哥艺术博物馆',
  }));
}

async function reanalyze(it, repaint) {
  try {
    const snap = await getDoc(doc(db, 'ideaSrc', it.id));
    if (!snap.exists()) { toast('找不到这张图的分析副本，删除后重新上传即可。', 5000); return; }
    it.status = 'analyzing';
    await updateDoc(doc(db, 'ideas', it.id), { status: 'analyzing' });
    repaint();
    // Re-analysis replaces the AI's suggestions, but keeps title, category and tags you edited by hand.
    if (!it.edited) Object.assign(it, { title: '', category: '', tags: [] });
    await analyze(it, snap.data());
  } catch (err) { toast('重新分析失败：' + (err.code || err.message)); }
  repaint();
}

function repaintIfOpen(it) {
  const { name, arg } = parseRoute();
  if (name === 'idea' && arg === it.id) route();
}

// ---------- Start ----------
$('#logoutBtn').addEventListener('click', async () => { await signOut(auth); location.replace('password.html?next=ideas.html'); });

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace('password.html?next=ideas.html'); return; }
  owner = isOwner(user);
  $('#addBtn').hidden = !owner;
  $('#shopTab').hidden = !owner;
  try {
    const snap = await getDocs(collection(db, 'ideas'));
    ideas = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (owner) {
      const s = await getDocs(collection(db, 'shopping')).catch(() => null);
      shopping = new Map((s?.docs || []).map(d => [d.id, { ideaId: d.id, ...d.data() }]));
    }
  } catch (err) {
    console.error(err);
    $('#view').replaceChildren(h('p', { class: 'empty', text: '加载失败：' + (err.code || err.message) + '。如果刚更新过网站，请确认 Firebase 规则已经发布。' }));
    return;
  }
  loaded = true;
  route();
});
