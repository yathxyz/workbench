// Server buffers (spec §6.1–§6.2, §6.5, §8): the registry of shared buffers by id and jid, their load from
// files and journals, snapshots to clients, saves, reverts, renames, disk changes, kills, the index and the
// server side of undo. Every text change goes through the sequencer, so Edwin's markers and hooks
// follow it and every batch is journaled before anyone is told.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProtoError, CHUNK } from './proto.mts';
import { PathError, expandHome, under } from './paths.mts';
import { readText, saveAtomic, writeAtomic, fsyncDir, sha256, diskState, FileError, BIG } from './files.mts';
import { Journal, readJournal, header as journalHeader, Index, randomId, jidPath, SNAP_NEW } from './journal.mts';
import { Sequencer } from './sequencer.mts';
import { Watcher, diffOps, merge3 } from './watch.mts';
import { restore as restoreAnchors, record as anchorsRecord, publicAnchors } from './anchors.mts';
import { ensureNoteDir } from './notes.mts';
import type { Ed as Edwin, EdBuffer, Lisp, Log, SchemeValue } from './main.mts';
import type { Authority, ParsedId } from './paths.mts';
import type { Client } from './session.mts';
import type { Hold } from './threads.mts';
import type { By, Meta, Op, Undo } from './proto.mts';
import type { DiskState, Eol, TextFile } from './files.mts';
import type { IndexEntry, MovedRecord } from './journal.mts';
import type { Anchor } from './anchors.mts';

const require = createRequire(import.meta.url);
const OT = require('../src/ot.js');

export const AUTOSAVE_MS = 2000;
export const MOVED_TTL_MS = 24 * 3600 * 1000;
export const UNLOAD_AFTER_MS = 7 * 24 * 3600 * 1000;
const DISK_BY: By = { kind: 'disk' };
/* Test hook (R16.5): EDWIND_FAULT=kill-compact-snap or kill-compact-journal kills edwind between the steps of a compaction. */
const crashPoint = (name: string): void => { if (process.env.EDWIND_FAULT === name) process.kill(process.pid, 'SIGKILL'); };
/* The new snapshot of a compaction becomes the snapshot (an atomic rename). A failure is logged: SNAP_NEW still
   matches the journal, and the next reload tries it. */
function promoteSnap(next: string, snap: string, log: Log, buf: string): void {
  try { fs.renameSync(next, snap); fsyncDir(path.dirname(snap)); }
  catch (e) { log.error('compact', { buf, snapshot: e.code || e.message }); }
}
const SERVER_BY: By = { kind: 'server' };
/* The refusal of a destination in, on or above a refused path: the words of wb-web's POST /api/mv (fsapi.rs), which
   forwards its moves here. */
