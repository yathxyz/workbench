/* The Node host: the same names as host-browser.ts (R4.1), for Edwin's core with no page at all. edwind
   runs the core with it, and so do the headless tests.

   The core files are classic scripts that keep their state in globals, so loadEdwin runs them in this
   process's global scope, once per process. With no page the core is headless: redisplay is skipped and
   no frame exists; buffers, keymaps, the command loop, Evil, ex, Org, Scheme and undo run unchanged.

   Storage is in memory unless a store is passed in. config reads the shipped Scheme from scm/;
   userConfig and readFile read the user's files (CONFIG_DIR/init.scm, and files for load and require). */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');

const SRC = __dirname;
const ROOT = path.join(SRC, '..');
const WORKER_FILE = path.join(ROOT, 'server', 'worker.mts');
const JOBS_FILE = path.join(ROOT, 'server', 'jobs.mts');
/* The core, in load order: the order of the script tags in index.html. */
const FILES = ['scheme', 'runtime', 'text', 'editor-core', 'editor-prims', 'evil-core', 'pool', 'complete', 'extras', 'stack', 'ai', 'evil-ex', 'org', 'markdown', 'ot', 'sync', 'display'];

function memoryStorage(map = new Map()) {
  return {
    get: k => (map.has(k) ? map.get(k) : null),
    set: (k, v) => { map.set(k, String(v)); return true; },
    remove: k => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch (e) { return -1; } };

/* The JavaScript of core file F of DIR (src/ by default), and the file a stack trace and definition-of name.
   The core is TypeScript run as classic scripts, which vm cannot strip: the build writes F.js beside F.ts
   (tools/strip.mts --in-place), and a checkout whose F.js is missing or older than F.ts gets F.ts stripped here
   (Node's stripper keeps every line and column, so positions are the .ts's either way). */
function coreSource(f, dir = SRC) {
  const ts = path.join(dir, f + '.ts'), js = path.join(dir, f + '.js'), t = mtime(js);
  const text = t >= 0 && t >= mtime(ts) ? fs.readFileSync(js, 'utf8') : require('node:module').stripTypeScriptTypes(fs.readFileSync(ts, 'utf8'), { mode: 'strip' });
  return { text, filename: ts };
}

/* ---------- the worker pool's threads (R4.47, R15.3) ----------
   pool.js runs the same code on a Web Worker in the browser and on a worker_threads Worker here; the
   differences of the two APIs are absorbed by PoolThread, which looks like a Web Worker to the pool:
   onmessage and onerror properties, postMessage(value, transferList), terminate(). Every thread is the
   file server/worker.mts (never code built from a string), which imports the Edwin sources and the named
   jobs of server/jobs.mts. ref/unref are Node's: the pool holds a thread only while work is outstanding,
   so a process whose main thread is done (a test, --check, --export) ends without terminating them. */
const workerCount = () => Math.min(6, Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
/* A thread's stack must hold what --stack-size tells V8 it may use (edwind sizes it for the Scheme depth
   cap, R4.34), else deep recursion on a thread would overrun the thread's stack instead of raising. */
function stackSizeMb() {
  let kib = 0;
  for (const a of [...process.execArgv, ...(process.env.NODE_OPTIONS || '').split(/\s+/)]) { const m = /^--stack-size=(\d+)$/.exec(a); if (m) kib = Number(m[1]); }
  return Math.max(4, Math.ceil(kib / 1024) + 1);
}
const STACK_MB = stackSizeMb();
const THREAD_HEAP_MB = 512;   // a runaway job dies with its thread (the pool starts another) instead of taking edwind past MemoryMax
class PoolThread {
  constructor(data) {
    this.onmessage = null; this.onerror = null; this.closed = false;
    const w = this.thread = new Worker(WORKER_FILE, { name: 'edwin-thread-' + data.k, workerData: data, resourceLimits: { stackSizeMb: STACK_MB, maxOldGenerationSizeMb: THREAD_HEAP_MB } });
    w.on('message', m => { if (this.onmessage) this.onmessage({ data: m }); });
    w.on('error', e => this.fail(e && e.message ? e.message : String(e)));
    w.on('exit', code => this.fail('the thread exited with code ' + code));
  }
  /* A crash reaches the pool once, as a Web Worker error event would; a terminate() of our own is silent. */
  fail(message) { if (this.closed) return; this.closed = true; if (this.onerror) this.onerror({ message, preventDefault() {} }); }
  postMessage(m, transfer) { this.thread.postMessage(m, transfer || []); }
  terminate() { this.closed = true; this.thread.terminate().catch(() => {}); }
  ref() { this.thread.ref(); }
  unref() { this.thread.unref(); }
}
/* The named jobs of server/jobs.mts, for the main thread: the functions by name (the fallback when the
   pool is off, and what EdPool.define may name) and the names jobs.mts keeps on the main thread. The
   module is loaded synchronously (require of an ES module, Node 22.12 and later); where that is not
   possible the pool runs with no threads, as before. */
function loadJobs() {
  const ns = require(JOBS_FILE);
  const fns = new Map();
  for (const k of Object.keys(ns)) if (typeof ns[k] === 'function') fns.set(k, ns[k]);
  return { fns, localOnly: new Set(Array.isArray(ns.LOCAL_ONLY) ? ns.LOCAL_ONLY : []) };
}

function createHost(opts = {}) {
  const scmDir = opts.scmDir || path.join(ROOT, 'scm');
  const configDir = opts.configDir || null;
  const attrs = new Map(), vars = new Map(), suspend = [];
  /* The pool runs threads unless { workers: false } (tests of the main-thread fallbacks). */
  let jobs = null, jobsError = null;
  try { jobs = loadJobs(); } catch (e) { jobsError = e && e.message ? e.message : String(e); }
  const page = {
    getAttr: name => attrs.get(name),
    setAttr: (name, v) => { if (v === undefined || v === null) attrs.delete(name); else attrs.set(name, v); },
    getVar: name => vars.get(name) ?? '',
    setVar: (name, v) => { vars.set(name, String(v)); },
    prefersDark: () => false,
    addStyle() {},
    onResize() {}, onMedia() {}, onFontsLoaded() {},
  };
  return {
    kind: 'node', headless: true,
    storage: opts.storage || memoryStorage(),
    config: name => readText(path.join(scmDir, name)),
    userConfig: name => (configDir ? readText(path.join(configDir, name)) : null),
    readFile: p => readText(p),
    loadPath: configDir ? [path.join(configDir, 'lisp'), scmDir] : [scmDir],
    page,
    /* Persistent tables flush when the process ends; suspend() runs the same flush on demand. */
    onSuspend(f) { suspend.push(f); },
    suspend() { for (const f of suspend) f(); },
    whenLoaded(f) { f(); },
    clipboard: '',
    setClipboard(s) { this.clipboard = s; },
    openUrl: () => false,
    onCspViolation() {},
    idle: f => setTimeout(f, 0),
    nextFrame: f => setTimeout(f, 0),
    /* The worker pool (R4.47): threads from server/worker.mts, min(6, CPUs - 1) of them, the named jobs of
       server/jobs.mts; workers is false when the pool must stay off (then every job runs on the main thread). */
    workers: opts.workers !== false && !!jobs,
    workersUnavailable: jobsError,
    workerCount: workerCount(),
    jobs,
    makeWorker: data => new PoolThread(data),
  };
}

/* Run the core files in this process with HOST, and give back Ed. Ed.boot({host}) starts it. MODE is the
   evaluator's mode (R4.38): 'gen' for the server image (threads, blocking calls, deadlines), 'direct' for
   frames and workers. */
function loadEdwin(host = createHost(), { mode = 'direct' } = {}) {
  if (globalThis.Ed) throw new Error('Edwin is already loaded in this process');
  globalThis.EdHost = host;
  globalThis.SCHEME_MODE = mode;
  for (const f of FILES) { const c = coreSource(f); vm.runInThisContext(c.text, { filename: c.filename }); }
  return globalThis.Ed;
}

module.exports = { FILES, createHost, memoryStorage, loadEdwin, coreSource, workerCount, WORKER_FILE, JOBS_FILE };
