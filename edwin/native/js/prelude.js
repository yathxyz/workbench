/* What a page or Node gives the core and bare V8 does not (DT1): timers, queueMicrotask, performance.now,
   console, TextEncoder, crypto.randomUUID. Timers are kept here; the shell's event loop calls
   __native.tick() for the due ones and sleeps until the next. console writes to the log file
   (EDWIN_LOG, else edwin.log in the state directory), never to the terminal Edwin draws on. */
(function () {
'use strict';
const N = globalThis.__n;

/* ---------- timers ---------- */
const timers = new Map();
let seq = 0;
function add(f, ms, args, every) {
  if (typeof f !== 'function') throw new TypeError('setTimeout: the callback is not a function');
  const id = ++seq, d = Math.max(0, Number(ms) || 0);
  timers.set(id, { f, args, at: N.now() + d, every: every ? Math.max(1, d) : 0 });
  return id;
}
globalThis.setTimeout = (f, ms, ...args) => add(f, ms, args, false);
globalThis.setInterval = (f, ms, ...args) => add(f, ms, args, true);
globalThis.clearTimeout = globalThis.clearInterval = id => { timers.delete(id); };
globalThis.queueMicrotask = f => { Promise.resolve().then(f); };
globalThis.performance = { now: () => N.now(), timeOrigin: Date.now() - N.now() };

/* ---------- the event loop's side: due timers, then milliseconds to the next (-1: none) ---------- */
const handlers = { input: null, signal: null, sock: null };
let frozenAt = null;
function report(e) { try { console.error(e && e.stack ? e.stack : String(e)); } catch (e2) { /* nowhere to say it */ } }
globalThis.__native = {
  handlers,
  tick() {
    const now = N.now();
    const due = [];
    for (const [id, t] of timers) if (t.at <= now) due.push([id, t]);
    due.sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, t] of due) {
      if (!timers.has(id)) continue;
      if (t.every) t.at = now + t.every; else timers.delete(id);
      try { t.f(...t.args); } catch (e) { report(e); }
    }
    let next = Infinity;
    for (const t of timers.values()) if (t.at < next) next = t.at;
    return next === Infinity ? -1 : Math.max(0, next - N.now());
  },
  /* The startup snapshot is made at one clock and restored at another (N.now() starts again at 0): freeze()
     before it is made, thaw() after it is restored, keeps each timer's delay. */
  freeze() { frozenAt = N.now(); },
  thaw() {
    if (frozenAt === null) return;
    const shift = N.now() - frozenAt;
    for (const t of timers.values()) t.at += shift;
    frozenAt = null; logFile = null;
    globalThis.performance.timeOrigin = Date.now() - N.now();
  },
  /* Milliseconds to the next timer (-1: none), asked again after microtasks may have added one. */
  next() {
    let next = Infinity;
    for (const t of timers.values()) if (t.at < next) next = t.at;
    return next === Infinity ? -1 : Math.max(0, next - N.now());
  },
  input(s) { if (handlers.input) try { handlers.input(s); } catch (e) { report(e); } },
  signal(name) { if (handlers.signal) try { handlers.signal(name); } catch (e) { report(e); } },
  sock(id, line) { if (handlers.sock) try { handlers.sock(id, line); } catch (e) { report(e); } },
};

/* ---------- console: a log file ---------- */
let logFile = null;
function logPath() {
  if (logFile !== null) return logFile;
  const home = N.env('HOME') || '/tmp';
  const dir = (N.env('XDG_STATE_HOME') || home + '/.local/state') + '/edwin';
  logFile = N.env('EDWIN_LOG') || dir + '/edwin.log';
  try { N.mkdirs(logFile.slice(0, logFile.lastIndexOf('/')) || '/'); } catch (e) { /* the append reports it */ }
  return logFile;
}
const show = a => (typeof a === 'string' ? a : a instanceof Error ? (a.stack || a.message) : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })());
const log = level => (...a) => { try { N.appendFile(logPath(), `${new Date().toISOString()} ${level} ${a.map(show).join(' ')}\n`); } catch (e) { /* no log */ } };
globalThis.console = { log: log('info'), info: log('info'), warn: log('warn'), error: log('error'), debug: () => {}, trace: log('trace') };

/* ---------- text and randomness ---------- */
class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(s = '') {
    const out = [];
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return new Uint8Array(out);
  }
}
globalThis.TextEncoder = TextEncoder;
const hex = n => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
globalThis.crypto = {
  getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 2 ** (8 * (a.BYTES_PER_ELEMENT || 1))); return a; },
  randomUUID: () => `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`,
};
})();
