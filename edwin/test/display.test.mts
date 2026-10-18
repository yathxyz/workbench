// The display seam (DT0): model frames drawn on a cell grid for a backend that is not a page (src/display.ts).
// A fake backend records each model; the faces and the palette are checked against the stylesheets they mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHost, loadEdwin } from './headless.mts';
import type { Edwin } from './headless.mts';

type Globals = typeof globalThis & { L: Edwin };
/* The model a model frame hands its backend (src/display.ts). */
interface Face { fg?: string; bg?: string; weight?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; box?: boolean }
interface Segment { x: number; w: number; text: string; f: number }
interface Model {
  cols: number; rows: number; theme: 'light' | 'dark'; focused: boolean; title: string;
  faces: Face[]; lines: Segment[][];
  cursor: { x: number; y: number; shape: 'box' | 'bar' | 'hbar' | 'half' | 'hollow'; color: string; fg: string } | null;
  ghosts: { x: number; y: number }[];
  presence: { x: number; y: number; label: string; color: string }[];
  windows: { id: number; x: number; y: number; w: number; h: number; selected: boolean; buffer: string; start: number; lastLine: number }[];
}
/* A rule's declarations as the face tables spell them. */
type Spec = { fg?: string[]; bg?: string[]; w?: number; i?: number; u?: number; s?: number; box?: number; hide?: number; a?: number };

/* Boot with a host that keeps the stylesheets the modes register (markdown.ts, org.ts), for the face checks. */
const host = createHost({ workers: false });
const sheets: Record<string, string> = {};
host.page.addStyle = (id, css) => { sheets[id] = css; };
const Ed = loadEdwin(host);
Ed.boot({ host });
await Ed.whenIdle();
const E = Ed.E, L = (globalThis as Globals).L, D = Ed.display;
const feed = async (keys: string[]) => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
const keys = (s: string) => feed(Ed.kbd(s).split(' '));
const type = (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch === '\t' ? 'TAB' : ch)));
const ev = (src: string) => { L.resetOps(); return L.evalText(src); };
ev('(set! display-line-numbers #f)');   // init.scm turns them on; the test of the gutter turns them on again

let size = { cols: 60, rows: 16 }, model: Model | null = null, bells = 0;
const backend = { size: () => size, draw: (m: Model) => { model = m; }, bell: () => { bells++; } };
const frame = Ed.makeFrame(null, { backend });
frame.focused = true;
const draw = () => { Ed.render(); return model!; };
const row = (m: Model, y: number) => m.lines[y].map(s => s.text).join('');
const rows = (m: Model) => m.lines.map((_, y) => row(m, y));
/* The face of the cell at X, Y. */
const faceAt = (m: Model, x: number, y: number) => { const s = m.lines[y].find(s => x >= s.x && x < s.x + s.w)!; return m.faces[s.f]; };
/* A fresh buffer NAME in MODE holding TEXT, shown in a single window, point at POS. */
async function show(name: string, mode: string, text: string, pos = 0) {
  await keys('ESC');
  if (E.mini) Ed.abortMini();
  Ed.deleteOtherWindows();
  const b = Ed.getBufferCreate(name);
  Ed.setWindowBuffer(b); E.current = b;
  ev(`(${mode})`);
  b.text = text; b.pt = pos; E.sel.start = 0;
  return b;
}

test('a model frame needs a backend with size and draw, and draws through it', () => {
  assert.throws(() => Ed.makeFrame(null, { backend: {} }), /backend/);
  assert.ok(E.frames.includes(frame) && E.frame === frame);
  assert.equal(frame.root, null);
  assert.equal(frame.el('echo'), null, 'a model frame has no page parts');
  const m = draw();
  assert.equal(m.cols, 60); assert.equal(m.rows, 16); assert.equal(m.lines.length, 16);
  for (const r of m.lines) {
    assert.equal(r[0].x, 0);
    assert.equal(r.reduce((n, s) => n + s.w, 0), 60, 'segments cover the row');
    for (let i = 1; i < r.length; i++) assert.equal(r[i].x, r[i - 1].x + r[i - 1].w);
  }
  assert.deepEqual(m.faces[0], D.resolveFace('default', m.theme));
});

