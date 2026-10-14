// The sequencer (spec §7.6–§7.7): one authoritative order of batches per buffer. An incoming edit is
// transformed against every batch sequenced after its base, checked, applied to the Edwin buffer through
// editText (so markers and change hooks run, R6.8), journaled and fsynced, then acknowledged to its
// sender and sent as `edits` to everyone else. Server-made batches (disk reverts, merges, undo) take
// the same path from applyBatch.
import { createRequire } from 'node:module';
import { ProtoError } from './proto.mjs';

const require = createRequire(import.meta.url);
const OT = require('../src/ot.js');

/* History retention (R7.17). */
export const HIST_MIN_BATCHES = 10000;
export const HIST_MIN_MS = 24 * 3600 * 1000;
export const HIST_MAX_BYTES = 32 * 1024 * 1024;
/* Every HASH_EVERY versions ack and edits carry the text hash (R7.14). */
export const HASH_EVERY = 50;

const originOf = by => (by.kind === 'disk' ? 'disk' : by.kind === 'server' ? 'server' : by.kind === 'agent' ? 'agent' : 'remote');

export class Sequencer {
  constructor(Ed, log) { this.Ed = Ed; this.log = log; }

  /* The length of the text at version VER of SB, from its history. */
  lenAt(sb, ver) {
    const b = sb.hist.find(x => x.ver === ver + 1);
    return b ? b.len : sb.ed.rope.length;
  }
  /* Is BASE still inside the retained history? */
  inHistory(sb, base) { return base === sb.ver || (sb.hist.length > 0 && base >= sb.hist[0].ver - 1); }

  /* Rebase OPS made against version BASE to the current text and check them: the ops as they apply now.
     Throws ProtoError stale_base or bad_edit. */
  rebase(sb, ops, base) {
    if (base > sb.ver) throw new ProtoError('bad_request', `base ${base} is ahead of the buffer (version ${sb.ver})`);
    if (!this.inHistory(sb, base)) throw new ProtoError('stale_base', `base ${base} is older than the retained history`);
    const later = sb.hist.filter(b => b.ver > base);
    let applied;
    try {
      /* The ops are checked against the text the client saw (R7.7, R7.8); a rebase alone would silently
         take the deleted text from the current buffer. */
      OT.check(later.length ? OT.textBefore(sb.ed.rope.toString(), later) : sb.ed.rope, ops);
      const op = later.length ? OT.rebase(ops, this.lenAt(sb, base), later) : OT.fromOps(ops, sb.ed.rope.length);
      applied = OT.toOps(op, sb.ed.rope);
    } catch (e) { throw new ProtoError('bad_edit', e.message); }
    return applied;
  }

  /* Check and apply OPS (already against the current text) to SB as one sequenced batch by BY.
     Returns the history entry. Throws ProtoError bad_edit with nothing applied (every op is checked
     against a string copy before the rope changes). */
  applyBatch(sb, ops, by, { cid = null, seq = null, undo = null } = {}) {
    const Ed = this.Ed;
    /* A thread holding SB (R4.41) has its pending edits sequenced first, so the history stays in rope order. */
    if (sb.hold && this.flushHold) this.flushHold(sb);
    const text = sb.ed.rope.toString();
    try { OT.apply(text, ops); } catch (e) { throw new ProtoError('bad_edit', e.message); }
    const len = sb.ed.rope.length;
    Ed.withOrigin(originOf(by), () => {
      const save = Ed.E.inhibitRO; Ed.E.inhibitRO = true;
      try { for (const [pos, del, ins] of ops) Ed.editText(sb.ed, pos, del.length, ins); }
      finally { Ed.E.inhibitRO = save; }
    });
    sb.ver++;
    const entry = { ver: sb.ver, cid, seq, by, ops, undo: undo || undefined, at: Date.now(), len, bytes: JSON.stringify(ops).length };
    /* The clients attached now get this batch as edits once it is journaled; one that opens in between gets
       it from the replay instead (open{since} reads the history), so nobody sees it twice. */
    entry.recipients = [...sb.clients];
    sb.hist.push(entry); sb.histBytes += entry.bytes;
    if (cid !== null && seq !== null) { let m = sb.seqIndex.get(cid); if (!m) { m = new Map(); sb.seqIndex.set(cid, m); } m.set(seq, sb.ver); }
    this.trim(sb);
    sb.touched();
    return entry;
  }

