// edwind: the Lisp machine inside Workbench, phase E1 (spec §6–§8, §13.1, §14, §15).
//
//   edwind --config /etc/workbench/edit.json          run
//   edwind --config … --check                         verify every journal and snapshot offline (R15.12)
//   edwind --config … --export DIR                    write every live buffer's text to DIR (R15.12)
//   edwind --config … --write-roots                   print the write roots, one per line (for bin/edwind's flags)
//
// The process loads Edwin's core headless (host-node.js), replays the journals, then listens on edit.sock.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { Authority, expandHome } from './paths.mjs';
import { Buffers } from './buffers.mjs';
import { Client } from './session.mjs';
import { ImageLog, randomId, readJournal, jidPath } from './journal.mjs';
import { ProtoError } from './proto.mjs';
import { sha256 } from './files.mjs';
import * as imageModule from './image.mjs';
import * as notesModule from './notes.mjs';
import * as threadsModule from './threads.mjs';

const require = createRequire(import.meta.url);
/* The E2 modules, installed in this order after the buffers are loaded; each exports install(server) and
   may export shutdown(server) and name. */
const MODULES = [imageModule, notesModule, threadsModule];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDWIN = path.join(HERE, '..');
export const BUILD = process.env.WB_EDIT_BUILD || 'dev';
const MIN_NODE = [22, 13];
/* The JS stack of the server thread in MiB (R4.34): the Scheme cap of 10,000 frames needs about 8 MiB in
   generator mode; 32 leaves room for deep primitives. EDWIND_STACK_MIB overrides it. */
const STACK_MB = Math.max(8, Number(process.env.EDWIND_STACK_MIB) || 32);

/* ---------- log (R15.10): one line per event, never buffer text ---------- */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
export function makeLog(level = 'info') {
  const max = LEVELS[level] ?? 2;
  /* Written synchronously: the server runs on a worker thread, whose process.stderr is an asynchronous relay
     that can lose the last lines at exit. */
  const out = (lvl, ev, fields) => { if (LEVELS[lvl] > max) return; fs.writeSync(2, `${lvl} ${ev} ${JSON.stringify(fields || {})}\n`); };
  return { error: (e, f) => out('error', e, f), warn: (e, f) => out('warn', e, f), info: (e, f) => out('info', e, f), debug: (e, f) => out('debug', e, f) };
}

