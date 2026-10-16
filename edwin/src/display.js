/* Edwin's display seam (DT0): frames that are not page elements.

   A page frame (Ed.makeFrame(el, ...)) is drawn by editor-core.js into the DOM, and the browser does the layout:
   wrapping, widths, the line height. A model frame (Ed.makeFrame(null, {backend})) has no page. Each redisplay
   this file lays it out on a grid of character cells, backend.size() = {cols, rows}, and hands the result to
   backend.draw(model). A terminal (DT1) and a native window (DT2) are such backends; so is the fake backend of
   test/display.test.mjs. The core, the modes and the Scheme image are the same as in the browser.

   The model is plain data, so a backend in another language can take it as JSON:
     cols, rows, theme ('light' | 'dark'), focused, title
     faces    [{fg, bg, weight, bold, italic, underline, strike, box}], colours as '#rrggbb'; faces[0] is the default
     lines    one entry per row, each a list of segments {x, w, text, f} that cover the row from column 0: text
              takes w cells from column x (a wide character takes two), f indexes faces
     cursor   {x, y, shape: 'box' | 'bar' | 'hbar' | 'half' | 'hollow', color, fg} or null; the cursor is not
              painted into the cells, so a terminal can use its own cursor (and its shape) there
     ghosts   [{x, y}], the cursors of the windows that do not have the keyboard
     presence [{x, y, label, color}], other writers' cursors (their cells are tinted too)
     windows  [{id, x, y, w, h, selected, buffer, start, lastLine}], h counting the modeline row
   Faces are data here too: FACES gives each class the renderer emits (renderBuffer's runs, Org and markdown-mode
   classes, the modeline and echo parts) a spec in palette tokens, and PALETTE gives the tokens the values of
   edwin/index.html in its light and dark themes. A token set with set-face-color! (host.page vars) wins, as it
   does on the page. test/display.test.mjs checks both tables against the stylesheets they mirror.

   What a model frame does not show yet: snipe boxes and the pulse are cell faces or nothing (no animation), the
   display text of markdown block references (a DOM pass in markdown.js) shows the reference, and the menubar of a
   console frame is not drawn. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, host = Ed.host;
const { truthy } = L;

/* ---------- the palette and the faces ---------- */
const PALETTE = {
  light: {
    'page': '#efe9dd', 'bg': '#fbf7f0', 'fg': '#000000', 'dim': '#595959', 'rule': '#c4b8ab', 'gutter': '#7f7f7f',
    'menu-bg': '#efe9dd', 'menu-fg': '#3a3a3a', 'ml-bg': '#cab9b2', 'ml-fg': '#000000', 'ml-dim': '#3a3a3a',
    'ml-inactive': '#dfd9cf', 'cursor': '#000000', 'cursor-fg': '#fbf7f0', 'region': '#c2bcb5', 'match': '#79a8ff',
    'lazy': '#c0efff', 'paren': '#7fdfcf', 'mismatch': '#ffa0a0', 'bell': '#a60000', 'hl': '#f1d5d0',
    'pulse': '#ffdfa0', 'kw': '#531ab6', 'fn': '#721045', 'st': '#3548cf', 'dc': '#2a5045', 'cm': '#7f0000',
    'co': '#0000b0', 'pa': '#7f7f7f', 'rb0': '#0000b0', 'rb1': '#a60000', 'rb2': '#006800', 'rb3': '#884900',
    'rb4': '#721045', 'rb5': '#005e8b', 'avy-bg': '#ffc000', 'avy-fg': '#000000', 's-normal': '#3548cf',
    's-insert': '#006800', 's-visual': '#884900', 's-replace': '#a60000', 's-operator': '#595959',
    's-motion': '#005e8b', 's-emacs': '#531ab6', 's-fg': '#ffffff', 'cursor-normal': '#a60000',
    'cursor-insert': '#006800', 'cursor-emacs': '#005e8b', 'cursor-visual': '#884900', 'cursor-replace': '#a60000',
    'snipe': '#ffc000',
  },
  dark: {
    'page': '#0d0e1c', 'bg': '#0d0e1c', 'fg': '#ffffff', 'dim': '#989898', 'rule': '#3d3f5a', 'gutter': '#7e7e7e',
    'menu-bg': '#1d2235', 'menu-fg': '#b8b8b8', 'ml-bg': '#484d67', 'ml-fg': '#ffffff', 'ml-dim': '#cfcfcf',
    'ml-inactive': '#292d48', 'cursor': '#ff66ff', 'cursor-fg': '#0d0e1c', 'region': '#555a66', 'match': '#2f7f9f',
    'lazy': '#1f3f4f', 'paren': '#2f7f9f', 'mismatch': '#7f1f1f', 'bell': '#ff5f59', 'hl': '#303a6f',
    'pulse': '#5f4f2f', 'kw': '#b6a0ff', 'fn': '#feacd0', 'st': '#79a8ff', 'dc': '#9ac8e0', 'cm': '#ff9f80',
    'co': '#00bcff', 'pa': '#7e7e7e', 'rb0': '#00bcff', 'rb1': '#ff5f59', 'rb2': '#44bc44', 'rb3': '#fec43f',
    'rb4': '#feacd0', 'rb5': '#00d3d0', 'avy-bg': '#d0bc00', 'avy-fg': '#000000', 's-normal': '#79a8ff',
    's-insert': '#44bc44', 's-visual': '#d0bc00', 's-replace': '#ff5f59', 's-operator': '#989898',
    's-motion': '#00d3d0', 's-emacs': '#b6a0ff', 's-fg': '#0d0e1c', 'cursor-normal': '#ff5f59',
    'cursor-insert': '#44bc44', 'cursor-emacs': '#00d3d0', 'cursor-visual': '#d0bc00', 'cursor-replace': '#ff5f59',
    'snipe': '#d0bc00',
  },
};
/* A face spec: fg and bg are a token, a list of tokens tried in order (CSS var() fallbacks), '#rrggbb',
   'transparent' (the background shows) or 'rgb(r g b / a)' (blended over what is below); a is the opacity of bg;
   w the font weight; i italic, u underline, s strike-through, box an outline in the fg colour; hide: the character
   takes no cell; glyph: shown instead of the character. p orders the layers: 0 the area (echo, modeline,
   current line), 1 the text's own class, 2 the combinations (pa.d3, cand.sel), 3 the highlights, 4 avy, 5 the
   colours of other writers. A key "a.b" applies when a cell has both classes. */
