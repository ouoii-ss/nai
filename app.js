'use strict';

/* ============ 数据层 (HTTP API → 后端存储) ============
 * 数据通过 serve.js / Cloudflare Pages Function 暴露的 GET/POST /api/data 读写。
 * - 本地：serve.js 把数据存到 data/index.json + data/images/<id>.<ext>。
 * - 云端：Cloudflare Pages Function 把数据存到 D1，图片作为静态文件 /data/images/...。
 * 两种后端共用同一套 /api/data 接口与图片路径，前端无需改动。
 * 换浏览器、删浏览器都不丢——因为数据在服务端（本地电脑或云端）。
 *
 * 旧版曾用 IndexedDB（库名 nai_workbench）——保留 "从旧版迁移" 逻辑，
 * 会从 IndexedDB 一次性把当前浏览器的数据合并进当前后端。
 */
const DB_NAME = 'nai_workbench'; // 仅用于"读旧 IndexedDB"做迁移
let db = null; // 旧 IDB 连接，仅迁移时用
let RAW_EXTERNAL = false; // 云端模式：vibes 的 raw 拆到静态文件 /data/vibes-raw/<id>.json，前端自行取回
let usingServer = false;  // true=服务端存储（serve.js / 云端）；false=浏览器本地 IndexedDB（双击打开即可用）
let STATIC_SITE = false; // 静态托管模式（GitHub Pages）：数据来自仓库内静态文件，无后端，写入为无操作

// file:// 双击打开时，若本机服务（serve.js）在跑，就通过它连到硬盘数据库；
// 否则退回离线（IndexedDB / 内置 seed）。这两个基址在 loadFromAPI 里按协议设置。
let API_BASE = '';                       // file:// 下 = 'http://127.0.0.1:8137'，否则空串（同源请求）
let RAW_BASE = '/data/vibes-raw/';      // vibe raw 静态基址（file:// 下换成绝对地址）
function fetchWithTimeout(url, opts, ms) {
  if (!ms) return fetch(url, opts);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(t));
}

// ===== 本地浏览器存储（IndexedDB）：无服务端时的兜底，双击打开 index.html 也能用、导入也工作 =====
const LOCAL_DB = 'nai_wb_local';
const LOCAL_STORE = 'data';
let _localDb = null;
function localDBOpen() {
  return new Promise((resolve, reject) => {
    if (_localDb) return resolve(_localDb);
    const req = indexedDB.open(LOCAL_DB, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(LOCAL_STORE)) db.createObjectStore(LOCAL_STORE); };
    req.onsuccess = () => { _localDb = req.result; resolve(_localDb); };
    req.onerror = () => reject(req.error);
  });
}
async function localGet(key) {
  const db = await localDBOpen();
  return new Promise((res, rej) => { const r = db.transaction(LOCAL_STORE, 'readonly').objectStore(LOCAL_STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function localSet(key, val) {
  const db = await localDBOpen();
  return new Promise((res, rej) => { const r = db.transaction(LOCAL_STORE, 'readwrite').objectStore(LOCAL_STORE).put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
async function localDel(key) {
  const db = await localDBOpen();
  return new Promise((res, rej) => { const r = db.transaction(LOCAL_STORE, 'readwrite').objectStore(LOCAL_STORE).delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
// 上传图片大图存储：每张图「独立存一条小记录」(imgfull:<id>)，导入时写一次。
// 绝不再把几十张图拼成一个超大对象一次性写入（浏览器会拒 → 整库丢失）。
// 之后任何保存只写主库的轻量标记，不碰大图库 → 不会卡、不会再丢。
const IMGREF = '__imgref__:';
const IMGKEY = (id) => 'imgfull:' + id;
let _imgStored = null; // 已知已落库的大图 id 集合（懒加载）
async function ensureImgStored() {
  if (_imgStored === null) _imgStored = new Set();
  return _imgStored;
}
async function storeUploadImage(id, full, thumb) {
  await localSet(IMGKEY(id), { full: full || '', thumb: thumb || '' });
  (await ensureImgStored()).add(id);
}
async function loadUploadImage(id) {
  try {
    const r = await localGet(IMGKEY(id));
    if (r && (r.full || r.thumb)) { (await ensureImgStored()).add(id); return r; }
  } catch (e) { /* ignore */ }
  return null;
}
async function localLoadAll() {
  const a = await localGet('artworks');
  const v = await localGet('vibes');
  const m = await localGet('artistMeta');
  artistMeta = (m && typeof m === 'object') ? m : {};
  const arts = Array.isArray(a) ? a : [];
  for (const x of arts) {
    if (!x || x.source !== 'upload') continue;
    if (typeof x.full === 'string' && x.full.indexOf(IMGREF) === 0) {
      const rec = await loadUploadImage(x.full.slice(IMGREF.length));
      x.full = rec ? rec.full : '';
      if (rec && rec.thumb && (!x.thumb || x.thumb.indexOf(IMGREF) === 0)) x.thumb = rec.thumb;
    }
    if (typeof x.thumb === 'string' && x.thumb.indexOf(IMGREF) === 0) {
      const rec = await loadUploadImage(x.thumb.slice(IMGREF.length));
      if (rec && rec.thumb) x.thumb = rec.thumb;
    }
  }
  return { artworks: arts, vibes: Array.isArray(v) ? v : [] };
}
async function localSaveAll(arts, vbs, meta) {
  const stored = await ensureImgStored();
  const stripped = [];
  for (const a of arts) {
    if (!a || a.source !== 'upload') { stripped.push(a); continue; }
    const hasFull = typeof a.full === 'string' && a.full.indexOf('data:') === 0;
    const hasThumb = typeof a.thumb === 'string' && a.thumb.indexOf('data:') === 0;
    let c = a;
    // 首次/变更：尝试把大图独立写成一条小记录（只写一次，绝不一口气写全库）
    if ((hasFull || hasThumb) && !stored.has(a.id)) {
      try { await storeUploadImage(a.id, a.full, a.thumb); }
      catch (e) { /* 写入失败则保留内联，绝不丢图 */ }
    }
    // 只有大图确实落库了才剥离成标记；否则保留内联 base64（双保险，不丢图）
    if (stored.has(a.id) && (hasFull || hasThumb)) {
      c = Object.assign({}, a);
      if (hasFull) c.full = IMGREF + a.id;
      if (hasThumb) c.thumb = IMGREF + a.id;
    }
    stripped.push(c);
  }
  await localSet('artworks', stripped);
  await localSet('vibes', vbs);
  await localSet('artistMeta', meta && typeof meta === 'object' ? meta : {});
}
// 清空本地时也清掉所有大图小记录
async function localClearImages() {
  const stored = await ensureImgStored();
  for (const id of stored) { try { await localDel(IMGKEY(id)); } catch (e) { /* ignore */ } }
  _imgStored = new Set();
}

// 旧 IndexedDB 读取（仅迁移）
function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用，请先关闭其它打开本页的标签页'));
  });
}
function store(name, mode) { return db.transaction(name, mode).objectStore(name); }
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

// 按 id 去重，避免磁盘/迁移过程中残留的重复条目被读出来
function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (const x of (arr || [])) {
    if (!x || x.id == null) { out.push(x); continue; }
    if (seen.has(x.id)) continue; // 同 id 只保留第一条
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

// 从 API 加载并填进 artworks / vibes 数组
// 本地（file:// 双击打开）模式：把服务端绝对路径 /data/... 转成相对路径 data/...，
// 这样图片能直接从硬盘 data/images/ 读取，无需任何服务器
function _normalizePaths(list) {
  (list || []).forEach(o => {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === 'string' && v.indexOf('/data/') === 0) o[k] = v.slice(1);
    }
  });
}

async function loadFromAPI() {
  // 静态托管模式（GitHub Pages 等纯静态）：从仓库内相对路径读取，无后端
  if (STATIC_SITE) {
    const r = await fetch('data/index.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('静态数据读取失败 ' + r.status);
    const data = await r.json();
    artworks = dedupeById(Array.isArray(data.artworks) ? data.artworks : []);
    vibes = dedupeById(Array.isArray(data.vibes) ? data.vibes : []);
    RAW_EXTERNAL = true;
    usingServer = false;
    try { await attachVibeRaws(); } catch (e) { /* 取 raw 失败不阻断列表 */ }
    return;
  }
  try {
    // file:// 双击打开：尝试连本机服务（serve.js）的硬盘数据库；带短超时，连不上就退回离线
    const isFile = location.protocol === 'file:';
    API_BASE = isFile ? 'http://127.0.0.1:8137' : '';
    RAW_BASE = isFile ? 'http://127.0.0.1:8137/data/vibes-raw/' : '/data/vibes-raw/';
    const r = await fetchWithTimeout(API_BASE + '/api/data?_=' + Date.now(), { cache: 'no-store' }, isFile ? 1500 : 0);
    if (!r.ok) throw new Error('API 返回 ' + r.status);
    const data = await r.json();
    const rawA = Array.isArray(data.artworks) ? data.artworks : [];
    const rawV = Array.isArray(data.vibes) ? data.vibes : [];
    artworks = dedupeById(rawA);
    vibes = dedupeById(rawV);
    artistMeta = (data.artistMeta && typeof data.artistMeta === 'object') ? data.artistMeta : {};
    // 云端模式：后端把 raw 大字段拆到静态文件，标记后由前端补充回 vibes（不增加 D1/POST 体积）
    RAW_EXTERNAL = !!(data.meta && data.meta.rawExternal);
    if (RAW_EXTERNAL) { try { await attachVibeRaws(); } catch (e) { /* 取 raw 失败不阻断列表 */ } }
    usingServer = true;
    if (isFile) toast('已连接本机数据库（' + artworks.length + ' 张画作 + ' + vibes.length + ' 个 Vibe），改动会存到硬盘 ✓');
    // 若后端本就有重复条目，加载时顺手把干净版本写回，彻底清除重复
    if (artworks.length !== rawA.length || vibes.length !== rawV.length) {
      try { await saveToAPI(); } catch (e) { /* 写回失败不影响本次读取 */ }
    }
    return;
  } catch (e) {
    // 无服务端（双击打开 index.html / 服务未启动）：优先用浏览器本地 IndexedDB；
    // 若本地也为空，则直接用内置 data/seed.js（双击即开、无需服务器），并写入 IndexedDB 持久化
    usingServer = false;
    RAW_EXTERNAL = false;
    let local = { artworks: [], vibes: [] };
    try { local = await localLoadAll(); } catch (err) { /* 忽略 */ }
    if (local.artworks.length || local.vibes.length) {
      artworks = dedupeById(local.artworks);
      vibes = dedupeById(local.vibes);
    } else if (window.__SEED && (window.__SEED.artworks || window.__SEED.vibes)) {
      artworks = dedupeById(window.__SEED.artworks || []);
      vibes = dedupeById(window.__SEED.vibes || []);
      _normalizePaths(artworks); _normalizePaths(vibes);
      try { await localSaveAll(artworks, vibes); } catch (err) { /* 忽略 */ }
      toast('已从本地数据载入 ' + artworks.length + ' 张画作（已存进本浏览器）✓');
    } else {
      artworks = []; vibes = [];
    }
    // 归一化 vibe：补齐画师 / 标签 / 批次字段（老数据可能缺）
    vibes.forEach(v => {
      if (!('artist' in v)) v.artist = '';
      if (!('tags' in v)) v.tags = [];
      if (!('batch' in v)) v.batch = '';
    });
  }
}

// 云端模式：从静态文件取回每个 vibe 的 raw（D1 单格上限 2MB，raw 可达 15MB，故不放 D1）
async function attachVibeRaws() {
  if (!Array.isArray(vibes)) return;
  await Promise.all(vibes.map(async (v) => {
    if (!v || !v.id || v.raw) return;
    try {
      // raw 是部署时生成的静态文件，内容不变，允许浏览器/CDN 缓存（不强制 no-store）
      const base = STATIC_SITE ? 'data/vibes-raw/' : RAW_BASE;
      const r = await fetch(base + encodeURIComponent(v.id) + '.json');
      if (!r.ok) return;
      v.raw = await r.json();
    } catch (e) { /* 单个失败忽略 */ }
  }));
}

// 序列化 + 防抖写入：100ms 内多次改动合并成一次 POST
let _saveTimer = null;
let _saveResolvers = [];
async function _flushSaveNow() {
  if (STATIC_SITE) {
    // 静态托管：没有后端可写，假装成功以免 UI 报错（横幅已提示用户改动不保存）
    rs.forEach(({ res }) => res({ ok: true }));
    return Promise.resolve({ ok: true });
  }
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const rs = _saveResolvers; _saveResolvers = [];
  if (usingServer) {
    // 服务端模式：保存前先合并服务器现有数据，避免旧客户端（如刷新前的内存态 / 多标签页）
    // 把服务器上的新数据整体覆盖掉而丢失。规则：同 id 且内容不同 -> 保留本地(即本次编辑)；
    // 同 id 且内容相同 -> 任取(不丢)；服务器独有 -> 保留；本地独有 -> 追加。
    let arts = artworks, vbs = vibes;
    try {
      const cur = await fetchWithTimeout(API_BASE + '/api/data?_=' + Date.now(), { cache: 'no-store' }, 0);
      if (cur.ok) {
        const cd = await cur.json();
        const sA = dedupeById(Array.isArray(cd.artworks) ? cd.artworks : []);
        const localA = new Map(artworks.filter(a => a && a.id != null).map(a => [a.id, a]));
        const sIdsA = new Set(sA.map(a => a.id));
        const mergedA = sA.map(s => {
          const l = localA.get(s.id);
          if (l && JSON.stringify(l) !== JSON.stringify(s)) return l; // 本地有编辑 -> 用本地
          return s; // 相同或服务端独有 -> 保留服务端
        });
        arts = dedupeById([...mergedA, ...artworks.filter(a => a && a.id != null && !sIdsA.has(a.id))]);
        const sV = dedupeById(Array.isArray(cd.vibes) ? cd.vibes : []);
        const localV = new Map(vibes.filter(v => v && v.id != null).map(v => [v.id, v]));
        const sIdsV = new Set(sV.map(v => v.id));
        const mergedV = sV.map(s => {
          const l = localV.get(s.id);
          if (l && JSON.stringify(l) !== JSON.stringify(s)) return l;
          return s;
        });
        vbs = dedupeById([...mergedV, ...vibes.filter(v => v && v.id != null && !sIdsV.has(v.id))]);
      }
    } catch (e) { /* 合并失败则用内存态直接保存 */ }
    // raw 已在静态文件里，保存时剥离，避免每次改动都上传几十 MB
    const vibesToSave = RAW_EXTERNAL
      ? vbs.map(v => {
          if (v && typeof v === 'object' && ('raw' in v)) { const c = Object.assign({}, v); delete c.raw; return c; }
          return v;
        })
      : vbs;
    return fetch(API_BASE + '/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artworks: arts, vibes: vibesToSave, artistMeta }),
    }).then(r => {
      if (!r.ok) throw new Error('API ' + r.status);
      return r.json();
    }).then(data => { rs.forEach(({ res }) => res(data)); },
           err => { rs.forEach(({ rej }) => rej(err)); });
  }
  // 本地模式（无服务端）：写入浏览器 IndexedDB，双击打开也能持久化
  return localSaveAll(artworks, vibes, artistMeta).then(
    () => { rs.forEach(({ res }) => res({ ok: true })); },
    err => { rs.forEach(({ rej }) => rej(err)); }
  );
}
function saveToAPI() {
  return new Promise((res, rej) => {
    _saveResolvers.push({ res, rej });
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _flushSaveNow(); }, 100);
  });
}
// 立即强制 flush（用于批量操作结束 / 关页前）
function flushSave() { if (_saveTimer) return _flushSaveNow(); return Promise.resolve({ ok: true }); }
// 强制立即落盘（无视是否有待保存队列）
function forceSave() { return _flushSaveNow(); }
window.addEventListener('beforeunload', () => { if (_saveTimer) _flushSaveNow(); });


// —— 以下函数保留旧名字，调用点不动；实现改为"内存 + 自动落盘" ——
async function addArtwork(a) {
  const idx = artworks.findIndex(x => x.id === a.id);
  if (idx >= 0) artworks[idx] = a; else artworks.push(a);
  await saveToAPI();
}
function getAllArt() { return artworks.slice(); }
async function delArtDB(id) {
  artworks = artworks.filter(a => a.id !== id);
  await saveToAPI();
}
async function addVibeDB(v) {
  const idx = vibes.findIndex(x => x.id === v.id);
  if (idx >= 0) vibes[idx] = v; else vibes.push(v);
  await saveToAPI();
}
async function updateVibeDB(v) {
  const idx = vibes.findIndex(x => x.id === v.id);
  if (idx >= 0) vibes[idx] = v; else vibes.push(v);
  await saveToAPI();
}
function getAllVibes() { return vibes.slice(); }
async function delVibeDB(id) {
  vibes = vibes.filter(v => v.id !== id);
  await saveToAPI();
}

// 仅含提示词、无图片的导入条目使用的占位缩略图
const PLACEHOLDER_THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420">' +
  '<rect width="100%" height="100%" fill="#eef0f5"/>' +
  '<text x="50%" y="48%" font-family="sans-serif" font-size="16" fill="#9aa0ad" text-anchor="middle">无缩略图</text>' +
  '<text x="50%" y="55%" font-family="sans-serif" font-size="12" fill="#9aa0ad" text-anchor="middle">仅提示词</text>' +
  '</svg>'
);

/* ============ 内存状态 ============ */
let artworks = [];
let vibes = [];
let artistMeta = {}; // 画师合集卡片用的备注/链接：{ [artistName]: { note, link } }
let pendingThumb = null;
let pendingFull = null;
let pendingFileName = '';
let lbCurrent = null;
// 复制确认框里显示的名字
const COPY_LABEL = { lbArtist: '画师串', lbPos: '正面提示词', lbNeg: '负面提示词' };
let renamingId = null;   // 正在改名的 Vibe id（null 表示无）
let viewMode = 'gallery'; // 'gallery' 平铺画廊 | 'artists' 画师合集（文件夹导航）
let artistDrill = null;   // 画师合集中当前进入的画师名（null=显示文件夹列表）
let selectedIds = new Set(); // 批量选择：被选中的画作 id
// 分页状态：各视图独立，互不干扰（画廊 / 画师文件夹 / 钻进去的画作 / Vibe 库）
const pg = { flat: 1, folders: 1, drill: 1, vibe: 1 };
const ps = { flat: 24, folders: 24, drill: 24, vibe: 24 };
let pagerView = 'flat'; // #pager 当前控制哪个视图
let selectMode = false;      // 是否处于选择模式

/* ============ 工具 ============ */
const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}
function copyText(text) {
  if (!text) { toast('内容为空'); return; }
  navigator.clipboard.writeText(text).then(() => toast('已复制 ✓')).catch(() => toast('复制失败，请手动复制'));
}
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ============ PNG 元数据解析 ============ */
async function inflateRaw(bytes) {
  try {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(bytes).body.pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new TextDecoder('latin1').decode(ab);
  } catch (e) { return ''; }
}
async function readPNGTextChunks(arrayBuffer) {
  const data = new DataView(arrayBuffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (data.getUint8(i) !== sig[i]) return null;
  let offset = 8;
  const results = {};
  while (offset + 8 <= data.byteLength) {
    const length = data.getUint32(offset); offset += 4;
    const type = String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
    const start = offset + 4;
    const end = start + length;
    if (type === 'tEXt') {
      let sep = start; while (data.getUint8(sep) !== 0 && sep < end) sep++;
      const keyword = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer, start, sep - start));
      const text = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer, sep + 1, end - (sep + 1)));
      results[keyword] = text;
    } else if (type === 'iTXt') {
      let p = start, sep = p; while (data.getUint8(sep) !== 0 && sep < end) sep++;
      const keyword = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer, p, sep - p)); p = sep + 1;
      const compression = data.getUint8(p); p += 2;
      let lsep = p; while (data.getUint8(lsep) !== 0 && lsep < end) lsep++;
      let tsep = p; while (data.getUint8(tsep) !== 0 && tsep < end) tsep++;
      let text;
      if (compression === 0) text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer, tsep + 1, end - (tsep + 1)));
      else text = await inflateRaw(new Uint8Array(arrayBuffer, tsep + 1, end - (tsep + 1)));
      results[keyword] = text;
    } else if (type === 'zTXt') {
      let sep = start; while (data.getUint8(sep) !== 0 && sep < end) sep++;
      const keyword = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer, start, sep - start));
      const compression = data.getUint8(sep + 1);
      const comp = new Uint8Array(arrayBuffer, sep + 2, end - (sep + 2));
      const text = compression === 0 ? new TextDecoder('latin1').decode(comp) : await inflateRaw(comp);
      results[keyword] = text;
    }
    if (type === 'IEND') break;
    offset = end + 4;
  }
  return results;
}
function grab(text, key) {
  const m = text.match(new RegExp('\\b' + key + '\\s*:\\s*([^,\\n]+(?:\\([^)]*\\)[^,\\n]*)*)', 'i'));
  return m ? m[1].trim() : '';
}
function splitBodyAndParams(text, paramRe) {
  const lines = String(text).split(/\r?\n/);
  const bodyLines = [];
  let paramStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (paramRe.test(lines[i].trim())) { paramStart = i; break; }
    bodyLines.push(lines[i]);
  }
  return {
    body: bodyLines.join('\n').trim(),
    paramsText: paramStart !== -1 ? lines.slice(paramStart).join('\n') : '',
  };
}
function parseNovelAIMetadata(raw) {
  const res = { positive: '', negative: '', params: {} };
  if (!raw) return res;
  const t = String(raw);
  // 参数行：Steps / Sampler / CFG scale / Seed / Size / Model ...（行首，大小写不敏感）
  const paramRe = /^(Steps|Sampler|CFG scale|CFG Scale|Seed|Size|Model hash|Model|VAE|Denoise|Clip skip|ENSD|Version|Schedule type|Schedule|Resources|Loras?|Width|Height|Prompt|uc)\b\s*:/i;

  const posM = t.match(/positive\s*prompt\s*:/i);   // "positive prompt:"
  const negM = t.match(/negative\s*prompt\s*:/i);   // "negative prompt:"（也覆盖 A1111 的 "Negative prompt:"）

  // 情况 A：同时存在 positive prompt: 与 negative prompt:（两段都用标记分隔）
  if (posM && negM && posM.index < negM.index) {
    res.positive = t.slice(posM.index + posM[0].length, negM.index).trim();
    const tail = splitBodyAndParams(t.slice(negM.index + negM[0].length).trim(), paramRe);
    res.negative = tail.body;
    if (tail.paramsText) res.params = parseParams(tail.paramsText);
    return res;
  }
  // 情况 B：只有 negative prompt:（A1111 风格，正面在前面整段）
  if (negM) {
    res.positive = t.slice(0, negM.index).trim();
    const tail = splitBodyAndParams(t.slice(negM.index + negM[0].length).trim(), paramRe);
    res.negative = tail.body;
    if (tail.paramsText) res.params = parseParams(tail.paramsText);
    return res;
  }
  // 情况 C：没有明确负面标记 —— 整段当正面（仍尝试提取参数行）
  const tail = splitBodyAndParams(t, paramRe);
  res.positive = tail.body;
  if (tail.paramsText) res.params = parseParams(tail.paramsText);
  return res;
}
// 图片 Comment 块可能是 NAI 生成请求 JSON（V4 把 {prompt,uc,v4_prompt,...} 塞进 PNG），
// 也可能是纯文本提示词（含 positive/negative prompt 标记）。统一入口：
function parseMetadataText(text) {
  if (!text) return { positive: '', negative: '', params: {} };
  const t = String(text).trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const obj = JSON.parse(t);
      const r = parseNAIRequest(obj);
      if (r) return r;
    } catch (e) { /* 不是合法 JSON，继续走纯文本解析 */ }
  }
  return parseNovelAIMetadata(text);
}
function parseParams(paramText) {
  return {
    steps: grab(paramText, 'Steps'),
    sampler: grab(paramText, 'Sampler'),
    cfg: grab(paramText, 'CFG scale'),
    seed: grab(paramText, 'Seed'),
    size: grab(paramText, 'Size'),
    model: grab(paramText, 'Model') || grab(paramText, 'Model hash'),
  };
}
async function extractMetadata(file) {
  try {
    const buf = await file.arrayBuffer();
    const chunks = await readPNGTextChunks(buf);
    if (!chunks) return null;
    let text = null;
    for (const k of ['Comment', 'parameters', 'prompt', 'description', 'comment']) {
      if (chunks[k]) { text = chunks[k]; break; }
    }
    if (!text) {
      for (const v of Object.values(chunks)) {
        if (v && /negative\s*prompt/i.test(v)) { text = v; break; }
      }
    }
    if (!text) return null;
    return parseMetadataText(text);
  } catch (e) { return null; }
}
function detectArtist(pos) {
  if (!pos) return '';
  // NAI 风格权重语法：artist haoriday:: / 2::artist shule_de_yu::
  const m1 = pos.match(/artist\s+([a-z0-9_][a-z0-9_ .\-]{1,40}?)\s*(?:::|,|\n|$)/i);
  if (m1) return m1[1].trim();
  // 通用语法：by artistname
  const m2 = pos.match(/\bby\s+([a-z0-9_][a-z0-9_ .\-]{2,40}?)(?:,|\n|$)/i);
  return m2 ? m2[1].trim() : '';
}

