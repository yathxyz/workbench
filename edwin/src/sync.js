/* Edwin's protocol client (spec 6.3, 7, 9.5; R6.3, R6.7-R6.10, R6.15-R6.19, R7.12-R7.19): the replica side of
   edwind's edit protocol, and served-mode boot (Ed.bootServed).

   A shared buffer is an Edwin Buffer whose text is driven by the protocol: b.shared, b.id (the buffer id),
   b.sver (the last server version applied), b.inflight (the one unacknowledged batch), b.queue (later local
   batches, rebased on inflight), b.hist (sequenced batches since open), b.meta (file, mode, anchors, ...)
   and b.presence (other writers' cursors). The transform is edwin/src/ot.js, used exactly as the test
   model edwin/test/ot-sim.mts Client does. Every text change goes through Ed.applyOps (R6.8): local
   commands reach this file through hooks.applied, remote batches are applied with it.

   Loaded after ot.js in both runtimes; it does nothing until Ed.sync.start or Ed.bootServed is called,
   so edwind and the headless tests carry it inert. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, OT = globalThis.EdOT;
const { intern, NIL, signal, listOf, truthy, Sym } = L;
const host = Ed.host;

const HASH_EVERY = 50;        // R7.14: ack and edits carry h at these versions
const SEL_MS = 50;            // sel at most 20 a second
const SPINNER_MS = 150;       // R4.27
const BACKOFF_MIN = 250, BACKOFF_MAX = 8000;   // R7.19 shutting_down
const AGENT_FADE_MS = 5000;   // R9.13

function randomHex(n) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) { const a = new Uint8Array(n / 2); c.getRandomValues(a); return Array.from(a, x => x.toString(16).padStart(2, '0')).join(''); }
  let s = ''; while (s.length < n) s += Math.floor(Math.random() * 16).toString(16); return s;
}
const basename = id => { const s = id.startsWith('name:') ? id.slice(5) : id; const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
const timeTag = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
/* JSON from the server as a Scheme value (var, R4.18): arrays are lists, objects hash tables, integers exact. */
function fromJSON(j) {
  if (j === null || j === undefined) return false;
  if (Array.isArray(j)) return listOf(j.map(fromJSON));
  if (typeof j === 'object') { const m = new Map(); for (const [k, v] of Object.entries(j)) m.set(k, fromJSON(v)); return m; }
  if (typeof j === 'number' && Number.isInteger(j)) return BigInt(j);
  return j;
}
/* A writer's key, label and colour (R9.13). */
const writerKey = by => (by ? (by.cid ? 'c:' + by.cid : by.device ? 'd:' + by.device : 'k:' + by.kind) : 'k:?');
function writerLabel(by) {
  if (!by) return '?';
  if (by.kind === 'agent') return by.name || 'agent';
  if (by.kind === 'cli') return by.session ? 'wb ' + by.session : by.device || 'cli';
  if (by.kind === 'disk') return 'disk';
  if (by.kind === 'server') return by.thread || 'server';
  return by.device || by.kind;
}
function writerColor(key) { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return `hsl(${h % 360} 65% 45%)`; }
const originOf = by => (by && by.kind === 'disk' ? 'disk' : by && by.kind === 'server' ? 'server' : by && by.kind === 'agent' ? 'agent' : 'remote');
const deletes = o => { let n = 0; for (const x of o.c) if (typeof x === 'number' && x < 0) n -= x; return n; };

