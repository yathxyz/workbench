// Server buffers (spec §6.1–§6.2, §6.5, §8): the registry of shared buffers by id and jid, their load from
// files and journals, snapshots to clients, saves, reverts, disk changes, kills, the index and the
// server side of undo. Every text change goes through the sequencer, so Edwin's markers and hooks
// follow it and every batch is journaled before anyone is told.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProtoError, CHUNK } from './proto.mjs';
import { PathError } from './paths.mjs';
import { readText, saveAtomic, writeAtomic, sha256, diskState, FileError, BIG } from './files.mjs';
import { Journal, readJournal, header as journalHeader, Index, randomId, jidPath } from './journal.mjs';
import { Sequencer } from './sequencer.mjs';
import { Watcher, diffOps, merge3 } from './watch.mjs';

const require = createRequire(import.meta.url);
const OT = require('../src/ot.js');

export const AUTOSAVE_MS = 2000;
export const MOVED_TTL_MS = 24 * 3600 * 1000;
export const UNLOAD_AFTER_MS = 7 * 24 * 3600 * 1000;
const DISK_BY = { kind: 'disk' };
const SERVER_BY = { kind: 'server' };

/* One shared buffer as edwind keeps it (§6.2). */
export class SBuf {
  constructor(owner, { id, jid, name, file, ed }) {
    this.owner = owner; this.id = id; this.jid = jid; this.name = name; this.file = file; this.ed = ed;
    this.ver = 0; this.hist = []; this.histBytes = 0; this.seqIndex = new Map();
    this.savedText = ''; this.savedHash = sha256(''); this.savedVer = 0;
    this.eol = 'lf'; this.readOnly = false; this.diskChanged = null; this.disk = null; this.big = false;
    this.clients = new Set(); this.journal = null; this.autosave = null; this.lastOpen = Date.now();
    this.special = false; this.writers = []; this.serverEdit = null;
  }
  get text() { return this.ed.rope.toString(); }
  get modified() { return this.ed.rope.length !== this.savedText.length || this.text !== this.savedText; }
  /* The buffer-list's notion of who is attached. */
  attached() { return [...this.clients].map(c => c.by()); }
  setReadOnly(reason) { this.readOnly = reason; this.ed.readOnly = !!reason; this.owner.sendMeta(this); }
  setDiskChanged(v) { if (this.diskChanged !== v) { this.diskChanged = v; this.owner.sendMeta(this); } }
  /* After every batch: modified may have changed, autosave may be due. */
  touched() {
    this.owner.index.set(this.indexEntry());
    if (this.owner.autosaves(this)) {
      if (this.autosave) clearTimeout(this.autosave);
      this.autosave = setTimeout(() => { this.autosave = null; if (this.modified && !this.readOnly) this.owner.save(this).catch(e => this.owner.log.warn('autosave', { buf: this.id, error: e.code || e.message })); }, AUTOSAVE_MS);
    }
  }
  indexEntry() { return { jid: this.jid, id: this.id, name: this.name, file: this.file, mode: this.ed.mode, ver: this.ver, modified: this.modified, lastOpen: this.lastOpen }; }
  /* meta (§7.3). */
  meta() {
    return {
      file: this.file, mode: this.ed.mode, modified: this.modified, readOnly: this.readOnly, saved: this.savedVer,
      diskChanged: this.diskChanged, eol: this.eol, anchors: [], locals: {},
    };
  }
}

