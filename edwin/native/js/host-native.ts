/* The native host (DT1): the same names as host-browser.ts and host-node.cts (R4.1), for Edwin's core inside
   the desktop shell (edwin/native, a Rust program with V8 in it). The shell gives it __n, its natives:
   files, the terminal, sockets, the environment, exit. Unlike the page and edwind, this host has a file
   system the user edits directly: host.files, which the core's Store reads and writes (a file name is a
   path, relative to the directory edwin started in).

   Storage (recentf, savehist, save-place, the core's persistent tables) is one JSON file in the state
   directory, written atomically when a table changes (after a pause), when the program suspends and when it
   ends. Shipped Scheme comes from the binary (__scm); the user's own from ~/.config/edwin/. */
(function () {
'use strict';
const N = globalThis.__n;

const env = (k: string) => { const v = N.env(k); return v === undefined || v === null || v === '' ? null : v; };
/* The directories are the process's: read by init(), when the program starts (not when the startup snapshot
   was made). */
let HOME = '/', CWD = '/', CONFIG_DIR = '/', STATE_DIR = '/';
const join = (a: string, b: string) => (b.startsWith('/') ? b : (a.endsWith('/') ? a : a + '/') + b);
const dirname = (p: string) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
/* An absolute path without empty, . and .. segments (as the shell's cd does, not following links). */
function normalize(p: string) {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return '/' + out.join('/');
}
/* A file name as the user gave it to an absolute path: ~ is the home directory, others are under CWD. So
   foo, ./foo and bar/../foo are one file. */
function resolve(name: string) {
  const n = String(name);
  if (n === '~') return HOME;
  if (n.startsWith('~/')) return normalize(join(HOME, n.slice(2)));
  return normalize(join(CWD, n));
}
/* The file's true name, every symbolic link resolved: two names for one file have the same true name. */
const truename = (name: string) => { const p = resolve(name); return N.realpath(p) || p; };
function readDirs() {
  HOME = env('HOME') || '/';
  CWD = N.cwd();
  CONFIG_DIR = join(env('XDG_CONFIG_HOME') || join(HOME, '.config'), 'edwin');
  STATE_DIR = join(env('XDG_STATE_HOME') || join(HOME, '.local/state'), 'edwin');
}
readDirs();

/* ---------- files: line ends and the byte order mark are kept per file ---------- */
const shapes = new Map<string, { crlf: boolean; bom: boolean }>();   // absolute path -> { crlf, bom }
function read(name: string) {
  const p = resolve(name);
  let t = N.readFile(p);
  if (t === null) return null;
  const bom = t.charCodeAt(0) === 0xfeff;
  if (bom) t = t.slice(1);
  const crlf = t.includes('\r\n') && !/(^|[^\r])\n/.test(t);
  if (crlf) t = t.replace(/\r\n/g, '\n');
  shapes.set(p, { crlf, bom });
  return t;
}
function write(name: string, text: string) {
  const p = resolve(name), sh = shapes.get(p) || { crlf: false, bom: false };
  let t = String(text);
  if (sh.crlf) t = t.replace(/\n/g, '\r\n');
  if (sh.bom) t = '﻿' + t;
  N.writeFile(p, t);
  listCache = null;
}
/* The files completion offers: those under CWD, breadth first, without hidden and build directories, at
   most LIST_MAX of them; listed again when asked after LIST_TTL. */
const LIST_MAX = 5000, LIST_TTL = 3000, SKIP = new Set(['node_modules', 'target', 'result', '__pycache__', 'dist', 'build']);
let listCache: string[] | null = null, listAt = 0;
function list() {
  const now = N.now();
  if (listCache && now - listAt < LIST_TTL) return listCache;
  const out: string[] = [], queue = [''];
  while (queue.length && out.length < LIST_MAX) {
    const rel = queue.shift();
    let ents: [name: string, dir: boolean][];
    try { ents = N.readDir(join(CWD, rel || '.')); } catch (e) { continue; }
    ents.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, dir] of ents) {
      if (name.startsWith('.')) continue;
      const r = rel ? rel + '/' + name : name;
      if (dir) { if (!SKIP.has(name)) queue.push(r); } else if (out.length < LIST_MAX) out.push(r);
    }
  }
  listCache = out; listAt = now;
  return out;
}
/* How a path is shown and offered: relative under CWD, ~/... under the home directory, else absolute. */
function label(p: string) {
  const a = String(p);
  if (a.startsWith(CWD === '/' ? '/' : CWD + '/')) return a.slice(CWD === '/' ? 1 : CWD.length + 1);
  if (HOME !== '/' && a.startsWith(HOME + '/')) return '~/' + a.slice(HOME.length + 1);
  return a;
}
const files: EdHostFiles = { read, write, remove: name => { N.remove(resolve(name)); listCache = null; }, list, resolve, label, truename, exists: name => N.stat(resolve(name)) !== null, get cwd() { return CWD; } };

