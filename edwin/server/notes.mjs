// The notes index (spec §11): every *.md and *.org under notesDir parsed under the grammar of
// edwin/scm/notes-syntax.scm into file, heading, block, link, task and card records (R11.1–R11.3), kept fresh
// from buffer edits (300 ms after the last one, from the live text), from file system events and a 10 s sweep
// (R11.4), parsed in a worker thread (R11.5), snapshotted to <stateDir>/notes-index/index.json (R11.6), and
// announced to every client as notes{gen} on each change (R11.7). The server commands behind wb-web's /api
// routes (§11.3) and the Lisp procedures of §11.4 read it; the writes among them are edits to buffers (R11.9).
import fs from 'node:fs';
import path from 'node:path';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { ProtoError } from './proto.mjs';
import { writeAtomic } from './files.mjs';
import { PathError, under } from './paths.mjs';
import { parseFile, compileGrammar, NOTE_EXT, ignoreMatcher } from './notes-parse.mjs';

export const name = 'notes';
export const EDIT_DEBOUNCE_MS = 300;
export const FS_DEBOUNCE_MS = 200;
export const SWEEP_MS = 10000;
export const SNAPSHOT_MS = 60000;
export const PARSE_CHUNK = 64;
export const GREP_MAX = 5000;
const SYNC_TIMEOUT_MS = 30000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCM_FILE = path.join(HERE, '..', 'scm', 'notes-syntax.scm');
const PARSER = new URL('./notes-parse.mjs', import.meta.url);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z][\w-]*$/;

const param = args => (Array.isArray(args) && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {});
const bad = (msg) => new ProtoError('bad_request', msg);
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/* The shorter path wins an ambiguity (R11.3), then the lexicographically smaller. */
const shortest = ids => [...ids].sort((a, b) => a.length - b.length || byPath(a, b))[0];
const stripExt = p => p.replace(/\.[^./]+$/, '');
const publicTask = t => { const { endLine, fields, ...rest } = t; return rest; };
const publicFile = f => { const { orgId, line, ...rest } = f; return rest; };
const publicHeading = h => { const { orgId, ...rest } = h; return rest; };

export class Notes {
  constructor(server) {
    this.server = server; this.log = server.log; this.L = server.L; this.S = server.L.S;
    this.root = server.cfg.notesDir; this.realRoot = server.auth.realNotesDir();
    this.stateFile = path.join(server.cfg.stateDir, 'notes-index', 'index.json');
    this.files = new Map();          // id -> {id, mtimeMs, size, rec, fromBuffer}
    this.gen = 0; this.cache = null; this.dirty = false;
    this.jobs = new Map(); this.jobSeq = 0; this.worker = null; this.workerStarts = 0;
    this.bufferTimers = new Map(); this.fsTimers = new Map();
    this.sweeping = null; this.sweepTimer = null; this.broadcastTimer = null;
    this.startup = { total: 0, parsed: 0, reused: 0, buffers: 0, ms: 0 };
    this.watcher = null; this.recursiveWatch = false;
  }

