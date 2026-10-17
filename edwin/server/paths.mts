// File authority and buffer ids (spec R6.1, R14.8): the one module every file primitive of edwind goes
// through. Reads are allowed anywhere but the refusal list; writes only inside the write roots and never
// in the refusal list. Checks run on real paths: the parent directory resolved through the kernel, and
// the last component looked at with lstat so a symlink there is seen, never the string the client sent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class PathError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

const HOME = process.env.HOME || os.homedir();
/* Expand a leading ~ to the service user's home. */
export const expandHome = p => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
export const home = () => HOME;

/* True when P equals ROOT or lies under it (both absolute, normalised). */
export const under = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

/* The real path of P: its parent resolved by the kernel, the last component resolved if it exists and
   is a symlink (a symlink and its target name one buffer, R6.1). A missing parent is an error. */
export function realPath(p) {
  const abs = path.resolve(expandHome(p));
  const parent = path.dirname(abs), base = path.basename(abs);
  let realParent;
  try { realParent = fs.realpathSync.native(parent); } catch (e) { throw new PathError(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'no_buffer' : 'refused_path', `${parent}: ${e.code}`); }
  const full = path.join(realParent, base);
  let st = null;
  try { st = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw new PathError('refused_path', `${full}: ${e.code}`); }
  if (st && st.isSymbolicLink()) {
    try { return { real: fs.realpathSync.native(full), exists: true, symlink: true }; }
    catch (e) { return { real: full, exists: false, symlink: true }; }
  }
  return { real: full, exists: !!st, symlink: false, stat: st };
}

/* The authority: constructed once from edit.json. */
export class Authority {
  constructor({ notesDir, stateDir, configDir, writablePaths = [], refusePaths = [] }) {
    const norm = p => path.resolve(expandHome(p));
    this.notesDir = norm(notesDir); this.stateDir = norm(stateDir); this.configDir = norm(configDir);
    this.writeRoots = [...new Set([...writablePaths.map(norm), this.notesDir, this.stateDir, this.configDir])];
    this.refuse = refusePaths.map(norm);
    /* The roots as the kernel sees them, so a root reached through a symlinked parent still counts. */
    this.realWriteRoots = this.writeRoots.map(r => { try { return fs.realpathSync.native(r); } catch (e) { return r; } });
    this.realRefuse = this.refuse.map(r => { try { return fs.realpathSync.native(r); } catch (e) { return r; } });
  }
  /* Nothing in, on or above a refused path (the rule of POST /api/mv). */
  refused(real) { return this.realRefuse.some(r => under(real, r) || under(r, real)) || this.refuse.some(r => under(real, r) || under(r, real)); }
  /* A read of REAL: anywhere but the refusal list. Throws PathError refused_path. */
  checkRead(real) { if (this.refused(real)) throw new PathError('refused_path', `${real}: refused`); return real; }
  /* A write of REAL (save, create, rename, delete). Throws PathError refused_path. */
  checkWrite(real) {
    if (this.refused(real)) throw new PathError('refused_path', `${real}: refused`);
    if (!this.realWriteRoots.some(r => under(real, r)) && !this.writeRoots.some(r => under(real, r))) throw new PathError('refused_path', `${real}: outside the writable paths`);
    return real;
  }
  /* The write roots for the Node permission flags (R14.12). */
  writeRootsForFlags() { return [...new Set([...this.writeRoots, ...this.realWriteRoots])]; }

  /* ---------- buffer ids (R6.1) ---------- */

  /* Parse an id: {kind: 'name', name} or {kind: 'file', real, exists}. Throws PathError bad_id. */
  parseId(id) {
    if (typeof id !== 'string' || !id) throw new PathError('bad_id', 'buffer id must be a non-empty string');
    if (id.startsWith('name:')) { const name = id.slice(5); if (!name) throw new PathError('bad_id', 'empty buffer name'); return { kind: 'name', name }; }
    if (id.includes('\0')) throw new PathError('bad_id', 'buffer id contains NUL');
    let p;
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
  realNotesDir() { try { return fs.realpathSync.native(this.notesDir); } catch (e) { return this.notesDir; } }
  /* The id of a real file path: notesDir-relative, ~/…, or absolute. */
  idOf(real) {
    const nd = this.realNotesDir();
    if (under(real, nd) && real !== nd) return real.slice(nd.length + 1);
    const h = (() => { try { return fs.realpathSync.native(HOME); } catch (e) { return HOME; } })();
    if (under(real, h) && real !== h) return '~/' + real.slice(h.length + 1);
    return real;
  }
}