// 拆分画师串 / 正面提示词
// 画师串 = ① weight::内容:: 加权条目（含 artist、也含 masterpiece 这类纯加权）
//          ② year2025 / year 2025 这类元数据
// 正面提示词 = 剩下的纯描述性标签（1boy, black hair, 25yo, portrait ...）
// 【格式保真】原数据长什么样就抽成什么样，不 trim、不改空格/逗号风格
function splitArtistChain(positive) {
  const out = { rest: positive || '', chain: '' };
  if (!positive) return out;
  // 条目本体 + 其后紧跟的分隔符（原样保留 "::, " / "::," 等差异）
  // 权重必须至少 1 位数字（否则孤立的 "::" 会被当成条目开头，抽出 "::,0.3::" 之类乱码）
  // 内容允许出现「单冒号」（如 1.5::artist: yalmyu::），但不能是 "::"
  const re = /((?:-?\d+(?:\.\d+)?\s*::\s*(?:[^:\n]|\:(?!\:))+?::)|\byear\s*\d+)(\s*,\s*)?/gi;
  const spans = [];
  let m;
  while ((m = re.exec(positive)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  if (!spans.length) return out;

  // 画师串：各片段原样拼接，只去掉末尾多余的分隔符
  out.chain = spans.map(s => s.text).join('').replace(/[,\s]+$/, '').trim();

  // 提示词：用原文索引一次性剔除（不能边删边用旧索引，否则会错位吞掉相邻内容）
  let rest = '', cursor = 0;
  for (const s of spans) { rest += positive.slice(cursor, s.start); cursor = s.end; }
  rest += positive.slice(cursor);

  out.rest = rest
    .replace(/^[,\s]+/, '')
    .replace(/[,\s]+$/, '')
    .replace(/,\s*,+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}
// 标签：优先用新的 tags 数组；兼容旧数据的 vibe 单标签（自动迁移显示为标签）
function getTags(a) {
  if (Array.isArray(a.tags) && a.tags.length) return a.tags.map(t => String(t).trim()).filter(Boolean);
  if (a.vibe) return [String(a.vibe).trim()].filter(Boolean);
  return [];
}
// 把输入框里的 "现代, 赛博朋克" / "现代 赛博朋克" 解析成标签数组
function parseTagsInput(str) {
  return String(str || '')
    .split(/[,，、\s]+/)
    .map(t => t.trim())
    .filter(Boolean);
}
// Vibe 的标签读取（与画作的 getTags 平行）
function getVibeTags(v) {
  if (Array.isArray(v.tags) && v.tags.length) return v.tags.map(t => String(t).trim()).filter(Boolean);
  return [];
}

/* ============ 通用辅助 ============ */
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
function downscaleDataUrl(dataUrl, maxDim = 720, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}
async function metaFromArrayBuffer(buf) {
  const chunks = await readPNGTextChunks(buf);
  if (!chunks) return null;
  let text = null;
  for (const k of ['Comment', 'parameters', 'prompt', 'description', 'comment']) if (chunks[k]) { text = chunks[k]; break; }
  if (!text) for (const v of Object.values(chunks)) if (v && /negative\s*prompt/i.test(v)) { text = v; break; }
  if (!text) return null;
  return parseMetadataText(text);
}
function mimeOf(p) {
  const e = p.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' })[e] || 'image/png';
}
function batchOf(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}
function normVibe(v) {
  return {
    id: uid(),
    kind: 'text',
    name: v.name || v.title || '未命名 Vibe',
    positive: v.positive || v.prompt || '',
    negative: v.negative || v.neg || v.negPrompt || v.negativePrompt || '',
    createdAt: Date.now(),
  };
}
function harvestVibes(obj) {
  const out = [];
  const tryArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const v of arr) {
      if (v && typeof v === 'object' && (v.name || v.title) && (v.positive || v.prompt || v.negative || v.neg || v.negPrompt || v.negativePrompt)) {
        out.push(normVibe(v));
      }
    }
  };
  if (obj && typeof obj === 'object') {
    if (obj.vibes) tryArr(Array.isArray(obj.vibes) ? obj.vibes : Object.entries(obj.vibes).map(([k, val]) => ({ ...val, name: val.name || k })));
    if (obj.presets) tryArr(obj.presets);
    if (obj.galleryVibes) tryArr(obj.galleryVibes);
  }
  if (Array.isArray(obj)) tryArr(obj);
  return out;
}

/* ============ NAI 真实 Vibe 解析 (.naiv4vib / .naiv4vibebundle) ============ */
// NAI Vibe 是「风格编码」文件，不是提示词文字。
// 单个 .naiv4vib = { identifier:"novelai-vibe-transfer", version, type, image(base64), id, encodings:{model:{hash:{encoding,params}}}, name, thumbnail(dataURL), createdAt, importInfo:{model,information_extracted,strength} }
// 打包 .naiv4vibebundle = { identifier:"novelai-vibe-transfer-bundle", version, vibes:[...] }
function parseVibeFile(text) {
  const obj = JSON.parse(text);
  if (obj && obj.identifier === 'novelai-vibe-transfer-bundle' && Array.isArray(obj.vibes)) return obj.vibes;
  if (obj && obj.identifier === 'novelai-vibe-transfer') return [obj];
  if (Array.isArray(obj)) return obj;
  return [obj]; // 尽力而为：当作单个 vibe 对象
}
function modelShort(m) {
  if (!m) return '';
  const s = String(m).toLowerCase();
  let name = s.includes('4-5') || s.includes('4.5') ? 'V4.5' : (s.includes('4') ? 'V4' : '');
  if (s.includes('full')) name += ' Full';
  else if (s.includes('curated')) name += ' Curated';
  return name.trim() || String(m).slice(0, 28);
}
function encodeVibeToItem(v, originalFilename) {
  const enc = v.encodings || {};
  const models = Object.keys(enc);
  let count = 0;
  for (const m of models) count += Object.keys(enc[m] || {}).length;
  const info = v.importInfo || {};
  // 缩略图优先用文件自带 data URL（NAI 已经带 data:image/jpeg;base64, 前缀）；否则兜底用 image 字段
  let thumbnail = '';
  if (v.thumbnail && /^data:/i.test(v.thumbnail)) thumbnail = v.thumbnail;
  else if (v.thumbnail) thumbnail = 'data:image/jpeg;base64,' + v.thumbnail;
  else if (v.image && /^data:/i.test(v.image)) thumbnail = v.image;
  else if (v.image) thumbnail = 'data:image/jpeg;base64,' + v.image;
  // 显示名：优先用户文件名（"玫瑰"），其次 v.name（NAI 默认是 ID 前缀），最后 ID 前缀
  const name = (originalFilename || '').replace(/\.(naiv4vibe|naiv4vib|naiv4vibebundle)(\.json)?$/i, '')
    || v.name
    || (v.id ? String(v.id).slice(0, 12) : '未命名 Vibe');
  // 适用模型名：importInfo.model（如 "nai-diffusion-4-5-full"）比 encodings 的简写键（如 "v4-5full"）信息更完整
  const modelLabel = info.model || models[0] || '';
  return {
    id: uid(),
    kind: 'encoding',
    name,
    originalName: v.name || '',   // 保留原始 NAI 命名
    originalFilename: originalFilename || '',
    thumbnail,
    model: modelLabel,
    modelKey: models[0] || '',    // 编码对应的简写键（v4-5full 等）
    strength: info.strength ?? '',
    informationExtracted: info.information_extracted ?? '',
    encodingCount: count,
    raw: v,                       // 原始对象，导出 .naiv4vib 时原样写回
    note: '',
    artist: '',                   // 关联画师（与画作同名，便于按画师整理 Vibe）
    tags: [],                    // 标签
    batch: '',                   // 批次
    createdAt: v.createdAt || Date.now(),
  };
}
function isEncodingVibe(v) {
  return !!(v && (v.encodings || v.identifier === 'novelai-vibe-transfer' || v.image || v.thumbnail));
}

/* ============ 图片压缩 ============ */
function downscaleImage(file, maxDim = 720, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale); h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      URL.revokeObjectURL(url);
      resolve(dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/* ============ 渲染 ============ */
const getArt = (id) => artworks.find(a => a.id === id);
const getVibe = (id) => vibes.find(v => v.id === id);

function cardHTML(a) {
  const tags = getTags(a);
  const tagChips = tags.map(t => `<span class="tag tagchip" data-filtertag="${esc(t)}"># ${esc(t)}</span>`).join('');
  const checked = selectedIds.has(a.id) ? 'checked' : '';
  return `<div class="card ${selectedIds.has(a.id) ? 'selected' : ''}" data-id="${esc(a.id)}">
    <label class="sel"><input type="checkbox" data-sel="${esc(a.id)}" ${checked}><span></span></label>
    <div class="thumb" data-open="${esc(a.id)}"><img src="${a.thumb}" alt="" loading="lazy" decoding="async"><button class="card-del-btn" data-del="${esc(a.id)}" title="删除这张画作">🗑</button></div>
    <div class="card-body">
      <div class="card-line">${a.artist ? `<span class="tag artist" data-filterartist="${esc(a.artist)}">🎨 ${esc(a.artist)}</span>` : '<span class="muted">未署名</span>'}${tagChips}<button class="note-btn ${a.note && a.note.trim() ? 'has-note' : ''}" data-opennote="${esc(a.id)}" title="${a.note && a.note.trim() ? '有备注，点击编辑' : '添加备注'}">📝</button></div>
    </div>
  </div>`;
}

// 当前筛选条件下可见的画作列表（搜索 / 画师 / 标签 / 批次）
function computeList() {
  const q = $('search').value.trim().toLowerCase();
  const af = $('artistFilter').value;   // 画师分类
  const bf = $('batchFilter').value;    // 全部批次
  const sel = tagFilterSelected;        // 标签多选集合（Set<string>）
  let list = artworks.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (af) list = list.filter(a => (a.artist || '') === af);
  if (sel.size) {
    if (tagFilterMode === 'and') {
      // 全部命中：画作要包含 sel 中每一个 tag
      list = list.filter(a => {
        const ts = new Set(getTags(a));
        for (const t of sel) if (!ts.has(t)) return false;
        return true;
      });
    } else {
      // 任一命中（默认）
      list = list.filter(a => getTags(a).some(t => sel.has(t)));
    }
  }
  if (bf) list = list.filter(a => a.batch === bf);
  if (q) {
    list = list.filter(a =>
      (a.artist || '').toLowerCase().includes(q) ||
      getTags(a).some(t => t.toLowerCase().includes(q)) ||
      (a.batch || '').toLowerCase().includes(q) ||
      (a.positive || '').toLowerCase().includes(q) ||
      (a.negative || '').toLowerCase().includes(q)
    );
  }
  return list;
}

function updateWarnBar() {
  const w = $('warnBar'); if (!w) return;
  if (artworks.length || vibes.length) w.classList.add('hidden');
  else w.classList.remove('hidden');
}

// 按指定视图的 pg[key] / ps[key] 切片，并自动 clamp 页码
function paginate(arr, key) {
  const total = arr.length;
  const sz = ps[key];
  const totalPages = sz > 0 ? Math.max(1, Math.ceil(total / sz)) : 1;
  if (pg[key] > totalPages) pg[key] = totalPages;
  if (pg[key] < 1) pg[key] = 1;
  const start = sz > 0 ? (pg[key] - 1) * sz : 0;
  const end = sz > 0 ? start + sz : total;
  return { items: arr.slice(start, end), totalPages };
}
// 渲染分页条（key: 'flat' | 'folders' | 'drill' | 'vibe'）
function renderPager(total, totalPages, key) {
  pagerView = key;
  // 同步每页数量下拉框到当前视图（用户正在改时不打断）
  const sizeSel = $('pageSize');
  if (sizeSel && document.activeElement !== sizeSel) sizeSel.value = String(ps[key]);
  const pager = $('pager');
  if (!total) { pager.classList.add('hidden'); return; }
  pager.classList.remove('hidden');
  const unit = { flat: '张', folders: '个画师', drill: '张', vibe: '个' }[key] || '';
  $('pagerInfo').textContent = `共 ${total} ${unit} · 第 ${pg[key]}/${totalPages} 页`;
  // 数字按钮（多页时折叠为 首尾 + 当前附近 + …）
  let nums = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) nums.push(i);
  } else {
    nums.push(1);
    const s = Math.max(2, pg[key] - 1), e = Math.min(totalPages - 1, pg[key] + 1);
    if (s > 2) nums.push('…');
    for (let i = s; i <= e; i++) nums.push(i);
    if (e < totalPages - 1) nums.push('…');
    nums.push(totalPages);
  }
  $('pageNums').innerHTML = nums.map(n =>
    n === '…' ? `<span class="page-ellipsis">…</span>`
      : `<button type="button" class="page-num ${n === pg[key] ? 'active' : ''}" data-page="${n}">${n}</button>`
  ).join('');
  $('pagePrev').disabled = pg[key] <= 1;
  $('pageNext').disabled = pg[key] >= totalPages;
}
// 重渲 #pager 当前绑定的视图
function renderCurrentPagerView() {
  if (pagerView === 'vibe') renderVibes();
  else renderGallery();
}
// 判断某个主视图是否正显示（避免互相覆盖 #pager）
function isViewActive(view) {
  if (view === 'vibe') return !$('vibeView').classList.contains('hidden');
  return !$('artworkView').classList.contains('hidden');
}