export class Buffers {
  constructor({ Ed, auth, stateDir, log }) {
    this.Ed = Ed; this.auth = auth; this.stateDir = stateDir; this.log = log;
    this.byId = new Map(); this.byJid = new Map();
    fs.mkdirSync(path.join(stateDir, 'buffers'), { recursive: true, mode: 0o700 });
    this.index = new Index(path.join(stateDir, 'index.json'));
    this.seq = new Sequencer(Ed, log);
    this.watcher = new Watcher(this, log);
    this.moved = new Map(); // old id → {to, at}
    this.compacting = new Set();
    this.hooks = { killed: null, afterBatch: null };
    /* Edwin's own kill-buffer must reach us: wrap it so a Scheme (kill-buffer) kills everywhere (R6.3). */
    const L = globalThis.L;
    const orig = L.get('kill-buffer');
    const self = this;
    const wrapped = function killBuffer(args) {
      const b = args.length && args[0] !== false && args[0] !== undefined ? Ed.toBuffer(args[0]) : Ed.E.current;
      const sb = self.ofEd(b);
      const r = orig(args);
      if (sb && !Ed.E.buffers.includes(b)) self.forget(sb);
      return r;
    };
    Object.assign(wrapped, { procName: orig.procName, doc: orig.doc, interactive: orig.interactive, arity: orig.arity, rest: orig.rest, optional: orig.optional, params: orig.params, props: orig.props });
    L.set('kill-buffer', wrapped);
  }
  all() { return [...this.byJid.values()]; }
  byFile(real) { for (const sb of this.byJid.values()) if (sb.file === real) return sb; return null; }
  ofEd(ed) { for (const sb of this.byJid.values()) if (sb.ed === ed) return sb; return null; }
  autosaves(sb) { return !!sb.file && !sb.special && !sb.big && sb.file.startsWith(this.auth.realNotesDir() + '/'); }

  /* ---------- start: reload what the index names (R8.4, R8.6) ---------- */
  reload() {
    for (const e of [...this.index.buffers.values()]) {
      try { this.reloadOne(e); }
      catch (err) { this.log.error('reload', { jid: e.jid, id: e.id, error: err.message }); }
    }
  }
  reloadOne(e) {
    const jfile = jidPath(this.stateDir, e.jid, '.jsonl');
    if (!fs.existsSync(jfile)) { this.index.delete(e.jid); return; }
    /* Unload stale saved buffers: a header-only journal and no open for 7 days (R8.6). */
    const { header, batches, mv, torn } = readJournal(jfile);
    const id = mv.length ? mv[mv.length - 1].id : header.id;
    let base = null, baseWhy = '';
    const saved = jidPath(this.stateDir, e.jid, '.saved'), snap = jidPath(this.stateDir, e.jid, '.snap');
    for (const f of [snap, saved]) {
      if (!fs.existsSync(f)) continue;
      const t = fs.readFileSync(f, 'utf8');
      if (sha256(t) === header.base.sha256) { base = t; break; }
      baseWhy = `${path.basename(f)} does not match the journal base`;
    }
    let file = header.file, eol = 'lf', disk = null, savedText = null;
    if (file) {
      try { const r = readText(file); eol = r.eol; disk = diskState(r.stat); savedText = r.text; if (base === null && sha256(r.text) === header.base.sha256) base = r.text; }
      catch (err) { if (err.code !== 'no_buffer') baseWhy = `${file}: ${err.message}`; }
    }
    if (base === null && header.base.ver === 0 && !batches.length && header.base.sha256 === sha256('')) base = '';
    const sb = this.create({ id, jid: e.jid, name: header.name, file, text: base ?? '', eol });
    sb.disk = disk;
    if (fs.existsSync(saved)) { const t = fs.readFileSync(saved, 'utf8'); sb.savedText = t; sb.savedHash = sha256(t); }
    else if (savedText !== null) { sb.savedText = savedText; sb.savedHash = sha256(savedText); }
    if (base === null) {
      sb.setReadOnly(`journal base is missing: ${baseWhy || 'no snapshot, saved copy or file matches'}`);
      sb.journal = new Journal(jfile); this.log.warn('reload', { buf: id, readOnly: sb.readOnly });
      return sb;
    }
    sb.ver = header.base.ver;
    let bad = null;
    for (const b of batches) {
      if (b.ver !== sb.ver + 1) { bad = `version ${b.ver} after ${sb.ver}`; break; }
      try { this.seq.applyBatch(sb, b.ops, b.by || SERVER_BY, { cid: b.cid ?? null, seq: b.seq ?? null, undo: b.undo || null }); }
      catch (err) { bad = `batch ${b.ver}: ${err.message}`; break; }
      sb.hist[sb.hist.length - 1].at = b.at || Date.now();
    }
    if (torn) this.log.warn('reload', { buf: id, truncated: 'a torn last journal line was dropped' });
    sb.journal = new Journal(jfile).open();
    sb.journal.lines = 1 + batches.length + mv.length;
    if (bad) { sb.setReadOnly(`journal replay failed: ${bad}`); this.log.error('reload', { buf: id, error: bad }); return sb; }
    sb.lastOpen = e.lastOpen || Date.now();
    /* The file may have changed while edwind was down. */
    if (file) { this.watcher.add(sb); this.watcher.check(sb); }
    this.log.info('reload', { buf: id, ver: sb.ver, batches: batches.length });
    return sb;
  }