const TAG_BG = 'rgb(127 127 127 / 0.12)', BLOCK_BG = 'rgb(127 127 127 / 0.08)';
const FACES = {
  default: { fg: 'fg', bg: 'bg', p: 0 }, cl: { bg: 'hl', p: 0 },
  kw: { fg: 'kw', w: 500 }, fn: { fg: 'fn', w: 500 }, st: { fg: 'st' }, dc: { fg: 'dc', i: 1 }, cm: { fg: 'cm', i: 1 },
  co: { fg: 'co' }, nu: { fg: 'co' }, qu: { fg: 'co' }, pa: { fg: 'pa' },
  'pa.d0': { fg: 'rb0', p: 2 }, 'pa.d1': { fg: 'rb1', p: 2 }, 'pa.d2': { fg: 'rb2', p: 2 }, 'pa.d3': { fg: 'rb3', p: 2 }, 'pa.d4': { fg: 'rb4', p: 2 }, 'pa.d5': { fg: 'rb5', p: 2 },
  rg: { bg: 'region', p: 3 }, lz: { bg: 'lazy', p: 3 }, im: { bg: 'match', p: 3 }, pm: { bg: 'paren', p: 3 }, px: { bg: 'mismatch', p: 3 },
  snipe: { bg: 'snipe', a: 0.45, p: 3 },
  avy: { bg: 'avy-bg', fg: 'avy-fg', w: 700, p: 4 },
  ln: { fg: 'gutter' }, 'ln.cl': { fg: 'fg', w: 500, bg: 'hl', p: 2 }, rule: { fg: 'rule' },
  modeline: { fg: 'ml-fg', bg: 'ml-bg', p: 0 }, 'modeline.inactive': { fg: 'ml-dim', bg: 'ml-inactive', p: 0.5 },
  'ml-tag': { fg: 's-fg', bg: 's-normal', w: 600 },
  'ml-tag.insert': { bg: 's-insert', p: 2 }, 'ml-tag.visual': { bg: 's-visual', p: 2 }, 'ml-tag.replace': { bg: 's-replace', p: 2 },
  'ml-tag.operator': { bg: 's-operator', p: 2 }, 'ml-tag.motion': { bg: 's-motion', p: 2 }, 'ml-tag.emacs': { bg: 's-emacs', p: 2 },
  'ml-state': { fg: 'ml-dim' }, 'ml-name': { w: 600 }, 'ml-name.inactive': { w: 500, p: 2 }, 'ml-pos': { fg: 'ml-dim' }, 'ml-mode': { fg: 'ml-dim' },
  'ml-extra': { fg: 's-replace', w: 500 }, 'ml-sync': { fg: 's-replace', w: 600 }, 'ml-cmd': { fg: 'ml-fg', w: 500 },
  echo: { fg: 'fg', bg: 'bg', p: 0 }, prompt: { fg: 'fn', w: 500 }, cc: { fg: 'dim' }, flash: { fg: 'co' },
  'cand.sel': { bg: 'region', p: 2 }, 'cand-m': { fg: 'co', w: 600 }, ca: { fg: 'dim' }, 'ca.sel': { fg: 'fg', p: 2 },
  wkp: { fg: 'dim' }, 'wk-key': { fg: 'kw', w: 600 },
  /* The completion popup has a border and a shadow on the page; in cells it is told apart by its background. */
  corfu: { fg: 'fg', bg: 'menu-bg', p: 0 },
  /* markdown-mode (markdown.js CSS) */
  'markdown-heading-1': { fg: ['md-heading', 'org-l1', 'kw'], w: 700 }, 'markdown-heading-2': { fg: ['md-heading', 'org-l2', 'fn'], w: 700 },
  'markdown-heading-3': { fg: ['md-heading', 'org-l3', 'st'], w: 600 }, 'markdown-heading-4': { fg: ['md-heading', 'org-l4', 'dc'], w: 600 },
  'markdown-heading-5': { fg: ['md-heading', 'org-l4', 'dc'], w: 600 }, 'markdown-heading-6': { fg: ['md-heading', 'org-l4', 'dc'], w: 600 },
  'markdown-markup': { fg: ['md-markup', 'dim'] }, 'markdown-bold': { w: 700 }, 'markdown-italic': { i: 1 },
  'markdown-strike': { s: 1, fg: ['md-markup', 'dim'] },
  'markdown-code': { fg: ['md-code', 'st'], bg: ['md-code-bg', 'org-code-bg', TAG_BG] }, 'markdown-code-block': { fg: ['md-code', 'st'], bg: ['md-code-bg', 'org-code-bg', TAG_BG] },
  'markdown-fence': { fg: ['md-markup', 'dim'], bg: ['md-code-bg', 'org-code-bg', TAG_BG] },
  'markdown-link': { fg: ['md-link', 'st'], u: 1 }, 'markdown-wiki-link': { fg: ['md-link', 'st'], u: 1 }, 'markdown-url': { fg: ['md-link', 'st'] },
  'markdown-image': { fg: ['md-image', 'dc'] }, 'markdown-block-ref': { fg: ['md-ref', 'co'] },
  'markdown-block-ref-display': { fg: ['md-ref', 'co'], bg: ['md-ref-bg', 'rgb(127 127 127 / 0.1)'] },
  'markdown-anchor': { fg: ['md-anchor', 'dim'], bg: ['md-tag-bg', 'org-tag-bg', TAG_BG] }, 'markdown-tag': { fg: ['md-tag', 'co'], bg: ['md-tag-bg', 'org-tag-bg', TAG_BG] },
  'markdown-list': { fg: ['md-list', 'kw'], w: 700 }, 'markdown-checkbox': { fg: ['md-checkbox', 'co'], w: 600 }, 'markdown-checkbox-done': { fg: ['md-markup', 'dim'] },
  'markdown-task-todo': { fg: ['md-task-todo', 'org-todo', 'rb1'], w: 700, box: 1 }, 'markdown-task-someday': { fg: ['md-task-todo', 'org-todo', 'rb1'], w: 700, box: 1 },
  'markdown-task-later': { fg: ['md-task-todo', 'org-todo', 'rb1'], w: 700, box: 1 }, 'markdown-task-other': { fg: ['md-task-todo', 'org-todo', 'rb1'], w: 700, box: 1 },
  'markdown-task-next': { fg: ['md-task-next', 'rb2'], w: 700, box: 1 }, 'markdown-task-doing': { fg: ['md-task-next', 'rb2'], w: 700, box: 1 }, 'markdown-task-now': { fg: ['md-task-next', 'rb2'], w: 700, box: 1 },
  'markdown-task-waiting': { fg: ['md-task-waiting', 'rb3'], w: 700, box: 1 }, 'markdown-task-hold': { fg: ['md-task-waiting', 'rb3'], w: 700, box: 1 },
  'markdown-task-done': { fg: ['md-task-done', 'dim'], w: 600, box: 1 }, 'markdown-task-cancelled': { fg: ['md-task-done', 'dim'], w: 600, box: 1 }, 'markdown-task-other-done': { fg: ['md-task-done', 'dim'], w: 600, box: 1 },
  'markdown-task-done-text': { fg: ['md-task-done', 'dim'], s: 1 }, 'markdown-field-key': { fg: ['md-field', 'fn'] }, 'markdown-priority': { fg: ['md-priority', 'rb1'], w: 700 },
  'markdown-planning': { fg: ['md-markup', 'dim'], w: 600 }, 'markdown-date': { fg: ['md-date', 'co'], bg: ['md-tag-bg', 'org-tag-bg', TAG_BG] },
  'markdown-quote': { i: 1, fg: ['md-quote', 'dim'] }, 'markdown-table': { fg: ['md-table', 'co'] }, 'markdown-table-delimiter': { fg: ['md-markup', 'dim'] },
  'markdown-hr': { fg: ['md-markup', 'rule'] }, 'markdown-front-matter': { fg: ['md-meta', 'dim'] },
  /* Org (org.js CSS): hidden markup, hidden leading stars, bullets drawn as glyphs */
  oh: { hide: 1 }, ohs: { fg: 'transparent' },
  ob1: { fg: ['org-star', 'kw'], glyph: '◉' }, ob2: { fg: ['org-star', 'kw'], glyph: '○' }, ob3: { fg: ['org-star', 'kw'], glyph: '◈' }, ob4: { fg: ['org-star', 'kw'], glyph: '◇' }, ob5: { fg: ['org-star', 'kw'], glyph: '✳' },
  ol1: { fg: ['org-l1', 'kw'], w: 700 }, ol2: { fg: ['org-l2', 'fn'], w: 700 }, ol3: { fg: ['org-l3', 'st'], w: 600 }, ol4: { fg: ['org-l4', 'dc'], w: 600 }, ol5: { fg: ['org-l5', 'rb3'], w: 600 },
  ox: { fg: 'dim' }, ot: { fg: ['org-todo', 'rb1'], w: 700, box: 1 }, od: { fg: 'dim', w: 600, s: 1, box: 1 },
  og: { fg: 'dim', bg: ['org-tag-bg', TAG_BG] }, ots: { fg: 'co', bg: ['org-tag-bg', TAG_BG] }, osd: { fg: 'dim', w: 600 },
  obb: { w: 700 }, oit: { i: 1 }, oul: { u: 1 }, ost: { s: 1, fg: 'dim' },
  ocd: { fg: 'st', bg: ['org-code-bg', TAG_BG] }, ovb: { fg: 'st', bg: ['org-code-bg', TAG_BG] },
  okw: { fg: 'dim' }, oti: { fg: 'fg', w: 700 }, obd: { fg: 'dim' }, osb: { bg: ['org-block-bg', BLOCK_BG] }, oqb: { i: 1, fg: 'dim', bg: ['org-block-bg', BLOCK_BG] },
  olk: { fg: 'st', u: 1 }, ocb: { fg: 'co', w: 600 }, ocx: { fg: 'dim' }, odr: { fg: 'dim' }, opr: { fg: 'rb1', w: 700 }, ocm: { fg: 'cm', i: 1 },
  oli: { fg: 'kw', w: 700 }, otb: { fg: 'co' }, ohr: { fg: 'rule' }, oe: { fg: 'dim' },
  oad: { w: 700, fg: 'fg' }, oat: { w: 700, fg: 'kw' }, oag: { w: 700, fg: 'fn' }, oac: { fg: 'dim' }, oaw: { fg: 'co' }, oao: { fg: 'rb1', w: 600 },
};
const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff',
  gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a' };
