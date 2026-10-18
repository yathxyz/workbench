/* Operational transform for edwind and its frames (spec §7.5–§7.7, R7.14): one pure module, loaded as a
   classic script in the page (globalThis.EdOT) and with require in Node.

   Two shapes of an edit exist here:
   - ops: the wire and journal form, an array of [pos, del, ins] applied in order, each pos a UTF-16
     code-unit offset into the text after the previous op, del the removed text itself (R7.5);
   - a TextOperation (as in ot.js): retain / insert / delete components over the whole document, the form
     transform and compose work on.
   fromOps and toOps convert; toOps recomputes del from the text the operation applies to (R7.10).

   Transform is the standard pair function: transform(seq, inc) gives [seq', inc'] with
   apply(apply(S, seq), inc') = apply(apply(S, inc), seq'), and an insert of the already sequenced
   operation stays left of a concurrent insert at the same position (R7.9). */
(function (root: typeof globalThis) {
'use strict';

/* A group of batches: its frame's cid and its undo group. */
type OTGroup = { cid: unknown; g: unknown };
interface OTWalk { out: EdOTBatch[]; texts: string[]; text: string; pending: EdTextOperation; partial: boolean }

class OTError extends Error {
  declare code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}
const isHigh = (c: number) => c >= 0xD800 && c <= 0xDBFF;
const isLow = (c: number) => c >= 0xDC00 && c <= 0xDFFF;
/* True when POS lies between the halves of a surrogate pair (R7.8). TEXT is a string or a rope. */
function splitsPair(text: EdText, pos: number) { return pos > 0 && pos < text.length && isLow(text.charCodeAt(pos)) && isHigh(text.charCodeAt(pos - 1)); }

/* ---------- sequential ops ---------- */

/* Check one op against TEXT and give back the text after it. Throws OTError bad_edit. */
function applyOp(text: EdText, op: EdOTOp): string {
  checkOp(text, op);
  const [pos, del, ins] = op;
  if (!del && !ins) return String(text);
  return text.slice(0, pos) + ins + text.slice(pos + del.length);
}
/* Check one op against TEXT (a string or a rope) without building the result (R7.7, R7.8). */
function checkOp(text: EdText, op: EdOTOp) {
  if (!Array.isArray(op) || op.length !== 3 || typeof op[0] !== 'number' || typeof op[1] !== 'string' || typeof op[2] !== 'string') throw new OTError('bad_edit', 'an op is [pos, del, ins]');
  const [pos, del, ins] = op;
  if (!Number.isInteger(pos) || pos < 0 || pos > text.length) throw new OTError('bad_edit', `position ${pos} is outside the text (length ${text.length})`);
  if (pos + del.length > text.length) throw new OTError('bad_edit', `deletion at ${pos} runs past the end of the text`);
  if (del && text.slice(pos, pos + del.length) !== del) throw new OTError('bad_edit', `the text at ${pos} is not the one the op deletes`);
  if (splitsPair(text, pos) || splitsPair(text, pos + del.length)) throw new OTError('bad_edit', `position ${pos} splits a surrogate pair`);
  if (ins && (isLow(ins.charCodeAt(0)) && pos > 0 && isHigh(text.charCodeAt(pos - 1)) || isHigh(ins.charCodeAt(ins.length - 1)) && pos + del.length < text.length && isLow(text.charCodeAt(pos + del.length)))) throw new OTError('bad_edit', `the insertion at ${pos} splits a surrogate pair`);
}
/* Apply OPS in order to TEXT (a string), checking each (R7.7). */
function apply(text: EdText, ops: EdOTOp[]) {
  if (!Array.isArray(ops)) throw new OTError('bad_edit', 'ops is not an array');
  let t = String(text);
  for (const op of ops) t = applyOp(t, op);
  return t;
}
/* Check OPS against TEXT without building the result for a string: the length and the pieces are what
   a rope-backed buffer needs. Returns the length after the ops. */
function check(text: EdText, ops: EdOTOp[]) { return apply(text, ops).length; }
/* The inverse of OPS: each op inverted and the order reversed (R6.16). */
function invert(ops: EdOTOp[]) { const out: EdOTOp[] = []; for (let i = ops.length - 1; i >= 0; i--) { const [p, d, n] = ops[i]; out.push([p, n, d]); } return out; }
/* Length change of OPS. */
function delta(ops: EdOTOp[]) { let d = 0; for (const [, del, ins] of ops) d += ins.length - del.length; return d; }

/* ---------- TextOperation ---------- */

/* Components: a positive number retains, a negative number deletes, a string inserts. */
function Op(): EdTextOperation { return { c: [], baseLen: 0, targetLen: 0 }; }
function retain(o: EdTextOperation, n: number) {
  if (!n) return o;
  o.baseLen += n; o.targetLen += n;
  const c = o.c, last = c[c.length - 1];
  if (typeof last === 'number' && last > 0) c[c.length - 1] = last + n; else c.push(n);
  return o;
}
function insert(o: EdTextOperation, s: string) {
  if (!s) return o;
  o.targetLen += s.length;
  const c = o.c, last = c[c.length - 1];
  if (typeof last === 'string') c[c.length - 1] = last + s;
  else if (typeof last === 'number' && last < 0) {
    /* An insert next to a delete goes before it, so every operation has one normal form. */
    const prev = c[c.length - 2];
    if (typeof prev === 'string') c[c.length - 2] = prev + s;
    else { c[c.length] = last; c[c.length - 2] = s; }
  } else c.push(s);
  return o;
}
function del(o: EdTextOperation, n: number) {
  if (!n) return o;
  o.baseLen += n;
  const c = o.c, last = c[c.length - 1];
  if (typeof last === 'number' && last < 0) c[c.length - 1] = last - n; else c.push(-n);
  return o;
}
const isRetain = (x: unknown) => typeof x === 'number' && x > 0;
const isDelete = (x: unknown) => typeof x === 'number' && x < 0;
const isInsert = (x: unknown): x is string => typeof x === 'string';

/* One op [pos, del, ins] against a text of length LEN as an operation. */
function single(pos: number, delLen: number, ins: string, len: number) { const o = Op(); retain(o, pos); del(o, delLen); insert(o, ins); retain(o, len - pos - delLen); return o; }
/* Sequential OPS against a text of length LEN as one operation. */
function fromOps(ops: EdOTOp[], len: number) {
  let o: EdTextOperation | null = null, cur = len;
  for (const [pos, d, ins] of ops) {
    if (pos < 0 || pos + d.length > cur) throw new OTError('bad_edit', `position ${pos} is outside the text (length ${cur})`);
    const s = single(pos, d.length, ins, cur);
    o = o ? compose(o, s) : s;
    cur += ins.length - d.length;
  }
  return o || retain(Op(), len);
}
/* Operation O as sequential ops against TEXT, the text it applies to (a string or a rope); del is read
   from TEXT. A delete and an insert at one place merge into one replacement op (R6.12). */
function toOps(o: EdTextOperation, text: EdText) {
  if (o.baseLen !== text.length) throw new OTError('bad_edit', `the operation expects a text of ${o.baseLen} units, not ${text.length}`);
  const out: EdOTOp[] = [];
  let cur = 0, shift = 0;
  const c = o.c;
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    if (isRetain(x)) { cur += x as number; continue; }
    let d = '', ins = '';
    if (isInsert(x)) { ins = x; if (isDelete(c[i + 1])) { d = text.slice(cur, cur - (c[i + 1] as number)); cur -= c[i + 1] as number; i++; } }
    else { d = text.slice(cur, cur - x); cur -= x; if (isInsert(c[i + 1])) { ins = c[i + 1] as string; i++; } }
    out.push([cur - d.length + shift, d, ins]);
    shift += ins.length - d.length;
  }
  return out;
}
/* Apply operation O to string S. */
function applyOperation(s: string, o: EdTextOperation) {
  if (s.length !== o.baseLen) throw new OTError('bad_edit', 'the operation expects a different text length');
  const parts: string[] = [];
  let i = 0;
  for (const x of o.c) {
    if (isRetain(x)) { parts.push(s.slice(i, i + (x as number))); i += x as number; }
    else if (isInsert(x)) parts.push(x);
    else i -= x;
  }
  if (i !== s.length) throw new OTError('bad_edit', 'the operation does not cover the text');
  return parts.join('');
}

/* compose(a, b): the operation that does A then B. */
function compose(a: EdTextOperation, b: EdTextOperation) {
  if (a.targetLen !== b.baseLen) throw new OTError('bad_edit', 'compose: the base of the second operation is not the target of the first');
  const o = Op(), A = a.c, B = b.c;
  let i = 0, j = 0, x: number | string | undefined = A[i++], y: number | string | undefined = B[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (isDelete(x)) { del(o, -x); x = A[i++]; continue; }
    if (isInsert(y)) { insert(o, y); y = B[j++]; continue; }
    if (x === undefined || y === undefined) throw new OTError('bad_edit', 'compose: the operations do not line up');
    if (isRetain(x) && isRetain(y)) {
      if ((x as number) > y) { retain(o, y); (x as number) -= y; y = B[j++]; } else if (x === y) { retain(o, x); x = A[i++]; y = B[j++]; } else { retain(o, x as number); y -= x as number; x = A[i++]; }
    } else if (isInsert(x) && isDelete(y)) {
      if (x.length > -y) { x = x.slice(-y); y = B[j++]; } else if (x.length === -y) { x = A[i++]; y = B[j++]; } else { y += x.length; x = A[i++]; }
    } else if (isInsert(x) && isRetain(y)) {
      if (x.length > y) { insert(o, x.slice(0, y)); x = x.slice(y); y = B[j++]; } else if (x.length === y) { insert(o, x); x = A[i++]; y = B[j++]; } else { insert(o, x); y -= x.length; x = A[i++]; }
    } else if (isRetain(x) && isDelete(y)) {
      if ((x as number) > -y) { del(o, -y); (x as number) += y; y = B[j++]; } else if (x === -y) { del(o, x); x = A[i++]; y = B[j++]; } else { del(o, x as number); y += x as number; x = A[i++]; }
    } else throw new OTError('bad_edit', 'compose: unreachable');
  }
  return o;
}

/* transform(a, b) for two operations on one text: [a', b'] with a' applied after b and b' after a.
   A's insert at a position where B also inserts stays left: call it with the sequenced operation as A. */
function transform(a: EdTextOperation, b: EdTextOperation): [EdTextOperation, EdTextOperation] {
  if (a.baseLen !== b.baseLen) throw new OTError('bad_edit', 'transform: the operations have different bases');
  const ap = Op(), bp = Op(), A = a.c, B = b.c;
  let i = 0, j = 0, x: number | string | undefined = A[i++], y: number | string | undefined = B[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (isInsert(x)) { insert(ap, x); retain(bp, x.length); x = A[i++]; continue; }
    if (isInsert(y)) { retain(ap, y.length); insert(bp, y); y = B[j++]; continue; }
    if (x === undefined || y === undefined) throw new OTError('bad_edit', 'transform: the operations do not line up');
    let n;
    if (isRetain(x) && isRetain(y)) {
      if (x > y) { n = y; x -= y; y = B[j++]; } else if (x === y) { n = x; x = A[i++]; y = B[j++]; } else { n = x; y -= x; x = A[i++]; }
      retain(ap, n); retain(bp, n);
    } else if (isDelete(x) && isDelete(y)) {
      /* Both delete the same text: it goes once (R7.10). */
      if (-x > -y) { x -= y; y = B[j++]; } else if (x === y) { x = A[i++]; y = B[j++]; } else { y -= x; x = A[i++]; }
    } else if (isDelete(x) && isRetain(y)) {
      if (-x > y) { n = y; x += y; y = B[j++]; } else if (-x === y) { n = y; x = A[i++]; y = B[j++]; } else { n = -x; y += x; x = A[i++]; }
      del(ap, n);
    } else if (isRetain(x) && isDelete(y)) {
      if (x > -y) { n = -y; x += y; y = B[j++]; } else if (x === -y) { n = x; x = A[i++]; y = B[j++]; } else { n = x; y += x; x = A[i++]; }
      del(bp, n);
    } else throw new OTError('bad_edit', 'transform: unreachable');
  }
  return [ap, bp];
}

/* Sequential ops SEQ (already sequenced) and INC (incoming), both made against TEXT: [seq', inc'] as
   sequential ops with del recomputed, seq' against apply(text, inc) and inc' against apply(text, seq). */
function transformOps(seq: EdOTOp[], inc: EdOTOp[], text: EdText): [EdOTOp[], EdOTOp[]] {
  const t = String(text), len = t.length;
  const [sp, ip] = transform(fromOps(seq, len), fromOps(inc, len));
  return [toOps(sp, apply(t, inc)), toOps(ip, apply(t, seq))];
}

/* Rebase INC, made against the text of length BASELEN at some version, through the sequenced batches
   LATER ([{ops, len}] in order, len = the length each batch applied to) and give back the operation that
   applies to the text after them. */
function rebase(inc: EdOTOp[], baseLen: number, later: { ops: EdOTOp[]; len: number }[]) {
  let o = fromOps(inc, baseLen);
  for (const b of later) {
    if (b.len !== o.baseLen) throw new OTError('bad_edit', 'rebase: the history does not line up');
    o = transform(fromOps(b.ops, b.len), o)[1];
  }
  return o;
}

/* ---------- markers (R7.13, R6.12) ---------- */

/* Where a marker at P of TYPE ('before' or 'after') goes after the op [pos, del, ins]: Edwin's shiftMarkers rule. */
function shiftMarker(p: number, type: 'before' | 'after', pos: number, delLen: number, insLen: number) {
  const e = pos + delLen;
  if (p < pos) return p;
  if (p > e || (delLen && p === e)) return p + insLen - delLen;
  return type === 'after' ? pos + insLen : pos;
}
/* True when the op deletes the character a marker at P stood before (the marker is then dead). */
function killsMarker(p: number, pos: number, delLen: number) { return delLen > 0 && p > pos && p < pos + delLen; }

/* ---------- divergence check (R7.14) ---------- */

/* 32-bit FNV-1a over the UTF-16 code units of TEXT (a string, or a rope with chunks). */
function hash(text: EdText) {
  let h = 0x811c9dc5;
  const chunks = (text as Rope).ch && Array.isArray((text as Rope).ch) ? (text as Rope).ch : [String(text)];
  for (const s of chunks) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/* ---------- undo (R6.16–R6.19) ---------- */

/* Delete units of operation O. */
function deletes(o: EdTextOperation) { let n = 0; for (const x of o.c) if (isDelete(x)) n -= x as number; return n; }
/* The text before a sequence of batches, from the text after them: inverted back, newest first. */
function textBefore(text: EdText, batches: EdOTBatch[]) {
  let t = String(text);
  for (let i = batches.length - 1; i >= 0; i--) t = apply(t, invert(batches[i].ops));
  return t;
}
/* Is batch B a (non-undo) batch of group G = {cid, g}? */
const inGroup = (b: EdOTBatch, g: OTGroup | null) => !!g && b.cid === g.cid && !!b.undo && b.undo.g === g.g;

/* Remove group SKIP from the sequential batches ITEMS ([{ops, cid, undo}], the first applying to text T):
   {out, text, pending, partial}. out is the same history in the coordinates of a text that never had the
   group's edits, text is that text after out, and pending is the operation from the real text after ITEMS
   to it: the undo of the group, transformed through everything after it (R6.17). A later undo batch of a
   group whose batches all lie inside the walk cancels with them, so undoing one's own batches in reverse
   order is exact, as linear undo is; an undo of a group that started before the walk is an ordinary batch.
   partial is true when another batch deleted text the undo would delete, so the undo shrank. */
function reduceSeq(items: EdOTBatch[], T: string, skip: OTGroup | null): OTWalk {
  /* Cancel the complete undo pairs first, so the group's inverse never meets a batch that a later batch
     undoes again (the delete would shrink and never grow back). */
  if (skip) items = walk(items, T, null).out;
  return walk(items, T, skip);
}
function walk(items: EdOTBatch[], T: string, skip: OTGroup | null): OTWalk {
  const out: EdOTBatch[] = [], texts: string[] = [];
  let real = String(T), red = real, pending: EdTextOperation | null = null, partial = false;
  for (const b of items) {
    const op = fromOps(b.ops, real.length);
    const after = apply(real, b.ops);
    if (inGroup(b, skip)) {
      const inv = fromOps(invert(b.ops), after.length);
      pending = pending ? compose(inv, pending) : inv;
      real = after; continue;
    }
    let cancelled = false;
    /* An undo of a group whose batches all lie in out cancels with them: the real text after it is the
       reduced text without that group. Only the first pass (no skip, so pending is null) meets these. */
    if (!pending && b.undo && b.undo.of !== undefined) {
      const g = { cid: b.undo.ofCid || b.cid, g: b.undo.of };
      const j = out.findIndex(x => inGroup(x, g));
      if (j >= 0) {
        const r = reduceSeq(out.slice(j), texts[j], g);
        out.splice(j, out.length - j, ...r.out); texts.splice(j, texts.length - j, ...r.texts);
        red = r.text;
        cancelled = true;
      }
    }
    if (!cancelled) {
      if (pending) {
        const was = deletes(pending);
        const [bp, pp] = transform(op, pending);
        if (deletes(pp) < was) partial = true;
        const ops = toOps(bp, red);
        texts.push(red); out.push({ ops, cid: b.cid, undo: b.undo }); red = apply(red, ops);
        pending = pp;
      } else { texts.push(red); out.push({ ops: b.ops, cid: b.cid, undo: b.undo }); red = after; }
    }
    real = after;
  }
  return { out, texts, text: red, pending: pending || retain(Op(), real.length), partial };
}

/* The undo of GROUP ({cid, g}) given HISTORY, the sequential batches [{ver, ops, cid, undo}] from the
   group's first batch to the newest one, and TEXT, the text after them: {op, partial} with op the operation
   on TEXT that undoes the group through everything sequenced after it (R6.17, R6.19). */
function undoOps(group: OTGroup, history: EdOTBatch[], text: EdText) {
  const r = reduceSeq(history, textBefore(text, history), group);
  return { op: r.pending, partial: r.partial };
}

const OT = { OTError, apply, applyOp, checkOp, check, invert, delta, fromOps, toOps, applyOperation, compose, transform, transformOps, rebase, shiftMarker, killsMarker, hash, splitsPair, undoOps, textBefore, Op, retain, insert, del };
if (typeof module !== 'undefined' && module.exports) module.exports = OT;
root.EdOT = OT;
})(typeof globalThis !== 'undefined' ? globalThis : self);
