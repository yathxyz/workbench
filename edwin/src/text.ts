/* Buffer text: a chunked rope. The text is a list of string chunks of about 2K characters, with
   prefix sums of chunk lengths and newline counts kept lazily. An edit rewrites one or two chunks
   and marks the prefix sums dirty from there, so it costs O(chunk + chunks) instead of the O(n)
   copy that rebuilding one big JS string costs (V8 joins slice + insert + slice into a cons string
   and flattens it, copying every character, on the next index or search).
   The rope answers the reads that run on every key (characters, short slices, line starts, line
   numbers, newline searches) itself. Code that wants the whole text as one string calls
   toString(); the joined string is cached until the next edit, and the chunks are re-pointed into
   it so the text is kept in memory once. The read methods have the names and the semantics of
   the String methods, so helpers written for strings accept a rope too. */
(function () {
/* The module is a function so a worker can be built from its source (globalThis.ropeSource). */
function ropeModule(g: typeof globalThis) {
'use strict';
const TARGET = 2048, MAX = 4096, MIN = 256;

/* A copy of S that does not keep its parent alive. V8 makes a slice of 13 or more characters a view
   into the parent string, so a short piece of a 10MB text kept in the edit log or a register would
   keep all 10MB. Slicing a concatenation flattens it into a new string first. */
function own(s: string) { return s.length < 13 ? s : (s + ' ').slice(0, -1); }
function countNL(s: string) { let n = 0; for (let k = s.indexOf('\n'); k >= 0; k = s.indexOf('\n', k + 1)) n++; return n; }
function isHigh(c: number) { return c >= 0xD800 && c <= 0xDBFF; }
/* Split S into chunks of about TARGET characters, never between the halves of a surrogate pair. */
function chunkify(s: string, out: string[], nls: number[]) {
  const n = s.length;
  if (n <= MAX) { if (n) { out.push(s); nls.push(countNL(s)); } return; }
  let k = 0;
  while (k < n) {
    let e = Math.min(n, k + TARGET);
    if (n - e < MIN) e = n;
    if (e < n && isHigh(s.charCodeAt(e - 1))) e++;
    const piece = s.slice(k, e);
    out.push(piece); nls.push(countNL(piece));
    k = e;
  }
}

class Rope {
  declare ch: string[];
  declare nl: number[];
  declare off: Int32Array;
  declare nlo: Int32Array;
  declare len: number;
  /* the first chunk whose prefix sums are stale, or -1 */
  declare dirty: number;
  declare flat: string | null;
  declare ci: number;
  declare static flattens: number;
  constructor(s?: string) {
    this.ch = []; this.nl = [];
    this.off = new Int32Array(16); this.nlo = new Int32Array(16);
    this.len = 0; this.dirty = 0; this.flat = ''; this.ci = 0;
    this.reset(s || '');
  }
  static from(s: string) { return new Rope(s); }
  /* Replace the whole text. */
  reset(s: string) {
    this.ch = []; this.nl = [];
    chunkify(s, this.ch, this.nl);
    this.len = s.length; this.flat = s; this.dirty = 0; this.ci = 0;
  }
  get length() { return this.len; }
  /* Bring the prefix sums up to date. */
  fix() {
    if (this.dirty < 0) return;
    const C = this.ch.length;
    if (this.off.length < C + 1) {
      const cap = Math.max(C + 1, this.off.length * 2);
      const o = new Int32Array(cap), n = new Int32Array(cap);
      o.set(this.off.subarray(0, Math.min(this.dirty + 1, this.off.length))); n.set(this.nlo.subarray(0, Math.min(this.dirty + 1, this.nlo.length)));
      this.off = o; this.nlo = n;
    }
    const off = this.off, nlo = this.nlo, ch = this.ch, nl = this.nl;
    let k = this.dirty;
    if (k === 0) { off[0] = 0; nlo[0] = 0; }
    for (; k < C; k++) { off[k + 1] = off[k] + ch[k].length; nlo[k + 1] = nlo[k] + nl[k]; }
    this.dirty = -1;
  }
  /* Index of the chunk holding position P (the last chunk for P = length). */
  find(p: number) {
    this.fix();
    const C = this.ch.length, off = this.off;
    let i = this.ci;
    if (i < C && off[i] <= p && (p < off[i + 1] || (i === C - 1 && p <= off[C]))) return i;
    let lo = 0, hi = C - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (off[m] <= p) lo = m; else hi = m - 1; }
    this.ci = lo;
    return lo;
  }
  toString() {
    if (this.flat !== null) return this.flat;
    const s = this.ch.length === 1 ? this.ch[0] : this.ch.join('');
    this.flat = s;
    /* Point the chunks into the joined string, so the text is held once. */
    if (this.ch.length > 1) {
      this.fix();
      const off = this.off;
      for (let k = 0; k < this.ch.length; k++) this.ch[k] = s.slice(off[k], off[k + 1]);
    }
    Rope.flattens++;
    return s;
  }
  valueOf() { return this.toString(); }
  charCodeAt(p: number) {
    if (this.flat !== null) return this.flat.charCodeAt(p);
    if (!(p >= 0 && p < this.len)) return NaN;
    const i = this.find(p);
    return this.ch[i].charCodeAt(p - this.off[i]);
  }
  charAt(p: number) {
    if (this.flat !== null) return this.flat.charAt(p);
    if (!(p >= 0 && p < this.len)) return '';
    const i = this.find(p);
    return this.ch[i][p - this.off[i]];
  }
  /* Like s[p]: the character, or undefined outside the text. */
  at(p: number) {
    if (this.flat !== null) return this.flat[p];
    if (!(p >= 0 && p < this.len)) return undefined;
    const i = this.find(p);
    return this.ch[i][p - this.off[i]];
  }
  codePointAt(p: number) {
    const c = this.charCodeAt(p);
    if (isHigh(c) && p + 1 < this.len) { const d = this.charCodeAt(p + 1); if (d >= 0xDC00 && d <= 0xDFFF) return (c - 0xD800) * 0x400 + d - 0xDC00 + 0x10000; }
    return c !== c ? undefined : c;
  }
  slice(a?: number, b?: number) {
    if (this.flat !== null) { const s = this.flat.slice(a, b); return s.length * 4 < this.len ? own(s) : s; }
    const n = this.len;
    a = a === undefined ? 0 : a < 0 ? Math.max(0, n + a) : Math.min(a, n);
    b = b === undefined ? n : b < 0 ? Math.max(0, n + b) : Math.min(b, n);
    if (b <= a) return '';
    const i = this.find(a), j = this.find(b - 1), off = this.off, ch = this.ch;
    if (i === j) return own(ch[i].slice(a - off[i], b - off[i]));
    let s = ch[i].slice(a - off[i]);
    for (let k = i + 1; k < j; k++) s += ch[k];
    s += ch[j].slice(0, b - off[j]);
    s.charCodeAt(0); /* flatten the concatenation, so it holds no views into the chunks */
    return s;
  }
  substring(a: number, b?: number) { return this.slice(Math.max(0, Math.min(a, b === undefined ? a : b)), b === undefined ? undefined : Math.max(a, b)); }
  indexOf(needle: string, from?: number) {
    if (this.flat !== null) return this.flat.indexOf(needle, from);
    from = from === undefined || from < 0 ? 0 : from | 0;
    if (from > this.len) return needle === '' ? this.len : -1;
    if (needle === '') return from;
    const ch = this.ch, C = ch.length, L = needle.length;
    let i = this.find(from), off = this.off;
    if (L === 1) {
      for (let k = i, rel = from - off[i]; k < C; k++, rel = 0) { const q = ch[k].indexOf(needle, rel); if (q >= 0) return off[k] + q; }
      return -1;
    }
    /* A longer needle can straddle chunks: search each chunk with the tail of the one before. */
    for (let k = i; k < C; k++) {
      const base = Math.max(off[k] - (L - 1), from);
      const s = this.slice(base, Math.min(this.len, off[k + 1] + 0));
      const q = s.indexOf(needle);
      if (q >= 0) return base + q;
    }
    return -1;
  }
  lastIndexOf(needle: string, from?: number) {
    if (this.flat !== null) return this.flat.lastIndexOf(needle, from);
    const n = this.len, L = needle.length;
    let start = from === undefined || from !== from ? n : Math.max(0, Math.min(from | 0, n));
    if (L === 0) return Math.min(start, n);
    if (start > n - L) start = n - L;
    if (start < 0) return -1;
    /* find() may reallocate this.off (fix), so read the arrays after it. */
    let i = this.find(start);
    const ch = this.ch, off = this.off;
    if (L === 1) {
      for (let k = i, rel = start - off[i]; k >= 0; k--) { const q = ch[k].lastIndexOf(needle, rel); if (q >= 0) return off[k] + q; if (k > 0) rel = ch[k - 1].length - 1; }
      return -1;
    }
    for (let k = i; k >= 0; k--) {
      const end = Math.min(n, (k === i ? start : off[k + 1] - 1) + L);
      const base = off[k];
      const s = this.slice(base, end);
      const q = s.lastIndexOf(needle);
      if (q >= 0) return base + q;
    }
    return -1;
  }
  /* Newlines in the whole text. */
  newlines() { this.fix(); const C = this.ch.length; return C ? this.nlo[C] : 0; }
  /* 1-based line number of position P: one more than the newlines before P. */
  lineOf(p: number) {
    if (p <= 0 || this.len === 0) return 1;
    if (p > this.len) p = this.len;
    const i = this.find(p - 1), s = this.ch[i], rel = p - this.off[i];
    let n = this.nlo[i];
    for (let k = s.indexOf('\n'); k >= 0 && k < rel; k = s.indexOf('\n', k + 1)) n++;
    return n + 1;
  }
  /* Start of line N (1-based); past the last line, the start of the last line. */
  lineStart(n: number) {
    if (n <= 1 || this.len === 0) return 0;
    this.fix();
    const C = this.ch.length, nlo = this.nlo;
    let target = n - 1;
    const total = nlo[C];
    if (target > total) target = total;
    if (target === 0) return 0;
    /* The chunk that holds the TARGETth newline: nlo[i] < target <= nlo[i + 1]. */
    let lo = 0, hi = C - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (nlo[m + 1] < target) lo = m + 1; else hi = m; }
    const s = this.ch[lo];
    let need = target - nlo[lo], k = -1;
    while (need-- > 0) k = s.indexOf('\n', k + 1);
    return this.off[lo] + k + 1;
  }
  /* Replace DEL characters at POS with INS; return the removed text. */
  splice(pos: number, del: number, ins: string) {
    const n = this.len;
    if (pos < 0) pos = 0; if (pos > n) pos = n;
    if (pos + del > n) del = n - pos;
    if (!del && !ins) return '';
    const removed = del ? this.slice(pos, pos + del) : '';
    this.flat = null;
    const ch = this.ch, nl = this.nl;
    if (!ch.length) { chunkify(ins, ch, nl); this.len = ins.length; this.dirty = 0; return removed; }
    const end = pos + del;
    const i = this.find(pos);
    const j = del ? this.find(end - 1) : i;
    const off = this.off;
    const left = ch[i].slice(0, pos - off[i]), right = ch[j].slice(end - off[j]);
    let mid = left + ins + right;
    mid.charCodeAt(0); /* flatten now, so the new chunk drops its references to the old pieces */
    let a = i, b = j;
    /* Keep chunks from getting tiny: fold a short result into a neighbour. */
    if (mid.length < MIN) {
      if (b + 1 < ch.length && ch[b + 1].length + mid.length <= MAX) { b++; mid += ch[b]; }
      else if (a > 0 && ch[a - 1].length + mid.length <= MAX) { a--; mid = ch[a] + mid; }
    }
    const pieces: string[] = [], pnl: number[] = [];
    if (mid.length <= MAX) { if (mid.length) { pieces.push(mid); pnl.push(countNL(mid)); } }
    else chunkify(mid, pieces, pnl);
    ch.splice(a, b - a + 1, ...pieces);
    nl.splice(a, b - a + 1, ...pnl);
    this.len = n - del + ins.length;
    this.dirty = this.dirty < 0 ? a : Math.min(this.dirty, a);
    this.ci = Math.min(a, Math.max(0, ch.length - 1));
    return removed;
  }
}
Rope.flattens = 0;
g.Rope = Rope;
}
ropeModule(globalThis);
globalThis.ropeSource = '(' + ropeModule.toString() + ')(self);';
})();
