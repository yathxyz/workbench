// Buffer journals, snapshots, the index and the image log (spec §8.1–§8.2, R4.15 log only).
//
// A journal is one JSON object per line: a header, then a batch per sequenced edit. A batch is
// acknowledged only after its line is written and fdatasync has returned; batches that arrive within
// 2 ms share one sync (R8.3). Replay drops a torn last line and reports any other failure (R8.4).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic, sha256 } from './files.mjs';

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
      let failed = null;
      try {
        const data = Buffer.from(batch.map(b => b.line).join(''), 'utf8');
        let off = 0;
        while (off < data.length) off += fs.writeSync(this.fd, data, off, data.length - off);
        fs.fdatasyncSync(this.fd);
        this.lines += batch.length; this.bytes += data.length;
      } catch (e) { failed = e; }
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

/* Read a journal: {header, batches, mv, torn}. A torn last line (no newline, or not JSON) is dropped and
   reported; any other bad line is a JournalError (the buffer then opens read-only, R8.4). */
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
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const o = parse(lines[i], i);
    if (o.t === 'b') {
      if (!Number.isInteger(o.ver) || !Array.isArray(o.ops)) throw new JournalError(`line ${i + 1}: bad batch`, i + 1);
      batches.push(o);
    } else if (o.t === 'mv') mv.push(o);
    /* Unknown line kinds are skipped: a newer edwind may add some (R15.15 covers the format version). */
  }
  return { header, batches, mv, torn };
}

/* The header line of R8.1. */
export const header = ({ jid, id, name, file, mode, baseVer, baseText }) => ({ t: 'hdr', format: FORMAT, jid, id, name, file, mode, base: { ver: baseVer, sha256: sha256(baseText) } });

/* ---------- the index (R8.1) ---------- */
export class Index {
  constructor(file) { this.file = file; this.buffers = new Map(); this.timer = null; this.load(); }
  load() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (o.format !== undefined && o.format > FORMAT) throw new Error(`index format ${o.format} is newer than this edwind (${FORMAT})`);
      for (const b of o.buffers || []) this.buffers.set(b.jid, b);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  set(entry) { this.buffers.set(entry.jid, entry); this.schedule(); }
  delete(jid) { this.buffers.delete(jid); this.schedule(); }
  schedule() { if (!this.timer) this.timer = setTimeout(() => this.write(), 50); }
  write() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    writeAtomic(this.file, JSON.stringify({ format: FORMAT, buffers: [...this.buffers.values()] }, null, 1) + '\n');
  }
}

/* ---------- the image log (R4.15, log only in E1) ---------- */
export class ImageLog {
  constructor(file) { this.file = file; this.gen = 0; this.entries = []; this.epoch = null; this.load(); }
  load() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; } // a torn last line
      if (o.t === 'epoch') { this.epoch = o.epoch; continue; }
      if (o.t === 'form' && Number.isInteger(o.gen)) { this.entries.push(o); this.gen = o.gen; }
    }
  }
  /* The epoch changes only when the image is reset or compacted (R4.20); a fresh log gets one. */
  ensureEpoch(make) {
    if (this.epoch) return this.epoch;
    this.epoch = make();
    fs.appendFileSync(this.file, JSON.stringify({ t: 'epoch', epoch: this.epoch, at: Date.now() }) + '\n', { mode: 0o600 });
    return this.epoch;
  }
  /* Append a definitional form; returns its generation. */
  append(form, by) {
    const entry = { t: 'form', gen: this.gen + 1, form, by, at: Date.now() };
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
    this.entries.push(entry); this.gen = entry.gen;
    return entry.gen;
  }
  after(gen) { return this.entries.filter(e => e.gen > gen); }
}

/* A random id: 96 bits (12 bytes) for a jid (R6.1). */
export const randomId = (bytes = 12) => randomBytes(bytes).toString('hex');
export const jidPath = (dir, jid, ext) => path.join(dir, 'buffers', jid + ext);