export const REFUSED_DST = 'refused: the destination is in or above ~/.ssh or a systemd user-unit directory';
/* An fs error as the message of a refusal: its code and text, without the paths Node appends. */
const osMessage = (e: NodeJS.ErrnoException): string => (e && e.code ? String(e.message).replace(/, \w+ '.*$/, '') : String(e && e.message || e));

/* An undo tag (R6.19): the group, and for an undo batch the group it undoes (of) and that group's writer (ofCid). */
export interface UndoTag extends Undo { ofCid?: string | null }
/* One sequenced batch in sb.hist (sequencer.mts); anchorsBefore, recipients and pending live until it is committed. */
export interface HistEntry {
  ver: number; cid: string | null; seq: number | null; by: By; ops: Op[]; undo?: UndoTag; at: number; len: number; bytes: number;
  anchorsBefore?: Anchor[]; recipients?: Client[]; pending?: Promise<void>;
}
/* What the file on disk did that edwind has not taken in (R8.13, R8.15). */
export type DiskChange = 'conflict' | 'deleted' | null;
/* A server-edit waiting on the buffer (§13.1): each waiter gets the exit code. */
export interface ServerEdit { waiters: ((exit: number) => void)[]; saved: boolean; line: number | null }
/* The result of resolve() for an id whose file was renamed. */
export interface Moved { moved: string }
export interface SBufInit { id: string; jid: string; name: string; file: string | null; ed: EdBuffer }

/* One shared buffer as edwind keeps it (§6.2). */
export class SBuf {
  declare owner: Buffers; declare id: string; declare jid: string; declare name: string; declare file: string | null; declare ed: EdBuffer;
  declare ver: number; declare hist: HistEntry[]; declare histBytes: number; declare seqIndex: Map<string, Map<number, number>>;
  declare savedText: string; declare savedHash: string | null; declare savedVer: number;
  declare eol: Eol; declare readOnly: string | false; declare diskChanged: DiskChange; declare disk: DiskState | null; declare big: boolean;
  declare clients: Set<Client>; declare journal: Journal | null; declare autosave: NodeJS.Timeout | null; declare lastOpen: number;
  declare special: boolean; declare writers: By[]; declare serverEdit: ServerEdit | null;
  declare anchors: Anchor[]; declare anchorsDirty: boolean;
  declare hold?: Hold | null; declare heldQueue?: (() => void)[] | null;
  constructor(owner: Buffers, { id, jid, name, file, ed }: SBufInit) {
    this.owner = owner; this.id = id; this.jid = jid; this.name = name; this.file = file; this.ed = ed;
    this.ver = 0; this.hist = []; this.histBytes = 0; this.seqIndex = new Map();
    this.savedText = ''; this.savedHash = sha256(''); this.savedVer = 0;
    this.eol = 'lf'; this.readOnly = false; this.diskChanged = null; this.disk = null; this.big = false;
    this.clients = new Set(); this.journal = null; this.autosave = null; this.lastOpen = Date.now();
    this.special = false; this.writers = []; this.serverEdit = null;
    /* Shared anchors (R9.12, anchors.mts): [{id, pos, label?, quote, prefix}], moved by the sequencer. */
    this.anchors = []; this.anchorsDirty = false;
  }
  get text(): string { return this.ed.rope.toString(); }
  get modified(): boolean { return this.ed.rope.length !== this.savedText.length || this.text !== this.savedText; }
  /* The buffer-list's notion of who is attached. */
  attached(): By[] { return [...this.clients].map(c => c.by()); }
  setReadOnly(reason: string | false): void { this.readOnly = reason; this.ed.readOnly = !!reason; this.owner.sendMeta(this); }
  setDiskChanged(v: DiskChange): void { if (this.diskChanged !== v) { this.diskChanged = v; this.owner.sendMeta(this); } }
  /* After every batch: modified may have changed, autosave may be due. */
  touched(): void {
    this.owner.index.set(this.indexEntry());
    if (this.owner.autosaves(this)) {
      if (this.autosave) clearTimeout(this.autosave);
      this.autosave = setTimeout(() => { this.autosave = null; if (this.modified && !this.readOnly) this.owner.save(this).catch(e => this.owner.log.warn('autosave', { buf: this.id, error: e.code || e.message })); }, AUTOSAVE_MS);
    }
  }
  indexEntry(): IndexEntry { return { jid: this.jid, id: this.id, name: this.name, file: this.file, mode: this.ed.mode, ver: this.ver, modified: this.modified, lastOpen: this.lastOpen }; }
  /* meta (§7.3). */
  meta(): Meta {
    return {
      file: this.file, mode: this.ed.mode, modified: this.modified, readOnly: this.readOnly, saved: this.savedVer,
      diskChanged: this.diskChanged, eol: this.eol, anchors: publicAnchors(this), locals: {}, ver: this.ver,
    };
  }
}

/* The events of Buffers, by name, with their listeners' arguments. */
export interface BufferEvents {
  afterBatch: [sb: SBuf, entry: HistEntry];
  killed: [sb: SBuf];
  created: [sb: SBuf];
  saved: [sb: SBuf];
  renamed: [fromReal: string, toReal: string];
}
type Listener = (...args: any[]) => void; // any: one map holds the listeners of every event
export interface BufferHooks { killed: ((sb: SBuf) => void) | null; afterBatch: ((sb: SBuf, entry: HistEntry) => void) | null }
export interface BuffersInit { Ed: Edwin; auth: Authority; stateDir: string; log: Log }
export interface CreateInit { id: string; jid: string; name: string; file: string | null; text: string; eol?: Eol; special?: boolean }
/* buffer-list (§13.1). */
export interface BufferListEntry { id: string; name: string; mode: string; modified: boolean; readOnly: string | false; ver: number; file: string | null; writers: By[] }
export interface OpenOptions { rid?: string; since?: number; create?: boolean }
export interface VisitInfo { buf: string; readOnly: string | false }
export interface RenameResult { ok: true; src: string; dst: string; from: string; to: string; dir?: true }
export interface UndoResult { ver: number; partial: boolean; of: string | number; by: By }

export class Buffers {
  declare Ed: Edwin; declare auth: Authority; declare stateDir: string; declare log: Log;
  declare byId: Map<string, SBuf>; declare byJid: Map<string, SBuf>;
  declare index: Index; declare seq: Sequencer; declare watcher: Watcher;
  declare moved: Map<string, MovedRecord>; declare compacting: Set<SBuf>;
  declare hooks: BufferHooks; declare listeners: Map<keyof BufferEvents, Listener[]>;
  constructor({ Ed, auth, stateDir, log }: BuffersInit) {
    this.Ed = Ed; this.auth = auth; this.stateDir = stateDir; this.log = log;
    this.byId = new Map(); this.byJid = new Map();
    fs.mkdirSync(path.join(stateDir, 'buffers'), { recursive: true, mode: 0o700 });
    this.index = new Index(path.join(stateDir, 'index.json'));
    this.seq = new Sequencer(Ed, log);
    this.watcher = new Watcher(this, log);
    /* Renames (R6.1, §7 moved): old id → {to, at, dir}, kept 24 h in index.json; a directory's record covers the
       ids under it. */
    this.moved = this.index.moved;
    this.pruneMoved();
    this.compacting = new Set();
    this.hooks = { killed: null, afterBatch: null };
    /* Listeners of the E2 modules: on('afterBatch', (sb, entry) => …), on('killed', sb => …),
       on('created', sb => …), on('saved', sb => …), on('renamed', (fromReal, toReal) => …). */
    this.listeners = new Map();
    /* Edwin's own kill-buffer must reach us: wrap it so a Scheme (kill-buffer) kills everywhere (R6.3). */
    const L = (globalThis as unknown as { L: Lisp }).L;
    const orig = L.get('kill-buffer');
    const self = this;
    const wrapped = function killBuffer(args: SchemeValue[]): SchemeValue {
      const b = args.length && args[0] !== false && args[0] !== undefined ? Ed.toBuffer(args[0]) : Ed.E.current;
      const sb = self.ofEd(b);
      const r = orig(args);
      if (sb && !Ed.E.buffers.includes(b)) self.forget(sb);
      return r;
    };
    Object.assign(wrapped, { procName: orig.procName, doc: orig.doc, interactive: orig.interactive, arity: orig.arity, rest: orig.rest, optional: orig.optional, params: orig.params, props: orig.props });
    L.set('kill-buffer', wrapped);
  }
  all(): SBuf[] { return [...this.byJid.values()]; }
  /* The loaded buffer ID names, or the one it was renamed to (an edit, sel or close sent before the client
     learnt of the move) while nothing is at the old path again, as resolve() has it. */
  live(id: string): SBuf | null {
    const sb = this.byId.get(id); if (sb) return sb;
    const to = this.movedTo(id);
    return to && !this.fileExists(id) ? this.byId.get(to) || null : null;
  }
  byFile(real: string): SBuf | null { for (const sb of this.byJid.values()) if (sb.file === real) return sb; return null; }
  ofEd(ed: EdBuffer): SBuf | null { for (const sb of this.byJid.values()) if (sb.ed === ed) return sb; return null; }
  autosaves(sb: SBuf): boolean { return !!sb.file && !sb.special && !sb.big && sb.file.startsWith(this.auth.realNotesDir() + '/'); }

  /* ---------- start: reload what the index names (R8.4, R8.6) ---------- */
  reload(): void {
    for (const e of [...this.index.buffers.values()]) {
      try { this.reloadOne(e); }
      catch (err) { this.log.error('reload', { jid: e.jid, id: e.id, error: err.message }); }
    }
  }
  reloadOne(e: IndexEntry): SBuf | undefined {
    const jfile = jidPath(this.stateDir, e.jid, '.jsonl');
    if (!fs.existsSync(jfile)) { this.index.delete(e.jid); return; }
    /* Unload stale saved buffers: a header-only journal and no open for 7 days (R8.6). */
    const { header, batches, mv, anchors, torn, count } = readJournal(jfile);
    /* The newest mv line names the current id, file and name (R8.1); compaction folds them into the header. */
    let last: { id: string; file?: string | null; name?: string } | null = mv.length ? mv[mv.length - 1] : null;
    /* A rename whose mv line never became durable (a crash right after it, or a full disk): the index, written
       at the rename, names the moved file. It wins only when the journal's file is gone and the index's is there. */
    const jfileOf = last && last.file !== undefined ? last.file : header.file;
    let mvLost = false;
    if (jfileOf && e.file && e.file !== jfileOf && typeof e.id === 'string' && !fs.existsSync(jfileOf) && fs.existsSync(e.file)) {
      last = { id: e.id, file: e.file, name: e.name || path.basename(e.file) }; mvLost = true;
    }
    const id = last ? last.id : header.id;
    let base: string | null = null, baseWhy = '';
    const saved = jidPath(this.stateDir, e.jid, '.saved'), snap = jidPath(this.stateDir, e.jid, '.snap'), next = jidPath(this.stateDir, e.jid, SNAP_NEW);
    /* A compaction killed after its journal was in place left the snapshot of that journal in SNAP_NEW: it
       becomes the snapshot now, before a later compaction writes SNAP_NEW again. */
    for (const f of [snap, next, saved]) {
      if (!fs.existsSync(f)) continue;
      const t = fs.readFileSync(f, 'utf8');
      if (sha256(t) === header.base.sha256) { base = t; if (f === next) promoteSnap(next, snap, this.log, header.id); break; }
      if (f !== next) baseWhy = `${path.basename(f)} does not match the journal base`;
    }
    let file: string | null = last && last.file !== undefined ? last.file : header.file, eol: Eol = 'lf', disk: DiskState | null = null, savedText: string | null = null;
    if (file) {
      try { const r = readText(file); eol = r.eol; disk = diskState(r.stat); savedText = r.text; if (base === null && sha256(r.text) === header.base.sha256) base = r.text; }
      catch (err) { if (err.code !== 'no_buffer') baseWhy = `${file}: ${err.message}`; }
    }
    if (base === null && header.base.ver === 0 && !batches.length && header.base.sha256 === sha256('')) base = '';
    const sb = this.create({ id, jid: e.jid, name: (last && last.name) || header.name, file, text: base ?? '', eol });
    sb.disk = disk;
    if (fs.existsSync(saved)) { const t = fs.readFileSync(saved, 'utf8'); sb.savedText = t; sb.savedHash = sha256(t); }
    else if (savedText !== null) { sb.savedText = savedText; sb.savedHash = sha256(savedText); }
    if (base === null) {
      sb.setReadOnly(`journal base is missing: ${baseWhy || 'no snapshot, saved copy or file matches'}`);
      sb.journal = new Journal(jfile); this.log.warn('reload', { buf: id, readOnly: sb.readOnly });
      return sb;
    }
    sb.ver = header.base.ver;
    let bad: string | null = null, applied = 0;
    for (const b of batches) {
      if (b.ver !== sb.ver + 1) { bad = `version ${b.ver} after ${sb.ver}`; break; }
      try { this.seq.applyBatch(sb, b.ops, b.by || SERVER_BY, { cid: b.cid ?? null, seq: b.seq ?? null, undo: b.undo || null }); }
      catch (err) { bad = `batch ${b.ver}: ${err.message}`; break; }
      sb.hist[sb.hist.length - 1].at = b.at || Date.now(); applied++;
    }
    restoreAnchors(sb, anchors, batches.slice(0, applied));
    if (torn) this.log.warn('reload', { buf: id, truncated: 'a torn last journal line was dropped' });
    sb.journal = new Journal(jfile).open();
    sb.journal.lines = count;   // every line on disk, anchors lines too, as appends count them
    if (mvLost) sb.journal.append({ t: 'mv', id: sb.id, file: sb.file, name: sb.name, at: Date.now() }).catch(err => this.log.error('reload', { buf: id, journal: err.code || err.message }));
    if (bad) { sb.setReadOnly(`journal replay failed: ${bad}`); this.log.error('reload', { buf: id, error: bad }); return sb; }
    sb.lastOpen = e.lastOpen || Date.now();
    /* The file may have changed while edwind was down. */
    if (file) { this.watcher.add(sb); this.watcher.check(sb); }
    this.log.info('reload', { buf: id, ver: sb.ver, batches: batches.length });
    return sb;
  }

  /* ---------- creation ---------- */
  /* Make the Edwin buffer and the wrapper; the text is set directly (no batch). */
  create({ id, jid, name, file, text, eol = 'lf', special = false }: CreateInit): SBuf {
    const Ed = this.Ed;
    let ed = special ? Ed.getBuffer(name) : null;
    if (!ed) {
      const uniq = Ed.getBuffer(name) ? (globalThis as unknown as { L: Lisp }).L.call('generate-new-buffer-name', [name]) : name;
      ed = Ed.getBufferCreate(uniq);
      ed.file = file; ed.mode = Ed.modeFor(file ? path.basename(file) : name);
      Ed.withOrigin('disk', () => { ed.text = text; });
      ed.pt = 0; ed.modified = false; ed.undo = []; ed.redo = [];
    }
    const sb = new SBuf(this, { id, jid, name: ed.name, file, ed });
    sb.eol = eol; sb.special = special;
    if (this.moved.delete(id)) this.index.schedule();
    sb.savedText = text; sb.savedHash = sha256(text);
    this.byId.set(id, sb); this.byJid.set(jid, sb);
    this.emit('created', sb);
    return sb;
  }
  /* A fresh journal for SB, based on its current text at its current version. */
  startJournal(sb: SBuf): void {
    const jfile = jidPath(this.stateDir, sb.jid, '.jsonl');
    sb.journal = Journal.create(jfile, journalHeader({ jid: sb.jid, id: sb.id, name: sb.name, file: sb.file, mode: sb.ed.mode, baseVer: sb.ver, baseText: sb.text }), []);
    writeAtomic(jidPath(this.stateDir, sb.jid, '.snap'), sb.text);
    this.writeSaved(sb);
    this.index.set(sb.indexEntry());
  }
  writeSaved(sb: SBuf): void { writeAtomic(jidPath(this.stateDir, sb.jid, '.saved'), sb.savedText); }

  /* Find or load the buffer for ID; CREATE makes a missing file buffer. Throws ProtoError. */
  resolve(id: string, create?: boolean): SBuf | Moved {
    const existing = this.byId.get(id);
    if (existing) return existing;
    /* A renamed file's old id names where it went, unless a file is at the old path again. */
    const to = this.movedTo(id);
    if (to && !this.fileExists(id)) return { moved: to };
    /* A new note under a directory that does not exist yet (R6.1 relative ids only): the directories are made
       inside notesDir with the walk notes-append uses; elsewhere a missing directory stays no_buffer. */
    if (create && typeof id === 'string' && id.includes('/') && !/^(\/|~|name:)/.test(id) && !id.includes('\0') && !id.split('/').some(s => s === '' || s === '.' || s === '..'))
      ensureNoteDir(id, this.auth.realNotesDir(), this.auth);
    let p: ParsedId;
    try { p = this.auth.parseId(id); } catch (e) { if (e instanceof PathError) throw new ProtoError(e.code, e.message); throw e; }
    if (p.kind === 'name') {
      const ed = this.Ed.getBuffer(p.name);
      if (ed) {
        const sb = this.ofEd(ed);
        if (sb) return sb;
        /* One of Edwin's own buffers (*scratch*, *Messages*, the boot files): shared from now on. */
        const nb = this.create({ id, jid: randomId(), name: p.name, file: null, text: ed.text, special: true });
        nb.savedText = nb.text; nb.savedHash = sha256(nb.savedText);
        if (ed.readOnly) nb.readOnly = 'server special buffer';
        this.startJournal(nb);
        return nb;
      }
      if (!create) throw new ProtoError('no_buffer', `no buffer ${JSON.stringify(id)}`);
      const nb = this.create({ id, jid: randomId(), name: p.name, file: null, text: '' });
      this.startJournal(nb);
      this.log.info('create', { buf: id });
      return nb;
    }
    const canon = this.auth.idOf(p.real);
    const byReal = this.byFile(p.real);
    if (byReal) return byReal;
    try { this.auth.checkRead(p.real); } catch (e) { throw new ProtoError('refused_path', e.message); }
    if (!p.exists) {
      if (!create) throw new ProtoError('no_buffer', `no file ${p.real}`);
      try { this.auth.checkWrite(p.real); } catch (e) { throw new ProtoError('refused_path', e.message); }
      const nb = this.create({ id: canon, jid: randomId(), name: path.basename(p.real), file: p.real, text: '' });
      nb.disk = null;
      this.startJournal(nb); this.watcher.add(nb);
      this.log.info('create', { buf: canon, file: true });
      return nb;
    }
    let r: TextFile;
    try { r = readText(p.real); } catch (e) { if (e instanceof FileError) throw new ProtoError(e.code, e.message); throw e; }
    const nb = this.create({ id: canon, jid: randomId(), name: path.basename(p.real), file: p.real, text: r.text, eol: r.eol });
    nb.disk = diskState(r.stat);
    if (r.big) { nb.big = true; nb.readOnly = `file larger than ${BIG >> 20} MiB: read-only`; nb.ed.readOnly = true; }
    else this.startJournal(nb);
    this.watcher.add(nb);
    try { this.auth.checkWrite(p.real); } catch (e) { if (!nb.readOnly) { nb.readOnly = 'outside the writable paths'; nb.ed.readOnly = true; } }
    this.log.info('open', { buf: canon, bytes: r.bytes, eol: r.eol });
    return nb;
  }

  /* ---------- open / close (§7.3) ---------- */
  open(client: Client, msg: { buf: string }, { rid, since, create }: OpenOptions): void {
    const r = this.resolve(msg.buf, create);
    if ((r as Moved).moved) { client.send({ t: 'moved', buf: msg.buf, to: (r as Moved).moved }); return; }
    const sb = r as SBuf;
    sb.clients.add(client); client.buffers.add(sb);
    sb.lastOpen = Date.now();
    if (since !== undefined && since <= sb.ver && this.seq.inHistory(sb, since)) {
      this.seq.replay(client, sb, since);
    } else {
      this.snapshot(client, sb, rid);
    }
    client.send({ t: 'opened', rid, buf: sb.id, ver: sb.ver });
    this.index.set(sb.indexEntry());
  }
  /* snap, in 1 MiB pieces (R14.14). */
  snapshot(client: Client, sb: SBuf, rid?: string): void {
    const text = sb.text;
    if (text.length <= CHUNK) { client.sendBulk({ t: 'snap', rid, buf: sb.id, ver: sb.ver, text, meta: sb.meta() }); return; }
    const pieces: string[] = [];
    for (let i = 0; i < text.length;) { let j = Math.min(text.length, i + CHUNK); if (OT.splitsPair(text, j)) j--; pieces.push(text.slice(i, j)); i = j; }
    client.sendBulk({ t: 'snap', rid, buf: sb.id, ver: sb.ver, text: pieces[0], meta: sb.meta(), more: true });
    for (let k = 1; k < pieces.length; k++) client.sendBulk({ t: 'chunk', rid, buf: sb.id, text: pieces[k], more: k < pieces.length - 1 });
  }
  close(client: Client, sb: SBuf): void { sb.clients.delete(client); client.buffers.delete(sb); }
  detachAll(client: Client): void { for (const sb of client.buffers) sb.clients.delete(client); client.buffers.clear(); }
  /* A loaded buffer by id, else no_buffer. */
  get(id: string): SBuf {
    const sb = this.live(id);
    if (!sb) {
      /* An id in another spelling of the same file. */
      try { const p = this.auth.parseId(id); if (p.kind === 'file') { const b = this.byFile(p.real); if (b) return b; } } catch (e) { throw new ProtoError(e.code || 'bad_id', e.message); }
      throw new ProtoError('no_buffer', `no buffer ${JSON.stringify(id)}`);
    }
    return sb;
  }

  sendMeta(sb: SBuf): void { const m = { t: 'meta', buf: sb.id, ...sb.meta() }; for (const c of sb.clients) c.send(m); }
  afterBatch(sb: SBuf, entry: HistEntry): void { if (this.hooks.afterBatch) this.hooks.afterBatch(sb, entry); this.emit('afterBatch', sb, entry); }
  on<K extends keyof BufferEvents>(event: K, fn: (...args: BufferEvents[K]) => void): () => void { let l = this.listeners.get(event); if (!l) { l = []; this.listeners.set(event, l); } l.push(fn); return () => { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }; }
  emit<K extends keyof BufferEvents>(event: K, ...args: BufferEvents[K]): void { const l = this.listeners.get(event); if (l) for (const fn of l) { try { fn(...args); } catch (e) { this.log.error('listener', { event, error: e.stack || e.message }); } } }
  compactSoon(sb: SBuf): void { if (this.compacting.has(sb)) return; this.compacting.add(sb); setTimeout(() => { this.compacting.delete(sb); this.compact(sb).catch(e => this.log.error('compact', { buf: sb.id, error: e.message })); }, 0); }

  /* ---------- save / revert (§8.3) ---------- */
  async save(sb: SBuf): Promise<{ buf: string; ver: number; saved: true }> {
    if (!sb.file) throw new ProtoError('bad_request', `${sb.id} visits no file`);
    if (sb.big) throw new ProtoError('read_only', sb.readOnly as string);
    try { this.auth.checkWrite(sb.file); } catch (e) { throw new ProtoError('refused_path', e.message); }
    const text = sb.text, ver = sb.ver;
    let r: ReturnType<typeof saveAtomic>;
    try { r = saveAtomic(sb.file, text, { eol: sb.eol }); }
    catch (e) { this.log.error('save', { buf: sb.id, error: e.code || e.message }); throw new ProtoError('refused_path', `save failed: ${e.code || e.message}`); }
    sb.savedText = text; sb.savedHash = r.hash; sb.savedVer = ver; sb.disk = diskState(r.stat);
    if (sb.diskChanged) sb.setDiskChanged(null);
    if (sb.readOnly && typeof sb.readOnly === 'string' && sb.readOnly.startsWith('journal write failed')) sb.setReadOnly(false);
    this.writeSaved(sb);
    this.log.info('save', { buf: sb.id, bytes: r.bytes, ver });
    this.sendMeta(sb);
    this.watcher.add(sb);
    this.emit('saved', sb);
    if (sb.journal) await this.compact(sb);
    return { buf: sb.id, ver, saved: true };
  }
  /* Reload the file as one batch by disk (R6.23). */
  async revert(sb: SBuf): Promise<{ buf: string; ver: number; saved: true }> {
    if (!sb.file) throw new ProtoError('bad_request', `${sb.id} visits no file`);
    let r: TextFile;
    try { r = readText(sb.file); } catch (e) { throw new ProtoError(e.code === 'no_buffer' ? 'no_buffer' : e.code, e.message); }
    sb.disk = diskState(r.stat); sb.eol = r.eol;
    await this.replaceText(sb, r.text, DISK_BY);
    sb.savedText = r.text; sb.savedHash = sha256(r.text); sb.savedVer = sb.ver;
    this.writeSaved(sb);
    sb.setDiskChanged(null);
    this.sendMeta(sb);
    return { buf: sb.id, ver: sb.ver, saved: true };
  }
  /* Make the text NEW as one sequenced batch by BY (a line-then-character diff, R8.12). */
  async replaceText(sb: SBuf, newText: string, by: By): Promise<HistEntry | null> {
    const ops = diffOps(sb.text, newText);
    if (!ops.length) return null;
    const entry = this.seq.applyBatch(sb, ops, by);
    await this.seq.commit(sb, entry, null);
    return entry;
  }

  /* ---------- disk changes (R8.12–R8.14) ---------- */
  diskChanged(sb: SBuf, text: string, eol: Eol, hash: string): void {
    if (sb.readOnly && sb.readOnly !== 'outside the writable paths') return;
    sb.eol = eol;
    if (!sb.modified) {
      this.replaceText(sb, text, DISK_BY).then(() => {
        sb.savedText = text; sb.savedHash = hash; sb.savedVer = sb.ver; this.writeSaved(sb); sb.setDiskChanged(null); this.sendMeta(sb);
        this.log.info('disk', { buf: sb.id, change: 'reverted', ver: sb.ver });
      }).catch(e => this.log.error('disk', { buf: sb.id, error: e.message }));
      return;
    }
    const m = merge3(sb.savedText, sb.text, text);
    if (m.conflict) { sb.setDiskChanged('conflict'); this.log.info('disk', { buf: sb.id, change: 'conflict' }); return; }
    this.replaceText(sb, m.text!, DISK_BY).then(() => {
      sb.savedText = text; sb.savedHash = hash; this.writeSaved(sb); sb.setDiskChanged(null); this.sendMeta(sb);
      this.log.info('disk', { buf: sb.id, change: 'merged', ver: sb.ver });
    }).catch(e => this.log.error('disk', { buf: sb.id, error: e.message }));
  }

  /* ---------- the board's file opener ---------- */
  /* The id a frame would open the file ID (any id form of R6.1) under, and whether edwind would edit it, without
     loading it: {buf, readOnly}, readOnly false or the reason a frame would show. Throws ProtoError as open does
     (bad_id, refused_path, no_buffer, not_text), so the board keeps the list of what edwind refuses here. */
  visitInfo(id: string): VisitInfo {
    const live = this.live(id);
    if (live) return { buf: live.id, readOnly: live.readOnly || false };
    let p: ParsedId;
    try { p = this.auth.parseId(id); } catch (e) { if (e instanceof PathError) throw new ProtoError(e.code, e.message); throw e; }
    if (p.kind === 'name') throw new ProtoError('bad_request', `${id} names no file`);
    const loaded = this.byFile(p.real);
    if (loaded) return { buf: loaded.id, readOnly: loaded.readOnly || false };
    try { this.auth.checkRead(p.real); } catch (e) { throw new ProtoError('refused_path', e.message); }
    let st: fs.Stats;
    try { st = fs.statSync(p.real); } catch (e) { throw new ProtoError('no_buffer', `no file ${p.real}`); }
    if (!st.isFile()) throw new ProtoError('not_text', `${p.real}: not a regular file`);
    const buf = this.auth.idOf(p.real);
    try { this.auth.checkWrite(p.real); } catch (e) { return { buf, readOnly: 'outside the writable paths' }; }
    if (st.size > BIG) return { buf, readOnly: `file larger than ${BIG >> 20} MiB: read-only` };
    try { readText(p.real); } catch (e) { if (e instanceof FileError) throw new ProtoError(e.code, e.message); throw e; }
    return { buf, readOnly: false };
  }

  /* ---------- rename (R4.49, R6.1, R8.1, R8.8, §7 moved) ---------- */
  /* Rename the file or directory SRC to DST, or into DST when that is an existing directory, never replacing
     anything: the rule of wb-web's POST /api/mv, which forwards here when edwind is configured. Paths are absolute,
     ~/… or notesDir-relative. Both ends pass the file authority (R14.8; a source above a refused path moves it too,
     so it is refused), and edwind's own directories and everything above them stay where they are. Loaded buffers
     visiting the file, or files under the directory, keep their SBuf, jid and history and take the new id: an mv
     journal line each, a moved record kept 24 h, and moved{buf, to} to every attached client, who stays attached.
     Returns {ok, src, dst, from, to, dir?}: the expanded paths and the ids of both ends, so a caller holding ids of
     buffers that are not loaded can follow too. Throws ProtoError. */
  async rename(src: unknown, dst: unknown): Promise<RenameResult> {
    const auth = this.auth;
    const lexical = (p: unknown): string => {
      if (typeof p !== 'string' || !p || p.includes('\0')) throw new ProtoError('bad_request', 'src and dst must be non-empty paths');
      if (p === '~' || p.startsWith('~/') || p.startsWith('/')) return path.resolve(expandHome(p));
      if (p.startsWith('name:') || p.split('/').some(x => x === '' || x === '.' || x === '..')) throw new ProtoError('bad_request', `bad path ${JSON.stringify(p)}`);
      return path.join(auth.notesDir, p);
    };
    /* The parent resolved by the kernel and the last component left alone: what a rename moves (a symlink itself). */
    const real = (p: string): string => { try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch (e) { throw new ProtoError('bad_request', osMessage(e)); } };
    const srcAbs = lexical(src);
    let dstAbs = lexical(dst);
    if (srcAbs === '/') throw new ProtoError('bad_request', 'cannot move /');
    try { if (fs.statSync(dstAbs).isDirectory()) dstAbs = path.join(dstAbs, path.basename(srcAbs)); } catch (e) { /* a new name */ }
    if (auth.refused(dstAbs)) throw new ProtoError('refused_path', REFUSED_DST);
    const dstReal = real(dstAbs);
    if (auth.refused(dstReal)) throw new ProtoError('refused_path', REFUSED_DST);
    const srcReal = real(srcAbs);
    let st: fs.Stats;
    try { st = fs.lstatSync(srcReal); } catch (e) { throw new ProtoError('bad_request', osMessage(e)); }
    try { auth.checkWrite(srcReal); auth.checkWrite(dstReal); } catch (e) { throw new ProtoError('refused_path', e.message); }
    /* A root, or a source, may be a symlink (notesDir linked into a synced folder, configDir linked by home-manager):
       both spellings of each are compared, so neither the link nor its target moves. */
    for (const root of [auth.notesDir, auth.stateDir, auth.configDir]) {
      let r = root; try { r = fs.realpathSync.native(root); } catch (e) { /* not made yet */ }
      if ([root, r].some(x => under(x, srcReal) || under(x, srcAbs))) throw new ProtoError('refused_path', `${srcReal}: holds edwind's directory ${root}`);
    }
    const dir = st.isDirectory();
    if (this.all().some(sb => sb.file && under(sb.file, dstReal))) throw new ProtoError('bad_request', 'destination exists');
    /* Node has no renameat2: the destination is claimed first (an exclusive create, or mkdir), so a name that
       appears meanwhile is never replaced, and the rename then replaces only the claim. */
    try { if (dir) fs.mkdirSync(dstReal, 0o700); else fs.closeSync(fs.openSync(dstReal, 'wx', 0o600)); }
    catch (e) { throw new ProtoError('bad_request', e.code === 'EEXIST' ? 'destination exists' : osMessage(e)); }
    try { fs.renameSync(srcReal, dstReal); }
    catch (e) { try { if (dir) fs.rmdirSync(dstReal); else fs.unlinkSync(dstReal); } catch (x) { /* gone */ } throw new ProtoError('bad_request', osMessage(e)); }
    fsyncDir(path.dirname(dstReal));
    if (path.dirname(srcReal) !== path.dirname(dstReal)) fsyncDir(path.dirname(srcReal));
    /* From here to the first await the buffers follow, so the watcher never sees their files missing (R8.15). */
    const from = auth.idOf(srcReal), to = auth.idOf(dstReal), at = Date.now();
    const moved: { sb: SBuf; was: { id: string; file: string } }[] = [];
    for (const sb of this.all()) {
      if (!sb.file || !under(sb.file, srcReal)) continue;
      const was = { id: sb.id, file: sb.file };
      const file = dstReal + sb.file.slice(srcReal.length), id = auth.idOf(file), name = path.basename(file);
      this.byId.delete(sb.id); sb.id = id; sb.file = file; sb.ed.file = file; this.byId.set(id, sb);
      if (sb.ed.name !== name) sb.ed.name = this.Ed.getBuffer(name) ? (globalThis as unknown as { L: Lisp }).L.call('generate-new-buffer-name', [name]) : name;
      sb.name = sb.ed.name;
      /* sb.disk stays: a rename keeps the inode, mtime and size, so a write that landed just before it still
         differs from what edwind last saw, and the check moved() queues picks it up. */
      this.watcher.moved(sb, was.file);
      this.addMoved(was.id, id, at, false);
      this.index.set(sb.indexEntry());
      moved.push({ sb, was });
    }
    if (!st.isSymbolicLink()) this.addMoved(from, to, at, dir);
    /* The index names the new ids and files before the mv journal lines are durable (or when they fail), so a
       crash or a full disk here still reloads the buffers on the moved files (reloadOne). */
    try { this.index.write(); } catch (e) { this.log.error('rename', { index: e.code || e.message }); }
    for (const { sb, was } of moved) for (const c of sb.clients) c.send({ t: 'moved', buf: was.id, to: sb.id });
    this.emit('renamed', srcReal, dstReal);
    this.log.info('rename', { src: srcReal, dst: dstReal, buffers: moved.length });
    await Promise.all(moved.map(({ sb }) => sb.journal && sb.journal.append({ t: 'mv', id: sb.id, file: sb.file, name: sb.name, at })
      .catch(e => this.log.error('rename', { buf: sb.id, journal: e.code || e.message }))));
    return { ok: true, src: srcAbs, dst: dstAbs, from, to, ...(dir ? { dir: true } : {}) };
  }
  addMoved(from: string, to: string, at: number, dir: boolean): void {
    if (from === to) return;
    this.moved.delete(to);   // a record from the new id would send its opens away from the file now there
    this.moved.set(from, { to, at, dir });
    this.pruneMoved();
    this.index.schedule();
  }
  pruneMoved(): void { const now = Date.now(); for (const [k, m] of this.moved) if (now - m.at >= MOVED_TTL_MS) this.moved.delete(k); }
  /* Where ID went, following moved records younger than 24 h; null when it did not move. A directory's record
     sends on only ids of files that went with it: nothing is at the old directory again, and the file is at the
     new place. A new note under the old name (the directory made again, or not) stays where it was asked for. */
  movedTo(id: unknown): string | null {
    if (typeof id !== 'string' || !this.moved.size) return null;
    const now = Date.now(), seen = new Set([id]);
    let cur = id, viaDir = false;
    for (;;) {
      let next: string | null = null;
      const m = this.moved.get(cur);
      if (m && now - m.at < MOVED_TTL_MS) next = m.to;
      else for (const [from, d] of this.moved) if (d.dir && now - d.at < MOVED_TTL_MS && cur.startsWith(from + '/') && !this.fileExists(from)) { next = d.to + cur.slice(from.length); viaDir = true; break; }
      if (next === null || seen.has(next)) break;
      seen.add(next); cur = next;
    }
    if (viaDir && !this.fileExists(cur)) return null;
    return cur === id ? null : cur;
  }
  fileExists(id: string): boolean { try { const p = this.auth.parseId(id); return p.kind === 'file' && p.exists; } catch (e) { return false; } }

  /* ---------- journal compaction (R8.5) ---------- */
  async compact(sb: SBuf): Promise<void> {
    if (!sb.journal || sb.big) return;
    await sb.journal.drain();
    const text = sb.text;
    /* Snapshot at the version where the retained history begins, so dedup and undo survive a restart. */
    const baseVer = sb.hist.length ? sb.hist[0].ver - 1 : sb.ver;
    const baseText = sb.hist.length ? OT.textBefore(text, sb.hist) : text;
    /* The new snapshot goes beside the old one (SNAP_NEW) until the new journal is in place, so a kill at any step
       leaves a journal whose base one of the two matches; reloadOne and --check try both. */
    const snap = jidPath(this.stateDir, sb.jid, '.snap'), next = jidPath(this.stateDir, sb.jid, SNAP_NEW);
    writeAtomic(next, baseText);
    crashPoint('kill-compact-snap');
    sb.journal.close();
    sb.journal = Journal.create(sb.journal.file, journalHeader({ jid: sb.jid, id: sb.id, name: sb.name, file: sb.file, mode: sb.ed.mode, baseVer, baseText }),
      [...sb.hist.map(b => ({ t: 'b' as const, ver: b.ver, cid: b.cid, seq: b.seq, by: b.by, ops: b.ops, undo: b.undo, at: b.at })), ...(sb.anchors.length ? [anchorsRecord(sb)] : [])]);
    crashPoint('kill-compact-journal');
    promoteSnap(next, snap, this.log, sb.id);
    this.index.set(sb.indexEntry());
  }

  /* ---------- kill (R6.3) ---------- */
  kill(sb: SBuf): void {
    const L = (globalThis as unknown as { L: Lisp }).L;
    if (this.Ed.E.buffers.includes(sb.ed)) L.call('kill-buffer', [sb.ed]); else this.forget(sb);
  }
  /* The Edwin buffer is gone: tell the clients, drop the journal. */
  forget(sb: SBuf): void {
    for (const c of sb.clients) { c.send({ t: 'killed', buf: sb.id }); c.buffers.delete(sb); }
    sb.clients.clear();
    if (sb.autosave) clearTimeout(sb.autosave);
    if (sb.journal) { sb.journal.close(); for (const ext of ['.jsonl', '.snap', SNAP_NEW, '.saved']) { try { fs.unlinkSync(jidPath(this.stateDir, sb.jid, ext)); } catch (e) { /* gone */ } } }
    this.byId.delete(sb.id); this.byJid.delete(sb.jid); this.index.delete(sb.jid);
    if (sb.serverEdit) { for (const w of sb.serverEdit.waiters) w(sb.serverEdit.saved ? 0 : 1); sb.serverEdit = null; }
    if (this.hooks.killed) this.hooks.killed(sb);
    this.emit('killed', sb);
    this.log.info('kill', { buf: sb.id });
  }

  /* ---------- buffer-list (§13.1) ---------- */
  list(): BufferListEntry[] {
    return this.all().map(sb => ({ id: sb.id, name: sb.name, mode: sb.ed.mode, modified: sb.modified, readOnly: sb.readOnly, ver: sb.ver, file: sb.file, writers: sb.attached() }));
  }

  /* ---------- undo (R6.19–R6.21) ---------- */
  /* Undo the newest group of SB matching PICK(batch); returns {ver, partial} or null. */
  async undoWhere(sb: SBuf, pick: (b: HistEntry) => unknown, by: By, { cid = null, seq = null }: { cid?: string | null; seq?: number | null } = {}): Promise<UndoResult | null> {
    const undone = new Set(sb.hist.filter(b => b.undo && b.undo.of !== undefined).map(b => `${b.undo!.ofCid || b.cid}:${b.undo!.of}`));
    const groups = sb.hist.filter(b => b.undo && b.undo.of === undefined && pick(b) && !undone.has(`${b.cid}:${b.undo.g}`));
    if (!groups.length) return null;
    const g = groups[groups.length - 1];
    const r = this.seq.undoOps(sb, { cid: g.cid, g: g.undo!.g });
    if (!r) return null;
    /* The undo batch names the group and its writer (undo.ofCid), so the pair cancels in later undo
       computations whoever asked for it. */
    const entry = this.seq.applyBatch(sb, r.ops, by, { cid, seq, undo: { g: 'undo-' + sb.ver + '-' + randomId(4), of: g.undo!.g, ofCid: g.cid } });
    await this.seq.commit(sb, entry, null);
    return { ver: entry.ver, partial: r.partial, of: g.undo!.g, by: g.by };
  }

  async shutdown(): Promise<void> {
    this.watcher.close();
    for (const sb of this.all()) { if (sb.autosave) { clearTimeout(sb.autosave); sb.autosave = null; } if (sb.journal) { await sb.journal.drain(); sb.journal.close(); } }
    this.index.write();
  }
}
