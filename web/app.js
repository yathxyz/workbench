/* Canvas Workbench prototype.
   One pannable world. Node kinds: term (shell), repl, buffer, ref, agent, frame (a folder: a container that holds items through `in`).
   Edges: spawn (tree lineage), pipe (dataflow), ref (pinned excerpt).
   Runs in two modes: with canvasd (real PTYs) or in-browser demo (simulated shell, JS REPL). */
(() => {
'use strict';
const V = window.V;
const HDR = 30, GRID = 200, LOD_Z = 0.45, LS_KEY = 'canvas-proto-board-v5';
const MONO = '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, monospace';

// ------------------------------------------------------------------ utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }   // text only: markup goes through innerHTML at the few static sites
function svgEl(tag, attrs) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; }
const uid = p => p + Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = motionQuery.matches;
motionQuery.addEventListener?.('change', e => { reduceMotion = e.matches; });

// ------------------------------------------------------------------ state
let S = null;                 // persisted board
const live = {};              // id -> runtime objects (DOM, xterm, CodeMirror view, backend)
let DAEMON = false, BOOTED = false, BOARD_ETAG = null, HUB_STARTED = null, BOARD_CAM;   // BOARD_CAM: the board's stored camera, written back untouched (F-A7)
const SERVED = /^https?:$/.test(location.protocol) && !window.CANVAS_HOSTED;   // served by wb-web: never the demo, never localStorage
let tool = 'select', inkColor = 'ink', penSeen = false, activeId = null, topZ = 10, focusedBuf = null;
const camBack = [], camFwd = [];

const viewport = $('#viewport'), world = $('#world'), framesEl = $('#frames'), nodesEl = $('#nodes');
const edgesSvg = $('#edges'), inkWorld = $('#ink-world'), inkLive = $('#ink-live'), shapesSvg = $('#shapes');
const VW = () => viewport.clientWidth || innerWidth, VH = () => viewport.clientHeight || innerHeight;  // the side pane narrows the canvas
const TODAY = (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());
const clean = name => String(name || '').replace(/[\/›#@]/g, '-').trim() || 'node';

// ------------------------------------------------------------------ tree helpers
function parentOf(id) { const e = S.edges.find(e => e.to === id && e.type === 'spawn'); return e ? e.from : null; }
function pathOf(id) {
  if (id === 'dock') return 'dock';
  const parts = []; let cur = id, guard = 0;
  while (cur && guard++ < 64) { const n = S.nodes[cur]; if (!n) break; parts.unshift(n.name); cur = parentOf(cur); }
  return parts.join('/');
}
function childrenOf(id, type) { return S.edges.filter(e => e.from === id && e.type === type).map(e => S.nodes[e.to]).filter(Boolean); }
const nodeList = () => Object.values(S.nodes).filter(n => n.kind !== 'frame');
const frameList = () => Object.values(S.nodes).filter(n => n.kind === 'frame');

// ------------------------------------------------------------------ camera
const cam = () => S.cam;
function s2w(sx, sy) { return { x: sx / cam().z + cam().x, y: sy / cam().z + cam().y }; }
function w2s(wx, wy) { return { x: (wx - cam().x) * cam().z, y: (wy - cam().y) * cam().z }; }
let lastLod = null, lodTimer = null;
function applyCam() {
  const c = cam();
  world.style.transform = `translate(${-c.x * c.z}px, ${-c.y * c.z}px) scale(${c.z})`;
  world.style.setProperty('--iz', String(1 / c.z)); // folder tabs keep their screen size at every zoom
  let g = 24 * c.z; while (g < 10) g *= 4;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${-c.x * c.z}px ${-c.y * c.z}px`;
  $('#st-zoom').textContent = Math.round(c.z * 100) + '%';
  if (Math.abs(c.z - chromeZ) > chromeZ * 0.04) fitChromeAll(c.z);
  const lod = c.z < LOD_Z;
  if (lod !== lastLod) {
    lastLod = lod;
    world.classList.toggle('far', lod);
    clearInterval(lodTimer);
    if (lod) { refreshSnapshots(); lodTimer = setInterval(refreshSnapshots, 1500); }
    else for (const id in live) { live[id].fitNow?.(); scheduleLineInk(id); }
  }
  if (INK.ids.length) placeInkChip();
  dirtyCam();
}
function zoomAt(sx, sy, f) {
  const w = s2w(sx, sy); const c = cam();
  c.z = clamp(c.z * f, 0.08, 3);
  c.x = w.x - sx / c.z; c.y = w.y - sy / c.z;
  applyCam();
}
let anim = null, animDone = null;
const GLIDE = { raf: 0, ok: false, trail: [] };   // a flicked one-finger pan carrying on; trail: its last moves, [time, x, y]
// A flight follows van Wijk and Nuij's smooth zoom path ("Smooth and efficient zooming and panning", 2003, as d3's
// interpolateZoom): the zoom changes at an even rate on screen, and a long jump at one zoom pulls back and comes
// in again rather than sliding the whole board past. Any hand on the camera (a pan, a pinch, the wheel) ends it.
const RHO = Math.SQRT2;
function zoomPath(cx0, cy0, w0, cx1, cy1, w1) {
  const dx = cx1 - cx0, dy = cy1 - cy0, d2 = dx * dx + dy * dy;
  if (d2 < 1e-6 * w0 * w0) { const S = Math.log(w1 / w0) / RHO; return k => [cx0 + k * dx, cy0 + k * dy, w0 * Math.exp(RHO * k * S)]; }
  const d = Math.sqrt(d2), r2 = RHO * RHO, r4 = r2 * r2;
  const b0 = (w1 * w1 - w0 * w0 + r4 * d2) / (2 * w0 * r2 * d), b1 = (w1 * w1 - w0 * w0 - r4 * d2) / (2 * w1 * r2 * d);
  const r0 = -Math.asinh(b0), r1 = -Math.asinh(b1), S = (r1 - r0) / RHO;   // ln(√(b²+1) − b), without the cancellation
  return k => { const s = k * S, u = w0 / (r2 * d) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0)); return [cx0 + u * dx, cy0 + u * dy, w0 * Math.cosh(r0) / Math.cosh(RHO * s + r0)]; };
}
function animateTo(t, done) {
  camStop(false);
  const c = cam(), T = reduceMotion ? 0 : 380, t0 = performance.now(), W = VW(), H = VH();
  // the path runs on the screen centre and the width of world in view
  const path = zoomPath(c.x + W / 2 / c.z, c.y + H / 2 / c.z, W / c.z, t.x + W / 2 / t.z, t.y + H / 2 / t.z, W / t.z);
  animDone = done || null;
  const step = now => {
    const k = T ? clamp((now - t0) / T, 0, 1) : 1, e = 1 - Math.pow(1 - k, 3);
    if (k < 1) { const [cx, cy, w] = path(e); c.z = W / w; c.x = cx - W / 2 / c.z; c.y = cy - H / 2 / c.z; }
    else { c.x = t.x; c.y = t.y; c.z = t.z; }   // land exactly on the target
    applyCam();
    if (k < 1) anim = requestAnimationFrame(step); else { anim = null; const d = animDone; animDone = null; d?.(); }
  };
  anim = requestAnimationFrame(step);
}
// stop whatever moves the camera on its own (a flight, a glide); a cut-short flight still runs its done step
function camStop(finish = true) {
  if (anim) { cancelAnimationFrame(anim); anim = null; const d = animDone; animDone = null; if (finish) d?.(); }
  if (GLIDE.raf) { cancelAnimationFrame(GLIDE.raf); GLIDE.raf = 0; }
}
function pushHistory() { camBack.push({ ...cam() }); if (camBack.length > 60) camBack.shift(); camFwd.length = 0; }
function camArea() {   // the part of the viewport a fit aims at
  const left = document.body.classList.contains('tree-open') && VW() > 900 ? (S?.treeW || TREE_W) + 16 : 0;  // the folder tree floats over the left edge
  const top = 56, bottom = 34; return { left, top, vw: VW() - left, vh: VH() - top - bottom };
}
const screenAspect = () => { const a = camArea(); return (a.vw * 0.88) / (a.vh * 0.86); };   // w : h of what a workspace fit shows
function camTarget(x, y, w, h, maxZ = 1) {
  const { left, top, vw, vh } = camArea();
  const z = clamp(Math.min(maxZ, vw * 0.88 / w, vh * 0.86 / h), 0.08, 3);
  return { z, x: x + w / 2 - (left + vw / 2) / z, y: y + h / 2 - (top + vh / 2) / z };
}
function fitAll(animate = true) {
  const items = Object.values(S.nodes).filter(n => !stashed(n));
  if (!items.length) return;
  const x0 = Math.min(...items.map(n => n.x)), y0 = Math.min(...items.map(n => n.y - (n.kind === 'frame' ? LABEL_H : 0)));
  const x1 = Math.max(...items.map(n => n.x + n.w)), y1 = Math.max(...items.map(n => n.y + n.h));
  const t = camTarget(x0 - 30, y0 - 30, x1 - x0 + 60, y1 - y0 + 60, 1);
  if (animate) { pushHistory(); animateTo(t); } else { Object.assign(cam(), t); applyCam(); }
}

// ------------------------------------------------------------------ persistence
let saveT = null, camT = null;
let ADOPTING = false;   // applying another tab's board: nothing in it is this tab's edit
function dirty() { if (!S || ADOPTING) return; clearTimeout(saveT); saveT = setTimeout(() => { saveT = null; save(); }, 500); }
// The camera is per device (localStorage wb-cam-<host>), never saved in a served board, so a pan dirties nothing.
const camKey = () => 'wb-cam-' + (INFO?.host || location.host);
function camLoad() { try { const c = JSON.parse(store.get(camKey())); if ([c.x, c.y, c.z].every(Number.isFinite) && c.z > 0) return { x: c.x, y: c.y, z: c.z }; } catch {} return null; }
function dirtyCam() { clearTimeout(camT); camT = setTimeout(() => DAEMON ? store.set(camKey(), JSON.stringify(S.cam)) : dirty(), 400); }
// The view is per device too (localStorage wb-view-<host>, F-A22): the entered workspace, the focus tabs and the
// perspective. The board keeps none of them, and inside a perspective it keeps the manual layout, so another device
// opens the board as it was made.
const VIEW_KEYS = ['ws', 'focusTabs', 'persp', 'manual'];
const viewKey = () => 'wb-view-' + (INFO?.host || location.host);
function viewLoad() { try { const v = JSON.parse(store.get(viewKey())); if (v && typeof v === 'object') return v; } catch {} return null; }
function viewSave() { if (S && BOOTED) store.set(viewKey(), JSON.stringify({ ws: S.ws || null, focusTabs: S.focusTabs || [], persp: perspCur(), desk: DESK.cur, prevDesk: DESK.prev, scratch: DESK.scratch, deskCams: DESK.cams })); }
// Desks (§10.8): the current desk, the one before it, the scratch desks and a camera per desk are this device's. snap is the
// Board's geometry while another desk is shown; mem is that desk's members.
const DESK = { cur: 0, prev: 0, snap: null, mem: new Set(), scratch: [], cams: {}, shapeIn: new Map(), shapeOld: new Set() };
function syncBuffers() {
  for (const n of nodeList()) {
    if (n.kind !== 'buffer' || !live[n.id]?.view) continue;
    const st = live[n.id].view.state, doc = st.doc, f = st.field(anchorField);
    const used = new Set(S.strokes.filter(s => s.owner === n.id && s.aid).map(s => s.aid));
    for (const r of S.nodes ? Object.values(S.nodes) : []) if (r.kind === 'ref' && r.src?.node === n.id && r.src.aid) used.add(r.src.aid);
    n.text = doc.toString();
    n.anchors = Object.entries(f).filter(([id, a]) => a.label || used.has(id)).map(([id, a]) => ({
      id, label: a.label, pos: a.pos, quote: doc.sliceString(a.pos, a.pos + 24), prefix: doc.sliceString(Math.max(0, a.pos - 16), a.pos),
    }));
  }
}
function serialize() {
  syncBuffers(); if (DESK.cur) deskRecord();
  const nodes = manualNodes(), shapes = DESK.snap ? S.shapes.map(sh => { const d = deskShapeDelta(sh); return d ? { ...sh, x: sh.x + d[0], y: sh.y + d[1] } : sh; }) : S.shapes;
  return JSON.stringify(S, function (k, v) {
    if (this === S) { if (VIEW_KEYS.includes(k)) return undefined; if (k === 'nodes') return nodes; if (k === 'shapes') return shapes; if (DAEMON && k === 'cam') return BOARD_CAM; }
    return k.startsWith('_') ? undefined : v;
  });
}
// One PUT in flight: each 204 carries the ETag the next PUT's If-Match needs (30 §2.3).
const SAVE = { busy: false, again: false, paused: null, pending: false, err: 0, theirs: null, lastJson: null, recheck: null, retryT: null, leaving: false, dbQueue: new Set() };
function save() {
  if (!S || !BOOTED) return;
  if (DESK.cur) { deskRecord(); viewSave(); }   // a scratch desk's rectangles live in the view
  if (!DAEMON) return store.set(LS_KEY, serialize());
  if (SAVE.paused) { SAVE.pending = true; if (NET.state === 'signed_out') authBar(); return; }
  if (SAVE.busy) { SAVE.again = true; return; }
  const json = serialize();
  if (json === SAVE.lastJson) { SAVE.pending = false; SAVE.err = 0; barClear('save'); return; }   // nothing to write: a pan, a re-layout that changed nothing, or an edit undone before its retry
  SAVE.busy = true; SAVE.pending = true; clearTimeout(SAVE.retryT);
  fetch('/api/board', { method: 'PUT', redirect: 'manual', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'If-Match': BOARD_ETAG }, body: json })
    .then(async r => {
      if (r.status === 204) { BOARD_ETAG = r.headers.get('ETag'); SAVE.lastJson = json; SAVE.err = 0; SAVE.pending = SAVE.again; barClear('save'); return; }
      if (r.type === 'opaqueredirect' || r.status === 401) { SAVE.paused = 'auth'; return netSet('signed_out'); }
      if (r.status === 412) { SAVE.theirs = (await r.json().catch(() => ({}))).etag; SAVE.paused = 'conflict'; return conflictBar(); }
      throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
    })
    .catch(e => { SAVE.err++; SAVE.again = false; bar('save', 'Board not saved: ' + e.message + '. Retrying…'); SAVE.retryT = setTimeout(save, backoff(SAVE.err)); netKick(); })
    .finally(() => {
      SAVE.busy = false;
      if (SAVE.again && !SAVE.paused) { SAVE.again = false; save(); }
      if (SAVE.recheck) { const e = SAVE.recheck; SAVE.recheck = null; boardChanged(e); }
    });
}
// A change not yet on disk, including one still inside the 500 ms debounce (SAVE.pending misses those).
const changed = () => (saveT !== null || SAVE.pending) && serialize() !== SAVE.lastJson;
const unsaved = () => !!SAVE.paused || changed();
function changeCount() {   // this tab's changes against the board it last loaded or saved
  const a = JSON.parse(serialize()), b = JSON.parse(SAVE.lastJson || '{}'), an = a.nodes || {}, bn = b.nodes || {};
  let c = 0;
  for (const id of new Set([...Object.keys(an), ...Object.keys(bn)])) if (JSON.stringify(an[id]) !== JSON.stringify(bn[id])) c++;
  for (const k of ['edges', 'strokes', 'shapes']) if (JSON.stringify(a[k] || []) !== JSON.stringify(b[k] || [])) c++;
  return c;
}
function conflictBar() {
  const c = changeCount();
  bar('conflict', `The board changed in another tab or device. This tab: ${c} change${c === 1 ? '' : 's'}; server: newer.`, [
    ['Load it', () => { SAVE.leaving = true; location.reload(); }],
    ['Overwrite with this tab', () => { BOARD_ETAG = SAVE.theirs; SAVE.paused = null; SAVE.lastJson = null; barClear('conflict'); save(); dbFlush(); }],
  ]);
}
// /rpc board{etag}: another tab or device saved (F-A7).
async function boardChanged(etag) {
  if (!DAEMON || !BOOTED || etag === BOARD_ETAG) return;   // our own save
  if (SAVE.busy) { SAVE.recheck = etag; return; }          // our PUT's 204 may carry this very ETag
  if (unsaved()) { if (SAVE.paused !== 'auth') { SAVE.theirs = etag; SAVE.paused = 'conflict'; conflictBar(); } return; }
  let b; try { b = await bootFetch('/api/board'); } catch { return netKick(); }
  if (b.etag === BOARD_ETAG || b.body?.v !== 5) return;
  if (unsaved()) { SAVE.theirs = b.etag; SAVE.paused = 'conflict'; return conflictBar(); }
  boardAdopt(b.body); BOARD_ETAG = b.etag;
}
// A clean tab takes another tab's board in place: nodes, links and ink. The camera and the view stay this device's: a tab
// inside a perspective goes back to the manual layout, takes the board, and builds its perspective again over it.
function boardAdopt(b) {
  ADOPTING = true;
  try {
    if (b.manual && b.persp && b.persp !== 'manual') b = { ...b, nodes: manualNodesOf(b.nodes || {}, b.manual) };   // saved inside a perspective by a page from before F-A22
    const p = perspCur(); if (p !== 'manual') { perspClear(); S.persp = 'manual'; }
    const dk = deskAt(DESK.cur); if (dk) deskUnapply();   // the same for a desk: take the Board, then stand the desk up again
    const cur = S.nodes;
    for (const id of Object.keys(cur)) if (!b.nodes?.[id] || b.nodes[id].kind !== cur[id].kind) { unmountQuiet(id); delete cur[id]; }
    for (const [id, nn] of Object.entries(b.nodes || {})) {
      const o = cur[id];
      if (!o) { cur[id] = nn; continue; }
      for (const k of Object.keys(o)) if (!k.startsWith('_') && !(k in nn)) delete o[k];
      Object.assign(o, nn);   // in place: the mounted card's closures hold this object
      const v = live[id]?.view;
      if (o.kind === 'buffer' && v && v.state.doc.toString() !== (o.text || '')) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: o.text || '' } });
    }
    S.edges = b.edges || []; S.strokes = b.strokes || []; S.shapes = b.shapes || []; if (Array.isArray(b.desks)) S.desks = b.desks; else delete S.desks; BOARD_CAM = b.cam;
    deskSlotsFix();
    frameList().filter(f => !live[f.id]).sort((x, y) => depthOf(x) - depthOf(y)).forEach(mount);
    nodeList().filter(n => !live[n.id]).forEach(mount);
    frameList().forEach(placeFrame); nodeList().forEach(place);
    frameList().sort((x, y) => depthOf(y) - depthOf(x)).forEach(f => relayout(f));
    if (p !== 'manual') { perspBuild(p); S.persp = p; perspChip(); wsApply(false); }
    if (dk) { const d = deskList().find(x => x === dk || (deskPinned(x) && x.slot === dk.slot)); if (d) deskApply(d); }   // a pinned desk comes back as the other device saved it
    deskRefresh(true);
    refreshBlockCards();   // a page the other tab removed, restored or rewrote
    restack(); updateAllTitles(); renderTree(); renderLinks(); renderInk(null);
    SAVE.lastJson = serialize();
  } finally { ADOPTING = false; }
}
function unmountQuiet(id) {   // the card went in another tab: drop it here without killing its session
  const L = live[id]; if (!L) return;
  L.backend?.dispose?.(); L.ro?.disconnect(); L.view?.destroy(); L.term?.dispose(); if (L.frame?.contentWindow) HOSTS.delete(L.frame.contentWindow);
  L.el.remove(); delete live[id];
}

// ------------------------------------------------------------------ toast, ask, copy
let toastT = null;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

// ------------------------------------------------------------------ connection state, alert bar, sessions (30 §0)
const backoff = n => { const d = Math.min(30000, 500 * 2 ** Math.min(n, 6)); return d / 2 + Math.random() * d / 2; };   // equal jitter
const NET = { state: 'up', hub: null, tries: 0, probing: null, since: 0, timer: null };
const WAKE = new Set();   // parked until the network or the hub is back: PTY backends and the RPC socket, each with .wake()
const SIGN_IN = '/oauth2/sign_in?rd=%2Ficon.svg';   // signs in in a new tab and lands on a harmless static file
const hhmm = t => new Date(t).toTimeString().slice(0, 5);
function netKick() { if (!DAEMON) return; return NET.probing || (NET.probing = netProbe().finally(() => { NET.probing = null; })); }
async function netProbe() {
  let r;
  try { r = await fetch('/api/info', { redirect: 'manual', cache: 'no-store' }); } catch { return netSet(navigator.onLine === false ? 'offline' : 'down'); }
  if (r.type === 'opaqueredirect' || r.status === 401) return netSet('signed_out');
  if (r.status === 403) return netSet('forbidden');
  let info = null; if (r.ok) try { info = await r.json(); } catch {}
  if (!info) return netSet('down');
  Object.assign(INFO, info); hubSeen(info.hub); acpButton(); netSet('up');
}
function netSet(s) {
  const was = NET.state; NET.state = s; clearTimeout(NET.timer);
  if (s !== was) NET.since = Date.now();
  if (s === 'up') {
    if (was !== 'up') {
      NET.tries = 0; barClear('auth'); barClear('forbidden'); wakeAll();
      if (SAVE.paused === 'auth') { SAVE.paused = null; save(); dbFlush(); }
    }
  } else if (s === 'down' || s === 'offline') NET.timer = setTimeout(netKick, backoff(NET.tries++));
  else if (s === 'signed_out') {
    if (!SAVE.paused) SAVE.paused = 'auth';
    authBar();
    NET.timer = setTimeout(netKick, 5000);
  } else if (s === 'forbidden') { bar('forbidden', 'This account has no access to Workbench (403).', [['Retry', () => netKick()]]); NET.timer = setTimeout(netKick, 30000); }
  netChip();
}
function authBar() {
  const since = changed() ? 'changes since ' + hhmm(NET.since) + ' are not saved yet' : 'nothing is lost yet';
  bar('auth', 'Signed out: ' + since + '.', [['Sign in', SIGN_IN], ['Reload (unsaved changes are lost)', () => { SAVE.leaving = true; location.reload(); }]]);
}
function wakeAll() { for (const w of [...WAKE]) w.wake(); }
addEventListener('online', () => { wakeAll(); netKick(); });
addEventListener('focus', () => { if (NET.state !== 'up') netKick(); const L = live[activeId]; if (L?.term) L.backend?.resize?.(L.term.cols, L.term.rows); L?.backend?.maybeSeen?.(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wakeAll(); if (NET.state !== 'up') netKick(); live[activeId]?.backend?.maybeSeen?.(); } });
addEventListener('beforeunload', e => { if (DAEMON && !SAVE.leaving && SAVE.pending && (SAVE.paused || SAVE.err)) { e.preventDefault(); e.returnValue = ''; } });
// One persistent strip; only the highest-priority key shows. A string action starting with / is a link.
const BARS = {}, BAR_ORDER = ['auth', 'forbidden', 'conflict', 'save', 'hub'];
function bar(key, text, actions = []) { BARS[key] = { text, actions }; barRender(); }
function barClear(key) { if (BARS[key]) { delete BARS[key]; barRender(); } }
function barRender() {
  const b = $('#bar'), k = BAR_ORDER.find(x => BARS[x]);
  b.hidden = !k; if (!k) return;
  b.dataset.key = k; b.classList.toggle('bad', k !== 'save');
  $('.msg', b).textContent = BARS[k].text;
  $('.acts', b).replaceChildren(...BARS[k].actions.map(([label, act]) => {
    if (typeof act === 'string') { const a = el('a', '', label); a.href = act; a.target = '_blank'; a.rel = 'noopener'; return a; }
    const btn = el('button', '', label); btn.onclick = act; return btn;
  }));
}
// Session facts from /rpc: sessions replaces, session upserts, gone deletes and leaves a tombstone (§3.5.3).
const SESS = {}, TOMBS = new Set();
function sessChanged(sid) { if (S?.nodes[sid]) { updateTitle(S.nodes[sid]); live[sid]?.backend?.refresh?.(); } clearTimeout(sessChanged.t); sessChanged.t = setTimeout(sessShown, 250); }
// The Folders tree, the outline and the navigator show each agent card's state (30 §1.6): redraw them only when one
// changed, since a running card's info arrives every 500 ms and a redraw replaces the rows under the pointer.
function sessShown() {
  statusRender();
  const shown = S ? nodeList().filter(n => n.kind === 'acp').map(n => n.id + ' ' + badgeOf(n) + ' ' + SESS[n.id]?.state).join('\n') : '';
  if (shown === sessShown.last) return;
  sessShown.last = shown; renderTree();
  if (VIEW === 'outline') renderOutline(); else if (VIEW === 'ranger') renderRanger();
}
function sessPut(x) { if (x?.sid && !TOMBS.has(x.sid + ' ' + x.createdAt)) { SESS[x.sid] = x; sessChanged(x.sid); } }
const RPC_EVENTS = {
  hub: m => hubStatus(m),
  sessions: m => { for (const k in SESS) delete SESS[k]; (m.sessions || []).forEach(sessPut); statusRender(); },
  session: m => sessPut(m.session),
  gone: m => {
    TOMBS.add(m.sid + ' ' + m.epoch);
    if (SESS[m.sid]?.createdAt === m.epoch) delete SESS[m.sid];
    live[m.sid]?.backend?.goneElsewhere?.(m.epoch); sessChanged(m.sid);
  },
  board: m => boardChanged(m.etag),
};
// Hub status (30 §3.3).
function hubStatus(m) {
  const was = NET.hub?.status; NET.hub = m;
  if (m.status === 'down') bar('hub', 'The Workbench hub is down: shells and agents are unavailable.');
  else if (m.status === 'incompatible') bar('hub', 'The hub is older than this web version. Restart workbench-hub (this ends all shells and agents).');
  else if (m.status === 'up' && (was === 'down' || was === 'incompatible')) { barClear('hub'); for (const w of [...WAKE]) if (w.waitHub) w.wake(); netKick(); }
  netChip();
}
function hubSeen(hub) {
  if (!hub?.startedAt) return;   // a probe while the hub is down must not forget the start time its return is compared with
  if (HUB_STARTED && hub.startedAt !== HUB_STARTED) toast('The Workbench hub restarted at ' + hhmm(hub.startedAt) + ': shells and agents ended. Enter restarts a shell; ↻ revives an agent.', 8000);
  HUB_STARTED = hub.startedAt;
}
function netChip() {
  const c = $('#st-net'); if (!c) return;
  const s = NET.state, h = NET.hub?.status;
  const [text, cls, title] =
    s === 'down' || s === 'offline' ? ['reconnecting…', 'warn', (s === 'offline' ? 'Offline' : 'Server unreachable') + ' since ' + hhmm(NET.since)] :
    s === 'signed_out' ? ['signed out', 'bad', 'Click to sign in (opens a new tab)'] :
    s === 'forbidden' ? ['no access', 'bad', 'This account has no access to Workbench (403)'] :
    h === 'down' ? ['hub down', 'bad', 'The Workbench hub is down'] :
    h === 'incompatible' ? ['hub needs restart', 'bad', 'The hub is older than this web version'] :
    NET.hub?.stale ? ['⟳', 'dim', 'hub update pending; restart workbench-hub when convenient (ends all sessions)'] : [null];
  c.hidden = !text; if (!text) return;
  c.textContent = text; c.className = 'stc ' + cls; c.title = title;
  c.onclick = s === 'signed_out' ? () => window.open(SIGN_IN, '_blank', 'noopener') : null;
}
// Boot fetches (30 §2.2): a manual redirect is how an expired sign-in shows up.
async function bootFetch(path) {   // throws {kind, status?}
  let r; try { r = await fetch(path, { redirect: 'manual', cache: 'no-store' }); } catch { throw { kind: 'net' }; }
  if (r.type === 'opaqueredirect' || r.status === 401) throw { kind: 'signed_out' };
  if (r.status === 403) throw { kind: 'forbidden' };
  if (!r.ok) throw { kind: 'http', status: r.status };
  if (!/^application\/json\b/i.test(r.headers.get('content-type') || '')) throw { kind: 'not_json' };
  try { return { body: await r.json(), etag: r.headers.get('ETag') }; } catch { throw { kind: 'not_json' }; }
}
let bootTries = 0, bootTimer = null;
function bootScreen(e) {
  const m = $('#boot-msg'), retry = () => { clearInterval(bootTimer); m.hidden = true; boot(); };
  const auto = e.kind === 'net' || (e.kind === 'http' && e.status >= 500);
  const [title, text, acts] =
    e.kind === 'signed_out' ? ['Signed out', 'Sign in again to open the board.', [['Sign in', () => location.reload()]]] :
    e.kind === 'forbidden' ? ['No access', 'This account has no access to Workbench (403).', [['Retry', retry]]] :
    e.kind === 'not_json' ? ['Not a board', 'The server answered with something that is not a board. Nothing was changed.', [['Retry', retry]]] :
    e.kind === 'format' ? ['Unknown board', `Board format not recognised (v=${e.v}); nothing was changed.`, [['Retry', retry]]] :
    auto ? ['Workbench server unreachable', '', [['Retry now', retry]]] :
    ['Error ' + e.status, 'The server refused to load the board.', [['Retry', retry]]];
  m.dataset.kind = e.kind; $('h2', m).textContent = title; $('p', m).textContent = text;
  $('.acts', m).replaceChildren(...acts.map(([label, fn]) => { const b = el('button', '', label); b.onclick = fn; return b; }));
  m.hidden = false; clearInterval(bootTimer);
  if (auto) {
    let left = Math.ceil(backoff(bootTries++) / 1000);
    const tick = () => { if (left <= 0) return retry(); $('p', m).textContent = `Retrying in ${left--} s.`; };
    tick(); bootTimer = setInterval(tick, 1000);
  }
}
function copyText(text) {
  const ok = () => toast('Copied: ' + text);
  try { navigator.clipboard.writeText(text).then(ok, () => toast(text, 6000)); } catch { toast(text, 6000); }
}
let askCb = null;
function ask(label, value, cb) {
  $('#ask-label').textContent = label; const i = $('#ask-in'); i.value = value || ''; askCb = cb;
  $('#ask').hidden = false; i.focus(); i.select();
}
$('#ask-form').addEventListener('submit', e => { e.preventDefault(); const v = $('#ask-in').value.trim(); $('#ask').hidden = true; const cb = askCb; askCb = null; if (v && cb) cb(v); });
function confirmDel(btn, fn) {
  if (btn.classList.contains('armed')) { fn(); return; }
  btn.classList.add('armed'); btn.title = 'Click again to delete';
  setTimeout(() => btn.classList.remove('armed'), 2200);
}

// ------------------------------------------------------------------ CodeMirror anchors
// Anchors are document positions mapped through every edit, so they survive typing.
// Labeled anchors render as chips; unlabeled ones hold ink and reference cards to their text.
const anchorAdd = V.StateEffect.define(), anchorDel = V.StateEffect.define();
class AnchorWidget extends V.WidgetType {
  constructor(label) { super(); this.label = label; }
  eq(o) { return o.label === this.label; }
  toDOM() { const s = document.createElement('span'); s.className = 'anchor-chip'; s.textContent = '⚓' + this.label; return s; }
}
const anchorField = V.StateField.define({
  create: () => ({}),
  update(val, tr) {
    let out = val;
    if (tr.docChanged) { out = {}; for (const k in val) out[k] = { ...val[k], pos: tr.changes.mapPos(val[k].pos, 1) }; }
    for (const e of tr.effects) {
      if (e.is(anchorAdd)) out = { ...out, [e.value.id]: { pos: e.value.pos, label: e.value.label } };
      if (e.is(anchorDel)) { out = { ...out }; delete out[e.value]; }
    }
    return out;
  },
  provide: f => V.EditorView.decorations.from(f, val => V.Decoration.set(
    Object.values(val).filter(a => a.label).map(a => V.Decoration.widget({ widget: new AnchorWidget(a.label), side: -1 }).range(a.pos)), true)),
});
function relocate(doc, a) {
  if (a.quote) {
    for (const [needle, off] of [[(a.prefix || '') + a.quote, (a.prefix || '').length], [a.quote, 0]]) {
      let best = -1, bd = Infinity, i = doc.indexOf(needle);
      while (i >= 0) { const p = i + off, d = Math.abs(p - (a.pos || 0)); if (d < bd) { bd = d; best = p; } i = doc.indexOf(needle, i + 1); }
      if (best >= 0) return best;
    }
  }
  return clamp(a.pos || 0, 0, doc.length);
}
const bufTheme = V.EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--buf-bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55' },
  '.cm-content': { padding: '8px 0 40px' },
  '.cm-gutters': { backgroundColor: 'var(--buf-bg)', color: 'var(--muted)', border: 'none', opacity: '.7' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--cursor)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--sel) !important' },
  '.cm-foldGutter': { display: 'none' },
});
const T = V.tags;
const bufHighlight = V.HighlightStyle.define([
  { tag: [T.heading1, T.heading2, T.heading3, T.heading4, T.heading], color: 'var(--heading)', fontWeight: '600' },
  { tag: T.heading1, fontSize: '1.18em' },
  { tag: T.emphasis, fontStyle: 'italic' },
  { tag: T.strong, fontWeight: '600' },
  { tag: [T.link, T.url], color: 'var(--link)' },
  { tag: T.monospace, color: 'var(--code)' },
  { tag: [T.processingInstruction, T.list, T.quote, T.meta, T.contentSeparator], color: 'var(--muted)' },
  // code: Modus's mappings (keyword, string, comment, builtin, function name, variable, constant, type, docstring)
  { tag: [T.keyword, T.controlKeyword, T.definitionKeyword, T.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [T.string, T.special(T.string), T.regexp], color: 'var(--syn-string)' },
  { tag: [T.comment, T.lineComment, T.blockComment], color: 'var(--syn-comment)' },
  { tag: [T.docString, T.docComment], color: 'var(--syn-docstring)' },
  { tag: [T.standard(T.name), T.standard(T.variableName)], color: 'var(--syn-builtin)' },
  { tag: [T.function(T.variableName), T.function(T.definition(T.variableName)), T.function(T.propertyName)], color: 'var(--syn-fnname)' },
  { tag: T.definition(T.variableName), color: 'var(--syn-variable)' },
  { tag: [T.constant(T.name), T.constant(T.variableName), T.bool, T.null, T.atom], color: 'var(--syn-constant)' },
  { tag: [T.typeName, T.className, T.namespace], color: 'var(--syn-type)' },
]);

// ------------------------------------------------------------------ addresses
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function colIndex(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function frameAt(x, y) { return frameList().filter(f => !stashed(f) && x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null; }
function canvasAddr(x, y) {
  const f = frameAt(x, y);
  if (f) return `${f.name}/${colName(Math.floor((x - f.x) / GRID))}${Math.floor((y - f.y) / GRID) + 1}`;
  return `@${Math.round(x)},${Math.round(y)}`;
}
function nodeAt(x, y) {
  let best = null, bz = -1;
  for (const n of nodeList()) {
    if (!stashed(n) && x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) { const z = +live[n.id]?.el.style.zIndex || 0; if (z >= bz) { bz = z; best = n; } }
  }
  return best;
}
// Buffer address: heading path + paragraph number + a short quote. Readable, sayable, survives line shifts.
function bufferAddress(n, state, pos) {
  const doc = state.doc, ln = doc.lineAt(pos).number;
  let stack = [], para = 0, inPara = false, isHeading = false;
  for (let i = 1; i <= ln; i++) {
    const t = doc.line(i).text, m = t.match(/^(#{1,6})\s+(.*)$/);
    if (m) { const lvl = m[1].length; stack = stack.filter(s => s.lvl < lvl); stack.push({ lvl, title: m[2].trim() }); para = 0; inPara = false; isHeading = i === ln; continue; }
    isHeading = false;
    if (!t.trim()) { inPara = false; continue; }
    if (!inPara || /^\s*([-*+]|\d+\.)\s/.test(t)) { para++; inPara = true; }
  }
  const line = doc.lineAt(pos), off = pos - line.from;
  let start = off; while (start > 0 && /\S/.test(line.text[start - 1])) start--;
  let quote = line.text.slice(start).replace(/^[#>*\-\s]+/, '').split(/\s+/).slice(0, 3).join(' ').slice(0, 28).replace(/"/g, '');
  if (!line.text.trim()) quote = '';
  let h1s = 0; for (let i = 1; i <= doc.lines && h1s < 2; i++) if (/^#\s/.test(doc.line(i).text)) h1s++;
  if (h1s === 1 && stack[0]?.lvl === 1 && (stack.length > 1 || stack[0].title.toLowerCase() === n.name.toLowerCase())) stack = stack.slice(1);  // a single H1 is the document title
  return { name: n.name, path: stack.map(s => s.title), para: isHeading ? 0 : para, quote };
}
function fmtAddr(a) { return [a.name, ...a.path].join(' › ') + (a.para ? ` ¶${a.para}` : '') + (a.quote ? ` "${a.quote}"` : ''); }
function resolveBufferAddress(q) {
  const parts = q.split('›').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const last = parts.pop().match(/^(.*?)\s*(?:¶\s*(\d+))?\s*(?:"([^"]*)"?)?$/);
  if (last && last[1]) parts.push(last[1]);
  const para = last && last[2] ? +last[2] : 0, quote = last ? last[3] || '' : '';
  const name = (parts.shift() || '').toLowerCase();
  const n = nodeList().find(x => x.kind === 'buffer' && x.name.toLowerCase() === name) || nodeList().find(x => x.kind === 'buffer' && x.name.toLowerCase().startsWith(name));
  if (!n || !live[n.id]?.view) return null;
  const doc = live[n.id].view.state.doc;
  let from = 1, to = doc.lines, lvl = 0;
  for (const title of parts) {
    let found = false;
    for (let i = from; i <= to; i++) {
      const m = doc.line(i).text.match(/^(#{1,6})\s+(.*)$/);
      if (m && m[1].length > lvl && m[2].trim().toLowerCase().startsWith(title.toLowerCase())) {
        lvl = m[1].length; from = i + 1; let j = i + 1;
        while (j <= doc.lines) { const mm = doc.line(j).text.match(/^(#{1,6})\s/); if (mm && mm[1].length <= lvl) break; j++; }
        to = j - 1; found = true; break;
      }
    }
    if (!found) break;
  }
  let pos = doc.line(clamp(from - 1, 1, doc.lines)).from, pFrom = from, pTo = to;
  if (para) {
    let k = 0, inP = false;
    for (let i = from; i <= to; i++) {
      const t = doc.line(i).text;
      if (/^#{1,6}\s/.test(t)) { k = 0; inP = false; continue; }
      const bullet = /^\s*([-*+]|\d+\.)\s/.test(t);
      if (!t.trim() || (bullet && inP && k === para)) { if (inP && k === para) { pTo = i - 1; break; } inP = false; if (!t.trim()) continue; }
      if (!inP || bullet) { k++; inP = true; if (k === para) { pos = doc.line(i).from; pFrom = i; } }
    }
  }
  if (quote) {
    const scopes = [[pFrom, pTo], [from, to], [1, doc.lines]];
    for (const [a, b] of scopes) {
      const s = doc.line(clamp(a, 1, doc.lines)).from, e = doc.line(clamp(b, 1, doc.lines)).to;
      const i = doc.sliceString(s, e).toLowerCase().indexOf(quote.toLowerCase());
      if (i >= 0) { pos = s + i; break; }
    }
  }
  return { node: n, pos };
}

// ------------------------------------------------------------------ backends
class LineEditor {
  constructor(term, promptFn, onLine) { this.t = term; this.p = promptFn; this.on = onLine; this.buf = ''; this.hist = []; this.hi = 0; }
  prompt() { this.buf = ''; this.t.write(this.p()); }
  redraw() { this.t.write('\r\x1b[2K' + this.p() + this.buf); }
  feed(data) {
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (c === '\x1b') {
        const seq = data.slice(i, i + 3);
        if (seq === '\x1b[A' && this.hist.length) { this.hi = Math.max(0, this.hi - 1); this.buf = this.hist[this.hi] || ''; this.redraw(); }
        else if (seq === '\x1b[B') { this.hi = Math.min(this.hist.length, this.hi + 1); this.buf = this.hist[this.hi] || ''; this.redraw(); }
        i += 2; continue;
      }
      if (c === '\r') { this.t.write('\r\n'); const line = this.buf; this.buf = ''; if (line.trim()) this.hist.push(line); this.hi = this.hist.length; this.on(line); continue; }
      if (c === '\x7f' || c === '\b') { if (this.buf) { this.buf = this.buf.slice(0, -1); this.t.write('\b \b'); } continue; }
      if (c === '\x03') { this.t.write('^C\r\n'); this.prompt(); continue; }
      if (c === '\x0c') { this.t.clear(); this.redraw(); continue; }
      if (c === '\n' || c < ' ') continue;
      this.buf += c; this.t.write(c);
    }
  }
}

// Simulated shell over an in-memory file system shared by all demo shells.
function seedFs() {
  const d = c => ({ t: 'd', c }), f = s => ({ t: 'f', d: s });
  return d({
    home: d({ me: d({
      projects: d({ canvas: d({ 'README.md': { t: 'f', d: '# canvas\nA spatial workbench.\n', ino: 77 }, daemon: d({ 'canvasd.py': f('# pty + board store\n') }), web: d({ 'app.js': f('// the canvas\n') }) }) }),
      'todo.txt': f('buy pens\nwire Jupyter kernels\n'),
      'canvas-readme.md': { t: 'f', d: '# canvas\nA spatial workbench.\n', ino: 77 },   // a hard link to projects/canvas/README.md: one inode, two names
      notes: { t: 'l', d: '/home/me/projects/canvas' },
    }) }),
    mnt: d({ data: { t: 'd', c: { 'models': d({}) }, mount: true } }),
    tmp: d({}),
  });
}
function fsNlink(ino) { let k = 0; const walk = d => { for (const v of Object.values(d.c || {})) { if (v.ino === ino) k++; if (v.t === 'd') walk(v); } }; walk(S.fs); return k; }
function fsResolve(cwd, p) {
  if (!p) return cwd;
  let parts = p.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
  if (p === '~' || p.startsWith('~/')) { parts = ['home', 'me']; p = p.slice(1); }
  for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return '/' + parts.join('/');
}
function fsGet(path) { let cur = S.fs; for (const seg of path.split('/').filter(Boolean)) { if (!cur || cur.t !== 'd') return null; cur = cur.c[seg]; } return cur || null; }
function fsParent(path) { const parts = path.split('/').filter(Boolean); const name = parts.pop(); return [fsGet('/' + parts.join('/')), name]; }

class FakeShell {
  constructor(n, term) {
    this.n = n; this.t = term; n.cwd = n.cwd || '/home/me'; n.env = n.env || {};
    this.le = new LineEditor(term, () => this.promptStr(), line => this.run(line));
    term.write('\x1b[2m' + (DAEMON ? 'Simulated shell (made in demo mode). ' : 'Simulated shell in your browser. Serve the page from wb-web for real ones. ') + 'Type help.\x1b[0m\r\n');
    if (n.spawnNote) term.write('\x1b[38;5;179m⑂ ' + n.spawnNote + '\x1b[0m\r\n');
    this.le.prompt();
  }
  promptStr() {
    const h = '/home/me', c = this.n.cwd.startsWith(h) ? '~' + this.n.cwd.slice(h.length) : this.n.cwd;
    return `\x1b[38;5;179m${pathOf(this.n.id)}\x1b[0m \x1b[38;5;110m${c}\x1b[0m $ `;
  }
  input(d) { this.le.feed(d); }
  w(s) { if (s) this.t.write(s.replace(/\n/g, '\r\n') + (s.endsWith('\n') ? '' : '\r\n')); }
  run(line) {
    activity(this.n.id);
    let out;
    try { out = this.exec(line.trim()); } catch (e) { out = String(e.message || e); }
    this.w(out); this.le.prompt(); dirty();
  }
  exec(line) {
    if (!line) return '';
    let redir = null, append = false;
    const m = line.match(/^(.*?)\s*(>>?)\s*(\S+)$/);
    if (m && !/^["']/.test(m[3])) { line = m[1]; append = m[2] === '>>'; redir = m[3]; }
    const env = this.n.env;
    const args = (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^["']|["']$/g, '').replace(/\$(\w+)/g, (_, k) => env[k] ?? (k === 'HOME' ? '/home/me' : k === 'PWD' ? this.n.cwd : '')));
    const cmd = args.shift();
    let out = this.command(cmd, args);
    if (redir) {
      const p = fsResolve(this.n.cwd, redir), [dir, name] = fsParent(p);
      if (!dir || dir.t !== 'd') return `${redir}: no such directory`;
      const prev = dir.c[name]?.t === 'f' ? dir.c[name].d : '';
      dir.c[name] = { t: 'f', d: (append ? prev : '') + (out.endsWith('\n') || !out ? out : out + '\n') };
      out = '';
    }
    return out;
  }
  command(cmd, a) {
    const cwd = this.n.cwd;
    switch (cmd) {
      case 'help': return 'Simulated commands: ls cd pwd cat echo mkdir touch rm tree export env whoami where history clear date\nBranch this node with ⑂: the child starts in the same folder with the same env.';
      case 'pwd': return cwd;
      case 'cd': { const p = fsResolve(cwd, a[0] || '~'); const d = fsGet(p); if (!d || d.t !== 'd') return `cd: ${a[0]}: no such directory`; this.n.cwd = p; cwdMoved(this.n); return ''; }
      case 'ls': {
        const d = fsGet(fsResolve(cwd, a.find(x => !x.startsWith('-')))); if (!d) return `ls: ${a[0]}: not found`;
        if (d.t === 'f') return a[0];
        return Object.keys(d.c).sort().map(k => d.c[k].t === 'd' ? `\x1b[38;5;110m${k}/\x1b[0m` : k).join('  ');
      }
      case 'cat': return a.map(p => { const f = fsGet(fsResolve(cwd, p)); return f?.t === 'f' ? f.d.replace(/\n$/, '') : `cat: ${p}: no such file`; }).join('\n');
      case 'echo': return a.join(' ');
      case 'mkdir': for (const p of a.filter(x => !x.startsWith('-'))) { const [d, n] = fsParent(fsResolve(cwd, p)); if (d?.t === 'd' && !d.c[n]) d.c[n] = { t: 'd', c: {} }; } return '';
      case 'touch': for (const p of a) { const [d, n] = fsParent(fsResolve(cwd, p)); if (d?.t === 'd' && !d.c[n]) d.c[n] = { t: 'f', d: '' }; } return '';
      case 'rm': for (const p of a.filter(x => !x.startsWith('-'))) { const [d, n] = fsParent(fsResolve(cwd, p)); if (d?.c[n]) delete d.c[n]; } return '';
      case 'tree': {
        const lines = [], walk = (d, pre) => Object.keys(d.c).sort().forEach((k, i, arr) => {
          const last = i === arr.length - 1; lines.push(pre + (last ? '└─ ' : '├─ ') + k + (d.c[k].t === 'd' ? '/' : ''));
          if (d.c[k].t === 'd') walk(d.c[k], pre + (last ? '   ' : '│  '));
        });
        const d = fsGet(fsResolve(cwd, a[0])); if (!d || d.t !== 'd') return 'tree: not a directory';
        lines.push('.'); walk(d, ''); return lines.join('\n');
      }
      case 'export': for (const kv of a) { const i = kv.indexOf('='); if (i > 0) this.n.env[kv.slice(0, i)] = kv.slice(i + 1); } return '';
      case 'env': return Object.entries({ CANVAS_NODE: pathOf(this.n.id), PWD: cwd, ...this.n.env }).map(([k, v]) => `${k}=${v}`).join('\n');
      case 'whoami': return `${pathOf(this.n.id)}  (node ${this.n.id})`;
      case 'where': return `${canvasAddr(this.n.x + 10, this.n.y + 10)}  ·  ${pathOf(this.n.id)}`;
      case 'history': return this.le.hist.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n');
      case 'clear': this.t.clear(); return '';
      case 'date': return new Date().toString();
      default: return `${cmd}: not available in the simulated shell (wb-web serves real ones)`;
    }
  }
}

function fmtVal(v) {
  try {
    if (typeof v === 'function') return 'ƒ ' + (v.name || 'anonymous');
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    return JSON.stringify(v) ?? String(v);
  } catch { return String(v); }
}
// JavaScript REPL: each node owns a hidden iframe, so each has its own global scope.
// History is replayed on load and on branch, which is the cheap, deterministic way to fork state.
class JsRepl {
  constructor(n, term) {
    this.n = n; this.t = term; n.history = n.history || [];
    this.frame = document.createElement('iframe'); this.frame.style.display = 'none'; this.frame.setAttribute('aria-hidden', 'true');
    document.body.append(this.frame);
    this.win = this.frame.contentWindow; this.quiet = false;
    try { this.win.console.log = (...a) => { if (!this.quiet) this.print(a.map(x => typeof x === 'string' ? x : fmtVal(x)).join(' ')); }; } catch {}
    this.le = new LineEditor(term, () => '\x1b[38;5;179m' + pathOf(n.id) + ' ›\x1b[0m ', line => this.exec(line));
    term.write('\x1b[2mJavaScript REPL in your browser. Each node has its own globals.\x1b[0m\r\n');
    if (n.history.length) {
      this.quiet = true; let ok = 0; for (const l of n.history) if (this.evalQuiet(l)) ok++; this.quiet = false;
      this.le.hist = [...n.history]; this.le.hi = n.history.length;
      term.write(`\x1b[38;5;179m↺ replayed ${ok} line(s)${n.replayFrom ? ' inherited from ' + n.replayFrom : ''}; ↑ shows them\x1b[0m\r\n`);
    }
    this.le.prompt();
  }
  evalJs(code) { return this.win.eval(code.replace(/^\s*(let|const)\s+/, 'var ')); }
  evalQuiet(l) { try { this.evalJs(l); return true; } catch { return false; } }
  exec(line) {
    if (!line.trim()) { this.le.prompt(); return; }
    activity(this.n.id); this.n.history.push(line);
    try { this.print('\x1b[38;5;110m' + fmtVal(this.evalJs(line)) + '\x1b[0m'); }
    catch (e) { this.print('\x1b[31m' + (e && e.name === 'EvalError' ? 'This page blocks eval. Run the prototype locally for the REPL.' : String(e)) + '\x1b[0m'); }
    this.le.prompt(); dirty();
  }
  print(s) { this.t.write(String(s).replace(/\n/g, '\r\n') + '\r\n'); }
  input(d) { this.le.feed(d); }
  kill() { this.frame.remove(); }
}

// Real PTY through canvasd. The daemon keeps the session alive across reloads and replays recent output.
// A real shell on the server (/pty, §3.5.1). Nothing auto-runs: `spawn` is true only on the first open of a card made in
// this page and on Enter on an ended or not-found card, and only until that open is sent; page loads and reconnects attach
// with `resume` (SEC-2, F-A6).
const IN_CHUNK = 262144;   // characters per `in` message: worst-case JSON escaping stays under the web's message cap
const EXIT_TEXT = {
  hub_restart: 'the Workbench hub restarted: press Enter to start a new shell',
  killed: 'process killed: press Enter to start a new one',
  spawn_failed: 'could not start: press Enter to try again',
};
// Board, server or host text written into a terminal: control characters show escaped, so the text cannot rewrite the
// prompt it sits in (SEC-2), and a long value is cut with a visible mark.
function plain(s) {
  const t = String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}
// A card's shell is a name in the hub's syntax for one (DELTA-1 §B.5); anything else on a board is never shown or sent.
const shellName = n => /^[a-z0-9-]{1,32}$/.test(n.shell || '') ? n.shell : '';
class PtyBackend {
  constructor(n, term, L) { this.n = n; this.t = term; this.L = L; this.spawn = !!n._spawn; delete n._spawn; this.tries = 0; this.connect(); }
  openMsg() {
    const n = this.n, m = { t: 'open', id: n.id, cmd: n.cmd || '', parent: n.spawnFrom || '', cwd: n.cwd || '', tmux: n.tmux || '', cols: this.t.cols, rows: this.t.rows, env: { CANVAS_NODE: pathOf(n.id), ...(n.env || {}) }, spawn: this.spawn };
    if (this.spawn && shellName(n)) m.shell = n.shell;
    if (!this.spawn && this.resume) m.resume = this.resume;
    return JSON.stringify(m);
  }
  connect() {
    if (this.disposed) return;
    clearTimeout(this.timer); WAKE.delete(this); this.waitHub = false;
    const h = this.host = this.n.hostUrl ? hostByUrl(this.n.hostUrl) : hostOf(this.n);   // a process stays on the host it started on
    if (h) { this.n.hostUrl = h.url; rpcFor(h); } else delete this.n.hostUrl;
    this.parked = false; this.final = false; this.helloSeen = false;
    const ws = this.ws = new WebSocket(hWs(h, '/pty'));
    ws.onopen = () => { ws.send(this.openMsg()); this.spawn = false; if (h) { this.tries = 0; hostUp(h); } };   // a reconnect never spawns
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') {
        this.dead = false; this.exitReason = null; this.helloSeen = true; this.tries = 0; this.epoch = m.epoch;
        this.final = false;   // a respawn on the socket a failed open left open is live again
        this.L?.el.classList.remove('net-wait');
        if (m.stream != null) this.resume = { stream: m.stream, out: m.out };
        if (m.tmux) { if (this.n.tmuxSess !== m.tmux || !!this.n.tmuxAdopted !== !!m.adopted) { this.n.tmuxSess = m.tmux; this.n.tmuxAdopted = !!m.adopted; retag(this.n); } if (m.attached && m.cwd) this.n.cwdLive = m.cwd; }
        if (m.new) {
          if (this.lost || (this.helloed && !this.respawning)) this.t.write('\r\n\x1b[33m[new shell: the server had no session for this card]\x1b[0m\r\n');
          if (this.n._replay) {   // set only by spawnChild in this page, never saved: a board cannot type into a new shell
            const r = this.n._replay; delete this.n._replay;
            setTimeout(() => { this.t.write('\x1b[38;5;179m↺ replaying the parent’s input\x1b[0m\r\n'); this.send(r); }, 800);
          }
        } else if (m.resumed) this.t.write(m.replay || '');   // the ring tail after our offset: the scrollback stays
        else { this.t.reset(); this.t.write(m.replay || ''); }
        this.helloed = true; this.respawning = false; this.lost = false;
      } else if (m.t === 'out') { this.t.write(m.d); if (m.out != null && this.resume) this.resume.out = m.out; activity(this.n.id); }
      else if (m.t === 'fg') { if (this.n.fg !== m.comm) { this.n.fg = m.comm; retag(this.n); } if (m.cwd && this.n.cwdLive !== m.cwd) { this.n.cwdLive = m.cwd; cwdMoved(this.n); } }
      else if (m.t === 'exit') {
        this.dead = true; this.exitReason = m.reason || null;
        const how = m.code != null ? ` with code ${m.code}` : m.signal ? ` (signal ${m.signal})` : '';
        this.t.write('\r\n\x1b[2m[' + (EXIT_TEXT[m.reason] || `process exited${how}: press Enter to start a new one`) + ']\x1b[0m\r\n');
      } else if (m.t === 'gone') this.goneElsewhere(m.epoch);
      else if (m.t === 'error') {
        if (!this.helloSeen) this.final = true;   // a failed open: the server closes 1000, nothing to reconnect to (F-A4)
        this.dead = true;
        if (m.code === 'not_found') {
          const env = Object.keys(this.n.env || {});   // a board's env changes what starts too (PROMPT_COMMAND, BASH_ENV)
          this.lost = true; this.t.write(`\r\n\x1b[33m[No session: press Enter to start ${plain(this.n.cmd || shellName(this.n) || 'a shell')}${env.length ? ' with env ' + plain(env.join(' ')) : ''}]\x1b[0m\r\n`);
        }
        else if (m.code === 'bad_request' && shellName(this.n) && INFO?.defaultShell && /^shell .* not available/.test(m.error || '')) this.offerDefault();
        else this.t.write('\r\n\x1b[31m' + plain(m.error) + '\x1b[0m\r\n');
      }
    };
    ws.onclose = ev => {
      if (this.disposed || ws !== this.ws) return;
      if (h) {
        hostDown(h);
        if (hostAuto(this.n)) { this.tries = (this.tries || 0) + 1; setTimeout(() => this.connect(), Math.min(15000, 1200 * 2 ** Math.min(this.tries, 4))); }
        else { this.parked = true; this.t.write(`\r\n\x1b[2m[@${plain(h.name)} is unreachable. ↻ on the folder tab, or entering the workspace, reconnects.]\x1b[0m\r\n`); }
        return;
      }
      // §3.5.4: 1000/1008/1009 are final and keep the card's state; 1013 waits for the hub; the rest back off.
      if (this.final || [1000, 1008, 1009].includes(ev.code)) {
        this.final = true;
        if (ev.code === 1008 || ev.code === 1009) this.t.write(`\r\n\x1b[31m[connection closed: ${ev.code === 1009 ? 'message too big' : 'protocol error'} (${ev.code}): press Enter to reopen]\x1b[0m\r\n`);
        else if (!this.dead) this.t.write('\r\n\x1b[2m[connection closed: press Enter to start a new shell]\x1b[0m\r\n');
        this.dead = true; this.L?.el.classList.remove('net-wait');
        return;
      }
      this.L?.el.classList.add('net-wait'); WAKE.add(this);
      if (ev.code === 1013) { this.waitHub = true; this.timer = setTimeout(() => this.wake(), 30000); return; }
      netKick();
      if (NET.state !== 'signed_out' && NET.state !== 'forbidden') this.timer = setTimeout(() => this.connect(), backoff(this.tries++));
    };
  }
  wake() { if (!this.disposed && !this.final && !this.host && this.ws?.readyState > 1) { this.tries = 0; this.connect(); } }
  reconnect() { if (this.parked && !this.disposed) { this.tries = 0; this.connect(); } }
  // /rpc or /pty `gone`: the session was ended in another tab or by wb; never reconnect or respawn on our own (ROB-19)
  goneElsewhere(epoch) {
    if (epoch != null && this.epoch != null && epoch !== this.epoch) return;
    if (this.final) return;
    this.final = true; this.dead = true; clearTimeout(this.timer); WAKE.delete(this); this.L?.el.classList.remove('net-wait');
    this.t.write('\r\n\x1b[2m[this session was ended elsewhere: press Enter to start a new one]\x1b[0m\r\n');
    try { this.ws?.close(); } catch {}
  }
  offerDefault() { this.shellOffer = true; this.t.write(`\r\n\x1b[33m[the shell ${shellName(this.n)} is not available here: press Enter to start ${plain(INFO.defaultShell)}]\x1b[0m\r\n`); }
  // Enter on an ended or not-found card: an explicit spawn with the card's shell, or the default one the card offered
  respawn() {
    if (!this.shellOffer && shellName(this.n) && INFO?.shells && INFO.defaultShell && !INFO.shells.includes(this.n.shell)) return this.offerDefault();
    if (this.shellOffer) { this.shellOffer = false; this.n.shell = INFO.defaultShell; updateTitle(this.n); dirty(); }
    this.dead = false; this.respawning = true; this.spawn = true;
    // after a failed open the server is closing this socket (1000), so the spawn needs a new one
    if (this.ws?.readyState === 1 && !this.final) { this.ws.send(this.openMsg()); this.spawn = false; } else this.connect();
  }
  send(d) {
    if (this.ws?.readyState !== 1) return;
    for (let i = 0; i < d.length;) {
      let j = Math.min(d.length, i + IN_CHUNK);
      if (j < d.length && /[\ud800-\udbff]/.test(d[j - 1])) j--;   // never split a surrogate pair
      this.ws.send(JSON.stringify({ t: 'in', d: d.slice(i, j) })); i = j;
    }
  }
  input(d) {
    if (this.dead) { if (d === '\r') this.respawn(); return; }
    if (this.n.kind === 'repl') { this.n.inputLog = ((this.n.inputLog || '') + d).slice(-20000); dirty(); }
    this.send(d);
  }
  // only the tab the user is looking at sizes the PTY (ROB-8): the active card, or a terminal holding the keyboard (the dock is never a card)
  resize(cols, rows) { if (this.ws?.readyState === 1 && document.visibilityState === 'visible' && document.hasFocus() && (activeId === this.n.id || this.L?.body?.contains(document.activeElement))) this.ws.send(JSON.stringify({ t: 'resize', cols, rows })); }
  // the card goes: a wb-* tmux session dies with it, an adopted one is only detached (the daemon decides); detachOnly forces a detach.
  // Without an open socket the kill waits for the server; a connecting socket is dropped before it can send its open.
  kill() {
    this.disposed = true; clearTimeout(this.timer); WAKE.delete(this);
    const session = this.detachOnly ? false : undefined;
    if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify({ t: 'kill', session })); setTimeout(() => this.ws?.close(), 50); }
    else { try { this.ws?.close(); } catch {} new Reap('/pty', { t: 'open', id: this.n.id, spawn: false }, { t: 'kill', session }, undefined, this.host); }
  }
  // the card went in another tab: close here, the session is not ours to end
  dispose() { this.disposed = true; clearTimeout(this.timer); WAKE.delete(this); try { this.ws?.close(); } catch {} }
  // end the process (session=true also kills a tmux session) but keep the card: it shows the exit and Enter starts anew
  end(session) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'kill', session })); }
}
// ------------------------------------------------------------------ agent cards: the `acp` kind (30 §1, DESIGN §3.5.2)
// Agent output is untrusted. Every string from the agent, its tool calls and its requests reaches the page through
// textContent (el()), never innerHTML. URLs stay text; only an https: one opens, and only on an explicit click (F-A19).
const PROMPT_MAX = 8388608;   // bytes of UTF-8 in one prompt's blocks (F-A17)
const ACP_STATES = new Set(['idle', 'running', 'waiting_permission', 'waiting_input', 'done', 'error', 'exited', 'detached']);
const ACP_BAD = new Set(['waiting_permission', 'waiting_input', 'error']);
const CHUNK_KIND = { user_message_chunk: 'user', agent_message_chunk: 'asst', agent_thought_chunk: 'thought' };
const TOOL_GLYPH = { pending: '○', in_progress: '◐', completed: '✓', failed: '✗' };
const PLAN_GLYPH = { pending: '○', in_progress: '◐', completed: '●' };
const agentLabel = name => (INFO?.agents || []).find(a => a.name === name)?.label || name || 'agent';
const vtext = v => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const blockText = b => !b || typeof b !== 'object' ? '' : b.type === 'text' ? vtext(b.text) : b.type === 'image' ? '[image]' : b.type === 'audio' ? '[audio]'
  : b.type === 'resource_link' ? vtext(b.name || b.uri) : b.type === 'resource' ? vtext(b.resource?.uri) : '';
const urlHost = u => { try { return new URL(u).host || 'the page'; } catch { return 'the page'; } };
class AcpBackend {
  constructor(n, L) {
    this.n = n; this.L = L; this.spawn = !!n._spawn; delete n._spawn;   // spawn fields only for a card made in this page (SEC-2)
    this.seq = 0; this.epoch = null; this.sum = null; this.session = {}; this.tries = 0; this.rid = 0; this.rids = new Map();
    this.items = []; this.changed = new Set(); this.byMsg = new Map(); this.byTool = new Map(); this.pending = new Map(); this.waiting = new Map();
    this.panels = new Map(); this.draft = null; this.seenSent = 0;
    this.connect();
  }
  get dead() { return this.gone || this.missing || !this.sum?.alive; }
  get parked() { return false; }
  state() { return this.gone || this.missing ? 'exited' : ACP_STATES.has(this.sum?.state) ? this.sum.state : ''; }
  stateText() { return this.restarting ? 'ending…' : this.gone ? 'ended' : this.missing ? 'no session' : (this.sum?.state || '…').replace(/_/g, ' '); }
  promptable() { return !this.dead && !this.sum.fault && this.sum.acp?.activity === 'none' && this.draft == null && this.replayed && this.ws?.readyState === 1; }
  modeNow() { return this.modeSeen ?? (this.sum?.acp?.modeId || this.session.modes?.currentModeId || ''); }   // the agent's latest word wins
  mode() { return this.modeWanted ?? this.modeNow(); }
  connect() {
    if (this.disposed) return;
    clearTimeout(this.timer); WAKE.delete(this);
    this.waitHub = false; this.final = false; this.opened = false; this.helloSeen = false; this.replayed = false;   // per connection (F-A4)
    const n = this.n, ws = this.ws = new WebSocket(hWs(null, '/acp'));
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'open', id: n.id, since: this.seq, ...(this.spawn ? { agent: n.agent, cwd: n.cwd } : this.epoch != null ? { epoch: this.epoch } : {}) }));
      this.opened = true;
    };
    ws.onmessage = ev => { if (ws !== this.ws) return; let m; try { m = JSON.parse(ev.data); } catch { return; } this.onMessage(m); };
    ws.onclose = ev => { if (ws === this.ws) this.onClose(ev); };
    this.schedule();
  }
  onMessage(m) {
    if (m.t === 'hello') {
      const info = m.info || {};
      this.helloSeen = true; this.tries = 0; this.spawn = false; this.missing = false; this.gone = false; this.failed = null;
      this.L.el.classList.remove('net-wait');
      if (m.reset) this.clear();   // F-A1: transcript, pending and cursor, before the replay
      if (info.createdAt !== this.epoch) this.seenSent = 0;
      this.epoch = info.createdAt ?? null;   // F-A2: sent on reopen, permission and elicitation
      if (m.from > this.seq + 1) this.add({ k: 'note', text: '… earlier messages not shown (replay truncated)' });
      // An answer may have been lost with the old socket: what the hub still holds can be answered again, the rest is gone
      const held = new Set((Array.isArray(info.acp?.pending) ? info.acp.pending : []).map(x => x?.req));
      for (const [req, p] of this.pending) if (held.has(req)) p.sent = false; else this.pending.delete(req);
      this.setInfo(info);
    } else if (m.t === 'ev') this.fold(m.ev);
    else if (m.t === 'replayed') { this.seq = Math.max(this.seq, m.head || 0); this.replayed = true; if (this.draft != null) this.draftBack(); this.schedule(); }
    else if (m.t === 'info') this.setInfo(m.info || {});
    else if (m.t === 'error') this.onError(m);
    else if (m.t === 'gone') this.goneElsewhere(m.epoch);
  }
  onError(m) {
    const ctx = m.rid != null ? this.rids.get(m.rid) : null, name = this.n.name, why = vtext(m.error) || vtext(m.code);
    if (ctx) this.rids.delete(m.rid);
    if (!this.helloSeen && !ctx) {   // a failed open: the web closes 1000 and nothing reconnects (F-A4)
      this.final = true;
      if (m.code === 'not_found' || this.spawn) this.missing = true;   // a spawning open that failed left no session either
      this.failed = m.code === 'not_found' ? null : why;
      return this.schedule();
    }
    if (ctx?.t === 'kill' && this.restarting) {
      if (m.code === 'not_found') return this.renew();   // already forgotten: start the new session straight away
      this.restarting = false;
    }
    if (m.code === 'stale') toast(name + ': this request belongs to an ended session');
    else if (m.code === 'already_resolved') toast(name + ': already answered elsewhere');
    else if (ctx) toast(name + ': ' + why);
    else this.add({ k: 'note', cls: 'err', text: why });
    const p = ctx?.req != null && ctx.epoch === this.epoch ? this.pending.get(ctx.req) : null;
    if (p) { if (m.code === 'stale' || m.code === 'already_resolved') this.pending.delete(ctx.req); else p.sent = false; }
    if (ctx?.t === 'prompt') this.draftBack();
    if (ctx?.t === 'set_mode') this.modeWanted = null;
    this.schedule();
  }
  onClose(ev) {
    if (this.disposed) return;
    if (this.restarting && ev.code === 1000) return this.renew();   // the kill-forget finished: a new session (F-A3)
    this.restarting = false; this.replayed = false;
    // §3.5.4: 1000/1008/1009 are final and keep the card's state; 1013 waits for the hub; the rest back off.
    if (this.final || this.gone || [1000, 1008, 1009].includes(ev.code)) {
      this.final = true; WAKE.delete(this); this.L.el.classList.remove('net-wait');
      if (ev.code === 1008 || ev.code === 1009) this.failed = 'connection closed: ' + (ev.code === 1009 ? 'message too big' : 'protocol error') + ' (' + ev.code + ')';
      else if (!this.missing && !this.gone && !this.failed) this.failed = 'connection closed';
      if (this.draft != null) this.draftBack();
      return this.schedule();
    }
    this.L.el.classList.add('net-wait'); WAKE.add(this); this.schedule();
    if (ev.code === 1013) { this.waitHub = true; this.timer = setTimeout(() => this.wake(), 30000); return; }
    netKick();
    if (NET.state !== 'signed_out' && NET.state !== 'forbidden') this.timer = setTimeout(() => this.connect(), backoff(this.tries++));
  }
  wake() { if (!this.disposed && !this.final && this.ws?.readyState > 1) { this.tries = 0; this.connect(); } }
  reconnect() { if (!this.disposed && this.ws?.readyState > 1) { this.tries = 0; this.failed = null; this.connect(); } }
  // /rpc or /acp `gone`: the session was forgotten in another tab or by wb; never respawn on our own (ROB-19)
  goneElsewhere(epoch) {
    if (this.disposed || this.restarting || this.gone) return;
    if (epoch != null && (epoch === this.ended || (this.epoch != null && epoch !== this.epoch))) return;   // F-A3: our own restart's old epoch
    this.gone = true; this.final = true; clearTimeout(this.timer); WAKE.delete(this); this.L.el.classList.remove('net-wait');
    try { this.ws?.close(); } catch {}
    if (this.draft != null) this.draftBack();
    this.schedule();
  }
  setInfo(info) {
    const { session, ...sum } = info;
    if (session) this.session = session;
    this.sum = sum; sessPut(sum); this.schedule();
  }
  refresh() {   // sessChanged: /rpc may carry a fresher summary of the same incarnation
    const s = SESS[this.n.id]; if (s && s.createdAt === this.epoch) this.sum = s;
    this.schedule(); this.maybeSeen();
  }
  send(m, ctx, early) {   // early: also before this connection's hello, for requests the epoch guards
    if (!this.opened || this.ws?.readyState !== 1 || !(early || this.helloSeen)) return false;
    if (ctx) { m.rid = ++this.rid; this.rids.set(m.rid, ctx); if (this.rids.size > 100) this.rids.delete(this.rids.keys().next().value); }
    this.ws.send(JSON.stringify(m)); return true;
  }
  prompt(text, composer) {   // throws when it cannot be sent, so dispatchTask reports it before it writes session::
    const blocks = [{ type: 'text', text }];
    if (new TextEncoder().encode(JSON.stringify(blocks)).length > PROMPT_MAX) throw new Error(this.n.name + ': the prompt is over 8 MiB');
    if (!this.promptable()) {
      const s = this.sum;
      throw new Error(this.n.name + (this.dead ? ' is not running' : s.fault ? ' has a fault: ' + vtext(s.fault.message) : s.acp?.activity !== 'none' || this.draft != null ? ' is busy' : ' is not connected'));
    }
    this.send({ t: 'prompt', blocks }, { t: 'prompt' });
    if (composer) this.draft = text;   // F-A5: the composer keeps the text until this prompt's echo
    this.schedule();
  }
  submit() { const text = this.L.ta.value; if (!text.trim() || this.draft != null) return; try { this.prompt(text, true); } catch (e) { toast(e.message); } }
  input(d) {   // duck typing: a trailing \r prompts (or throws); anything else drafts into the composer
    if (!d.endsWith('\r')) { this.L.ta.value += d; return; }
    this.prompt(d.slice(0, -1));
  }
  echoed() { this.draft = null; this.L.ta.value = ''; }
  draftBack() { this.draft = null; this.schedule(); }   // the text never left the composer
  cancel() { this.send({ t: 'cancel' }); }
  setMode(modeId) { if (this.send({ t: 'set_mode', modeId }, { t: 'set_mode' })) this.modeWanted = modeId; else toast(this.n.name + ': not connected'); this.schedule(); }
  revive() { if (!this.send({ t: 'revive' }, { t: 'revive' })) toast(this.n.name + ': not connected'); }
  authenticate(methodId) { if (!this.send({ t: 'authenticate', methodId }, { t: 'authenticate' })) toast(this.n.name + ': not connected'); }
  answer(req, t, body, p, ep) {   // p, ep: the request and the incarnation its panel was rendered from (ROB-2)
    if (this.pending.get(req) !== p || ep !== this.epoch || p.sent) return;
    if (this.gone || this.missing) { this.pending.delete(req); this.schedule(); return toast(this.n.name + ': this request belongs to an ended session'); }
    if (!this.send({ t, req, epoch: ep, ...body }, { t, req, epoch: ep }, true)) return toast(this.n.name + ': not connected');
    p.sent = true; this.schedule();
  }
  answerPermission(req, optionId, p, ep) { this.answer(req, 'permission', { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }, p, ep); }
  answerElicitation(req, response, p, ep) { this.answer(req, 'elicitation', { response }, p, ep); }
  // Start new session (F-A3): forget this one, wait for the close 1000, then open a new one with the spawn fields
  restart() {
    if (this.restarting || this.disposed) return;
    if (this.gone || this.missing) return this.renew();
    if (!this.send({ t: 'kill', forget: true }, { t: 'kill' })) return toast(this.n.name + ': not connected; reconnect first');
    this.restarting = true; this.ended = this.epoch; this.schedule();
  }
  renew() {
    const old = this.ws; this.ws = null; try { old?.close(); } catch {}
    this.restarting = false; this.missing = false; this.gone = false; this.failed = null; this.sum = null; this.session = {}; this.draft = null;
    this.clear(); this.spawn = true; this.tries = 0; this.connect();
  }
  end() { this.send({ t: 'kill', forget: false }, { t: 'end' }); }   // the card stays, detached and revivable
  // The card goes: forget the session. Without an open socket the kill waits for the server (as for PTY cards).
  kill() {
    if (this.disposed) return;
    const ws = this.ws, epoch = this.epoch, ended = this.gone || this.missing;
    if (!ended && this.opened && ws?.readyState === 1) {
      this.stop(); ws.send(JSON.stringify({ t: 'kill', forget: true }));
      setTimeout(() => { try { ws.close(); } catch {} }, 5000);   // the web closes 1000 after the ok; the hub has the kill either way
      return;
    }
    this.dispose();
    if (!ended) new Reap('/acp', { t: 'open', id: this.n.id, since: this.seq }, { t: 'kill', forget: true }, m => epoch == null || m.info?.createdAt === epoch);
  }
  stop() { this.disposed = true; clearTimeout(this.timer); WAKE.delete(this); cancelAnimationFrame(this.raf); }
  dispose() { this.stop(); try { this.ws?.close(); } catch {} }   // the card went in another tab: close here, the session is not ours to end
  maybeSeen() {   // seen only when the user can see the result (§3.4.6)
    const s = this.sum, a = s?.acp;
    if (!a || activeId !== this.n.id || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if ((s.state !== 'done' && s.state !== 'error') || a.headSeq <= a.seenSeq || this.seenSent >= a.headSeq) return;
    if (this.send({ t: 'seen', seq: a.headSeq })) this.seenSent = a.headSeq;
  }
  text(max = 40) {   // the transcript's last lines as plain text: read_node, snapshots, the navigator
    const out = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < max; i--) {
      const it = this.items[i], t = it.k === 'user' ? '› ' + it.text : it.k === 'asst' ? it.text : it.k === 'note' ? '· ' + it.text
        : it.k === 'tool' ? '⚙ ' + (vtext(it.kind) || 'tool') + ' ' + vtext(it.title) + ' [' + vtext(it.status) + ']' : '';
      if (t) out.unshift(...t.split('\n').slice(-(max - out.length)));
    }
    return out.join('\n');
  }
  clear() {   // the panels go at once: no button of the old incarnation survives until the next frame
    this.items = []; this.changed.clear(); this.byMsg.clear(); this.byTool.clear(); this.pending.clear(); this.waiting.clear();
    for (const P of this.panels.values()) P.remove();
    this.panels.clear();
    this.seq = 0; this.cleared = true; this.authNeeded = false; this.modeSeen = undefined;
  }
  add(it) { this.items.push(it); this.changed.add(it); return it; }
  fold(ev) {
    if (!ev || !(ev.seq > this.seq)) return;   // the cursor: an event never applies twice
    this.seq = ev.seq;
    try { this.apply(ev); } catch (e) { console.warn('acp: event ' + ev.seq + ' not shown', e); }
    this.schedule();
  }
  apply(ev) {
    switch (ev.e) {
      case 'prompt': {
        const text = (Array.isArray(ev.prompt) ? ev.prompt : []).map(blockText).join('');
        this.add({ k: 'user', text, closed: true });
        if (this.draft != null && text === this.draft) this.echoed();
        break;
      }
      case 'update': this.update(ev.update || {}); break;
      case 'turn_end': this.add(ev.stopReason === 'end_turn' ? { k: 'sep' } : { k: 'note', text: 'stopped: ' + vtext(ev.stopReason) }); break;
      case 'turn_error': this.add({ k: 'note', cls: 'err', text: 'turn failed: ' + vtext(ev.message) }); break;
      case 'setup_error':
        this.add({ k: 'note', cls: 'err', text: (ev.code === 'revive_failed' ? 'could not revive: ' : 'setup failed: ') + vtext(ev.message) });
        if (ev.code === 'auth_required') this.authNeeded = true;
        break;
      case 'permission':
        this.pending.set(ev.seq, { kind: 'permission', toolCall: ev.toolCall && typeof ev.toolCall === 'object' ? ev.toolCall : {}, options: Array.isArray(ev.options) ? ev.options : [] });
        if (ev.toolCall?.toolCallId != null) this.tool(ev.toolCall);
        break;
      case 'permission_resolved': {
        const p = this.pending.get(ev.req), o = ev.outcome || {}, opt = p?.options.find(x => x?.optionId === o.optionId), by = ev.by && ev.by !== 'user' ? ' (by ' + vtext(ev.by) + ')' : '';
        this.pending.delete(ev.req);
        const verb = /^allow/.test(vtext(opt?.kind)) ? 'allowed' : /^reject/.test(vtext(opt?.kind)) ? 'rejected' : 'answered';
        this.add({ k: 'note', text: o.outcome === 'selected' ? verb + ': ' + vtext(opt?.name || o.optionId) + by : 'permission cancelled' + by });
        break;
      }
      case 'elicitation': this.pending.set(ev.seq, { kind: 'elicitation', request: ev.request && typeof ev.request === 'object' ? ev.request : {} }); break;
      case 'elicitation_resolved': {
        const q = this.pending.get(ev.req)?.request || {}, r = ev.response || {}, by = ev.by && ev.by !== 'user' ? ' (by ' + vtext(ev.by) + ')' : '';
        this.pending.delete(ev.req);
        if (q.mode === 'url' && r.action === 'accept') { const host = urlHost(q.url); this.waiting.set(vtext(q.elicitationId), this.add({ k: 'note', text: 'waiting for ' + host + '…', host })); }
        else this.add({ k: 'note', text: 'question ' + ({ accept: 'answered', decline: 'declined', cancel: 'cancelled' }[r.action] || 'answered') + by });
        break;
      }
      case 'elicitation_complete': {
        const id = vtext(ev.elicitationId), it = this.waiting.get(id);
        if (it) { this.waiting.delete(id); it.text = it.host + ': completed'; this.changed.add(it); } else this.add({ k: 'note', text: 'completed' });
        break;
      }
      case 'spawn': this.authNeeded = false; this.add({ k: 'note', text: ev.via === 'revive' ? 'agent restarted to revive the session' : 'agent started' }); break;
      case 'session': this.authNeeded = false; this.add({ k: 'note', text: ev.via === 'load' ? 'resumed via load' : ev.via === 'resume' ? 'resumed' : 'session ready' }); break;
      case 'authenticate': this.add({ k: 'note', text: 'authenticating…' }); break;
      case 'mode': this.modeSeen = vtext(ev.modeId); this.add({ k: 'note', text: 'mode: ' + vtext((this.session.modes?.availableModes || []).find(x => x?.id === ev.modeId)?.name || ev.modeId) }); break;
      case 'notice': this.add({ k: 'note', cls: ev.level === 'error' ? 'err' : ev.level === 'warn' ? 'warn' : '', text: vtext(ev.text) }); break;
      case 'exit': this.add({ k: 'note', text: 'agent exited' + (ev.reason ? ' (' + vtext(ev.reason) + ')' : '') }); break;
    }
  }
  update(u) {
    const k = CHUNK_KIND[u.sessionUpdate];
    if (k) {   // a chunk joins the open item of its kind and messageId, else the last item when neither has one
      const mid = u.messageId == null ? null : vtext(u.messageId), key = k + '\n' + mid, last = this.items[this.items.length - 1];
      let it = mid != null ? this.byMsg.get(key) : last?.k === k && last.mid == null && !last.closed ? last : null;
      if (!it) { it = this.add({ k, text: '', mid }); if (mid != null) this.byMsg.set(key, it); }
      it.text += blockText(u.content); this.changed.add(it);
      return;
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') this.tool(u);
    else if (u.sessionUpdate === 'plan') this.session = { ...this.session, plan: { entries: Array.isArray(u.entries) ? u.entries : [] } };
    else if (u.sessionUpdate === 'current_mode_update') this.modeSeen = vtext(u.currentModeId);
  }
  tool(u) {   // tool_call and tool_call_update merge into one item per toolCallId; content replaces (ACP)
    const id = vtext(u.toolCallId); let it = this.byTool.get(id);
    if (!it) { it = this.add({ k: 'tool', id, status: 'pending' }); this.byTool.set(id, it); }
    for (const f of ['title', 'kind', 'status', 'content', 'locations']) if (u[f] != null) it[f] = u[f];
    this.changed.add(it);
  }
  schedule() { if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  render() {
    const L = this.L, log = L.logEl; if (this.disposed || !log) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (this.cleared) { this.cleared = false; log.replaceChildren(); }
    for (const it of this.changed) { if (!it.el) log.append(it.el = acpItemEl(it)); acpFill(it); }
    this.changed.clear();
    if (stick) log.scrollTop = log.scrollHeight;
    this.renderPlan(); this.renderPending(); this.paint();
  }
  renderPlan() {
    const box = $('.ag-plan', this.L.body), es = Array.isArray(this.session.plan?.entries) ? this.session.plan.entries : [], key = JSON.stringify(es);
    if (key === this.planKey) return; this.planKey = key;
    box.hidden = !es.length;
    let d = box.firstChild; if (!d) { d = el('details'); d.open = true; box.append(d); }
    const st = e => (PLAN_GLYPH[e?.status] ? e.status : 'pending');
    d.replaceChildren(el('summary', '', 'Plan ' + es.filter(e => e?.status === 'completed').length + '/' + es.length), ...es.map(e => el('div', 'pe ' + st(e), PLAN_GLYPH[st(e)] + ' ' + vtext(e?.content))));
  }
  renderPending() {
    const box = $('.ag-pend', this.L.body), sp = this.stateSpec(), key = sp ? sp.key : '';
    if (key !== this.stateKey) { this.stateKey = key; acpStatePanel($('.ag-state', box), sp, this); }
    for (const [req, P] of this.panels) if (!this.pending.has(req)) { P.remove(); this.panels.delete(req); }
    for (const [req, p] of this.pending) {   // one panel per request, in req order; a kept panel keeps a half-filled form
      let P = this.panels.get(req);
      if (!P) {
        P = p.kind === 'permission' ? this.permPanel(req, p) : this.elicitPanel(req, p); this.panels.set(req, P);
        const next = [...this.panels].filter(([r]) => r > req).sort((a, b) => a[0] - b[0])[0];
        box.insertBefore(P, next ? next[1] : null);
      }
      P.classList.toggle('sent', !!p.sent);
    }
  }
  stateSpec() {
    const s = this.sum, a = s?.acp, renew = ['Start new session', () => this.restart(), 'go'];
    const runs = 'Start new session runs ' + agentLabel(this.n.agent) + ' in ' + (vtext(this.n.cwd) || '(no folder)') + '.';
    if (this.restarting) return { key: 'ending', text: 'Ending the session…' };
    if (this.gone) return { key: 'gone', text: 'This session was ended elsewhere.', hint: runs, acts: [renew] };
    if (this.missing) return { key: 'missing ' + this.failed, text: this.failed ? 'Could not open the session: ' + this.failed : 'No session for this card.', hint: runs, acts: [renew] };
    if (this.failed) return { key: 'failed ' + this.failed, text: this.failed[0].toUpperCase() + this.failed.slice(1) + '.', acts: [['Reconnect', () => this.reconnect(), 'go']] };
    if (!s) return null;
    if (s.fault) {
      const ended = !s.alive && !a?.revivable;   // F-A16, e.g. a quarantined load_failed session
      return { key: 'fault ' + ended + ' ' + s.fault.message, text: 'Fault: ' + vtext(s.fault.message), ...(ended ? { hint: runs, acts: [renew] } : {}) };
    }
    if (!s.alive && !a?.revivable) return { key: 'ended', text: 'The session ended and cannot be revived.', hint: runs, acts: [renew] };   // F-A16
    if (this.authNeeded && s.alive && a?.activity === 'none') return { key: 'auth ' + JSON.stringify(this.session.authMethods), auth: true, text: agentLabel(this.n.agent) + ' needs a login.', acts: [renew] };
    return null;
  }
  permPanel(req, p) {
    const tc = p.toolCall, d = el('div', 'ag-perm'), h = el('div', 'ph'), ep = this.epoch;
    h.append(el('b', '', 'Permission'), el('span', 'tt', vtext(tc.title) || 'tool call')); if (tc.kind) h.append(el('span', 'kind', vtext(tc.kind)));
    d.append(h);
    const diff = Array.isArray(tc.content) ? tc.content.find(c => c?.type === 'diff') : null;
    if (diff) d.append(lineDiff(diff));
    else if (tc.rawInput != null) { const j = JSON.stringify(tc.rawInput, null, 1) || ''; d.append(el('pre', 'raw', j.length > 2048 ? j.slice(0, 2048) + '…' : j)); }
    const row = el('div', 'acts');
    for (const o of p.options) {   // no keyboard shortcut: a stray Enter must not approve a tool
      const kind = vtext(o?.kind), always = kind === 'allow_always' || kind === 'reject_always';
      const b = el('button', kind.startsWith('allow') ? 'go' : '', vtext(o?.name || o?.optionId) + (always ? ' · remembered by ' + agentLabel(this.n.agent) : ''));
      b.type = 'button'; b.dataset.kind = kind;
      if (always) b.title = 'The agent stores this rule and applies it to its future sessions on this server';
      b.onclick = () => this.answerPermission(req, vtext(o?.optionId), p, ep);
      row.append(b);
    }
    d.append(row); return d;
  }
  elicitPanel(req, p) {
    const q = p.request, ep = this.epoch, answer = r => this.answerElicitation(req, r, p, ep), btn = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; return b; };
    const decline = btn('Decline', '', () => answer({ action: 'decline' })), cancel = btn('Cancel', '', () => answer({ action: 'cancel' })), row = el('div', 'acts');
    if (q.mode === 'url') {   // F-A19: the full origin, never auto-opened, only https:
      const d = el('div', 'ag-url'), code = el('code', 'u');
      let u = null; try { u = new URL(vtext(q.url)); } catch {}
      const ok = u?.protocol === 'https:' && !!u.host, open = btn(ok ? 'Open ' + u.host : 'Open', 'go open', () => { window.open(u.href, '_blank', 'noopener,noreferrer'); answer({ action: 'accept' }); });
      if (ok) { code.append('https://', el('b', '', u.host), u.pathname + u.search + u.hash); open.title = 'Opens ' + u.origin + ' in a new tab'; }
      else { code.textContent = vtext(q.url); open.disabled = true; open.title = 'Only https: addresses open from an agent card'; }
      d.append(el('div', 'msg', vtext(q.message)), ok ? el('div', 'org', 'Origin: ' + u.origin) : el('div', 'warn', 'Not an https: address: it cannot be opened from here.'), code);
      row.append(open, decline, cancel); d.append(row); return d;
    }
    const d = el('div', 'ag-form'); d.append(el('div', 'msg', vtext(q.message)));
    if (q.mode !== 'form' && !q.requestedSchema) { d.append(el('div', 'warn', 'This kind of question is not supported here (' + vtext(q.mode) + ').')); row.append(decline, cancel); d.append(row); return d; }
    const f = elicitForm(q.requestedSchema), err = el('div', 'err'), accept = btn('Accept', 'go', () => { const r = check(); if (r.ok) answer({ action: 'accept', content: r.content }); });
    const check = () => { const r = f.check(); accept.disabled = !r.ok; err.textContent = r.ok ? '' : r.err; return r; };
    f.el.addEventListener('input', check); f.el.addEventListener('change', check);
    row.append(accept, decline, cancel); d.append(f.el, err, row); check(); return d;
  }
  paint() {
    const L = this.L, s = this.sum, a = s?.acp, ta = L.ta, go = $('.ag-row .go', L.body), sel = $('.ag-mode', L.body);   // .ag-row: the state panel has a .go too
    const off = this.restarting || this.gone || this.missing || !s || !s.alive || a?.activity === 'setup';
    ta.disabled = off; ta.readOnly = this.draft != null;
    ta.placeholder = this.restarting ? 'Ending the session…' : this.gone || this.missing ? 'No session: Start new session, or ⑂ for a new card'
      : !s ? 'Connecting…' : !s.alive ? (a?.revivable ? 'Detached: ↻ revive to continue' : 'Ended: Start new session, or ⑂ for a new card')
      : a?.activity === 'setup' ? 'Starting…' : 'Message ' + agentLabel(this.n.agent) + ' (Enter sends, Shift+Enter is a new line)';
    go.disabled = off || !this.promptable();
    go.textContent = this.draft != null ? 'Sending…' : 'Send';
    $('.ag-row .stop', L.body).hidden = !(s?.alive && a?.activity === 'turn');
    const modes = (Array.isArray(this.session.modes?.availableModes) ? this.session.modes.availableModes : []).filter(m => m && m.id != null);
    sel.hidden = modes.length < 2;
    const mk = JSON.stringify(modes.map(m => [m.id, m.name]));
    if (sel.dataset.key !== mk) { sel.dataset.key = mk; sel.replaceChildren(...modes.map(m => { const o = el('option', '', vtext(m.name || m.id)); o.value = vtext(m.id); o.title = vtext(m.description); return o; })); }
    if (this.modeWanted != null && this.modeWanted === this.modeNow()) this.modeWanted = null;
    if (sel.value !== this.mode()) sel.value = this.mode();
    if (L.revive) L.revive.hidden = !(s && !s.alive && a?.revivable && !this.gone && !this.missing && !this.restarting);
    const st = this.state(), badge = $('.badge', L.hdr);
    $('.dot', L.hdr).className = 'dot' + (st ? ' st-' + st : '');
    // Checked against the DOM: sessChanged writes the badge too, from a /rpc summary that may be older than this one.
    if (badge.textContent !== badgeOf(this.n)) updateTitle(this.n);
    badge.className = 'badge' + (st ? ' st-' + st : '');
  }
}
// The kill of a card removed while its socket was down (§3.5.1): attach without spawning once the server is back, then end
// the session, but only when `mine(hello)` says it is still the one the card had. It lives in this page only, so a reload
// before the server returns leaves the session running.
class Reap {
  constructor(path, open, kill, mine = () => true, h = null) { Object.assign(this, { path, open, kill, mine, h, tries: 0 }); this.connect(); }
  connect() {
    clearTimeout(this.timer); WAKE.delete(this); this.waitHub = false;
    const ws = this.ws = new WebSocket(hWs(this.h, this.path));
    ws.onopen = () => ws.send(JSON.stringify(this.open));
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') { this.done = true; if (this.mine(m)) ws.send(JSON.stringify(this.kill)); setTimeout(() => ws.close(), 50); }
      else if (m.t === 'error' || m.t === 'gone') { this.done = true; ws.close(); }   // no session left to end
    };
    ws.onclose = ev => {
      if (this.done || [1000, 1008, 1009].includes(ev.code)) return;
      WAKE.add(this);
      if (ev.code === 1013) { this.waitHub = true; this.timer = setTimeout(() => this.wake(), 30000); return; }
      netKick();
      if (NET.state !== 'signed_out' && NET.state !== 'forbidden') this.timer = setTimeout(() => this.connect(), backoff(this.tries++));
    };
  }
  wake() { if (this.ws?.readyState > 1) { this.tries = 0; this.connect(); } }
}
function acpItemEl(it) {
  if (it.k === 'thought') { const d = el('details', 'ag-thought'); d.append(el('summary', '', 'thinking'), el('div', 'ag-msg')); return d; }
  return el('div', { user: 'ag-msg ag-user', asst: 'ag-msg ag-asst', tool: 'ag-tool', sep: 'ag-sep' }[it.k] || 'ag-note');
}
function acpFill(it) {
  const e = it.el;
  if (it.k === 'user' || it.k === 'asst') e.textContent = it.text;
  else if (it.k === 'thought') e.lastChild.textContent = it.text;
  else if (it.k === 'note') { e.textContent = it.text; e.classList.toggle('err', it.cls === 'err'); e.classList.toggle('warn', it.cls === 'warn'); }
  else if (it.k === 'tool') {
    const st = TOOL_GLYPH[it.status] ? it.status : 'pending', h = el('div', 'th'), locs = Array.isArray(it.locations) ? it.locations : [];
    h.append(el('span', 'tg ' + st, TOOL_GLYPH[st]), el('b', '', vtext(it.kind) || 'tool'), el('span', 'tt', vtext(it.title)));
    const parts = [h];
    if (locs.length) parts.push(el('div', 'tl', locs.map(l => vtext(l?.path) + (l?.line != null ? ':' + vtext(l.line) : '')).join('  ')));
    for (const c of Array.isArray(it.content) ? it.content : []) parts.push(toolContent(c));
    e.replaceChildren(...parts); e.dataset.status = st;
  }
}
function toolContent(c) {
  if (c?.type === 'diff') return lineDiff(c);
  if (c?.type === 'terminal') return el('div', 'ag-note', '[terminal output not available]');
  const t = blockText(c?.content), lines = t.split('\n').length, pre = el('pre', lines > 20 ? 'clip' : '', t);
  if (lines <= 20) return pre;
  const box = el('div'), more = el('button', 'more', 'show all ' + lines + ' lines');
  more.type = 'button'; more.onclick = () => { pre.classList.remove('clip'); more.remove(); };
  box.append(pre, more); return box;
}
function acpStatePanel(box, sp, b) {
  box.hidden = !sp; box.replaceChildren(); if (!sp) return;
  box.append(el('div', 'msg', sp.text));
  if (sp.auth) {   // agent-handled methods are buttons; the others need a shell (§1.4)
    for (const m of Array.isArray(b.session.authMethods) ? b.session.authMethods : []) {
      if (!m || typeof m !== 'object') continue;
      if (!m.type || m.type === 'agent') { const x = el('button', 'go', 'Log in: ' + vtext(m.name || m.id)); x.type = 'button'; x.title = vtext(m.description); x.onclick = () => b.authenticate(vtext(m.id)); box.append(x); }
      else box.append(el('div', 'hint', vtext(m.name || m.id) + (m.description ? ': ' + vtext(m.description) : '') + '. Log in from a shell card on this server, then Start new session.'));
    }
  }
  if (sp.hint) box.append(el('div', 'hint', sp.hint));
  if (sp.acts) { const row = el('div', 'acts'); for (const [label, fn, cls] of sp.acts) { const x = el('button', cls || '', label); x.type = 'button'; x.onclick = fn; row.append(x); } box.append(row); }
}
// A tool call's diff content (30 §1.2): common prefix and suffix trimmed, an LCS over the middle when it is small enough,
// 3 lines of context around each change.
function lineDiff(d) {
  const box = el('div', 'ag-diff'), path = vtext(d.path), oldT = d.oldText == null ? null : vtext(d.oldText), newT = vtext(d.newText);
  const a = oldT == null ? [] : oldT.split('\n'), b = newT.split('\n');
  box.append(el('div', 'dp', path + (oldT == null ? ' (new file)' : '')));
  if ((oldT || '').length + newT.length > 200000) {
    box.append(el('div', 'gap', 'diff too large: ' + path + ' (' + a.length + ' → ' + b.length + ' lines)'));
    const t = el('button', 'more', 'show new text'); t.type = 'button'; t.onclick = () => t.replaceWith(el('pre', '', newT));
    box.append(t); return box;
  }
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s), bm = b.slice(p, b.length - s), ops = a.slice(0, p).map(x => ['=', x]), m = am.length, n = bm.length;
  if (m * n <= 1e6) {
    const T = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) T[i][j] = am[i] === bm[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    let i = 0, j = 0;
    while (i < m && j < n) { if (am[i] === bm[j]) { ops.push(['=', am[i]]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) ops.push(['-', am[i++]]); else ops.push(['+', bm[j++]]); }
    while (i < m) ops.push(['-', am[i++]]);
    while (j < n) ops.push(['+', bm[j++]]);
  } else { for (const x of am) ops.push(['-', x]); for (const x of bm) ops.push(['+', x]); }
  for (const x of a.slice(a.length - s)) ops.push(['=', x]);
  const keep = ops.map(() => false);
  ops.forEach(([o], i) => { if (o !== '=') for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep[k] = true; });
  const pre = el('pre');
  for (let i = 0; i < ops.length;) {
    if (keep[i]) { const [o, t] = ops[i++]; pre.append(el('div', o === '+' ? 'add' : o === '-' ? 'del' : 'ctx', (o === '=' ? ' ' : o) + ' ' + t)); continue; }
    let j = i; while (j < ops.length && !keep[j]) j++;
    pre.append(el('div', 'gap', '… ' + (j - i) + ' unchanged line' + (j - i === 1 ? '' : 's'))); i = j;
  }
  box.append(pre); return box;
}
// An elicitation form from requestedSchema (30 §1.4): one control per property, in object order.
function elicitForm(schema) {
  const props = schema && typeof schema.properties === 'object' && schema.properties ? schema.properties : {};
  const need = new Set(Array.isArray(schema?.required) ? schema.required : []), box = el('div', 'fields'), fields = [];
  const choices = p => {
    if (Array.isArray(p.enum)) return p.enum.map((v, i) => ({ v: vtext(v), t: vtext(Array.isArray(p.enumNames) ? p.enumNames[i] ?? v : v) }));
    const alt = p.oneOf || p.anyOf;
    return Array.isArray(alt) && alt.length && alt.every(o => o && typeof o === 'object' && 'const' in o) ? alt.map(o => ({ v: vtext(o.const), t: vtext(o.title ?? o.const) })) : null;
  };
  for (const [key, raw] of Object.entries(props)) {
    const p = raw && typeof raw === 'object' ? raw : {}, req = need.has(key), row = el('div', 'fld'), f = { key, p, req };
    row.dataset.key = key;
    row.append(el('span', 'lbl', vtext(p.title || key) + (req ? ' *' : '')));
    const opts = p.type === 'string' ? choices(p) : null, items = p.type === 'array' && p.items && typeof p.items === 'object' ? choices(p.items) : null;
    if (opts) {
      const s = f.ctl = el('select'); if (!req) s.append(Object.assign(el('option', '', ''), { value: '' }));
      for (const o of opts) s.append(Object.assign(el('option', '', o.t), { value: o.v }));
      if (p.default != null) s.value = vtext(p.default);
      f.get = () => s.value || undefined;
    } else if (p.type === 'string') {
      const type = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' }[p.format] || 'text';
      const i = f.ctl = p.maxLength > 200 && type === 'text' ? el('textarea') : Object.assign(el('input'), { type });
      if (p.default != null) i.value = type === 'datetime-local' ? vtext(p.default).slice(0, 16) : vtext(p.default);
      f.get = () => (i.value === '' ? undefined : type === 'datetime-local' ? new Date(i.value).toISOString() : i.value);
    } else if (p.type === 'number' || p.type === 'integer') {
      const i = f.ctl = Object.assign(el('input'), { type: 'number' });
      if (p.minimum != null) i.min = vtext(p.minimum); if (p.maximum != null) i.max = vtext(p.maximum); i.step = p.type === 'integer' ? '1' : 'any';
      if (p.default != null) i.value = vtext(p.default);
      f.get = () => (i.value === '' ? undefined : Number(i.value));
    } else if (p.type === 'boolean') {
      const i = f.ctl = Object.assign(el('input'), { type: 'checkbox', checked: p.default === true });
      f.get = () => i.checked;
    } else if (items) {
      const g = f.ctl = el('div', 'multi'), def = Array.isArray(p.default) ? p.default.map(vtext) : [];
      for (const o of items) { const l = el('label'), c = Object.assign(el('input'), { type: 'checkbox', value: o.v, checked: def.includes(o.v) }); l.append(c, ' ' + o.t); g.append(l); }
      f.get = () => { const v = $$('input:checked', g).map(c => c.value); return v.length ? v : undefined; };
    } else { f.ctl = el('span', 'warn', 'unsupported field (' + vtext(p.type || 'no type') + ')'); f.get = () => undefined; f.bad = true; }
    row.append(f.ctl); if (p.description) row.append(el('span', 'hint', vtext(p.description)));
    box.append(row); fields.push(f);
  }
  const check = () => {
    const content = {};
    for (const { key, p, req, get, bad } of fields) {
      const v = get(), name = vtext(p.title || key);
      if (bad) { if (req) return { ok: false, err: name + ' cannot be filled in here' }; continue; }
      if (v === undefined) { if (req) return { ok: false, err: name + ' is required' }; continue; }
      if (typeof v === 'string') {
        if (p.minLength != null && v.length < p.minLength) return { ok: false, err: name + ': at least ' + p.minLength + ' characters' };
        if (p.maxLength != null && v.length > p.maxLength) return { ok: false, err: name + ': at most ' + p.maxLength + ' characters' };
        if (typeof p.pattern === 'string') { let re = null; try { re = new RegExp(p.pattern, 'u'); } catch {} if (re && !re.test(v)) return { ok: false, err: name + ' does not have the expected form' }; }
      }
      if (typeof v === 'number') {
        if (!Number.isFinite(v) || (p.type === 'integer' && !Number.isInteger(v))) return { ok: false, err: name + ' must be ' + (p.type === 'integer' ? 'a whole number' : 'a number') };
        if (p.minimum != null && v < p.minimum) return { ok: false, err: name + ': at least ' + p.minimum };
        if (p.maximum != null && v > p.maximum) return { ok: false, err: name + ': at most ' + p.maximum };
      }
      if (Array.isArray(v)) {
        if (p.minItems != null && v.length < p.minItems) return { ok: false, err: name + ': pick at least ' + p.minItems };
        if (p.maxItems != null && v.length > p.maxItems) return { ok: false, err: name + ': pick at most ' + p.maxItems };
      }
      content[key] = v;
    }
    return { ok: true, content };
  };
  return { el: box, check };
}
function newAgentCard() {
  const ag = DAEMON ? INFO?.agents || [] : [];
  if (!ag.length) return toast(DAEMON ? 'No agents are configured on this server.' : 'Agent cards run on the Workbench server.');
  const go = a => askName('Folder for the agent', defaultCwd(), cwd => {
    if (!cwd.startsWith('/')) return toast('The folder must be an absolute path.');
    newAt('acp', { agent: a.name, cwd, w: 560, h: 520 });
  });
  if (ag.length === 1) return go(ag[0]);
  openPicker('Agent', ag.map(a => ({ k: 'agent', l: a.label || a.name, s: a.name, run: () => go(a) })));
}
function acpButton() { const b = $('#add-acp'); if (b) b.disabled = !DAEMON || !(INFO?.agents || []).length; }
function defaultCwd() {
  const a = activeId && S.nodes[activeId];
  if (a && (a.kind === 'term' || a.kind === 'repl')) { const c = a.cwdLive || SESS[a.id]?.cwd; if (c) return c; }
  if (a?.kind === 'acp' && a.cwd) return a.cwd;
  return INFO?.home || '';
}
// An alive session with no card on this board (a "load theirs" conflict, or a tab that missed a card): a card with the
// same id attaches to it and never spawns (N25).
function adoptOrphan(s) {
  if (S.nodes[s.sid]) return jumpNode(S.nodes[s.sid]);
  const acp = s.kind === 'acp', c = viewCenterWorld(), w = 560, h = acp ? 520 : 320;
  const base = acp ? { kind: 'acp', agent: s.acp?.agent || '', cwd: s.cwd || '' } : { kind: 'term', backend: 'pty', env: {}, ...(s.cwd ? { cwd: s.cwd } : {}) };
  const n = addNode({ id: s.sid, name: (acp ? 'agent' : 'shell') + (nodeList().length + 1), ...base, ...freeSpot(c.x - w / 2, c.y - h / 2, w, h), w, h, _spawn: false });
  jumpNode(n);
}
function mountAcp(n, L) {
  if (!DAEMON) { L.body.append(el('div', 'ag-note', 'Agent cards run on the Workbench server.')); return; }
  L.body.innerHTML = '<div class="ag-plan" hidden></div><div class="ag-log" aria-live="polite"></div><div class="ag-pend"><div class="ag-state" hidden></div></div>'
    + '<form class="ag-in"><textarea rows="2"></textarea><div class="ag-row"><select class="ag-mode" title="Agent mode" hidden></select>'
    + '<button type="button" class="stop" hidden>Stop</button><button type="submit" class="go">Send</button></div></form>';
  L.logEl = $('.ag-log', L.body); L.ta = $('textarea', L.body);
  const b = L.backend = new AcpBackend(n, L);
  $('.ag-in', L.body).addEventListener('submit', e => { e.preventDefault(); b.submit(); });
  L.ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); b.submit(); } });
  $('.ag-row .stop', L.body).onclick = () => b.cancel();
  $('.ag-mode', L.body).onchange = e => b.setMode(e.target.value);
}
class Offline {
  constructor(n, term) { term.write('\x1b[33mThis node is a real shell: it runs when wb-web serves this page.\x1b[0m\r\n'); }
  input() {}
}

// ------------------------------------------------------------------ mounting
function termTheme() {   // Modus tinted terminal colours, from the --ansi-* tokens in style.css
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const t = { background: cssVar('--term-bg'), foreground: cssVar('--term-fg'), cursor: cssVar('--cursor'), cursorAccent: cssVar('--term-bg'), selectionBackground: cssVar('--sel') };
  names.forEach((nm, i) => { t[nm] = cssVar('--ansi-' + i); t['bright' + nm[0].toUpperCase() + nm.slice(1)] = cssVar('--ansi-' + (i + 8)); });
  return t;
}
function mount(n) { if (n.kind === 'frame') mountFrame(n); else mountNode(n); }

function mountFrame(n) {
  const e = el('div', 'frame'); e.dataset.id = n.id;
  e.innerHTML = '<div class="flabel"><span class="ftab"><span class="fico"></span><span class="fname"></span><span class="fcount"></span><span class="fhost"></span><button class="hb fre" title="This host is unreachable: click to reconnect its shells">↻</button><button class="hb fls" title="List this directory: its entries appear as ghost cards; open one to make it real">☰</button></span>'
    + '<span class="fmodes" role="group" aria-label="Folder mode">'
    + '<button class="hb" data-m="free" title="Free: items stay where you drop them; the walls stretch to hold them. Click again to pull the walls in.">◻</button>'
    + '<button class="hb" data-m="pack" title="Pack: items flow into rows in the order you drop them">▦</button>'
    + '<button class="hb" data-m="tile" title="Tile: items fill the folder like panes in a tiling window manager; resize the folder to resize them">⊞</button>'
    + '<button class="hb" data-m="stack" title="Stack: collapse everything into a deck of cards">❐</button></span>'
    + '<button class="hb fshape" title="Change the shape: folder, box, round">◐</button>'
    + '<button class="hb fws" title="Workspace: make this folder the desktop (Enter); inside one, this leaves it (Esc)">⌂</button>'
    + '<button class="hb fdel" title="Delete folder (click twice); its items move up one level">✕</button></div>'
    + '<div class="fgrid"></div><div class="fcols"></div><div class="frows"></div><div class="deck" hidden></div><div class="rse" title="Drag: width"></div><div class="rsb" title="Drag: height"></div><div class="rs" title="Drag to resize the folder. Packed: items re-flow and shrink to fit; small enough and they stack. Tiled: panes retile."></div>';
  const ink = svgEl('svg', { class: 'ink' }); e.append(ink);
  framesEl.append(e);
  const L = live[n.id] = { el: e, ink };
  placeFrame(n);
  const label = $('.flabel', e), name = $('.fname', e);
  $('.fdel', e).onclick = ev => { ev.stopPropagation(); confirmDel(ev.currentTarget, () => removeNode(n.id)); };
  $$('.fmodes button', e).forEach(b => { b.title += ' Shift-click: cascade it to every nested folder.'; b.onclick = ev => { ev.stopPropagation(); ev.shiftKey ? setModeCascade(n, b.dataset.m) : setMode(n, b.dataset.m); }; });
  $('.fre', e).onclick = ev => { ev.stopPropagation(); const h = hostOf(n); if (h) hostRetry(h.url, true); };
  $('.fls', e).onclick = ev => { ev.stopPropagation(); fsExpand(n); };
  $('.fws', e).onclick = ev => { ev.stopPropagation(); WS.cur === n.id ? wsLeave() : wsEnter(n); };
  $('.fshape', e).onclick = ev => { ev.stopPropagation(); n.shape = FSHAPES[(FSHAPES.indexOf(n.shape || 'folder') + 1) % FSHAPES.length]; placeFrame(n); dirty(); };
  name.ondblclick = ev => { ev.stopPropagation(); rename(n, name); };
  $('.fico', e).ondblclick = ev => { ev.stopPropagation(); wsEnter(n); }; $('.fico', e).title = 'Double-click: enter this folder as a workspace (Enter / Esc)';
  label.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || ev.target.closest('button') || name.isContentEditable) return;
    if (ev.shiftKey) { ev.stopPropagation(); ev.preventDefault(); pickToggle(n.id); return; }
    startFolderDrag(ev, label, n);
  });
  e.addEventListener('dblclick', ev => {
    if (n.mode === 'stack' && ev.target.closest('.deck') && !ev.target.closest('.deck-row')) { ev.stopPropagation(); setMode(n, n.prevMode || 'free'); }
  });
  for (const [sel, axis] of [['.rs', 'xy'], ['.rse', 'x'], ['.rsb', 'y']]) resizeWith($(sel, e), n, 160, 2 * PAD + 60, () => frameResized(n), axis, () => frameResizeEnd(n));
  renderInk(n.id);
  return L;
}
function placeFrame(n) {
  const L = live[n.id]; if (!L) return;
  Object.assign(L.el.style, { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }); fitChrome(n);
  const mode = n.mode || 'free', shape = n.shape || 'folder';
  for (const m of ['free', 'pack', 'tile', 'stack']) L.el.classList.toggle('m-' + m, m === mode);
  L.el.classList.toggle('packed', mode === 'stack' && !!n.packed);
  L.el.classList.toggle('d-fs', n.derived === 'fs'); L.el.classList.toggle('d-mount', !!n.mount); L.el.classList.toggle('d-unit', n.derived === 'unit'); L.el.classList.toggle('d-proc', n.derived === 'proc'); L.el.classList.toggle('u-failed', n.unitState === 'failed');
  for (const s of FSHAPES) L.el.classList.toggle('shape-' + s, s === shape);
  $('.fname', L.el).textContent = n.name;
  $('.fico', L.el).textContent = FICON[mode];
  const k = kidsOf(n.id).length;
  $('.fcount', L.el).textContent = k ? String(k) : '';
  { const fh = $('.fhost', L.el), h = n.host ? hostRes(n.host) : null; if (fh) { fh.textContent = h ? '@' + h.name : n.host ? '@' + (n.host.name || '?') + '?' : ''; fh.title = h ? h.url : n.host ? 'not in hosts.json' : ''; } L.el.classList.toggle('hdown', !!h && !!HOSTCONN[h.url]?.down); }
  $$('.fmodes button', L.el).forEach(b => b.classList.toggle('on', b.dataset.m === mode));
  const cols = $('.fcols', L.el), rows = $('.frows', L.el);
  cols.replaceChildren(); rows.replaceChildren();
  if (mode === 'free') {
    for (let i = 0; i * GRID < n.w; i++) { const s = el('span'); s.textContent = colName(i); s.style.left = Math.min(i * GRID + GRID / 2, n.w - 10) + 'px'; cols.append(s); }
    for (let j = 0; j * GRID < n.h; j++) { const s = el('span'); s.textContent = j + 1; s.style.top = Math.min(j * GRID + GRID / 2, n.h - 10) + 'px'; rows.append(s); }
  }
  renderDeck(n);
}

// ------------------------------------------------------------------ folders: containers on the canvas
// A folder is a frame that owns items through `in`. Membership is explicit, not geometric: an item belongs to the
// folder it was dropped into (the pointer decides), and moving a folder carries everything inside it, nested folders too.
// Modes:  free  = no gravity: items stay where they are dropped; the walls stretch outward to hold them, never shrink.
//         pack  = items flow left to right into rows in drop order; dropping between two items inserts there; resizing reflows.
//         stack = the folder collapses into a deck; items keep their places for when it is spread out again.
const PAD = 28, GAP = 24, LABEL_H = 32, DECK = { w: 300, h: 230 };
const FSHAPES = ['folder', 'box', 'round'], FICON = { free: '◻', pack: '▦', tile: '⊞', stack: '❐' };   // v18.1: ribbon (PaperWM row) removed; old boards' ribbon folders load as tile
const KIND_GLYPH = { term: '$', repl: '›', buffer: '¶', agent: '✦', acp: '✦', ref: '❝', frame: '▭', artifact: '◧', web: '⌾', sketch: '✎', ghost: '◌' };
const kidsOf = fid => Object.values(S.nodes).filter(m => m.in === fid);
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.y - b.y || a.x - b.x;
function descendants(fid, out = []) { for (const k of kidsOf(fid)) { out.push(k); if (k.kind === 'frame') descendants(k.id, out); } return out; }
function ancestors(n) { const out = []; let cur = n.in, g = 0; while (cur && S.nodes[cur] && g++ < 32) { out.push(S.nodes[cur]); cur = S.nodes[cur].in; } return out; }
const stashed = n => deskOff(n) || ancestors(n).some(a => a.mode === 'stack');
const visibleOf = n => ancestors(n).reverse().find(a => a.mode === 'stack') || n;
const depthOf = n => ancestors(n).length;
const folderPath = n => ancestors(n).reverse().map(a => a.name).join('/');
const fullPath = f => [...ancestors(f).reverse(), f].map(a => a.name).join('/');
const placeAny = m => (m.kind === 'frame' ? placeFrame(m) : place(m));
// The viewport's box, kept between resizes: a drag or a stroke reads it on every move, right after it has moved
// things, and getBoundingClientRect() there forced a layout of the whole board per move.
let VP_RECT = null;
const vpRect = () => VP_RECT || (VP_RECT = viewport.getBoundingClientRect());
new ResizeObserver(() => { VP_RECT = null; }).observe(viewport);
window.addEventListener('resize', () => { VP_RECT = null; });
function evWorld(e) { const r = vpRect(); return s2w(e.clientX - r.left, e.clientY - r.top); }
function containerAt(x, y, skip) {
  let best = null, bd = -1;
  for (const f of frameList()) {
    if (skip?.has(f.id) || stashed(f)) continue;
    if (x >= f.x && x <= f.x + f.w && y >= f.y - LABEL_H && y <= f.y + f.h) { const d = depthOf(f); if (d > bd) { bd = d; best = f; } }
  }
  return best;
}
function moveTree(n, dx, dy) {
  dx = Math.round(dx); dy = Math.round(dy);
  if (!dx && !dy) return;
  const moved = [n, ...(n.kind === 'frame' ? descendants(n.id) : [])], ids = new Set(moved.map(m => m.id));
  for (const m of moved) { m.x += dx; m.y += dy; placeAny(m); }
  for (const sh of S.shapes) if (sh.in && ids.has(sh.in)) { sh.x += dx; sh.y += dy; }
}
function renumber(f) { kidsOf(f.id).sort(byOrder).forEach((k, i) => { k.order = i; }); }
let settleT = null;
function settle() {
  if (reduceMotion) return;
  world.classList.add('settle'); clearTimeout(settleT);
  settleT = setTimeout(() => { world.classList.remove('settle'); renderLinks(); for (const id in live) live[id].fitNow?.(); }, 280);
}
// ---- boundaries: items on one level never overlap (user, 10:35). After a drop, a resize, an unfold or a new item, the
// others on that level are pushed apart along the axis of least overlap, folder tabs included, and the folder grows to fit.
const SEP = { keep: null, off: 0, on: () => S && S.noOverlap !== false && !SEP.off && !(optimise.depth > 0) };
function footprint(k) {
  // world units, independent of the zoom, so layouts do not fight across zoom levels; the tab's unscaled width is its width at 100 %
  const tabH = k.kind === 'frame' ? LABEL_H : 0;
  const tabW = k.kind === 'frame' ? ($('.ftab', live[k.id]?.el || document.createElement('i'))?.offsetWidth || 0) : 0;
  return { x: k.x, y: k.y - tabH, w: Math.max(k.w, tabW), h: k.h + tabH };
}
function separate(container, keep, depth = 0) {
  if (!SEP.on() || depth > 8) return false;
  if (container && (container.mode || 'free') !== 'free') return false;
  const items = (container ? kidsOf(container.id) : Object.values(S.nodes).filter(n => !n.in || !S.nodes[n.in])).filter(n => !stashed(n));
  if (items.length < 2) return false;
  const holds = i => i === keep || (keep && i.kind === 'frame' && ancestors(keep).includes(i));
  const fixed = keep ? items.find(holds) : null;
  const later = (a, b) => (a.y - b.y || a.x - b.x) < 0 ? b : a;  // the one further down the reading order moves
  // every item moves in one direction only, so the loop cannot oscillate: a push from the kept item sets an item's direction,
  // an item with a direction passes it on to what it bumps into, and items with no direction yet move away from the earlier one
  const dir = new Map(); let moved = false;
  const shift = (m, d, amt) => { moveTree(m, d === 'l' ? -amt : d === 'r' ? amt : 0, d === 'u' ? -amt : d === 'd' ? amt : 0); dir.set(m, d); moved = true; };
  const away = (M, O, ox, oy) => ox < oy ? (M.x + M.w / 2 >= O.x + O.w / 2 ? 'r' : 'l') : (M.y + M.h / 2 >= O.y + O.h / 2 ? 'd' : 'u');
  const amount = (d, ox, oy) => (d === 'l' || d === 'r' ? ox : oy);
  for (let pass = 0; pass < 60; pass++) {
    let any = false;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j], A = footprint(a), B = footprint(b);
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + GAP, oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) + GAP;
      if (ox <= 0 || oy <= 0) continue;
      any = true;
      if (a === fixed || b === fixed) { const m = a === fixed ? b : a, M = m === a ? A : B, F = m === a ? B : A; const d = dir.get(m) || away(M, F, ox, oy); shift(m, d, amount(d, ox, oy)); }
      else if (dir.has(a) !== dir.has(b)) { const m = dir.has(a) ? b : a, d = dir.get(m === a ? b : a); shift(m, d, amount(d, ox, oy)); }
      else { const m = later(a, b), o = m === a ? b : a, M = m === a ? A : B, O = m === a ? B : A; const d = dir.get(m) || away(M, O, ox, oy); shift(m, d, amount(d, ox, oy)); }
    }
    if (!any) break;
  }
  if (moved && container) { growFolder(container); placeFrame(container); if (container.in && S.nodes[container.in]) { SEP.keep = container; relayoutUp(S.nodes[container.in], depth + 1); } else separate(null, container, depth + 1); }
  return moved;
}
function separateAll() {
  // whole board, deepest folders first so each folder has its final size before its level is cleared; boards saved before boundaries existed get cleaned on load
  if (!SEP.on()) return 0;
  let moved = 0; SEP.keep = null;
  for (const f of frameList().sort((a, b) => depthOf(b) - depthOf(a))) if ((f.mode || 'free') === 'free' && !stashed(f)) { if (separate(f, null)) moved++; growFolder(f); placeFrame(f); }
  if (separate(null, null)) moved++;
  for (const f of frameList()) placeFrame(f);
  return moved;
}
function relayoutUp(f, depth) { if (!f) return; if ((f.mode || 'free') === 'free') { growFolder(f); placeFrame(f); separate(f, SEP.keep, depth); } else relayout(f); if (f.in && S.nodes[f.in]) relayoutUp(S.nodes[f.in], depth + 1); else if (!f.in) separate(null, f, depth); }
function growFolder(f) {
  const ks = kidsOf(f.id); if (!ks.length) return;
  const x0 = Math.min(...ks.map(k => k.x)) - PAD, y0 = Math.min(...ks.map(k => k.y - (k.kind === 'frame' ? LABEL_H : 0))) - PAD;
  const x1 = Math.max(...ks.map(k => k.x + k.w)) + PAD, y1 = Math.max(...ks.map(k => k.y + k.h)) + PAD;
  if (x0 < f.x) { f.w += f.x - x0; f.x = x0; }
  if (y0 < f.y) { f.h += f.y - y0; f.y = y0; }
  f.w = Math.max(f.w, x1 - f.x); f.h = Math.max(f.h, y1 - f.y);
}
function packFolder(f) {
  const ks = kidsOf(f.id).sort(byOrder);
  ks.forEach((k, i) => { k.order = i; });
  const base = k => k.prePack || { w: k.w, h: k.h };
  const flow = (scale, innerW) => {   // rows in drop order at this scale; returns the height used
    let x = 0, y = 0, rowH = 0;
    for (const k of ks) {
      const b = base(k), w = Math.max(60, Math.round(b.w * scale)), h = Math.max(40, Math.round(b.h * scale)), top = k.kind === 'frame' ? LABEL_H : 0;
      if (x > 0 && x + w > innerW) { x = 0; y += rowH + GAP; rowH = 0; }
      k._pk = { x, y: y + top, w, h }; x += w + GAP; rowH = Math.max(rowH, h + top);
    }
    return ks.length ? y + rowH : 0;
  };
  let scale = 1, innerW, usedH;
  if (f.fit) {   // the user sized the folder: find the largest scale (1 … 0.35) at which everything fits it
    innerW = Math.max(f.fit.w - 2 * PAD, 100); const innerH = Math.max(f.fit.h - 2 * PAD, 40);
    for (scale = 1; scale > 0.35; scale = Math.round((scale - 0.05) * 100) / 100) { usedH = flow(scale, innerW); if (usedH <= innerH && ks.every(k => k._pk.w <= innerW)) break; }
    if (scale <= 0.35) { scale = 0.35; usedH = flow(scale, innerW); }
    f.w = f.fit.w; f.h = f.fit.h; f.packScale = scale < 1 ? scale : undefined;
  } else {   // no size of the user's: rows wrap at the folder's width, then the folder shrinks to its widest row (user, 15:07: it stayed as wide as its last mode)
    innerW = Math.max(f.w - 2 * PAD, 160, ...ks.map(k => base(k).w)); usedH = flow(1, innerW);
    const usedW = Math.max(160, ...ks.map(k => k._pk.x + k._pk.w));
    f.w = usedW + 2 * PAD; f.h = Math.max(120, usedH + 2 * PAD); delete f.packScale;
  }
  for (const k of ks) {
    const p = k._pk; delete k._pk;
    if (scale < 1) { k.prePack = k.prePack || { w: k.w, h: k.h }; } else if (k.prePack) { delete k.prePack; }
    if (k.w !== p.w || k.h !== p.h) { k.w = p.w; k.h = p.h; if (k.kind === 'frame') relayoutInner(k); else place(k); }
    moveTree(k, f.x + PAD + p.x - k.x, f.y + PAD + p.y - k.y);
  }
}
// tile = dwm's fibonacci spiral (user, 2026-10-10 13:54): the first pane takes the golden share (mfact, 0.618) of the width,
// the next takes the golden share of what is left, split the other way, and so on, the panes spiralling inwards
// (left, top, right, bottom …). Dragging a pane's edge changes its share; resizing the folder retiles into the new size.
const TGAP = 8, PHI = 0.618;
function tileFolder(f) {
  const ks = kidsOf(f.id).sort(byOrder); ks.forEach((k, i) => { k.order = i; });
  f.w = Math.max(f.w, 320); f.h = Math.max(f.h, 200);
  const put = (k, x, y, w, h) => { const top = k.kind === 'frame' ? LABEL_H : 0; moveTree(k, Math.round(x) - k.x, Math.round(y + top) - k.y); k.w = Math.max(80, Math.round(w)); k.h = Math.max(60, Math.round(h - top)); if (k.kind === 'frame') relayoutInner(k); else place(k); };
  let x = f.x + TGAP, y = f.y + TGAP, w = f.w - 2 * TGAP, h = f.h - 2 * TGAP;
  ks.forEach((k, i) => {
    if (i === ks.length - 1) { k.tile = i ? { axis: null, avail: 0 } : null; put(k, x, y, w, h); return; }
    let axis = i % 2 === 0 ? 'x' : 'y';                       // alternate, unless the remainder is far too thin for it
    if (axis === 'x' && w < h * 0.6) axis = 'y'; else if (axis === 'y' && h < w * 0.6) axis = 'x';
    const r = clamp(k.tfact || (i === 0 ? (f.mfact || PHI) : PHI), 0.15, 0.85), side = i % 4;   // 0 left, 1 top, 2 right, 3 bottom
    if (axis === 'x') { const avail = w - TGAP, a = Math.round(avail * r); k.tile = { axis, avail, first: i === 0 }; if (side === 0 || side === 1) { put(k, x, y, a, h); x += a + TGAP; } else { put(k, x + avail - a + TGAP, y, a, h); } w = avail - a; }
    else { const avail = h - TGAP, a = Math.round(avail * r); k.tile = { axis, avail, first: i === 0 }; if (side === 0 || side === 1) { put(k, x, y, w, a); y += a + TGAP; } else { put(k, x, y + avail - a + TGAP, w, a); } h = avail - a; }
  });
}
// a tiled folder has an aspect ratio: the first is the screen's own, so Enter (workspace) fills the viewport with its
// panes; ⊞ on an already tiled folder (or `wb mode F tile` again) steps to the next. Each step keeps the folder's area
// and its top-left corner, and the panes retile. 'screen' counts the tab row, as the workspace fit does.
const ASPECTS = [{ name: 'screen', lh: LABEL_H }, { name: '16:9', r: 16 / 9 }, { name: '3:2', r: 3 / 2 }, { name: '4:3', r: 4 / 3 }, { name: '1:1', r: 1 }, { name: '3:4', r: 3 / 4 }, { name: '9:16', r: 9 / 16 }];
function aspectSize(f, a) {
  const lh = a.lh || 0, r = a.r || screenAspect(), area = Math.max(f.w, 320) * (Math.max(f.h, 200) + lh);
  let w = Math.round(Math.sqrt(area * r)), h = Math.round(w / r) - lh;
  if (w < 320) { w = 320; h = Math.round(w / r) - lh; }
  if (h < 200) { h = 200; w = Math.round((h + lh) * r); }
  f.w = w; f.h = h; f.aspect = a.name;
}
function tileAspect(f, a, quiet) {
  if (!f || f.kind !== 'frame') return;
  if (typeof a === 'string') a = ASPECTS.find(x => x.name === a); if (!a) return;
  const p = f.in && S.nodes[f.in];
  if (p && p.mode === 'tile') { if (!quiet) toast(`${f.name} is a pane of ${p.name}: its size comes from ${p.name}. Drag its edge for a bigger share.`); return; }
  layoutSnap('aspect ' + a.name + ' ' + f.name); settle();
  if (f.mode !== 'tile') setMode(f, 'tile', true);
  aspectSize(f, a); tileFolder(f); placeFrame(f);
  SEP.keep = f; if (p) relayout(p); else separate(null, f); SEP.keep = null;
  restack(); renderLinks(); dirty();
  if (WS.cur === f.id) animateTo(camTarget(f.x, f.y - LABEL_H, f.w, f.h + LABEL_H, 1));
  const i = ASPECTS.indexOf(a);
  if (!quiet) toast(`${f.name}: ${a.name === 'screen' ? 'the screen\'s ratio (Enter fills the view with it)' : a.name} · ${i + 1} of ${ASPECTS.length}. ⊞ again for the next.`);
}
function tileAspectCycle(f, quiet) { const i = ASPECTS.findIndex(a => a.name === f.aspect); tileAspect(f, ASPECTS[(i + 1) % ASPECTS.length], quiet); }
// lay out a folder's own contents after its size was set from outside (a tile), without growing it
function relayoutInner(f) {
  if (f.mode === 'tile') tileFolder(f); else if (f.mode === 'pack') packFolder(f);
  placeFrame(f);
}
function relayout(f, anim) {
  if (!f || f.kind !== 'frame') return;
  if (anim) settle();
  if (f.mode === 'pack') packFolder(f);
  else if (f.mode === 'tile') tileFolder(f);
  else if (f.mode === 'stack') { if (f.packed) { f.w = PKG.w; f.h = PKG.h; } else { f.w = DECK.w; f.h = DECK.h; } }
  else { growFolder(f); separate(f, SEP.keep); }
  placeFrame(f);
  if (f.in && S.nodes[f.in]) relayout(S.nodes[f.in], anim); else separate(null, SEP.keep && ancestors(SEP.keep).includes(f) ? SEP.keep : f);
}
function setMode(f, m, quiet) {
  const cur = f.mode || 'free';
  if (cur === 'free' && m === 'free') {  // ◻ again on a free folder pulls the walls in to fit what it holds
    const ks = kidsOf(f.id); if (!ks.length) return;
    const x0 = Math.min(...ks.map(k => k.x)) - PAD, y0 = Math.min(...ks.map(k => k.y - (k.kind === 'frame' ? LABEL_H : 0))) - PAD;
    const x1 = Math.max(...ks.map(k => k.x + k.w)) + PAD, y1 = Math.max(...ks.map(k => k.y + k.h)) + PAD;
    settle(); Object.assign(f, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }); placeFrame(f); if (f.in) relayout(S.nodes[f.in], true);
    renderLinks(); dirty(); if (!quiet) toast(`${f.name}: walls pulled in to fit`); return;
  }
  if (cur === 'tile' && m === 'tile') return tileAspectCycle(f, quiet);   // ⊞ again: the next aspect ratio
  if (cur === m || !FICON[m]) return;
  if (m === 'tile' || cur === 'tile') layoutSnap((m === 'tile' ? 'tiling ' : 'untiling ') + f.name);
  if (m === 'stack') {
    f.openW = f.w; f.openH = f.h; f.prevMode = cur;
    for (const sh of S.shapes) if (sh.type !== 'arrow' && !sh.in && sh.x >= f.x && sh.y >= f.y && sh.x + sh.w <= f.x + f.w && sh.y + sh.h <= f.y + f.h) sh.in = f.id;
  }
  if (cur === 'stack') { f.w = f.openW || f.w; f.h = f.openH || f.h; delete f.packed; for (const sh of S.shapes) if (sh.in === f.id) delete sh.in; }
  if (m === 'pack' || m === 'tile') kidsOf(f.id).sort((a, b) => a.y - b.y || a.x - b.x).forEach((k, i) => { k.order = i; });
  if (cur === 'pack' && m !== 'pack') { delete f.fit; delete f.packScale; for (const k of kidsOf(f.id)) if (k.prePack) { k.w = k.prePack.w; k.h = k.prePack.h; delete k.prePack; placeAny(k); } }
  if (m === 'tile') { f.preTile = { w: f.w, h: f.h }; for (const k of kidsOf(f.id)) k.preTile = k.preTile || { w: k.w, h: k.h, dx: k.x - f.x, dy: k.y - f.y }; }   // size and places tile started from, restored on leaving (no ratchet)
  if (cur === 'tile' && m !== 'stack' && m !== 'tile') {
    if (f.preTile) { f.w = f.preTile.w; f.h = f.preTile.h; delete f.preTile; }
    for (const k of kidsOf(f.id)) if (k.preTile) { const t = k.preTile; k.w = t.w; k.h = t.h; if (t.dx != null) moveTree(k, f.x + t.dx - k.x, f.y + t.dy - k.y); delete k.preTile; placeAny(k); }
  }
  if (m === 'stack' && activeId && descendants(f.id).some(d => d.id === activeId)) activate(f.id);
  if (m === 'tile') { const p = f.in && S.nodes[f.in]; if (!p || p.mode !== 'tile') aspectSize(f, ASPECTS[0]); } else delete f.aspect;   // a tiled folder starts at the screen's ratio
  f.mode = m;
  SEP.keep = f; relayout(f, true); SEP.keep = null; restack(); renderTree(); renderLinks(); dirty();
  if (!quiet) toast(m === 'stack' ? `${f.name} stacked: ${kidsOf(f.id).length} card(s). Drag a card out, or double-click to spread.` : m === 'tile' ? `${f.name} tiled in the screen's ratio: Enter fills the view with its panes; ⊞ again cycles 16:9, 3:2, 4:3, 1:1… Drag a pane's edge for its share.` : m === 'pack' ? `${f.name} packed: items flow into rows. Drop between two to insert.` : `${f.name} is free: items stay where you drop them.`);
}
function restack() {
  for (const n of Object.values(S.nodes)) live[n.id]?.el.classList.toggle('stashed', stashed(n));
  frameList().sort((a, b) => depthOf(a) - depthOf(b)).forEach(f => { if (live[f.id]) { framesEl.append(live[f.id].el); placeFrame(f); } });
}
// ------------------------------------------------------------------ selection and compact
// Shift-drag on empty canvas draws a selection box; Shift-click a header or folder tab toggles an item.
// Compact (c, or the palette) packs the selection, or with nothing selected the whole board, into tight rows.
// Ctrl-Z undoes the last compact or tile change (layout only).
const PICKED = new Set();                                   // cards and folders
const SEL = { strokes: new Set(), shapes: new Set() };     // v19: ink and drawn shapes picked by the area tool
function renderPicked() {
  document.querySelectorAll('path.stroke[data-id]').forEach(p => p.classList.toggle('picked', SEL.strokes.has(p.dataset.id)));
  shapesSvg.querySelectorAll('g.shape').forEach(g => g.classList.toggle('picked', SEL.shapes.has(g.dataset.id)));
}
function pickToggle(id, on) {
  on = on ?? !PICKED.has(id); on ? PICKED.add(id) : PICKED.delete(id);
  live[id]?.el.classList.toggle('picked', on); pickChip();
}
function pickClear() { for (const id of PICKED) live[id]?.el.classList.remove('picked'); PICKED.clear(); SEL.strokes.clear(); SEL.shapes.clear(); renderPicked(); pickChip(); }
function pickChip() {
  const c = $('#pick-chip'); if (!c) return;
  const ids = [...PICKED].filter(id => S.nodes[id]), ns = SEL.strokes.size, nh = SEL.shapes.size;
  c.hidden = !ids.length && !ns && !nh;
  const parts = []; if (ids.length) parts.push(ids.length + (ids.length === 1 ? ' card' : ' cards')); if (ns) parts.push(ns + (ns === 1 ? ' stroke' : ' strokes')); if (nh) parts.push(nh + (nh === 1 ? ' shape' : ' shapes'));
  $('#pick-n', c).textContent = parts.join(' · ') + ' selected';
  const show = (act, on) => { const b = $(`[data-act=${act}]`, c); if (b) b.hidden = !on; };
  show('compact', ids.length > 0); show('sketch', ns > 0); show('read', ns > 0);
}
// everything whose box lies fully inside the world rectangle a..b: cards and folders (tab included), ink strokes (board or
// folder ink; ink anchored to a page line stays), drawn shapes (an arrow needs both ends inside)
function pickInRect(a, b) {
  for (const n of Object.values(S.nodes)) {
    if (stashed(n)) continue;
    const top = n.kind === 'frame' ? n.y - LABEL_H : n.y;
    if (n.x >= a.x && top >= a.y && n.x + n.w <= b.x && n.y + n.h <= b.y) pickToggle(n.id, true);
  }
  for (const st of S.strokes) {
    if (st.aid || (st.owner ? S.nodes[st.owner] && stashed(S.nodes[st.owner]) : DESK.cur)) continue;   // hidden ink is not picked: the Board's loose ink on a desk, a hidden card's ink
    const pts = strokeWorldPts(st); if (!pts.length) continue;
    if (pts.every(([x, y]) => x >= a.x && y >= a.y && x <= b.x && y <= b.y)) SEL.strokes.add(st.id);
  }
  for (const sh of S.shapes) {
    if (shapeHidden(sh)) continue;
    if (sh.type === 'arrow') { const e = arrowEnds(sh); if ([[e.x1, e.y1], [e.x2, e.y2]].every(([x, y]) => x >= a.x && y >= a.y && x <= b.x && y <= b.y)) SEL.shapes.add(sh.id); }
    else if (sh.x >= a.x && sh.y >= a.y && sh.x + sh.w <= b.x && sh.y + sh.h <= b.y) SEL.shapes.add(sh.id);
  }
  renderPicked(); pickChip();
}
let REMOVE_UNDO = null;
function removeSelection() {
  const nodes = [...PICKED].filter(id => S.nodes[id]), strokes = S.strokes.filter(x => SEL.strokes.has(x.id)), shapes = S.shapes.filter(x => SEL.shapes.has(x.id));
  if (!nodes.length && !strokes.length && !shapes.length) { toast('Nothing selected. Drag the ⬚ tool (S) over what to remove.'); return; }
  REMOVE_UNDO = { strokes, shapes: shapes.map(x => ({ ...x })) };
  const owners = new Set(strokes.map(x => x.owner || null));
  S.strokes = S.strokes.filter(x => !SEL.strokes.has(x.id)); owners.forEach(o => renderInk(o));
  for (const sh of shapes) removeShape(sh.id);
  for (const n of nodes.map(id => S.nodes[id]).sort((p, q) => depthOf(q) - depthOf(p))) if (S.nodes[n.id]) removeNode(n.id);   // deepest first: items before their folder
  pickClear(); INK.ids = INK.ids.filter(id => S.strokes.some(x => x.id === id)); placeInkChip(); dirty();
  const parts = []; if (nodes.length) parts.push(nodes.length + (nodes.length === 1 ? ' card' : ' cards')); if (strokes.length) parts.push(strokes.length + ' strokes'); if (shapes.length) parts.push(shapes.length + (shapes.length === 1 ? ' shape' : ' shapes'));
  toast(`Removed ${parts.join(', ')}.${strokes.length || shapes.length ? ' Ctrl-Z brings the ink and shapes back.' : ''}`);
}
function removeUndo() {
  const u = REMOVE_UNDO; if (!u) return false; REMOVE_UNDO = null;
  const back = u.strokes.filter(x => !x.owner || S.nodes[x.owner]);   // ink whose card went with it stays gone
  S.strokes.push(...back); new Set(back.map(x => x.owner || null)).forEach(o => renderInk(o));
  for (const sh of u.shapes) if (!S.shapes.some(x => x.id === sh.id)) S.shapes.push(sh);
  renderShapes(); dirty(); toast(`Restored ${back.length} strokes and ${u.shapes.length} shapes.`); return true;
}
// the selected handwriting becomes a sketch card: it then has an address, tags, arrows and Aa → text, and moves as one
function sketchFromSelection() {
  const strokes = S.strokes.filter(x => SEL.strokes.has(x.id) && !x.aid && (!x.owner || S.nodes[x.owner]?.kind === 'frame'));
  if (!strokes.length) { toast('Select some handwriting first: the ⬚ tool (S), or Shift-drag.'); return null; }
  const b = inkBox(strokes.map(x => x.id)), pad = 20, owners = strokes.map(x => x.owner).filter(Boolean);
  const inId = owners.length && owners.every(o => o === owners[0]) ? owners[0] : null;
  const count = Object.values(S.nodes).filter(m => m.kind === 'sketch').length + 1;
  const n = addNode({ kind: 'sketch', name: 'sketch' + count, x: Math.round(b.x0 - pad), y: Math.round(b.y0 - pad - HDR), w: Math.max(200, Math.round(b.x1 - b.x0 + 2 * pad)), h: Math.max(140, Math.round(b.y1 - b.y0 + 2 * pad + HDR)), ...(inId ? { in: inId } : {}) });
  const olds = new Set(strokes.map(x => x.owner || null));
  for (const x of strokes) { const pts = strokeWorldPts(x); x.pts = pts.map(([px, py], i) => [px - n.x, py - n.y, x.pts[i]?.[2] ?? 0.5]); x.owner = n.id; delete x._d; }
  olds.forEach(o => renderInk(o)); renderInk(n.id);
  const L = live[n.id]; if (L) $('.sk-hint', L.body)?.remove();
  pickClear(); pickToggle(n.id, true); activate(n.id); INK.ids = []; placeInkChip(); renderTree(); dirty();
  toast(`${n.name}: a sketch card from ${strokes.length} strokes. It has an address, tags and arrows now; Aa reads it.`);
  return n;
}
function marquee(ev) {
  if (!ev.shiftKey) pickClear();   // Shift adds to the selection
  const r = viewport.getBoundingClientRect(), box = el('div', 'marquee'); viewport.append(box);
  const x0 = ev.clientX, y0 = ev.clientY; viewport.setPointerCapture(ev.pointerId);
  const rect = e => ({ l: Math.min(x0, e.clientX), t: Math.min(y0, e.clientY), r: Math.max(x0, e.clientX), b: Math.max(y0, e.clientY) });
  const mv = e => { const q = rect(e); Object.assign(box.style, { left: q.l - r.left + 'px', top: q.t - r.top + 'px', width: q.r - q.l + 'px', height: q.b - q.t + 'px' }); };
  const up = e => {
    viewport.removeEventListener('pointermove', mv); viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up); box.remove();
    const q = rect(e), a = s2w(q.l - r.left, q.t - r.top), b = s2w(q.r - r.left, q.b - r.top);
    pickInRect(a, b);
    if (PICKED.size || SEL.strokes.size || SEL.shapes.size) document.activeElement?.blur?.();   // so Delete and Ctrl-Z reach the board, not a shell that still had the keyboard
  };
  viewport.addEventListener('pointermove', mv); viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up);
}
let LAYOUT_UNDO = null;
function layoutSnap(label) {
  const nodes = {}; for (const n of Object.values(S.nodes)) nodes[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h, preTile: n.preTile && { ...n.preTile } };
  LAYOUT_UNDO = { label, nodes, shapes: S.shapes.map(sh => ({ sh, x: sh.x, y: sh.y })) };
}
function layoutUndo() {
  const u = LAYOUT_UNDO; if (!u) return toast('Nothing to undo.');
  LAYOUT_UNDO = null; settle();
  for (const [id, g] of Object.entries(u.nodes)) { const n = S.nodes[id]; if (!n) continue; Object.assign(n, { x: g.x, y: g.y, w: g.w, h: g.h }); if (g.preTile) n.preTile = g.preTile; else delete n.preTile; placeAny(n); }
  for (const { sh, x, y } of u.shapes) { sh.x = x; sh.y = y; }
  renderShapes(); renderLinks(); dirty(); toast('Undid ' + u.label);
}
// rows in reading order, as wide as a squarish block of the same area
function shelfPack(items, x0, y0) {
  const top = k => (k.kind === 'frame' ? LABEL_H : 0);
  items.sort((a, b) => (a.y - top(a)) - (b.y - top(b)) || a.x - b.x);
  const area = items.reduce((s, k) => s + (k.w + GAP) * (k.h + top(k) + GAP), 0);
  const rowW = Math.max(Math.sqrt(area) * 1.5, ...items.map(k => k.w));
  let x = 0, y = 0, rowH = 0;
  for (const k of items) {
    if (x > 0 && x + k.w > rowW) { x = 0; y += rowH + GAP; rowH = 0; }
    moveTree(k, x0 + x - k.x, y0 + y + top(k) - k.y);
    x += k.w + GAP; rowH = Math.max(rowH, k.h + top(k));
  }
}
function compact(which) {
  let ids = which === 'selection' ? [...PICKED].filter(id => S.nodes[id]) : null;
  if (which === 'selection' && !ids.length) return toast('Select items first: Shift-drag on the canvas, or Shift-click headers.');
  layoutSnap(which === 'selection' ? 'compact selection' : 'compact all'); settle(); SEP.off++; setTimeout(() => { SEP.off = Math.max(0, SEP.off - 1); }, 0);
  if (!ids) {
    // everything: pull every free folder's walls in (deepest first), then pack what lies loose on the canvas
    for (const f of frameList().filter(f => !stashed(f)).sort((a, b) => depthOf(b) - depthOf(a))) {
      if ((f.mode || 'free') === 'free' && kidsOf(f.id).length) setMode(f, 'free', true); else relayout(f);
    }
    const roots = Object.values(S.nodes).filter(n => !n.in);
    const top = k => (k.kind === 'frame' ? LABEL_H : 0);
    shelfPack(roots, Math.min(...roots.map(k => k.x)), Math.min(...roots.map(k => k.y - top(k))));
  } else {
    // only the outermost picked items move; group them by the folder they sit in, pack each group where it starts
    const set = new Set(ids), roots = ids.map(id => S.nodes[id]).filter(n => !ancestors(n).some(a => set.has(a.id)));
    const groups = new Map(); for (const n of roots) { const k = n.in || ''; groups.set(k, [...(groups.get(k) || []), n]); }
    const top = k => (k.kind === 'frame' ? LABEL_H : 0);
    for (const [fid, items] of groups) {
      const f = fid && S.nodes[fid];
      if (f && (f.mode === 'pack' || f.mode === 'tile' || f.mode === 'stack')) { relayout(f); continue; }  // those folders already arrange themselves
      shelfPack(items, Math.min(...items.map(k => k.x)), Math.min(...items.map(k => k.y - top(k))));
      if (f) { setMode(f, 'free', true); }
    }
  }
  restack(); renderShapes(); renderLinks(); renderTree(); dirty();
  toast(`Compacted ${ids ? ids.length + ' item(s)' : 'the board'}. Ctrl-Z undoes.`);
}
// Show something that sits inside stacked folders: spread each enclosing deck, outermost first.
function reveal(n) { deskReveal(n); for (const a of ancestors(n).reverse()) if (a.mode === 'stack') setMode(a, a.prevMode || 'free', true); }
function slotOrder(t, n, w) {
  renumber(t);
  const sib = kidsOf(t.id).filter(k => k !== n).sort(byOrder);
  let i = sib.findIndex(s => s.y > w.y || (w.y >= s.y && w.y <= s.y + s.h && s.x + s.w / 2 > w.x));
  if (i < 0) i = sib.length;
  return (sib[i]?.order ?? sib.length) - 0.5;
}
// Put n into folder t (null: the bare canvas). w is the drop point; without one, n goes to the end of the folder.
function adopt(n, t, w, quiet) {
  const from = n.in && S.nodes[n.in] ? S.nodes[n.in] : null;
  if (t && (t === n || (n.kind === 'frame' && descendants(n.id).includes(t)))) return;
  if (!PERSP.building && t?.derived === 'process' && !(t.owner && S.edges.some(e => e.type === 'spawn' && e.from === t.owner && e.to === n.id))) { toast('In the process perspective a folder is a shell and what it spawned. Spawn from the shell (⑂), or switch to the manual perspective.'); return; }
  if (!PERSP.building && t?.derived === 'fs') { fsDrop(n, t); return; }
  if (!PERSP.building && t?.derived === 'tmux') { toast('In the tmux perspective a folder is a session on the socket. Adopt sessions from the navigator (tmux:), or switch to the manual perspective.'); return; }
  if (!PERSP.building && (t?.derived === 'proc' || t?.derived === 'unit')) { toast('This folder is the host\'s own tree (' + t.derived + '); it is read from the host, not arranged by hand.'); return; }
  if (!PERSP.building && (t?.derived === 'tag' || (perspCur() === 'tag' && from?.derived === 'tag'))) { tagDrop(n, t, from); return; }
  if (!PERSP.building && perspCur() === 'fs' && from?.derived === 'fs' && !(t?.derived === 'fs')) { toast('In the filesystem perspective everything lives in a directory: drop it into another directory to move it.'); return; }
  if (!PERSP.building && hostKey(hostOf(n)) !== hostKey(t ? hostOf(t) : null) && [n, ...(n.kind === 'frame' ? descendants(n.id) : [])].some(m => m.kind === 'term' && m.backend === 'pty' && live[m.id]?.backend?.ws && !live[m.id].backend.dead && !live[m.id].backend.parked)) { toast(`${n.name} has a running shell: a process cannot change host. Kill it, or open a new shell in the other folder.`); return; }
  if (t) n.in = t.id; else delete n.in;
  if (t && (!w || t.mode === 'stack')) {
    const ks = kidsOf(t.id).filter(k => k !== n), top = n.kind === 'frame' ? LABEL_H : 0;
    const y = ks.length ? Math.max(...ks.map(k => k.y + k.h)) + GAP + top : t.y + PAD + top;
    moveTree(n, t.x + PAD - n.x, y - n.y);
  } else if (!t && !w && from) {
    const root = [from, ...ancestors(from)].pop();
    moveTree(n, root.x + root.w + 80 - n.x, root.y - n.y);
  }
  if (t && (t.mode === 'pack' || t.mode === 'tile')) n.order = w ? slotOrder(t, n, w) : 1e9;
  if (t?.mode === 'tile') n.preTile = n.preTile || { w: n.w, h: n.h };
  if (from?.mode === 'tile' && from !== t && n.preTile) { n.w = n.preTile.w; n.h = n.preTile.h; delete n.preTile; placeAny(n); }
  if (t && t.mode === 'stack') n.order = -1;
  if (t) renumber(t);
  SEP.keep = n;
  if (from && from !== t) relayout(from, true);
  if (t) relayout(t, true); else separate(null, n);
  SEP.keep = null;
  restack(); renderTree(); renderLinks(); updateAllTitles(); dirty();
  if (!quiet && from !== t) toast(t ? `${n.name} → ${fullPath(t)}${t.mode === 'stack' ? ' (on top of the deck)' : ''}` : `${n.name} is loose on the canvas`);
}
let dropHint = null;
function dragSkip(n) { return new Set([n.id, ...(n.kind === 'frame' ? descendants(n.id).map(d => d.id) : [])]); }
function hoverDrop(e, n, skip) {
  const w = evWorld(e), t = containerAt(w.x, w.y, skip || dragSkip(n)), id = t ? t.id : null;
  $('#st-addr').textContent = t ? `drop into ${fullPath(t)}${t.mode !== 'free' ? ` (${t.mode})` : ''}` : 'drop on the canvas';
  if (id === dropHint) return;
  clearDrop(); dropHint = id; if (id) live[id]?.el.classList.add('drop-target');
}
function clearDrop() { if (dropHint) live[dropHint]?.el.classList.remove('drop-target'); dropHint = null; }
function dropInto(n, e, skip) { clearDrop(); const w = evWorld(e); adopt(n, containerAt(w.x, w.y, skip || dragSkip(n)), w); }
function startFolderDrag(ev, handle, n) {
  ev.stopPropagation(); ev.preventDefault(); activate(n.id);
  const items = [n, ...descendants(n.id)], skip = dragSkip(n), b = { x0: n.x, y0: n.y - LABEL_H, x1: n.x + n.w, y1: n.y + n.h };
  const inside = new Set([n.id, ...descendants(n.id).map(d => d.id)]);
  const shapes = S.shapes.filter(s => s.type !== 'arrow' && (s.in ? inside.has(s.in) : n.mode !== 'stack' && s.x >= b.x0 && s.y >= b.y0 && s.x + s.w <= b.x1 && s.y + s.h <= b.y1));
  dragWith(ev, handle, [...items, ...shapes], e => { items.forEach(placeAny); renderLinks(); hoverDrop(e, n, skip); },
    e => { if (n.x === b.x0 && n.y === b.y0 + LABEL_H) return clearDrop(); dropInto(n, e, skip); items.forEach(m => scheduleLineInk(m.id)); });
}
function renderDeck(n) {
  const L = live[n.id], d = L && $('.deck', L.el); if (!d) return;
  d.hidden = n.mode !== 'stack' || !!n.packed; if (d.hidden) { d.replaceChildren(); d._sig = ''; return; }
  const kids = kidsOf(n.id).sort(byOrder), sig = kids.map(k => k.id + k.name + (k.mode || '')).join('|');
  if (d._sig === sig) return;
  d._sig = sig;
  d.className = 'deck n' + Math.min(kids.length, 3);
  const face = el('div', 'deck-face');
  const top = el('div', 'deck-top'); top.innerHTML = '<b></b><span class="badge"></span>';
  $('b', top).textContent = kids[0] ? kids[0].name : 'empty';
  $('.badge', top).textContent = kids[0] ? (kids[0].kind === 'frame' ? 'folder' : badgeOf(kids[0])) : '';
  const list = el('div', 'deck-list');
  for (const k of kids) {
    const r = el('button', 'deck-row'); r.innerHTML = '<span class="g"></span><span class="nm"></span>';
    $('.g', r).textContent = k.kind === 'frame' ? FICON[k.mode || 'free'] : KIND_GLYPH[k.kind] || '·'; $('.nm', r).textContent = k.name;
    r.title = 'Click to spread the deck and open · drag out to take it out';
    r.addEventListener('pointerdown', ev => pullCard(ev, r, n, k));
    list.append(r);
  }
  const hint = el('div', 'deck-hint'); hint.textContent = kids.length ? 'drag a card out · double-click to spread' : 'drop items here';
  face.append(top, list, hint);
  face.addEventListener('pointerdown', ev => { if (ev.button === 0 && !ev.target.closest('.deck-row')) startFolderDrag(ev, face, n); });
  d.replaceChildren(face);
}
function pullCard(ev, row, deck, k) {
  if (ev.button !== 0) return;
  ev.stopPropagation(); ev.preventDefault();
  row.setPointerCapture(ev.pointerId);
  const sx = ev.clientX, sy = ev.clientY, skip = new Set([deck.id, ...dragSkip(k)]); let ghost = null;
  const mv = e => {
    if (!ghost && Math.hypot(e.clientX - sx, e.clientY - sy) > 6) { ghost = el('div', 'deck-ghost'); ghost.textContent = (KIND_GLYPH[k.kind] || '') + ' ' + k.name; document.body.append(ghost); }
    if (ghost) { ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; hoverDrop(e, k, skip); }
  };
  const up = e => {
    row.removeEventListener('pointermove', mv); row.removeEventListener('pointerup', up); row.removeEventListener('pointercancel', up);
    clearDrop();
    if (!ghost) { k.kind === 'frame' ? jumpFolder(k) : jumpNode(k); return; }
    ghost.remove();
    const w = evWorld(e);
    if (w.x >= deck.x && w.x <= deck.x + deck.w && w.y >= deck.y - LABEL_H && w.y <= deck.y + deck.h) return;
    moveTree(k, w.x - Math.min(k.w / 2, 120) - k.x, w.y - 14 - k.y);
    adopt(k, containerAt(w.x, w.y, skip), w);
    activate(k.id);
  };
  row.addEventListener('pointermove', mv); row.addEventListener('pointerup', up); row.addEventListener('pointercancel', up);
}
function jumpFolder(f) {
  if (VIEW !== 'canvas') setView('canvas');
  reveal(f); pushHistory(); activate(f.id);
  animateTo(camTarget(f.x, f.y - LABEL_H, f.w, f.h + LABEL_H, 1));
}
function findFolder(p) {
  if (!p) return null;
  const low = String(p).trim().toLowerCase().replace(/\s*\/\s*/g, '/');
  return frameList().find(f => fullPath(f).toLowerCase() === low) || frameList().find(f => f.name.toLowerCase() === low) || frameList().find(f => f.id === p) || null;
}

// ------------------------------------------------------------------ folder tree: the same nesting as a list
function renderTree() {
  const list = $('#tp-list'); if (!list || !S) return;
  const closed = S.treeClosed || (S.treeClosed = {});
  const rows = [];
  const row = (n, d) => {
    const isF = n.kind === 'frame', owner = isF && n.owner && S.nodes[n.owner], kids = isF ? kidsOf(n.id).sort(byOrder).filter(k => !owner || k.id !== owner.id) : [];
    const r = el('div', 'tp-row' + (isF ? ' tp-f' : '') + (n.id === activeId ? ' on' : '') + (stashed(n) ? ' tp-stashed' : ''));
    r.style.setProperty('--d', d); r.draggable = true; r.dataset.id = n.id; r.setAttribute('role', 'treeitem');
    const tw = el('button', 'tp-tw'); tw.textContent = isF && kids.length ? (closed[n.id] ? '▸' : '▾') : '';
    tw.onclick = ev => { ev.stopPropagation(); closed[n.id] = !closed[n.id]; renderTree(); dirty(); };
    const ic = el('span', 'tp-ic'); ic.textContent = owner ? (KIND_GLYPH[owner.kind] || '·') + FICON[n.mode || 'free'] : isF ? FICON[n.mode || 'free'] : KIND_GLYPH[n.kind] || '·';
    const nm = el('span', 'tp-nm'); nm.textContent = owner ? owner.name : n.name;
    const mt = el('span', 'tp-mt'); mt.textContent = (isF ? (n.mode === 'stack' ? (n.packed ? `package of ${kids.length}` : `deck of ${kids.length}`) : String(kids.length || '')) : badgeOf(n)) + tagsOf(owner || n).filter(t => t !== 'aggregator' || !isF).map(t => ' #' + t).join('');
    if (TAG_FILTER && !tagsOf(n).includes(TAG_FILTER)) r.classList.add('dim');
    r.append(tw, ic, nm, mt);
    r.onclick = () => (owner ? jumpNode(owner) : isF ? jumpFolder(n) : jumpNode(n));
    rows.push(r);
    if (n.kind === 'buffer' && (n.id === activeId || (VIEW === 'editor' && ED.node === n))) {   // v16: the focused page's heading tree
      const lines = pageText(n).split('\n'), stack = [];
      lines.forEach((ln, i) => { const m = ln.match(/^(#{1,6}) (.*)$/); if (!m) return; const lv = m[1].length; while (stack.length && stack[stack.length - 1] >= lv) stack.pop(); const depth = stack.length; stack.push(lv);
        const h = el('div', 'tp-row tp-h'); h.style.setProperty('--d', d + 1 + depth); h.dataset.id = n.id; h.dataset.line = i + 1;
        const ic = el('span', 'tp-ic', '§'), nm = el('span', 'tp-nm', m[2].replace(/\s*\^[\w-]+$/, '')), mt = el('span', 'tp-mt', 'h' + lv); h.append(el('span', 'tp-tw'), ic, nm, mt);
        h.onclick = ev => { ev.stopPropagation(); edOpen(n, lineFrom(n, i + 1)); }; rows.push(h); });
    }
    if (isF && !closed[n.id]) kids.forEach(k => row(k, d + 1));
  };
  const all = Object.values(S.nodes), roots = all.filter(n => !n.in || !S.nodes[n.in]);
  roots.filter(n => n.kind === 'frame').sort((a, b) => a.y - b.y || a.x - b.x).forEach(f => row(f, 0));
  const loose = roots.filter(n => n.kind !== 'frame').sort((a, b) => a.y - b.y || a.x - b.x);
  const cv = el('div', 'tp-row tp-root'); cv.dataset.id = ''; cv.innerHTML = '<span class="tp-tw"></span><span class="tp-ic">∞</span><span class="tp-nm">loose on the canvas</span><span class="tp-mt"></span>';
  $('.tp-mt', cv).textContent = loose.length || '';
  rows.push(cv); loose.forEach(n => row(n, 1));
  list.replaceChildren(...rows);
}
(() => {
  const list = $('#tp-list'); let dragId = null, over = null;
  const target = e => e.target.closest('.tp-f, .tp-root');
  list.addEventListener('dragstart', e => { const r = e.target.closest('.tp-row'); dragId = r?.dataset.id || null; if (dragId) { e.dataTransfer.setData('text/plain', S.nodes[dragId].name); e.dataTransfer.effectAllowed = 'move'; } });
  list.addEventListener('dragover', e => {
    const t = target(e); if (!dragId || !t) return;
    const f = t.dataset.id ? S.nodes[t.dataset.id] : null, n = S.nodes[dragId];
    if (f && (f === n || (n.kind === 'frame' && descendants(n.id).includes(f)))) return;
    e.preventDefault(); if (over !== t) { over?.classList.remove('drop'); over = t; t.classList.add('drop'); }
  });
  list.addEventListener('dragleave', e => { if (over && !over.contains(e.relatedTarget)) { over.classList.remove('drop'); over = null; } });
  list.addEventListener('drop', e => {
    e.preventDefault(); over?.classList.remove('drop'); over = null;
    const t = target(e), n = dragId && S.nodes[dragId]; dragId = null; if (!t || !n) return;
    const f = t.dataset.id ? S.nodes[t.dataset.id] : null;
    if ((n.in || null) === (f ? f.id : null)) return;
    adopt(n, f, null);
  });
  list.addEventListener('dragend', () => { over?.classList.remove('drop'); over = null; dragId = null; });
})();
function toggleTree(open) {
  open = open ?? !document.body.classList.contains('tree-open');
  document.body.classList.toggle('tree-open', open);
  $('#toggle-tree').classList.toggle('on', open);
  if (S) { S.tree = open; dirty(); }
}
$('#toggle-tree').onclick = () => toggleTree();
$('#tp-close').onclick = () => toggleTree(false);
$('#tp-new').onclick = () => $('#add-frame').click();

function mountNode(n) {
  const e = el('div', 'node k-' + n.kind); e.dataset.id = n.id;
  const hdr = Object.assign(el('div', 'hdr'), { innerHTML: '<i class="dot"></i><span class="path"><span class="anc"></span><b class="name"></b></span><span class="badge"></span><span class="tags"></span><span class="btns"></span>' });
  const body = el('div', 'body'), lod = Object.assign(el('div', 'lod'), { innerHTML: '<b></b><pre></pre>' }), ink = svgEl('svg', { class: 'ink' });
  const port = el('div', 'port'); port.title = 'Drag onto another node to add a pipe';
  const rs = el('div', 'rs'), rse = el('div', 'rse'), rsb = el('div', 'rsb'); rs.title = 'Drag to resize'; rse.title = 'Drag: width'; rsb.title = 'Drag: height';
  e.append(hdr, body, lod, ink, port, rse, rsb, rs); nodesEl.append(e);
  e.style.zIndex = ++topZ;
  const L = live[n.id] = { el: e, hdr, body, lod, ink };
  const btns = $('.btns', hdr);
  const B = (label, title, fn) => { const b = el('button', 'hb'); b.textContent = label; b.title = title; b.onclick = ev => { ev.stopPropagation(); fn(b); }; btns.append(b); return b; };
  if (n.kind === 'term' || n.kind === 'repl') {
    if (n.tmux) B('⇠', 'Adopted tmux session ' + n.tmux + ': detach (the card goes, the session keeps running)', () => removeNode(n.id));
    B('⑂', 'Branch: spawn a child that inherits this node’s context', () => spawnChild(n));
    B('⇢', 'Send the selected output along pipe edges', () => pipeFrom(n));
    B('❝', 'Pin the selected output as a reference card', () => refFrom(n));
  } else if (n.kind === 'buffer') {
    B('🎙', 'Dictate at the cursor (Alt-V). Say "new line" or "new bullet". Click again to stop.', () => dictateInto(n));
    B('⚓', 'Drop a named anchor at the cursor', () => anchorAtCursor(n));
    B('⧉', 'Copy a ((block ref)) to the cursor position', () => { const v = live[n.id].view; copyText('((' + fmtAddr(bufferAddress(n, v.state, v.state.selection.main.head)) + '))'); });
    B('⇢', 'Send the selection (or current line) along pipe edges', () => pipeFrom(n));
    B('❝', 'Pin the selection as a reference card', () => refFrom(n));
  } else if (n.kind === 'ref') {
    B('↗', 'Jump to the source', () => jumpRef(n));
  } else if (n.kind === 'agent') {
    B('⑂', 'Branch: fork this conversation into a child agent', () => spawnChild(n));
  } else if (n.kind === 'acp') {
    B('⑂', 'New session: same agent, same folder (a new conversation, not a fork)', () => spawnChild(n));
    B('⇢', 'Send the selected text along pipe edges', () => pipeFrom(n));
    L.revive = B('↻', 'Revive: restart the agent and resume this conversation', () => L.backend?.revive());
    L.revive.hidden = true;
  } else if (n.kind === 'artifact') {
    B('↻', 'Reload the page', () => artMount(n, live[n.id]));
    if (n.block) B('✎', 'Jump to the html block this card shows', () => jumpBlock(n));
    else { B('✎', 'Edit the source as a page; publish it back from the palette', () => artifactSourcePage(n)); B('⧉', 'Versions', () => artifactVersions(n)); }
    B('⚙', 'Permissions: what this page may use', () => artifactPermissions(n));
    if (n.file) B('⌁', 'File-backed: ' + n.file + ' (reloads when the file changes)', () => toast('Backed by ' + n.file));
  } else if (n.kind === 'web') {
    B('↻', 'Reload', () => webGo(n, live[n.id]));
    B('↗', 'Open in a browser tab', () => { if (webUrlOk(n.url)) window.open(n.url, '_blank', 'noopener'); else toast('Only http and https URLs open in a tab.'); });
  } else if (n.kind === 'sketch') {
    B('Aa', 'Turn the ink on this card into a page (needs a model that reads images)', () => sketchToPage(n));
    B('⌫', 'Clear the ink on this card', () => sketchClear(n));
  } else if (n.kind === 'ghost') {
    B('↗', n.alias ? 'Jump to the real node' : n.tmuxTarget ? 'Adopt: a card attached to this tmux session' : n.dir ? 'Open: this directory becomes a folder' : 'Open: make it real (Emacs on the file; a page in demo mode)', () => ghostOpen(n));
  }
  B('✕', 'Delete (click twice)', b => confirmDel(b, () => removeNode(n.id)));
  place(n); updateTitle(n);
  if (n.emacs) L.el.classList.add('emacs');
  if (n.kind === 'term' || n.kind === 'repl') mountTerm(n, L);
  else if (n.kind === 'buffer') mountBuffer(n, L);
  else if (n.kind === 'ref') mountRef(n, L);
  else if (n.kind === 'agent') mountAgent(n, L);
  else if (n.kind === 'acp') mountAcp(n, L);
  else if (n.kind === 'artifact') mountArtifact(n, L);
  else if (n.kind === 'web') mountWeb(n, L);
  else if (n.kind === 'sketch') mountSketch(n, L);
  else if (n.kind === 'ghost') mountGhost(n, L);
  wireNode(n, L, port, rs);
  renderInk(n.id);
  return L;
}
function place(n) { const L = live[n.id]; if (L) { Object.assign(L.el.style, { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }); fitChrome(n); } }
// a folder's tab and a card's header keep their screen size, so a narrow item (or a far zoom) cannot show all of them:
// t-narrow drops the count, badge and tags; t-tiny drops the mode buttons, host and all header buttons but ✕. The name
// is always the last thing to go (ellipsis). Re-run when the zoom moves (applyCam) and when an item is placed.
let chromeZ = 1;
const CHROME = { frame: [250, 170], node: [240, 150] };
function fitChrome(n, z = cam().z) {
  const L = live[n.id]; if (!L || n.id === 'dock') return;
  const sw = n.w * z, t = CHROME[n.kind === 'frame' ? 'frame' : 'node'];
  L.el.classList.toggle('t-narrow', sw < t[0]); L.el.classList.toggle('t-tiny', sw < t[1]);
}
function fitChromeAll(z = cam().z) { chromeZ = z; for (const id in live) if (S.nodes[id]) fitChrome(S.nodes[id], z); }
function badgeOf(n) {
  if (n.kind === 'frame' && n.owner && S.nodes[n.owner]) return '✦ ' + S.nodes[n.owner].name;
  if (n.kind === 'artifact') return n.head ? 'v ' + String(n.head).slice(0, 6) : '';
  if (n.kind === 'ghost') return n.alias ? 'copy' : n.journalDay && !n.noteId ? 'journal' : n.noteId ? 'note' : n.linkTitle ? 'link' : n.tmuxTarget ? 'tmux' : n.procPid ? 'process' : n.unitName ? (n.unitState || 'unit') : n.hardlink ? 'hardlink' : n.link ? 'symlink' : n.mount ? 'mount' : n.dir ? 'directory' : 'file';
  if (n.kind === 'term') return n.backend === 'pty' ? shellName(n) || 'shell' : 'sim shell';
  if (n.kind === 'repl') return n.lang === 'js' ? 'js' : (n.cmd || '').split(' ')[0].replace('python3', 'py');
  if (n.kind === 'acp') return agentLabel(n.agent) + ' · ' + (live[n.id]?.backend?.stateText() || (SESS[n.id]?.state || '…').replace(/_/g, ' '));
  return { buffer: 'page', ref: 'ref', agent: 'agent' }[n.kind] || n.kind;
}
function updateTitle(n) {
  const L = live[n.id]; if (!L?.hdr) return;
  const p = pathOf(n.id), i = p.lastIndexOf('/');
  $('.anc', L.hdr).textContent = i >= 0 ? p.slice(0, i + 1) : '';
  $('.name', L.hdr).textContent = n.name;
  $('.badge', L.hdr).textContent = badgeOf(n);
  renderTags(n, L);
  $('b', L.lod).textContent = p;
}
const updateAllTitles = () => nodeList().forEach(updateTitle);
function rename(n, nameEl) {
  const old = n.name;
  nameEl.contentEditable = 'true'; nameEl.focus();
  const r = document.createRange(); r.selectNodeContents(nameEl); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const done = commit => {
    nameEl.contentEditable = 'false'; nameEl.onkeydown = nameEl.onblur = null;
    const v = nameEl.textContent.replace(/[\/›#@]/g, '-').trim();
    n.name = commit && v ? v : old;
    if (n.kind === 'frame') placeFrame(n); else updateAllTitles();
    renderTree(); dirty();
  };
  nameEl.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); done(true); } if (ev.key === 'Escape') done(false); };
  nameEl.onblur = () => done(true);
}

function mountTerm(n, L) {
  const term = new V.Terminal({ fontFamily: MONO, fontSize: 13, lineHeight: 1.12, cursorBlink: true, scrollback: 5000, theme: termTheme(), allowProposedApi: true });
  const fit = new V.FitAddon(); term.loadAddon(fit);
  term.open(L.body); L.term = term;
  L.fitNow = () => {
    if ((lastLod && n.id !== 'dock') || !L.body.clientWidth || !L.body.isConnected) return;
    try { fit.fit(); } catch {}
    L.backend?.resize?.(term.cols, term.rows);
  };
  L.ro = new ResizeObserver(() => { clearTimeout(L.fitT); L.fitT = setTimeout(L.fitNow, 40); });
  L.ro.observe(L.body);
  term.textarea?.addEventListener('focus', () => L.backend?.resize?.(term.cols, term.rows));   // focus makes this tab the one that sizes the PTY
  L.fitNow();
  if (n.kind === 'repl' && n.lang === 'js') L.backend = new JsRepl(n, term);
  else if (n.backend === 'pty') L.backend = DAEMON ? new PtyBackend(n, term, L) : new Offline(n, term);
  else L.backend = new FakeShell(n, term);
  term.onData(d => L.backend.input(d));
}

function mountBuffer(n, L) {
  const text = n.text || '', init = {};
  for (const a of n.anchors || []) init[a.id] = { pos: relocate(text, a), label: a.label };
  const state = V.EditorState.create({
    doc: text,
    extensions: [
      vimComp.of(vimExt(false)), V.basicSetup, V.markdown(), wikiCompletion, V.EditorView.lineWrapping, bufTheme, V.syntaxHighlighting(bufHighlight),
      anchorField.init(() => init), linkField, outlineKeys,
      V.EditorView.updateListener.of(u => {
        if (u.docChanged && ED.node === n) mirrorTo(ED.view, u, u.view);
        if (u.docChanged) { n.text = u.state.doc.toString(); dirty(); scheduleCrossRefresh(); blockCardsChanged(n); }
        if ((u.docChanged || u.selectionSet) && focusedBuf === n.id) scheduleBufAddr(n);
        if (u.docChanged || u.geometryChanged || u.viewportChanged) scheduleLineInk(n.id);
      }),
      V.EditorView.domEventHandlers({
        focus: () => { focusedBuf = n.id; showBufAddr(n); },
        mousedown: e => {
          const link = e.target.closest('.cm-wikilink');
          if (link && !e.shiftKey) { e.preventDefault(); openPage(link.dataset.page, n); return true; }
          const tear = e.target.closest('.cm-tear');
          if (tear) { e.preventDefault(); tearOutBlock(n, L.view.posAtDOM(tear)); return true; }
          const ref = e.target.closest('.blockref');
          if (ref) { e.preventDefault(); const r = resolveRef(ref.dataset.ref); if (r) jumpBuffer(r.node, r.pos); return true; }
          return false;
        },
      }),
    ],
  });
  L.view = new V.EditorView({ state, parent: L.body });
  L.backlinks = el('div', 'backlinks'); L.body.append(L.backlinks);
  L.inkLines = svgEl('svg', { class: 'ink-lines' }); L.body.append(L.inkLines);
  L.view.scrollDOM.addEventListener('scroll', () => scheduleLineInk(n.id), { passive: true });
}
function mountRef(n, L) {
  const src = el('div', 'ref-src'); src.textContent = '↗ ' + (n.srcLabel || 'source'); src.title = 'Jump to the source';
  src.onclick = () => jumpRef(n);
  const pre = el('pre'); pre.textContent = n.text || '';
  L.body.append(src, pre);
}

// ------------------------------------------------------------------ dragging and node wiring
function dragWith(ev, handle, items, onMove, onEnd) {
  const sx = ev.clientX, sy = ev.clientY, starts = items.map(m => ({ m, x: m.x, y: m.y }));
  handle.setPointerCapture(ev.pointerId);
  const mv = e => { const dx = (e.clientX - sx) / cam().z, dy = (e.clientY - sy) / cam().z; for (const s of starts) { s.m.x = Math.round(s.x + dx); s.m.y = Math.round(s.y + dy); } onMove(e); };
  const up = e => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); onEnd?.(e); dirty(); };
  handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
}
const RESIZING = { n: null };
// v17: resizing a card. Free/pack: its own size. Tile: the drag changes that pane's share of the split it sits in (dwm's
// mfact for the first pane, its own factor for the others), the folder retiles live. Ribbon: width only.
function nodeResized(n) {
  const f = n.in && S.nodes[n.in];
  if (f && f.mode === 'tile' && n.tile) {
    const t = n.tile, r = clamp((t.axis === 'x' ? n.w : n.h) / t.avail, 0.15, 0.85);
    if (t.first) f.mfact = r; else n.tfact = r;
    tileFolder(f); placeFrame(f); return;
  }
  place(n); if (f) relayout(f);
}
// resizing a folder. Pack: the dragged size is what the items must fit: rows re-flow, and when they still do not fit the
// items shrink together; below a deck's size the folder stacks. Tile: the panes retile into the new size. A deck
// dragged open un-stacks into the mode it had.
function frameResized(f) {
  const r = RESIZING;
  if (f.mode === 'stack') { if (r.w > DECK.w * 1.4 || r.h > DECK.h * 1.4) { const m = f.prevMode && f.prevMode !== 'stack' ? f.prevMode : 'pack'; setMode(f, m, true); f.fit = { w: r.w, h: r.h }; relayoutInner(f); } else { f.w = DECK.w; f.h = DECK.h; placeFrame(f); } return; }
  if (f.mode === 'pack' || f.mode === 'tile') {
    if (r.w < DECK.w * 0.9 && r.h < DECK.h * 0.9) { f.prevMode = f.mode; setMode(f, 'stack', true); toast(f.name + ' stacked: too small for its items. Drag the deck open to unstack.'); return; }
    if (f.mode === 'pack') f.fit = { w: f.w, h: f.h };
  }
  relayoutInner(f); if (f.in) relayout(S.nodes[f.in]);
}
function frameResizeEnd(f) { if (f.mode === 'free') { growFolder(f); placeFrame(f); } }
function resizeWith(handle, n, minW, minH, onMove, axis = 'xy', onEnd) {
  if (!handle) return;
  handle.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return; ev.stopPropagation(); ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, w0 = n.w, h0 = n.h;
    handle.setPointerCapture(ev.pointerId); RESIZING.n = n; RESIZING.w0 = w0; RESIZING.h0 = h0;
    const mv = e => { if (axis.includes('x')) n.w = Math.round(Math.max(minW, w0 + (e.clientX - sx) / cam().z)); if (axis.includes('y')) n.h = Math.round(Math.max(minH, h0 + (e.clientY - sy) / cam().z)); RESIZING.w = n.w; RESIZING.h = n.h; onMove(); renderLinks(); };
    const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); RESIZING.n = null; if (onEnd) onEnd(); SEP.keep = n; if (n.in && S.nodes[n.in]) relayout(S.nodes[n.in], true); else separate(null, n); SEP.keep = null; restack(); renderLinks(); dirty(); };
    handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up);
  });
}
function activate(id) {
  if (activeId && live[activeId]) live[activeId].el.classList.remove('active');
  activeId = id;
  const L = live[id]; if (!L) return;
  L.el.classList.add('active');
  if (L.term) L.backend?.resize?.(L.term.cols, L.term.rows);   // the card the user looks at sizes its PTY
  if (L.el.parentNode === nodesEl && +L.el.style.zIndex < topZ) L.el.style.zIndex = ++topZ;
  $$('#tp-list .tp-row').forEach(r => r.classList.toggle('on', r.dataset.id === id));
  updateSideCtx();
  L.backend?.maybeSeen?.();
}
function wireNode(n, L, port, rs) {
  L.el.addEventListener('pointerdown', () => activate(n.id));
  L.hdr.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || ev.target.closest('button') || ev.target.isContentEditable) return;
    ev.preventDefault();
    if (ev.shiftKey) { ev.stopPropagation(); pickToggle(n.id); return; }
    const moved = { x: n.x, y: n.y };
    dragWith(ev, L.hdr, [n], e => { place(n); renderLinks(); hoverDrop(e, n); }, e => { if (n.x !== moved.x || n.y !== moved.y) dropInto(n, e); else clearDrop(); });
  });
  L.lod.addEventListener('pointerdown', ev => {  // far out, the snapshot card is the handle
    if (ev.button !== 0) return; ev.preventDefault(); activate(n.id);
    const moved = { x: n.x, y: n.y };
    dragWith(ev, L.lod, [n], e => { place(n); renderLinks(); hoverDrop(e, n); }, e => { if (n.x !== moved.x || n.y !== moved.y) dropInto(n, e); else clearDrop(); });
  });
  L.hdr.addEventListener('dblclick', ev => {
    if (ev.target.closest('button')) return;
    if (ev.target.classList.contains('name')) { rename(n, ev.target); return; }
    jumpNode(n, 1);
  });
  for (const [h, axis] of [[rs, 'xy'], [$('.rse', L.el), 'x'], [$('.rsb', L.el), 'y']]) resizeWith(h, n, 200, 110, () => nodeResized(n), axis);
  port.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return; ev.stopPropagation(); ev.preventDefault();
    port.setPointerCapture(ev.pointerId);
    const p1 = { x: n.x + n.w / 2, y: n.y + n.h };
    const tmp = svgEl('path', { class: 'edge e-temp' }); edgesSvg.append(tmp);
    const mv = e => { const w = evWorld(e); tmp.setAttribute('d', `M${p1.x},${p1.y} C${p1.x},${p1.y + 80} ${w.x},${w.y - 80} ${w.x},${w.y}`); };
    const up = e => {
      port.removeEventListener('pointermove', mv); port.removeEventListener('pointerup', up); tmp.remove();
      const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
      if (t && t.dataset.id !== n.id) {
        if (S.edges.some(x => x.from === n.id && x.to === t.dataset.id)) return toast('Those nodes are already linked.');
        S.edges.push({ id: uid('e'), from: n.id, to: t.dataset.id, type: 'pipe' }); renderEdges(); dirty();
        toast('Pipe added. Select text and press ⇢ to send it. Click the label to change the edge type.');
      }
    };
    port.addEventListener('pointermove', mv); port.addEventListener('pointerup', up);
  });
}

// ------------------------------------------------------------------ node operations
function viewCenterWorld() { return s2w(VW() / 2, VH() / 2); }
function addNode(n) {
  n.id = n.id || uid('n');
  // A new item lands in whatever folder is under its top-left corner, unless the caller said where it belongs.
  if (!('in' in n)) { const t = containerAt(n.x + Math.min(40, n.w / 2), n.y + 20, new Set([n.id])); if (t && t.mode !== 'stack') n.in = t.id; }
  if (!n.in || !S.nodes[n.in]) delete n.in;
  if (n.in && S.nodes[n.in].mode === 'pack') n.order = 1e9;
  if (n._spawn !== false) n._spawn = true;   // made in this page: its first open may spawn (SEC-2), unless adopted; `_` keys are never saved
  deskJoin(n);
  S.nodes[n.id] = n; mount(n);
  SEP.keep = n; if (n.in) relayout(S.nodes[n.in], true); else separate(null, n); SEP.keep = null;
  restack(); renderEdges(); activate(n.id); renderTree(); dirty(); return n;
}
function newAt(kind, extra = {}) {
  const c = viewCenterWorld(), w = extra.w || (kind === 'frame' ? 760 : kind === 'buffer' ? 460 : 560), h = extra.h || (kind === 'frame' ? 460 : 320);
  const jitter = () => Math.round((Math.random() - .5) * 60);
  const count = Object.values(S.nodes).filter(m => m.kind === kind).length + 1;
  const names = { term: 'shell', repl: 'repl', buffer: 'page', frame: 'folder', agent: 'agent', acp: 'agent', artifact: 'artifact', web: 'web', sketch: 'sketch' };
  return addNode({ kind, name: names[kind] + count, x: Math.round(c.x - w / 2) + jitter(), y: Math.round(c.y - h / 2) + jitter(), w, h, ...extra });
}
function removeNode(id) {
  PICKED.delete(id); pickChip();
  const gone = S.nodes[id], parent = gone?.in && S.nodes[gone.in];
  if (gone?.kind === 'frame') {
    if (gone.mode === 'stack') setMode(gone, gone.prevMode || 'free', true);
    for (const k of kidsOf(id)) { if (parent) k.in = parent.id; else delete k.in; }
  }
  const L = live[id];
  if (L) { L.backend?.kill?.(); L.ro?.disconnect(); L.view?.destroy(); L.term?.dispose(); if (L.frame?.contentWindow) HOSTS.delete(L.frame.contentWindow); L.el.remove(); delete live[id]; }
  delete S.nodes[id]; DESK.mem.delete(id); for (const d of deskList()) delete d.members[id];
  S.edges = S.edges.filter(e => e.from !== id && e.to !== id);
  S.strokes = S.strokes.filter(s => s.owner !== id);
  if (parent) relayout(parent, true);
  if (gone?.kind === 'buffer') blockCardsChanged(gone);
  restack(); renderEdges(); updateAllTitles(); renderTree(); dirty();
}
function spawnChild(n, name) {
  const kids = childrenOf(n.id, 'spawn'), k = kids.length, w = Math.min(n.w, 440), h = Math.min(n.h, 300);
  const child = { id: uid('n'), kind: n.kind, backend: n.backend, lang: n.lang, cmd: n.cmd, name: name ? clean(name) : 'b' + (k + 1),
    x: n.x + k * (w + 40), y: n.y + n.h + 90, w, h, spawnFrom: n.id, in: n.agg && S.nodes[n.agg] ? n.agg : n.in };
  if (n.kind === 'term' && n.backend !== 'pty') {
    child.cwd = n.cwd; child.env = { ...(n.env || {}) };
    child.spawnNote = `branched from ${pathOf(n.id)}: started in ${n.cwd}, inherited ${Object.keys(child.env).length} env var(s)`;
  }
  if (n.kind === 'term' && n.backend === 'pty') { child.env = { ...(n.env || {}) }; if (shellName(n)) child.shell = n.shell; }
  if (n.kind === 'repl' && n.lang === 'js') { child.history = [...(n.history || [])]; child.replayFrom = pathOf(n.id); }
  if (n.kind === 'repl' && n.lang !== 'js') child._replay = n.inputLog || '';
  if (n.kind === 'acp') { child.agent = n.agent; child.cwd = n.cwd; }   // a new session in the same folder, not a fork
  if (n.kind === 'agent') { child.turns = (n.turns || []).map(t => ({ ...t })); child.log = [...(n.log || []).filter(m => !m.live).map(m => ({ ...m })), { t: 'note', text: `Forked from ${pathOf(n.id)} after ${child.turns.length} turn(s). This branch continues on its own.` }]; child.tier = n.tier; }
  S.edges.push({ id: uid('e'), from: n.id, to: child.id, type: 'spawn' });
  addNode(child);
  const vis = w2s(child.x + child.w, child.y + child.h);
  if (vis.y > VH() - 40 || vis.x > VW()) { pushHistory(); const x0 = Math.min(n.x, child.x), y0 = n.y; animateTo(camTarget(x0, y0, Math.max(n.x + n.w, child.x + child.w) - x0, child.y + child.h - y0, cam().z)); }
  return child;
}
function selectionOf(n) {
  const L = live[n.id];
  if (L.term) return L.term.getSelection();
  if (L.view) { const st = L.view.state, s = st.selection.main; return s.empty ? st.doc.lineAt(s.head).text : st.sliceDoc(s.from, s.to); }
  if (n.kind === 'acp') { const s = getSelection(); return s && L.body.contains(s.anchorNode) ? String(s) : ''; }
  return '';
}
function pipeFrom(n) {
  const text = selectionOf(n);
  if (!text || !text.trim()) return toast(n.kind === 'buffer' ? 'Nothing to send on this line.' : 'Select some output in the terminal first.');
  const targets = childrenOf(n.id, 'pipe');
  if (!targets.length) return toast('No pipes from here yet. Drag the ● at the bottom edge onto another node.');
  for (const t of targets) {
    const L = live[t.id]; if (!L) continue;
    if (t.kind === 'buffer') {
      const doc = L.view.state.doc, ins = `\n*from ${pathOf(n.id)}:*\n\`\`\`\n${text.replace(/\s+$/, '')}\n\`\`\`\n`;
      L.view.dispatch({ changes: { from: doc.length, insert: ins }, scrollIntoView: true });
    } else if ((t.kind === 'agent' || t.kind === 'acp') && L.ta) {   // drafts into the composer, never sends
      L.ta.value = (L.ta.value ? L.ta.value + '\n' : '') + text; L.ta.focus();
    } else if (L.backend) {
      L.backend.input(text.replace(/\r?\n/g, '\r').replace(/\r$/, '') + (n.kind === 'buffer' ? '\r' : ''));
    }
    L.el.classList.remove('pulse'); void L.el.offsetWidth; L.el.classList.add('pulse');
    for (const e of S.edges) if (e.type === 'pipe' && e.from === n.id && e.to === t.id) flowPipe(e);
  }
  toast(`Sent ${text.split('\n').length} line(s) to ${targets.map(t => pathOf(t.id)).join(', ')}`);
}
function refFrom(n) {
  const L = live[n.id]; let text = '', src, label;
  if (L.term) {
    text = L.term.getSelection(); if (!text.trim()) return toast('Select some output first.');
    const p = L.term.getSelectionPosition();
    const line = p ? p.start.y : 0, lines = p ? p.end.y - p.start.y + 1 : 1;
    src = { node: n.id, line, lines }; label = `${pathOf(n.id)} › L${line + 1}${lines > 1 ? '–' + (line + lines) : ''}`;
  } else {
    const st = L.view.state, s = st.selection.main;
    if (s.empty) return toast('Select some text first.');
    text = st.sliceDoc(s.from, s.to);
    const aid = uid('a'); L.view.dispatch({ effects: anchorAdd.of({ id: aid, pos: s.from, label: null }) });
    src = { node: n.id, aid }; label = fmtAddr(bufferAddress(n, st, s.from));
  }
  const k = childrenOf(n.id, 'ref').length, lines = text.split('\n').length;
  const r = { id: uid('n'), kind: 'ref', in: n.in, name: `${n.name}-ref${k + 1}`, text, src, srcLabel: label, x: n.x + n.w + 70, y: n.y + k * 50, w: 360, h: clamp(70 + lines * 18, 110, 320) };
  S.edges.push({ id: uid('e'), from: n.id, to: r.id, type: 'ref' });
  addNode(r);
}
function anchorAtCursor(n) {
  const v = live[n.id].view;
  ask('Name this anchor (address becomes ' + n.name + '#name)', '', name => {
    name = name.replace(/[^\w-]/g, '-');
    v.dispatch({ effects: anchorAdd.of({ id: uid('a'), pos: v.state.selection.main.head, label: name }) });
    dirty(); toast(`Anchor ${n.name}#${name} set. It moves with the text.`);
  });
}

// ------------------------------------------------------------------ jumping
function jumpNode(n, maxZ = 1, done) { if (VIEW !== 'canvas') setView('canvas'); reveal(n); pushHistory(); activate(n.id); animateTo(camTarget(n.x, n.y, n.w, n.h, maxZ), done); }
function jumpBuffer(n, pos) {
  if (VIEW === 'editor') return edOpen(n, pos);
  jumpNode(n, 1, () => {
    const v = live[n.id]?.view; if (!v) return;
    v.dispatch({ selection: { anchor: pos, head: Math.min(pos + 1, v.state.doc.length) }, scrollIntoView: true }); v.focus();
  });
}
function jumpRef(r) {
  const n = S.nodes[r.src?.node]; if (!n) return toast('The source node is gone.');
  if (r.src.aid) {
    const a = live[n.id]?.view?.state.field(anchorField)[r.src.aid];
    return a ? jumpBuffer(n, a.pos) : jumpNode(n);
  }
  jumpNode(n, 1, () => { const t = live[n.id]?.term; if (t) { t.scrollToLine(Math.max(0, r.src.line - 2)); t.select(0, r.src.line, t.cols * r.src.lines); } });
}

// ------------------------------------------------------------------ edges
function edgeGeom(a, b) {
  if (b.y >= a.y + a.h + 24 || b.y + b.h + 24 <= a.y) {
    const down = b.y > a.y;
    const p1 = { x: a.x + a.w / 2, y: down ? a.y + a.h : a.y }, p2 = { x: b.x + b.w / 2, y: down ? b.y : b.y + b.h };
    const d = Math.max(40, Math.abs(p2.y - p1.y) / 2) * (down ? 1 : -1);
    return [p1, { x: p1.x, y: p1.y + d }, { x: p2.x, y: p2.y - d }, p2];
  }
  const right = b.x > a.x;
  const p1 = { x: right ? a.x + a.w : a.x, y: a.y + Math.min(a.h / 2, 60) }, p2 = { x: right ? b.x : b.x + b.w, y: b.y + Math.min(b.h / 2, 60) };
  const d = Math.max(40, Math.abs(p2.x - p1.x) / 2) * (right ? 1 : -1);
  return [p1, { x: p1.x + d, y: p1.y }, { x: p2.x - d, y: p2.y }, p2];
}
let rsEdges = null;
const FLOWING = new Map();   // pipe edge id → until (ms): its dashes flow for a moment after a send
function flowPipe(e) {
  FLOWING.set(e.id, Date.now() + 2400);
  edgesSvg.querySelector(`.redge[data-edge="${CSS.escape(e.id)}"]`)?.classList.add('flowing');
  setTimeout(() => { if ((FLOWING.get(e.id) || 0) > Date.now()) return; FLOWING.delete(e.id); edgesSvg.querySelector(`.redge[data-edge="${CSS.escape(e.id)}"]`)?.classList.remove('flowing'); }, 2450);
}
const hashSeed = id => { let h = 7; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0; return (Math.abs(h) % 2147483646) + 1; };
// An edge's drawing is kept while its ends, its type and its flow stay the same, so a drag redraws only the edges of
// what moves (each edge was redrawn, rough.js and all, on every pointer move).
const edgeDrawn = new WeakMap();   // edge → { key, els }
function renderEdges() {
  const rs = rsEdges || (rsEdges = V.rough.svg(edgesSvg));
  const out = [];
  for (const e of [...S.edges, ...PERSP.edges]) {
    let a = S.nodes[e.from], b = S.nodes[e.to]; if (!a || !b || deskOff(a) || deskOff(b)) continue;
    a = visibleOf(a); b = visibleOf(b); if (a === b) continue;  // items in a stacked folder connect to its deck
    const [p1, c1, c2, p2] = edgeGeom(a, b);
    const key = [p1.x, p1.y, c1.x, c1.y, c2.x, c2.y, p2.x, p2.y, e.type, e.persp ? 1 : 0, (FLOWING.get(e.id) || 0) > Date.now() ? 1 : 0].join();
    const had = edgeDrawn.get(e);
    if (had?.key === key) { out.push(...had.els); continue; }
    const els = [];
    const o = { seed: hashSeed(e.id), roughness: 0.9, bowing: 0.8, stroke: 'currentColor', strokeWidth: 1.7 };
    const g = svgEl('g', { class: 'redge e-' + e.type + ((FLOWING.get(e.id) || 0) > Date.now() ? ' flowing' : ''), 'data-edge': e.id });
    g.append(rs.path(`M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, e.type === 'spawn' ? o : { ...o, strokeLineDash: e.type === 'pipe' ? [8, 6] : e.type === 'symlink' ? [6, 4] : [2, 5] }));
    const ang = Math.atan2(p2.y - c2.y, p2.x - c2.x), L = 13;
    g.append(rs.linearPath([[p2.x - L * Math.cos(ang - .5), p2.y - L * Math.sin(ang - .5)], [p2.x, p2.y], [p2.x - L * Math.cos(ang + .5), p2.y - L * Math.sin(ang + .5)]], o));
    els.push(g);
    const mx = .125 * p1.x + .375 * c1.x + .375 * c2.x + .125 * p2.x, my = .125 * p1.y + .375 * c1.y + .375 * c2.y + .125 * p2.y;
    const lg = svgEl('g', { class: `elabel e-${e.type}-l`, transform: `translate(${mx},${my})` });
    const w = e.type.length * 7 + 14;
    lg.append(svgEl('rect', { x: -w / 2, y: -10, width: w, height: 20 }));
    const tx = svgEl('text', { 'text-anchor': 'middle', y: 4 }); tx.textContent = e.type; lg.append(tx);
    const title = svgEl('title'); title.textContent = e.persp ? 'symlink on the host (follows the filesystem)' : 'Click to change type · Shift-click to delete'; lg.append(title);
    els.push(lg); edgeDrawn.set(e, { key, els }); out.push(...els);
    if (e.persp) continue;
    lg.addEventListener('pointerdown', ev => ev.stopPropagation());
    lg.addEventListener('click', ev => {
      ev.stopPropagation();
      if (ev.shiftKey) S.edges = S.edges.filter(x => x !== e);
      else e.type = { spawn: 'pipe', pipe: 'ref', ref: 'spawn' }[e.type];
      renderEdges(); updateAllTitles(); dirty();
    });
  }
  // put back only what changed when the list keeps its order (a drag), else rebuild it
  const kids = edgesSvg.children;
  if (kids.length === out.length && out.every((x, i) => kids[i] === x || !x.isConnected)) out.forEach((x, i) => { if (kids[i] !== x) kids[i].replaceWith(x); });
  else edgesSvg.replaceChildren(...out);
}
function renderLinks() { renderEdges(); renderShapes(); }

// ------------------------------------------------------------------ ink
function strokeOpts(s) {
  return { size: s.size, thinning: s.sim ? 0.5 : 0.65, smoothing: 0.5, streamline: 0.45, simulatePressure: !!s.sim, last: true };
}
function pathD(pts) {
  if (pts.length < 2) return '';
  const d = ['M', pts[0][0].toFixed(1), pts[0][1].toFixed(1), 'Q'];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    d.push(x0.toFixed(1), y0.toFixed(1), ((x0 + x1) / 2).toFixed(1), ((y0 + y1) / 2).toFixed(1));
  }
  d.push('Z'); return d.join(' ');
}
function strokePath(s) {
  if (!s._d) s._d = pathD(V.getStroke(s.pts, strokeOpts(s)));
  const p = svgEl('path', { d: s._d, class: 'stroke c-' + s.color + (SEL.strokes.has(s.id) ? ' picked' : '') }); p.dataset.id = s.id; return p;
}
// Top of the anchored line, in the buffer body's own (unscaled) coordinates.
function lineTopBody(id, aid) {
  const L = live[id], v = L?.view; if (!v) return null;
  const a = v.state.field(anchorField)[aid]; if (!a) return null;
  const r = v.coordsAtPos(Math.min(a.pos, v.state.doc.length), 1);  // null when the line is outside CodeMirror's rendered viewport
  if (!r) return null;
  return (r.top - L.body.getBoundingClientRect().top) / cam().z;
}
const lineInkQueued = new Set();
function scheduleLineInk(id) {
  if (!live[id]?.inkLines || lineInkQueued.has(id)) return;
  lineInkQueued.add(id);
  requestAnimationFrame(() => { lineInkQueued.delete(id); renderLineInk(id); });
}
function renderLineInk(id) {
  const L = live[id]; if (!L?.inkLines || lastLod) return;
  const gs = [];
  for (const s of S.strokes) {
    if (s.owner !== id || !s.aid) continue;
    const top = lineTopBody(id, s.aid); if (top == null) continue;
    const g = svgEl('g', { transform: `translate(0,${top.toFixed(1)})` }); g.append(strokePath(s)); gs.push(g);
  }
  L.inkLines.replaceChildren(...gs);
}
function renderInk(owner) {
  if (owner == null) { inkWorld.replaceChildren(...S.strokes.filter(s => !s.owner).map(strokePath)); return; }
  const L = live[owner]; if (!L) return;
  L.ink.replaceChildren(...S.strokes.filter(s => s.owner === owner && !s.aid).map(strokePath));
  if (L.inkLines) scheduleLineInk(owner);
}
function strokeWorldPts(s) {
  const o = s.owner && S.nodes[s.owner];
  if (!o) return s.pts;
  let dy = o.y;
  if (s.aid) { const t = lineTopBody(o.id, s.aid); if (t == null) return []; dy += HDR + t; }
  return s.pts.map(([x, y]) => [x + o.x, y + dy]);
}
function commitStroke(pts, sim, size) {
  if (pts.length < 2) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5, pts[0][2]]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const s = { id: uid('s'), color: inkColor, size, sim, owner: null };
  const node = nodeAt(cx, cy);
  if (node && node.kind === 'buffer' && cy > node.y + HDR) {
    // Anchor to the line under the stroke's centre so the ink follows the text through edits and scrolling.
    const v = live[node.id].view, r = viewport.getBoundingClientRect(), sc = w2s(cx, cy);
    const pos = v.posAtCoords({ x: sc.x + r.left, y: sc.y + r.top }, false);
    const aid = 'ink-' + s.id;
    v.dispatch({ effects: anchorAdd.of({ id: aid, pos: v.state.doc.lineAt(pos).from, label: null }) });
    const top = lineTopBody(node.id, aid);
    Object.assign(s, { owner: node.id, aid, pts: pts.map(([x, y, p]) => [x - node.x, y - node.y - HDR - top, p]) });
  } else if (node) {
    Object.assign(s, { owner: node.id, pts: pts.map(([x, y, p]) => [x - node.x, y - node.y, p]) });
  } else {
    const f = frameAt(cx, cy);
    if (f) Object.assign(s, { owner: f.id, pts: pts.map(([x, y, p]) => [x - f.x, y - f.y, p]) });
    else s.pts = pts;
  }
  S.strokes.push(s); renderInk(s.owner); dirty();
  return s;
}
function eraseAt(clientX, clientY) {
  const r = vpRect(), w = s2w(clientX - r.left, clientY - r.top), thr = 9 / cam().z;
  const shapeHit = S.shapes.filter(s => {
    if (s.type !== 'arrow') return w.x >= s.x - thr && w.x <= s.x + s.w + thr && w.y >= s.y - thr && w.y <= s.y + s.h + thr;
    const { x1, y1, x2, y2 } = arrowEnds(s), dx = x2 - x1, dy = y2 - y1, t = clamp(((w.x - x1) * dx + (w.y - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(x1 + t * dx - w.x, y1 + t * dy - w.y) < thr;
  });
  if (shapeHit.length) { shapeHit.forEach(s => removeShape(s.id)); }
  const hit = S.strokes.filter(s => strokeWorldPts(s).some(([x, y]) => Math.hypot(x - w.x, y - w.y) < thr + s.size / 2));
  if (!hit.length) return;
  S.strokes = S.strokes.filter(s => !hit.includes(s));
  new Set(hit.map(s => s.owner)).forEach(o => renderInk(o || null));
  placeInkChip();
  dirty();
}
function startInk(ev, erasing) {
  const pid = ev.pointerId;
  viewport.setPointerCapture(pid);
  const r = viewport.getBoundingClientRect();
  if (erasing) {
    eraseAt(ev.clientX, ev.clientY);
    const mv = e => { if (e.pointerId === pid) eraseAt(e.clientX, e.clientY); };
    const up = e => { if (e.pointerId !== pid) return; viewport.removeEventListener('pointermove', mv); viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up); };
    viewport.addEventListener('pointermove', mv); viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up);
    return;
  }
  const sim = ev.pointerType !== 'pen', size = clamp(3.6 / cam().z, 1.5, 24);
  const pts = [];
  const add = e => { const w = s2w(e.clientX - r.left, e.clientY - r.top); pts.push([w.x, w.y, sim ? 0.5 : (e.pressure || 0.5)]); };
  add(ev);
  const path = svgEl('path', { class: 'stroke c-' + inkColor }); inkLive.append(path);
  const mv = e => {
    if (e.pointerId !== pid) return;
    for (const ce of (e.getCoalescedEvents?.() || []).length ? e.getCoalescedEvents() : [e]) add(ce);
    path.setAttribute('d', pathD(V.getStroke(pts, { ...strokeOpts({ size, sim }), last: false })));
  };
  const up = e => {
    if (e.pointerId !== pid) return;
    viewport.removeEventListener('pointermove', mv); viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up);
    path.remove(); inkTrack(commitStroke(pts, sim, size));
  };
  viewport.addEventListener('pointermove', mv); viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ activity and level of detail
function activity(id) {
  const d = live[id]?.hdr && $('.dot', live[id].hdr); if (!d) return;
  d.classList.add('busy'); clearTimeout(live[id].busyT); live[id].busyT = setTimeout(() => d.classList.remove('busy'), 1200);
}
function termLines(L, max) {
  const b = L.term.buffer.active, out = [];
  for (let i = Math.max(0, b.length - 400); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-max);
}
function snapshotText(n, max = 12) {
  const L = live[n.id]; if (!L) return '';
  if (L.term) return termLines(L, max).join('\n');
  if (n.kind === 'buffer') return (n.text || '').split('\n').slice(0, max).join('\n');
  if (n.kind === 'acp') return L.backend?.text(max) || '';
  if (n.kind === 'agent') return (n.log || []).filter(m => m.text).slice(-6).map(m => (m.t === 'user' ? '› ' : '') + m.text).join('\n');
  if (n.kind === 'web') return n.url || '';
  if (n.kind === 'sketch') return `${S.strokes.filter(x => x.owner === n.id).length} strokes`;
  if (n.kind === 'artifact') return `artifact · ${Object.keys(n.capabilities || {}).join(', ') || 'no capabilities'}\nversion ${String(n.head || '').slice(0, 8) || '(none)'}`;
  return n.text || '';
}
function refreshSnapshots() { for (const n of nodeList()) { const L = live[n.id]; if (L?.lod) $('pre', L.lod).textContent = snapshotText(n); } }

// ------------------------------------------------------------------ status bar
let bufAddrT = 0;
function scheduleBufAddr(n) { clearTimeout(bufAddrT); bufAddrT = setTimeout(() => { if (focusedBuf === n.id) showBufAddr(n); }, 120); }
function showBufAddr(n) {
  const v = live[n.id]?.view; if (!v) return;
  const t = $('#st-buf-text'); t.textContent = fmtAddr(bufferAddress(n, v.state, v.state.selection.main.head)); t.classList.add('live');
  $('#st-copy').hidden = false;
}
$('#st-copy').onclick = () => copyText($('#st-buf-text').textContent);
let addrRaf = 0;
viewport.addEventListener('pointermove', e => {
  if (addrRaf) return;
  addrRaf = requestAnimationFrame(() => {
    addrRaf = 0;
    const w = evWorld(e), n = nodeAt(w.x, w.y);
    $('#st-addr').textContent = canvasAddr(w.x, w.y) + (n ? '  ·  ' + pathOf(n.id) : '');
  });
});

// ------------------------------------------------------------------ viewport input: ink, pan, pinch, wheel
// Touch: two fingers move the camera wherever they land, over cards too (the pinch zooms, both fingers pan); one
// finger keeps its meaning (bare canvas pans, a card scrolls or drags its own content). The second finger takes the
// camera only when the first holds nothing: a finger that drags a card, a handle or ink keeps it. A one-finger pan
// glides on after the lift.
const TOUCH = new Map(), CAPTURED = new Map();   // every finger on the canvas → { x, y }; pointer → the element holding it
const holdTouch = e => { if (pinch && e.touches.length > 1) { e.preventDefault(); e.stopPropagation(); } };   // no card scrolls under a pinch
viewport.addEventListener('gotpointercapture', e => CAPTURED.set(e.pointerId, e.target), true);
viewport.addEventListener('lostpointercapture', e => { if (CAPTURED.get(e.pointerId) === e.target) CAPTURED.delete(e.pointerId); }, true);
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, e => {
  if (!TOUCH.delete(e.pointerId) || TOUCH.size) return;
  viewport.removeEventListener('touchmove', holdTouch, { capture: true });
}, true);
viewport.addEventListener('pointerdown', ev => {
  if (ev.pointerType !== 'touch') return;
  camStop();   // a finger down stops a flight or a glide
  TOUCH.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (FOCUS.cur || TOUCH.size !== 2) return;
  const first = [...TOUCH.keys()].find(id => id !== ev.pointerId);
  if (CAPTURED.has(first) && !pointers.has(first)) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  viewport.addEventListener('touchmove', holdTouch, { capture: true, passive: false });
  for (const [id, q] of TOUCH) { if (!pointers.has(id)) pointers.set(id, { x: q.x, y: q.y }); try { viewport.setPointerCapture(id); } catch {} }
  startPinch(); viewport.classList.add('panning');
}, true);
viewport.addEventListener('pointermove', ev => { const q = TOUCH.get(ev.pointerId); if (q) { q.x = ev.clientX; q.y = ev.clientY; } }, true);
function glide(ev) {   // the pan's speed over its last 100 ms carries on and decays (time constant 325 ms)
  const tr = GLIDE.trail.filter(([t]) => ev.timeStamp - t < 100); GLIDE.trail = [];
  if (reduceMotion || ev.type !== 'pointerup' || tr.length < 2 || ev.timeStamp - tr[tr.length - 1][0] > 50) return;   // a finger that rested before the lift stays
  const [t0, x0, y0] = tr[0], [t1, x1, y1] = tr[tr.length - 1], dt = Math.max(8, t1 - t0);
  let vx = (x1 - x0) / dt, vy = (y1 - y0) / dt, last = performance.now();
  if (Math.hypot(vx, vy) < 0.25) return;   // px/ms: a slow lift stops where it is
  const step = now => {
    const d = Math.min(48, now - last), f = Math.exp(-d / 325); last = now;
    cam().x -= vx * d / cam().z; cam().y -= vy * d / cam().z; vx *= f; vy *= f; applyCam();
    GLIDE.raf = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
  };
  GLIDE.raf = requestAnimationFrame(step);
}
const isChrome = t => t.closest('.hdr button, .port, .rs, .flabel, .elabel, .deck');
// middle-drag and Alt-drag pan from anywhere, also over a terminal or editor body, and never paste (Linux primary selection)
const MID = { at: 0 };
const panGrab = ev => !FOCUS.cur && ev.pointerType !== 'touch' && (ev.button === 1 || (ev.button === 0 && ev.altKey && !ev.ctrlKey && !ev.metaKey));
viewport.addEventListener('pointerdown', ev => {
  if (!panGrab(ev)) return;
  ev.preventDefault(); ev.stopPropagation(); MID.at = performance.now(); camStop();
  viewport.setPointerCapture(ev.pointerId); pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); viewport.classList.add('panning');
}, true);
for (const t of ['mousedown', 'mouseup', 'auxclick', 'click']) viewport.addEventListener(t, ev => { if (ev.button === 1) { ev.preventDefault(); ev.stopPropagation(); MID.at = performance.now(); } }, true);
window.addEventListener('paste', ev => { if (performance.now() - MID.at < 600) { ev.preventDefault(); ev.stopPropagation(); } }, true);
viewport.addEventListener('pointerdown', ev => {
  const pen = ev.pointerType === 'pen';
  if (pen) penSeen = true;
  const eraserButton = pen && (ev.button === 5 || (ev.buttons & 32));
  const drawTool = tool === 'pen' || tool === 'erase';
  const onNode = ev.target.closest('.node');
  if (WS.cur && ev.button === 0 && ev.target.closest('.outside')) {   // v19.1: a dimmed item outside the workspace is the way out: click it to leave and go there
    ev.preventDefault(); ev.stopPropagation();
    const o = ev.target.closest('.outside'), n = S.nodes[o.dataset.id]; wsLeave();
    if (n) { activate(n.id); animateTo(camTarget(n.x, n.kind === 'frame' ? n.y - LABEL_H : n.y, n.w, n.h + (n.kind === 'frame' ? LABEL_H : 0), 1)); }
    return;
  }
  if (tool === 'area' && ev.button === 0 && !eraserButton && !isChrome(ev.target)) { ev.preventDefault(); ev.stopPropagation(); marquee(ev); return; }   // v19: the rectangle wins over cards and the pen
  let draw = false;
  if (pen) draw = drawTool || eraserButton || (!onNode && !isChrome(ev.target));
  else if (drawTool && ev.button === 0) draw = ev.pointerType === 'mouse' || (ev.pointerType === 'touch' && !penSeen);
  if (draw && !isChrome(ev.target)) {
    ev.preventDefault(); ev.stopPropagation();
    startInk(ev, eraserButton || tool === 'erase');
  } else if (SHAPE_TOOLS.has(tool) && ev.button === 0 && !isChrome(ev.target) && (tool === 'arrow' || !onNode)) {
    ev.preventDefault(); ev.stopPropagation();
    startShape(ev);
  }
}, true);

const pointers = new Map();
let space = false, pinch = null;
viewport.addEventListener('pointerdown', ev => {
  const bg = ev.target === viewport || ev.target === world || ev.target.classList.contains('fgrid') || ev.target.classList.contains('frame');
  if (FOCUS.cur) return;
  if (pointers.has(ev.pointerId)) return;  // already grabbed by the middle/Alt pan above
  if (!(ev.button === 1 || space || (bg && (ev.button === 0 || ev.pointerType === 'touch')))) return;
  ev.preventDefault();
  if (bg && ev.button === 0 && ev.shiftKey && !space) { marquee(ev); return; }
  if (bg && ev.button === 0 && PICKED.size) pickClear();
  if (bg && ev.button === 0 && activeId) { live[activeId]?.el.classList.remove('active'); activeId = null; }
  if (bg && selShape) { selShape = null; renderShapes(); }
  camStop();
  viewport.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  viewport.classList.add('panning');
  if (pointers.size === 1) { GLIDE.ok = ev.pointerType === 'touch'; GLIDE.trail = []; }
  if (pointers.size === 2) startPinch();
});
function startPinch() { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; GLIDE.ok = false; }
viewport.addEventListener('pointermove', ev => {
  const p = pointers.get(ev.pointerId); if (!p) return;
  if (pointers.size === 1) {
    cam().x -= (ev.clientX - p.x) / cam().z; cam().y -= (ev.clientY - p.y) / cam().z; applyCam();
    if (GLIDE.ok) GLIDE.trail.push([ev.timeStamp, ev.clientX, ev.clientY]);
  }
  p.x = ev.clientX; p.y = ev.clientY;
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    cam().x -= (mx - pinch.mx) / cam().z; cam().y -= (my - pinch.my) / cam().z;
    zoomAt(mx, my, d / pinch.d); pinch = { d, mx, my };
  }
});
const endPan = ev => { if (!pointers.delete(ev.pointerId)) return; pinch = null; if (!pointers.size) { viewport.classList.remove('panning'); if (GLIDE.ok) glide(ev); } };
viewport.addEventListener('pointerup', endPan); viewport.addEventListener('pointercancel', endPan);
viewport.addEventListener('wheel', e => {
  if (FOCUS.cur) return;
  const inBody = e.target.closest('.node.active .body');
  if (inBody && !e.ctrlKey && !e.metaKey) return;
  e.preventDefault(); camStop();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 4 : 1)));
  else { const k = e.deltaMode ? 30 : 1; cam().x += e.deltaX * k / cam().z; cam().y += e.deltaY * k / cam().z; applyCam(); }
}, { passive: false });
viewport.addEventListener('dblclick', ev => {
  const bg = ev.target === viewport || ev.target === world || ev.target.classList.contains('fgrid');
  if (!bg || tool !== 'select') return;
  const r = viewport.getBoundingClientRect(), w = s2w(ev.clientX - r.left, ev.clientY - r.top);
  const count = nodeList().filter(m => m.kind === 'buffer').length + 1;
  const n = addNode({ kind: 'buffer', name: 'note' + count, x: Math.round(w.x - 20), y: Math.round(w.y - 20), w: 420, h: 260, text: '# note' + count + '\n\n- ' });
  setTimeout(() => { const v = live[n.id].view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); }, 30);
});

// ------------------------------------------------------------------ toolbar
function setTool(t) {
  tool = t;
  $$('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  viewport.classList.toggle('tool-pen', t === 'pen'); viewport.classList.toggle('tool-erase', t === 'erase'); viewport.classList.toggle('tool-shape', SHAPE_TOOLS.has(t)); viewport.classList.toggle('tool-area', t === 'area');
}
$$('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$$('.sw').forEach(b => b.onclick = () => { inkColor = b.dataset.color; $$('.sw').forEach(x => x.classList.toggle('on', x === b)); if (tool === 'select') setTool('pen'); });
$('#add-artifact').onclick = () => newArtifact('artifact' + (nodeList().filter(n => n.kind === 'artifact').length + 1));
$('#add-emacs').onclick = () => askName('File to open in Emacs', INFO?.notes ? INFO.notes + '/' : '~/', f => newEmacs(f));
$('#add-web').onclick = () => askName('Address', 'https://', u => newWeb(u));
$('#add-acp').onclick = () => newAgentCard();
$('#add-sketch').onclick = () => newSketch();
if ($('#add-agent')) $('#add-agent').onclick = () => { const n = newAt('agent', { w: 520, h: 440, log: [{ t: 'note', text: 'Ask me about the board, or tell me what to change.' }], turns: [], tier: 'quick' }); setTimeout(() => live[n.id]?.ta?.focus(), 50); };
$('#open-today').onclick = () => openToday();
$('#add-shell').onclick = () => pickShell(shell => newAt('term', { backend: DAEMON ? 'pty' : 'fake', cwd: DAEMON ? undefined : '/home/me', env: {}, ...(shell ? { shell } : {}) }));
// The server's shells (/api/info.shells); the default is the last one picked on this device, else the server's default.
const SHELL_KEY = 'wb-shell';
function shellDefault() { const sh = INFO?.shells || [], last = store.get(SHELL_KEY); return sh.includes(last) ? last : INFO?.defaultShell; }
function pickShell(then) {
  const sh = DAEMON && INFO?.shells || [];
  if (sh.length < 2) return then(sh[0]);
  const d = shellDefault(), order = sh.includes(d) ? [d, ...sh.filter(x => x !== d)] : sh;
  openPicker('Shell', order.map(x => ({ k: 'shell', l: x, s: x === INFO.defaultShell ? 'default' : '', run: () => { store.set(SHELL_KEY, x); then(x); } })));
}
$('#add-buffer').onclick = () => { const n = newAt('buffer', { text: '# untitled\n\n- ' }); n.text = `# ${n.name}\n\n- `; live[n.id].view.dispatch({ changes: { from: 0, to: live[n.id].view.state.doc.length, insert: n.text } }); };
$('#add-frame').onclick = () => {
  if (VIEW !== 'canvas') setView('canvas');
  const n = newAt('frame', { mode: 'free', shape: 'folder' });
  setTimeout(() => rename(n, $('.fname', live[n.id].el)), 400);
};
const replMenu = $('#repl-menu');
$('#add-repl').onclick = ev => {
  ev.stopPropagation();
  const r = ev.currentTarget.getBoundingClientRect();
  replMenu.style.left = r.left + 'px'; replMenu.style.top = r.bottom + 'px';
  $$('.needs-daemon', replMenu).forEach(b => b.disabled = !DAEMON);
  const ae = $('#add-emacs'); if (ae) ae.disabled = !DAEMON;
  replMenu.hidden = !replMenu.hidden;
};
$$('#repl-menu button').forEach(b => b.onclick = () => {
  replMenu.hidden = true;
  const r = b.dataset.repl;
  if (r === 'js') newAt('repl', { lang: 'js', history: [] });
  else newAt('repl', { lang: 'cmd', backend: 'pty', cmd: r, name: r.split(' ')[0].replace('python3', 'py') + (nodeList().length + 1) });
});
document.addEventListener('pointerdown', e => { if (!e.target.closest('.menu-wrap')) replMenu.hidden = true; });
$('#open-palette').onclick = () => { PICK = null; openPalette(''); };
$('#open-help').onclick = () => { $('#help').hidden = false; };
$('#help-close').onclick = () => { $('#help').hidden = true; };
$('#reset-board').onclick = ev => confirmDel(ev.currentTarget, () => {
  for (const id in live) live[id].backend?.kill?.();
  S = null; clearTimeout(saveT);
  SAVE.leaving = true;   // a deliberate wipe: a 412 reloads too
  if (DAEMON) fetch('/api/board', { method: 'PUT', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'If-Match': BOARD_ETAG }, body: '{"v":0}' }).finally(() => location.reload());
  else { store.del(LS_KEY); location.reload(); }
});

// ------------------------------------------------------------------ export (JSON Canvas 1.0)
function toJsonCanvas() {
  const nodes = [], edges = [];
  const all = [...frameList(), ...nodeList()];
  for (const n of all) {
    const base = { id: n.id, x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.w), height: Math.round(n.h) };
    if (n.kind === 'frame') nodes.push({ ...base, type: 'group', label: n.name });
    else if (n.kind === 'buffer') nodes.push({ ...base, type: 'text', text: n.text || '' });
    else if (n.kind === 'ref') nodes.push({ ...base, type: 'text', text: `> from ${n.srcLabel}\n\n\`\`\`\n${n.text}\n\`\`\``, color: '6' });
    else nodes.push({ ...base, type: 'text', text: `**${pathOf(n.id)}** · ${badgeOf(n)}\n\n\`\`\`\n${snapshotText(n, 30)}\n\`\`\``, color: '4' });
  }
  for (const e of S.edges) edges.push({ id: e.id, fromNode: e.from, toNode: e.to, label: e.type, color: { spawn: '2', pipe: '5', ref: '6' }[e.type] });
  return JSON.stringify({ nodes, edges }, null, 2);
}
$('#ex-close').onclick = () => { $('#export-box').hidden = true; };
$('#ex-copy').onclick = () => { const t = $('#ex-text'); try { navigator.clipboard.writeText(t.value).then(() => toast('Copied JSON Canvas'), () => { t.select(); toast('Press Ctrl-C to copy'); }); } catch { t.select(); } };
if (window.CANVAS_HOSTED) $('#ex-dl').hidden = true;  // the hosted viewer blocks downloads
$('#ex-dl').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([$('#ex-text').value], { type: 'application/json' }));
  a.download = 'board.canvas'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// ------------------------------------------------------------------ palette
// ------------------------------------------------------------------ command palette: fuzzy search over everything you can open or do
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const keyLabel = k => (k || '').replace(/Mod-/g, IS_MAC ? '⌘' : 'Ctrl-').replace(/Alt-/g, IS_MAC ? '⌥' : 'Alt-');
// fzf-style: every query character must appear in order; runs, word starts and prefixes score higher.
function fuzzy(q, s) {
  if (!q) return { score: 0, idx: [] };
  const t = s.toLowerCase(); let qi = 0, score = 0, last = -2; const idx = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    let b = 1; if (i === last + 1) b += 5; if (i === 0 || /[\s\/\-_›.:#@(]/.test(t[i - 1])) b += 8;
    score += b; idx.push(i); last = i; qi++;
  }
  if (qi < q.length) return null;
  if (t.startsWith(q)) score += 12;
  return { score: score - t.length * 0.03 - idx[0] * 0.2, idx };
}
const CMDS = [];
// keys: a label, or @command to show where web/keys.js binds that command (so the palette follows the keymaps)
function cmd(title, run, keys = '', when = null) {
  const kc = keys[0] === '@' ? keys.slice(1) : null;
  CMDS.push({ k: 'command', l: title, get keys() { return kc ? WBKeys.whereIs(kc, LEADERS[leaderName()].key) : keys; }, run, when, cmd: true });
}
const activeFolder = () => { const a = S.nodes[activeId]; return a ? (a.kind === 'frame' ? a : a.in && S.nodes[a.in]) : null; };
function onCanvas(fn) { return () => { if (VIEW !== 'canvas') setView('canvas'); fn(); }; }
let PICK = null;  // a sub-list the palette shows instead of everything (pick a folder, a page name…)
function openPicker(prompt, items) { PICK = { prompt, items }; openPalette(''); $('#pal-in').placeholder = prompt; }
function palSearch(q) {
  const out = [], raw = q.trim(), ql = raw.toLowerCase();
  if (PICK) return rank(PICK.items, ql);
  if (q.startsWith('>save')) {
    const name = q.slice(5).trim();
    return [{ k: 'view', l: name ? `Save this view as “${name}”` : 'Type a name for this view', run: () => { if (!name) return; S.views[name] = { ...cam() }; dirty(); toast(`View “${name}” saved. Find it in the palette.`); } }];
  }
  if (q.startsWith('>')) return rank(CMDS.filter(c => !c.when || c.when()), ql.slice(1).trim(), true);
  // exact addresses first: page › heading ¶n, Folder/B3, @x,y
  if (q.includes('›') || /¶\s*\d/.test(q)) { const r = resolveBufferAddress(q); if (r) out.push({ k: 'position', l: fmtAddr(bufferAddress(r.node, live[r.node.id].view.state, r.pos)), s: 'buffer address', run: () => jumpBuffer(r.node, r.pos), score: 1e6 }); }
  let m = raw.match(/^(.+)\/([A-Za-z]{1,2})(\d{1,3})$/);
  if (m) { const f = findFolder(m[1]); if (f) { const cx = f.x + colIndex(m[2]) * GRID, cy = f.y + (+m[3] - 1) * GRID; out.push({ k: 'cell', l: `${f.name}/${m[2].toUpperCase()}${m[3]}`, s: 'folder cell', score: 1e6, run: onCanvas(() => { pushHistory(); animateTo(camTarget(cx, cy, GRID, GRID, 1.6)); }) }); } }
  m = raw.match(/^@\s*(-?\d+)\s*,\s*(-?\d+)$/);
  if (m) out.push({ k: 'point', l: `@${m[1]},${m[2]}`, s: 'world coordinates', score: 1e6, run: onCanvas(() => { pushHistory(); animateTo(camTarget(+m[1] - 200, +m[2] - 150, 400, 300, cam().z)); }) });
  const cands = [];
  for (const n of nodeList()) cands.push({ k: n.kind === 'term' ? 'shell' : n.kind === 'buffer' ? 'page' : n.kind, l: pathOf(n.id), s: (folderPath(n) ? folderPath(n) + '/' : '') + (deskOff(n) ? ' (not on this desk)' : stashed(n) ? ' (in a deck)' : ''), run: () => (n.kind === 'buffer' && VIEW === 'editor' ? edOpen(n) : jumpNode(n)) });
  for (const f of frameList()) cands.push({ k: 'folder', l: fullPath(f) + '/', s: `${f.mode || 'free'} · ${kidsOf(f.id).length} item(s)`, run: () => jumpFolder(f) });
  for (const n of nodeList()) {
    if (n.kind !== 'buffer' || !live[n.id]?.view) continue;
    for (const [, a] of Object.entries(live[n.id].view.state.field(anchorField))) if (a.label) cands.push({ k: 'anchor', l: `${n.name}#${a.label}`, s: fmtAddr(bufferAddress(n, live[n.id].view.state, a.pos)), run: () => jumpBuffer(n, a.pos) });
  }
  for (const [name, v] of Object.entries(S.views)) cands.push({ k: 'view', l: name, s: `saved view · ${Math.round(v.z * 100)}%`, run: onCanvas(() => { pushHistory(); animateTo(v); }) });
  if (!ql) {
    const recent = (S.recentCmds || []).map(t => CMDS.find(c => c.l === t)).filter(c => c && (!c.when || c.when()));
    return [...recent.map(c => ({ ...c, s: 'recent' })), ...cands.slice(0, 30)];
  }
  const ranked = rank([...cands, ...CMDS.filter(c => !c.when || c.when())], ql);
  if (ql.length >= 3) {
    for (const n of nodeList()) {
      if (n.kind === 'buffer' && live[n.id]?.view) {
        const st = live[n.id].view.state, low = st.doc.toString().toLowerCase(); let i = low.indexOf(ql), c = 0;
        while (i >= 0 && c++ < 3) { ranked.push({ k: 'text', l: fmtAddr(bufferAddress(n, st, i)), s: 'match in page', run: (p => () => jumpBuffer(n, p))(i) }); i = low.indexOf(ql, i + 1); }
      } else if (live[n.id]?.term) {
        const L = live[n.id], b = L.term.buffer.active;
        for (let i = b.length - 1, c = 0; i >= 0 && c < 2; i--) {
          const t = b.getLine(i)?.translateToString(true) || '';
          if (t.toLowerCase().includes(ql)) { c++; ranked.push({ k: 'output', l: `${pathOf(n.id)} › L${i + 1}`, s: t.trim().slice(0, 60), run: (line => () => jumpNode(n, 1, () => L.term.scrollToLine(Math.max(0, line - 3))))(i) }); }
        }
      }
    }
  }
  return [...out, ...ranked].slice(0, 60);
}
function rank(list, ql, keepOrder) {
  if (!ql) return keepOrder ? list.slice() : list.slice(0, 60);
  const scored = [];
  for (const it of list) { const f = fuzzy(ql, it.l); if (f) scored.push({ ...it, idx: f.idx, score: f.score + (it.cmd ? 0 : 0.5) }); }
  return scored.sort((a, b) => b.score - a.score).slice(0, 60);
}
function openPalette(prefill) {
  $('#palette').hidden = false; const i = $('#pal-in'); i.value = prefill; i.placeholder = PICK ? PICK.prompt : 'Search pages, shells, folders… or > for commands';
  i.focus(); i.setSelectionRange(prefill.length, prefill.length); renderPalette();
}
function closeOverlays() { $$('.overlay').forEach(o => o.hidden = true); replMenu.hidden = true; PICK = null; }
function hl(text, idx) {
  const f = document.createDocumentFragment(); if (!idx?.length) { f.append(text); return f; }
  const set = new Set(idx); let buf = '';
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) { if (buf) f.append(buf); buf = ''; const b = document.createElement('mark'); b.textContent = text[i]; f.append(b); } else buf += text[i];
  }
  if (buf) f.append(buf); return f;
}
function renderPalette() {
  palItems = palSearch($('#pal-in').value); palSel = 0;
  const list = $('#pal-list'); list.replaceChildren();
  palItems.forEach((it, i) => {
    const d = el('div', 'pi' + (i === palSel ? ' sel' : '')); d.setAttribute('role', 'option');
    d.innerHTML = '<span class="k"></span><span class="l"></span><span class="s"></span><kbd class="pk"></kbd>';
    $('.k', d).textContent = it.k; $('.l', d).append(hl(it.l, it.idx)); $('.s', d).textContent = it.s || ''; $('.pk', d).textContent = keyLabel(it.keys);
    d.onclick = () => runItem(it);
    list.append(d);
  });
  if (!palItems.length) list.append(Object.assign(el('div', 'pal-hint'), { innerHTML: 'No match. Type <code>&gt;</code> for commands, or a path, <code>Folder/B3</code>, <code>page › heading ¶2</code>, <code>page#anchor</code>, <code>@x,y</code>.' }));
}
function runItem(it) {
  if (it.cmd) { const r = S.recentCmds = (S.recentCmds || []).filter(t => t !== it.l); r.unshift(it.l); r.length = Math.min(r.length, 5); dirty(); }
  const keep = it.keepOpen; if (!keep) closeOverlays(); it.run();
}
let palItems = [], palSel = 0;
$('#pal-in').addEventListener('input', renderPalette);
$('#pal-in').addEventListener('keydown', e => {
  const move = d => { palSel = clamp(palSel + d, 0, palItems.length - 1); $$('#pal-list .pi').forEach((x, i) => x.classList.toggle('sel', i === palSel)); $$('#pal-list .pi')[palSel]?.scrollIntoView({ block: 'nearest' }); };
  if (e.key === 'ArrowDown' || (e.ctrlKey && ['n', 'j'].includes(e.key.toLowerCase()))) { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && ['p', 'k'].includes(e.key.toLowerCase()))) { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); const it = palItems[palSel]; if (it) runItem(it); else closeOverlays(); }
});
function askName(label, value, cb) { ask(label, value, cb); }
function pickFolder(prompt, cb) {
  openPicker(prompt, [{ k: 'canvas', l: '(loose on the canvas)', run: () => cb(null) }, ...frameList().map(f => ({ k: 'folder', l: fullPath(f) + '/', s: f.mode || 'free', run: () => cb(f) }))]);
}

// Every action in the app is a command here. Keys show what is bound; the palette is the way to find the rest.
{
  const VN = { canvas: 'Canvas', ranger: 'Navigator (ranger)', graph: 'Graph', editor: 'Editor', outline: 'Outline', tasks: 'Tasks' };
  ['canvas', 'ranger', 'graph', 'editor', 'outline', 'tasks'].forEach((v, i) => cmd(`View: ${VN[v]}`, () => setView(v), '@view.' + v));  // Review is Alt-7, registered with its view
}
cmd('Toggle folder tree', () => toggleTree(), '@tree.toggle');
cmd('Toggle the docked terminal', () => toggleDockTerm(), '@dock.toggle');
cmd('Side pane: wider', () => { toggleSide(true, true); setPaneW((S.paneW || PANE_W) + 80, true); }, '@pane.wider');
cmd('Side pane: narrower', () => { toggleSide(true, true); setPaneW((S.paneW || PANE_W) - 80, true); }, '@pane.narrower');
cmd('Side pane: reset width', () => setPaneW(PANE_W, true));
// Listed only while the assistant pane exists (initChat mounts none since v9): run without it, they threw.
const hasChat = () => !!(S.chat && live.chat);
cmd('Assistant: new conversation', () => { S.chat.turns = []; S.chat.log = [{ t: 'note', text: CHAT_HELLO }]; renderAgentLog(S.chat); dirty(); toggleSide(true); }, '', hasChat);
cmd('Assistant: fork the conversation onto the canvas', () => $('#chat-fork').click(), '', hasChat);
cmd('Assistant: talk (hold-to-talk mic)', () => { toggleSide(true, true); sideTab('chat'); $('.mic', live.chat.body).dispatchEvent(new PointerEvent('pointerdown', { button: 0 })); }, '', hasChat);
cmd('Dictate into the page', () => { if (VIEW === 'editor' && ED.view) dictateInto('editor'); else if (focusedBuf && S.nodes[focusedBuf]) dictateInto(S.nodes[focusedBuf]); else toast('Click into a page first.'); }, '@dictate');
for (const [t, name, key] of [['select', 'select and move', 'V'], ['area', 'select an area (ink, shapes, cards)', 'S'], ['rect', 'rectangle', 'R'], ['diamond', 'diamond', 'D'], ['ellipse', 'ellipse', 'O'], ['arrow', 'arrow', 'A'], ['pen', 'pen', 'P'], ['text', 'text', 'T'], ['erase', 'eraser', 'E']])
  cmd(`Tool: ${name}`, onCanvas(() => setTool(t)), '@tool.' + t);
cmd('Selection: remove it (ink, shapes, cards)', onCanvas(() => removeSelection()), '@selection.remove', () => PICKED.size > 0 || SEL.strokes.size > 0 || SEL.shapes.size > 0);
cmd('Selection → sketch card', onCanvas(() => sketchFromSelection()), '', () => SEL.strokes.size > 0);
cmd('Selection → text (read the handwriting)', () => { INK.ids = [...SEL.strokes]; INK.t = Date.now(); inkToText(); }, '', () => SEL.strokes.size > 0);
cmd('Undo the last removal', () => removeUndo(), '', () => !!REMOVE_UNDO);
for (const c of ['ink', 'red', 'blue']) cmd(`Ink colour: ${c}`, onCanvas(() => { $(`.sw[data-color="${c}"]`).click(); }));
cmd('Handwriting → text', () => inkToText(), '', () => INK.ids.length > 0);
cmd('Handwriting → ask the assistant', () => inkAsk(), '', () => INK.ids.length > 0);
cmd('Show or hide drawing tools', () => toggleDock('draw'));
cmd('Show or hide the add bar', () => toggleDock('new'));
cmd('New Emacs buffer…', onCanvas(() => $('#add-emacs').click()), '', () => DAEMON);
cmd('New agent card…', onCanvas(() => newAgentCard()), '', () => DAEMON && (INFO?.agents || []).length);
{
  const acpActive = () => S.nodes[activeId]?.kind === 'acp' ? live[activeId]?.backend : null;
  cmd('Agent: start a new session in the active card (ends the current one)', () => acpActive()?.restart(), '', () => !!acpActive());
  cmd('Agent: end the active card\'s session (the card stays, ↻ revives)', () => acpActive()?.end(), '', () => !!acpActive()?.sum?.alive);
}
cmd('New browser window…', onCanvas(() => $('#add-web').click()));
cmd('New sketch (write on it with the pen)', onCanvas(() => newSketch()));
cmd('New shell', onCanvas(() => $('#add-shell').click()));
cmd('New JavaScript REPL', onCanvas(() => newAt('repl', { lang: 'js', history: [] })));
cmd('New Python REPL', onCanvas(() => newAt('repl', { lang: 'cmd', backend: 'pty', cmd: 'python3 -q', name: 'py' + (nodeList().length + 1) })), '', () => DAEMON);
cmd('New Node REPL', onCanvas(() => newAt('repl', { lang: 'cmd', backend: 'pty', cmd: 'node', name: 'node' + (nodeList().length + 1) })), '', () => DAEMON);
cmd('New page…', () => askName('New page name', '', name => openPage(name)));
cmd('New folder…', () => askName('New folder name', '', name => { if (VIEW !== 'canvas') setView('canvas'); const n = newAt('frame', { mode: 'free', shape: 'folder' }); n.name = clean(name); placeFrame(n); renderTree(); dirty(); }));
cmd('Open today’s journal', () => openToday());
cmd('Move the active item to a folder…', () => { const n = S.nodes[activeId]; pickFolder(`Move ${n.name} to…`, f => adopt(n, f, null)); }, '', () => !!S.nodes[activeId]);
cmd('Rename the active item…', () => { const n = S.nodes[activeId]; askName('Rename ' + n.name, n.name, v => { n.name = clean(v); n.kind === 'frame' ? placeFrame(n) : updateAllTitles(); renderTree(); dirty(); }); }, '', () => !!S.nodes[activeId]);
cmd('Branch the active shell, REPL or agent', () => spawnChild(S.nodes[activeId]), '', () => ['term', 'repl', 'agent', 'acp'].includes(S.nodes[activeId]?.kind));
cmd('Compact everything', onCanvas(() => compact('all')), '@compact', () => !PICKED.size);
cmd('Compact the selection', onCanvas(() => compact('selection')), '@compact', () => PICKED.size > 0);
cmd('Select all items in the view', onCanvas(() => { for (const n of Object.values(S.nodes)) if (!stashed(n) && !n.in) pickToggle(n.id, true); }));
cmd('Clear the selection', () => pickClear(), '@esc', () => PICKED.size > 0);
cmd('Undo layout change', () => layoutUndo(), '@undo.layout', () => !!LAYOUT_UNDO);
for (const m of ['free', 'pack', 'tile', 'stack']) cmd(`Folder: ${m}`, () => setMode(activeFolder(), m), '', () => !!activeFolder());
cmd('Folder: pull the walls in to fit', () => setMode(activeFolder(), 'free'), '', () => activeFolder()?.mode === 'free' || !activeFolder()?.mode && !!activeFolder());
cmd('Folder: change shape', () => { const f = activeFolder(); f.shape = FSHAPES[(FSHAPES.indexOf(f.shape || 'folder') + 1) % FSHAPES.length]; placeFrame(f); dirty(); }, '', () => !!activeFolder());
cmd('Fit everything', onCanvas(() => fitAll()), '@fit');
cmd('Save this view as…', () => setTimeout(() => openPalette('>save '), 0));
cmd('Back to the previous view', onCanvas(() => { const t = camBack.pop(); if (t) { camFwd.push({ ...cam() }); animateTo(t); } }), '@camera.back');
cmd('Export as JSON Canvas', () => { syncBuffers(); $('#ex-text').value = toJsonCanvas(); $('#export-box').hidden = false; });
cmd('Theme: Modus Operandi (light)', () => setTheme('light'));
cmd('Theme: Modus Vivendi (dark)', () => setTheme('dark'));
cmd('Theme: follow the system', () => setTheme('auto'));
cmd('Pages: vim keys on or off', () => setVim(!S.vim));
cmd('Help: keys and gestures', () => { $('#help').hidden = false; }, '@help');

// ------------------------------------------------------------------ keyboard (DESIGN §6.4)
// One capture listener walks the layers of web/keys.js, innermost first: leader, transient (an overlay, hints, arrange),
// interior (the card or field that has the keyboard), view, place, global. A card gets every key it needs before the
// board looks at it (K2), and leader Esc takes the keyboard back out of any card (K3).
const typing = () => { const a = document.activeElement; return a && (a.matches('input, textarea, [contenteditable="true"]') || a.closest('.cm-editor, .xterm')); };
function keyInterior(a = document.activeElement) {
  if (!a || a === document.body || a === document.documentElement || a === viewport) return null;
  if (a.closest('.xterm')) return 'term';
  if (a.closest('.cm-editor')) return 'page';
  if (a.tagName === 'IFRAME') return 'frame';
  if (a.matches('input, textarea, select, [contenteditable="true"]')) return 'text';
  if (a.matches('button, a[href], summary')) return 'control';
  return null;
}
function keyContext() {
  const ov = $$('.overlay').find(o => !o.hidden);
  const transient = HINTS.on ? 'hints' : ARR.on ? 'arrange' : ov ? (ov.id === 'palette' ? 'palette' : 'dialog') : null;
  return { transient, interior: transient ? null : keyInterior(), view: VIEW, place: FOCUS.cur ? 'tab' : WS.cur ? 'workspace' : 'board' };
}
const VIEW_KEYFN = { ranger: e => !e.ctrlKey && !e.metaKey && !e.altKey && rgKey(e), tasks: e => tasksKey(e), review: e => reviewKey(e) };
window.addEventListener('keydown', e => {
  if (LEADER.pass) return;
  const k = WBKeys.keyName(e); if (!k) return;
  if (LEADER.on) { e.preventDefault(); e.stopPropagation(); leaderKey(k, e); return; }
  if (k === leaderKeyName()) { e.preventDefault(); e.stopPropagation(); leaderOpen(); return; }
  for (const s of WBKeys.resolve(keyContext(), k)) {
    if (s.pass) return;
    if (s.swallow) { e.preventDefault(); e.stopPropagation(); return; }
    if (s.fn) { if (VIEW_KEYFN[s.fn](e)) { e.preventDefault(); e.stopPropagation(); return; } continue; }
    const f = KC[s.cmd];
    if (!f) { console.warn('key ' + k + ': no command ' + s.cmd); return; }
    if (f(e, k) === false) return;   // the command did nothing: the browser keeps the key (Tab moves focus, Ctrl-Z undoes text)
    e.preventDefault(); e.stopPropagation(); return;
  }
}, true);
window.addEventListener('keyup', e => { if (e.key === ' ') space = false; });

// ------------------------------------------------------------------ pages: outliner keys, [[links]], ((refs)), backlinks
function outlineEnter(view) {
  const st = view.state, sel = st.selection.main; if (!sel.empty) return false;
  const line = st.doc.lineAt(sel.head), m = line.text.match(/^(\s*)([-*+]|\d+\.)\s(.*)$/);
  if (!m) return false;
  if (!m[3].trim() && sel.head === line.to) {   // Enter on an empty bullet: outdent it, or end the list
    if (m[1].length >= 2) view.dispatch({ changes: { from: line.from, to: line.from + 2 } });
    else view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } });
    return true;
  }
  const bullet = /\d+\./.test(m[2]) ? (parseInt(m[2], 10) + 1) + '.' : m[2], ins = '\n' + m[1] + bullet + ' ';
  view.dispatch({ changes: { from: sel.head, insert: ins }, selection: { anchor: sel.head + ins.length }, scrollIntoView: true });
  return true;
}
function shiftLines(view, dir) {
  const st = view.state, changes = [], seen = new Set();
  for (const r of st.selection.ranges) {
    for (let l = st.doc.lineAt(r.from).number; l <= st.doc.lineAt(r.to).number; l++) {
      if (seen.has(l)) continue; seen.add(l);
      const line = st.doc.line(l);
      if (dir > 0) changes.push({ from: line.from, insert: '  ' });
      else { const sp = line.text.match(/^ {1,2}/); if (sp) changes.push({ from: line.from, to: line.from + sp[0].length }); }
    }
  }
  if (changes.length) view.dispatch({ changes });
  return true;
}
const outlineKeys = V.Prec.high(V.keymap.of([
  { key: 'Enter', run: outlineEnter },
  { key: 'Tab', run: v => shiftLines(v, 1) },
  { key: 'Shift-Tab', run: v => shiftLines(v, -1) },
]));
class RefWidget extends V.WidgetType {
  constructor(addr, text, ok) { super(); this.addr = addr; this.text = text; this.ok = ok; }
  eq(o) { return o.addr === this.addr && o.text === this.text; }
  toDOM() {
    const s = document.createElement('span'); s.className = 'blockref' + (this.ok ? '' : ' missing');
    s.textContent = this.text; s.title = '((' + this.addr + ')) · click to jump'; s.dataset.ref = this.addr; return s;
  }
  ignoreEvent() { return false; }
}
class TearWidget extends V.WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-tear'; s.textContent = '⇱ card'; s.title = 'Tear this block out onto the canvas as a live card'; return s; }
  ignoreEvent() { return false; }
}
const refreshLinks = V.StateEffect.define();
const REF_DOCS = new WeakMap();   // doc (immutable) → it holds a ((ref)), so its decorations depend on the cursor line and on other pages
const curLine = (doc, sel) => doc.lineAt(Math.min(sel.main.head, doc.length)).number;
// [[links]] render as links; ((refs)) render as the referenced text, except on the line being edited.
function linkDecos(docObj, selection) {
  const out = [], doc = docObj.toString(), cur = docObj.lineAt(Math.min(selection.main.head, docObj.length));
  REF_DOCS.set(docObj, doc.includes('(('));
  for (const m of doc.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
    const a = m.index, b = a + 2 + m[1].length;
    out.push(V.Decoration.mark({ class: 'cm-brk' }).range(a, a + 2));
    out.push(V.Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-page': m[1] } }).range(a + 2, b));
    out.push(V.Decoration.mark({ class: 'cm-brk' }).range(b, b + 2));
  }
  for (const m of doc.matchAll(/^(\s*[-*+]\s+)(TODO|NEXT|WAITING|HOLD|SOMEDAY|DONE|CANCELLED|DOING|NOW|LATER)\b(.*)$/gm)) {
    const a = m.index + m[1].length, b = a + m[2].length;
    out.push(V.Decoration.mark({ class: 'cm-task cm-task-' + m[2].toLowerCase() }).range(a, b));
    if ((m[2] === 'DONE' || m[2] === 'CANCELLED') && m[3].trim()) out.push(V.Decoration.mark({ class: 'cm-task-done-text' }).range(b, b + m[3].length));
  }
  for (const m of doc.matchAll(/\(\(([^()\n]+)\)\)/g)) {
    const a = m.index, b = a + m[0].length;
    if (a <= cur.to && b >= cur.from) continue;
    const r = resolveRef(m[1]);
    out.push(V.Decoration.replace({ widget: new RefWidget(m[1], r ? r.text : m[1] + ' · not found', !!r) }).range(a, b));
  }
  for (const b of htmlBlocks(doc)) out.push(V.Decoration.widget({ widget: new TearWidget(), side: 1 }).range(b.head));
  return V.Decoration.set(out, true);
}
const linkField = V.StateField.define({
  create: st => linkDecos(st.doc, st.selection),
  // tr.state must not be read here (it is the state being built), so use newDoc/newSelection
  // A cursor move changes only which ((ref)) shows its source: nothing in a page without refs, nor while the cursor
  // stays on its line. Rebuilding on every move made j/k and clicks cost a pass over the whole page.
  update(val, tr) {
    if (tr.docChanged || tr.effects.some(e => e.is(refreshLinks))) return linkDecos(tr.newDoc, tr.newSelection);
    if (!tr.selection || !REF_DOCS.get(tr.newDoc) || curLine(tr.newDoc, tr.newSelection) === curLine(tr.startState.doc, tr.startState.selection)) return val;
    return linkDecos(tr.newDoc, tr.newSelection);
  },
  provide: f => V.EditorView.decorations.from(f),
});
function findPage(name) { name = String(name).trim().toLowerCase(); return nodeList().find(n => n.kind === 'buffer' && n.name.toLowerCase() === name) || null; }
function resolveRef(addr) {
  addr = String(addr).trim(); let hit = null;
  const m = addr.match(/^([^#›]+)#([\w-]+)$/);
  if (m) {
    const n = findPage(m[1]), v = n && live[n.id]?.view;
    if (v) for (const a of Object.values(v.state.field(anchorField))) if (a.label === m[2]) hit = { node: n, pos: a.pos };
  } else if (addr.includes('›')) hit = resolveBufferAddress(addr);
  else { const n = findPage(addr); if (n && live[n.id]?.view) hit = { node: n, pos: 0 }; }
  if (!hit || !live[hit.node.id]?.view) return null;
  const doc = live[hit.node.id].view.state.doc, line = doc.lineAt(Math.min(hit.pos, doc.length));
  let text = (doc.sliceString(hit.pos, line.to).trim() || line.text.trim()).replace(/^([-*+]|\d+\.)\s+|^#+\s+/, '');
  return { ...hit, text: text.length > 90 ? text.slice(0, 88) + '…' : text || hit.node.name };
}
// [[name]] opens any node with that name, or creates a page.
function openPage(name, from, quiet) {
  name = clean(name);
  const fo = !findPage(name) && findFolder(name); if (fo) { if (!quiet) jumpFolder(fo); return fo; }
  let n = findPage(name) || nodeList().find(m => m.name.toLowerCase() === name.toLowerCase());
  if (!n) {
    const base = from || S.nodes[activeId], c = viewCenterWorld();
    const pos = base ? freeSpot(base.x + base.w + 60, base.y + 30, 420, 300) : freeSpot(c.x - 210, c.y - 150, 420, 300);
    n = addNode({ kind: 'buffer', name, ...pos, w: 420, h: 300, text: `# ${name}\n\n- ` });
    if (!quiet) toast(`Created page ${name}`);
  }
  if (!quiet) { if (VIEW === 'editor') edOpen(n); else jumpNode(n, 1, () => focusEnd(n)); }
  return n;
}
function focusEnd(n) {
  const v = live[n.id]?.view; if (!v) return;
  v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true }); v.focus();
}
function openToday() {
  if (VIEW === 'editor') return edOpen(openPage(TODAY, null, true));
  const n = findPage(TODAY);
  if (n) return jumpNode(n, 1, () => focusEnd(n));
  openPage(TODAY);
}
function freeSpot(x, y, w, h) {
  for (let i = 0; i < 40; i++) {
    if (!nodeList().some(m => x < m.x + m.w + 20 && x + w + 20 > m.x && y < m.y + m.h + 20 && y + h + 20 > m.y)) break;
    y += 60;
  }
  return { x: Math.round(x), y: Math.round(y) };
}
// One pass over every page: each line is lowercased once and its [[name]], ((name#…)) and ((name ›…)) targets are
// collected, so the cost is the board's text, not pages × pages × lines. A box is rebuilt only when its hits changed.
function updateBacklinks() {
  const pages = nodeList().filter(n => n.kind === 'buffer' && live[n.id]?.view);
  const names = new Set(pages.map(p => p.name.toLowerCase())), hitsOf = new Map();
  const RX = /\[\[([^\[\]\n]+)\]\]|\(\(([^()#›\n]+?)\s*(?:#|›)/g;
  for (const q of pages) {
    const st = live[q.id].view.state, doc = st.doc, text = doc.toString();
    if (!text.includes('[[') && !text.includes('((')) continue;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i), low = line.text.toLowerCase(), seen = new Set();
      if (!low.includes('[[') && !low.includes('((')) continue;
      for (const m of low.matchAll(RX)) {
        const name = m[1] !== undefined ? m[1] : m[2].trimEnd();
        if (!names.has(name) || seen.has(name)) continue;
        seen.add(name);
        if (!hitsOf.has(name)) hitsOf.set(name, []);
        hitsOf.get(name).push({ q, pos: line.from, t: line.text, st });
      }
    }
  }
  for (const p of pages) {
    const box = live[p.id].backlinks; if (!box) continue;
    const hits = (hitsOf.get(p.name.toLowerCase()) || []).filter(h => h.q !== p);
    const sig = hits.length + '\n' + hits.slice(0, 20).map(h => h.q.id + ':' + h.pos + ':' + h.t).join('\n');
    if (box._sig === sig) continue;
    box._sig = sig; box.replaceChildren();
    if (!hits.length) continue;
    box.append(el('h4', null, `Linked references · ${hits.length}`));
    for (const h of hits.slice(0, 20)) {
      const a = el('span', 'bl'); a.innerHTML = '<b></b> <span></span>';
      $('b', a).textContent = fmtAddr({ ...bufferAddress(h.q, h.st, h.pos), quote: '' });
      $('span', a).textContent = h.t.trim().replace(/^([-*+]|\d+\.)\s+/, '');
      a.onclick = () => jumpBuffer(h.q, h.pos);
      box.append(a);
    }
  }
}
let crossT = null;
function scheduleCrossRefresh() {
  clearTimeout(crossT);
  crossT = setTimeout(() => {
    updateBacklinks();
    // Only ((refs)) show another page's text; [[links]] look the same whatever the other pages say.
    for (const n of nodeList()) { const v = n.kind === 'buffer' && live[n.id]?.view; if (v && REF_DOCS.get(v.state.doc) !== false) v.dispatch({ effects: refreshLinks.of(null) }); }
    if (ED.view && REF_DOCS.get(ED.view.state.doc) !== false) ED.view.dispatch({ effects: refreshLinks.of(null) });
    refreshViews();
  }, 250);
}

// ------------------------------------------------------------------ sketch shapes (Excalidraw-style)
const SHAPE_TOOLS = new Set(['rect', 'diamond', 'ellipse', 'arrow', 'text']);
let rsShapes = null, selShape = null;
function anyById(id) { return S.nodes[id] || S.shapes.find(s => s.id === id) || null; }
function arrowEnds(s) {
  const end = (b, x, y) => { const o = b && anyById(b.id); return o ? [o.x + b.dx, o.y + b.dy] : [x, y]; };
  const [x1, y1] = end(s.a, s.x1, s.y1), [x2, y2] = end(s.b, s.x2, s.y2);
  return { x1, y1, x2, y2 };
}
function addLabel(g, text, cx, cy, fs) {
  const lines = text.split('\n'), t = svgEl('text', { 'font-size': fs, 'text-anchor': 'middle' });
  lines.forEach((ln, i) => { const sp = svgEl('tspan', { x: cx, y: cy + (i - (lines.length - 1) / 2) * fs * 1.25 + fs * 0.35 }); sp.textContent = ln; t.append(sp); });
  g.append(t);
}
function drawShape(s) {
  const rs = rsShapes || (rsShapes = V.rough.svg(shapesSvg));
  const g = svgEl('g', { class: `shape c-${s.color}${selShape === s.id ? ' sel' : ''}` }); g.dataset.id = s.id;
  const o = { seed: s.seed, roughness: 1.1, bowing: 1, stroke: 'currentColor', strokeWidth: 1.8 };
  if (s.type === 'arrow') {
    const { x1, y1, x2, y2 } = arrowEnds(s), ang = Math.atan2(y2 - y1, x2 - x1), L = 16;
    g.append(svgEl('line', { x1, y1, x2, y2, class: 'hit-line' }));
    g.append(rs.line(x1, y1, x2, y2, o));
    g.append(rs.linearPath([[x2 - L * Math.cos(ang - .45), y2 - L * Math.sin(ang - .45)], [x2, y2], [x2 - L * Math.cos(ang + .45), y2 - L * Math.sin(ang + .45)]], o));
    if (s.text) addLabel(g, s.text, (x1 + x2) / 2, (y1 + y2) / 2 - 14, 16);
    g.append(svgEl('rect', { class: 'selbox', x: Math.min(x1, x2) - 6, y: Math.min(y1, y2) - 6, width: Math.abs(x2 - x1) + 12, height: Math.abs(y2 - y1) + 12 }));
  } else {
    const { x, y, w, h } = s;
    g.append(svgEl('rect', { x, y, width: w, height: h, class: 'hit' }));
    if (s.type === 'rect') g.append(rs.rectangle(x, y, w, h, o));
    else if (s.type === 'ellipse') g.append(rs.ellipse(x + w / 2, y + h / 2, w, h, o));
    else if (s.type === 'diamond') g.append(rs.polygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], o));
    if (s.text) addLabel(g, s.text, x + w / 2, y + h / 2, s.type === 'text' ? 22 : 18);
    g.append(svgEl('rect', { class: 'selbox', x: x - 5, y: y - 5, width: w + 10, height: h + 10 }));
    const hd = svgEl('rect', { class: 'shandle', x: x + w - 1, y: y + h - 1, width: 9, height: 9 }); hd.dataset.handle = '1'; g.append(hd);
  }
  return g;
}
// Sketch shapes go into a deck with their folder; an arrow hides when either end is in a deck.
function shapeHidden(s) {
  if (DESK.cur) {   // on a desk: the shapes of its folders, and what is drawn there; a Board arrow shows only with both ends
    if (s.type !== 'arrow') { const f = deskShapeFrame(s); if (f ? deskOff(f) : DESK.shapeOld.has(s.id)) return true; }
    else if (DESK.shapeOld.has(s.id) && !(s.a && s.b)) return true;
  }
  if (s.in && S.nodes[s.in] && (S.nodes[s.in].mode === 'stack' || stashed(S.nodes[s.in]))) return true;
  if (s.type === 'arrow') for (const e of [s.a, s.b]) { if (!e) continue; const nd = S.nodes[e.id], sh = !nd && S.shapes.find(x => x.id === e.id); if ((nd && stashed(nd)) || (sh && shapeHidden(sh))) return true; }
  return false;
}
function renderShapes() { if (S) shapesSvg.replaceChildren(...S.shapes.filter(s => !shapeHidden(s)).map(drawShape)); }
function fitText(s) {
  const lines = (s.text || '').split('\n'), fs = 22;
  s.w = Math.round(Math.max(...lines.map(l => l.length), 2) * fs * 0.56 + 14); s.h = Math.round(lines.length * fs * 1.25 + 8);
}
function addShape(s) {
  s.id = s.id || uid('sh'); s.seed = s.seed || hashSeed(s.id); s.color = s.color || inkColor;
  if (s.type === 'text') fitText(s);
  S.shapes.push(s); renderShapes(); dirty(); return s;
}
function removeShape(id) {
  for (const a of S.shapes) {   // arrows bound to the removed element keep their last position
    if (a.type !== 'arrow') continue;
    const e = arrowEnds(a);
    if (a.a?.id === id) { a.x1 = e.x1; a.y1 = e.y1; delete a.a; }
    if (a.b?.id === id) { a.x2 = e.x2; a.y2 = e.y2; delete a.b; }
  }
  S.shapes = S.shapes.filter(s => s.id !== id); if (selShape === id) selShape = null;
  renderShapes(); dirty();
}
function bindTarget(x, y, except) {
  const n = nodeAt(x, y); if (n && n.id !== except) return n;
  for (let i = S.shapes.length - 1; i >= 0; i--) { const s = S.shapes[i]; if (s.type !== 'arrow' && s.id !== except && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s; }
  return null;
}
function startShape(ev) {
  const r = viewport.getBoundingClientRect(), p0 = s2w(ev.clientX - r.left, ev.clientY - r.top), pid = ev.pointerId;
  if (tool === 'text') { const s = addShape({ type: 'text', x: Math.round(p0.x), y: Math.round(p0.y - 14), text: '' }); setTool('select'); setTimeout(() => editShapeText(s), 0); return; }
  viewport.setPointerCapture(pid);
  const s = { id: uid('sh'), type: tool, color: inkColor, x: p0.x, y: p0.y, w: 1, h: 1 }; s.seed = hashSeed(s.id);
  if (tool === 'arrow') { Object.assign(s, { x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y }); const hit = bindTarget(p0.x, p0.y); if (hit) s.a = { id: hit.id, dx: p0.x - hit.x, dy: p0.y - hit.y }; }
  S.shapes.push(s);
  const mv = e => {
    if (e.pointerId !== pid) return;
    const p = s2w(e.clientX - r.left, e.clientY - r.top);
    if (s.type === 'arrow') { s.x2 = p.x; s.y2 = p.y; }
    else { s.x = Math.min(p0.x, p.x); s.y = Math.min(p0.y, p.y); s.w = Math.abs(p.x - p0.x); s.h = Math.abs(p.y - p0.y); if (e.shiftKey) s.w = s.h = Math.max(s.w, s.h); }
    renderShapes();
  };
  const up = e => {
    if (e.pointerId !== pid) return;
    viewport.removeEventListener('pointermove', mv); viewport.removeEventListener('pointerup', up);
    if (s.type === 'arrow') {
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 8) s.x2 = s.x1 + 120;
      const hit = bindTarget(s.x2, s.y2, s.a?.id); if (hit) s.b = { id: hit.id, dx: s.x2 - hit.x, dy: s.y2 - hit.y };
    } else if (s.w < 8 && s.h < 8) { s.w = 160; s.h = 90; s.x -= 80; s.y -= 45; }
    selShape = s.id; renderShapes(); setTool('select'); dirty();
  };
  viewport.addEventListener('pointermove', mv); viewport.addEventListener('pointerup', up);
}
function editShapeText(s) {
  const ta = document.createElement('textarea'); ta.className = 'text-edit'; ta.setAttribute('aria-label', 'Shape label');
  const e = s.type === 'arrow' ? arrowEnds(s) : null;
  const wx = e ? (e.x1 + e.x2) / 2 - 90 : s.x, wy = e ? (e.y1 + e.y2) / 2 - 24 : s.y;
  const p = w2s(wx, wy), r = viewport.getBoundingClientRect(), z = cam().z;
  Object.assign(ta.style, { left: r.left + p.x + 'px', top: r.top + p.y + 'px', width: Math.max(180, (s.w || 180) * z) + 'px', height: Math.max(44, (s.type === 'text' ? s.h : Math.min(s.h || 60, 90)) * z) + 'px', fontSize: clamp(20 * z, 13, 32) + 'px' });
  ta.value = s.text || ''; document.body.append(ta); ta.focus(); ta.select();
  ta.addEventListener('blur', () => {
    ta.remove(); s.text = ta.value.trim();
    if (s.type === 'text') { if (!s.text) return removeShape(s.id); fitText(s); }
    renderShapes(); dirty();
  }, { once: true });
  ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) ta.blur(); });
}
shapesSvg.addEventListener('pointerdown', ev => {
  const g = ev.target.closest('.shape'); if (!g || tool !== 'select' || ev.button !== 0) return;
  ev.stopPropagation(); ev.preventDefault();
  const s = S.shapes.find(x => x.id === g.dataset.id); if (!s) return;
  selShape = s.id; renderShapes();
  const sx = ev.clientX, sy = ev.clientY, z = cam().z, o = { ...s }, resizing = ev.target.dataset.handle;
  const mv = e => {
    const dx = (e.clientX - sx) / z, dy = (e.clientY - sy) / z;
    if (resizing) { s.w = Math.max(20, o.w + dx); s.h = Math.max(16, o.h + dy); }
    else if (s.type === 'arrow') { if (!s.a) { s.x1 = o.x1 + dx; s.y1 = o.y1 + dy; } if (!s.b) { s.x2 = o.x2 + dx; s.y2 = o.y2 + dy; } }
    else { s.x = o.x + dx; s.y = o.y + dy; }
    renderShapes();
  };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); dirty(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
});
shapesSvg.addEventListener('dblclick', ev => {
  const g = ev.target.closest('.shape'); if (!g) return;
  ev.stopPropagation(); const s = S.shapes.find(x => x.id === g.dataset.id); if (s) editShapeText(s);
});

// ------------------------------------------------------------------ agent
// Runs on Claude through the artifact's `sample` capability. Tools are page functions over the board.
let samplePromise = null;
function getSample() {
  if (!samplePromise) samplePromise = (DAEMON && INFO?.sample) ? Promise.resolve(daemonSample()) : window.claude?.use ? Promise.resolve(window.claude.use('sample')).catch(() => null) : Promise.resolve(null);
  return samplePromise;
}
function findNode(p) {
  if (!p) return null;
  p = String(p).trim().replace(/^\[\[|\]\]$/g, '');
  if (p === 'dock' && S.dockTerm) return S.dockTerm;
  const all = nodeList(), low = p.toLowerCase();
  const hit = all.find(n => pathOf(n.id) === p) || all.find(n => pathOf(n.id).toLowerCase() === low) || all.find(n => n.name.toLowerCase() === low) || all.find(n => n.id === p) || null;
  if (hit) return hit;
  return boardAt(p.replace(/^board:/, '').replace(/^\/+/, '')) || null;   // folder path as addresses write it (board:/folder/name)
}
function boardSummary() {
  const lines = [];
  for (const f of frameList()) lines.push(`folder ${fullPath(f)}/ [${f.mode || 'free'}${f.mode === 'stack' ? ', collapsed into a deck' : ''}, ${f.shape || 'folder'} shape, ${kidsOf(f.id).length} item(s)]`);
  for (const n of nodeList()) {
    let extra = '';
    if (n.kind === 'term') extra = n.backend === 'pty' ? ', real shell' : `, simulated shell, cwd ${n.cwd}`;
    if (n.kind === 'repl') extra = n.lang === 'js' ? ', JavaScript REPL' : `, ${n.cmd} REPL`;
    if (n.kind === 'buffer') extra = `, ${(n.text || '').split('\n').length} lines`;
    if (n.kind === 'artifact') extra = `, artifact page, capabilities ${Object.keys(n.capabilities || {}).join('/') || 'none'}, version ${String(n.head || '').slice(0, 8)}`;
    lines.push(`- ${pathOf(n.id)} [${n.kind === 'buffer' ? 'page' : n.kind}${extra}] ${n.in ? 'in folder ' + folderPath(n) + '/' : 'loose on the canvas'}${deskOff(n) ? ' (not on this desk)' : stashed(n) ? ' (hidden in a deck)' : ''}`);
  }
  for (const e of S.edges) if (S.nodes[e.from] && S.nodes[e.to]) lines.push(`edge ${e.type}: ${pathOf(e.from)} -> ${pathOf(e.to)}`);
  const labeled = S.shapes.filter(s => s.text);
  if (S.shapes.length) lines.push(`${S.shapes.length} sketch shape(s)` + (labeled.length ? ': ' + labeled.slice(0, 12).map(s => `${s.type} "${s.text.replace(/\n/g, ' ')}"`).join(', ') : ''));
  return lines.join('\n');
}
function agentRules(n) {
  if (n.id === 'chat') return chatRules();
  const act = activeId && activeId !== n.id && S.nodes[activeId] ? pathOf(activeId) : 'nothing in particular';
  return `You are "${pathOf(n.id)}", an agent node on a canvas workbench: a pannable board of shells, REPLs, markdown outline pages, reference cards, folders and hand-drawn shapes. Spawn edges form trees; pipe edges carry data. Folders are containers on the canvas that hold nodes and other folders. A folder is free (items stay where placed; it stretches to hold them), pack (items flow into rows in order) or stack (collapsed into a deck of cards). Use make_folder and put_in_folder to organise; reading or running something inside a deck works without spreading it. Pages follow Logseq conventions: "- " bullets, [[page]] links, ((address)) block references. Addresses look like "plans › Rollout ¶2", "plans#freeze" or folder cells like "machines/B2".

Look before you answer and act when asked, using the tools: read nodes, run commands in shells or REPLs, write pages, create nodes and edges, draw shapes, move the view. Shells here are simulated (ls, cd, cat, echo, mkdir, touch, tree, env, export, pwd); REPLs run JavaScript. Keep replies short and concrete, refer to nodes by path, and say what you changed.

Board now:
${boardSummary()}

The user last focused: ${act}.`;
}
const str = v => (v == null ? '' : String(v));
const AGENT_TOOLS = [
  { name: 'read_node', description: 'Read a node by path. A page returns its markdown; a shell or REPL returns its last 80 lines of output; a ref returns its text.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path }) => {
      const n = findNode(path); if (!n) throw new Error('no node at ' + path);
      syncBuffers();
      if (n.kind === 'buffer') return (n.text || '').slice(0, 8000);
      if (live[n.id]?.term) return termLines(live[n.id], 80).join('\n') || '(empty)';
      if (n.kind === 'acp') return live[n.id]?.backend?.text(40) ?? '(not mounted)';
      if (n.kind === 'agent') return (n.log || []).slice(-10).map(l => `${l.t}: ${l.text || l.name}`).join('\n');
      return n.text || '';
    } },
  { name: 'run_in_shell', description: 'Type a command into a shell or REPL node and press Enter. Returns the new output, up to 60 lines.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, command: { type: 'string' } }, required: ['path', 'command'] },
    run: async ({ path, command }, ctx) => {
      const n = findNode(path), L = n && live[n.id]; if (!L?.term) throw new Error('not a shell or REPL: ' + path);
      const before = termLines(L, 2000);
      L.backend.input(str(command).replace(/\n/g, '\r') + '\r'); pulse(n.id);
      let last = '', stable = 0;
      for (let i = 0; i < 40 && stable < 3 && !ctx?.signal?.aborted; i++) { await new Promise(r => setTimeout(r, 200)); const cur = termLines(L, 2000).join('\n'); stable = cur === last ? stable + 1 : 0; last = cur; }
      const after = termLines(L, 2000); let k = 0;
      while (k < before.length - 1 && before[k] === after[k]) k++;
      return after.slice(k).slice(-60).join('\n') || '(no output)';
    } },
  { name: 'write_page', description: 'Write markdown to a page. mode "append" (default) adds at the end; "replace" replaces all text. Creates the page if it does not exist.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } }, required: ['path', 'text'] },
    run: ({ path, text, mode }) => {
      let n = findNode(path); if (!n) n = openPage(str(path), live[activeId] ? S.nodes[activeId] : null, true);
      if (n.kind !== 'buffer') throw new Error(path + ' is not a page');
      const v = live[n.id].view, doc = v.state.doc, t = str(text);
      if (mode === 'replace') v.dispatch({ changes: { from: 0, to: doc.length, insert: t } });
      else v.dispatch({ changes: { from: doc.length, insert: (doc.length && !doc.toString().endsWith('\n') ? '\n' : '') + t }, scrollIntoView: true });
      pulse(n.id);
      return `ok, ${pathOf(n.id)} now has ${v.state.doc.lines} lines`;
    } },
  { name: 'create_node', description: 'Create a node. kind is page, shell or repl. parent (a node path of the same kind) makes it a spawned child that inherits context; near (a node path) places it beside that node. Returns the new path.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['page', 'shell', 'repl'] }, name: { type: 'string' }, text: { type: 'string', description: 'initial markdown for a page' }, parent: { type: 'string' }, near: { type: 'string' } }, required: ['kind', 'name'] },
    run: ({ kind, name, text, parent, near }) => {
      const k = { page: 'buffer', shell: 'term', repl: 'repl' }[kind]; if (!k) throw new Error('unknown kind ' + kind);
      const par = parent && findNode(parent), nr = near && findNode(near);
      if (par && par.kind === k) return pathOf(spawnChild(par, name).id);
      const extra = { term: { backend: DAEMON ? 'pty' : 'fake', shell: shellDefault(), cwd: DAEMON ? undefined : '/home/me', env: {} }, repl: { lang: 'js', history: [] }, buffer: { text: str(text) || `# ${clean(name)}\n\n- ` } }[k];
      const w = k === 'buffer' ? 420 : 520, h = k === 'buffer' ? 300 : 340, base = nr || par || n0();
      const pos = base ? freeSpot(base.x + base.w + 60, base.y, w, h) : (c => freeSpot(c.x - w / 2, c.y - h / 2, w, h))(viewCenterWorld());
      const m = addNode({ kind: k, name: clean(name), ...pos, w, h, ...extra });
      if (par) { S.edges.push({ id: uid('e'), from: par.id, to: m.id, type: 'spawn' }); renderLinks(); updateAllTitles(); dirty(); }
      return pathOf(m.id);
    } },
  { name: 'link_nodes', description: 'Add an edge between two nodes. type is spawn (tree lineage), pipe (data flows from -> to) or ref.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: ['spawn', 'pipe', 'ref'] } }, required: ['from', 'to', 'type'] },
    run: ({ from, to, type }) => {
      const a = findNode(from), b = findNode(to); if (!a || !b) throw new Error('unknown node');
      S.edges.push({ id: uid('e'), from: a.id, to: b.id, type: ['spawn', 'pipe', 'ref'].includes(type) ? type : 'pipe' });
      renderLinks(); updateAllTitles(); dirty(); return `ok: ${pathOf(a.id)} -${type}-> ${pathOf(b.id)}`;
    } },
  { name: 'draw_shape', description: 'Draw a hand-drawn shape. shape is rect, ellipse, diamond, text or arrow. An arrow needs from and to (node paths or shape ids) and binds to them. Other shapes take a label and either near (a node path) or x and y world coordinates. color is ink, red or blue. Returns the shape id.',
    inputSchema: { type: 'object', properties: { shape: { type: 'string', enum: ['rect', 'ellipse', 'diamond', 'text', 'arrow'] }, label: { type: 'string' }, near: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' }, color: { type: 'string', enum: ['ink', 'red', 'blue'] } }, required: ['shape'] },
    run: ({ shape, label, near, x, y, from, to, color }) => {
      const c = ['ink', 'red', 'blue'].includes(color) ? color : 'blue', t = str(label);
      if (shape === 'arrow') {
        const a = findNode(from) || S.shapes.find(s => s.id === from), b = findNode(to) || S.shapes.find(s => s.id === to);
        if (!a || !b) throw new Error('an arrow needs existing from and to');
        const down = b.y > a.y + a.h;
        const s = addShape({ type: 'arrow', color: c, text: t, x1: 0, y1: 0, x2: 0, y2: 0,
          a: { id: a.id, dx: down ? a.w / 2 : a.w, dy: down ? a.h : a.h / 2 }, b: { id: b.id, dx: down ? b.w / 2 : 0, dy: down ? 0 : b.h / 2 } });
        return s.id;
      }
      const nr = near && findNode(near), lines = t.split('\n'), longest = Math.max(...lines.map(l => l.length), 6);
      const w = Math.max(140, longest * 10 + 50), h = Math.max(70, lines.length * 24 + 40);
      const base = nr ? { x: nr.x + nr.w + 40, y: nr.y + nr.h - h } : { x: Number.isFinite(+x) && x !== undefined ? +x : viewCenterWorld().x - w / 2, y: Number.isFinite(+y) && y !== undefined ? +y : viewCenterWorld().y - h / 2 };
      const s = addShape({ type: ['rect', 'ellipse', 'diamond', 'text'].includes(shape) ? shape : 'rect', color: c, text: t, x: Math.round(base.x), y: Math.round(base.y), w, h });
      return s.id;
    } },
  { name: 'make_folder', description: 'Create a folder: a container on the canvas. mode is free (items stay where placed), pack (items flow into rows) or stack (collapsed deck). shape is folder, box or round. inside nests it in an existing folder. Returns its path.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, mode: { type: 'string', enum: ['free', 'pack', 'tile', 'stack'] }, shape: { type: 'string', enum: FSHAPES }, inside: { type: 'string' } }, required: ['name'] },
    run: ({ name, mode, shape, inside }) => {
      const par = inside ? findFolder(inside) : null; if (inside && !par) throw new Error('no folder ' + inside);
      const c = viewCenterWorld(), pos = freeSpot(c.x - 300, c.y - 160, 600, 320);
      const f = addNode({ kind: 'frame', name: clean(name), ...pos, w: 600, h: 320, mode: 'free', shape: FSHAPES.includes(shape) ? shape : 'folder', in: undefined });
      if (par) adopt(f, par, null, true);
      if (mode && mode !== 'free') setMode(f, mode, true);
      pulse(f.id); return fullPath(f) + '/';
    } },
  { name: 'put_in_folder', description: 'Move a node or folder into a folder (it goes to the end, or on top of a deck), or onto the bare canvas when folder is empty. mode optionally changes that folder to free, pack or stack.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, folder: { type: 'string' }, mode: { type: 'string', enum: ['free', 'pack', 'tile', 'stack'] } }, required: ['path'] },
    run: ({ path, folder, mode }) => {
      const n = findNode(path) || findFolder(path); if (!n) throw new Error('nothing at ' + path);
      const f = folder ? findFolder(folder) : null; if (folder && !f) throw new Error('no folder ' + folder);
      if ((n.in || null) !== (f ? f.id : null)) adopt(n, f, null, true);
      if (f && mode) setMode(f, mode, true);
      return `${n.name} is now ${f ? 'in ' + fullPath(f) + '/ (' + (f.mode || 'free') + ')' : 'loose on the canvas'}`;
    } },
  { name: 'move_view', description: 'Move the user\'s view to show something: a node path, a folder path, a folder cell like machines/B2, a page address, an anchor like plans#freeze, or text to search.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    run: ({ target }) => { const r = palSearch(str(target))[0]; if (!r) throw new Error('nothing matches ' + target); r.run(); return 'showing ' + r.l; } },
];
const n0 = () => (activeId && S.nodes[activeId]) || null;
function pulse(id) { const L = live[id]; if (!L) return; L.el.classList.remove('pulse'); void L.el.offsetWidth; L.el.classList.add('pulse'); }
function mountAgent(n, L) {
  n.log = n.log || []; n.turns = n.turns || []; n.tier = n.tier || 'quick';
  for (const m of n.log) if (m.live) { m.live = false; if (m.text === 'Thinking…') m.text = '(interrupted)'; }
  L.body.innerHTML = '<div class="ag-log" aria-live="polite"></div><form class="ag-in"><textarea rows="2" placeholder="Ask about the board, or tell the agent what to do…"></textarea>'
    + '<div class="ag-row"><span class="seg" role="group" aria-label="Model"><button type="button" data-t="quick" title="Fastest model">Fast</button><button type="button" data-t="default" title="Balanced model that thinks first">Expert</button><button type="button" data-t="complex" title="Most capable model, slowest">Heavy</button></span>'
    + '<button type="button" class="mic" title="Hold to talk, release to send. Tap to dictate without sending.">🎙</button><button type="button" class="stop" hidden>Stop</button><button type="submit" class="go">Send</button></div></form>';
  L.logEl = $('.ag-log', L.body); L.ta = $('textarea', L.body);
  const seg = () => $$('.seg button', L.body).forEach(b => b.classList.toggle('on', b.dataset.t === n.tier));
  $$('.seg button', L.body).forEach(b => b.onclick = () => { n.tier = b.dataset.t; seg(); dirty(); });
  seg();
  $('.ag-in', L.body).addEventListener('submit', e => { e.preventDefault(); agentSend(n); });
  L.ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(n); } });
  $('.stop', L.body).onclick = () => L.ctl?.abort();
  wireMic($('.mic', L.body), n);
  renderAgentLog(n);
}
function renderAgentLog(n) {
  const L = live[n.id]; if (!L?.logEl) return;
  L.logEl.replaceChildren(...n.log.map(m => {
    const d = el('div', 'ag-msg ag-' + (m.t === 'assistant' ? 'asst' : m.t));
    if (m.t === 'tool') {
      d.innerHTML = '<b></b> <span class="args"></span><span class="res"></span>';
      $('b', d).textContent = '⚙ ' + m.name; $('.args', d).textContent = m.args || ''; $('.res', d).textContent = m.res ?? '…';
    } else d.textContent = m.text;
    if (m.live) d.classList.add('thinking');
    return d;
  }));
  L.logEl.scrollTop = L.logEl.scrollHeight;
  if (lastLod) refreshSnapshots();
}
async function agentSend(n, opt = {}) {
  const L = live[n.id]; if (!L || L.busy) return;
  const text = (opt.text ?? L.ta.value).trim(); if (!text) return;
  if (opt.text == null) L.ta.value = '';
  n.log.push({ t: 'user', text }); n.turns.push({ role: 'user', content: opt.note ? `${opt.note}\n${text}` : text }); renderAgentLog(n);
  const sample = await getSample();
  if (!sample) {
    n.log.push({ t: 'note', text: DAEMON ? SAMPLE_OFF : 'The agent needs a language model: Claude inside the hosted artifact on claude.ai, or a Workbench server that serves one. It is not available in this copy.' });
    renderAgentLog(n); dirty(); return;
  }
  L.busy = true; $('.stop', L.body).hidden = false; $('.go', L.body).disabled = true; activity(n.id);
  const reply = { t: 'assistant', text: 'Thinking…', live: true }; n.log.push(reply); renderAgentLog(n);
  const ctl = L.ctl = new AbortController();
  const tools = AGENT_TOOLS.map(t => ({
    name: t.name, description: t.description, inputSchema: t.inputSchema,
    execute: async (input, ctx) => {
      const entry = { t: 'tool', name: t.name, args: JSON.stringify(input || {}).slice(0, 180) };
      n.log.splice(n.log.indexOf(reply), 0, entry); renderAgentLog(n); activity(n.id);
      try {
        const r = await t.run(input || {}, ctx), out = typeof r === 'string' ? r : JSON.stringify(r);
        entry.res = out.split('\n').slice(0, 4).join('\n'); renderAgentLog(n); dirty();
        return out.slice(0, 30000);
      } catch (e) { entry.res = 'error: ' + (e.message || e); renderAgentLog(n); throw e; }
    },
  }));
  try {
    const res = await sample([{ role: 'user', content: agentRules(n) }, ...n.turns.slice(-16)], {
      modelTier: n.tier, tools, signal: ctl.signal, ...(opt.images ? { images: opt.images } : {}),
      onText: ({ text: t }) => { reply.text = t; reply.live = false; renderAgentLog(n); },
    });
    reply.text = res.text; reply.live = false; n.turns.push({ role: 'assistant', content: res.text });
    if (res.truncated) n.log.push({ t: 'note', text: 'The answer was cut short. Ask for less at a time.' });
  } catch (e) {
    reply.live = false; reply.text = e?.text || '';
    if (reply.text) n.turns.push({ role: 'assistant', content: reply.text }); else n.log.splice(n.log.indexOf(reply), 1);
    const msg = { cancelled: 'Stopped.', not_granted: 'The agent needs permission to use Claude. Allow it from the artifact’s permissions, then send again.',
      rate_limited: 'Too many requests right now. Wait a moment, then send again.', tools_unavailable: 'This view cannot run agent tools.',
      sampling_disabled: 'Claude is not available for this account.', session_expired: 'Sign in to claude.ai again, then send again.' }[e?.code] || `The request failed (${e?.code || 'error'}). Send again to retry.`;
    n.log.push({ t: 'note', text: msg });
  } finally {
    L.busy = false; $('.stop', L.body).hidden = true; $('.go', L.body).disabled = false;
    if (n.log.length > 80) n.log.splice(0, n.log.length - 80);
    renderAgentLog(n); dirty();
  }
}

// ------------------------------------------------------------------ pen: handwriting becomes text, or a question
// Strokes written close together in time and space form one note. A chip beside it turns the note into text
// (Claude reads the ink as an image) or sends it to the assistant. Ink on a page turns into text at its line.
const INK = { ids: [], t: 0 };
function inkBox(ids) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of S.strokes) if (ids.includes(s.id)) for (const [x, y] of strokeWorldPts(s)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x0 < Infinity ? { x0, y0, x1, y1 } : null;
}
function inkTrack(s) {
  const now = Date.now(), b = inkBox([s.id]), prev = INK.ids.length ? inkBox(INK.ids) : null;
  const near = prev && b && b.x0 < prev.x1 + 260 && b.x1 > prev.x0 - 260 && b.y0 < prev.y1 + 200 && b.y1 > prev.y0 - 200;
  if (!(near && now - INK.t < 8000)) INK.ids = [];
  INK.ids.push(s.id); INK.t = now; placeInkChip();
}
function placeInkChip() {
  const c = $('#ink-chip'); if (!c || !S) return;
  if (INK.ids.length) INK.ids = INK.ids.filter(id => S.strokes.some(s => s.id === id));
  const b = INK.ids.length && VIEW === 'canvas' ? inkBox(INK.ids) : null;
  if (!b) { c.hidden = true; return; }
  const r = viewport.getBoundingClientRect(), p = w2s(b.x1, b.y0);
  c.hidden = false;
  c.style.left = clamp(r.left + p.x + 10, 8, innerWidth - c.offsetWidth - 8) + 'px';
  c.style.top = clamp(r.top + p.y - 44, 58, innerHeight - 90) + 'px';
}
async function inkImage(ids) {
  const polys = S.strokes.filter(s => ids.includes(s.id)).map(s => V.getStroke(strokeWorldPts(s).map((p, i) => [p[0], p[1], s.pts[i]?.[2] ?? 0.5]), strokeOpts(s)));
  const b = inkBox(ids), pad = 24, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2, k = clamp(1400 / Math.max(w, h), 0.5, 3);
  const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#111';
  for (const poly of polys) { if (poly.length < 2) continue; g.beginPath(); poly.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo']((x - b.x0 + pad) * k, (y - b.y0 + pad) * k)); g.closePath(); g.fill(); }
  return new Promise(res => cv.toBlob(res, 'image/png'));
}
async function canSeeImages() {
  const sample = await getSample(); if (!sample) { toast(DAEMON ? SAMPLE_OFF : 'Reading handwriting needs a language model: Claude inside the hosted artifact on claude.ai, or a Workbench server that serves one.', 6000); return null; }
  const lim = await sample.limits?.().catch(() => null);
  if (!lim?.images) { toast('The model here cannot read images, so it cannot read handwriting.', 6000); return null; }
  return sample;
}
const INK_PROMPT = 'The image is a handwritten note from a personal workspace. Transcribe it to Markdown. Keep the writer\'s words and line breaks. Lines that look like list items become "- " bullets; a first line that looks like a title becomes "# Title". Write "- TODO " for items marked as to-do or with an empty checkbox. Use [[name]] only where the writer drew double brackets. If a word is unreadable, write [?]. Output only the Markdown, no commentary.';
async function inkToText() {
  const ids = [...INK.ids]; if (!ids.length) return;
  const sample = await canSeeImages(); if (!sample) return;
  const chip = $('#ink-chip'); chip.classList.add('busy');
  try {
    const res = await sample(INK_PROMPT, { images: [await inkImage(ids)], modelTier: 'default', cache: false });
    const md = res.text.trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    if (!md) throw new Error('empty');
    const strokes = S.strokes.filter(s => ids.includes(s.id));
    const onPage = strokes.find(s => s.aid && S.nodes[s.owner]?.kind === 'buffer' && live[s.owner]?.view);
    let where;
    if (onPage) {
      const n = S.nodes[onPage.owner], v = live[n.id].view, a = v.state.field(anchorField)[onPage.aid];
      const line = v.state.doc.lineAt(a ? a.pos : v.state.doc.length), ins = '\n' + md.replace(/^# .*\n+/, '');
      v.dispatch({ changes: { from: line.to, insert: ins }, selection: { anchor: line.to + ins.length } });
      where = n.name;
    } else {
      const b = inkBox(ids), first = md.split('\n')[0].replace(/^[#\-\s]+|TODO\s+/g, '').split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^\w-]/g, '') || 'note';
      let name = first, i = 2; while (findPage(name)) name = `${first}-${i++}`;
      const n = addNode({ kind: 'buffer', name, x: Math.round(b.x0), y: Math.round(b.y0), w: Math.max(360, Math.round(b.x1 - b.x0)), h: Math.max(220, Math.round(b.y1 - b.y0)),
        text: md.startsWith('# ') ? md + '\n' : `# ${name}\n\n${md}\n` });
      where = pathOf(n.id);
    }
    S.strokes = S.strokes.filter(s => !ids.includes(s.id));
    new Set(strokes.map(s => s.owner)).forEach(o => renderInk(o || null));
    INK.ids = []; placeInkChip(); dirty(); scheduleCrossRefresh();
    toast(`Handwriting → text in ${where}`);
  } catch (e) {
    toast(e?.code === 'not_granted' ? 'Allow this page to use Claude (with images), then try again.' : `Could not read the handwriting (${e?.code || e?.message || 'error'}).`, 6000);
  } finally { chip.classList.remove('busy'); }
}
async function inkAsk() {
  const ids = [...INK.ids]; if (!ids.length) return;
  if (!(await canSeeImages())) return;
  const img = await inkImage(ids);
  toggleSide(true, true);
  const ta = live.chat.ta, typed = ta.value.trim(); ta.value = '';
  agentSend(S.chat, { text: typed || '✎ (handwritten note)', images: [img], note: '[The user wrote this by hand on the canvas; the handwriting is attached as an image. Read it and respond to it.]' });
  INK.ids = []; placeInkChip();
}
$('#ink-text').onclick = inkToText;
if ($('#ink-ask')) $('#ink-ask').onclick = inkAsk;
$('#ed-mic').onclick = () => dictateInto('editor');
$('#ink-x').onclick = () => { INK.ids = []; placeInkChip(); };

// ------------------------------------------------------------------ voice: the browser's speech recognition
// Hold 🎙 in an agent or the assistant to talk, release to send; tap it to dictate into the box without sending.
// 🎙 on a page (or Alt-V) dictates at the cursor. Saying "new line" or "new bullet" breaks the line.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE_BLOCKED = 'The microphone is not available here. On claude.ai the artifact runs in a sandboxed frame without microphone access. Use the self-hosted Workbench in Chrome, Edge or Safari, or your system dictation into any text box (macOS: press Fn twice; Windows: Win+H).';
const VOICE = { rec: null, target: null };
function spoken(t) { return t.replace(/\s*\bnew bullet\b\s*/gi, '\n- ').replace(/\s*\bnew (line|paragraph)\b\s*/gi, '\n'); }
function listen({ onUpdate, onEnd, label }) {
  if (!SR) { toast('This browser has no speech recognition. ' + VOICE_BLOCKED, 9000); onEnd?.('', 'unsupported'); return false; }
  stopListening();
  const r = new SR(); r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = true;
  let fin = '', failed = null;
  r.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t; else interim += t; }
    onUpdate?.(fin, interim);
    const st = $('#st-buf-text'); st.textContent = '🎙 ' + (fin + interim).slice(-90); st.classList.add('live');
  };
  r.onerror = e => { failed = e.error; };
  r.onend = () => {
    if (VOICE.rec === r) VOICE.rec = null;
    document.body.classList.remove('listening'); $$('.mic.on').forEach(b => b.classList.remove('on'));
    if (failed && !['no-speech', 'aborted'].includes(failed)) toast(['not-allowed', 'service-not-allowed', 'audio-capture'].includes(failed) ? VOICE_BLOCKED : `Speech recognition stopped (${failed}).`, 9000);
    onEnd?.(fin.trim(), failed);
  };
  let heard = false; r.onaudiostart = () => { heard = true; };
  // Some sandboxed frames never start audio and never report an error: give up after a few seconds and say why.
  setTimeout(() => { if (!heard && VOICE.rec === r) { failed = 'audio-capture'; try { r.abort(); } catch {} } }, 4500);
  try { r.start(); } catch { toast(VOICE_BLOCKED, 9000); onEnd?.('', 'start'); return false; }
  VOICE.rec = r; document.body.classList.add('listening');
  $('#st-buf-text').textContent = '🎙 listening' + (label ? ' for ' + label : '') + '…';
  return true;
}
function stopListening() { const r = VOICE.rec; VOICE.rec = null; try { r?.stop(); } catch {} }
function wireMic(btn, n) {
  let t0 = 0, held = false;
  btn.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return; ev.preventDefault();
    if (VOICE.rec && VOICE.target === btn) { stopListening(); return; }
    t0 = performance.now(); held = true;
    const L = live[n.id], base = L.ta.value ? L.ta.value.replace(/\s*$/, ' ') : '';
    VOICE.target = btn; btn.classList.add('on');
    listen({ label: n.id === 'chat' ? 'the assistant' : n.name,
      onUpdate: (fin, interim) => { L.ta.value = base + spoken(fin + interim); },
      onEnd: (fin, failed) => { L.ta.value = base + spoken(fin); if (btn.dataset.send === '1' && fin && !failed) agentSend(n); btn.dataset.send = ''; } });
  });
  const release = () => {
    if (!held) return; held = false;
    if (performance.now() - t0 > 400) { btn.dataset.send = '1'; stopListening(); }  // held: release sends; tapped: keep dictating until tapped again
  };
  btn.addEventListener('pointerup', release); btn.addEventListener('pointerleave', release); btn.addEventListener('pointercancel', release);
}
function dictateInto(n) {
  const v = n === 'editor' ? ED.view : live[n.id]?.view; if (!v) return;
  if (VOICE.rec && VOICE.target === v) { stopListening(); return; }
  let done = 0;
  VOICE.target = v;
  const btn = n === 'editor' ? null : $$('.hb', live[n.id].hdr).find(b => b.textContent === '🎙'); btn?.classList.add('mic', 'on');
  v.focus();
  listen({ label: n === 'editor' ? ED.node?.name : n.name,
    onUpdate: fin => {
      const add = fin.slice(done); if (!add.trim()) return;
      done = fin.length;
      const head = v.state.selection.main.head, prev = v.state.sliceDoc(Math.max(0, head - 1), head);
      const text = spoken((prev && !/\s/.test(prev) ? ' ' : '') + add.trim());
      v.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length }, scrollIntoView: true });
    },
    onEnd: () => { VOICE.target = null; } });
}

// ------------------------------------------------------------------ navigator: ranger-style Miller columns over folders and files
// Workspace folders and items, plus "~ files" (the real file system with canvasd, the simulated one otherwise).
// Keys follow ranger: h j k l, gg G, / filter, space mark, dd cut, pp paste, yp copy path, r rename, S shell here.
const RG = { dir: 'root', sel: {}, filter: '', marks: new Set(), clip: null, seq: '', fs: {}, home: null, bm: {} };
const FS_PREFIX = 'fs:';
const rgHome = () => RG.home || (DAEMON ? '~' : '/home/me');
const isFs = k => k.startsWith(FS_PREFIX);
function rgEntryOf(n) { return { key: n.id, name: n.name, kind: n.kind, dir: n.kind === 'frame', n }; }
function rgSort(list) { return list.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })); }
function rgEntries(key) {
  if (key === 'root') {
    const roots = Object.values(S.nodes).filter(n => !n.in || !S.nodes[n.in]).map(rgEntryOf);
    return [...rgSort(roots), { key: FS_PREFIX + rgHome(), name: '~ files', kind: 'fsdir', dir: true, fsroot: true },
      ...(DAEMON ? allHosts().map(h => ({ key: FS_PREFIX + '@' + h.name + ':~', name: '@' + h.name + ' files', kind: 'fsdir', dir: true, fsroot: true, host: h })) : []),
      ...rgPerspRoots()];
  }
  if (isFs(key)) return rgFsList(key.slice(FS_PREFIX.length));
  if (/^(tag|note|journal|link|proc|tmux|unit|attn):/.test(key)) return rgRelList(key);
  return S.nodes[key] ? rgSort(kidsOf(key).map(rgEntryOf)) : [];
}
function rgFsList(path) {
  if (!DAEMON) {
    const d = fsGet(fsResolve('/', path.replace(/^~/, '/home/me'))); if (!d || d.t !== 'd') return [];
    const p = path.replace(/^~/, '/home/me').replace(/\/$/, '');
    return rgSort(Object.keys(d.c).map(k => ({ key: FS_PREFIX + (p || '') + '/' + k, name: k, kind: d.c[k].t === 'd' ? 'fsdir' : 'file', dir: d.c[k].t === 'd', size: d.c[k].t === 'f' ? d.c[k].d?.length : undefined, link: d.c[k].t === 'l' ? d.c[k].d : undefined, meta: d.c[k].mount ? 'mount' : d.c[k].ino && fsNlink(d.c[k].ino) > 1 ? 'hardlink ×' + fsNlink(d.c[k].ino) : undefined })));
  }
  const c = RG.fs[path];
  if (c === undefined) {
    RG.fs[path] = null;
    const { h, p: rel } = fsSplit(path), pre = h ? '@' + h.name + ':' : '';
    hFetch(h, '/api/ls?path=' + encodeURIComponent(rel)).then(r => r.ok ? r.json() : Promise.reject(r.status)).then(j => {
      if (rel === '~' && !h && !RG.home) RG.home = j.path;
      RG.fs[path] = j.entries.map(e => ({ key: FS_PREFIX + pre + j.path.replace(/\/$/, '') + '/' + e.name, name: e.name, kind: e.dir ? 'fsdir' : 'file', dir: e.dir, size: e.size, mtime: e.mtime, link: e.link, host: h, meta: e.mount ? 'mount' : e.nlink > 1 ? 'hardlink ×' + e.nlink : e.link ? '→ ' + e.link : undefined, ino: e.ino, dev: e.dev, nlink: e.nlink, mount: e.mount }));
      if (rel === '~') { RG.fs[pre + j.path] = RG.fs[path]; if (RG.dir === FS_PREFIX + pre + '~') RG.dir = FS_PREFIX + pre + j.path; }
      renderRanger();
    }).catch(() => { RG.fs[path] = []; renderRanger(); });
  }
  return RG.fs[path] || [];
}
function rgParent(key) {
  if (key === 'root') return null;
  if (/^(tag|note|journal|link|proc|tmux|unit|attn):/.test(key)) return rgRelParent(key);
  if (isFs(key)) { const raw = key.slice(FS_PREFIX.length), m = raw.match(/^(@[^:]+:)?([\s\S]*)$/), pre = m[1] || '', p = m[2]; if (p === '/' || p === '~' || p === rgHome() && !DAEMON) return 'root'; const up = p.replace(/\/[^/]+\/?$/, '') || '/'; return FS_PREFIX + pre + up; }
  const n = S.nodes[key]; return n?.in && S.nodes[n.in] ? n.in : 'root';
}
function rgLabel(key) {
  if (key === 'root') return 'workspace';
  if (/^(tag|note|journal|link|proc|tmux|unit|attn):/.test(key)) return keyToAddr(key);
  if (isFs(key)) return keyToAddr(key);
  return S.nodes[key] ? fullPath(S.nodes[key]) : '?';
}
const rgList = () => { const all = rgEntries(RG.dir), f = RG.filter.toLowerCase(); return f ? all.filter(e => fuzzy(f, e.name)) : all; };
function rgCur() { const l = rgList(); const i = clamp(RG.sel[RG.dir] ?? 0, 0, Math.max(0, l.length - 1)); RG.sel[RG.dir] = i; return { list: l, i, e: l[i] }; }
const RG_GLYPH = { frame: '▸', fsdir: '▸', file: '·', buffer: '¶', term: '$', repl: '›', agent: '✦', acp: '✦', ref: '❝', artifact: '◧', persp: '⊳', itag: '#', inote: '¶', iblock: '§', ijournal: '▸', ghost: '◌', itmux: '⌗', itmuxw: '▭', iproc: '⚙', iunit: '⊙', iattn: '!' };
function rgRow(e, on, cur) {
  const r = el('div', 'rg-row' + (on ? ' on' : '') + (e.dir ? ' dir' : '') + (RG.marks.has(e.key) ? ' marked' : '') + (RG.clip?.keys.includes(e.key) ? ' cut' : '') + (e.n && stashed(e.n) ? ' dim' : ''));
  r.innerHTML = '<span class="g"></span><span class="nm"></span><span class="mt"></span>';
  $('.g', r).textContent = e.n?.kind === 'frame' ? FICON[e.n.mode || 'free'] : RG_GLYPH[e.kind] || '·';
  $('.nm', r).textContent = e.name;
  $('.mt', r).textContent = e.n?.kind === 'frame' ? String(kidsOf(e.key).length) : e.n ? badgeOf(e.n) : e.meta != null ? e.meta : e.dir ? '' : e.size != null ? fmtSize(e.size) : '';
  if (e.unit?.u.active === 'failed' || e.attn === 'bad') r.classList.add('bad');
  r.dataset.key = e.key;
  return r;
}
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' K' : (b / 1048576).toFixed(1) + ' M';
function rgBacklinks(box, title) {
  const bl = backlinksOfTitle(title); if (!bl.length) return;
  const h = el('div', 'rg-meta', '← ' + bl.length + ' backlink' + (bl.length === 1 ? '' : 's')); box.append(h);
  for (const b of bl.slice(0, 40)) { const r = el('div', 'rg-row rg-bl'); r.innerHTML = '<span class="rg-nm"></span><span class="rg-meta2"></span>'; $('.rg-nm', r).textContent = b.title + ':' + b.line; $('.rg-meta2', r).textContent = b.text.slice(0, 80); r.onclick = () => b.page ? edOpen(b.page, lineFrom(b.page, b.line)) : b.note ? noteOpen({ ...b.note, line: b.line }) : null; box.append(r); }
}
const lineFrom = (n, line) => { const v = live[n.id]?.view; if (!v) return undefined; const doc = v.state.doc; return doc.line(clamp(line, 1, doc.lines)).from; };
function rgPreview(e) {
  const box = $('#rg-prev'); box.replaceChildren();
  if (!e) return;
  if (e.dir) { const l = rgEntries(e.key); box.append(...l.slice(0, 200).map(x => rgRow(x, false))); if (!l.length) box.append(el('div', 'rg-empty', isFs(e.key) && DAEMON && RG.fs[e.key.slice(3)] === null ? 'loading…' : e.reserved ? e.reserved : 'empty')); return; }
  const pre = el('pre', 'rg-text');
  if (e.note) { const meta = el('div', 'rg-meta'); meta.textContent = [keyToAddr(e.key), e.note.path + (e.note.line > 1 ? ':' + e.note.line : ''), (e.note.tags || []).map(t => '#' + t).join(' ')].filter(Boolean).join(' · '); pre.textContent = e.note.body || '(empty)'; box.append(meta, pre); if (e.note.kind === 'file') rgBacklinks(box, e.note.title); return; }
  if (e.link) { const meta = el('div', 'rg-meta'); meta.textContent = keyToAddr(e.key) + (e.link.page ? ' · board page' : e.link.note ? ' · ' + e.link.note.path : ' · no page yet'); pre.textContent = e.link.page ? pageText(e.link.page).slice(0, 1200) : e.link.note ? (e.link.note.body || '(empty)') : 'Enter creates the page.'; box.append(meta, pre); rgBacklinks(box, e.link.title); return; }
  if (e.reserved) { pre.textContent = e.reserved; box.append(pre); return; }
  if (e.proc) { const p = e.proc, meta = el('div', 'rg-meta'); meta.textContent = [keyToAddr(e.key), p.state, p.unit ? 'unit ' + p.unit : '', p.rss ? fmtSize(p.rss) : ''].filter(Boolean).join(' · '); pre.textContent = [p.cmd || p.comm, p.cwd ? 'cwd ' + p.cwd : '', p.start ? 'started ' + new Date(p.start * 1000).toLocaleString() : '', 'pid ' + p.pid + ' · parent ' + p.ppid, e.kids ? e.kids + ' child process' + (e.kids === 1 ? '' : 'es') : ''].filter(Boolean).join('\n'); box.append(meta, pre); return; }
  if (e.unit) { const k = 'unitst:' + e.key; if (RG.fs[k] === undefined) { RG.fs[k] = null; unitShow(e.unit.h, e.unit.name).then(j => { RG.fs[k] = j.status || j.error || ''; setTimeout(() => { delete RG.fs[k]; }, 10000); if (rgCur().e?.key === e.key) rgPreview(e); }).catch(() => { RG.fs[k] = '(cannot read)'; }); }
    const meta = el('div', 'rg-meta'); meta.textContent = [keyToAddr(e.key), e.unit.u.active + '/' + e.unit.u.sub, e.unit.u.description].filter(Boolean).join(' · '); pre.textContent = RG.fs[k] ?? 'loading…'; box.append(meta, pre); return; }
  if (e.tmux) { const k = 'tmuxcap:' + e.key; if (RG.fs[k] === undefined) { RG.fs[k] = null; hFetch(e.tmux.h, '/api/tmux/capture?lines=60&target=' + encodeURIComponent(e.tmux.target)).then(r => r.json()).then(j => { RG.fs[k] = j.text || j.error || ''; setTimeout(() => { delete RG.fs[k]; }, 4000); if (rgCur().e?.key === e.key) rgPreview(e); }).catch(() => { RG.fs[k] = '(cannot read)'; }); }
    const meta = el('div', 'rg-meta'); meta.textContent = [keyToAddr(e.key), e.meta].filter(Boolean).join(' · '); pre.textContent = RG.fs[k] ?? 'loading…'; box.append(meta, pre); return; }
  if (e.n) {
    const n = e.n, L = live[n.id];
    if (n.kind === 'buffer') pre.textContent = pageText(n);
    else if (L?.term) pre.textContent = termLines(L, 60).join('\n');
    else if (n.kind === 'acp') pre.textContent = L?.backend?.text(60) || '';
    else if (n.kind === 'agent') pre.textContent = (n.log || []).filter(m => m.text).slice(-12).map(m => (m.t === 'user' ? '› ' : m.t === 'tool' ? '⚙ ' : '') + (m.text || m.name)).join('\n\n');
    else pre.textContent = n.text || '';
    const meta = el('div', 'rg-meta'); meta.textContent = [badgeOf(n), folderPath(n) ? 'in ' + folderPath(n) + '/' : 'loose on the canvas', n.cwd && n.kind === 'term' ? 'cwd ' + n.cwd : ''].filter(Boolean).join(' · ');
    box.append(meta, pre); return;
  }
  const path = e.key.slice(FS_PREFIX.length);
  if (!DAEMON) { const f = fsGet(path); pre.textContent = f?.t === 'f' ? f.d : ''; box.append(pre); return; }
  const k = 'cat:' + path;
  if (RG.fs[k] === undefined) { RG.fs[k] = null; const fp = fsSplit(path); hFetch(fp.h, '/api/cat?path=' + encodeURIComponent(fp.p)).then(r => r.json()).then(j => { RG.fs[k] = j.text; if (rgCur().e?.key === e.key) rgPreview(e); }).catch(() => { RG.fs[k] = '(cannot read)'; }); }
  pre.textContent = RG.fs[k] ?? 'loading…'; box.append(pre);
}
function renderRanger() {
  if (VIEW !== 'ranger' || !S) return;
  const { list, i, e } = rgCur(), par = rgParent(RG.dir);
  const pc = $('#rg-parent'); pc.replaceChildren();
  if (par) { const pl = rgEntries(par); pc.append(...pl.map(x => rgRow(x, x.key === RG.dir))); }
  const cc = $('#rg-cur'); cc.replaceChildren(...list.map((x, j) => rgRow(x, j === i, true)));
  if (!list.length) cc.append(el('div', 'rg-empty', RG.filter ? 'no match for “' + RG.filter + '”' : 'empty'));
  cc.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); pc.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  rgPreview(e);
  $('#rg-path').textContent = rgLabel(RG.dir) + (e ? (RG.dir === 'root' ? ' › ' : '/') + e.name : '');
  const info = [];
  if (e?.n?.kind === 'frame') info.push(`folder · ${e.n.mode || 'free'} · ${e.n.shape || 'folder'}`); else if (e?.n) info.push(badgeOf(e.n)); else if (e) info.push(e.dir ? 'directory' : 'file' + (e.size != null ? ' · ' + fmtSize(e.size) : ''));
  if (e?.n && tagsOf(e.n).length) info.push(tagsOf(e.n).map(t => '#' + t).join(' '));
  info.push(`${list.length ? i + 1 : 0}/${list.length}`);
  if (RG.marks.size) info.push(`${RG.marks.size} marked`);
  if (RG.clip) info.push(`${RG.clip.keys.length} cut — pp pastes`);
  if (RG.filtering || RG.filter) info.push(`filter: ${RG.filter}${RG.filtering ? '▏' : ''}`);
  if (RG.seq) info.push(RG.seq + '…');
  $('#rg-info').textContent = info.join('   ');
}
function rgGo(key, selKey) {
  RG.dir = key; RG.filter = ''; RG.filtering = false;
  if (selKey) { const j = rgEntries(key).findIndex(x => x.key === selKey); if (j >= 0) RG.sel[key] = j; }
  renderRanger();
}
function rgOpen(e, canvas) {
  if (!e) return;
  if (e.dir && !canvas) return rgGo(e.key);
  if (e.n?.kind === 'frame') return jumpFolder(e.n);
  if (e.n) return e.n.kind === 'buffer' && !canvas ? edOpen(e.n) : jumpNode(e.n);
  if (e.note) return noteOpen(e.note);
  if (e.tmux) return tmuxAdopt(e.tmux.target, e.tmux.h);
  if (e.go) return e.go();
  if (e.proc) return toast(e.proc.cmd || e.proc.comm);
  if (e.reserved) return toast(e.reserved);
  toast('Files show in the preview. S opens a shell in this directory.');
}
const rgTargets = () => { const { e } = rgCur(); return RG.marks.size ? [...RG.marks] : e ? [e.key] : []; };
function rgShellHere() {
  const { e } = rgCur(), fsh = isFs(RG.dir) ? fsSplit(RG.dir.slice(3)) : null, fsDir = fsh ? fsh.p : null, folder = !isFs(RG.dir) && RG.dir !== 'root' ? S.nodes[RG.dir] : null;
  setView('canvas');
  const c = viewCenterWorld(), w = 560, h = 320, hf = fsh?.h ? hostFolder(fsh.h) : null;
  const n = addNode({ kind: 'term', backend: DAEMON ? 'pty' : 'fake', shell: shellDefault(), name: 'sh' + (nodeList().filter(m => m.kind === 'term').length + 1), env: {}, ...freeSpot(c.x - w / 2, c.y - h / 2, w, h), w, h,
    cwd: fsDir ? fsDir.replace(/^~/, DAEMON ? '~' : '/home/me') : DAEMON ? undefined : '/home/me', in: folder ? folder.id : hf ? hf.id : undefined });
  if (hf) adopt(n, hf, null, true);
  jumpNode(n, 1, () => live[n.id]?.term?.focus());
}
function rgKey(e) {
  const k = e.key, { list, i, e: cur } = rgCur();
  if (RG.filtering) {
    if (k === 'Escape') { RG.filter = ''; RG.filtering = false; }
    else if (k === 'Enter') RG.filtering = false;
    else if (k === 'Backspace') RG.filter = RG.filter.slice(0, -1);
    else if (k.length === 1) { RG.filter += k; RG.sel[RG.dir] = 0; }
    else return false;
    renderRanger(); return true;
  }
  const seq = RG.seq + k; RG.seq = '';
  const sel = j => { RG.sel[RG.dir] = clamp(j, 0, Math.max(0, list.length - 1)); renderRanger(); };
  const half = Math.max(1, Math.floor(($('#rg-cur').clientHeight / 30) / 2));
  if (seq === 'gg') return sel(0), true;
  if (seq === 'gh') return rgGo(FS_PREFIX + rgHome()), true;
  if (seq === 'gw' || seq === 'gr') return rgGo('root'), true;
  if (seq === 'ga') return askName('Address (board:/path · fs:@host/dir · note:Title#Heading · tag:x · journal:2026/10/10 · link:Page)', keyToAddr(RG.dir), v => goAddr(v)), true;
  if (seq === 'dd') { const keys = rgTargets().filter(x => !isFs(x) && S.nodes[x]); if (keys.length) { RG.clip = { keys }; RG.marks.clear(); toast(`${keys.length} item(s) cut. Go to a folder and press pp.`); } return renderRanger(), true; }
  if (seq === 'pp') {
    if (!RG.clip) return toast('Nothing cut. Mark with space, then dd.'), true;
    if (isFs(RG.dir)) return toast('Workspace items go into folders, not file directories.'), true;
    const t = RG.dir === 'root' ? null : S.nodes[RG.dir];
    for (const key of RG.clip.keys) { const n = S.nodes[key]; if (n && n !== t) adopt(n, t, null, true); }
    toast(`Moved ${RG.clip.keys.length} item(s) to ${t ? fullPath(t) + '/' : 'the canvas'}`); RG.clip = null; return renderRanger(), true;
  }
  if (seq === 'yp') { if (cur) copyText(cur.n ? (cur.n.kind === 'frame' ? fullPath(cur.n) + '/' : pathOf(cur.n.id)) : cur.key.slice(3)); return true; }
  if (seq === 'DD') { const keys = rgTargets().filter(x => S.nodes[x]); keys.forEach(removeNode); RG.marks.clear(); toast(`Deleted ${keys.length} item(s)`); return renderRanger(), true; }
  if (seq[0] === 'm' && seq.length === 2) { RG.bm[seq[1]] = RG.dir; S.rgBookmarks = RG.bm; dirty(); toast(`Bookmark ${seq[1]} → ${rgLabel(RG.dir)}`); return true; }
  if (seq[0] === "'" && seq.length === 2) { const d = RG.bm[seq[1]]; if (d) rgGo(d); else toast('No bookmark ' + seq[1]); return true; }
  if (seq === ']d') return journalStep(1), true;
  if (seq === '[d') return journalStep(-1), true;
  if (['g', 'd', 'p', 'y', 'D', 'm', "'", ']', '['].includes(k) && seq.length === 1) { RG.seq = k; renderRanger(); return true; }
  switch (k) {
    case 'j': case 'ArrowDown': return sel(i + 1), true;
    case 'k': case 'ArrowUp': return sel(i - 1), true;
    case 'G': case 'End': return sel(list.length - 1), true;
    case 'Home': return sel(0), true;
    case 'PageDown': return sel(i + half * 2), true;
    case 'PageUp': return sel(i - half * 2), true;
    case 'h': case 'ArrowLeft': case 'Backspace': { const p = rgParent(RG.dir); if (p) rgGo(p, RG.dir); return true; }
    case 'l': case 'ArrowRight': case 'Enter': rgOpen(cur); return true;
    case 'o': rgOpen(cur, true); return true;
    case 'e': if (cur?.n?.kind === 'buffer') edOpen(cur.n); return true;
    case '/': RG.filtering = true; RG.filter = ''; renderRanger(); return true;
    case ' ': if (cur) { RG.marks.has(cur.key) ? RG.marks.delete(cur.key) : RG.marks.add(cur.key); } return sel(i + 1), true;
    case 'v': list.forEach(x => (RG.marks.has(x.key) ? RG.marks.delete(x.key) : RG.marks.add(x.key))); return renderRanger(), true;
    case 'Escape': RG.marks.clear(); RG.clip = null; RG.filter = ''; return renderRanger(), true;
    case 'r': if (cur?.n) askName('Rename ' + cur.n.name, cur.n.name, v => { cur.n.name = clean(v); cur.n.kind === 'frame' ? placeFrame(cur.n) : updateAllTitles(); renderTree(); renderRanger(); dirty(); }); return true;
    case '+': if (!isFs(RG.dir)) askName('New folder name', '', v => { const par = RG.dir === 'root' ? null : S.nodes[RG.dir]; const c = viewCenterWorld(); const f = addNode({ kind: 'frame', name: clean(v), ...freeSpot(c.x - 300, c.y - 160, 600, 320), w: 600, h: 320, mode: 'free', shape: 'folder', in: undefined }); if (par) adopt(f, par, null, true); setView('ranger'); rgGo(RG.dir, f.id); }); return true;
    case 'n': if (!isFs(RG.dir)) askName('New page name', '', v => { const par = RG.dir === 'root' ? null : S.nodes[RG.dir]; const p = openPage(v, null, true); if (par && p.in !== par.id) adopt(p, par, null, true); setView('ranger'); rgGo(RG.dir, p.id); }); return true;
    case 'S': rgShellHere(); return true;
    case '1': case '2': case '3': case '4': case '5': if (cur?.n?.kind === 'frame') { setMode(cur.n, ['free', 'pack', 'tile', 'stack'][+k - 1] || 'tile'); renderRanger(); } return true;
    case 'f': if (cur?.n) { cur.n.kind === 'frame' ? wsEnter(cur.n) : focusOpen(cur.n); } return true;
    case '?': $('#help').hidden = false; return true;
  }
  return false;
}
$('#rg-cur').addEventListener('click', e => { const r = e.target.closest('.rg-row'); if (!r) return; const j = rgList().findIndex(x => x.key === r.dataset.key); if (j >= 0) { RG.sel[RG.dir] = j; renderRanger(); } });
$('#rg-cur').addEventListener('dblclick', e => { const r = e.target.closest('.rg-row'); if (r) rgOpen(rgCur().e); });
$('#rg-parent').addEventListener('click', e => { const r = e.target.closest('.rg-row'); if (!r) return; const p = rgParent(RG.dir); if (p) rgGo(p, r.dataset.key); });
$('#rg-prev').addEventListener('click', e => { const r = e.target.closest('.rg-row'); const cur = rgCur().e; if (r && cur?.dir) rgGo(cur.key, r.dataset.key); });

// ------------------------------------------------------------------ docked terminal: a shell in the side pane instead of the assistant
function sideTab(which) {
  which = 'term'; S.sideTab = which; dirty();
  $$('.side-tabs button').forEach(b => b.classList.toggle('on', b.dataset.side === which));
  { const sc = $('#side-chat'); if (sc) sc.hidden = true; } $('#side-term').hidden = false;
  if (which === 'term') {
    if (!S.dockTerm) { S.dockTerm = { id: 'dock', kind: 'term', name: 'dock', backend: DAEMON ? 'pty' : 'fake', cwd: DAEMON ? undefined : '/home/me', env: {}, _spawn: BOOTED }; if (shellDefault()) S.dockTerm.shell = shellDefault(); dirty(); }
    if (!live.dock) { live.dock = { el: $('#side-term'), body: $('#side-term-body'), hdr: null }; mountTerm(S.dockTerm, live.dock); }
    setTimeout(() => { live.dock.term?.focus(); live.dock.fitNow?.(); }, 60);
  }
}
function toggleDockTerm() {
  const open = document.body.classList.contains('side-open');
  if (open && S.sideTab === 'term') toggleSide(false); else { toggleSide(true, true); sideTab('term'); }
}
$$('.side-tabs button').forEach(b => b.onclick = () => sideTab(b.dataset.side));

// ------------------------------------------------------------------ chrome: docks, theme, vim
function toggleDock(which, open) {
  const d = $('#dock-' + which); open = open ?? d.hidden; d.hidden = !open;
  $('#toggle-' + which).classList.toggle('on', open);
  S.docks = { ...(S.docks || {}), [which]: open }; dirty();
  if (which === 'draw' && !open && tool !== 'select') setTool('select');
}
$('#toggle-draw').onclick = () => toggleDock('draw');
$('#toggle-new').onclick = () => toggleDock('new');
$('#view-name').onclick = () => openPalette('>view ');
function setTheme(t) {
  setTimeout(() => { for (const n of nodeList()) if (n.kind === 'artifact' && live[n.id]?.frame) artMount(n, live[n.id]); }, 0);
  S.theme = t; dirty();
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  requestAnimationFrame(() => {
    for (const id in live) if (live[id].term) live[id].term.options.theme = termTheme();
    graphColors?.(); if (VIEW === 'graph') graphDraw(); renderLinks();
  });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!S?.theme || S.theme === 'auto') setTheme('auto'); });
const vimComp = new V.Compartment();
const vimExt = status => (S?.vim ?? true) ? V.vim({ status }) : [];
function setVim(on) {
  S.vim = on; dirty();
  for (const id in live) live[id].view?.dispatch({ effects: vimComp.reconfigure(vimExt(false)) });
  ED.view?.dispatch({ effects: vimComp.reconfigure(vimExt(true)) });
  toast(on ? 'Vim keys on in pages (Esc for normal mode, i to insert)' : 'Vim keys off in pages');
}
// [[ completes to any page, folder, shell, REPL or agent: notes link to anything (zettelkasten).
function wikiComplete(ctx) {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/); if (!m) return null;
  const opts = [...nodeList().map(n => ({ label: n.name, detail: n.kind === 'buffer' ? 'page' : badgeOf(n), type: n.kind === 'buffer' ? 'text' : 'variable' })),
    ...frameList().map(f => ({ label: f.name, detail: 'folder', type: 'namespace' }))];
  const seen = new Set();
  const apply = (view, c, from, to) => { const close = view.state.sliceDoc(to, to + 2) === ']]', ins = c.label + (close ? '' : ']]'); view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length + (close ? 2 : 0) } }); };
  return { from: m.from + 2, options: opts.filter(o => !seen.has(o.label) && seen.add(o.label)).map(o => ({ ...o, apply })), validFor: /^[^\]\n]*$/ };
}
const wikiCompletion = V.EditorState.languageData.of(() => [{ autocomplete: wikiComplete }]);

// ------------------------------------------------------------------ views: one board, several ways to look at it
// Every view reads and writes the same S (nodes, edges, shapes) and the same CodeMirror documents,
// so switching never copies or forks data. The canvas stays mounted underneath the other views.
let VIEW = 'canvas';
const VIEWS = ['canvas', 'ranger', 'graph', 'editor', 'outline', 'tasks', 'review'];
const VIEW_NAMES = { canvas: 'Canvas', ranger: 'Navigator', graph: 'Graph', editor: 'Editor', outline: 'Outline', tasks: 'Tasks', review: 'Review' };
const pages = () => nodeList().filter(n => n.kind === 'buffer');
const pageText = n => live[n.id]?.view ? live[n.id].view.state.doc.toString() : (n.text || '');
const isJournal = n => /^\d{4}-\d\d-\d\d$/.test(n.name);
function sortPages(list) { return list.sort((a, b) => (isJournal(b) - isJournal(a)) || (isJournal(a) ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name))); }
function setView(v) {
  if (!VIEWS.includes(v)) return;
  const prev = VIEW; VIEW = v;
  if (S && S.view !== v) { S.view = v; dirty(); }
  document.body.dataset.view = v;
  $$('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-selected', b.dataset.view === v); });
  $$('.view').forEach(p => { p.hidden = p.id !== 'v-' + v; });
  if (prev === 'graph' && v !== 'graph') graphStop();
  if (v === 'graph') graphStart();
  if (v === 'editor') edEnsure();
  if (v === 'outline') renderOutline();
  if (v === 'tasks') renderTasks();
  if (v === 'ranger') renderRanger();
  if (v === 'review') renderReview();
  $('#view-name').textContent = VIEW_NAMES[v];
  if (S) placeInkChip();
  if (v !== 'canvas') { if (tool !== 'select') setTool('select'); $('#st-addr').textContent = VIEW_NAMES[v]; $('#st-zoom').textContent = ''; }
  else { $('#st-zoom').textContent = Math.round(cam().z * 100) + '%'; $('#st-addr').textContent = '–'; }
  updateSideCtx();
}
$$('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
// Pages changed somewhere: refresh whichever non-canvas view is showing.
function refreshViews() {
  if (VIEW === 'editor') edInfo();
  else if (VIEW === 'outline') renderOutline();
  else if (VIEW === 'tasks') renderTasks();
  else if (VIEW === 'graph') graphRebuild();
  else if (VIEW === 'ranger') renderRanger();
}

// ------------------------------------------------------------------ editor view: one page as a full text editor
// The editor holds its own EditorView. Edits are mirrored, as ChangeSets, into the page's canvas editor
// (and back), so anchors, ink and backlinks on the canvas follow edits made here.
const ED = { node: null, view: null };
let mirroring = false;
function mirrorTo(target, u, src) {
  if (mirroring || !target) return;
  mirroring = true;
  try { for (const tr of u.transactions) if (tr.docChanged) target.dispatch({ changes: tr.changes }); }
  catch { target.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: src.state.doc.toString() } }); }
  finally { mirroring = false; }
}
const edTheme = V.EditorView.theme({
  '&': { fontSize: '14px' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  '.cm-content': { maxWidth: '72ch', margin: '0 auto', padding: '28px 24px 40vh' },
  '.cm-gutters': { display: 'none' },
});
function edEnsure() {
  const n = (ED.node && S.nodes[ED.node.id]) ? ED.node : (S.nodes[S.edPage] || findPage(TODAY) || sortPages(pages())[0]);
  if (n) edLoad(n); else renderEdList();
}
function edOpen(n, pos) {
  if (!n || n.kind !== 'buffer') return;
  ED.next = n;
  if (VIEW !== 'editor') setView('editor');
  edLoad(n, pos);
}
function edLoad(n, pos) {
  ED.next = null;
  if (ED.node !== n || !ED.view || !S.nodes[n.id]) {
    ED.view?.destroy();
    ED.node = n; S.edPage = n.id; dirty();
    const state = V.EditorState.create({
      doc: pageText(n),
      extensions: [
        vimComp.of(vimExt(true)), edTheme, V.basicSetup, V.markdown(), wikiCompletion, V.EditorView.lineWrapping, bufTheme, V.syntaxHighlighting(bufHighlight), linkField, outlineKeys,
        V.EditorView.updateListener.of(u => {
          if (u.docChanged) mirrorTo(live[n.id]?.view, u, u.view);
          if (u.docChanged || u.selectionSet) edStatus();
        }),
        V.EditorView.domEventHandlers({
          mousedown: e => {
            const link = e.target.closest('.cm-wikilink');
            if (link && !e.shiftKey) { e.preventDefault(); const t = openPage(link.dataset.page, n, true); t.kind === 'buffer' ? edOpen(t) : t.kind === 'frame' ? jumpFolder(t) : jumpNode(t); return true; }
            const tear = e.target.closest('.cm-tear');
            if (tear) { e.preventDefault(); const pos = ED.view.posAtDOM(tear); setView('canvas'); tearOutBlock(n, pos); return true; }
            const ref = e.target.closest('.blockref');
            if (ref) { e.preventDefault(); const r = resolveRef(ref.dataset.ref); if (r) edOpen(r.node, r.pos); return true; }
            return false;
          },
          focus: () => edStatus(),
        }),
      ],
    });
    ED.view = new V.EditorView({ state, parent: $('#ed-host') });
    $('#ed-host').replaceChildren(ED.view.dom);
  }
  const v = ED.view;
  if (pos != null) v.dispatch({ selection: { anchor: Math.min(pos, v.state.doc.length) }, scrollIntoView: true });
  requestAnimationFrame(() => v.focus());
  $('#ed-crumb').textContent = pathOf(n.id);
  renderEdList(); edInfo(); edStatus(); updateSideCtx();
}
function edStatus() {
  if (VIEW !== 'editor' || !ED.view) return;
  const t = $('#st-buf-text'); t.textContent = fmtAddr(bufferAddress(ED.node, ED.view.state, ED.view.state.selection.main.head)); t.classList.add('live');
  $('#st-copy').hidden = false;
}
function renderEdList() {
  const q = $('#ed-filter').value.trim().toLowerCase(), list = $('#ed-list');
  list.replaceChildren();
  for (const p of sortPages(pages())) {
    if (q && !p.name.toLowerCase().includes(q) && !pageText(p).toLowerCase().includes(q)) continue;
    const b = el('button', 'ed-item' + (p === ED.node ? ' on' : '')); b.innerHTML = '<span></span><small></small>';
    $('span', b).textContent = p.name;
    $('small', b).textContent = isJournal(p) ? 'journal' : `${pageText(p).split('\n').length} lines`;
    b.onclick = () => edOpen(p);
    list.append(b);
  }
}
$('#ed-filter').addEventListener('input', renderEdList);
$('#ed-new').onclick = () => ask('New page name', '', name => edOpen(openPage(name, ED.node, true)));
$('#ed-today').onclick = () => edOpen(openPage(TODAY, null, true));
$('#ed-canvas').onclick = () => { const n = ED.node; if (!n) return; const pos = ED.view.state.selection.main.head; setView('canvas'); jumpBuffer(n, pos); };
function headingsOf(text) {
  const out = []; let pos = 0;
  for (const line of text.split('\n')) { const m = line.match(/^(#{1,6})\s+(.*)$/); if (m) out.push({ level: m[1].length, text: m[2], pos }); pos += line.length + 1; }
  return out;
}
function backlinksOf(p) {
  const name = p.name.toLowerCase(), hits = [];
  for (const q of pages()) {
    if (q === p || !live[q.id]?.view) continue;
    const st = live[q.id].view.state;
    for (let i = 1; i <= st.doc.lines; i++) {
      const t = st.doc.line(i).text, low = t.toLowerCase();
      if (low.includes('[[' + name + ']]') || low.includes('((' + name + '#') || low.includes('((' + name + ' ›')) hits.push({ q, pos: st.doc.line(i).from, t, st });
    }
  }
  return hits;
}
let edInfoT = null;
function edInfo() {
  clearTimeout(edInfoT);
  edInfoT = setTimeout(() => {
    const n = ED.node; if (!n || !ED.view) return;
    const toc = $('#ed-toc'); toc.replaceChildren();
    for (const h of headingsOf(ED.view.state.doc.toString())) {
      const b = el('button', 'toc-h'); b.style.paddingLeft = (h.level - 1) * 12 + 6 + 'px'; b.textContent = h.text;
      b.onclick = () => { ED.view.dispatch({ selection: { anchor: h.pos }, effects: V.EditorView.scrollIntoView(h.pos, { y: 'start', yMargin: 24 }) }); ED.view.focus(); };
      toc.append(b);
    }
    if (!toc.children.length) toc.append(el('p', 'muted small', 'No headings yet. Lines that start with # show here.'));
    const hits = backlinksOf(n), bl = $('#ed-bl'); bl.replaceChildren();
    $('#ed-bl-h').textContent = `Linked references · ${hits.length}`;
    for (const h of hits.slice(0, 40)) {
      const a = el('button', 'bl'); a.innerHTML = '<b></b><span></span>';
      $('b', a).textContent = fmtAddr({ ...bufferAddress(h.q, h.st, h.pos), quote: '' });
      $('span', a).textContent = h.t.trim().replace(/^([-*+]|\d+\.)\s+/, '');
      a.onclick = () => edOpen(h.q, h.pos);
      bl.append(a);
    }
    if (!hits.length) bl.append(el('p', 'muted small', `No page links here yet. Write [[${n.name}]] in another page.`));
    const lb = $('#ed-ul'); lb.replaceChildren();
    const linked = new Set(backlinksOf(n).map(h => h.q.id)), text = ED.view.state.doc.toString().toLowerCase();
    for (const q of pages()) {
      if (q === n || linked.has(q.id) || q.name.length < 3) continue;
      const re = new RegExp('(^|[^\\w-])' + n.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])'), t = pageText(q).toLowerCase(), mm = t.match(re), i = mm ? mm.index + mm[1].length : -1;
      if (i >= 0 && !text.includes('[[' + q.name.toLowerCase() + ']]')) { const a = el('button', 'bl'); a.innerHTML = '<b></b>'; $('b', a).textContent = q.name; a.onclick = () => edOpen(q, i); lb.append(a); }
    }
    $('#ed-ul-h').hidden = !lb.children.length;
  }, 120);
}

// ------------------------------------------------------------------ graph view: pages and nodes as a link graph (Logseq-style)
const G = { N: new Map(), E: [], pos: new Map(), cam: { x: 0, y: 0, z: 1 }, alpha: 1, raf: 0, hover: null, sel: null, drag: null, colors: null };
const gCanvas = $('#g-canvas'), gctx = gCanvas.getContext('2d');
function graphData() {
  const showAll = $('#g-all').checked, ghosts = $('#g-ghost').checked, N = new Map(), E = [];
  const add = (id, label, kind, ref) => { if (!N.has(id)) N.set(id, { id, label, kind, ref, deg: 0 }); return N.get(id); };
  for (const n of nodeList()) if (n.kind === 'buffer' || showAll) add(n.id, n.kind === 'buffer' ? n.name : pathOf(n.id), n.kind, n);
  const link = (a, b, type) => {
    if (a === b || !N.has(a) || !N.has(b) || E.some(e => ((e.a === a && e.b === b) || (e.a === b && e.b === a)) && e.type === type)) return;
    E.push({ a, b, type }); N.get(a).deg++; N.get(b).deg++;
  };
  for (const p of pages()) {
    const t = pageText(p);
    for (const m of t.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
      const name = m[1].trim(), low = name.toLowerCase(), tgt = findPage(name) || nodeList().find(x => x.name.toLowerCase() === low);
      if (tgt) link(p.id, tgt.id, 'link');
      else if (ghosts) { add('ghost:' + low, name, 'ghost', null); link(p.id, 'ghost:' + low, 'link'); }
    }
    for (const m of t.matchAll(/\(\(([^()\n]+)\)\)/g)) { const tgt = findPage(m[1].split(/[#›]/)[0]); if (tgt) link(p.id, tgt.id, 'blockref'); }
  }
  // Folders are nodes that aggregate what they hold; nesting is a "contains" edge.
  for (const f of frameList()) add(f.id, f.name + '/', 'folder', f);
  for (const n of Object.values(S.nodes)) if (n.in && N.has(n.in)) { if (!N.has(n.id) && n.kind !== 'frame') continue; link(n.in, n.id, 'contains'); }
  for (const p of pages()) for (const m of pageText(p).matchAll(/\[\[([^\[\]\n]+)\]\]/g)) { const f = !findPage(m[1].trim()) && findFolder(m[1].trim()); if (f) link(p.id, f.id, 'link'); }
  for (const e of S.edges) link(e.from, e.to, e.type);
  for (const s of S.shapes) if (s.type === 'arrow' && s.a?.id && s.b?.id) link(s.a.id, s.b.id, 'sketch');
  return { N, E };
}
function graphRebuild() {
  const { N, E } = graphData(); G.N = N; G.E = E;
  for (const g of N.values()) {
    if (G.pos.has(g.id)) continue;
    let x, y;
    if (g.ref) { x = (g.ref.x + g.ref.w / 2 - 1300) / 5; y = (g.ref.y + g.ref.h / 2 - 500) / 5; }
    else { const e = E.find(e => e.b === g.id || e.a === g.id), o = e && G.pos.get(e.a === g.id ? e.b : e.a); x = (o?.x || 0) + (Math.random() - .5) * 80; y = (o?.y || 0) + (Math.random() - .5) * 80; }
    G.pos.set(g.id, { x, y, vx: 0, vy: 0 });
  }
  for (const id of [...G.pos.keys()]) if (!N.has(id)) G.pos.delete(id);
  if (G.sel && !N.has(G.sel)) graphSelect(null);
  G.alpha = Math.max(G.alpha, 0.5);
  graphKick();
}
function graphColors() {
  const c = n => cssVar(n);
  G.colors = { page: c('--link'), term: c('--accent'), repl: c('--pipe'), agent: c('--ref'), ref: c('--muted'), ghost: c('--muted'), buffer: c('--link'),
    link: c('--muted'), blockref: c('--ref'), folder: c('--folder-node'), contains: c('--line-strong'), spawn: c('--accent'), pipe: c('--pipe'), sketch: c('--ink-red'), fg: c('--fg'), muted: c('--muted'), bg: c('--bg'), panel: c('--panel'), accent: c('--accent') };
}
function graphTick() {
  const nodes = [...G.N.values()], P = G.pos, a = G.alpha;
  for (let i = 0; i < nodes.length; i++) {
    const p = P.get(nodes[i].id);
    for (let j = i + 1; j < nodes.length; j++) {
      const q = P.get(nodes[j].id); let dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
      const f = Math.min(4200 / d2, 6) * a, d = Math.sqrt(d2);
      p.vx += dx / d * f; p.vy += dy / d * f; q.vx -= dx / d * f; q.vy -= dy / d * f;
    }
    p.vx -= p.x * 0.004 * a; p.vy -= p.y * 0.004 * a;
  }
  for (const e of G.E) {
    const p = P.get(e.a), q = P.get(e.b), dx = q.x - p.x, dy = q.y - p.y, d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - (e.type === 'link' ? 90 : 120)) * 0.03 * a;
    p.vx += dx / d * f; p.vy += dy / d * f; q.vx -= dx / d * f; q.vy -= dy / d * f;
  }
  for (const n of nodes) {
    const p = P.get(n.id);
    if (G.drag?.id === n.id) { p.vx = p.vy = 0; continue; }
    p.vx *= 0.82; p.vy *= 0.82; p.x += clamp(p.vx, -30, 30); p.y += clamp(p.vy, -30, 30);
  }
  G.alpha = G.drag ? Math.max(G.alpha, 0.3) : G.alpha * 0.985;
}
const gRadius = g => (g.kind === 'buffer' || g.kind === 'ghost' ? 5 : 6) + Math.sqrt(g.deg) * 2.6;
function gToScreen(x, y) { const r = gCanvas.getBoundingClientRect(); return { x: (x - G.cam.x) * G.cam.z + r.width / 2, y: (y - G.cam.y) * G.cam.z + r.height / 2 }; }
function gToWorld(sx, sy) { const r = gCanvas.getBoundingClientRect(); return { x: (sx - r.width / 2) / G.cam.z + G.cam.x, y: (sy - r.height / 2) / G.cam.z + G.cam.y }; }
function graphDraw() {
  const dpr = devicePixelRatio || 1, r = gCanvas.getBoundingClientRect(), W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (gCanvas.width !== W || gCanvas.height !== H) { gCanvas.width = W; gCanvas.height = H; }
  const C = G.colors, ctx = gctx, z = G.cam.z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  ctx.translate(r.width / 2, r.height / 2); ctx.scale(z, z); ctx.translate(-G.cam.x, -G.cam.y);
  const focus = G.hover || G.sel, q = $('#g-q').value.trim().toLowerCase();
  const near = new Set(focus ? [focus] : []);
  if (focus) for (const e of G.E) { if (e.a === focus) near.add(e.b); if (e.b === focus) near.add(e.a); }
  const dim = id => (focus && !near.has(id)) || (q && !G.N.get(id)?.label.toLowerCase().includes(q));
  for (const e of G.E) {
    const p = G.pos.get(e.a), s = G.pos.get(e.b), hot = focus && (e.a === focus || e.b === focus);
    ctx.globalAlpha = focus ? (hot ? 0.95 : 0.16) : (e.type === 'link' ? 0.45 : 0.7);
    ctx.strokeStyle = C[e.type] || C.muted; ctx.lineWidth = (hot ? 2 : 1.2) / Math.sqrt(z);
    ctx.setLineDash(e.type === 'sketch' ? [5, 4] : e.type === 'blockref' ? [2, 3] : e.type === 'contains' ? [1, 3] : []);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(s.x, s.y); ctx.stroke();
    if (e.type === 'pipe' || e.type === 'spawn') {   // direction tick at 60 %
      const mx = p.x + (s.x - p.x) * .6, my = p.y + (s.y - p.y) * .6, an = Math.atan2(s.y - p.y, s.x - p.x), k = 6;
      ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(mx - Math.cos(an - .5) * k, my - Math.sin(an - .5) * k); ctx.lineTo(mx, my); ctx.lineTo(mx - Math.cos(an + .5) * k, my - Math.sin(an + .5) * k); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  for (const g of G.N.values()) {
    const p = G.pos.get(g.id), rad = gRadius(g), d = dim(g.id);
    ctx.globalAlpha = d ? 0.38 : 1;
    ctx.fillStyle = C[g.kind] || C.muted; ctx.strokeStyle = C.bg; ctx.lineWidth = 2 / z;
    ctx.beginPath();
    if (g.kind === 'buffer' || g.kind === 'ghost') ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    else if (g.kind === 'folder') { const w = rad * 1.5; ctx.moveTo(p.x - w, p.y - rad * .7); ctx.lineTo(p.x - w * .3, p.y - rad * .7); ctx.lineTo(p.x - w * .15, p.y - rad); ctx.lineTo(p.x + w, p.y - rad); ctx.lineTo(p.x + w, p.y + rad); ctx.lineTo(p.x - w, p.y + rad); ctx.closePath(); }
    else ctx.rect(p.x - rad, p.y - rad, rad * 2, rad * 2);
    if (g.kind === 'ghost') { ctx.fillStyle = C.bg; ctx.fill(); ctx.setLineDash([3, 2]); ctx.strokeStyle = C.muted; ctx.lineWidth = 1.2 / z; ctx.stroke(); ctx.setLineDash([]); }
    else { ctx.fill(); ctx.stroke(); }
    if (g.id === G.sel) { ctx.beginPath(); ctx.arc(p.x, p.y, rad + 5 / z, 0, Math.PI * 2); ctx.strokeStyle = C.accent; ctx.lineWidth = 2 / z; ctx.stroke(); }
    const showLabel = z > 0.7 || near.has(g.id) || g.deg >= 3 || (q && !d);
    if (showLabel) {
      ctx.globalAlpha = d ? 0.25 : 1;
      ctx.font = `${g.id === focus || g.kind === 'folder' ? 600 : 400} ${12 / Math.sqrt(z)}px ${MONO}`;
      ctx.fillStyle = g.kind === 'ghost' ? C.muted : C.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(g.label, p.x, p.y + rad + 4 / z);
    }
  }
  ctx.globalAlpha = 1;
}
function graphLoop() {
  G.raf = 0; if (VIEW !== 'graph') return;
  if (G.alpha > 0.01) graphTick();
  graphDraw();
  if (G.alpha > 0.01 || G.drag) G.raf = requestAnimationFrame(graphLoop);
}
function graphKick() { if (VIEW === 'graph' && !G.raf) G.raf = requestAnimationFrame(graphLoop); }
function graphStart() {
  graphColors(); const first = !G.pos.size; graphRebuild();
  if (first) { for (let i = 0; i < 220; i++) graphTick(); G.alpha = 0.3; graphFit(); }
  graphKick();
}
function graphStop() { cancelAnimationFrame(G.raf); G.raf = 0; }
function graphFit() {
  const ps = [...G.pos.values()]; if (!ps.length) return;
  const r = gCanvas.getBoundingClientRect(), xs = ps.map(p => p.x), ys = ps.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  G.cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: clamp(Math.min((r.width - 160) / Math.max(1, x1 - x0), (r.height - 140) / Math.max(1, y1 - y0)), 0.3, 2.2) };
  graphKick();
}
function gHit(sx, sy) {
  const w = gToWorld(sx, sy); let best = null, bd = Infinity;
  for (const g of G.N.values()) { const p = G.pos.get(g.id), d = Math.hypot(p.x - w.x, p.y - w.y); if (d < gRadius(g) + 6 / G.cam.z && d < bd) { bd = d; best = g.id; } }
  return best;
}
function graphSelect(id) {
  G.sel = id; const card = $('#g-card'); updateSideCtx();
  if (!id) { card.hidden = true; graphKick(); return; }
  const g = G.N.get(id); card.hidden = false; card.replaceChildren();
  const head = el('div', 'gc-head'); head.innerHTML = '<b></b><span class="badge"></span><button class="mini gc-x" title="Show everything again (Esc, or click empty space)">✕</button>';
  $('.gc-x', head).onclick = () => graphSelect(null);
  $('b', head).textContent = g.label; $('.badge', head).textContent = (g.kind === 'buffer' ? 'page' : g.kind === 'ghost' ? 'no page yet' : badgeOf(g.ref)) + (g.ref ? tagsOf(g.ref).map(t => ' #' + t).join('') : '');
  const nb = G.E.filter(e => e.a === id || e.b === id).map(e => ({ id: e.a === id ? e.b : e.a, type: e.type }));
  const pre = el('pre'); pre.textContent = g.ref ? (g.kind === 'buffer' ? pageText(g.ref).split('\n').slice(0, 8).join('\n') : snapshotText(g.ref, 8)) : 'Linked from ' + nb.map(x => G.N.get(x.id)?.label).join(', ') + '.';
  const links = el('div', 'gc-links');
  for (const x of nb.slice(0, 12)) { const b = el('button', 'chip'); b.textContent = (G.N.get(x.id)?.label || '?') + ' · ' + x.type; b.onclick = () => { graphSelect(x.id); graphCenter(x.id); }; links.append(b); }
  const acts = el('div', 'ex-btns');
  const B = (label, fn) => { const b = el('button', 'tb'); b.textContent = label; b.onclick = fn; acts.append(b); };
  if (g.ref) { const ad = el('div', 'gc-addr'); const code = el('code'); code.textContent = addrOf(g.ref); const cp = el('button', 'mini', '⧉'); cp.title = 'Copy the address'; cp.onclick = () => copyText(addrOf(g.ref)); ad.append(code, cp); card.append(ad); }
  if (g.kind === 'ghost') B('Create page', () => { const n = openPage(g.label, null, true); graphRebuild(); edOpen(n); });
  if (g.kind === 'buffer') B('Open in editor', () => edOpen(g.ref));
  if (g.ref) B('Show on canvas', () => { setView('canvas'); jumpNode(g.ref); });
  if (g.ref) B(g.ref.kind === 'frame' ? 'Enter as workspace' : 'Open as tab', () => { setView('canvas'); g.ref.kind === 'frame' ? wsEnter(g.ref) : focusOpen(g.ref); });
  B('Ask assistant', () => { toggleSide(true); const ta = live.chat.ta; ta.value = `About [[${g.label}]]: `; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  const hint = el('div', 'gc-hint', 'Neighbours of ' + g.label + ' are bright; the rest is dimmed. Esc, ✕ or a click on empty space shows all.');
  card.append(head, pre, ...(nb.length ? [links] : []), acts, hint);
  graphKick();
}
function graphCenter(id) {
  const p = G.pos.get(id); if (!p) return;
  const from = { ...G.cam }, t0 = performance.now();
  const step = now => { const k = Math.min(1, (now - t0) / 300), e = 1 - (1 - k) ** 3; G.cam.x = from.x + (p.x - from.x) * e; G.cam.y = from.y + (p.y - from.y) * e; graphDraw(); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
gCanvas.addEventListener('pointerdown', ev => {
  const r = gCanvas.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top, id = gHit(sx, sy);
  gCanvas.setPointerCapture(ev.pointerId);
  const start = { x: ev.clientX, y: ev.clientY, cam: { ...G.cam } }; let moved = false;
  if (id) G.drag = { id };
  const mv = e => {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) moved = true;
    if (G.drag) { const w = gToWorld(e.clientX - r.left, e.clientY - r.top), p = G.pos.get(id); p.x = w.x; p.y = w.y; G.alpha = Math.max(G.alpha, 0.3); }
    else { G.cam.x = start.cam.x - (e.clientX - start.x) / G.cam.z; G.cam.y = start.cam.y - (e.clientY - start.y) / G.cam.z; }
    graphKick(); if (!G.raf) graphDraw();
  };
  const up = () => {
    gCanvas.removeEventListener('pointermove', mv); gCanvas.removeEventListener('pointerup', up); gCanvas.removeEventListener('pointercancel', up);
    G.drag = null; if (!moved) graphSelect(id);
    graphKick();
  };
  gCanvas.addEventListener('pointermove', mv); gCanvas.addEventListener('pointerup', up); gCanvas.addEventListener('pointercancel', up);
});
gCanvas.addEventListener('pointermove', ev => {
  if (G.drag || ev.buttons) return;
  const r = gCanvas.getBoundingClientRect(), id = gHit(ev.clientX - r.left, ev.clientY - r.top);
  if (id !== G.hover) { G.hover = id; gCanvas.style.cursor = id ? 'pointer' : 'grab'; graphDraw(); }
});
gCanvas.addEventListener('pointerleave', () => { if (G.hover) { G.hover = null; graphDraw(); } });
gCanvas.addEventListener('dblclick', ev => {
  const r = gCanvas.getBoundingClientRect(), g = G.N.get(gHit(ev.clientX - r.left, ev.clientY - r.top)); if (!g) return;
  if (g.kind === 'buffer') edOpen(g.ref);
  else if (g.kind === 'ghost') { const n = openPage(g.label, null, true); graphRebuild(); edOpen(n); }
  else if (g.kind === 'folder') jumpFolder(g.ref);
  else { setView('canvas'); jumpNode(g.ref); }
});
gCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = gCanvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, before = gToWorld(sx, sy);
  G.cam.z = clamp(G.cam.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)), 0.15, 4);
  const after = gToWorld(sx, sy); G.cam.x += before.x - after.x; G.cam.y += before.y - after.y;
  graphDraw();
}, { passive: false });
$('#g-q').addEventListener('input', () => graphDraw());
$('#g-q').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase(), g = [...G.N.values()].find(g => g.label.toLowerCase().includes(q));
  if (g) { graphSelect(g.id); graphCenter(g.id); }
});
$('#g-all').onchange = $('#g-ghost').onchange = () => graphRebuild();
$('#g-fit').onclick = () => { graphFit(); graphDraw(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { graphColors(); if (VIEW === 'graph') graphDraw(); });

// ------------------------------------------------------------------ outline view: the whole workspace as a tree
function renderOutline() {
  const list = $('#ol-list'), open = new Set($$('#ol-list details:not([open])').map(d => d.dataset.k));
  list.replaceChildren();
  const groups = new Map(frameList().sort((a, b) => fullPath(a).localeCompare(fullPath(b))).map(f => [f.id, { f, items: [] }])); groups.set('', { f: null, items: [] });
  const groupOf = n => (n.in && S.nodes[n.in] ? n.in : '');
  for (const n of nodeList()) groups.get(groupOf(n)).items.push(n);
  const row = (n, depth, box) => {
    const r = el('div', 'ol-row'); r.style.setProperty('--d', depth);
    r.innerHTML = '<span class="ol-k"></span><button class="ol-name"></button><span class="ol-meta"></span><span class="ol-acts"></span>';
    $('.ol-k', r).textContent = n.kind === 'buffer' ? 'page' : badgeOf(n);
    $('.ol-name', r).textContent = depth && parentOf(n.id) ? n.name : pathOf(n.id);
    $('.ol-name', r).onclick = () => (n.kind === 'buffer' ? edOpen(n) : (setView('canvas'), jumpNode(n)));
    let meta = '';
    if (n.kind === 'buffer') { const t = pageText(n), links = (t.match(/\[\[[^\]]+\]\]/g) || []).length, bl = backlinksOf(n).length, todo = (t.match(/^\s*[-*+]\s+(TODO|NEXT|WAITING|HOLD|SOMEDAY|DOING|NOW|LATER)\s/gm) || []).length; meta = [`${t.split('\n').length} lines`, links && `${links} links out`, bl && `${bl} in`, todo && `${todo} open tasks`].filter(Boolean).join(' · '); }
    else if (n.kind === 'term') meta = n.backend === 'pty' ? 'real shell' : (live[n.id]?.backend?.cwd || n.cwd || '');
    else if (n.kind === 'repl') meta = n.lang === 'js' ? `JavaScript · ${(n.history || []).length} inputs` : n.cmd;
    else if (n.kind === 'acp') meta = agentLabel(n.agent) + ' · ' + (SESS[n.id]?.state || '…').replace(/_/g, ' ');
    else if (n.kind === 'agent') meta = `${(n.turns || []).length} turns · ${({ quick: 'Fast', default: 'Expert', complex: 'Heavy' })[n.tier] || ''}`;
    else if (n.kind === 'ref') meta = 'from ' + (n.srcLabel || '?');
    const pipes = S.edges.filter(e => e.from === n.id && e.type !== 'spawn').map(e => `${e.type} → ${S.nodes[e.to]?.name}`);
    $('.ol-meta', r).textContent = [meta, ...pipes].filter(Boolean).join(' · ');
    const acts = $('.ol-acts', r), B = (t, title, fn) => { const b = el('button', 'mini'); b.textContent = t; b.title = title; b.onclick = fn; acts.append(b); };
    B('canvas', 'Show on the canvas', () => { setView('canvas'); jumpNode(n); });
    if (n.kind === 'buffer') B('edit', 'Open in the editor', () => edOpen(n));
    box.append(r);
    if (n.kind === 'buffer') for (const h of headingsOf(pageText(n)).filter(h => h.level > 1 || headingsOf(pageText(n)).length > 1)) {
      const hr = el('button', 'ol-h'); hr.style.setProperty('--d', depth + h.level - 1); hr.textContent = h.text; hr.onclick = () => edOpen(n, h.pos); box.append(hr);
    }
    for (const c of childrenOf(n.id, 'spawn')) row(c, depth + 1, box);
  };
  for (const [k, g] of groups) {
    if (!g.items.length) continue;
    const d = el('details', 'ol-group'); d.dataset.k = k || 'loose'; d.open = !open.has(d.dataset.k);
    const sm = el('summary'); sm.innerHTML = '<b></b> <span class="muted"></span>';
    $('b', sm).textContent = g.f ? fullPath(g.f) + '/' : 'Loose on the canvas'; $('span', sm).textContent = `${g.items.length} node${g.items.length > 1 ? 's' : ''}`;
    d.append(sm);
    const roots = g.items.filter(n => { const p = parentOf(n.id); return !p || !S.nodes[p] || groupOf(S.nodes[p]) !== k; });
    for (const n of roots.sort((a, b) => a.y - b.y || a.x - b.x)) row(n, 0, d);
    list.append(d);
  }
}

// ------------------------------------------------------------------ tasks view: TODO / DOING / DONE bullets from every page
// Tasks are blocks whose first word is a keyword (the user's Org set; DOING/NOW/LATER read as aliases). Planning lines and
// key:: value fields sit right under the task line, Logseq-style: SCHEDULED: <2026-10-11 Sat>, session:: tmux:agent-x.
const TASK_KWS = ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED'];
const TASK_RE = /^(\s*[-*+]\s+)(TODO|NEXT|WAITING|HOLD|SOMEDAY|DONE|CANCELLED|DOING|NOW|LATER)(\s+)(.*)$/;
const COL = { TODO: 'TODO', SOMEDAY: 'TODO', LATER: 'TODO', NEXT: 'NEXT', DOING: 'NEXT', NOW: 'NEXT', WAITING: 'WAITING', HOLD: 'WAITING', DONE: 'DONE', CANCELLED: 'DONE' };
const COL_KW = { TODO: 'TODO', NEXT: 'NEXT', WAITING: 'WAITING', DONE: 'DONE' };
const TASK_DATE_RE = /^\s*(SCHEDULED|DEADLINE|CLOSED):\s*[<[](\d{4}-\d{2}-\d{2})[^>\]]*[>\]]/, FIELD_LINE_RE = /^\s*([\w-]+)::\s*(.*)$/;
function collectTasks() {
  const out = [];
  for (const p of pages()) {
    const v = live[p.id]?.view; if (!v) continue;
    const doc = v.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i), m = line.text.match(TASK_RE);
      if (!m) continue;
      const t = { node: p, line: i, kw: m[2], kwFrom: line.from + m[1].length, text: m[4], pos: line.from + m[1].length, st: v.state, fields: {}, body: [] };
      const pm = t.text.match(/\s*\[#([A-C])\]/); if (pm) t.priority = pm[1];
      for (let j = i + 1; j <= doc.lines; j++) { const l = doc.line(j).text; if (!l.trim() || !/^\s/.test(l) || TASK_RE.test(l) || /^#{1,6} /.test(l)) break; const dm = l.match(TASK_DATE_RE), fm = l.match(FIELD_LINE_RE); if (dm) t[dm[1].toLowerCase()] = dm[2]; else if (fm) t.fields[fm[1].toLowerCase()] = fm[2]; else t.body.push(l.trim()); t.lastLine = j; }
      t.session = t.fields.session; t.dispatched = t.fields.dispatched;
      out.push(t);
    }
  }
  return out;
}
// tasks in the notes index (the daemon's /api/tasks); demo mode has none beyond the board's pages
const TASKS = { rows: [], at: 0 };
async function tasksLoad(force) {
  if (!DAEMON) { TASKS.rows = []; return TASKS.rows; }
  if (!force && Date.now() - TASKS.at < 20000) return TASKS.rows;
  try { const j = await (await hFetch(null, '/api/tasks')).json(); TASKS.rows = (j.tasks || []).map(r => ({ idx: true, id: r.id, nodeId: r.node, kw: r.kw, text: r.title, priority: r.priority, scheduled: r.scheduled, deadline: r.deadline, session: r.session, dispatched: r.dispatched, target: r.target, path: r.path, line: r.line, body: (r.prompt || '').split('\n').filter(l => l.trim() && !FIELD_LINE_RE.test(l) && !TASK_DATE_RE.test(l)).map(l => l.trim()), tags: r.tags || [] })); } catch { TASKS.rows = []; }
  TASKS.at = Date.now(); if (VIEW === 'tasks') renderTasks(); statusRender(); return TASKS.rows;
}
const allTasks = () => [...collectTasks(), ...TASKS.rows];
const taskKey = t => t.idx ? 'idx:' + t.id : t.node.id + ':' + t.line;
const taskWhere = t => t.idx ? t.path + ':' + t.line : fmtAddr({ ...bufferAddress(t.node, t.st, t.pos), quote: '' });
const taskAddr = t => t.idx ? 'task:' + t.id : 'board:/' + t.node.name + ':' + t.line;
const taskOpen = t => t.idx ? noteOpen({ path: t.path, line: t.line }) : edOpen(t.node, t.pos);
const taskText = t => [plainTask(t.text).replace(/\s*\^[\w-]+$/, ''), ...(t.body || [])].join(' ').replace(/\s+/g, ' ').trim();
const taskDue = t => t.deadline || t.scheduled || null;
async function taskSetKw(t, kw) {
  if (!TASK_KWS.includes(kw)) return;
  if (!t.idx) { setTask(t, kw); return; }
  try { const r = await hFetch(null, '/api/task/' + encodeURIComponent(t.id), { method: 'POST', body: JSON.stringify({ kw }), headers: { 'Content-Type': 'application/json' } }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); } catch (e) { toast('Could not change ' + t.text + ': ' + e.message); }
  await tasksLoad(true);
}
function taskCycle(t, back) { const i = TASK_KWS.indexOf(COL_KW[COL[t.kw]] || t.kw), order = ['TODO', 'NEXT', 'WAITING', 'DONE']; const j = order.indexOf(TASK_KWS[i] === 'DONE' ? 'DONE' : COL[t.kw]); return taskSetKw(t, order[(j + (back ? 3 : 1)) % 4]); }
function findTask(ref) {
  const r = String(ref || '').trim(); if (!r) return null;
  const pl = r.replace(/^board:\/?/, '').match(/^(.+?):(\d+)$/); if (pl && findPage(pl[1])) { const p = findPage(pl[1]); return collectTasks().find(t => t.node === p && t.line === +pl[2]) || null; }
  const a = parseAddr(r);
  if (a && a.kind === 'note') { const an = (a.path.match(/#\^([\w-]+)$/) || [])[1]; if (an) return TASKS.rows.find(t => t.id === an) || null; const row = noteByAddrPath(a.path); return row ? TASKS.rows.find(t => t.nodeId === row.id) || null : null; }
  if (a && a.kind === 'board') { const m = a.path.match(/^\/?(.+?):(\d+)$/); if (m) { const p = findPage(m[1]); return p ? collectTasks().find(t => t.node === p && t.line === +m[2]) || null : null; } }
  if (/^task:/.test(r)) return TASKS.rows.find(t => t.id === r.slice(5).replace(/^\^/, '')) || null;
  const m = r.match(/^(.+?):(\d+)$/); if (m && findPage(m[1])) { const p = findPage(m[1]); return collectTasks().find(t => t.node === p && t.line === +m[2]) || null; }
  const an = r.replace(/^\^/, ''); return TASKS.rows.find(t => t.id === an || t.nodeId === an) || collectTasks().find(t => plainTask(t.text).toLowerCase().startsWith(an.toLowerCase())) || null;
}
// dispatch: paste the task into a shell running an agent on that host (or say so), then record session:: and dispatched::
async function dispatchTask(t, { host, shell } = {}) {
  const h = host ? hostByName(host) : null; if (host && !h) throw new Error('unknown host @' + host);
  let n = shell ? findNode(shell) : null;
  if (shell && !n) throw new Error('no shell at ' + shell);
  if (!n) n = nodeList().find(m => m.kind === 'acp' && ['idle', 'done'].includes(SESS[m.id]?.state) && live[m.id]?.backend?.promptable()) || null;   // an idle agent card first
  if (!n) n = nodeList().find(m => m.kind === 'term' && tagsOf(m).includes('agent') && (!h || fsHostKey(m) === h.url) && live[m.id]?.backend && !live[m.id].backend.dead && !live[m.id].backend.parked) || null;
  if (!n) {
    const hf = h ? hostFolder(h) : null, c = viewCenterWorld(), w = 640, hh = 400;
    const sh = addNode({ kind: 'term', backend: DAEMON ? 'pty' : 'fake', shell: shellDefault(), name: 'agent' + (nodeList().filter(m => m.kind === 'term').length + 1), env: {}, in: hf ? hf.id : undefined, ...freeSpot(c.x - w / 2, c.y - hh / 2, w, hh), w, h: hh });
    if (hf) adopt(sh, hf, null, true);
    throw new Error('no idle agent card or shell with #agent' + (h ? ' on @' + h.name : '') + ': opened ' + pathOf(sh.id) + '. Start your agent there and dispatch again.');
  }
  const L = live[n.id], text = taskText(t); if (!L?.backend) throw new Error(n.name + ' is not running');
  L.backend.input(text + '\r'); pulse(n.id); if (VIEW === 'canvas') jumpNode(n);
  const hk = fsHostKey(n), hn = hk ? hostByUrl(hk)?.name : null, sess = tmuxTargetOf(n) ? 'tmux:' + tmuxTargetOf(n) + (hn ? '@' + hn : '') : addrOf(n);
  const stamp = new Date().toISOString().slice(0, 16), kw = ['TODO', 'SOMEDAY', 'LATER'].includes(t.kw) ? 'NEXT' : null;
  if (t.idx) {
    const r = await hFetch(null, '/api/task/' + encodeURIComponent(t.id), { method: 'POST', body: JSON.stringify({ kw, set: { session: sess, dispatched: stamp } }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'could not write session:: into the task'); await tasksLoad(true);
  } else {
    const v = live[t.node.id]?.view; if (v) { const doc = v.state.doc, head = doc.line(t.line), indent = (head.text.match(/^\s*/) || [''])[0] + '  ', lines = []; for (let j = t.line + 1; j <= (t.lastLine || t.line); j++) lines.push(doc.line(j));
      const changes = [];
      for (const [k, val] of [['session', sess], ['dispatched', stamp]]) { const ex = lines.find(l => (l.text.match(FIELD_LINE_RE) || [])[1] === k); if (ex) changes.push({ from: ex.from, to: ex.to, insert: indent + k + ':: ' + val }); else changes.push({ from: head.to, insert: '\n' + indent + k + ':: ' + val }); }
      v.dispatch({ changes }); if (kw) setTask({ ...t, st: v.state }, kw); }
  }
  if (VIEW === 'tasks') renderTasks();
  return { shell: pathOf(n.id), session: sess, text };
}
function setTask(t, kw) {
  const v = live[t.node.id]?.view; if (!v) return;
  const line = v.state.doc.line(Math.min(t.line, v.state.doc.lines)), m = line.text.match(TASK_RE);
  if (!m) return toast('That task moved. Try again.');
  v.dispatch({ changes: { from: line.from + m[1].length, to: line.from + m[1].length + m[2].length, insert: kw } });
  renderTasks();
}
function plainTask(s) { return s.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\(\(([^)]+)\)\)/g, (_, a) => resolveRef(a)?.text || a).replace(/\s*\[#[A-C]\]/, '').replace(/\s*\^[\w-]+$/, ''); }
const TK = { sel: null, order: [] };
function renderTasks() {
  if (DAEMON && Date.now() - TASKS.at > 20000) tasksLoad();
  const tasks = allTasks(), board = $('#tk-board'), today = TODAY;
  const cols = { TODO: [], NEXT: [], WAITING: [], DONE: [] };
  for (const t of tasks) cols[COL[t.kw] || 'TODO'].push(t);
  const byDue = (a, b) => (taskDue(a) || '9999').localeCompare(taskDue(b) || '9999') || (a.priority || 'Z').localeCompare(b.priority || 'Z');
  TK.order = [];
  for (const [k, list] of Object.entries(cols)) {
    list.sort(byDue);
    const col = $(`.tk-col[data-col="${k}"]`, board), box = $('.tk-cards', col);
    $('.tk-n', col).textContent = list.length;
    box.replaceChildren();
    for (const t of list) {
      const key = taskKey(t); TK.order.push(key);
      const c = el('div', 'tk-card' + (k === 'DONE' ? ' done' : '') + (TK.sel === key ? ' on' : '')); c.draggable = true; c.dataset.key = key;
      c.innerHTML = '<div class="tk-t"></div><div class="tk-meta"></div><div class="tk-src"><button class="tk-page"></button><span class="tk-mv"></span></div>';
      $('.tk-t', c).textContent = (t.kw !== COL_KW[k] ? t.kw + ' ' : '') + (plainTask(t.text).replace(/\s*\[#[A-C]\]/, '').replace(/\s*\^[\w-]+$/, '') || '(empty)');
      const meta = $('.tk-meta', c), due = taskDue(t), over = due && due < today && k !== 'DONE';
      const bits = [];
      if (t.priority) bits.push(['#' + t.priority, 'prio']);
      if (t.deadline) bits.push(['⏰ ' + t.deadline, over ? 'over' : '']); else if (t.scheduled) bits.push(['▸ ' + t.scheduled, over ? 'over' : '']);
      if (t.session) bits.push(['⇢ ' + t.session.replace(/^tmux:/, ''), 'sess']);
      if (t.idx && t.tags?.length) bits.push([t.tags.map(x => '#' + x).join(' '), '']);
      for (const [txt, cls] of bits) { const sp = el('span', cls, txt); meta.append(sp); }
      if (!bits.length) meta.remove();
      $('.tk-page', c).textContent = taskWhere(t); $('.tk-page', c).title = taskAddr(t);
      $('.tk-page', c).onclick = () => taskOpen(t);
      const mv = $('.tk-mv', c), order = ['TODO', 'NEXT', 'WAITING', 'DONE'], i = order.indexOf(k);
      if (i > 0) { const b = el('button', 'mini'); b.textContent = '←'; b.title = 'Move to ' + order[i - 1]; b.onclick = () => taskSetKw(t, order[i - 1]); mv.append(b); }
      if (i < 3) { const b = el('button', 'mini'); b.textContent = i === 0 ? 'Next' : i === 1 ? 'Wait' : 'Done'; b.title = 'Move to ' + order[i + 1]; b.onclick = () => taskSetKw(t, order[i + 1]); mv.append(b); }
      if (k !== 'DONE') { const b = el('button', 'mini'); b.textContent = '⇢'; b.title = 'Dispatch: paste this task into a shell running an agent (d)'; b.onclick = () => dispatchTask(t).then(r => toast('Dispatched to ' + r.shell + '.')).catch(e => toast(e.message)); mv.append(b); }
      c.addEventListener('click', () => { TK.sel = key; $$('.tk-card.on', board).forEach(x => x.classList.remove('on')); c.classList.add('on'); });
      c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', ''); renderTasks.drag = t; c.classList.add('dragging'); });
      c.addEventListener('dragend', () => c.classList.remove('dragging'));
      box.append(c);
    }
    if (!list.length) box.append(el('p', 'muted small', k === 'TODO' ? 'Write “- TODO something” in any page or note, or add one below.' : 'Nothing here.'));
  }
  if (TK.sel && !TK.order.includes(TK.sel)) TK.sel = null;
}
function tasksKey(e) {
  const k = e.key; if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const cur = () => allTasks().find(t => taskKey(t) === TK.sel) || null;
  if (k === 'j' || k === 'k' || k === 'ArrowDown' || k === 'ArrowUp') { const i = TK.order.indexOf(TK.sel), d = k === 'j' || k === 'ArrowDown' ? 1 : -1; TK.sel = TK.order[clamp(i < 0 ? 0 : i + d, 0, Math.max(0, TK.order.length - 1))] || null; renderTasks(); $('.tk-card.on')?.scrollIntoView({ block: 'nearest' }); return true; }
  const t = cur(); if (!t) { if (k === 't' || k === 'T' || k === 'Enter' || k === 'd') { toast('Pick a task first (j / k or click).'); return true; } return false; }
  if (k === 't' || k === 'T') { taskCycle(t, k === 'T').then(() => renderTasks()); return true; }
  if (k === 'Enter') { taskOpen(t); return true; }
  if (k === 'd') { dispatchTask(t).then(r => toast('Dispatched to ' + r.shell + '.')).catch(e => toast(e.message)); return true; }
  if (k === 'r') { tasksLoad(true).then(() => toast('Tasks reloaded from the index.')); return true; }
  return false;
}
$$('.tk-col').forEach(col => {
  col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('over'); });
  col.addEventListener('dragleave', () => col.classList.remove('over'));
  col.addEventListener('drop', e => { e.preventDefault(); col.classList.remove('over'); const t = renderTasks.drag; renderTasks.drag = null; if (t && COL[t.kw] !== col.dataset.col) taskSetKw(t, col.dataset.col); });
});
$('#tk-add').addEventListener('submit', e => {
  e.preventDefault(); const i = $('#tk-in'), text = i.value.trim(); if (!text) return;
  const n = openPage(TODAY, null, true), v = live[n.id].view, doc = v.state.doc, last = doc.line(doc.lines);
  const ins = /^\s*[-*+]\s*$/.test(last.text) ? { from: last.from, to: last.to, insert: `- TODO ${text}` } : { from: doc.length, insert: (doc.length && !doc.toString().endsWith('\n') ? '\n' : '') + `- TODO ${text}` };
  v.dispatch({ changes: ins }); i.value = ''; renderTasks(); toast(`Added to ${TODAY}`);
});

// ------------------------------------------------------------------ side pane: the general-purpose assistant
const CHAT_HELLO = 'I am the general assistant. I see the view you are in and can act on the whole workspace: read and write pages, run commands in shells and REPLs, add nodes and links, draw, and switch views. ⑂ forks this conversation onto the canvas as an agent node.';
function initChat() {
  return; // v9: the assistant pane is gone; agents run in terminals.
  if (!S.chat) S.chat = { id: 'chat', name: 'assistant', kind: 'agent', tier: 'quick', turns: [], log: [{ t: 'note', text: CHAT_HELLO }] };
  live.chat = { el: $('#side'), body: $('#side-body'), hdr: null };
  mountAgent(S.chat, live.chat);
  live.chat.ta.placeholder = 'Ask anything, or tell me what to change…';
}
function toggleSide(open, quiet) {
  open = open ?? !document.body.classList.contains('side-open');
  document.body.classList.toggle('side-open', open);
  if (S) { S.side = open; dirty(); }
  if (open && !quiet) setTimeout(() => live.chat?.ta?.focus(), 60);
  if (VIEW === 'graph') setTimeout(graphDraw, 220);
}
const PANE_W = 400, TREE_W = 240;
function setTreeW(w, save) {
  w = Math.round(Math.max(180, Math.min(w, 560, innerWidth * 0.5)));
  document.documentElement.style.setProperty('--tree-w', w + 'px');
  if (save && S) { S.treeW = w; dirty(); }
}
function wireGrip(g, widthAt, set, reset) {
  g.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); g.setPointerCapture(e.pointerId);
    document.body.classList.add('pane-drag');
    const move = ev => set(widthAt(ev), false);
    const up = ev => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      document.body.classList.remove('pane-drag'); set(widthAt(ev), true); };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => set(reset, true));
}
function setPaneW(w, save) {
  w = Math.round(Math.max(280, Math.min(w, innerWidth * 0.85)));
  document.documentElement.style.setProperty('--pane-w', w + 'px');
  if (save && S) { S.paneW = w; dirty(); }
  if (VIEW === 'graph') { clearTimeout(setPaneW.t); setPaneW.t = setTimeout(graphDraw, 60); }
}
function wirePaneGrip() {
  wireGrip($('#side-grip'), ev => innerWidth - ev.clientX, setPaneW, PANE_W);
  wireGrip($('#tree-grip'), ev => ev.clientX - $('#tree-pane').getBoundingClientRect().left, setTreeW, TREE_W);
  $('#pick-chip [data-act=compact]').onclick = () => compact('selection');
  $('#pick-chip [data-act=clear]').onclick = () => pickClear();
  const wu = $('#ws-up'); if (wu) wu.onclick = () => wsLeave();
  $('#pick-chip [data-act=delete]').onclick = () => removeSelection();
  $('#pick-chip [data-act=sketch]').onclick = () => sketchFromSelection();
  $('#pick-chip [data-act=read]').onclick = () => { INK.ids = [...SEL.strokes]; INK.t = Date.now(); inkToText(); };
}
function focusLabel() {
  if (VIEW === 'editor' && ED.node) return 'page ' + ED.node.name;
  if (VIEW === 'graph' && G.sel) return G.N.get(G.sel)?.label;
  if (VIEW === 'canvas' && activeId && S.nodes[activeId]) return pathOf(activeId);
  return '';
}
function updateSideCtx() { const f = focusLabel(), ta = $('#side-chat textarea'); if (ta) ta.placeholder = f ? `Ask about ${f}, or anything on the board…` : 'Ask about the board, or tell the agent what to do…'; }
function chatRules() {
  const f = focusLabel();
  return `You are the general-purpose assistant in the side pane of a personal workbench. One set of data (pages, shells, REPLs, agent nodes, reference cards, folders, edges and sketch shapes) is shown through five views the user switches between: canvas (a pannable spatial board), graph (pages and nodes as a link graph), editor (one page as a full-width text editor), outline (everything as a tree grouped by folder) and tasks (TODO / NEXT / WAITING / DONE blocks from all pages and the notes index as a board).

Folders are containers on the canvas that hold nodes and other folders. A folder is free (items stay where placed; it stretches to hold them), pack (items flow into rows in order) or stack (collapsed into a deck of cards). Use make_folder and put_in_folder to organise; reading or running something inside a deck works without spreading it.

Pages follow Logseq conventions: "- " bullets, [[page]] links, ((address)) block references, and tasks written as "- TODO …", "- NEXT …", "- WAITING …", "- DONE …" (also HOLD, SOMEDAY, CANCELLED), with SCHEDULED:/DEADLINE: lines and session:: fields under them. Addresses look like "plans › Rollout ¶2", "plans#freeze" or folder cells like "machines/B2". Today is ${TODAY}; today's journal page is named "${TODAY}".

Artifact nodes are self-contained HTML pages (Claude artifacts) in sandboxed frames; publish_artifact creates or updates one, read_artifact reads it, and artifact_from_file shows an HTML file that any agent writes (it reloads on change). open_web opens a page as a browser-window node; open_in_emacs opens a file in an Emacs buffer node (a PTY running emacsclient). Sketch nodes are cards the user writes on with the pen. tag_node and list_nodes work with tags (#agent, #aggregator, user tags). Flashcards live as blocks in notes; list_due reads the FSRS queue and create_flashcard writes a card block; the Review view (Alt-7) is where the user reviews.\n\nLook before you answer and act when asked, using the tools. Shells are ${DAEMON ? 'real shells on the user\'s machine' : 'simulated (ls, cd, cat, echo, mkdir, touch, tree, env, export, pwd)'}; JavaScript REPLs run in the browser. Keep replies short and concrete, refer to nodes by path, and say what you changed. When the result is easier to see in another view, switch to it with open_view.

The user is in the ${VIEW} view${f ? `, focused on ${f}` : ''}.

Workspace now:
${boardSummary()}`;
}
$('#side-close').onclick = () => toggleSide(false);
if ($('#chat-clear')) $('#chat-clear').onclick = ev => confirmDel(ev.currentTarget, () => {
  S.chat.turns = []; S.chat.log = [{ t: 'note', text: CHAT_HELLO }]; renderAgentLog(S.chat); dirty();
});
if ($('#chat-fork')) $('#chat-fork').onclick = () => {
  const c = S.chat; if (!c.turns.length) return toast('Nothing to fork yet. Ask the assistant something first.');
  setView('canvas');
  const p = viewCenterWorld(), count = nodeList().filter(n => n.kind === 'agent').length + 1;
  const n = addNode({ kind: 'agent', name: 'chat' + count, ...freeSpot(p.x - 260, p.y - 200, 520, 420), w: 520, h: 420, tier: c.tier,
    turns: c.turns.map(t => ({ ...t })), log: [...c.log.filter(m => !m.live).map(m => ({ ...m })), { t: 'note', text: `Forked from the assistant after ${c.turns.length} turn(s). This branch continues on its own.` }] });
  jumpNode(n); toast(`Forked into ${n.name} on the canvas`);
};
AGENT_TOOLS.push({
  name: 'open_view', description: 'Switch the main area to a view: canvas, graph, editor, outline or tasks. With editor, page opens that page (created if missing). With canvas, target is anything move_view accepts. With graph, target selects that node.',
  inputSchema: { type: 'object', properties: { view: { type: 'string', enum: VIEWS }, page: { type: 'string' }, target: { type: 'string' } }, required: ['view'] },
  run: ({ view, page, target }) => {
    if (!VIEWS.includes(view)) throw new Error('unknown view ' + view);
    if (view === 'editor' && (page || target)) {
      const nm = str(page || target), n = findNode(nm) || openPage(nm, null, true);
      if (n.kind !== 'buffer') throw new Error(nm + ' is not a page');
      edOpen(n); return 'editor showing ' + n.name;
    }
    setView(view);
    if (view === 'canvas' && target) { const r = palSearch(str(target))[0]; if (r) r.run(); }
    if (view === 'graph' && target) { const n = findNode(target); if (n && G.N.has(n.id)) { graphSelect(n.id); graphCenter(n.id); } }
    return 'showing ' + view;
  },
});

// ------------------------------------------------------------------ daemon info and RPC: Claude through canvasd
// In the local build every `sample` call (assistant, agent nodes, handwriting, hosted artifacts) goes to the daemon over
// one WebSocket; the key lives in the daemon's environment. In the hosted artifact the outer page's own `sample` answers.
let INFO = null;
class Rpc {
  constructor(h = null) { this.h = h; this.calls = new Map(); this.seq = 0; this.tries = 0; this.connect(); }
  connect() {
    clearTimeout(this.timer); WAKE.delete(this);
    const ws = this.ws = new WebSocket(hWs(this.h, '/rpc'));
    ws.onopen = () => { this.tries = 0; if (!this.h && this.opened) netKick(); this.opened = true; };   // a reopen re-reads /api/info: hubSeen spots a restart
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (!this.h && RPC_EVENTS[m.t] && m.id == null) return RPC_EVENTS[m.t](m);
      if (m.t === 'cmd') return this.runCmd(m);
      const c = this.calls.get(m.id); if (c) c.on(m);
    };
    ws.onclose = () => {
      for (const c of this.calls.values()) c.on({ t: 'error', code: 'upstream_error', message: 'the server connection closed' }); this.calls.clear();
      if (this.h) { this.tries++; return void setTimeout(() => this.connect(), Math.min(30000, 1500 * 2 ** Math.min(this.tries, 4))); }
      WAKE.add(this);
      if (NET.state === 'signed_out' || NET.state === 'forbidden') return;
      netKick(); this.timer = setTimeout(() => this.connect(), backoff(this.tries++));
    };
  }
  wake() { if (this.ws?.readyState > 1) { this.tries = 0; this.connect(); } }
  ready() { return new Promise(res => { if (this.ws.readyState === 1) return res(true); this.ws.addEventListener('open', () => res(true), { once: true }); setTimeout(() => res(this.ws.readyState === 1), 4000); }); }
  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  async runCmd(m) {
    try { const t = AGENT_TOOLS.find(x => x.name === m.tool); if (!t) throw new Error('unknown tool ' + m.tool + ' (wb tools lists them)'); const r = await t.run(m.input || {}, {}); this.send({ t: 'cmd_result', id: m.id, result: typeof r === 'string' ? r : JSON.stringify(r) }); }
    catch (e) { this.send({ t: 'cmd_result', id: m.id, error: e?.message || String(e) }); }
  }
  async limits() {
    await this.ready(); const id = 'l' + (++this.seq);
    return new Promise(res => { this.calls.set(id, { on: m => { this.calls.delete(id); res(m.value || null); } }); this.send({ t: 'limits', id }); setTimeout(() => res(null), 4000); });
  }
  async sample(args, { onText, onTool, signal } = {}) {
    await this.ready(); const id = 's' + (++this.seq);
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { this.calls.delete(id); fn(v); };
      this.calls.set(id, { on: async m => {
        if (m.t === 'text') onText?.(m.text);
        else if (m.t === 'tool') { try { const r = await onTool(m); this.send({ t: 'tool_result', id, callId: m.callId, result: r ?? '' }); } catch (e) { this.send({ t: 'tool_error', id, callId: m.callId, message: String(e?.message || e) }); } }
        else if (m.t === 'done') done(resolve, { text: m.text, truncated: !!m.truncated, modelTierApplied: m.modelTierApplied, modelApplied: m.modelApplied || undefined });
        else if (m.t === 'error') done(reject, { code: m.code || 'upstream_error', message: m.message, ...(m.text ? { text: m.text } : {}) });
      } });
      signal?.addEventListener('abort', () => this.send({ t: 'cancel', id }), { once: true });
      this.send({ t: 'sample', id, ...args });
    });
  }
}
let RPC = null;
const blobB64 = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });
// A `sample` function with the contract's shape, answered by the daemon.
function daemonSample() {
  const fn = async (input, o = {}) => {
    const images = o.images ? await Promise.all(o.images.map(async b => ({ media_type: b.type || 'image/png', data: await blobB64(b) }))) : undefined;
    const tools = o.tools ? o.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : undefined;
    let last = '';
    return RPC.sample({ input, modelTier: o.modelTier, model: o.model, effort: o.effort, images, tools }, {
      signal: o.signal,
      onText: text => { if (o.onText && text !== last) { const delta = text.slice(last.length); last = text; o.onText({ text, delta }); } },
      onTool: async m => { const t = o.tools?.find(x => x.name === m.name); if (!t) throw new Error('no such tool'); const ctl = new AbortController(); let r = await t.execute(m.input || {}, { signal: ctl.signal }); return typeof r === 'string' ? r : JSON.stringify(r); },
    });
  };
  fn.limits = async () => { const l = await RPC.limits(); return l ? { maxPromptBytes: l.maxPromptBytes, images: l.images, tools: l.tools } : null; };
  fn.json = async (input, o) => JSON.parse((await fn(input, o)).text.replace(/^[\s\S]*?([\[{])/, '$1').replace(/[^\]}]*$/, ''));
  return fn;
}
// Said where a model feature is used, never at startup: a server without a model is a normal setup, not a fault.
// Provider-neutral: the server's `sample` backend is configured on the server, with its key there, never in a page.
const SAMPLE_OFF = 'No language model on this server: the assistant, handwriting and artifacts that ask a model stay off until wb-web serves `sample` (configured in its web.json, with the key kept on the server). Shells, agent cards and pages work without it.';

// ------------------------------------------------------------------ artifacts: Claude artifact pages as nodes
// An artifact node is a versioned HTML page running in a sandboxed frame on its own origin (the daemon's second port;
// an opaque srcdoc frame in demo mode). The page sees only window.claude.use(); this host answers each call, asks the
// user once per capability, and routes `sample` to the daemon (or to the outer artifact's own sample when hosted).
const CAPS_ALL = ['sample', 'artifact', 'db', 'permissions', 'downloads', 'user', 'room'];
const CAP_TEXT = { sample: 'ask Claude (uses your account or API key)', artifact: 'publish new versions of itself', db: 'keep a document store in this workspace', downloads: 'hand you files to save', user: 'know who is viewing', room: 'talk to other open copies of itself' };
const DEFAULT_CAPS = { sample: { images: true }, artifact: {}, db: {} };
let BRIDGE_SRC = window.CLAUDE_BRIDGE_SRC || null;
async function bridgeSrc() {
  if (BRIDGE_SRC) return BRIDGE_SRC;
  try { BRIDGE_SRC = await (await fetch('bridge.js')).text(); } catch { BRIDGE_SRC = ''; }
  return BRIDGE_SRC;
}
const ART_SKELETON = '<style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>';
function wrapFragment(fragment, bridge, theme) {
  const b = `<script>${bridge.replace(/<\/script/g, '<\\/script')}<\/script>`;
  if (/^\s*<!doctype/i.test(fragment)) return fragment.replace(/<head[^>]*>/i, m => m + b);
  return `<!doctype html><html${theme ? ` data-theme="${theme}"` : ''}><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">${ART_SKELETON}${b}</head><body>\n${fragment}\n</body></html>`;
}
const shaShort = async s => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(''); };
const artTheme = () => (S.theme === 'light' || S.theme === 'dark') ? S.theme : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const HOSTS = new Map();   // iframe contentWindow -> {n, port}

// versions: in the local build the daemon keeps them; in demo mode the node keeps the last few in S
async function artPublish(n, { html, files } = {}, capabilities) {
  if (DAEMON) {
    const r = await fetch(`/api/artifact/${n.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html, files, capabilities, ifMatch: n.head ?? null }) });
    const j = await r.json();
    if (!r.ok) throw { code: j.error?.code || 'upstream_error', message: j.error?.message || 'publish failed' };
    n.head = j.version; n.versions = j.meta.versions.slice(-30); n.url = j.url;
    if (capabilities) n.capabilities = capabilities;
    delete n.html; dirty(); return { version: j.version, changed: true, shas: {} };
  }
  const src = html ?? (files ? (typeof files['index.html'] === 'string' ? files['index.html'] : files['index.html']?.text) ?? n.html : n.html);
  if (files) { n.files = { ...(n.files || {}) }; for (const [p, v] of Object.entries(files)) { if (v == null || v.delete) delete n.files[p]; else n.files[p] = typeof v === 'string' ? v : v.text ?? ''; } }
  const sha = await shaShort(src || '');
  n.versions = [...(n.versions || []).filter(v => v.sha !== sha), { sha, at: new Date().toISOString().slice(0, 19), html: src }].slice(-8);
  n.html = src; n.head = sha; if (capabilities) n.capabilities = capabilities; dirty();
  return { version: sha, changed: true, shas: {} };
}
async function artSource(n, sha) {
  if (n.block) return blockOf(n)?.code || '';
  if (!DAEMON) { const v = sha && (n.versions || []).find(v => v.sha === sha); return v ? v.html : (n.html || ''); }
  const r = await fetch(`/api/artifact/${n.id}${sha ? '?v=' + sha : ''}`); const j = await r.json();
  const c = j.content; if (!c) return n.html || '';
  return c.kind === 'page' ? c.html : (c.files['index.html']?.text || '');
}
async function artMount(n, L) {
  const f = L.frame; if (!f) return;
  f.removeAttribute('srcdoc'); f.removeAttribute('src');
  L.hello = false; L.notice.hidden = true; L.notice.textContent = '';
  if (n.block) {   // a block card: the page's block is the source, in an opaque-origin frame in both modes
    const b = blockOf(n); L.blockCode = b?.code;
    if (!b) { L.notice.hidden = false; L.notice.textContent = blockMissing(n); return; }
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock allow-popups allow-modals');
    f.srcdoc = wrapFragment(b.code, await bridgeSrc(), artTheme());
  } else if (DAEMON) {
    if (n.file) { try { await artFromFile(n, L); } catch (e) { L.notice.hidden = false; L.notice.textContent = 'Cannot read ' + n.file + ': ' + (e?.message || e); return; } }
    if (!n.head && n.html) { try { await artPublish(n, { html: n.html }); } catch {} }
    if (!n.head) { L.notice.hidden = false; L.notice.textContent = 'Empty artifact. Publish a page from the assistant or the palette.'; return; }
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups allow-modals');
    f.src = `${INFO.artifactOrigin}/a/${n.id}/${n.head}/?theme=${artTheme()}`;
  } else {
    if (!n.html) { L.notice.hidden = false; L.notice.textContent = 'Empty artifact. Publish a page from the assistant or the palette.'; return; }
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock allow-popups allow-modals');
    f.srcdoc = wrapFragment(n.html, await bridgeSrc(), artTheme());
  }
  clearTimeout(L.helloT);
  L.helloT = setTimeout(() => { if (!L.hello && live[n.id] === L) { L.notice.hidden = false; L.notice.textContent = window.CANVAS_HOSTED
    ? 'The page did not start. On claude.ai the viewer blocks frames inside an artifact; artifact nodes run on the self-hosted Workbench.'
    : 'The page did not answer the bridge within 6 s. It still runs, but window.claude.use() resolves null for it.'; } }, 6000);
}
function mountArtifact(n, L) {
  n.capabilities = n.capabilities || { ...DEFAULT_CAPS }; n.grants = n.grants || {}; n.db = n.db || { docs: {} };
  const f = el('iframe', 'art-frame'); f.title = n.name; f.setAttribute('referrerpolicy', 'no-referrer');
  const notice = el('div', 'art-notice'); notice.hidden = true;
  L.frame = f; L.notice = notice; L.body.append(f, notice);
  f.addEventListener('load', () => { f.contentWindow && HOSTS.set(f.contentWindow, { n, L }); });
  artMount(n, L);
  if (n.file) artWatch(n);
}
// The host side of the bridge: one listener; the frame introduces itself with a port.
window.addEventListener('message', ev => {
  const d = ev.data; if (!d || d.claude !== 'hello' || !ev.ports?.[0]) return;
  let rec = HOSTS.get(ev.source);
  if (!rec) { for (const n of nodeList()) if (n.kind === 'artifact' && live[n.id]?.frame?.contentWindow === ev.source) { rec = { n, L: live[n.id] }; HOSTS.set(ev.source, rec); } }
  if (!rec) return;
  const { n, L } = rec; const port = ev.ports[0]; L.port = port; L.hello = true; L.notice.hidden = true; clearTimeout(L.helloT);
  const served = [...new Set([...Object.keys(n.capabilities || {}).filter(c => CAPS_ALL.includes(c) || c === 'self'), 'permissions', 'user'])];
  if (served.includes('artifact')) served.push('self');
  port.onmessage = e => hostCall(n, L, port, e.data);
  port.postMessage({ t: 'hello', contract: '0.2.75', served, keys: { leader: leaderKeyName() } });   // keys: the page hands the leader back (DESIGN §6.4)
  activity(n.id);
});
const LIVE_CALLS = new Map();  // `${node}:${id}` -> {cancel, ...}
async function hostCall(n, L, port, m) {
  if (!m || typeof m !== 'object') return;
  const key = n.id + ':' + m.id;
  if (m.t === 'cancel') { LIVE_CALLS.get(key)?.cancel?.(); LIVE_CALLS.delete(key); return; }
  if (m.t === 'key') { if (m.key === 'leader') { leaveCard(L.frame); leaderOpen(); } return; }
  if (m.t === 'tool_result' || m.t === 'tool_error') { const c = LIVE_CALLS.get(key); c?.tools?.get(m.callId)?.(m); return; }
  if (m.t !== 'call') return;
  const ok = value => port.postMessage({ t: 'ok', id: m.id, value });
  const err = error => port.postMessage({ t: 'err', id: m.id, error });
  const ev = (event, data) => port.postMessage({ t: 'ev', id: m.id, event, data });
  const cap = m.cap === 'self' ? 'artifact' : m.cap;
  try {
    if (!(cap in (n.capabilities || {})) && !['permissions', 'user'].includes(cap)) return err({ code: 'not_declared', message: `this artifact does not declare ${cap}` });
    if (cap === 'permissions') return ok(await hostPermissions(n, m.method, m.args));
    if (cap === 'user') return ok(({ id: 'local', me: { id: 'local', name: 'you', isOwner: true }, isOwner: true, canEdit: true, can: true, profiles: [], search: [] })[m.method]);
    if (cap === 'sample') {
      if (m.method === 'limits') { const s = await getSample(); return ok(s ? await s.limits?.() : null); }
      if (!(await grant(n, 'sample'))) return err({ code: 'not_granted', message: 'the user did not allow this artifact to use Claude' });
      const sample = await getSample(); if (!sample) return err({ code: 'sampling_disabled', message: SAMPLE_OFF });
      const ctl = new AbortController(); const rec = { cancel: () => ctl.abort(), tools: new Map() }; LIVE_CALLS.set(key, rec);
      const a = m.args || {};
      const tools = a.tools?.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: (input, ctx) => new Promise((res, rej) => {
        const callId = uid('t'); rec.tools.set(callId, r => { rec.tools.delete(callId); r.t === 'tool_result' ? res(r.result) : rej(new Error(r.message)); });
        ev('tool', { callId, name: t.name, input }); ctx.signal?.addEventListener('abort', () => { rec.tools.delete(callId); rej(new Error('cancelled')); });
      }) }));
      activity(n.id);
      try { const r = await sample(a.input, { modelTier: a.modelTier, model: a.model, effort: a.effort, images: a.images, tools, signal: ctl.signal, onText: ({ text }) => ev('text', { text }) }); ok(r); }
      catch (e) { err({ code: e?.code || 'upstream_error', message: e?.message || String(e), ...(e?.text ? { text: e.text } : {}) }); }
      finally { LIVE_CALLS.delete(key); }
      return;
    }
    if (cap === 'artifact') {
      if (m.method !== 'publish') return err({ code: 'invalid_request', message: 'unknown method' });
      if (!(await grant(n, 'artifact'))) return err({ code: 'not_granted', message: 'not allowed' });
      const r = await artPublish(n, m.args || {}); ok(r); toast(`${n.name} published version ${r.version.slice(0, 8)}`); updateTitle(n); setTimeout(() => artMount(n, L), 50); return;
    }
    if (cap === 'db') return dbCall(n, L, port, m, ok, err, ev, key);
    if (cap === 'downloads') {
      if (window.CANVAS_HOSTED) return err({ code: 'not_allowed', message: 'downloads are blocked in the hosted demo' });
      const { filename, data } = m.args || {}; const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data)]);
      const a = el('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'download'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); return ok({ saved: true });
    }
    if (cap === 'room') {
      if (m.method === 'emit') { for (const [w, r] of HOSTS) if (r.n.id === n.id && r.L.port && r.L !== L) r.L.port.postMessage({ t: 'ev', id: 'room', event: 'msg', data: { type: m.args.type, payload: m.args.payload, from: 'local' } }); return ok(true); }
      return ok(m.method === 'presence' ? [{ id: 'local' }] : true);
    }
    err({ code: 'capability_disabled', message: cap + ' is not served here' });
  } catch (e) { err({ code: e?.code || 'upstream_error', message: e?.message || String(e) }); }
}
// grants: asked once per capability per artifact, in the Workbench (never inside the frame)
const GRANT_Q = [];
function grant(n, cap) {
  if (n.grants[cap] === 'granted') return Promise.resolve(true);
  if (n.grants[cap] === 'denied') return Promise.resolve(false);
  return new Promise(res => { GRANT_Q.push({ n, cap, res }); if (GRANT_Q.length === 1) showGrant(); });
}
function showGrant() {
  const g = GRANT_Q[0]; if (!g) return;
  const box = $('#grant'); box.hidden = false;
  $('#grant-text', box).textContent = `Artifact "${g.n.name}" wants to ${CAP_TEXT[g.cap] || 'use ' + g.cap}.`;
  const finish = v => { g.n.grants[g.cap] = v ? 'granted' : 'denied'; dirty(); GRANT_Q.shift(); box.hidden = true; g.res(v); if (GRANT_Q.length) showGrant(); };
  $('#grant-allow').onclick = () => finish(true); $('#grant-deny').onclick = () => finish(false);
  $('#grant-allow').focus();
}
async function hostPermissions(n, method, args) {
  const st = name => n.grants[name === 'self' ? 'artifact' : name] || 'prompt';
  if (method === 'state') return st(args.name);
  if (method === 'request') { const out = {}; for (const name of args.names || []) out[name] = (await grant(n, name === 'self' ? 'artifact' : name)) ? 'granted' : 'denied'; return out; }
  if (method === 'manage') { artifactPermissions(n); return true; }
  return null;
}
function artifactPermissions(n) {
  const items = CAPS_ALL.filter(c => c !== 'permissions').map(c => ({ l: `${n.grants[c] === 'granted' ? '✓' : n.grants[c] === 'denied' ? '✕' : '·'} ${c}: ${CAP_TEXT[c] || c}${c in (n.capabilities || {}) ? '' : ' (not declared)'}`, run: () => { n.grants[c] = n.grants[c] === 'granted' ? 'denied' : 'granted'; dirty(); toast(`${n.name}: ${c} ${n.grants[c]}`); } }));
  openPicker(`Permissions for ${n.name}: pick one to toggle`, items);
}
// db: slash paths; even segments are documents. Query evaluation in the host; persistence with the board (demo) or
// in the daemon's per-artifact store (local build). Snapshots are pushed to watchers after every write.
const DB_WATCH = new Map();  // node id -> Set of {kind, path, q, push}
function dbSave(n) { dirty(); if (DAEMON) { clearTimeout(n._dbT); n._dbT = setTimeout(() => dbPut(n), 400); } }
function dbPut(n) {   // deferred while saving is paused (signed out, conflict); errors show and retry
  if (SAVE.paused) return void SAVE.dbQueue.add(n);
  fetch(`/api/db/${n.id}`, { method: 'PUT', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n.db) })
    .then(r => {
      if (r.type === 'opaqueredirect' || r.status === 401) { SAVE.dbQueue.add(n); return netSet('signed_out'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      n._dbErr = 0; if (!SAVE.err) barClear('save');
    })
    .catch(e => { bar('save', 'Data for ' + n.name + ' not saved: ' + e.message + '. Retrying…'); clearTimeout(n._dbT); n._dbT = setTimeout(() => dbPut(n), backoff(n._dbErr = (n._dbErr || 0) + 1)); netKick(); });
}
function dbFlush() { const q = [...SAVE.dbQueue]; SAVE.dbQueue.clear(); q.forEach(dbPut); }
const dbGetField = (d, f) => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
function dbQuery(n, path, q) {
  const prefix = path.replace(/\/+$/, '') + '/';
  let rows = Object.entries(n.db.docs).filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(([p, data]) => ({ path: p, data }));
  for (const [f, op, v] of q?.where || []) rows = rows.filter(r => { const x = dbGetField(r.data, f); return op === '==' ? x === v : op === '!=' ? x !== v : op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '>=' ? x >= v : op === 'in' ? (v || []).includes(x) : op === 'array-contains' ? Array.isArray(x) && x.includes(v) : true; });
  if (q?.orderBy) { const [f, dir] = q.orderBy; rows.sort((a, b) => { const x = dbGetField(a.data, f), y = dbGetField(b.data, f); return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); }); }
  if (q?.limit) rows = rows.slice(0, q.limit);
  return rows;
}
function dbNotify(n, path) {
  for (const w of DB_WATCH.get(n.id) || []) {
    if (w.kind === 'doc' && w.path === path) w.push('doc', { path, data: n.db.docs[path] ?? null });
    if (w.kind === 'query' && path.startsWith(w.path.replace(/\/+$/, '') + '/')) w.push('query', { docs: dbQuery(n, w.path, w.q) });
  }
}
function dbCall(n, L, port, m, ok, err, ev, key) {
  const a = m.args || {}; const path = String(a.path || '').replace(/^\/+|\/+$/g, '');
  const segs = path.split('/').filter(Boolean);
  if (m.method === 'get') return ok(n.db.docs[path] ?? null);
  if (['set', 'update', 'delete'].includes(m.method)) {
    if (segs.length % 2) return err({ code: 'invalid_path', message: 'a document path has an even number of segments' });
    if (m.method === 'set') n.db.docs[path] = structuredClone(a.data || {});
    else if (m.method === 'update') { if (!(path in n.db.docs)) return err({ code: 'not_found', message: 'no document at ' + path }); Object.assign(n.db.docs[path], structuredClone(a.data || {})); }
    else delete n.db.docs[path];
    dbSave(n); dbNotify(n, path); return ok(null);
  }
  if (m.method === 'query') return ok(dbQuery(n, path, a.q));
  if (m.method === 'watchDoc' || m.method === 'watchQuery') {
    const w = { kind: m.method === 'watchDoc' ? 'doc' : 'query', path, q: a.q, push: ev };
    if (!DB_WATCH.has(n.id)) DB_WATCH.set(n.id, new Set()); DB_WATCH.get(n.id).add(w);
    LIVE_CALLS.set(key, { cancel: () => DB_WATCH.get(n.id)?.delete(w) });
    return w.kind === 'doc' ? ev('doc', { path, data: n.db.docs[path] ?? null }) : ev('query', { docs: dbQuery(n, path, a.q) });
  }
  err({ code: 'invalid_request', message: 'unknown db method ' + m.method });
}
const ART_TEMPLATE = `<title>Hello Workbench</title>
<style>
:root{--bg:#fff;--fg:#000;--accent:#0031a9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#000;--fg:#fff;--accent:#2fafff}}
:root[data-theme="dark"]{--bg:#000;--fg:#fff;--accent:#2fafff}
body{background:var(--bg);color:var(--fg);font-family:system-ui;padding:16px}
button{font:inherit;padding:6px 10px}
#out{white-space:pre-wrap;margin-top:12px}
</style>
<h1>Hello from an artifact</h1>
<p>This page runs in a sandboxed frame. It can only reach the outside through <code>claude.use()</code>.</p>
<button id="ask">Ask Claude for a haiku</button> <button id="count">Count (db)</button>
<div id="out"></div>
<script>
const out = document.getElementById('out');
document.getElementById('ask').onclick = async () => {
  const sample = await claude.use('sample');
  if (!sample) { out.textContent = 'sample is not served here'; return; }
  out.textContent = '…';
  try { await sample('Write a haiku about a workbench.', { modelTier: 'quick', onText: ({ text }) => { out.textContent = text; } }); }
  catch (e) { out.textContent = 'failed: ' + e.code; }
};
document.getElementById('count').onclick = async () => {
  const db = await claude.use('db'); if (!db) { out.textContent = 'db is not served here'; return; }
  const ref = db.doc('data/counter'); const snap = await ref.get(); const n = (snap.data()?.n || 0) + 1;
  await ref.set({ n }); out.textContent = 'count = ' + n + ' (kept in this workspace)';
};
<\/script>`;
async function newArtifact(name, html, capabilities) {
  if (VIEW !== 'canvas') setView('canvas');
  const c = viewCenterWorld(), w = 640, h = 480;
  const n = addNode({ kind: 'artifact', name: clean(name || 'artifact'), ...freeSpot(c.x - w / 2, c.y - h / 2, w, h), w, h, html: html ?? ART_TEMPLATE, capabilities: capabilities || { ...DEFAULT_CAPS }, grants: {}, db: { docs: {} } });
  try { await artPublish(n, { html: n.html }, n.capabilities); artMount(n, live[n.id]); } catch (e) { toast('Publish failed: ' + (e.message || e)); }
  jumpNode(n); return n;
}
function artifactSourcePage(n) {
  const name = n.name + '.html';
  let p = findPage(name);
  artSource(n).then(src => {
    if (!p) { p = openPage(name, n, true); const v = live[p.id].view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: src } }); p.artifactOf = n.id; }
    else if (live[p.id]?.view && !live[p.id].view.state.doc.length) live[p.id].view.dispatch({ changes: { from: 0, insert: src } });
    p.artifactOf = n.id; if (!S.edges.some(e => e.from === n.id && e.to === p.id)) { S.edges.push({ id: uid('e'), from: n.id, to: p.id, type: 'ref' }); renderLinks(); }
    jumpNode(p); dirty(); toast('Edit the HTML here, then run "Artifact: publish from this page".');
  });
}
async function publishFromPage(p) {
  const n = S.nodes[p.artifactOf] || nodeList().find(x => x.kind === 'artifact' && x.name + '.html' === p.name); if (!n) return toast('This page is not the source of an artifact.');
  syncBuffers();
  try { const r = await artPublish(n, { html: p.text || '' }); toast(`${n.name}: version ${r.version.slice(0, 8)} published`); updateTitle(n); artMount(n, live[n.id]); }
  catch (e) { toast('Publish failed: ' + (e.message || e)); }
}
async function artifactVersions(n) {
  const list = (n.versions || []).slice().reverse();
  if (!list.length) return toast('No versions yet.');
  openPicker(`${n.name}: versions (head ${String(n.head).slice(0, 8)})`, list.map(v => ({ l: `${v.sha === n.head ? '● ' : '○ '}${v.sha.slice(0, 8)} · ${v.at.replace('T', ' ')}`, run: async () => { if (v.sha === n.head) return; const src = await artSource(n, v.sha); await artPublish(n, { html: src }); artMount(n, live[n.id]); toast(`Rolled ${n.name} to ${v.sha.slice(0, 8)} (as a new version)`); } })));
}
async function openWorkbenchInside() {
  if (!DAEMON) return toast('Needs the local build: the demo page is 1.3 MB and cannot embed itself here.');
  const r = await fetch(`/api/cat?path=${encodeURIComponent(INFO.dist)}&limit=6000000`); const j = await r.json();
  if (!r.ok || j.text?.startsWith('(binary')) return toast('dist/canvas-workbench.html not found. Run python3 tools/build-artifact.py first.');
  const n = await newArtifact('workbench-inside', j.text, { sample: { images: true }, artifact: {}, db: {} }); n.w = 1100; n.h = 720; place(n); jumpNode(n);
}
AGENT_TOOLS.push(
  { name: 'publish_artifact', description: 'Create or update a Claude artifact node: a self-contained HTML page (fragment: no doctype/html/head/body; first element a <title>; CSS tokens on :root with a dark variant; scripts only inline or from cdnjs/jsdelivr/unpkg; no fetch) that may call window.claude.use("sample"|"db"|"artifact"). name identifies the node; an existing artifact of that name gets a new version.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, html: { type: 'string' }, capabilities: { type: 'object', description: 'e.g. {"sample":{"images":true},"db":{}}' } }, required: ['name', 'html'] },
    run: async ({ name, html, capabilities }) => {
      const ex = nodeList().find(x => x.kind === 'artifact' && x.name.toLowerCase() === str(name).toLowerCase());
      if (ex?.block) throw new Error(`${pathOf(ex.id)} shows a block of a page; edit the block with write_page instead`);
      if (ex) { const r = await artPublish(ex, { html: str(html) }, capabilities); artMount(ex, live[ex.id]); pulse(ex.id); return `${pathOf(ex.id)} now at version ${r.version.slice(0, 8)}`; }
      const n = await newArtifact(str(name), str(html), capabilities); return `created artifact ${pathOf(n.id)}`;
    } },
  { name: 'read_artifact', description: 'Read the HTML source of an artifact node by path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path }) => { const n = findNode(path); if (!n || n.kind !== 'artifact') throw new Error('no artifact at ' + path); return (await artSource(n)).slice(0, 60000); } },
);
cmd('New artifact (hello page)', () => newArtifact('artifact' + (nodeList().filter(n => n.kind === 'artifact').length + 1)));
cmd('New artifact from a file… (any agent writes the HTML, the node reloads)', () => askName('HTML file path', INFO?.notes ? INFO.notes + '/' : '~/', f => newArtifactFromFile(f)), '', () => DAEMON);
cmd('New artifact from HTML…', () => askName('Artifact name', '', name => { const n = newArtifact(name, '<title>' + name + '</title>\n<h1>' + name + '</h1>'); setTimeout(() => n.then?.(a => artifactSourcePage(a)), 300); }));
cmd('Artifact: edit the source page', () => artifactSourcePage(S.nodes[activeId]), '', () => S.nodes[activeId]?.kind === 'artifact' && !S.nodes[activeId].block);
cmd('Artifact: publish from this page', () => publishFromPage(S.nodes[activeId]), '', () => S.nodes[activeId]?.kind === 'buffer' && /\.html$/.test(S.nodes[activeId].name));
cmd('Artifact: reload', () => artMount(S.nodes[activeId], live[activeId]), '', () => S.nodes[activeId]?.kind === 'artifact');
cmd('Artifact: versions…', () => artifactVersions(S.nodes[activeId]), '', () => S.nodes[activeId]?.kind === 'artifact' && !S.nodes[activeId].block);
cmd('Artifact: permissions…', () => artifactPermissions(S.nodes[activeId]), '', () => S.nodes[activeId]?.kind === 'artifact');
cmd('Artifact: open the Workbench demo inside itself', () => openWorkbenchInside(), '', () => DAEMON && !!INFO?.dist);   // wb-web reports dist:null until M5
cmd('Artifact: paste HTML from the clipboard as a new artifact', async () => { try { const t = await navigator.clipboard.readText(); if (!t.trim()) return toast('Clipboard is empty.'); askName('Artifact name', 'pasted', name => newArtifact(name, t)); } catch { toast('Clipboard read is not allowed here. Use "New artifact from HTML…" and paste into the page.'); } });

// ------------------------------------------------------------------ block cards: ```html fences in a page as live cards
// A fenced html block in a page can be torn out onto the canvas. The card is an artifact node bound to the block by
// {page, id}: it keeps no source of its own, shows the block in an opaque-origin srcdoc frame and reloads when the block
// changes. The info string carries the attributes, as Pandoc reads them: ```html {#chart card=520x430}. Step H0 of the
// hypernotes plan (docs/HYPERNOTES.md); nothing in a block runs outside its frame.
function blockAttrs(s) {
  const a = {};
  for (const t of String(s || '').trim().split(/\s+/)) { if (t[0] === '#') a.id = t.slice(1); else { const i = t.indexOf('='); if (i > 0) a[t.slice(0, i)] = t.slice(i + 1); } }
  return a;
}
// The html fences of TEXT: {id, attrs, from (fence line start), head (fence line end), to (block end), code}.
function htmlBlocks(text) {
  const out = [];
  if (!/^ {0,3}(`{3,}|~{3,})[ \t]*html\b/mi.test(text)) return out;
  let pos = 0, open = null;
  const done = (to, code) => { if (open.lang === 'html') { const attrs = blockAttrs(open.attrs); out.push({ id: attrs.id || null, attrs, from: open.from, head: open.head, to, code }); } open = null; };
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (!open) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s{`~]*)[ \t]*(?:\{([^}\n]*)\})?/);
      if (m) open = { fence: m[1], lang: m[2].toLowerCase(), attrs: m[3], from: pos, head: end };
    } else {
      const c = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (c && c[1][0] === open.fence[0] && c[1].length >= open.fence.length) done(end, text.slice(open.head + 1, pos).replace(/\n$/, ''));
    }
    pos = end + 1;
  }
  if (open) done(text.length, text.slice(open.head + 1));   // an unclosed fence runs to the end, as in CommonMark
  return out;
}
function blockOf(n) {
  const p = S.nodes[n.block?.page];
  return p ? htmlBlocks(pageText(p)).find(b => b.id === n.block.id) || null : null;
}
function blockMissing(n) {
  const p = S.nodes[n.block.page];
  return p ? `${p.name} has no html block #${n.block.id} now. Put it back, or close this card.` : 'The page this card came from is gone.';
}
function jumpBlock(n) {
  const p = S.nodes[n.block?.page], b = p && blockOf(n);
  if (!b) return toast(blockMissing(n));
  jumpBuffer(p, Math.min(b.head + 1, b.to));
}
// Tear the html block at POS of page P out as a card. A block without an id gets one in its info string first, so
// the card's address survives edits around it.
function tearOutBlock(p, pos) {
  const v = live[p.id]?.view; if (!v) { toast('Open the page first.'); return null; }
  const blocks = htmlBlocks(v.state.doc.toString()), b = blocks.find(b => pos >= b.from && pos <= b.to);
  if (!b) { toast('Put the cursor in a ```html block first.'); return null; }
  let id = b.id;
  if (!id) {
    const ids = new Set(blocks.map(x => x.id)); let k = 1; while (ids.has('block' + k)) k++; id = 'block' + k;
    const br = v.state.doc.sliceString(b.from, b.head).indexOf('{');
    v.dispatch({ changes: br >= 0 ? { from: b.from + br + 1, insert: '#' + id + ' ' } : { from: b.head, insert: ' {#' + id + '}' } });
  }
  return newBlockCard(p, id, b.attrs.card);
}
function newBlockCard(p, id, size) {
  if (VIEW !== 'canvas') setView('canvas');
  const m = /^(\d+)x(\d+)$/.exec(size || ''), w = clamp(m ? +m[1] : 480, 200, 1600), h = clamp(m ? +m[2] : 360, 120, 1200);
  const k = nodeList().filter(x => x.block?.page === p.id).length;
  const n = addNode({ kind: 'artifact', name: clean(p.name + '-' + id), ...freeSpot(p.x + p.w + 60, p.y + k * 40, w, h), w, h, block: { page: p.id, id }, capabilities: { sample: { images: true }, db: {} }, grants: {}, db: { docs: {} } });
  S.edges.push({ id: uid('e'), from: p.id, to: n.id, type: 'ref' }); renderLinks(); dirty();
  jumpNode(n); return n;
}
// Every block card (of page PID, or of any page) whose block changed or vanished reloads.
function refreshBlockCards(pid) {
  for (const n of nodeList()) if (n.kind === 'artifact' && n.block && (!pid || n.block.page === pid) && live[n.id]?.frame && blockOf(n)?.code !== live[n.id].blockCode) artMount(n, live[n.id]);
}
// After an edit to page P settles, its block cards follow.
const BLOCK_T = new Map();
function blockCardsChanged(p) {
  clearTimeout(BLOCK_T.get(p.id));
  BLOCK_T.set(p.id, setTimeout(() => { BLOCK_T.delete(p.id); refreshBlockCards(p.id); }, 400));
}
AGENT_TOOLS.push(
  { name: 'tear_out_block', description: 'Put a ```html block of a page on the canvas as a live card. The card shows the block in a sandboxed frame (window.claude.use offers sample and db) and reloads whenever the block changes, so edit the block with write_page to change the card. block is the id from the info string (```html {#chart}) or the 1-based position among the page\'s html blocks; a block without an id gets one.',
    inputSchema: { type: 'object', properties: { page: { type: 'string', description: 'page path' }, block: { type: 'string' } }, required: ['page'] },
    run: async ({ page, block }) => {
      const p = findNode(str(page)); if (!p || p.kind !== 'buffer') throw new Error('no page at ' + page);
      const blocks = htmlBlocks(pageText(p)), want = str(block || '1');
      const b = blocks.find(x => x.id === want) || (/^\d+$/.test(want) ? blocks[+want - 1] : null);
      if (!b) throw new Error(`${pathOf(p.id)} has no html block ${want} (it has ${blocks.length})`);
      const n = tearOutBlock(p, b.from); if (!n) throw new Error('could not tear out the block');
      return `created ${pathOf(n.id)}, showing ${pathOf(p.id)}#${n.block.id}`;
    } },
);
cmd('Page: tear out the html block at the cursor as a card', () => { const n = S.nodes[activeId]; tearOutBlock(n, live[n.id].view.state.selection.main.head); }, '', () => S.nodes[activeId]?.kind === 'buffer' && !!live[activeId]?.view);
cmd('Artifact: jump to its html block', () => jumpBlock(S.nodes[activeId]), '', () => !!S.nodes[activeId]?.block);

// ------------------------------------------------------------------ flashcards: a review view over cards from notes
// Cards are blocks in notes (card:: basic|reverse|cloze|type|pen|voice; back::; deck::), read through the daemon's index.
// Scheduling is FSRS-6 computed from an append-only review log (.reviews/<host>.jsonl via the daemon; the board in demo
// mode). No scheduling data is ever written into a note. Pen and voice are grading modes: produce the answer first.
const FSRS_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const FSRS = (() => {
  const W = FSRS_W, DECAY = -W[20], FACTOR = Math.pow(0.9, 1 / DECAY) - 1, DAY = 86400000;
  const R = (t, s) => (s <= 0 ? 0 : Math.pow(1 + FACTOR * t / s, DECAY));
  const ivl = (s, r) => Math.max(1, Math.round(s / FACTOR * (Math.pow(r, 1 / DECAY) - 1)));
  const initS = g => W[g - 1], initD = g => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
  const nextD = (d, g) => clamp(W[7] * initD(4) + (1 - W[7]) * (d + (-W[6] * (g - 3)) * (10 - d) / 9), 1, 10);
  const nextS = (d, s, r, g, sameDay) => {
    if (sameDay) return s * Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
    if (g === 1) return Math.min(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)), s);
    return s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1) + 1);
  };
  const state = reviews => {
    let st = null;
    for (const r of reviews) {
      const t = Date.parse(r.t);
      if (!st) { st = { d: initD(r.g), s: initS(r.g), last: t, n: 1, lapses: r.g === 1 ? 1 : 0 }; continue; }
      const el = (t - st.last) / DAY, sd = el < 1, r0 = sd ? 1 : R(el, st.s);
      st = { d: nextD(st.d, r.g), s: nextS(st.d, st.s, r0, r.g, sd), last: t, n: st.n + 1, lapses: st.lapses + (r.g === 1 ? 1 : 0) };
    }
    return st;
  };
  const preview = (st, now, ret) => { const o = {}; for (const g of [1, 2, 3, 4]) { let s; if (!st) s = initS(g); else { const el = (now - st.last) / DAY, sd = el < 1; s = nextS(st.d, st.s, sd ? 1 : R(el, st.s), g, sd); } o[g] = s < 1 ? 0 : ivl(s, ret); } return o; };
  return { R, ivl, state, preview, DAY };
})();
const SAMPLE_CARDS = [
  { id: 'c4f2a#^k3m9x2#fwd', file: 'roam/grc/vocab.md', line: 12, deck: 'grc/vocab', kind: 'basic', front: 'ἀρετή', back: 'excellence, virtue', extra: 'Aristotle, EN 1103a. Pen answer in Greek script is the point of this deck.', src: '## ἀρετή ^k3m9x2\ncard:: reverse\ndeck:: grc/vocab\nback:: excellence, virtue\nAristotle, EN 1103a. See [[Nicomachean Ethics notes#^q81ab]].' },
  { id: 'c4f2a#^k3m9x2#rev', file: 'roam/grc/vocab.md', line: 12, deck: 'grc/vocab', kind: 'reverse', front: 'excellence, virtue', back: 'ἀρετή', extra: 'Reverse card of the same block.', src: '## ἀρετή ^k3m9x2\ncard:: reverse          ; one block, two cards: #fwd and #rev\ndeck:: grc/vocab\nback:: excellence, virtue' },
  { id: 'c4f2a#^p01x7', file: 'roam/grc/vocab.md', line: 20, deck: 'grc/vocab', kind: 'basic', front: 'λόγος', back: 'word, reason, account', extra: '', src: '## λόγος ^p01x7\ncard:: basic\ndeck:: grc/vocab\nback:: word, reason, account' },
  { id: 'c4f2a#^a0r1s', file: 'roam/grc/grammar.md', line: 4, deck: 'grc/grammar', kind: 'type', front: 'aorist of λύω, 1 sg. active indicative', back: 'ἔλυσα', extra: 'Augment ε + stem λυ + σ + α.', src: '- aorist of λύω, 1 sg. active indicative ^a0r1s\n  card:: type\n  deck:: grc/grammar\n  back:: ἔλυσα\n  Augment ε + stem λυ + σ + α.' },
  { id: '7d3e5#^nx0m1#c1', file: 'roam/nixos/modules.md', line: 9, deck: 'nixos', kind: 'cloze', text: 'In a NixOS module, {{c1::mkIf}} guards a config block on a condition, and {{c2::mkEnableOption}} declares a boolean `enable` option.', cloze: 1, extra: 'From the anki-sync-server module notes.', src: '## NixOS module helpers ^nx0m1\ncard:: cloze\ndeck:: nixos\nIn a NixOS module, {{c1::mkIf}} guards a config block on a\ncondition, and {{c2::mkEnableOption}} declares a boolean\n`enable` option. Source: [[anki-sync-server module notes]]' },
  { id: '7d3e5#^nx0m1#c2', file: 'roam/nixos/modules.md', line: 9, deck: 'nixos', kind: 'cloze', text: 'In a NixOS module, {{c1::mkIf}} guards a config block on a condition, and {{c2::mkEnableOption}} declares a boolean `enable` option.', cloze: 2, extra: 'Second cloze of the same block.', src: '## NixOS module helpers ^nx0m1\ncard:: cloze            ; one block, two cards: #c1 and #c2' },
  { id: 'b8a2e#^fsrs1', file: 'roam/fsrs.md', line: 7, deck: 'workbench', kind: 'basic', front: 'FSRS: what does stability S mean?', back: 'The interval (days) at which the probability of recall falls to 90 %.', extra: 'R(t) = (1 + F·t/S)^(−w20)', src: '## FSRS: what does stability S mean? ^fsrs1\ncard:: basic\ndeck:: workbench\nback:: The interval (days) at which the probability of recall falls to 90 %.\nR(t) = (1 + F·t/S)^(−w20)' },
  { id: 'b8a2e#^rvlg0', file: 'roam/fsrs.md', line: 14, deck: 'workbench', kind: 'basic', front: 'Which Anki table holds the review history?', back: 'revlog', extra: 'Columns: id (ms), cid, usn, ease 1–4, ivl, lastIvl, factor, time, type.', src: '## Which Anki table holds the review history? ^rvlg0\ncard:: basic\ndeck:: workbench\nback:: revlog' },
  { id: 'e07f3#^bx9dy', file: 'roam/rust/ownership.md', line: 30, deck: 'rust', kind: 'basic', front: 'Rust: what does `Box<dyn Trait>` give you that `impl Trait` does not?', back: 'Dynamic dispatch and a single concrete type: heterogeneous collections and runtime choice of implementation.', extra: '', src: '## Rust: what does `Box<dyn Trait>` give you that `impl Trait` does not? ^bx9dy\ncard:: basic\ndeck:: rust\nback:: Dynamic dispatch and a single concrete type: heterogeneous collections and runtime choice of implementation.' },
  { id: 'f912a#^csw01', file: 'roam/maths/analysis.md', line: 3, deck: 'maths', kind: 'pen', front: 'State the Cauchy–Schwarz inequality', back: '|⟨u, v⟩| ≤ ‖u‖ · ‖v‖', extra: 'Equality iff u and v are linearly dependent. Write it by hand.', src: '## State the Cauchy–Schwarz inequality ^csw01\ncard:: pen              ; default answer mode for this card\ndeck:: maths\nback:: |⟨u, v⟩| ≤ ‖u‖ · ‖v‖\nEquality iff u and v are linearly dependent.' },
];
const RV = { cards: [], log: [], mode: 'basic', cur: null, revealed: false, ret: 0.9, shownAt: 0, undo: [], deck: 'all', done: 0, ink: [], drawing: false, loaded: false, touched: false, source: '' };
const rvAnswer = c => (c.kind === 'cloze' ? ([...String(c.text || '').matchAll(/\{\{c(\d+)::(.*?)\}\}/g)].find(m => +m[1] === c.cloze)?.[2] || '') : c.back || '');
const rvFront = c => (c.kind === 'cloze' ? c.text : c.front);
function rvReviewsFor(id) { const out = []; for (const r of RV.log) { if (r.card !== id) continue; if (r.g === 0) { out.pop(); continue; } if (r.g < 0) continue; out.push(r); } return out; }
function rvFlags(id) { let f = {}; for (const r of RV.log) { if (r.card !== id) continue; if (r.g === -1) f.suspended = true; if (r.g === -2) f.buried = r.t; if (r.g === 0) f = {}; } return f; }
async function rvLoad(force) {
  if (RV.loaded && !force) return;
  RV.cards = SAMPLE_CARDS; RV.log = S.reviews || []; RV.source = 'sample deck (demo)';
  if (DAEMON) {
    try {
      const [c, r] = await Promise.all([fetch('/api/cards').then(x => x.json()), fetch('/api/reviews').then(x => x.json())]);
      if (c.cards?.length) { RV.cards = c.cards.filter(x => x.status !== 'retired').map(x => ({ ...x, src: x.src || `${x.title}\n${Object.entries(x.props || {}).map(([k, v]) => `${k.toLowerCase()}:: ${v}`).join('\n')}\n${x.body || ''}`.trim() })); RV.source = c.root; }
      else RV.source = `sample deck (no cards under ${c.root}${c.exists ? '' : ', which does not exist'})`;
      RV.log = r.reviews || [];
    } catch { RV.source = 'sample deck (daemon unreachable)'; }
  }
  RV.loaded = true;
  const sel = $('#rv-deck'); const decks = ['all', ...new Set(RV.cards.map(c => c.deck || 'none'))];
  sel.replaceChildren(...decks.map(d => { const o = el('option'); o.value = d; o.textContent = d; return o; })); sel.value = decks.includes(RV.deck) ? RV.deck : 'all';
}
function rvQueue() {
  const now = Date.now();
  const list = RV.cards.filter(c => RV.deck === 'all' || (c.deck || 'none') === RV.deck).map(c => {
    const st = FSRS.state(rvReviewsFor(c.id)), fl = rvFlags(c.id);
    const due = st ? (st.s < 1 ? st.last + 600000 : st.last + FSRS.ivl(st.s, RV.ret) * FSRS.DAY) : 0;
    return { c, st, due, skip: fl.suspended || (fl.buried && now - Date.parse(fl.buried) < FSRS.DAY) };
  });
  return { list, dueNow: list.filter(x => !x.skip && (!x.st || x.due <= now)).sort((a, b) => (a.due || 0) - (b.due || 0)) };
}
const fmtIv = d => (d === 0 ? '<10 min' : d < 30 ? d + 'd' : d < 365 ? (d / 30).toFixed(1) + 'mo' : (d / 365).toFixed(1) + 'y');
function rvCloze(c, show) {
  const frag = document.createDocumentFragment(); const re = /\{\{c(\d+)::(.*?)\}\}/g; let last = 0, m;
  while ((m = re.exec(c.text))) { frag.append(c.text.slice(last, m.index)); const s = el('span'); if (+m[1] === c.cloze) { s.className = show ? 'cloze' : 'blank'; s.textContent = m[2]; } else s.textContent = m[2]; frag.append(s); last = re.lastIndex; }
  frag.append(c.text.slice(last)); return frag;
}
async function renderReview() {
  await rvLoad();
  const q = rvQueue();
  $('#rv-due').textContent = q.dueNow.length; $('#rv-new').textContent = q.list.filter(x => !x.st && !x.skip).length;
  $('#rv-learnt').textContent = q.list.filter(x => x.st && x.st.s >= 21).length; $('#rv-done').textContent = RV.done;
  $('#rv-source').textContent = RV.source;
  if (!RV.cur || !q.dueNow.some(x => x.c.id === RV.cur.id)) RV.cur = q.dueNow[0]?.c || null;
  RV.revealed = false; RV.shownAt = Date.now();
  ['#rv-answer', '#rv-diff', '#rv-ai', '#rv-done-box', '#rv-typebox', '#rv-inkwrap'].forEach(s => { $(s).hidden = true; });
  $('#rv-grades').hidden = true; $('#rv-reveal').hidden = false; $('#rv-gradeink').hidden = true;
  const c = RV.cur;
  if (!c) { $('#rv-face').textContent = ''; $('#rv-cdeck').textContent = RV.deck; $('#rv-ckind').textContent = ''; $('#rv-done-box').hidden = false; $('#rv-reveal').hidden = true; rvSide(null); return; }
  if (!RV.touched && ['type', 'pen', 'voice'].includes(c.kind)) rvSetMode(c.kind, true);
  $('#rv-cdeck').textContent = `${c.file} · ${c.deck || 'no deck'}`; $('#rv-ckind').textContent = `${c.kind} · ${c.id}`;
  const face = $('#rv-face'); face.replaceChildren(c.kind === 'cloze' ? rvCloze(c, false) : el('div', 'q', null));
  if (c.kind !== 'cloze') $('.q', face).textContent = c.front;
  if (RV.mode === 'type' || RV.mode === 'voice') { $('#rv-typebox').hidden = false; $('#rv-typein').value = ''; $('#rv-typein').placeholder = RV.mode === 'voice' ? 'hold 🎙 and say the answer, or type it' : 'type the answer, Enter to check'; if (RV.mode === 'type') setTimeout(() => $('#rv-typein').focus(), 0); }
  if (RV.mode === 'pen') { $('#rv-inkwrap').hidden = false; $('#rv-ghost').hidden = true; rvClearInk(); setTimeout(rvResizeInk, 0); }
  rvSide(c);
}
function rvSide(c) {
  $('#rv-src').textContent = c ? c.src : ''; $('#rv-srcfile').textContent = c ? `${c.file}${c.line ? ':' + c.line : ''}` : '';
  const kv = $('#rv-state'); kv.replaceChildren();
  if (c) {
    const st = FSRS.state(rvReviewsFor(c.id)); const rows = [];
    if (!st) rows.push(['state', 'new'], ['reviews', '0']);
    else { const r = FSRS.R((Date.now() - st.last) / FSRS.DAY, st.s); rows.push(['difficulty D', st.d.toFixed(2) + ' / 10'], ['stability S', st.s.toFixed(2) + ' d'], ['retrievability R', (r * 100).toFixed(1) + ' %'], ['interval @' + RV.ret.toFixed(2), fmtIv(FSRS.ivl(st.s, RV.ret))], ['reviews', st.n + (st.lapses ? ` (${st.lapses} lapses)` : '')], ['last', new Date(st.last).toLocaleString()]); }
    for (const [k, v] of rows) { const a = el('span'); a.textContent = k; const b = el('span'); b.textContent = v; kv.append(a, b); }
  }
  const lg = $('#rv-log'); lg.replaceChildren(...RV.log.slice(-12).reverse().map(l => { const p = el('pre'); p.textContent = JSON.stringify(l); return p; }));
  if (!RV.log.length) lg.innerHTML = '<pre class="muted">(empty: grade a card)</pre>';
  $('#rv-logfile').textContent = DAEMON ? '.reviews/<host>.jsonl via wb-web' : 'board (demo mode)';
}
function rvReveal() {
  const c = RV.cur; if (!c || RV.revealed) return; RV.revealed = true;
  if (c.kind === 'cloze') $('#rv-face').replaceChildren(rvCloze(c, true));
  const a = $('#rv-answer'); a.hidden = false; a.replaceChildren(); const b = el('div'); b.textContent = rvAnswer(c); a.append(b);
  if (c.extra) { const e = el('div', 'extra'); e.textContent = c.extra; a.append(e); }
  if (RV.mode === 'type' || RV.mode === 'voice') rvDiff($('#rv-typein').value, rvAnswer(c));
  if (RV.mode === 'pen') { $('#rv-ghost').hidden = false; $('#rv-ghost').textContent = rvAnswer(c); $('#rv-gradeink').hidden = false; }
  const pv = FSRS.preview(FSRS.state(rvReviewsFor(c.id)), Date.now(), RV.ret);
  for (const g of [1, 2, 3, 4]) $('#rv-iv' + g).textContent = fmtIv(pv[g]);
  $('#rv-reveal').hidden = true; $('#rv-grades').hidden = false;
}
const rvNorm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
function rvDiff(typed, truth) {
  const d = $('#rv-diff'); d.hidden = false; d.replaceChildren();
  const a = rvNorm(typed).split(/\s+/).filter(Boolean), b = rvNorm(truth).split(/\s+/).filter(Boolean);
  if (!a.length) { d.textContent = '(no answer given)'; return; }
  const bset = new Set(b), aset = new Set(a);
  for (const w of a) { const s = el('span', bset.has(w) ? 'ok' : 'no'); s.textContent = w + ' '; d.append(s); }
  for (const w of b) if (!aset.has(w)) { const s = el('span', 'miss'); s.textContent = '+' + w + ' '; d.append(s); }
  if (rvNorm(typed) === rvNorm(truth)) { const s = el('span', 'ok'); s.textContent = ' ✓ exact (accents ignored)'; d.append(s); }
}
async function rvAppend(lines) {
  if (DAEMON) { try { await fetch('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviews: lines }) }); } catch { toast('Could not write the review log; the daemon is unreachable.'); } }
  else { S.reviews = S.reviews || []; S.reviews.push(...lines); dirty(); }
  RV.log.push(...lines);
}
async function rvGrade(g) {
  const c = RV.cur; if (!c || !RV.revealed) return;
  const st = FSRS.state(rvReviewsFor(c.id));
  const line = { t: new Date().toISOString(), card: c.id, g, ms: Date.now() - RV.shownAt, mode: RV.mode, dev: DAEMON ? undefined : 'browser' };
  if (st) line.pre = { d: +st.d.toFixed(2), s: +st.s.toFixed(2), r: +FSRS.R((Date.now() - st.last) / FSRS.DAY, st.s).toFixed(3) };
  if (RV.mode === 'pen' && RV.ink.length) line.ink = { strokes: RV.ink.length, points: RV.ink.reduce((n, s) => n + s.length, 0) };
  if (!DAEMON) delete line.dev; else delete line.dev;
  await rvAppend([line]); RV.done++; RV.undo.push(c.id); RV.cur = null; renderReview();
}
async function rvUndo() { const id = RV.undo.pop(); if (!id) return; await rvAppend([{ t: new Date().toISOString(), card: id, g: 0, note: 'retract previous' }]); RV.done = Math.max(0, RV.done - 1); RV.cur = RV.cards.find(c => c.id === id); renderReview(); }
async function rvFlag(g) { if (!RV.cur) return; await rvAppend([{ t: new Date().toISOString(), card: RV.cur.id, g, note: g === -1 ? 'suspend' : 'bury' }]); RV.cur = null; renderReview(); }
function rvSetMode(m, auto) {
  RV.mode = m; if (!auto) RV.touched = true;
  $$('#rv-modes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#rv-modenote').textContent = { basic: 'Grade from memory.', type: 'Diff ignores accents and case.', pen: 'Write the answer; the back is overlaid after reveal. Claude can grade the ink.', voice: 'Hold 🎙 and say it; the transcript is diffed against the back.' }[m];
  $('#rv-mic').hidden = m !== 'voice';
}
// ink on the card
function rvResizeInk() { const cv = $('#rv-ink'); const r = cv.getBoundingClientRect(); if (!r.width) return; const dpr = devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr; cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); rvRedraw(); }
function rvRedraw() { const cv = $('#rv-ink'), g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); g.lineCap = g.lineJoin = 'round'; g.strokeStyle = cssVar('--accent') || '#0031a9'; for (const s of RV.ink) { g.beginPath(); s.forEach((p, i) => { g.lineWidth = 2 + p.p * 3; i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }); g.stroke(); } }
function rvClearInk() { RV.ink = []; rvRedraw(); }
function wireReview() {
  const cv = $('#rv-ink');
  const pt = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 }; };
  cv.addEventListener('pointerdown', e => { RV.drawing = true; cv.setPointerCapture(e.pointerId); RV.ink.push([pt(e)]); });
  cv.addEventListener('pointermove', e => { if (!RV.drawing) return; RV.ink[RV.ink.length - 1].push(pt(e)); rvRedraw(); });
  ['pointerup', 'pointercancel'].forEach(t => cv.addEventListener(t, () => { RV.drawing = false; }));
  $('#rv-clearink').onclick = rvClearInk;
  $('#rv-reveal').onclick = rvReveal;
  $$('#rv-grades button').forEach(b => b.onclick = () => rvGrade(+b.dataset.g));
  $$('#rv-modes button').forEach(b => b.onclick = () => { rvSetMode(b.dataset.mode); renderReview(); });
  $('#rv-undo').onclick = rvUndo; $('#rv-suspend').onclick = () => rvFlag(-1); $('#rv-bury').onclick = () => rvFlag(-2);
  $('#rv-ask').onclick = rvAsk; $('#rv-gradeink').onclick = rvGradeInk;
  $('#rv-reload').onclick = () => { RV.cur = null; rvLoad(true).then(renderReview); };
  $('#rv-typein').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); rvReveal(); e.target.blur(); } });
  $('#rv-deck').onchange = e => { RV.deck = e.target.value; RV.cur = null; renderReview(); };
  $('#rv-ret').oninput = e => { RV.ret = +e.target.value; $('#rv-retv').textContent = RV.ret.toFixed(2); if (RV.revealed) { const pv = FSRS.preview(FSRS.state(rvReviewsFor(RV.cur.id)), Date.now(), RV.ret); for (const g of [1, 2, 3, 4]) $('#rv-iv' + g).textContent = fmtIv(pv[g]); } rvSide(RV.cur); };
  $('#rv-open').onclick = () => rvOpenSource();
  const mic = $('#rv-mic');
  mic.addEventListener('pointerdown', e => { e.preventDefault(); mic.classList.add('on'); listen({ label: 'the answer', onUpdate: (f, i) => { $('#rv-typein').value = (f + ' ' + i).trim(); }, onEnd: f => { mic.classList.remove('on'); if (f) { $('#rv-typein').value = f; rvReveal(); } } }); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => mic.addEventListener(t, () => { if (VOICE.rec) stopListening(); }));
  window.addEventListener('resize', () => { if (VIEW === 'review') rvResizeInk(); });
}
function rvOpenSource() {
  const c = RV.cur; if (!c) return;
  if (DAEMON && !String(c.file).startsWith('roam/')) { const p = `${INFO.notes}/${c.file}`; RG.home = INFO.notes; setView('ranger'); rgGo(FS_PREFIX + p.replace(/\/[^/]*$/, ''), FS_PREFIX + p); return; }
  const name = (c.file || 'card').replace(/^roam\//, '').replace(/\.md$/, ''); const p = findPage(name) || openPage(name, null, true);
  if (live[p.id]?.view && !live[p.id].view.state.doc.length) live[p.id].view.dispatch({ changes: { from: 0, insert: `# ${name}\n\n${c.src}\n` } });
  jumpNode(p);
}
async function rvAsk() {
  const c = RV.cur; if (!c) return; const box = $('#rv-ai'); box.hidden = false;
  const sample = await getSample(); if (!sample) { box.textContent = DAEMON ? SAMPLE_OFF : 'The assistant needs a language model: Claude inside the hosted artifact on claude.ai, or a Workbench server that serves one.'; return; }
  box.textContent = 'Thinking…';
  try { await sample(`You are helping someone review a flashcard. Give context, one example and, if useful, a mnemonic, in at most 80 words. Plain text.\nFront: ${rvFront(c)}\nBack: ${rvAnswer(c)}\nExtra: ${c.extra || ''}\nSource: ${c.file}`, { modelTier: 'quick', onText: ({ text }) => { box.textContent = text; } }); }
  catch (e) { box.textContent = `Assistant unavailable (${e?.code || 'error'}).`; }
}
async function rvGradeInk() {
  const c = RV.cur; if (!c) return; const box = $('#rv-ai'); box.hidden = false;
  const sample = await canSeeImages(); if (!sample) { box.textContent = 'The model here cannot read images.'; return; }
  box.textContent = 'Looking at the ink…';
  try {
    const blob = await new Promise(res => $('#rv-ink').toBlob(res, 'image/png'));
    const r = await sample(`The image shows a handwritten answer to a flashcard. Expected answer: "${rvAnswer(c)}". Say in one line whether the handwriting matches, then propose a grade: Again, Hard, Good or Easy, with a five-word reason. The reviewer decides.`, { images: [blob], modelTier: 'quick' });
    box.textContent = r.text;
  } catch (e) { box.textContent = `Could not grade the ink (${e?.code || 'error'}).`; }
}
function reviewKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.key === ' ' || e.key === 'Enter') { rvReveal(); return true; }
  if (['1', '2', '3', '4'].includes(e.key) && RV.revealed) { rvGrade(+e.key); return true; }
  const map = { u: rvUndo, s: () => rvFlag(-1), b: () => rvFlag(-2), '?': rvAsk, o: rvOpenSource, r: () => $('#rv-reload').click() };
  if (map[e.key]) { map[e.key](); return true; }
  return false;
}
AGENT_TOOLS.push(
  { name: 'list_due', description: 'Flashcards due now (FSRS-6 over the review log), with their state. deck filters; limit defaults to 20.',
    inputSchema: { type: 'object', properties: { deck: { type: 'string' }, limit: { type: 'number' } } },
    run: async ({ deck, limit }) => { await rvLoad(); const q = rvQueue().dueNow.filter(x => !deck || x.c.deck === deck).slice(0, +limit || 20); return q.map(x => `${x.c.id} [${x.c.deck}] ${rvFront(x.c).slice(0, 80)} → ${rvAnswer(x.c).slice(0, 60)}${x.st ? ` (D ${x.st.d.toFixed(1)}, S ${x.st.s.toFixed(1)}d)` : ' (new)'}`).join('\n') || 'nothing due'; } },
  { name: 'create_flashcard', description: 'Write a flashcard as a block in a note: "## front ^anchor" with card::, deck::, back:: fields and the extra as body. In the local build it is appended to roam/inbox/cards.md (or path) and indexed; in demo mode to the page "cards". Use it after suggesting cards and getting agreement.',
    inputSchema: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' }, deck: { type: 'string' }, kind: { type: 'string', enum: ['basic', 'reverse', 'cloze', 'type', 'pen', 'voice'] }, extra: { type: 'string' }, source: { type: 'string', description: 'a [[link]] to the note it came from' }, path: { type: 'string' } }, required: ['front'] },
    run: async ({ front, back, deck, kind, extra, source, path }) => {
      const anchor = Math.random().toString(36).slice(2, 8);
      const block = `## ${str(front)} ^${anchor}\ncard:: ${kind || 'basic'}${deck ? `\ndeck:: ${deck}` : ''}${back ? `\nback:: ${str(back)}` : ''}${extra ? `\n${str(extra)}` : ''}${source ? `\nSource: ${source}` : ''}\n`;
      if (DAEMON) { const r = await fetch('/api/notes/append', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path || 'roam/inbox/cards.md', text: block, by: 'assistant' }) }); const j = await r.json(); RV.loaded = false; return `written to ${j.path} as ^${anchor}`; }
      const p = findPage('cards') || openPage('cards', null, true); const v = live[p.id].view; v.dispatch({ changes: { from: v.state.doc.length, insert: (v.state.doc.length ? '\n' : '# cards\n\n') + block } });
      SAMPLE_CARDS.push({ id: `${p.id}#^${anchor}`, file: 'cards', deck: deck || 'inbox', kind: kind || 'basic', front: str(front), back: str(back), extra: str(extra), src: block.trim() }); RV.loaded = false;
      return `added to page cards as ^${anchor}`;
    } },
);
cmd('View: Review (flashcards)', () => setView('review'), '@view.review');
cmd('Review: reload cards from notes', () => { RV.cur = null; rvLoad(true).then(renderReview); }, '', () => VIEW === 'review');

// ------------------------------------------------------------------ device mode: desktop | phone | tablet
// One breakpoint; a pen promotes the session to tablet whatever the width. Views read document.body.dataset.mode.
const MODE = { v: 'desktop' };
function setDeviceMode(v) { if (MODE.v === v) return; MODE.v = v; document.body.dataset.mode = v; if (v !== 'desktop' && VIEW === 'canvas' && !S?.modeToastShown) { toast(v === 'phone' ? 'Phone mode: navigator, pages, review and the assistant. The canvas is a viewer here.' : 'Tablet mode: a pen draws anywhere.', 5000); if (S) S.modeToastShown = true; } }
function detectMode() { setDeviceMode(penSeen ? 'tablet' : (innerWidth < 700 ? 'phone' : 'desktop')); }
window.addEventListener('resize', detectMode);
window.addEventListener('pointerdown', e => { if (e.pointerType === 'pen' && MODE.v !== 'tablet') { penSeen = true; setDeviceMode('tablet'); } }, true);

// ------------------------------------------------------------------ seed board
const PLANS = `# Canvas workspace

## Rollout

- Ship terminals as trees first. Ink second, recognition last.
- Code freeze on Friday before the demo.
  - Runbook lives in [[log]]; the build runs in [[ops]].
- DOING Wire the side-pane assistant into every view
- TODO Try the [[graph]] layout on a bigger board
- DONE Outline pages with backlinks

## Ideas

- Pipe a terminal selection into [[log]].
- Circle words with the pen; the circle follows its line.
- Jump with Ctrl-K (⌘K on a Mac): try \`plans › Rollout ¶2\`.
`;
function seed() {
  const real = DAEMON, sh = real ? 'pty' : 'fake', home = real ? undefined : '/home/me/projects/canvas';
  const B = { v: 5, nodes: {}, edges: [], strokes: [], shapes: [], views: {}, cam: { x: 0, y: 0, z: 0.5 }, fs: seedFs(), fresh: true };
  const add = n => { B.nodes[n.id] = n; };
  // canvas-workbench: a free folder (no gravity) with a nested box of machines
  add({ id: 'fCW', kind: 'frame', name: 'canvas-workbench', shape: 'folder', mode: 'free', x: 0, y: 0, w: 2130, h: 1100 });
  add({ id: 'fMach', kind: 'frame', name: 'machines', shape: 'box', mode: 'free', in: 'fCW', x: 1050, y: 70, w: 1040, h: 1000 });
  add({ id: 'plans', kind: 'buffer', name: 'plans', in: 'fCW', x: 40, y: 50, w: 560, h: 470, text: PLANS,
    anchors: [{ id: 'a-freeze', label: 'freeze', pos: PLANS.indexOf('freeze on'), quote: 'freeze on Friday', prefix: 'Code ' }] });
  add({ id: 'log', kind: 'buffer', name: 'log', in: 'fCW', x: 640, y: 50, w: 370, h: 400, text: '# log\n\n- Select text in [[ops]], then press ⇢ on ops.\n' });
  add({ id: 'agent', kind: 'agent', name: 'agent', in: 'fCW', x: 40, y: 560, w: 560, h: 400, tier: 'quick', turns: [],
    log: [{ t: 'note', text: 'I can read this board, run commands in the shells and REPLs, write pages, add nodes, sort things into folders and draw shapes. Try: "Put calc and what-if in a new packed folder called sums."' }] });
  add({ id: 'ops', kind: 'term', backend: sh, name: 'ops', in: 'fMach', x: 1090, y: 110, w: 640, h: 360, cwd: home, env: { PROJECT: 'canvas' } });
  add({ id: 'build', kind: 'term', backend: sh, name: 'build', in: 'fMach', x: 1090, y: 580, w: 440, h: 300, spawnFrom: 'ops', cwd: home, env: { PROJECT: 'canvas', STAGE: 'build' },
    spawnNote: real ? undefined : 'branched from ops: started in ' + home + ', inherited 1 env var(s)' });
  add({ id: 'logs', kind: 'term', backend: sh, name: 'logs', in: 'fMach', x: 1580, y: 580, w: 440, h: 300, spawnFrom: 'ops', cwd: real ? undefined : '/home/me', env: { PROJECT: 'canvas', STAGE: 'logs' },
    spawnNote: real ? undefined : 'branched from ops, then cd ~' });
  // scratch: a round folder in pack mode; items flow into rows
  add({ id: 'fScratch', kind: 'frame', name: 'scratch', shape: 'round', mode: 'pack', x: 0, y: 1220, w: 1240, h: 700 });
  add({ id: 'calc', kind: 'repl', lang: 'js', name: 'calc', in: 'fScratch', order: 0, x: 0, y: 1220, w: 580, h: 320, history: ['var base = 120', 'var rate = 1.07', 'base * rate'] });
  add({ id: 'whatif', kind: 'repl', lang: 'js', name: 'what-if', in: 'fScratch', order: 1, x: 0, y: 1220, w: 580, h: 300, spawnFrom: 'calc', replayFrom: 'calc',
    history: ['var base = 120', 'var rate = 1.07', 'base * rate', 'rate = 1.25', 'base * rate'] });
  add({ id: 'reading', kind: 'buffer', name: 'reading', in: 'fScratch', order: 2, x: 0, y: 1220, w: 420, h: 260, text: '# reading\n\n- Logseq: pages are outlines; links make the graph.\n- Excalidraw: sketch over everything, arrows bind.\n- LATER Compare with [[plans]] and the journal.\n' });
  add({ id: 'scratchpad', kind: 'buffer', name: 'scratchpad', in: 'fScratch', order: 3, x: 0, y: 1220, w: 340, h: 260, text: '# scratchpad\n\n- Drag any node in here: it joins the row where you drop it.\n- Drag it out again and it stays where you leave it.\n' });
  // homelab: a folder stacked into a deck; its items keep their places for when it is spread
  add({ id: 'fLab', kind: 'frame', name: 'homelab', shape: 'folder', mode: 'stack', prevMode: 'free', x: 2250, y: 40, w: 300, h: 230, openW: 1000, openH: 560 });
  add({ id: 'hosts', kind: 'buffer', name: 'hosts', in: 'fLab', order: 0, x: 2280, y: 70, w: 420, h: 500, text: '# hosts\n\n- nas: 192.0.2.12, zfs pool `tank`\n- pi: 192.0.2.20, runs the backups\n- TODO Rotate the backup key on [[pi]]\n' });
  add({ id: 'labsh', kind: 'term', backend: sh, name: 'sh', in: 'fLab', order: 1, x: 2740, y: 70, w: 480, h: 290, cwd: real ? undefined : '/home/me', env: { SITE: 'homelab' } });
  add({ id: 'backup', kind: 'agent', name: 'backup-rotation', in: 'fLab', order: 2, x: 2740, y: 390, w: 480, h: 180, tier: 'quick', turns: [],
    log: [{ t: 'note', text: 'Thread for the backup rotation. Ask me to check the hosts page or run something in sh.' }] });
  add({ id: 'journal', kind: 'buffer', name: TODAY, x: 2250, y: 640, w: 380, h: 470,
    text: `# ${TODAY}\n\n- v5: folders are containers on the canvas. Drag anything by its header into a folder.\n- Each folder is ◻ free, ▦ packed or ❐ stacked: the buttons sit on its tab.\n- Freeze reminder: ((plans#freeze))\n- TODO Drag [[reading]] out of scratch and drop it in canvas-workbench\n- TODO Spread the homelab deck (double-click it), then stack it again\n- DONE Sketch the [[canvas]] layout\n- ` });
  B.edges.push({ id: 'e1', from: 'ops', to: 'build', type: 'spawn' }, { id: 'e2', from: 'ops', to: 'logs', type: 'spawn' },
    { id: 'e3', from: 'calc', to: 'whatif', type: 'spawn' }, { id: 'e4', from: 'ops', to: 'log', type: 'pipe' }, { id: 'e5', from: 'labsh', to: 'hosts', type: 'pipe' });
  B.shapes.push(
    { id: 'sh-idea', type: 'ellipse', color: 'red', x: 1150, y: 940, w: 250, h: 92, text: 'cache the build?', seed: 11 },
    { id: 'sh-arrow', type: 'arrow', color: 'red', x1: 0, y1: 0, x2: 0, y2: 0, seed: 12, a: { id: 'sh-idea', dx: 125, dy: 0 }, b: { id: 'build', dx: 190, dy: 302 } },
    { id: 'sh-note', type: 'text', color: 'blue', x: 1770, y: 470, w: 250, h: 62, text: 'children inherit\nfolder + env', seed: 13 },
    { id: 'sh-q', type: 'diamond', color: 'ink', x: 2700, y: 700, w: 220, h: 110, text: 'ship it?', seed: 14 },
  );
  return B;
}
// Hand-drawn ellipse around "freeze on Friday", anchored to its line, made after layout so it fits the real glyphs.
function seedInk() {
  const L = live.plans; if (!L?.view) return;
  const v = L.view, i = v.state.doc.toString().indexOf('freeze on Friday'); if (i < 0) return;
  const a = v.coordsAtPos(i), b = v.coordsAtPos(i + 16); if (!a || !b) return;
  const r = viewport.getBoundingClientRect(), p0 = s2w(a.left - r.left, a.top - r.top), p1 = s2w(b.right - r.left, b.bottom - r.top);
  const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2, rx = (p1.x - p0.x) / 2 + 12, ry = (p1.y - p0.y) / 2 + 7;
  const pts = [];
  for (let t = 0; t <= 1.12; t += 0.02) {
    const ang = -2.6 + t * Math.PI * 2, wob = 1 + 0.04 * Math.sin(t * 9);
    pts.push([cx + Math.cos(ang) * rx * wob + t * 4, cy + Math.sin(ang) * ry * wob, 0.35 + 0.4 * Math.sin(t * Math.PI)]);
  }
  const prev = inkColor; inkColor = 'red';
  commitStroke(pts, false, 3);
  inkColor = prev;
}

// ------------------------------------------------------------------ boot
async function boot() {
  // @font-face fonts load lazily: wait for the faces xterm and CodeMirror measure (at most 1.5 s)
  try { await Promise.race([Promise.all([document.fonts.load('13px "JetBrainsMono Nerd Font Mono"'), document.fonts.load('13px "Noto Sans"')]), new Promise(r => setTimeout(r, 1500))]); } catch {}
  let board = null;
  if (SERVED) {   // served: the board comes from the server or not at all (30 §2.1)
    let b, info;
    try { b = await bootFetch('/api/board'); info = await bootFetch('/api/info'); } catch (e) { return bootScreen(e); }
    const v = b.body?.v;
    if (!(b.body === null && b.etag === '"empty"') && v !== 0 && v !== 5) return bootScreen({ kind: 'format', v: b.body === null ? 'null' : v });
    if (v === 5) board = b.body;   // else a fresh install, or the reset's {"v":0}: seed
    DAEMON = true; BOARD_ETAG = b.etag; INFO = info.body; HUB_STARTED = INFO.hub?.startedAt; bootTries = 0;
    RPC = new Rpc();
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  } else { const raw = store.get(LS_KEY); if (raw) try { board = JSON.parse(raw); } catch {} }
  S = board && board.v === 5 ? board : seed();
  if (DAEMON) { BOARD_CAM = S.cam; S.cam = camLoad() || { x: 0, y: 0, z: 1, ...S.cam }; }
  // F-A22: the view comes from this device; a board from before it lends its own view once, and one saved inside a
  // perspective is turned back into the manual layout here.
  if (S.manual && S.persp && S.persp !== 'manual') S.nodes = manualNodesOf(S.nodes, S.manual);
  const view = viewLoad() || { ws: S.ws, focusTabs: S.focusTabs, persp: S.persp };
  delete S.manual; S.persp = 'manual'; S.ws = view.ws || null; S.focusTabs = Array.isArray(view.focusTabs) ? view.focusTabs : [];
  migrateV9();
  // No /api/hosts at boot: wb-web answers it 404 by design (multi-host is a v1 non-goal; DESIGN §3.5.5), so the call
  // only put an error in the console of every load.
  perspChip(); { const ah = $('#add-host'); if (ah) ah.disabled = !DAEMON; } acpButton();
  hashInit();
  if (separateAll()) { restack(); renderLinks(); }
  S.views = S.views || {}; S.strokes = S.strokes || []; S.fs = S.fs || seedFs(); S.shapes = S.shapes || [];
  $('#help-mode').innerHTML = DAEMON
    ? 'Connected to wb-web: shells and agents run in wb-hub on this machine and outlive page reloads and web restarts. The board is saved in wb-web’s boards directory.'
    : 'Demo mode: shells are simulated in the browser and the board is saved in this browser only. Serve the page from wb-web (see the README) for real shells.';
  setTheme(S.theme || 'auto'); S.vim = S.vim ?? true; setPaneW(S.paneW || PANE_W, false); setTreeW(S.treeW || TREE_W, false); wirePaneGrip();
  RG.bm = S.rgBookmarks || {};
  $('.k-pal').textContent = keyLabel('Mod-K');
  $$('[data-modkey]').forEach(e => { e.textContent = keyLabel(e.dataset.modkey); });
  initChat(); toggleSide(S.side ?? innerWidth >= 1500, true);
  for (const [k, v] of Object.entries(S.docks || {})) toggleDock(k, v);
  frameList().sort((a, b) => depthOf(a) - depthOf(b)).forEach(mount);
  nodeList().forEach(mount);
  frameList().sort((a, b) => depthOf(b) - depthOf(a)).forEach(f => relayout(f));
  restack(); toggleTree(S.tree ?? innerWidth >= 900); renderTree();
  renderLinks(); renderInk(null); scheduleCrossRefresh();
  const fresh = S.fresh; delete S.fresh;
  if (fresh) { Object.assign(cam(), camTarget(-30, -50, 2960, 1180, 1)); applyCam(); } else applyCam();
  if (fresh) requestAnimationFrame(() => setTimeout(() => { seedInk(); dirty(); }, 60));
  if (fresh) setTimeout(() => toast(`${keyLabel('Mod-K')} finds anything and runs any command · Alt-2 navigator · drag items into folders · ? for keys`, 7000), 600);
  setView(S.view || (fresh && innerWidth < 760 ? 'ranger' : 'canvas'));
  sideTab(S.sideTab || 'chat');
  placeInkChip();
  wireReview(); detectMode(); { const ae = $('#add-emacs'); if (ae) ae.disabled = !DAEMON; }
  if (view.persp && view.persp !== 'manual' && PERSP_NAMES[view.persp]) { perspSet(view.persp, true); if (perspCur() === 'fs') setTimeout(() => { perspEdgesRebuild(); renderLinks(); }, 300); }
  deskRestore(view);
  wsRestore(); focusRestoreTabs();
  BOOTED = true; SAVE.lastJson = serialize(); viewSave();
}
// ================================================================ v8: node kinds around terminals, Emacs, browser, artifacts, sketch
// Emacs buffer: a real PTY running emacsclient -t on one file (starts a daemon if none), falling back to emacs -nw.
function emacsCmd(file) {
  const q = "'" + String(file).replace(/'/g, "'\\''") + "'";
  return `f=${q}; if command -v emacsclient >/dev/null 2>&1; then emacsclient -t -a '' "$f"; else emacs -nw "$f"; fi`;
}
function newEmacs(file) {
  if (!DAEMON) { toast('Emacs buffers need the self-hosted Workbench (wb-web).'); return null; }
  file = String(file || '').trim(); if (!file) return null;
  const base = file.replace(/\/+$/, '').split('/').pop() || 'scratch';
  const n = newAt('term', { backend: 'pty', cmd: emacsCmd(file), emacs: file, name: base, w: 640, h: 440, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
  live[n.id]?.el.classList.add('emacs');
  return n;
}
// Browser window: a page in a frame. Sites that send X-Frame-Options or a frame-ancestors CSP stay blank; ↗ opens them outside.
// Only http(s) pages: a javascript: or data: URL from a board or a tool would run script (SEC-1).
const webUrlOk = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
function normUrl(u) { u = String(u || '').trim(); if (!u) return ''; if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u; return webUrlOk(u) ? u : ''; }
function newWeb(url) {
  const u = normUrl(url); const name = u ? u.replace(/^https?:\/\//, '').split('/')[0] : 'web';
  return newAt('web', { url: u, name, w: 720, h: 520 });
}
function mountWeb(n, L) {
  const bar = el('div', 'web-bar'); const inp = el('input'); inp.type = 'text'; inp.value = n.url || ''; inp.placeholder = 'https://'; inp.spellcheck = false;
  const go = el('button'); go.textContent = 'Go'; const out = el('button'); out.textContent = '↗'; out.title = 'Open in a browser tab';
  bar.append(inp, go, out);
  const f = el('iframe', 'web-frame'); f.title = n.name; f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-modals');
  const note = el('div', 'web-note'); note.textContent = 'Blank? That site refuses to be framed; ↗ opens it in a tab.';
  L.body.append(bar, f, note); L.frame = f; L.urlInput = inp; L.note = note;
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { n.url = normUrl(inp.value); inp.value = n.url; dirty(); webGo(n, L); updateTitle(n); } });
  inp.addEventListener('pointerdown', e => e.stopPropagation());
  go.onclick = e => { e.stopPropagation(); n.url = normUrl(inp.value); inp.value = n.url; dirty(); webGo(n, L); updateTitle(n); };
  out.onclick = e => { e.stopPropagation(); if (webUrlOk(n.url)) window.open(n.url, '_blank', 'noopener'); };
  webGo(n, L);
}
function webGo(n, L) {
  const f = L.frame; if (!f) return;
  const ok = webUrlOk(n.url);
  L.note.textContent = n.url && !ok ? 'Refused: only http and https pages open in a web card.' : 'Blank? That site refuses to be framed; ↗ opens it in a tab.';
  if (!ok) { f.removeAttribute('src'); return; }
  if (window.CANVAS_HOSTED) { toast('On claude.ai the viewer blocks nested frames; web nodes work in the local build. ↗ opens the page in a tab.', 5000); }
  f.src = n.url;
}
// Sketch: a card the pen writes on. Ink attaches to the node (existing stroke model), so it moves and nests with it.
function newSketch() {
  const n = newAt('sketch', { w: 480, h: 360 });
  const L = live[n.id]; if (L) { const h = el('div', 'sk-hint'); h.textContent = 'Write or draw here with the pen tool. Aa turns it into a page.'; L.body.append(h); }
  if (typeof setTool === 'function') setTool('pen');
  return n;
}
function mountSketch(n, L) { if (!$('.sk-hint', L.body)) { const h = el('div', 'sk-hint'); h.textContent = 'Write or draw here with the pen tool. Aa turns it into a page.'; L.body.append(h); } }
function sketchClear(n) { const ids = new Set(S.strokes.filter(x => x.owner === n.id).map(x => x.id)); if (!ids.size) return; S.strokes = S.strokes.filter(x => !ids.has(x.id)); renderInk(n.id); dirty(); toast('Ink cleared'); }
async function sketchToPage(n) {
  const ids = S.strokes.filter(x => x.owner === n.id).map(x => x.id);
  if (!ids.length) { toast('Nothing written on this card yet.'); return; }
  const sample = await canSeeImages(); if (!sample) return;
  toast('Reading the handwriting…');
  try {
    const res = await sample(INK_PROMPT, { images: [await inkImage(ids)], modelTier: 'default', cache: false });
    const md = (res.text || '').trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    if (!md) throw new Error('empty');
    const page = addNode({ kind: 'buffer', name: n.name + '-text', x: n.x + n.w + 24, y: n.y, w: 420, h: Math.max(220, n.h), text: md, in: n.in });
    toast('Page ' + page.name + ' written from the ink.');
  } catch (e) { toast('Could not read the ink: ' + (e?.message || e), 6000); }
}
// File-backed artifact: the HTML file is the source of truth; any agent (claude code, oh-my-pi, a script) writes it and the node republishes and reloads.
async function artFromFile(n, L) {
  const st = await (await fetch(`/api/stat?path=${encodeURIComponent(n.file)}`)).json();
  if (!st.exists) throw new Error('no such file');
  if (st.mtime === n.fileMtime && n.head) return false;
  const r = await fetch(`/api/cat?path=${encodeURIComponent(n.file)}&limit=6000000`);
  const html = await r.text();
  const sha = await shaShort(html);
  if (sha !== n.head) { await artPublish(n, { html }); }
  n.fileMtime = st.mtime; dirty();
  return sha !== n.head || true;
}
function artWatch(n) {
  if (!DAEMON || !n.file) return;
  const tick = async () => {
    const L = live[n.id]; if (!L || S.nodes[n.id] !== n) { clearInterval(n._poll); n._poll = null; return; }
    try {
      const st = await (await fetch(`/api/stat?path=${encodeURIComponent(n.file)}`)).json();
      if (st.exists && st.mtime !== n.fileMtime) { const before = n.head; await artFromFile(n, L); if (n.head !== before) { artMount(n, L); updateTitle(n); } else n.fileMtime = st.mtime; }
    } catch {}
  };
  if (!n._poll) n._poll = setInterval(tick, 2000);
}
async function newArtifactFromFile(file) {
  if (!DAEMON) { toast('File-backed artifacts need the local build.'); return null; }
  file = String(file || '').trim(); if (!file) return null;
  const name = file.split('/').pop().replace(/\.html?$/i, '') || 'artifact';
  const n = newAt('artifact', { name, file, w: 640, h: 480, capabilities: { ...DEFAULT_CAPS }, grants: {}, db: { docs: {} } });
  artWatch(n);
  return n;
}
// start watching file-backed artifacts that were on the board at load, and new ones as they mount
AGENT_TOOLS.push(
  { name: 'open_web', description: 'Open a web page as a browser-window node on the canvas.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, run: ({ url }) => { if (!normUrl(url)) throw new Error('only http and https URLs open in a web node'); const n = newWeb(url); return `opened ${n.name}`; } },
  { name: 'open_in_emacs', description: 'Open a file in an Emacs buffer node (local build only).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: ({ path }) => { const n = newEmacs(path); return n ? `opened ${n.name}` : 'needs the local build'; } },
  { name: 'artifact_from_file', description: 'Show an HTML file as an artifact node that reloads whenever the file changes (local build only).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: async ({ path }) => { const n = await newArtifactFromFile(path); return n ? `showing ${path} as ${n.name}` : 'needs the local build'; } },
);
// ================================================================ v9: tags on nodes; agents are terminals; no assistant pane
// A node carries tags. Some are read off the node itself (auto), the rest are the user's. #agent: a terminal whose foreground
// process is an agent CLI. #aggregator: the node is a container (folders always are; a tagged terminal gets a folder of its own).
const AGENT_RE = /^(claude|claude-code|oh-my-pi|omp|aider|codex|gemini|goose|opencode|copilot|cursor-agent|amp|crush|pi)$/i;
let TAG_FILTER = '';
function autoTags(n) {
  const t = [];
  if (n.kind === 'frame') { t.push('aggregator'); if (n.host) t.push('host'); if (n.unitState) t.push(n.unitState); if (n.tmuxState) t.push(n.tmuxState); }
  if (n.kind === 'term') { const first = (n.cmd || '').trim().split(/\s+/)[0]?.split('/').pop() || ''; if ((n.fg && AGENT_RE.test(n.fg)) || AGENT_RE.test(first)) t.push('agent'); if (n.tmux) t.push('tmux'); }
  if (n.kind === 'acp') t.push('agent');   // the state is never a tag: tags write the board
  if (n.emacs) t.push('emacs');
  return t;
}
function tagsOf(n) { return n ? [...new Set([...autoTags(n), ...(n.tags || [])])] : []; }
function cleanTags(v) { return [...new Set(String(Array.isArray(v) ? v.join(' ') : v || '').toLowerCase().split(/[\s,#]+/).map(x => x.replace(/[^a-z0-9_\-:.\/]/g, '')).filter(Boolean))]; }
function renderTags(n, L) {
  const box = L?.hdr && $('.tags', L.hdr); if (!box) return;
  const auto = new Set(autoTags(n)); box.replaceChildren();
  for (const t of tagsOf(n)) { if (n.kind === 'frame' && t === 'aggregator') continue; const sp = el('span', auto.has(t) ? 'auto' : ''); sp.textContent = '#' + t; sp.title = (auto.has(t) ? 'from the node itself · ' : '') + 'click to filter by #' + t; sp.onclick = ev => { ev.stopPropagation(); tagFilter(TAG_FILTER === t ? '' : t); }; box.append(sp); }
  if (L.el) L.el.classList.toggle('dim', !!TAG_FILTER && !tagsOf(n).includes(TAG_FILTER));
}
function retag(n) { const L = live[n.id]; if (L) renderTags(n, L); if (tagsOf(n).includes('aggregator') && n.kind !== 'frame' && !n.agg) aggWrap(n); renderTree(); dirty(); }
function setTags(n, tags, { remove } = {}) {
  if (!n) return [];
  const t = cleanTags(tags);
  n.tags = remove ? (n.tags || []).filter(x => !t.includes(x)) : [...new Set([...(n.tags || []), ...t])];
  if (!n.tags.length) delete n.tags;
  if (n.kind !== 'frame') {
    if (tagsOf(n).includes('aggregator') && !n.agg) aggWrap(n);
    else if (!tagsOf(n).includes('aggregator') && n.agg) { const f = S.nodes[n.agg]; if (f) delete f.owner; delete n.agg; if (f) updateTitle(f); }
  }
  updateTitle(n); renderTree(); if (VIEW === 'ranger') renderRanger(); dirty();
  return tagsOf(n);
}
// An aggregator that is not a folder gets one: the node moves inside it, and its spawned children land there too.
function aggWrap(n) {
  if (n.kind === 'frame' || (n.agg && S.nodes[n.agg])) return S.nodes[n.agg];
  const f = addNode({ kind: 'frame', name: n.name, mode: 'free', shape: 'folder', x: n.x - 24, y: n.y - 56, w: Math.max(n.w + 48, 520), h: Math.max(n.h + 96, 420), in: n.in, owner: n.id });
  n.agg = f.id; adopt(n, f, null); n.x = f.x + 16; n.y = f.y + 44; place(n); updateTitle(f); updateTitle(n);
  for (const k of childrenOf(n.id, 'spawn')) if (S.nodes[k.id] && (k.in || null) === (f.in || null)) adopt(k, f, null);
  return f;
}
function tagPrompt(n) {
  if (!n) { toast('Click a node first, then press # to tag it.'); return; }
  const known = [...new Set(nodeList().flatMap(tagsOf))].filter(t => t !== 'aggregator').slice(0, 12);
  askName(`Tags for ${n.name}${known.length ? ' (known: ' + known.map(t => '#' + t).join(' ') + ')' : ''}. Prefix - to remove.`, (n.tags || []).map(t => '#' + t).join(' '), v => {
    const parts = String(v).split(/\s+/), rm = parts.filter(p => p.startsWith('-')).map(p => p.slice(1)), add = parts.filter(p => !p.startsWith('-'));
    if (rm.length) setTags(n, rm, { remove: true });
    n.tags = []; setTags(n, add);
    toast(tagsOf(n).length ? n.name + ': ' + tagsOf(n).map(t => '#' + t).join(' ') : n.name + ': no tags');
  });
}
function tagFilter(tag) {
  TAG_FILTER = cleanTags(tag)[0] || '';
  for (const n of nodeList()) { const L = live[n.id]; if (L?.el) L.el.classList.toggle('dim', !!TAG_FILTER && !tagsOf(n).includes(TAG_FILTER)); }
  let chip = $('#tag-chip');
  if (!TAG_FILTER) { chip?.remove(); renderTree(); return; }
  if (!chip) { chip = el('div'); chip.id = 'tag-chip'; document.body.append(chip); }
  const n = nodeList().filter(x => tagsOf(x).includes(TAG_FILTER)).length;
  chip.innerHTML = ''; chip.append(`#${TAG_FILTER} · ${n} node${n === 1 ? '' : 's'}`); const x = el('button', 'mini', '✕'); x.title = 'Clear the filter (Esc)'; x.onclick = () => tagFilter(''); chip.append(x);
  renderTree();
}
function migrateV9() {
  for (const n of Object.values(S.nodes || {})) if (n.mode === 'ribbon') { n.mode = 'tile'; delete n.preTile; }   // v18.1: the ribbon mode is gone
  // Agent nodes become pages holding their log; the demo's agent becomes a shell tagged #agent.
  for (const n of Object.values(S.nodes)) {
    if (n.kind !== 'agent') continue;
    if (n.id === 'agent' && !(n.turns || []).length) { Object.assign(n, { kind: 'term', backend: DAEMON ? 'pty' : 'fake', cmd: DAEMON ? '' : 'claude', fg: DAEMON ? undefined : 'claude', name: 'claude', tags: ['agent'], env: {} }); delete n.log; delete n.turns; delete n.tier; continue; }
    const text = '# ' + n.name + ' (former agent node)\n\n' + (n.log || []).filter(m => m.text).map(m => (m.t === 'user' ? '> ' : '') + m.text).join('\n\n');
    Object.assign(n, { kind: 'buffer', text }); delete n.log; delete n.turns; delete n.tier;
  }
  delete S.chat; if (S.sideTab === 'chat') S.sideTab = 'term';
}
cmd('Tag the active node… (#)', () => tagPrompt(activeId && S.nodes[activeId]), '#');
cmd('Filter nodes by tag…', () => askName('Tag to show (empty clears)', TAG_FILTER ? '#' + TAG_FILTER : '#', v => tagFilter(v)));
cmd('Clear the tag filter', () => tagFilter(''), '', () => !!TAG_FILTER);
cmd('Tags: make the active node an aggregator (a folder of its own)', () => { const n = activeId && S.nodes[activeId]; if (n) setTags(n, ['aggregator']); }, '', () => !!activeId);
AGENT_TOOLS.push(
  { name: 'tag_node', description: 'Add tags to a node (or remove them with remove: true). Tags: agent, aggregator (makes the node a container with its own folder), or any word.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, tags: { type: 'string', description: 'space-separated' }, remove: { type: 'boolean' } }, required: ['path', 'tags'] },
    run: ({ path, tags, remove }) => { const n = findNode(path); if (!n) throw new Error('no node at ' + path); return pathOf(n.id) + ': ' + (setTags(n, tags, { remove: !!remove }).map(t => '#' + t).join(' ') || 'no tags'); } },
  { name: 'list_nodes', description: 'List nodes on the board: path, kind and tags. tag filters.', inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
    run: ({ tag } = {}) => nodeList().filter(n => !tag || tagsOf(n).includes(cleanTags(tag)[0])).map(n => `${pathOf(n.id)} · ${n.kind === 'frame' ? 'folder' : n.kind}${n.fg ? ' (' + n.fg + ')' : ''}${tagsOf(n).map(t => ' #' + t).join('')}`).join('\n') || '(no nodes)' },
  { name: 'list_tools', description: 'List the board tools and their input fields.', inputSchema: { type: 'object', properties: {} },
    run: () => AGENT_TOOLS.map(t => `${t.name}(${Object.keys(t.inputSchema?.properties || {}).join(', ')}): ${t.description}`).join('\n') },
);
// ================================================================ v10: workspaces, focus tabs, leader key, optimiser
// ---- workspaces: an entered aggregator is the desktop; everything outside dims; Esc steps up a level
const WS = { cur: null, last: null };
function wsTop() { return frameList().filter(f => !f.in || !S.nodes[f.in]).sort((a, b) => a.y - b.y || a.x - b.x); }
function wsApply(animateCam = true) {
  const f = WS.cur && S.nodes[WS.cur];
  if (WS.cur && !f) WS.cur = null;
  const inside = f ? new Set([f.id, ...descendants(f.id).map(d => d.id)]) : null;
  for (const n of Object.values(S.nodes)) live[n.id]?.el.classList.toggle('outside', !!inside && !inside.has(n.id));
  document.body.classList.toggle('in-ws', !!f);
  const h = f && hostOf(f), label = f ? '⌂ ' + pathOf(f.id) + (h ? ' @' + h.name : '') : '';
  const st = $('#st-ws'); if (st) st.textContent = label;
  const bar = $('#ws-bar'); if (bar) { bar.hidden = !f; if (f) $('#ws-name', bar).textContent = label; }   // v19.1: the way out stays on screen (user, 18:15)
  for (const n of Object.values(S.nodes)) if (n.kind === 'frame') live[n.id]?.el.classList.toggle('ws-cur', !!f && n.id === f.id);
  S.ws = f ? f.id : null; viewSave();
}
function wsEnter(f, quiet) {
  if (!f || f.kind !== 'frame') return;
  if (VIEW !== 'canvas') setView('canvas');
  deskReveal(f);
  if (FOCUS.cur) focusHide();
  if (WS.cur !== f.id) WS.last = WS.cur;
  WS.cur = f.id; reveal(f); pushHistory(); activate(f.id);
  wsFill(f);
  { const h = hostOf(f); if (h && HOSTCONN[h.url]?.down) hostRetry(h.url); }
  animateTo(camTarget(f.x, f.y - LABEL_H, f.w, f.h + LABEL_H, 1));
  wsApply(); dirty();
  if (!quiet) toast(`Workspace ${pathOf(f.id)}: the other folders are dimmed. ⇱ Leave at the top, Esc, or a click on a dimmed folder steps out.`);
}
// a tiled folder in the screen's ratio is a desktop: entering it as a workspace grows it to the screen's size (at zoom 1)
// when it is smaller, so its panes take the whole view. It keeps that size afterwards; ⊞ or a drag changes it again.
function wsFill(f) {
  if (f.mode !== 'tile' || f.aspect !== 'screen') return;
  const p = f.in && S.nodes[f.in]; if (p && p.mode === 'tile') return;
  const a = camArea(), W = Math.round(a.vw * 0.88), H = Math.round(a.vh * 0.86) - LABEL_H;
  if (f.w >= W - 1 && f.h >= H - 1) return;
  settle(); f.w = Math.max(f.w, W); f.h = Math.max(f.h, H); tileFolder(f); placeFrame(f);
  SEP.keep = f; if (p) relayout(p); else separate(null, f); SEP.keep = null; restack(); renderLinks(); dirty();
}
function wsLeave() {
  const f = WS.cur && S.nodes[WS.cur]; const p = f?.in && S.nodes[f.in];
  WS.last = WS.cur; WS.cur = p ? p.id : null;
  if (p) { activate(p.id); pushHistory(); animateTo(camTarget(p.x, p.y - LABEL_H, p.w, p.h + LABEL_H, 1)); } else fitAll();
  wsApply(); dirty();
}
function wsGo(i) { const list = wsTop(); const f = list[i - 1]; if (f) wsEnter(f); else toast(`No workspace ${i}: there are ${list.length} top-level folders.`); }
function wsToggleLast() { const f = WS.last && S.nodes[WS.last]; if (f) wsEnter(f); else if (WS.cur) wsLeave(); }
function wsRestore() { if (S?.ws && S.nodes[S.ws] && !deskOff(S.nodes[S.ws])) { WS.cur = S.ws; wsApply(false); } }

// ---- focus tabs: a node fills the main area at 100 %; the canvas is untouched underneath; tabs persist
const FOCUS = { tabs: [], cur: null, saved: null, rect: null };
const FT_TOP = 56, FT_H = 34, FT_BOTTOM = 34;
function focusStrip() {
  const strip = $('#focus-tabs'); if (!strip) return;
  FOCUS.tabs = FOCUS.tabs.filter(id => S.nodes[id]);
  strip.hidden = !FOCUS.tabs.length; strip.replaceChildren();
  S.focusTabs = [...FOCUS.tabs]; viewSave();
  if (!FOCUS.tabs.length) return;
  const home = el('button', 'ft' + (FOCUS.cur ? '' : ' on')); home.innerHTML = '<span class="g">◻</span>canvas'; home.onclick = () => focusHide(); strip.append(home);
  for (const id of FOCUS.tabs) {
    const n = S.nodes[id], b = el('button', 'ft' + (FOCUS.cur === id ? ' on' : '')); b.setAttribute('role', 'tab');
    const g = el('span', 'g'); g.textContent = KIND_GLYPH[n.kind] || '·'; const nm = document.createTextNode(n.name); const x = el('span', 'x', '✕'); x.title = 'Close this tab (back to the canvas)';
    b.append(g, nm, x); b.onclick = ev => { if (ev.target === x) { ev.stopPropagation(); focusClose(id); } else focusShow(id); };
    strip.append(b);
  }
}
function focusGeometry(n) {
  const w = Math.max(200, VW() - 2), h = Math.max(120, VH() - FT_TOP - FT_H - FT_BOTTOM - 2);
  n.w = w; n.h = h; placeAny(n);
  Object.assign(cam(), { z: 1, x: n.x - 1, y: n.y - FT_TOP - FT_H - 1 }); applyCam();
  live[n.id]?.fitNow?.();
}
function focusShow(id) {
  const n = S.nodes[id]; if (!n || n.kind === 'frame') return;
  if (VIEW !== 'canvas') setView('canvas');
  deskReveal(n);
  if (FOCUS.cur && FOCUS.cur !== id) focusRestoreNode();
  if (!FOCUS.cur) FOCUS.saved = { ...cam() };
  if (FOCUS.cur !== id) { reveal(n); FOCUS.rect = { x: n.x, y: n.y, w: n.w, h: n.h }; }
  FOCUS.cur = id; activate(id);
  live[id]?.el.classList.add('focused'); document.body.classList.add('focus');
  focusGeometry(n); focusStrip();
}
function focusRestoreNode() {
  const n = FOCUS.cur && S.nodes[FOCUS.cur]; const L = n && live[n.id];
  if (n && FOCUS.rect) { Object.assign(n, FOCUS.rect); placeAny(n); if (n.in && S.nodes[n.in]) relayout(S.nodes[n.in]); L?.fitNow?.(); }
  L?.el.classList.remove('focused'); document.body.classList.remove('focus');
  FOCUS.cur = null; FOCUS.rect = null;
}
function focusOpen(n) { if (!n || n.kind === 'frame') return wsEnter(n); if (!FOCUS.tabs.includes(n.id)) FOCUS.tabs.push(n.id); focusShow(n.id); }
// Enter on the active card puts the keyboard in it where it stands: a shell's cursor, an agent's composer, a page's
// text, a web card's address. A card that is off screen, in a closed deck or drawn as a far-zoom snapshot is brought
// into view at reading size first. A card with no text input opens as a focus tab, as Shift-Enter does for any card.
function cardInput(n) { const L = live[n.id]; return L && (L.term || L.ta || L.view || (n.kind === 'web' && $('.web-bar input', L.body))) || null; }
function typeInto(n) {
  const t = cardInput(n); if (!t) return focusOpen(n);
  const go = () => { activate(n.id); t.focus(); };
  if (FOCUS.cur === n.id) return go();
  const a = w2s(n.x, n.y), b = w2s(n.x + n.w, n.y + n.h);
  if (lastLod || stashed(n) || a.x < 0 || a.y < 0 || b.x > VW() || b.y > VH()) jumpNode(n, 1, go); else go();
}
function focusHide() {
  if (!FOCUS.cur) { focusStrip(); return; }
  focusRestoreNode();
  if (FOCUS.saved) { Object.assign(cam(), FOCUS.saved); applyCam(); FOCUS.saved = null; }
  focusStrip(); renderLinks(); dirty();
}
function focusClose(id) {
  const wasCur = FOCUS.cur === id;
  FOCUS.tabs = FOCUS.tabs.filter(x => x !== id);
  if (wasCur) focusHide(); else focusStrip();
  dirty();
}
function focusCycle(d) { if (!FOCUS.tabs.length) return; const i = FOCUS.tabs.indexOf(FOCUS.cur); focusShow(FOCUS.tabs[(i + d + FOCUS.tabs.length) % FOCUS.tabs.length]); }
function focusRestoreTabs() { FOCUS.tabs = (S?.focusTabs || []).filter(id => S.nodes[id]); focusStrip(); }
window.addEventListener('resize', () => { if (FOCUS.cur && S?.nodes[FOCUS.cur]) focusGeometry(S.nodes[FOCUS.cur]); });

// ---- desks (DESIGN §10.8, D1): named arrangements of some cards, switched as i3 switches workspaces. Desk 0 is the Board,
// the only geometry in the board's nodes. On another desk its members stand at the desk's own rectangles (a folder brings
// what it holds) and every other item is hidden as a deck's cards are. The Board's geometry waits in DESK.snap, so a save
// writes the Board whichever desk is shown, and leaving the desk puts it back. Pinned desks are records in the board
// (S.desks); scratch desks are this device's until pinned, and go when they are left empty.
const DESK_MAX = 8;
function deskList() { return [...(S.desks || []), ...DESK.scratch].sort((a, b) => a.slot - b.slot); }
function deskAt(slot) { return slot ? (S.desks || []).find(d => d.slot === slot) || DESK.scratch.find(d => d.slot === slot) || null : null; }
const deskPinned = d => !!d && (S.desks || []).includes(d);
const deskName = d => d ? d.slot + (d.name && d.name !== String(d.slot) ? ' ' + d.name : '') : '0 Board';
function deskShown(n) { return DESK.mem.has(n.id) || ancestors(n).some(a => DESK.mem.has(a.id)); }
function deskOff(n) { return !!DESK.cur && !deskShown(n); }
function deskFree() { for (let s = 1; s <= DESK_MAX; s++) if (!deskAt(s)) return s; return 0; }
// A pinned desk from another device wins its slot; a scratch desk there moves to a free one.
function deskSlotsFix() {
  const taken = new Set((S.desks || []).map(d => d.slot));
  for (const d of [...DESK.scratch]) if (taken.has(d.slot)) { const s = deskFree(); if (s) d.slot = s; else DESK.scratch = DESK.scratch.filter(x => x !== d); }
}
// the shown desk's rectangles, from the page (a card in a focus tab keeps its rectangle on the desk)
function deskRecord() {
  const d = deskAt(DESK.cur); if (!d) return;
  for (const id of [...DESK.mem]) { const n = S.nodes[id]; if (!n) { DESK.mem.delete(id); delete d.members[id]; continue; } const r = FOCUS.cur === id && FOCUS.rect ? FOCUS.rect : n; d.members[id] = [r.x, r.y, r.w, r.h]; }
}
// The Board as it stands under the shown desk, built without touching the page. An item made on the desk goes to the Board
// with the nearest item that has a place there: its folder, the card it was spawned from, or the closest member.
function deskBoardOf(nodes) {
  const snap = DESK.snap, out = {}, delta = {};
  for (const n of Object.values(nodes)) { const p = snap.pos[n.id]; if (p) delta[n.id] = [p[0] - n.x, p[1] - n.y]; }
  const near = n => {
    for (let c = n.in && nodes[n.in], g = 0; c && g++ < 32; c = c.in && nodes[c.in]) if (delta[c.id]) return delta[c.id];
    if (n.spawnFrom && delta[n.spawnFrom]) return delta[n.spawnFrom];
    let best = [0, 0], bd = Infinity;
    for (const id of DESK.mem) { const m = nodes[id]; if (!m || !delta[id]) continue; const d = Math.hypot(m.x + m.w / 2 - n.x - n.w / 2, m.y + m.h / 2 - n.y - n.h / 2); if (d < bd) { bd = d; best = delta[id]; } }
    return best;
  };
  for (const n of Object.values(nodes)) {
    const c = { ...n }, p = snap.pos[n.id];
    if (p) { const f = snap.in[n.id]; if (f && nodes[f]) c.in = f; else delete c.in; [c.x, c.y, c.w, c.h] = p; if (n.id in snap.order) c.order = snap.order[n.id]; else delete c.order; }
    else { const [dx, dy] = near(n); c.x += dx; c.y += dy; }
    out[n.id] = c;
  }
  return out;
}
// The folder a shape goes with on a desk: its deck (in), else the member folder it lay in on the Board when the desk was
// entered (a shape belongs to an open folder by where it lies, as a folder drag finds it), else, for a shape drawn on the
// desk, the deepest shown folder it lies in now. It goes back to the Board by that folder's offset.
const shapeInside = (sh, f) => sh.x >= f.x && sh.y >= f.y - LABEL_H && sh.x + sh.w <= f.x + f.w && sh.y + sh.h <= f.y + f.h;
function deskShapeFrame(sh) {
  if (sh.type === 'arrow') return null;
  if (sh.in) return S.nodes[sh.in] || null;
  if (DESK.shapeOld.has(sh.id)) return S.nodes[DESK.shapeIn.get(sh.id)] || null;
  let best = null, bd = -1;
  for (const f of frameList()) if (!stashed(f) && shapeInside(sh, f)) { const d = depthOf(f); if (d > bd) { bd = d; best = f; } }
  return best;
}
function deskShapeDelta(sh) { const f = DESK.snap && deskShapeFrame(sh), p = f && DESK.snap.pos[f.id]; return p && (p[0] !== f.x || p[1] !== f.y) ? [p[0] - f.x, p[1] - f.y] : null; }
function deskApply(d) {
  const snap = { in: {}, pos: {}, order: {} };
  for (const n of Object.values(S.nodes)) { snap.in[n.id] = n.in || null; snap.pos[n.id] = [n.x, n.y, n.w, n.h]; if ('order' in n) snap.order[n.id] = n.order; }
  for (const id of Object.keys(d.members)) if (!S.nodes[id]) delete d.members[id];
  DESK.snap = snap; DESK.cur = d.slot; DESK.mem = new Set(Object.keys(d.members));
  const ms = [...DESK.mem].map(id => S.nodes[id]).sort((a, b) => depthOf(a) - depthOf(b)), mf = ms.filter(n => n.kind === 'frame');
  DESK.shapeOld = new Set(S.shapes.map(sh => sh.id)); DESK.shapeIn = new Map();
  for (const sh of S.shapes) if (sh.type !== 'arrow' && !sh.in) { const f = mf.filter(f => shapeInside(sh, f)).pop(); if (f) DESK.shapeIn.set(sh.id, f.id); }   // ms is shallow first: the deepest member folder wins
  for (const n of ms) if (n.in && S.nodes[n.in] && !deskShown(S.nodes[n.in])) delete n.in;   // a member whose folder is not on the desk stands loose
  for (const n of ms) {   // outer first: a folder carries what it holds, then a member inside it takes its own place
    const r = d.members[n.id]; if (!r) continue;
    if (n.kind === 'frame') { moveTree(n, r[0] - n.x, r[1] - n.y); n.w = r[2]; n.h = r[3]; } else [n.x, n.y, n.w, n.h] = r;
  }
  for (const [id, fid] of DESK.shapeIn) { const sh = S.shapes.find(x => x.id === id), f = S.nodes[fid], p = snap.pos[fid]; if (sh && f) { sh.x += f.x - p[0]; sh.y += f.y - p[1]; } }
  for (const n of Object.values(S.nodes)) placeAny(n);
}
function deskUnapply() {
  if (!DESK.snap) return;
  deskRecord();
  for (const sh of S.shapes) { const d = deskShapeDelta(sh); if (d) { sh.x += d[0]; sh.y += d[1]; } }
  const board = deskBoardOf(S.nodes), made = new Set();
  for (const n of Object.values(S.nodes)) {
    const b = board[n.id];
    if (b.in) n.in = b.in; else delete n.in;
    if ('order' in b) n.order = b.order; else delete n.order;
    n.x = b.x; n.y = b.y; n.w = b.w; n.h = b.h;
    if (!DESK.snap.pos[n.id] && n.in && S.nodes[n.in]) made.add(S.nodes[n.in]);
  }
  DESK.cur = 0; DESK.snap = null; DESK.mem = new Set(); DESK.shapeIn = new Map(); DESK.shapeOld = new Set();
  for (const n of Object.values(S.nodes)) placeAny(n);
  for (const f of [...made].sort((a, b) => depthOf(b) - depthOf(a))) relayout(f);   // a folder that took new items on the desk
}
// what the page shows after a desk changes; quiet: no save (another device's board is being taken)
function deskRefresh(quiet) {
  document.body.classList.toggle('on-desk', !!DESK.cur);
  restack(); renderTree(); renderLinks(); updateAllTitles(); deskPager();
  if (VIEW === 'ranger') renderRanger();
  if (!quiet) { viewSave(); dirty(); }
}
function deskGo(slot, quiet) {
  slot = Math.trunc(+slot);
  if (!(slot >= 0 && slot <= 9)) return;
  if (slot === 9) { toast('Desk 9 is kept for the attention desk, which comes with the overview (desks D2).'); return; }
  if (slot === DESK.cur) { if (!quiet) toast('Already on desk ' + deskName(deskAt(slot)) + '.'); return; }
  if (VIEW !== 'canvas') setView('canvas');
  if (FOCUS.cur) focusHide();
  if (WS.cur) { WS.cur = null; WS.last = null; wsApply(false); }
  if (perspCur() !== 'manual') perspSet('manual', true);
  LAYOUT_UNDO = null; pickClear();
  const from = DESK.cur, fromD = deskAt(from);
  DESK.cams[from] = { ...cam() };
  deskUnapply();
  if (fromD && !deskPinned(fromD) && !Object.keys(fromD.members).length) { DESK.scratch = DESK.scratch.filter(x => x !== fromD); delete DESK.cams[from]; }   // i3: an empty desk goes when left
  let d = deskAt(slot), made = false;
  if (slot && !d) { d = { slot, name: String(slot), members: {} }; DESK.scratch.push(d); made = true; }
  DESK.prev = from;
  if (d) deskApply(d);
  deskRefresh();
  const c = DESK.cams[slot];
  if (c) { Object.assign(cam(), c); applyCam(); } else if (d && Object.keys(d.members).length) fitAll(false);
  dirtyCam();
  if (!quiet) toast(!d ? 'Desk 0: the Board, every card where you put it.' : made || !Object.keys(d.members).length
    ? `Desk ${deskName(d)}: empty. ${LEADERS[leaderName()].label} m ${slot} on the Board sends the active card here; cards you make here join it.`
    : `Desk ${deskName(d)}${deskPinned(d) ? '' : ' (this device)'}: ${Object.keys(d.members).length} item(s). ${LEADERS[leaderName()].label} 0 goes back to the Board.`);
}
// A card that is not on the shown desk is found on the Board.
function deskReveal(n) { if (n && deskOff(n)) deskGo(0, true); }
function deskTargets() { return (PICKED.size ? [...PICKED] : activeId ? [activeId] : []).map(id => S.nodes[id]).filter(Boolean); }
// The items join desk d in the arrangement they have here, to the right of what the desk already holds.
function deskAdd(d, ns) {
  ns = ns.filter(n => !(n.id in d.members)); if (!ns.length) return 0;
  const top = n => n.y - (n.kind === 'frame' ? LABEL_H : 0), rs = Object.values(d.members).filter(Boolean);
  const x0 = Math.min(...ns.map(n => n.x)), y0 = Math.min(...ns.map(top));
  const ox = rs.length ? Math.max(...rs.map(r => r[0] + r[2])) + 3 * GAP : x0, oy = rs.length ? Math.min(...rs.map(r => r[1])) : y0;
  for (const n of ns) d.members[n.id] = [n.x - x0 + ox, n.y - y0 + oy, n.w, n.h];
  if (d.slot === DESK.cur) for (const n of ns) DESK.mem.add(n.id);
  return ns.length;
}
// off the shown desk; the Board keeps them. An item shown with its folder goes with the folder only.
function deskDrop(ns) {
  const d = deskAt(DESK.cur); if (!d) return 0;
  const own = ns.filter(n => DESK.mem.has(n.id));
  for (const n of own) { delete d.members[n.id]; DESK.mem.delete(n.id); PICKED.delete(n.id); live[n.id]?.el.classList.remove('picked'); }
  if (own.length < ns.length) toast('An item inside a folder on this desk goes with that folder: take the folder off, or drag the item out of it.');
  pickChip(); return own.length;
}
function deskSend(slot, { follow = false, keep = false } = {}) {
  if (FOCUS.cur) focusHide();
  const ns = deskTargets(); if (!ns.length) return toast('Pick a card or folder first (click it, or Shift-click several).');
  if (slot === 9) return toast('Desk 9 is kept for the attention desk (desks D2).');
  if (slot === DESK.cur && slot) return toast('Already on this desk.');
  if (slot === 0) {   // every item is on the Board: sending there takes it off this desk
    if (!DESK.cur || keep) return toast('Every item is on the Board already; this takes items off another desk.');
    const name = deskName(deskAt(DESK.cur)), k = deskDrop(ns); deskRefresh(); if (follow) deskGo(0, true);
    if (k) toast(`${k} item(s) off desk ${name}. They stay on the Board.`); return;
  }
  let d = deskAt(slot); if (!d) { d = { slot, name: String(slot), members: {} }; DESK.scratch.push(d); }
  const k = deskAdd(d, ns), moved = !!DESK.cur && !keep;
  if (moved) deskDrop(ns);   // i3: a card sent on from a desk leaves it
  deskRefresh();
  if (follow) deskGo(slot, true);
  toast(k ? `${k} item(s) ${moved ? 'moved to' : 'now also on'} desk ${deskName(d)}.` : `Already on desk ${deskName(d)}.`);
}
// A new item joins the desk it is made on, and a spawned card joins every desk its parent is on, beside the parent.
function deskJoin(n) {
  if (n.kind === 'ghost' || PERSP.building) return;
  const cur = deskAt(DESK.cur);
  if (cur && !(n.in && S.nodes[n.in] && deskShown(S.nodes[n.in]))) { if (n.in) delete n.in; cur.members[n.id] = null; DESK.mem.add(n.id); }
  const p = n.spawnFrom && S.nodes[n.spawnFrom]; if (!p) return;
  for (const d of deskList()) if (d !== cur && p.id in d.members && !(n.id in d.members)) { const r = d.members[p.id]; d.members[n.id] = r ? [r[0] + n.x - p.x, r[1] + n.y - p.y, n.w, n.h] : null; }
}
function deskNew() {
  const ns = deskTargets(), slot = deskFree(); if (!slot) return toast(`All ${DESK_MAX} desks are in use. ${LEADERS[leaderName()].label} d k deletes the shown one.`);
  askName(`Name desk ${slot}${ns.length ? ` (with ${ns.length} item(s))` : ''}`, '', v => {
    const d = { slot, name: clean(v || '').replace(/^node$/, '') || String(slot), members: {} }; DESK.scratch.push(d); deskAdd(d, ns); deskGo(slot);
  });
}
function deskRename() { const d = deskAt(DESK.cur); if (!d) return toast('The Board keeps its name.'); askName(`Name desk ${d.slot}`, d.name === String(d.slot) ? '' : d.name, v => { d.name = clean(v || '').replace(/^node$/, '') || String(d.slot); deskRefresh(); }); }
function deskPin() {
  const d = deskAt(DESK.cur); if (!d) return toast('The Board is always in the board file.');
  if (deskPinned(d)) { S.desks = S.desks.filter(x => x !== d); DESK.scratch.push(d); toast(`Desk ${deskName(d)} unpinned: on this device only, and gone when left empty.`); }
  else { DESK.scratch = DESK.scratch.filter(x => x !== d); (S.desks ||= []).push(d); toast(`Desk ${deskName(d)} pinned: it is saved in the board, and every device has it.`); }
  deskRefresh();
}
function deskDelete() {
  const d = deskAt(DESK.cur); if (!d) return toast('The Board cannot be deleted.');
  deskGo(0, true);
  S.desks = (S.desks || []).filter(x => x !== d); DESK.scratch = DESK.scratch.filter(x => x !== d); delete DESK.cams[d.slot];
  deskRefresh(); toast(`Desk ${deskName(d)} deleted. Its cards are still on the Board.`);
}
function deskAlso() {   // which desks hold the active item
  const n = activeId && S.nodes[activeId]; if (!n) return toast('Pick a card or folder first.');
  const on = deskList().filter(d => n.id in d.members || ancestors(n).some(a => a.id in d.members));
  toast(`${pathOf(n.id)}: on the Board${on.map(d => ', desk ' + deskName(d)).join('')}.`);
}
// the pager: one button per desk in the mode line, as a desktop pager has
function deskPager() {
  const st = $('#st-desk'); if (!st) return;
  st.replaceChildren(); const ds = deskList();
  if (!ds.length && !DESK.cur) return;
  for (const d of [null, ...ds]) {
    const slot = d ? d.slot : 0, b = el('button', 'dk' + (slot === DESK.cur ? ' on' : '') + (d && !deskPinned(d) ? ' scratch' : ''), d ? deskName(d) : '0');
    b.title = d ? `Desk ${deskName(d)}: ${Object.keys(d.members).length} item(s)${deskPinned(d) ? ', pinned in the board' : ', this device only'}` : 'Desk 0: the Board';
    b.dataset.slot = slot; b.onclick = () => deskGo(slot); st.append(b);
  }
}
// boot: the desk this device was on, its scratch desks and cameras
function deskRestore(view) {
  DESK.scratch = Array.isArray(view?.scratch) ? view.scratch.filter(d => d && d.slot >= 1 && d.slot <= DESK_MAX && d.members && typeof d.members === 'object') : [];
  DESK.cams = view?.deskCams && typeof view.deskCams === 'object' ? view.deskCams : {};
  if (!Array.isArray(S.desks)) delete S.desks;   // a board without desks keeps no desks key
  deskSlotsFix();
  DESK.prev = +view?.prevDesk || 0;
  const d = perspCur() === 'manual' && deskAt(+view?.desk || 0); if (d) deskApply(d);
  deskRefresh(true);
}
cmd('Desk: go to…', () => askName('Desk number: 0 Board' + deskList().map(d => '  ·  ' + deskName(d)).join(''), '', v => deskGo(+String(v).trim())));
cmd('Desk: previous', () => KC['desk.prev'](), '@desk.prev');
cmd('Desk: send the selection to…', () => askName('Send to desk number (0 takes it off this desk)', '', v => deskSend(+String(v).trim())));
cmd('Desk: new desk with the selection', () => deskNew(), '@desk.new');
cmd('Desk: rename this desk', () => deskRename(), '@desk.rename', () => !!DESK.cur);
cmd('Desk: pin or unpin this desk', () => deskPin(), '@desk.pin', () => !!DESK.cur);
cmd('Desk: take the selection off this desk', () => deskSend(0), '@desk.off', () => !!DESK.cur);
cmd('Desk: which desks hold the active item', () => deskAlso(), '@desk.which');
cmd('Desk: delete this desk', () => deskDelete(), '@desk.delete', () => !!DESK.cur);

// ---- i3-style neighbours: focus moves to the nearest sibling in a direction; swapping exchanges places or order
function siblingsOf(n) { return Object.values(S.nodes).filter(m => m !== n && (m.in || null) === (n.in || null) && !stashed(m)); }
function neighbour(n, dir) {
  if (!n) return null;
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2; let best = null, bd = Infinity;
  for (const m of siblingsOf(n)) {
    const dx = m.x + m.w / 2 - cx, dy = m.y + m.h / 2 - cy;
    const ok = dir === 'l' ? dx > 0 && Math.abs(dy) <= Math.abs(dx) * 1.2 : dir === 'h' ? dx < 0 && Math.abs(dy) <= Math.abs(dx) * 1.2 : dir === 'j' ? dy > 0 && Math.abs(dx) <= Math.abs(dy) * 1.2 : dy < 0 && Math.abs(dx) <= Math.abs(dy) * 1.2;
    if (!ok) continue;
    const d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = m; }
  }
  return best;
}
function focusMove(dir) {
  const n = activeId && S.nodes[activeId];
  if (!n) {   // nothing selected yet: start from the card nearest the middle of the screen
    const c = s2w(VW() / 2, VH() / 2); let best = null, bd = Infinity;
    for (const m of Object.values(S.nodes)) { if (stashed(m) || m.id === 'dock' || !live[m.id]?.el?.getClientRects().length) continue; const d = Math.hypot(m.x + m.w / 2 - c.x, m.y + m.h / 2 - c.y); if (d < bd) { bd = d; best = m; } }
    if (best) activate(best.id); else toast('Nothing on the board yet.');
    return;
  }
  const m = neighbour(n, dir); if (!m) { toast('Nothing ' + ({ h: 'to the left', j: 'below', k: 'above', l: 'to the right' })[dir] + '.'); return; }
  if (FOCUS.cur) { if (m.kind !== 'frame') focusOpen(m); return; }
  activate(m.id);
  const s = w2s(m.x, m.y), s2 = w2s(m.x + m.w, m.y + m.h);
  if (s.x < 0 || s.y < 0 || s2.x > VW() || s2.y > VH()) jumpNode(m, cam().z);
}
function swapWith(dir) {
  const n = activeId && S.nodes[activeId]; if (!n) return; const m = neighbour(n, dir); if (!m) return;
  layoutSnap('swap'); settle();
  const f = n.in && S.nodes[n.in];
  if (f && ['pack', 'tile'].includes(f.mode)) { renumber(f); [n.order, m.order] = [m.order, n.order]; relayout(f); }
  else { const a = { x: n.x, y: n.y }, b = { x: m.x, y: m.y }; moveTree(n, b.x - n.x, b.y - n.y); moveTree(m, a.x - m.x, a.y - m.y); if (f) relayout(f); }
  renderLinks(); renderTree(); dirty();
}

// ---- the optimiser: group by links, spawns, pipes, arrows and shared tags; lay each group out in flow order; pack the groups
const SNAP = 24;
function optimise(f) {
  const items = (f ? kidsOf(f.id) : Object.values(S.nodes).filter(n => !n.in || !S.nodes[n.in])).filter(n => !stashed(n));
  if (!items.length) return;
  const label = f ? 'optimise ' + f.name : 'optimise the board';
  if (!f || !optimise.depth) { layoutSnap(label); settle(); }
  optimise.depth = (optimise.depth || 0) + 1;
  try {
    // inner folders first, deepest first, so each unit has its final size
    for (const k of items) if (k.kind === 'frame') { if ((k.mode || 'free') === 'free') optimise(k); else relayout(k); }
    if (f && (f.mode || 'free') !== 'free') { relayout(f); return; }
    // folder tabs keep screen size, so in world units they need LABEL_H / z; a package is only its tab, so its footprint is the tab's
    const z = Math.max(cam().z, 0.05), top = k => (k.kind === 'frame' ? Math.max(LABEL_H, LABEL_H / z) : 0), W = k => (k.kind === 'frame' && k.packed ? Math.max(k.w, 320 / z) : k.w);
    const set = new Map(items.map(n => [n.id, n]));
    const unit = id => { let cur = S.nodes[id]; let g = 0; while (cur && !set.has(cur.id) && g++ < 40) cur = cur.in && S.nodes[cur.in]; return cur && set.has(cur.id) ? cur : null; };
    // relations between units
    const rel = new Map(items.map(n => [n.id, new Set()])), flow = new Map(items.map(n => [n.id, new Set()]));
    const link = (a, b, directed) => { const ua = unit(a), ub = unit(b); if (!ua || !ub || ua === ub) return; rel.get(ua.id).add(ub.id); rel.get(ub.id).add(ua.id); if (directed) flow.get(ua.id).add(ub.id); };
    let E = []; try { E = graphData().E; } catch {}
    for (const e of E) if (e.type !== 'contains') link(e.a, e.b, e.type === 'spawn' || e.type === 'pipe');
    for (const e of S.edges) link(e.from, e.to, e.type === 'spawn' || e.type === 'pipe');
    for (const sh of S.shapes) if (sh.type === 'arrow' && sh.a?.id && sh.b?.id) link(sh.a.id, sh.b.id, true);
    const byTag = new Map();
    for (const n of items) for (const t of (n.tags || [])) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(n); }
    for (const list of byTag.values()) for (let i = 1; i < list.length; i++) link(list[0].id, list[i].id, false);
    // groups = connected components, kept in reading order of their first member
    const seen = new Set(), groups = [];
    for (const n of [...items].sort((a, b) => (a.y - top(a)) - (b.y - top(b)) || a.x - b.x)) {
      if (seen.has(n.id)) continue;
      const g = []; const q = [n.id]; seen.add(n.id);
      while (q.length) { const id = q.shift(); g.push(set.get(id)); for (const o of rel.get(id)) if (!seen.has(o)) { seen.add(o); q.push(o); } }
      groups.push(g);
    }
    // lay out one group: levels by flow (parents above children), left to right by original x within a level
    const GX = GAP, GY = GAP;
    const layoutGroup = g => {
      const ids = new Set(g.map(n => n.id)), level = new Map();
      const depth = (id, guard = 0) => { if (level.has(id)) return level.get(id); if (guard > 40) return 0; let d = 0; for (const n of g) if (flow.get(n.id).has(id) && n.id !== id) d = Math.max(d, depth(n.id, guard + 1) + 1); level.set(id, d); return d; };
      for (const n of g) depth(n.id);
      const rows = new Map(); for (const n of g) { const d = level.get(n.id) || 0; if (!rows.has(d)) rows.set(d, []); rows.get(d).push(n); }
      const area = g.reduce((s, k) => s + (W(k) + GX) * (k.h + top(k) + GY), 0), rowW = Math.max(Math.sqrt(area) * 1.6, ...g.map(k => W(k)));
      const placed = []; let y = 0;
      for (const d of [...rows.keys()].sort((a, b) => a - b)) {
        const row = rows.get(d).sort((a, b) => a.x - b.x); let x = 0, rowH = 0;
        for (const k of row) {
          if (x > 0 && x + W(k) > rowW) { x = 0; y += rowH + GY; rowH = 0; }
          placed.push({ k, x, y: y + top(k) }); x += W(k) + GX; rowH = Math.max(rowH, k.h + top(k));
        }
        y += rowH + GY;
      }
      const w = Math.max(...placed.map(p => p.x + W(p.k))), h = y - GY;
      return { placed, w, h };
    };
    const boxes = groups.map(layoutGroup);
    // pack the groups themselves into rows, then snap everything to the grid
    const x0 = Math.min(...items.map(k => k.x)), y0 = Math.min(...items.map(k => k.y - top(k)));
    const area = boxes.reduce((s, b) => s + (b.w + GAP * 2) * (b.h + GAP * 2), 0), rowW = Math.max(Math.sqrt(area) * 1.4, ...boxes.map(b => b.w));
    let x = 0, y = 0, rowH = 0;
    for (const b of boxes) {
      if (x > 0 && x + b.w > rowW) { x = 0; y += rowH + GAP * 2; rowH = 0; }
      for (const p of b.placed) { const nx = Math.round((x0 + x + p.x) / SNAP) * SNAP, ny = Math.round((y0 + y + p.y) / SNAP) * SNAP; moveTree(p.k, nx - p.k.x, ny - p.k.y); }
      x += b.w + GAP * 2; rowH = Math.max(rowH, b.h);
    }
    if (f) { setMode(f, 'free', true); }
  } finally {
    optimise.depth--;
    if (!optimise.depth) { restack(); renderShapes(); renderLinks(); renderTree(); dirty(); toast(`Optimised ${f ? f.name : 'the board'}: ${items.length} item(s). Ctrl-Z undoes.`); }
  }
}

// ---- leader key (Ctrl-Space) with a which-key popup. Its keymap is MAPS.leader in web/keys.js (DESIGN §6.4).
const LEADER = { on: false, pass: false, target: null, prefix: null };
const LEADERS = { 'C-SPC': { label: 'Ctrl-Space', key: 'C-SPC' }, 'C-M-SPC': { label: 'Ctrl-Alt-Space', key: 'C-M-SPC' }, 'F1': { label: 'F1', key: '<f1>' } };
function leaderName() { return S?.leader && LEADERS[S.leader] ? S.leader : 'C-SPC'; }
const leaderKeyName = () => LEADERS[leaderName()].key;
function isLeader(e) { return WBKeys.keyName(e) === leaderKeyName(); }
function setLeader(k) { if (!LEADERS[k]) return; S.leader = k; dirty(); keysToFrames(); toast('Leader key: ' + LEADERS[k].label + ' (press it twice to send it to the terminal or editor).'); }
// Open artifacts watch for the leader themselves (bridge.js); tell them when it changes.
function keysToFrames() { for (const L of Object.values(live)) if (L?.port) try { L.port.postMessage({ t: 'keys', keys: { leader: leaderKeyName() } }); } catch {} }
function folderMode(m, cascade) { const n = activeId && S.nodes[activeId]; const f = n && (n.kind === 'frame' ? n : n.in && S.nodes[n.in]); if (f) cascade ? setModeCascade(f, m) : setMode(f, m); else toast('Pick a folder or something inside one.'); }
function toggleFullscreen() { try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); } catch (e) { toast('Fullscreen is not available here.'); } }
function leaderOpen(prefix) {
  const wk = $('#which-key'); if (!wk) return;
  if (!LEADER.on) LEADER.target = document.activeElement;
  LEADER.on = true; LEADER.prefix = prefix || null; wk.hidden = false; wk.replaceChildren();
  const t = el('div', 'wk-title');
  const desks = '  ·  0 Board' + deskList().map(d => '  ·  ' + deskName(d)).join(''), n = deskTargets().length + ' item(s)';
  t.textContent = prefix === 'leader-v' ? 'Perspective (now: ' + perspCur() + ')'
    : prefix === 'leader-m' ? 'Send ' + n + ' to desk' + desks : prefix === 'leader-M' ? 'Send ' + n + ' to desk and go there' + desks : prefix === 'leader-da' ? 'Also on desk (' + n + ')' + desks
    : prefix === 'leader-d' ? 'Desk ' + deskName(deskAt(DESK.cur)) + (DESK.cur && !deskPinned(deskAt(DESK.cur)) ? ' (this device)' : '')
    : LEADERS[leaderName()].label + '  ·  desk ' + deskName(deskAt(DESK.cur)) + (WS.cur && S.nodes[WS.cur] ? '  ·  workspace ' + pathOf(WS.cur) : '') + (FOCUS.tabs.length ? '  ·  ' + FOCUS.tabs.length + ' tab(s)' : '') + (keyInterior(LEADER.target) ? '  ·  Esc leaves the card' : '');
  wk.append(t);
  const rows = WBKeys.rows(prefix || 'leader');
  if (!prefix) rows.push({ keys: 'leader', label: 'send the key through' });
  for (const r of rows) { const s = el('span'); const b = el('b'); b.textContent = r.keys; s.append(b, r.label); wk.append(s); }
}
function leaderClose() { LEADER.on = false; LEADER.prefix = null; const wk = $('#which-key'); if (wk) wk.hidden = true; }
function leaderKey(k, e) {
  const prefix = LEADER.prefix; leaderClose();
  if (k === leaderKeyName()) { // leader twice: pass the key through to the terminal or editor that had it (Emacs set-mark, tmux prefix)
    const t = LEADER.target; if (t && t.isConnected) {
      // keyCode is not settable from the constructor and xterm reads it (Ctrl-Space is keyCode 32 → NUL)
      const ev = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
      for (const p of ['keyCode', 'which']) Object.defineProperty(ev, p, { get: () => e.keyCode });
      LEADER.pass = true; try { t.dispatchEvent(ev); } finally { LEADER.pass = false; }
    }
    return;
  }
  const b = WBKeys.leaderResolve(k, prefix);
  if (!b) { toast('Leader: no binding for ' + WBKeys.label(k) + '. ' + LEADERS[leaderName()].label + ' ? lists them.'); return; }
  if (b.cmd[0] === '>') return leaderOpen(b.cmd.slice(1));
  KC[b.cmd]?.(e, k, 'leader');
}
// Leave the card that has the keyboard (K3): the keyboard goes back to the board and the card stays selected.
function leaveCard(t = document.activeElement) {
  const id = t?.closest?.('.node')?.dataset.id || (t?.tagName === 'IFRAME' && Object.keys(live).find(i => live[i]?.frame === t || live[i]?.el?.contains(t)));
  try { t?.blur?.(); } catch {}
  if (document.activeElement && document.activeElement !== document.body) try { document.activeElement.blur(); } catch {}
  if (id && S.nodes[id]) activate(id);
}
const activeNode = () => activeId && S.nodes[activeId] || null;
const activeFolderOf = () => { const n = activeNode(); return n && (n.kind === 'frame' ? n : n.in && S.nodes[n.in]) || null; };
function panBy(fx, fy) { const c = cam(); animateTo({ z: c.z, x: c.x + fx * VW() / 3 / c.z, y: c.y + fy * VH() / 3 / c.z }); }

// ---- hints (f on the board, leader ; from anywhere): a label on every card on screen and on the selected card's
// buttons; typing a label picks it, as Vimium and avy do. Mode pipe picks the target of a new pipe instead.
const HINTS = { on: false, typed: '', items: [], mode: 'pick', from: null };
const HINT_KEYS = 'fjdkslaghrueiwoqptyzxcvbnm';
function hintLabels(n) { const A = [...HINT_KEYS]; if (n <= A.length) return A.slice(0, n); const out = []; for (const a of A) for (const b of A) { if (out.length === n) return out; out.push(a + b); } return out; }
function hintsOpen(mode = 'pick', from = null) {
  if (VIEW !== 'canvas' && VIEW !== 'graph') setView('canvas');
  const items = [], vr = viewport.getBoundingClientRect();
  if (VIEW === 'canvas') for (const n of Object.values(S.nodes)) {
    const L = live[n.id]; if (stashed(n) || !L?.el?.isConnected || !L.el.getClientRects().length || (mode === 'pipe' && (n.id === from || n.kind === 'frame'))) continue;
    const a = w2s(n.x, n.kind === 'frame' ? n.y - LABEL_H : n.y), b = w2s(n.x + n.w, n.y + n.h);
    if (b.x < 0 || b.y < 0 || a.x > VW() || a.y > VH()) continue;
    items.push({ x: vr.left + clamp(a.x, 0, VW() - 30), y: vr.top + clamp(a.y, 0, VH() - 20), node: n });
  }
  if (mode === 'pick') {
    const scope = VIEW === 'graph' ? $('#g-card') : activeId && live[activeId]?.hdr;
    if (scope && !scope.hidden) for (const b of $$('button', scope)) if (b.getClientRects().length && !b.disabled) { const r = b.getBoundingClientRect(); items.push({ x: r.left, y: r.top, button: b }); }
  }
  if (!items.length) { toast(mode === 'pipe' ? 'No other card on screen to pipe to.' : 'Nothing on screen to pick.'); return; }
  const labels = hintLabels(items.length), box = el('div'); box.id = 'hints';
  items.forEach((it, i) => { it.label = labels[i]; it.el = el('span', 'hint' + (it.button ? ' hint-b' : '')); it.el.textContent = it.label; Object.assign(it.el.style, { left: it.x + 'px', top: it.y + 'px' }); box.append(it.el); });
  $('#hints')?.remove(); document.body.append(box);
  Object.assign(HINTS, { on: true, typed: '', items, mode, from });
}
function hintsClose() { HINTS.on = false; HINTS.items = []; $('#hints')?.remove(); }
function hintsType(k) {
  const typed = HINTS.typed + k, left = HINTS.items.filter(it => it.label.startsWith(typed));
  if (!left.length) { toast('No hint ' + typed + '. Esc cancels.'); return; }
  HINTS.typed = typed;
  const hit = left.find(it => it.label === typed);
  if (!hit) { for (const it of HINTS.items) it.el.hidden = !it.label.startsWith(typed); return; }
  const { mode, from } = HINTS; hintsClose();
  if (hit.button) return hit.button.click();
  const n = hit.node;
  if (mode === 'pipe') {
    if (S.edges.some(x => x.from === from && x.to === n.id)) return toast('Those nodes are already linked.');
    S.edges.push({ id: uid('e'), from, to: n.id, type: 'pipe' }); renderEdges(); dirty();
    return toast('Pipe added. Select text and press ⇢ to send it.');
  }
  activate(n.id);
}
// ---- card actions (. on the board): the selected card's buttons and commands, in the palette
const CARD_CMDS = ['Rename the active item…', 'Move the active item to a folder…', 'Branch the active shell, REPL or agent', 'Agent: start a new session in the active card (ends the current one)', 'Agent: end the active card\'s session (the card stays, ↻ revives)'];
function cardActions() {
  const scope = VIEW === 'graph' ? $('#g-card') : null, n = activeNode();
  if (!scope && !n) return toast('Select a card first: h j k l, or f for hints.');
  const items = [];
  const seen = new Set();
  for (const b of $$('button', scope || live[n.id].hdr)) {
    if (!b.getClientRects().length || b.disabled) continue;
    const l = (b.title || b.textContent || '').trim().split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, '');   // the title's first clause
    if (!l || seen.has(l)) continue; seen.add(l);
    items.push({ k: 'button', l, s: b.title ? b.textContent.trim() : '', run: () => b.click() });
  }
  if (n && !scope) {
    if (n.kind !== 'frame') items.push({ k: 'card', l: 'Pipe to… (pick the target with hints)', run: () => hintsOpen('pipe', n.id) });
    items.push({ k: 'card', l: 'Tag…', run: () => tagPrompt(n) }, { k: 'card', l: 'Arrange: move and resize with the keys', run: () => arrangeOpen() });
    for (const c of CMDS) if (CARD_CMDS.includes(c.l) && (!c.when || c.when())) items.push({ k: 'card', l: c.l, run: c.run });
  }
  openPicker(scope ? 'Actions of ' + (G.N.get(G.sel)?.label || 'the node') : 'Actions of ' + n.name, items);
}
// ---- arrange (m on the board): h j k l move the selected card by a grid step (in a pack or tile folder, by one place),
// H J K L resize it; Enter keeps it, Esc puts it back. One undo step.
const ARR = { on: false, id: null };
function arrangeOpen() {
  const n = activeNode(); if (!n) return toast('Select a card first: h j k l, or f for hints.');
  layoutSnap('arrange ' + n.name); ARR.on = true; ARR.id = n.id; live[n.id]?.el.classList.add('arranging');
  toast('Arrange ' + n.name + ': h j k l move · H J K L resize · Enter keeps it · Esc puts it back', 5000);
}
function arrangeMove(dx, dy) {
  const n = S.nodes[ARR.id]; if (!n) return arrangeDone(true);
  const f = n.in && S.nodes[n.in];
  if (f && ['pack', 'tile', 'stack'].includes(f.mode)) { renumber(f); n.order += (dx || dy) * 1.5; renumber(f); relayout(f); }
  else moveTree(n, dx * SNAP, dy * SNAP);
  renderLinks();
}
function arrangeSize(dw, dh) {
  const n = S.nodes[ARR.id]; if (!n) return arrangeDone(true);
  if (n.kind === 'frame') return toast('Folders take their size from their cards and their mode; drag the corner, or ⊞ for a tiled folder.');
  n.w = Math.max(200, n.w + dw * SNAP); n.h = Math.max(110, n.h + dh * SNAP); nodeResized(n); renderLinks();
}
function arrangeDone(cancel) {
  const n = S.nodes[ARR.id]; ARR.on = false; ARR.id = null; if (!n) return;
  live[n.id]?.el.classList.remove('arranging');
  if (cancel) { layoutUndo(); return; }
  const f = n.in && S.nodes[n.in] || null;
  if (!f || (f.mode || 'free') === 'free') adopt(n, f, { x: n.x + n.w / 2, y: n.y + 8 }, true); else { restack(); renderLinks(); dirty(); }
}
// ---- graph keys: h j k l move the selection to the nearest node that way, Enter takes the card's first action
function graphMove(dir) {
  if (!G.N.size) return;
  const cur = G.sel && G.pos.get(G.sel);
  const from = cur || { x: G.cam.x, y: G.cam.y };
  let best = null, bd = Infinity;
  for (const [id, p] of G.pos) {
    if (id === G.sel) continue;
    const dx = p.x - from.x, dy = p.y - from.y;
    const ok = !cur || (dir === 'l' ? dx > 0 && Math.abs(dy) <= Math.abs(dx) * 1.2 : dir === 'h' ? dx < 0 && Math.abs(dy) <= Math.abs(dx) * 1.2 : dir === 'j' ? dy > 0 && Math.abs(dx) <= Math.abs(dy) * 1.2 : dy < 0 && Math.abs(dx) <= Math.abs(dy) * 1.2);
    if (!ok) continue;
    const d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = id; }
  }
  if (best) { graphSelect(best); graphCenter(best); }
}
function graphOpen() { const b = G.sel && $('#g-card .ex-btns button'); if (b) b.click(); }

// The commands the keymaps of web/keys.js name. A command returns false when it did nothing, so the browser keeps the key.
const KC = {
  'palette.open': () => { PICK = null; openPalette(''); },
  'palette.commands': () => { PICK = null; openPalette('>'); },
  'dock.toggle': () => toggleDockTerm(),
  'pane.wider': () => { toggleSide(true, true); setPaneW((S.paneW || PANE_W) + 80, true); },
  'pane.narrower': () => { toggleSide(true, true); setPaneW((S.paneW || PANE_W) - 80, true); },
  'tree.toggle': () => toggleTree(),
  dictate: () => {
    if (VOICE.rec) return stopListening();
    if (VIEW === 'editor' && ED.view) dictateInto('editor');
    else if (focusedBuf && S.nodes[focusedBuf]) dictateInto(S.nodes[focusedBuf]);
    else toast('Dictation goes into a page: focus one first (Alt-V), or use the Review view.');
  },
  ...Object.fromEntries(VIEWS.map(v => ['view.' + v, () => setView(v)])),
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(i => [['desk.' + i, () => deskGo(i)], ['desk.send.' + i, () => deskSend(i)],
    ['desk.follow.' + i, () => deskSend(i, { follow: true })], ['desk.also.' + i, () => deskSend(i, { keep: true })]])),
  'desk.prev': () => deskGo(DESK.prev === DESK.cur ? 0 : DESK.prev), 'desk.new': () => deskNew(), 'desk.rename': () => deskRename(), 'desk.pin': () => deskPin(),
  'desk.off': () => deskSend(0), 'desk.which': () => deskAlso(), 'desk.delete': () => deskDelete(),
  'ws.last': () => wsToggleLast(),
  esc: () => { if (VIEW === 'graph' && G.sel) graphSelect(null); else if (tool !== 'select') setTool('select'); else if (PICKED.size) pickClear(); else if (FOCUS.cur) focusHide(); else if (WS.cur) wsLeave(); else if (TAG_FILTER) tagFilter(''); else return false; },
  help: () => { $('#help').hidden = false; },
  'overlay.close': () => closeOverlays(),
  // canvas
  ...Object.fromEntries([['left', 'h'], ['down', 'j'], ['up', 'k'], ['right', 'l']].flatMap(([d, k]) => [['card.' + d, () => focusMove(k)], ['card.swap' + d[0].toUpperCase() + d.slice(1), () => swapWith(k)],
    ['graph.' + d, () => graphMove(k)], ['arrange.' + d, () => arrangeMove({ h: -1, l: 1 }[k] || 0, { k: -1, j: 1 }[k] || 0)]])),
  'arrange.narrower': () => arrangeSize(-1, 0), 'arrange.wider': () => arrangeSize(1, 0), 'arrange.shorter': () => arrangeSize(0, -1), 'arrange.taller': () => arrangeSize(0, 1),
  'arrange.done': () => arrangeDone(false), 'arrange.cancel': () => arrangeDone(true), arrange: () => arrangeOpen(),
  hints: (e, k, via) => { if (via === 'leader') leaveCard(LEADER.target); hintsOpen('pick'); },
  'hints.letter': (e, k) => hintsType(k), 'hints.back': () => { HINTS.typed = HINTS.typed.slice(0, -1); for (const it of HINTS.items) it.el.hidden = !it.label.startsWith(HINTS.typed); }, 'hints.cancel': () => hintsClose(),
  'card.actions': () => cardActions(), 'graph.actions': () => cardActions(), 'graph.open': () => graphOpen(),
  'card.enter': () => { const n = activeNode(); if (!n) return false; n.kind === 'frame' ? wsEnter(n) : typeInto(n); },
  'card.tab': () => { const n = activeNode(); if (!n) return false; focusOpen(n); },
  'fold.toggle': (e, k, via) => { if (FOCUS.cur && via !== 'leader') return false; foldToggle(); },
  'fold.cycle': (e, k, via) => { if (FOCUS.cur && via !== 'leader') return false; foldCycle(); },
  'pan.left': () => panBy(-1, 0), 'pan.right': () => panBy(1, 0), 'pan.up': () => panBy(0, -1), 'pan.down': () => panBy(0, 1),
  'zoom.in': () => zoomAt(VW() / 2, VH() / 2, 1.25), 'zoom.out': () => zoomAt(VW() / 2, VH() / 2, 0.8),
  'zoom.card': () => { const n = activeNode(); if (!n) return toast('Select a card first: h j k l, or f for hints.'); jumpNode(n, 1); },
  fit: () => fitAll(),
  'camera.back': () => { const t = camBack.pop(); if (t) { camFwd.push({ ...cam() }); animateTo(t); } },
  'camera.forward': () => { const t = camFwd.pop(); if (t) { camBack.push({ ...cam() }); animateTo(t); } },
  compact: () => compact(PICKED.size ? 'selection' : 'all'),
  'optimise.board': () => optimise(null),
  'optimise.folder': () => { const f = activeFolderOf(); f ? optimise(f) : toast('Pick a folder or something inside one.'); },
  tag: () => tagPrompt(activeNode()),
  'selection.remove': () => { if (PICKED.size || SEL.strokes.size || SEL.shapes.size) removeSelection(); else if (selShape) removeShape(selShape); else return false; },
  'undo.layout': () => { if (!(LAYOUT_UNDO || REMOVE_UNDO)) return false; LAYOUT_UNDO ? layoutUndo() : removeUndo(); },
  'pan.hold': () => { space = true; return false; },
  ...Object.fromEntries(['select', 'rect', 'diamond', 'ellipse', 'arrow', 'area', 'pen', 'text', 'erase'].map(t => ['tool.' + t, () => setTool(t)])),
  // leader
  up: () => FOCUS.cur ? focusHide() : wsLeave(),
  'tab.close': () => FOCUS.cur && focusClose(FOCUS.cur), 'tab.next': () => focusCycle(1), 'tab.prev': () => focusCycle(-1),
  ...Object.fromEntries(['free', 'pack', 'tile', 'stack'].flatMap(m => [['folder.' + m, () => folderMode(m)], ['folder.' + m + '*', () => folderMode(m, true)]])),
  address: () => askName('Address (board:/path · fs:@host/dir · note:Title#Heading · tag:x · journal:2026/10/10 · link:Page)', currentAddr(), v => goAddr(v)),
  fullscreen: () => toggleFullscreen(),
  leave: () => leaveCard(LEADER.target),
  cancel: () => {},
  ...Object.fromEntries(['manual', 'process', 'fs', 'tag', 'tmux', 'proc', 'unit', 'journal', 'link'].map(p => ['persp.' + p, () => perspSet(p)])),
};
{ const missing = [...WBKeys.commands()].filter(c => !KC[c]); if (missing.length) console.error('keys: bound but not defined: ' + missing.join(', ')); }
cmd('Workspace: enter the active folder', () => { const n = activeId && S.nodes[activeId]; if (n?.kind === 'frame') wsEnter(n); else toast('Pick a folder first.'); }, '@card.enter');
cmd('Workspace: step out', () => wsLeave(), '@esc', () => !!WS.cur);
cmd('Workspace: switch…', () => { const list = wsTop(); askName('Workspace number: ' + list.map((f, i) => (i + 1) + ' ' + f.name).join('  ·  '), '', v => wsGo(+String(v).trim())); });
cmd('Workspace: last', () => wsToggleLast(), '@ws.last');
cmd('Focus: open the active node as a tab', () => { const n = activeId && S.nodes[activeId]; if (n) focusOpen(n); else toast('Pick a node first.'); }, '@card.tab');
cmd('Type into the active node', () => { const n = activeId && S.nodes[activeId]; if (n && n.kind !== 'frame') typeInto(n); else toast('Pick a node first.'); }, '@card.enter');
cmd('Focus: back to the canvas', () => focusHide(), '@esc', () => !!FOCUS.cur);
cmd('Focus: close this tab', () => focusClose(FOCUS.cur), '@tab.close', () => !!FOCUS.cur);
cmd('Focus: next tab', () => focusCycle(1), '@tab.next', () => FOCUS.tabs.length > 1);
cmd('Layout: optimise the board', onCanvas(() => optimise(null)), '@optimise.board');
cmd('Folder: next tile aspect ratio (⊞ again on a tiled folder)', onCanvas(() => { const n = activeId && S.nodes[activeId]; const f = n && (n.kind === 'frame' ? n : n.in && S.nodes[n.in]); f ? tileAspectCycle(f) : toast('Pick a folder or something inside one.'); }));
cmd('Layout: optimise the active folder', onCanvas(() => KC['optimise.folder']()), '@optimise.folder');
cmd('Fullscreen (browser)', () => toggleFullscreen(), '@fullscreen');
cmd('Leader key: which-key list', () => leaderOpen(), 'Ctrl-Space');
cmd('Hints: label the cards and buttons on screen, type one to pick it', () => KC.hints(), '@hints');
cmd('Card: actions of the selected card…', () => cardActions(), '@card.actions', () => !!activeNode());
cmd('Card: arrange it with the keys (move, resize)', onCanvas(() => arrangeOpen()), '@arrange', () => !!activeNode());
cmd('Zoom in', onCanvas(() => KC['zoom.in']()), '@zoom.in');
cmd('Zoom out', onCanvas(() => KC['zoom.out']()), '@zoom.out');
cmd('Zoom to the selected card', onCanvas(() => KC['zoom.card']()), '@zoom.card', () => !!activeNode());
for (const k of Object.keys(LEADERS)) cmd('Leader key: use ' + LEADERS[k].label, () => setLeader(k), '', () => leaderName() !== k);
// ---- packages: a folded folder is just its tab (user, 10:00). Tab folds and unfolds; Shift-Tab folds the siblings for focus, then unfolds all
const PKG = { w: 180, h: 10 };
function packFold(f, quiet = true) { if (!f || f.kind !== 'frame') return; if (f.mode !== 'stack') setMode(f, 'stack', true); f.packed = true; relayout(f); placeFrame(f); renderDeck(f); if (!quiet) toast(`${f.name} packaged. Tab opens it.`); }
function unfold(f) { if (!f || f.kind !== 'frame' || f.mode !== 'stack') return; setMode(f, f.prevMode && f.prevMode !== 'stack' ? f.prevMode : 'free', true); }
function foldTarget() { const n = activeId && S.nodes[activeId]; if (!n) return null; return n.kind === 'frame' ? n : (n.in && S.nodes[n.in]) || null; }
function foldToggle() {
  const f = foldTarget(); if (!f) { toast('Pick a folder, or something inside one, then Tab.'); return; }
  layoutSnap('fold ' + f.name);
  if (f.mode === 'stack') { unfold(f); activate(f.id); jumpNode(f, Math.max(cam().z, 0.5)); } else { packFold(f); activate(f.id); }
  restack(); renderTree(); renderLinks(); dirty();
}
function foldCycle() {
  // org-style global cycle over one level: fold every sibling folder except the active one, then unfold them all
  const f = foldTarget(); const parent = f ? (f.in && S.nodes[f.in]) || null : null;
  const level = frameList().filter(x => ((x.in && S.nodes[x.in]) || null) === parent && !stashed(x));
  const others = level.filter(x => x !== f);
  if (!others.length) { toast('Nothing else on this level to fold.'); return; }
  layoutSnap('fold level');
  const anyOpen = others.some(x => x.mode !== 'stack');
  for (const x of others) anyOpen ? packFold(x) : unfold(x);
  if (f && f.mode === 'stack' && !anyOpen) unfold(f);
  restack(); renderTree(); renderLinks(); dirty();
  toast(anyOpen ? `Folded ${others.length} folder(s) into packages${f ? '; ' + f.name + ' stays open' : ''}. Shift-Tab again unfolds them.` : `Unfolded ${others.length} folder(s).`);
}
cmd('Fold: package the active folder / unfold it', onCanvas(() => foldToggle()), '@fold.toggle');
cmd('Layout: push apart everything that overlaps', onCanvas(() => { layoutSnap('push apart'); settle(); const n = separateAll(); restack(); renderLinks(); renderTree(); dirty(); toast(n ? 'Pushed overlapping items apart. Ctrl-Z undoes.' : 'Nothing overlaps.'); }));
cmd('Layout: keep a boundary between items (no overlap)', () => { S.noOverlap = S.noOverlap === false ? true : false; dirty(); toast(S.noOverlap === false ? 'Items may overlap again.' : 'Items keep a boundary: the others move aside on drop, resize, unfold and new items.'); if (S.noOverlap !== false) { SEP.keep = null; for (const f of frameList()) if (!f.in) relayout(f); separate(null, null); restack(); renderLinks(); dirty(); } }, '', null);
cmd('Fold: package the other folders on this level (focus) / unfold all', onCanvas(() => foldCycle()), '@fold.cycle');

// ================================================================ v11: hosts, perspectives, cascading folder modes
// ---- hosts: a folder may carry a host {name, url, token}. Everything inside it that needs a process (shell, Emacs, file
// listing) runs on that host's daemon; folders without a host use the daemon that served the page. One page, one board,
// several daemons. Sampling always goes through the serving daemon (one API key, in its environment).
let HOSTLIST = [];           // from the serving daemon's /api/hosts (its hosts.json: name, url, token)
const HOSTCONN = {};         // url -> { rpc, down, since }
const hostKey = h => h ? h.url : '';
function hostRes(h) {        // a folder's host record resolved against hosts.json (the file wins on name; a typed URL stands alone)
  if (!h) return null;
  const known = HOSTLIST.find(x => x.name === h.name) || HOSTLIST.find(x => h.url && x.url === h.url);
  if (known) return known;
  if (!h.url) return null;
  return { name: h.name || h.url.replace(/^https?:\/\//, '').split(/[/:]/)[0], url: h.url.replace(/\/$/, ''), token: h.token || '' };
}
function hostOf(n) { for (let cur = n, g = 0; cur && g++ < 40; cur = cur.in && S.nodes[cur.in]) if (cur.kind === 'frame' && cur.host) return hostRes(cur.host); return null; }
function hostByUrl(url) { return hostRes(HOSTLIST.find(h => h.url === url) || frameList().map(f => f.host).find(h => h && h.url === url) || { url }); }
function hostByName(name) { const h = HOSTLIST.find(h => h.name === name) || frameList().map(f => f.host).find(h => h && h.name === name); return h ? hostRes(h) : null; }
function allHosts() { const m = new Map(); for (const h of HOSTLIST) m.set(h.url, h); for (const f of frameList()) { const h = f.host && hostRes(f.host); if (h && !m.has(h.url)) m.set(h.url, h); } return [...m.values()]; }
function hFetch(h, path, opts = {}) {
  if (h) return fetch(h.url + path, { ...opts, headers: { 'X-Token': h.token || '', ...(opts.headers || {}) } });
  return fetch(path, opts).catch(e => { netKick(); throw e; });   // same-origin cookies authenticate; a throw feeds the connection state
}
function hWs(h, path) { return h ? h.url.replace(/^http/, 'ws') + path + '?token=' + encodeURIComponent(h.token || '') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`; }
function rpcFor(h) { if (!h) return RPC; const c = HOSTCONN[h.url] || (HOSTCONN[h.url] = {}); return c.rpc || (c.rpc = new Rpc(h)); }
function fsSplit(raw) { const m = String(raw).match(/^@([^:]+):([\s\S]*)$/); return m ? { h: hostByName(m[1]), p: m[2] || '~' } : { h: null, p: raw }; }
function hostFrames(url) { return frameList().filter(f => f.host && hostRes(f.host)?.url === url); }
function hostDown(h) { const c = HOSTCONN[h.url] || (HOSTCONN[h.url] = {}); if (!c.down) { c.down = true; c.since = Date.now(); for (const f of hostFrames(h.url)) placeFrame(f); } }
function hostUp(h) { const c = HOSTCONN[h.url] || (HOSTCONN[h.url] = {}); if (c.down) { c.down = false; for (const f of hostFrames(h.url)) placeFrame(f); toast('@' + h.name + ' is reachable again.'); } }
// reconnect policy (the user's default): automatic, with backoff, for shells inside the open workspace; elsewhere a shell parks
// until ↻ on the folder tab, the palette, or entering that workspace
function hostAuto(n) { const f = WS.cur && S.nodes[WS.cur]; return !!f && (n.id === f.id || ancestors(n).some(a => a.id === f.id)); }
function hostRetry(url, loud) {
  let k = 0;
  for (const n of nodeList()) { const b = live[n.id]?.backend; if (b?.reconnect && n.hostUrl === url && b.parked) { b.reconnect(); k++; } }
  const c = HOSTCONN[url]; if (c?.rpc && c.rpc.ws.readyState > 1) { c.rpc.tries = 0; c.rpc.connect(); }
  if (loud) toast(k ? `Reconnecting ${k} shell(s)…` : 'No parked shell on that host.');
  return k;
}
async function hostsLoad() {
  try { const j = await (await hFetch(null, '/api/hosts')).json(); HOSTLIST = (j.hosts || []).map(h => ({ name: h.name, url: String(h.url).replace(/\/$/, ''), token: h.token || '', sample: !!h.sample })); } catch { HOSTLIST = []; }
  for (const f of frameList()) if (f.host) placeFrame(f);
  if (VIEW === 'ranger') renderRanger();
  return HOSTLIST;
}
function parseHost(v) {       // "build1" (from hosts.json) · "build1=http://192.0.2.7:7970#token" · "http://192.0.2.7:7970"
  v = String(v || '').trim(); if (!v) return null;
  const m = v.match(/^([\w.-]+)\s*=\s*(\S+)$/); let name = m ? m[1] : null, rest = m ? m[2] : v, token = '';
  const t = rest.match(/^(.*)#([\w-]+)$/); if (t) { rest = t[1]; token = t[2]; }
  if (/^https?:\/\/\S+$/.test(rest)) { const url = rest.replace(/\/$/, ''); return { name: name || url.replace(/^https?:\/\//, '').split(/[/:]/)[0], url, token }; }
  if (!name && HOSTLIST.find(h => h.name === rest)) return { name: rest };
  return null;
}
function setHost(f, h, quiet) {
  if (!f || f.kind !== 'frame') return;
  if (h) { const r = hostRes(h); f.host = r && HOSTLIST.includes(r) ? { name: r.name } : { name: h.name, url: h.url, ...(h.token ? { token: h.token } : {}) }; } else delete f.host;
  placeFrame(f); renderTree(); wsApply(false); if (VIEW === 'ranger') renderRanger(); dirty();
  if (!quiet) toast(h ? `${f.name} runs on @${hostRes(f.host)?.name || h.name}: new shells inside start there.` : `${f.name} runs on this machine again.`);
}
function newHostFolder(h) { const n = newAt('frame', { mode: 'free', shape: 'folder' }); n.name = hostRes(h)?.name || h.name || 'host'; setHost(n, h, true); return n; }
function hostFolder(h) { const r = hostRes(h); if (!r) return null; return hostFrames(r.url).find(f => !f.in) || hostFrames(r.url)[0] || newHostFolder(r); }
function hostPrompt(label, cb) {
  const known = HOSTLIST.map(h => h.name);
  askName(label + (known.length ? '. Known: ' + known.join(', ') : '. No hosts.json yet') + '. Or name=http://addr:port#token', known[0] || '', v => { const h = parseHost(v); if (!h) return toast('Give a host from hosts.json, or name=http://addr:port#token.'); cb(h); });
}
function hostFolderPrompt() { if (!DAEMON) return toast('Host folders need the local build: run canvasd and list hosts in ~/.canvas-proto/hosts.json.'); hostPrompt('Host for the new folder', h => { const f = newHostFolder(h); activate(f.id); }); }
function cwdMoved(n) { PERSP.onCwd?.(n); }
$('#add-host').onclick = () => hostFolderPrompt();
cmd('New host folder…', () => hostFolderPrompt(), '', () => DAEMON);
cmd('Folder: bind the active folder to a host…', () => { const f = foldTarget(); if (!f) return toast('Pick a folder first.'); hostPrompt('Host for ' + f.name, h => setHost(f, h)); }, '', () => DAEMON && !!activeId);
cmd('Folder: unbind from its host', () => { const f = foldTarget(); if (f?.host) setHost(f, null); }, '', () => !!foldTarget()?.host);
cmd('Host: reconnect the parked shells of the active folder', () => { const f = foldTarget(), h = f && hostOf(f); if (h) hostRetry(h.url, true); else toast('Pick a host folder first.'); }, '', () => !!(foldTarget() && hostOf(foldTarget())));
cmd('Host: reload hosts.json', () => hostsLoad().then(l => toast(l.length ? l.length + ' host(s): ' + l.map(h => h.name).join(', ') : 'No hosts in ' + (INFO?.state || '~/.canvas-proto') + '/hosts.json')), '', () => DAEMON);
AGENT_TOOLS.push(
  { name: 'list_hosts', description: 'List the hosts this Workbench can bind folders to (from hosts.json) and which folders use them.', inputSchema: { type: 'object', properties: {} },
    run: () => allHosts().map(h => `@${h.name} ${h.url}${HOSTCONN[h.url]?.down ? ' (down)' : ''}: ${hostFrames(h.url).map(f => fullPath(f)).join(', ') || 'no folder'}`).join('\n') || '(no hosts: add ~/.canvas-proto/hosts.json on the serving daemon)' },
  { name: 'host_folder', description: 'Make a folder bound to a host (its shells run there). host: a name from hosts.json or name=http://addr:port#token.', inputSchema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
    run: ({ host }) => { const h = parseHost(host); if (!h) throw new Error('unknown host ' + host); const f = newHostFolder(h); return `folder ${f.name} on @${hostRes(f.host)?.name}`; } },
);

// ---- cascading folder modes (user, 11:26): Shift-click a mode button, leader E B T R S, or the palette
function setModeCascade(f, m, quiet) {
  if (!f || f.kind !== 'frame' || !FICON[m]) return;
  const fs = [f, ...descendants(f.id).filter(d => d.kind === 'frame')].sort((a, b) => depthOf(b) - depthOf(a));   // deepest first, so each parent lays out settled children
  layoutSnap('cascade ' + m);
  for (const k of fs) if ((k.mode || 'free') !== m || m === 'free') setMode(k, m, true);
  restack(); renderTree(); renderLinks(); dirty();
  if (!quiet) toast(`${f.name} and ${fs.length - 1} nested folder(s): ${m}. Ctrl-Z undoes.`);
}
for (const [m, key] of [['free', 'E'], ['pack', 'B'], ['tile', 'T'], ['stack', 'S']]) cmd(`Folder: ${m}, cascading to the nested folders`, () => folderMode(m, true), '@folder.' + m + '*');
AGENT_TOOLS.push({ name: 'folder_mode', description: 'Set a folder\'s mode: free, pack, tile or stack. cascade applies it to the nested folders too. tile on a tiled folder steps to the next aspect ratio (screen, 16:9, 3:2, 4:3, 1:1, 3:4, 9:16).', inputSchema: { type: 'object', properties: { path: { type: 'string' }, mode: { type: 'string' }, cascade: { type: 'boolean' } }, required: ['path', 'mode'] },
  run: ({ path, mode, cascade }) => { const f = findFolder(path); if (!f) throw new Error('no folder at ' + path); if (!FICON[mode]) throw new Error('mode must be free, pack, tile or stack'); cascade ? setModeCascade(f, mode, true) : setMode(f, mode, true); return `${fullPath(f)}: ${mode}${cascade ? ' (cascaded)' : ''}`; } });

// ---- perspectives (user, 09:36): a folder is a view of one relation. The manual relation is the stored one; another
// perspective derives folders from a different relation and shows them with the same layout engine. While a derived
// perspective is shown, the manual relation and every position are kept in S.manual and restored exactly on return.
const PERSP = { building: false, onCwd: null, fsReady: true, edges: [] };
const PERSP_NAMES = { manual: 'manual: folders as you made them', process: 'process: a shell and what it spawned', fs: 'filesystem: directories on each host', tag: 'tags: one folder per tag, copies under the others', tmux: 'tmux: one folder per session on each host\'s socket', proc: 'processes: each shell with the OS processes under it', unit: 'units: systemd services on each host, shells under their unit', journal: 'journal: year › month › day over the dated pages and journal files', link: 'links: pages under the page that links to them (from one root)' };
const perspCur = () => S.persp || 'manual';
function perspSnapshot() {
  const snap = { in: {}, pos: {}, order: {}, frames: {} };   // order: a derived folder renumbers what it takes in
  for (const n of Object.values(S.nodes)) { snap.in[n.id] = n.in || null; snap.pos[n.id] = [n.x, n.y, n.w, n.h]; if ('order' in n) snap.order[n.id] = n.order; }
  for (const f of frameList()) snap.frames[f.id] = f;
  S.manual = snap;
}
// The board as the manual perspective holds it, built without touching the page: the stashed folders, each node's
// manual folder and rectangle, no derived folders or ghosts. A node made inside a derived folder goes home as in perspClear.
function manualNodesOf(nodes, snap) {
  const out = {};
  for (const [id, f] of Object.entries(snap.frames || {})) out[id] = f;
  for (const n of Object.values(nodes)) {
    if (n.kind === 'ghost' || (n.kind === 'frame' && n.derived) || out[n.id]) continue;
    const c = { ...n };
    if (snap.in && n.id in snap.in) { const p = snap.in[n.id]; if (p && (out[p] || (nodes[p] && !nodes[p].derived))) c.in = p; else delete c.in; [c.x, c.y, c.w, c.h] = snap.pos[n.id]; if (snap.order) { if (n.id in snap.order) c.order = snap.order[n.id]; else delete c.order; } }
    else if (c.in && !out[c.in]) {
      const hf = c.hostUrl && Object.values(out).find(f => f.kind === 'frame' && !f.derived && f.host && hostRes(f.host)?.url === c.hostUrl);
      if (hf) { c.in = hf.id; c.x = hf.x + PAD; c.y = hf.y + PAD + LABEL_H; } else delete c.in;
    }
    out[n.id] = c;
  }
  return out;
}
// What a save writes as nodes: a card shown in a focus tab keeps its place on the canvas, and a desk's or a perspective's
// layout gives way to the Board's.
function manualNodes() {
  let nodes = S.nodes; const f = FOCUS.cur && FOCUS.rect && nodes[FOCUS.cur];
  if (f) nodes = { ...nodes, [f.id]: { ...f, ...FOCUS.rect } };
  if (DESK.snap) return deskBoardOf(nodes);
  return perspCur() !== 'manual' && S.manual ? manualNodesOf(nodes, S.manual) : nodes;
}
function perspClear() {
  const snap = S.manual; if (!snap) return;
  for (const f of frameList()) if (f.derived) { const L = live[f.id]; if (L) { L.el.remove(); delete live[f.id]; } delete S.nodes[f.id]; }
  for (const n of nodeList()) if (n.kind === 'ghost') { const L = live[n.id]; if (L) { L.el.remove(); delete live[n.id]; } delete S.nodes[n.id]; }
  PERSP.edges = [];
  for (const [id, f] of Object.entries(snap.frames)) if (!S.nodes[id]) { S.nodes[id] = f; mount(f); }
  const landed = new Set();
  for (const n of Object.values(S.nodes)) {
    if (n.id in snap.in) { const p = snap.in[n.id]; if (p && S.nodes[p]) n.in = p; else delete n.in; const [x, y, w, h] = snap.pos[n.id]; Object.assign(n, { x, y, w, h }); if (snap.order) { if (n.id in snap.order) n.order = snap.order[n.id]; else delete n.order; } }
    else if (n.in && !S.nodes[n.in]) { const hf = n.hostUrl && hostFrames(n.hostUrl).find(f => !f.derived); if (hf) { n.in = hf.id; n.x = hf.x + PAD; n.y = hf.y + PAD + LABEL_H; landed.add(hf); } else delete n.in; }   // made inside a derived folder (an adopted tmux session): home is its host folder
    live[n.id]?.el.classList.remove('persp-dim');
  }
  delete S.manual;
  for (const n of Object.values(S.nodes)) placeAny(n);
  for (const hf of landed) relayout(hf, true);
}
function perspBuild(p) {
  perspSnapshot(); PERSP.building = true;
  for (const f of frameList()) { const L = live[f.id]; if (L) { L.el.remove(); delete live[f.id]; } delete S.nodes[f.id]; }
  for (const n of Object.values(S.nodes)) delete n.in;
  const related = new Set();
  if (p === 'process') {
    const spawner = n => { const e = S.edges.find(e => e.to === n.id && e.type === 'spawn' && S.nodes[e.from]); return e ? S.nodes[e.from] : null; };
    const spawned = n => S.edges.filter(e => e.from === n.id && e.type === 'spawn' && S.nodes[e.to]).map(e => S.nodes[e.to]);
    const build = n => {
      const f = addNode({ kind: 'frame', name: n.name, mode: 'pack', shape: 'folder', owner: n.id, derived: 'process', in: null, x: n.x - PAD, y: n.y - PAD - LABEL_H, w: Math.max(n.w + 2 * PAD, 520), h: n.h + 2 * PAD + LABEL_H });
      related.add(n.id); adopt(n, f, null, true);
      for (const c of spawned(n)) { related.add(c.id); if (spawned(c).length) adopt(build(c), f, null, true); else adopt(c, f, null, true); }
      return f;
    };
    for (const n of nodeList()) if (spawned(n).length && !spawner(n)) build(n);
  }
  if (p === 'tag') {
    const frameFor = {};
    const tagFrame = (t, near) => {
      if (frameFor[t]) return frameFor[t];
      const up = t.includes('/') ? t.slice(0, t.lastIndexOf('/')) : null, parent = up ? tagFrame(up, near) : null;
      const f = addNode({ kind: 'frame', name: '#' + t, mode: 'pack', shape: 'folder', derived: 'tag', tag: t, in: null, x: near.x - PAD, y: near.y - PAD - LABEL_H, w: 520, h: 300 });
      frameFor[t] = f; if (parent) adopt(f, parent, null, true); return f;
    };
    for (const n of nodeList()) {
      const tags = tagsOf(n).filter(t => t !== 'aggregator'); if (!tags.length) continue;
      related.add(n.id); adopt(n, tagFrame(tags[0], n), null, true);
      for (const t of tags.slice(1)) { const g = { id: uid('n'), kind: 'ghost', ghost: true, alias: n.id, name: n.name, in: tagFrame(t, n).id, order: 1e9, x: n.x, y: n.y, w: 220, h: 54 }; S.nodes[g.id] = g; mount(g); renumber(S.nodes[g.in]); relayout(S.nodes[g.in]); }
    }
  }
  if (p === 'tmux') tmuxPerspBuild(related);
  if (p === 'journal') journalPerspBuild(related);
  if (p === 'link') linkPerspBuild(related);
  if (p === 'proc') procPerspBuild(related);
  if (p === 'unit') unitPerspBuild(related);
  if (p === 'fs') {
    const idents = nodeList().map(n => [n, fsIdent(n)]).filter(([, i]) => i && i.dir);
    const byHost = {}; for (const [n, i] of idents) (byHost[i.host] ||= []).push([n, i]);
    for (const [host, list] of Object.entries(byHost)) {
      const first = list[0][0];
      fsFrameFor(host, fsCommonDir(list.map(([, i]) => i.dir)), { x: first.x - PAD, y: first.y - PAD - LABEL_H });
      for (const [n, i] of list) { related.add(n.id); adopt(n, fsFrameFor(host, i.dir, n), null, true); }
    }
  }
  PERSP.building = false;
  for (const n of nodeList()) live[n.id]?.el.classList.toggle('persp-dim', !related.has(n.id));
  separateAll();
}
function perspSet(p, quiet) {
  if (!PERSP_NAMES[p]) return;
  if (p === 'fs' && !PERSP.fsReady) { toast('The filesystem perspective comes in the next version.'); return; }
  if (p === 'tmux' && !DAEMON) { toast('The tmux perspective needs the local build: canvasd --tmux-socket PATH.'); return; }
  if (p === 'link' && !PERSP.linkRoot) { const n = n0(); const e = n && n.kind === 'buffer' ? n.name : (linkEntities().map(e => [e, linkTargets(e).length]).sort((a, b) => b[1] - a[1])[0] || [])[0]?.title; if (!e) { toast('No page links to another yet.'); return; } PERSP.linkRoot = e; }
  const cur = perspCur(); if (cur === p) { if (!quiet) toast('Already in the ' + p + ' perspective.'); return; }
  if (FOCUS.cur) focusHide();
  if (WS.cur) { WS.cur = null; WS.last = null; wsApply(false); }
  if (DESK.cur && p !== 'manual') deskGo(0, true);   // a perspective rewrites the Board's folders: it is shown on the Board only
  LAYOUT_UNDO = null;
  if (cur !== 'manual') perspClear();
  if (p !== 'manual') perspBuild(p);
  S.persp = p; viewSave(); perspChip(); restack(); renderTree(); renderLinks(); updateAllTitles(); if (VIEW === 'ranger') renderRanger(); dirty();
  if (!quiet) toast('Perspective ' + PERSP_NAMES[p] + (p === 'manual' ? '' : '. Dimmed items have no place in this relation.') + (p === 'fs' ? ' ☰ on a directory lists it.' : '') + (p === 'link' ? ' Root: ' + PERSP.linkRoot + ' (palette: Perspective: links from…).' : ''));
}
function perspRebuild() { const p = perspCur(); if (p === 'manual') return toast('The manual perspective is the stored one; nothing to rebuild.'); perspClear(); perspBuild(p); restack(); renderTree(); renderLinks(); dirty(); toast('Rebuilt the ' + p + ' perspective.'); }
function perspChip() {
  let chip = $('#persp-chip'); const p = perspCur();
  if (p === 'manual') { chip?.remove(); return; }
  if (!chip) { chip = el('div'); chip.id = 'persp-chip'; document.body.append(chip); }
  chip.replaceChildren('perspective: ' + p); const x = el('button', 'mini', '✕'); x.title = 'Back to the manual perspective (folders as you made them)'; x.onclick = () => perspSet('manual'); chip.append(x);
}
function perspMenu() { leaderOpen('leader-v'); }
cmd('Perspective: manual (folders as you made them)', () => perspSet('manual'), 'Ctrl-Space v m', () => perspCur() !== 'manual');
cmd('Perspective: process (a shell and what it spawned)', () => perspSet('process'), 'Ctrl-Space v p', () => perspCur() !== 'process');
cmd('Perspective: filesystem (directories on each host)', () => perspSet('fs'), 'Ctrl-Space v f', () => perspCur() !== 'fs');
cmd('Perspective: tags (one folder per tag, copies under the others)', () => perspSet('tag'), 'Ctrl-Space v t', () => perspCur() !== 'tag');
cmd('Perspective: tmux (one folder per session on each host\'s socket)', () => perspSet('tmux'), 'Ctrl-Space v x', () => perspCur() !== 'tmux' && DAEMON && !!INFO?.tmux);   // tmux:false: /api/tmux is 404 in wb-web
cmd('Perspective: processes (each shell with the OS processes under it)', () => perspSet('proc'), 'Ctrl-Space v c', () => perspCur() !== 'proc');
cmd('Perspective: units (systemd services on each host)', () => perspSet('unit'), 'Ctrl-Space v u', () => perspCur() !== 'unit');
cmd('Perspective: journal (year › month › day)', () => perspSet('journal'), 'Ctrl-Space v j', () => perspCur() !== 'journal');
cmd('Perspective: links from a page (the MOC view)…', () => askName('Root page or note', PERSP.linkRoot || (n0()?.kind === 'buffer' ? n0().name : ''), v => linkPerspFrom(v.trim())), 'Ctrl-Space v l');
cmd('Journal: today', () => journalOpen(TODAY), '', () => true);
cmd('Journal: next day (]d in the navigator)', () => journalStep(1), '', () => true);
cmd('Journal: previous day ([d in the navigator)', () => journalStep(-1), '', () => true);
cmd('Perspective: rebuild the derived folders', () => perspRebuild(), '', () => perspCur() !== 'manual');
cmd('Filesystem: list the active directory as ghost entries', () => { const f = foldTarget(); if (f?.derived === 'fs') fsExpand(f); else toast('Pick a directory folder in the filesystem perspective (Ctrl-Space v f).'); }, '', () => perspCur() === 'fs');
AGENT_TOOLS.push({ name: 'set_perspective', description: 'Switch the board perspective: manual (stored folders), process (spawn tree), fs (directories on each host), tag (one folder per tag), tmux (one folder per tmux session).', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  run: ({ name }) => { if (!PERSP_NAMES[name]) throw new Error('perspective must be manual, process, fs, tag, tmux, proc or unit'); perspSet(name, true); return 'perspective: ' + perspCur(); } });

// ---- filesystem perspective (user, 09:36): the host's directory tree is one more relation, tagged as its own edge kind.
// A directory is a derived folder (`derived: 'fs'`, `fsHost`, `fsPath`); a node sits in the directory it lives in: a shell in
// its cwd (it moves when the daemon reports a cd), an Emacs buffer or file artifact beside its file. Nothing lists a whole
// host: ☰ on a directory lists it once, as ghost cards; a ghost becomes real when opened. Symlinks: a ghost under its own
// directory with a dashed `symlink` edge to the target when that target is on the board. Dropping into a directory: a shell
// cd's there; a file is moved on the host (mv) after a confirm.
const fsDirname = p => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : i === 0 ? '/' : ''; };
const fsBase = p => p.replace(/\/$/, '').split('/').pop() || p;
function fsNorm(p, base) {
  if (!p) return p;
  if (!p.startsWith('/') && !p.startsWith('~')) p = (base || '/') + '/' + p;
  const out = []; for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
  return p.startsWith('~') ? out.join('/') : '/' + out.join('/');
}
function fsHome(host) { const h = host ? HOSTCONN[host]?.home : RG.home; return h || null; }
function fsTilde(p, host) { const h = fsHome(host); return h && p.startsWith('~') ? h + p.slice(1) : p; }
function fsCommonDir(dirs) { const segs = dirs.map(d => d.split('/')); const out = []; for (let i = 0; ; i++) { const s = segs[0][i]; if (s === undefined || segs.some(x => x[i] !== s)) break; out.push(s); } return out.join('/') || (dirs[0]?.startsWith('/') ? '/' : dirs[0] || '/'); }
function fsHostKey(n) { const h = n.hostUrl ? hostByUrl(n.hostUrl) : hostOf(n); return h ? h.url : ''; }
function fsIdent(n) {
  if (n.kind === 'frame') return n.derived === 'fs' ? { host: n.fsHost || '', dir: n.fsPath } : null;
  if (n.kind === 'ghost') return n.path ? { host: n.host || '', dir: fsDirname(n.path), path: n.path } : null;
  if (n.kind === 'term') {
    const host = fsHostKey(n), d = n.cwdLive || n.cwd;
    if (n.emacs) { const f = fsTilde(fsNorm(n.emacs, d || '~'), host); return { host, dir: fsDirname(f), path: f }; }
    if (!d) return null; return { host, dir: fsTilde(fsNorm(d), host) };
  }
  if (n.kind === 'artifact' && n.file) { const f = fsTilde(fsNorm(n.file, '~'), ''); return { host: '', dir: fsDirname(f), path: f }; }
  return null;
}
const fsFrame = (host, dir) => frameList().find(f => f.derived === 'fs' && (f.fsHost || '') === host && f.fsPath === dir);
const fsAncestorFrame = (host, dir) => frameList().some(f => f.derived === 'fs' && (f.fsHost || '') === host && (f.fsPath === dir || dir.startsWith(f.fsPath.replace(/\/$/, '') + '/')));
function fsFrameFor(host, dir, near) {
  let f = fsFrame(host, dir); if (f) return f;
  const up = fsDirname(dir), parent = up && up !== dir && fsAncestorFrame(host, up) ? fsFrameFor(host, up, near) : null;
  const hn = host ? hostByUrl(host) : null, was = PERSP.building; PERSP.building = true;
  f = addNode({ kind: 'frame', name: parent ? fsBase(dir) : dir + (hn ? ' @' + hn.name : ''), mode: 'pack', shape: 'folder', derived: 'fs', fsHost: host, fsPath: dir, in: null, ...(hn && !parent ? { host: { name: hn.name, url: hn.url } } : {}), x: near ? near.x - PAD : 0, y: near ? near.y - PAD - LABEL_H : 0, w: 520, h: 300 });
  if (parent) adopt(f, parent, null, true);
  PERSP.building = was; return f;
}
function mountGhost(n, L) {
  L.body.classList.add('ghost-body');
  if (n.journalDay && !n.noteId) { L.body.textContent = '▦ ' + n.name; L.body.title = 'No entry for ' + n.journalDay + ' yet. Double-click or ↗ creates it.'; L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  if (n.noteId && !n.alias) { L.body.textContent = '¶ ' + n.name + (n.meta ? '  ' + n.meta : ''); L.body.title = 'A note in the index, not on the board. Double-click or ↗ opens it' + (DAEMON ? ' in Emacs.' : '.'); L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  if (n.linkTitle && !n.alias) { L.body.textContent = '[[' + n.name + ']]  ' + (n.meta || 'no page yet'); L.body.title = 'Linked, but no page or note has this title. Double-click or ↗ creates the page.'; L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  if (n.alias) { const r = S.nodes[n.alias]; L.body.textContent = '≡ ' + (r?.name || n.name) + '  (' + (n.meta || 'also here') + ')'; L.body.title = 'A copy: the real node sits under its first tag. Double-click or ↗ jumps to it.'; L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  if (n.tmuxTarget) { L.body.textContent = '⌗ ' + n.name + (n.meta ? '  ' + n.meta : ''); L.body.title = 'tmux session ' + n.tmuxTarget + ' with no card yet. Double-click or ↗ adopts it.'; L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  if (n.procPid) { L.body.textContent = '⚙ ' + n.name + (n.meta ? '  ' + n.meta : ''); L.body.title = 'Process ' + n.procPid + (n.cmd ? ': ' + n.cmd : '') + '. Double-click or ↗ shows it in the navigator.'; L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  if (n.unitName) { L.body.textContent = (n.unitState === 'failed' ? '✗ ' : n.unitState === 'active' ? '● ' : '○ ') + n.name + (n.meta ? '  ' + n.meta : ''); L.body.title = n.unitName + ': ' + (n.unitState || '') + '. Double-click or ↗ shows its status in the navigator.'; L.body.classList.toggle('bad', n.unitState === 'failed'); L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); }; return; }
  L.body.textContent = (n.hardlink ? '⧉ ' : n.mount ? '⛁ ' : n.dir ? '▸ ' : '· ') + n.name + (n.link ? '  →  ' + n.link : n.hardlink ? '  (also ' + (S.nodes[n.hardlink]?.path || 'elsewhere') + ')' : n.nlink > 1 ? '  ×' + n.nlink : n.mount ? '  mount' : '');
  L.body.title = n.path + (n.link ? ' → ' + n.link : n.hardlink ? ' is the same file as ' + (S.nodes[n.hardlink]?.path || '?') + ' (one inode, two names)' : n.nlink > 1 ? ' has ' + n.nlink + ' names (hard links)' : n.mount ? ' is a mount point' : '') + '. Double-click or ↗ to open.';
  L.body.ondblclick = ev => { ev.stopPropagation(); ghostOpen(n); };
}
function removeGhost(n) { const L = live[n.id]; if (L) { L.el.remove(); delete live[n.id]; } delete S.nodes[n.id]; PERSP.edges = PERSP.edges.filter(e => e.from !== n.id && e.to !== n.id); }
async function fsExpand(f) {
  if (!f || f.derived !== 'fs') { toast('Pick a directory folder in the filesystem perspective.'); return 0; }
  const host = f.fsHost || '', h = host ? hostByUrl(host) : null; let entries;
  if (!DAEMON) { const d = fsGet(f.fsPath.replace(/^~/, '/home/me')); entries = d?.t === 'd' ? Object.entries(d.c).map(([k, v]) => ({ name: k, dir: v.t === 'd' || (v.t === 'l' && fsGet(v.d)?.t === 'd'), link: v.t === 'l' ? v.d : undefined, ino: v.ino, dev: v.ino ? 1 : undefined, nlink: v.ino ? fsNlink(v.ino) : undefined, mount: v.mount })) : []; }
  else { try { const r = await hFetch(h, '/api/ls?path=' + encodeURIComponent(f.fsPath)); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); entries = j.entries; if (f.fsPath === '~' && j.path) { if (h) (HOSTCONN[host] ||= {}).home = j.path; else RG.home = RG.home || j.path; } } catch (e) { toast('Could not list ' + f.fsPath + (h ? ' on @' + h.name : '') + ': ' + (e.message || e)); return 0; } }
  const have = new Set(kidsOf(f.id).map(k => k.kind === 'frame' ? k.fsPath : fsIdent(k)?.path).filter(Boolean));
  let k = 0, order = kidsOf(f.id).length;
  for (const e of entries.slice(0, 150)) {
    const path = f.fsPath.replace(/\/$/, '') + '/' + e.name; if (have.has(path)) continue;
    const n = { id: uid('n'), kind: 'ghost', ghost: true, name: e.name, path, dir: !!e.dir, link: e.link, host, in: f.id, order: order++, x: f.x + PAD, y: f.y + PAD, w: 220, h: 54 };
    if (e.mount) n.mount = true;
    if (e.nlink > 1) { n.nlink = e.nlink; n.ino = e.ino; n.dev = e.dev; const twin = nodeList().find(m => m.kind === 'ghost' && m !== n && (m.host || '') === host && m.ino === e.ino && m.dev === e.dev); if (twin) n.hardlink = twin.id; }
    S.nodes[n.id] = n; mount(n); k++;
  }
  f.fsListed = true;
  SEP.keep = f; relayout(f, true); SEP.keep = null; restack(); renderTree(); perspEdgesRebuild(); renderLinks(); dirty();
  toast(k ? `${f.fsPath}: ${k} entr${k === 1 ? 'y' : 'ies'} as ghost cards${entries.length > 150 ? ' (first 150)' : ''}. Open one to make it real.` : `${f.fsPath}: nothing new to list.`);
  return k;
}
function ghostOpen(n) {
  if (!n || n.kind !== 'ghost') return null;
  if (n.alias) { const r = S.nodes[n.alias]; if (r) jumpNode(r); return r || null; }
  if (n.journalDay && !n.noteId) { journalOpen(n.journalDay); return null; }
  if (n.noteId) { const r = noteById(n.noteId); if (r) return noteOpen(r); toast('That note is no longer in the index.'); return null; }
  if (n.linkTitle) { const f = n.in && S.nodes[n.in]; const p = addNode({ kind: 'buffer', name: n.linkTitle, text: '# ' + n.linkTitle + '\n\n- ', in: f ? f.id : undefined, x: n.x, y: n.y, w: 420, h: 300 }); removeGhost(n); if (f) { renumber(f); relayout(f, true); } restack(); renderTree(); dirty(); return p; }
  if (n.procPid) { goAddr('proc:' + (n.host && hostByUrl(n.host) ? '@' + hostByUrl(n.host).name : '') + '/' + n.procPid); return null; }
  if (n.unitName) { goAddr('unit:' + (n.host && hostByUrl(n.host) ? '@' + hostByUrl(n.host).name : '') + '/' + n.unitName); return null; }
  if (n.tmuxTarget) { const f = n.in && S.nodes[n.in]; const real = tmuxAdopt(n.tmuxTarget, n.host ? hostByUrl(n.host) : null, { in: f ? f.id : undefined, x: n.x, y: n.y }); if (real) { removeGhost(n); if (f) { renumber(f); relayout(f, true); } restack(); renderTree(); dirty(); } return real; }
  const f = n.in && S.nodes[n.in], host = n.host || '', target = n.link ? fsNorm(n.link, fsDirname(n.path)) : n.path;
  if (n.dir) { const d = fsFrameFor(host, n.link ? target : n.path, n); if (n.mount) { d.mount = true; placeFrame(d); } removeGhost(n); if (f) relayout(f, true); restack(); renderTree(); renderLinks(); dirty(); fsExpand(d); activate(d.id); return d; }
  let real;
  if (!DAEMON) { const file = fsGet(target.replace(/^~/, '/home/me')); real = addNode({ kind: 'buffer', name: n.name, text: file?.t === 'f' ? file.d : '# ' + n.name + '\n', in: f ? f.id : undefined, x: n.x, y: n.y, w: 460, h: 320 }); }
  else { real = addNode({ kind: 'term', backend: 'pty', cmd: emacsCmd(target), emacs: target, name: n.name, in: f ? f.id : undefined, x: n.x, y: n.y, w: 640, h: 440, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } }); live[real.id]?.el.classList.add('emacs'); }
  removeGhost(n); if (f) { renumber(f); relayout(f, true); } restack(); renderTree(); perspEdgesRebuild(); renderLinks(); dirty();
  return real;
}
function perspEdgesRebuild() {
  PERSP.edges = []; if (perspCur() !== 'fs') return;
  const byPath = new Map();
  for (const n of Object.values(S.nodes)) { const p = n.kind === 'frame' ? (n.derived === 'fs' ? n.fsPath : null) : fsIdent(n)?.path, host = n.kind === 'frame' ? (n.fsHost || '') : (fsIdent(n)?.host || ''); if (p) byPath.set(host + '|' + p, n); }
  for (const n of Object.values(S.nodes)) if (n.kind === 'ghost' && n.link) { const t = byPath.get((n.host || '') + '|' + fsNorm(n.link, fsDirname(n.path))); if (t && t !== n) PERSP.edges.push({ id: 'pe:' + n.id, from: n.id, to: t.id, type: 'symlink', persp: true }); }
  for (const n of Object.values(S.nodes)) if (n.kind === 'ghost' && n.hardlink && S.nodes[n.hardlink]) PERSP.edges.push({ id: 'pe:' + n.id, from: n.id, to: n.hardlink, type: 'hardlink', persp: true });
}
function fsDrop(n, t) {
  const host = t.fsHost || '', dst = t.fsPath, hn = host ? hostByUrl(host) : null, where = dst + (hn ? ' @' + hn.name : ''), i = fsIdent(n);
  const settle = () => { PERSP.building = true; adopt(n, t, null, true); PERSP.building = false; perspEdgesRebuild(); renderLinks(); updateTitle(n); dirty(); };
  if (n.kind === 'frame') return toast('Directories are moved from a shell (mv); these folders mirror the host.');
  if (n.kind === 'term' && !n.emacs) {   // a shell lives in its cwd: dropping it into a directory is cd
    if ((i?.host || '') !== host) return toast('That directory is on another host; open a shell there instead.');
    if (n.backend === 'pty') { live[n.id]?.backend?.input?.(` cd '${dst.replace(/'/g, "'\\''")}'\r`); toast(`${n.name}: cd ${dst}. It moves when the shell reports its new directory.`); }
    else { n.cwd = dst.replace(/^~/, '/home/me'); settle(); toast(`${n.name}: cd ${dst}`); }
    return;
  }
  if (!i?.path) return toast(`${n.name} has no file on a host; only files and shells move between directories.`);
  if ((i.host || '') !== host) return toast('Moving a file to another host is not supported; copy it from a shell.');
  if (fsDirname(i.path) === dst) return;
  const newPath = dst.replace(/\/$/, '') + '/' + fsBase(i.path);
  ask(`Move ${i.path} into ${where}? Enter = yes, Esc = no`, 'yes', async v => {
    if (!/^y/i.test(v)) return;
    if (DAEMON) { try { const r = await hFetch(hn, '/api/mv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src: i.path, dst: newPath }) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); } catch (e) { toast('mv failed: ' + (e.message || e)); return; } }
    else { const src = fsGet(i.path.replace(/^~/, '/home/me')), dd = fsGet(dst.replace(/^~/, '/home/me')), parent = fsGet(fsDirname(i.path).replace(/^~/, '/home/me')); if (!src || !dd || dd.t !== 'd' || !parent) return toast('mv failed in the demo filesystem.'); delete parent.c[fsBase(i.path)]; dd.c[fsBase(i.path)] = src; }
    if (n.kind === 'ghost') { n.path = newPath; const L = live[n.id]; if (L) mountGhost(n, L); } else if (n.emacs) n.emacs = newPath; else if (n.file) n.file = newPath;
    settle();
    toast(`Moved to ${newPath}${hn ? ' on @' + hn.name : ''}.${n.emacs ? ' Emacs still shows the old buffer; revert it there.' : ''}`);
  });
}
PERSP.onCwd = n => {
  if (perspCur() !== 'fs' || n.emacs) return;
  const i = fsIdent(n); if (!i) return;
  const cur = n.in && S.nodes[n.in]; if (cur?.derived === 'fs' && cur.fsPath === i.dir && (cur.fsHost || '') === i.host) return;
  const f = fsFrameFor(i.host, i.dir, n);
  PERSP.building = true; adopt(n, f, null, true); PERSP.building = false;
  live[n.id]?.el.classList.remove('persp-dim'); restack(); renderTree(); renderLinks(); dirty();
};

// ================================================================ v12: the path grammar and one navigator over every relation
// Every node has an address `relation:path`: board:/Research/canvas · fs:@build1/srv (host omitted for the serving daemon) ·
// note:Title#Heading#^anchor · tag:grc/vocab · journal:2026/10/10 · link:Page. proc:, tmux: and unit: are reserved for the
// host's own trees (v13, v14). The navigator walks any of them with the same columns; the canvas shows the active perspective;
// the URL hash carries the current address so that every place is a link.
const ADDR_KINDS = ['board', 'fs', 'note', 'tag', 'journal', 'link', 'proc', 'tmux', 'unit', 'attn'];
const ADDR_RESERVED = {};
function parseAddr(a) {
  const m = String(a || '').trim().match(/^([a-z]+):([\s\S]*)$/); if (!m || !ADDR_KINDS.includes(m[1])) return null;
  let rest = m[2], host = null;
  if (['fs', 'proc', 'tmux', 'unit'].includes(m[1])) { const hm = rest.match(/^@([\w.-]+)(.*)$/); if (hm) { host = hm[1]; rest = hm[2]; } }
  return { kind: m[1], host, path: rest };
}
function fsAddr(hostUrl, path) { const h = hostUrl ? hostByUrl(hostUrl) : null; return 'fs:' + (h ? '@' + h.name : '') + (path || '~'); }
function addrOf(n) {
  if (!n) return '';
  if (n.kind === 'frame' && n.derived === 'fs') return fsAddr(n.fsHost, n.fsPath);
  if (n.kind === 'frame' && n.derived === 'tag') return 'tag:' + n.tag;
  if (n.kind === 'ghost' && n.alias) return addrOf(S.nodes[n.alias]);
  if (n.kind === 'ghost' && n.tmuxTarget) return tmuxAddr(n.host, n.tmuxTarget);
  if (n.kind === 'ghost' && n.procPid) return 'proc:' + (n.host && hostByUrl(n.host) ? '@' + hostByUrl(n.host).name : '') + '/' + n.procPid;
  if (n.kind === 'ghost' && n.unitName) return 'unit:' + (n.host && hostByUrl(n.host) ? '@' + hostByUrl(n.host).name : '') + '/' + n.unitName;
  if (n.kind === 'frame' && n.derived === 'proc') return S.nodes[n.owner] ? addrOf(S.nodes[n.owner]) : 'proc:' + (n.procHost && hostByUrl(n.procHost) ? '@' + hostByUrl(n.procHost).name : '') + '/' + n.procPid;
  if (n.kind === 'frame' && n.derived === 'unit') return 'unit:' + (n.unitHost && hostByUrl(n.unitHost) ? '@' + hostByUrl(n.unitHost).name : '') + '/' + (n.unitName || '');
  if (n.kind === 'frame' && n.derived === 'tmux') return tmuxAddr(n.tmuxHost, n.tmuxSess);
  if (n.kind === 'ghost') return fsAddr(n.host, n.path);
  if (n.kind === 'frame' && n.derived === 'process') return S.nodes[n.owner] ? addrOf(S.nodes[n.owner]) : 'board:/' + n.name;
  if (S.manual && perspCur() !== 'manual') {   // inside a derived perspective the board address is still the manual one
    const parts = []; let cur = S.manual.in[n.id], g = 0;
    while (cur && g++ < 40) { const f = S.manual.frames[cur] || S.nodes[cur]; if (!f) break; parts.unshift(f.name); cur = S.manual.in[cur]; }
    return 'board:/' + [...parts, n.name].join('/');
  }
  return 'board:/' + (n.kind === 'frame' ? fullPath(n) : (folderPath(n) ? folderPath(n) + '/' : '') + n.name);
}
// navigator keys <-> addresses. Keys: node id · 'root' · 'fs:[@host:]path' · 'tag:x' · 'note:<id>' · 'journal:Y/M/D' · 'link:Title'
function keyToAddr(key) {
  if (key === 'root') return 'board:/';
  if (isFs(key)) { const { h, p } = fsSplit(key.slice(FS_PREFIX.length)); return 'fs:' + (h ? '@' + h.name : '') + p; }
  if (key.startsWith('note:')) { const r = noteById(key.slice(5)); return r ? 'note:' + noteAddrPath(r) : key; }
  if (key.startsWith('tmux:')) { const t = tmuxSplitKey(key.slice(5)); return 'tmux:' + (t.host ? '@' + t.host + '/' : t.path ? '/' : '') + t.path; }
  if (key.startsWith('proc:') || key.startsWith('unit:')) { const k = key.slice(0, 4), t = tmuxSplitKey(key.slice(5)); return k + ':' + (t.host ? '@' + t.host + '/' : t.path ? '/' : '') + t.path; }
  if (/^(tag|journal|link|attn):/.test(key)) return key;
  return S.nodes[key] ? addrOf(S.nodes[key]) : key;
}
function addrToKey(addr) {
  const a = parseAddr(addr); if (!a) return null;
  if (a.kind === 'board') { const p = a.path.replace(/^\/+|\/+$/g, ''); if (!p) return 'root'; const f = findFolder(p); if (f) return f.id; const n = boardAt(p); return n ? n.id : null; }
  if (a.kind === 'fs') { const h = a.host ? hostByName(a.host) : null; if (a.host && !h) return null; return FS_PREFIX + (h ? '@' + h.name + ':' : '') + (a.path || '~'); }
  if (a.kind === 'note') { if (!a.path) return 'note:'; const r = noteByAddrPath(a.path); return r ? 'note:' + r.id : null; }
  if (a.kind === 'journal') { let p = a.path.replace(/^\/+|\/+$/g, ''); if (p === 'today') p = TODAY.replace(/-/g, '/'); else if (/^\d{4}-\d{2}-\d{2}$/.test(p)) p = p.replace(/-/g, '/'); return 'journal:' + p; }
  if (a.kind === 'link') return 'link:' + a.path.replace(/^\/+|\/+$/g, '');
  if (a.kind === 'tmux') { if (a.host && !hostByName(a.host)) return null; return 'tmux:' + (a.host ? '@' + a.host + ':' : '') + a.path.replace(/^\/+|\/+$/g, ''); }
  if (a.kind === 'proc') { if (a.host && !hostByName(a.host)) return null; const pid = a.path.replace(/^\/+|\/+$/g, '').split('/').pop(); if (pid && !/^\d+$/.test(pid)) return null; return 'proc:' + (a.host ? '@' + a.host + ':' : '') + pid; }
  if (a.kind === 'unit') { if (a.host && !hostByName(a.host)) return null; return 'unit:' + (a.host ? '@' + a.host + ':' : '') + a.path.replace(/^\/+|\/+$/g, ''); }
  if (a.kind === 'attn') return 'attn:' + a.path.replace(/^\/+|\/+$/g, '');
  return a.kind + ':' + a.path;
}
function boardAt(p) { const parts = p.split('/'), name = parts.pop().toLowerCase(), dir = parts.join('/').toLowerCase(); return nodeList().find(n => n.name.toLowerCase() === name && folderPath(n).toLowerCase() === dir) || nodeList().find(n => n.name.toLowerCase() === name) || null; }
function resolveAddr(addr) {
  const a = parseAddr(addr); if (!a) return { error: 'not an address: ' + addr + ' (relation:path; relations ' + ADDR_KINDS.join(', ') + ')' };
  if (ADDR_RESERVED[a.kind]) return { error: ADDR_RESERVED[a.kind] };
  const key = addrToKey(addr); if (key == null) return { error: 'nothing at ' + addr };
  const n = S.nodes[key] || null;
  return { key, n, entries: rgEntries(key), addr: keyToAddr(key) };
}
// the notes index as the navigator sees it (the daemon's SQLite index; in demo mode the board's pages stand in)
const NOTES = { rows: [], at: 0, byPath: {} };
function notesDemoRows() {
  const rows = [];
  for (const p of pages()) { const text = pageText(p), lines = text.split('\n'); rows.push({ id: p.id, path: p.name + '.md', title: p.name, kind: 'file', tags: tagsOf(p), body: lines.slice(0, 12).join('\n'), line: 1, board: p });
    lines.forEach((ln, i) => { const m = ln.match(/^(#{1,6}) (.*)$/); if (m) rows.push({ id: p.id + '#' + (i + 1), path: p.name + '.md', title: m[2].replace(/\s*\^[\w-]+$/, ''), kind: 'heading', level: m[1].length, tags: [], body: lines.slice(i + 1, i + 6).join('\n'), line: i + 1, board: p }); }); }
  return rows;
}
async function notesLoad(force) {
  if (!force && Date.now() - NOTES.at < 30000) return NOTES.rows;
  if (!DAEMON) NOTES.rows = notesDemoRows();
  else { try { const j = await (await hFetch(null, '/api/nodes?limit=20000')).json(); NOTES.rows = j.nodes || []; } catch { NOTES.rows = []; } }
  NOTES.at = Date.now(); NOTES.byPath = {}; NOTES.tree = {}; for (const r of NOTES.rows) (NOTES.byPath[r.path] ||= []).push(r);
  if (DAEMON) linksLoad(force);
  if (VIEW === 'ranger') renderRanger();
  return NOTES.rows;
}
const noteFiles = () => NOTES.rows.filter(r => r.kind === 'file');
const noteById = id => NOTES.rows.find(r => r.id === id) || null;
function noteAddrPath(r) { const f = r.kind === 'file' ? r : (NOTES.byPath[r.path] || []).find(x => x.kind === 'file'); const t = (f || r).title.replace(/[#]/g, ''); if (r.kind === 'file') return t; const an = String(r.id).match(/#\^([\w-]+)$/); return t + '#' + r.title.replace(/[#]/g, '') + (an ? '#^' + an[1] : ''); }
function noteByAddrPath(p) {
  const am = p.match(/^#?\^([\w-]+)$/); if (am) return NOTES.rows.find(x => String(x.id).endsWith('#^' + am[1])) || null;   // an anchor alone finds its block anywhere
  const segs = p.split('#'), title = segs[0], anchor = segs.length > 1 && /^\^/.test(segs[segs.length - 1]) ? segs.pop() : undefined, heading = segs.length > 1 ? segs[segs.length - 1] : undefined;
  const f = noteFiles().find(r => r.title.toLowerCase() === title.toLowerCase()) || noteFiles().find(r => r.path.replace(/\.(md|org)$/, '').toLowerCase() === title.toLowerCase());
  if (!f) return null; if (!heading) return f;
  const rows = NOTES.byPath[f.path] || [];
  if (anchor) { const an = anchor.replace(/^\^/, ''); const r = rows.find(x => String(x.id).endsWith('#^' + an)); if (r) return r; }
  return rows.find(x => x.kind !== 'file' && x.title.toLowerCase() === heading.toLowerCase()) || null;
}
const LINKS = { g: null, at: 0, p: null };
function linksLoad(force) {
  if (!DAEMON) return Promise.resolve(LINKS.g);
  if (LINKS.p) return LINKS.p;   // one fetch in flight: every caller awaits the same one
  if (!force && Date.now() - LINKS.at < 30000) return Promise.resolve(LINKS.g);
  return LINKS.p = (async () => { try { LINKS.g = await (await hFetch(null, '/api/links')).json(); } catch { LINKS.g = null; } LINKS.at = Date.now(); LINKS.p = null; if (VIEW === 'ranger') renderRanger(); return LINKS.g; })();
}
const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g;
const linkTitle = t => t.replace(/^id:/, '').split('#')[0].trim();
// a "page-like" thing: a board page or an index file. Board pages win when a title is both.
function linkEntity(title) { const p = findPage(title); if (p) return { title: p.name, page: p }; const r = noteFiles().find(f => f.title.toLowerCase() === String(title).toLowerCase() || f.path.replace(/\.(md|org)$/, '').toLowerCase() === String(title).toLowerCase()); return r ? { title: r.title, note: r } : null; }
const entityKey = e => e.page ? 'p:' + e.page.id : 'n:' + e.note.id;
function linkEntities() { const out = pages().map(p => ({ title: p.name, page: p })), seen = new Set(out.map(e => e.title.toLowerCase())); for (const r of noteFiles()) if (!seen.has(r.title.toLowerCase())) { out.push({ title: r.title, note: r }); seen.add(r.title.toLowerCase()); } return out; }
// titles an entity links to, with how many times (the pick rule for multi-parent nodes = the parent that links most)
function linkTargets(e) {
  const c = {};
  if (e.page) for (const m of pageText(e.page).matchAll(WIKI_RE)) { const t = linkTitle(m[1]); if (t && t.toLowerCase() !== e.title.toLowerCase()) c[t] = (c[t] || 0) + 1; }
  else if (LINKS.g) for (const l of LINKS.g.links) if (l.srcFile === e.note.id) { const t = l.dstFile ? (LINKS.g.files[l.dstFile]?.title || linkTitle(l.dst)) : l.kind === 'title' || l.kind === 'file' ? linkTitle(l.dst) : null; if (t && l.dstFile !== e.note.id) c[t] = (c[t] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ title: t, n }));
}
function backlinkCount(x) {   // x: a board page, an index file row, or a title
  const title = typeof x === 'string' ? x : x.kind === 'buffer' ? x.name : x.title, low = title.toLowerCase();
  let n = 0;
  for (const p of pages()) if (p.name.toLowerCase() !== low) for (const m of pageText(p).matchAll(WIKI_RE)) if (linkTitle(m[1]).toLowerCase() === low) n++;
  if (LINKS.g) { const f = Object.entries(LINKS.g.files).find(([, v]) => v.title.toLowerCase() === low); if (f) n += LINKS.g.backlinks[f[0]] || 0; }
  return n;
}
function backlinksOfTitle(title) {
  const low = title.toLowerCase(), out = [];
  for (const p of pages()) if (p.name.toLowerCase() !== low) { const lines = pageText(p).split('\n'); lines.forEach((ln, i) => { for (const m of ln.matchAll(WIKI_RE)) if (linkTitle(m[1]).toLowerCase() === low) out.push({ title: p.name, page: p, line: i + 1, text: ln.trim() }); }); }
  if (LINKS.g) { const f = Object.entries(LINKS.g.files).find(([, v]) => v.title.toLowerCase() === low); if (f) for (const l of LINKS.g.links) if (l.dstFile === f[0] && l.srcFile !== f[0]) { const row = noteById(l.src) || noteById(l.srcFile); out.push({ title: LINKS.g.files[l.srcFile]?.title || l.path, note: row, line: l.line, text: '[[' + l.dst + ']]' }); } }
  return out;
}
const JOURNAL_RE = /^(?:journal|daily|dailies)\/(\d{4})-(\d{2})-(\d{2})\.(?:md|org)$/;
const journalRows = () => noteFiles().map(r => { const m = r.path.match(JOURNAL_RE) || r.title.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? { r, y: m[1], mo: m[2], d: m[3] } : null; }).filter(Boolean);
// v16: the heading tree of a file. A heading's parent is the nearest heading above it with a smaller level; a list item hangs under
// the nearest heading above it; everything else hangs from the file. Computed once per index load, per file.
function noteTree(path) {
  const t = (NOTES.tree ||= {}); if (t[path]) return t[path];
  const rows = (NOTES.byPath[path] || []).filter(x => x.kind !== 'file').slice().sort((a, b) => a.line - b.line), file = (NOTES.byPath[path] || []).find(x => x.kind === 'file');
  const parent = {}, kids = {}, stack = [];   // stack of open headings [row]
  for (const r of rows) {
    if (r.kind === 'heading') { while (stack.length && stack[stack.length - 1].level >= (r.level || 1)) stack.pop(); parent[r.id] = stack.length ? stack[stack.length - 1].id : (file ? file.id : null); stack.push(r); }
    else parent[r.id] = stack.length ? stack[stack.length - 1].id : (file ? file.id : null);
    (kids[parent[r.id]] ||= []).push(r);
  }
  return t[path] = { parent, kids, file };
}
const noteKids = r => (noteTree(r.path).kids[r.id] || []);
const noteParent = r => { const p = noteTree(r.path).parent[r.id]; return p ? noteById(p) : null; };
function noteEntry(r) { const kids = noteKids(r), bl = r.kind === 'file' ? backlinkCount(r) : 0; return { key: 'note:' + r.id, name: r.title, kind: r.kind === 'file' ? 'inote' : 'iblock', dir: kids.length > 0, note: r, meta: [r.kind === 'file' ? (kids.length ? String(kids.length) : '') : (r.kind === 'item' ? 'item' : 'h' + r.level), bl ? '← ' + bl : ''].filter(Boolean).join(' · ') }; }
function rgPerspRoots() {
  if (!NOTES.at) notesLoad();
  const out = [{ key: 'tag:', name: '# tags', kind: 'persp', dir: true, meta: 'tag:' }, { key: 'note:', name: '¶ notes', kind: 'persp', dir: true, meta: 'note:' }, { key: 'journal:', name: '▦ journal', kind: 'persp', dir: true, meta: 'journal:' }, { key: 'link:', name: '⇄ links', kind: 'persp', dir: true, meta: 'link:' }];
  out.push({ key: 'tmux:', name: '⌗ tmux', kind: 'persp', dir: true, meta: 'tmux:' }, { key: 'proc:', name: '⚙ processes', kind: 'persp', dir: true, meta: 'proc:' }, { key: 'unit:', name: '⊙ units', kind: 'persp', dir: true, meta: 'unit:' }, { key: 'attn:', name: '! attention', kind: 'persp', dir: true, meta: attnCount() ? String(attnCount()) : '' });
  return out;
}
function allTags() { const t = new Set(); for (const n of nodeList()) for (const x of tagsOf(n)) if (x !== 'aggregator') t.add(x); for (const r of NOTES.rows) for (const x of r.tags || []) t.add(String(x).toLowerCase()); return [...t].sort(); }
function rgRelList(key) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (ADDR_RESERVED[kind]) return [];
  if (kind === 'tmux') return tmuxRelList(rest);
  if (kind === 'proc') return procRelList(rest);
  if (kind === 'unit') return unitRelList(rest);
  if (kind === 'attn') return attnList();
  if (kind === 'tag') {
    const tags = allTags(), pre = rest ? rest + '/' : '';
    const subs = [...new Set(tags.filter(t => t.startsWith(pre) && t !== rest).map(t => pre + t.slice(pre.length).split('/')[0]))];
    const out = subs.map(t => ({ key: 'tag:' + t, name: '#' + t.slice(pre.length), kind: 'itag', dir: true, meta: String(nodeList().filter(n => tagsOf(n).includes(t)).length + NOTES.rows.filter(r => (r.tags || []).map(x => String(x).toLowerCase()).includes(t)).length) }));
    if (rest) { for (const n of nodeList()) if (tagsOf(n).includes(rest)) out.push(rgEntryOf(n)); for (const r of NOTES.rows) if ((r.tags || []).map(x => String(x).toLowerCase()).includes(rest)) out.push(noteEntry(r)); }
    return out;
  }
  if (kind === 'note') { if (!rest) return noteFiles().sort((a, b) => a.path.localeCompare(b.path)).map(noteEntry); const r = noteById(rest); return r ? noteKids(r).map(noteEntry) : []; }
  if (kind === 'journal') {
    const rows = journalRows(), parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) return [...new Set(rows.map(x => x.y))].sort().reverse().map(y => ({ key: 'journal:' + y, name: y, kind: 'ijournal', dir: true, meta: String(rows.filter(x => x.y === y).length) }));
    if (parts.length === 1) return [...new Set(rows.filter(x => x.y === parts[0]).map(x => x.mo))].sort().reverse().map(mo => ({ key: 'journal:' + parts[0] + '/' + mo, name: parts[0] + '-' + mo, kind: 'ijournal', dir: true, meta: String(rows.filter(x => x.y === parts[0] && x.mo === mo).length) }));
    if (parts.length === 2) return rows.filter(x => x.y === parts[0] && x.mo === parts[1]).sort((a, b) => b.d.localeCompare(a.d)).map(x => ({ ...noteEntry(x.r), key: 'journal:' + x.y + '/' + x.mo + '/' + x.d, name: x.y + '-' + x.mo + '-' + x.d + (x.r.title !== x.y + '-' + x.mo + '-' + x.d ? '  ' + x.r.title : '') }));
    const x = rows.find(x => x.y === parts[0] && x.mo === parts[1] && x.d === parts[2]); return x ? (NOTES.byPath[x.r.path] || []).filter(r => r.kind !== 'file').map(noteEntry) : [];
  }
  if (kind === 'link') {
    const entry = (e, n) => { const out = linkTargets(e).length, bl = backlinkCount(e.title); return { key: 'link:' + e.title, name: e.title, kind: e.page ? 'buffer' : 'inote', dir: out > 0, n: e.page, note: e.note, link: e, meta: [n ? '×' + n : '', out ? '→ ' + out : '', bl ? '← ' + bl : ''].filter(Boolean).join(' ') }; };
    if (!rest) return linkEntities().map(e => [e, linkTargets(e).length, backlinkCount(e.title)]).filter(([, o, i]) => o || i).sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]) || a[0].title.localeCompare(b[0].title)).map(([e]) => entry(e));
    const e = linkEntity(rest); if (!e) return [];
    return linkTargets(e).map(({ title, n }) => { const q = linkEntity(title); return q ? entry(q, n > 1 ? n : 0) : { key: 'link:' + title, name: title, kind: 'ghost', dir: false, link: { title }, meta: 'no page yet', go: () => openPage(title) }; });
  }
  return [];
}
function rgRelParent(key) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (!rest) return 'root';
  if (kind === 'tmux') { const t = tmuxSplitKey(rest), pre = t.host ? '@' + t.host + ':' : ''; if (!t.path) return 'tmux:'; const parts = t.path.split(':'); parts.pop(); return 'tmux:' + (parts.length ? pre + parts.join(':') : t.host ? pre : ''); }
  if (kind === 'proc') { const t = tmuxSplitKey(rest), pre = t.host ? '@' + t.host + ':' : ''; if (!t.path) return 'proc:'; const p = procData(t.h).byPid[+t.path], up = p && procData(t.h).byPid[p.ppid]; return 'proc:' + (up ? pre + up.pid : t.host ? pre : ''); }
  if (kind === 'unit') { const t = tmuxSplitKey(rest), pre = t.host ? '@' + t.host + ':' : ''; return 'unit:' + (t.path && t.host ? pre : ''); }
  if (kind === 'attn') return 'attn:';
  if (kind === 'tag') return rest.includes('/') ? 'tag:' + rest.slice(0, rest.lastIndexOf('/')) : 'tag:';
  if (kind === 'journal') { const parts = rest.split('/').filter(Boolean); parts.pop(); return 'journal:' + parts.join('/'); }
  if (kind === 'note') { const r = noteById(rest); const p = r && r.kind !== 'file' && noteParent(r); return p ? 'note:' + p.id : 'note:'; }
  return kind + ':';
}
// v16: the journal as a tree (year > month > day) over journal/YYYY-MM-DD.md and board pages named by date
const journalDays = () => { const days = {}; for (const p of pages()) if (isJournal(p)) days[p.name] = { day: p.name, page: p }; for (const x of journalRows()) { const d = x.y + '-' + x.mo + '-' + x.d; if (!days[d]) days[d] = { day: d, note: x.r }; } return Object.values(days).sort((a, b) => a.day.localeCompare(b.day)); };
const journalKey = day => 'journal:' + day.replace(/-/g, '/');
function journalCurrentDay() {
  if (VIEW === 'ranger') { const m = String(RG.dir).match(/^journal:(\d{4})\/(\d{2})\/(\d{2})$/); if (m) return m[1] + '-' + m[2] + '-' + m[3]; const e = rgCur().e; const k = e && String(e.key).match(/^journal:(\d{4})\/(\d{2})\/(\d{2})$/); if (k) return k[1] + '-' + k[2] + '-' + k[3]; if (e?.note) { const r = journalRows().find(x => x.r === e.note); if (r) return r.y + '-' + r.mo + '-' + r.d; } if (e?.n && isJournal(e.n)) return e.n.name; }
  if (VIEW === 'editor' && ED.node && isJournal(ED.node)) return ED.node.name;
  const n = n0(); if (n && isJournal(n)) return n.name;
  return TODAY;
}
async function journalOpen(day, quiet) {
  if (day === 'today') day = TODAY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { toast('A day is YYYY-MM-DD.'); return null; }
  const p = findPage(day); if (p) { if (VIEW === 'ranger') rgGo(journalKey(day)); else edOpen(p); return p; }
  await notesLoad(); const x = journalRows().find(x => x.y + '-' + x.mo + '-' + x.d === day);
  if (x) { if (VIEW === 'ranger') rgGo(journalKey(day)); else noteOpen(x.r); return x.r; }
  if (!DAEMON) { const n = openPage(day, null, true); if (!quiet) toast('New journal page ' + day); if (VIEW === 'ranger') { await notesLoad(true); rgGo(journalKey(day)); } else edOpen(n); return n; }
  try { const r = await hFetch(null, '/api/journal', { method: 'POST', body: JSON.stringify({ day }), headers: { 'Content-Type': 'application/json' } }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); await notesLoad(true); const y = journalRows().find(x => x.y + '-' + x.mo + '-' + x.d === day); if (!quiet) toast((j.created ? 'Created ' : 'Opened ') + j.path); if (VIEW === 'ranger') rgGo(journalKey(day)); else if (y) noteOpen(y.r); return y ? y.r : null; } catch (e) { toast('Journal: ' + e.message); return null; }
}
function journalStep(delta) {
  const cur = journalCurrentDay(), days = journalDays().map(d => d.day);
  const next = delta > 0 ? days.find(d => d > cur) : days.slice().reverse().find(d => d < cur);
  if (!next) { if (delta > 0 && cur < TODAY) return journalOpen(TODAY); toast(delta > 0 ? 'No later journal entry (today is ' + TODAY + ').' : 'No earlier journal entry.'); return null; }
  return journalOpen(next, true);
}
function journalPerspBuild(related) {
  const frames = {}, c = viewCenterWorld(); let gx = c.x - 600;
  const frameFor = (key, name, parent) => { if (frames[key]) return frames[key]; const f = addNode({ kind: 'frame', name, mode: 'pack', shape: 'folder', derived: 'journal', journal: key, in: null, x: gx, y: c.y - 200, w: 560, h: 320 }); if (parent) adopt(f, parent, null, true); else gx += 620; return frames[key] = f; };
  const days = journalDays(); if (!days.some(d => d.day === TODAY)) days.push({ day: TODAY, empty: true });
  for (const d of days.sort((a, b) => a.day.localeCompare(b.day))) {
    const [y, mo] = d.day.split('-'), yf = frameFor(y, y), mf = frameFor(y + '-' + mo, y + '-' + mo, yf);
    if (d.page) { related.add(d.page.id); adopt(d.page, mf, null, true); continue; }
    const g = { id: uid('n'), kind: 'ghost', ghost: true, journalDay: d.day, noteId: d.note ? d.note.id : undefined, name: d.day + (d.empty ? '  (today, no entry yet)' : d.note && d.note.title !== d.day ? '  ' + d.note.title : ''), in: mf.id, order: 1e9, x: mf.x + PAD, y: mf.y + PAD, w: 300, h: 54 };
    S.nodes[g.id] = g; mount(g); renumber(mf); relayout(mf);
  }
}
// v16: the link perspective, rooted at one page (the MOC view). A page sits under the parent that links to it most; other parents hold a copy.
function linkPerspBuild(related) {
  const rootT = PERSP.linkRoot, root = rootT && linkEntity(rootT); if (!root) { PERSP.linkWait = 'no page named ' + rootT; return; }
  const best = {}, order = [root.title.toLowerCase()], q = [root], seen = new Set(order), edges = [];
  while (q.length) { const e = q.shift(); for (const { title, n } of linkTargets(e)) { const low = title.toLowerCase(); if (low === root.title.toLowerCase()) continue; edges.push([e.title, title, n]); if (!best[low] || best[low].n < n) best[low] = { parent: e.title.toLowerCase(), parentTitle: e.title, n, title }; if (!seen.has(low)) { seen.add(low); order.push(low); const q2 = linkEntity(title); if (q2 && order.length < 200) q.push(q2); } } }
  const childrenOf = low => order.filter(x => best[x] && best[x].parent === low).sort((a, b) => best[b].n - best[a].n);
  const c = viewCenterWorld(), frames = {};
  const build = (e, parentF, depth) => {
    const low = e.title.toLowerCase(), kids = childrenOf(low);
    const f = addNode({ kind: 'frame', name: '⇄ ' + e.title, mode: 'pack', shape: 'folder', derived: 'link', linkTitle: e.title, in: null, x: c.x - 300, y: c.y - 200, w: 600, h: 340 }); frames[low] = f; if (parentF) adopt(f, parentF, null, true);
    if (e.page) { related.add(e.page.id); adopt(e.page, f, null, true); } else ghostIn(f, { noteId: e.note.id, name: e.title, meta: '← ' + backlinkCount(e.title) });
    for (const low2 of kids) { const t = best[low2].title, q2 = linkEntity(t); if (q2 && childrenOf(low2).length && depth < 4) build(q2, f, depth + 1); else if (q2?.page) { related.add(q2.page.id); adopt(q2.page, f, null, true); } else if (q2) ghostIn(f, { noteId: q2.note.id, name: t, meta: '← ' + backlinkCount(t) }); else ghostIn(f, { linkTitle: t, name: t, meta: 'no page yet' }); }
    for (const [from, to, n] of edges) if (from.toLowerCase() === low && best[to.toLowerCase()]?.parent !== low) { const q2 = linkEntity(to); ghostIn(f, { alias: q2?.page?.id, noteId: q2?.note?.id, linkTitle: !q2 ? to : undefined, name: to, meta: (n > 1 ? '×' + n + ' ' : '') + (q2 ? 'also under ' + best[to.toLowerCase()].parentTitle : 'no page yet') }); }
    return f;
  };
  build(root, null, 0);
}
function ghostIn(f, props) { const g = { id: uid('n'), kind: 'ghost', ghost: true, in: f.id, order: 1e9, x: f.x + PAD, y: f.y + PAD, w: 300, h: 54, ...props }; S.nodes[g.id] = g; mount(g); renumber(f); relayout(f); return g; }
function linkPerspFrom(title) { const e = title && linkEntity(title); if (!e) { toast('No page or note named ' + title); return; } PERSP.linkRoot = e.title; if (perspCur() === 'link') { perspClear(); perspBuild('link'); restack(); renderTree(); renderLinks(); dirty(); toast('Links from ' + e.title); } else perspSet('link'); }
function noteOpen(r) {
  if (r.board) { edOpen(r.board, r.line > 1 ? r.line : undefined); return r.board; }
  if (!DAEMON) { toast('That note is not on the board.'); return null; }
  const f = INFO?.notes ? INFO.notes.replace(/\/$/, '') + '/' + r.path : r.path;
  const n = newEmacs(f); if (n && r.line > 1) n.cmd = n.cmd.replace(/emacsclient -t -a '' "\$f"/, `emacsclient -t -a '' +${r.line} "$f"`).replace(/emacs -nw "\$f"/, `emacs -nw +${r.line} "$f"`);
  return n;
}
// go to an address: board nodes on the canvas, everything else in the navigator
function goAddr(addr, push = true) {
  const r = resolveAddr(addr); if (r.error) { toast(r.error); return false; }
  if (r.n && !isFs(r.key)) { r.n.kind === 'frame' ? (VIEW === 'ranger' ? rgGo(r.key) : jumpFolder(r.n)) : (VIEW === 'ranger' ? rgGo(rgParent(r.key) || 'root', r.key) : jumpNode(r.n)); }
  else if (r.key === 'root') { if (VIEW === 'ranger') rgGo('root'); else fitAll(); }
  else { if (VIEW !== 'ranger') setView('ranger'); const e = r.entries; if (!r.entries.length && !isFs(r.key) && !/^(tag|note|journal|link):$/.test(r.key)) { const par = rgParent(r.key); rgGo(par || 'root', r.key); } else rgGo(r.key); void e; }
  if (push) hashSync(r.addr, true);
  return true;
}
const HASH = { busy: false, last: '' };
function currentAddr() { if (VIEW === 'ranger') return keyToAddr(RG.dir); const n = activeId && S.nodes[activeId]; return n ? addrOf(n) : (WS.cur && S.nodes[WS.cur] ? addrOf(S.nodes[WS.cur]) : 'board:/'); }
function hashSync(addr, push) {
  addr = addr || currentAddr(); if (!addr || addr === HASH.last) return;
  HASH.last = addr; HASH.busy = true;
  try { if (push) history.pushState(null, '', '#' + addr); else history.replaceState(null, '', '#' + addr); } catch {}
  setTimeout(() => { HASH.busy = false; }, 0);
}
function hashInit() {
  const start = decodeURIComponent(location.hash.slice(1));
  if (start && parseAddr(start)) setTimeout(() => goAddr(start, false), 400);
  addEventListener('hashchange', () => { if (HASH.busy) return; const a = decodeURIComponent(location.hash.slice(1)); if (a && parseAddr(a) && a !== HASH.last) { HASH.last = a; goAddr(a, false); } });
  setInterval(() => { if (!HASH.busy && !document.hidden) hashSync(); }, 1500);
}
cmd('Go to address…', () => askName('Address (board:/path · fs:@host/dir · note:Title#Heading · tag:x · journal:2026/10/10 · link:Page · tmux:@host/session)', currentAddr(), v => goAddr(v)), 'Ctrl-Space a · ga in the navigator');
cmd('Copy the address of the active node', () => { const n = activeId && S.nodes[activeId]; if (n) { copyText(addrOf(n)); toast(addrOf(n)); } else toast('Pick a node first.'); });
AGENT_TOOLS.push(
  { name: 'list_addr', description: 'List what an address holds: board:/folder, fs:@host/dir, note:Title (its headings), tag:x, journal:2026/10, link:Page, tmux:@host/ (sessions). Returns one entry per line with its own address.', inputSchema: { type: 'object', properties: { addr: { type: 'string' } }, required: ['addr'] },
    run: async ({ addr }) => { if (/^(note|tag|journal):/.test(addr)) await notesLoad(); const r = resolveAddr(addr); if (r.error) throw new Error(r.error); if (isFs(r.key)) { rgEntries(r.key); await new Promise(res => setTimeout(res, 700)); } const es = rgEntries(r.key); return es.map(e => `${keyToAddr(e.key)}${e.dir ? '/' : ''}${e.n ? ' · ' + (e.n.kind === 'frame' ? 'folder' : e.n.kind) : e.note ? ' · ' + e.note.kind : e.kind === 'file' ? ' · file' : ''}${e.meta ? ' · ' + e.meta : ''}`).join('\n') || '(empty)'; } },
  { name: 'open_addr', description: 'Go to an address: a board node is shown on the canvas, anything else opens in the navigator.', inputSchema: { type: 'object', properties: { addr: { type: 'string' } }, required: ['addr'] },
    run: async ({ addr }) => { if (/^(note|tag|journal):/.test(addr)) await notesLoad(); const r = resolveAddr(addr); if (r.error) throw new Error(r.error); goAddr(addr); return 'at ' + r.addr; } },
  { name: 'node_addr', description: 'The address of a node (by board path), or of the active node when path is empty.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: ({ path } = {}) => { const n = path ? (findNode(path) || findFolder(path)) : activeId && S.nodes[activeId]; if (!n) throw new Error('no node at ' + (path || '(active)')); return addrOf(n); } },
  { name: 'cd_shell', description: 'Send cd to a shell so that it moves to a directory given as an fs: address (fs:/srv or fs:@host/srv). shell: the shell\'s board path; empty = the active shell.', inputSchema: { type: 'object', properties: { addr: { type: 'string' }, shell: { type: 'string' } }, required: ['addr'] },
    run: ({ addr, shell }) => { const a = parseAddr(addr); if (!a || a.kind !== 'fs') throw new Error('addr must be fs:[@host]/dir'); const n = shell ? findNode(shell) : activeId && S.nodes[activeId]; if (!n || n.kind !== 'term') throw new Error('no shell at ' + (shell || '(active)')); const h = a.host ? hostByName(a.host) : null; if (a.host && !h) throw new Error('unknown host @' + a.host); if (hostKey(h) !== hostKey(hostOf(n))) throw new Error('that directory is on another host than the shell'); const d = a.path || '~'; const b = live[n.id]?.backend; if (n.backend === 'pty') b?.input?.(` cd '${d.replace(/'/g, "'\\''")}'\r`); else if (b) { b.input(`cd ${d}\r`); } else throw new Error('shell not live'); return `${pathOf(n.id)}: cd ${d}`; } },
);
// ---- dropping into a tag folder tags the node; dragging between tag folders retags it; out of a tag folder removes the tag
function tagDrop(n, t, from) {
  const real = n.kind === 'ghost' && n.alias ? S.nodes[n.alias] : n; if (!real || real.kind === 'frame') { toast('Tag folders take nodes, not folders.'); return; }
  const add = t?.derived === 'tag' ? t.tag : null, rm = from?.derived === 'tag' ? from.tag : null;
  if (add && !t) return;
  if (rm) setTags(real, [rm], { remove: true });
  if (add) setTags(real, [add]);
  toast(`${real.name}: ${tagsOf(real).filter(x => x !== 'aggregator').map(x => '#' + x).join(' ') || 'no tags'}`);
  perspRebuild();
}
// ---- v13: tmux sessions on each host's shared socket. A terminal card is a tmux session (wb-<id>) when the daemon runs with
// --tmux-socket: it survives daemon restarts. Sessions other programs made there (the control-panel agents) are listed under
// tmux: and adopted as cards tagged #tmux. The tmux perspective shows one folder per session; sessions with no card are ghosts.
const TMUX = { data: {} };   // host url ('' = the serving daemon) -> { at, socket, sessions, loading }
const tmuxHostKey = h => h ? h.url : '';
function tmuxAddr(hostUrl, target) { const h = hostUrl ? hostByUrl(hostUrl) : null; return 'tmux:' + (h ? '@' + h.name + '/' : '/') + (target || ''); }
function tmuxSplitKey(rest) { const m = rest.match(/^@([^:]+):([\s\S]*)$/); return m ? { host: m[1], h: hostByName(m[1]), path: m[2] } : { host: null, h: null, path: rest }; }
function tmuxTargetOf(n) { return n && n.kind === 'term' ? (n.tmux ? n.tmux.split(':')[0] : n.tmuxSess || null) : null; }
function tmuxNodeFor(h, target) { const sess = String(target || '').split(':')[0], k = tmuxHostKey(h); return nodeList().find(n => tmuxTargetOf(n) === sess && fsHostKey(n) === k) || null; }
function tmuxStore(h, j) { const d = TMUX.data[tmuxHostKey(h)] = { at: Date.now(), socket: j.socket || null, sessions: j.sessions || [], err: !!j.error }; if (VIEW === 'ranger') renderRanger(); if (perspCur() === 'tmux' && !PERSP.building && PERSP.tmuxWait) { PERSP.tmuxWait = false; perspClear(); perspBuild('tmux'); restack(); renderTree(); renderLinks(); dirty(); } return d; }
function tmuxData(h, force) {
  const k = tmuxHostKey(h), d = TMUX.data[k];
  if (!DAEMON) return { at: 1, socket: null, sessions: [] };
  if (d && (d.loading || (!force && Date.now() - d.at < 8000))) return d;
  TMUX.data[k] = { ...(d || { sessions: [], socket: null }), at: d?.at || 0, loading: true };
  hFetch(h, '/api/tmux').then(r => r.json()).then(j => tmuxStore(h, j)).catch(() => tmuxStore(h, { error: 'unreachable' }));
  return TMUX.data[k];
}
async function tmuxLoad(h) { if (!DAEMON) return { socket: null, sessions: [] }; const r = await hFetch(h, '/api/tmux'); return tmuxStore(h, await r.json()); }
function tmuxEntry(h, s) {
  const pre = h ? '@' + h.name + ':' : '', n = tmuxNodeFor(h, s.name);
  return { key: 'tmux:' + pre + s.name, name: s.name, kind: 'itmux', dir: s.windows.length > 1, n: n || undefined, tmux: { target: s.name, h },
    meta: [s.command, s.windows.length > 1 ? s.windows.length + ' windows' : '', s.attached ? 'attached' : '', n ? 'card ' + n.name : ''].filter(Boolean).join(' · ') };
}
function tmuxRelList(rest) {
  const { host, h, path } = tmuxSplitKey(rest); if (host && !h) return [];
  const out = [];
  if (!path) {
    if (!host && DAEMON) for (const hh of allHosts()) out.push({ key: 'tmux:@' + hh.name + ':', name: '@' + hh.name, kind: 'persp', dir: true, meta: 'tmux:@' + hh.name + '/' });
    const d = tmuxData(h);
    if (!DAEMON) { if (!host) out.push({ key: 'tmux:_', name: 'sessions need the local build', kind: 'ghost', dir: false, reserved: 'tmux sessions show in the local build when canvasd runs with --tmux-socket PATH (shells then survive daemon restarts, and sessions made by other programs can be adopted as cards).' }); return out; }
    if (d.socket === null && !d.loading) out.push({ key: 'tmux:' + (host ? '@' + host + ':' : '') + '_', name: 'no tmux socket on ' + (h ? '@' + h.name : 'this daemon'), kind: 'ghost', dir: false, reserved: 'Start canvasd with --tmux-socket PATH (for example /var/lib/control-panel/tmux.sock) to run shells inside tmux and adopt sessions.' });
    for (const s_ of d.sessions) out.push(tmuxEntry(h, s_));
    return out;
  }
  const d = tmuxData(h), [sname, win] = path.split(':'), s_ = d.sessions.find(x => x.name === sname); if (!s_) return [];
  const pre = h ? '@' + h.name + ':' : '';
  if (win === undefined) return s_.windows.map(w => ({ key: 'tmux:' + pre + sname + ':' + w.index, name: w.index + ' ' + w.name, kind: 'itmuxw', dir: false, tmux: { target: sname, h }, meta: [(w.panes.find(p => p.active) || w.panes[0] || {}).command, w.panes.length > 1 ? w.panes.length + ' panes' : '', w.active ? 'current' : ''].filter(Boolean).join(' · ') }));
  const w = s_.windows.find(w => String(w.index) === win); return w ? w.panes.map(p => ({ key: 'tmux:' + pre + sname + ':' + w.index + '.' + p.index, name: w.index + '.' + p.index + ' ' + p.command, kind: 'itmuxw', dir: false, tmux: { target: sname, h }, meta: p.path })) : [];
}
// adopt a session as a card: in the host's folder, or where a ghost stood (at = { in, x, y })
function tmuxAdopt(target, h, at) {
  if (!DAEMON) { toast('Adopting tmux sessions needs the local build (canvasd --tmux-socket).'); return null; }
  const sess = String(target || '').split(':')[0]; if (!sess) return null;
  const have = tmuxNodeFor(h, sess); if (have && !at) { jumpNode(have); toast(sess + ' is already on the board as ' + have.name + '.'); return have; }
  const hf = !at && h ? hostFolder(h) : null, c = viewCenterWorld(), w = 640, hh = 400;
  const n = addNode({ kind: 'term', backend: 'pty', name: clean(sess.replace(/^wb-/, '')), tmux: sess, env: {}, in: at ? at.in : hf ? hf.id : undefined, hostUrl: h ? h.url : undefined,
    ...(at ? { x: at.x, y: at.y } : freeSpot(c.x - w / 2, c.y - hh / 2, w, hh)), w, h: hh });
  if (hf) adopt(n, hf, null, true);
  if (!at) jumpNode(n, 1, () => live[n.id]?.term?.focus());
  return n;
}
function tmuxPerspBuild(related) {
  const frames = {};
  const sessFrame = (hostUrl, sname, near) => {
    const k = hostUrl + '|' + sname; if (frames[k]) return frames[k];
    const h = hostUrl ? hostByUrl(hostUrl) : null;
    const d = TMUX.data[hostUrl], s_ = d?.sessions.find(x => x.name === sname);
    const f = addNode({ kind: 'frame', name: sname + (h ? ' @' + h.name : ''), mode: 'pack', shape: 'folder', derived: 'tmux', tmuxSess: sname, tmuxHost: hostUrl, host: h ? { name: h.name, url: h.url, token: h.token } : undefined, tmuxState: s_ ? (SHELL_RE.test(s_.command || '') ? 'idle' : 'running') : undefined, in: null, x: near.x - PAD, y: near.y - PAD - LABEL_H, w: 520, h: 300 });
    return frames[k] = f;
  };
  for (const n of nodeList()) { const t = tmuxTargetOf(n); if (!t) continue; related.add(n.id); adopt(n, sessFrame(fsHostKey(n), t, n), null, true); }
  let gx = 100, gy = 100;
  for (const h of [null, ...allHosts()]) {
    const d = tmuxData(h); if (d.loading && !d.at) { PERSP.tmuxWait = true; continue; }
    for (const s_ of d.sessions) {
      const hostUrl = h ? h.url : '', f = sessFrame(hostUrl, s_.name, { x: gx, y: gy }); gy += 360;
      if (kidsOf(f.id).some(k => k.kind === 'term')) continue;
      const g = { id: uid('n'), kind: 'ghost', ghost: true, tmuxTarget: s_.name, host: hostUrl, name: s_.name, meta: [s_.command, s_.windows.length > 1 ? s_.windows.length + ' windows' : ''].filter(Boolean).join(' · '), in: f.id, order: 1e9, x: f.x + PAD, y: f.y + PAD, w: 260, h: 54 };
      S.nodes[g.id] = g; mount(g); renumber(f); relayout(f);
    }
  }
}
// shell commands: a board path, a tmux:[@host]/session address, or nothing for the active shell
function shellRef(p) {
  const a = p && parseAddr(p);
  if (a && a.kind === 'tmux') {
    const h = a.host ? hostByName(a.host) : null; if (a.host && !h) throw new Error('unknown host @' + a.host);
    const target = a.path.replace(/^\/+/, ''); if (!target) throw new Error('give a session: tmux:[@host]/NAME');
    const n = tmuxNodeFor(h, target); return { n, target, h, addr: tmuxAddr(h ? h.url : '', target) };
  }
  const n = p ? findNode(p) : activeId && S.nodes[activeId];
  if (!n || !(n.kind === 'term' || n.kind === 'repl')) throw new Error('no shell at ' + (p || '(active)'));
  return { n, target: tmuxTargetOf(n), h: n.hostUrl ? hostByUrl(n.hostUrl) : hostOf(n), addr: addrOf(n) };
}
async function tmuxApi(h, op, body) { const r = await hFetch(h, '/api/tmux/' + op, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('tmux ' + op + ' failed: ' + r.status)); return j; }
async function shellLogs(r, lines) {
  if (r.n && DAEMON && r.n.backend === 'pty') { try { const j = await (await hFetch(r.h, '/api/pty/' + r.n.id + '/capture?lines=' + lines)).json(); if (j.text != null) return j.text; } catch {} }
  if (r.n) { const L = live[r.n.id]; return L?.term ? termLines(L, lines).join('\n') : '(not a running shell)'; }
  return (await (await hFetch(r.h, '/api/tmux/capture?lines=' + lines + '&target=' + encodeURIComponent(r.target))).json()).text || '';
}
AGENT_TOOLS.push(
  { name: 'shell_send', description: 'Type text into a shell and (by default) press Enter. path: a board path, a tmux:[@host]/session address (a session need not be on the board), or empty for the active shell.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean' } }, required: ['text'] },
    run: async ({ path, text, enter = true }) => { const r = shellRef(path); const L = r.n && live[r.n.id]; if (L?.backend) { L.backend.input(str(text).replace(/\n/g, '\r') + (enter ? '\r' : '')); pulse(r.n.id); } else await tmuxApi(r.h, 'send', { target: r.target, text, enter }); return 'sent to ' + r.addr; } },
  { name: 'shell_interrupt', description: 'Send Ctrl-C to a shell (board path, tmux: address, or the active shell).', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: async ({ path } = {}) => { const r = shellRef(path); const L = r.n && live[r.n.id]; if (L?.backend) L.backend.input('\x03'); else await tmuxApi(r.h, 'interrupt', { target: r.target }); return 'interrupted ' + r.addr; } },
  { name: 'shell_logs', description: 'The last lines of a shell: tmux scrollback when the shell runs in tmux, else the terminal buffer. path: board path, tmux: address, or empty for the active shell.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, lines: { type: 'number' } } },
    run: async ({ path, lines = 200 } = {}) => shellLogs(shellRef(path), Math.max(1, Math.min(+lines || 200, 5000))) },
  { name: 'shell_kill', description: 'End a shell\'s process; a tmux session dies with it. The card stays and shows the exit. path: board path, tmux: address, or the active shell.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: async ({ path } = {}) => { const r = shellRef(path); const L = r.n && live[r.n.id]; if (L?.backend?.end) L.backend.end(true); else if (L?.backend) throw new Error(r.n.name + ' is a simulated shell'); else await tmuxApi(r.h, 'kill', { target: r.target }); return 'killed ' + r.addr; } },
  { name: 'shell_detach', description: 'Remove a shell card whose tmux session keeps running (re-adopt it later from tmux:). path: board path or tmux: address.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    run: ({ path } = {}) => { const r = shellRef(path); if (!r.n) throw new Error(r.addr + ' has no card'); if (!tmuxTargetOf(r.n)) throw new Error(r.n.name + ' does not run in tmux'); const L = live[r.n.id]; if (L?.backend) L.backend.detachOnly = true; const t = tmuxAddr(fsHostKey(r.n), tmuxTargetOf(r.n)); removeNode(r.n.id); return 'detached; the session stays at ' + t; } },
  { name: 'list_tmux', description: 'tmux sessions on a host\'s socket (host: a name from hosts.json; empty = the serving daemon): one line per session with its address, foreground command, path, windows and its card when on the board.', inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
    run: async ({ host } = {}) => { const h = host ? hostByName(host) : null; if (host && !h) throw new Error('unknown host @' + host); const d = await tmuxLoad(h); if (!d.socket) return 'no tmux socket on ' + (h ? '@' + h.name : 'this daemon') + ' (canvasd --tmux-socket PATH)'; return d.sessions.map(s_ => { const n = tmuxNodeFor(h, s_.name); return `${tmuxAddr(h ? h.url : '', s_.name)} · ${s_.command || '?'} · ${s_.path || ''} · ${s_.windows.length} window${s_.windows.length === 1 ? '' : 's'}${s_.attached ? ' · attached' : ''}${n ? ' · card ' + pathOf(n.id) : ''}`; }).join('\n') || '(no sessions)'; } },
  { name: 'adopt_tmux', description: 'Make a card attached to a tmux session: target = session name (or tmux:[@host]/name); host = name from hosts.json when the target is a bare name.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, host: { type: 'string' } }, required: ['target'] },
    run: ({ target, host }) => { const a = parseAddr(target); let h = host ? hostByName(host) : null; if (host && !h) throw new Error('unknown host @' + host); let t = target; if (a && a.kind === 'tmux') { if (a.host) { h = hostByName(a.host); if (!h) throw new Error('unknown host @' + a.host); } t = a.path.replace(/^\/+/, ''); } const n = tmuxAdopt(t, h); if (!n) throw new Error('could not adopt ' + target); return 'adopted ' + tmuxAddr(h ? h.url : '', t.split(':')[0]) + ' as ' + pathOf(n.id); } }
);
cmd('Shell: interrupt the active shell (Ctrl-C)', () => { try { const r = shellRef(''); live[r.n.id]?.backend?.input('\x03'); } catch (e) { toast(e.message); } }, '', () => n0()?.kind === 'term' || n0()?.kind === 'repl');
cmd('Shell: kill the active shell\'s process (its tmux session too)', () => { try { const r = shellRef(''); const L = live[r.n.id]; if (L?.backend?.end) L.backend.end(true); else toast('Simulated shell.'); } catch (e) { toast(e.message); } }, '', () => n0()?.kind === 'term' || n0()?.kind === 'repl');
cmd('Shell: detach the active card (its tmux session keeps running)', () => { const n = n0(); if (!n || !tmuxTargetOf(n)) return toast('The active node is not a tmux-backed shell.'); const L = live[n.id]; if (L?.backend) L.backend.detachOnly = true; const t = tmuxAddr(fsHostKey(n), tmuxTargetOf(n)); removeNode(n.id); toast('Detached. The session stays at ' + t + '.'); }, '', () => !!tmuxTargetOf(n0()));
cmd('Shell: scrollback of the active shell as a reference card', async () => { const n = n0(); if (!n || !(n.kind === 'term' || n.kind === 'repl')) return toast('Pick a shell first.'); const text = await shellLogs(shellRef(''), 200); const k = childrenOf(n.id, 'ref').length; const r = { id: uid('n'), kind: 'ref', in: n.in, name: n.name + '-log' + (k + 1), text, src: { node: n.id, line: 0, lines: text.split('\n').length }, srcLabel: pathOf(n.id) + ' › scrollback', x: n.x + n.w + 70, y: n.y + k * 50, w: 420, h: 360 }; S.edges.push({ id: uid('e'), from: n.id, to: r.id, type: 'ref' }); addNode(r); }, '', () => n0()?.kind === 'term' || n0()?.kind === 'repl');
cmd('tmux: sessions in the navigator', () => goAddr('tmux:'), '', () => DAEMON);
cmd('tmux: adopt a session as a card…', () => askName('Session (name, or tmux:@host/name)', 'tmux:/', v => { try { const a = parseAddr(v); let h = null, t = v; if (a && a.kind === 'tmux') { h = a.host ? hostByName(a.host) : null; if (a.host && !h) return toast('unknown host @' + a.host); t = a.path.replace(/^\/+/, ''); } tmuxAdopt(t, h); } catch (e) { toast(e.message); } }), '', () => DAEMON);
// ---- v14: the host's own trees. proc: (from /proc), unit: (systemd), the status line and the Attention query. Board
// terminals are the real nodes; every other process or unit is a ghost. Data comes from each host's daemon; in demo mode
// a small seeded host stands in.
const SHELL_RE = /^(bash|zsh|sh|fish|dash|ksh|tmux|tmux: client|tmux: server)$/;
const PROC = { data: {} }, UNITS = { data: {} }, STATUS = { data: {}, at: 0 };
function demoProcs() {
  const shells = nodeList().filter(n => n.kind === 'term' && n.backend !== 'pty');
  const ps = [{ pid: 1, ppid: 0, comm: 'systemd', state: 'S', cwd: '/', cmd: '/sbin/init', start: 1791600000, rss: 12e6, unit: null }, { pid: 2, ppid: 0, comm: 'kthreadd', state: 'S', cwd: null, cmd: '', start: 1791600000, rss: 0 },
    { pid: 611, ppid: 1, comm: 'caddy', state: 'S', cwd: '/', cmd: 'caddy run --config /etc/caddy/Caddyfile', start: 1791600100, rss: 48e6, unit: 'caddy.service' }, { pid: 640, ppid: 1, comm: 'sshd', state: 'S', cwd: '/', cmd: 'sshd: /usr/sbin/sshd -D', start: 1791600100, rss: 9e6, unit: 'sshd.service' },
    { pid: 700, ppid: 1, comm: 'tmux: server', state: 'S', cwd: '/home/me', cmd: 'tmux -S /var/lib/control-panel/tmux.sock', start: 1791600200, rss: 6e6, unit: 'control-panel.service' },
    { pid: 702, ppid: 700, comm: 'codex', state: 'S', cwd: '/home/me/computer', cmd: 'codex --full-auto', start: 1791600300, rss: 310e6, unit: 'control-panel.service' },
    { pid: 800, ppid: 1, comm: 'python3', state: 'S', cwd: '/home/me', cmd: 'python3 canvasd.py --tmux-socket /var/lib/control-panel/tmux.sock', start: 1791600400, rss: 60e6, unit: 'workbench.service' }];
  shells.forEach((n, i) => { const pid = 1000 + i * 10; ps.push({ pid, ppid: 800, comm: 'bash', state: 'S', cwd: n.cwd || '/home/me', cmd: 'bash', start: 1791600500 + i, rss: 4e6, unit: 'workbench.service', node: n.id });
    if (n.fg && n.fg !== 'bash') ps.push({ pid: pid + 1, ppid: pid, comm: n.fg, state: 'S', cwd: n.cwd || '/home/me', cmd: n.fg, start: 1791600600 + i, rss: 120e6, unit: 'workbench.service' });
    if (i === 0) { ps.push({ pid: pid + 2, ppid: pid, comm: 'node', state: 'S', cwd: '/home/me/projects/canvas', cmd: 'node tests/ui.mjs', start: 1791600700, rss: 90e6, unit: 'workbench.service' }, { pid: pid + 3, ppid: pid + 2, comm: 'chromium', state: 'S', cwd: '/home/me/projects/canvas', cmd: 'chromium --headless', start: 1791600701, rss: 400e6, unit: 'workbench.service' }); } });
  return ps;
}
const demoUnits = () => [{ unit: 'caddy.service', load: 'loaded', active: 'active', sub: 'running', description: 'Caddy web server' }, { unit: 'workbench.service', load: 'loaded', active: 'active', sub: 'running', description: 'Workbench daemon (canvasd)' }, { unit: 'control-panel.service', load: 'loaded', active: 'active', sub: 'running', description: 'Agent sessions on a shared tmux socket' }, { unit: 'sshd.service', load: 'loaded', active: 'active', sub: 'running', description: 'OpenSSH server' }, { unit: 'postgresql.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'PostgreSQL (retired: the daemon indexes in SQLite)' }, { unit: 'borgbackup-job-home.timer', load: 'loaded', active: 'active', sub: 'waiting', description: 'Nightly backup' }, { unit: 'example-idp.service', load: 'loaded', active: 'inactive', sub: 'dead', description: 'Identity provider (runs elsewhere)' }];
function procIndex(list) { const byPid = {}, kids = {}; for (const p of list) { byPid[p.pid] = p; (kids[p.ppid] ||= []).push(p); } for (const k of Object.values(kids)) k.sort((a, b) => a.pid - b.pid); return { byPid, kids }; }
function procData(h, force) {
  const k = tmuxHostKey(h), d = PROC.data[k];
  if (!DAEMON) { if (!d || force) { const list = demoProcs(); PROC.data[k] = { at: Date.now(), list, ...procIndex(list) }; } return PROC.data[k]; }
  if (d && (d.loading || (!force && Date.now() - d.at < 8000))) return d;
  PROC.data[k] = { ...(d || { list: [], byPid: {}, kids: {} }), at: d?.at || 0, loading: true };
  hFetch(h, '/api/proc').then(r => r.json()).then(j => procStore(h, j.procs || [])).catch(() => procStore(h, [], true));
  return PROC.data[k];
}
function procStore(h, list, err) { const d = PROC.data[tmuxHostKey(h)] = { at: Date.now(), list, err: !!err, ...procIndex(list) }; if (VIEW === 'ranger') renderRanger(); if (perspCur() === 'proc' && !PERSP.building) procPerspRefresh(h); return d; }
async function procLoad(h) { if (!DAEMON) return procData(h, true); const r = await hFetch(h, '/api/proc'); const j = await r.json(); return procStore(h, j.procs || []); }
function procShellPid(n, d) { if (!n || n.kind !== 'term' || !d) return null; if (!DAEMON) return d.list.find(p => p.node === n.id)?.pid || null; return d.list.find(p => p.node === n.id)?.pid || null; }
function procEntry(h, p, d) {
  const pre = h ? '@' + h.name + ':' : '', kids = (d.kids[p.pid] || []).length, n = p.node && S.nodes[p.node];
  return { key: 'proc:' + pre + p.pid, name: p.comm + ' ' + p.pid, kind: 'iproc', dir: kids > 0, kids, proc: p, n: n || undefined, meta: [n ? 'card ' + n.name : '', p.unit || '', p.cwd && !n ? p.cwd : ''].filter(Boolean).join(' · ') };
}
function procRelList(rest) {
  const { host, h, path } = tmuxSplitKey(rest); if (host && !h) return [];
  const d = procData(h), out = [];
  if (!path) {
    if (!host && DAEMON) for (const hh of allHosts()) out.push({ key: 'proc:@' + hh.name + ':', name: '@' + hh.name, kind: 'persp', dir: true, meta: 'proc:@' + hh.name + '/' });
    if (d.loading && !d.list.length) return out;
    const roots = d.list.filter(p => !d.byPid[p.ppid] || p.ppid === 0);
    return [...out, ...roots.map(p => procEntry(h, p, d))];
  }
  return (d.kids[+path] || []).map(p => procEntry(h, p, d));
}
function unitsData(h, force) {
  const k = tmuxHostKey(h), d = UNITS.data[k];
  if (!DAEMON) { if (!d) UNITS.data[k] = { at: Date.now(), units: demoUnits() }; return UNITS.data[k]; }
  if (d && (d.loading || (!force && Date.now() - d.at < 10000))) return d;
  UNITS.data[k] = { ...(d || { units: [] }), at: d?.at || 0, loading: true };
  hFetch(h, '/api/units').then(r => r.json()).then(j => unitsStore(h, j)).catch(() => unitsStore(h, { units: [], error: 'unreachable' }));
  return UNITS.data[k];
}
function unitsStore(h, j) { const d = UNITS.data[tmuxHostKey(h)] = { at: Date.now(), units: j.units || [], error: j.error || null }; if (VIEW === 'ranger') renderRanger(); if (perspCur() === 'unit' && !PERSP.building && PERSP.unitWait) { PERSP.unitWait = false; perspClear(); perspBuild('unit'); restack(); renderTree(); renderLinks(); dirty(); } statusRender(); return d; }
async function unitsLoad(h) { if (!DAEMON) return unitsData(h); const r = await hFetch(h, '/api/units'); return unitsStore(h, await r.json()); }
async function unitShow(h, name) { if (!DAEMON) { const u = demoUnits().find(u => u.unit === name); return { unit: name, status: u ? `● ${name} - ${u.description}\n   Loaded: ${u.load}\n   Active: ${u.active} (${u.sub})\n(demo host)` : '', error: u ? null : 'no such unit' }; } const r = await hFetch(h, '/api/unit/' + encodeURIComponent(name)); return r.json(); }
const unitOrder = u => u.active === 'failed' ? 0 : u.active === 'active' ? 1 : u.active === 'activating' || u.active === 'deactivating' ? 2 : 3;
const unitGlyph = u => u.active === 'failed' ? '✗ ' : u.active === 'active' ? '● ' : '○ ';
function unitEntry(h, u) {
  const pre = h ? '@' + h.name + ':' : '', d = PROC.data[tmuxHostKey(h)], procs = d ? d.list.filter(p => p.unit === u.unit) : [];
  return { key: 'unit:' + pre + u.unit, name: unitGlyph(u) + u.unit, kind: 'iunit', dir: procs.length > 0, unit: { name: u.unit, u, h }, meta: [u.active + (u.sub && u.sub !== u.active ? '/' + u.sub : ''), procs.length ? procs.length + ' proc' : '', u.description].filter(Boolean).join(' · ') };
}
function unitRelList(rest) {
  const { host, h, path } = tmuxSplitKey(rest); if (host && !h) return [];
  const d = unitsData(h), out = []; procData(h);
  if (!path) {
    if (!host && DAEMON) for (const hh of allHosts()) out.push({ key: 'unit:@' + hh.name + ':', name: '@' + hh.name, kind: 'persp', dir: true, meta: 'unit:@' + hh.name + '/' });
    if (d.error && !d.units.length) out.push({ key: 'unit:' + (host ? '@' + host + ':' : '') + '_', name: 'no units: ' + d.error, kind: 'ghost', dir: false, reserved: 'This host answered: ' + d.error + '. Units need systemd on the host (systemctl list-units --output=json).' });
    return [...out, ...[...d.units].sort((a, b) => unitOrder(a) - unitOrder(b) || a.unit.localeCompare(b.unit)).map(u => unitEntry(h, u))];
  }
  const pd = procData(h); return pd.list.filter(p => p.unit === path).map(p => procEntry(h, p, pd));
}
// perspectives
function procPerspBuild(related) {
  for (const h of [null, ...(DAEMON ? allHosts() : [])]) procData(h);
  for (const n of nodeList()) {
    if (n.kind !== 'term') continue;
    const hostUrl = fsHostKey(n), h = hostUrl ? hostByUrl(hostUrl) : null, d = PROC.data[hostUrl]; if (!d) continue;
    const pid = procShellPid(n, d); if (!pid) continue;
    related.add(n.id);
    const f = addNode({ kind: 'frame', name: n.name + (h ? ' @' + h.name : ''), mode: 'pack', shape: 'folder', derived: 'proc', owner: n.id, procPid: pid, procHost: hostUrl, host: h ? { name: h.name, url: h.url, token: h.token } : undefined, in: null, x: n.x - PAD, y: n.y - PAD - LABEL_H, w: Math.max(n.w + 2 * PAD, 520), h: n.h + 2 * PAD + LABEL_H });
    adopt(n, f, null, true); procGhostsFill(f, d);
  }
}
function procGhostsFill(f, d) {
  const walk = (pid, depth, out) => { for (const c of d.kids[pid] || []) { if (out.length > 60) break; out.push([c, depth]); walk(c.pid, depth + 1, out); } return out; };
  const have = new Map(kidsOf(f.id).filter(k => k.kind === 'ghost' && k.procPid).map(k => [k.procPid, k])), want = walk(f.procPid, 1, []), seen = new Set();
  let order = kidsOf(f.id).length, changed = false;
  for (const [c, depth] of want) {
    seen.add(c.pid); const g = have.get(c.pid);
    const name = '· '.repeat(depth - 1) + c.comm + ' ' + c.pid, meta = c.cwd || '';
    if (g) { if (g.name !== name || g.meta !== meta) { g.name = name; g.meta = meta; const L = live[g.id]; if (L) mountGhost(g, L); } continue; }
    const n = { id: uid('n'), kind: 'ghost', ghost: true, procPid: c.pid, cmd: c.cmd, host: f.procHost || '', name, meta, in: f.id, order: order++, x: f.x + PAD, y: f.y + PAD, w: 260, h: 54 };
    S.nodes[n.id] = n; mount(n); changed = true;
  }
  for (const [pid, g] of have) if (!seen.has(pid)) { removeGhost(g); changed = true; }
  if (changed) { renumber(f); SEP.keep = f; relayout(f, true); SEP.keep = null; }
  return changed;
}
function procPerspRefresh(h) {
  const url = h ? h.url : '', d = PROC.data[url]; if (!d) return;
  let changed = false;
  for (const f of frameList()) if (f.derived === 'proc' && (f.procHost || '') === url) changed = procGhostsFill(f, d) || changed;
  if (changed) { restack(); renderTree(); dirty(); }
}
setInterval(() => { if (perspCur() !== 'proc' || !S) return; const f = WS.cur && S.nodes[WS.cur]; if (!f || f.derived !== 'proc') return; if (DAEMON) procData(f.procHost ? hostByUrl(f.procHost) : null, true); else { procData(null, true); procPerspRefresh(null); } }, 2000);
function unitPerspBuild(related) {
  const hosts = [null, ...(DAEMON ? allHosts() : [])];
  let gx = 100, gy = 100;
  for (const h of hosts) {
    const url = h ? h.url : '', ud = unitsData(h), pd = procData(h);
    if (ud.loading && !ud.at) { PERSP.unitWait = true; continue; }
    const owned = {};   // unit -> board terminals whose shell process sits in that unit's cgroup
    for (const n of nodeList()) { if (n.kind !== 'term' || fsHostKey(n) !== url) continue; const pid = procShellPid(n, pd), p = pid && pd.byPid[pid]; if (p?.unit) (owned[p.unit] ||= []).push(n); }
    const hostTag = h ? { name: h.name, url: h.url, token: h.token } : undefined, hn = h ? ' @' + h.name : '';
    for (const [uname, nodes] of Object.entries(owned)) {
      const u = ud.units.find(x => x.unit === uname) || { unit: uname, active: 'active', sub: '', description: '' }, first = nodes[0];
      const f = addNode({ kind: 'frame', name: uname + hn, mode: 'pack', shape: 'folder', derived: 'unit', unitName: uname, unitHost: url, unitState: u.active, host: hostTag, in: null, x: first.x - PAD, y: first.y - PAD - LABEL_H, w: 520, h: 300 });
      for (const n of nodes) { related.add(n.id); adopt(n, f, null, true); }
    }
    if (!ud.units.length) continue;
    const f = addNode({ kind: 'frame', name: 'units' + hn, mode: 'pack', shape: 'folder', derived: 'unit', unitHost: url, host: hostTag, in: null, x: gx, y: gy, w: 560, h: 320 }); gy += 400;
    let order = 0;
    for (const u of [...ud.units].sort((a, b) => unitOrder(a) - unitOrder(b) || a.unit.localeCompare(b.unit)).slice(0, 120)) {
      if (owned[u.unit]) continue;
      const g = { id: uid('n'), kind: 'ghost', ghost: true, unitName: u.unit, unitState: u.active, host: url, name: u.unit, meta: u.sub && u.sub !== u.active ? u.sub : '', in: f.id, order: order++, x: f.x + PAD, y: f.y + PAD, w: 280, h: 54 };
      S.nodes[g.id] = g; mount(g);
    }
    renumber(f); relayout(f, true);
  }
}
// unit control: the only mutating verbs on the host trees; always behind a confirm
async function unitControl(h, name, verb) {
  if (!DAEMON) { const u = demoUnits().find(u => u.unit === name); if (!u) throw new Error('no such unit: ' + name); return { ok: true, unit: name, verb, output: '(demo host) ' + verb + ' ' + name }; }
  const r = await hFetch(h, '/api/unit/' + encodeURIComponent(name) + '/' + verb, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || (verb + ' failed: ' + r.status));
  UNITS.data[tmuxHostKey(h)] = undefined; unitsData(h, true); return j;
}
function unitPrompt(verb) {
  askName(verb[0].toUpperCase() + verb.slice(1) + ' which unit? (name, or unit:@host/name)', 'unit:/', v => {
    const a = parseAddr(v); let h = null, name = v; if (a && a.kind === 'unit') { h = a.host ? hostByName(a.host) : null; if (a.host && !h) return toast('unknown host @' + a.host); name = a.path.replace(/^\/+/, ''); }
    if (!name) return;
    ask(`${verb} ${name}${h ? ' on @' + h.name : ''}? Type yes`, '', ans => { if (!/^y(es)?$/i.test(ans)) return toast('Left ' + name + ' alone.'); unitControl(h, name, verb).then(j => toast(`${name}: ${verb} ok${j.output ? ' · ' + j.output.slice(0, 120) : ''}`)).catch(e => toast(e.message)); });
  });
}
cmd('Unit: restart a systemd unit… (asks first)', () => unitPrompt('restart'));
cmd('Unit: stop a systemd unit… (asks first)', () => unitPrompt('stop'));
cmd('Unit: start a systemd unit… (asks first)', () => unitPrompt('start'));
cmd('Units: list in the navigator', () => goAddr('unit:'));
cmd('Processes: list in the navigator', () => goAddr('proc:'));
// the status line: counts that are each a click to the matching place; the Attention query lists the same items
function attnItems() {
  const items = [];
  if (DAEMON) for (const h of allHosts()) if (HOSTCONN[h.url]?.down) items.push({ key: FS_PREFIX + '@' + h.name + ':~', name: '@' + h.name + ' unreachable', kind: 'iattn', attn: 'bad', dir: false, meta: 'host down', go: () => { hostRetry(h.url, true); } });
  for (const [url, d] of Object.entries(UNITS.data)) { const h = url ? hostByUrl(url) : null; for (const u of d?.units || []) if (u.active === 'failed') items.push({ ...unitEntry(h, u), kind: 'iattn', attn: 'bad', name: u.unit + ' failed' + (h ? ' @' + h.name : '') });
  }
  for (const n of nodeList()) if (n.kind === 'term' && live[n.id]?.backend?.dead && live[n.id].backend.exitReason !== 'hub_restart') items.push({ key: n.id, name: n.name + ' ended', kind: 'iattn', attn: 'bad', n, dir: false, meta: 'shell exited' });
  for (const n of nodeList()) if (n.kind === 'term' && live[n.id]?.backend?.parked) items.push({ key: n.id, name: n.name + ' parked', kind: 'iattn', attn: 'bad', n, dir: false, meta: 'host unreachable' });
  for (const n of nodeList()) {   // agent cards, from the session feed (§3.4.6)
    const s = n.kind === 'acp' && SESS[n.id], a = s?.acp, it = { key: n.id, kind: 'iattn', n, dir: false };
    if (!s) continue;
    if (s.state === 'waiting_permission') items.push({ ...it, name: n.name + ' needs permission', attn: 'bad', meta: a?.pending?.find(p => p.kind === 'permission')?.title || '' });
    else if (s.state === 'waiting_input') items.push({ ...it, name: n.name + ' asks a question', attn: 'bad', meta: a?.pending?.[0]?.title || '' });
    else if (s.state === 'error') items.push({ ...it, name: n.name + ' failed', attn: 'bad', meta: s.fault?.message || a?.last?.error?.message || a?.last?.outcome || '' });
    else if (s.state === 'done') items.push({ ...it, name: n.name + ' finished', attn: '', meta: agentLabel(n.agent) });
  }
  if (DAEMON && S) for (const s of Object.values(SESS)) if (s.alive && !S.nodes[s.sid] && s.sid !== 'dock')   // running invisibly otherwise; the dock is never a node
    items.push({ key: 'orphan:' + s.sid, name: (s.kind === 'acp' ? agentLabel(s.acp?.agent) : s.pty?.fg?.comm || 'shell') + ' running without a card', kind: 'iattn', attn: 'bad', dir: false, meta: s.cwd || '', go: () => adoptOrphan(s) });
  const due = RV.loaded ? rvQueue().dueNow.length : 0; if (due) items.push({ key: 'attn:review', name: due + ' card' + (due === 1 ? '' : 's') + ' due', kind: 'iattn', dir: false, meta: 'review', go: () => setView('review') });
  for (const t of allTasks()) { if (COL[t.kw] === 'DONE') continue; const due = taskDue(t); if (due && due <= TODAY) items.push({ key: 'attn:' + taskKey(t), name: (due < TODAY ? 'overdue ' : 'due today ') + plainTask(t.text).slice(0, 60), kind: 'iattn', attn: due < TODAY ? 'bad' : '', dir: false, meta: taskAddr(t), go: () => taskOpen(t) }); else if (COL[t.kw] === 'NEXT' && !t.session) items.push({ key: 'attn:' + taskKey(t), name: 'NEXT ' + plainTask(t.text).slice(0, 60), kind: 'iattn', dir: false, meta: taskAddr(t), go: () => taskOpen(t) }); }
  return items;
}
function attnList() { return attnItems(); }
function attnCount() { try { return attnItems().length; } catch { return 0; } }
function statusCounts() {
  const hosts = DAEMON ? allHosts() : [], down = hosts.filter(h => HOSTCONN[h.url]?.down).length;
  let failed = 0; for (const d of Object.values(UNITS.data)) failed += (d?.units || []).filter(u => u.active === 'failed').length;
  const acps = nodeList().filter(n => n.kind === 'acp'), st = n => SESS[n.id]?.state;
  const agents = nodeList().filter(n => n.kind === 'term' && tagsOf(n).includes('agent') && !live[n.id]?.backend?.dead).length + acps.filter(n => st(n) && st(n) !== 'exited' && st(n) !== 'detached').length;
  const waiting = acps.filter(n => ACP_BAD.has(st(n))).length;
  const due = RV.loaded ? rvQueue().dueNow.length : null;
  const open = allTasks().filter(t => COL[t.kw] !== 'DONE'), tasks = open.length, dueToday = open.filter(t => taskDue(t) && taskDue(t) <= TODAY).length;
  return { hosts: hosts.length, down, failed, agents, waiting, due, tasks, dueToday };
}
function statusRender() {
  const box = $('#st-host'); if (!box) return;
  const c = statusCounts(); box.replaceChildren();
  const add = (text, title, cls, fn) => { const b = el('button', 'stc' + (cls ? ' ' + cls : ''), text); b.title = title; b.onclick = fn; box.append(b); };
  if (DAEMON && c.hosts) add((c.hosts - c.down) + '/' + c.hosts + ' hosts', 'Hosts from hosts.json: reachable / all. Click: the navigator root lists them.', c.down ? 'bad' : '', () => { setView('ranger'); rgGo('root'); });
  if (DAEMON || !DAEMON) add('✗ ' + c.failed, c.failed ? c.failed + ' failed unit(s). Click: units, failed first.' : 'No failed units. Click: units.', c.failed ? 'bad' : '', () => { goAddr('unit:'); });
  add('✦ ' + c.agents + (c.waiting ? ' · ' + c.waiting + ' waiting' : ''), c.agents + ' agent card(s) and shell(s) running an agent' + (c.waiting ? ', ' + c.waiting + ' waiting for you. Click: the first waiting card.' : '. Click: filter the canvas by #agent.'), c.waiting ? 'bad' : '', () => {
    const w = nodeList().find(n => n.kind === 'acp' && ACP_BAD.has(SESS[n.id]?.state));
    if (w) jumpNode(w); else { setView('canvas'); tagFilter('agent'); }
  });
  if (c.due != null) add('▦ ' + c.due, c.due + ' flashcard(s) due. Click: review.', c.due ? 'warn' : '', () => setView('review'));
  add('☐ ' + c.tasks + (c.dueToday ? ' (' + c.dueToday + ' due)' : ''), c.tasks + ' open task(s) on the board and in the notes' + (c.dueToday ? ', ' + c.dueToday + ' scheduled or due by today' : '') + '. Click: the tasks view.', c.dueToday ? 'warn' : '', () => setView('tasks'));
  const a = attnCount(); add('! ' + a, a ? a + ' item(s) need a look. Click: the Attention list (addresses).' : 'Nothing needs a look.', a ? 'bad' : '', () => { setView('ranger'); rgGo('attn:'); });
}
function statusTick() { if (!S) return; if (DAEMON) { for (const h of [null, ...allHosts()]) if (!HOSTCONN[h ? h.url : '']?.down) unitsData(h); tasksLoad(); } else unitsData(null); statusRender(); }
setInterval(statusTick, 20000); setTimeout(statusTick, 1500);
cmd('Attention: what needs a look (addresses)', () => { setView('ranger'); rgGo('attn:'); }, '', () => true);
cmd('Task: dispatch a task to an agent shell…', () => askName('Task (id, note:Title#^anchor, Page:line) [@host]', '', v => { const m = v.trim().match(/^(.*?)(?:\s+@([\w.-]+))?$/); const t = findTask(m[1]); if (!t) return toast('No task ' + m[1] + ' (wb tasks lists them).'); dispatchTask(t, { host: m[2] }).then(r => toast('Dispatched to ' + r.shell + '.')).catch(e => toast(e.message)); }));
cmd('Tasks: reload from the notes index', () => tasksLoad(true).then(r => toast(r.length + ' task(s) in the index.')), '', () => DAEMON);
AGENT_TOOLS.push(
  { name: 'backlinks', description: 'Pages and notes that link to a title ([[Title]]): one line each with page:line and the linking text. Also the count of links out.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    run: async ({ title }) => { await notesLoad(); await linksLoad(true); const e = linkEntity(title); const bl = backlinksOfTitle(e ? e.title : title); return [(e ? e.title : title) + ': ← ' + bl.length + ' in' + (e ? ', → ' + linkTargets(e).length + ' out' : ' (no page or note with this title)'), ...bl.map(b => `${b.title}:${b.line} · ${b.text.slice(0, 120)}`)].join('\n'); } },
  { name: 'journal', description: 'Open or create the journal entry for a day (YYYY-MM-DD or "today"); or step: "next" / "previous" from the open day.', inputSchema: { type: 'object', properties: { day: { type: 'string' } } },
    run: async ({ day } = {}) => { const d = (day || 'today').trim(); const r = d === 'next' ? await journalStep(1) : d === 'previous' || d === 'prev' ? await journalStep(-1) : await journalOpen(d === 'today' ? TODAY : d); return r ? 'journal ' + (r.name || r.title || r.path) : 'no entry'; } },
  { name: 'list_tasks', description: 'Tasks on the board pages and in the notes index: one line each with its reference (task:<id> or Page:line), keyword, title, date, session. status: todo | next | waiting | done | open.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    run: async ({ status } = {}) => { await tasksLoad(true); let ts = allTasks(); const st = (status || 'open').toLowerCase(); if (st === 'open') ts = ts.filter(t => COL[t.kw] !== 'DONE'); else if (st !== 'all') ts = ts.filter(t => COL[t.kw] === st.toUpperCase()); return ts.map(t => `${taskAddr(t)} · ${t.kw} · ${plainTask(t.text)}${t.priority ? ' [#' + t.priority + ']' : ''}${t.deadline ? ' · deadline ' + t.deadline : t.scheduled ? ' · scheduled ' + t.scheduled : ''}${t.session ? ' · ' + t.session : ''}`).join('\n') || '(no tasks)'; } },
  { name: 'set_task', description: 'Change a task\'s keyword: TODO NEXT WAITING HOLD SOMEDAY DONE CANCELLED. task: task:<id>, ^anchor, note:Title#^anchor, or Page:line.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, keyword: { type: 'string' } }, required: ['task', 'keyword'] },
    run: async ({ task, keyword }) => { await tasksLoad(true); const t = findTask(task); if (!t) throw new Error('no task ' + task); const kw = String(keyword).toUpperCase(); if (!TASK_KWS.includes(kw)) throw new Error('keyword must be one of ' + TASK_KWS.join(' ')); await taskSetKw(t, kw); return taskAddr(t) + ' → ' + kw; } },
  { name: 'dispatch_task', description: 'Paste a task (title and body) into a shell running an agent, then write session:: and dispatched:: into the task and move TODO to NEXT. task: task:<id>, ^anchor, note:Title#^anchor or Page:line; host: a name from hosts.json; shell: a board path to use instead of the first #agent shell.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, host: { type: 'string' }, shell: { type: 'string' } }, required: ['task'] },
    run: async ({ task, host, shell }) => { await tasksLoad(true); const t = findTask(task); if (!t) throw new Error('no task ' + task); const r = await dispatchTask(t, { host, shell }); return `dispatched ${taskAddr(t)} to ${r.shell} (${r.session}): ${r.text.slice(0, 120)}`; } }
);
AGENT_TOOLS.push(
  { name: 'list_procs', description: 'Processes on a host from /proc: pid, parent, command, cwd, unit; board shells are marked with their card. pid: subtree root (empty = the roots). host: a name from hosts.json (empty = the serving daemon).', inputSchema: { type: 'object', properties: { host: { type: 'string' }, pid: { type: 'number' } } },
    run: async ({ host, pid } = {}) => { const h = host ? hostByName(host) : null; if (host && !h) throw new Error('unknown host @' + host); const d = await procLoad(h); const walk = (p, depth, out) => { for (const c of d.kids[p] || []) { if (out.length > 400) break; out.push('  '.repeat(depth) + `proc:${h ? '@' + h.name : ''}/${c.pid} · ${c.comm}${c.node && S.nodes[c.node] ? ' · card ' + S.nodes[c.node].name : ''}${c.unit ? ' · ' + c.unit : ''}${c.cwd ? ' · ' + c.cwd : ''}`); walk(c.pid, depth + 1, out); } return out; };
      const roots = pid ? [d.byPid[+pid]].filter(Boolean) : d.list.filter(p => !d.byPid[p.ppid] || p.ppid === 0); const out = []; for (const r of roots) { out.push(`proc:${h ? '@' + h.name : ''}/${r.pid} · ${r.comm}${r.cmd ? ' · ' + r.cmd.slice(0, 80) : ''}`); walk(r.pid, 1, out); } return out.join('\n') || '(nothing)'; } },
  { name: 'list_units', description: 'systemd units on a host: unit:@host/name · active/sub · description, failed first. host: a name from hosts.json (empty = the serving daemon).', inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
    run: async ({ host } = {}) => { const h = host ? hostByName(host) : null; if (host && !h) throw new Error('unknown host @' + host); const d = await unitsLoad(h); if (d.error && !d.units.length) throw new Error(d.error); return [...d.units].sort((a, b) => unitOrder(a) - unitOrder(b) || a.unit.localeCompare(b.unit)).map(u => `unit:${h ? '@' + h.name : ''}/${u.unit} · ${u.active}${u.sub && u.sub !== u.active ? '/' + u.sub : ''} · ${u.description}`).join('\n') || '(no units)'; } },
  { name: 'unit_status', description: 'systemctl status of one unit (unit:@host/name or a bare name with host).', inputSchema: { type: 'object', properties: { unit: { type: 'string' }, host: { type: 'string' } }, required: ['unit'] },
    run: async ({ unit, host }) => { const a = parseAddr(unit); let h = host ? hostByName(host) : null, name = unit; if (a && a.kind === 'unit') { h = a.host ? hostByName(a.host) : h; if (a.host && !h) throw new Error('unknown host @' + a.host); name = a.path.replace(/^\/+/, ''); } const j = await unitShow(h, name); if (j.error && !j.status) throw new Error(j.error); return j.status || JSON.stringify(j.props || {}); } },
  { name: 'unit_control', description: 'start | stop | restart a systemd unit. Mutating: needs confirm=true, otherwise it only says what it would do. unit: unit:@host/name or a name with host.', inputSchema: { type: 'object', properties: { unit: { type: 'string' }, verb: { type: 'string' }, host: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['unit', 'verb'] },
    run: async ({ unit, verb, host, confirm }) => { if (!['start', 'stop', 'restart'].includes(verb)) throw new Error('verb must be start, stop or restart'); const a = parseAddr(unit); let h = host ? hostByName(host) : null, name = unit; if (a && a.kind === 'unit') { h = a.host ? hostByName(a.host) : h; if (a.host && !h) throw new Error('unknown host @' + a.host); name = a.path.replace(/^\/+/, ''); } if (!name) throw new Error('which unit?'); if (!confirm) return `would ${verb} ${name}${h ? ' on @' + h.name : ''}. Add confirm=true (wb unit ${verb} ${name}${h ? ' ' + h.name : ''} yes) to do it.`; const j = await unitControl(h, name, verb); return `${verb} ${name}${h ? ' on @' + h.name : ''}: ok${j.output ? '\n' + j.output : ''}`; } },
  { name: 'host_status', description: 'Health of a host: load, memory, disk, uptime, shells, tmux sessions, unit counts (failed names). host: a name from hosts.json (empty = the serving daemon).', inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
    run: async ({ host } = {}) => { const h = host ? hostByName(host) : null; if (host && !h) throw new Error('unknown host @' + host); if (!DAEMON) { const u = demoUnits(); return `demo host · load 0.4 · units ${u.filter(x => x.active === 'active').length}/${u.length} active, ${u.filter(x => x.active === 'failed').length} failed (${u.filter(x => x.active === 'failed').map(x => x.unit).join(', ')})`; } const j = await (await hFetch(h, '/api/status')).json(); const gb = b => (b / 2 ** 30).toFixed(1) + ' G'; return [`@${j.host}`, j.load ? 'load ' + j.load.map(x => x.toFixed(2)).join(' ') : '', j.mem ? 'mem ' + gb(j.mem.available) + ' free of ' + gb(j.mem.total) : '', j.disk ? 'disk / ' + gb(j.disk.free) + ' free of ' + gb(j.disk.total) : '', j.uptime != null ? 'up ' + Math.floor(j.uptime / 3600) + ' h' : '', `shells ${j.sessions?.alive ?? '?'}` + (j.sessions?.tmux != null ? ', tmux sessions ' + j.sessions.tmux : ''), j.units?.error ? 'units: ' + j.units.error : `units ${j.units.active}/${j.units.total} active, ${j.units.failed} failed` + (j.units.failedNames?.length ? ' (' + j.units.failedNames.join(', ') + ')' : '')].filter(Boolean).join(' · '); } }
);
window.__canvas = { typeInto, cardInput, setTool, SEL, PICKED, pickInRect, pickClear, pickToggle, removeSelection, removeUndo, sketchFromSelection, renderInk, inkBox, addShape, applyCam, wsFill, ASPECTS, aspectSize, tileAspect, tileAspectCycle, screenAspect, camArea, fitChrome, fitChromeAll, zoomAt, WS, wsEnter, wsLeave, findNode, graphSelect, jumpFolder, RESIZING, nodeResized, frameResized, tileFolder, packFolder, PHI, findPage, openPage, LINKS, linksLoad, linkEntities, linkTargets, backlinkCount, backlinksOfTitle, noteTree, noteKids, journalDays, journalOpen, journalStep, journalCurrentDay, linkPerspFrom, TASKS, tasksLoad, allTasks, findTask, dispatchTask, taskSetKw, taskText, collectTasks, renderTasks, TK, PROC, UNITS, procData, procLoad, unitsData, unitsLoad, unitShow, unitControl, attnItems, statusCounts, statusRender, procRelList, unitRelList, TMUX, tmuxData, tmuxLoad, tmuxAdopt, tmuxNodeFor, tmuxTargetOf, tmuxAddr, shellRef, shellLogs, hostByName, termLines, rgParent, addrOf, parseAddr, keyToAddr, addrToKey, goAddr, resolveAddr, rgEntries, rgGo, get RG() { return RG; }, notesLoad, get NOTES() { return NOTES; }, hashSync, fsIdent, fsExpand, ghostOpen, fsFrameFor, fsDrop, perspEdgesRebuild, HOSTCONN, get HOSTLIST() { return HOSTLIST; }, hostOf, hostRes, setHost, newHostFolder, hostRetry, hostsLoad, parseHost, rgFsList, fsSplit, PERSP, perspSet, perspCur, perspRebuild, setModeCascade, folderMode, fitAll, separateAll, separate, SEP, footprint, moveTree, placeAny, foldToggle, foldCycle, packFold, unfold, WS, FOCUS, LEADER, setLeader, isLeader, wsEnter, wsLeave, wsGo, wsTop, focusOpen, focusClose, focusHide, optimise, neighbour, leaderOpen, leaderKey, renderTree, addNode, spawnChild, tagsOf, setTags, retag, tagFilter, get TAG_FILTER() { return TAG_FILTER; }, newEmacs, newWeb, newSketch, newArtifactFromFile, emacsCmd, sketchClear, RV, renderReview, rvGrade, rvReveal, FSRS, newArtifact, artPublish, htmlBlocks, tearOutBlock, boardAdopt, HOSTS, get INFO() { return INFO; }, get DAEMON() { return DAEMON; }, MODE, RG, rgKey, renderRanger, fuzzy, CMDS, palSearch, setTheme, setVim, sideTab, toggleDockTerm, INK, inkTrack, commitStroke, get S() { return S; }, live, setView, G, ED, collectTasks, adopt, setMode, containerAt, kidsOf, stashed, findFolder, AGENT_TOOLS, jumpNode, removeNode, SAVE, NET, SESS, BARS, WAKE, get BOARD_ETAG() { return BOARD_ETAG; }, get BOOTED() { return BOOTED; }, dirty, boardChanged, changeCount, netKick, termTheme, pickShell, shellDefault, webUrlOk, AcpBackend, newAgentCard, lineDiff, elicitForm };  // for tests and debugging
Object.assign(window.__canvas, { keyContext, keyInterior, leaveCard, hintsOpen, hintsClose, HINTS, ARR, arrangeOpen, cardActions, KC, focusMove, graphMove });
Object.assign(window.__canvas, { DESK, deskGo, deskSend, deskList, deskAt, deskPin, deskDelete, deskOff, deskPinned, serialize, activate, viewKey });
boot();
})();
