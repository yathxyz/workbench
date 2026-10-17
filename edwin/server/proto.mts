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

/* The error codes of §7.8. */
export type ErrorCode = 'bad_request' | 'too_large' | 'bad_id' | 'no_buffer' | 'not_text' | 'bad_edit' | 'stale_base' | 'read_only' | 'refused_path' | 'slow_client' | 'proto' | 'shutting_down';
export const CODES: ErrorCode[] = ['bad_request', 'too_large', 'bad_id', 'no_buffer', 'not_text', 'bad_edit', 'stale_base', 'read_only', 'refused_path', 'slow_client', 'proto', 'shutting_down'];

/* Fields an error frame carries besides code and msg (buf, seq, …). */
export type ErrorExtra = Record<string, unknown>;

export class ProtoError extends Error {
  declare code: ErrorCode;
  declare extra: ErrorExtra;
  constructor(code: ErrorCode, msg: string, extra?: ErrorExtra) { super(msg); this.code = code; this.extra = extra || {}; }
}
export const bad = (msg: string, extra?: ErrorExtra): ProtoError => new ProtoError('bad_request', msg, extra);

/* Encode one message as a line. */
export const encode = (obj: unknown): string => JSON.stringify(obj) + '\n';

/* Split a byte stream into lines, each at most MAX_LINE bytes. onLine(text) gets each complete line;
   onTooLong() fires once for a line past the limit, whose bytes are then skipped up to its newline. */