test('text, the modeline and the echo area land on their rows; the cursor is reported, not painted', async () => {
  await show('d1.scm', 'scheme-mode', '(define (f x) "doc" x)\n; note\n', 3);
  ev('(evil-normal-state)');
  const m = draw();
  assert.equal(row(m, 0).trimEnd(), '(define (f x) "doc" x)');
  assert.equal(row(m, 1).trimEnd(), '; note');
  const ml = row(m, m.rows - 2);
  assert.match(ml, /NORMAL .*d1\.scm.*L1 C3.*\(Scheme\)/);
  assert.deepEqual([m.cursor!.x, m.cursor!.y, m.cursor!.shape], [3, 0, 'box']);
  const pal = D.PALETTE[m.theme];
  assert.equal(faceAt(m, 1, 0).fg, pal.kw, '"define" is a keyword');
  assert.equal(faceAt(m, 1, 0).weight, 500);
  assert.equal(faceAt(m, 15, 0).fg, pal.dc, 'a docstring');
  assert.equal(faceAt(m, 0, 1).fg, pal.cm); assert.ok(faceAt(m, 0, 1).italic, 'comments are italic');
  assert.equal(faceAt(m, 3, 0).bg, pal.hl, 'the cursor cell keeps the current line background (the backend draws the cursor)');
  assert.equal(faceAt(m, 40, 0).bg, pal.hl, 'the current line is highlighted across the window');
  assert.equal(faceAt(m, 40, 1).bg, pal.bg);
  assert.equal(faceAt(m, 40, m.rows - 2).bg, pal['ml-bg']);
  assert.deepEqual(m.windows.map(w => [w.x, w.y, w.w, w.h, w.selected, w.buffer]), [[0, 0, 60, 15, true, 'd1.scm']]);
  assert.equal(m.title, 'd1.scm');
  ev('(evil-insert-state)'); assert.equal(draw().cursor!.shape, 'bar');
  assert.equal(model!.cursor!.color, pal['cursor-insert']);
  frame.focused = false; assert.equal(draw().cursor!.shape, 'hollow'); frame.focused = true;
  ev('(evil-normal-state)');
});

test('long lines wrap after the last space that fits; truncate-lines keeps one row and scrolls to the cursor', async () => {
  const words = Array.from({ length: 20 }, (_, i) => 'word' + i).join(' ');
  const b = await show('d2.txt', 'fundamental-mode', words + '\nnext\n', 0);   // text-mode turns on visual-line-mode, which wraps truncated lines
  let m = draw();
  const r0 = row(m, 0), r1 = row(m, 1);
  assert.ok(r0.trimEnd().endsWith('word9'), r0);
  assert.ok(r1.startsWith('word10 '), r1);
  b.pt = words.length - 1;
  m = draw(); assert.equal(m.cursor!.y, 2);
  assert.equal(row(m, 3).trimEnd(), 'next');
  ev('(set! truncate-lines #t)');
  m = draw();
  assert.ok(m.cursor!.x < 60 && row(m, 0).includes('word19'), 'the window scrolled sideways to the cursor');
  assert.equal(row(m, 1).trim(), '', 'the whole window scrolls, as the page\'s view does');
  b.pt = 0; m = draw();
  assert.equal(row(m, 0), words.slice(0, 60)); assert.equal(row(m, 1).trimEnd(), 'next');
  ev('(set! truncate-lines #f)');
});

test('tabs reach the next stop of 8, wide characters take two cells, control characters show as ^X', async () => {
  await show('d3.txt', 'text-mode', 'a\tb\n日本x\n\u0001z\n', 0);
  const m = draw();
  assert.equal(row(m, 0).slice(0, 10), 'a       b ');
  const r1 = m.lines[1];
  const cells = r1.reduce((n, s) => n + s.w, 0);
  assert.equal(cells, 60);
  assert.ok(row(m, 1).startsWith('日本x'));
  assert.equal(D.strWidth('日本'), 4);
  assert.equal(D.charWidth('́'.codePointAt(0)), 0);
  assert.equal(row(m, 2).slice(0, 3), '^Az');
  const p = D.posAt(frame, 4, 1);
  assert.deepEqual([p.area, p.pos], ['text', 6], 'the cell after the two wide characters is x');
});

