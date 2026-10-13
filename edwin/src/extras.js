/* Editing extras that need the display or the key queue: avy jumps, pulse after a jump,
   electric pairs, fill-paragraph, centered view, bookmarks, the save hook, face colours. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, truthy, listOf, arr, NIL } = L;
const { D, CMD } = L;
const cur = () => E.current;
const { bol, eol, lineNo } = Ed;
const str = x => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x; };

L.defvar('fill-column', 70, 'Column at which fill-paragraph wraps.');
L.defvar('avy-keys', 'asdfghjklqwertyuiopzxcvbnm', 'Letters used for avy labels, in order of preference.');
L.defvar('before-save-hook', NIL, 'Procedures called before a buffer is saved.');
L.defvar('ws-butler-mode', true, 'Non-#f removes trailing blanks from Scheme buffers when they are saved.');

/* ---------- avy: jump to a visible place by typing its label ---------- */
function visibleRange(w) {
  const b = w.buffer, t = b.rope;
  const lastLs = Ed.lineStartB(b, Math.max(1, w.lastLine || Ed.lineNoB(b, w.start)));
  return [w.start, eol(t, lastLs)];
}
function labelsFor(n) {
  const keys = String(L.get('avy-keys') || 'asdfghjkl');
  if (n <= keys.length) return [...keys].slice(0, n);
  const out = [];
  const single = Math.max(0, keys.length - Math.ceil((n - keys.length) / (keys.length - 1)));
  for (let i = 0; i < single && out.length < n; i++) out.push(keys[i]);
  for (let i = single; i < keys.length && out.length < n; i++) for (let j = 0; j < keys.length && out.length < n; j++) out.push(keys[i] + keys[j]);
  return out;
}
async function avyPick(positions, w) {
  if (!positions.length) signal('user-error', 'No matches on screen');
  if (positions.length === 1) return positions[0];
  const labels = labelsFor(positions.length);
  let live = positions.map((p, i) => ({ p, label: labels[i] }));
  let typed = '';
  try {
    for (;;) {
      E.avy = { win: w, labels: new Map(live.map(x => [x.p, x.label.slice(typed.length)])) };
      const k = await Ed.nextKey();
      if (k === 'ESC' || k === 'C-g') Ed.quietQuit();
      const ch = Ed.keyChar(k);
      if (!ch) continue;
      typed += ch;
      live = live.filter(x => x.label.startsWith(typed));
      if (!live.length) signal('user-error', 'No match for ' + typed);
      if (live.length === 1 || live.every(x => x.label === typed)) return live[0].p;
    }
  } finally { E.avy = null; }
}
function jumpTo(p) { const b = cur(); EC.pushJump(b, b.pt); b.pt = p; pulse(b); }
function pulse(b) { E.pulse = { b, ls: bol(b.rope, b.pt), t: Date.now() }; setTimeout(() => { if (E.pulse && Date.now() - E.pulse.t >= 350) { E.pulse = null; Ed.render(); } }, 400); }
CMD('avy-goto-char', async () => [await Ed.readChar('char: ')], 'char', 'Jump to a visible occurrence of CHAR, chosen by its label (SPC a).', async ([c]) => {
  const b = cur(), w = E.sel, [s, e] = visibleRange(w), ch = L.chr(c).toLowerCase(), t = b.rope, out = [];
  for (let k = s; k <= e && k < t.length; k++) if (t.at(k).toLowerCase() === ch) out.push(k);
  jumpTo(await avyPick(out, w)); return false;
});
CMD('avy-goto-char-2', async () => { const a = await Ed.readChar('char 1: '); const b = await Ed.readChar('char 2: '); return [a, b]; }, 'c1 c2', 'Jump to a visible pair of characters.', async ([c1, c2]) => {
  const b = cur(), w = E.sel, [s, e] = visibleRange(w), pair = (L.chr(c1) + L.chr(c2)).toLowerCase(), t = b.rope.toLowerCase(), out = [];
  for (let k = t.indexOf(pair, s); k >= 0 && k <= e; k = t.indexOf(pair, k + 1)) out.push(k);
  jumpTo(await avyPick(out, w)); return false;
});
CMD('avy-goto-line', '', '', 'Jump to a visible line, chosen by its label (SPC l).', async () => {
  const b = cur(), w = E.sel, [s, e] = visibleRange(w), t = b.rope, out = [];
  for (let ls = bol(t, s); ls <= e; ) { out.push(ls); const le = eol(t, ls); if (le >= t.length) break; ls = le + 1; }
  const p = await avyPick(out, w); jumpTo(EC.firstNonBlank(b.rope, p)); return false;
});
CMD('avy-goto-symbol-1', async () => [await Ed.readChar('char: ')], 'char', 'Jump to a visible symbol that starts with CHAR (SPC s).', async ([c]) => {
  const b = cur(), w = E.sel, [s, e] = visibleRange(w), ch = L.chr(c).toLowerCase(), t = b.rope, out = [];
  const sym = /[\p{L}\p{N}_\-!?*<>=+\/]/u;
  for (let k = s; k <= e && k < t.length; k++) if (t.at(k).toLowerCase() === ch && (k === 0 || !sym.test(t.at(k - 1)))) out.push(k);
  jumpTo(await avyPick(out, w)); return false;
});
CMD('avy-goto-word-1', async () => [await Ed.readChar('char: ')], 'char', 'Jump to a visible word that starts with CHAR.', async ([c]) => L.call('avy-goto-symbol-1', [c]));
for (const n of ['avy-goto-char', 'avy-goto-char-2', 'avy-goto-line', 'avy-goto-symbol-1', 'avy-goto-word-1']) { L.put(intern(n), 'evil-jump', true); L.put(intern(n), 'evil-repeat', intern('abort')); }
D('pulse-line', '', 'Flash the line at point for a moment.', () => { pulse(cur()); return false; });
for (const n of ['evil-goto-line', 'evil-goto-first-line', 'evil-jump-backward', 'evil-jump-forward', 'evil-search-next', 'evil-search-previous', 'evil-goto-mark', 'evil-goto-mark-line', 'consult-line', 'consult-imenu'])
  L.addHook('post-command-pulse', intern(n));