  /* ---------- grammar and Scheme ---------- */
  loadGrammar() {
    this.L.evalText(fs.readFileSync(SCM_FILE, 'utf8'));
    const alist = this.L.call('notes-grammar', []);
    const g = {};
    for (const p of this.S.arr(alist)) {
      if (!(p instanceof this.S.Pair) || !(p.car instanceof this.S.Sym)) throw new Error('notes-grammar: not an alist');
      g[p.car.name] = p.cdr instanceof this.S.Pair || p.cdr === this.S.NIL ? this.S.arr(p.cdr) : p.cdr;
    }
    this.grammar = g; this.G = compileGrammar(g);
  }
  ignorePatterns() {
    try { const v = this.L.get('notes-index-ignore'); return v === undefined || v === false ? [] : this.S.arr(v).filter(x => typeof x === 'string'); } catch (e) { return []; }
  }
  /* A JS value as Scheme data: objects become alists with symbol keys, arrays lists, null #f. */
  toScm(v) {
    const S = this.S;
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return S.listOf(v.map(x => this.toScm(x)));
    if (typeof v === 'object') return S.listOf(Object.entries(v).map(([k, x]) => new S.Pair(S.intern(k), this.toScm(x))));
    return v;
  }
  fromScm(v) {
    const S = this.S;
    if (v === false || v === undefined) return null;
    if (v instanceof S.Sym) return v.name;
    if (v instanceof S.Pair || v === S.NIL) return S.arr(v).map(x => this.fromScm(x));
    return v;
  }
  /* Keyword arguments (:kind "task" :tag "x") as an object. */
  filtersOf(args) {
    const S = this.S, out = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a instanceof S.Sym && a.name.length > 1 && a.name[0] === ':') { out[a.name.slice(1)] = this.fromScm(args[++i]); }
      else throw new S.SchemeError('wrong-type-argument', `notes-query: expected a keyword, got ${S.write(a)}`, [a]);
    }
    return out;
  }

  /* ---------- the worker (R11.5) ---------- */
  startWorker() {
    if (this.worker) return;
    const sab = new SharedArrayBuffer(4);
    this.signal = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    this.syncPort = port1;
    const w = new Worker(PARSER, { workerData: { notesWorker: true, grammar: this.grammar, syncPort: port2, signal: this.signal }, transferList: [port2] });
    this.worker = w; this.workerStarts++;
    w.unref();
    w.on('message', msg => this.onWorkerMessage(msg));
    w.on('error', e => { this.log.error('notes', { worker: 'error', error: e.message }); });
    w.on('exit', code => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const j of this.jobs.values()) j.reject(new Error(`notes worker exited with ${code}`));
      this.jobs.clear();
      if (!this.stopped && this.workerStarts < 5) { this.log.warn('notes', { worker: 'restart', code }); this.startWorker(); }
      else if (!this.stopped) this.log.error('notes', { worker: 'gave up', code });
    });
  }
  onWorkerMessage(msg) {
    const j = this.jobs.get(msg.jobId);
    if (msg.t === 'parsed') { this.apply(msg.results); if (j) { this.jobs.delete(msg.jobId); j.resolve(msg.results); } return; }
    if (!j) return;
    this.jobs.delete(msg.jobId);
    if (msg.t === 'error') j.reject(new Error(msg.error)); else j.resolve(msg.files ?? msg);
  }
  job(msg) {
    if (!this.worker) this.startWorker();
    const jobId = ++this.jobSeq;
    return new Promise((resolve, reject) => { this.jobs.set(jobId, { resolve, reject }); this.worker.postMessage({ ...msg, jobId }); });
  }
  /* A job answered on the synchronous channel: the main thread waits on the shared signal and reads the one
     reply. Used by the Lisp procedures (notes-grep, unlinked-mentions) until Scheme can block (S.block). */
  syncJob(msg) {
    if (!this.worker) this.startWorker();
    const jobId = ++this.jobSeq;
    Atomics.store(this.signal, 0, 0);
    this.syncPort.postMessage({ ...msg, jobId });
    const r = Atomics.wait(this.signal, 0, 0, SYNC_TIMEOUT_MS);
    if (r === 'timed-out') throw new Error('the notes worker did not answer in time');
    const m = receiveMessageOnPort(this.syncPort);
    if (!m || !m.message) throw new Error('the notes worker sent no reply');
    if (m.message.error) throw new Error(m.message.error);
    return m.message;
  }

  /* ---------- the index ---------- */
  /* Apply parse results from the worker or an in-process parse; bumps the generation when anything changed. */
  apply(results) {
    let changed = false;
    for (const r of results) {
      const old = this.files.get(r.id);
      if (r.skipped || r.error) {
        if (r.error) this.log.warn('notes', { file: r.id, error: r.error });
        if (old) { this.files.delete(r.id); changed = true; }
        continue;
      }
      /* The live buffer's text wins over a disk parse (R11.4). */
      if (!r.fromBuffer && this.bufferFor(r.id) && old && old.fromBuffer) continue;
      this.files.set(r.id, { id: r.id, mtimeMs: r.mtimeMs, size: r.size, rec: r.rec, fromBuffer: !!r.fromBuffer });
      changed = true;
    }
    if (changed) this.changed();
  }
  changed() {
    this.gen++; this.cache = null; this.dirty = true;
    try { this.L.set('notes-generation', this.gen); } catch (e) { /* the variable is defined by notes-syntax.scm */ }
    if (!this.broadcastTimer) this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const msg = { t: 'notes', gen: this.gen };
      for (const c of this.server.clients) if (c.hello && !c.closed) c.send(msg);
    }, 20);
  }
  /* The derived views: link resolution (R11.3), backlinks, the row lists of §11.3. */
  derived() {
    if (this.cache) return this.cache;
    const ids = [...this.files.keys()].sort(byPath);
    const byTitle = new Map(), byAlias = new Map(), byPathNoExt = new Map(), byAnchor = new Map(), byOrgId = new Map();
    const add = (m, k, v) => { if (!k) return; k = k.toLowerCase(); let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } s.add(v); };
    for (const id of ids) {
      const { rec } = this.files.get(id), f = rec.file;
      add(byTitle, f.title, id);
      for (const a of f.aliases) add(byAlias, a, id);
      byPathNoExt.set(stripExt(id).toLowerCase(), id);
      if (f.orgId) byOrgId.set(f.orgId, id);
      for (const h of rec.headings) if (h.orgId) byOrgId.set(h.orgId, id);
      for (const b of rec.blocks) { const an = b.id.slice(b.id.lastIndexOf('#^') + 2); add(byAnchor, an, id); }
    }
    const ambiguous = [];
    const pick = (set, link) => {
      if (!set || !set.size) return null;
      if (set.size === 1) return [...set][0];
      const chosen = shortest(set);
      if (link) ambiguous.push({ src: link.src, srcFile: link.srcFile, dst: link.dst, line: link.line, candidates: [...set].sort(byPath), chosen });
      return chosen;
    };
    /* R11.3: a title, an alias, or the path without its extension, case-insensitively. */
    const resolveName = (name, link) => {
      const k = name.toLowerCase().replace(/^\.\//, '');
      const set = new Set();
      for (const m of [byTitle, byAlias]) for (const id of m.get(k) || []) set.add(id);
      const p = byPathNoExt.get(k); if (p) set.add(p);
      return pick(set, link);
    };
    const resolveLink = (l) => {
      const t = l.dst;
      switch (l.kind) {
        case 'url': return null;
        case 'title': return byOrgId.get(t.replace(/^id:/i, '').trim()) || null;
        case 'file': {
          let rel = t.replace(/^file:/i, '').split('#')[0].trim();
          if (rel.startsWith('/')) { if (under(rel, this.realRoot) && rel !== this.realRoot) rel = rel.slice(this.realRoot.length + 1); else if (under(rel, this.root) && rel !== this.root) rel = rel.slice(this.root.length + 1); else return null; }
          const fromSrc = path.posix.normalize(path.posix.join(path.posix.dirname(l.srcFile), rel));
          for (const c of [fromSrc, path.posix.normalize(rel)]) { if (this.files.has(c)) return c; const p = byPathNoExt.get(stripExt(c).toLowerCase()); if (p) return p; }
          return resolveName(stripExt(rel), l);
        }
        case 'ref': {
          if (t.startsWith('^')) return pick(byAnchor.get(t.slice(1).toLowerCase()), l);
          const name = t.split(' › ')[0].split('#')[0].trim();
          return name ? resolveName(name, l) : l.srcFile;
        }
        default: {
          const name = t.split('#')[0].split('|')[0].trim();
          return name ? resolveName(name, l) : l.srcFile;
        }
      }
    };
    const links = [], backlinks = {}, outlinks = {}, files = {}, nodes = [], tasks = [], cards = [];
    for (const id of ids) {
      const { rec } = this.files.get(id);
      files[id] = { title: rec.file.title, path: id };
      nodes.push(publicFile(rec.file));
      for (const r of [...rec.headings.map(publicHeading), ...rec.blocks].sort((a, b) => a.line - b.line || (a.kind === 'heading' ? -1 : 1))) nodes.push(r);
      for (const t of rec.tasks) tasks.push(publicTask(t));
      for (const c of rec.cards) cards.push(c);
      for (const l0 of rec.links) {
        const l = { ...l0, dstFile: resolveLink(l0) };
        links.push(l);
        if (l.dstFile && l.dstFile !== l.srcFile) { backlinks[l.dstFile] = (backlinks[l.dstFile] || 0) + 1; outlinks[l.srcFile] = (outlinks[l.srcFile] || 0) + 1; }
      }
    }
    this.cache = { ids, files, nodes, tasks, cards, links, backlinks, outlinks, ambiguous, resolveName: n => resolveName(n, null), byAnchor };
    return this.cache;
  }
  /* The file id named by X: an id, a path without extension, a title or an alias. */
  fileIdOf(x) {
    if (typeof x !== 'string' || !x) return null;
    const id = x.replace(/^\.\//, '');
    if (this.files.has(id)) return id;
    return this.derived().resolveName(id);
  }

  /* ---------- buffers (R11.4) ---------- */
  /* The notesDir-relative id of a buffer that the index covers, else null. */
  noteIdOf(sb) {
    if (!sb || !sb.file || sb.special || sb.big) return null;
    if (!under(sb.file, this.realRoot) || sb.file === this.realRoot) return null;
    const id = sb.file.slice(this.realRoot.length + 1);
    if (!NOTE_EXT.test(id) || id.split('/').some(s => s.startsWith('.') && s.length > 1 && s !== '..')) return null;
    if (ignoreMatcher(this.ignorePatterns())(id, false)) return null;
    return id;
  }
  bufferFor(id) { return this.server.buffers.byFile(path.join(this.realRoot, id)) || this.server.buffers.byFile(path.join(this.root, id)); }
  scheduleBuffer(sb) {
    const id = this.noteIdOf(sb);
    if (!id) return;
    const t = this.bufferTimers.get(sb);
    if (t) clearTimeout(t);
    this.bufferTimers.set(sb, setTimeout(() => { this.bufferTimers.delete(sb); this.indexBuffer(sb).catch(e => this.log.warn('notes', { buf: sb.id, error: e.message })); }, EDIT_DEBOUNCE_MS));
  }
  /* Re-parse SB's live text in the worker (the text is copied once). */
  indexBuffer(sb) {
    const id = this.noteIdOf(sb);
    if (!id || !this.server.buffers.byJid.has(sb.jid)) return Promise.resolve();
    return this.job({ t: 'parse', items: [{ id, text: sb.text, mtimeMs: -1 }] });
  }
  /* Re-parse SB now, in this thread: after an edit the server itself made, so the next read sees it. */
  indexBufferNow(sb) {
    const id = this.noteIdOf(sb);
    if (!id) return;
    const t = this.bufferTimers.get(sb); if (t) { clearTimeout(t); this.bufferTimers.delete(sb); }
    const rec = parseFile(id, sb.text, this.G);
    rec.file.mtime = null;
    this.apply([{ id, mtimeMs: -1, size: sb.text.length, rec, fromBuffer: true }]);
  }
  /* A buffer's file was saved or seen on disk unchanged from the buffer: key its entry by the disk state so
     a restart need not parse it again. */
  refreshStat(id, sb) {
    const e = this.files.get(id);
    if (!e || !sb || sb.modified) return;
    try { const st = fs.statSync(sb.file); e.mtimeMs = st.mtimeMs; e.size = st.size; e.fromBuffer = false; this.dirty = true; } catch (err) { /* gone; the sweep will see */ }
  }

  /* ---------- disk (R11.4, R11.1) ---------- */
  startWatch() {
    try {
      this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (ev, fname) => this.onFsEvent(fname));
      this.watcher.on('error', e => { this.log.warn('notes', { watch: 'error', error: e.message }); this.recursiveWatch = false; try { this.watcher.close(); } catch (x) { /* closed */ } this.watcher = null; });
      this.recursiveWatch = true;
    } catch (e) { this.log.warn('notes', { watch: 'unavailable', error: e.message }); this.recursiveWatch = false; }
    this.sweepTimer = setInterval(() => this.sweep().catch(e => this.log.warn('notes', { sweep: e.message })), SWEEP_MS);
    this.sweepTimer.unref();
    this.snapshotTimer = setInterval(() => this.snapshot(), SNAPSHOT_MS);
    this.snapshotTimer.unref();
  }
  onFsEvent(fname) {
    if (this.stopped) return;
    if (!fname) { this.scheduleSweep(500); return; }
    const rel = String(fname).split(path.sep).join('/');
    if (NOTE_EXT.test(rel) && !rel.split('/').some(s => s.startsWith('.')) && !ignoreMatcher(this.ignorePatterns())(rel, false)) {
      const t = this.fsTimers.get(rel); if (t) clearTimeout(t);
      this.fsTimers.set(rel, setTimeout(() => { this.fsTimers.delete(rel); this.checkFile(rel); }, FS_DEBOUNCE_MS));
      return;
    }
    /* A directory came or went: the sweep finds what is inside. */
    try { if (fs.statSync(path.join(this.root, rel)).isDirectory()) this.scheduleSweep(500); } catch (e) { /* a file we do not index */ }
  }
  checkFile(rel) {
    const abs = path.join(this.root, rel), sb = this.bufferFor(rel);
    if (sb) { this.refreshStat(rel, sb); return; }
    let st;
    try { st = fs.statSync(abs); } catch (e) { if (this.files.delete(rel)) this.changed(); return; }
    if (!st.isFile()) return;
    const e = this.files.get(rel);
    if (e && !e.fromBuffer && e.mtimeMs === st.mtimeMs && e.size === st.size) return;
    this.job({ t: 'parse', items: [{ id: rel, file: abs }] }).catch(err => this.log.warn('notes', { file: rel, error: err.message }));
  }
  scheduleSweep(ms) { if (this.sweepSoon) return; this.sweepSoon = setTimeout(() => { this.sweepSoon = null; this.sweep().catch(e => this.log.warn('notes', { sweep: e.message })); }, ms); this.sweepSoon.unref(); }
  /* Scan the tree in the worker and parse what differs from the index (FULL: everything). */
  async refresh(full) {
    const t0 = Date.now();
    const scanned = await this.job({ t: 'scan', root: this.root, ignore: this.ignorePatterns() });
    if (this.stopped) return { files: 0, parsed: 0, ms: 0 };
    const seen = new Set(), items = [];
    let reused = 0;
    for (const f of scanned) {
      seen.add(f.id);
      const e = this.files.get(f.id);
      const sb = this.bufferFor(f.id);
      /* An open buffer is the truth for its file: parse its text when the entry is missing or the buffer holds
         unsaved changes (a journal replayed at start). */
      if (sb) { if (!e || sb.modified) items.push({ id: f.id, text: sb.text, mtimeMs: -1 }); else reused++; continue; }
      if (full || !e || e.fromBuffer || e.mtimeMs !== f.mtimeMs || e.size !== f.size) items.push({ id: f.id, file: path.join(this.root, f.id) });
      else reused++;
    }
    let dropped = false;
    for (const id of [...this.files.keys()]) if (!seen.has(id) && !this.bufferFor(id)) { this.files.delete(id); dropped = true; }
    if (dropped) this.changed();
    const chunks = [];
    for (let i = 0; i < items.length; i += PARSE_CHUNK) chunks.push(items.slice(i, i + PARSE_CHUNK));
    await Promise.all(chunks.map(c => this.job({ t: 'parse', items: c })));
    return { files: scanned.length, parsed: items.length, reused, ms: Date.now() - t0 };
  }
  sweep() {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.refresh(false).finally(() => { this.sweeping = null; });
    return this.sweeping;
  }
  async rebuild() {
    const r = await this.refresh(true);
    this.log.info('notes', { rebuild: r.files, ms: r.ms });
    return { files: r.files, ms: r.ms };
  }

  /* ---------- snapshot (R11.6) ---------- */
  loadSnapshot() {
    let snap;
    try { snap = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') this.log.warn('notes', { snapshot: 'unreadable', error: e.message }); return; }
    if (!snap || snap.v !== 1 || !Array.isArray(snap.files)) { this.log.warn('notes', { snapshot: 'ignored', reason: 'unknown format' }); return; }
    for (const e of snap.files) if (e && typeof e.id === 'string' && e.rec && e.rec.file) this.files.set(e.id, { id: e.id, mtimeMs: e.mtimeMs, size: e.size, rec: e.rec, fromBuffer: !!e.fromBuffer });
    this.gen = Number.isInteger(snap.gen) ? snap.gen : 0;
  }
  snapshot() {
    if (!this.dirty) return false;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      writeAtomic(this.stateFile, JSON.stringify({ v: 1, gen: this.gen, at: Date.now(), files: [...this.files.values()] }));
      this.dirty = false;
      return true;
    } catch (e) { this.log.warn('notes', { snapshot: 'failed', error: e.message }); return false; }
  }

  /* ---------- install ---------- */
  async install() {
    const { server } = this;
    this.loadGrammar();
    this.startWorker();
    this.loadSnapshot();
    const t0 = Date.now();
    this.ready = this.refresh(false).then(r => {
      this.startup = { total: r.files, parsed: r.parsed, reused: r.reused, ms: Date.now() - t0 };
      this.log.info('notes', { start: r.files, parsed: r.parsed, reused: r.reused, ms: this.startup.ms, gen: this.gen, watch: this.recursiveWatch ? 'recursive' : 'sweep' });
    }).catch(e => this.log.error('notes', { start: 'failed', error: e.message }));
    server.buffers.on('afterBatch', sb => this.scheduleBuffer(sb));
    server.buffers.on('saved', sb => { const id = this.noteIdOf(sb); if (id) this.refreshStat(id, sb); });
    server.buffers.on('killed', sb => { const id = this.noteIdOf(sb); if (!id) return; const t = this.bufferTimers.get(sb); if (t) { clearTimeout(t); this.bufferTimers.delete(sb); } this.checkFile(id); });
    this.startWatch();
    server.statusProviders.push(() => ({ notesExists: this.exists(), notesGen: this.gen }));
    this.defineCommands();
    this.definePrimitives();
  }
  async shutdown() {
    this.stopped = true;
    if (this.watcher) { try { this.watcher.close(); } catch (e) { /* closed */ } }
    clearInterval(this.sweepTimer); clearInterval(this.snapshotTimer); clearTimeout(this.sweepSoon); clearTimeout(this.broadcastTimer);
    for (const t of this.bufferTimers.values()) clearTimeout(t);
    for (const t of this.fsTimers.values()) clearTimeout(t);
    /* Buffers edited in the last 300 ms are indexed now so the snapshot has them. */
    for (const sb of [...this.bufferTimers.keys()]) { try { this.indexBufferNow(sb); } catch (e) { /* skip */ } }
    this.bufferTimers.clear();
    this.snapshot();
    if (this.worker) { const w = this.worker; this.worker = null; await w.terminate().catch(() => {}); }
    for (const j of this.jobs.values()) j.reject(new Error('edwind is stopping'));
    this.jobs.clear();
  }
  exists() { try { return fs.statSync(this.root).isDirectory(); } catch (e) { return false; } }

  /* ---------- the writes (R11.9): edits to buffers, never direct file writes ---------- */
  /* Attribution of a write made for a web client: its by when it names one, else the client's own. */
  byOf(by, client) {
    if (by && typeof by === 'object' && typeof by.kind === 'string' && ['agent', 'frame', 'web', 'cli'].includes(by.kind)) {
      const out = {}; for (const [k, v] of Object.entries(by)) if (typeof v === 'string' && k.length <= 32 && v.length <= 256) out[k] = v; return out;
    }
    if (typeof by === 'string' && by) return { kind: 'agent', agent: by.slice(0, 256) };
    return client.by();
  }
  /* The buffer of the notesDir-relative ID (opened or created); a path outside notesDir is bad_request. */
  noteBuffer(id, create) {
    if (typeof id !== 'string' || !id) throw bad('path is required');
    if (id.startsWith('/') || id.startsWith('~') || id.startsWith('name:') || id.includes('\0')) throw bad(`path must be relative to the notes directory: ${JSON.stringify(id)}`);
    const segs = id.split('/');
    if (segs.some(s => s === '' || s === '.' || s === '..')) throw bad(`bad relative path ${JSON.stringify(id)}`);
    if (create) {
      /* A new note may sit in a directory that does not exist yet: make it, inside notesDir only. */
      const cand = path.join(this.realRoot, id);
      if (!under(cand, this.realRoot) || cand === this.realRoot) throw bad(`${id} is outside the notes directory`);
      try { this.server.auth.checkWrite(cand); } catch (e) { throw new ProtoError('refused_path', e.message); }
      try { fs.mkdirSync(path.dirname(cand), { recursive: true, mode: 0o700 }); } catch (e) { throw bad(`${id}: ${e.code || e.message}`); }
    }
    let p;
    try { p = this.server.auth.parseId(id); } catch (e) { if (e instanceof PathError) throw bad(`${id}: ${e.message}`); throw e; }
    if (!under(p.real, this.realRoot) || p.real === this.realRoot) throw bad(`${id} is outside the notes directory`);
    if (create && !p.exists) { try { this.server.auth.checkWrite(p.real); } catch (e) { throw new ProtoError('refused_path', e.message); } }
    let sb = this.server.buffers.resolve(id, create);
    if (sb.moved) sb = this.server.buffers.resolve(sb.moved, create);
    if (sb.readOnly) throw new ProtoError('read_only', String(sb.readOnly));
    return sb;
  }
  async editBuffer(sb, ops, by) {
    const seq = this.server.buffers.seq;
    const entry = seq.applyBatch(sb, ops, by);
    await seq.commit(sb, entry, null);
    this.indexBufferNow(sb);
    return entry;
  }
  findTask(id) {
    if (typeof id !== 'string' || !id) return null;
    const { tasks } = this.derived();
    const an = id.replace(/^\^/, '');
    return tasks.find(t => t.id === id) || tasks.find(t => t.node === id) || tasks.find(t => t.node.endsWith('#^' + an)) || null;
  }
  /* POST /api/task/{id}: the keyword and the session::/dispatched:: fields of a task, as one edit batch. */
  async taskSet(client, p) {
    const t0 = this.findTask(p.id);
    if (!t0) throw bad(`no task ${p.id}`);
    const kw = p.kw === undefined || p.kw === null ? null : p.kw;
    if (kw !== null && !this.G.kws.includes(kw)) throw bad(`unknown task keyword ${JSON.stringify(kw)}`);
    const set = p.set && typeof p.set === 'object' && !Array.isArray(p.set) ? p.set : {};
    for (const [k, v] of Object.entries(set)) if (!KEY_RE.test(k) || typeof v !== 'string' || /[\n\r]/.test(v)) throw bad(`bad field ${JSON.stringify(k)}`);
    const sb = this.noteBuffer(t0.path, false);
    const text = sb.text, lines = text.split('\n');
    const live = parseFile(t0.path, text, this.G).tasks;
    const t = live.find(x => x.line === t0.line && x.title === t0.title) || live.find(x => x.node === t0.node && x.title === t0.title) || live.find(x => x.line === t0.line) || live.find(x => x.title === t0.title && x.kw === t0.kw);
    if (!t) throw bad(`task ${p.id} is not in the current text of ${t0.path}`);
    const offsets = [0]; for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
    const head = lines[t.line - 1], hm = this.G.task.exec(head);
    if (!hm) throw bad(`task ${p.id} is not in the current text of ${t0.path}`);
    const edits = [];
    if (kw !== null && kw !== hm[3]) edits.push([offsets[t.line - 1] + hm[1].length + hm[2].length, hm[3], kw]);
    const isBullet = !(/\.org$/i.test(t.path) && /^\*+\s/.test(hm[2])) && /^(?:[-*+]|\d+[.)])\s/.test(hm[2]);
    const indent = isBullet ? ' '.repeat(hm[1].length + 2) : (hm[2].trim() ? '' : hm[1]);
    const inserts = [];
    for (const [k, v] of Object.entries(set)) {
      let done = false;
      for (let j = t.line; j < t.endLine && j < lines.length; j++) {
        const fm = this.G.field.exec(lines[j]);
        if (!fm || fm[1].toLowerCase() !== k.toLowerCase()) continue;
        const start = lines[j].indexOf('::') + 2, vs = lines[j].indexOf(fm[2], start);
        edits.push([offsets[j] + vs, fm[2], v]); done = true; break;
      }
      if (!done) inserts.push(`\n${indent}${k}:: ${v}`);
    }
    if (inserts.length) edits.push([offsets[t.line - 1] + head.length, '', inserts.join('')]);
    if (!edits.length) return { value: publicTask(t), msg: 'nothing to change' };
    edits.sort((a, b) => a[0] - b[0]);
    const ops = []; let delta = 0;
    for (const [pos, del, ins] of edits) { ops.push([pos + delta, del, ins]); delta += ins.length - del.length; }
    await this.editBuffer(sb, ops, this.byOf(p.by, client));
    this.log.info('notes', { task: t.id, kw, fields: Object.keys(set) });
    const now = this.derived().tasks.find(x => x.path === t.path && x.line === t.line) || null;
    return { value: now };
  }
  /* POST /api/journal {day}: journal/<day>.md from journal-template when absent. */
  async journal(client, p) {
    const day = p.day;
    if (typeof day !== 'string' || !DAY_RE.test(day)) throw bad('day must be YYYY-MM-DD');
    let ext = 'md';
    try { const f = this.L.get('journal-format'); if (f === 'org' || (f instanceof this.S.Sym && f.name === 'org')) ext = 'org'; } catch (e) { /* default */ }
    const id = `journal/${day}.${ext}`;
    const existing = this.server.buffers.byId.get(id) || this.bufferFor(id);
    if (existing || fs.existsSync(path.join(this.root, id))) return { value: { path: id, created: false } };
    const sb = this.noteBuffer(id, true);
    let text;
    const tpl = this.L.get('journal-template');
    if (typeof tpl === 'function') text = this.S.callProc(tpl, [day]);
    else if (typeof tpl === 'string') text = tpl.replace(/<day>/g, day);
    else text = ext === 'org' ? `#+title: ${day}\n\n` : `# ${day}\n\n`;
    if (typeof text !== 'string') throw bad('journal-template did not give a string');
    const by = this.byOf(p.by, client);
    if (text) await this.editBuffer(sb, [[0, sb.text, text]], by);
    await this.server.buffers.save(sb);
    this.log.info('notes', { journal: id, created: true });
    return { value: { path: id, created: true } };
  }
  /* POST /api/notes/append {path, text, by}: TEXT appended to the note as an edit, on its own lines. */
  async append(client, p) {
    if (typeof p.text !== 'string') throw bad('text must be a string');
    const sb = this.noteBuffer(p.path, true);
    const cur = sb.text;
    let ins = p.text;
    if (cur.length && !cur.endsWith('\n')) ins = '\n' + ins;
    if (ins.length && !ins.endsWith('\n')) ins += '\n';
    if (ins) await this.editBuffer(sb, [[cur.length, '', ins]], this.byOf(p.by, client));
    this.log.info('notes', { append: sb.id, chars: ins.length });
    return { value: { path: sb.id } };
  }
  /* The review log (DESIGN §3.3): <notesDir>/.reviews/*.jsonl, one JSON object per line. */
  reviewsDir() { return path.join(this.root, '.reviews'); }
  readReviews() {
    const dir = this.reviewsDir(), out = [];
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort(); } catch (e) { return { dir, reviews: out }; }
    for (const n of names) {
      let text;
      try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { continue; }
      for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (e) { /* a torn line */ } }
    }
    return { dir, reviews: out };
  }
  appendReviews(p) {
    const reviews = p.reviews;
    if (!Array.isArray(reviews) || !reviews.every(r => r && typeof r === 'object')) throw bad('reviews must be a list of objects');
    const dir = this.reviewsDir(), file = path.join(dir, `${this.server.cfg.host}.jsonl`);
    try { this.server.auth.checkWrite(file); } catch (e) { throw new ProtoError('refused_path', e.message); }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (reviews.length) fs.appendFileSync(file, reviews.map(r => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    return { dir, appended: reviews.length };
  }

  /* ---------- the server commands (§11.3) ---------- */
  defineCommands() {
    const { server } = this;
    const ready = () => this.ready.catch(() => {});
    const def = (cmd, fn) => server.defineCommand(cmd, async (client, args, ctx, buf) => { await ready(); return fn(client, param(args), args, ctx, buf); });
    def('notes-nodes', (c, p) => {
      const lim = Number.isInteger(p.limit) ? p.limit : typeof p.limit === 'string' && /^\d+$/.test(p.limit) ? Number(p.limit) : Infinity;
      return { value: { root: this.root, nodes: this.derived().nodes.slice(0, lim) } };
    });
    def('notes-links', () => { const d = this.derived(); return { value: { files: d.files, links: d.links, backlinks: d.backlinks, outlinks: d.outlinks } }; });
    def('notes-cards', () => ({ value: { root: this.root, exists: this.exists(), cards: this.derived().cards } }));
    def('notes-reviews', () => ({ value: this.readReviews() }));
    def('notes-reviews-append', (c, p) => ({ value: this.appendReviews(p) }));
    def('notes-tasks', () => ({ value: { host: server.cfg.host, tasks: this.derived().tasks } }));
    def('notes-task', (c, p, args) => {
      const id = typeof args[0] === 'string' ? args[0] : p.id;
      const t = this.findTask(id);
      if (!t) throw bad(`no task ${id}`);
      return { value: t };
    });
    def('notes-task-set', (c, p) => this.taskSet(c, p));
    def('notes-journal', (c, p) => this.journal(c, p));
    def('notes-append', (c, p) => this.append(c, p));
    def('notes-info', () => ({ value: { root: this.root, exists: this.exists(), gen: this.gen, files: this.files.size, ready: true, startup: this.startup, watch: this.recursiveWatch ? 'recursive' : 'sweep', worker: !!this.worker } }));
    def('notes-rebuild', async () => ({ value: await this.rebuild() }));
    def('notes-ambiguous-links', () => ({ value: this.derived().ambiguous }));
    def('notes-grammar', () => ({ value: this.grammar }));
  }

  /* ---------- from Lisp (§11.4) ---------- */
  query(f) {
    const d = this.derived();
    let rows;
    const kind = f.kind;
    if (kind === 'task' || f['task-kw'] !== undefined || f['due-before'] !== undefined) rows = d.tasks;
    else if (kind === 'card') rows = d.cards;
    else if (kind === 'link') rows = d.links;
    else rows = kind ? d.nodes.filter(r => r.kind === kind) : d.nodes;
    if (f.tag) { const tag = String(f.tag).replace(/^#/, '').toLowerCase(); rows = rows.filter(r => (r.tags || []).some(t => t.toLowerCase() === tag)); }
    if (f.text) { const q = String(f.text).toLowerCase(); rows = rows.filter(r => [r.title, r.body, r.prompt, r.front, r.back, r.text, r.dst].some(s => typeof s === 'string' && s.toLowerCase().includes(q))); }
    if (f.path) { const p = String(f.path).replace(/\/$/, ''); rows = rows.filter(r => { const rp = r.path || r.srcFile || ''; return rp === p || rp.startsWith(p + '/') || rp.startsWith(p); }); }
    if (f['linked-from']) { const src = this.fileIdOf(f['linked-from']); const set = new Set(d.links.filter(l => l.srcFile === src && l.dstFile).map(l => l.dstFile)); rows = rows.filter(r => set.has(r.path || r.srcFile)); }
    if (f['linked-to']) { const dst = this.fileIdOf(f['linked-to']); const set = new Set(d.links.filter(l => l.dstFile === dst && l.srcFile !== dst).map(l => l.srcFile)); rows = rows.filter(r => set.has(r.path || r.srcFile)); }
    if (f['task-kw']) { const kws = Array.isArray(f['task-kw']) ? f['task-kw'] : [f['task-kw']]; rows = rows.filter(r => kws.includes(r.kw)); }
    if (f['due-before']) { const day = String(f['due-before']); rows = rows.filter(r => (r.deadline && r.deadline < day) || (r.scheduled && r.scheduled < day)); }
    return rows;
  }
  backlinks(x) {
    const id = this.fileIdOf(x);
    if (!id) return [];
    return this.derived().links.filter(l => l.dstFile === id && l.srcFile !== id);
  }
  /* Titles and aliases (completion candidates), optionally those containing PREFIX. */
  find(prefix) {
    const out = [];
    for (const id of this.derived().ids) { const f = this.files.get(id).rec.file; out.push(f.title); for (const a of f.aliases) out.push(a); }
    const uniq = [...new Set(out)].sort((a, b) => a.localeCompare(b));
    if (!prefix) return uniq;
    const q = String(prefix).toLowerCase();
    return uniq.filter(t => t.toLowerCase().includes(q));
  }
  /* The files to grep: every indexed file from disk, open buffers from their live text. */
  grepFiles() {
    const out = [];
    for (const id of this.derived().ids) { const sb = this.bufferFor(id); out.push(sb ? { id, text: sb.text } : { id, file: path.join(this.root, id) }); }
    return out;
  }
  /* The grep job for SOURCE: {files, source, flags, excludeLinks, max}; a bad pattern fails here, on this thread. */
  grepJob(source, flags, { excludeLinks = false, max = GREP_MAX, exclude = null } = {}) {
    if (typeof source !== 'string') throw new Error('notes-grep: a regexp source string is required');
    if (flags === undefined || flags === null) flags = /[A-Z]/.test(source.replace(/\\./g, '')) ? '' : 'i';
    new RegExp(source, flags.replace('g', ''));
    const files = this.grepFiles().filter(f => f.id !== exclude);
    return { t: 'grep', files, source, flags, excludeLinks, max };
  }
  /* Synchronous (outside a thread: the sync channel) and blocking (on a thread: the worker answers while the
     thread waits, R4.42) forms of the grep. */
  grep(source, flags, opts) { return this.syncJob(this.grepJob(source, flags, opts)).hits; }
  grepAsync(source, flags, opts) { return this.job(this.grepJob(source, flags, opts)).then(r => r.hits); }
  mentionsJob(x) {
    const id = this.fileIdOf(x);
    if (!id) return null;
    const f = this.files.get(id).rec.file;
    const names = [f.title, ...f.aliases].filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!names.length) return null;
    const source = `(?<![\\p{L}\\p{N}_])(?:${names.join('|')})(?![\\p{L}\\p{N}_])`;
    return this.grepJob(source, 'iu', { excludeLinks: true, exclude: id });
  }
  unlinkedMentions(x) { const j = this.mentionsJob(x); return j ? this.syncJob(j).hits : []; }
  unlinkedMentionsAsync(x) { const j = this.mentionsJob(x); return j ? this.job(j).then(r => r.hits) : Promise.resolve([]); }
  definePrimitives() {
    const { L, S } = this;
    const def = (name, args, doc, fn) => { const f = L.D(name, args, doc, fn); f.where = 'server'; return f; };
    const list = rows => S.listOf(rows.map(r => this.toScm(r)));
    def('notes-query', '. filters', 'Rows of the notes index matching the keyword FILTERS :kind :tag :text :path :linked-from :linked-to :task-kw :due-before, as alists.', (args) => list(this.query(this.filtersOf(args))));
    def('notes-backlinks', 'file', 'The links into FILE (an id, a path without extension, a title or an alias), as alists.', ([x]) => list(this.backlinks(x)));
    def('notes-file', 'id', 'The file record of ID (an id, a title or an alias), or #f.', ([x]) => { const id = this.fileIdOf(x); return id ? this.toScm(publicFile(this.files.get(id).rec.file)) : false; });
    def('notes-tasks', '. filters', 'The tasks of the index, with the keyword FILTERS of notes-query.', (args) => list(this.query({ ...this.filtersOf(args), kind: 'task' })));
    def('notes-cards', '[deck]', 'The flashcards of DECK, or all of them.', ([deck]) => list(this.derived().cards.filter(c => !deck || deck === false || c.deck === deck)));
    def('notes-rebuild', '', 'Start a full rebuild of the notes index; notes-generation changes when it is done.', () => { this.rebuild().catch(e => this.log.warn('notes', { rebuild: e.message })); return true; });
    def('notes-find', '[text]', 'Titles and aliases of the notes, those containing TEXT when given: the candidates of a completing read.', ([q]) => S.listOf(this.find(q === undefined || q === false ? '' : String(q))));
    /* On a thread these block while the worker searches (S.Block); the plain forms wait on the sync channel. */
    const self = this;
    def('unlinked-mentions', 'file', 'Mentions of FILE\'s title or aliases in other notes that are not links, as #(path line column text).', ([x]) => S.listOf(this.unlinkedMentions(x)))
      .gen = function* ([x]) { return S.listOf(yield new S.Block(self.unlinkedMentionsAsync(x), 'the notes worker')); };
    const flagsOf = flags => (flags === undefined || flags === false ? null : String(flags));
    def('notes-grep', 'regexp [flags]', 'Search every note for REGEXP (a source string; FLAGS as for JavaScript, smart case when absent) in the index worker: a list of #(path line column text).', ([re, flags]) => S.listOf(this.grep(String(re), flagsOf(flags))))
      .gen = function* ([re, flags]) { return S.listOf(yield new S.Block(self.grepAsync(String(re), flagsOf(flags)), 'the notes worker')); };
    def('notes-ambiguous-links', '', 'Links whose target names several files, each with its candidates and the chosen (shortest) path.', () => list(this.derived().ambiguous));
  }
}

let notes = null;
export async function install(server) { notes = new Notes(server); server.notes = notes; await notes.install(); }
export async function shutdown(server) { if (notes) await notes.shutdown(); notes = null; server.notes = null; }
