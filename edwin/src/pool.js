/* Threads: a pool of Web Workers that each run the full Edwin Scheme (scheme.js, runtime.js), the
   rope (text.js) and the Lisp lexer, all built from the module sources into one blob: URL, so no
   separate file is served. Each worker keeps a mirror of every buffer it has been asked about and
   follows it through the edit log (deltas), so a job copies the text across once. Jobs are either
   named pure JS functions (EdPool.define/run/map: the word index, candidate filtering, lex, :s,
   grep) or Scheme code shipped by closure conversion (thread-run, future, parallel-map). Results
   come back as promises for JS callers and as futures for Scheme, whose handlers run on the main
   thread at a safe point of the command loop. When workers are not available every job still runs
   on the main thread, only without parallelism. */
(function () {
'use strict';
const Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, L = globalThis.L, S = L.S;
const { intern, NIL, UNSPEC, listOf, arr, truthy, SchemeError, Sym, Pair } = L;
const { D, CMD } = L;

const SIZE = Math.min(6, Math.max(1, ((globalThis.navigator && navigator.hardwareConcurrency) || 2) - 1));
const DELTA_CAP = 4096;          // a mirror more than this many versions behind is reset, not patched (trimLog's own cutoff)
const MIRROR_BUDGET = 64 << 20;  // per worker: total mirror characters before LRU eviction
const SCHEME_TIMEOUT = 30000;    // watchdog limit for Scheme jobs in a worker (the main thread uses 8000)
const CRASH_LIMIT = 3, CRASH_WINDOW = 60000;
const CAP = 50000;               // word index cap
const UI = 0, BATCH = 1;         // priorities
const JOB_LIMIT = 30000;         // a shard of :s or grep that runs longer (a regexp that backtracks) is stopped

/* ---------- codec: structured-clone-safe tagged trees; the same source runs in both realms ---------- */
function codecModule(g) {
  const S = g.Scheme;
  if (!S) { g.EdCodec = null; return; }
  const hooks = { buffer: null };    // set per realm: a buffer handle { id, name, pt, ver } -> the buffer or mirror
  const shipErr = msg => new S.SchemeError('ship-error', msg, []);
  /* META.buffers collects every buffer met; META.ship turns a procedure into an (encoded) form;
     META.record is told the type of every record met (the converter ships it ahead of the data). */
  function encode(x, meta) {
    const active = new Set();
    const enc = x => {
      if (x === true || x === false || typeof x === 'number' || typeof x === 'string') return x;
      if (x === S.NIL) return { $: 'nil' };
      if (x === S.UNSPEC || x === undefined || x === null) return { $: 'u' };
      if (x === S.EOF) return { $: 'eof' };
      if (x instanceof S.Sym) return { $: 'y', n: x.name };
      if (x instanceof S.Alias) return { $: 'y', n: S.baseName(x).name };
      if (x instanceof S.Char) return { $: 'c', c: x.code };
      if (x instanceof S.Pair) {
        const a = [], cells = []; let c = x, n = 0;
        while (c instanceof S.Pair) {
          if (active.has(c)) throw shipErr('cannot send a cyclic structure to a thread');
          active.add(c); cells.push(c);
          a.push(enc(c.car)); c = c.cdr;
          if (++n > 10000000) throw shipErr('cannot send a list of more than 10 million cells to a thread');
        }
        const out = { $: 'l', a };
        if (c !== S.NIL) out.t = enc(c);
        for (const p of cells) active.delete(p);
        return out;
      }
      if (typeof x === 'function') { if (meta && meta.ship) return { $: 'proc', f: meta.ship(x) }; throw shipErr('cannot send ' + S.write(x) + ' to a thread'); }
      if (typeof x !== 'object') throw shipErr('cannot send ' + S.write(x) + ' to a thread');
      if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer) return x;
      if (active.has(x)) throw shipErr('cannot send a cyclic structure to a thread');
      active.add(x);
      try {
        if (Array.isArray(x)) return { $: 'v', a: x.map(enc) };
        if (x instanceof Map) { const e = []; for (const [k, v] of x) e.push([enc(k), enc(v)]); return { $: 'h', e }; }
        if (x instanceof S.Record) { if (meta && meta.record) meta.record(x.type); return { $: 'r', t: x.type.name, f: x.fields.map(enc) }; }
        if (x instanceof S.Values) return { $: 'vals', a: x.vals.map(enc) };
        if (x instanceof RegExp) return { $: 'rx', s: x.source, f: x.flags };
        if (x instanceof S.SchemeError) return { $: 'e', k: x.kind, m: x.message, i: x.irritants.map(enc) };
        if (x.__type === 'buffer') { if (meta && meta.buffers) meta.buffers.add(x); return { $: 'b', id: x.id, name: x.name, pt: x.pt, ver: x.ver }; }
        if (x instanceof S.Param) return { $: 'p', v: enc(x.value) };
        throw shipErr('cannot send ' + S.write(x) + ' to a thread');
      } finally { active.delete(x); }
    };
    return enc(x);
  }
  const rtCache = new Map();
  function recordType(name) {
    const b = S.globals.get(name);
    if (b && b.value instanceof S.RecordType) return b.value;
    let rt = rtCache.get(name);
    if (!rt) { rt = new S.RecordType(name, []); rtCache.set(name, rt); }
    return rt;
  }
  function decode(x) {
    const dec = x => {
      if (x === null) return S.UNSPEC;
      if (typeof x !== 'object') return x;
      if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer) return x;
      switch (x.$) {
        case 'nil': return S.NIL;
        case 'u': return S.UNSPEC;
        case 'eof': return S.EOF;
        case 'y': return S.intern(x.n);
        case 'c': return S.mkchar(x.c);
        case 'l': { const a = x.a.map(dec); return S.listOf(a, x.t === undefined ? S.NIL : dec(x.t)); }
        case 'v': return x.a.map(dec);
        case 'h': { const m = new Map(); for (const [k, v] of x.e) m.set(dec(k), dec(v)); return m; }
        case 'r': return new S.Record(recordType(x.t), x.f.map(dec));
        case 'vals': return new S.Values(x.a.map(dec));
        case 'rx': return new RegExp(x.s, x.f);
        case 'e': return new S.SchemeError(x.k, x.m, x.i.map(dec));
        case 'b': return hooks.buffer ? hooks.buffer(x) : false;
        case 'p': return new S.Param(dec(x.v), null);
        case 'proc': return S.evalForm(dec(x.f));
      }
      return x;   /* a plain object from a JS job stays as it is */
    };
    return dec(x);
  }
  g.EdCodec = { encode, decode, hooks };
}