const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
/* A colour as [r, g, b, a], or null: '#rgb', '#rrggbb', 'rgb(r g b / a)', 'rgb(r, g, b)', 'rgba(...)', a few names. */
function parseColor(s) {
  s = String(s).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [+m[1], +m[2], +m[3], a]; }
  return null;
}
/* The value of one token in THEME: a set-face-color! override (a page variable), else the palette's. */
function tokenColor(tok, theme) {
  if (tok === 'transparent') return 'transparent';
  if (tok[0] === '#' || tok.startsWith('rgb')) return parseColor(tok);
  const o = host.page.getVar(tok);
  if (o) { const c = parseColor(o); if (c) return c; }
  const v = PALETTE[theme][tok];
  return v ? parseColor(v) : null;
}
function chainColor(chain, theme) {
  for (const t of Array.isArray(chain) ? chain : [chain]) { const c = tokenColor(t, theme); if (c) return c; }
  return null;
}
const over = (top, a, under) => '#' + [0, 1, 2].map(i => hex2(top[i] * a + under[i] * (1 - a))).join('');
const toHex = c => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
/* The face of a cell whose classes are KEY (space-separated), in THEME, as concrete colours. */
function resolveFace(key, theme) {
  const cls = key.split(' ').filter(Boolean), layers = [];
  for (const c of cls) {
    const e = FACES[c];
    if (e) layers.push(e);
    else if (c.startsWith('bg=')) layers.push({ bg: c.slice(3), p: 5 });
    else if (c.startsWith('tint=')) layers.push({ bg: c.slice(5), a: 0.3, p: 5 });
  }
  for (const c of cls) for (const d of cls) if (c !== d && FACES[c + '.' + d]) layers.push(FACES[c + '.' + d]);
  layers.sort((x, y) => (x.p ?? 1) - (y.p ?? 1));
  const pal = PALETTE[theme];
  let fg = parseColor(pal.fg), bg = parseColor(pal.bg), fgT = false;
  const out = { weight: 400, italic: false, underline: false, strike: false, box: false };
  for (const e of layers) {
    if (e.bg) { const c = chainColor(e.bg, theme); if (c && c !== 'transparent') bg = parseColor(over(c, (e.a ?? 1) * c[3], bg)); }
    if (e.fg) { const c = chainColor(e.fg, theme); if (c === 'transparent') fgT = true; else if (c) { fg = c; fgT = false; } }
    if (e.w) out.weight = e.w;
    if (e.i) out.italic = true;
    if (e.u) out.underline = true;
    if (e.s) out.strike = true;
    if (e.box) out.box = true;
  }
  return { fg: fgT ? toHex(bg) : toHex(fg), bg: toHex(bg), ...out, bold: out.weight >= 600 };
}
/* The spec of the hiding and glyph classes of a cell (Org's hidden markup and bullets), or null. */
const specials = new Map();
function special(cls) {
  let r = specials.get(cls);
  if (r !== undefined) return r;
  r = null;
  for (const c of cls.split(' ')) { const e = FACES[c]; if (e && (e.hide || e.glyph)) r = e; }
  specials.set(cls, r);
  return r;
}

