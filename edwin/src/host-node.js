/* The Node host: the same names as host-browser.js (R4.1), for Edwin's core with no page at all. edwind
   runs the core with it, and so do the headless tests.

   The core files are classic scripts that keep their state in globals, so loadEdwin runs them in this
   process's global scope, once per process. With no page the core is headless: redisplay is skipped and
   no frame exists; buffers, keymaps, the command loop, Evil, ex, Org, Scheme and undo run unchanged.

   Storage is in memory unless a store is passed in. config reads the shipped Scheme from scm/;
   userConfig and readFile read the user's files (CONFIG_DIR/init.scm, and files for load and require). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = __dirname;
const ROOT = path.join(SRC, '..');
/* The core, in load order: the order of the script tags in index.html. */
const FILES = ['scheme', 'runtime', 'text', 'editor-core', 'editor-prims', 'evil-core', 'pool', 'complete', 'extras', 'stack', 'ai', 'evil-ex', 'org'];

function memoryStorage(map = new Map()) {
  return {
    get: k => (map.has(k) ? map.get(k) : null),
    set: (k, v) => { map.set(k, String(v)); return true; },
    remove: k => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

function createHost(opts = {}) {
  const scmDir = opts.scmDir || path.join(ROOT, 'scm');
  const configDir = opts.configDir || null;
  const attrs = new Map(), vars = new Map(), suspend = [];
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
  };
}

/* Run the core files in this process with HOST, and give back Ed. Ed.boot({host}) starts it. */
function loadEdwin(host = createHost()) {
  if (globalThis.Ed) throw new Error('Edwin is already loaded in this process');
  globalThis.EdHost = host;
  for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(SRC, f + '.js'), 'utf8'), { filename: path.join(SRC, f + '.js') });
  return globalThis.Ed;
}

module.exports = { FILES, createHost, memoryStorage, loadEdwin };