/* ---------- worker side: the read-only buffer primitives of a thread (1-based, as editor-prims.js) ---------- */
function workerPrims(self) {
  const S = self.Scheme, L = self.L;
  if (!S || !L) return;
  const { D, listOf, signal } = L;
  let W = null;    // the worker state: mirrors, cur, k, t0, touch, report
  const isBuf = x => !!x && typeof x === 'object' && x.__type === 'buffer';
  function live(m) {
    if (!isBuf(m)) signal('wrong-type-argument', S.intern('bufferp'), m);
    if (m.dead || !m.rope) throw new S.SchemeError('buffer-killed', 'Buffer ' + m.name + ' was killed', [m]);
    W.touch(m);
    return m;
  }
  const cur = () => { if (!W.cur) throw new S.SchemeError('error', 'No current buffer in this thread: pass the buffer as an argument or with :buffers', []); return live(W.cur); };
  const buf = b => b === undefined || b === false ? cur() : live(b);
  const int = x => { if (!Number.isInteger(x)) signal('wrong-type-argument', 'expected an integer, got', x); return x; };
  const given = x => x !== undefined && x !== false;
  const pos = (m, x) => { const p = int(x) - 1; if (p < 0 || p > m.rope.length) signal('args-out-of-range', x); return p; };
  const bol = (t, p) => p <= 0 ? 0 : t.lastIndexOf('\n', p - 1) + 1;
  const eol = (t, p) => { const k = t.indexOf('\n', p); return k < 0 ? t.length : k; };
  const lineCount = r => { const nl = r.newlines(); return r.length && r.charCodeAt(r.length - 1) === 10 ? nl : nl + 1; };
  const gre = r => { if (!(r instanceof RegExp)) signal('wrong-type-argument', 'expected a regexp, got', r); return new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'); };
  D('current-buffer', '', 'The buffer this job was given (the first buffer argument or :buffers).', () => cur());
  D('buffer-list', '', 'The buffers mirrored on this thread.', () => listOf([...W.mirrors.values()]));
  D('get-buffer', 'NAME', 'The mirrored buffer named NAME, or #f.', ([n]) => { if (isBuf(n)) return n; for (const m of W.mirrors.values()) if (m.name === n) return m; return false; });
  D('buffer-name', '&optional BUFFER', 'Name of BUFFER.', ([b]) => buf(b).name);
  D('buffer-size', '&optional BUFFER', 'Number of characters in BUFFER.', ([b]) => buf(b).rope.length);
  D('buffer-version', '&optional BUFFER', 'Version of the mirror of BUFFER (buffer-changed-since? on the main thread tells whether it is stale).', ([b]) => buf(b).ver);
  D('bufferp', 'OBJECT', 'Non-#f if OBJECT is a buffer.', ([x]) => isBuf(x));
  D('buffer?', 'OBJECT', 'Non-#f if OBJECT is a buffer.', ([x]) => isBuf(x));
  D('point', '', 'Point of the current buffer when the job was posted.', () => cur().pt + 1);
  D('point-min', '', 'Always 1.', () => 1);
  D('point-max', '', 'One past the last character.', () => cur().rope.length + 1);
  D('buffer-string', '&optional BUFFER', 'The whole text.', ([b]) => buf(b).rope.toString());
  D('buffer-substring', 'START END &optional BUFFER', 'Text between START and END.', ([s, e, b]) => { const m = buf(b); let a = pos(m, s), z = pos(m, e); if (a > z) [a, z] = [z, a]; return m.rope.slice(a, z); });
  D('char-after', '&optional POS BUFFER', 'Character at POS (default point), or #f at the end.', ([p, b]) => { const m = buf(b), k = given(p) ? pos(m, p) : m.pt; return k < m.rope.length ? S.mkchar(m.rope.codePointAt(k)) : false; });
  D('line-number-at-pos', '&optional POS BUFFER', 'Line number of POS (default point).', ([p, b]) => { const m = buf(b); return m.rope.lineOf(given(p) ? pos(m, p) : m.pt); });
  D('line-beginning-position', '&optional N BUFFER', 'Start of the line N-1 lines from the one holding point.', ([n, b]) => {
    const m = buf(b), t = m.rope, k = (given(n) ? int(n) : 1) - 1;
    let p = bol(t, m.pt);
    if (k > 0) for (let i = 0; i < k; i++) { const e = t.indexOf('\n', p); if (e < 0) { p = bol(t, t.length); break; } p = e + 1; }
    else for (let i = 0; i < -k && p > 0; i++) p = bol(t, p - 1);
    return p + 1;
  });
  D('buffer-line-count', '&optional BUFFER', 'Number of lines.', ([b]) => lineCount(buf(b).rope));
  D('buffer-lines', '&optional BUFFER FROM TO', 'The lines FROM..TO (1-based, inclusive; default all) as a list of strings.', ([b, f, t]) => {
    const m = buf(b), r = m.rope, n = lineCount(r), a = given(f) ? Math.max(1, int(f)) : 1, z = given(t) ? Math.min(n, int(t)) : n, out = [];
    for (let i = a; i <= z; i++) { const s = r.lineStart(i); out.push(r.slice(s, eol(r, s))); }
    return listOf(out);
  });
  D('buffer-search-forward', 'STRING START &optional BUFFER', 'Position after the first STRING at or after START, or #f.', ([s, st, b]) => {
    const m = buf(b); if (typeof s !== 'string') signal('wrong-type-argument', 'expected a string, got', s);
    const k = m.rope.indexOf(s, pos(m, st)); return k < 0 ? false : k + s.length + 1;
  });
  D('buffer-re-search-forward', 'REGEXP START &optional BUFFER BOUND', 'The first match of REGEXP at or after START as (START . END), or #f.', ([re, st, b, bound]) => {
    const m = buf(b), t = m.rope.toString(), r = gre(re);
    r.lastIndex = pos(m, st);
    const x = r.exec(t); if (!x) return false;
    const end = x.index + x[0].length;
    if (given(bound) && end > int(bound) - 1) return false;
    return new S.Pair(x.index + 1, end + 1);
  });
  D('buffer-matches', 'REGEXP &optional BUFFER', 'Every match of REGEXP as a list of (START . TEXT).', ([re, b]) => {
    const m = buf(b), t = m.rope.toString(), r = gre(re), out = []; let x;
    while ((x = r.exec(t))) { out.push(new S.Pair(x.index + 1, x[0])); if (x[0] === '') r.lastIndex++; }
    return listOf(out);
  });
  D('%with-current-buffer', 'BUFFER THUNK', 'Call THUNK with BUFFER current.', ([b, f]) => { const saved = W.cur; W.cur = live(b); try { return L.apply(f, []); } finally { W.cur = saved; } });
  L.evalText('(define-syntax with-current-buffer (syntax-rules () ((_ buffer body ...) (%with-current-buffer buffer (lambda () body ...)))))');
  D('in-thread?', '', '#t in a thread, #f on the main thread.', () => true);
  D('%thread-restore!', 'NAME', 'Give the global NAME back the value this thread booted with (a shipped redefinition is undone).', ([n]) => { const v = W.base && W.base.get(n.name); if (v !== undefined) S.gdef(n.name, v); return S.UNSPEC; });
  D('thread-id', '', 'Index of this thread.', () => W.k);
  D('thread-report', 'X', 'Send X to the future-progress handlers of this job.', ([x]) => { W.report(x); return S.UNSPEC; });
  D('thread-elapsed', '', 'Milliseconds since this job started.', () => performance.now() - W.t0);
  D('message', 'FORMAT . ARGS', 'Show a message in the echo area of the editor and log it in *Messages*.', ([f, ...a]) => {
    if (f === false) { self.postMessage({ t: 'msg', s: '' }); return false; }
    const s = S.fmt(S.str(f, 'message'), a); self.postMessage({ t: 'msg', s }); return s;
  });
  self.EdPrims = { install(w) { W = w; }, setId(k) { S.gdef('%thread-id', k); } };
}

/* ---------- worker side: the message loop ---------- */
function workerMain(self, limits) {
  const S = self.Scheme || null, L = self.L || null, codec = self.EdCodec || null;
  const W = { mirrors: new Map(), state: new Map(), k: -1, cur: null, req: 0, t0: 0, chars: 0, touch: () => {}, report: () => {} };
  const mirrors = W.mirrors;
  let useN = 0;
  const mkMirror = (id, name, ver, pt, rope) => ({ id, name, ver, pt, rope, lastUse: 0, __type: 'buffer', __print() { return '#<buffer ' + this.name + '>'; } });
  if (S) {
    S.watchdog.limitMs = limits.SCHEME_TIMEOUT;
    S.hooks.output = s => self.postMessage({ t: 'out', s });
    codec.hooks.buffer = h => mirrors.get(h.id) || Object.assign(mkMirror(h.id, h.name, h.ver, h.pt, null), { dead: true });
    self.EdPrims.install(W);
  }
  function setMirror(id, name, ver, pt, rope) { const old = mirrors.get(id); if (old) { W.chars -= old.rope.length; old.rope = null; old.dead = true; } mirrors.set(id, mkMirror(id, name, ver, pt, rope)); W.chars += rope.length; }
  function dropMirror(id) { const old = mirrors.get(id); if (old) { W.chars -= old.rope.length; old.rope = null; old.dead = true; mirrors.delete(id); } }
  /* After a job: drop the least recently used mirrors the job did not read until the budget holds. */
  function evict(used) {
    const out = [];
    while (W.chars > limits.MIRROR_BUDGET) {
      let lru = null;
      for (const m of mirrors.values()) if (!used.has(m.id) && (!lru || m.lastUse < lru.lastUse)) lru = m;
      if (!lru) break;
      out.push(lru.id); dropMirror(lru.id);
    }
    return out;
  }
  const errMsg = e => S ? S.errorMessage(e) : (e && e.message) || String(e);
  function encodeSafe(x) { try { return codec.encode(x); } catch (e) { return S.write(x); } }
  function encodeError(e) {
    if (S && e instanceof S.SchemeError) return { kind: e.kind === 'error' && /^Interrupted:/.test(e.message) ? 'thread-timeout' : e.kind, message: e.message, irritants: e.irritants.map(encodeSafe) };
    if (S && e instanceof S.Raise) return { kind: 'raise', message: S.errorMessage(e), obj: encodeSafe(e.obj) };
    if (e instanceof RangeError) return { kind: 'error', message: 'Stack overflow' };
    if (S && e instanceof S.Escape) return { kind: 'error', message: 'Escape procedure called outside its extent' };
    return { kind: 'job-error', message: e && e.message !== undefined ? e.message : String(e), stack: e && e.stack };
  }
  /* Typed arrays and ArrayBuffers up to two levels deep in VAL are transferred, not copied. */
  function collectTransfer(val, extra) {
    const set = new Set(extra);
    const add = (x, depth) => {
      if (!x || typeof x !== 'object') return;
      if (ArrayBuffer.isView(x)) { if (x.buffer instanceof ArrayBuffer) set.add(x.buffer); return; }
      if (x instanceof ArrayBuffer) { set.add(x); return; }
      if (depth >= 2) return;
      if (Array.isArray(x)) for (const y of x) add(y, depth + 1);
      else if (Object.getPrototypeOf(x) === Object.prototype) for (const k in x) add(x[k], depth + 1);
    };
    add(val, 0);
    return [...set];
  }
  const evalEncoded = f => S.evalForm(codec.decode(f));
  function makeCtx(m, versions, used, extra) {
    const get = id => { const r = mirrors.get(id); if (!r) throw new Error('buffer ' + id + ' is not mirrored on this worker'); versions[id] = r.ver; r.lastUse = ++useN; used.add(id); return r; };
    return { buffer: id => get(id).rope.toString(), rope: id => get(id).rope, version: id => get(id).ver, args: m.args, state: W.state, worker: W.k,
      progress: x => self.postMessage({ t: 'progress', req: m.req, x }), scheme: S ? { S, L } : null, transfer: ab => extra.push(ab) };
  }
  function runJob(m) {
    W.req = m.req; W.t0 = performance.now();
    const versions = {}, used = new Set(), extra = [];
    W.touch = r => { versions[r.id] = r.ver; r.lastUse = ++useN; used.add(r.id); };
    W.report = x => self.postMessage({ t: 'progress', req: m.req, x: codec.encode(x) });
    const ctx = makeCtx(m, versions, used, extra);
    if (L) L.resetOps();
    if (S) S.watchdog.limitMs = m.timeout || limits.SCHEME_TIMEOUT;
    try {
      let val;
      if (m.t === 'run' || m.t === 'map') {
        const job = self.JOBS[m.name];
        if (!job) throw new Error('no such job: ' + m.name);
        val = m.t === 'run' ? job(m.args, ctx) : m.items.map(it => job(it, ctx));
      } else {
        if (!S) throw new Error('this worker does not run Scheme');
        W.cur = m.cur !== null && m.cur !== undefined ? mirrors.get(m.cur) || null : null;
        for (const f of m.prelude) evalEncoded(f);
        val = codec.encode(S.evalForm(codec.decode(m.form)));
      }
      const transfer = collectTransfer(val, extra);
      self.postMessage({ t: 'done', req: m.req, val, versions, ms: performance.now() - W.t0, evicted: evict(used) }, transfer);
    } catch (e) {
      self.postMessage({ t: 'fail', req: m.req, error: encodeError(e), versions });
    } finally { W.req = 0; W.cur = null; W.touch = () => {}; W.report = () => {}; }
  }
  self.onmessage = ev => {
    const m = ev.data;
    switch (m.t) {
      case 'init':
        W.k = m.k;
        if (S) { self.EdPrims.setId(m.k); for (const f of m.broadcast) { try { evalEncoded(f); } catch (e) { self.postMessage({ t: 'out', s: 'broadcast failed: ' + errMsg(e) + '\n' }); } } }
        W.base = new Map();
        if (S) for (const [n, b] of S.globals) { const v = b.value; if (v !== undefined) W.base.set(n, v); }
        self.postMessage({ t: 'ready', k: m.k, scheme: !!S, names: [...W.base.keys()], macros: S ? [...S.macros.keys()] : [] });
        break;
      case 'reset': setMirror(m.id, m.name, m.ver, m.pt, new self.Rope(m.text)); break;
      case 'edits': { const r = mirrors.get(m.id); if (!r) break; W.chars -= r.rope.length; for (const o of m.ops) r.rope.splice(o[0], o[1], o[2]); W.chars += r.rope.length; r.ver = m.ver; r.pt = m.pt; if (m.name !== undefined) r.name = m.name; break; }
      case 'drop': dropMirror(m.id); break;
      case 'define': try { self.importScripts(m.url); self.postMessage({ t: 'defined', name: m.name, url: m.url }); } catch (e) { self.postMessage({ t: 'define-failed', name: m.name, url: m.url, error: String(e) }); } break;
      case 'broadcast': { let ok = true; try { evalEncoded(m.form); } catch (e) { ok = false; self.postMessage({ t: 'out', s: 'broadcast failed: ' + errMsg(e) + '\n' }); } if (m.req) self.postMessage({ t: 'bdone', req: m.req, ok }); break; }
      case 'run': case 'map': case 'eval': runJob(m); break;
    }
  };
}

/* ---------- main side: the codec and the blob ---------- */
const mainG = { Scheme: S };
codecModule(mainG);
const codec = mainG.EdCodec;
const bufferById = id => E.buffers.find(b => b.id === id) || (E.minibuf.id === id ? E.minibuf : null);
codec.hooks.buffer = h => bufferById(h.id) || false;

const canWorkers = typeof Worker === 'function' && typeof Blob === 'function' && !!globalThis.ropeSource && !!Ed.LEX_SOURCE;
const hasScheme = !!(globalThis.schemeSource && globalThis.runtimeSource);
const registry = new Map();         // job name -> { name, fn, src, depsSrc, localOnly }
const urls = { true: null, false: null };
const jobSource = j => 'JOBS[' + JSON.stringify(j.name) + '] = (function () { ' + j.depsSrc + '\nreturn (' + j.src + '); })();';
function buildUrl(withScheme) {
  const key = withScheme ? 'true' : 'false';
  if (urls[key]) return urls[key];
  const parts = [
    'self.window = self;',
    globalThis.ropeSource,
    withScheme ? globalThis.schemeSource : '',
    withScheme ? globalThis.runtimeSource : '',
    Ed.LEX_SOURCE,
    '(' + codecModule.toString() + ')(self);',
    'self.JOBS = Object.create(null);',
    ...[...registry.values()].map(jobSource),
    withScheme ? '(' + workerPrims.toString() + ')(self);' : '',
    '(' + workerMain.toString() + ')(self, ' + JSON.stringify({ SCHEME_TIMEOUT, MIRROR_BUDGET }) + ');',
  ];
  return urls[key] = URL.createObjectURL(new Blob([parts.join('\n')], { type: 'text/javascript' }));
}
function invalidateUrls() { for (const k of ['true', 'false']) if (urls[k]) { try { URL.revokeObjectURL(urls[k]); } catch (e) { /* gone */ } urls[k] = null; } }

/* ---------- slots ---------- */
const slots = [];
let size = SIZE, spawning = 0, gaveUp = false;
let schemeState = 'unknown';        // 'yes' or 'no' once a worker booted
let baseNames = null, baseMacros = null;   // the globals and macros of a booted Scheme worker (what a ship can leave out)
let readyResolve = null;
const readyPromise = new Promise(r => { readyResolve = r; });
let useTick = 0, reqN = 0;
const pending = new Map();          // req -> running job
const ui = [], batch = [];          // queues
const broadcastLog = [];            // { form, enc }: replayed in every init
const broadcastNames = new Map();   // global name -> the main-thread value a broadcast defined
const bWaiters = new Map();         // broadcast req -> { left, resolve }
const lastSlotFor = new Map();      // affinity key -> k
const threadLocal = new Set();      // names never copied by shipping (define-thread-local)
const mkErr = (kind, msg) => new SchemeError(kind, msg || kind, []);
const jobsOf = b => b._jobs || (b._jobs = new Map());
const idle = f => Ed.host.idle(f);

function mkSlot(k) {
  return { k, w: null, url: null, ready: false, scheme: false, busy: null, gen: 0, mirrors: new Map(), meta: new Map(), have: new Map(), names: null, macros: null,
    lastUse: 0, crashes: [], dead: false, retired: false, bootFails: 0, withScheme: hasScheme && schemeState !== 'no' };
}
const aliveCount = () => slots.reduce((n, s) => n + (s && s.ready ? 1 : 0), 0);
const isOk = () => canWorkers && !gaveUp;
function spawn(k) {
  let s = slots[k];
  if (!s) s = slots[k] = mkSlot(k);
  if (s.w || s.dead || gaveUp) return s;
  s.retired = false;
  let w;
  try { s.url = buildUrl(s.withScheme); w = new Worker(s.url); }
  catch (e) { s.dead = true; checkDead(); return s; }
  spawning++;
  s.w = w; s.ready = false; s.scheme = false; s.mirrors = new Map(); s.have = new Map(); s.busy = null;
  w.onmessage = ev => { if (s.w === w) onMessage(s, ev.data); };
  w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); if (s.w === w) onError(s, ev); };
  try { w.postMessage({ t: 'init', k, size, broadcast: broadcastLog.map(x => x.enc) }); } catch (e) { /* reported by onerror */ }
  return s;
}
function ensure(k) { if (!gaveUp && canWorkers && (!slots[k] || !slots[k].w) && !(slots[k] && slots[k].dead)) spawn(k); }
/* Boot failures go down a ladder: twice with Scheme, twice with the JS-only blob, then the slot is dead. */
function onError(s, ev) {
  const msg = ev && ev.message ? ev.message : 'worker error';
  if (!s.ready) {
    s.bootFails++;
    const w = s.w; s.w = null;
    try { w.terminate(); } catch (e) { /* gone */ }
    spawning = Math.max(0, spawning - 1);
    if (s.bootFails >= 2 && s.withScheme) { s.withScheme = false; s.bootFails = 0; if (schemeState === 'unknown') { schemeState = 'no'; schemeUnavailable(); } }
    else if (s.bootFails >= 2) { s.dead = true; checkDead(); schedule(); return; }
    setTimeout(() => spawn(s.k), 0);
    return;
  }
  terminateSlot(s, 'thread-died', 'the thread crashed: ' + msg, true);
}
/* Stop the worker of S (a crash, a cancel or a timeout), fail its job, and spawn it again. */
function terminateSlot(s, kind, msg, isCrash) {
  const w = s.w; s.w = null;
  if (w) try { w.terminate(); } catch (e) { /* gone */ }
  if (!s.ready) spawning = Math.max(0, spawning - 1);
  s.ready = false; s.scheme = false; s.gen++; s.mirrors = new Map(); s.have = new Map();
  const job = s.busy; s.busy = null;
  if (job) { pending.delete(job.req); rejectJob(job, mkErr(kind, msg)); }
  for (const [req, bw] of bWaiters) if (--bw.left <= 0) { bWaiters.delete(req); bw.resolve(); }
  if (isCrash) {
    const now = performance.now();
    s.crashes = s.crashes.filter(t => now - t < CRASH_WINDOW); s.crashes.push(now);
    if (s.crashes.length >= CRASH_LIMIT) { s.dead = true; checkDead(); schedule(); return; }
  }
  if (!s.retired && !gaveUp) spawn(s.k);
  schedule();
}
function retire(s) {
  if (s.busy) { s.retired = true; return; }
  const w = s.w; s.w = null; s.retired = true;
  if (w) { if (!s.ready) spawning = Math.max(0, spawning - 1); try { w.terminate(); } catch (e) { /* gone */ } }
  s.ready = false; s.scheme = false; s.gen++; s.mirrors = new Map(); s.have = new Map();
}
function checkDead() {
  for (let k = 0; k < size; k++) if (!slots[k] || !slots[k].dead) return;
  giveUp();
}
function giveUp() {
  gaveUp = true;
  localizeSchemeJobs();
  for (const q of [ui, batch]) for (const job of q.splice(0)) rejectJob(job, mkErr('thread-died', 'no thread is alive'));
  for (const b of E.buffers) if (b._jobs) b._jobs.clear();
  readyResolve(false);
}
/* The workers cannot run Scheme (or none is left): queued Scheme futures run on the main thread. */
function schemeUnavailable() { localizeSchemeJobs(); }
function localizeSchemeJobs() {
  for (const q of [ui, batch]) for (const job of q.slice()) {
    if (job.kind !== 'eval') continue;
    const f = job.parent || job.future;
    if (!f || !f.localFn) continue;
    if (job.parent) { if (f.localized) { removeFromQueue(job); rejectJob(job, mkErr('thread-cancelled', 'cancelled')); continue; } f.localized = true; for (const j of f.parts) if (j.status === 'queued') { removeFromQueue(j); j.status = 'done'; } }
    else removeFromQueue(job);
    job.future = null;
    localFuture(f, f.localFn);
  }
}
function onMessage(s, m) {
  switch (m.t) {
    case 'ready': {
      s.ready = true; spawning = Math.max(0, spawning - 1); s.scheme = m.scheme; s.names = new Set(m.names); s.macros = new Set(m.macros);
      for (const [n, v] of broadcastNames) s.have.set('g:' + n, v);
      if (!baseNames && m.scheme) { baseNames = s.names; baseMacros = s.macros; }
      if (schemeState === 'unknown') { schemeState = m.scheme ? 'yes' : 'no'; if (!m.scheme) schemeUnavailable(); }
      readyResolve(true);
      if (s.retired || s.k >= size) { retire(s); break; }
      schedule(); warm(); break;
    }
    case 'done': { const job = pending.get(m.req); if (!job || job.slot !== s) break; for (const id of m.evicted || []) s.mirrors.delete(id); settleDone(s, job, m); break; }
    case 'fail': { const job = pending.get(m.req); if (!job || job.slot !== s) break; settleFail(s, job, m); break; }
    case 'progress': { const job = pending.get(m.req); if (job) progress(job, m.x); break; }
    case 'out': appendMessages(s.k, m.s); break;
    case 'msg': deliver(() => Ed.message(m.s), true); break;
    case 'bdone': { const bw = bWaiters.get(m.req); if (bw && --bw.left <= 0) { bWaiters.delete(m.req); bw.resolve(); } break; }
    case 'defined': lateUrlDone(m.url); break;
    /* The thread could not load a job defined after it booted: it is replaced by one whose blob has the job. */
    case 'define-failed': lateUrlDone(m.url); retire(s); schedule(); warm(); break;
  }
}
/* Output of display/write in a thread: appended to *Messages*, each line prefixed with the thread. */
function appendMessages(k, s) {
  const mb = Ed.getBufferCreate('*Messages*');
  const was = E.inhibitRO; E.inhibitRO = true;
  try {
    const n = mb.rope.length, atEnd = mb.pt === n, save = mb.pt;
    const prefix = n === 0 || mb.rope.charCodeAt(n - 1) === 10 ? '[thread ' + k + '] ' : '';
    mb.pt = n; Ed.insertText(mb, prefix + s); mb.pt = atEnd ? mb.rope.length : save; mb.modified = false;
  } finally { E.inhibitRO = was; }
  if (Ed.windowFor(mb) && !E.mini) Ed.render();
}

