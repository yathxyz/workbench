// The edit protocol's framing and shapes (spec §7.1, §7.8): newline-delimited JSON with `t`, lines no
// longer than MAX_LINE, requests with a `rid` of at most 64 bytes, and the error codes.
import { Buffer } from 'node:buffer';

export const PROTO = 1;
/* wb_proto::limits::MAX_LINE (crates/wb-proto/src/limits.rs): 16 MiB, newline excluded. A test compares. */
export const MAX_LINE = 16 * 1024 * 1024;
export const RID_MAX = 64;
/* Bulk payloads go in pieces of this size (R14.14). */
export const CHUNK = 1024 * 1024;
/* Queued edits, sel and msg frames a client may hold before it is dropped (R14.14). */
export const CLIENT_QUEUE_CAP = 4 * 1024 * 1024;
export const PING_EVERY_MS = 20000;
export const HELLO_TIMEOUT_MS = 5000;
export const SEL_PER_SECOND = 20;

export const CODES = ['bad_request', 'too_large', 'bad_id', 'no_buffer', 'not_text', 'bad_edit', 'stale_base', 'read_only', 'refused_path', 'slow_client', 'proto', 'shutting_down'];

export class ProtoError extends Error {
  constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra || {}; }
}
export const bad = (msg, extra) => new ProtoError('bad_request', msg, extra);

/* Encode one message as a line. */
export const encode = obj => JSON.stringify(obj) + '\n';

/* Split a byte stream into lines, each at most MAX_LINE bytes. onLine(text) gets each complete line;
   onTooLong() fires once for a line past the limit, whose bytes are then skipped up to its newline. */
export class LineReader {
  constructor(onLine, onTooLong, max = MAX_LINE) { this.onLine = onLine; this.onTooLong = onTooLong; this.max = max; this.parts = []; this.size = 0; this.skipping = false; }
  push(chunk) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) {
        const rest = chunk.subarray(start);
        if (this.skipping) return;
        if (this.size + rest.length > this.max) { this.skipping = true; this.parts = []; this.size = 0; this.onTooLong(); return; }
        if (rest.length) { this.parts.push(rest); this.size += rest.length; }
        return;
      }
      if (this.skipping) { this.skipping = false; start = nl + 1; continue; }
      const piece = chunk.subarray(start, nl);
      if (this.size + piece.length > this.max) { this.parts = []; this.size = 0; this.onTooLong(); start = nl + 1; continue; }
      const line = this.parts.length ? Buffer.concat([...this.parts, piece]) : piece;
      this.parts = []; this.size = 0;
      this.onLine(line.toString('utf8'));
      start = nl + 1;
    }
  }
}

/* ---------- field checks ---------- */
export const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function str(msg, k, opt) {
  const v = msg[k];
  if (v === undefined || v === null) { if (opt) return undefined; throw bad(`${k} is required`); }
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}
export function int(msg, k, opt) {
  const v = msg[k];
  if (v === undefined || v === null) { if (opt) return undefined; throw bad(`${k} is required`); }
  if (!Number.isInteger(v) || v < 0) throw bad(`${k} must be a non-negative integer`);
  return v;
}
export function rid(msg) {
  const r = msg.rid;
  if (r === undefined || r === null) return undefined;
  if (typeof r !== 'string' || Buffer.byteLength(r) > RID_MAX) throw bad(`rid must be a string of at most ${RID_MAX} bytes`);
  return r;
}
/* ops: an array of [pos, del, ins] (R7.5); the content is checked against the text later. */
export function ops(msg) {
  const o = msg.ops;
  if (!Array.isArray(o)) throw bad('ops must be an array');
  for (const op of o) if (!Array.isArray(op) || op.length !== 3 || !Number.isInteger(op[0]) || op[0] < 0 || typeof op[1] !== 'string' || typeof op[2] !== 'string') throw bad('an op is [pos, del, ins]');
  return o;
}
/* undo: {g, of?} with g and of strings or integers (R6.15). */
export function undo(msg) {
  const u = msg.undo;
  if (u === undefined || u === null) return undefined;
  if (!isObj(u)) throw bad('undo must be an object');
  const ok = v => typeof v === 'string' ? Buffer.byteLength(v) <= 64 : Number.isInteger(v);
  if (!ok(u.g)) throw bad('undo.g must be a string or an integer');
  if (u.of !== undefined && u.of !== null && !ok(u.of)) throw bad('undo.of must be a string or an integer');
  return u.of === undefined || u.of === null ? { g: u.g } : { g: u.g, of: u.of };
}
