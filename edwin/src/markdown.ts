/* markdown-mode for Edwin (spec §10.1, R10.1-R10.5): the lexer that gives every shown character a face,
   the display overlays that show a ((block reference)) as the text it names, and the primitives behind
   the commands of scm/markdown.scm. The grammar is scm/notes-syntax.scm, read through the Scheme variables
   it defines (the regexp sources and the task keyword table shared with Org), so the mode, the notes index
   and Org agree on what a link, a task or a field is.

   Font-lock is incremental (R10.5): hooks.lexSeg classifies the shown segment only, as org.ts does, and
   the one piece of context a line needs from before the segment, whether it sits inside a ``` fence, comes
   from a per-buffer index of fence lines that an edit updates from the changed lines alone (hooks.edited),
   never by a pass over the whole text. Faces are CSS classes named markdown-*; the frame runtime maps them
   to the board's --syn-* tokens (R9.10) through the --md-* variables the style below reads first.

   A reference is drawn as its resolved text by a pass over the rendered lines (hooks.renderOverlay): the
   renderer emits spans of classes and text only, so the span of a reference that is not on the point's
   line gets the resolved text put in place after the lines are drawn. Resolution uses address.scm
   (block-address, resolve-address) over the open pages, then resolve-ref-function (bound by the frame
   runtime), then the notes index when this runtime is the server image. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, truthy, listOf, arr, NIL, Sym } = L;
const { D, CMD } = L;
const { bol, eol, lineNoB, lineStartB } = Ed;
const cur = () => E.current;
const str = (x: SchemeValue) => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x as string; };
const num = (x: SchemeValue) => { if (typeof x !== 'number') signal('wrong-type-argument', 'expected an integer, got', x); return Math.trunc(x as number); };
const MD = { gen: 0, stats: { lexed: 0, lexCalls: 0, fenceScans: 0, fenceUpdates: 0 }, shift: false, rcache: new Map() };
const isMd = (b: EdBuffer | null | undefined) => !!b && (b.mode === 'markdown-mode' || (Ed.modeParents.size > 0 && Ed.modeChain(b.mode).includes('markdown-mode')));
const mdBuffers = () => E.buffers.filter(isMd);

/* ---------- the shipped Scheme through require ----------
   load-path gets a last entry, edwin:scm, whose files are the shipped Scheme the host carries (the page's
   text/x-scheme blocks in a browser, scm/ under Node). org.scm ends with (require 'markdown), which loads
   notes-syntax.scm, address.scm and markdown.scm this way, after Org and before init.scm. */
const SHIPPED = 'edwin:scm';
{
  const prev = L.S.hooks.readFile;
  L.S.hooks.readFile = p => {
    const m = /^edwin:scm\/([^/]+)$/.exec(String(p));
    if (m) { const t = Ed.host.config(m[1]); return t === null || t === undefined ? null : t; }
    return prev ? prev(p) : null;
  };
  const lp = arr(L.get('load-path') ?? NIL);
  if (!lp.includes(SHIPPED)) L.set('load-path', listOf([...lp, SHIPPED]));
}

/* ---------- the grammar: notes-syntax.scm's regexps and keywords, compiled once per value ---------- */
const DEFAULTS: Record<string, string> = {
  'notes-wiki-link-regexp': '\\[\\[([^\\[\\]\\n|]+?)(?:\\|([^\\[\\]\\n]*)|\\]\\[([^\\]\\n]*))?\\]\\]',
  'notes-block-ref-regexp': '\\(\\(([^()\\n]+?)\\)\\)',
  'notes-inline-link-regexp': '(?<!!)\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)',
  'notes-anchor-regexp': '(?:^|\\s)\\^([A-Za-z0-9_-]+)\\s*$',
  'notes-field-regexp': '^\\s*(?:[-*+]\\s+)?([A-Za-z][\\w-]*)::\\s*(.*?)\\s*$',
  'notes-priority-regexp': '\\[#([A-Z0-9])\\]',
  'notes-planning-regexp': '(SCHEDULED|DEADLINE|CLOSED):\\s*[<\\[](\\d{4}-\\d{2}-\\d{2})[^>\\]\\n]*[>\\]]',
  'notes-md-heading-regexp': '^(#{1,6})[ \\t]+(.*?)[ \\t]*$',
  'notes-md-setext-regexp': '^(=+|-+)[ \\t]*$',
  'notes-list-item-regexp': '^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$',
  'notes-inline-tag-regexp': '(?:^|[\\s(])#([A-Za-z][\\w/-]*)',
  'notes-fence-regexp': '^\\s*(```|~~~)',
  'notes-url-regexp': '^(?:https?|mailto|ftp):',
};
const rxCache = new Map<string, { src: SchemeValue; re: RegExp }>();
function rx(name: string, flags = '') {
  let src = L.get(name); if (typeof src !== 'string') src = DEFAULTS[name];
  const key = name + '/' + flags, c = rxCache.get(key);
  if (c && c.src === src) return c.re;
  let re; try { re = new RegExp(src as string, flags); } catch (e) { re = new RegExp(DEFAULTS[name], flags); }
  rxCache.set(key, { src, re });
  return re;
}
/* The keyword sets {all, done, src} from notes-task-keywords and notes-done-keywords (the shared table). */
let kwCache: MdKeywords | null = null;
function taskKeywords() {
  const v = L.get('notes-task-keywords'), d = L.get('notes-done-keywords');
  if (kwCache && kwCache.src === v && kwCache.dsrc === d) return kwCache;
  const all = v ? arr(v).map(String) : ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED', 'DOING', 'NOW', 'LATER'];
  const done = d ? arr(d).map(String) : ['DONE', 'CANCELLED'];
  return kwCache = { src: v, dsrc: d, all, done };
}
/* The task keyword at K in LINE, followed by a blank or the end: the keyword, or null. */
function keywordAt(line: string, k: number, kw: MdKeywords) {
  for (const w of kw.all) if (line.startsWith(w, k) && (k + w.length === line.length || line[k + w.length] === ' ' || line[k + w.length] === '\t')) return w;
  return null;
}

