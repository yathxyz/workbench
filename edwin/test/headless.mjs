// Load Edwin's core in Node with no browser, feed it keys, and read the buffers back.
//
// This is step E0's safety net. The browser files are loaded as they are, in the order index.html loads them,
// with a stand-in for the few page objects they touch at load time. Each stand-in that remains marks a place
// where the core still reaches into the page; E0 removes them one by one, with this test proving that the
// editing behaviour stays the same.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = ['scheme', 'runtime', 'text', 'editor-core', 'editor-prims', 'evil-core', 'pool', 'complete', 'extras', 'stack', 'ai', 'evil-ex', 'org'];
const SCM = { 'emacs-scm': 'emacs', 'evil-scm': 'evil', 'ai-scm': 'ai', 'init-scm': 'init', 'org-scm': 'org' };

// The page stand-in: every element is an inert object that accepts any property, call or child.
export const touched = new Map();
function inert(name) {
  const fn = function () { return inert(name + '()'); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k in t && typeof k === 'symbol') return t[k];
      if (k === 'textContent' || k === 'value' || k === 'innerHTML' || k === 'className') return '';
      if (k === 'length' || k === 'offsetWidth' || k === 'offsetHeight' || k === 'scrollTop') return 0;
      return inert(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return inert(name + '()'); },
    construct() { return inert('new ' + name); },
  });
}
function note(what) { touched.set(what, (touched.get(what) || 0) + 1); }

export function loadEdwin() {
  const g = globalThis;
  const store = new Map();
  g.window = g; g.self = g; g.EDWIN_HEADLESS = true;
  g.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
  g.requestAnimationFrame = f => setTimeout(() => f(Date.now()), 0);
  g.addEventListener = type => note('window.addEventListener(' + type + ')');
  g.removeEventListener = () => {};
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.document = new Proxy({}, {
    get(_, k) {
      if (k === 'getElementById') return id => {
        note('getElementById(' + id + ')');
        if (SCM[id]) return { textContent: '\n' + readFileSync(join(ROOT, 'scm', SCM[id] + '.scm'), 'utf8') };
        return inert('#' + id);
      };
      if (k === 'readyState') return 'complete';
      if (k === 'fonts') return undefined;
      if (k === 'visibilityState') return 'visible';
      note('document.' + String(k));
      return inert('document.' + String(k));
    },
  });
  for (const f of FILES) vm.runInThisContext(readFileSync(join(ROOT, 'src', f + '.js'), 'utf8'), { filename: f + '.js' });
  return g.Ed;
}

// Load Edwin (the last file boots it and starts the command loop) and give back a driver.
export async function startEdwin() {
  const Ed = loadEdwin();
  await Ed.whenIdle();
  return {
    Ed, E: Ed.E,
    async keys(s) { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await Ed.whenIdle(); },
    async type(s) { for (const ch of s) Ed.feedKey(ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch); await Ed.whenIdle(); },
    text: () => Ed.E.current.text,
    point: () => Ed.E.current.pt,
  };
}
