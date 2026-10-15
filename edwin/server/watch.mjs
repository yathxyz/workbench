// Disk changes (spec §8.4): a watcher per directory of a loaded file plus a 10 s stat sweep; reverts as
// one batch by `disk` when the buffer is unmodified, a three-way merge against the saved text when it is
// modified, a conflict mark when hunks overlap, a deleted mark when the file is gone. Own saves are
// recognised by their hash (R8.15), own renames by the buffer having moved with the file before any event is
// read. The line-then-character diff and the merge live here too.
import fs from 'node:fs';
import path from 'node:path';
import { readText, sha256, diskState, sameDisk } from './files.mjs';

export const SWEEP_MS = 10000;

/* ---------- diffs ---------- */

/* Split TEXT into lines, each keeping its newline. */
export function lines(text) {
  const out = [];
  let i = 0;
  for (;;) { const j = text.indexOf('\n', i); if (j < 0) { if (i < text.length) out.push(text.slice(i)); break; } out.push(text.slice(i, j + 1)); i = j + 1; }
  return out;
}

/* Myers diff of arrays A and B (elements compared with ===): hunks {a0, a1, b0, b1}, A[a0, a1) replaced
   by B[b0, b1). When no edit script of at most MAX_D steps exists the differing middle is one hunk. */
export function diffArrays(A, B, MAX_D = 4000) {
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N || !M) return [{ a0: pre, a1: pre + N, b0: pre, b1: pre + M }];
  const MAX = Math.min(N + M, MAX_D), off = MAX + 1;
  const V = new Int32Array(2 * MAX + 3);
  const trace = [];
  let found = false;
  for (let d = 0; d <= MAX && !found; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[k - 1 + off] < V[k + 1 + off]) ? V[k + 1 + off] : V[k - 1 + off] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      V[k + off] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  if (!found) return [{ a0: pre, a1: pre + N, b0: pre, b1: pre + M }];
  const edits = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? k + 1 : k - 1;
    const prevX = v[prevK + off], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (d > 0) edits.push(x === prevX ? { a0: x, a1: x, b0: prevY, b1: y } : { a0: prevX, a1: x, b0: y, b1: y });
    x = prevX; y = prevY;
  }
  edits.reverse();
  const hunks = [];
  for (const e of edits) {
    const h = hunks[hunks.length - 1];
    if (h && h.a1 === e.a0 && h.b1 === e.b0) { h.a1 = e.a1; h.b1 = e.b1; } else hunks.push({ ...e });
  }
  return hunks.map(h => ({ a0: h.a0 + pre, a1: h.a1 + pre, b0: h.b0 + pre, b1: h.b1 + pre }));
}

const isHigh = c => c >= 0xD800 && c <= 0xDBFF, isLow = c => c >= 0xDC00 && c <= 0xDFFF;
/* The ops [pos, del, ins] that turn OLD into NEW: a line diff, each hunk shrunk by its common prefix and
   suffix at the character level without splitting a surrogate pair (R8.12). */
export function diffOps(oldText, newText) {
  if (oldText === newText) return [];
  const A = lines(oldText), B = lines(newText);
  const offA = [0]; for (const l of A) offA.push(offA[offA.length - 1] + l.length);
  const offB = [0]; for (const l of B) offB.push(offB[offB.length - 1] + l.length);
  const ops = [];
  let shift = 0;
  for (const h of diffArrays(A, B)) {
    let d = oldText.slice(offA[h.a0], offA[h.a1]), n = newText.slice(offB[h.b0], offB[h.b1]);
    let pos = offA[h.a0];
    let p = 0; while (p < d.length && p < n.length && d.charCodeAt(p) === n.charCodeAt(p)) p++;
    if (p && isHigh(d.charCodeAt(p - 1)) && p < d.length && p < n.length) p--;
    let s = 0; while (s < d.length - p && s < n.length - p && d.charCodeAt(d.length - 1 - s) === n.charCodeAt(n.length - 1 - s)) s++;
    if (s && isLow(d.charCodeAt(d.length - s)) && s < d.length - p && s < n.length - p) s--;
    d = d.slice(p, d.length - s); n = n.slice(p, n.length - s); pos += p;
    if (!d && !n) continue;
    ops.push([pos + shift, d, n]);
    shift += n.length - d.length;
  }
  return ops;
}

/* Three-way merge of line arrays (R8.13): {text, conflict}. Regions changed only by ours or only by theirs
   take that side; a base region both sides changed (or that one side changed next to the other's change)
   is a conflict and the merge is refused. */