/* ---------- jobs: queue, choice of worker, dispatch, settling ---------- */
function newJob(kind, opts) {
  opts = opts || {};
  const job = { req: ++reqN, kind, priority: opts.priority === 'ui' || opts.priority === UI ? UI : BATCH, worker: opts.worker, affinity: opts.affinity,
    timeout: opts.timeout, tag: opts.tag, transfer: opts.transfer, onProgress: opts.onProgress, buffers: new Set(), status: 'queued', slot: null, gen: 0,
    timer: 0, versions: null, future: null, parent: null, cbs: null, added: null, name: null, args: undefined, items: null, form: null, defs: null, cur: null, convert: null, localFn: null };
  job.promise = new Promise((res, rej) => { job.res = res; job.rej = rej; });
  job.promise.req = job.req;
  job.promise.cancel = o => cancelJob(job, o && o.hard !== undefined ? !!o.hard : kind !== 'map');
  return job;
}
function enqueue(job) { (job.priority === UI ? ui : batch).push(job); schedule(); }
function removeFromQueue(job) { for (const q of [ui, batch]) { const i = q.indexOf(job); if (i >= 0) { q.splice(i, 1); return true; } } return false; }
function finishJob(job) {
  if (job.timer) { clearTimeout(job.timer); job.timer = 0; }
  pending.delete(job.req);
  if (job.slot && job.slot.busy === job) job.slot.busy = null;
  for (const b of job.buffers) if (b._jobs) b._jobs.delete(job.req);
}
function resolveJob(job, val, versions) {
  if (job.status === 'done' || job.status === 'failed') return;
  finishJob(job); job.status = 'done';
  job.versions = versions || new Map(); job.promise.versions = job.versions;
  job.res(val);
  if (job.cbs && job.cbs.onDone) job.cbs.onDone(val, job.versions);
  if (job.future) settleFuture(job.future, 'done', val, null, job.versions);
}
function rejectJob(job, err, versions) {
  if (job.status === 'done' || job.status === 'failed') return;
  finishJob(job); job.status = 'failed';
  job.versions = versions || new Map(); job.promise.versions = job.versions;
  job.rej(err);
  if (job.cbs && job.cbs.onFail) job.cbs.onFail(err);
  if (job.future) settleFuture(job.future, err.kind === 'thread-cancelled' ? 'cancelled' : 'failed', undefined, err, job.versions);
}
function cancelJob(job, hard) {
  if (job.status === 'queued') { removeFromQueue(job); rejectJob(job, mkErr('thread-cancelled', 'cancelled')); return true; }
  if (job.status === 'running') { if (hard && job.slot) terminateSlot(job.slot, 'thread-cancelled', 'cancelled', false); return true; }
  return false;
}
function cancelAll(tag) { for (const q of [ui, batch]) for (const job of q.slice()) if (job.tag === tag) cancelJob(job, false); }
/* Run a job on the main thread when idle (no worker, or a job that could not be compiled there). */
function runLocally(job, fn) {
  job.status = 'running';
  idle(() => { try { resolveJob(job, fn(), new Map()); } catch (e) { rejectJob(job, e instanceof Error ? e : mkErr('job-error', String(e))); } });
}
let scheduled = false;
function schedule() { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; runSchedule(); }); }
function sweepKilled() {
  const live = new Set(E.buffers.map(b => b.id)); live.add(E.minibuf.id);
  for (const s of slots) { if (!s || !s.w) continue; for (const id of [...s.mirrors.keys()]) if (!live.has(id)) { s.mirrors.delete(id); try { s.w.postMessage({ t: 'drop', id }); } catch (e) { /* dying */ } } }
  return live;
}
function runSchedule() {
  if (!canWorkers || gaveUp) { for (const q of [ui, batch]) for (const job of q.splice(0)) rejectJob(job, mkErr(gaveUp ? 'thread-died' : 'no-worker', gaveUp ? 'no thread is alive' : 'no worker')); return; }
  if (!ui.length && !batch.length) return;
  const live = sweepKilled();
  for (const q of [ui, batch]) {
    for (let i = 0; i < q.length; ) {
      const job = q[i];
      let killed = null;
      for (const b of job.buffers) if (!live.has(b.id)) { killed = b; break; }
      if (killed) { q.splice(i, 1); rejectJob(job, mkErr('buffer-killed', 'Buffer ' + killed.name + ' was killed')); continue; }
      const s = pick(job);
      if (s) { q.splice(i, 1); dispatch(s, job); continue; }
      if (job.worker !== undefined) {
        const t = slots[job.worker];
        if (job.worker >= size || (t && t.dead)) { q.splice(i, 1); rejectJob(job, mkErr('thread-died', 'thread ' + job.worker + ' is not available')); continue; }
        if (!t || !t.w) spawn(job.worker);
      } else if (aliveCount() + spawning < size) spawnNext();
      i++;
    }
  }
}
function spawnNext() { for (let k = 0; k < size; k++) { const s = slots[k]; if (!s || (!s.w && !s.dead)) { spawn(k); return; } } }
/* Boot the threads one at a time while the page is idle: a parallel job then starts at once
   instead of waiting a boot (about 30 ms) on its critical path. */
let warming = false;
function warm() {
  if (warming || gaveUp || !canWorkers || aliveCount() + spawning >= size) return;
  warming = true;
  idle(() => { warming = false; if (!gaveUp && canWorkers && aliveCount() + spawning < size) spawnNext(); });
}
/* The cost of bringing B up to date on S: 0 (current), the delta bytes (patchable) or the text (a reset). */
function syncCost(s, b) {
  const have = s.mirrors.get(b.id);
  if (have === b.ver) return 0;
  const log = b.log;
  if (have === undefined || !log.length || log[0].v > have + 1 || b.ver - have > DELTA_CAP) return b.rope.length;
  let k = log.length - 1, bytes = 0;
  while (k >= 0 && log[k].v > have) { bytes += log[k].ins.length + 16; k--; }
  return bytes > b.rope.length / 2 ? b.rope.length : bytes;
}
function pick(job) {
  let best = null, bestCost = 0, bestAff = 0;
  for (const s of slots) {
    if (!s || !s.ready || s.busy || s.dead || s.retired || s.k >= size) continue;
    if (job.worker !== undefined && s.k !== job.worker) continue;
    if (job.kind === 'eval' && !s.scheme) continue;
    let cost = 0;
    for (const b of job.buffers) cost += syncCost(s, b);
    const aff = job.affinity !== undefined && lastSlotFor.get(job.affinity) === s.k ? 0 : 1;
    if (!best || cost < bestCost || (cost === bestCost && (aff < bestAff || (aff === bestAff && s.lastUse < best.lastUse)))) { best = s; bestCost = cost; bestAff = aff; }
  }
  return best;
}
/* Bring the mirror of B on S to b.ver: the edits since the mirror's version, or a fresh copy when
   the log no longer reaches back or the deltas outweigh half the text. Posted right before the job
   in the same synchronous call, so per-worker FIFO ordering makes the job see exactly b.ver. */
