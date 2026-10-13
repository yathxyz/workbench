// Files (spec §8.3): UTF-8 reads with CRLF detection and the 32 MiB limit, atomic saves, hashes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const BIG = 32 * 1024 * 1024;

export class FileError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });

/* Read a text file: {text, eol, big, stat}. text has \n inside (R8.10). Not UTF-8 → FileError not_text.
   Over 32 MiB → big: true, read anyway (the buffer opens read-only, R6.24). Missing → FileError no_buffer. */
export function readText(real) {
  let bytes, stat;
  try { stat = fs.statSync(real); bytes = fs.readFileSync(real); }
  catch (e) { throw new FileError(e.code === 'ENOENT' ? 'no_buffer' : 'refused_path', `${real}: ${e.code}`); }
  let text;
  try { text = decoder.decode(bytes); } catch (e) { throw new FileError('not_text', `${real}: not UTF-8 text`); }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let eol = 'lf';
  if (text.includes('\r\n')) { eol = 'crlf'; text = text.replace(/\r\n/g, '\n'); }
  return { text, eol, big: bytes.length > BIG, stat, bytes: bytes.length };
}

/* The disk form of TEXT for EOL and the trailing newline policy. */
export function encodeText(text, eol, trailingNewline) {
  let t = text;
  if (trailingNewline && t.length && !t.endsWith('\n')) t += '\n';
  if (eol === 'crlf') t = t.replace(/\n/g, '\r\n');
  return t;
}

/* Write TEXT to REAL atomically (R8.7): temp file in the same directory, fsync, mode bits of the existing
   file (new files 0600), rename, fsync of the directory. Returns the bytes written and their hash (of the
   text as the buffer holds it). Throws the fs error (ENOSPC among them) with nothing half-written. */
export function saveAtomic(real, text, { eol = 'lf' } = {}) {
  const dir = path.dirname(real);
  let existing = null;
  try { existing = fs.statSync(real); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let trailing = true;
  if (existing && existing.size) {
    /* The trailing newline policy follows the file: no newline at the end stays that way. */
    const fd = fs.openSync(real, 'r');
    try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, existing.size - 1); trailing = b[0] === 10; } finally { fs.closeSync(fd); }
  }
  const data = encodeText(text, eol, trailing);
  const tmp = path.join(dir, `.${path.basename(real)}.edwind-${process.pid}-${randomBytes(4).toString('hex')}~`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    let off = 0;
    const buf = Buffer.from(data, 'utf8');
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    if (existing) fs.fchmodSync(fd, existing.mode & 0o7777);
  } catch (e) {
    try { fs.closeSync(fd); } catch (x) { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch (x) { /* nothing to remove */ }
    throw e;
  }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, real); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } throw e; }
  fsyncDir(dir);
  const stat = fs.statSync(real);
  return { bytes: Buffer.byteLength(data), stat, hash: sha256(text), trailing };
}

export function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); } catch (e) { return; }
  try { fs.fsyncSync(fd); } catch (e) { /* some filesystems refuse; the rename is still durable enough */ } finally { fs.closeSync(fd); }
}

/* Write a whole file atomically with mode 0600 (state files: index, snapshots, saved copies). */
export function writeAtomic(real, data) {
  const dir = path.dirname(real);
  const tmp = path.join(dir, `.${path.basename(real)}.${process.pid}-${randomBytes(4).toString('hex')}~`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } catch (e) { try { fs.closeSync(fd); } catch (x) { /* closed */ } try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } throw e; }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, real); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } throw e; }
  fsyncDir(dir);
}

/* The disk state edwind remembers per file (R8.15, the stat sweep). */
export const diskState = stat => (stat ? { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino } : null);
export const sameDisk = (a, b) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