/* ---------- faces: a class per character of the shown segment ---------- */
const DEFAULT_KWS = ['todo', 'next', 'waiting', 'hold', 'someday', 'done', 'cancelled', 'doing', 'now', 'later'];
const FACES = ['', 'markdown-heading-1', 'markdown-heading-2', 'markdown-heading-3', 'markdown-heading-4', 'markdown-heading-5', 'markdown-heading-6',
  'markdown-markup', 'markdown-bold', 'markdown-italic', 'markdown-strike', 'markdown-code', 'markdown-code-block', 'markdown-fence',
  'markdown-link', 'markdown-url', 'markdown-image', 'markdown-wiki-link', 'markdown-block-ref', 'markdown-block-ref-display',
  'markdown-anchor', 'markdown-tag', 'markdown-list', 'markdown-checkbox', 'markdown-checkbox-done',
  ...DEFAULT_KWS.map(k => 'markdown-task-' + k), 'markdown-task-other', 'markdown-task-other-done', 'markdown-task-done-text',
  'markdown-field-key', 'markdown-priority', 'markdown-planning', 'markdown-date', 'markdown-quote', 'markdown-table', 'markdown-table-delimiter',
  'markdown-hr', 'markdown-front-matter'];
const F: Record<string, number> = {}; FACES.forEach((nm, i) => { if (nm) F[nm.replace(/^markdown-/, '')] = i; });
const taskFace = (w: string, kw: MdKeywords) => { const i = FACES.indexOf('markdown-task-' + w.toLowerCase()); return i > 0 ? i : kw.done.includes(w) ? F['task-other-done'] : F['task-other']; };
const TS_RE = /[<[]\d{4}-\d{2}-\d{2}(?: [^\s>\]]{1,3}\.?)?(?: \d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)?(?: [+.]+\d+[hdwmy])?(?: -\d+[hdwmy])?[>\]]/g;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const PRE = /[\s\-('"{>]/, POST = /[\s\-.,:!?;'")}\\[>]/;
const EM1: Record<string, string> = { '*': 'italic', '_': 'italic' }, EM2: Record<string, string> = { '*': 'bold', '_': 'bold', '~': 'strike' };

/* ---------- the fence index: the line starts of every ``` or ~~~ line, kept up to date from the changed
   lines of each edit (R10.5), so a line's "inside a fence" context costs a binary search ---------- */
function scanFences(r: Rope, from: number, to: number, out: number[]) {
  const re = rx('notes-fence-regexp');
  for (let ls = from; ls <= to && ls <= r.length; ) {
    const le = eol(r, ls);
    if (le - ls >= 3 && re.test(r.slice(ls, Math.min(le, ls + 80)))) out.push(ls);
    if (le >= r.length) break;
    ls = le + 1;
  }
  return out;
}
function fenceIndex(b: EdBuffer) {
  let c = b._mdf as MdFences | undefined;
  if (c && c.ver === b.ver) return c.list;
  MD.stats.fenceScans++;
  const r = b.rope, list: number[] = [];
  /* A native search for the markers finds the candidate lines; only those lines are tested. */
  for (const needle of ['```', '~~~']) for (let k = r.indexOf(needle); k >= 0; k = r.indexOf(needle, eol(r, k) + 1)) { const ls = bol(r, k); if (/^\s*$/.test(r.slice(ls, k))) list.push(ls); }
  list.sort((x, y) => x - y);
  b._mdf = { ver: b.ver, list };
  return list;
}
/* Fence lines strictly before LS, counted: odd means LS is inside a fence. */
function fencesBefore(list: number[], ls: number) { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < ls) lo = m + 1; else hi = m; } return lo; }
/* Front matter: a --- line at the top closed by the next --- line (within 200 lines); its end offset or -1. */
function frontMatterEnd(b: EdBuffer) {
  const c = b._mdfm as MdFrontMatter | undefined; if (c && c.ver === b.ver) return c.end;
  const r = b.rope; let end = -1;
  if (/^---[ \t]*(\r?\n|$)/.test(r.slice(0, 8))) {
    let ls = eol(r, 0) + 1;
    for (let i = 0; i < 200 && ls < r.length; i++) { const le = eol(r, ls); if (/^---[ \t]*\r?$/.test(r.slice(ls, le))) { end = le; break; } ls = le + 1; }
    if (end < 0) end = r.length;
  }
  b._mdfm = { ver: b.ver, end };
  return end;
}
const prevEdited = H.edited;
H.edited = b => {
  if (prevEdited) prevEdited(b);
  MD.gen++;
  if (!isMd(b)) return;
  const c = b._mdf as MdFences | undefined, ed = b.log[b.log.length - 1];
  if (!c || !ed || ed.v !== b.ver) return;
  /* The touched lines in the new text run from LS to LE; in the old text the same lines ended at LE - D.
     Fence lines before them stay, those after move by D, and the touched lines are scanned again. */
  const r = b.rope, d = ed.ins.length - ed.del.length, ls = bol(r, ed.pos), le = eol(r, ed.pos + ed.ins.length), oldLe = le - d;
  const list: number[] = [];
  for (const f of c.list) { if (f < ls) list.push(f); else if (f > oldLe) list.push(f + d); }
  const found = scanFences(r, ls, le, []);
  if (found.length) { list.push(...found); list.sort((x, y) => x - y); }
  c.list = list; c.ver = b.ver; MD.stats.fenceUpdates++;
  const fm = b._mdfm as MdFrontMatter | undefined; if (fm && fm.end >= 0 && ed.pos > fm.end) fm.ver = b.ver;
};