function syncTo(s, b) {
  const have = s.mirrors.get(b.id);
  if (have === b.ver) {
    /* Same text: only point or the name may have moved since the last sync. */
    const seen = s.meta.get(b.id);
    if (seen && seen.pt === b.pt && seen.name === b.name) return;
    s.w.postMessage({ t: 'edits', id: b.id, name: b.name, ver: b.ver, pt: b.pt, ops: [] });
    s.meta.set(b.id, { pt: b.pt, name: b.name });
    return;
  }
  const log = b.log;
  let ops = null;
  if (!(have === undefined || !log.length || log[0].v > have + 1 || b.ver - have > DELTA_CAP)) {
    let k = log.length - 1, bytes = 0;
    while (k >= 0 && log[k].v > have) { bytes += log[k].ins.length + 16; k--; }
    if (bytes <= b.rope.length / 2) { ops = []; for (let i = k + 1; i < log.length; i++) ops.push([log[i].pos, log[i].del.length, log[i].ins]); }
  }
  if (ops) s.w.postMessage({ t: 'edits', id: b.id, name: b.name, ver: b.ver, pt: b.pt, ops });
  else s.w.postMessage({ t: 'reset', id: b.id, name: b.name, ver: b.ver, pt: b.pt, text: b.text });
  s.mirrors.set(b.id, b.ver); s.meta.set(b.id, { pt: b.pt, name: b.name });
}
function buildMessage(job, s) {
  if (job.kind === 'run') return { t: 'run', req: job.req, name: job.name, args: job.args, timeout: job.timeout || 0 };
  if (job.kind === 'map') return { t: 'map', req: job.req, name: job.name, items: job.items, args: job.args, timeout: job.timeout || 0 };
  if (!job.form) job.convert(s.names);
  const prelude = []; job.added = [];
  /* A definition that copies data (a global's value, a captured variable) goes with every job: the
     value may have been changed in place since, or set! by an earlier job on this thread. Procedures,
     macros and record types are rebound, not changed in place, so a thread keeps them by identity. */
  for (const [key, d] of job.defs) {
    if (d.data) prelude.push(d.enc);
    else if (s.have.get(key) !== d.value) { prelude.push(d.enc); s.have.set(key, d.value); job.added.push(key); }
  }
  return { t: 'eval', req: job.req, prelude, form: job.form, cur: job.cur, timeout: job.timeout || 0 };
}
function dispatch(s, job) {
  let msg;
  try { msg = buildMessage(job, s); }
  catch (e) { rejectJob(job, e instanceof Error ? e : mkErr('ship-error', String(e))); return; }
  for (const b of job.buffers) { syncTo(s, b); jobsOf(b).set(job.req, b.ver); }
  s.busy = job; s.lastUse = ++useTick; job.slot = s; job.gen = s.gen; job.status = 'running';
  if (job.affinity !== undefined) lastSlotFor.set(job.affinity, s.k);
  pending.set(job.req, job);
  if (job.future) job.future.status = 'running';
  try { s.w.postMessage(msg, job.transfer || []); }
  catch (e) { rejectJob(job, mkErr('job-error', 'cannot send the job to a thread: ' + e.message)); return; }
  const ms = job.timeout ? (job.kind === 'eval' ? job.timeout + 1000 : job.timeout) : 0;
  if (ms) job.timer = setTimeout(() => { if (pending.get(job.req) === job) terminateSlot(s, 'thread-timeout', 'the job ran for more than ' + Math.round(ms / 1000) + ' s', false); }, ms);
}
const toVersions = o => new Map(Object.keys(o || {}).map(k => [+k, o[k]]));
function settleDone(s, job, m) {
  const versions = toVersions(m.versions);
  let val = m.val;
  if (job.kind === 'eval') { try { val = codec.decode(val); } catch (e) { rejectJob(job, e, versions); schedule(); return; } }
  resolveJob(job, val, versions);
  if (s.retired || s.k >= size) retire(s);
  schedule();
}
function settleFail(s, job, m) {
  if ((job.kind === 'run' || job.kind === 'map') && registry.has(job.name) && m.error && m.error.kind === 'job-error' && m.error.message === 'no such job: ' + job.name) {
    /* The thread lacks a job defined after it booted (define-failed): run it on a fresh thread. */
    if (job.timer) { clearTimeout(job.timer); job.timer = 0; }
    pending.delete(job.req); s.busy = null; job.slot = null; job.status = 'queued';
    retire(s); enqueue(job); warm();
    return;
  }
  if (job.kind === 'eval' && job.added) for (const k of job.added) s.have.delete(k);
  rejectJob(job, decodeError(m.error), toVersions(m.versions));
  if (s.retired || s.k >= size) retire(s);
  schedule();
}
function boundOnMain(name) { try { const b = S.globals.get(name); return (!!b && b.value !== undefined) || S.macros.has(name); } catch (e) { return false; } }
function safeDecode(x) { try { return codec.decode(x); } catch (e) { return typeof x === 'string' ? x : L.write(x); } }
/* An error that crossed from a thread, as a SchemeError: error-kind, error-message and guard work on it. */
function decodeError(e) {
  if (!e || typeof e !== 'object') return mkErr('job-error', String(e));
  let msg = e.message || '';
  const kind = e.kind || 'job-error';
  if (kind === 'unbound-variable') { const m = /^Unbound variable: (.+)$/.exec(msg); if (m && boundOnMain(m[1])) msg = m[1] + ' is not available in a thread'; }
  const irr = [];
  if (e.obj !== undefined) irr.push(safeDecode(e.obj));
  for (const i of e.irritants || []) irr.push(safeDecode(i));
  const err = new SchemeError(kind, msg, irr);
  if (e.stack) err.stack = e.stack;
  return err;
}
function progress(job, x) {
  if (job.onProgress) { try { job.onProgress(x); } catch (e) { console.error(e); } }
  const f = job.future;
  if (f && f.progressH.length) { const v = safeDecode(x); deliverFor(f, () => { for (const h of f.progressH) { L.resetOps(); L.apply(h, [v]); } }); }
}