  /* ---------- creation ---------- */
  /* Make the Edwin buffer and the wrapper; the text is set directly (no batch). */
  create({ id, jid, name, file, text, eol = 'lf', special = false }) {
    const Ed = this.Ed;
    let ed = special ? Ed.getBuffer(name) : null;
    if (!ed) {
      const uniq = Ed.getBuffer(name) ? globalThis.L.call('generate-new-buffer-name', [name]) : name;
      ed = Ed.getBufferCreate(uniq);
      ed.file = file; ed.mode = Ed.modeFor(file ? path.basename(file) : name);
      Ed.withOrigin('disk', () => { ed.text = text; });
      ed.pt = 0; ed.modified = false; ed.undo = []; ed.redo = [];
    }
    const sb = new SBuf(this, { id, jid, name: ed.name, file, ed });
    sb.eol = eol; sb.special = special;
    sb.savedText = text; sb.savedHash = sha256(text);
    this.byId.set(id, sb); this.byJid.set(jid, sb);
    return sb;
  }
  /* A fresh journal for SB, based on its current text at its current version. */
  startJournal(sb) {
    const jfile = jidPath(this.stateDir, sb.jid, '.jsonl');
    sb.journal = Journal.create(jfile, journalHeader({ jid: sb.jid, id: sb.id, name: sb.name, file: sb.file, mode: sb.ed.mode, baseVer: sb.ver, baseText: sb.text }), []);
    writeAtomic(jidPath(this.stateDir, sb.jid, '.snap'), sb.text);
    this.writeSaved(sb);
    this.index.set(sb.indexEntry());
  }
  writeSaved(sb) { writeAtomic(jidPath(this.stateDir, sb.jid, '.saved'), sb.savedText); }