/* ---------- the lexer ---------- */
function lexMdSeg(b: EdBuffer, from: number, to: number, seg: string, ptLine: number) {
  const n = seg.length, cls = new Uint8Array(n), r = b.rope, kw = taskKeywords(), folds = b.folds && b.folds.length ? b.folds : null;
  const fences = fenceIndex(b), fm = frontMatterEnd(b), refs: MdRef[] = [];
  const WIKI = rx('notes-wiki-link-regexp', 'g'), REF = rx('notes-block-ref-regexp', 'g'), INLINE = rx('notes-inline-link-regexp', 'g');
  const ANCHOR = rx('notes-anchor-regexp'), FIELD = rx('notes-field-regexp'), PRIO = rx('notes-priority-regexp', 'g'), PLAN = rx('notes-planning-regexp', 'g');
  const HEAD = rx('notes-md-heading-regexp'), SETEXT = rx('notes-md-setext-regexp'), ITEM = rx('notes-list-item-regexp'), TAG = rx('notes-inline-tag-regexp', 'g'), FENCE = rx('notes-fence-regexp');
  MD.stats.lexed += n; MD.stats.lexCalls++;
  const fill = (a: number, z: number, c: number) => { for (let k = a; k < z; k++) cls[k] = c; };
  /* Inline markup over the segment range A..Z of LINE (which starts at LS), on top of BASE. */
  const inline = (line: string, ls: number, a: number, z: number, base: number) => {
    if (z <= a) return;
    fill(a, z, base);
    const s = line.slice(a - ls, z - ls), off = a, bp = from + a;
    let m;
    const free = (i: number, j: number) => { for (let k = i; k < j; k++) if (cls[off + k] !== base) return false; return true; };
    /* Code spans first: nothing inside them is markup. */
    const code = /`+/g;
    while ((m = code.exec(s))) {
      const open = m[0], j = s.indexOf(open, m.index + open.length);
      if (j < 0 || !free(m.index, j + open.length)) continue;
      fill(off + m.index, off + m.index + open.length, F.markup); fill(off + m.index + open.length, off + j, F.code); fill(off + j, off + j + open.length, F.markup);
      code.lastIndex = j + open.length;
    }
    const img = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
    while ((m = img.exec(s))) if (free(m.index, m.index + m[0].length)) fill(off + m.index, off + m.index + m[0].length, F.image);
    WIKI.lastIndex = 0;
    while ((m = WIKI.exec(s))) {
      const i = m.index, e = i + m[0].length; if (!free(i, e)) continue;
      fill(off + i, off + i + 2, F.markup);
      const t = m[1].length; fill(off + i + 2, off + i + 2 + t, F['wiki-link']);
      let k = i + 2 + t;
      if (m[2] !== undefined) { cls[off + k] = F.markup; fill(off + k + 1, off + k + 1 + m[2].length, F['wiki-link']); k += 1 + m[2].length; }
      else if (m[3] !== undefined) { fill(off + k, off + k + 2, F.markup); fill(off + k + 2, off + k + 2 + m[3].length, F['wiki-link']); k += 2 + m[3].length; }
      fill(off + k, off + e, F.markup);
    }
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(s))) {
      const i = m.index, e = i + m[0].length; if (!free(i, e)) continue;
      cls[off + i] = F.markup; fill(off + i + 1, off + i + 1 + m[1].length, F.link);
      const u = i + 1 + m[1].length; fill(off + u, off + u + 2, F.markup); fill(off + u + 2, off + e - 1, F.url); cls[off + e - 1] = F.markup;
    }
    REF.lastIndex = 0;
    while ((m = REF.exec(s))) {
      const i = m.index, e = i + m[0].length; if (!free(i, e)) continue;
      const raw = ls + from === ptLine;
      fill(off + i, off + e, raw ? F['block-ref'] : F['block-ref-display']);
      if (!raw) refs.push({ s: bp + i, e: bp + e, addr: m[1].trim() });
    }
    const ang = /<((?:https?|mailto|ftp):[^>\s]+)>/g;
    while ((m = ang.exec(s))) if (free(m.index, m.index + m[0].length)) fill(off + m.index, off + m.index + m[0].length, F.url);
    const url = /\bhttps?:\/\/[^\s<>\]()]+/g;
    while ((m = url.exec(s))) if (free(m.index, m.index + m[0].length)) fill(off + m.index, off + m.index + m[0].length, F.url);
    TS_RE.lastIndex = 0;
    while ((m = TS_RE.exec(s))) if (free(m.index, m.index + m[0].length)) fill(off + m.index, off + m.index + m[0].length, F.date);
    PRIO.lastIndex = 0;
    while ((m = PRIO.exec(s))) if (free(m.index, m.index + m[0].length)) fill(off + m.index, off + m.index + m[0].length, F.priority);
    const an = ANCHOR.exec(s);
    if (an) { const i = an.index + an[0].indexOf('^'); if (free(i, i + 1 + an[1].length)) fill(off + i, off + i + 1 + an[1].length, F.anchor); }
    TAG.lastIndex = 0;
    while ((m = TAG.exec(s))) { const i = m.index + m[0].indexOf('#'); if (free(i, i + 1 + m[1].length)) fill(off + i, off + i + 1 + m[1].length, F.tag); }
    /* Emphasis: **bold** __bold__ *italic* _italic_ ~~strike~~, markers kept visible as markup. */
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      let style = EM1[ch], w = 1;
      if (EM2[ch] && s[i + 1] === ch) { style = EM2[ch]; w = 2; }
      if (!style || cls[off + i] !== base) continue;
      if (i > 0 && !PRE.test(s[i - 1])) continue;
      if (i + w >= s.length || /\s/.test(s[i + w]) || s[i + w] === ch) continue;
      let j = i + w, ok = false;
      for (; j < s.length; j++) {
        if (s[j] !== ch || (w === 2 && s[j + 1] !== ch) || (w === 1 && s[j + 1] === ch && s[j - 1] !== ch)) continue;
        if (j > i + w && !/\s/.test(s[j - 1]) && (j + w >= s.length || POST.test(s[j + w]))) { ok = free(i, j + w); break; }
      }
      if (!ok) continue;
      const c = F[style];
      fill(off + i, off + i + w, F.markup); fill(off + i + w, off + j, c); fill(off + j, off + j + w, F.markup);
      i = j + w - 1;
    }
  };
  /* The text of the line after LE (a segment offset), from the rope: Setext underlines sit on it. */
  const nextLine = (le: number) => { const p = from + le + 1; if (p >= r.length) return null; return r.slice(p, eol(r, p)); };
  const prevLine = (ls: number) => { const p = from + ls; if (p === 0) return null; const q = bol(r, p - 1); return r.slice(q, p - 1); };
  const setextOf = (line: string, under: string | null) => !!under && SETEXT.test(under) && /\S/.test(line) && !ITEM.test(line) && !/^\s*[>|#]/.test(line) && !HR_RE.test(line) && !FENCE.test(line) && !SETEXT.test(line);
  const lexLine = (line: string, ls: number, le: number) => {
    const bp = from + ls;
    if (fm >= 0 && bp <= fm) { fill(ls, le, F['front-matter']); return; }
    const fenceLine = line.length >= 3 && FENCE.test(line);
    if (fenceLine) { fill(ls, le, F.fence); return; }
    if (fencesBefore(fences, bp) & 1) { fill(ls, le, F['code-block']); return; }
    let m;
    if ((m = HEAD.exec(line))) {
      const level = m[1].length, base = F['heading-' + level];
      fill(ls, ls + level, F.markup);
      let k = level; while (line[k] === ' ' || line[k] === '\t') k++;
      let b0 = base;
      const w = keywordAt(line, k, kw);
      if (w) { fill(ls + k, ls + k + w.length, taskFace(w, kw)); k += w.length; while (line[k] === ' ') k++; if (kw.done.includes(w)) b0 = F['task-done-text']; }
      inline(line, ls, ls + k, le, b0); return;
    }
    if (setextOf(line, nextLine(le))) { inline(line, ls, ls, le, nextLine(le)![0] === '=' ? F['heading-1'] : F['heading-2']); return; }
    if (SETEXT.test(line) && line.length) { const pl = prevLine(ls); if (pl !== null && setextOf(pl, line)) { fill(ls, le, F.markup); return; } }
    if (HR_RE.test(line)) { fill(ls, le, F.hr); return; }
    if (/^\s*>/.test(line)) { const k = line.indexOf('>') + 1; fill(ls, ls + k, F.markup); inline(line, ls, ls + k, le, F.quote); return; }
    if (/^\s*\|/.test(line)) { fill(ls, le, TABLE_DELIM_RE.test(line) ? F['table-delimiter'] : F.table); if (!TABLE_DELIM_RE.test(line)) for (let i = 0; i < line.length; i++) if (line[i] === '|') cls[ls + i] = F.markup; return; }
    if ((m = ITEM.exec(line))) {
      const bs = ls + m[1].length, be = bs + m[2].length;
      fill(ls, bs, 0); fill(bs, be, F.list);
      let k = m[0].length - m[3].length;
      const cb = /^\[([ xX-])\]\s?/.exec(line.slice(k));
      if (cb) { fill(ls + k, ls + k + 3, cb[1] === ' ' ? F.checkbox : F['checkbox-done']); k += cb[0].length; }
      let base = 0;
      const w = keywordAt(line, k, kw);
      if (w) { fill(ls + k, ls + k + w.length, taskFace(w, kw)); k += w.length; while (line[k] === ' ') k++; if (kw.done.includes(w)) base = F['task-done-text']; }
      const fd = FIELD.exec(line);
      if (fd && !w) { const ks = line.indexOf(fd[1], k); if (ks >= 0) { fill(ls + ks, ls + ks + fd[1].length, F['field-key']); fill(ls + ks + fd[1].length, ls + ks + fd[1].length + 2, F.markup); k = ks + fd[1].length + 2; } }
      inline(line, ls, ls + k, le, base); return;
    }
    if ((m = FIELD.exec(line))) { const ks = line.indexOf(m[1]); fill(ls, ls + ks, 0); fill(ls + ks, ls + ks + m[1].length, F['field-key']); fill(ls + ks + m[1].length, ls + ks + m[1].length + 2, F.markup); inline(line, ls, ls + ks + m[1].length + 2, le, 0); return; }
    if (/^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(line)) {
      fill(ls, le, 0); PLAN.lastIndex = 0;
      while ((m = PLAN.exec(line))) { fill(ls + m.index, ls + m.index + m[1].length + 1, F.planning); fill(ls + m.index + m[1].length + 1, ls + m.index + m[0].length, F.date); }
      return;
    }
    inline(line, ls, ls, le, 0);
  };
  let ls = 0;
  while (ls < n) {
    if (folds) { const f = Ed.foldAt(folds, from + ls); if (f) { ls = f.e + 1 - from; continue; } }
    let le = seg.indexOf('\n', ls); if (le < 0) le = n;
    lexLine(seg.slice(ls, le), ls, le);
    ls = le + 1;
  }
  return { cls, refs };
}
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  if (!isMd(b)) return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const ptl = bol(b.rope, b.pt), fv = b._foldVer || 0, kw = L.get('notes-task-keywords'), c = b._mlx as MdLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to && c.fv === fv && c.ptl === ptl && c.kw === kw) return c;
  const { cls, refs } = lexMdSeg(b, from, to, seg as string, ptl);
  return b._mlx = { ver: b.ver, from, to, fv, ptl, kw, cls, names: FACES, refs };
};
/* The face of the character at buffer position P (0-based), lexing its line with the buffer's context. */
function faceAt(b: EdBuffer, p: number) {
  const r = b.rope; if (p < 0 || p >= r.length) return '';
  const ls = bol(r, p), le = Math.min(r.length, eol(r, p) + 1);
  const { cls } = lexMdSeg(b, ls, le, r.slice(ls, le), bol(r, b.pt));
  return FACES[cls[p - ls]] || '';
}

/* ---------- pages, addresses and references ---------- */
const stripExt = (s: string) => s.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
function pageName(b: EdBuffer) {
  const v = Ed.localValue(b, 'page-name');
  if (typeof v === 'string' && v) return v;
  return stripExt(b.file || b.name);
}
function findPage(name: SchemeValue) { name = String(name).trim().toLowerCase(); return mdBuffers().find(b => pageName(b).toLowerCase() === name) || null; }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* Where the anchor LABEL is in B: a server anchor of that label (meta.anchors, R9.12), else the line that ends in ^LABEL. */
function anchorPos(b: EdBuffer, label: string) {
  const anchors: { label?: unknown; pos?: unknown }[] = b.meta && Array.isArray(b.meta.anchors) ? b.meta.anchors : [];
  for (const a of anchors) if (a && a.label === label && typeof a.pos === 'number') return Math.min(a.pos, b.rope.length);
  const m = new RegExp('(?:^|[ \\t])\\^' + esc(label) + '[ \\t]*$', 'm').exec(b.text);
  return m ? bol(b.rope, m.index + m[0].length - 1) : null;
}
/* The text of the block at POS in B, as resolveRef in app.js shows it: the rest of the line, its bullet or
   hashes dropped, at most 90 characters, the page name when the line is blank. */
function blockText(b: EdBuffer, pos: number) {
  const r = b.rope, p = Math.min(pos, r.length), le = eol(r, p), ls = bol(r, p);
  let text = (r.slice(p, le).trim() || r.slice(ls, le).trim()).replace(/^([-*+]|\d+\.)\s+|^#+\s+/, '');
  return text.length > 90 ? text.slice(0, 88) + '…' : text || pageName(b);
}
const pagesAlist = () => listOf(mdBuffers().map(b => new L.Pair(pageName(b), b.text)));
/* Resolve ADDR over the open pages: {b, pos} or null. Addresses: Name#anchor, ^anchor, Name › Heading ¶N "quote", Name. */
function resolveLocal(addr: string): MdHit | null {
  let m;
  if ((m = /^([^#›]+)#\^?([\w-]+)$/.exec(addr))) { const b = findPage(m[1]); if (b) { const p = anchorPos(b, m[2]); if (p !== null) return { b, pos: p }; } return null; }
  if ((m = /^\^([\w-]+)$/.exec(addr))) { for (const b of mdBuffers()) { const p = anchorPos(b, m[1]); if (p !== null) return { b, pos: p }; } return null; }
  if (/›|¶|"/.test(addr)) {
    const r = L.call('resolve-address', [addr, pagesAlist()]);
    if (r instanceof L.Pair) { const b = findPage(r.car); if (b) return { b, pos: Math.min(num(r.cdr), b.rope.length) }; }
    return null;
  }
  const b = findPage(addr);
  return b ? { b, pos: 0 } : null;
}
/* The record of a note in the server's index, as an object, or null. */
function indexRecord(name: string) {
  if (!L.fnOrNull(intern('notes-file')) || !L.fnOrNull(intern('image-server?'))) return null;
  let v; try { if (!truthy(L.call('image-server?', []))) return null; v = L.call('notes-file', [name]); } catch (e) { return null; }
  if (!v || v === false) return null;
  const o: Record<string, SchemeValue> = {}; for (const p of arr(v)) if (p instanceof L.Pair) o[p.car instanceof Sym ? p.car.name : String(p.car)] = p.cdr;
  return o;
}
/* The text shown for ((ADDR)): from the open pages, else resolve-ref-function, else the server's index; null when nothing names it. */
function resolveRef(addr: string) {
  addr = String(addr).trim();
  const key = addr, gen = MD.gen + ':' + String(L.get('notes-generation') ?? ''), c = MD.rcache.get(key);
  if (c && c.gen === gen) return c.text;
  let text: string | null = null;
  const hit = resolveLocal(addr);
  if (hit) text = blockText(hit.b, hit.pos);
  if (text === null) {
    const fn = L.get('resolve-ref-function');
    if (typeof fn === 'function') { try { const v = L.apply(fn, [addr]); if (typeof v === 'string') text = v; } catch (e) { Ed.reportError(e); } }
  }
  if (text === null) {
    const name = addr.split(/›|#/)[0].trim(), rec = indexRecord(name);
    if (rec) {
      const title = typeof rec.title === 'string' ? rec.title : name, body = typeof rec.body === 'string' ? rec.body : '';
      if (/›|¶|"/.test(addr) && body) { const r = L.call('resolve-address', [addr, listOf([new L.Pair(title, body)])]); if (r instanceof L.Pair) { const p = num(r.cdr), le = body.indexOf('\n', p), t = body.slice(p, le < 0 ? body.length : le).trim().replace(/^([-*+]|\d+\.)\s+|^#+\s+/, ''); text = t || title; } }
      if (text === null) text = title;
    }
  }
  if (MD.rcache.size > 2000) MD.rcache.clear();
  MD.rcache.set(key, { gen, text });
  return text;
}
const displayText = (addr: string) => { const t = resolveRef(addr); return t === null ? addr + ' · not found' : t; };
/* The link at P in B: {kind: wiki|ref|inline|url, target, s, e} or null. */
function linkAt(b: EdBuffer, p: number) {
  const r = b.rope, ls = bol(r, p), le = eol(r, p), line = r.slice(ls, le);
  const WIKI = rx('notes-wiki-link-regexp', 'g'), REF = rx('notes-block-ref-regexp', 'g'), INLINE = rx('notes-inline-link-regexp', 'g');
  const res: [RegExp, (m: RegExpExecArray) => { kind: string; target: string }][] = [[WIKI, m => ({ kind: 'wiki', target: m[1].trim() })], [REF, m => ({ kind: 'ref', target: m[1].trim() })], [INLINE, m => ({ kind: 'inline', target: m[2] })],
    [/<((?:https?|mailto|ftp):[^>\s]+)>/g, m => ({ kind: 'url', target: m[1] })], [/\bhttps?:\/\/[^\s<>\]()]+/g, m => ({ kind: 'url', target: m[0] })]];
  for (const [re, mk] of res) { let m; re.lastIndex = 0; while ((m = re.exec(line))) { const s = ls + m.index, e = s + m[0].length; if (p >= s && p < e) return { s, e, ...mk(m) }; } }
  return null;
}
/* The references whose display text replaces their source in the window: those not on the point's line. */
function refsIn(b: EdBuffer, from: number, to: number) {
  const lx = H.lexSeg!(b, from, to, b.rope.slice(from, to)) as MdLex | null;
  return lx && lx.refs ? lx.refs : [];
}

/* ---------- the editing primitives behind markdown.scm ---------- */
D('%markdown-outline-enter', '', 'RET in a list item, as outlineEnter of the page cards: a sibling bullet (numbered ones count up, task bullets keep [ ]), outdent or end the list on an empty item. #f when point is not in a list item.', () => {
  const b = cur();
  if (b.markActive && b.mark !== null && b.mark !== b.pt) return false;
  const r = b.rope, ls = bol(r, b.pt), le = eol(r, b.pt), line = r.slice(ls, le);
  const m = /^(\s*)([-*+]|\d+\.)\s(.*)$/.exec(line);
  if (!m) return false;
  const box = /^\[([ xX-])\]\s?/.exec(m[3]), body = box ? m[3].slice(box[0].length) : m[3];
  if (!body.trim() && b.pt === le) {
    if (m[1].length >= 2) Ed.deleteText(b, ls, ls + 2); else Ed.replaceText(b, ls, le, '');
    b.pt = Math.min(b.pt, eol(b.rope, ls));
    return true;
  }
  const bullet = /\d+\./.test(m[2]) ? (parseInt(m[2], 10) + 1) + '.' : m[2], ins = '\n' + m[1] + bullet + ' ' + (box ? '[ ] ' : '');
  const p = b.pt;
  Ed.replaceText(b, p, p, ins); b.pt = p + ins.length;
  return true;
});
/* The lines a shift applies to: the region's lines in Visual state or with an active mark, else the line of point. */
function shiftTarget(b: EdBuffer) {
  const r = b.rope;
  let s = b.pt, e = b.pt, region = false;
  if (EC.stateOf(b) === 'visual' && b.mark !== null) { [s, e] = EC.visualRange(b, true); region = true; }
  else if (b.markActive && b.mark !== null && b.mark !== b.pt) { s = Math.min(b.pt, b.mark); e = Math.max(b.pt, b.mark); region = true; }
  const last = region && e > s ? e - 1 : s, lines: number[] = [];
  for (let ls = bol(r, s); ; ls = eol(r, ls) + 1) { lines.push(ls); if (ls > last || eol(r, ls) >= r.length || eol(r, ls) + 1 > last) break; }
  return { lines, region };
}
D('%markdown-shift-lines', 'DIR', 'Indent (DIR 1) or dedent (DIR -1) by two spaces the list item at point, or every line of the region, as shiftLines of the page cards. #f when there is no region and point is not in a list item.', ([dir]: SchemeValue[]) => {
  const b = cur(), d = num(dir) > 0 ? 1 : -1, ITEM = rx('notes-list-item-regexp');
  const { lines, region } = shiftTarget(b);
  if (!region && !ITEM.test(b.rope.slice(lines[0], eol(b.rope, lines[0])))) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ls = lines[i], r = b.rope;
    if (d > 0) Ed.replaceText(b, ls, ls, '  ');
    else { const m = /^ {1,2}/.exec(r.slice(ls, ls + 2)); if (m) Ed.deleteText(b, ls, ls + m[0].length); }
  }
  if (region) { if (EC.stateOf(b) === 'visual') EC.exitVisual(b); b.pt = EC.firstNonBlank(b.rope, lines[0]); b.markActive = false; }
  return true;
});
/* The task line at LS: the start of its keyword slot K, the keyword there (or null) and where the text after it begins. */
function taskSlot(b: EdBuffer, ls: number) {
  const r = b.rope, le = eol(r, ls), line = r.slice(ls, le), kw = taskKeywords();
  const pm = /^(\s*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX-]\]\s+)?|#{1,6}\s+)?/.exec(line)!;
  const k = pm[2] ? pm[0].length : pm[1].length;
  const w = keywordAt(line, k, kw);
  let z = k; if (w) { z = k + w.length; while (line[z] === ' ') z++; }
  return { line, k, kw: w, z, le };
}
D('%markdown-todo-cycle', 'BACK', 'Set the task at point to the next (or with BACK the previous) state of markdown-todo-cycle-order; a keyword outside the cycle goes to its column of markdown-todo-columns first. The new keyword.', ([back]: SchemeValue[]) => {
  const b = cur(), r = b.rope, ls = bol(r, b.pt);
  if (!/\S/.test(r.slice(ls, eol(r, ls)))) signal('user-error', 'Not on a task line');
  const { k, kw, z } = taskSlot(b, ls);
  const order = arr(L.get('markdown-todo-cycle-order') ?? NIL).map(String);
  if (!order.length) signal('user-error', 'markdown-todo-cycle-order is empty');
  const cols = new Map(arr(L.get('markdown-todo-columns') ?? NIL).filter((p): p is SchemePair => p instanceof L.Pair).map(p => [String(p.car), String(p.cdr)] as [string, string]));
  const col = kw ? (cols.get(kw) || L.call('notes-task-keyword-base', [kw]) || kw) : null, j = col ? order.indexOf(col as string) : -1;
  const next = truthy(back) ? (j < 0 ? order[order.length - 1] : order[(j + order.length - 1) % order.length]) : (j < 0 ? order[0] : order[(j + 1) % order.length]);
  Ed.replaceText(b, ls + k, ls + z, next + ' ');
  if (b.pt < ls + k) b.pt = ls + k;
  try { L.runHook('markdown-after-todo-state-change-hook'); } catch (e) { Ed.reportError(e); }
  return next;
});
L.defvar('markdown-after-todo-state-change-hook', NIL, 'Procedures called after markdown-todo-cycle changed a task keyword.');
D('markdown-link-at', '[pos]', 'The link at POS (default point): #(kind target start end) with kind wiki, ref, inline or url and 1-based positions, or #f.', ([p]: SchemeValue[]) => {
  const b = cur(), lk = linkAt(b, L.absent(p) ? b.pt : num(p) - 1);
  return lk ? [intern(lk.kind), lk.target, lk.s + 1, lk.e + 1] : false;
});
D('markdown-page-name', '[buffer]', 'The page name of BUFFER: its buffer-local page-name, else its file name without directory and extension.', ([bb]: SchemeValue[]) => pageName(Ed.toBuffer(bb === undefined ? false : bb)));
D('markdown-find-page', 'name', 'The open Markdown buffer whose page name is NAME (ignoring case), or #f.', ([n]: SchemeValue[]) => findPage(str(n)) || false);
D('markdown-block-ref-at-point', '', 'A ((reference)) to the block at point: the address of block-address, formatted.', () => {
  const b = cur(), a = L.call('block-address', [pageName(b), b.text, b.pt]);
  return '((' + L.call('format-address', [a]) + '))';
});
D('markdown-resolve-ref', 'address', 'The text an ((ADDRESS)) shows: from the open pages, resolve-ref-function, or the notes index on the server; #f when nothing names it.', ([a]: SchemeValue[]) => { const t = resolveRef(str(a)); return t === null ? false : t; });
D('markdown-resolve-ref-position', 'address', 'The open buffer and 1-based position an ((ADDRESS)) names, as (buffer . pos), or #f.', ([a]: SchemeValue[]) => { const h = resolveLocal(str(a).trim()); return h ? new L.Pair(h.b, h.pos + 1) : false; });
D('markdown-ref-overlays', '[from to]', 'The ((references)) between FROM and TO (1-based, default the whole buffer) that are shown as their resolved text: a list of #(start end text), the point\'s line excluded.', ([f, t]: SchemeValue[]) => {
  const b = cur(), from = L.absent(f) ? 0 : num(f) - 1, to = L.absent(t) ? b.rope.length : num(t) - 1;
  return listOf(refsIn(b, from, to).map(x => [x.s + 1, x.e + 1, displayText(x.addr)]));
});
D('markdown-face-at', '[pos]', 'The face (a symbol, markdown-*) of the character at POS (default point) in the current buffer, or #f for none.', ([p]: SchemeValue[]) => { const b = cur(), f = faceAt(b, L.absent(p) ? b.pt : num(p) - 1); return f ? intern(f) : false; });
D('markdown-faces', '', 'The faces markdown-mode uses, as symbols.', () => listOf(FACES.filter(Boolean).map(intern)));
D('markdown-stats', '', 'Counters of the lexer for tests: ((lexed . chars) (lex-calls . n) (fence-scans . n) (fence-updates . n)).', () => listOf(Object.entries(MD.stats).map(([k, v]) => new L.Pair(intern(k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())), v))));
D('markdown-reset-stats', '', 'Zero the lexer counters.', () => { for (const k in MD.stats) MD.stats[k as keyof typeof MD.stats] = 0; return false; });
D('journal-day-string', '[date]', 'Today (or DATE, milliseconds since the epoch) as YYYY-MM-DD in local time.', ([d]: SchemeValue[]) => { const x = L.absent(d) ? new Date() : new Date(num(d)); const p2 = (n: number) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; });

/* ---------- imenu: the headings ---------- */
function imenuItems(b: EdBuffer) {
  const out: MdImenuItem[] = [], re = /^(#{1,6})[ \t]+(.*?)[ \t]*$/gm, t = b.text, fences = fenceIndex(b);
  let m;
  while ((m = re.exec(t))) { if (fencesBefore(fences, m.index) & 1) continue; out.push({ name: '  '.repeat(m[1].length - 1) + m[2], kind: 'heading', pos: m.index }); }
  return out;
}
D('markdown-imenu-items', '[buffer]', 'The imenu items of BUFFER: its headings as (name kind . position), position 1-based.', ([bb]: SchemeValue[]) => listOf(imenuItems(Ed.toBuffer(bb === undefined ? false : bb)).map(it => new L.Pair(it.name, new L.Pair(intern(it.kind), it.pos + 1)))));
{
  const orig = L.toFn(intern('consult-imenu'));
  const spec = async () => {
    const b = cur();
    if (!isMd(b)) return (orig.interactive as () => unknown)();
    const items = imenuItems(b), w = E.sel, start = b.pt, startScroll = w ? w.start : 0;
    if (!items.length) signal('user-error', 'No headings found in this buffer');
    const names = items.map((it, i) => it.name + (items.findIndex(x => x.name === it.name) !== i ? ' <' + (i + 1) + '>' : ''));
    let cancelled = true, v;
    try {
      v = await Ed.readMini('Go to heading: ', '', () => names, { kind: 'imenu', require: true, keepOrder: true, annotate: c => items[names.indexOf(c)].kind,
        onSelect: c => { if (!c) return; b.pt = items[names.indexOf(c)].pos; E.recenter = 'center'; } });
      cancelled = false;
    } finally { if (cancelled) { b.pt = start; if (w) w.start = startScroll; } }
    return [items[names.indexOf(v)].pos + 1];
  };
  const g: SchemeProcedure = CMD('consult-imenu', spec, orig.params as string, orig.doc as string, (args: SchemeValue[]) => orig(args));
  if (orig.props) g.props = new Map(orig.props);
}

/* ---------- wiki-capf: the corfu popup after [[ ---------- */
function wikiPrefix(b: EdBuffer) {
  const r = b.rope, ls = bol(r, b.pt), before = r.slice(ls, b.pt), m = /\[\[([^\[\]\n]*)$/.exec(before);
  return m ? { start: b.pt - m[1].length, text: m[1] } : null;
}
function wikiCandidates(b: EdBuffer, prefix: string) {
  const names: { n: string; ann: string }[] = [], seen = new Set<string>();
  const add = (n: SchemeValue, ann: string) => { if (typeof n === 'string' && n && !seen.has(n)) { seen.add(n); names.push({ n, ann }); } };
  for (const x of arr(L.get('wiki-candidates') ?? NIL)) add(x, '');
  for (const pb of mdBuffers()) add(pageName(pb), 'page');
  const lower = prefix.toLowerCase(), closes = b.rope.slice(b.pt, b.pt + 2) === ']]';
  const score = (n: string) => { const l = n.toLowerCase(); return l.startsWith(lower) ? 0 : l.includes(lower) ? 1 : -1; };
  return names.map(x => ({ x, sc: score(x.n) })).filter(y => y.sc >= 0).sort((a, c) => a.sc - c.sc || (a.x.n < c.x.n ? -1 : 1)).slice(0, 200)
    .map(y => ({ text: y.x.n + (closes ? '' : ']]'), score: y.sc, ann: y.x.ann }));
}
function openWiki(b: EdBuffer, auto: boolean) {
  const p = wikiPrefix(b); if (!p) return false;
  const cands = wikiCandidates(b, p.text);
  if (!cands.length) { if (E.corfu && E.corfu.wiki) E.corfu = null; return false; }
  E.corfu = { start: p.start, prefix: p.text, cands, index: 0, scroll: 0, auto, wiki: true };
  return true;
}
D('%wiki-capf', '', 'Open the completion popup for the [[link before point: #t when it has candidates.', () => openWiki(cur(), false));
{
  const prevPost = H.postCommand;
  H.postCommand = (def, b, failed) => {
    if (prevPost) prevPost(def, b, failed);
    if (E.depth > 0 || E.mini) return;
    if (L.cmdSym(def) !== intern('self-insert-command')) return;
    const cb = E.current;
    if (!isMd(cb) || !truthy(L.get('corfu-auto'))) return;
    const st = EC.stateOf(cb);
    if (st === 'insert' || st === null || st === 'emacs') openWiki(cb, true);
  };
}

/* ---------- auto-mode-alist, links by mouse, the display pass ---------- */
{
  const prevModeFor = H.modeFor, cache = new Map<string, RegExp>();
  H.modeFor = name => {
    const al = L.get('auto-mode-alist');
    if (al) for (const p of arr(al)) {
      if (!(p instanceof L.Pair) || typeof p.car !== 'string') continue;
      let re = cache.get(p.car); if (!re) { try { re = new RegExp(p.car); } catch (e) { re = /$^/; } cache.set(p.car, re); }
      if (re.test(name)) return p.cdr instanceof Sym ? p.cdr.name : String(p.cdr);
    }
    return prevModeFor ? prevModeFor(name) : null;
  };
}
{
  /* A click on a [[link]] or a ((reference)) follows it, after the click placed point; Shift-click only places point. */
  const prevMouse = H.mouseDown;
  H.mouseDown = (b, p) => {
    if (prevMouse) prevMouse(b, p); else { b.pt = p; b.markActive = false; }
    if (!isMd(b) || MD.shift) return;
    const lk = linkAt(b, p);
    if (lk && (lk.kind === 'wiki' || lk.kind === 'ref')) Ed.feedKey('<cmd:' + (lk.kind === 'wiki' ? 'wiki-follow' : 'markdown-follow-ref') + '>');
  };
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('mousedown', e => { MD.shift = !!e.shiftKey; }, true);
}
{
  /* After the lines are drawn, the span of each ((reference)) off the point's line shows its resolved text. */
  const prevOverlay = H.renderOverlay;
  H.renderOverlay = () => {
    if (prevOverlay) prevOverlay();
    if (!E.frame || !Ed.windowList) return;
    for (const w of Ed.windowList()) {
      const b = w.buffer, lx = b && b._mlx as MdLex | undefined;
      if (!isMd(b) || !w.view || !lx || !lx.refs.length) continue;
      for (const span of w.view.querySelectorAll<HTMLElement>('span.markdown-block-ref-display')) {
        const ln = span.closest<HTMLElement>('.ln'); if (!ln) continue;
        const pos = Number(ln.dataset.o) + Number(span.dataset.o);
        const ref = lx.refs.find(x => pos >= x.s && pos < x.e); if (!ref) continue;
        const text = pos === ref.s ? displayText(ref.addr) : '';
        if (span.textContent !== text) span.textContent = text;
        if (pos === ref.s) { const title = '((' + ref.addr + ')) · RET or click to jump'; if (span.title !== title) span.title = title; }
      }
    }
  };
}

/* ---------- the look: faces as classes; --md-* first (the frame runtime sets them from the board's --syn-* tokens), then Edwin's own variables ---------- */
const CSS = `
.text .markdown-heading-1 { color: var(--md-heading, var(--org-l1, var(--kw))); font-weight: 700; }
.text .markdown-heading-2 { color: var(--md-heading, var(--org-l2, var(--fn))); font-weight: 700; }
.text .markdown-heading-3 { color: var(--md-heading, var(--org-l3, var(--st))); font-weight: 600; }
.text .markdown-heading-4, .text .markdown-heading-5, .text .markdown-heading-6 { color: var(--md-heading, var(--org-l4, var(--dc))); font-weight: 600; }
.text .markdown-markup { color: var(--md-markup, var(--dim)); }
.text .markdown-bold { font-weight: 700; }
.text .markdown-italic { font-style: italic; }
.text .markdown-strike { text-decoration: line-through; color: var(--md-markup, var(--dim)); }
.text .markdown-code, .text .markdown-code-block { color: var(--md-code, var(--st)); background: var(--md-code-bg, var(--org-code-bg, rgb(127 127 127 / 0.12))); border-radius: 3px; }
.text .markdown-fence { color: var(--md-markup, var(--dim)); background: var(--md-code-bg, var(--org-code-bg, rgb(127 127 127 / 0.12))); }
.text .markdown-link, .text .markdown-wiki-link { color: var(--md-link, var(--st)); text-decoration: underline; cursor: pointer; }
.text .markdown-url { color: var(--md-link, var(--st)); }
.text .markdown-image { color: var(--md-image, var(--dc)); }
.text .markdown-block-ref { color: var(--md-ref, var(--co)); }
.text .markdown-block-ref-display { color: var(--md-ref, var(--co)); background: var(--md-ref-bg, rgb(127 127 127 / 0.1)); border-radius: 3px; cursor: pointer; }
.text .markdown-anchor { color: var(--md-anchor, var(--dim)); background: var(--md-tag-bg, var(--org-tag-bg, rgb(127 127 127 / 0.12))); border-radius: 3px; font-size: 0.85em; }
.text .markdown-tag { color: var(--md-tag, var(--co)); background: var(--md-tag-bg, var(--org-tag-bg, rgb(127 127 127 / 0.12))); border-radius: 3px; }
.text .markdown-list { color: var(--md-list, var(--kw)); font-weight: 700; }
.text .markdown-checkbox { color: var(--md-checkbox, var(--co)); font-weight: 600; }
.text .markdown-checkbox-done { color: var(--md-markup, var(--dim)); }
.text .markdown-task-todo, .text .markdown-task-someday, .text .markdown-task-later, .text .markdown-task-other { color: var(--md-task-todo, var(--org-todo, var(--rb1))); font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; border-radius: 3px; }
.text .markdown-task-next, .text .markdown-task-doing, .text .markdown-task-now { color: var(--md-task-next, var(--rb2)); font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; border-radius: 3px; }
.text .markdown-task-waiting, .text .markdown-task-hold { color: var(--md-task-waiting, var(--rb3)); font-weight: 700; box-shadow: inset 0 0 0 1px currentColor; border-radius: 3px; }
.text .markdown-task-done, .text .markdown-task-cancelled, .text .markdown-task-other-done { color: var(--md-task-done, var(--dim)); font-weight: 600; box-shadow: inset 0 0 0 1px currentColor; border-radius: 3px; }
.text .markdown-task-done-text { color: var(--md-task-done, var(--dim)); text-decoration: line-through; }
.text .markdown-field-key { color: var(--md-field, var(--fn)); }
.text .markdown-priority { color: var(--md-priority, var(--rb1)); font-weight: 700; }
.text .markdown-planning { color: var(--md-markup, var(--dim)); font-weight: 600; }
.text .markdown-date { color: var(--md-date, var(--co)); background: var(--md-tag-bg, var(--org-tag-bg, rgb(127 127 127 / 0.12))); border-radius: 3px; }
.text .markdown-quote { font-style: italic; color: var(--md-quote, var(--dim)); }
.text .markdown-table { color: var(--md-table, var(--co)); }
.text .markdown-table-delimiter { color: var(--md-markup, var(--dim)); }
.text .markdown-hr { color: var(--md-markup, var(--rule)); }
.text .markdown-front-matter { color: var(--md-meta, var(--dim)); }
`;
Ed.host.page.addStyle('markdown-css', CSS);

globalThis.Markdown = { MD, FACES, lexSeg: H.lexSeg, faceAt, linkAt, resolveRef, resolveLocal, pageName, findPage, imenuItems, fenceIndex, refsIn, displayText, taskKeywords,
  /* The face names of the characters FROM..TO of B, for tests. */
  facesOf(b: EdBuffer, from: number, to: number) { const seg = b.rope.slice(from, to); const r = H.lexSeg!(b, from, to, seg) as MdLex | null; return r ? Array.from(r.cls, c => FACES[c]) : null; } };
interface MdKeywords { src: SchemeValue; dsrc: SchemeValue; all: string[]; done: string[] }
interface MdFences { ver: number; list: number[] }
interface MdFrontMatter { ver: number; end: number }
/* a ((reference)) shown as its resolved text: S..E in the buffer */
interface MdRef { s: number; e: number; addr: string }
/* what hooks.lexSeg gives back, cached as b._mlx */
interface MdLex { ver: number; from: number; to: number; fv: number; ptl: number; kw: SchemeValue; cls: Uint8Array; names: string[]; refs: MdRef[] }
interface MdHit { b: EdBuffer; pos: number }
interface MdImenuItem { name: string; kind: string; pos: number }
})();