/* ---------- JS API ---------- */
function define(name, fn, deps) {
  if (typeof fn !== 'function') throw new Error('EdPool.define(' + name + '): expected a function');
  const src = fn.toString();
  if (/\[native code\]/.test(src) || /^async\b/.test(src) || /^function\s*\*/.test(src) || (/^\s*[\w$]+\s*\(/.test(src) && !/^function\b/.test(src))) throw new Error('EdPool.define(' + name + '): the job must be a plain function or arrow');
  const depsSrc = (deps || []).map(d => {
    const s = d.toString();
    if (/^(function|class)\b/.test(s)) return s;
    if (!d.name) throw new Error('EdPool.define(' + name + '): a dep must be a named function');
    return 'const ' + d.name + ' = ' + s + ';';
  }).join('\n');
  const bad = /\b(window|document|localStorage|Ed|E)\./.exec(src + '\n' + depsSrc);
  if (bad) throw new Error('EdPool.define(' + name + '): job code must not use page state (' + bad[0].slice(0, -1) + ')');
  const def = { name, fn, src, depsSrc, localOnly: false };
  registry.set(name, def);
  invalidateUrls();
  /* Threads already running load the job from its own blob: URL; importScripts needs no eval. */
  const live = slots.filter(s => s && s.w);
  if (!live.length) return;
  let url = null;
  try { url = URL.createObjectURL(new Blob([jobSource(def)], { type: 'text/javascript' })); lateUrls.set(url, live.length); } catch (e) { /* the threads report define-failed */ }
  for (const s of live) { try { s.w.postMessage({ t: 'define', name, url }); } catch (e) { /* dying */ } }
}
const lateUrls = new Map();         // blob: URL of a late job -> threads yet to load it
function lateUrlDone(url) {
  const n = lateUrls.get(url);
  if (n === undefined) return;
  if (n > 1) { lateUrls.set(url, n - 1); return; }
  lateUrls.delete(url);
  try { URL.revokeObjectURL(url); } catch (e) { /* gone */ }
}
/* Buffers one level deep in ARGS become handles; BUFS collects them. */
function encodeArgs(args, bufs) {
  const handle = b => { bufs.add(b); return { $: 'b', id: b.id, name: b.name, pt: b.pt, ver: b.ver }; };
  if (args instanceof Ed.Buffer) return handle(args);
  if (Array.isArray(args)) return args.map(a => a instanceof Ed.Buffer ? handle(a) : a);
  if (args && typeof args === 'object' && Object.getPrototypeOf(args) === Object.prototype) { let out = null; for (const k in args) if (args[k] instanceof Ed.Buffer) { if (!out) out = { ...args }; out[k] = handle(args[k]); } return out || args; }
  return args;
}
function startRun(name, args, opts) {
  opts = opts || {};
  const job = newJob('run', opts);
  job.name = name;
  const def = registry.get(name), bufs = new Set(opts.buffers || []);
  job.args = encodeArgs(args, bufs); job.buffers = bufs;
  if (!def) rejectJob(job, mkErr('job-error', 'no such job: ' + name));
  else if (def.localOnly || !isOk()) {
    if (def.localOnly || opts.fallback === 'local') runLocally(job, () => local(name, args, [...bufs]));
    else rejectJob(job, mkErr('no-worker', 'no worker'));
  } else enqueue(job);
  return job;
}
function run(name, args, opts) { return startRun(name, args, opts).promise; }
function map(name, items, opts) {
  opts = opts || {};
  const outer = newJob('map', opts);
  const def = registry.get(name);
  if (!def) { rejectJob(outer, mkErr('job-error', 'no such job: ' + name)); return outer.promise; }
  const bufsFor = it => new Set(opts.buffersFor ? opts.buffersFor(it) : (opts.buffers || []));
  if (def.localOnly || !isOk()) {
    if (def.localOnly || opts.fallback === 'local') runLocally(outer, () => items.map(it => local(name, it, [...bufsFor(it)], opts.args)));
    else rejectJob(outer, mkErr('no-worker', 'no worker'));
    return outer.promise;
  }
  const n = Math.max(1, opts.chunk || Math.ceil(items.length / (2 * size)));
  const chunks = [];
  for (let i = 0; i < items.length; i += n) chunks.push(items.slice(i, i + n));
  const results = new Array(chunks.length), parts = [];
  let left = chunks.length;
  outer.parts = parts;
  outer.promise.cancel = o => { for (const j of parts) cancelJob(j, !!(o && o.hard)); };
  if (!chunks.length) { resolveJob(outer, []); return outer.promise; }
  chunks.forEach((its, ci) => {
    const job = newJob('map', opts);
    job.promise.catch(() => {});
    const bufs = new Set();
    for (const it of its) for (const b of bufsFor(it)) bufs.add(b);
    job.name = name; job.items = its.map(it => encodeArgs(it, bufs)); job.args = opts.args; job.buffers = bufs;
    job.cbs = {
      onDone: (v, versions) => {
        results[ci] = v;
        if (--left === 0) { const all = new Map(); for (const j of parts) for (const [id, ver] of j.versions) if (!all.has(id) || ver < all.get(id)) all.set(id, ver); resolveJob(outer, [].concat(...results), all); }
      },
      onFail: e => { if (outer.status !== 'queued') return; for (const j of parts) if (j !== job) cancelJob(j, false); rejectJob(outer, e); },
    };
    parts.push(job);
  });
  for (const j of parts) enqueue(j);
  return outer.promise;
}
const localState = new Map();
/* The job NAME on the main thread, with a ctx over the buffers in BUFS (by id). */
function local(name, args, bufs, mapArgs) {
  const def = registry.get(name);
  if (!def) throw mkErr('job-error', 'no such job: ' + name);
  const byId = new Map((bufs || []).map(b => [b.id, b]));
  const get = id => { const b = byId.get(id); if (!b) throw new Error('buffer ' + id + ' is not mirrored on this worker'); return b; };
  const ctx = { buffer: id => get(id).text, rope: id => get(id).rope, version: id => get(id).ver, args: mapArgs, state: localState, worker: 0, progress: () => {}, scheme: { S, L }, transfer: () => {} };
  return def.fn(args, ctx);
}
/* Line-aligned ranges covering [FROM, TO) of B, about N of them. */
function shards(b, from, to, n) {
  const r = b.rope, out = [];
  from = Math.max(0, from); to = Math.min(r.length, to);
  if (to <= from) return out;
  const l1 = r.lineOf(from), l2 = r.lineOf(Math.max(from, to - 1)), per = Math.max(1, Math.ceil((l2 - l1 + 1) / Math.max(1, n)));
  const cuts = [from];
  for (let l = l1 + per; l <= l2; l += per) cuts.push(Math.max(from, Math.min(to, r.lineStart(l))));
  cuts.push(to);
  for (let i = 1; i < cuts.length; i++) if (cuts[i] > cuts[i - 1]) out.push({ id: b.id, from: cuts[i - 1], to: cuts[i] });
  return out;
}
function sync(b) { for (const s of slots) if (s && s.w && s.ready && s.mirrors.has(b.id)) syncTo(s, b); }
function release(b) { for (const s of slots) if (s && s.w && s.mirrors.has(b.id)) { s.mirrors.delete(b.id); try { s.w.postMessage({ t: 'drop', id: b.id }); } catch (e) { /* dying */ } } }
function setSize(n) {
  n = Math.max(1, Math.min(16, Math.floor(Number(n) || 1)));
  size = n;
  for (const s of slots) if (s && s.k >= n && s.w) retire(s);
  if (ui.length || batch.length) schedule();
  return size;
}
function stats() {
  return { alive: aliveCount(), size, busy: slots.filter(s => s && s.busy).map(s => s.k), mirrors: slots.filter(s => s).map(s => [s.k, [...s.mirrors]]),
    queued: ui.length + batch.length, defs: [...registry.keys()], crashes: slots.reduce((n, s) => n + (s ? s.crashes.length : 0), 0), scheme: schemeState };
}
/* Every worker dies and none comes back: the fallback paths take over (tests). */
function _fail() {
  gaveUp = true;
  for (let k = 0; k < Math.max(size, slots.length); k++) {
    const s = slots[k] || (slots[k] = mkSlot(k));
    const w = s.w; s.w = null; s.dead = true;
    if (w) try { w.terminate(); } catch (e) { /* gone */ }
    const job = s.busy; s.busy = null; s.ready = false; s.scheme = false; s.mirrors = new Map(); s.have = new Map();
    if (job) { pending.delete(job.req); rejectJob(job, mkErr('thread-died', 'the thread pool was shut down')); }
  }
  spawning = 0;
  giveUp();
}

/* ---------- shipping Scheme code: closure conversion ---------- */
const QUOTE = intern('quote'), LAMBDA = intern('lambda'), DEFINE = intern('define');
const sy = n => ({ $: 'y', n }), el = (...a) => ({ $: 'l', a }), qt = enc => el(sy('quote'), enc);
/* Every symbol of FORM outside (quote ...); an over-approximation of its free variables. */
function freeSymbols(x, out) {
  if (x instanceof Sym) { if (!S.isKeyword(x)) out.add(x); return out; }
  if (x instanceof Pair) {
    if (x.car === QUOTE) return out;
    let c = x;
    while (c instanceof Pair) { freeSymbols(c.car, out); c = c.cdr; }
    if (c !== NIL) freeSymbols(c, out);
    return out;
  }
  if (Array.isArray(x)) for (const y of x) freeSymbols(y, out);
  return out;
}
/* A converter collects, in DEFS (key -> { value, enc }, in dependency order), the definitions a
   worker that has the globals NAMES may lack: user procedures by their source with free lexical
   variables bound by value in a let, macros and record types by their source, data by a quoted
   copy. META.buffers collects the buffers met. Procedures without source (editor primitives) are
   left out: a use raises unbound-variable in the thread. */
function converter(names, meta) {
  const defs = new Map(), converting = new Set();
  let count = 0, procData = false;   /* procData: the form proc last returned copies a captured value */
  const err = msg => new SchemeError('ship-error', msg, []);
  /* The thread has NAME and the main thread has not redefined it: the thread's own one serves. */
  const has = name => names.has(name) && isBaseGlobal(name);
  const encode = v => codec.encode(v, meta);
  meta.ship = p => proc(p);
  meta.record = rt => { if (!has(rt.name)) recordType(rt); };
  function addDef(key, value, enc, data) {
    if (defs.has(key)) defs.delete(key);
    if (++count > 500) throw err('cannot send more than 500 definitions to a thread in one call');
    defs.set(key, { value, enc, data: !!data });
  }
  function global(name) {
    if (threadLocal.has(name) || defs.has('g:' + name) || defs.has('m:' + name)) return;
    if (has(name)) {
      /* A redefinition shipped earlier is undone, so the thread runs its own one again. */
      if (shippedOver.has(name)) addDef('g:' + name, RESTORED, el(sy('%thread-restore!'), qt(sy(name))));
      return;
    }
    const m = S.macros.get(name);
    if (m) { if (!(baseMacros && baseMacros.has(name) && isBaseMacro(name, m))) macro(name, m); return; }
    const box = S.globals.get(name);
    let v;
    try { v = box ? box.value : undefined; } catch (e) { return; }
    if (v === undefined) return;
    if (broadcastNames.has(name) && broadcastNames.get(name) === v) return;   /* every thread defined it (define-threaded) */
    const over = names.has(name);   /* the main thread redefined a global the thread has its own of */
    if (over) shippedOver.add(name);
    if (typeof v === 'function') {
      if (v.src) {
        defs.set('g:' + name, { value: v, enc: null });   /* reserved: a recursive procedure refers to itself */
        let enc;
        try { enc = proc(v); } catch (e) { defs.delete('g:' + name); throw e; }
        addDef('g:' + name, v, el(sy('define'), sy(name), enc), procData);
      } else if (v.recordType) recordType(v.recordType);
      else if (over) addDef('g:' + name, v, el(sy('define'), sy(name), proc(v)));   /* another primitive, or a ship-error */
      return;
    }
    if (v instanceof S.RecordType) { recordType(v); return; }
    let enc;
    try { enc = encode(v); } catch (e) { if (e instanceof SchemeError && e.kind === 'ship-error' && !over) return; throw e; }
    addDef('g:' + name, v, el(sy('define'), sy(name), qt(enc)), true);
  }
  function macro(name, m) {
    if (!m.src) throw err('macro ' + name + ' cannot be shipped: define it at top level');
    defs.set('m:' + name, { value: m, enc: null });
    for (const s of freeSymbols(m.src, new Set())) if (s.name !== name) global(s.name);
    addDef('m:' + name, m, encode(m.src));
  }
  function recordType(rt) {
    const key = 'r:' + rt.name;
    if (defs.has(key)) return;
    if (!rt.src) throw err('record type ' + rt.name + ' cannot be shipped: define it at top level');
    addDef(key, rt, encode(rt.src));
  }
  /* The source of P with its free variables bound by value in a let. The free variables are what the
     compiler resolves outside P (scanOf), so names P binds itself, quoted or quasiquoted data and
     vector literals are not captured. Identifiers a macro introduced (aliases) that P binds or
     captures get fresh names, so they cannot capture the user's variables of the same name. */
  function proc(p) {
    if (!p.src) {
      const g = p.procName ? S.globals.get(p.procName) : null, isGlobal = !!g && g.value === p;
      procData = false;
      if (isGlobal && has(p.procName)) return sy(p.procName);
      if (p.recordType && p.procName) { recordType(p.recordType); return sy(p.procName); }
      throw err('cannot send ' + L.write(p) + ' to a thread: ' + (isGlobal ? 'it is an editor primitive' : 'it has no source'));
    }
    if (converting.has(p)) throw err('cannot ship a procedure that refers to itself through its environment');
    converting.add(p);
    try {
      const sc = scanOf(p), lets = [], seen = new Set(), ren = new Map();
      const local = () => err('cannot send ' + L.write(p) + ' to a thread: it uses a local macro');
      const rename = a => { let y = ren.get(a); if (!y) { y = intern(S.baseName(a).name + '%' + a.id); ren.set(a, y); } return y; };
      for (const scope of sc.scopes) for (const id of scope.names.keys()) if (id instanceof S.Alias) rename(id);
      for (const [kw, r] of sc.macros) {
        if (r === null) global(S.baseName(kw).name);
        else if (r.macro && !sc.scopes.has(r.at)) throw local();
      }
      let data = false;
      for (const [id, r] of sc.refs) {
        if (r === null) { global(S.baseName(id).name); continue; }
        if (r.macro) throw local();
        if (sc.scopes.has(r.at) || seen.has(id)) continue;
        seen.add(id);
        let depth = 1, at = p.scope.parent;
        while (at && at !== r.at) { at = at.parent; depth++; }
        if (!at) throw local();
        let e = p.env;
        for (let d = 1; d < depth && e; d++) e = e[0];
        const v = e ? e[r.index] : undefined;
        const nm = id instanceof S.Alias ? rename(id).name : S.baseName(id).name;
        if (typeof v === 'function') { const f = proc(v); data = data || procData; lets.push(el(sy(nm), f)); }
        else { data = true; lets.push(el(sy(nm), qt(encode(v)))); }
      }
      const body = encode(shipForm(p.src, ren));
      procData = data;
      return lets.length ? el(sy('let'), { $: 'l', a: lets }, body) : body;
    } finally { converting.delete(p); }
  }
  const walk = datum => { for (const s of freeSymbols(datum, new Set())) global(s.name); };
  return { defs, encode, global, proc, walk, addDef };
}
/* What P's source uses, found by compiling it again where it was compiled (cached per source). */
const scans = new WeakMap();
function scanOf(p) {
  let sc = scans.get(p.src);
  if (!sc) { sc = S.scanClosure(p.src, p.scope ? p.scope.parent : null); scans.set(p.src, sc); }
  return sc;
}
/* X without aliases: those in REN get their fresh names, the rest their plain names. Quoted data,
   the data parts of a quasiquote and vector literals keep plain names. */
const QQ = intern('quasiquote'), UNQ = intern('unquote'), UNQS = intern('unquote-splicing');
const isKw = (x, k) => (x instanceof Sym || x instanceof S.Alias) && S.baseName(x) === k;
function shipForm(x, ren) {
  if (!ren.size) return S.strip(x);
  const walk = x => {
    if (x instanceof S.Alias) return ren.get(x) || S.strip(x);
    if (x instanceof Pair) {
      if (isKw(x.car, QUOTE)) return S.strip(x);
      if (isKw(x.car, QQ) && x.cdr instanceof Pair) return L.list(QQ, qq(x.cdr.car, 1));
      return mapList(x, walk);
    }
    if (Array.isArray(x)) return S.strip(x);
    return x;
  };
  const qq = (x, depth) => {
    if (x instanceof Pair) {
      if ((isKw(x.car, UNQ) || isKw(x.car, UNQS)) && x.cdr instanceof Pair) return L.list(S.baseName(x.car), depth === 1 ? walk(x.cdr.car) : qq(x.cdr.car, depth - 1));
      if (isKw(x.car, QQ) && x.cdr instanceof Pair) return L.list(QQ, qq(x.cdr.car, depth + 1));
      return mapList(x, y => qq(y, depth));
    }
    if (Array.isArray(x)) return x.map(y => qq(y, depth));
    return S.strip(x);
  };
  return walk(x);
}
function mapList(x, f) { const out = []; let c = x; while (c instanceof Pair) { out.push(f(c.car)); c = c.cdr; } return listOf(out, c === NIL ? NIL : f(c)); }
/* Which globals a fresh thread has its own version of that the main thread still uses: the values
   at load (after this file's own definitions) and whatever the shipped config (emacs.scm, evil.scm,
   org.scm, ai.scm) defined over them, which is the editor's version of a name (newline, with-current-buffer).
   A later redefinition (init.scm, the user) is shipped. */
const RESTORED = {};                 // s.have value of a global given back its thread version
const shippedOver = new Set();       // globals a thread has that a job shipped a redefinition of
let loadVals = null, loadMacros = null, sysRedef = null, sysRedefM = null;
const isMagic = b => { const d = Object.getOwnPropertyDescriptor(b, 'value'); return !!(d && d.get); };
function snapshotLoad() {
  loadVals = new Map(); for (const [n, b] of S.globals) if (!isMagic(b)) loadVals.set(n, b.value);
  loadMacros = new Map(S.macros);
}
function markSystem() {
  if (sysRedef) return;
  if (!loadVals) snapshotLoad();
  sysRedef = new Set(); sysRedefM = new Set();
  for (const [n, b] of S.globals) if (!isMagic(b) && b.value !== loadVals.get(n)) sysRedef.add(n);
  for (const [n, m] of S.macros) if (loadMacros.get(n) !== m) sysRedefM.add(n);
}
function isBaseGlobal(name) {
  const b = S.globals.get(name);
  if (!b || isMagic(b)) return true;
  markSystem();
  return sysRedef.has(name) || b.value === loadVals.get(name);
}
function isBaseMacro(name, m) { markSystem(); return sysRedefM.has(name) || loadMacros.get(name) === m; }
/* boot() opens the init.scm buffer right before it evaluates init.scm: the shipped config is in. */
{
  const prev = Ed.getBufferCreate;
  Ed.getBufferCreate = function (name) { if (name === 'init.scm' && !sysRedef && loadVals) markSystem(); return prev.apply(this, arguments); };
}
/* The call of WHAT (a procedure, a symbol or a datum) on ARGS as { form, defs } for a worker with NAMES. */
function convertCall(what, args, names, meta, evalOnly) {
  const cv = converter(names, meta);
  const qargs = args.map(a => qt(cv.encode(a)));
  let form;
  if (typeof what === 'function') form = el(cv.proc(what), ...qargs);
  else if (what instanceof Sym) { cv.global(what.name); form = el(sy(what.name), ...qargs); }
  else if (!evalOnly && what instanceof Pair && what.car === LAMBDA) { cv.walk(what); form = el(cv.encode(what), ...qargs); }
  else {
    if (args.length) throw new SchemeError('ship-error', 'thread-run: a datum that is not a lambda form takes no arguments', []);
    cv.walk(what); form = cv.encode(what);
  }
  return { form, defs: cv.defs };
}
/* The same call on the main thread (no worker). */
function localThunk(what, args, evalOnly) {
  if (typeof what === 'function' || what instanceof S.Param) return () => L.apply(what, args);
  if (what instanceof Sym) return () => L.apply(L.toFn(what), args);
  if (!evalOnly && what instanceof Pair && what.car === LAMBDA) return () => L.apply(S.evalForm(what), args);
  if (args.length) throw new SchemeError('ship-error', 'thread-run: a datum that is not a lambda form takes no arguments', []);
  return () => S.evalForm(what);
}

/* ---------- futures and delivery ---------- */
let futureN = 0;
class Future {
  constructor() {
    this.id = ++futureN; this.status = 'queued'; this.value = undefined; this.error = null; this.versions = new Map();
    this.handlers = []; this.progressH = []; this.waiters = []; this.js = []; this.awaited = false; this.now = false; this.delivered = false;
    this.job = null; this.parts = null; this.localFn = null; this.localQueued = false; this.localized = false; this.name = null;
  }
  __print() { return '#<future ' + this.id + (this.name ? ' ' + this.name : '') + ' ' + this.status + '>'; }
  get __type() { return 'future'; }
  get settled() { return this.status === 'done' || this.status === 'failed' || this.status === 'cancelled'; }
  /* A thenable: a command whose value is a future is awaited by the command loop. */
  then(res, rej) {
    this.awaited = true;
    if (!this.settled && this.localQueued) runLocalNow(this);
    if (this.settled) { if (this.status === 'done') res(this.value); else rej(this.error); }
    else this.js.push([res, rej]);
  }
}
const threadError = e => { const t = new SchemeError(e.kind, 'Thread error: ' + e.message, e.irritants); if (e.stack) t.stack = e.stack; return t; };
function settleFuture(f, status, value, error, versions) {
  if (f.settled) return;
  f.status = status; f.value = value; f.error = error || null; f.versions = versions || new Map();
  if (f.handlers.length || status === 'failed') deliverFor(f, () => runHandlers(f)); else f.delivered = true;
  for (const [res, rej] of f.js.splice(0)) status === 'done' ? res(value) : rej(error);
  for (const w of f.waiters.splice(0)) { try { w(f); } catch (e) { Ed.reportError(e); } }
}
/* Where the handlers of F run: at once inside the command awaiting it, at once for :now, else at the next safe point. */
function deliverFor(f, fn) {
  if (f.awaited) { try { fn(); } catch (e) { Ed.reportError(e); } }
  else if (f.now) Ed.runCallback(fn);
  else deliver(fn);
}
function runHandlers(f) {
  f.delivered = true;
  const hs = f.handlers.splice(0);
  let handled = f.status === 'done' || f.awaited;
  for (const h of hs) {
    try {
      L.resetOps();
      if (f.status === 'done') { if (h.onValue) L.apply(h.onValue, [f.value]); }
      else if (h.onError) { handled = true; L.apply(h.onError, [f.error]); }
      if (h.onFinally) L.apply(h.onFinally, []);
    } catch (e) { Ed.reportError(e); }
  }
  if (!handled && f.status === 'failed') Ed.reportError(threadError(f.error));
}
function addHandler(f, h) {
  if (f.settled && f.delivered) {
    if (f.status === 'done') { if (h.onValue) L.apply(h.onValue, [f.value]); }
    else if (h.onError) L.apply(h.onError, [f.error]);
    if (h.onFinally) L.apply(h.onFinally, []);
  } else f.handlers.push(h);
  return f;
}
const onSettle = (f, cb) => { if (f.settled) cb(f); else f.waiters.push(cb); };
function doneFuture(v) { const f = new Future(); f.status = 'done'; f.value = v; f.delivered = true; return f; }
/* Scheme work on the main thread (no worker): queued for a safe point, or run at once when a command awaits it. */
function localFuture(f, fn) {
  f.localFn = fn; f.localQueued = true; f.job = null;
  if (f.awaited) { runLocalNow(f); return f; }
  deliver(() => runLocalNow(f));
  return f;
}
function runLocalNow(f) {
  if (!f.localQueued) return;
  f.localQueued = false; f.status = 'running';
  try { L.resetOps(); const v = f.localFn(); settleFuture(f, 'done', v, null, new Map()); }
  catch (e) { settleFuture(f, 'failed', undefined, e instanceof Error ? e : mkErr('error', String(e)), new Map()); }
}
/* The gate: callbacks run only while the command loop is parked at top level and nothing is queued. */
let running = 0;
const deliverQ = [];
const prevPre = H.preCommand, prevPost = H.postCommand;
H.preCommand = (def, b) => { if (prevPre) prevPre(def, b); running++; };
H.postCommand = (def, b, failed) => { if (prevPost) prevPost(def, b, failed); running = Math.max(0, running - 1); if (deliverQ.length) Ed.whenIdle().then(drain); };
const safe = () => running === 0 && !!E.idle && Ed.queueLength === 0 && !E.mini && E.depth === 0 && !E.isearch && !E.pendingKeys;
let draining = false;
function drain() {
  if (draining) return;
  draining = true;
  try { while (deliverQ.length && safe()) Ed.runCallback(deliverQ.shift()); }
  finally { draining = false; }
}
function scheduleDrain() { if (safe()) drain(); else Ed.whenIdle().then(drain); }
function deliver(fn, now) { if (now) Ed.runCallback(fn); else { deliverQ.push(fn); scheduleDrain(); } }

/* ---------- Scheme jobs ---------- */
const OPT_KEYS = new Set([':timeout', ':name', ':priority', ':buffers', ':now', ':worker', ':affinity', ':tag']);
function popOpts(args) {
  const o = {};
  while (args.length >= 2 && args[args.length - 2] instanceof Sym && OPT_KEYS.has(args[args.length - 2].name)) { const v = args.pop(); o[args.pop().name.slice(1)] = v; }
  return o;
}
const jobOpts = o => ({ priority: o.priority instanceof Sym ? o.priority.name : 'batch', timeout: typeof o.timeout === 'number' ? o.timeout * 1000 : undefined,
  worker: typeof o.worker === 'number' ? o.worker : undefined, affinity: o.affinity === undefined || o.affinity === false ? undefined : L.write(o.affinity), tag: o.tag === undefined || o.tag === false ? undefined : L.write(o.tag) });
function checkBuffers(o) {
  const bufs = o.buffers === undefined || o.buffers === false ? [] : arr(o.buffers);
  for (const b of bufs) if (!(b instanceof Ed.Buffer)) L.signal('wrong-type-argument', intern('bufferp'), b);
  return bufs;
}
const schemeOff = () => !isOk() || schemeState === 'no';
/* A future of WHAT applied to ARGS in a worker (or on the main thread without one). */
function startFuture(what, args, o, evalOnly) {
  const f = new Future();
  f.name = typeof o.name === 'string' ? o.name : null; f.now = truthy(o.now);
  const bufs = checkBuffers(o);
  const localFn = localThunk(what, args, evalOnly);
  if (schemeOff()) return localFuture(f, localFn);
  const meta = { buffers: new Set(bufs) };
  const job = newJob('eval', jobOpts(o));
  job.promise.catch(() => {});
  job.future = f; f.job = job; f.localFn = localFn; job.buffers = meta.buffers;
  job.convert = names => {
    const r = convertCall(what, args, names, meta, evalOnly);
    job.form = r.form; job.defs = r.defs;
    const first = args.find(a => a instanceof Ed.Buffer) || bufs[0] || [...meta.buffers][0];
    job.cur = first ? first.id : null;
  };
  if (baseNames) job.convert(baseNames);   /* an unshippable value signals here, at call time */
  enqueue(job);
  return f;
}
/* A future over the chunks of ITEMS: each chunk is one eval job of MKFORM(cv, chunk) with the
   definitions DEFSSEED(cv) adds (F, shipped once per worker); COMBINE joins the chunk results in order. */
function parallel(items, chunkSize, defsSeed, mkForm, combine, localFn, unbind) {
  const f = new Future();
  f.localFn = localFn;
  if (schemeOff()) return localFuture(f, localFn);
  if (!items.length) { settleFuture(f, 'done', combine([]), null, new Map()); return f; }
  const n = Math.max(1, chunkSize || Math.ceil(items.length / (2 * size)));
  const chunks = [];
  for (let i = 0; i < items.length; i += n) chunks.push(items.slice(i, i + n));
  const results = new Array(chunks.length), jobs = [];
  let left = chunks.length;
  f.parts = jobs;
  const finish = () => { if (unbind) unbind(); };
  chunks.forEach((its, ci) => {
    const meta = { buffers: new Set() };
    const job = newJob('eval', {});
    job.promise.catch(() => {});
    job.parent = f; job.buffers = meta.buffers;
    job.convert = names => { const cv = converter(names, meta); defsSeed(cv); job.form = mkForm(cv, its); job.defs = cv.defs; job.cur = null; };
    job.cbs = {
      onDone: v => {
        if (f.settled || f.localized) return;
        results[ci] = v;
        if (--left === 0) {
          const all = new Map();
          for (const j of jobs) for (const [id, ver] of j.versions) if (!all.has(id) || ver < all.get(id)) all.set(id, ver);
          finish();
          try { settleFuture(f, 'done', combine(results), null, all); } catch (e) { settleFuture(f, 'failed', undefined, e, all); }
        }
      },
      onFail: e => {
        if (f.settled || f.localized) return;
        for (const j of jobs) if (j !== job) cancelJob(j, false);
        finish();
        settleFuture(f, e.kind === 'thread-cancelled' ? 'cancelled' : 'failed', undefined, e, new Map());
      },
    };
    if (baseNames) job.convert(baseNames);
    jobs.push(job);
  });
  for (const j of jobs) enqueue(j);
  return f;
}
let pmN = 0;
/* (OP F LIST) over the workers: F is shipped once per worker as %pm-N and unbound there afterwards. */
function parallelOp(op, F, list, chunk, combine, extra) {
  const items = arr(list), name = '%pm-' + (++pmN), key = 'g:' + name;
  if (typeof F !== 'function' && !(F instanceof Sym)) L.signal('wrong-type-argument', 'expected a procedure, got', F);
  const defsSeed = cv => { const fe = typeof F === 'function' ? cv.proc(F) : (cv.global(F.name), sy(F.name)); cv.addDef(key, F, el(sy('define'), sy(name), fe)); };
  const mkForm = (cv, its) => el(sy(op), sy(name), ...(extra ? [qt(cv.encode(extra.value))] : []), qt(cv.encode(listOf(its))));
  const localFn = () => L.call(op, extra ? [F, extra.value, list] : [F, list]);
  const unbind = () => { const form = codec.encode(L.list(intern('global-unbind!'), L.list(QUOTE, intern(name)))); for (const s of slots) if (s && s.w && s.have.has(key)) { s.have.delete(key); try { s.w.postMessage({ t: 'broadcast', form }); } catch (e) { /* dying */ } } };
  return parallel(items, chunk === undefined || chunk === false ? 0 : Number(chunk), defsSeed, mkForm, combine, localFn, unbind);
}
/* FORM evaluated in every live worker now and in every worker spawned later. */
function broadcastForm(form) {
  const enc = codec.encode(form, { buffers: new Set() });
  broadcastLog.push({ form, enc });
  if (form instanceof Pair && form.car === DEFINE && form.cdr instanceof Pair) {
    const t = form.cdr.car, nm = t instanceof Pair ? t.car : t;
    if (nm instanceof Sym) { let v; try { v = L.get(nm.name); } catch (e) { v = undefined; } if (v !== undefined) { broadcastNames.set(nm.name, v); for (const s of slots) if (s && s.ready) s.have.set('g:' + nm.name, v); } }
  }
  const f = new Future();
  const live = slots.filter(s => s && s.w && (s.scheme || !s.ready));
  if (!live.length || !hasScheme) { settleFuture(f, 'done', true, null, new Map()); return f; }
  const req = ++reqN;
  bWaiters.set(req, { left: live.length, resolve: () => settleFuture(f, 'done', true, null, new Map()) });
  for (const s of live) { try { s.w.postMessage({ t: 'broadcast', form: enc, req }); } catch (e) { /* dying: terminateSlot settles the waiter */ } }
  return f;
}
function evalForm(form, opts) { const f = startFuture(form, [], opts || {}, true); return new Promise((res, rej) => f.then(res, rej)); }
function callProc(proc, args, opts) { const f = startFuture(proc, args || [], opts || {}); return new Promise((res, rej) => f.then(res, rej)); }
function broadcast(form) { const f = broadcastForm(form); return new Promise((res, rej) => f.then(() => res(), rej)); }

/* ---------- the jobs defined here ---------- */
/* Word index of text T: the distinct words (SRC repeated 3 or more times, as scanWords does, in text
   order up to CAP words), sorted by their lowercase form. Kept as two joined strings with offsets
   so it crosses threads as three flat objects instead of 50,000 strings. */
function wordIndex(t, src, cap) {
  const rx = new RegExp(src + '{3,}', 'gu'), set = new Set();
  let m;
  while ((m = rx.exec(t)) && set.size < cap) set.add(m[0]);
  const arr = [];
  for (const w of set) arr.push([w.toLowerCase(), w]);
  arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const n = arr.length, off = new Int32Array(n + 1), loff = new Int32Array(n + 1);
  let words = '', lower = '';
  for (let i = 0; i < n; i++) { lower += arr[i][0]; words += arr[i][1]; loff[i + 1] = lower.length; off[i + 1] = words.length; }
  return { n, words, lower, off, loff };
}
/* Indices of the items that match every term ([source, flags] pairs). */
function filterItems(items, terms) {
  const res = terms.map(([s, f]) => new RegExp(s, f)), out = [];
  for (let i = 0; i < items.length; i++) { let ok = true; for (const r of res) if (!r.test(items[i])) { ok = false; break; } if (ok) out.push(i); }
  return Int32Array.from(out);
}
define('words', (a, ctx) => wordIndex(ctx.buffer(a.id), a.src, a.cap), [wordIndex]);
define('list', (a, ctx) => { ctx.state.set('list:' + a.key, a.items); return true; });
define('unlist', (a, ctx) => { ctx.state.delete('list:' + a.key); return true; });
define('filter', (a, ctx) => filterItems(ctx.state.get('list:' + a.key) || [], a.terms), [filterItems]);
/* The lexer on the main thread, for EdPool.local('lex') (the worker has it from Ed.LEX_SOURCE). */
const C = Ed.C, lex = Ed.lex, markDocstrings = Ed.markDocstrings;
function parenDepths(t, cls, from, to, depth, d) {
  const ret = arguments.length > 5;
  d = d || new Uint8Array(t.length);
  for (let k = from; k < to; k++) if (cls[k] === C.PAR) { if (t.charCodeAt(k) === 40) { d[k] = ((depth % 6) + 6) % 6; depth++; } else { depth--; d[k] = ((depth % 6) + 6) % 6; } }
  return ret ? depth : d;
}
define('lex', (a, ctx) => { const t = ctx.buffer(a.id), cls = markDocstrings(t, lex(t)); return { cls, d: parenDepths(t, cls, 0, t.length, 0) }; });
/* Matches of a regexp in a buffer, a shard of one, or a text: five numbers per hit (index, line, column, line start, line end). */
define('grep', (it, ctx) => {
  const t = it.text !== undefined ? it.text : ctx.buffer(it.id), re = new RegExp(ctx.args.source, ctx.args.flags.includes('g') ? ctx.args.flags : ctx.args.flags + 'g');
  const hits = []; let m, n = 0, line = 1, nlPos = 0;
  re.lastIndex = it.from || 0; const end = it.to === undefined ? t.length : it.to;
  while ((m = re.exec(t)) && m.index < end && n < ctx.args.max) {
    for (let k = t.indexOf('\n', nlPos); k >= 0 && k < m.index; k = t.indexOf('\n', nlPos)) { line++; nlPos = k + 1; }
    const ls = t.lastIndexOf('\n', m.index - 1) + 1, le = t.indexOf('\n', m.index);
    hits.push(m.index, line, m.index - ls, ls, le < 0 ? t.length : le); n++;
    if (m[0] === '') re.lastIndex++;
  }
  return { hits: Int32Array.from(hits), truncated: n >= ctx.args.max };
});
/* [{ target, hits, truncated }] for TARGETS: buffers, file names (read from the store) or { id, from, to } shards. */
function grepItem(t) { return t instanceof Ed.Buffer ? { id: t.id } : typeof t === 'string' ? { name: t, text: Ed.Store.get(t) || '' } : t; }
function grep(source, flags, targets, max) {
  const items = targets.map(grepItem);
  const p = map('grep', items, { buffersFor: it => it.id ? [bufferById(it.id)].filter(Boolean) : [], args: { source, flags, max: max || 1000 }, chunk: 1, priority: 'ui', timeout: JOB_LIMIT });
  const q = p.then(res => res.map((r, i) => ({ target: targets[i], hits: r.hits, truncated: r.truncated })));
  q.cancel = p.cancel;
  return q;
}
function grepLocal(source, flags, targets, max) {
  return targets.map(t => { const it = grepItem(t), b = it.id ? bufferById(it.id) : null; const r = local('grep', it, b ? [b] : [], { source, flags, max: max || 1000 }); return { target: t, hits: r.hits, truncated: r.truncated }; });
}
const grepText = (target, ls, le) => target instanceof Ed.Buffer ? target.rope.slice(ls, le) : (Ed.Store.get(target) || '').slice(ls, le);

/* ---------- word index: wordsIn(buf, src) returns the latest index (maybe from an older version)
   and starts a refresh when the buffer changed. The first index of a small buffer is built at once;
   a big one is built in the background and is empty until then. ---------- */
const EMPTY = { n: 0, words: '', lower: '', off: new Int32Array(1), loff: new Int32Array(1) };
function wordsIn(buf, src, sync) {
  const st = buf._wix;
  if (st && st.src === src && (st.ver === buf.ver || st.busy)) return st.ix;
  if (!st || st.src !== src) {
    if (sync || !isOk() || buf.rope.length < (1 << 20)) {
      buf._wix = { src, ver: buf.ver, ix: wordIndex(buf.text, src, CAP), busy: false };
      return buf._wix.ix;
    }
    buf._wix = { src, ver: -1, ix: EMPTY, busy: false };
  }
  refreshWords(buf, src);
  return buf._wix.ix;
}
function refreshWords(buf, src) {
  const st = buf._wix;
  if (st.busy) return;
  st.busy = true;
  const ver = buf.ver;
  const done = ix => { if (buf._wix === st) { st.ix = ix; st.ver = ver; st.busy = false; } };
  /* Debounce a little: typing changes the version on every key. */
  setTimeout(() => {
    if (buf._wix !== st) return;
    if (buf.ver !== ver) { st.busy = false; refreshWords(buf, src); return; }
    if (isOk()) run('words', { id: buf.id, src, cap: CAP }, { buffers: [buf], affinity: buf.id }).then(done, () => { st.busy = false; });
    else idle(() => done(wordIndex(buf.text, src, CAP)));
  }, isOk() ? 150 : 700);
}
/* The words of index IX whose lowercase form starts with LOWER, in index order. */
function wordsWithPrefix(ix, lower, fn) {
  let lo = 0, hi = ix.n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ix.lower.slice(ix.loff[mid], ix.loff[mid + 1]) < lower) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < ix.n; i++) {
    if (!ix.lower.startsWith(lower, ix.loff[i]) || ix.loff[i] + lower.length > ix.loff[i + 1]) break;
    fn(ix.words.slice(ix.off[i], ix.off[i + 1]));
  }
}