function renderGallery() {
  updateWarnBar();
  const g = $('gallery');
  $('countBadge').textContent = `${artworks.length} 张画作`;
  const _ac = $('artistCountLine'); if (_ac) _ac.textContent = new Set(artworks.map(a => (a.artist || '').trim()).filter(Boolean)).size;
  const _vc = $('vibeCountLine'); if (_vc) _vc.textContent = vibes.length;
  $('emptyState').style.display = artworks.length ? 'none' : 'block';

  const list = computeList();
  const total = list.length;

  // 画师合集视图：文件夹导航（先显示画师文件夹，点进去才看子图）
  if (viewMode === 'artists') {
    const groups = new Map(); // 画师名 -> [artworks]
    let uncat = [];
    for (const a of list) {
      const key = a.artist || '';
      if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(a); }
      else uncat.push(a);
    }
    // 排序：画师名 A-Z，未分类放最后
    const names = [...groups.keys()].sort((x, y) => x.localeCompare(y, 'zh'));

    // —— 已进入某个画师文件夹：显示该画师的全部子图 + 返回 ——
    if (artistDrill) {
      const items = (groups.get(artistDrill) || []).concat(artistDrill === '未分类' ? uncat : []);
      const { items: pageItems, totalPages } = paginate(items, 'drill');
      let html = `<div class="drill-head">
        <button class="btn tiny" data-artist-back>← 返回画师列表</button>
        <span class="drill-title">🎨 ${esc(artistDrill)} · ${items.length} 张</span>
      </div>`;
      html += pageItems.map(cardHTML).join('');
      g.innerHTML = html;
      if (isViewActive('artwork')) renderPager(items.length, totalPages, 'drill');
      return;
    }

    // —— 顶层：一排画师文件夹（按文件夹分页）——
    const folderNames = names.concat(uncat.length ? ['未分类'] : []);
    const { items: pageFolders, totalPages: ftp } = paginate(folderNames, 'folders');
    let html = `<div class="folder-grid">`;
    for (const name of pageFolders) {
      const arr = name === '未分类' ? uncat : groups.get(name);
      html += folderCardHTML(name, arr, name === '未分类' ? '🗂️' : undefined);
    }
    html += `</div>`;
    g.innerHTML = html;
    if (isViewActive('artwork')) renderPager(folderNames.length, ftp, 'folders');
    return;
  }

  // 画廊平铺视图（分页）
  const { items: pageItems, totalPages } = paginate(list, 'flat');
  if (!pageItems.length) {
    g.innerHTML = `<div class="no-result">${total ? '没有匹配的画作' : ''}</div>`;
    $('pager').classList.add('hidden');
    return;
  }
  g.innerHTML = pageItems.map(cardHTML).join('');
  if (isViewActive('artwork')) renderPager(total, totalPages, 'flat');
}

/* ============ 批量选择 / 批量编辑 ============ */
function updateSelectUI() {
  const bar = $('selectBar');
  const n = selectedIds.size;
  $('selCount').textContent = n ? `已选 ${n} 张` : '选择画作';
  bar.classList.toggle('hidden', !selectMode);
  $('selectBtn').classList.toggle('active', selectMode);
  $('gallery').classList.toggle('selecting', selectMode);
}
function enterSelect() {
  selectMode = true;
  selectedIds.clear();
  updateSelectUI();
  renderGallery();
  // 同步 vibe 视图选择模式（让两边模式状态一致，切换 view 不用手动再开）
  if (!vibeSelectMode) {
    vibeSelectMode = true;
    selectedVibeIds.clear();
    updateVibeSelectUI();
  }
  if (isViewActive('vibe')) renderVibes();
  toast('已进入选择模式：点卡片或勾选框即可选中');
}
function exitSelect() {
  selectMode = false;
  selectedIds.clear();
  updateSelectUI();
  renderGallery();
  // 同步 vibe 视图选择模式
  if (vibeSelectMode) {
    vibeSelectMode = false;
    selectedVibeIds.clear();
    updateVibeSelectUI();
  }
  if (isViewActive('vibe')) renderVibes();
}
function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) {
    card.classList.toggle('selected', selectedIds.has(id));
    const cb = card.querySelector('[data-sel]');
    if (cb) cb.checked = selectedIds.has(id);
  }
  updateSelectUI();
}
function selectAllVisible() {
  for (const a of computeList()) selectedIds.add(a.id);
  renderGallery();
  updateSelectUI();
}
function clearSelection() {
  selectedIds.clear();
  renderGallery();
  updateSelectUI();
}
function openBatchModal() {
  if (!selectedIds.size) { toast('请先选择画作'); return; }
  $('batchCount').textContent = `（选中 ${selectedIds.size} 张）`;
  $('bNameOn').checked = $('bArtistOn').checked = $('bBatchOn').checked = $('bTagsOn').checked = false;
  $('bName').value = $('bArtist').value = $('bBatch').value = $('bTags').value = '';
  $('bTagMode').value = 'set';
  showModal('batchModal');
  setTimeout(() => $('bName').focus(), 30);
}
async function applyBatchEdit() {
  const ids = [...selectedIds];
  if (!ids.length) { toast('没有选中的画作'); return; }
  const applyName = $('bNameOn').checked;
  const name = $('bName').value.trim();
  const applyArtist = $('bArtistOn').checked;
  const artist = $('bArtist').value.trim();
  const applyBatch = $('bBatchOn').checked;
  const batch = $('bBatch').value.trim();
  const applyTags = $('bTagsOn').checked;
  const tagMode = $('bTagMode').value; // 'set' 覆盖 | 'add' 追加
  const tags = parseTagsInput($('bTags').value);
  let n = 0;
  for (const id of ids) {
    const a = getArt(id);
    if (!a) continue;
    if (applyName) a.title = name;
    if (applyArtist) a.artist = artist;
    if (applyBatch) a.batch = batch;
    if (applyTags) {
      if (tagMode === 'add') {
        const cur = getTags(a);
        for (const t of tags) if (!cur.includes(t)) cur.push(t);
        a.tags = cur; a.vibe = '';
      } else {
        a.tags = tags; a.vibe = '';
      }
    }
    await addArtwork(a); // 按 id 覆盖
    n++;
  }
  closeModals();
  refreshFilters();
  renderGallery();
  updateSelectUI();
  toast(`已更新 ${n} 张画作 ✓`);
}
async function batchDelete() {
  const ids = [...selectedIds];
  if (!ids.length) { toast('请先选择画作'); return; }
  if (!await confirmModal(`确定删除选中的 ${ids.length} 张画作？此操作不可恢复。`, true)) return;
  for (const id of ids) await delArtDB(id);
  artworks = artworks.filter(a => !selectedIds.has(a.id));
  const k = ids.length;
  exitSelect();
  toast(`已删除 ${k} 张画作`);
}

/* ============ Vibe 批量选择 / 批量编辑 ============ */
let selectedVibeIds = new Set();
let vibeSelectMode = false;
function updateVibeSelectUI() {
  const bar = $('vibeSelectBar');
  if (!bar) return;
  const n = selectedVibeIds.size;
  $('vibeSelCount').textContent = n ? `已选 ${n} 个` : '选择 Vibe';
  bar.classList.toggle('hidden', !vibeSelectMode);
  $('vibeSelectBtn').classList.toggle('active', vibeSelectMode);
  $('vibeGrid').classList.toggle('selecting', vibeSelectMode);
}
function enterVibeSelect() {
  vibeSelectMode = true;
  selectedVibeIds.clear();
  updateVibeSelectUI();
  renderVibes();
  // 同步画作视图选择模式
  if (!selectMode) {
    selectMode = true;
    selectedIds.clear();
    updateSelectUI();
  }
  if (isViewActive('artwork')) renderGallery();
  toast('已进入选择模式：点卡片或勾选框即可选中 Vibe');
}
function exitVibeSelect() {
  vibeSelectMode = false;
  selectedVibeIds.clear();
  updateVibeSelectUI();
  renderVibes();
  // 同步画作视图选择模式
  if (selectMode) {
    selectMode = false;
    selectedIds.clear();
    updateSelectUI();
  }
  if (isViewActive('artwork')) renderGallery();
}
function toggleVibeSelect(id) {
  if (selectedVibeIds.has(id)) selectedVibeIds.delete(id);
  else selectedVibeIds.add(id);
  const card = document.querySelector(`.card[data-vibeid="${CSS.escape(id)}"]`);
  if (card) {
    card.classList.toggle('selected', selectedVibeIds.has(id));
    const cb = card.querySelector('[data-vsel]');
    if (cb) cb.checked = selectedVibeIds.has(id);
  }
  updateVibeSelectUI();
}
// 当前筛选项 + 分页后的本页可见 Vibe（与 renderVibes 一致）
function computeVibePageItems() {
  const q = vibeFilter.trim().toLowerCase();
  const filtered = q
    ? vibes.filter(v => [v.name, v.model, v.modelKey, v.originalName].filter(Boolean).join(' ').toLowerCase().includes(q))
    : vibes;
  const sorted = filtered.slice().sort((a, b) => b.createdAt - a.createdAt);
  return paginate(sorted, 'vibe').items;
}
function vibeSelectAllVisible() {
  for (const v of computeVibePageItems()) selectedVibeIds.add(v.id);
  renderVibes();
  updateVibeSelectUI();
}
function clearVibeSelection() {
  selectedVibeIds.clear();
  renderVibes();
  updateVibeSelectUI();
}
function openVibeBatchModal() {
  if (!selectedVibeIds.size) { toast('请先选择 Vibe'); return; }
  $('vibeBatchCount').textContent = `（选中 ${selectedVibeIds.size} 个）`;
  $('vbArtistOn').checked = $('vbNameOn').checked = $('vbBatchOn').checked = $('vbTagsOn').checked = false;
  $('vbArtist').value = $('vbName').value = $('vbBatch').value = $('vbTags').value = '';
  $('vbTagMode').value = 'set';
  const box = $('qfArtistsVibeBatch');
  if (box) {
    const artists = [...new Set(artworks.map(a => a.artist).filter(Boolean))];
    box.innerHTML = artists.length
      ? artists.map(n => `<button type="button" class="qf-chip" data-qvartistb="${esc(n)}">${esc(n)}</button>`).join('')
      : '<span class="muted" style="font-size:12px">暂无画作画师</span>';
  }
  showModal('vibeBatchModal');
  setTimeout(() => $('vbArtist').focus(), 30);
}
async function applyVibeBatchEdit() {
  const ids = [...selectedVibeIds];
  if (!ids.length) { toast('没有选中的 Vibe'); return; }
  const applyArtist = $('vbArtistOn').checked;
  const artist = $('vbArtist').value.trim();
  const applyName = $('vbNameOn').checked;
  const name = $('vbName').value.trim();
  const applyBatch = $('vbBatchOn').checked;
  const batch = $('vbBatch').value.trim();
  const applyTags = $('vbTagsOn').checked;
  const tagMode = $('vbTagMode').value; // 'set' 覆盖 | 'add' 追加
  const tags = parseTagsInput($('vbTags').value);
  let n = 0;
  for (const id of ids) {
    const v = getVibe(id);
    if (!v) continue;
    if (applyArtist) v.artist = artist;
    if (applyName) v.name = name;
    if (applyBatch) v.batch = batch;
    if (applyTags) {
      if (tagMode === 'add') {
        const cur = getVibeTags(v);
        for (const t of tags) if (!cur.includes(t)) cur.push(t);
        v.tags = cur;
      } else {
        v.tags = tags;
      }
      // 改名同步回原始对象（导出 .naiv4vib 时也用新名）
      if (v.raw && typeof v.raw === 'object' && applyName) v.raw.name = name;
    }
    await updateVibeDB(v);
    n++;
  }
  closeModals();
  exitVibeSelect();
  renderVibes();
  toast(`已更新 ${n} 个 Vibe ✓`);
}
async function vibeBatchDelete() {
  const ids = [...selectedVibeIds];
  if (!ids.length) { toast('请先选择 Vibe'); return; }
  if (!await confirmModal(`确定删除选中的 ${ids.length} 个 Vibe？此操作不可恢复。`, true)) return;
  for (const id of ids) await delVibeDB(id);
  vibes = vibes.filter(v => !selectedVibeIds.has(v.id));
  const k = ids.length;
  exitVibeSelect();
  toast(`已删除 ${k} 个 Vibe`);
}

/* ============ 手机扫码打开 ============ */
let qrLibLoading = null;
function ensureQR() {
  if (typeof QRCode !== 'undefined') return Promise.resolve();
  if (qrLibLoading) return qrLibLoading;
  qrLibLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = () => res();
    s.onerror = () => rej(new Error('qr-load-failed'));
    document.head.appendChild(s);
  });
  return qrLibLoading;
}
async function renderPhoneQR() {
  const host = location.hostname;
  const ipInput = $('phoneIP');
  if (!ipInput.value.trim() && host !== '127.0.0.1' && host !== 'localhost') ipInput.value = host;
  const ip = (ipInput.value.trim() || host);
  const url = `http://${ip}:8137/index.html`;
  $('phoneURL').textContent = url;
  const box = $('phoneQR');
  box.innerHTML = '';
  try {
    await ensureQR();
    new QRCode(box, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  } catch (e) {
    box.innerHTML = '<p class="muted" style="font-size:12px">二维码加载失败（可能离线），请直接复制上方网址到手机浏览器。</p>';
  }
}

function folderCardHTML(name, items, emoji) {
  const cover = (items[0] && items[0].thumb) || PLACEHOLDER_THUMB;
  const m = (artistMeta && artistMeta[name]) || {};
  const hasNote = m.note && String(m.note).trim();
  const hasLink = m.link && String(m.link).trim();
  return `<div class="folder-card" data-open-folder="${esc(name)}" title="打开 ${esc(name)} 的画师合集">
    <div class="folder-cover"><img src="${esc(cover)}" alt="" loading="lazy" onerror="this.src='${PLACEHOLDER_THUMB}'"></div>
    <div class="folder-meta">
      <span class="folder-emoji">${emoji || '🎨'}</span>
      <span class="folder-name">${esc(name)}</span>
      <span class="folder-count">${items.length} 张</span>
      <span class="folder-tools">
        <button class="folder-tool ${hasNote ? 'has-note' : ''}" data-edit-artist="${esc(name)}" title="${hasNote ? '有备注，点击编辑' : '添加备注'}">📝</button>
        ${hasLink ? `<a class="folder-tool folder-link" href="${esc(m.link)}" target="_blank" rel="noopener" data-stop-drill title="跳转链接">↗</a>` : ''}
      </span>
    </div>
  </div>`;
}

function refreshArtistFilter() {
  const sel = $('artistFilter');
  const cur = sel.value;
  const vals = [...new Set(artworks.map(a => a.artist).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'zh'));
  sel.innerHTML = '<option value="">画师分类</option>' + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (vals.includes(cur)) sel.value = cur;
}
// 多选标签筛选：刷新 popover 里的 checkbox 列表 + 同步按钮文本
function refreshTagFilter() {
  const list = $('tagFilterList');
  const btn = $('tagFilterBtn');
  if (!list) return;
  const all = new Set();
  for (const a of artworks) for (const t of getTags(a)) all.add(t);
  const vals = [...all].sort((x, y) => x.localeCompare(y, 'zh'));
  // 自动清理已选但实际不存在的 tag（比如作品被删之后）
  tagFilterSelected = new Set([...tagFilterSelected].filter(t => all.has(t)));
  const q = (tagFilterSearch || '').trim().toLowerCase();
  const visible = q ? vals.filter(v => v.toLowerCase().includes(q)) : vals;
  if (!visible.length) {
    list.innerHTML = '<div class="tag-filter-empty">没有匹配的标签</div>';
  } else {
    // 列表过长时加最大高度 + 滚动，避免撑爆筛选行
    list.innerHTML = visible.map(v => {
      const checked = tagFilterSelected.has(v);
      return `<label class="tag-filter-item${checked ? ' checked' : ''}">` +
        `<input type="checkbox" data-tag="${esc(v)}"${checked ? ' checked' : ''}>` +
        `<span class="tag-filter-name"># ${esc(v)}</span>` +
        `</label>`;
    }).join('');
  }
  // 按钮文本：未选 / 选 1 个 / 选多个
  const lab = $('tagFilterBtnLabel');
  if (lab) {
    const n = tagFilterSelected.size;
    if (n === 0) lab.textContent = '标签';
    else if (n === 1) lab.textContent = `标签 # ${[...tagFilterSelected][0]}`;
    else lab.textContent = `标签 # ${n}`;
  }
  if (btn) btn.classList.toggle('has-sel', tagFilterSelected.size > 0);
}
function refreshBatchFilter() {
  const sel = $('batchFilter');
  const cur = sel.value;
  const vals = [...new Set(artworks.map(a => a.batch).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'zh'));
  sel.innerHTML = '<option value="">全部批次</option>' + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (vals.includes(cur)) sel.value = cur;
}
function refreshFilters() { refreshArtistFilter(); refreshTagFilter(); refreshBatchFilter(); }

// 标签多选 popover：仅刷按钮文本（保留列表滚动位置）
function refreshTagFilterBtnOnly() {
  const lab = $('tagFilterBtnLabel');
  const btn = $('tagFilterBtn');
  if (lab) {
    const n = tagFilterSelected.size;
    if (n === 0) lab.textContent = '标签';
    else if (n === 1) lab.textContent = `标签 # ${[...tagFilterSelected][0]}`;
    else lab.textContent = `标签 # ${n}`;
  }
  if (btn) btn.classList.toggle('has-sel', tagFilterSelected.size > 0);
}

// 标签多选 popover 控制函数（由 wireEvents 内 wireTagFilter() 触发）
function openTagPop() {
  const btn = $('tagFilterBtn'), pop = $('tagFilterPop');
  if (!btn || !pop) return;
  pop.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  tagFilterPopOpen = true;
  // 打开时聚焦搜索框（便于直接键入过滤）
  setTimeout(() => { const s = $('tagFilterSearch'); if (s) { s.focus(); s.select(); } }, 0);
}
function closeTagPop() {
  const btn = $('tagFilterBtn'), pop = $('tagFilterPop');
  if (!btn || !pop) return;
  pop.classList.add('hidden');
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  tagFilterPopOpen = false;
}

// 绑定标签多选 popover 全套交互（点按钮展开 / 复选即筛 / 搜索过滤 / 全选清空 / 点外面关闭）
function wireTagFilter() {
  const tagBtn = $('tagFilterBtn');
  const tagPop = $('tagFilterPop');
  const tagList = $('tagFilterList');
  if (!tagBtn || !tagPop || !tagList) return;

  // 1) 按钮点击：toggle 展开
  tagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tagFilterPopOpen) closeTagPop(); else openTagPop();
  });
  // 阻止 popover 内点击冒泡触发「点外面关闭」
  tagPop.addEventListener('click', (e) => e.stopPropagation());

  // 2) popover 内的勾选 / 模式切换（事件委托）
  tagPop.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[type=checkbox][data-tag]')) {
      const tg = t.dataset.tag;
      if (t.checked) tagFilterSelected.add(tg); else tagFilterSelected.delete(tg);
      // 同步行的视觉态
      const row = t.closest('.tag-filter-item');
      if (row) row.classList.toggle('checked', t.checked);
      // 只刷按钮文本 + 画廊，不重渲列表（保留滚动位置）
      refreshTagFilterBtnOnly();
      pg.flat = 1;
      renderGallery();
    } else if (t.name === 'tagMode') {
      tagFilterMode = t.value;
      if (tagFilterSelected.size) { pg.flat = 1; renderGallery(); }
    }
  });

  // 3) 搜索框：输入即过滤列表显示（不影响已选项）
  $('tagFilterSearch')?.addEventListener('input', (e) => {
    tagFilterSearch = e.target.value || '';
    refreshTagFilter();
  });

  // 4) 全选：勾选当前可见项
  $('tagFilterAll')?.addEventListener('click', (e) => {
    e.stopPropagation();
    tagList.querySelectorAll('input[type=checkbox][data-tag]').forEach(i => {
      tagFilterSelected.add(i.dataset.tag);
      i.checked = true;
      i.closest('.tag-filter-item')?.classList.add('checked');
    });
    refreshTagFilterBtnOnly();
    pg.flat = 1; renderGallery();
  });

  // 5) 清空：取消所有可见项（其实 tagFilterSelected 里的隐藏项也清，避免「看不见还选中」困惑）
  $('tagFilterNone')?.addEventListener('click', (e) => {
    e.stopPropagation();
    tagList.querySelectorAll('input[type=checkbox][data-tag]').forEach(i => {
      tagFilterSelected.delete(i.dataset.tag);
      i.checked = false;
      i.closest('.tag-filter-item')?.classList.remove('checked');
    });
    refreshTagFilterBtnOnly();
    pg.flat = 1; renderGallery();
  });

  // 6) 点页面其他位置自动收起 popover
  document.addEventListener('click', (e) => {
    if (!tagFilterPopOpen) return;
    if (tagPop.contains(e.target)) return;
    if (tagBtn.contains(e.target)) return;
    closeTagPop();
  });
  // 7) 滚动 / 窗口大小变化时自动收起（避免 popover 飘到错位）
  window.addEventListener('scroll', () => { if (tagFilterPopOpen) closeTagPop(); }, true);
  window.addEventListener('resize', () => { if (tagFilterPopOpen) closeTagPop(); });
}

