// Anchors (spec R9.12, R6.11–R6.13, R7.13): the shared markers edwind holds for every shared buffer, and the
// small server commands the frame runtime needs besides them (user-init, capf-candidates).
//
// A buffer's anchors are `sb.anchors`, a list of {id, pos, label?, quote, prefix}. The sequencer moves them
// in its apply path for every writer (frames, wb, server threads, disk reverts, undo) with `afterOps`; the
// rule is the `after` marker of R6.11/R6.12 (OT.shiftMarker 'after'): an insert exactly at an anchor
// advances it past the inserted text, a deleted range that covers it moves it to the range's start, a
// replacement that covers it puts it at the end of the insertion. This is what today's board does
// (web/app.ts anchorField maps through changes with mapPos(pos, 1), which associates the position with the
// character after it), so ink stays with the text it was drawn next to when someone types at the line start.
//
// Relocation after a disk revert (R8.12–R8.15): every anchor keeps the 24 characters after it (`quote`) and
// the 16 before it (`prefix`), refreshed cheaply after every batch whose ops touch that window. A batch by
// disk (a revert, a three-way merge, an explicit revert) is a diff that may put an anchor on the wrong line,
// so after shifting it the anchor is moved to the nearest occurrence of prefix+quote, else of quote, as
// web/app.ts relocate() does; when neither is found the shifted position stands.
//
// Journal: an anchor add, an anchor remove and a relocation append one line `{t: "a", ver, anchors}` holding
// the whole list as of version `ver` (the journal format stays 1: older edwinds skip unknown line kinds, and
// --check ignores them). Replay takes the last `a` line and shifts its anchors through the batches sequenced
// after `ver`; compaction writes the list after the retained batches. Ordinary shifts are not journaled,
// since the batches reproduce them, and not sent: every client applies the same rule to the same ops. `meta`
// (with `anchors` and `ver`) goes to every attached client when the set changes or a disk batch relocated
// something, coalesced per buffer per event-loop turn. Anchors die with the buffer (kill drops the journal).
//
// Server commands (call{cmd}): anchor-add [buf, pos, label?, id?] -> {id, pos}; anchor-remove [buf, id] ->
// true | false; anchors [buf] -> [{id, pos, label?}]; user-init -> the user's <configDir>/init.scm or null
// (R4.11); capf-candidates [{kind: 'wiki'}] -> note titles, aliases and folder names from the notes index
// (R10.9). Scheme: anchor-add!, anchor-remove!, buffer-anchors (server-only, R4.48).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProtoError, isObj } from './proto.mts';
import { randomId } from './journal.mts';
import { jsonToScheme } from './threads.mts';
import type { Server, Log, SchemeValue } from './main.mts';
import type { SBuf, Buffers } from './buffers.mts';
import type { By, Op, WireAnchor } from './proto.mts';
import type { AnchorsLine, JournalAnchor } from './journal.mts';
import type { SchemeGen } from './threads.mts';

const require = createRequire(import.meta.url);
const OT = require('../src/ot.js');

export const name = 'anchors';
export const QUOTE = 24;
export const PREFIX = 16;
export const ID_MAX = 64;
export const LABEL_MAX = 256;

/* A shared anchor as edwind holds it in sb.anchors; stale marks one whose context window a batch touched. */
export interface Anchor { id: string; pos: number; label?: string; quote: string; prefix: string; stale?: boolean }
/* An `a` line as read back from a journal: unchecked JSON. */
export interface AnchorsLineIn { ver?: unknown; anchors?: unknown }
interface AnchorIn { id?: unknown; pos?: unknown; quote?: unknown; prefix?: unknown; label?: unknown }
/* A string, or a rope (edwin/src) with slice. */
export interface TextLike { slice(start: number, end: number): string }

/* ---------- the marker rules, used by the sequencer ---------- */

/* Shift the anchors of SB through OPS (one batch, in the order the ops were applied) as `after` markers,
   marking the ones whose context window the batch touched. */
function shift(anchors: Anchor[], ops: Op[]): void {
  for (const [pos, del, ins] of ops) {
    const span = Math.max(del.length, ins.length);
    for (const a of anchors) {
      a.pos = OT.shiftMarker(a.pos, 'after', pos, del.length, ins.length);
      if (pos <= a.pos + QUOTE && pos + span >= a.pos - PREFIX) a.stale = true;
    }
  }
}
/* Refresh A's quote and prefix from TEXT (a string or a rope with slice). */
export function capture(text: TextLike, a: Anchor): void {
  a.quote = text.slice(a.pos, a.pos + QUOTE);
  a.prefix = text.slice(Math.max(0, a.pos - PREFIX), a.pos);
  delete a.stale;
}
/* Where A belongs in TEXT (a string) after a wholesale change: the occurrence of prefix+quote, else of quote,
   nearest to its shifted position; without a quote or a match, the shifted position clamped (web/app.ts). */