/* ---------- character cells ---------- */
const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];
const ZERO = /^[\p{Mn}\p{Me}​-‏⁠︀-️]$/u, EMOJI = /^\p{Emoji_Presentation}$/u;
const widths = new Map();
/* The cells code point CP takes: 0 (combining marks, joiners, variation selectors), 2 (East Asian wide and
   full-width, emoji presentation) or 1. Tabs and control characters are the caller's (tab stops, ^X). */
function charWidth(cp) {
  if (cp < 0x300) return 1;
  let w = widths.get(cp);
  if (w !== undefined) return w;
  const ch = String.fromCodePoint(cp);
  w = ZERO.test(ch) ? 0 : EMOJI.test(ch) || WIDE.some(([a, z]) => cp >= a && cp <= z) ? 2 : 1;
  widths.set(cp, w);
  return w;
}
function strWidth(s) { let n = 0; for (const ch of s) n += charWidth(ch.codePointAt(0)); return n; }

/* A grid of cells: CH holds each cell's text ('' in the right half of a wide character), FC its classes. */
class Grid {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows; this.ch = []; this.fc = [];
    for (let y = 0; y < rows; y++) { this.ch.push(new Array(cols).fill(' ')); this.fc.push(new Array(cols).fill('default')); }
  }
  /* Write T (W cells) at X, Y with classes K; returns the next column. A cell out of bounds is skipped, and a wide
     character cut by the edge LIM becomes a space. */
  put(x, y, t, w, k, lim = this.cols) {
    if (y < 0 || y >= this.rows) return x + w;
    if (w === 0) { if (x > 0 && x <= lim && this.ch[y][x - 1] !== '') this.ch[y][x - 1] += t; return x; }
    if (x < 0 || x + w > lim) { for (let i = 0; i < w; i++) if (x + i >= 0 && x + i < lim) this.cell(x + i, y, ' ', k); return x + w; }
    this.cell(x, y, t, k);
    for (let i = 1; i < w; i++) this.cell(x + i, y, '', k);
    return x + w;
  }
  cell(x, y, t, k) {
    const row = this.ch[y];
    if (row[x] === '' && x > 0 && t !== '') row[x - 1] = ' ';        // over the right half of a wide character
    if (x + 1 < this.cols && row[x + 1] === '' && t !== '' && strWidth(row[x]) === 2) row[x + 1] = ' ';  // over its left half
    row[x] = t; this.fc[y][x] = k;
  }
  text(x, y, s, k, lim = this.cols) { for (const ch of s) { if (x >= lim) break; x = this.put(x, y, ch, charWidth(ch.codePointAt(0)), k, lim); } return x; }
  fill(x, y, n, k) { for (let i = 0; i < n; i++) if (x + i >= 0 && x + i < this.cols && y >= 0 && y < this.rows) this.cell(x + i, y, ' ', k); }
  addClass(x, y, c) { if (y >= 0 && y < this.rows && x >= 0 && x < this.cols) this.fc[y][x] += ' ' + c; }
  /* Row Y as segments {x, w, text, f}: runs of equal classes, F from FACE (classes -> face index). */
  segments(y, face) {
    const row = this.ch[y], fr = this.fc[y], out = [];
    let x = 0;
    while (x < this.cols) {
      const k = fr[x];
      let e = x + 1;
      while (e < this.cols && (fr[e] === k || row[e] === '')) e++;
      out.push({ x, w: e - x, text: row.slice(x, e).join(''), f: face(k) });
      x = e;
    }
    return out;
  }
}

/* The glyphs of one rendered line (renderBuffer with runs): {t, w, p, k, cur} each, where T is what is shown, W
   its cells, P its offset in the line, K its classes. A tab reaches the next stop of 8, a control character shows
   as ^X, hidden markup takes no cell, and the cursor's own classes are dropped (the backend draws it). */