test('line numbers take a gutter; the current number is set apart', async () => {
  const b = await show('d4.scm', 'scheme-mode', 'a\nb\nc\n', 2);
  ev("(set! display-line-numbers #t)");
  const m = draw();
  assert.equal(row(m, 0).slice(0, 4), ' 1 a');
  assert.equal(row(m, 1).slice(0, 4), ' 2 b');
  assert.equal(m.cursor!.x, 3);
  assert.equal(faceAt(m, 1, 1).fg, D.PALETTE[m.theme].fg, 'the current line number');
  assert.equal(faceAt(m, 1, 0).fg, D.PALETTE[m.theme].gutter);
  ev("(set! display-line-numbers 'relative)");
  assert.equal(row(draw(), 0).slice(0, 4), ' 1 a');
  ev('(set! display-line-numbers #f)');
  void b;
});

test('a window taller than its buffer view scrolls to keep point; lastLine and rows follow', async () => {
  const text = Array.from({ length: 100 }, (_, i) => 'line ' + (i + 1)).join('\n');
  const b = await show('d5.txt', 'text-mode', text, 0);
  let m = draw();
  assert.equal(E.sel.rows, 14); assert.equal(Ed.windowRows(E.sel), 14);
  assert.equal(E.sel.lastLine, 14);
  b.pt = text.indexOf('line 50');
  m = draw();
  assert.ok(m.cursor!.y >= 0 && m.cursor!.y < 14, 'the cursor is on a text row');
  assert.equal(row(m, m.cursor!.y).trimEnd(), 'line 50');
  assert.ok(E.sel.start > 0);
  await keys('C-l');
  m = draw();
  assert.equal(m.cursor!.y, 7, 'recentered');
  assert.match(row(m, 14), /L50 C0 +\d+%/);
});

test('splits: side by side windows have a divider, stacked ones share the height; each has a modeline', async () => {
  await show('d6.txt', 'text-mode', 'left\n', 0);
  Ed.splitWindow(E.sel, 'right');
  let m = draw();
  assert.equal(m.windows.length, 2);
  const [a, c] = m.windows;
  assert.deepEqual([a.x, a.w, c.x, c.w], [0, 29, 30, 30]);
  assert.equal(row(m, 0)[29], '│');
  assert.ok(a.selected && !c.selected);
  assert.equal(m.ghosts.length, 1, 'the other window shows a ghost cursor');
  assert.notEqual(faceAt(m, 27, 14).bg, faceAt(m, 57, 14).bg, 'the selected modeline stands out');
  Ed.deleteOtherWindows(); Ed.splitWindow(E.sel, 'below');
  m = draw();
  assert.deepEqual(m.windows.map(w => [w.y, w.h]), [[0, 7], [7, 8]]);
  assert.match(row(m, 6), /d6\.txt/); assert.match(row(m, 14), /d6\.txt/);
  Ed.deleteOtherWindows();
});

test('the minibuffer: prompt, input, candidates with every matching term marked, and the cursor in the echo area', async () => {
  await show('d7.txt', 'text-mode', '', 0);
  await keys('M-x'); await type('find fi');
  const m = draw();
  const first = m.rows - (m.rows - m.windows[0].h);
  assert.match(row(m, first), /^\d+\/\d+ +M-x find fi/);
  assert.equal(m.cursor!.y, first); assert.equal(m.cursor!.shape, 'bar');
  const cands = rows(m).slice(first + 1).map(s => s.trim()).filter(Boolean);
  assert.ok(cands.some(s => s.startsWith('find-file')), cands.join('\n'));
  const v = Ed.miniView();
  const ff = v.items.find((it: Edwin) => it.label === 'find-file');
  assert.deepEqual(ff.marks, [[0, 4], [5, 7]], 'both terms are marked (the page marked only the last one)');
  const y = first + 1 + v.items.indexOf(ff), pal = D.PALETTE[m.theme];
  assert.equal(faceAt(m, 1, y).fg, pal.co, 'a matched part');
  await keys('C-g');
});

test('a pending prefix shows its bindings in the echo area', async () => {
  await show('d8.txt', 'text-mode', 'x', 0);
  ev('(evil-normal-state)'); ev('(set! which-key-idle-delay 0)');
  Ed.feedKey('g'); await Ed.whenIdle();
  const m = draw();
  const echo = rows(m).slice(m.windows[0].h).join('\n');
  assert.match(echo, /^g- /);
  assert.match(echo, /g evil-goto-first-line|gg|g +\S/);
  await keys('ESC');
});