let vibeFilter = '';
// 标签多选筛选状态：选中的 tag 集合 + 命中模式 + 搜索关键词
let tagFilterSelected = new Set();     // Set<string>
let tagFilterMode = 'or';               // 'or' = 任一命中（默认），'and' = 全部命中
let tagFilterSearch = '';               // popover 内搜索关键词（过滤列表显示用，不影响筛选结果）
let tagFilterPopOpen = false;           // popover 是否展开
function renderVibes() {
  updateWarnBar();
  const grid = $('vibeGrid');
  const empty = $('vibeEmpty');
  const cnt = $('vibeCount');
  if (cnt) cnt.textContent = vibes.length;
  if (!vibes.length) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    $('pager').classList.add('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  const q = vibeFilter.trim().toLowerCase();
  const filtered = q
    ? vibes.filter(v => {
        const hay = [v.name, v.model, v.modelKey, v.originalName].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
    : vibes;
  const sorted = filtered.slice().sort((a, b) => b.createdAt - a.createdAt);
  const { items: pageItems, totalPages } = paginate(sorted, 'vibe');
  grid.innerHTML = pageItems.map(v => {
    const isEnc = v.kind === 'encoding';
    const emoji = isEnc ? '🖼️' : '💡';
    const thumb = v.thumbnail
      ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;thumb-empty&quot;>${emoji}</div>'">`
      : `<div class="thumb-empty">${emoji}</div>`;
    const name = v.name || '未命名 Vibe';
    const checked = selectedVibeIds.has(v.id) ? 'checked' : '';
    const vtags = getVibeTags(v).map(t => `<span class="tag tagchip" data-filtertag="${esc(t)}"># ${esc(t)}</span>`).join('');
    const artistTag = v.artist ? `<span class="tag artist" data-filterartist="${esc(v.artist)}">🎨 ${esc(v.artist)}</span>` : '';
    const selLabel = vibeSelectMode
      ? `<label class="sel"><input type="checkbox" data-vsel="${esc(v.id)}" ${checked}><span></span></label>`
      : '';
    return `<div class="card ${selectedVibeIds.has(v.id) ? 'selected' : ''}" data-vibeid="${esc(v.id)}" title="${esc(name)}">
      ${selLabel}
      <div class="thumb" data-openvibe="${esc(v.id)}"><button class="card-del-btn vibe-del-btn" data-delvibe="${esc(v.id)}" title="删除这个 Vibe">🗑</button>${thumb}</div>
      <div class="card-body"><div class="card-line">${artistTag}${vtags}</div></div>
    </div>`;
  }).join('');
  if (isViewActive('vibe')) renderPager(sorted.length, totalPages, 'vibe');
}

/* ============ Vibe 主视图切换（画廊 vs Vibe 库） ============ */
function showVibeView() {
  $('artworkView').classList.add('hidden');
  $('vibeView').classList.remove('hidden');
  $('artBtn').classList.remove('active');
  $('vibeBtn').classList.add('active');
  renderVibes();
}
function showArtworkView() {
  $('vibeView').classList.add('hidden');
  $('artworkView').classList.remove('hidden');
  $('vibeBtn').classList.remove('active');
  $('artBtn').classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============ Vibe 详情弹窗（点 Vibe 卡片打开） ============ */
let vdCurrentId = null;
function openVibeDetail(id) {
  const v = getVibe(id); if (!v) return;
  vdCurrentId = id;
  const isEnc = v.kind === 'encoding';
  $('vdName').textContent = '💡 ' + (v.name || '未命名 Vibe');
  const img = $('vdImg');
  const imgwrap = img.closest('.vd-imgwrap');
  if (v.thumbnail) { img.src = v.thumbnail; img.style.display = ''; imgwrap.classList.remove('no-img'); }
  else { img.removeAttribute('src'); img.style.display = 'none'; imgwrap.classList.add('no-img'); }
  const fmtNum = (x) => (typeof x === 'number') ? x.toString() : (x == null ? '' : String(x));
  const chips = [];
  if (isEnc) {
    if (v.model) chips.push(`<span class="chip">🧩 ${esc(modelShort(v.model))}</span>`);
    if (v.modelKey && v.modelKey !== v.model) chips.push(`<span class="chip muted">编码键 ${esc(v.modelKey)}</span>`);
    if (v.strength !== '' && v.strength != null) chips.push(`<span class="chip">强度 ${esc(fmtNum(v.strength))}</span>`);
    if (v.informationExtracted !== '' && v.informationExtracted != null) chips.push(`<span class="chip">信息提取 ${esc(fmtNum(v.informationExtracted))}</span>`);
    if (v.encodingCount) chips.push(`<span class="chip">编码 ${esc(fmtNum(v.encodingCount))}</span>`);
  } else {
    chips.push(`<span class="chip muted">💡 文本备注</span>`);
  }
  if (v.createdAt) chips.push(`<span class="chip muted">${new Date(v.createdAt).toLocaleDateString()}</span>`);
  $('vdChips').innerHTML = chips.join('') || '<span class="muted" style="font-size:12px">—</span>';
  const rows = [];
  if (isEnc && v.originalName && v.originalName !== v.name) {
    rows.push(`<div class="vd-row"><span class="vd-key">原 NAI 名</span><span class="vd-val">${esc(v.originalName)}</span></div>`);
  }
  $('vdRows').innerHTML = rows.join('');
  const posBlock = $('vdPromptPosBlock'), negBlock = $('vdPromptNegBlock');
  if (!isEnc) {
    posBlock.classList.remove('hidden');
    negBlock.classList.toggle('hidden', !v.negative);
    $('vdPos').value = v.positive || '';
    $('vdNeg').value = v.negative || '';
  } else {
    posBlock.classList.add('hidden');
    negBlock.classList.add('hidden');
  }
  $('vdDownload').classList.toggle('hidden', !isEnc);
  renderVdNote(v);
  renderVdLink(v);
  renderVdArtist(v);
  showModal('vibeDetail');
}

/* ============ Vibe 备注 & 链接 ============ */
function renderVdNote(v) {
  const view = $('vdNoteView');
  const edit = $('vdNoteEdit');
  if (!view || !edit) return;
  const txt = (v && v.note) ? String(v.note).trim() : '';
  view.textContent = txt || '（点击右侧 ✎ 添加备注）';
  view.classList.toggle('empty', !txt);
  edit.classList.add('hidden');
  $('vdNoteInput').value = v ? (v.note || '') : '';
}
async function saveVibeNote() {
  if (!vdCurrentId) return;
  const v = getVibe(vdCurrentId); if (!v) return;
  v.note = $('vdNoteInput').value;
  try { await updateVibeDB(v); renderVdNote(v); toast('备注已保存 ✓'); }
  catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
}
function renderVdLink(v) {
  const view = $('vdLinkView');
  const edit = $('vdLinkEdit');
  const open = $('vdLinkOpen');
  if (!view || !edit || !open) return;
  const url = v && v.link ? String(v.link).trim() : '';
  if (url) { open.href = url; open.classList.remove('hidden'); view.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`; }
  else { open.classList.add('hidden'); open.removeAttribute('href'); view.textContent = '（无链接，点 ✎ 添加）'; view.classList.add('empty'); }
  edit.classList.add('hidden');
  $('vdLinkInput').value = v ? (v.link || '') : '';
}
async function saveVibeLink() {
  if (!vdCurrentId) return;
  const v = getVibe(vdCurrentId); if (!v) return;
  const url = $('vdLinkInput').value.trim();
  if (url && !/^https?:\/\//i.test(url)) { toast('链接必须以 http:// 或 https:// 开头'); return; }
  v.link = url;
  try { await updateVibeDB(v); renderVdLink(v); toast(url ? '链接已保存 ✓' : '已清空链接'); }
  catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
}
function renderVdArtist(v) {
  const view = $('vdArtistView');
  const edit = $('vdArtistEdit');
  if (!view || !edit) return;
  const artist = v && v.artist ? String(v.artist).trim() : '';
  if (artist) {
    view.innerHTML = `<span class="tag artist">🎨 ${esc(artist)}</span>`;
    view.classList.remove('empty');
  } else {
    view.textContent = '（未关联画师，点 ✎ 添加）';
    view.classList.add('empty');
  }
  edit.classList.add('hidden');
  $('vdArtistQf').style.display = 'none';
  $('vdArtistInput').value = v ? (v.artist || '') : '';
  // 填已有画师 chips（从画作列表去重）
  const box = $('qfArtistsVibe');
  if (box) {
    const artists = [...new Set(artworks.map(a => a.artist).filter(Boolean))];
    box.innerHTML = artists.length
      ? artists.map(n => `<button type="button" class="qf-chip" data-qvartist="${esc(n)}">${esc(n)}</button>`).join('')
      : '<span class="muted" style="font-size:12px">暂无画作画师</span>';
  }
}
async function saveVibeArtist() {
  if (!vdCurrentId) return;
  const v = getVibe(vdCurrentId); if (!v) return;
  const artist = $('vdArtistInput').value.trim();
  v.artist = artist;
  try { await updateVibeDB(v); renderVdArtist(v); renderVibes(); toast(artist ? '画师已保存 ✓' : '已清空画师'); }
  catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
}

/* ============ 画师合集卡片备注 & 链接（folder-card 上的 📝 / ↗） ============ */
let amCurrentName = null;
function openArtistMetaModal(name) {
  amCurrentName = name;
  if (!artistMeta[name]) artistMeta[name] = { note: '', link: '' };
  const m = artistMeta[name];
  $('amName').textContent = name;
  $('amNoteInput').value = m.note || '';
  $('amLinkInput').value = m.link || '';
  showModal('artistMetaModal');
}
async function saveArtistMetaField(field) {
  if (!amCurrentName) return;
  const m = artistMeta[amCurrentName] || (artistMeta[amCurrentName] = { note: '', link: '' });
  let val = (field === 'note') ? $('amNoteInput').value : $('amLinkInput').value.trim();
  if (field === 'link' && val && !/^https?:\/\//i.test(val)) { toast('链接必须以 http(s):// 开头'); return; }
  m[field] = val;
  try {
    await saveToAPI();
    renderGallery();
    toast(field === 'note' ? '备注已保存 ✓' : (val ? '链接已保存 ✓' : '已清空链接'));
    $('artistMetaModal').classList.add('hidden');  // 保存后关闭弹窗
  }
  catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
}

/* ============ Vibe 预览图（手动配图，编码无图时可用） ============ */
let pendingThumbVibeId = null;
let pendingPastedThumb = null;   // 剪贴板粘贴进来的图片 File
function openVibeThumbModal(id) {
  const v = getVibe(id); if (!v) return;
  pendingThumbVibeId = id;
  pendingPastedThumb = null;
  $('vbThumbFile').value = '';
  $('vbThumbPreview').innerHTML = v.thumbnail
    ? `<img src="${esc(v.thumbnail)}" style="max-width:200px;max-height:160px;border-radius:10px;border:1px solid var(--line)">`
    : '';
  $('vbThumbRemove').style.display = v.thumbnail ? '' : 'none';
  showModal('vibeThumbModal');
}
function vibeThumbPreviewLocal(file) {
  if (!file) { $('vbThumbPreview').innerHTML = ''; return; }
  const r = new FileReader();
  r.onload = () => { $('vbThumbPreview').innerHTML = `<img src="${esc(r.result)}" style="max-width:200px;max-height:160px;border-radius:10px;border:1px solid var(--line)">`; };
  r.readAsDataURL(file);
}
async function saveVibeThumb() {
  const id = pendingThumbVibeId; if (!id) return;
  const v = getVibe(id); if (!v) return;
  const file = $('vbThumbFile').files && $('vbThumbFile').files[0];
  try {
    let dataUrl = '';
    if (pendingPastedThumb) {
      dataUrl = await downscaleImage(pendingPastedThumb, 720, 0.82);
    } else if (file) {
      dataUrl = await downscaleImage(file, 720, 0.82);
    } else {
      toast('请选择图片、拖入或 Ctrl+V 粘贴');
      return;
    }
    v.thumbnail = dataUrl;
    await updateVibeDB(v);
    renderVibes();
    // 只关缩略图弹窗，保留可能开着的 Vibe 详情
    $('vibeThumbModal').classList.add('hidden');
    if (vdCurrentId === id) {
      const img = $('vdImg');
      if (img) { img.src = dataUrl; img.style.display = ''; }
    }
    toast('预览图已更新 ✓');
  } catch (e) { toast('设置失败：' + e.message); }
}
async function removeVibeThumb() {
  const id = pendingThumbVibeId; if (!id) return;
  const v = getVibe(id); if (!v) return;
  v.thumbnail = '';
  await updateVibeDB(v);
  renderVibes();
  $('vibeThumbModal').classList.add('hidden');
  if (vdCurrentId === id) {
    const img = $('vdImg');
    if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
  }
  toast('已移除预览图');
}

/* ============ 应用内确认弹窗（替换被浏览器拦截的 confirm()） ============ */
let _confirmResolve = null;
function confirmModal(message, danger = true) {
  $('confirmMsg').textContent = message;
  $('confirmOk').classList.toggle('danger', danger);
  $('confirmOk').textContent = danger ? '删除' : '确定';
  showModal('confirmModal');
  return new Promise(resolve => { _confirmResolve = resolve; });
}
function _resolveConfirm(val) {
  if (_confirmResolve) { const r = _confirmResolve; _confirmResolve = null; r(val); }
  $('confirmModal').classList.add('hidden'); // 只关掉确认弹窗，不关底下的 Vibe/画廊弹窗
}

/* ============ 弹窗控制 ============ */
function showModal(id) { $(id).classList.remove('hidden'); }
// 关闭任意弹窗（必须"点一下就立刻关"，绝不能被等待阻塞）
// 若灯箱里正/负提示词有改动，后台自动保存（fire-and-forget，不 await，不阻塞关闭）
function closeModals() {
  const lb = document.getElementById('lightbox');
  if (lb && !lb.classList.contains('hidden') && lbCurrent) {
    const a = getArt(lbCurrent);
    if (a) {
      const pos = $('lbPos').value, neg = $('lbNeg').value, ac = $('lbArtist').value.trim();
      if ((a.positive || '') !== pos || (a.negative || '') !== neg || (a.artistChain || '') !== ac) {
        a.positive = pos; a.negative = neg; a.artistChain = ac;
        // 后台保存：成功/失败都只弹出提示，绝不影响"关弹窗"这一动作
        addArtwork(a).then(
          () => { refreshFilters(); toast('提示词已自动保存 ✓'); },
          (e) => { console.error('auto-save prompt on close failed:', e); toast('提示词保存失败：' + (e && e.message ? e.message : e)); }
        );
      }
    }
    lbCurrent = null; // 清掉残留，避免下次 closeModals 误以为灯箱还开着
  }
  // 同步隐藏所有弹窗：无论上面保存是否完成，用户点关闭就立刻关闭
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}


/* ============ 上传流程 ============ */
async function handleFiles(files) {
  const file = files && files[0];
  if (!file) return;
  pendingFileName = file.name;
  try {
    pendingThumb = await downscaleImage(file, 720, 0.82);
    pendingFull = await fileToDataUrl(file);
  } catch (e) {
    toast('图片读取失败');
    return;
  }
  $('previewImg').src = pendingThumb;
  const meta = await extractMetadata(file);
  $('fTitle').value = '';
  if (meta) {
    $('fPos').value = meta.positive || '';
    $('fNeg').value = meta.negative || '';
    $('fArtist').value = detectArtist(meta.positive) || '';
    if (meta.params && meta.params.model) toast('已解析提示词 ✓');
  } else {
    $('fPos').value = ''; $('fNeg').value = ''; $('fArtist').value = '';
    toast('未识别到 NAI 元数据，可手动填写');
  }
  $('uploadForm').classList.remove('hidden');
  $('saveArtBtn').disabled = false;
  renderQuickFillArtists();
}
async function saveArtwork() {
  if (!pendingThumb) return;
  const a = {
    id: uid(),
    thumb: pendingThumb,
    full: pendingFull,
    source: 'upload',
    file: pendingFileName || '',
    title: $('fTitle').value.trim(),
    artist: $('fArtist').value.trim(),
    tags: parseTagsInput($('fTags').value),
    vibe: '',
    positive: $('fPos').value.trim(),
    negative: $('fNeg').value.trim(),
    batch: '',
    params: {},
    createdAt: Date.now(),
  };
  await addArtwork(a);
  $('uploadForm').classList.add('hidden');
  $('saveArtBtn').disabled = true;
  pendingThumb = null;
  pendingFull = null;
  pendingFileName = '';
  closeModals();
  refreshFilters();
  renderGallery();
  toast('已保存到工作台 ✓');
}
/* ============ 给画作换图（覆盖当前图片） ============ */
// 待替换的图片文件（在换图弹窗里选好/拖好/粘好后暂存这里）
let pendingReplaceFile = null;
function openReplaceModal() {
  if (!lbCurrent) { toast('请先打开一张画作'); return; }
  pendingReplaceFile = null;
  $('replacePreview').classList.add('hidden');
  showModal('replaceModal');
}
// 把选中的文件读出来做预览（只解码一次，不降采样；真正写入时再降采样）
async function loadReplacePreview(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
  pendingReplaceFile = file;
  try {
    const url = await fileToDataUrl(file);
    $('replacePreviewImg').src = url;
    $('replaceSize').textContent = `${(file.size / 1024).toFixed(0)} KB · ${file.name}`;
    $('replacePreview').classList.remove('hidden');
  } catch (e) {
    toast('图片读取失败');
  }
}
async function replaceArtworkImage(id, full, thumb) {
  const a = getArt(id);
  if (!a) throw new Error('找不到这张画作');
  // 安全：若原图是磁盘/网络路径，记下来源，便于日后回溯（新图是 upload 内联，不影响原图）
  if (a.source && a.source !== 'upload' && typeof a.full === 'string'
      && a.full.indexOf('data:') !== 0 && a.full.indexOf(IMGREF) !== 0) {
    a._replacedFrom = a.full;
  }
  // 统一改为 upload 来源：本地模式落 imgfull:<id>，服务端模式由 serve.js 解码写盘（不会撑大 index.json）
  a.source = 'upload';
  // 先覆盖大图小记录（无论之前是否已存，确保新字节落库），再交给 addArtwork 持久化
  try { await storeUploadImage(id, full, thumb); } catch (e) { /* 后面 addArtwork 会再尝试保存 */ }
  a.full = full;
  a.thumb = thumb;
  await addArtwork(a); // 按 id 覆盖
}
async function doReplaceImage(id, file) {
  const a = getArt(id);
  if (!a) { toast('找不到这张画作'); return; }
  toast('正在读取新图片…');
  let full, thumb;
  try {
    thumb = await downscaleImage(file, 720, 0.82);
    full = await downscaleImage(file, 1280, 0.85);
  } catch (e) {
    toast('图片读取失败，换张试试');
    return;
  }
  try {
    await replaceArtworkImage(id, full, thumb);
    $('lbImg').src = thumb;          // 灯箱立即显示新图
    renderGallery();                 // 画廊缩略图同步刷新
    const _ai = $('lbAddImg'); if (_ai) _ai.classList.add('hidden');
    const _rb = $('lbImgReplace'); if (_rb) _rb.textContent = '🖼 换图';
    toast('已换图 ✓');
  } catch (e) {
    console.error(e);
    toast('换图失败：' + (e && e.message ? e.message : e));
  }
}

/* ============ 批量上传（多图 + 逐张填提示词，一次保存） ============ */
let batchDrafts = [];
function openBatchUploadModal() {
  batchDrafts = [];
  $('batchGrid').innerHTML = '';
  $('batchBar').classList.add('hidden');
  $('batchArtistAll').value = '';
  $('batchTagsAll').value = '';
  $('batchUploadSaveBtn').disabled = true;
  showModal('batchUploadModal');
  renderQuickFillArtists('qfArtistsBatch');
  updateBatchStat();
}
function buildArtFromDraft(d) {
  return {
    id: d.id, thumb: d.thumb, full: d.full, source: 'upload', file: d.file || '',
    title: (d.title || '').trim(), artist: (d.artist || '').trim(), note: (d.note || '').trim(),
    tags: parseTagsInput(d.tags || ''), vibe: '',
    positive: (d.positive || '').trim(), negative: (d.negative || '').trim(),
    batch: '', params: {}, createdAt: Date.now(),
  };
}
async function handleBatchFiles(files) {
  const list = files && Array.from(files);
  if (!list || !list.length) return;
  let added = 0;
  for (const file of list) {
    if (!/^image\//.test(file.type)) continue;
    let full, thumb;
    try { full = await downscaleImage(file, 1280, 0.85); thumb = await downscaleImage(file, 720, 0.82); }
    catch (e) { toast('图片读取失败：' + file.name); continue; }
    const d = { id: uid(), full, thumb, file: file.name, title: '', artist: '', note: '', link: '', tags: '', positive: '', negative: '' };
    try {
      const meta = await extractMetadata(file);
      if (meta) {
        const sp = splitArtistChain(meta.positive || '');
        d.positive = sp.rest;
        d.artistChain = sp.chain;
        d.negative = meta.negative || '';
        d.artist = detectArtist(meta.positive) || '';
      }
    } catch (e) { /* 无元数据则留空，用户手填 */ }
    batchDrafts.push(d);
    added++;
  }
  if (added) {
    $('batchBar').classList.remove('hidden');
    const baw = $('batchArtistsWrap'); if (baw) baw.classList.remove('hidden');
    renderBatchGrid();
    updateBatchStat();
    if (added < list.length) toast('已加入 ' + added + ' 张（已跳过非图片文件）');
  }
}
function renderBatchGrid() {
  const g = $('batchGrid');
  if (!batchDrafts.length) { g.innerHTML = ''; $('batchUploadSaveBtn').disabled = true; return; }
  g.innerHTML = batchDrafts.map(d => `
    <div class="batch-card" data-bid="${d.id}">
      <div class="bc-head">
        <img class="bc-img" src="${esc(d.thumb)}" alt="">
        <button class="bc-remove" data-remove="${d.id}" title="移除这张">✕</button>
      </div>
      <div class="bc-fields">
        <input class="bc-in" data-field="title" placeholder="名字（可选）" value="${esc(d.title)}">
        <input class="bc-in" data-field="artist" placeholder="画师" value="${esc(d.artist)}">
        <input class="bc-in" data-field="tags" placeholder="标签（空格/逗号分隔）" value="${esc(d.tags)}">
        <textarea class="bc-ta" data-field="positive" rows="3" placeholder="Positive Prompt">${esc(d.positive)}</textarea>
        <textarea class="bc-ta" data-field="negative" rows="2" placeholder="Negative Prompt">${esc(d.negative)}</textarea>
      </div>
    </div>`).join('');
  $('batchUploadSaveBtn').disabled = false;
}
function updateBatchStat() {
  $('batchStat').textContent = batchDrafts.length ? ('共 ' + batchDrafts.length + ' 张') : '';
}
async function saveBatchAll() {
  if (!batchDrafts.length) return;
  const n = batchDrafts.length;
  const existing = new Set(artworks.map(a => a.id));
  for (const d of batchDrafts) {
    const a = buildArtFromDraft(d);
    if (existing.has(a.id)) { const i = artworks.findIndex(x => x.id === a.id); artworks[i] = a; }
    else artworks.push(a);
  }
  await forceSave();
  batchDrafts = [];
  closeModals();
  refreshFilters();
  refreshBatchFilter();
  renderGallery();
  toast('已批量保存 ' + n + ' 张 ✓');
}

async function delArt(id) {
  if (!await confirmModal('确定删除这张画作？此操作不可恢复。')) return;
  await delArtDB(id);
  artworks = artworks.filter(a => a.id !== id);
  refreshFilters();
  refreshBatchFilter();
  if (lbCurrent === id) closeModals();
  renderGallery();
  toast('已删除');
}
function imageExt(url) {
  const m = (url || '').match(/\.(png|jpe?g|webp|gif)(?:$|[?#])/i) || (url || '').match(/^data:image\/([a-z0-9]+)/i);
  if (!m) return 'jpg';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}
function dataURLToBlob(dataURL) {
  return new Promise((res, rej) => {
    try {
      const [head, b64] = dataURL.split(',');
      const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      res(new Blob([arr], { type: mime }));
    } catch (e) { rej(e); }
  });
}
function buildMetaText(a) {
  const L = [];
  if (a.title && a.title.trim()) L.push('标题: ' + a.title.trim());
  if (a.artist) L.push('画师: ' + a.artist);
  if (a.tags && a.tags.length) L.push('标签: ' + a.tags.join(', '));
  if (a.batch) L.push('批次: ' + a.batch);
  if (a.vibe) L.push('Vibe: ' + a.vibe);
  if (a.positive) L.push('\n正面提示词:\n' + a.positive);
  if (a.negative) L.push('\n负面提示词:\n' + a.negative);
  if (a.source) L.push('\n来源: ' + a.source);
  return L.join('\n');
}
function downloadArt(id) {
  const a = getArt(id);
  if (!a) return;
  if (!a.full) { toast('该条目只有提示词、没有图片，无法下载'); return; }
  const ext = imageExt(a.full);
  const base = `${String(a.artist || a.batch || 'nai').replace(/[\\/:*?"<>|]/g, '_')}-${String(id).slice(0, 6)}`;
  const hasMeta = !!(a.artist || (a.tags && a.tags.length) || a.positive || a.negative || a.title);
  // 没有任何元数据：维持原行为，直接下载图片本身
  if (!hasMeta) {
    const link = document.createElement('a');
    link.href = a.full; link.download = base + '.' + ext; link.click();
    return;
  }
  // 有元数据：把图片 + metadata.txt 打包成 zip，元数据跟着一起下载
  (async () => {
    try {
      if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载，请刷新页面');
      const zip = new JSZip();
      let blob;
      if (a.full.startsWith('data:')) blob = await dataURLToBlob(a.full);
      else blob = await (await fetch(a.full)).blob();
      zip.file(base + '.' + ext, blob);
      zip.file(base + '.txt', buildMetaText(a));
      const out = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(out);
      const link = document.createElement('a');
      link.href = url; link.download = base + '.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('已下载图片 + 元数据（zip：图片 + metadata.txt）✓');
    } catch (e) {
      // 兜底：打包失败就只下图片，保证用户一定拿得到图
      const link = document.createElement('a');
      link.href = a.full; link.download = base + '.' + ext; link.click();
      toast('打包失败，已改为只下载图片：' + e.message);
    }
  })();
}
async function clearAll() {
  if (!await confirmModal('确定清空本地全部内容吗？所有画作和 Vibe 将被永久删除，此操作不可恢复！')) return;
  artworks = [];
  vibes = [];
  await saveToAPI();
  await localClearImages();
  refreshFilters();
  refreshBatchFilter();
  renderGallery();
  renderVibes();
  toast('已清空本地全部内容');
}
/* ============ 灯箱 ============ */
function openLightbox(id, opts) {
  const a = getArt(id);
  if (!a) return;
  lbCurrent = id;
  $('lbImg').src = a.thumb;
  $('lbImg').decoding = 'async';
  // 无图时显示「添加图片」入口，有图时显示「换图」
  const _hasImg = !!(a.full && a.full.trim());
  const _addImg = $('lbAddImg'); if (_addImg) _addImg.classList.toggle('hidden', _hasImg);
  const _repBtn = $('lbImgReplace'); if (_repBtn) _repBtn.textContent = _hasImg ? '🖼 换图' : '📷 添加图片';
  // 标题（名字）：用户起的标题，与画师完全独立；无标题显示中性占位，不再用画师回填
  const tv = $('lbTitleVal');
  if (a.title && a.title.trim()) {
    tv.textContent = a.title.trim();
    tv.classList.remove('empty');
  } else {
    tv.textContent = '未命名（点 ✎ 起个名字）';
    tv.classList.add('empty');
  }
  // 画师
  const av = $('lbArtistVal');
  if (a.artist) { av.textContent = a.artist; av.classList.remove('empty'); }
  else { av.textContent = '未填，点击 ✎ 添加'; av.classList.add('empty'); }
  $('lbPos').value = a.positive || '';
  $('lbArtist').value = a.artistChain || '';
  $('lbNeg').value = a.negative || '';
  $('lbMeta').innerHTML = [
    a.batch ? `<span class="chip">📁 ${esc(a.batch)}</span>` : '',
    a.params && a.params.steps ? `<span class="chip">Steps ${esc(a.params.steps)}</span>` : '',
    a.params && a.params.sampler ? `<span class="chip">${esc(a.params.sampler)}</span>` : '',
    a.params && a.params.cfg ? `<span class="chip">CFG ${esc(a.params.cfg)}</span>` : '',
    a.params && a.params.size ? `<span class="chip">${esc(a.params.size)}</span>` : '',
  ].join('');
  renderLbTags(a);
  renderLbNote(a);
  renderLbLink(a);
  // 重置所有编辑入口为收起
  $('lbTagsEdit').classList.add('hidden');
  $('lbTitleEdit').classList.add('hidden');
  $('lbArtistEdit').classList.add('hidden');
  $('lbNoteEdit').classList.add('hidden');
  $('lbLinkEdit').classList.add('hidden');
  $('lbTagInput').value = getTags(a).join(' ');
  $('lbTitleInput').value = a.title || '';
  $('lbArtistInput').value = a.artist || '';
  $('lbNoteInput').value = a.note || '';
  $('lbLinkInput').value = a.link || '';
  showModal('lightbox');
  // 可选：自动展开某编辑面板（从卡片点 📝 时展开备注）
  if (opts && opts.openNote) {
    const edit = $('lbNoteEdit');
    if (edit) { edit.classList.remove('hidden'); $('lbNoteInput').focus(); }
  }
}
// 新建「纯文字画作」：先不传图，只建空壳供填写提示词/画师串/备注，之后随时可点「添加图片」补图
async function createTextArtwork() {
  const a = {
    id: uid(),
    thumb: PLACEHOLDER_THUMB,
    full: '',
    source: 'text',
    file: '',
    title: '',
    artist: '',
    artistChain: '',
    positive: '',
    negative: '',
    tags: [],
    vibe: '',
    note: '',
    link: '',
    batch: '',
    params: {},
    createdAt: Date.now(),
  };
  await addArtwork(a);
  refreshFilters();
  renderGallery();
  openLightbox(a.id);
  toast('已新建一张文字画作，填好提示词后随时可点图片区「📷 添加图片」补图 ✓');
}
function renderLbTags(a) {
  const tags = getTags(a);
  const el = $('lbTags');
  if (!tags.length) { el.innerHTML = '<span class="lb-tags-empty">还没有标签，点「✎ 编辑标签」添加</span>'; return; }
  el.innerHTML = tags.map(t => `<span class="tag tagchip" data-filtertag="${esc(t)}"># ${esc(t)}</span>`).join('');
}
async function saveArtworkTags(id) {
  const a = getArt(id);
  if (!a) return;
  const tags = parseTagsInput($('lbTagInput').value);
  a.tags = tags;
  a.vibe = '';
  await addArtwork(a); // 按 id 覆盖
  $('lbTagsEdit').classList.add('hidden');
  renderLbTags(a);
  refreshFilters();
  toast('标签已保存 ✓');
}
function renderLbNote(a) {
  const el = $('lbNote');
  if (!el) return;
  const note = (a.note || '').trim();
  if (!note) { el.innerHTML = '<span class="lb-note-empty">还没有备注，点 ✎ 写一条</span>'; return; }
  el.textContent = note;
}
async function saveArtworkNote(id) {
  const a = getArt(id);
  if (!a) return;
  const v = $('lbNoteInput').value;
  a.note = v;
  await addArtwork(a);
  renderLbNote(a);
  $('lbNoteEdit').classList.add('hidden');
  renderGallery();
  toast(v && v.trim() ? '备注已保存 ✓' : '已清空备注');
}
function renderLbLink(a) {
  const view = $('lbLink');
  const open = $('lbLinkOpen');
  if (!view) return;
  const url = (a && a.link) ? String(a.link).trim() : '';
  if (url) {
    view.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener" class="lb-link-text">${esc(url)}</a>`;
    if (open) { open.href = url; open.classList.remove('hidden'); }
    view.classList.remove('empty');
  } else {
    view.innerHTML = '<span class="lb-note-empty">还没有链接，点右侧 ✎ 添加</span>';
    if (open) { open.classList.add('hidden'); open.removeAttribute('href'); }
    view.classList.add('empty');
  }
  const edit = $('lbLinkEdit');
  if (edit) edit.classList.add('hidden');
}
async function saveArtworkLink(id) {
  const a = getArt(id);
  if (!a) return;
  const url = $('lbLinkInput').value.trim();
  if (url && !/^https?:\/\//i.test(url)) { toast('链接必须以 http:// 或 https:// 开头'); return; }
  a.link = url;
  try {
    await addArtwork(a);
    $('lbLinkEdit').classList.add('hidden');  // 显式隐藏编辑框，避免依赖 renderLbLink 副作用
    renderLbLink(a);
    renderGallery();
    toast(url ? '链接已保存 ✓' : '已清空链接');
  } catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
}
async function saveArtworkTitle(id) {
  const a = getArt(id);
  if (!a) return;
  const v = $('lbTitleInput').value.trim();
  a.title = v;
  await addArtwork(a);
  const tv = $('lbTitleVal');
  if (v) { tv.textContent = v; tv.classList.remove('empty'); }
  else { tv.textContent = '未命名（点 ✎ 起个名字）'; tv.classList.add('empty'); }
  $('lbTitleEdit').classList.add('hidden');
  renderGallery();
  toast(v ? '名字已保存 ✓' : '已清空名字');
}
async function saveArtworkArtist(id) {
  const a = getArt(id);
  if (!a) return;
  const v = $('lbArtistInput').value.trim();
  a.artist = v;
  await addArtwork(a);
  const av = $('lbArtistVal');
  if (v) { av.textContent = v; av.classList.remove('empty'); }
  else { av.textContent = '未填，点击 ✎ 添加'; av.classList.add('empty'); }
  // 注意：名字是独立字段，改画师绝不动名字
  $('lbArtistEdit').classList.add('hidden');
  refreshFilters();
  renderGallery();
  toast(v ? '画师已保存 ✓' : '已清空画师');
}
async function saveArtworkPrompt(id) {
  const a = getArt(id);
  if (!a) { toast('找不到这张画作，无法保存'); return; }
  const btn = $('lbPromptSave');
  const prevLabel = btn ? btn.textContent : '';
  try {
    a.positive = $('lbPos').value;
    a.negative = $('lbNeg').value;
    a.artistChain = $('lbArtist').value.trim();
    await addArtwork(a); // 按 id 覆盖
    refreshFilters();
    renderGallery();
    toast('提示词已保存 ✓');
    if (btn) { btn.textContent = '✓ 已保存'; btn.disabled = true; setTimeout(() => { btn.textContent = prevLabel; btn.disabled = false; }, 1400); }
  } catch (e) {
    console.error('saveArtworkPrompt failed:', e);
    toast('保存失败：' + (e && e.message ? e.message : e));
  }
}

// 从当前灯箱的正面提示词里把画师串抽出来，分到独立字段并保存
// 注意：用「合并」而不是「覆盖」，避免把之前已提取的内容顶掉
async function extractArtistChain() {
  if (!lbCurrent) return;
  const a = getArt(lbCurrent);
  if (!a) return;
  const { rest, chain } = splitArtistChain($('lbPos').value);
  const existing = (a.artistChain || '').trim();
  if (!chain) {
    toast(existing ? '正面里没有新的画师串了，已保留原有的' : '正面提示词里没找到画师串（weight::内容:: 这种格式）');
    return;
  }
  // 已有的在前、新抽的在后，合并（不覆盖！）
  const merged = existing ? (existing + ', ' + chain) : chain;
  $('lbPos').value = rest;
  $('lbArtist').value = merged;
  a.positive = rest;
  a.artistChain = merged;
  try {
    await addArtwork(a);
    refreshFilters();
    renderGallery();
    toast(existing ? `已追加 ${chain.split(', ').length} 条（原有 ${existing.split(', ').length} 条保留）✓` : '画师串已提取并保存 ✓');
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : e));
  }
}

// 反向操作：把画师串放回正面提示词开头，清空画师串字段（本张重来）
async function chainBackToPositive() {
  if (!lbCurrent) return;
  const a = getArt(lbCurrent);
  if (!a) return;
  const chain = ($('lbArtist').value || '').trim();
  if (!chain) { toast('画师串是空的，没有可放回的内容'); return; }
  const pos = ($('lbPos').value || '').trim();
  const merged = pos ? (chain + ', ' + pos) : chain;
  $('lbPos').value = merged;
  $('lbArtist').value = '';
  a.positive = merged;
  a.artistChain = '';
  try {
    await addArtwork(a);
    refreshFilters();
    renderGallery();
    toast('画师串已放回正面提示词，可以重新提取 ✓');
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : e));
  }
}

// 清空某个提示词字段（先弹确认；会备份，可用工具栏「↩ 撤销」恢复）
async function clearPromptField(which) {
  if (!lbCurrent) return;
  const a = getArt(lbCurrent);
  if (!a) return;
  const map = {
    artist: { id: 'lbArtist', name: '画师串',    get: () => a.artistChain || '', set: v => { a.artistChain = v; } },
    pos:    { id: 'lbPos',    name: '正面提示词', get: () => a.positive || '',   set: v => { a.positive = v; } },
    neg:    { id: 'lbNeg',    name: '负面提示词', get: () => a.negative || '',   set: v => { a.negative = v; } },
  };
  const f = map[which];
  if (!f) return;
  const el = $(f.id);
  // 以「文本框里当前的内容」为准（用户可能改了还没保存），不要用已保存的值判断
  const cur = el ? el.value : f.get();
  if (!cur.trim()) { toast(`${f.name} 本来就是空的`); return; }
  if (!await confirmModal(`确定清空「${f.name}」吗？此操作不可撤销，请确认。`, false)) return;
  f.set('');
  if (el) el.value = '';
  try {
    await addArtwork(a);
    refreshFilters();
    renderGallery();
    toast(`${f.name}已清空 ✓`);
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : e));
  }
}

// （批量提取画师串功能已移除：仅保留灯箱单张「🔀 提取」）

/* ============ 上传表单：已有画师快捷填入 ============ */
function renderQuickFillArtists(targetId) {
  const tid = targetId || 'qfArtists';
  const aBox = $(tid);
  if (!aBox) return;
  const artists = [...new Set(artworks.map(a => a.artist).filter(Boolean))];
  const chipInput = tid === 'qfArtistsBatch' ? 'batchArtistAll' : 'fArtist';
  aBox.innerHTML = artists.length
    ? artists.map(n => `<button type="button" class="qf-chip" data-qartist="${esc(n)}" data-qartist-input="${esc(chipInput)}">${esc(n)}</button>`).join('')
    : '<span class="muted" style="font-size:12px">暂无</span>';
}

/* ============ Vibe CRUD ============ */
async function addVibe() {
  const name = $('vName').value.trim();
  const positive = $('vPos').value.trim();
  if (!name || !positive) { toast('请填写名称和正面提示词'); return; }
  const v = { id: uid(), kind: 'text', name, positive, negative: $('vNeg').value.trim(), artist: '', tags: [], batch: '', createdAt: Date.now() };
  await addVibeDB(v);
  vibes.push(v);
  renderVibes();
  $('vName').value = ''; $('vPos').value = ''; $('vNeg').value = '';
  $('vibeImportModal').classList.add('hidden');
  toast('文本备注已保存 ✓');
}
async function delVibe(id) {
  if (!await confirmModal('删除这个 Vibe？此操作不可恢复。')) return;
  await delVibeDB(id);
  vibes = vibes.filter(v => v.id !== id);
  renderVibes();
  toast('已删除 Vibe');
}
async function renameVibe(id, newName) {
  const v = getVibe(id);
  if (!v) return;
  const name = (newName || '').trim();
  if (!name) { toast('名称不能为空'); return; }
  v.name = name;
  if (v.raw && typeof v.raw === 'object') v.raw.name = name; // 改名同步回原始对象（导出 .naiv4vib 时也用新名）
  await updateVibeDB(v);
  renamingId = null;
  renderVibes();
  toast('已改名 ✓');
}
function downloadVibe(id) {
  const v = getVibe(id);
  if (!v || v.kind !== 'encoding') return;
  const obj = Object.assign({}, v.raw);
  if (!obj.identifier) obj.identifier = 'novelai-vibe-transfer';
  if (!obj.version) obj.version = 1;
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = String(v.name || 'vibe').replace(/[\\/:*?"<>|]/g, '_');
  a.download = `${safe}.naiv4vib`;
  a.click();
  URL.revokeObjectURL(url);
}
function exportVibes() {
  if (!vibes.length) { toast('没有可导出的 Vibe'); return; }
  const data = vibes.map(v => v.kind === 'encoding' ? v.raw : { name: v.name, positive: v.positive, negative: v.negative });
  downloadJSON({ type: 'nai-vibes', version: 1, vibes: data }, 'nai-vibes.json');
}
async function importVibeText(text, originalFilename) {
  try {
    const arr = parseVibeFile(text);
    if (!arr || !arr.length) { toast('未识别到 NAI Vibe 数据'); return; }
    let n = 0, enc = 0;
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue;
      if (isEncodingVibe(v)) {
        const item = encodeVibeToItem(v, originalFilename);
        await addVibeDB(item); vibes.push(item); n++; enc++;
      } else if (v.name || v.title) {
        const item = normVibe(v);
        await addVibeDB(item); vibes.push(item); n++;
      }
    }
    renderVibes();
    $('vibePaste').classList.add('hidden');
    $('vibePasteRow').classList.add('hidden');
    $('vibePaste').value = '';
    toast(`已导入 ${n} 个 Vibe（其中 ${enc} 个编码型）✓`);
  } catch (e) {
    console.error('Vibe import error:', e);
    toast('解析失败：' + (e && e.message ? e.message : e));
  }
}
async function importVibeFile(file) {
  if (!file) return;
  try { await importVibeText(await file.text(), file.name); }
  catch (e) { toast('读取失败：' + e.message); }
}

/* ============ 完整备份 / 恢复（独立于浏览器网址，防换地址丢数据） ============ */
function exportBackup() {
  const arts = artworks.map(a => ({
    id: a.id, thumb: a.thumb || '', full: a.full || '',
    artist: a.artist || '', tags: a.tags || [], vibe: a.vibe || '',
    positive: a.positive || '', negative: a.negative || '',
    params: a.params || {}, batch: a.batch || '', source: a.source || '',
    createdAt: a.createdAt || Date.now()
  }));
  let vbs = [];
  try { vbs = vibes.map(v => JSON.parse(JSON.stringify(v))); } catch (e) { vbs = []; }
  if (!arts.length && !vbs.length) { toast('没有可备份的内容'); return; }
  const payload = {
    type: 'nai-workbench-backup', version: 2,
    exportedAt: Date.now(),
    note: 'NAI 画师串工作台完整备份（画作+Vibe），可用「📂 恢复」载入',
    artworks: arts, vibes: vbs
  };
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  downloadJSON(payload, `nai-workbench-backup-${stamp}.json`);
  toast(`已备份 ${arts.length} 张画作 + ${vbs.length} 个 Vibe 到文件 ✓`);
}

// —— 从本机服务器把现有数据「合并」进本浏览器（顶栏「从本机导入」按钮）——
async function pullFromServer() {
  try {
    const r = await fetchWithTimeout(API_BASE + '/api/data?_=' + Date.now(), { cache: 'no-store' }, location.protocol === 'file:' ? 1500 : 0);
    if (!r.ok) throw new Error('服务器返回 ' + r.status);
    const data = await r.json();
    const incA = Array.isArray(data.artworks) ? data.artworks : [];
    const incV = Array.isArray(data.vibes) ? data.vibes : [];
    let added = 0;
    const byId = new Map(artworks.map(a => [a.id, a]));
    for (const a of incA) { if (!a || !a.id) continue; if (!byId.has(a.id)) { artworks.push(a); added++; } }
    const byV = new Map(vibes.map(v => [v.id, v]));
    for (const v of incV) { if (!v || !v.id) continue; if (!byV.has(v.id)) { vibes.push(v); } }
    if (RAW_EXTERNAL) { try { await attachVibeRaws(); } catch (e) { /* 忽略 */ } }
    await forceSave();
    refreshFilters(); refreshBatchFilter(); renderGallery(); renderVibes();
    toast(`已从本机服务器合并导入 ${added} 张新画作（已有的不重复）✓`);
  } catch (e) {
    toast('从本机服务器导入失败：' + e.message + '（请确认电脑上的服务在跑）');
  }
}

async function importBackup(text) {
  const data = JSON.parse(text);
  if (!data) throw new Error('文件为空');
  const arts = Array.isArray(data.artworks) ? data.artworks : [];
  const vbs = Array.isArray(data.vibes) ? data.vibes : [];
  // 兼容：工作台完整备份（type='nai-workbench-backup'）或原始 data/index.json（{artworks,vibes}）
  if (data.type !== 'nai-workbench-backup' && !arts.length && !vbs.length) {
    throw new Error('不是工作台备份 / 数据文件（需含 artworks 或 vibes）');
  }
  let nArt = 0, nVibe = 0;
  for (const a of arts) {
    if (!a || (!a.thumb && !a.positive && !a.negative)) continue;
    const item = {
      id: a.id || uid(),
      thumb: a.thumb || PLACEHOLDER_THUMB,
      full: a.full || '',
      artist: a.artist || '',
      tags: a.tags || [],
      vibe: a.vibe || '',
      positive: a.positive || '',
      negative: a.negative || '',
      params: a.params || {},
      batch: a.batch || '',
      source: a.source || 'backup',
      createdAt: a.createdAt || Date.now(),
    };
    await addArtwork(item); nArt++;
  }
  for (const v of vbs) {
    if (!v || !v.id) continue;
    await addVibeDB(v); nVibe++;
  }
  artworks = await getAllArt();
  vibes = await getAllVibes();
  refreshFilters(); renderGallery(); renderVibes();
  toast(`已恢复 ${nArt} 张画作 + ${nVibe} 个 Vibe ✓`);
}
/* ============ 解析 NAI 生成请求 JSON ============ */
// NAI 网页/插件导出的生成数据常见形如：
//   { prompt:"...", uc:"...", steps, sampler, scale, seed, width, height, v4_prompt:{caption:{base_caption}}, v4_negative_prompt:{...} }
// 正面 = v4_prompt.caption.base_caption（优先）或 prompt；负面 = v4_negative_prompt.caption.base_caption（优先）或 uc
function parseNAIRequest(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const hasV4 = obj.v4_prompt || obj.v4_negative_prompt;
  const hasSimple = ('prompt' in obj) || ('uc' in obj);
  if (!hasV4 && !hasSimple) return null; // 不是 NAI 生成请求

  const positive =
    (obj.v4_prompt && obj.v4_prompt.caption && obj.v4_prompt.caption.base_caption) ||
    obj.prompt || '';
  const negative =
    (obj.v4_negative_prompt && obj.v4_negative_prompt.caption && obj.v4_negative_prompt.caption.base_caption) ||
    obj.uc || '';

  const params = {
    steps: obj.steps,
    sampler: obj.sampler,
    cfg: obj.scale != null ? obj.scale : (obj.cfg_scale != null ? obj.cfg_scale : ''),
    seed: obj.seed,
    size: (obj.width && obj.height) ? `${obj.width}x${obj.height}` : (obj.size || ''),
    model: obj.model || (obj.v4_prompt ? 'V4' : ''),
  };
  // 去掉空字段，保持整洁
  Object.keys(params).forEach(k => { if (params[k] === '' || params[k] == null) delete params[k]; });

  return {
    positive: String(positive).trim(),
    negative: String(negative).trim(),
    artist: detectArtist(String(positive)),
    params,
  };
}

async function importAll(text) {
  try {
    const data = JSON.parse(text);
    // 路径 -1：NAI Vibe 传输文件（.naiv4vibe / .naiv4vibebundle），识别后转入 Vibe 导入
    if (data && (data.identifier === 'novelai-vibe-transfer' || data.identifier === 'novelai-vibe-transfer-bundle')) {
      await importVibeText(text, '');
      return;
    }
    // 路径 -0：本工作台完整备份（画作+Vibe），原样恢复
    if (data && data.type === 'nai-workbench-backup') {
      await importBackup(text);
      return;
    }
    // 路径 0：nai-preset-switcher 画廊导出（JSON，正负面已拆分）
    if (data && data.format === 'nai-preset-switcher-gallery-export') {
      await importGalleryExport(data, null);
      return;
    }
    // 路径 1：应用自身导出格式 { artworks:[...] }（正负面已分开）
    const arr = data.artworks || (Array.isArray(data) && data.length && data[0] && (data[0].thumb || data[0].positive || data[0].negative) ? data : null);
    if (arr) {
      let n = 0;
      for (const a of arr) {
        if (!a.thumb && !a.positive && !a.negative) continue;
        const item = {
          id: a.id || uid(), thumb: a.thumb || PLACEHOLDER_THUMB, full: a.full || '',
          artist: a.artist || '',
          tags: a.tags || (a.vibe ? [a.vibe] : []), vibe: '',
          positive: a.positive || '', negative: a.negative || '',
          params: a.params || {}, createdAt: a.createdAt || Date.now(),
        };
        await addArtwork(item); n++;
      }
      refreshFilters(); renderGallery();
      toast(`已导入 ${n} 张画作 ✓`);
      return;
    }
    // 路径 2：NAI 生成请求 JSON（单对象或数组），正负面必须拆分
    const items = [];
    if (Array.isArray(data)) {
      for (const o of data) { const r = parseNAIRequest(o); if (r) items.push(r); }
    } else {
      const r = parseNAIRequest(data);
      if (r) items.push(r);
    }
    if (!items.length) { toast('未识别到可导入的画作或提示词'); return; }
    let n = 0;
    for (const r of items) {
      const a = {
        id: uid(),
        thumb: PLACEHOLDER_THUMB,
        full: '',
        source: 'json',
        artist: r.artist || '',
        tags: [],
        vibe: '',
        positive: r.positive,
        negative: r.negative,
        params: r.params || {},
        batch: '',
        createdAt: Date.now(),
      };
      await addArtwork(a); n++;
    }
    refreshFilters(); renderGallery();
    toast(`已导入 ${n} 条提示词（正/负面已拆分）✓`);
  } catch (e) { toast('解析失败：' + e.message); }
}

/* ============ nai-preset-switcher 画廊导出（JSON 内嵌图片+提示词，正负面已拆分） ============ */
async function importGalleryExport(obj, progress) {
  if (progress) progress.innerHTML = '<div>正在解析 nai-preset-switcher 画廊导出…</div>';
  const imgById = {};
  (obj.images || []).forEach(im => { if (im && im.id) imgById[im.id] = im; });
  const grpById = {};
  (obj.vibe_groups || []).forEach(g => { if (g && g.id) grpById[g.id] = g; });
  const vibeNameById = {};
  (obj.vibes || []).forEach(v => { if (v && v.id) vibeNameById[v.id] = v.name; });

  // 1) 画作：图片来自 images[].data_url（或 gallery[].image_data_url），提示词来自 positive_prompt / negative_prompt
  let added = 0, failed = 0, noImg = 0, order = 0;
  const items = (obj.gallery && obj.gallery.length) ? obj.gallery : (obj.prompts || []);
  for (const g of items) {
    try {
      const dataUrl = g.image_data_url || (imgById[g.image_id] && imgById[g.image_id].data_url) || '';
      let thumb = PLACEHOLDER_THUMB, full = '';
      if (dataUrl) {
        full = dataUrl;
        try { thumb = await downscaleDataUrl(dataUrl, 720, 0.82); }
        catch (e) { thumb = dataUrl; }
      } else { noImg++; }
      const positive = String(g.positive_prompt || g.positive || '').trim();
      const negative = String(g.negative_prompt || g.negative || '').trim();
      const artist = detectArtist(positive);
      const tags = [];
      if (Array.isArray(g.tags)) {
        for (const t of g.tags) {
          const s = String(t || '').trim();
          if (s && !tags.includes(s)) tags.push(s);
        }
      }
      if (g.vibe_group_id && grpById[g.vibe_group_id] && grpById[g.vibe_group_id].name) {
        const gn = grpById[g.vibe_group_id].name.trim();
        if (gn && !tags.includes(gn)) tags.push(gn);
      }
      if (Array.isArray(g.vibe_refs)) {
        for (const r of g.vibe_refs) {
          const nm = (typeof r === 'string') ? vibeNameById[r] : (r && r.name);
          if (nm && !tags.includes(nm)) tags.push(nm);
        }
      }
      const a = {
        id: uid(),
        thumb, full, source: 'zip-gallery',
        artist, tags,
        vibe: '',
        positive, negative,
        params: (g.params && Object.keys(g.params).length) ? g.params : {},
        batch: '',
        title: g.title || '',
        createdAt: Date.now() - order++,
      };
      await addArtwork(a); added++;
    } catch (e) { failed++; }
  }

  // 2) Vibe：data 字段是 NAI vibe-transfer 对象的 JSON 字符串，复用 encodeVibeToItem
  let vibesAdded = 0;
  for (const v of (obj.vibes || [])) {
    if (!v || v.missing) continue;
    let raw = null;
    if (v.data) { try { raw = JSON.parse(v.data); } catch (e) {} }
    if (!raw) continue;
    try {
      const item = encodeVibeToItem(raw, v.name);
      if (v.name) { item.name = v.name; item.originalName = v.name; }
      if (v.model) item.model = v.model;
      if (v.strength != null) item.strength = v.strength;
      if (v.thumbnail) item.thumbnail = v.thumbnail;
      await addVibeDB(item); vibes.push(item); vibesAdded++;
    } catch (e) {}
  }

  refreshFilters(); refreshBatchFilter(); renderGallery(); renderVibes();
  if (progress) progress.innerHTML = `
    <div class="zp-line"><span>导入完成</span><span class="zp-ok">✓</span></div>
    <div class="zp-line"><span>画作</span><span>${added} 张${failed ? ' · 失败 ' + failed : ''}</span></div>
    <div class="zp-line"><span>无图条目</span><span>${noImg} 条</span></div>
    <div class="zp-line"><span>Vibe</span><span>${vibesAdded} 个</span></div>
    <div style="margin-top:8px;font-size:12px;color:var(--muted)">提示词已按 positive_prompt / negative_prompt 拆分；图片来自 images.data_url。重复导入会生成重复条目，建议先清空。</div>`;
  toast(`已导入 ${added} 张画作 / ${vibesAdded} 个 Vibe`);
}

/* ============ ZIP 画廊导入 (nai-preset-switcher-gallery-export) ============ */
async function importZipBuffer(buf) {
  if (typeof JSZip === 'undefined') { toast('JSZip 未加载，刷新页面重试'); return; }
  const progress = $('zipProgress');
  progress.classList.remove('hidden');
  progress.innerHTML = '<div>正在解压 ZIP…</div>';
  let zip;
  try { zip = await JSZip.loadAsync(buf); }
  catch (e) { progress.innerHTML = `<div class="zp-err">ZIP 解压失败：${esc(e.message)}</div>`; return; }

  const entries = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const lower = path.toLowerCase();
    if (lower.endsWith('.ds_store') || lower.includes('__macosx')) return;
    entries.push({ path, entry, isImg: /\.(png|jpe?g|webp|gif|bmp)$/.test(lower), isJson: lower.endsWith('.json') });
  });
  const imgs = entries.filter(e => e.isImg);
  const jsons = entries.filter(e => e.isJson);
  const vibeFiles = entries.filter(e => /\.naiv4vib(ebundle)?$/i.test(e.path));

  // 0) nai-preset-switcher 画廊导出：JSON 内嵌图片(data_url)+提示词，正负面已拆分
  for (const jf of jsons) {
    try {
      const obj = JSON.parse(await jf.entry.async('string'));
      if (obj && obj.format === 'nai-preset-switcher-gallery-export') {
        await importGalleryExport(obj, progress);
        return;
      }
    } catch (e) { /* 不是该格式，继续走通用逻辑 */ }
  }

  // 1a) 解析 Vibe（尝试从 JSON 中识别 vibes / presets 数组）
  let vibesAdded = 0;
  for (const jf of jsons) {
    try {
      const obj = JSON.parse(await jf.entry.async('string'));
      const found = harvestVibes(obj);
      for (const v of found) { await addVibeDB(v); vibes.push(v); vibesAdded++; }
    } catch (e) { /* 忽略非结构化 JSON */ }
  }

  // 1b) 解析 ZIP 内嵌的真实 .naiv4vib / .naiv4vibebundle 编码文件
  for (const vf of vibeFiles) {
    try {
      const obj = JSON.parse(await vf.entry.async('string'));
      const arr = parseVibeFile(JSON.stringify(obj));
      for (const v of arr) {
        if (isEncodingVibe(v)) {
          const item = encodeVibeToItem(v, (vf.path || '').split('/').pop());
          await addVibeDB(item); vibes.push(item); vibesAdded++;
        }
      }
    } catch (e) { /* 忽略无法解析的项 */ }
  }

  // 2) 解析图片：优先读取内嵌 NAI 元数据，按顶层文件夹归为「画廊批次」
  let added = 0, failed = 0;
  const batches = new Set();
  let order = 0;
  for (const im of imgs) {
    try {
      const ab = await im.entry.async('arraybuffer');
      const b64 = await im.entry.async('base64');
      const dataUrl = 'data:' + mimeOf(im.path) + ';base64,' + b64;
      const thumb = await downscaleDataUrl(dataUrl, 720, 0.82);
      const meta = await metaFromArrayBuffer(ab);
      const batch = batchOf(im.path);
      if (batch) batches.add(batch);
      const a = {
        id: uid(),
        thumb,
        full: dataUrl,
        source: 'zip',
        artist: meta ? detectArtist(meta.positive) : '',
        tags: [],
        vibe: '',
        positive: meta ? meta.positive : '',
        negative: meta ? meta.negative : '',
        params: meta ? meta.params : {},
        batch: batch || '',
        createdAt: Date.now() - order++,
      };
      await addArtwork(a);
      added++;
    } catch (e) { failed++; }
  }

  refreshFilters(); refreshBatchFilter(); renderGallery(); renderVibes();
  progress.innerHTML = `
    <div class="zp-line"><span>导入完成</span><span class="zp-ok">✓</span></div>
    <div class="zp-line"><span>画作</span><span>${added} 张${failed ? ' · 失败 ' + failed : ''}</span></div>
    <div class="zp-line"><span>画廊批次</span><span>${batches.size} 个</span></div>
    <div class="zp-line"><span>Vibe</span><span>${vibesAdded} 个</span></div>
    <div style="margin-top:8px;font-size:12px;color:var(--muted)">提示词来自图片内嵌 NAI 元数据；若插件以 JSON 单独存放提示词且字段不同，部分条目可能为空，可手动补充。</div>`;
  toast(`已导入 ${added} 张画作 / ${batches.size} 个批次`);
}
async function importZipFile(file) {
  if (!file) return;
  try { await importZipBuffer(await file.arrayBuffer()); }
  catch (e) { toast('读取 ZIP 失败：' + e.message); }
}
async function importZipFromFolder() {
  const names = ['import/gallery-export.zip', 'import/gallery.zip', 'import/nai-preset-switcher-gallery-export.zip'];
  for (const n of names) {
    try {
      const res = await fetch(n);
      if (res.ok) { await importZipBuffer(await res.arrayBuffer()); return; }
    } catch (e) { /* try next */ }
  }
  toast('未找到 import/ 下的 ZIP，请先把文件放进项目文件夹');
}

/* ============ 事件绑定 ============ */
function wireEvents() {
  // 手机端：侧栏抽屉开关
  const navToggle = document.getElementById('navToggle');
  const navBackdrop = document.getElementById('navBackdrop');
  if (navToggle) navToggle.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  if (navBackdrop) navBackdrop.addEventListener('click', () => document.body.classList.remove('nav-open'));
  const sidebarEl = document.querySelector('.sidebar');
  if (sidebarEl) sidebarEl.addEventListener('click', (e) => {
    if (e.target.closest('.nav-link')) document.body.classList.remove('nav-open');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('nav-open'); });
  // 顶部按钮
  $('uploadBtn').addEventListener('click', () => {
    pendingThumb = null; pendingFull = null;
    $('uploadForm').classList.add('hidden'); $('saveArtBtn').disabled = true;
    $('zipProgress').classList.add('hidden');
    showModal('uploadModal');
  });
  $('batchBtn').addEventListener('click', openBatchUploadModal);
  $('batchFileInput').addEventListener('change', (e) => { handleBatchFiles(e.target.files); e.target.value = ''; });
  const bdz = $('batchDrop');
  ['dragenter', 'dragover'].forEach(ev => bdz.addEventListener(ev, (e) => { e.preventDefault(); bdz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => bdz.addEventListener(ev, (e) => { e.preventDefault(); bdz.classList.remove('drag'); }));
  bdz.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files.length) handleBatchFiles(e.dataTransfer.files); });
  $('batchApplyAll').addEventListener('click', () => {
    const artist = $('batchArtistAll').value.trim();
    const tags = $('batchTagsAll').value.trim();
    if (!artist && !tags) { toast('先填写要统一的画师或标签'); return; }
    for (const d of batchDrafts) { if (artist) d.artist = artist; if (tags) d.tags = tags; }
    renderBatchGrid();
    toast('已应用到全部 ✓');
  });
  $('batchUploadSaveBtn').addEventListener('click', saveBatchAll);
  $('batchGrid').addEventListener('input', (e) => {
    const card = e.target.closest('[data-bid]'); if (!card) return;
    const d = batchDrafts.find(x => x.id === card.dataset.bid); if (!d) return;
    const f = e.target.dataset.field; if (!f) return;
    d[f] = e.target.value;
  });
  $('batchGrid').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]'); if (!rm) return;
    const id = rm.dataset.remove;
    batchDrafts = batchDrafts.filter(x => x.id !== id);
    renderBatchGrid(); updateBatchStat();
  });
  $('vibeBtn').addEventListener('click', showVibeView);
  $('themeToggle').addEventListener('click', toggleTheme);
  $('vibeBackBtn').addEventListener('click', showArtworkView);
  $('vibeImportBtn').addEventListener('click', () => showModal('vibeImportModal'));
  $('vibeSearch').addEventListener('input', (e) => { vibeFilter = e.target.value; pg.vibe = 1; renderVibes(); });
  $('vibeGrid').addEventListener('click', (e) => {
    // —— Vibe 选择模式：勾选框 / 点击卡片本体切换选中 ——
    if (vibeSelectMode) {
      const cb = e.target.closest('[data-vsel]');
      if (cb) { toggleVibeSelect(cb.dataset.vsel); return; }
      const card = e.target.closest('.card[data-vibeid]');
      if (card) {
        const isAction = e.target.closest('[data-delvibe]');
        if (!isAction) { toggleVibeSelect(card.dataset.vibeid); return; }
      }
    }
    const del = e.target.closest('[data-delvibe]');
    if (del) { e.stopPropagation(); delVibe(del.dataset.delvibe); return; }
    const card = e.target.closest('.card[data-vibeid]');
    if (card) openVibeDetail(card.dataset.vibeid);
  });
  // Vibe 选择模式按钮
  $('vibeSelectBtn').addEventListener('click', () => { if (vibeSelectMode) exitVibeSelect(); else enterVibeSelect(); });
  $('vibeSelAll').addEventListener('click', vibeSelectAllVisible);
  $('vibeSelClear').addEventListener('click', clearVibeSelection);
  $('vibeSelectExitBtn').addEventListener('click', exitVibeSelect);
  $('vibeBatchEditBtn').addEventListener('click', openVibeBatchModal);
  $('vibeBatchDelBtn').addEventListener('click', vibeBatchDelete);
  $('vibeBatchSaveBtn').addEventListener('click', applyVibeBatchEdit);
  $('qfArtistsVibeBatch').addEventListener('click', (e) => {
    const ca = e.target.closest('[data-qvartistb]');
    if (ca) { $('vbArtist').value = ca.dataset.qvartistb; toast('已填入画师：' + ca.dataset.qvartistb); }
  });
  // Vibe 详情弹窗按钮
  $('vdDownload').addEventListener('click', () => { if (vdCurrentId) downloadVibe(vdCurrentId); });
  $('vdSetThumb').addEventListener('click', () => { if (vdCurrentId) openVibeThumbModal(vdCurrentId); });
  $('vdRename').addEventListener('click', () => {
    if (!vdCurrentId) return;
    const v = getVibe(vdCurrentId); if (!v) return;
    const n = prompt('改名为：', v.name || '');
    if (n != null) renameVibe(vdCurrentId, n).then(() => {
      const v2 = getVibe(vdCurrentId);
      if (v2) $('vdName').textContent = '💡 ' + (v2.name || '未命名 Vibe');
    });
  });
  $('vdDelete').addEventListener('click', async () => {
    if (!vdCurrentId) return;
    await delVibe(vdCurrentId);
    $('vibeDetail').classList.add('hidden');
  });
  // Vibe 备注：✎ 展开编辑、保存、Ctrl+Enter 提交
  $('vdNoteEditBtn').addEventListener('click', () => {
    const edit = $('vdNoteEdit'); if (!edit) return;
    edit.classList.toggle('hidden');
    if (!edit.classList.contains('hidden')) $('vdNoteInput').focus();
  });
  $('vdNoteSave').addEventListener('click', saveVibeNote);
  $('vdNoteInput').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveVibeNote();
  });
  // Vibe 链接：✎ 展开编辑、保存、跳转按钮已用 a 标签
  $('vdLinkEditBtn').addEventListener('click', () => {
    const edit = $('vdLinkEdit'); if (!edit) return;
    edit.classList.toggle('hidden');
    if (!edit.classList.contains('hidden')) $('vdLinkInput').focus();
  });
  $('vdLinkSave').addEventListener('click', saveVibeLink);
  $('vdLinkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveVibeLink(); });
  // Vibe 画师：✎ 展开编辑、保存、点已有画师 chip 填入
  $('vdArtistEditBtn').addEventListener('click', () => {
    const edit = $('vdArtistEdit'); if (!edit) return;
    edit.classList.toggle('hidden');
    $('vdArtistQf').style.display = edit.classList.contains('hidden') ? 'none' : '';
    if (!edit.classList.contains('hidden')) $('vdArtistInput').focus();
  });
  $('vdArtistSave').addEventListener('click', saveVibeArtist);
  $('vdArtistInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveVibeArtist(); });
  $('qfArtistsVibe').addEventListener('click', (e) => {
    const ca = e.target.closest('[data-qvartist]');
    if (ca) { $('vdArtistInput').value = ca.dataset.qvartist; toast('已填入画师：' + ca.dataset.qvartist); }
  });

  // 画师合集（folder-card 上的 📝 按钮）备注 / 链接
  $('amNoteSave').addEventListener('click', () => saveArtistMetaField('note'));
  $('amLinkSave').addEventListener('click', () => saveArtistMetaField('link'));
  $('amNoteInput').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveArtistMetaField('note'); });
  $('amLinkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveArtistMetaField('link'); });
  $('exportBtn').addEventListener('click', exportBackup);
  $('restoreBtn').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await importBackup(await f.text()); }
    catch (err) { toast('恢复失败：' + err.message); }
    closeModals();
  });
  $('importBtn').addEventListener('click', () => showModal('importModal'));
  // 空库提示条：一键选硬盘 data/index.json 搬入本浏览器（画作 + Vibe 一起）
  const wd = $('warnImportDisk');
  if (wd) wd.addEventListener('click', () => $('restoreFile').click());
  // 上传表单 / 批量表单：已有画师快捷填入（点 chip 填入画师 input）
  function chipArtistClick(targetInputId) {
    return (e) => {
      const ca = e.target.closest('[data-qartist]');
      if (ca) {
        const target = ca.dataset.qartistInput || targetInputId;
        const ti = $(target);
        if (ti) ti.value = ca.dataset.qartist;
        toast('已填入画师：' + ca.dataset.qartist);
      }
    };
  }
  $('uploadForm').addEventListener('click', chipArtistClick('fArtist'));
  // 批量上传：把 chip 画师填进 batchArtistAll
  $('batchUploadModal').addEventListener('click', chipArtistClick('batchArtistAll'));
  $('clearAllBtn').addEventListener('click', clearAll);

  // 导入弹窗：标签页切换
  document.querySelectorAll('.itab').forEach(t => t.addEventListener('click', () => {
    const tab = t.dataset.tab;
    document.querySelectorAll('.itab').forEach(x => x.classList.toggle('active', x === t));
    $('tab-zip').classList.toggle('hidden', tab !== 'zip');
    $('tab-json').classList.toggle('hidden', tab !== 'json');
  }));

  // JSON 导入
  $('importFilePick').addEventListener('click', () => $('importFile').click());
  $('importDoBtn').addEventListener('click', () => {
    const txt = $('importPaste').value.trim();
    if (!txt) { toast('请先粘贴 JSON 或选择文件'); return; }
    importAll(txt); $('importPaste').value = ''; closeModals();
  });

  // ZIP 导入：选择文件 / 拖拽 / 从项目文件夹
  $('zipFilePick').addEventListener('click', () => $('importFile').click());
  $('zipFolderBtn').addEventListener('click', importZipFromFolder);
  const zdz = $('zipDrop');
  ['dragenter', 'dragover'].forEach(ev => zdz.addEventListener(ev, (e) => { e.preventDefault(); zdz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => zdz.addEventListener(ev, (e) => { e.preventDefault(); zdz.classList.remove('drag'); }));
  zdz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importZipFile(f);
  });

  // 统一文件输入：按扩展名区分 ZIP / NAI Vibe / 其他 JSON
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const isZip = /zip/i.test(f.type) || /\.zip$/i.test(f.name);
    const isVibe = /\.naiv4vib(ebundle|e)?$/i.test(f.name) || /^novelai-vibe-transfer/i.test(f.name);
    if (isZip) { await importZipFile(f); }
    else if (isVibe) { await importVibeFile(f); closeModals(); }
    else { await importAll(await f.text()); closeModals(); }
  });

  // 上传：文件选择 / 拖拽
  $('fileInput').addEventListener('change', (e) => handleFiles(e.target.files));
  const dz = $('dropZone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  $('saveArtBtn').addEventListener('click', saveArtwork);

  // 视图切换：画廊 / 画师合集（左栏 [data-view] 通用）
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    viewMode = b.dataset.view;
    artistDrill = null; // 切换视图时退出画师文件夹
    showArtworkView(); // 确保 artworkView 显示 + 同步 #artBtn/#vibeBtn active
    document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x === b));
    renderGallery();
  }));

  // 批量选择：进入 / 退出、全选、清空、批量编辑、删除选中
  $('selectBtn').addEventListener('click', () => { if (selectMode) exitSelect(); else enterSelect(); });
  $('selAll').addEventListener('click', selectAllVisible);
  $('selClear').addEventListener('click', clearSelection);
  $('selectExitBtn').addEventListener('click', exitSelect);
  $('batchEditBtn').addEventListener('click', openBatchModal);
  $('batchDelBtn').addEventListener('click', batchDelete);
  $('batchSaveBtn').addEventListener('click', applyBatchEdit);

  // 手机扫码打开：生成当前工作台网址的二维码
  $('phoneBtn').addEventListener('click', () => { showModal('phoneModal'); renderPhoneQR(); });
  $('phoneIP').addEventListener('input', renderPhoneQR);
  $('phoneCopy').addEventListener('click', () => copyText($('phoneURL').textContent));

  // 搜索 / 筛选（改变条件重置到第 1 页）
  $('search').addEventListener('input', () => { pg.flat = 1; renderGallery(); });
  $('artistFilter').addEventListener('change', () => { pg.flat = 1; renderGallery(); });
  // 多选标签 popover（替代原 tagFilter 单选下拉的 change 事件）
  wireTagFilter();
  $('batchFilter').addEventListener('change', () => { pg.flat = 1; renderGallery(); });

  // 分页控制
  $('pagePrev').addEventListener('click', () => { if (pg[pagerView] > 1) { pg[pagerView]--; renderCurrentPagerView(); } });
  $('pageNext').addEventListener('click', () => { pg[pagerView]++; renderCurrentPagerView(); });
  $('pageSize').addEventListener('change', () => { ps[pagerView] = parseInt($('pageSize').value, 10) || 0; pg[pagerView] = 1; renderCurrentPagerView(); });
  $('pageNums').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) { pg[pagerView] = parseInt(b.dataset.page, 10); renderCurrentPagerView(); }
  });

  // 画廊事件委托
  $('gallery').addEventListener('click', (e) => {
    // —— 画师合集：文件夹导航（返回 / 进入）——
    const back = e.target.closest('[data-artist-back]');
    if (back) { artistDrill = null; pg.drill = 1; renderGallery(); return; }
    // folder-card 上的 📝 / ↗ 按钮：阻止钻入合集，直接打开备注弹窗
    const editArtist = e.target.closest('[data-edit-artist]');
    if (editArtist) { e.stopPropagation(); e.preventDefault(); openArtistMetaModal(editArtist.dataset.editArtist); return; }
    if (e.target.closest('[data-stop-drill]')) { e.stopPropagation(); return; }
    const fol = e.target.closest('[data-open-folder]');
    if (fol) { artistDrill = fol.dataset.openFolder; pg.drill = 1; renderGallery(); return; }
    // —— 选择模式：勾选框 / 点击卡片本体切换选中 ——
    if (selectMode) {
      const cb = e.target.closest('[data-sel]');
      if (cb) { toggleSelect(cb.dataset.sel); return; }
      const card = e.target.closest('.card');
      if (card) {
        const isAction = e.target.closest('[data-del],[data-dl],[data-copypos],[data-copyneg]');
        if (!isAction) { toggleSelect(card.dataset.id); return; }
        // 操作按钮（删除/下载/复制）走下方常规逻辑
      }
    }
    const t = e.target.closest('[data-open],[data-del],[data-dl],[data-copypos],[data-copyneg],[data-filterartist],[data-filtertag],[data-filterbatch],[data-opennote]');
    if (!t) return;
    if (t.dataset.open) openLightbox(t.dataset.open);
    else if (t.dataset.opennote) { e.stopPropagation(); openLightbox(t.dataset.opennote, { openNote: true }); return; }
    else if (t.dataset.del) delArt(t.dataset.del);
    else if (t.dataset.dl) downloadArt(t.dataset.dl);
    else if (t.dataset.copypos) copyText((getArt(t.dataset.copypos) || {}).positive || '');
    else if (t.dataset.copyneg) copyText((getArt(t.dataset.copyneg) || {}).negative || '');
    else if (t.dataset.filterartist) { $('artistFilter').value = t.dataset.filterartist; pg.flat = 1; renderGallery(); }
    else if (t.dataset.filtertag) {
      // 多选标签：点一次加入选中，再点取消
      if (tagFilterSelected.has(t.dataset.filtertag)) tagFilterSelected.delete(t.dataset.filtertag);
      else tagFilterSelected.add(t.dataset.filtertag);
      refreshTagFilter();
      pg.flat = 1;
      renderGallery();
    }
    else if (t.dataset.filterbatch) { $('batchFilter').value = t.dataset.filterbatch; pg.flat = 1; renderGallery(); }
  });

  // 灯箱复制（直接复制 + toast 提示，不弹确认框）
  $('lightbox').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) {
      const id = b.dataset.copy;
      const label = COPY_LABEL[id] || '内容';
      const el = $(id);
      if (!el) return;
      if (!el.value.trim()) { toast(`${label} 是空的，没什么可复制`); return; }
      copyText(el.value);
      toast(`已复制${label} ✓`);
      return;
    }
    const ft = e.target.closest('[data-filtertag]');
    if (ft) {
      if (tagFilterSelected.has(ft.dataset.filtertag)) tagFilterSelected.delete(ft.dataset.filtertag);
      else tagFilterSelected.add(ft.dataset.filtertag);
      refreshTagFilter();
      pg.flat = 1;
      closeModals();
      renderGallery();
    }
  });
  $('lbDownload').addEventListener('click', () => { if (lbCurrent) downloadArt(lbCurrent); });
  // 灯箱内删除当前画作（确认框防误删，delArt 内部已带 confirmModal）
  $('lbDel').addEventListener('click', () => { if (lbCurrent) delArt(lbCurrent); });
  // 给画作换图：与上传一致，支持「点选 / 拖拽 / Ctrl+V 粘贴」
  $('lbImgReplace').addEventListener('click', openReplaceModal);
  $('lbAddImg').addEventListener('click', openReplaceModal);
  $('newTextArtBtn').addEventListener('click', createTextArtwork);
  $('replaceFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = ''; // 重置，允许重复选同一文件
    if (f) await loadReplacePreview(f);
  });
  const rdz = $('replaceDrop');
  ['dragenter', 'dragover'].forEach(ev => rdz.addEventListener(ev, (e) => { e.preventDefault(); rdz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => rdz.addEventListener(ev, (e) => { e.preventDefault(); rdz.classList.remove('drag'); }));
  rdz.addEventListener('drop', async (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await loadReplacePreview(f);
  });
  $('replaceConfirm').addEventListener('click', async () => {
    if (!pendingReplaceFile || !lbCurrent) { toast('请先选一张新图片'); return; }
    const f = pendingReplaceFile;
    $('replaceModal').classList.add('hidden');
    await doReplaceImage(lbCurrent, f);
  });
  $('replaceCancel').addEventListener('click', () => {
    pendingReplaceFile = null;
    $('replacePreview').classList.add('hidden');
  });
  $('lbTagEditBtn').addEventListener('click', () => {
    const a = getArt(lbCurrent); if (!a) return;
    $('lbTagInput').value = getTags(a).join(' ');
    $('lbTagsEdit').classList.remove('hidden');
    $('lbTagInput').focus();
  });
  $('lbTagSave').addEventListener('click', () => { if (lbCurrent) saveArtworkTags(lbCurrent); });
  // 标题（名字）编辑
  $('lbTitleEditBtn').addEventListener('click', () => {
    if (!lbCurrent) return;
    const a = getArt(lbCurrent); if (!a) return;
    $('lbTitleInput').value = a.title || '';
    $('lbTitleEdit').classList.remove('hidden');
    $('lbTitleInput').focus();
  });
  $('lbTitleSave').addEventListener('click', () => { if (lbCurrent) saveArtworkTitle(lbCurrent); });
  $('lbTitleInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lbTitleSave').click(); });
  // 画师编辑
  $('lbArtistEditBtn').addEventListener('click', () => {
    if (!lbCurrent) return;
    const a = getArt(lbCurrent); if (!a) return;
    $('lbArtistInput').value = a.artist || '';
    $('lbArtistEdit').classList.remove('hidden');
    $('lbArtistInput').focus();
  });
  $('lbArtistSave').addEventListener('click', () => { if (lbCurrent) saveArtworkArtist(lbCurrent); });
  $('lbArtistInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lbArtistSave').click(); });
  // 备注编辑
  $('lbNoteEditBtn').addEventListener('click', () => {
    if (!lbCurrent) return;
    const a = getArt(lbCurrent); if (!a) return;
    $('lbNoteInput').value = a.note || '';
    $('lbNoteEdit').classList.remove('hidden');
    $('lbNoteInput').focus();
  });
  $('lbNoteSave').addEventListener('click', () => { if (lbCurrent) saveArtworkNote(lbCurrent); });
  $('lbNoteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('lbNoteSave').click(); });
  // 链接编辑
  $('lbLinkEditBtn').addEventListener('click', () => {
    if (!lbCurrent) return;
    const a = getArt(lbCurrent); if (!a) return;
    $('lbLinkInput').value = a.link || '';
    $('lbLinkEdit').classList.remove('hidden');
    $('lbLinkInput').focus();
  });
  $('lbLinkSave').addEventListener('click', () => { if (lbCurrent) saveArtworkLink(lbCurrent); });
  $('lbLinkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lbLinkSave').click(); });
  $('lbPromptSave').addEventListener('click', async () => {
    if (!lbCurrent) return;
    if (!await confirmModal('确定保存对提示词的修改吗？', false)) return;
    saveArtworkPrompt(lbCurrent);
  });
  $('lbExtractArtist').addEventListener('click', extractArtistChain);
  $('lbChainBack').addEventListener('click', chainBackToPositive);
  $('lbClearArtist').addEventListener('click', () => clearPromptField('artist'));
  $('lbClearPos').addEventListener('click', () => clearPromptField('pos'));
  $('lbClearNeg').addEventListener('click', () => clearPromptField('neg'));
  // （批量提取画师串已移除，保留灯箱单张「🔀 提取」）
  $('lbPos').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('lbPromptSave').click(); });
  $('lbNeg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('lbPromptSave').click(); });

  // Vibe 弹窗
  $('addVibeBtn').addEventListener('click', addVibe);
  $('exportVibeBtn').addEventListener('click', exportVibes);
  // 文本备注表单现在常驻在导入弹窗里，无需显隐按钮
  // 粘贴 JSON 显隐
  $('vibePasteToggle').addEventListener('click', () => {
    $('vibePaste').classList.remove('hidden');
    $('vibePasteRow').classList.remove('hidden');
    $('vibePaste').focus();
  });
  $('vibePasteCancel').addEventListener('click', () => {
    $('vibePaste').classList.add('hidden');
    $('vibePasteRow').classList.add('hidden');
    $('vibePaste').value = '';
  });
  $('vibePasteDo').addEventListener('click', () => {
    const txt = $('vibePaste').value.trim();
    if (!txt) { toast('请先粘贴 JSON'); return; }
    importVibeText(txt);
    $('vibePaste').value = '';
    $('vibePaste').classList.add('hidden');
    $('vibePasteRow').classList.add('hidden');
    $('vibeImportModal').classList.add('hidden');
  });
  // 设置 Vibe 预览图
  $('vbThumbSave').addEventListener('click', saveVibeThumb);
  $('vbThumbRemove').addEventListener('click', removeVibeThumb);
  $('vbThumbFile').addEventListener('change', (e) => { pendingPastedThumb = null; vibeThumbPreviewLocal(e.target.files && e.target.files[0]); });
  // 点击「点击选择图片」触发 file input
  $('vibeThumbPick').addEventListener('click', () => $('vbThumbFile').click());
  // 拖拽进 vibeThumbDrop → 同本地选择效果
  const vtdz = $('vibeThumbDrop');
  ['dragenter', 'dragover'].forEach(ev => vtdz.addEventListener(ev, (e) => { e.preventDefault(); vtdz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => vtdz.addEventListener(ev, (e) => { e.preventDefault(); vtdz.classList.remove('drag'); }));
  vtdz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !f.type.startsWith('image/')) { toast('请拖入图片文件'); return; }
    pendingPastedThumb = null;
    $('vbThumbFile').value = '';
    vibeThumbPreviewLocal(f);
    // 同时把文件挂到 file input 上，方便 saveVibeThumb 拿到（构造一个伪 FileList）
    try { const dt = new DataTransfer(); dt.items.add(f); $('vbThumbFile').files = dt.files; } catch(_) {}
  });
  $('vibeThumbModal').addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          pendingPastedThumb = f;
          $('vbThumbFile').value = '';
          vibeThumbPreviewLocal(f);
        }
        break;
      }
    }
  });
  // 选择文件 / 拖拽导入 .naiv4vib
  $('vibeFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) { await importVibeFile(f); $('vibeImportModal').classList.add('hidden'); }
  });
  const vdz = $('vibeDrop');
  ['dragenter', 'dragover'].forEach(ev => vdz.addEventListener(ev, (e) => { e.preventDefault(); vdz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => vdz.addEventListener(ev, (e) => { e.preventDefault(); vdz.classList.remove('drag'); }));
  vdz.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files || [];
    for (const f of files) {
      // 接受 .naiv4vibe / .naiv4vibebundle（带或不带 .json 后缀）；以及纯 .json 后缀（NAI 偶尔会把 vibe 当 .json 导出）
      if (/\.(naiv4vib(e|ebundle)?)(\.json)?$/i.test(f.name) || /\.json$/i.test(f.name)) importVibeFile(f);
    }
  });
  // Vibe 网格的点击已统一绑定到 #vibeGrid（点卡片 → openVibeDetail）

  // 应用内确认弹窗 按钮
  $('confirmOk').addEventListener('click', () => _resolveConfirm(true));
  $('confirmCancel').addEventListener('click', () => _resolveConfirm(false));
  $('confirmModal').addEventListener('click', (e) => { if (e.target === $('confirmModal')) _resolveConfirm(false); });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target !== m) return;
      if (m.id === 'lightbox') closeModals(); // 点背景关闭：走 closeModals 触发自动保存
      else m.classList.add('hidden');
    });
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 标签多选 popover 开着就先关它
    const pop = $('tagFilterPop');
    if (pop && !pop.classList.contains('hidden')) { closeTagPop(); return; }
    closeModals();
  });
  console.log('WIRE_END dc=' + document.querySelectorAll('[data-close]').length);

  // 直接 Ctrl+V 粘贴图片：灯箱打开时 → 换图；批量上传弹窗打开时 → 批量；否则 → 普通上传
  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          // 灯箱打开中：粘图直接走「换图」流程（与上传一致）
          const lbOpen = !document.getElementById('lightbox').classList.contains('hidden');
          if (lbOpen && lbCurrent) {
            openReplaceModal();
            loadReplacePreview(file);
            break;
          }
          const inBatch = !document.getElementById('batchUploadModal').classList.contains('hidden');
          if (inBatch) handleBatchFiles([file]);
          else { showModal('uploadModal'); handleFiles([file]); }
        }
        break;
      }
    }
  });
}