const glyphCache = new WeakMap();   // a line's runs (renderBuffer reuses them for an unchanged line) -> its glyphs
function glyphsOf(line) {
  const hit = glyphCache.get(line.runs);
  if (hit) return hit;
  const out = glyphsOf1(line);
  glyphCache.set(line.runs, out);
  return out;
}
function glyphsOf1(line) {
  const text = line.text, out = [];
  let col = 0, pos = 0;
  const push = (t, w, p, k, cur) => { out.push({ t, w, p, k, cur }); col += w; };
  for (const r of line.runs) {
    const isCur = r.k === 'cur';
    const k = isCur ? r.cls.split(' ').filter(c => c && !CURSOR_CLS.has(c)).join(' ') : r.cls;
    if (r.k === 'eol' || r.k === 'ell') { for (const ch of r.t) push(ch, charWidth(ch.codePointAt(0)), r.s, k, false); continue; }
    if (isCur && r.e === r.s) { push(' ', 1, r.s, k, true); continue; }
    if (r.k === 'avy') { let p = r.s; for (const ch of r.t) { push(ch, charWidth(ch.codePointAt(0)), p, k, false); p += ch.length; } pos = Math.max(pos, r.e); continue; }
    const sp = special(k);
    for (let i = Math.max(r.s, pos); i < r.e;) {
      const cp = text.codePointAt(i), n = cp > 0xffff ? 2 : 1;
      let t, w;
      if (cp === 9) { w = 8 - (col % 8); t = ' '.repeat(w); }
      else if (cp < 0x20 || cp === 0x7f) { t = '^' + String.fromCharCode(cp ^ 0x40); w = 2; }
      else { t = String.fromCodePoint(cp); w = charWidth(cp); }
      if (sp && !isCur) { if (sp.hide) { t = ''; w = 0; } else if (sp.glyph) { t = sp.glyph; w = charWidth(sp.glyph.codePointAt(0)); } }
      if (w === 0 && t && out.length && !isCur) out[out.length - 1].t += t;
      else push(t || '', w, i, k, isCur);
      i += n; pos = i;
    }
  }
  return out;
}
const CURSOR_CLS = new Set(['cur', 'bar', 'hbar', 'half', 'ghost']);
/* Break glyphs G into rows of COLS cells, as the page wraps a line (white-space: pre-wrap with overflow-wrap:
   anywhere): after the last space that fits, else anywhere. With NOWRAP the line is one row. */
function wrap(g, cols, nowrap) {
  if (nowrap) return [g];
  const rows = [];
  let row = [], w = 0;
  for (const x of g) {
    if (w + x.w > cols && row.length) {
      let j = row.length - 1;
      while (j > 0 && row[j].t !== ' ') j--;
      if (j > 0 && row[j].t === ' ') { const rest = row.splice(j + 1); rows.push(row); row = rest; w = row.reduce((a, y) => a + y.w, 0); }
      else { rows.push(row); row = []; w = 0; }
      if (w + x.w > cols && row.length) { rows.push(row); row = []; w = 0; }
    }
    row.push(x); w += x.w;
  }
  rows.push(row);
  return rows;
}

/* ---------- laying out a frame ---------- */
/* The window rectangles of the tree NODE in the area X, Y, W, H: siblings share the room equally, as the page's
   flex layout does; side-by-side windows have a one-cell divider between them (DIVS). */
function layout(node, x, y, w, h, out, divs) {
  if (node instanceof Ed.Window) { out.push({ win: node, x, y, w, h }); return; }
  const n = node.children.length;
  if (node.dir === 'h') {
    const avail = Math.max(0, w - (n - 1));
    let cx = x;
    node.children.forEach((c, i) => {
      const cw = Math.floor(avail * (i + 1) / n) - Math.floor(avail * i / n);
      if (i) { divs.push({ x: cx, y, h }); cx++; }
      layout(c, cx, y, cw, h, out, divs); cx += cw;
    });
  } else {
    let cy = y;
    node.children.forEach((c, i) => { const ch = Math.floor(h * (i + 1) / n) - Math.floor(h * i / n); layout(c, x, cy, w, ch, out, divs); cy += ch; });
  }
}
const SHAPES = { '': 'box', bar: 'bar', hbar: 'hbar', half: 'half' };
function cursorColor(state, theme) {
  const tok = state === 'normal' || state === 'motion' || state === 'operator' ? 'cursor-normal' : state ? 'cursor-' + state : 'cursor';
  const c = chainColor([tok, 'cursor'], theme), fg = state && state !== 'insert' && state !== 'replace' && state !== 'visual' ? '#ffffff' : null;
  return { color: toHex(c), fg: fg || toHex(chainColor('cursor-fg', theme)) };
}

/* Draw window R (a rectangle from layout) into G; ST is its windowState. Fills R.map (each text row's buffer
   positions, for posAt) and returns where its cursor went. */