/* ---------- filtering of big candidate lists (consult-line on a big buffer): the list is sent once
   to one worker and kept in its ctx.state; every input filters it there. ---------- */
const listKeys = new WeakMap();
let listN = 0;
function pickListSlot() {
  let best = null;
  for (let k = 0; k < size; k++) { const s = slots[k]; if (s && (s.dead || s.retired)) continue; if (!s) { if (!best) best = { k, lastUse: -1 }; continue; } if (!best || s.lastUse < best.lastUse) best = s; }
  return best ? best.k : 0;
}
function filterAsync(items, terms) {
  if (!isOk()) return null;
  let ent = listKeys.get(items);
  const s = ent && slots[ent.k];
  if (!ent || !s || s.dead || s.retired || s.gen !== ent.gen) {
    const k = pickListSlot();
    ent = { key: ++listN, k, gen: slots[k] ? slots[k].gen : 0 };
    listKeys.set(items, ent);
    run('list', { key: ent.key, items }, { worker: k, priority: 'ui' }).catch(() => {});
  }
  const tag = 'filter:' + ent.key;
  cancelAll(tag);
  return run('filter', { key: ent.key, terms: terms.map(r => [r.source, r.flags]) }, { worker: ent.k, priority: 'ui', tag });
}
function unlist(items) {
  const ent = listKeys.get(items);
  if (!ent) return;
  listKeys.delete(items);
  const s = slots[ent.k];
  if (isOk() && s && s.w && s.gen === ent.gen) run('unlist', { key: ent.key }, { worker: ent.k, priority: 'ui' }).catch(() => {});
}