test('the completion popup sits under the cursor', async () => {
  const b = await show('d9.txt', 'text-mode', 'al', 2);
  E.corfu = { start: 0, prefix: 'al', cands: [{ text: 'alpha', ann: 'w' }, { text: 'alps', ann: '' }], index: 1, scroll: 0 };
  const m = draw();
  assert.match(row(m, 1), /^ alpha +w /);
  assert.match(row(m, 2), /^ alps /);
  assert.equal(faceAt(m, 1, 2).bg, D.PALETTE[m.theme].region, 'the selected candidate');
  assert.equal(faceAt(m, 1, 1).bg, D.PALETTE[m.theme]['menu-bg']);
  E.corfu = null; void b;
});

test('posAt maps cells to buffer positions, the modeline and the echo area', async () => {
  await show('d10.txt', 'text-mode', 'hello\n\nworld', 0);
  draw();
  assert.deepEqual(D.posAt(frame, 1, 0).pos, 1);
  assert.equal(D.posAt(frame, 30, 0).pos, 5, 'past the text is the end of the line');
  assert.equal(D.posAt(frame, 3, 1).pos, 6, 'an empty line');
  assert.equal(D.posAt(frame, 2, 2).pos, 9);
  assert.equal(D.posAt(frame, 0, 14).area, 'modeline');
  assert.equal(D.posAt(frame, 0, 15).area, 'echo');
  assert.equal(D.posAt(frame, 99, 0), null);
});

test('themes, set-face-color!, markdown and Org faces resolve to colours', async () => {
  await show('d11.md', 'markdown-mode', '# Title\n\nsome *it* text\n', 12);
  let m = draw();
  assert.equal(faceAt(m, 2, 0).weight, 700);
  assert.equal(faceAt(m, 2, 0).fg, D.PALETTE.light.kw, 'a heading falls back to the keyword colour');
  D.setTheme(frame, 'dark');
  m = draw();
  assert.equal(m.theme, 'dark'); assert.equal(m.faces[0].bg, D.PALETTE.dark.bg);
  assert.equal(faceAt(m, 2, 0).fg, D.PALETTE.dark.kw);
  ev('(set-face-color! \'kw "#123456")');
  assert.equal(faceAt(draw(), 2, 0).fg, '#123456', 'a set-face-color! token wins, as on the page');
  host.page.setVar('kw', '');
  D.setTheme(frame, 'light');
  const f = D.resolveFace('default markdown-code', 'light');
  assert.equal(f.bg, '#ece9e2', 'rgb(127 127 127 / 0.12) over the background');
  assert.equal(D.resolveFace('default ohs', 'light').fg, D.PALETTE.light.bg, 'transparent text shows the background');
  assert.deepEqual(D.glyphsOf({ text: '* h', runs: [{ s: 0, e: 1, cls: 'ob1' }, { s: 1, e: 3, cls: 'ol1' }] }).map((g: Edwin) => g.t), ['◉', ' ', 'h']);
  assert.deepEqual(D.glyphsOf({ text: '*b*', runs: [{ s: 0, e: 1, cls: 'oh' }, { s: 1, e: 2, cls: 'obb' }, { s: 2, e: 3, cls: 'oh' }] }).map((g: Edwin) => g.w), [0, 1, 0]);
});

test('a wrapped line taller than the window keeps the cursor row in view', async () => {
  const long = 'x'.repeat(1500);
  const b = await show('d13.txt', 'fundamental-mode', long + '\nend', 1490);
  const m = draw();
  assert.ok(m.cursor, 'the cursor is shown');
  assert.ok(m.cursor!.y < 14);
  assert.equal(D.posAt(frame, m.cursor!.x, m.cursor!.y).pos, 1490);
  b.pt = 0; assert.equal(draw().cursor!.y, 0);
});