function drawWindow(g, r, st) {
  const w = r.win, { b, selected, numbers, nowrap, centered, pt, opts } = st;
  const textRows = Math.max(0, r.h - 1);
  const total = Ed.lineCountB(b);
  const gw = numbers ? Math.max(2, String(total).length) + 1 : 0;
  let x0 = r.x + gw, cols = Math.max(1, r.w - gw);
  if (centered) { const cap = Number(host.page.getVar('center-cols')) || 100; if (cols > cap) { x0 += Math.floor((cols - cap) / 2); cols = cap; } }
  const ptLine = Ed.vLineNo(b, pt);
  let startLine = Ed.scrollStart(w, b, ptLine, Math.max(1, textRows), selected);
  let lines, laid, curRow = -1;
  for (let tries = 0; tries < 4; tries++) {
    w.start = Ed.vLineStart(b, startLine);
    lines = Ed.renderBuffer(b, { ...opts, runs: true, html: false, from: w.start, count: Math.max(1, textRows) + 1, cache: w._mcache });
    w._mcache = lines.cache;
    laid = lines.map(l => { const gl = glyphsOf(l); return { line: l, gl, rows: wrap(gl, cols, nowrap) }; });
    let row = 0; curRow = -1;
    for (const x of laid) { const i = x.rows.findIndex(rw => rw.some(y => y.cur)); if (i >= 0) { curRow = row + i; break; } row += x.rows.length; }
    if (curRow < textRows || ptLine <= startLine) break;
    let need = curRow - textRows + 1, k = 0, acc = 0;
    while (k < laid.length - 1 && acc < need) { acc += laid[k].rows.length; k++; }
    startLine += Math.max(1, k);
  }
  /* Truncated lines scroll sideways to keep the cursor in view. */
  let hs = 0;
  if (nowrap) {
    hs = w._hs || 0;
    for (const x of laid) { let c = 0; for (const y of x.gl) { if (y.cur) { if (c < hs || c >= hs + cols) hs = Math.max(0, c - Math.floor(cols / 2)); break; } c += y.w; } }
    w._hs = hs;
  }
  r.map = []; r.textX = x0; r.textW = cols;
  let y = r.y, shownLines = 0, cursor = null;
  for (const x of laid) {
    if (y >= r.y + textRows) break;
    const l = x.line, rowBase = l.cl && selected ? 'default cl' : 'default';
    shownLines++;
    x.rows.forEach((rw, i) => {
      if (y >= r.y + textRows) return;
      g.fill(r.x, y, r.w, 'default');
      if (gw && i === 0 && l.n !== null && l.n !== undefined) g.text(r.x + gw - 1 - String(l.n).length, y, String(l.n), l.cl && selected ? 'default ln cl' : 'default ln', r.x + gw);
      g.fill(x0, y, Math.min(cols, r.x + r.w - x0), rowBase);
      const pos = new Int32Array(r.w).fill(-1);
      let cx = -hs, lastP = l.o;
      for (const gl of rw) {
        const sx = x0 + cx;
        if (gl.w && cx >= 0 && cx + gl.w <= cols) {
          const k = !gl.k ? rowBase : rowBase === 'default' ? gl.kd || (gl.kd = 'default ' + gl.k) : gl.kc || (gl.kc = 'default cl ' + gl.k);
          g.put(sx, y, gl.t, gl.w, k, x0 + cols);
          for (let j = 0; j < gl.w; j++) pos[sx - r.x + j] = l.o + gl.p;
        } else if (gl.w && cx < cols && cx + gl.w > 0) g.put(sx, y, ' ', 1, rowBase, x0 + cols);
        if (gl.cur && cx >= 0 && cx < cols) cursor = { x: sx, y };
        lastP = l.o + gl.p;
        cx += gl.w;
      }
      const last = i === x.rows.length - 1;
      r.map.push({ y, pos, end: last ? l.o + l.text.length : lastP, endX: Math.max(0, Math.min(r.w - 1, x0 - r.x + cx)) });
      y++;
    });
  }
  const shown = Math.min(shownLines, lines.length);
  w.lastLine = shown > 0 ? Ed.lineNoB(b, lines[shown - 1].o) : startLine - 1; w.rows = Math.max(1, textRows);
  for (; y < r.y + textRows; y++) g.fill(r.x, y, r.w, 'default');
  /* The modeline */
  if (r.h >= 1) drawModeline(g, r, Ed.modelineFields(w, st, ptLine), selected);
  return cursor;
}
function drawModeline(g, r, ml, selected) {
  const y = r.y + r.h - 1, base = selected ? 'modeline' : 'modeline inactive', lim = r.x + r.w;
  g.fill(r.x, y, r.w, base);
  let x = r.x;
  if (ml.tag) x = g.text(x, y, ' ' + ml.tag + ' ', `${base} ml-tag ${ml.state}`, lim) + 1;
  const fields = [[ml.mark, 'ml-state'], [ml.name, 'ml-name'], [ml.pos, 'ml-pos'], [ml.mode, 'ml-mode'], [ml.extra, 'ml-extra'], [ml.sync, 'ml-sync']];
  const cmdW = ml.cmd ? Math.max(6, strWidth(ml.cmd)) : 0, end = lim - 1 - (cmdW ? cmdW + 2 : 0);
  let first = true;
  for (const [s, c] of fields) { if (!s) continue; if (!first) x += 2; first = false; x = g.text(x, y, s, `${base} ${c}${selected ? '' : ' inactive'}`, Math.max(r.x, end)); }
  if (cmdW) g.text(lim - 1 - strWidth(ml.cmd), y, ml.cmd, `${base} ml-cmd`, lim);
}

/* The echo area's rows: the minibuffer line and its candidates, the bindings of a pending prefix, or the message,
   at most MAX rows. Returns {rows: [painter(g, y)], cursor}; painting the rows sets cursor ({x, row}) when the
   minibuffer shows one. */