/* ---------- first lex of a big Lisp buffer ---------- */
const LEX_KEY = Symbol('lex');
function lexAsync(b) {
  if (!isOk() || b._lexBusy) return false;
  b._lexBusy = true;
  const ver = b.ver;
  jobsOf(b).set(LEX_KEY, ver);   /* keeps the log back to VER until the lex is installed */
  run('lex', { id: b.id }, { buffers: [b], affinity: b.id }).then(m => {
    b._lexBusy = false; jobsOf(b).delete(LEX_KEY);
    /* Install the result at the version it was made for; lexOf brings it up to date from the log. */
    if (b._lv < ver || !b._lc) Ed.installLex(b, ver, m.cls, m.d);
    Ed.render();
  }, () => { b._lexBusy = false; jobsOf(b).delete(LEX_KEY); });
  return true;
}

/* The log must reach back to every mirror that can still be patched and to every job in flight. */
H.logFloor = (prev => b => {
  let f = prev ? prev(b) : Infinity;
  for (const s of slots) { if (!s) continue; const v = s.mirrors.get(b.id); if (v !== undefined && b.ver - v < DELTA_CAP && v < f) f = v; }
  if (b._jobs) for (const v of b._jobs.values()) if (v < f) f = v;
  return f;
})(H.logFloor);

/* ---------- C-g stops a pool job a command awaits ---------- */
/* The command loop holds every key while a command awaits a promise, C-g included, so a key that
   only queued could never stop a :s or grep whose regexp backtracks for hours. A promise wrapped
   here is cancelled (its running threads restarted) when C-g is typed, and rejects with a quit. */
const awaited = new Set();
function interruptible(p) {
  return new Promise((res, rej) => {
    const ent = () => { awaited.delete(ent); try { if (p.cancel) p.cancel({ hard: true }); } catch (e) { /* settled */ } rej(new SchemeError('quit', 'Quit', [])); };
    awaited.add(ent);
    p.then(v => { awaited.delete(ent); res(v); }, e => { awaited.delete(ent); rej(e); });
  });
}
{
  const prev = Ed.feedKey;
  Ed.feedKey = function (k) { if (k === 'C-g' && awaited.size) { for (const ent of [...awaited]) ent(); return; } return prev.apply(this, arguments); };
}