/* ============ 日 / 夜模式切换 ============ */
const THEME_KEY = 'nai_theme';
function applyTheme(theme) {
  const isNight = theme === 'night';
  // class 放在 <html> 上才能命中 :root.theme-night 选择器
  document.documentElement.classList.toggle('theme-night', isNight);
  const ico = document.querySelector('#themeToggle .theme-ico');
  const txt = document.querySelector('#themeToggle .theme-text');
  if (ico) ico.textContent = isNight ? '🌙' : '👤';
  if (txt) txt.textContent = isNight ? '来色日向' : '来色日间';
  try { localStorage.setItem(THEME_KEY, isNight ? 'night' : 'day'); } catch (e) {}
}
function toggleTheme() {
  applyTheme(document.documentElement.classList.contains('theme-night') ? 'day' : 'night');
}

function showStaticBanner() {
  if (document.getElementById('staticBanner')) return;
  const b = document.createElement('div');
  b.id = 'staticBanner';
  b.className = 'static-banner';
  b.innerHTML = '🌐 静态预览模式（GitHub Pages）：本页仅供查看，你的改动不会保存到仓库。要保存请在电脑端编辑后重发仓库。<button id="sbClose" type="button">知道了</button>';
  document.body.appendChild(b);
  const c = b.querySelector('#sbClose');
  if (c) c.addEventListener('click', () => b.remove());
}

/* ============ 启动 ============ */
async function init() {
  // 先恢复日/夜模式（在渲染前，避免重绘）
  let saved = 'day';
  try { saved = localStorage.getItem(THEME_KEY) || 'day'; } catch (e) {}
  applyTheme(saved);
  STATIC_SITE = !!window.__STATIC__;
  if (STATIC_SITE) showStaticBanner();
  await loadFromAPI();
  if (!usingServer) {
    toast('本地模式：数据存在本浏览器（IndexedDB），双击打开也能用；导入直接生效 ✓');
  }
  refreshFilters();
  refreshBatchFilter();
  renderGallery();
  renderVibes();
  wireEvents();
}
document.addEventListener('DOMContentLoaded', init);
