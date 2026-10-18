// The replica model used by the OT property tests and the conformance tests: a seeded generator, a
// sequencing server as §7.6 describes it, and a client with the states of R7.12 (synchronised, awaiting
// ack, awaiting ack with a queue). Markers follow R7.13 so the tests can compare them (R16.3).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const OT = require('../src/ot.ts') as OTModule;

/* An op of the wire and journal form: [pos, del, ins] (R7.5). */
export type EditOp = [pos: number, del: string, ins: string];
/* A TextOperation: retain (positive), delete (negative) and insert (string) components. */
export interface TextOperation { c: (number | string)[]; baseLen: number; targetLen: number }
/* The undo field of an edit (R6.16-R6.19): the batch's group, and the group it undoes. */
export interface UndoTag { g?: string | number; of?: string | number; ofCid?: string }
/* A sequenced batch as undoOps and textBefore read it. */
export interface UndoBatch { ver?: number; ops: EditOp[]; cid: string; undo?: UndoTag | null; len?: number }
export type MarkerType = 'before' | 'after';
/* The surface of src/ot.ts (R7.14), which this program loads untyped. */
export interface OTModule {
  OTError: new (code: string, msg: string) => Error & { code: string };
  apply(text: string, ops: EditOp[]): string;
  applyOp(text: string, op: EditOp): string;
  checkOp(text: string, op: EditOp): void;
  check(text: string, ops: EditOp[]): number;
  invert(ops: EditOp[]): EditOp[];
  delta(ops: EditOp[]): number;
  fromOps(ops: EditOp[], len: number): TextOperation;
  toOps(o: TextOperation, text: string): EditOp[];
  applyOperation(s: string, o: TextOperation): string;
  compose(a: TextOperation, b: TextOperation): TextOperation;
  transform(a: TextOperation, b: TextOperation): [TextOperation, TextOperation];
  transformOps(seq: EditOp[], inc: EditOp[], text: string): [EditOp[], EditOp[]];
  rebase(inc: EditOp[], baseLen: number, later: { ops: EditOp[]; len: number }[]): TextOperation;
  shiftMarker(p: number, type: MarkerType, pos: number, delLen: number, insLen: number): number;
  killsMarker(p: number, pos: number, delLen: number): boolean;
  hash(text: string | { ch: string[] }): number;
  splitsPair(text: string, pos: number): boolean;
  undoOps(group: { cid: string; g?: string | number }, history: UndoBatch[], text: string): { op: TextOperation; partial: boolean };
  textBefore(text: string, batches: { ops: EditOp[] }[]): string;
  Op(): TextOperation;
  retain(o: TextOperation, n: number): TextOperation;
  insert(o: TextOperation, s: string): TextOperation;
  del(o: TextOperation, n: number): TextOperation;
}

export interface Rng { next(): number; int(lo: number, hi: number): number; pick<T>(arr: readonly T[]): T }
export interface Marker { pos: number; type: MarkerType; dead: boolean; touched?: boolean }
/* What the sequencer sends a replica. */
export type SimMsg = { t: 'ack'; seq: number; ver: number } | { t: 'edits'; ver: number; ops: EditOp[]; by: string };
/* An edit as a replica sends it. */
export interface SimEdit { base: number; seq: number; ops: EditOp[]; undo?: UndoTag }
/* A batch in the sequencer's history. */
export interface SimBatch { ver: number; cid: string; seq: number; ops: EditOp[]; len: number; undo?: UndoTag }
export interface Inflight { seq: number; base: number; ops: EditOp[]; undo: UndoTag }
export interface Queued { ops: EditOp[]; undo?: UndoTag }