export class LineReader {
  declare onLine: (line: string) => void;
  declare onTooLong: () => void;
  declare max: number;
  declare parts: Buffer[];
  declare size: number;
  declare skipping: boolean;
  constructor(onLine: (line: string) => void, onTooLong: () => void, max = MAX_LINE) { this.onLine = onLine; this.onTooLong = onTooLong; this.max = max; this.parts = []; this.size = 0; this.skipping = false; }
  push(chunk: Buffer) {
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
export const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
export function str(msg: WireFields, k: string, opt?: false): string;
export function str(msg: WireFields, k: string, opt: true): string | undefined;
export function str(msg: WireFields, k: string, opt?: boolean): string | undefined {
  const v = msg[k];
  if (v === undefined || v === null) { if (opt) return undefined; throw bad(`${k} is required`); }
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}
export function int(msg: WireFields, k: string, opt?: false): number;
export function int(msg: WireFields, k: string, opt: true): number | undefined;
export function int(msg: WireFields, k: string, opt?: boolean): number | undefined {
  const v = msg[k];
  if (v === undefined || v === null) { if (opt) return undefined; throw bad(`${k} is required`); }
  if (!Number.isInteger(v) || (v as number) < 0) throw bad(`${k} must be a non-negative integer`);
  return v as number;
}
export function rid(msg: WireFields): string | undefined {
  const r = msg.rid;
  if (r === undefined || r === null) return undefined;
  if (typeof r !== 'string' || Buffer.byteLength(r) > RID_MAX) throw bad(`rid must be a string of at most ${RID_MAX} bytes`);
  return r;
}
/* ops: an array of [pos, del, ins] (R7.5); the content is checked against the text later. */
export function ops(msg: WireFields): Op[] {
  const o: unknown = msg.ops;
  if (!Array.isArray(o)) throw bad('ops must be an array');
  for (const op of o as unknown[]) if (!Array.isArray(op) || op.length !== 3 || !Number.isInteger(op[0]) || op[0] < 0 || typeof op[1] !== 'string' || typeof op[2] !== 'string') throw bad('an op is [pos, del, ins]');
  return o as Op[];
}
/* undo: {g, of?} with g and of strings or integers (R6.15). */
export function undo(msg: WireFields): Undo | undefined {
  const u = msg.undo;
  if (u === undefined || u === null) return undefined;
  if (!isObj(u)) throw bad('undo must be an object');
  const ok = (v: unknown): v is string | number => typeof v === 'string' ? Buffer.byteLength(v) <= 64 : Number.isInteger(v);
  if (!ok(u.g)) throw bad('undo.g must be a string or an integer');
  if (u.of !== undefined && u.of !== null && !ok(u.of)) throw bad('undo.of must be a string or an integer');
  return u.of === undefined || u.of === null ? { g: u.g as string | number } : { g: u.g as string | number, of: u.of as string | number };
}

/* ---------- message types (§7) ---------- */
/* A decoded line: an object with t whose other fields are still unchecked (the field checks above read them). */
export type WireFields = Record<string, unknown>;
export interface WireMessage { t: string; [k: string]: unknown }

/* An op [pos, del, ins] (R7.5) and an undo group (R6.15). */
export type Op = [pos: number, del: string, ins: string];
export interface Undo { g: string | number; of?: string | number }

/* Attribution (§7.9, R13.2): a client (frame, cli, web), the disk, the server (a thread) or an agent. */
export type ByKind = 'frame' | 'cli' | 'web' | 'disk' | 'server' | 'agent';
export interface By {
  kind: ByKind;
  cid?: string | null;
  device?: string | null;
  session?: string;
  thread?: string;
  agent?: string;
  tab?: unknown; // a web tab id as the client sent it
}
export type ClientKind = 'frame' | 'cli' | 'web';

/* The result object of call (§7.4): a value, or the error of a condition; msg is the echo area, out the
   output port. */
export interface Condition { condition: string; report: string; restarts: unknown[]; backtrace: string[] }
export type CallResult =
  | { value: unknown; error?: never; msg?: string; out?: string }
  | { error: Condition; value?: never; msg?: string; out?: string };
/* ctx of call (§7.4): the client's object with the request's rid added. */
export interface CallCtx { rid?: string; wait?: unknown; [k: string]: unknown }

/* A buffer's meta (§7.3), as SBuf.meta() builds it. */
export interface WireAnchor { id: string; pos: number; label?: string }
export interface Meta {
  file: string | null;
  mode: string;
  modified: boolean;
  readOnly: string | boolean;
  saved: number;
  diskChanged: 'conflict' | 'deleted' | string | null;
  eol: 'lf' | 'crlf';
  anchors: WireAnchor[];
  locals: Record<string, unknown>;
  ver: number;
}

/* Client → server. */
export interface HelloMsg { t: 'hello'; proto: number; cid: string; kind: ClientKind; device?: string; session?: string; caps?: Record<string, unknown>; client?: string }
export interface PingMsg { t: 'ping'; rid?: string }
export interface PongMsg { t: 'pong'; rid?: string }
export interface OpenMsg { t: 'open'; rid?: string; buf: string; since?: number; create?: boolean }
export interface CloseMsg { t: 'close'; buf: string }
export interface EditMsg { t: 'edit'; buf: string; base: number; seq: number; ops: Op[]; undo?: Undo }
export interface SelMsg { t: 'sel'; buf: string; ranges: unknown[] }
export interface SaveMsg { t: 'save' | 'revert'; rid?: string; buf: string }
export interface CallMsg { t: 'call'; rid: string; cmd?: string; form?: string; args?: unknown[]; ctx?: Record<string, unknown>; buf?: string }
export interface ImageQueryMsg { t: 'image?'; rid?: string; from: number }
export type ClientMessage = HelloMsg | PingMsg | PongMsg | OpenMsg | CloseMsg | EditMsg | SelMsg | SaveMsg | CallMsg | ImageQueryMsg;

/* Server → client. */
export interface WelcomeMsg { t: 'welcome'; proto: number; build: string; boot: string; imageEpoch: string; gen: number; caps: Record<string, unknown> }
export interface ErrorMsg { t: 'error'; code: ErrorCode; msg: string; rid?: string; buf?: string; seq?: number; [k: string]: unknown }
export type ResultMsg = { t: 'result'; rid?: string } & ({ value: unknown; error?: never; msg?: string; out?: string } | { error: Condition; value?: never; msg?: string; out?: string });
export interface OpenedMsg { t: 'opened'; rid?: string; buf: string; ver: number }
export interface SnapMsg { t: 'snap'; rid?: string; buf: string; ver: number; text: string; meta: Meta; more?: true }
export interface ChunkMsg { t: 'chunk'; rid?: string; buf: string; text: string; more: boolean }
export type MetaMsg = { t: 'meta'; buf: string } & Meta;
export interface MovedMsg { t: 'moved'; buf: string; to: string }
export interface KilledMsg { t: 'killed'; buf: string }
export interface AckMsg { t: 'ack'; buf: string; seq: number | null; ver: number; h?: number }
export interface EditsMsg { t: 'edits'; buf: string; ver: number; ops: Op[]; by: By; h?: number }
export interface SelOutMsg { t: 'sel'; buf: string; by: By; ranges: unknown[] }
export interface EchoMsg { t: 'msg'; text: string; level: string }
export interface DisplayMsg { t: 'display'; buf: string; how: string }
export interface ImageMsg { t: 'image'; gen: number; forms: string[] }
export interface VarMsg { t: 'var'; name: string; value: unknown }
export interface NotesMsg { t: 'notes'; gen: number }
export interface AskMsg { t: 'ask'; rid: string; kind: string; prompt: string; init?: unknown; table?: unknown }
export type ServerMessage = WelcomeMsg | ErrorMsg | PingMsg | PongMsg | ResultMsg | OpenedMsg | SnapMsg | ChunkMsg | MetaMsg | MovedMsg | KilledMsg | AckMsg | EditsMsg | SelOutMsg | EchoMsg | DisplayMsg | ImageMsg | VarMsg | NotesMsg | AskMsg;
/* What Client.send takes: a §7 message, or a module's own (sample.text, …). */
export type OutMessage = ServerMessage | WireMessage;
