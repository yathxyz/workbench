/* In-buffer completion, as corfu with cape does: a popup at point listing words from the open
   buffers (cape-dabbrev), in Scheme buffers the global names, and for a word that looks like a
   path the saved file names (cape-file). It opens on TAB, and by itself after a few characters
   of a word. */
(function () {
'use strict';
const L = window.L, Ed = window.Ed, E = Ed.E, H = Ed.hooks, EC = window.EvilCore;
const { intern, signal, truthy } = L;
const { D, CMD } = L;
const cur = () => E.current;

L.defvar('corfu-auto', true, 'Non-#f opens the completion popup by itself while typing.');
L.defvar('corfu-auto-prefix', 3, 'How many word characters are typed before the popup opens by itself.');
L.defvar('corfu-count', 10, 'How many candidates the popup shows at once.');
const SYM = /[\p{L}\p{N}_\-!?*<>=+\/.:]/u;
const WORD = /[\p{L}\p{N}_]/u;
function symbolChar(b) { return Ed.isLisp(b) ? SYM : WORD; }
/* cape-file: a word with a / in it, or starting with ~ or ., names a file. A link type or key
   before it ([[file:roam/, path=roam/) is not part of the path. */
const PATH = /[^\s"'()\[\]{}<>`]/u;
function pathPrefixAt(b) {
  const t = b.rope;
  let s = b.pt;
  while (s > 0 && PATH.test(t.at(s - 1))) s--;
  let text = t.slice(s, b.pt);
  const k = Math.max(text.lastIndexOf(':'), text.lastIndexOf('='));
  if (k >= 0) { s += k + 1; text = text.slice(k + 1); }
  return text && /\/|^[~.]/.test(text) && !/^\.{1,2}$/.test(text) ? { start: s, text, file: true } : null;
}
function wordPrefixAt(b) {
  const t = b.rope, re = symbolChar(b);
  let s = b.pt;
  while (s > 0 && re.test(t.at(s - 1))) s--;
  return s < b.pt ? { start: s, text: t.slice(s, b.pt) } : null;
}
function prefixAt(b) { return pathPrefixAt(b) || wordPrefixAt(b); }
/* The prefix and its candidates, as the capfs run on the desktop: cape-file first, and when it has
   nothing (no saved file under that folder, as with call/c or foo/ba) cape-dabbrev and the global
   names on the word before point. MIN is the shortest prefix to complete. */
function completionAt(b, min) {
  const p = pathPrefixAt(b);
  if (p && p.text.length >= min) { const cs = fileCandidates(p.text); if (cs.length) return { p, cs }; }
  const w = wordPrefixAt(b);
  if (w && w.text.length >= min) { const cs = candidates(b, w.text); if (cs.length) return { p: w, cs }; }
  return null;
}
/* Saved files that start with the path typed (a leading ./ or ~/ is dropped: the store has no directories). */
function fileCandidates(text) {
  const bare = text.replace(/^(\.\/|~\/)/, ''), lower = bare.toLowerCase(), out = [];
  for (const f of Ed.Store.list()) if (f !== bare && f.toLowerCase().startsWith(lower)) out.push({ text: f, score: 0, ann: 'file' });
  return out.slice(0, 200);
}
/* Words near point (a small window around it) score best; then words of this buffer, then of the
   others, from per-buffer indexes refreshed in the background after edits. */
const SCAN = 4000;
function scanWords(t, re, into, from, to) {
  const rx = new RegExp(re.source + '{3,}', 'gu'); rx.lastIndex = from || 0;
  let m; const end = to === undefined ? t.length : to;
  while ((m = rx.exec(t)) && m.index < end && into.size < 50000) into.add(m[0]);
  return into;
}
/* The words near point, in three parts: the text before the line of point, the line itself and the
   text after it. Typing changes only the line, so the two other parts are scanned again only when
   their text changed (a word never spans a line break, so the union is the same). */
const near = { b: null, re: null, before: '', after: '', bw: null, aw: null };
function nearWords(b, re) {
  const r = b.rope, ls = Ed.bol(r, b.pt), le = Ed.eol(r, b.pt);
  const a = Ed.bol(r, Math.max(0, b.pt - SCAN)), z = Ed.eol(r, Math.min(r.length, b.pt + SCAN));
  const before = r.slice(a, ls), after = r.slice(le, z);
  if (near.b !== b || near.re !== re) { near.b = b; near.re = re; near.bw = near.aw = null; }
  if (near.bw === null || near.before !== before) { near.before = before; near.bw = scanWords(before, re, new Set()); }
  if (near.aw === null || near.after !== after) { near.after = after; near.aw = scanWords(after, re, new Set()); }
  const out = new Set(near.bw);
  scanWords(r.slice(ls, le), re, out);
  for (const w of near.aw) out.add(w);
  return out;
}
/* The global names with their lowercase forms, extended as names are defined (they are never removed). */
const gnames = [];
function globalNames() {
  const g = L.S.globals;
  if (gnames.length !== g.size) { let i = 0; for (const [n, box] of g) { if (i++ < gnames.length) continue; gnames.push([n, n.toLowerCase(), box]); } }
  return gnames;
}
/* The index of each buffer comes from the worker pool (pool.js): sorted, so a prefix is a binary
   search instead of a pass over every word of every buffer. */
const P = window.EdPool;
function candidates(b, prefix) {
  const lower = prefix.toLowerCase(), out = [], re = symbolChar(b);
  const seen = new Map();
  for (const w of nearWords(b, re)) seen.set(w, 0);
  for (const buf of E.buffers) {
    if (buf.name.startsWith(' ')) continue;
    const d = buf === b ? 1 : 1e9;
    P.wordsWithPrefix(P.wordsIn(buf, symbolChar(buf).source), lower, w => { if (!seen.has(w)) seen.set(w, d); });
  }
  for (const [w, d] of seen) if (w !== prefix && w.toLowerCase().startsWith(lower)) out.push({ text: w, score: d, ann: '' });
  if (Ed.isLisp(b)) {
    for (const [n, nl, box] of globalNames()) {
      if (n === prefix || !nl.startsWith(lower)) continue;
      let v; try { v = box.value; } catch (e) { continue; }
      if (v === undefined) continue;
      const ann = typeof v === 'function' ? (v.interactive !== undefined ? 'command ' : 'proc ') + (v.doc ? v.doc.split('\n')[0] : '') : 'var ' + (L.S.gdoc.get(n) ? L.S.gdoc.get(n).split('\n')[0] : '');
      const k = out.findIndex(c => c.text === n);
      if (k >= 0) out[k].ann = ann; else out.push({ text: n, score: 5e8, ann });
    }
    for (const n of L.S.macros.keys()) if (n.toLowerCase().startsWith(lower) && n !== prefix && !out.some(c => c.text === n)) out.push({ text: n, score: 5e8, ann: 'macro' });
  }
  out.sort((a, b) => a.score - b.score || (a.text < b.text ? -1 : 1));
  return out.slice(0, 200);
}
function open(b, auto, min) {
  const r = completionAt(b, min || 1);
  if (!r) { close(); return false; }
  E.corfu = { start: r.p.start, prefix: r.p.text, cands: r.cs, index: 0, scroll: 0, auto };
  return true;
}
function close() { E.corfu = null; }
function accept() {
  const c = E.corfu, b = cur();
  if (!c) return;
  const pick = c.cands[c.index];
  Ed.replaceText(b, c.start, b.pt, pick.text); b.pt = c.start + pick.text.length;
  close();
}
CMD('completion-at-point', '*', '', 'Complete the word before point from the open buffers and the global names, or a path from the saved file names (TAB, C-SPC).', () => {
  const b = cur();
  if (E.corfu) { accept(); return false; }
  if (!open(b, false)) signal('user-error', 'No completions');
  if (E.corfu.cands.length === 1) accept();
  return false;
});
CMD('corfu-next', '', '', 'Highlight the next completion.', () => { const c = E.corfu; if (c) c.index = (c.index + 1) % c.cands.length; return false; });
CMD('corfu-previous', '', '', 'Highlight the previous completion.', () => { const c = E.corfu; if (c) c.index = (c.index - 1 + c.cands.length) % c.cands.length; return false; });
CMD('corfu-insert', '', '', 'Insert the highlighted completion.', () => { accept(); return false; });
CMD('corfu-quit', '', '', 'Close the completion popup.', () => { close(); return false; });

/* Keys while the popup is open. Other keys close it and are handled as usual. */
const prevBeforeKey = H.beforeKey;
H.beforeKey = async k => {
  if (E.corfu && !E.mini) {
    if (k === 'C-n' || k === '<down>') { await Ed.runCommand(intern('corfu-next'), k); return true; }
    if (k === 'C-p' || k === '<up>') { await Ed.runCommand(intern('corfu-previous'), k); return true; }
    if (k === 'TAB' || k === 'RET') { await Ed.runCommand(intern('corfu-insert'), k); return true; }
    close();
  }
  return prevBeforeKey ? prevBeforeKey(k) : false;
};
const prevPost = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost) prevPost(def, b, failed);
  if (E.depth > 0 || E.mini) return;
  const self = L.cmdSym(def) === intern('self-insert-command');
  const st = EC.stateOf(E.current);
  if (self && truthy(L.get('corfu-auto')) && (st === 'insert' || st === null || st === 'emacs')) {
    open(E.current, true, Number(L.get('corfu-auto-prefix')) || 3);
  }
};
/* The popup itself, placed under the cursor of the selected window. Its rows are rebuilt only when
   the candidates, the highlighted row or the prefix change. It is placed in the next animation
   frame, where the browser lays the page out anyway: measuring the cursor at render time forced
   a layout of the lines that render had just changed. */
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
let placing = false;
function place() {
  placing = false;
  const el = document.getElementById('corfu'), c = E.corfu;
  if (!el || el.hidden || !c || E.mini) return;
  const curEl = E.sel.view.querySelector('.cur'), frame = document.getElementById('frame').getBoundingClientRect();
  if (!curEl) { el.hidden = true; return; }
  const r = curEl.getBoundingClientRect();
  const left = r.left - frame.left - c.prefix.length * (r.width || 8);
  el.style.left = Math.max(8, Math.min(left, frame.width - el.offsetWidth - 8)) + 'px';
  const below = r.bottom - frame.top + 2;
  if (below + el.offsetHeight > frame.height - 40) el.style.top = (r.top - frame.top - el.offsetHeight - 2) + 'px'; else el.style.top = below + 'px';
}
H.renderOverlay = () => {
  let el = document.getElementById('corfu');
  const c = E.corfu;
  if (!c || E.mini) { if (el && !el.hidden) el.hidden = true; return; }
  if (!el) { el = document.createElement('div'); el.id = 'corfu'; document.getElementById('frame').appendChild(el); }
  const N = Math.max(3, Number(L.get('corfu-count')) || 10);
  if (c.index < c.scroll) c.scroll = c.index; if (c.index >= c.scroll + N) c.scroll = c.index - N + 1;
  const key = c.scroll + ' ' + c.index + ' ' + N + ' ' + c.prefix;
  if (el._cands !== c.cands || el._key !== key) {
    el.innerHTML = c.cands.slice(c.scroll, c.scroll + N).map((x, i) => `<div class="cand${i + c.scroll === c.index ? ' sel' : ''}"><span class="cl"><b>${esc(x.text.slice(0, c.prefix.length))}</b>${esc(x.text.slice(c.prefix.length))}</span>${x.ann ? `<span class="ca">${esc(x.ann)}</span>` : ''}</div>`).join('');
    el._cands = c.cands; el._key = key;
  }
  if (!E.sel.view.querySelector('.cur')) { el.hidden = true; return; }
  el.hidden = false;
  /* Inside a frame callback (a wheel scroll, a resize) a new animation frame is the next one, and
     this frame would paint the popup where the text was: place it now, the layout is due anyway. */
  if (E.inFrame) place();
  else if (!placing) { placing = true; requestAnimationFrame(place); }
};
window.Complete = { open, close, accept, prefixAt, fileCandidates };
})();