test('other writers keep their colours (sync.js gives hsl)', async () => {
  assert.deepEqual(D.parseColor('hsl(120 100% 25%)').map(Math.round), [0, 128, 0, 1]);
  const b = await show('d14.txt', 'text-mode', 'hello world', 0);
  b.presence = [{ label: 'ann', color: 'hsl(200 65% 45%)', ranges: [[6, 6]] }, { label: 'bob', color: 'hsl(20 65% 45%)', ranges: [[0, 4]] }];
  const m = draw();
  assert.deepEqual(m.presence.map(p => [p.x, p.y, p.label]), [[6, 0, 'ann']]);
  assert.equal(m.presence[0].color, '#288cbd');
  assert.equal(faceAt(m, 6, 0).bg, '#288cbd');
  assert.notEqual(faceAt(m, 1, 0).bg, faceAt(m, 8, 0).bg, 'a selection is tinted with its writer colour');
  b.presence = null;
});

test('ding rings the backend', () => { const n = bells; Ed.ding(); assert.equal(bells, n + 1); });

test('runs reproduce the html renderer: same text, same classes, and the html is unchanged by asking for runs', async () => {
  const b = await show('d12.scm', 'scheme-mode', '(define (g a) "s" ; c\n  (list a 1 #t #\\x "<&>"))\n\tz', 9);
  b.mark = 2; b.markActive = true;
  const o = { from: 0, count: 10, active: true, cursorClass: '', onChar: true };
  const plain = Ed.renderBuffer(b, o), both = Ed.renderBuffer(b, { ...o, runs: true });
  assert.deepEqual(both.map((l: Edwin) => l.html), plain.map((l: Edwin) => l.html));
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const l of both) {
    const fromHtml = [...l.html.matchAll(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map(x => [x[1], unesc(x[2])]);
    const fromRuns = l.runs.map((r: Edwin) => [r.cls, r.t !== undefined ? r.t : r.k === 'cur' && r.e === r.s ? ' ' : l.text.slice(r.s, r.e)]);
    assert.deepEqual(fromRuns, fromHtml);
  }
  b.markActive = false;
});

/* ---------- the face tables mirror the stylesheets ---------- */
/* var(--a, var(--b, #c)) -> ['a', 'b', '#c']; a plain colour -> [it]. */
function chain(v: string) {
  const out: string[] = [];
  v = v.trim();
  for (;;) {
    const m = /^var\(--([\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(v);
    if (!m) { if (v) out.push(v); return out; }
    out.push(m[1]);
    if (m[2] === undefined) return out;
    v = m[2].trim();
  }
}
function specOf(body: string) {
  const s: Spec = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':'); if (i < 0) continue;
    const k = decl.slice(0, i).trim(), v = decl.slice(i + 1).replace('!important', '').trim();
    if (k === 'color' && v !== 'inherit') s.fg = chain(v);
    else if (k === 'background' && /^(var|#|rgb|transparent)/.test(v)) s.bg = chain(v);
    else if (k === 'font-weight') s.w = Number(v);
    else if (k === 'font-style' && v === 'italic') s.i = 1;
    else if (k === 'text-decoration' && v.includes('underline')) s.u = 1;
    else if (k === 'text-decoration' && v.includes('line-through')) s.s = 1;
    else if (k === 'box-shadow' && /inset/.test(v) && /currentColor/.test(v)) s.box = 1;
    else if (k === 'display' && v === 'none') s.hide = 1;
    else if (k === 'opacity') s.a = Number(v);
  }
  return s;
}
/* The rules of CSS as [selector, spec] for each selector of each rule. */
function rules(css: string) {
  const out: [string, Spec][] = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const sel of m[1].split(',')) out.push([sel.trim(), specOf(m[2])]);
  return out;
}
const norm = (sp: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const k of ['fg', 'bg', 'w', 'i', 'u', 's', 'box', 'hide', 'a']) if (sp[k] !== undefined) o[k] = k === 'fg' || k === 'bg' ? ([] as unknown[]).concat(sp[k]) : sp[k]; return o; };

test('PALETTE is index.html\'s palette, light and dark', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const tokens = (start: string) => { const i = html.indexOf(start), body = html.slice(i, html.indexOf('}', i)); return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6});/g)].map(m => [m[1], m[2]])); };
  assert.deepEqual(D.PALETTE.light, tokens(':root {'));
  assert.deepEqual(D.PALETTE.dark, tokens(':root[data-theme="dark"] {'));
  assert.deepEqual(D.PALETTE.dark, tokens(':root:not([data-theme="light"]) {'), 'the dark scheme of prefers-color-scheme');
});