export function merge3(base, ours, theirs) {
  const A = lines(base), O = lines(ours), T = lines(theirs);
  const ho = diffArrays(A, O), ht = diffArrays(A, T);
  /* Walk the base; take hunks in order of base position. */
  const out = [];
  let i = 0, io = 0, it = 0;
  while (io < ho.length || it < ht.length) {
    const o = ho[io], t = ht[it];
    const next = o && (!t || o.a0 <= t.a0) ? 'o' : 't';
    const h = next === 'o' ? o : t;
    /* Base lines before the hunk are unchanged in both. */
    for (; i < h.a0; i++) out.push(A[i]);
    /* Overlap: the other side's next hunk starts before this one ends (touching ranges count as overlap
       when either is an insertion at the same place). */
    const other = next === 'o' ? t : o;
    if (other && other.a0 <= h.a1 && (other.a0 < h.a1 || other.a0 === h.a0)) return { text: null, conflict: true };
    if (next === 'o') { for (let k = o.b0; k < o.b1; k++) out.push(O[k]); io++; }
    else { for (let k = t.b0; k < t.b1; k++) out.push(T[k]); it++; }
    i = h.a1;
  }
  for (; i < A.length; i++) out.push(A[i]);
  return { text: out.join(''), conflict: false };
}

/* ---------- the watcher ---------- */
export class Watcher {
  constructor(buffers, log) {
    this.buffers = buffers; this.log = log;
    this.dirs = new Map(); // dir → fs.FSWatcher
    this.pending = new Map(); // real path → timer (debounce)
    this.sweep = setInterval(() => this.sweepAll(), SWEEP_MS);
    this.sweep.unref();
  }
  close() { clearInterval(this.sweep); for (const w of this.dirs.values()) w.close(); this.dirs.clear(); for (const t of this.pending.values()) clearTimeout(t); }
  /* Watch the directory of SB's file. */
  add(sb) {
    if (!sb.file) return;
    const dir = path.dirname(sb.file);
    if (this.dirs.has(dir)) return;
    try {
      const w = fs.watch(dir, { persistent: false }, (ev, name) => { if (name) this.changed(path.join(dir, String(name))); else this.sweepAll(); });
      w.on('error', () => { w.close(); this.dirs.delete(dir); });
      this.dirs.set(dir, w);
    } catch (e) { this.log.warn('watch', { dir, error: e.code || e.message }); }
  }
  /* edwind renamed SB's file from OLD (R8.15 for renames): SB already visits the new path and keeps the disk state
     it had (a rename keeps inode, mtime and size), so events for the old path find no buffer. A check queued for
     the old path moves to the new one, and one is queued anyway: a write that landed just before the rename, its
     event not read yet, is still compared. The new directory is watched. */
  moved(sb, old) {
    const t = this.pending.get(old);
    if (t) { clearTimeout(t); this.pending.delete(old); }
    this.add(sb);
    this.changed(sb.file);
  }
  /* A change event for REAL: look at it shortly, once events settle. */
  changed(real) {
    const sb = this.buffers.byFile(real);
    if (!sb) return;
    const t = this.pending.get(real);
    if (t) clearTimeout(t);
    this.pending.set(real, setTimeout(() => { this.pending.delete(real); this.check(sb); }, 50));
  }
  sweepAll() { for (const sb of this.buffers.all()) if (sb.file) this.check(sb); }
  /* Compare the file with what edwind last saw and act (R8.12–R8.15). */
  check(sb) {
    if (!sb.file || sb.big) return;
    let st = null;
    try { st = fs.statSync(sb.file); } catch (e) { if (e.code !== 'ENOENT') return; }
    if (!st) {
      if (sb.disk !== null) { sb.disk = null; sb.setDiskChanged('deleted'); this.log.info('disk', { buf: sb.id, change: 'deleted' }); }
      return;
    }
    if (sameDisk(diskState(st), sb.disk)) { if (sb.diskChanged === 'deleted') sb.setDiskChanged(null); return; }
    let r;
    try { r = readText(sb.file); } catch (e) { this.log.warn('disk', { buf: sb.id, error: e.code }); return; }
    sb.disk = diskState(r.stat);
    if (sb.diskChanged === 'deleted') sb.setDiskChanged(null);
    const hash = sha256(r.text);
    if (hash === sb.savedHash) { sb.eol = r.eol; return; } // our own save, or no change in content (R8.15)
    this.buffers.diskChanged(sb, r.text, r.eol, hash);
  }
}