const prevPost = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost) prevPost(def, b, failed);
  if (failed || E.depth > 0) return;
  const s = L.cmdSym(def);
  if (arr(L.get('post-command-pulse') ?? NIL).includes(s)) pulse(E.current);
};

/* ---------- electric pairs in Insert state ---------- */
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"' };
{
  const sic = L.toFn(intern('self-insert-command'));
  CMD('self-insert-command', sic.interactive, sic.params, sic.doc, ([n]) => {
    const b = cur(), ch = L.chr(L.get('last-command-event'));
    const st = EC.stateOf(b);
    if (truthy(L.get('electric-pair-enabled')) && st !== 'replace' && ch && (ch in PAIRS || ch === ')' || ch === ']' || ch === '}') && !b.readOnly) {
      const next = b.rope.at(b.pt), prev = b.rope.at(b.pt - 1);
      const count = Math.max(1, L.absent(n) ? 1 : n);
      if (count === 1) {
        if ((ch === ')' || ch === ']' || ch === '}') && next === ch) { b.pt++; return false; }
        if (ch === '"' && next === '"' && prev !== '\\') { b.pt++; return false; }
        if (ch in PAIRS && !(ch === '"' && /[\p{L}\p{N}]/u.test(prev || ''))) {
          Ed.insertText(b, ch + PAIRS[ch]); b.pt--; return false;
        }
      }
    }
    return sic([n]);
  });
}
/* The ad hoc toggles are minor modes (R4.25). Each one's state is its -enabled variable. */
Ed.defineMinorMode({ name: 'rainbow-delimiters-mode', global: true, init: true, pretty: 'Rainbow delimiters', doc: 'Toggle colouring parentheses by depth in Scheme buffers. The state is rainbow-delimiters-enabled.' });
Ed.defineMinorMode({ name: 'electric-pair-mode', global: true, init: true, pretty: 'Electric pairs', doc: 'Toggle inserting the closing bracket or quote when you type the opening one. The state is electric-pair-enabled.' });
D('electric-pair-delete', '', 'Delete the pair around point when it is empty, as DEL does with electric pairs. Return #t if it did.', () => {
  const b = cur(), prev = b.rope.at(b.pt - 1), next = b.rope.at(b.pt);
  if (truthy(L.get('electric-pair-enabled')) && prev in PAIRS && PAIRS[prev] === next && !b.readOnly && !b.markActive) { Ed.deleteText(b, b.pt - 1, b.pt + 1); return true; }
  return false;
});