export function relocate(text: string, a: Anchor): number {
  if (a.quote) {
    for (const [needle, off] of [[(a.prefix || '') + a.quote, (a.prefix || '').length], [a.quote, 0]] as [string, number][]) {
      let best = -1, bd = Infinity, i = text.indexOf(needle);
      while (i >= 0) { const p = i + off, d = Math.abs(p - (a.pos || 0)); if (d < bd) { bd = d; best = p; } i = text.indexOf(needle, i + 1); }
      if (best >= 0) return best;
    }
  }
  return Math.max(0, Math.min(a.pos || 0, text.length));
}
/* The sequencer calls this once OPS by BY have been applied to SB's rope (applyBatch, recordApplied).
   Sets sb.anchorsDirty when the result is not what the shift rule alone gives (a disk relocation), so the
   module journals the list and sends meta after the batch is committed. */
export function afterOps(sb: SBuf, ops: Op[], by?: By | null): void {
  const anchors = sb.anchors;
  if (!anchors || !anchors.length) return;
  shift(anchors, ops);
  if (by && by.kind === 'disk') {
    const text = sb.ed.rope.toString();
    for (const a of anchors) { a.pos = relocate(text, a); capture(text, a); }
    sb.anchorsDirty = true;
    return;
  }
  const rope = sb.ed.rope;
  for (const a of anchors) if (a.stale) capture(rope, a);
}
/* A copy of SB's anchors, for the rollback of a batch whose journal line failed (sequencer.rollback). */
export function snapshot(sb: SBuf): Anchor[] | null { return sb.anchors && sb.anchors.length ? sb.anchors.map(a => ({ ...a })) : null; }

/* ---------- journal lines ---------- */

/* The journal line that records SB's anchors as of its current version. */
export function record(sb: SBuf): AnchorsLine {
  return { t: 'a', ver: sb.ver, anchors: sb.anchors.map(a => { const o: JournalAnchor = { id: a.id, pos: a.pos, quote: a.quote, prefix: a.prefix }; if (a.label) o.label = a.label; return o; }) };
}
/* Restore SB's anchors at reload from REC, the journal's last `a` line (or null), shifted through BATCHES
   sequenced after it. A record from after the last whole batch (a torn tail) is clamped, never dropped. */
export function restore(sb: SBuf, rec: AnchorsLineIn | null, batches: { ver: number; ops: Op[] }[]): void {
  sb.anchors = [];
  if (!rec || !Array.isArray(rec.anchors)) return;
  const anchors: Anchor[] = [];
  for (const a of rec.anchors as (AnchorIn | null)[]) {
    if (!a || typeof a.id !== 'string' || !Number.isInteger(a.pos)) continue;
    const o: Anchor = { id: a.id, pos: a.pos as number, quote: typeof a.quote === 'string' ? a.quote : '', prefix: typeof a.prefix === 'string' ? a.prefix : '' };
    if (typeof a.label === 'string' && a.label) o.label = a.label;
    anchors.push(o);
  }
  const from = Number.isInteger(rec.ver) ? rec.ver as number : -1;
  for (const b of batches) if (b.ver > from) shift(anchors, b.ops);
  const rope = sb.ed.rope;
  for (const a of anchors) { a.pos = Math.max(0, Math.min(a.pos, rope.length)); capture(rope, a); }
  sb.anchors = anchors;
}
/* The anchors as meta and the `anchors` command carry them (§7.3). */
export function publicAnchors(sb: SBuf): WireAnchor[] {
  return (sb.anchors || []).map(a => (a.label ? { id: a.id, pos: a.pos, label: a.label } : { id: a.id, pos: a.pos }));
}

/* ---------- the module ---------- */