  /* Find or load the buffer for ID; CREATE makes a missing file buffer. Throws ProtoError. */
  resolve(id, create) {
    const existing = this.byId.get(id);
    if (existing) return existing;
    const mv = this.moved.get(id);
    if (mv && Date.now() - mv.at < MOVED_TTL_MS) return { moved: mv.to };
    let p;
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
    let r;
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
  open(client, msg, { rid, since, create }) {
    const r = this.resolve(msg.buf, create);
    if (r.moved) { client.send({ t: 'moved', buf: msg.buf, to: r.moved }); return; }
    const sb = r;
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
  snapshot(client, sb, rid) {
    const text = sb.text;
    if (text.length <= CHUNK) { client.sendBulk({ t: 'snap', rid, buf: sb.id, ver: sb.ver, text, meta: sb.meta() }); return; }
    const pieces = [];
    for (let i = 0; i < text.length;) { let j = Math.min(text.length, i + CHUNK); if (OT.splitsPair(text, j)) j--; pieces.push(text.slice(i, j)); i = j; }
    client.sendBulk({ t: 'snap', rid, buf: sb.id, ver: sb.ver, text: pieces[0], meta: sb.meta(), more: true });
    for (let k = 1; k < pieces.length; k++) client.sendBulk({ t: 'chunk', rid, buf: sb.id, text: pieces[k], more: k < pieces.length - 1 });
  }
  close(client, sb) { sb.clients.delete(client); client.buffers.delete(sb); }
  detachAll(client) { for (const sb of client.buffers) sb.clients.delete(client); client.buffers.clear(); }
  /* A loaded buffer by id, else no_buffer. */
  get(id) {
    const sb = this.byId.get(id);
    if (!sb) {
      /* An id in another spelling of the same file. */
      try { const p = this.auth.parseId(id); if (p.kind === 'file') { const b = this.byFile(p.real); if (b) return b; } } catch (e) { throw new ProtoError(e.code || 'bad_id', e.message); }
      throw new ProtoError('no_buffer', `no buffer ${JSON.stringify(id)}`);
    }
    return sb;
  }

  sendMeta(sb) { const m = { t: 'meta', buf: sb.id, ...sb.meta() }; for (const c of sb.clients) c.send(m); }
  afterBatch(sb, entry) { if (this.hooks.afterBatch) this.hooks.afterBatch(sb, entry); }
  compactSoon(sb) { if (this.compacting.has(sb)) return; this.compacting.add(sb); setTimeout(() => { this.compacting.delete(sb); this.compact(sb).catch(e => this.log.error('compact', { buf: sb.id, error: e.message })); }, 0); }

  /* ---------- save / revert (§8.3) ---------- */
  async save(sb) {
    if (!sb.file) throw new ProtoError('bad_request', `${sb.id} visits no file`);
    if (sb.big) throw new ProtoError('read_only', sb.readOnly);
    try { this.auth.checkWrite(sb.file); } catch (e) { throw new ProtoError('refused_path', e.message); }
    const text = sb.text, ver = sb.ver;
    let r;
    try { r = saveAtomic(sb.file, text, { eol: sb.eol }); }
    catch (e) { this.log.error('save', { buf: sb.id, error: e.code || e.message }); throw new ProtoError('refused_path', `save failed: ${e.code || e.message}`); }
    sb.savedText = text; sb.savedHash = r.hash; sb.savedVer = ver; sb.disk = diskState(r.stat);
    if (sb.diskChanged) sb.setDiskChanged(null);
    if (sb.readOnly && typeof sb.readOnly === 'string' && sb.readOnly.startsWith('journal write failed')) sb.setReadOnly(false);
    this.writeSaved(sb);
    this.log.info('save', { buf: sb.id, bytes: r.bytes, ver });
    this.sendMeta(sb);
    this.watcher.add(sb);
    if (sb.journal) await this.compact(sb);
    return { buf: sb.id, ver, saved: true };
  }
  /* Reload the file as one batch by disk (R6.23). */
  async revert(sb) {
    if (!sb.file) throw new ProtoError('bad_request', `${sb.id} visits no file`);
    let r;
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
  async replaceText(sb, newText, by) {
    const ops = diffOps(sb.text, newText);
    if (!ops.length) return null;
    const entry = this.seq.applyBatch(sb, ops, by);
    await this.seq.commit(sb, entry, null);
    return entry;
  }

  /* ---------- disk changes (R8.12–R8.14) ---------- */
  diskChanged(sb, text, eol, hash) {
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
    this.replaceText(sb, m.text, DISK_BY).then(() => {
      sb.savedText = text; sb.savedHash = hash; this.writeSaved(sb); sb.setDiskChanged(null); this.sendMeta(sb);
      this.log.info('disk', { buf: sb.id, change: 'merged', ver: sb.ver });
    }).catch(e => this.log.error('disk', { buf: sb.id, error: e.message }));
  }

  /* ---------- journal compaction (R8.5) ---------- */
  async compact(sb) {
    if (!sb.journal || sb.big) return;
    await sb.journal.drain();
    const text = sb.text;
    /* Snapshot at the version where the retained history begins, so dedup and undo survive a restart. */
    const baseVer = sb.hist.length ? sb.hist[0].ver - 1 : sb.ver;
    const baseText = sb.hist.length ? OT.textBefore(text, sb.hist) : text;
    writeAtomic(jidPath(this.stateDir, sb.jid, '.snap'), baseText);
    sb.journal.close();
    sb.journal = Journal.create(sb.journal.file, journalHeader({ jid: sb.jid, id: sb.id, name: sb.name, file: sb.file, mode: sb.ed.mode, baseVer, baseText }),
      sb.hist.map(b => ({ t: 'b', ver: b.ver, cid: b.cid, seq: b.seq, by: b.by, ops: b.ops, undo: b.undo, at: b.at })));
    this.index.set(sb.indexEntry());
  }

  /* ---------- kill (R6.3) ---------- */
  kill(sb) {
    const L = globalThis.L;
    if (this.Ed.E.buffers.includes(sb.ed)) L.call('kill-buffer', [sb.ed]); else this.forget(sb);
  }
  /* The Edwin buffer is gone: tell the clients, drop the journal. */
  forget(sb) {
    for (const c of sb.clients) { c.send({ t: 'killed', buf: sb.id }); c.buffers.delete(sb); }
    sb.clients.clear();
    if (sb.autosave) clearTimeout(sb.autosave);
    if (sb.journal) { sb.journal.close(); for (const ext of ['.jsonl', '.snap', '.saved']) { try { fs.unlinkSync(jidPath(this.stateDir, sb.jid, ext)); } catch (e) { /* gone */ } } }
    this.byId.delete(sb.id); this.byJid.delete(sb.jid); this.index.delete(sb.jid);
    if (sb.serverEdit) { for (const w of sb.serverEdit.waiters) w(sb.serverEdit.saved ? 0 : 1); sb.serverEdit = null; }
    if (this.hooks.killed) this.hooks.killed(sb);
    this.log.info('kill', { buf: sb.id });
  }

  /* ---------- buffer-list (§13.1) ---------- */
  list() {
    return this.all().map(sb => ({ id: sb.id, name: sb.name, mode: sb.ed.mode, modified: sb.modified, readOnly: sb.readOnly, ver: sb.ver, file: sb.file, writers: sb.attached() }));
  }

  /* ---------- undo (R6.19–R6.21) ---------- */
  /* Undo the newest group of SB matching PICK(batch); returns {ver, partial} or null. */
  async undoWhere(sb, pick, by, { cid = null, seq = null } = {}) {
    const undone = new Set(sb.hist.filter(b => b.undo && b.undo.of !== undefined).map(b => `${b.undo.ofCid || b.cid}:${b.undo.of}`));
    const groups = sb.hist.filter(b => b.undo && b.undo.of === undefined && pick(b) && !undone.has(`${b.cid}:${b.undo.g}`));
    if (!groups.length) return null;
    const g = groups[groups.length - 1];
    const r = this.seq.undoOps(sb, { cid: g.cid, g: g.undo.g });
    if (!r) return null;
    /* The undo batch names the group and its writer (undo.ofCid), so the pair cancels in later undo
       computations whoever asked for it. */
    const entry = this.seq.applyBatch(sb, r.ops, by, { cid, seq, undo: { g: 'undo-' + sb.ver + '-' + randomId(4), of: g.undo.g, ofCid: g.cid } });
    await this.seq.commit(sb, entry, null);
    return { ver: entry.ver, partial: r.partial, of: g.undo.g, by: g.by };
  }

  async shutdown() {
    this.watcher.close();
    for (const sb of this.all()) { if (sb.autosave) { clearTimeout(sb.autosave); sb.autosave = null; } if (sb.journal) { await sb.journal.drain(); sb.journal.close(); } }
    this.index.write();
  }
}
