// Buffer journals, snapshots and the index (spec §8.1–§8.2); the image log is in image.mts.
//
// A journal is one JSON object per line: a header, then a batch per sequenced edit. A batch is
// acknowledged only after its line is written and fdatasync has returned; batches that arrive within
// 2 ms share one sync (R8.3). Replay drops a torn last line and reports any other failure (R8.4).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic, sha256 } from './files.mts';

export const FORMAT = 1;
export const GROUP_COMMIT_MS = 2;
export const COMPACT_BYTES = 4 * 1024 * 1024;
export const COMPACT_LINES = 20000;

export class JournalError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

/* One buffer's journal file, appended to with group commit. */
export class Journal {
  constructor(file) { this.file = file; this.fd = null; this.pending = []; this.timer = null; this.lines = 0; this.bytes = 0; this.syncing = null; this.closed = false; }
  open() {
    if (this.fd === null) {
      this.fd = fs.openSync(this.file, 'a', 0o600);
      try { this.bytes = fs.fstatSync(this.fd).size; } catch (e) { this.bytes = 0; }
    }
    return this;
  }
  /* Write the header and the given batch lines fresh (a new journal, or a compaction's rewrite). */
  static create(file, header, batches) {
    const lines = [JSON.stringify(header), ...batches.map(b => JSON.stringify(b))].join('\n') + '\n';
    writeAtomic(file, lines);
    const j = new Journal(file).open();
    j.lines = 1 + batches.length;
    return j;
  }
  /* Append OBJ as a line; resolves once it is on disk (fdatasync). Rejects on a write error (ENOSPC), in
     which case nothing of the line counts as written: the caller drops the batch. */
  append(obj) {
    this.open();
    if (this.failed) return Promise.reject(this.failed);
    const line = JSON.stringify(obj) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.push({ line, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => this.flush(), GROUP_COMMIT_MS);
    });
  }
  /* Write every pending line, one fdatasync for all of them. */
  flush() {
    this.timer = null;
    const batch = this.pending; this.pending = [];
    if (!batch.length) return Promise.resolve();
    const run = async () => {
      let failed = null, start = null;
      try {
        const data = Buffer.from(batch.map(b => b.line).join(''), 'utf8');
        start = fs.fstatSync(this.fd).size;
        /* Test hooks (R16.7): EDWIND_FAULT=enospc-journal fails every append as a full disk does;
           enospc-journal-partial writes the lines and then fails, as a failing fdatasync does. */
        const fault = process.env.EDWIND_FAULT;
        if (fault === 'enospc-journal') throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        let off = 0;
        while (off < data.length) off += fs.writeSync(this.fd, data, off, data.length - off);
        if (fault === 'enospc-journal-partial') throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        fs.fdatasyncSync(this.fd);
        this.lines += batch.length; this.bytes += data.length;
      } catch (e) {
        failed = e;
        /* Whatever of the group reached the file is taken back, so a restart never replays a batch that was
           refused; from here on every append fails until a save makes a new journal. */
        if (start !== null) { try { fs.ftruncateSync(this.fd, start); fs.fdatasyncSync(this.fd); } catch (e2) { /* the disk is in trouble */ } }
        this.failed = e;
      }
      for (const b of batch) failed ? b.reject(failed) : b.resolve();
    };
    this.syncing = run();
    return this.syncing;
  }
  /* Flush now and wait (shutdown). */
  async drain() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } await this.flush(); }
  close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* closed */ } this.fd = null; } this.closed = true; }
  needsCompaction() { return this.bytes > COMPACT_BYTES || this.lines > COMPACT_LINES; }
}

/* Read a journal: {header, batches, mv, anchors, torn}. `anchors` is the last anchors line ({t: 'a', ver, anchors},
   anchors.mts) or null. A torn last line (no newline, or not JSON) is dropped and reported; any other bad line is
   a JournalError (the buffer then opens read-only, R8.4). */
export function readJournal(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  /* The last line ends with a newline when the file is whole; without one it is the tail of a write that
     did not finish and is dropped (R8.4). A complete JSON object without its newline is kept. */
  let torn = false;
  const last = lines.pop();
  if (last !== '') { try { JSON.parse(last); lines.push(last); } catch (e) { torn = true; } }
  const parse = (l, i) => { try { return JSON.parse(l); } catch (e) { throw new JournalError(`line ${i + 1} is not JSON`, i + 1); } };
  if (!lines.length) throw new JournalError('empty journal', 0);
  const header = parse(lines[0], 0);
  if (header.t !== 'hdr' || !header.jid || !header.base || !Number.isInteger(header.base.ver)) throw new JournalError('bad header', 1);
  if (header.format !== undefined && header.format > FORMAT) throw new JournalError(`journal format ${header.format} is newer than this edwind (${FORMAT})`, 1);
  const batches = [], mv = [];
  let anchors = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const o = parse(lines[i], i);
    if (o.t === 'b') {
      if (!Number.isInteger(o.ver) || !Array.isArray(o.ops)) throw new JournalError(`line ${i + 1}: bad batch`, i + 1);
      batches.push(o);
    } else if (o.t === 'mv') mv.push(o);
    else if (o.t === 'a') anchors = o;
    /* Unknown line kinds are skipped: a newer edwind may add some (R15.15 covers the format version). */
  }
  return { header, batches, mv, anchors, torn };
}

/* The header line of R8.1. */
export const header = ({ jid, id, name, file, mode, baseVer, baseText }) => ({ t: 'hdr', format: FORMAT, jid, id, name, file, mode, base: { ver: baseVer, sha256: sha256(baseText) } });

/* ---------- the index (R8.1) ---------- */
/* The buffers by jid, and the moved records of renames (R6.1, §7: old id → {to, at, dir}). The moved records live
   here rather than in the journals so they outlive a kill of the buffer and a restart; the caller prunes them. */
export class Index {
  constructor(file) { this.file = file; this.buffers = new Map(); this.moved = new Map(); this.timer = null; this.load(); }
  load() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (o.format !== undefined && o.format > FORMAT) throw new Error(`index format ${o.format} is newer than this edwind (${FORMAT})`);
      for (const b of o.buffers || []) this.buffers.set(b.jid, b);
      for (const m of o.moved || []) if (m && typeof m.from === 'string' && typeof m.to === 'string' && Number.isFinite(m.at)) this.moved.set(m.from, { to: m.to, at: m.at, dir: !!m.dir });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  set(entry) { this.buffers.set(entry.jid, entry); this.schedule(); }
  delete(jid) { this.buffers.delete(jid); this.schedule(); }
  schedule() { if (!this.timer) this.timer = setTimeout(() => this.write(), 50); }
  write() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const moved = [...this.moved].map(([from, m]) => ({ from, to: m.to, at: m.at, ...(m.dir ? { dir: true } : {}) }));
    writeAtomic(this.file, JSON.stringify({ format: FORMAT, buffers: [...this.buffers.values()], ...(moved.length ? { moved } : {}) }, null, 1) + '\n');
  }
}

/* The image log lives in image.mts (E2); the name stays importable from here. */
export { ImageLog } from './image.mts';

/* A random id: 96 bits (12 bytes) for a jid (R6.1). */
export const randomId = (bytes = 12) => randomBytes(bytes).toString('hex');
export const jidPath = (dir, jid, ext) => path.join(dir, 'buffers', jid + ext);