export class Anchors {
  declare server: Server; declare log: Log; declare buffers: Buffers;
  declare pendingMeta: Set<SBuf>;
  constructor(server: Server) {
    this.server = server; this.log = server.log; this.buffers = server.buffers;
    this.pendingMeta = new Set();
  }
  /* meta to every attached client of SB, once per event-loop turn however many changes this turn made. */
  scheduleMeta(sb: SBuf): void {
    if (this.pendingMeta.has(sb)) return;
    this.pendingMeta.add(sb);
    setImmediate(() => { this.pendingMeta.delete(sb); if (this.buffers.byJid.get(sb.jid) === sb) this.buffers.sendMeta(sb); });
  }
  /* Journal SB's anchor list; resolves when the line is on disk. A buffer without a journal (a big file) keeps
     its anchors in memory only. A failed append (ENOSPC) rejects with read_only; the caller takes its change back. */
  journal(sb: SBuf): Promise<void> {
    if (!sb.journal || sb.big) return Promise.resolve();
    return sb.journal.append(record(sb)).catch((e: NodeJS.ErrnoException) => { throw new ProtoError('read_only', `journal write failed: ${e.code || e.message}`, { buf: sb.id }); });
  }
  /* The buffer named by ID (any spelling), else no_buffer. */
  bufferOf(id: unknown, fallback?: string): SBuf {
    const x = typeof id === 'string' ? id : fallback;
    if (typeof x !== 'string') throw new ProtoError('bad_request', 'a buffer id is required');
    return this.buffers.get(x);
  }
  /* A thread holding SB (R4.41) has its pending edits sequenced first, so positions are read and placed
     against the sequenced text (as applyBatch does for a server batch). */
  settle(sb: SBuf): SBuf { const seq = this.buffers.seq; if (sb.hold && seq.flushHold) seq.flushHold(sb); return sb; }
  /* Add an anchor to SB at POS with LABEL and ID (client-chosen when given and unused, else random). The
     position is clamped to the text. Returns {id, pos}. */
  async add(sb: SBuf, pos: number, label?: string | null, id?: string | null): Promise<{ id: string; pos: number }> {
    if (!Number.isInteger(pos) || pos < 0) throw new ProtoError('bad_request', 'pos must be a non-negative integer');
    if (label !== undefined && label !== null && (typeof label !== 'string' || Buffer.byteLength(label) > LABEL_MAX)) throw new ProtoError('bad_request', `label must be a string of at most ${LABEL_MAX} bytes`);
    if (id !== undefined && id !== null && (typeof id !== 'string' || !id || Buffer.byteLength(id) > ID_MAX)) throw new ProtoError('bad_request', `id must be a string of at most ${ID_MAX} bytes`);
    this.settle(sb);
    const rope = sb.ed.rope;
    pos = Math.min(pos, rope.length);
    if (OT.splitsPair(rope, pos)) pos--;
    if (!id || sb.anchors.some(a => a.id === id)) { do id = randomId(8); while (sb.anchors.some(a => a.id === id)); }
    const a: Anchor = { id, pos, quote: '', prefix: '' };
    if (label) a.label = label;
    capture(rope, a);
    sb.anchors.push(a);
    try { await this.journal(sb); } catch (e) { const i = sb.anchors.indexOf(a); if (i >= 0) sb.anchors.splice(i, 1); throw e; }
    this.scheduleMeta(sb);
    this.log.info('anchor', { buf: sb.id, op: 'add', anchors: sb.anchors.length });
    return { id, pos };
  }
  async remove(sb: SBuf, id: unknown): Promise<boolean> {
    if (typeof id !== 'string') throw new ProtoError('bad_request', 'id must be a string');
    const i = sb.anchors.findIndex(a => a.id === id);
    if (i < 0) return false;
    const [a] = sb.anchors.splice(i, 1);
    try { await this.journal(sb); } catch (e) { sb.anchors.splice(Math.min(i, sb.anchors.length), 0, a); throw e; }
    this.scheduleMeta(sb);
    this.log.info('anchor', { buf: sb.id, op: 'remove', anchors: sb.anchors.length });
    return true;
  }