/* ---------- the client ---------- */
const sync = {
  state: 'offline', started: false, ready: false, cid: null, device: null, transport: null, sock: null,
  epoch: null, boot: null, gen: 0, welcome: null, epochChanged: false,
  buffers: new Map(), calls: new Map(), listeners: new Map(),
  ridN: 0, backoff: BACKOFF_MIN, reconnectTimer: null, closing: false, spinning: 0, asks: [], askPending: false,
  on(ev, fn) { let l = this.listeners.get(ev); if (!l) this.listeners.set(ev, l = []); l.push(fn); return () => { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; },
  emit(ev, ...args) { const l = this.listeners.get(ev); let handled = false; if (l) for (const fn of l.slice()) { try { if (fn(...args) === true) handled = true; } catch (e) { console.error(e); } } return handled; },
};
const newRid = () => 'f' + (++sync.ridN);
function setState(s) { if (sync.state === s) return; sync.state = s; sync.emit('state', s); statusChanged(); }
function statusChanged() { for (const f of E.frames) Ed.frameEvent('status', f); Ed.scheduleRender(); }
function send(obj) { if (sync.sock && sync.sockOpen) { try { sync.sock.send(JSON.stringify(obj)); return true; } catch (e) { return false; } } return false; }

function start({ transport, device, cid } = {}) {
  if (sync.started) return sync.startP;
  if (typeof transport !== 'function') throw new Error('Ed.sync.start needs a transport factory');
  sync.started = true; sync.transport = transport;
  sync.cid = cid || sync.cid || randomHex(32); sync.device = device || 'frame:' + sync.cid.slice(0, 8);
  sync.startP = new Promise(resolve => { sync.firstWelcome = resolve; });
  connect();
  return sync.startP;
}
function connect() {
  if (sync.closing || sync.epochChanged) return;
  sync.reconnectTimer = null;
  setState('connecting');
  let s;
  try { s = sync.transport(); } catch (e) { scheduleReconnect(); return; }
  sync.sock = s; sync.sockOpen = false;
  s.onopen = () => { if (sync.sock !== s) return; sync.sockOpen = true; send({ t: 'hello', proto: 1, cid: sync.cid, kind: 'frame', device: sync.device, caps: {} }); };
  s.onmessage = ev => { if (sync.sock === s) onLine(typeof ev === 'string' ? ev : ev.data); };
  s.onclose = () => onClose(s);
  s.onerror = () => { /* onclose follows */ };
}
function onClose(s) {
  if (sync.sock !== s) return;
  sync.sock = null; sync.sockOpen = false;
  setState('offline');
  for (const [rid, c] of sync.calls) { sync.calls.delete(rid); spinnerOff(c); c.resolve({ error: { condition: 'disconnected', report: 'the connection to edwind closed' } }); }
  for (const b of sync.buffers.values()) b.sync.opening = null;
  scheduleReconnect();
}
function scheduleReconnect() {
  if (sync.closing || sync.epochChanged || sync.reconnectTimer) return;
  const wait = sync.backoff; sync.backoff = Math.min(BACKOFF_MAX, sync.backoff * 2);
  sync.reconnectTimer = setTimeout(connect, wait);
  if (sync.reconnectTimer.unref) sync.reconnectTimer.unref();
}
function close() { sync.closing = true; if (sync.reconnectTimer) clearTimeout(sync.reconnectTimer); if (sync.sock) { try { sync.sock.close(); } catch (e) { /* closing */ } } }

/* ---------- messages from edwind ---------- */
function onLine(text) {
  let msg; try { msg = JSON.parse(text); } catch (e) { return; }
  if (!msg || typeof msg.t !== 'string') return;
  try { dispatch(msg); } catch (e) { console.error('sync', msg.t, e); }
}
function dispatch(msg) {
  switch (msg.t) {
    case 'welcome': return onWelcome(msg);
    case 'ping': return void send({ t: 'pong', rid: msg.rid });
    case 'pong': return;
    case 'error': return onError(msg);
    case 'snap': return onSnap(msg);
    case 'chunk': return onChunk(msg);
    case 'edits': return onEdits(msg);
    case 'ack': return onAck(msg);
    case 'opened': return onOpened(msg);
    case 'sel': return onSel(msg);
    case 'meta': return onMeta(msg);
    case 'moved': return onMoved(msg);
    case 'killed': return onKilled(msg);
    case 'result': return onResult(msg);
    case 'ask': return onAsk(msg);
    case 'msg': Ed.message(String(msg.text)); Ed.scheduleRender(); return;
    case 'var': try { L.set(String(msg.name), fromJSON(msg.value)); } catch (e) { Ed.message(`var ${msg.name}: ${Ed.errorText(e)}`); } return;
    case 'image': return onImage(msg);
    case 'display': return onDisplay(msg);
    default: return;   // R7.4
  }
}
function onWelcome(msg) {
  sync.welcome = msg;
  if (sync.epoch && msg.imageEpoch !== sync.epoch) {
    /* R7.19: the image was reset or compacted; the page starts a fresh frame runtime. */
    sync.epochChanged = true; sync.emit('epoch', { epoch: msg.imageEpoch, was: sync.epoch });
    return;
  }
  const first = !sync.boot;
  sync.epoch = msg.imageEpoch; sync.boot = msg.boot; sync.backoff = BACKOFF_MIN;
  setState('online');
  for (const b of sync.buffers.values()) sendOpen(b);
  if (!first) imageQuery(sync.gen).catch(() => {});
  if (sync.firstWelcome) { const r = sync.firstWelcome; sync.firstWelcome = null; r(msg); }
}
function sendOpen(b, opts = {}) {
  const s = b.sync, rid = newRid();
  const m = { t: 'open', rid, buf: b.id };
  if (!opts.snap && b.sver >= 0) m.since = b.sver;
  if (s.create) m.create = true;
  s.opening = rid; s.snapText = null;
  send(m);
  return rid;
}
function bufOf(msg) { return sync.buffers.get(msg.buf) || null; }

/* ---------- open, snap, opened ---------- */
function open(id, { create } = {}) {
  if (typeof id !== 'string' || !id) return Promise.reject(new Error('Ed.sync.open needs a buffer id'));
  let b = sync.buffers.get(id);
  if (b) return b.sync.opening || b.sver < 0 ? openPromise(b) : Promise.resolve(b);
  let name = basename(id);
  if (Ed.getBuffer(name)) name = L.call('generate-new-buffer-name', [name]);
  b = new Ed.Buffer(name);
  b.id = id; b.shared = true; b.file = id; b.sver = -1; b.inflight = null; b.queue = []; b.hist = []; b.presence = [];
  b.meta = { file: null, mode: b.mode, modified: false, readOnly: false, saved: 0, diskChanged: null, eol: 'lf', anchors: [], locals: {} };
  b.readOnly = true;   // until the snapshot
  b.sync = { sverText: '', seq: 0, acked: new Set(), gCount: 0, undoStack: [], redoStack: [], create: !!create, opening: null, waiters: [], anchorsServer: [], lastSel: null, selTimer: null };
  E.buffers.push(b); sync.buffers.set(id, b);
  if (E.booted) Ed.runHookSafely('buffer-list-update-hook', []);
  const p = openPromise(b);
  if (sync.state === 'online') sendOpen(b);
  return p;
}
function openPromise(b) { return new Promise((resolve, reject) => b.sync.waiters.push({ resolve, reject })); }
function settleOpen(b, err) { const ws = b.sync.waiters.splice(0); for (const w of ws) (err ? w.reject(err) : w.resolve(b)); }
/* Ed.sync.close(buf): the subscription ends and the replica goes with it at once (close has no answer to wait
   for): kill-buffer moves every window showing it, in any frame, to another buffer first, so closed replicas do
   not pile up in the buffer list. An open still on its way is settled with an error. */
function closeBuffer(id) {
  const b = typeof id === 'string' ? sync.buffers.get(id) : id;
  if (!b) return;
  send({ t: 'close', buf: b.id });
  sync.buffers.delete(b.id); b.shared = false;
  if (b.sync && b.sync.opening) { b.sync.opening = null; settleOpen(b, Object.assign(new Error(`${b.id}: closed`), { code: 'closed' })); }
  if (E.buffers.includes(b)) { try { L.call('kill-buffer', [b]); } catch (e) { Ed.reportError(e); } Ed.scheduleRender(); }
}
function onSnap(msg) {
  const b = bufOf(msg); if (!b) return;
  const s = b.sync;
  s.snap = { rid: msg.rid, ver: msg.ver, text: msg.text, meta: msg.meta };
  if (!msg.more) finishSnap(b);
}
function onChunk(msg) {
  const b = bufOf(msg); if (!b || !b.sync.snap) return;
  b.sync.snap.text += msg.text;
  if (!msg.more) finishSnap(b);
}
function finishSnap(b) {
  const s = b.sync, snap = s.snap; s.snap = null;
  if ((b.inflight || b.queue.length) && snap.text === s.sverText) {
    /* The server has no history for us (a restart) but the same text: our pending batches still apply and
       are resent after opened (R7.16). */
    b.sver = snap.ver; b.hist = []; if (b.inflight) b.inflight.base = snap.ver;
    s.anchorsServer = []; applyMeta(b, snap.meta || {}, snap.ver);
    statusChanged();
    return;
  }
  /* A snapshot replaces the replica: edits the server never acknowledged are kept aside (R7.14, R7.18). */
  offlineCopy(b, 'the server sent a fresh copy');
  b.inflight = null; b.queue = []; b.hist = [];
  const first = b.sver < 0;
  const was = E.inhibitModHooks; E.inhibitModHooks = first || was;   // the first text is not a change
  try { replaceText(b, snap.text, 'remote'); } finally { E.inhibitModHooks = was; }
  b.pt = first ? 0 : Math.min(b.pt, b.rope.length);
  if (first) for (const w of Ed.allWindows()) if (w.buffer === b) { w.pt = 0; w.start = 0; }
  s.sverText = snap.text; b.sver = snap.ver;
  s.anchorsServer = []; s.anchorsVer = snap.ver;
  applyMeta(b, snap.meta || {}, snap.ver);
  b.readOnly = !!(snap.meta && snap.meta.readOnly);
  statusChanged();
}
/* Replace the whole text of B as one change with ORIGIN: the differing middle only. */
function replaceText(b, text, origin) {
  const old = b.rope.toString();
  if (old === text) return;
  const n = Math.min(old.length, text.length);
  let pre = 0; while (pre < n && old.charCodeAt(pre) === text.charCodeAt(pre)) pre++;
  let suf = 0; while (suf < n - pre && old.charCodeAt(old.length - 1 - suf) === text.charCodeAt(text.length - 1 - suf)) suf++;
  if (OT.splitsPair(text, pre) || OT.splitsPair(old, pre)) pre--;
  if (OT.splitsPair(text, text.length - suf) || OT.splitsPair(old, old.length - suf)) suf--;
  sync.applying = b;
  try { Ed.applyOps(b, [[pre, old.slice(pre, old.length - suf), text.slice(pre, text.length - suf)]], origin, text); } finally { sync.applying = null; }
}
function onOpened(msg) {
  const b = bufOf(msg); if (!b) return;
  const s = b.sync;
  if (s.opening !== msg.rid && s.opening !== null) return;
  s.opening = null;
  if (b.sver < 0) { b.sver = msg.ver; }
  if (b.inflight) sendEdit(b);   // R7.16: resend the unacknowledged batch
  else if (b.queue.length) { const q = b.queue.shift(); b.inflight = { seq: ++s.seq, base: b.sver, ops: q.ops, undo: q.undo }; sendEdit(b); }
  settleOpen(b);
  statusChanged();
}

/* ---------- local edits (R7.12, R6.15) ---------- */
/* The undo group of the change a command is making in B: one per command, shared by an Evil insert
   session and by a run of self-inserts (R6.15). */
function groupFor(b) {
  const s = b.sync, self = intern('self-insert-command');
  if (s.gCmd === E.cmdSeq && s.g !== undefined) return s.g;
  const inSession = !!(H.inSession && H.inSession(b));
  const selfRun = E.thisCommand === self && E.lastCommand === self && s.gWasSelf && s.gRun < 20;
  const cont = s.g !== undefined && ((inSession && s.gSession) || selfRun);
  if (!cont) { s.g = ++s.gCount; s.gRun = 0; } else s.gRun++;
  s.gCmd = E.cmdSeq; s.gSession = inSession; s.gWasSelf = E.thisCommand === self;
  return s.g;
}
const wireUndo = u => (u.of !== undefined ? { g: u.g, of: u.of } : { g: u.g });
function sendEdit(b) {
  const f = b.inflight; if (!f) return;
  if (sync.state !== 'online' || b.sync.opening) return;
  send({ t: 'edit', buf: b.id, base: f.base, seq: f.seq, ops: f.ops, undo: wireUndo(f.undo) });
}
function local(b, ops, undo) {
  const s = b.sync;
  const u = undo || { g: groupFor(b) };
  if (!b.inflight) { b.inflight = { seq: ++s.seq, base: b.sver, ops: ops.slice(), undo: u }; sendEdit(b); }
  else if (b.queue.length && b.queue[b.queue.length - 1].undo.g === u.g) b.queue[b.queue.length - 1].ops = b.queue[b.queue.length - 1].ops.concat(ops);
  else b.queue.push({ ops: ops.slice(), undo: u });
  if (u.of === undefined) { if (!u.redo) s.redoStack = []; if (s.undoStack[s.undoStack.length - 1] !== u.g) s.undoStack.push(u.g); }
  for (const f of E.frames) if (f.sel && f.sel.buffer === b) Ed.frameEvent('status', f, b);
}
H.applied = (b, ops, origin) => {
  if (!sync.started || !b.shared || sync.applying === b) return;
  if (origin !== 'local') return;
  const u = sync.pendingUndo; sync.pendingUndo = null;
  local(b, ops, u);
};

/* ---------- remote batches and acks (R6.9) ---------- */
function onEdits(msg) {
  const b = bufOf(msg); if (!b || b.sver < 0) return;
  const s = b.sync;
  if (msg.ver <= b.sver) return;                       // already applied (a replay overlap)
  if (msg.ver !== b.sver + 1) { reopen(b, 'edits out of order'); return; }
  const sverLen = s.sverText.length;
  let R = OT.fromOps(msg.ops, sverLen);
  let base = OT.apply(s.sverText, msg.ops);
  s.sverText = base; b.sver = msg.ver;
  if (b.inflight) {
    const [Rp, Ip] = OT.transform(R, OT.fromOps(b.inflight.ops, sverLen));
    b.inflight.ops = OT.toOps(Ip, base); b.inflight.base = b.sver; R = Rp; base = OT.applyOperation(base, Ip);
  }
  for (const q of b.queue) {
    const [Rp, Qp] = OT.transform(R, OT.fromOps(q.ops, R.baseLen));
    q.ops = OT.toOps(Qp, base); R = Rp; base = OT.applyOperation(base, Qp);
  }
  const own = !!(msg.by && msg.by.cid === sync.cid);
  b.hist.push({ ver: msg.ver, ops: msg.ops, cid: own ? sync.cid : writerKey(msg.by), undo: own ? { g: 'server-' + msg.ver } : undefined, by: msg.by });
  trimHist(b);
  if (own) { s.undoStack.push('server-' + msg.ver); s.redoStack = []; }   // R4.28: a server command's edits are this frame's own
  for (const [pos, del, ins] of msg.ops) for (const a of s.anchorsServer) a.pos = OT.shiftMarker(a.pos, 'after', pos, del.length, ins.length);
  const applied = OT.toOps(R, b.rope);
  sync.applying = b;
  try { Ed.applyOps(b, applied, originOf(msg.by)); } finally { sync.applying = null; }
  if (b.rope.length !== base.length) { divergence(b, 'the replica text does not match'); return; }
  if (msg.h !== undefined && OT.hash(s.sverText) !== msg.h) { divergence(b, 'the text hash differs'); return; }
  touchPresence(b, msg.by);
  anchorsChanged(b);
}
function onAck(msg) {
  const b = bufOf(msg); if (!b) return;
  const s = b.sync;
  if (!b.inflight || b.inflight.seq !== msg.seq) {
    if (msg.ver > b.sver) { divergence(b, 'the server replayed a batch of ours this replica never saw'); return; }   // a thread's edit made for us while we were away (replay sends it as an ack with no ops)
    s.acked.add(msg.seq); return;   // a duplicate from a resend or replay
  }
  s.acked.add(msg.seq);
  const f = b.inflight;
  s.sverText = OT.apply(s.sverText, f.ops); b.sver = msg.ver;
  b.hist.push({ ver: msg.ver, ops: f.ops, cid: sync.cid, undo: f.undo });
  trimHist(b);
  for (const [pos, del, ins] of f.ops) for (const a of s.anchorsServer) a.pos = OT.shiftMarker(a.pos, 'after', pos, del.length, ins.length);
  b.inflight = null;
  if (msg.h !== undefined && OT.hash(s.sverText) !== msg.h) { divergence(b, 'the text hash differs'); return; }
  if (b.queue.length) { const q = b.queue.shift(); b.inflight = { seq: ++s.seq, base: b.sver, ops: q.ops, undo: q.undo }; sendEdit(b); }
  anchorsChanged(b);
  for (const fr of E.frames) if (fr.sel && fr.sel.buffer === b) Ed.frameEvent('status', fr, b);
  Ed.scheduleRender();
}
const HIST_MAX = 10000;
function trimHist(b) { if (b.hist.length > HIST_MAX) b.hist.splice(0, b.hist.length - HIST_MAX); }
/* R7.14, R7.18: the replica is discarded; unsent edits go to an offline buffer; the buffer is reopened fresh. */
function divergence(b, why) {
  console.warn('edwin sync: divergence on', b.id, why);
  Ed.message(`${b.name}: ${why}; reloading it from edwind`);
  offlineCopy(b, why);
  b.inflight = null; b.queue = [];
  reopen(b, why, { snap: true });
}
function offlineCopy(b, why) {
  if (!b.inflight && !b.queue.length) return null;
  const name = `${b.name}~offline-${timeTag()}`;
  const nb = Ed.getBufferCreate(name);
  nb.text = b.rope.toString(); nb.modified = true; nb.mode = b.mode;
  Ed.message(`${b.name}: your unsent edits are kept in ${name} (${why})`);
  return nb;
}
function reopen(b, why, opts = {}) {
  if (sync.state !== 'online') return;
  if (opts.snap) { b.inflight = null; b.queue = []; }
  sendOpen(b, opts);
}

/* ---------- undo (R6.15-R6.19) ---------- */
function historyItems(b, from) {
  const out = b.hist.slice(from || 0).map(x => ({ ops: x.ops, cid: x.cid, undo: x.undo || { g: 'v' + x.ver }, by: x.by }));
  if (b.inflight) out.push({ ops: b.inflight.ops, cid: sync.cid, undo: b.inflight.undo });
  for (const q of b.queue) out.push({ ops: q.ops, cid: sync.cid, undo: q.undo });
  return out;
}
function applyUndoBatch(b, ops, undo) {
  sync.pendingUndo = undo;
  try { Ed.applyOps(b, ops, 'local'); } finally { sync.pendingUndo = null; }
  if (ops.length) { b.pt = Math.min(ops[0][0] + (ops[0][2] ? ops[0][2].length : 0), b.rope.length); if (H.clampPoint) H.clampPoint(b); }
}
function otherWriter(items) { for (let i = items.length - 1; i >= 0; i--) if (items[i].cid !== sync.cid) return writerLabel(items[i].by); return 'another writer'; }
function undoShared(b) {
  const s = b.sync;
  while (s.undoStack.length) {
    const g = s.undoStack.pop();
    const items = historyItems(b);
    const idx = items.findIndex(x => x.cid === sync.cid && x.undo && x.undo.g === g);
    if (idx < 0) { s.undoStack.length = 0; break; }   // before the retained history: the server undoes (R6.19)
    const text = b.rope.toString();
    const r = OT.undoOps({ cid: sync.cid, g }, items.slice(idx), text);
    const ops = OT.toOps(r.op, text);
    const ng = ++s.gCount;
    s.redoStack.push({ u: ng, of: g });
    if (!ops.length) { Ed.message('Undo (nothing left of that change)'); continue; }
    applyUndoBatch(b, ops, { g: ng, of: g });
    Ed.message(r.partial ? `Undo (partial: changed by ${otherWriter(items.slice(idx + 1))})` : 'Undo');
    return false;
  }
  if (sync.state !== 'online') signal('user-error', 'No further undo information');
  spin(call({ cmd: 'undo', buf: b.id })).then(r => { Ed.message(r.error ? r.error.report : r.msg || (r.value ? 'Undo' : 'No further undo information')); Ed.scheduleRender(); });
  return false;
}
function redoShared(b) {
  const s = b.sync;
  const r = s.redoStack.pop();
  if (!r) signal('user-error', 'Already at newest change');
  const items = historyItems(b);
  const idx = items.findIndex(x => x.cid === sync.cid && x.undo && x.undo.g === r.u);
  if (idx < 0) signal('user-error', 'Redo history is no longer available');
  const text = b.rope.toString();
  const before = OT.textBefore(text, items.slice(idx));
  let cur = OT.apply(before, items[idx].ops);
  let op = OT.fromOps(OT.invert(items[idx].ops), cur.length), partial = false;
  for (const it of items.slice(idx + 1)) {
    const was = deletes(op);
    const t = OT.transform(OT.fromOps(it.ops, cur.length), op);
    op = t[1]; if (deletes(op) < was) partial = true;
    cur = OT.apply(cur, it.ops);
  }
  const ops = OT.toOps(op, text);
  const ng = ++s.gCount;
  if (ops.length) applyUndoBatch(b, ops, { g: ng, redo: true });
  s.undoStack.push(ng);
  Ed.message(partial ? `Redo (partial: changed by ${otherWriter(items.slice(idx + 1))})` : 'Redo');
  return false;
}
H.undoShared = undoShared;
H.redoShared = redoShared;

/* ---------- meta, anchors (R9.12), presence (R9.13) ---------- */
function applyMeta(b, m, ver) {
  const s = b.sync;
  const meta = b.meta || {};
  for (const k of ['file', 'mode', 'modified', 'readOnly', 'saved', 'diskChanged', 'eol', 'locals']) if (m[k] !== undefined) meta[k] = m[k];
  b.meta = meta;
  if (Array.isArray(m.anchors)) {
    const at = Number.isInteger(ver) ? ver : Number.isInteger(m.ver) ? m.ver : b.sver;
    const anchors = m.anchors.map(a => ({ id: a.id, pos: a.pos, label: a.label }));
    /* Positions at version AT are brought to the current server version through the batches since. */
    if (at < b.sver) for (const h of b.hist) if (h.ver > at) for (const [pos, del, ins] of h.ops) for (const a of anchors) a.pos = OT.shiftMarker(a.pos, 'after', pos, del.length, ins.length);
    s.anchorsServer = anchors;
  }
  if (m.mode && m.mode !== b.mode) { b.mode = m.mode; b.evilState = undefined; }
  if (m.file) b.file = m.file;
  if (m.modified !== undefined) b.modified = !!m.modified;
  if (m.readOnly !== undefined && b.sver >= 0) b.readOnly = !!m.readOnly;
  anchorsChanged(b);
  statusChanged();
}
/* b.meta.anchors in the replica's coordinates: the server positions mapped through inflight and the queue. */
function anchorsChanged(b) {
  const s = b.sync;
  const out = s.anchorsServer.map(a => ({ id: a.id, pos: a.pos, label: a.label }));
  const through = ops => { for (const [pos, del, ins] of ops) for (const a of out) a.pos = OT.shiftMarker(a.pos, 'after', pos, del.length, ins.length); };
  if (b.inflight) through(b.inflight.ops);
  for (const q of b.queue) through(q.ops);
  b.meta.anchors = out;
}
/* Local edits move the anchors too (R9.12): b.meta.anchors is recomputed after every change. */
{ const prev = H.applied; H.applied = (b, ops, origin) => { prev(b, ops, origin); if (b.shared && b.sync && sync.started) anchorsChanged(b); }; }
function onMeta(msg) { const b = bufOf(msg); if (!b) return; applyMeta(b, msg, msg.ver); }
function onSel(msg) {
  const b = bufOf(msg); if (!b || !Array.isArray(msg.ranges)) return;
  const key = writerKey(msg.by);
  let p = b.presence.find(x => x.key === key);
  if (!p) { p = { key, by: msg.by, color: writerColor(key), label: writerLabel(msg.by), ranges: [], at: 0 }; b.presence.push(p); }
  p.ranges = msg.ranges.filter(r => Array.isArray(r) && r.length === 2).map(r => [Math.max(0, Math.min(b.rope.length, r[0])), Math.max(0, Math.min(b.rope.length, r[1]))]);
  p.at = Date.now(); p.agent = msg.by && msg.by.kind === 'agent';
  b._presTick = (b._presTick || 0) + 1;
  Ed.scheduleRender();
}
function touchPresence(b, by) {
  if (!by) return;
  const key = writerKey(by), p = b.presence.find(x => x.key === key);
  if (p) { p.at = Date.now(); b._presTick = (b._presTick || 0) + 1; }
}
/* Our own point and mark, sent as sel at most 20 times a second. */
function maybeSendSel(b) {
  if (!b.shared || sync.state !== 'online') return;
  const s = b.sync;
  const r = b.markActive && b.mark !== null ? [Math.min(b.pt, b.mark), Math.max(b.pt, b.mark)] : [b.pt, b.pt];
  const key = r[0] + ':' + r[1];
  if (s.lastSel === key) return;
  s.lastSel = key;
  if (s.selTimer) return;
  s.selTimer = setTimeout(() => { s.selTimer = null; const rr = b.markActive && b.mark !== null ? [Math.min(b.pt, b.mark), Math.max(b.pt, b.mark)] : [b.pt, b.pt]; send({ t: 'sel', buf: b.id, ranges: [rr] }); }, SEL_MS);
  if (s.selTimer.unref) s.selTimer.unref();
}
/* Other writers' cursors and regions, drawn in a frame's presence layer with the writer's colour and label. */
H.renderPresence = f => {
  let layer = f.el('presence');
  const doc = f.root.ownerDocument;
  const bufs = Ed.leaves(f.wroot).map(w => w.buffer);
  const any = bufs.some(b => b.presence && b.presence.length);
  if (!any) { if (layer) layer.textContent = ''; return; }
  if (!layer) { layer = doc.createElement('div'); layer.className = 'ed-presence'; layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;overflow:hidden'; f.root.appendChild(layer); f.parts.presence = layer; }
  const sc = Ed.frameScale(f), fr = f.root.getBoundingClientRect(), now = Date.now();
  const parts = [];
  let fadeDue = 0;
  for (const w of Ed.leaves(f.wroot)) {
    const b = w.buffer; if (!b.presence) continue;
    for (const p of b.presence) {
      if (p.agent) { const left = AGENT_FADE_MS - (now - p.at); if (left <= 0) continue; fadeDue = fadeDue ? Math.min(fadeDue, left) : left; }
      for (const [from, to] of p.ranges) {
        if (from === to) {
          const r = Ed.rectAt(w, from, 0) || Ed.rectAt(w, Math.max(0, from - 1), 1);
          if (!r) continue;
          const x = (r.left - fr.left) / sc + (from > 0 && !Ed.rectAt(w, from, 0) ? r.width / sc : 0), y = (r.top - fr.top) / sc, h = r.height / sc;
          parts.push(`<div class="pc" style="left:${x}px;top:${y}px;height:${h}px;background:${p.color}"><span style="background:${p.color}">${esc(p.label)}</span></div>`);
        } else {
          for (const r of rangeRects(w, from, to)) parts.push(`<div class="pr" style="left:${(r.left - fr.left) / sc}px;top:${(r.top - fr.top) / sc}px;width:${r.width / sc}px;height:${r.height / sc}px;background:${p.color}"></div>`);
        }
      }
    }
  }
  const html = parts.join('');
  if (layer._h !== html) { layer.innerHTML = html; layer._h = html; }
  if (fadeDue) { clearTimeout(f._fadeTimer); f._fadeTimer = setTimeout(() => { for (const b of bufs) b._presTick = (b._presTick || 0) + 1; Ed.frameRender(); }, fadeDue + 20); }
};
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
/* Client rects of the text from FROM to TO in window W, line by line, for the lines that are drawn. */
function rangeRects(w, from, to) {
  const t = w.buffer.rope, out = [];
  let ls = Ed.bol(t, from), n = 0;
  while (ls <= to && n++ < 200) {
    const le = Ed.eol(t, ls);
    const a = Math.max(from, ls), z = Math.min(to, le);
    if (z > a) { const r = Ed.rectAt(w, a, z - a); if (r && r.width) out.push(r); }
    else if (z === a && le < to) { const r = Ed.rectAt(w, a, 0); if (r) out.push({ left: r.left, top: r.top, width: Math.max(4, r.height / 3), height: r.height }); }
    if (le >= t.length) break;
    ls = le + 1;
  }
  return out;
}

/* ---------- moved, killed, display ---------- */
function onMoved(msg) {
  const b = bufOf(msg); if (!b) return;
  sync.buffers.delete(b.id);
  /* This tab already holds a replica of the new id (an open of an old id edwind sent on): that one stays, and the
     replica made for the old id is dropped here only. It is not shared any more, so its kill sends no close, which
     would detach the replica that stays. Its opens settle with the one that stays. */
  const have = sync.buffers.get(msg.to);
  if (have && have !== b) {
    b.shared = false; b.sync.opening = null;
    const ws = b.sync.waiters.splice(0);
    if (have.sync.opening || have.sver < 0) have.sync.waiters.push(...ws); else for (const w of ws) w.resolve(have);
    if (E.buffers.includes(b)) { try { L.call('kill-buffer', [b]); } catch (e) { Ed.reportError(e); } Ed.scheduleRender(); }
    sync.emit('moved', { buf: msg.buf, to: msg.to });
    return;
  }
  b.id = msg.to; b.file = msg.to; b.name = basename(msg.to);
  sync.buffers.set(b.id, b);
  b.sync.acked = new Set();
  Ed.message(`${b.name}: the file moved to ${msg.to}`);
  sendOpen(b, { snap: true });
  sync.emit('moved', { buf: msg.buf, to: msg.to });   // the page that names the buffer by id follows (app.js)
}
function onKilled(msg) {
  const b = bufOf(msg); if (!b) return;
  sync.buffers.delete(b.id); b.shared = false;
  if (E.buffers.includes(b)) { try { L.call('kill-buffer', [b]); } catch (e) { Ed.reportError(e); } }
  Ed.message(`${b.name} was killed on the server`);
  Ed.scheduleRender();
}
function onDisplay(msg) {
  if (sync.emit('display', { buf: msg.buf, how: msg.how })) return;
  if (!E.frame) return;
  open(msg.buf).then(b => { Ed.popToBuffer(b, false); Ed.scheduleRender(); }, e => Ed.message(String(e && e.message || e)));
}

/* ---------- calls, results, errors (section 7.4) ---------- */
function ctxNow(buf) {
  const b = buf || E.current, ctx = {};
  if (b) { ctx.point = b.pt + 1; if (b.mark !== null && b.mark !== undefined) ctx.mark = b.mark + 1; if (b.shared) ctx.buffer = b.id; }
  if (E.prefixArg !== null && E.prefixArg !== undefined) ctx.prefix = E.prefixArg;
  return ctx;
}
function call({ cmd, form, args, buf, ctx } = {}) {
  if (sync.state !== 'online') return Promise.resolve({ error: { condition: 'offline', report: 'edwind is not connected' } });
  const rid = newRid();
  const m = { t: 'call', rid, ctx: ctx || ctxNow() };
  if (typeof form === 'string') m.form = form; else m.cmd = String(cmd);
  if (args !== undefined) m.args = args;
  const bid = typeof buf === 'string' ? buf : buf && buf.shared ? buf.id : E.current && E.current.shared ? E.current.id : undefined;
  if (bid) m.buf = bid;
  return new Promise(resolve => { sync.calls.set(rid, { resolve, frame: E.frame, at: Date.now(), rid }); send(m); });
}
function onResult(msg) {
  const c = sync.calls.get(msg.rid); if (!c) return;
  sync.calls.delete(msg.rid); spinnerOff(c);
  const r = {}; for (const k of ['value', 'error', 'msg', 'out']) if (msg[k] !== undefined) r[k] = msg[k];
  c.resolve(r);
}
function spin(p, c) {
  const t = setTimeout(() => { sync.spinning++; statusChanged(); t.fired = true; }, SPINNER_MS);
  if (t.unref) t.unref();
  const done = () => { clearTimeout(t); if (t.fired) { sync.spinning = Math.max(0, sync.spinning - 1); statusChanged(); } };
  p.then(done, done);
  return p;
}
function spinnerOff() { /* the spinner is per call through spin(); nothing to do for the call record */ }
function imageQuery(from) { const rid = newRid(); return new Promise(resolve => { sync.calls.set(rid, { resolve, frame: E.frame, at: Date.now(), rid }); send({ t: 'image?', rid, from }); }); }
function onError(msg) {
  const code = msg.code || 'bad_request';
  if (msg.rid && sync.calls.has(msg.rid)) { const c = sync.calls.get(msg.rid); sync.calls.delete(msg.rid); c.resolve({ error: { condition: code, report: msg.msg || code } }); return; }
  const b = msg.buf ? sync.buffers.get(msg.buf) : null;
  if (b && msg.rid && b.sync.opening === msg.rid) {
    /* The open failed (no_buffer, bad_id, not_text, refused_path): the buffer goes away. */
    b.sync.opening = null; sync.buffers.delete(b.id); b.shared = false;
    E.buffers = E.buffers.filter(x => x !== b);
    settleOpen(b, Object.assign(new Error(msg.msg || code), { code }));
    Ed.message(code === 'not_text' ? `${b.name}: not UTF-8 text` : `${b.name}: ${msg.msg || code}`);
    Ed.scheduleRender(); return;
  }
  switch (code) {
    case 'bad_edit':
      if (b) { Ed.message(`${b.name}: the server refused an edit (${msg.msg}); reloading`); if (b.inflight && b.inflight.seq === msg.seq) { offlineCopy(b, 'the server refused the edit'); b.inflight = null; b.queue = []; } reopen(b, 'bad_edit'); }
      break;
    case 'stale_base':
      if (b) { Ed.message(`${b.name}: your edits were made against a version edwind no longer has`); divergence(b, 'stale base'); }
      break;
    case 'read_only':
      if (b) { Ed.message(`${b.name} is read-only: ${(b.meta && b.meta.readOnly) || msg.msg}`); b.readOnly = true; if (b.inflight || b.queue.length) { offlineCopy(b, 'read-only'); reopen(b, 'read_only', { snap: true }); } }
      else Ed.message(msg.msg || 'read-only');
      break;
    case 'shutting_down': sync.backoff = Math.max(sync.backoff, BACKOFF_MIN); Ed.message('edwind is stopping; reconnecting'); break;
    case 'slow_client': Ed.message('edwind dropped this connection (too slow); reconnecting'); break;
    case 'proto': Ed.message('edwind speaks another protocol version: reload the page'); sync.closing = true; break;
    default: Ed.message(`edwind: ${code}${msg.msg ? ': ' + msg.msg : ''}`);
  }
  Ed.scheduleRender();
}

/* ---------- ask (R4.29, R10.10) ---------- */
function onAsk(msg) {
  const c = sync.calls.get(msg.rid);
  sync.asks.push({ rid: msg.rid, kind: msg.kind, prompt: String(msg.prompt || ''), init: msg.init, table: Array.isArray(msg.table) ? msg.table.map(String) : null, frame: c ? c.frame : E.frame });
  pumpAsks();
}
function pumpAsks() { if (sync.askPending || !sync.asks.length) return; sync.askPending = true; Ed.feedKey('<cmd:%sync-ask>'); }
L.CMD('%sync-ask', '', '', 'Answer the next ask from edwind in the calling frame\'s minibuffer (internal).', async () => {
  sync.askPending = false;
  const a = sync.asks[0]; if (!a) return false;
  if (E.mini) { setTimeout(pumpAsks, 100); return false; }
  sync.asks.shift();
  if (a.frame && E.frames.includes(a.frame) && E.frame !== a.frame) Ed.selectFrame(a.frame);
  let value, quit = false;
  try {
    switch (a.kind) {
      case 'completing': value = await Ed.readMini(a.prompt, a.init || '', () => a.table || [], { kind: 'ask' }); break;
      case 'y-or-n': {
        for (;;) { const ch = L.chr(await Ed.readChar(a.prompt + '(y or n) ')); if (ch === 'y' || ch === 'Y') { value = true; break; } if (ch === 'n' || ch === 'N') { value = false; break; } Ed.ding(); }
        break;
      }
      case 'char': value = L.chr(await Ed.readChar(a.prompt)); break;
      case 'number': { const v = await Ed.readMini(a.prompt, a.init || ''); const n = Number(v); value = v.trim() !== '' && !isNaN(n) ? n : v; break; }
      case 'yes-or-no': default: value = await Ed.readMini(a.prompt, a.init || ''); break;
    }
  } catch (e) { if (!L.isQuit(e)) throw e; quit = true; }
  if (quit) { send({ t: 'answer', rid: a.rid, quit: true }); E.echo = 'Quit'; }
  else send({ t: 'answer', rid: a.rid, value });
  if (sync.asks.length) pumpAsks();
  return false;
});
/* C-g while a call is pending interrupts it on the server (R4.37). */
{ const prev = H.beforeKey; H.beforeKey = async k => { if (k === 'C-g' && sync.started && sync.calls.size && sync.state === 'online') send({ t: 'interrupt' }); return prev ? prev(k) : false; }; }

/* ---------- the image (R4.15-R4.18) ---------- */
function onImage(msg) {
  const forms = Array.isArray(msg.forms) ? msg.forms : [];
  for (const text of forms) {
    let read;
    try { read = L.readAll(String(text)); } catch (e) { Ed.message(`Image #${msg.gen}: unreadable form: ${Ed.errorText(e)}`); continue; }
    for (const f of read) {
      if (f instanceof L.Pair && f.car instanceof Sym && f.car.name === 'on-server') continue;   // R4.16
      try { L.resetOps(); L.ev(f); } catch (e) { Ed.message(`Image #${msg.gen}: ${String(text).slice(0, 60)}: ${Ed.errorText(e)}`); }
    }
  }
  if (Number.isInteger(msg.gen)) sync.gen = Math.max(sync.gen, msg.gen);
  Ed.scheduleRender();
}

/* ---------- server commands and evaluation (R4.27, R4.15) ---------- */
function serverCommand(name) {
  const b = E.current;
  const p = spin(call({ cmd: name, args: [], buf: b, ctx: ctxNow(b) }));
  p.then(r => {
    if (r.error) Ed.message(r.error.condition === 'quit' ? 'Quit' : `${name}: ${r.error.report || r.error.condition}`);
    else if (r.msg) Ed.message(r.msg);
    Ed.scheduleRender();
  });
  return false;
}
function evalServer(text, { insert, buf, done } = {}) {
  const b = buf && buf.shared ? buf : null;
  const p = spin(call({ form: text, buf: b || undefined, ctx: ctxNow(buf) }));
  p.then(r => {
    if (r.error) { Ed.message(r.error.condition === 'quit' ? 'Quit' : r.error.report || r.error.condition); Ed.scheduleRender(); return; }
    const v = r.value === undefined ? '' : String(r.value);
    if (insert && buf && E.buffers.includes(buf)) Ed.runCallback(() => { const save = E.current; E.current = buf; try { Ed.insertText(buf, insert === 'line' ? '\n' + v + '\n' : v); } finally { E.current = save; } });
    else if (done) Ed.message(done);
    else Ed.message((r.msg ? r.msg + ' ' : '') + v);
    Ed.scheduleRender();
  });
  return false;
}

/* ---------- files in served mode: visit, save, revert, kill ---------- */
function visit(name) {
  const id = String(name).trim();
  const existing = sync.buffers.get(id) || E.buffers.find(b => b.shared && (b.id === id || b.file === id));
  if (existing && existing.sver >= 0) { Ed.setWindowBuffer(existing); if (H.visited) H.visited(existing, id, false); return existing; }
  return open(id, { create: true }).then(b => {
    Ed.setWindowBuffer(b);
    if (H.visited) H.visited(b, id, true);
    const save = E.current; E.current = b;
    try { L.resetOps(); L.runHook('find-file-hook'); } catch (e) { Ed.reportError(e); } finally { E.current = save; }
    Ed.scheduleRender();
    return b;
  }, e => { Ed.message(e && e.message ? e.message : String(e)); Ed.scheduleRender(); return false; });
}
function save(b) { b = typeof b === 'string' ? sync.buffers.get(b) : b; if (!b) return Promise.resolve({ error: { condition: 'error', report: 'no such buffer' } }); const rid = newRid(); return new Promise(resolve => { sync.calls.set(rid, { resolve, frame: E.frame, at: Date.now(), rid }); send({ t: 'save', rid, buf: b.id }); }); }
function revert(b) { b = typeof b === 'string' ? sync.buffers.get(b) : b; if (!b) return Promise.resolve({ error: { condition: 'error', report: 'no such buffer' } }); const rid = newRid(); return new Promise(resolve => { sync.calls.set(rid, { resolve, frame: E.frame, at: Date.now(), rid }); send({ t: 'revert', rid, buf: b.id }); }); }
function saveShared(b) { spin(save(b)).then(r => { Ed.message(r.error ? `${b.name}: ${r.error.report}` : `Wrote ${b.file || b.id}`); Ed.scheduleRender(); }); return false; }
function revertShared(b) { spin(revert(b)).then(r => { Ed.message(r.error ? `${b.name}: ${r.error.report}` : `${b.file || b.id} reloaded`); Ed.scheduleRender(); }); return false; }
function anchorAdd(buf, pos, label, id) {
  const bid = typeof buf === 'string' ? buf : buf.id;
  const args = [bid, pos]; if (label !== undefined && label !== null) args.push(label); if (id !== undefined && id !== null) { if (args.length < 3) args.push(null); args.push(id); }
  return call({ cmd: 'anchor-add', args, buf: bid, ctx: {} }).then(r => { if (r.error) throw Object.assign(new Error(r.error.report), r.error); return r.value && r.value.id !== undefined ? r.value.id : r.value; });
}
function anchorRemove(buf, id) { const bid = typeof buf === 'string' ? buf : buf.id; return call({ cmd: 'anchor-remove', args: [bid, id], buf: bid, ctx: {} }).then(r => { if (r.error) throw Object.assign(new Error(r.error.report), r.error); return r.value; }); }

/* ---------- the mode line (R9.15) and the frame events ---------- */
H.modeStatus = b => {
  if (!sync.started) return '';
  const out = [];
  if (b.shared) {
    if (b.inflight || (b.queue && b.queue.length)) out.push('•');
    if (sync.state !== 'online') out.push('⚠ offline');
    if (b.meta && b.meta.diskChanged) out.push('⚠ disk');
  }
  if (sync.spinning) out.push('⟳');
  return out.join(' ');
};
H.statusKey = () => (sync.started ? sync.state + '|' + sync.spinning : '');
{
  const prev = H.postCommand;
  H.postCommand = (def, b, failed) => {
    if (prev) prev(def, b, failed);
    if (!sync.started) return;
    /* An insert session that ended closes its undo group: the next change in that buffer starts a new one. */
    for (const sb of sync.buffers.values()) if (sb.sync.gSession && !(H.inSession && H.inSession(sb))) sb.sync.gSession = false;
    const f = E.frame, fb = f && f.sel ? f.sel.buffer : E.current;
    if (fb && fb.shared) maybeSendSel(fb);
    if (f && fb) { const k = fb.pt + ':' + fb.id; if (f._lastPoint !== k) { f._lastPoint = k; Ed.frameEvent('point', f, fb); } }
  };
}

/* ---------- served-mode boot (R4.11, R4.12, R9.1) ---------- */
function memoryStorage() {
  const map = new Map();
  return { get: k => (map.has(k) ? map.get(k) : null), set: (k, v) => { map.set(k, String(v)); return true; }, remove: k => { map.delete(k); }, keys: () => [...map.keys()] };
}
/* Primitives the registry marks server-only exist here as stubs that signal server-only (R4.30). */
function defineStubs(registry) {
  if (!Array.isArray(registry)) return 0;
  let n = 0;
  for (const p of registry) {
    if (!p || p.where !== 'server' || typeof p.name !== 'string' || p.name === '%image-server?') continue;
    if (L.get(p.name) !== undefined) continue;
    const name = p.name;
    const f = L.D(name, p.args || '', `${p.doc || ''} (runs in edwind only)`.trim(), () => signal('server-only', name, `runs in edwind: declare the command (:where 'server)`));
    f.where = 'server'; n++;
  }
  return n;
}
async function bootServed({ sources, transport, device, cid, pending } = {}) {
  if (sync.booted) throw new Error('Ed.bootServed was already called');
  sync.booted = true;
  if (sources) { host.sources = sources; host.config = name => (Object.prototype.hasOwnProperty.call(sources, name) ? sources[name] : null); }
  /* R4.12: the browser's lmacs:file:* and edwin:* stores are not read in served mode. */
  if (host.kind === 'browser') { host.pageStorage = host.storage; host.storage = memoryStorage(); }
  const notServer = L.D('%image-server?', '', '#f: this runtime is a frame (sync.js).', () => false); notServer.where = 'both';
  Ed.boot({ served: true });
  Ed.hooks.serverCommand = serverCommand;
  Ed.hooks.evalServer = evalServer;
  Ed.hooks.visit = visit;
  Ed.hooks.saveShared = saveShared;
  Ed.hooks.revertShared = revertShared;
  Ed.hooks.killShared = b => closeBuffer(b);
  if (pending) importPending(pending);
  await start({ transport, device, cid });
  const ui = await call({ cmd: 'user-init' });
  if (ui && typeof ui.value === 'string' && ui.value.trim()) { try { for (const f of L.readAll(ui.value)) { L.resetOps(); L.ev(f); } } catch (e) { Ed.message(`Error in ~/.config/edwin/init.scm: ${Ed.errorText(e)}`); } }
  await imageQuery(0);
  const prims = await call({ cmd: 'primitives' });
  if (prims && prims.value) defineStubs(prims.value);
  await refreshCandidates();
  const info = await call({ cmd: 'notes-info' });
  if (info && info.value && typeof info.value.root === 'string') L.set('notes-directory', info.value.root);
  const op = L.get('open-page'); if (typeof op === 'function') L.set('wiki-follow-function', op);
  L.set('resolve-ref-function', L.D('%sync-resolve-ref', 'address', 'The text an ((ADDRESS)) shows, from the server\'s notes index (R10.4): cached; #f while the answer is on its way.', ([a]) => resolveRef(String(a))));
  sync.ready = true; sync.emit('ready');
  return sync;
}
async function refreshCandidates() {
  const r = await call({ cmd: 'capf-candidates', args: [{ kind: 'wiki' }] });
  if (r && Array.isArray(r.value)) L.set('wiki-candidates', listOf(r.value.map(String)));
  return r;
}
/* ((references)) to pages that are not open resolve on the server (markdown-resolve-ref there reads the notes
   index); the answer is cached by address and the display cache is invalidated when it lands. */
const refs = new Map(); let refGen = 0;
function resolveRef(addr) {
  const c = refs.get(addr);
  if (c) return c.pending ? false : c.text;
  refs.set(addr, { pending: true, text: false });
  if (refs.size > 2000) for (const k of [...refs.keys()].slice(0, 1000)) refs.delete(k);
  call({ form: `(markdown-resolve-ref ${JSON.stringify(addr)})`, ctx: {} }).then(r => {
    let text = false;
    if (!r.error && typeof r.value === 'string') { try { const v = L.read(r.value); if (typeof v === 'string') text = v; } catch (e) { /* not a string */ } }
    refs.set(addr, { pending: false, text });
    L.set('notes-generation', BigInt(-(++refGen)));   // a new cache key for markdown-mode's display cache
    Ed.scheduleRender();
  });
  return false;
}
/* Unsent edits across a runtime reload (R7.19, R6.10): exportPending() before, pending: in bootServed after. */
function exportPending() {
  const out = [];
  for (const b of sync.buffers.values()) if (b.inflight || b.queue.length) out.push({ buf: b.id, sver: b.sver, sverText: b.sync.sverText, seq: b.sync.seq, inflight: b.inflight, queue: b.queue });
  return out;
}
function importPending(list) {
  for (const p of list) {
    if (!p || typeof p.buf !== 'string') continue;
    open(p.buf).catch(() => {});
    const b = sync.buffers.get(p.buf); if (!b) continue;
    const s = b.sync;
    s.sverText = String(p.sverText || ''); b.sver = Number.isInteger(p.sver) ? p.sver : -1; s.seq = p.seq || 0;
    b.inflight = p.inflight || null; b.queue = Array.isArray(p.queue) ? p.queue : [];
    let text = s.sverText; if (b.inflight) text = OT.apply(text, b.inflight.ops); for (const q of b.queue) text = OT.apply(text, q.ops);
    const was = E.inhibitModHooks; E.inhibitModHooks = true;
    try { replaceText(b, text, 'remote'); } finally { E.inhibitModHooks = was; }
    b.readOnly = false;
    if (b.inflight) s.undoStack.push(b.inflight.undo.g); for (const q of b.queue) s.undoStack.push(q.undo.g);
  }
}

Ed.sync = Object.assign(sync, { start, open, close: closeBuffer, shutdown: close, call, save, revert, anchorAdd, anchorRemove, refreshCandidates, exportPending, fromJSON, writerColor, writerLabel });
Ed.bootServed = bootServed;
})();