test('FACES mirror the page\'s stylesheets: index.html, markdown-mode and Org', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const at = html.indexOf('\n<style>'), style = html.slice(at, html.indexOf('</style>', at));   // the page's own sheet, after the skeleton's
  /* index.html selectors and the face each one is */
  const SEL: Record<string, string> = {
    '.kw': 'kw', '.fn': 'fn', '.st': 'st', '.dc': 'dc', '.cm': 'cm', '.co': 'co', '.nu': 'nu', '.qu': 'qu', '.pa': 'pa',
    '.pa.d0': 'pa.d0', '.pa.d1': 'pa.d1', '.pa.d2': 'pa.d2', '.pa.d3': 'pa.d3', '.pa.d4': 'pa.d4', '.pa.d5': 'pa.d5',
    '.rg': 'rg', '.lz': 'lz', '.im': 'im', '.pm': 'pm', '.px': 'px', '.avy': 'avy', '#snipe div': 'snipe',
    '.win.selected .ln.cl': 'cl', '.text.numbers .ln::before': 'ln', '.text.numbers .ln.cl::before': 'ln.cl',
    '.modeline': 'modeline', '.win:not(.selected) .modeline': 'modeline.inactive', '.ml-tag': 'ml-tag',
    '.ml-tag[data-state="insert"]': 'ml-tag.insert', '.ml-tag[data-state="visual"]': 'ml-tag.visual', '.ml-tag[data-state="replace"]': 'ml-tag.replace',
    '.ml-tag[data-state="operator"]': 'ml-tag.operator', '.ml-tag[data-state="motion"]': 'ml-tag.motion', '.ml-tag[data-state="emacs"]': 'ml-tag.emacs',
    '.ml-state': 'ml-state', '.ml-name': 'ml-name', '.win:not(.selected) .ml-name': 'ml-name.inactive', '.ml-pos': 'ml-pos', '.ml-mode': 'ml-mode',
    '.ml-extra': 'ml-extra', '.ml-cmd': 'ml-cmd', '#echo .prompt': 'prompt', '#echo .cc': 'cc', '#echo .flash': 'flash',
    '#echo .cand.sel': 'cand.sel', '#echo .cand .cl b': 'cand-m', '#echo .cand .ca': 'ca', '#echo .cand.sel .ca': 'ca.sel',
    '#echo .wkp': 'wkp', '#echo .wk kbd': 'wk-key',
  };
  const fromCss: Record<string, Spec> = {};
  const add = (k: string, sp: Spec) => { fromCss[k] = Object.assign(fromCss[k] || {}, sp); };
  for (const [sel, sp] of rules(style)) if (SEL[sel]) add(SEL[sel], sp);
  for (const id of ['markdown-css', 'org-css']) {
    assert.ok(sheets[id], id + ' was registered');
    for (const [sel, sp] of rules(sheets[id])) { const m = /^\.text \.([\w-]+)$/.exec(sel); if (m) add(m[1], sp); }
  }
  /* Faces with no rule of their own on the page: the default and area faces, the popup's background, the bullets
     (drawn by ::after), the sync field (FRAME_CSS only). */
  const CELL_ONLY = new Set(['default', 'echo', 'corfu', 'rule', 'ml-sync', 'ob1', 'ob2', 'ob3', 'ob4', 'ob5']);
  for (const [k, spec] of Object.entries(D.FACES)) {
    if (CELL_ONLY.has(k)) continue;
    assert.ok(fromCss[k], `FACES.${k} has a rule in the stylesheets`);
    const css = norm(fromCss[k]), mine = norm(spec as Record<string, unknown>);
    assert.deepEqual(mine, css, `FACES.${k}`);
  }
  for (const k of Object.keys(fromCss)) assert.ok(D.FACES[k], `the class ${k} has a face`);
  /* The bullets' glyphs are the ::after content. */
  for (let n = 1; n <= 5; n++) { const m = new RegExp(`\\.text \\.ob${n}::after \\{ content: "(.)"; \\}`).exec(sheets['org-css']); assert.equal(D.FACES['ob' + n].glyph, m![1]); }
});