  /* The user's init.scm (R4.11), read through the authority: its text, or null when absent. */
  userInit(): string | null {
    const file = path.join(this.server.cfg.configDir, 'init.scm');
    let real;
    try { real = fs.realpathSync.native(file); } catch (e) { if (e.code === 'ENOENT') return null; throw new ProtoError('refused_path', `${file}: ${e.code}`); }
    try { this.server.auth.checkRead(real); } catch (e) { throw new ProtoError('refused_path', e.message); }
    try { return fs.readFileSync(real, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw new ProtoError('refused_path', `${file}: ${e.code}`); }
  }
  /* Completion candidates for the frames' cache (R10.9): for kind wiki, the note titles and aliases and the
     folder names of the notes index, sorted and unique; [] without an index. */
  candidates(spec: unknown): string[] {
    const kind = isObj(spec) ? spec.kind : spec;
    if (kind !== 'wiki') throw new ProtoError('bad_request', 'capf-candidates: kind must be wiki');
    const notes = this.server.notes;
    if (!notes || !notes.exists()) return [];
    const out = new Set<string>();
    const d = notes.derived();
    for (const id of d.ids) {
      const f = notes.files.get(id)!.rec.file;
      if (f.title) out.add(f.title);
      for (const a of f.aliases) if (a) out.add(a);
      for (let dir = path.posix.dirname(id); dir && dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) out.add(dir);
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  install(): void {
    const server = this.server, B = this.buffers;
    /* A batch is committed: a relocation is journaled and announced. */
    B.on('afterBatch', sb => { if (sb.anchorsDirty) { sb.anchorsDirty = false; this.journal(sb).catch(e => this.log.warn('anchor', { buf: sb.id, error: e.code || e.message })); this.scheduleMeta(sb); } });
    B.on('killed', sb => { this.pendingMeta.delete(sb); sb.anchors = []; });

    server.defineCommand('anchor-add', (client, args, ctx, buf) => this.add(this.bufferOf(args[0], buf), args[1] as number, args[2] as string | null | undefined, args[3] as string | null | undefined).then(value => ({ value })));
    server.defineCommand('anchor-remove', (client, args, ctx, buf) => this.remove(this.bufferOf(args[0], buf), args[1]).then(value => ({ value })));
    server.defineCommand('anchors', (client, args, ctx, buf) => ({ value: publicAnchors(this.settle(this.bufferOf(args[0], buf))) }));
    server.defineCommand('user-init', () => ({ value: this.userInit() }));
    server.defineCommand('capf-candidates', (client, args) => ({ value: this.candidates(args[0] === undefined ? { kind: 'wiki' } : args[0]) }));
    server.statusProviders.push(() => { let n = 0; for (const sb of B.all()) n += sb.anchors.length; return { anchors: n }; });

    /* Scheme (server-only, R4.48). BUFFER is a shared buffer id, an Edwin buffer or its name, or omitted for
       the current buffer; a buffer edwind does not share is an error. */
    const { L, Ed } = server, S = L.S;
    const sbOf = (x: SchemeValue, who: string): SBuf => {
      let sb: SBuf | null = null;
      if (typeof x === 'string' && B.byId.has(x)) sb = B.byId.get(x)!;
      else sb = B.ofEd(Ed.toBuffer(x));
      if (!sb) throw new S.SchemeError('error', `${who}: not a shared buffer`, [x === undefined ? false : x]);
      return this.settle(sb);
    };
    const D = (nm: string, args: string, doc: string, fn: (args: SchemeValue[]) => SchemeValue, gen?: (args: SchemeValue[]) => SchemeGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
    const cannot = (nm: string) => (): never => { throw new S.SchemeError('cannot-block', `${nm}: cannot wait here`, []); };
    const num = (x: SchemeValue, who: string): number => { if (typeof x !== 'number' || !Number.isInteger(x)) throw new S.SchemeError('wrong-type-argument', `${who}: position must be an integer`, [x]); return x; };
    const str = (x: SchemeValue, who: string, what: string): string | undefined => { if (x === undefined || x === false) return undefined; if (typeof x !== 'string') throw new S.SchemeError('wrong-type-argument', `${who}: ${what} must be a string`, [x]); return x; };
    const err = (e: unknown): unknown => (e instanceof ProtoError ? new S.SchemeError('error', e.message, []) : e);
    D('anchor-add!', 'BUFFER POS &optional LABEL ID', 'Add a shared anchor to BUFFER at POS with LABEL and ID (random when omitted or in use); the id (R9.12).', cannot('anchor-add!'),
      function* (this: Anchors, [b, pos, label, id]: SchemeValue[]): SchemeGen { const sb = sbOf(b, 'anchor-add!'); try { const r = yield new S.Block(this.add(sb, num(pos, 'anchor-add!'), str(label, 'anchor-add!', 'label'), str(id, 'anchor-add!', 'id')), 'anchor-add!'); return r.id; } catch (e) { throw err(e); } }.bind(this));
    D('anchor-remove!', 'BUFFER ID', 'Remove the shared anchor ID from BUFFER; #t when it existed.', cannot('anchor-remove!'),
      function* (this: Anchors, [b, id]: SchemeValue[]): SchemeGen { const sb = sbOf(b, 'anchor-remove!'); try { return yield new S.Block(this.remove(sb, str(id, 'anchor-remove!', 'id')), 'anchor-remove!'); } catch (e) { throw err(e); } }.bind(this));
    D('buffer-anchors', '&optional BUFFER', 'The shared anchors of BUFFER as alists ((id . ID) (pos . POS) (label . LABEL)).', ([b]: SchemeValue[]) => jsonToScheme(S, publicAnchors(sbOf(b, 'buffer-anchors'))));
  }
}

let anchors: Anchors | null = null;
export async function install(server: Server): Promise<void> { anchors = new Anchors(server); server.anchors = anchors; anchors.install(); }
export async function shutdown(server: Server): Promise<void> { anchors = null; server.anchors = null; }