/* ---------- a seeded generator ---------- */
export function rng(seed: number): Rng {
  let a = (seed >>> 0) || 1, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const next = () => { // xoshiro128**
    const t = b << 9; let r = Math.imul(b * 5, 1); r = (Math.imul(r << 7 | r >>> 25, 9)) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = d << 11 | d >>> 21; return r / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(arr: readonly T[]): T => arr[int(0, arr.length - 1)];
  return { next, int, pick };
}
export const ALPHABET: string[] = ['a', 'b', 'c', '\n', '\n', ' ', 'é', '😀', '🧪', 'x', 'y', '\n'];
export const randText = (r: Rng, n: number): string => { let s = ''; for (let i = 0; i < n; i++) s += r.pick(ALPHABET); return s; };
/* A pair-safe position in TEXT. */
export function randPos(r: Rng, text: string): number { let p = r.int(0, text.length); if (OT.splitsPair(text, p)) p--; return p; }
/* A random op against TEXT: insert, delete or replace, pair-safe. */
export function randOp(r: Rng, text: string, zone?: [number, number]): EditOp {
  const lo = zone ? zone[0] : 0, hi = zone ? zone[1] : text.length;
  let a = lo + r.int(0, Math.max(0, hi - lo)); if (OT.splitsPair(text, a)) a--;
  if (a < lo) a = lo;
  const kind = r.int(0, 5);
  let b = a;
  if (kind >= 2 && hi > a) { b = Math.min(hi, a + r.int(1, 4)); if (OT.splitsPair(text, b)) b = b + 1 <= hi ? b + 1 : b - 1; }
  const del = text.slice(a, b);
  const ins = kind === 2 || kind === 3 ? '' : randText(r, r.int(1, 3));
  if (!del && !ins) return [a, '', 'z'];
  return [a, del, ins];
}

/* ---------- markers ---------- */
export function makeMarkers(text: string, r: Rng, n: number): Marker[] {
  const out: Marker[] = [];
  for (let i = 0; i < n; i++) out.push({ pos: randPos(r, text), type: r.next() < 0.5 ? 'before' : 'after', dead: false });
  return out.map(m => ({ ...m }));
}
export function shiftAll(markers: Marker[], ops: EditOp[]): void {
  for (const [pos, del, ins] of ops) for (const m of markers) {
    if (OT.killsMarker(m.pos, pos, del.length)) m.dead = true;
    /* A deletion that reached the marker (covered it, or ended or started at it): see R16.3 in ot.test.mts. */
    if (del.length && m.pos >= pos && m.pos <= pos + del.length) m.touched = true;
    m.pos = OT.shiftMarker(m.pos, m.type, pos, del.length, ins.length);
  }
}

/* ---------- the server (the sequencer of §7.6) ---------- */
export class Server {
  declare text: string; declare ver: number; declare hist: SimBatch[]; declare out: Map<string, SimMsg[]>; declare acked: Map<string, number>; declare markers: Marker[];
  constructor(text: string, markers: Marker[]) { this.text = text; this.ver = 0; this.hist = []; this.out = new Map(); this.acked = new Map(); this.markers = markers; }
  send(cid: string, msg: SimMsg): void { this.out.get(cid)!.push(msg); }
  lenAt(ver: number): number { const b = this.hist.find(x => x.ver === ver + 1); return b ? b.len : this.text.length; }
  edit(cid: string, { base, seq, ops, undo }: SimEdit): void {
    const key = cid + ':' + seq;
    if (this.acked.has(key)) { this.send(cid, { t: 'ack', seq, ver: this.acked.get(key)! }); return; } // R7.15
    if (base > this.ver) throw new Error('base from the future');
    const later = this.hist.filter(b => b.ver > base);
    const op = OT.rebase(ops, this.lenAt(base), later);
    const applied = OT.toOps(op, this.text);
    const len = this.text.length;
    this.text = OT.apply(this.text, applied);
    shiftAll(this.markers, applied);
    this.ver++;
    this.hist.push({ ver: this.ver, cid, seq, ops: applied, len, undo });
    this.acked.set(key, this.ver);
    for (const other of this.out.keys()) this.send(other, other === cid ? { t: 'ack', seq, ver: this.ver } : { t: 'edits', ver: this.ver, ops: applied, by: cid });
  }
}

/* ---------- a replica (the client states of R7.12) ---------- */
export class Client {
  declare cid: string; declare server: Server; declare text: string; declare sverText: string; declare sver: number;
  declare inflight: Inflight | null; declare queue: Queued[]; declare seq: number; declare inbox: SimMsg[]; declare markers: Marker[]; declare acks: Set<number>;
  constructor(cid: string, server: Server, markers: Marker[]) {
    this.cid = cid; this.server = server; this.text = server.text; this.sverText = server.text; this.sver = server.ver;
    this.inflight = null; this.queue = []; this.seq = 0; this.inbox = []; this.markers = markers; this.acks = new Set();
    server.out.set(cid, this.inbox);
  }
  /* Text after the inflight batch (the base of the queue). */
  afterInflight(): string { return this.inflight ? OT.apply(this.sverText, this.inflight.ops) : this.sverText; }
  local(ops: EditOp[], compose?: boolean, undo?: UndoTag): void {
    this.text = OT.apply(this.text, ops);
    shiftAll(this.markers, ops);
    if (!this.inflight) { this.inflight = { seq: ++this.seq, base: this.sver, ops, undo: undo || { g: 'q' + this.seq } }; this.send(); }
    else if (compose && this.queue.length) this.queue[this.queue.length - 1].ops = this.queue[this.queue.length - 1].ops.concat(ops);
    else this.queue.push({ ops, undo });
  }
  send(): void { this.server.edit(this.cid, { base: this.inflight!.base, seq: this.inflight!.seq, ops: this.inflight!.ops, undo: this.inflight!.undo }); }
  resend(): void { if (this.inflight) this.send(); }
  recv(msg: SimMsg): void {
    if (msg.t === 'ack') {
      if (this.acks.has(msg.seq)) return; // a duplicate ack from a resend
      assert.equal(msg.seq, this.inflight!.seq, 'ack for the wrong batch');
      this.acks.add(msg.seq);
      this.sverText = OT.apply(this.sverText, this.inflight!.ops); this.sver = msg.ver; this.inflight = null;
      if (this.queue.length) { const q = this.queue.shift()!; this.inflight = { seq: ++this.seq, base: this.sver, ops: q.ops, undo: q.undo || { g: 'q' + this.seq } }; this.send(); }
      return;
    }
    assert.equal(msg.t, 'edits');
    assert.equal(msg.ver, this.sver + 1, 'edits out of order');
    let R = OT.fromOps(msg.ops, this.sverText.length);
    let base = OT.apply(this.sverText, msg.ops); // the text R' and the rebased inflight apply to
    this.sverText = base; this.sver = msg.ver;
    if (this.inflight) {
      const [Rp, Ip] = OT.transform(R, OT.fromOps(this.inflight.ops, this.sverText.length - OT.delta(msg.ops)));
      this.inflight.ops = OT.toOps(Ip, base); this.inflight.base = this.sver; R = Rp; base = OT.applyOperation(base, Ip); // a resend carries the rebased ops with their new base
    }
    for (let i = 0; i < this.queue.length; i++) {
      const [Rp, Qp] = OT.transform(R, OT.fromOps(this.queue[i].ops, R.baseLen));
      this.queue[i].ops = OT.toOps(Qp, base); R = Rp; base = OT.applyOperation(base, Qp);
    }
    const applied = OT.toOps(R, this.text);
    this.text = OT.apply(this.text, applied);
    shiftAll(this.markers, applied);
    assert.equal(this.text, base);
  }
}

/* Run one random session from SEED and give back the server and clients, fully drained. */
export function session(seed: number, opts: { edits?: number } = {}): { server: Server; clients: Client[]; r: Rng } {
  const r = rng(seed);
  const text = randText(r, r.int(0, 40));
  const nClients = r.int(2, 5), nEdits = r.int(1, opts.edits || 20);
  const markers = makeMarkers(text, r, 6);
  const server = new Server(text, markers.map(m => ({ ...m })));
  const clients: Client[] = []; for (let i = 0; i < nClients; i++) clients.push(new Client('c' + i, server, markers.map(m => ({ ...m }))));
  let edits = 0;
  const pending = () => clients.some(c => c.inbox.length);
  while (edits < nEdits || pending()) {
    const c = r.pick(clients);
    const choice = r.int(0, 9);
    if (edits < nEdits && choice < 5) { c.local([randOp(r, c.text)], r.next() < 0.3); edits++; }
    else if (choice === 5 && r.next() < 0.2) c.resend();
    else if (c.inbox.length) c.recv(c.inbox.shift()!);
  }
  return { server, clients, r };
}