/* ---------- paragraphs, centred view, bookmarks ---------- */
CMD('fill-paragraph', '*', '', 'Re-wrap the paragraph at point to fill-column (SPC y w).', () => {
  const b = cur(), t = b.rope, width = Number(L.get('fill-column')) || 70;
  let s = bol(t, b.pt), e = eol(t, b.pt);
  if (/^\s*$/.test(t.slice(s, e))) return false;
  while (s > 0) { const ps = bol(t, s - 1); if (/^\s*$/.test(t.slice(ps, s - 1))) break; s = ps; }
  while (e < t.length) { const ne = eol(t, e + 1); if (/^\s*$/.test(t.slice(e + 1, ne))) break; e = ne; }
  const para = t.slice(s, e);
  const indent = (para.match(/^[ \t]*/) || [''])[0];
  const prefix = (para.match(/^[ \t]*((?:;+|#+|\/\/+|>)\s?)/) || ['', ''])[1];
  const words = para.split('\n').map(l => l.replace(/^[ \t]*/, '').replace(prefix ? new RegExp('^' + prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s?') : /$^/, '')).join(' ').split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const w of words) {
    if (line && (indent + prefix + line + ' ' + w).length > width) { lines.push(indent + prefix + line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(indent + prefix + line);
  const out = lines.join('\n');
  if (out !== para) { Ed.replaceText(b, s, e, out); b.pt = Math.min(b.pt, s + out.length); }
  return false;
});
L.defvar('centered-view-width', 100, 'Columns of text that centered-view-mode centres in the window (yath/centered-view-width).');
Ed.defineMinorMode({ name: 'centered-view-mode', pretty: 'Centered view', doc: 'Toggle centring this buffer’s text in a column of centered-view-width characters (SPC y c). The state is centered-view-enabled.',
  body: () => Ed.host.page.setVar('center-cols', String(Math.max(20, Number(L.get('centered-view-width')) || 100))) });
/* visual-line-mode is per buffer, as in Emacs: the buffer wraps whatever truncate-lines says, and j and k
   move by screen lines when evil-respect-visual-line-mode is on (init.scm binds them to the -visual-line motions). */
Ed.defineMinorMode({ name: 'visual-line-mode', lighter: ' Wrap', pretty: 'Visual-Line mode', doc: 'Toggle Visual Line mode in this buffer: long lines wrap and j and k move by screen lines (SPC y v). The state is visual-line-enabled.' });
const VERT = ['evil-next-line', 'evil-previous-line', 'evil-next-visual-line', 'evil-previous-visual-line'];
/* Move by screen rows using the rendered lines: the row below or above the cursor at the same x, kept
   as a goal across consecutive j and k. Rows that are not on screen fall back to buffer lines. */
D('evil--visual-line-move', 'COUNT', 'Move COUNT screen lines down (up if COUNT is negative) in a visual-line-mode buffer, keeping the x position; #f when this buffer is not in visual-line-mode.', ([n]) => {
  const b = cur(), w = E.sel, c = Number(n) || 0;
  if (!truthy(Ed.localValue(b, 'visual-line-enabled')) || !w || w.buffer !== b || !w.view) return false;
  const last = E.lastCommand instanceof L.Sym ? E.lastCommand.name : '';
  if (!VERT.includes(last)) E.goalX = null;
  const st = EC.stateOf(b), dir = c > 0 ? 1 : -1, t = b.rope;
  const rest = k => L.call('evil--line-move', [dir * (Math.abs(c) - k)]);
  for (let k = 0; k < Math.abs(c); k++) {
    Ed.render();
    const el = w.view.querySelector('.cur');
    if (!el) { rest(k); break; }
    const r = el.getBoundingClientRect(), lh = Ed.metrics(w).lh, vr = w.view.getBoundingClientRect();
    if (E.goalX === null || E.goalX === undefined) E.goalX = r.left + 1;
    const y = dir > 0 ? r.bottom + lh / 2 : r.top - lh / 2;
    if (y < vr.top || y > vr.bottom) { rest(k); break; }
    let q = Ed.posFromPoint(E.goalX, y, w);
    if (q === null) { rest(k); break; }
    const ls = bol(t, q), le = eol(t, q);
    if ((st === 'normal' || st === 'motion') && q >= le && le > ls) q = le - 1;
    if (q === b.pt) { rest(k); break; }
    b.pt = q;
  }
  L.set('evil-this-type', intern('exclusive'));
  return true;
});
Ed.defineMinorMode({ name: 'auto-fill-mode', lighter: ' Fill', pretty: 'Auto fill', doc: 'Toggle wrapping as you type past fill-column (SPC y a). The state is auto-fill-enabled.' });
const prevPost2 = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost2) prevPost2(def, b, failed);
  if (failed || E.depth > 0 || !truthy(Ed.localValue(E.current, 'auto-fill-enabled'))) return;
  if (L.cmdSym(def) === intern('self-insert-command') && L.chr(L.get('last-command-event')) === ' ') {
    const buf = E.current, t = buf.rope, ls = bol(t, buf.pt);
    if (Ed.column(t, buf.pt) > (Number(L.get('fill-column')) || 70)) {
      let k = buf.pt - 1; while (k > ls && t.at(k) === ' ') k--;
      while (k > ls && t.at(k) !== ' ') k--;
      if (k > ls) { Ed.replaceText(buf, k, k + 1, '\n'); }
    }
  }
};
const BM = 'edwin:bookmarks';
function bookmarks() { try { return JSON.parse(Ed.host.storage.get(BM) || '{}'); } catch (e) { return E.bookmarks || {}; } }
function saveBookmarks(m) { E.bookmarks = m; try { Ed.host.storage.set(BM, JSON.stringify(m)); } catch (e) { /* in memory only */ } }
CMD('bookmark-set', async () => [await Ed.readMini('Bookmark name: ', '', () => Object.keys(bookmarks()), { kind: 'bookmark', def: cur().name })], 'name', 'Remember this place under NAME (SPC b m).', ([name]) => {
  const b = cur(), m = bookmarks(); m[name] = { buffer: b.name, file: b.file, pt: b.pt }; saveBookmarks(m); Ed.message(`Set bookmark ${name}`); return false;
});
CMD('bookmark-jump', async () => [await Ed.readMini('Jump to bookmark: ', '', () => Object.keys(bookmarks()), { kind: 'bookmark', require: true, annotate: n => { const x = bookmarks()[n]; return x ? `${x.file || x.buffer} L${x.pt}` : ''; } })], 'name', 'Go to the bookmark NAME (SPC RET).', ([name]) => {
  const x = bookmarks()[name]; if (!x) signal('user-error', `No bookmark named ${name}`);
  let b = Ed.getBuffer(x.buffer) || (x.file ? L.call('find-file', [x.file]) : null);
  if (!b) signal('user-error', `The buffer of bookmark ${name} is gone`);
  if (b instanceof Ed.Buffer) Ed.setWindowBuffer(b); b = E.win;
  b.pt = Math.min(x.pt, b.rope.length); pulse(b); return false;
});
CMD('bookmark-delete', async () => [await Ed.readMini('Delete bookmark: ', '', () => Object.keys(bookmarks()), { kind: 'bookmark', require: true })], 'name', 'Forget the bookmark NAME.', ([name]) => { const m = bookmarks(); delete m[name]; saveBookmarks(m); return false; });

/* ---------- saving: before-save-hook and trailing whitespace ---------- */
{
  const save = L.toFn(intern('save-buffer'));
  CMD('save-buffer', save.interactive, save.params, save.doc, args => {
    const b = cur();
    if (truthy(L.get('ws-butler-mode')) && Ed.isLisp(b) && /[ \t]+$/m.test(b.text)) { const pt = b.pt, before = b.rope.length; const t = b.rope.replace(/[ \t]+$/gm, ''); Ed.replaceText(b, 0, b.rope.length, t); b.pt = Math.min(pt, b.rope.length); void before; }
    L.runHook('before-save-hook');
    return save(args);
  });
}

/* ---------- faces: colours and fonts are CSS variables ---------- */
D('set-face-color!', 'face color', 'Set the colour of FACE: bg fg dim cursor region kw fn st cm co pa or any CSS token name.', ([f, c]) => { Ed.host.page.setVar(f instanceof L.Sym ? f.name : str(f), str(c)); return false; });
D('set-font-size!', 'px', 'Set the text size in pixels.', ([n]) => { for (const f of E.frames) for (const v of f.root.querySelectorAll('.text')) v.style.fontSize = n + 'px'; Ed.host.page.setVar('text-size', n + 'px'); E.metricsGen++; return false; });
D('set-font-family!', 'family', 'Set the text font family.', ([f]) => { Ed.host.page.setVar('font-mono', str(f) + ', ' + 'ui-monospace, monospace'); E.metricsGen++; return false; });
D('theme-dark?', '', '#t when the page shows the dark theme.', () => { const t = Ed.host.page.getAttr('theme'); return t === 'dark' || (t !== 'light' && Ed.host.page.prefersDark()); });
})();