/* ---------- storage ---------- */
function jsonStorage(file: string): EdHostStorage & { flush(): void } {
  let map = new Map<string, string>(), timer: number | null = null;
  try { const t = N.readFile(file); if (t) map = new Map(Object.entries(JSON.parse(t))); } catch (e) { console.error('storage: ' + e.message); }
  const flush = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    try { N.mkdirs(dirname(file)); N.writeFile(file, JSON.stringify(Object.fromEntries(map))); } catch (e) { console.error('storage: ' + e.message); }
  };
  const later = () => { if (timer === null) timer = setTimeout(flush, 2000); };
  return {
    get: k => (map.has(k) ? map.get(k)! : null),
    set: (k, v) => { map.set(k, String(v)); later(); return true; },
    remove: k => { if (map.delete(k)) later(); },
    keys: () => [...map.keys()],
    flush,
  };
}

/* The storage the core holds: in memory until init() opens the state file behind it. */
function deferredStorage(): EdHostStorage & { flush(): void; open(file: string): void } {
  let inner: EdHostStorage & { flush(): void } | null = null;
  const mem = new Map<string, string>();
  const use = () => inner;
  return {
    get: k => (use() ? inner!.get(k) : (mem.has(k) ? mem.get(k)! : null)),
    set: (k, v) => { if (use()) return inner!.set(k, v); mem.set(k, String(v)); return true; },
    remove: k => { if (use()) inner!.remove(k); else mem.delete(k); },
    keys: () => (use() ? inner!.keys() : [...mem.keys()]),
    flush: () => { if (inner) inner.flush(); },
    open(file) { inner = jsonStorage(file); },
  };
}

function createHost(opts: { storage?: EdHostStorage; dark?: boolean } = {}): EdHost {
  const attrs = new Map<string, unknown>(), vars = new Map<string, string>(), suspend: (() => void)[] = [];
  const storage = opts.storage || deferredStorage();
  const tryRead = (p: string) => { try { return read(p); } catch (e) { return null; } };
  const host: EdHost = {
    kind: 'native', headless: true,
    storage, files,
    config: name => (Object.prototype.hasOwnProperty.call(globalThis.__scm, name) ? globalThis.__scm[name] : null),
    userConfig: name => tryRead(join(CONFIG_DIR, name)),
    readFile: p => tryRead(p),
    page: {
      getAttr: name => attrs.get(name),
      setAttr: (name, v) => { if (v === undefined || v === null) attrs.delete(name); else attrs.set(name, v); },
      getVar: name => vars.get(name) ?? '',
      setVar: (name, v) => { vars.set(name, String(v)); },
      prefersDark: () => opts.dark !== false,
      addStyle() {}, onResize() {}, onMedia() {}, onFontsLoaded() {},
    },
    onSuspend(f) { suspend.push(f); },
    suspend() { for (const f of suspend) { try { f(); } catch (e) { console.error(e); } } if (storage.flush) storage.flush(); },
    whenLoaded(f) { f(); },
    /* The clipboard: kept here, and sent to the terminal (OSC 52) by whoever sets onClipboard. */
    clipboard: '', onClipboard: null,
    setClipboard(s) { this.clipboard = String(s); if (this.onClipboard) this.onClipboard(this.clipboard); },
    openUrl: () => false,
    onCspViolation() {},
    idle: f => setTimeout(f, 0),
    nextFrame: f => setTimeout(f, 0),
    workers: false,
    get dirs() { return { home: HOME, cwd: CWD, config: CONFIG_DIR, state: STATE_DIR }; },
    get loadPath() { return [join(CONFIG_DIR, 'lisp')]; },
    /* The program has started: its directories, its storage file. */
    init() {
      readDirs(); shapes.clear(); listCache = null;
      if (storage.open) storage.open(join(STATE_DIR, 'storage.json'));
    },
  };
  return host;
}

globalThis.EdNativeHost = { createHost, resolve, truename, label, env, join, dirname, get HOME() { return HOME; }, get CWD() { return CWD; } };
})();