function echoRows(f, look, cols, max) {
  const rows = [], out = { rows, cursor: null };
  if (E.mini) {
    const v = Ed.miniView();
    const lines = Ed.renderBuffer(E.minibuf, { active: E.focused, lines: false, cursorClass: 'bar', runs: true, html: false });
    const gl = [];
    lines.forEach((l, i) => { if (i) gl.push({ t: '^J', w: 2, p: -1, k: '' }); gl.push(...glyphsOf(l)); });
    const head = (v.count !== null ? Math.max(7, strWidth(v.count) + 1) : 0) + strWidth(v.prompt);
    const flashW = v.flash ? 1 + strWidth(v.flash) : 0, room = Math.max(1, cols - head - flashW);
    let cc = 0, hs = 0; for (const x of gl) { if (x.cur) break; cc += x.w; }
    if (cc >= room) hs = cc - room + 1;
    rows.push((g, y) => {
      g.fill(0, y, cols, 'echo');
      let x = 0;
      if (v.count !== null) { g.text(0, y, v.count, 'echo cc'); x = Math.max(7, strWidth(v.count) + 1); }
      x = g.text(x, y, v.prompt, 'echo prompt');
      let cx = -hs;
      for (const gl1 of gl) {
        if (gl1.cur && cx >= 0) out.cursor = { x: x + cx, row: 0 };
        if (gl1.w && cx >= 0 && cx + gl1.w <= room) g.put(x + cx, y, gl1.t, gl1.w, 'echo' + (gl1.k ? ' ' + gl1.k : ''), x + room);
        cx += gl1.w;
      }
      if (v.flash) g.text(Math.min(cols - flashW, x + Math.max(0, cx)) + 1, y, v.flash, 'echo flash');
    });
    let items = v.items;
    const pad = v.pad, room2 = max - 1;
    if (items.length > room2) { const si = Math.max(0, items.findIndex(it => it.sel)); const from = Math.max(0, Math.min(si - room2 + 1, items.length - room2)); items = items.slice(from, from + room2); }
    const labW = Math.max(24, ...items.map(it => strWidth(it.label)));
    for (const it of items) rows.push((g, y) => {
      const sel = it.sel ? ' sel' : '';
      g.fill(0, y, cols, 'echo cand' + sel);
      let x = 1, k = 0;
      for (const [a, z] of it.marks) { x = g.text(x, y, it.label.slice(k, a), 'echo cand' + sel); x = g.text(x, y, it.label.slice(a, z), 'echo cand cand-m' + sel); k = z; }
      g.text(x, y, it.label.slice(k), 'echo cand' + sel);
      if (it.ann) g.text(1 + labW + 2, y, it.ann, 'echo cand ca' + sel);
    });
    for (let i = 0; i < pad && rows.length < max; i++) rows.push((g, y) => g.fill(0, y, cols, 'echo'));
    rows.length = Math.min(rows.length, max);
    return out;
  }
  const v = Ed.echoView(look);
  if (v.which) {
    const items = look.prefixWait ? [] : look.prefixItems || [];
    const flow = [];   // rows of [x, text, classes]
    let row = [[0, (look.showcmd || '') + '-', 'echo wkp']], x = strWidth((look.showcmd || '') + '-') + 2;
    for (const [k, d] of items) {
      const w = strWidth(k) + 1 + strWidth(d);
      if (x + w > cols && row.length) { flow.push(row); row = []; x = 0; }
      row.push([x, k, 'echo wk-key'], [x + strWidth(k) + 1, d, 'echo']);
      x += w + 3;
    }
    flow.push(row);
    for (const fr of flow.slice(0, max)) rows.push((g, y) => { g.fill(0, y, cols, 'echo'); for (const [x1, s, c] of fr) g.text(x1, y, s, c); });
    return out;
  }
  const parts = [];
  for (const ln of v.text.split('\n')) {
    let cur = '', w = 0;
    for (const ch of ln) { const cw = charWidth(ch.codePointAt(0)); if (w + cw > cols) { parts.push(cur); cur = ''; w = 0; } cur += ch; w += cw; }
    parts.push(cur);
  }
  for (const s of parts.slice(0, Math.max(1, max))) rows.push((g, y) => { g.fill(0, y, cols, 'echo'); g.text(0, y, s, 'echo'); });
  return out;
}

/* The completion popup (corfu) under the cursor of the selected window, or above it when it does not fit. */
function drawCorfu(g, cur, limitY) {
  const c = E.corfu;
  if (!c || E.mini || !cur) return;
  const N = Math.max(3, Number(L.get('corfu-count')) || 10);
  if (c.index < c.scroll) c.scroll = c.index; if (c.index >= c.scroll + N) c.scroll = c.index - N + 1;
  const items = c.cands.slice(c.scroll, c.scroll + N);
  if (!items.length) return;
  const labW = Math.max(...items.map(x => strWidth(x.text))), annW = Math.max(0, ...items.map(x => x.ann ? strWidth(x.ann) : 0));
  const w = Math.min(g.cols, Math.max(20, labW + (annW ? 2 + annW : 0) + 2), 60), h = items.length;
  const x = Math.max(0, Math.min(cur.x - strWidth(c.prefix), g.cols - w));
  const y = cur.y + 1 + h <= limitY ? cur.y + 1 : Math.max(0, cur.y - h);
  items.forEach((it, i) => {
    const sel = i + c.scroll === c.index ? ' cand sel' : '', k = 'corfu' + sel, lim = x + w;
    g.fill(x, y + i, w, k);
    let cx = g.text(x + 1, y + i, it.text.slice(0, c.prefix.length), k + ' cand-m', lim - 1);
    cx = g.text(cx, y + i, it.text.slice(c.prefix.length), k, lim - 1);
    if (it.ann) { const aw = Math.min(strWidth(it.ann), Math.max(0, lim - 1 - cx - 2)); g.text(lim - 1 - aw, y + i, it.ann, k + ' ca', lim - 1); }
  });
}

/* Cells of window R that show buffer positions in the set (or predicate) HIT get class CLS. */
function markCells(g, r, hit, cls) {
  for (const row of r.map) for (let i = 0; i < row.pos.length; i++) { const p = row.pos[i]; if (p >= 0 && hit(p)) g.addClass(r.x + i, row.y, cls); }
}
const AGENT_FADE_MS = 5000;   // as sync.js: an agent's cursor fades after five seconds (R9.13)
function presenceOf(g, rects, out) {
  const now = Date.now();
  let fadeDue = 0;
  for (const r of rects) {
    const b = r.win.buffer;
    if (!b.presence || !b.presence.length) continue;
    for (const p of b.presence) {
      if (p.agent) { const left = AGENT_FADE_MS - (now - p.at); if (left <= 0) continue; fadeDue = fadeDue ? Math.min(fadeDue, left) : left; }
      const col = parseColor(p.color) ? p.color : '#888888';
      for (const [from, to] of p.ranges) {
        if (from === to) {
          for (const row of r.map) {
            let i = row.pos.indexOf(from);
            if (i < 0 && from === row.end) i = row.endX;
            if (i >= 0 && i < r.w) { g.addClass(r.x + i, row.y, 'bg=' + col); out.push({ x: r.x + i, y: row.y, label: String(p.label || ''), color: col }); break; }
          }
        } else markCells(g, r, q => q >= from && q < to, 'tint=' + col);
      }
    }
  }
  return fadeDue;
}