/* ---------- config (R15.4): edit.json, unknown fields refused ---------- */
const FIELDS = new Set(['socket', 'hubSocket', 'webSocket', 'stateDir', 'notesDir', 'boardsDir', 'configDir', 'writablePaths', 'refusePaths', 'models', 'host', 'logLevel']);
export function loadConfig(file) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file}: not an object`);
  for (const k of Object.keys(cfg)) if (!FIELDS.has(k)) throw new Error(`${file}: unknown field ${JSON.stringify(k)}`);
  const str = (k, req, dflt) => { const v = cfg[k]; if (v === undefined || v === null) { if (req) throw new Error(`${file}: ${k} is required`); return dflt; } if (typeof v !== 'string' || !v) throw new Error(`${file}: ${k} must be a string`); return v; };
  const abs = (k, v) => { if (v !== undefined && !path.isAbsolute(expandHome(v))) throw new Error(`${file}: ${k} must be an absolute path`); return v === undefined ? v : expandHome(v); };
  const home = process.env.HOME || os.homedir();
  const out = {
    socket: abs('socket', str('socket', false, '/run/workbench-edit/edit.sock')),
    hubSocket: abs('hubSocket', str('hubSocket', false, undefined)),
    webSocket: abs('webSocket', str('webSocket', false, undefined)),
    stateDir: abs('stateDir', str('stateDir', false, path.join(home, '.local/state/workbench/edit'))),
    notesDir: abs('notesDir', str('notesDir', true)),
    boardsDir: abs('boardsDir', str('boardsDir', false, undefined)),
    configDir: abs('configDir', str('configDir', false, path.join(home, '.config/edwin'))),
    host: str('host', false, os.hostname()),
    logLevel: str('logLevel', false, 'info'),
    writablePaths: [], refusePaths: [], models: cfg.models || {},
  };
  for (const k of ['writablePaths', 'refusePaths']) {
    const v = cfg[k] === undefined ? [] : cfg[k];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${file}: ${k} must be a list of paths`);
    out[k] = v.map(x => abs(k, x));
  }
  for (const k of ['socket', 'hubSocket', 'webSocket']) if (out[k] && Buffer.byteLength(out[k]) >= 108) throw new Error(`${file}: ${k} is too long for a socket path (108 bytes)`);
  if (out.models && typeof out.models === 'object') for (const [name, m] of Object.entries(out.models)) {
    if (!m || typeof m !== 'object') throw new Error(`${file}: models.${name} must be an object`);
    if (m.baseUrl !== undefined) { let u; try { u = new URL(m.baseUrl); } catch (e) { throw new Error(`${file}: models.${name}.baseUrl is not a URL`); } if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error(`${file}: models.${name}.baseUrl: plain http only to loopback`); else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${file}: models.${name}.baseUrl must be http or https`); }
  }
  return out;
}

/* ---------- the server ---------- */
export class Server {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log; this.build = BUILD; this.boot = randomId(8); this.clients = new Set(); this.stopping = false;
    this.auth = new Authority(cfg);
    /* Extension points for the E2 modules (notes, models, hub, image, threads): server commands by name
       (§4.6; `call{cmd}` reaches them after the E1 switch in command()), handlers for message types the
       session does not know (`sample`, `tool_result`, …), and the installed modules, shut down in reverse. */
    this.commands = new Map(); this.handlers = new Map(); this.modules = [];
    /* status (R15.11): each provider returns fields merged into the `status` command's value. */
    this.statusProviders = [];
    this.started = Date.now();
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cfg.configDir, { recursive: true, mode: 0o700 });
    this.image = new ImageLog(path.join(cfg.stateDir, 'image.jsonl'));
    this.image.ensureEpoch(() => randomId(8));
  }
  /* Load Edwin's core headless and boot it (host-node.js), then replay the image log (R4.19) and the journals. */
  async start() {
    const { createHost, loadEdwin } = require(path.join(EDWIN, 'src/host-node.js'));
    const storageFile = path.join(this.cfg.stateDir, 'storage.json');
    const host = createHost({ scmDir: path.join(EDWIN, 'scm'), configDir: this.cfg.configDir, storage: fileStorage(storageFile, this.log) });
    this.Ed = loadEdwin(host, { mode: 'gen' });
    this.L = globalThis.L;
    this.Ed.boot({ host });
    await this.Ed.whenIdle();
    this.image.replay(this);
    this.buffers = new Buffers({ Ed: this.Ed, auth: this.auth, stateDir: this.cfg.stateDir, log: this.log });
    this.buffers.reload();
    for (const m of MODULES) { await m.install(this); this.modules.push(m); }
  }
  /* A server command: FN(client, args, ctx, buf) returns the result object ({value, msg?, out?} or {error}),
     a promise of one, or undefined for a delayed result. */
  defineCommand(name, fn) { this.commands.set(name, fn); }
  /* A handler for message type T from any client: FN(client, msg), may return a promise. */
  onMessage(t, fn) { this.handlers.set(t, fn); }
  /* The `status` command (R15.11): what wb-web shows under /api/status.edit and reads for /api/info.
     Modules add fields through statusProviders (notes: notesExists, notesGen; models: sample, models;
     threads: loopLagP95Ms, ackP95Ms). */
  status() {
    let journalBytes = 0;
    for (const sb of this.buffers.all()) if (sb.journal) journalBytes += sb.journal.bytes;
    const out = { version: this.build, build: this.build, boot: this.boot, uptimeMs: Date.now() - this.started, clients: this.clients.size, buffers: this.buffers.all().length, journalBytes, imageGen: this.image.gen, imageEpoch: this.image.epoch, loopLagP95Ms: null, ackP95Ms: null, notesExists: false, notesGen: 0, sample: false, models: {} };
    for (const p of this.statusProviders) { try { Object.assign(out, p()); } catch (e) { this.log.warn('status', { error: e.message }); } }
    return out;
  }

  /* ---------- the socket (R14.3) ---------- */
  listen() {
    const sock = this.cfg.socket, dir = path.dirname(sock);
    const euid = process.geteuid();
    let dst;
    try { dst = fs.lstatSync(dir); } catch (e) { throw new Error(`${dir}: ${e.code}`); }
    if (!dst.isDirectory() || dst.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
    if (dst.uid !== euid) throw new Error(`${dir} is owned by uid ${dst.uid}, not ${euid}`);
    if ((dst.mode & 0o777) !== 0o700) throw new Error(`${dir} has mode ${(dst.mode & 0o777).toString(8)}, not 700`);
    try { const st = fs.lstatSync(sock); if (st.isSymbolicLink() || !st.isSocket()) throw new Error(`${sock} exists and is not a socket`); fs.unlinkSync(sock); }
    catch (e) { if (e.code !== 'ENOENT') { if (e instanceof Error && !e.code) throw e; throw new Error(`${sock}: ${e.code}`); } }
    const server = net.createServer({ allowHalfOpen: false }, socket => {
      const c = new Client(this, socket);
      this.clients.add(c);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => {
        try {
          fs.chmodSync(sock, 0o600);
          const st = fs.lstatSync(sock);
          if (st.isSymbolicLink() || !st.isSocket()) throw new Error(`${sock} is not the socket edwind created`);
          if (st.uid !== euid) throw new Error(`${sock} is owned by uid ${st.uid}, not ${euid}`);
          if ((st.mode & 0o777) !== 0o600) throw new Error(`${sock} has mode ${(st.mode & 0o777).toString(8)}, not 600`);
        } catch (e) { server.close(); reject(e); return; }
        this.net = server;
        this.log.info('listen', { socket: sock, build: this.build, boot: this.boot });
        fs.writeSync(2, `listening on ${sock}\n`);
        resolve(server);
      });
    });
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info('stop', {});
    const closed = this.net ? new Promise(r => this.net.close(() => r())) : null;
    for (const c of [...this.clients]) { c.send({ t: 'error', code: 'shutting_down', msg: 'edwind is stopping' }); c.destroy(); }
    if (closed) await closed;
    for (const m of [...this.modules].reverse()) if (m.shutdown) { try { await m.shutdown(this); } catch (e) { this.log.error('shutdown', { module: m.name || '?', error: e.message }); } }
    await this.buffers.shutdown();
    try { this.Ed.host.suspend(); } catch (e) { /* storage flush is best effort */ }
    try { fs.unlinkSync(this.cfg.socket); } catch (e) { /* gone */ }
  }

  /* ---------- evaluation (§7.4, R14.13, R4.15) ---------- */
  /* The forms of FORM run on a command thread for CLIENT (threads.mjs); before the module is installed
     (image replay, tests of the bare server) they run directly. Resolves to the result object of §7.4. */
  evalForm(client, form, ctx = {}, buf) {
    if (this.threads) return this.threads.evalForms(client, form, { ctx, buf });
    return Promise.resolve(this.evalFormDirect(client, form));
  }
  evalFormDirect(client, form) {
    const { L, Ed } = this;
    const S = L.S;
    const outParts = [];
    const port = S.makeOutputPort(s => outParts.push(s), 'call');
    const saveEcho = Ed.E.echo; Ed.E.echo = '';
    const limit = S.watchdog.limitMs; S.watchdog.limitMs = client.deadlineMs();
    let value, error = null;
    try {
      L.resetOps();
      const forms = L.readAll(form);
      value = S.withOutputTo(port, () => { let v; for (const f of forms) v = L.ev(f); return v; });
      /* Definitional forms enter the image log and reach every frame (R4.14, R4.15; image.mjs). */
      const note = this.image.record(client, forms); if (note) Ed.E.echo = Ed.E.echo ? Ed.E.echo + '\n' + note : note;
    } catch (e) {
      error = this.conditionOf(e);
    } finally { S.watchdog.limitMs = limit; L.resetOps(); S.resetStack(); }
    const msg = Ed.E.echo; Ed.E.echo = saveEcho;
    const out = outParts.join('');
    if (error) { const r = { error }; if (out) r.out = out; if (msg) r.msg = msg; this.log.info('call', { kind: client.kind, condition: error.condition }); return r; }
    const r = { value: S.write(value) };
    if (out) r.out = out; if (msg) r.msg = msg;
    return r;
  }
  /* error of result (§7.4): {condition, report, restarts, backtrace}. */
  conditionOf(e) {
    const { L, Ed } = this;
    const S = L.S;
    let condition = 'error';
    if (e instanceof S.SchemeError) condition = e.kind === 'scheme-interrupt' && /ran for more than/.test(e.message) ? 'timeout' : e.kind;
    else if (e instanceof S.Raise) condition = 'raise';
    else if (e instanceof RangeError) condition = 'recursion-depth';
    else if (L.isQuit && L.isQuit(e)) condition = 'quit';
    const report = Ed.errorText(e);
    let backtrace = [];
    try { const bt = S.conditionBacktrace(e); if (bt) backtrace = bt.slice(0, 40).map(f => (f.proc && f.proc.procName ? f.proc.procName : 'anonymous') + (f.loc ? ` (${f.loc.file || ''}:${f.loc.line})` : '')); } catch (x) { /* no backtrace */ }
    return { condition, report, restarts: [], backtrace };
  }

  /* ---------- the E1 server commands (§4.6, §6.5, §13.1) ---------- */
  async command(client, cmd, args, ctx, buf) {
    const B = this.buffers;
    switch (cmd) {
      case 'buffer-list': return { value: B.list() };
      case 'server-edit': {
        const id = typeof args[0] === 'string' ? args[0] : (() => { throw new ProtoError('bad_request', 'server-edit needs a buffer id'); })();
        const line = Number.isInteger(args[1]) ? args[1] : null;
        const r = B.resolve(id, true);
        if (r.moved) return B.resolve(r.moved, true), { value: { buf: r.moved, exit: null } };
        const sb = r;
        if (!sb.serverEdit) sb.serverEdit = { waiters: [], saved: false, line };
        sb.lastOpen = Date.now();
        this.log.info('server-edit', { buf: sb.id, wait: !!ctx.wait, line });
        if (!ctx.wait) return { value: { buf: sb.id, exit: null } };
        const exit = await new Promise(resolve => sb.serverEdit.waiters.push(resolve));
        return { value: { buf: sb.id, exit } };
      }
      case 'server-edit-done': case 'server-edit-abort': {
        const sb = B.get(typeof args[0] === 'string' ? args[0] : buf);
        const se = sb.serverEdit;
        if (!se) return { value: { buf: sb.id, waiting: false } };
        let exit;
        if (cmd === 'server-edit-done') { if (sb.file && sb.modified) await B.save(sb); exit = 0; } else exit = 1;
        sb.serverEdit = null;
        for (const w of se.waiters) w(exit);
        return { value: { buf: sb.id, exit } };
      }
      case 'undo': case 'undo-global': case 'undo-writer': {
        const sb = B.get(buf || args[0]);
        if (sb.readOnly) throw new ProtoError('read_only', String(sb.readOnly));
        const me = client.by();
        const same = (a, b) => a.kind === b.kind && (a.device || null) === (b.device || null) && (a.cid || null) === (b.cid || null);
        let pick;
        if (cmd === 'undo') pick = b => b.by && (b.by.device ? b.by.device === me.device : same(b.by, me));
        else if (cmd === 'undo-global') pick = b => b.by && b.by.kind !== 'disk';
        else { const w = args[0] && typeof args[0] === 'object' ? args[0] : null; if (!w) throw new ProtoError('bad_request', 'undo-writer needs a writer (a by value)'); pick = b => b.by && JSON.stringify(b.by) === JSON.stringify(w); }
        const r = await B.undoWhere(sb, pick, me, { cid: client.cid, seq: null });
        if (!r) return { value: false, msg: 'No further undo information' };
        const msg = r.partial ? `Undo (partial: changed by ${r.by && r.by.kind})` : 'Undo';
        for (const c of sb.clients) if (c !== client) c.sendBulkish({ t: 'msg', text: msg, level: 'info' });
        return { value: { buf: sb.id, ver: r.ver, partial: r.partial }, msg };
      }
      case 'list-writers': { const sb = B.get(buf || args[0]); const seen = new Map(); for (const b of sb.hist) seen.set(JSON.stringify(b.by), b.by); return { value: [...seen.values()] }; }
      case 'kill-buffer': { const sb = B.get(typeof args[0] === 'string' ? args[0] : buf); B.kill(sb); return { value: true }; }
      case 'status': return { value: this.status() };
      default: {
        const fn = this.commands.get(cmd);
        if (fn) return fn(client, args, ctx, buf);
        /* A Scheme command declared (:where 'server) runs on a command thread (R4.27). */
        if (this.threads && this.threads.isServerCommand(cmd)) return this.threads.runCommand(client, cmd, args, ctx, buf);
        throw new ProtoError('bad_request', `unknown server command ${JSON.stringify(cmd)}`);
      }
    }
  }
}

/* Edwin's key-value store, kept as one JSON file in stateDir (settings and recentf; buffers are not in it). */
function fileStorage(file, log) {
  let map = new Map();
  try { map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch (e) { if (e.code !== 'ENOENT') log.warn('storage', { error: e.message }); }
  let timer = null;
  const flush = () => { timer = null; try { fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 }); } catch (e) { log.warn('storage', { error: e.message }); } };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 500); };
  return { get: k => (map.has(k) ? map.get(k) : null), set: (k, v) => { map.set(k, String(v)); schedule(); return true; }, remove: k => { map.delete(k); schedule(); }, keys: () => [...map.keys()], flush };
}

/* ---------- --check and --export (R15.12) ---------- */
export function check(cfg, out = s => process.stdout.write(s + '\n')) {
  const dir = path.join(cfg.stateDir, 'buffers');
  let bad = 0, n = 0;
  const OT = require(path.join(EDWIN, 'src/ot.js'));
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.jsonl')) : []) {
    n++;
    const jid = f.slice(0, -6);
    try {
      const { header, batches, torn } = readJournal(path.join(dir, f));
      let base = null;
      for (const ext of ['.snap', '.saved']) { const p = jidPath(cfg.stateDir, jid, ext); if (fs.existsSync(p)) { const t = fs.readFileSync(p, 'utf8'); if (sha256(t) === header.base.sha256) { base = t; break; } } }
      if (base === null && header.file && fs.existsSync(header.file)) { const t = fs.readFileSync(header.file, 'utf8').replace(/\r\n/g, '\n'); if (sha256(t) === header.base.sha256) base = t; }
      if (base === null && header.base.sha256 === sha256('')) base = '';
      if (base === null) { out(`${jid} ${header.id}: no snapshot, saved copy or file matches the journal base`); bad++; continue; }
      let text = base, ver = header.base.ver;
      for (const b of batches) {
        if (b.ver !== ver + 1) throw new Error(`version ${b.ver} after ${ver}`);
        text = OT.apply(text, b.ops); ver = b.ver;
      }
      out(`${jid} ${header.id}: ok, ${batches.length} batches, version ${ver}${torn ? ', torn last line dropped' : ''}`);
    } catch (e) { out(`${jid}: ${e.message}`); bad++; }
  }
  out(`${n} journals, ${bad} with problems`);
  return bad === 0;
}
export async function exportAll(cfg, dir, log) {
  const server = new Server(cfg, log);
  await server.start();
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const sb of server.buffers.all()) {
    const name = sb.file ? sb.file.replace(/^\//, '').replace(/\//g, '%2F') : sb.id.replace(/[/:]/g, '%2F');
    fs.writeFileSync(path.join(dir, name), sb.text, { mode: 0o600 }); n++;
  }
  await server.buffers.shutdown();
  return n;
}

/* ---------- main ---------- */
function usage() { process.stderr.write('usage: edwind --config PATH [--check | --export DIR | --write-roots]\n'); return 2; }
/* R4.45, R14.12: edwind never starts processes. Node's permission model would enforce this, but it also
   disables fsync and fdatasync (Node 22 and 24), which the journal and atomic save need (R8.3, R8.7). So the
   backstop is in-process: every function of child_process is replaced before anything else runs, for CJS
   and ESM importers alike. The Authority (paths.mjs) is the real check on file writes. */
export function guardProcesses() {
  const cp = require('node:child_process');
  const refuse = () => { throw new Error('edwind never starts processes (R4.45)'); };
  for (const k of Object.keys(cp)) if (typeof cp[k] === 'function') { try { Object.defineProperty(cp, k, { value: refuse, writable: false, configurable: false }); } catch (e) { /* frozen */ } }
  syncBuiltinESMExports();
}

export async function main(argv) {
  guardProcesses();
  const args = [...argv];
  let config = null, mode = 'run', exportDir = null;
  while (args.length) {
    const a = args.shift();
    if (a === '--config') config = args.shift();
    else if (a === '--check') mode = 'check';
    else if (a === '--export') { mode = 'export'; exportDir = args.shift(); }
    else if (a === '--write-roots') mode = 'roots';
    else return usage();
  }
  if (!config || (mode === 'export' && !exportDir)) return usage();
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) { process.stderr.write(`edwind needs Node ${MIN_NODE.join('.')} or newer (R15.2); this is ${process.versions.node}\n`); return 1; }
  let cfg;
  try { cfg = loadConfig(config); } catch (e) { process.stderr.write(`edwind: ${e.message}\n`); return 1; }
  const log = makeLog(cfg.logLevel);
  if (mode === 'roots') { const a = new Authority(cfg); for (const r of [...a.writeRootsForFlags(), path.dirname(cfg.socket)]) process.stdout.write(r + '\n'); return 0; }
  if (mode === 'check') return check(cfg) ? 0 : 1;
  if (mode === 'export') { const n = await exportAll(cfg, exportDir, log); process.stdout.write(`${n} buffers exported to ${exportDir}\n`); return 0; }
  if (isMainThread && !process.env.EDWIND_NO_THREAD) return runInThread(argv, log);
  const server = new Server(cfg, log);
  try { await server.start(); await server.listen(); }
  catch (e) { process.stderr.write(`edwind: ${e.message}\n`); log.error('start', { error: e.message }); return 1; }
  let stopping = null;
  const stop = sig => { if (stopping) return; log.info('signal', { sig }); stopping = server.stop().then(() => process.exit(0), e => { log.error('stop', { error: e.message }); process.exit(1); }); };
  if (isMainThread) { process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT')); }
  else parentPort.on('message', m => { if (m && m.t === 'stop') stop(m.sig); });
  process.on('uncaughtException', e => { log.error('uncaught', { error: e.stack || String(e) }); });
  process.on('unhandledRejection', e => { log.error('unhandled', { error: (e && e.stack) || String(e) }); });
  return new Promise(() => {});
}

/* The server runs on a worker thread with a stack sized for the Scheme cap (STACK_MB): Node's main thread
   gets about 1,500 Scheme frames from its default stack and `ulimit -s` belongs to the operator, while a
   worker's stack is the process's own choice. The main thread only relays SIGTERM and SIGINT to the server
   and exits with its code. EDWIND_NO_THREAD=1 runs the server on the main thread (debugging, benchmarks). */
function runInThread(argv, log) {
  return new Promise(resolve => {
    const resourceLimits = { stackSizeMb: STACK_MB };
    if (Number(process.env.EDWIND_MEMORY_MIB) > 0) resourceLimits.maxOldGenerationSizeMb = Number(process.env.EDWIND_MEMORY_MIB);
    const w = new Worker(fileURLToPath(import.meta.url), { argv, resourceLimits });
    const stop = sig => w.postMessage({ t: 'stop', sig });
    process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
    w.on('error', e => { log.error('thread', { error: e.stack || String(e) }); });
    w.on('exit', code => resolve(code));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { if (code !== undefined) process.exit(code); });
}
