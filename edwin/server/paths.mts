// File authority and buffer ids (spec R6.1, R14.8): the one module every file primitive of edwind goes
// through. Reads are allowed anywhere but the refusal list; writes only inside the write roots and never
// in the refusal list. Checks run on real paths: the parent directory resolved through the kernel, and
// the last component looked at with lstat so a symlink there is seen, never the string the client sent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* The codes a PathError carries; each is an error code of the protocol (§7.8). */
export type PathErrorCode = 'no_buffer' | 'refused_path' | 'bad_id';

export class PathError extends Error {
  declare code: PathErrorCode;
  constructor(code: PathErrorCode, msg: string) { super(msg); this.code = code; }
}

const HOME = process.env.HOME || os.homedir();
/* Expand a leading ~ to the service user's home. */
export const expandHome = (p: string): string => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
export const home = (): string => HOME;

/* True when P equals ROOT or lies under it (both absolute, normalised). */
export const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

/* The real path of P: its parent resolved by the kernel, the last component resolved if it exists and
   is a symlink (a symlink and its target name one buffer, R6.1). A missing parent is an error. */
/* A real path: REAL, whether it exists, whether the last component was a symlink, and its lstat when known. */
export interface RealPath { real: string; exists: boolean; symlink: boolean; stat?: fs.Stats | null }
export function realPath(p: string): RealPath {
  const abs = path.resolve(expandHome(p));
  const parent = path.dirname(abs), base = path.basename(abs);
  let realParent: string;
  try { realParent = fs.realpathSync.native(parent); } catch (e) { throw new PathError(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'no_buffer' : 'refused_path', `${parent}: ${e.code}`); }
  const full = path.join(realParent, base);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw new PathError('refused_path', `${full}: ${e.code}`); }
  if (st && st.isSymbolicLink()) {
    try { return { real: fs.realpathSync.native(full), exists: true, symlink: true }; }
    catch (e) { return { real: full, exists: false, symlink: true }; }
  }
  return { real: full, exists: !!st, symlink: false, stat: st };
}

/* The authority: constructed once from edit.json. */
/* What the authority takes of edit.json. */
export interface AuthorityConfig { notesDir: string; stateDir: string; configDir: string; writablePaths?: string[]; refusePaths?: string[] }
/* A parsed buffer id (R6.1). */
export type ParsedId = { kind: 'name'; name: string } | { kind: 'file'; real: string; exists: boolean; stat?: fs.Stats | null };

export class Authority {
  declare notesDir: string;
  declare stateDir: string;
  declare configDir: string;
  declare writeRoots: string[];
  declare refuse: string[];
  declare realWriteRoots: string[];
  declare realRefuse: string[];
  constructor({ notesDir, stateDir, configDir, writablePaths = [], refusePaths = [] }: AuthorityConfig) {
    const norm = (p: string) => path.resolve(expandHome(p));
    this.notesDir = norm(notesDir); this.stateDir = norm(stateDir); this.configDir = norm(configDir);
    this.writeRoots = [...new Set([...writablePaths.map(norm), this.notesDir, this.stateDir, this.configDir])];
    this.refuse = refusePaths.map(norm);
    /* The roots as the kernel sees them, so a root reached through a symlinked parent still counts. */
    this.realWriteRoots = this.writeRoots.map(r => { try { return fs.realpathSync.native(r); } catch (e) { return r; } });
    this.realRefuse = this.refuse.map(r => { try { return fs.realpathSync.native(r); } catch (e) { return r; } });
  }
  /* Nothing in, on or above a refused path (the rule of POST /api/mv). */
  refused(real: string): boolean { return this.realRefuse.some(r => under(real, r) || under(r, real)) || this.refuse.some(r => under(real, r) || under(r, real)); }
  /* A read of REAL: anywhere but the refusal list. Throws PathError refused_path. */
  checkRead(real: string): string { if (this.refused(real)) throw new PathError('refused_path', `${real}: refused`); return real; }
  /* A write of REAL (save, create, rename, delete). Throws PathError refused_path. */
  checkWrite(real: string): string {
    if (this.refused(real)) throw new PathError('refused_path', `${real}: refused`);
    if (!this.realWriteRoots.some(r => under(real, r)) && !this.writeRoots.some(r => under(real, r))) throw new PathError('refused_path', `${real}: outside the writable paths`);
    return real;
  }
  /* The write roots for the Node permission flags (R14.12). */
  writeRootsForFlags(): string[] { return [...new Set([...this.writeRoots, ...this.realWriteRoots])]; }

  /* ---------- buffer ids (R6.1) ---------- */

  /* Parse an id: {kind: 'name', name} or {kind: 'file', real, exists}. Throws PathError bad_id. */
  parseId(id: unknown): ParsedId {
    if (typeof id !== 'string' || !id) throw new PathError('bad_id', 'buffer id must be a non-empty string');
    if (id.startsWith('name:')) { const name = id.slice(5); if (!name) throw new PathError('bad_id', 'empty buffer name'); return { kind: 'name', name }; }
    if (id.includes('\0')) throw new PathError('bad_id', 'buffer id contains NUL');
    let p: string;
    if (id.startsWith('/')) p = id;
    else if (id === '~' || id.startsWith('~/')) p = expandHome(id);
    else {
      /* notesDir-relative: no empty segment, no . or .. segments. */
      const segs = id.split('/');
      if (segs.some(s => s === '' || s === '.' || s === '..')) throw new PathError('bad_id', `bad relative id ${JSON.stringify(id)}`);
      p = path.join(this.notesDir, id);
    }
    const segs = p.split('/');
    if (segs.some(s => s === '..' || s === '.')) throw new PathError('bad_id', `bad id ${JSON.stringify(id)}`);
    const r = realPath(p);
    if (!id.startsWith('/') && !id.startsWith('~') && !under(r.real, this.realNotesDir())) throw new PathError('bad_id', `${JSON.stringify(id)} escapes the notes directory`);
    return { kind: 'file', real: r.real, exists: r.exists, stat: r.stat };
  }
  realNotesDir(): string { try { return fs.realpathSync.native(this.notesDir); } catch (e) { return this.notesDir; } }
  /* The id of a real file path: notesDir-relative, ~/…, or absolute. */
  idOf(real: string): string {
    const nd = this.realNotesDir();
    if (under(real, nd) && real !== nd) return real.slice(nd.length + 1);
    const h = (() => { try { return fs.realpathSync.native(HOME); } catch (e) { return HOME; } })();
    if (under(real, h) && real !== h) return '~/' + real.slice(h.length + 1);
    return real;
  }
}