/* The model of frame F (the frame being drawn: withFrame). */
function frameModel(f) {
  const size = f.backend.size() || {}, cols = Math.max(1, size.cols | 0), rows = Math.max(1, size.rows | 0);
  const theme = f.theme || f.backend.theme || (host.page.prefersDark && host.page.prefersDark() ? 'dark' : 'light');
  const g = new Grid(cols, rows);
  const wins = Ed.windowList(), states = new Map(wins.map(w => [w, Ed.windowState(w)]));
  const look = states.get(E.sel) ? states.get(E.sel).look : {};
  const echo = echoRows(f, look, cols, Math.max(1, Math.floor(rows / 2)));
  const winH = Math.max(0, rows - echo.rows.length);
  const rects = [], divs = [];
  layout(E.root, 0, 0, cols, winH, rects, divs);
  let cursor = null;
  const ghosts = [];
  for (const r of rects) {
    const st = states.get(r.win), c = drawWindow(g, r, st);
    if (!c) continue;
    if (st.selected && !E.mini) {   // the frame's own cursor, hollow while the frame does not have the keyboard
      const state = st.look.state || null;
      const shape = !f.focused || state === 'visual' ? 'hollow' : SHAPES[st.look.cursor || ''] || 'box';
      cursor = { x: c.x, y: c.y, shape, ...cursorColor(state, theme) };
    } else ghosts.push({ x: c.x, y: c.y });
  }
  for (const d of divs) for (let y = d.y; y < d.y + d.h && y < winH; y++) g.put(d.x, y, '│', 1, 'default rule');
  echo.rows.forEach((paint, i) => paint(g, winH + i));
  if (echo.cursor && E.mini) cursor = { x: echo.cursor.x, y: winH + echo.cursor.row, shape: f.focused ? 'bar' : 'hollow', ...cursorColor(null, theme) };
  /* Snipe matches in the selected window (stack.js boxes them on the page). */
  const h = E.snipeHl, sr = rects.find(r => r.win === E.sel);
  if (h && sr && sr.win.buffer === h.b && !E.mini && h.str) {
    const t = h.b.rope, fold = h.str === h.str.toLowerCase(), hits = new Set();
    const first = sr.map.length ? Math.max(0, Math.min(...sr.map.map(m => m.pos.find(p => p >= 0) ?? m.end))) : 0, last = sr.map.length ? sr.map[sr.map.length - 1].end : 0;
    const hay = t.slice(first, Math.min(t.length, last + h.str.length)), nd = fold ? h.str.toLowerCase() : h.str, src = fold ? hay.toLowerCase() : hay;
    for (let k = src.indexOf(nd), n = 0; k >= 0 && n < 200; k = src.indexOf(nd, k + 1), n++) {
      if (!h.whole && (h.fwd ? first + k < h.pt : first + k > h.pt)) continue;
      for (let j = 0; j < h.str.length; j++) hits.add(first + k + j);
    }
    if (hits.size) markCells(g, sr, p => hits.has(p), 'snipe');
  }
  const presence = [];
  const fadeDue = presenceOf(g, rects, presence);
  if (fadeDue) { clearTimeout(f._fadeTimer); f._fadeTimer = setTimeout(() => { for (const r of rects) r.win.buffer._presTick = (r.win.buffer._presTick || 0) + 1; Ed.scheduleRender(); }, fadeDue + 20); }
  drawCorfu(g, E.mini ? null : cursor, winH);
  /* Faces: each distinct set of classes resolves once; equal faces share an index. */
  const faces = [], byJson = new Map(), byKey = new Map();
  const face = k => {
    let i = byKey.get(k);
    if (i !== undefined) return i;
    const fc = resolveFace(k, theme), j = JSON.stringify(fc);
    i = byJson.get(j);
    if (i === undefined) { i = faces.length; faces.push(fc); byJson.set(j, i); }
    byKey.set(k, i);
    return i;
  };
  face('default');
  const lines = [];
  for (let y = 0; y < rows; y++) lines.push(g.segments(y, face));
  f._layout = { rects, winH, cols, rows, echoRows: echo.rows.length };
  const sb = E.sel && E.sel.buffer;
  return {
    cols, rows, theme, focused: !!f.focused, title: sb ? sb.name : '',
    faces, lines, cursor, ghosts, presence,
    windows: rects.map(r => ({ id: r.win.id, x: r.x, y: r.y, w: r.w, h: r.h, selected: r.win === E.sel, buffer: r.win.buffer.name, start: r.win.start, lastLine: r.win.lastLine })),
  };
}
H.renderModel = f => {
  const model = frameModel(f);
  f.lastModel = model;
  f.backend.draw(model);
};

/* What is at cell X, Y of model frame F as last drawn: {area: 'text', window, pos} (pos the buffer position
   under the cell, or the end of the row past its text), {area: 'modeline', window}, {area: 'divider'},
   {area: 'echo'}, or null outside the frame. A backend maps a mouse click with it. */
function posAt(f, x, y) {
  const lay = f && f._layout;
  if (!lay || x < 0 || y < 0 || x >= lay.cols || y >= lay.rows) return null;
  if (y >= lay.winH) return { area: 'echo' };
  for (const r of lay.rects) {
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue;
    if (y === r.y + r.h - 1) return { area: 'modeline', window: r.win };
    const row = r.map.find(m => m.y === y);
    if (!row) return { area: 'text', window: r.win, pos: r.win.buffer.rope.length };
    const i = x - r.x, p = row.pos[i];
    if (p >= 0) return { area: 'text', window: r.win, pos: p };
    const before = i > 0 && row.pos.slice(0, i).some(q => q >= 0);
    return { area: 'text', window: r.win, pos: before ? row.end : Math.max(0, row.pos.find(q => q >= 0) ?? row.end) };
  }
  return { area: 'divider' };
}
/* The backend's size or theme changed: draw again. */
function redraw(f) { if (f && f.backend) { f._rkey = null; Ed.scheduleRender(); } }
function setTheme(f, theme) { f.theme = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : null; redraw(f); }

Ed.display = { PALETTE, FACES, resolveFace, parseColor, charWidth, strWidth, glyphsOf, wrap, frameModel, posAt, redraw, setTheme };
})();