/* ---------- Scheme API ---------- */
const sym = s => s instanceof Sym ? s : intern(String(s));
const fut = x => { if (!(x instanceof Future)) L.signal('wrong-type-argument', 'expected a future, got', x); return x; };
D('thread-run', 'WHAT . ARGS', 'Run WHAT on a thread and return a future. WHAT is a procedure (a copy of its source and of its free variables goes to the thread), a symbol naming a global procedure, or a datum: a (lambda ...) form is compiled there and applied to ARGS; any other datum is evaluated and ARGS must be empty. Keyword options at the end of ARGS: :timeout SECS :name "label" :priority \'ui|\'batch :buffers (list b ...) :now #t. Free variables are copied by value: a set! in the thread changes the copy. Editor primitives that change state (insert, goto-char, keymaps) do not exist there.', ([what, ...args]) => startFuture(what, args, popOpts(args)));
D('thread-eval', 'FORM', 'Evaluate FORM (a datum) at top level of one thread; a future of the value. Global procedures and data FORM names are copied over first.', ([form, ...rest]) => startFuture(form, [], popOpts(rest), true));
D('thread-broadcast', 'FORM', 'Evaluate FORM in every thread now and in every thread started later; a future of #t.', ([form]) => broadcastForm(form));
D('%thread-define', 'NAME FORM', 'Broadcast the definition FORM of NAME (define-threaded).', ([name, form]) => { broadcastForm(form); return sym(name); });
D('%thread-define-local', 'NAME FORM', 'Broadcast the definition FORM of NAME and never copy NAME to a thread (define-thread-local).', ([name, form]) => { threadLocal.add(sym(name).name); broadcastForm(form); return sym(name); });
D('thread-call', 'JOB ARGS', 'A future of the JS job JOB (EdPool.define) run on a thread with ARGS; values cross through the codec.', ([job, args, ...rest]) => {
  const o = popOpts(rest), f = new Future();
  const bufs = new Set(checkBuffers(o));
  const enc = codec.encode(args, { buffers: bufs });
  if (schemeOff()) return localFuture(f, () => codec.decode(local(sym(job).name, enc, [...bufs])));
  const j = startRun(sym(job).name, enc, { ...jobOpts(o), buffers: [...bufs] }), p = j.promise;
  f.job = j;
  p.then(v => { if (!f.settled) settleFuture(f, 'done', safeDecode(v), null, p.versions); }, e => { if (!f.settled) settleFuture(f, e.kind === 'thread-cancelled' ? 'cancelled' : 'failed', undefined, e, p.versions); });
  return f;
});
D('parallel-map', 'F LIST [CHUNK]', 'Map F over LIST on the threads, CHUNK items per job; a future of the list, in order. F is shipped once per thread.', ([f, l, c]) => parallelOp('map', f, l, c, rs => listOf([].concat(...rs.map(arr)))));
D('parallel-for-each', 'F LIST [CHUNK]', 'Call F on each element of LIST on the threads; a future of #t.', ([f, l, c]) => parallelOp('for-each', f, l, c, () => true));
D('parallel-filter', 'PRED LIST [CHUNK]', 'The elements of LIST satisfying PRED, found on the threads; a future of the list.', ([f, l, c]) => parallelOp('filter', f, l, c, rs => listOf([].concat(...rs.map(arr)))));
D('parallel-reduce', 'F LIST IDENTITY [CHUNK]', 'Reduce LIST with the associative F: each thread folds a chunk from IDENTITY, the main thread folds the chunk results; a future.', ([f, l, id, c]) => parallelOp('reduce', f, l, c, rs => L.call('reduce', [f, id, listOf(rs)]), { value: id }));
D('parallel-any', 'PRED LIST [CHUNK]', 'The first non-#f value of PRED over LIST, in order, found on the threads; a future.', ([f, l, c]) => parallelOp('any', f, l, c, rs => { for (const r of rs) if (r !== false) return r; return false; }));
D('parallel-every', 'PRED LIST [CHUNK]', '#f if PRED fails for an element of LIST, else the last value; a future.', ([f, l, c]) => parallelOp('every', f, l, c, rs => { let v = true; for (const r of rs) { if (r === false) return false; v = r; } return v; }));
D('thread-grep', 'REGEXP . BUFFERS', 'Every match of REGEXP in BUFFERS (default: all) found on the threads; a future of a list of #(buffer line column text).', ([re, ...bufs]) => {
  if (!(re instanceof RegExp)) L.signal('wrong-type-argument', 'expected a regexp, got', re);
  const targets = bufs.length ? bufs.map(b => Ed.toBuffer(b)) : E.buffers.filter(b => !b.name.startsWith(' '));
  const toList = res => { const out = []; for (const r of res) { const h = r.hits; for (let i = 0; i < h.length; i += 5) out.push([r.target, h[i + 1], h[i + 2], grepText(r.target, h[i + 3], h[i + 4])]); } return listOf(out); };
  const f = new Future();
  if (schemeOff()) return localFuture(f, () => toList(grepLocal(re.source, re.flags, targets, 100000)));
  const p = grep(re.source, re.flags, targets, 100000);
  p.then(res => settleFuture(f, 'done', toList(res), null, new Map()), e => settleFuture(f, e.kind === 'thread-cancelled' ? 'cancelled' : 'failed', undefined, e, new Map()));
  return f;
});
D('future?', 'X', '#t if X is a future.', ([x]) => x instanceof Future);
D('future-done?', 'F', '#t when F has a value.', ([f]) => fut(f).status === 'done');
D('future-failed?', 'F', '#t when F failed (or was cancelled).', ([f]) => fut(f).status === 'failed' || f.status === 'cancelled');
D('future-cancelled?', 'F', '#t when F was cancelled.', ([f]) => fut(f).status === 'cancelled');
D('future-running?', 'F', '#t while F runs on a thread.', ([f]) => fut(f).status === 'running');
D('future-status', 'F', 'queued, running, done, failed or cancelled.', ([f]) => intern(fut(f).status));
D('future-then', 'F ON-VALUE [ON-ERROR]', 'Call ON-VALUE with the value of F, or ON-ERROR with its condition, on the main thread when the command loop is at rest (at once inside a command that awaits F). Returns F.', ([f, ok, bad]) => addHandler(fut(f), { onValue: ok, onError: bad === undefined || bad === false ? null : bad }));
D('future-catch', 'F ON-ERROR', 'Call ON-ERROR with the condition when F fails. Returns F.', ([f, bad]) => addHandler(fut(f), { onError: bad }));
D('future-finally', 'F THUNK', 'Call THUNK when F settles either way. Returns F.', ([f, t]) => addHandler(fut(f), { onFinally: t }));
D('future-progress', 'F ON-PROGRESS', 'Call ON-PROGRESS with each value the job reports with thread-report, before the value. Returns F.', ([f, h]) => { fut(f).progressH.push(h); return f; });
D('future-value', 'F [DEFAULT]', 'The value of F when it is done, DEFAULT (#f) while it runs; a failure is signalled again. Never waits.', ([f, d]) => { fut(f); if (f.status === 'done') return f.value; if (f.status === 'failed' || f.status === 'cancelled') throw f.error; return d === undefined ? false : d; });
D('future-error', 'F', 'The condition F failed with, or #f.', ([f]) => fut(f).error || false);
D('future-versions', 'F', 'An alist ((BUFFER . VERSION) ...) of the buffer mirrors the job of F read.', ([f]) => listOf([...fut(f).versions].map(([id, v]) => new Pair(bufferById(id) || id, v))));
D('future-cancel', 'F', 'Cancel F: #t if it was queued or running (a running job stops when its thread is restarted). F then fails with kind thread-cancelled.', ([f]) => {
  fut(f);
  if (f.localQueued) { f.localQueued = false; settleFuture(f, 'cancelled', undefined, mkErr('thread-cancelled', 'cancelled'), new Map()); return true; }
  if (f.settled) return false;
  if (f.parts) { let any = false; for (const j of f.parts) any = cancelJob(j, true) || any; if (!f.settled) settleFuture(f, 'cancelled', undefined, mkErr('thread-cancelled', 'cancelled'), new Map()); return any; }
  return f.job ? cancelJob(f.job, true) : false;
});
D('futures-all', 'LIST', 'A future of the list of the values of the futures in LIST; it fails with the first failure.', ([l]) => {
  const fs = arr(l).map(fut), out = new Future(), vals = new Array(fs.length);
  let left = fs.length;
  if (!left) { settleFuture(out, 'done', NIL, null, new Map()); return out; }
  fs.forEach((f, i) => onSettle(f, g => { if (out.settled) return; if (g.status === 'done') { vals[i] = g.value; if (--left === 0) settleFuture(out, 'done', listOf(vals), null, new Map()); } else settleFuture(out, g.status, undefined, g.error, new Map()); }));
  return out;
});
D('futures-any', 'LIST', 'A future of the value of the first future in LIST to be done; it fails when all fail.', ([l]) => {
  const fs = arr(l).map(fut), out = new Future();
  let left = fs.length;
  if (!left) { settleFuture(out, 'failed', undefined, mkErr('error', 'futures-any: no futures'), new Map()); return out; }
  for (const f of fs) onSettle(f, g => { if (out.settled) return; if (g.status === 'done') settleFuture(out, 'done', g.value, null, new Map()); else if (--left === 0) settleFuture(out, g.status, undefined, g.error, new Map()); });
  return out;
});
D('future-now', 'V', 'A future already done with V.', ([v]) => doneFuture(v));
D('thread-count', '', 'Number of threads alive.', () => aliveCount());
D('thread-pool-ok?', '', '#t when threads run Scheme.', () => schemeState === 'yes' && slots.some(s => s && s.ready && s.scheme));
D('in-thread?', '', '#t in a thread, #f on the main thread.', () => false);
D('thread-id', '', 'Index of this thread, #f on the main thread.', () => false);
D('buffer-version', '&optional BUFFER', 'The version number of the text of BUFFER (it grows with every change).', ([b]) => Ed.toBuffer(b).ver);
D('buffer-changed-since?', 'BUFFER VERSION', '#t when the text of BUFFER differs from what it was at VERSION.', ([b, v]) => Ed.changedSince(Ed.toBuffer(b), Number(v)));
L.magic('thread-pool-size', () => size, v => { setSize(v); }, 'How many threads the pool may run; set! starts or retires threads.');
L.evalText(`
(define-syntax future
  (syntax-rules () ((_ body ...) (thread-run (lambda () body ...)))))
(define-syntax define-threaded
  (syntax-rules ()
    ((_ (name . args) body ...) (begin (define (name . args) body ...) (%thread-define 'name '(define (name . args) body ...))))
    ((_ name value) (begin (define name value) (%thread-define 'name '(define name value))))))
(define-syntax define-thread-local
  (syntax-rules ()
    ((_ name init) (begin (define name init) (%thread-define-local 'name '(define name init))))))
`);
S.gdoc.set('future', 'Macro: (future EXPR ...) runs the expressions on a thread and returns a future.');
S.gdoc.set('define-threaded', 'Macro: define NAME on the main thread and in every thread, now and later. Helpers it calls must be threaded too.');
S.gdoc.set('define-thread-local', 'Macro: define NAME everywhere, each thread evaluating INIT itself; the value is never copied to a thread.');

/* ---------- consult-grep: every open buffer and every saved file, with preview ---------- */
const grepHistory = [];
function grepRegex(pat) {
  const ci = pat === pat.toLowerCase() ? 'i' : '';
  try { return new RegExp(pat, 'g' + ci); } catch (e) { return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + ci); }
}
CMD('consult-grep', async () => [await Ed.readMini('Grep: ', '', null, { history: grepHistory })], 'PATTERN', 'Search every open buffer and every saved file for PATTERN on the threads; pick a hit with preview and jump to it.', async ([pat]) => {
  if (!pat) L.signal('user-error', 'No pattern given');
  const re = grepRegex(pat);
  const targets = [...E.buffers.filter(b => !b.name.startsWith(' ')), ...Ed.Store.list().filter(f => !E.buffers.some(b => b.file === f))];
  let res;
  try { res = isOk() ? await interruptible(grep(re.source, re.flags, targets, 2000)) : grepLocal(re.source, re.flags, targets, 2000); }
  catch (e) { if (e.kind === 'no-worker' || e.kind === 'thread-died') res = grepLocal(re.source, re.flags, targets, 2000); else throw e; }
  const items = [], locs = [];
  for (const r of res) {
    const name = r.target instanceof Ed.Buffer ? r.target.name : r.target, h = r.hits;
    for (let i = 0; i < h.length; i += 5) { items.push(name + ':' + h[i + 1] + ': ' + grepText(r.target, h[i + 3], h[i + 4]).trim().slice(0, 200)); locs.push({ target: r.target, pos: h[i] }); }
  }
  if (!items.length) L.signal('user-error', 'No matches for ' + pat);
  const w = E.sel, start = w.buffer, startPt = start.pt, startScroll = w.start;
  const at = new Map(); items.forEach((it, i) => { if (!at.has(it)) at.set(it, i); });
  let picked = null;
  try {
    picked = await Ed.readMini('Grep ' + pat + ': ', '', () => items, { kind: 'consult-grep', require: true, keepOrder: true,
      onSelect: c => { const k = c === null ? -1 : at.get(c); if (k === undefined || k < 0) return; const loc = locs[k]; if (!(loc.target instanceof Ed.Buffer)) return; if (w.buffer !== loc.target) Ed.setWindowBuffer(loc.target, w); loc.target.pt = loc.pos; E.recenter = 'center'; } });
  } finally {
    if (picked === null) { if (w.buffer !== start && E.buffers.includes(start)) Ed.setWindowBuffer(start, w); start.pt = startPt; w.start = startScroll; }
  }
  const loc = locs[at.get(picked)];
  if (loc.target instanceof Ed.Buffer) { if (E.buffers.includes(loc.target)) { EvilCore.pushJump(start, startPt); Ed.setWindowBuffer(loc.target, w); loc.target.pt = loc.pos; } }
  else { L.call('find-file', [loc.target]); const b = E.current; b.pt = Math.min(b.rope.length, loc.pos); }
  E.recenter = 'center';
  return false;
});

globalThis.EdPool = {
  get ok() { return isOk(); },
  get scheme() { return schemeState === 'yes' && slots.some(s => s && s.ready && s.scheme); },
  get size() { return size; }, set size(n) { setSize(n); },
  get alive() { return aliveCount(); },
  get ready() { ensure(0); return readyPromise; },
  setSize, stats, define, run, map, local, shards, cancel: p => p.cancel(), cancelAll, sync, release, evalForm, callProc, broadcast, deliver, grep, interruptible, JOB_LIMIT,
  wordIndex, wordsIn, wordsWithPrefix, filterItems, filterAsync, unlist, lexAsync, _fail, _slots: slots, _codec: codec, Future,
};
/* The threads boot while the page is idle after load (the old pool started its worker at load), so
   the first job of a session, often a :s or a lex of a big file, does not wait for a boot. A job
   that comes first still spawns at once. */
snapshotLoad();
if (isOk()) idle(warm);
})();
