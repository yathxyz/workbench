/* The browser host: what Edwin's core needs from a web page, in one place (R4.1).
   It loads before the core files. The core reaches the page only through globalThis.EdHost and through
   the frame objects it draws into (Ed.makeFrame); the Node host (host-node.js) provides the same names.

   storage   string key-value store: localStorage, in memory when it is unavailable
   config    the shipped Scheme files, read from the page's <script type="text/x-scheme"> blocks
   page      page-level presentation: the theme and other data attributes on <html>, CSS variables,
             style sheets, viewport and font events
   lifecycle onSuspend (the page is hidden or closed: flush what must persist), whenLoaded
   misc      clipboard, opening a link, scheduling (idle, next frame), CSP reports */
(function () {
'use strict';
const doc = document, root = doc.documentElement;
const mem = new Map();
const storage = {
  get(k) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* in memory only */ } return mem.has(k) ? mem.get(k) : null; },
  set(k, v) { v = String(v); mem.set(k, v); try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  remove(k) { mem.delete(k); try { localStorage.removeItem(k); } catch (e) { /* in memory only */ } },
  keys() {
    const s = new Set(mem.keys());
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) s.add(k); } } catch (e) { /* in memory only */ }
    return [...s];
  },
};
/* The Scheme blocks are named after their files: emacs.scm is <script id="emacs-scm">. */
function config(name) { const el = doc.getElementById(name.replace(/\.scm$/, '-scm')); return el ? el.textContent.replace(/^\n/, '') : null; }
const camel = name => name.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
const page = {
  getAttr(name) { return root.dataset[camel(name)]; },
  setAttr(name, v) { const k = camel(name); if (v === undefined || v === null) delete root.dataset[k]; else if (root.dataset[k] !== v) root.dataset[k] = v; },
  getVar(name) { return root.style.getPropertyValue('--' + name); },
  setVar(name, v) { root.style.setProperty('--' + name, String(v)); },
  prefersDark() { return !!(globalThis.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); },
  addStyle(id, css) { if (doc.getElementById(id)) return; const st = doc.createElement('style'); st.id = id; st.textContent = css; doc.head.appendChild(st); },
  onResize(f) { addEventListener('resize', f); },
  onMedia(query, f) {
    const m = globalThis.matchMedia ? matchMedia(query) : null;
    if (m && m.addEventListener) m.addEventListener('change', f); else if (m && m.addListener) m.addListener(f);
  },
  onFontsLoaded(f) { if (doc.fonts && doc.fonts.addEventListener) doc.fonts.addEventListener('loadingdone', f); },
};
globalThis.EdHost = {
  kind: 'browser', headless: false, storage, config, page,
  userConfig: () => null,
  readFile: () => null,
  loadPath: [],
  onSuspend(f) { addEventListener('pagehide', f); doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') f(); }); },
  whenLoaded(f) { if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', f); else f(); },
  setClipboard(s) { try { navigator.clipboard?.writeText(s).catch(() => {}); } catch (e) { /* not allowed here */ } },
  openUrl(url) { try { return !!open(url, '_blank', 'noopener'); } catch (e) { return false; } },
  onCspViolation(f) { doc.addEventListener('securitypolicyviolation', f); },
  idle: globalThis.requestIdleCallback ? f => requestIdleCallback(f, { timeout: 1000 }) : f => setTimeout(f, 50),
  nextFrame: f => requestAnimationFrame(f),
};
})();