  /* Record OPS, already applied to SB's rope by a thread (R4.41), as one sequenced batch by BY: the history
     entry, with the text length before the batch computed from the ops. Returns the entry. */
  recordApplied(sb, ops, by) {
    /* The thread's edits, one log entry each, in normal form: adjacent inserts merge, an insert next to a
       delete goes first (OT.fromOps), so the batch is as small as a client's. */
    const after = sb.ed.rope.toString();
    const before = OT.apply(after, OT.invert(ops));
    ops = OT.toOps(OT.fromOps(ops, before.length), before);
    const len = before.length;
    sb.ver++;
    const entry = { ver: sb.ver, cid: by.cid || null, seq: null, by, ops, undo: undefined, at: Date.now(), len, bytes: JSON.stringify(ops).length };
    entry.recipients = [...sb.clients];
    sb.hist.push(entry); sb.histBytes += entry.bytes;
    this.trim(sb);
    sb.touched();
    return entry;
  }
  /* Client edits wait while a thread holds SB; drainHeld lets them go on, in arrival order. */
  async waitHeld(sb) { while (sb.hold) await new Promise(r => { (sb.heldQueue || (sb.heldQueue = [])).push(r); }); }
  drainHeld(sb) { const q = sb.heldQueue; if (!q) return; sb.heldQueue = null; for (const r of q) r(); }

  /* Drop history past the retention rule (R7.17). */
  trim(sb) {
    const now = Date.now();
    while (sb.hist.length && (sb.histBytes > HIST_MAX_BYTES || (sb.hist.length > HIST_MIN_BATCHES && now - sb.hist[0].at > HIST_MIN_MS))) {
      const b = sb.hist.shift(); sb.histBytes -= b.bytes;
      if (b.cid !== null) { const m = sb.seqIndex.get(b.cid); if (m) { m.delete(b.seq); if (!m.size) sb.seqIndex.delete(b.cid); } }
    }
  }

  hashIf(sb) { return sb.ver % HASH_EVERY === 0 ? OT.hash(sb.ed.rope) : undefined; }

  /* One `edit` from CLIENT (R7.11, R7.15). Resolves after the ack is queued. */
  async edit(client, sb, msg) {
    const { base, seq, ops, undo } = msg;
    const known = sb.seqIndex.get(client.cid);
    if (known && known.has(seq)) { // a resend: the original ack, once the batch is on disk (R7.15, R8.3)
      const ver = known.get(seq);
      const entry = sb.hist.find(b => b.ver === ver);
      if (entry && entry.pending) { try { await entry.pending; } catch (e) { /* reported below */ } }
      if (!sb.seqIndex.get(client.cid) || !sb.seqIndex.get(client.cid).has(seq)) throw new ProtoError('read_only', typeof sb.readOnly === 'string' ? sb.readOnly : 'the batch was not journaled', { buf: sb.id, seq });
      client.send({ t: 'ack', buf: sb.id, seq, ver });
      return;
    }
    if (sb.readOnly) throw new ProtoError('read_only', typeof sb.readOnly === 'string' ? sb.readOnly : 'the buffer is read-only', { buf: sb.id, seq });
    if (sb.hold) await this.waitHeld(sb);
    const applied = this.rebase(sb, ops, base);
    const entry = this.applyBatch(sb, applied, client.by(), { cid: client.cid, seq, undo });
    await this.commit(sb, entry, client);
  }

  /* Undo ENTRY, the newest batch of SB, in place: the inverse ops applied as the server, the history entry and
     its (cid, seq) forgotten, the version stepped back. Nothing has been sent about it yet. */
  rollback(sb, entry) {
    const Ed = this.Ed;
    if (sb.hist[sb.hist.length - 1] !== entry) throw new Error('rollback of a batch that is not the newest');
    Ed.withOrigin('server', () => {
      const save = Ed.E.inhibitRO; Ed.E.inhibitRO = true;
      try { for (const [pos, del, ins] of OT.invert(entry.ops)) Ed.editText(sb.ed, pos, del.length, ins); }
      finally { Ed.E.inhibitRO = save; }
    });
    sb.hist.pop(); sb.histBytes -= entry.bytes; sb.ver--;
    if (entry.cid !== null && entry.seq !== null) { const m = sb.seqIndex.get(entry.cid); if (m) { m.delete(entry.seq); if (!m.size) sb.seqIndex.delete(entry.cid); } }
    sb.touched();
  }

  /* Roll back ENTRY and every newer batch of SB, newest first. The batches of one failed group commit reject
     in order, so the first continuation undoes the whole group and the later ones find theirs gone (false).
     Any batch newer than a failed one is unjournaled too: the journal refuses appends after a failure. */
  rollbackThrough(sb, entry) {
    if (!sb.hist.includes(entry)) return false;
    for (;;) { const last = sb.hist[sb.hist.length - 1]; this.rollback(sb, last); if (last === entry) return true; }
  }

  /* Journal ENTRY, wait for the sync, then ack SENDER (if any) and send edits to the others. */
  async commit(sb, entry, sender) {
    const h = this.hashIf(sb);
    const recipients = entry.recipients; delete entry.recipients;
    if (sb.journal) {
      try { entry.pending = sb.journal.append({ t: 'b', ver: entry.ver, cid: entry.cid, seq: entry.seq, by: entry.by, ops: entry.ops, undo: entry.undo, at: entry.at }); await entry.pending; delete entry.pending; }
      catch (e) {
        delete entry.pending;
        /* The line did not reach the disk (ENOSPC): the batch is rolled back, so nothing is applied that a
           restart would lose and a resend is applied afresh; the buffer goes read-only with the reason until
           a save or restart (R16.7). */
        this.log.error('journal', { buf: sb.id, error: e.code || e.message });
        this.rollbackThrough(sb, entry);
        sb.setReadOnly(`journal write failed: ${e.code || e.message}`);
        throw new ProtoError('read_only', `journal write failed: ${e.code || e.message}`, { buf: sb.id, seq: entry.seq });
      }
      if (sb.journal.needsCompaction()) sb.owner.compactSoon(sb);
    }
    if (sender) sender.send(h === undefined ? { t: 'ack', buf: sb.id, seq: entry.seq, ver: entry.ver } : { t: 'ack', buf: sb.id, seq: entry.seq, ver: entry.ver, h });
    const edits = { t: 'edits', buf: sb.id, ver: entry.ver, ops: entry.ops, by: entry.by };
    if (h !== undefined) edits.h = h;
    for (const c of recipients) if (c !== sender) c.sendBulkish(edits);
    sb.owner.afterBatch(sb, entry);
  }

  /* Replay for open{since}: own batches as ack, others as edits (R7.16). */
  replay(client, sb, since) {
    for (const b of sb.hist) {
      if (b.ver <= since) continue;
      const h = b.ver % HASH_EVERY === 0 && b.ver === sb.ver ? OT.hash(sb.ed.rope) : undefined;
      if (b.cid === client.cid) client.send(h === undefined ? { t: 'ack', buf: sb.id, seq: b.seq, ver: b.ver } : { t: 'ack', buf: sb.id, seq: b.seq, ver: b.ver, h });
      else client.sendBulkish(h === undefined ? { t: 'edits', buf: sb.id, ver: b.ver, ops: b.ops, by: b.by } : { t: 'edits', buf: sb.id, ver: b.ver, ops: b.ops, by: b.by, h });
    }
  }

  /* The ops that undo GROUP ({cid, g}) of SB through its retained history (R6.19): {ops, partial}, or
     null when the group is not in the retained history. */
  undoOps(sb, group) {
    const first = sb.hist.findIndex(b => b.cid === group.cid && b.undo && b.undo.g === group.g);
    if (first < 0) return null;
    const history = sb.hist.slice(first).map(b => ({ ver: b.ver, ops: b.ops, cid: b.cid, undo: b.undo || { g: 'v' + b.ver } }));
    const r = OT.undoOps(group, history, sb.ed.rope.toString());
    return { ops: OT.toOps(r.op, sb.ed.rope), partial: r.partial };
  }
}
