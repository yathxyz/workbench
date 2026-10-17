// Processes through the hub (spec §4.8: R4.43, R4.44, R4.45; R9.22; R14.12). edwind never calls
// child_process: a process is a hub PTY session that this module opens over server.hub (hub.mts) with
// `pty.open` and a `spawn` of `{argv: [shell, "-c", command], shell, cwd, env}`; the hub only ever runs its
// configured shells (DESIGN §3.2.7). Output arrives as `pty.out` and goes to the process's filter or into
// its buffer at the process mark; `pty.exit` runs the sentinel. The sid is `ed-` followed by 16 random
// base32 characters, so the board hides the session (R9.22) unless :card asks for a shell card (§5).
//
// Callbacks (filters, sentinels) are Scheme procedures, so they run on background threads of the scheduler
// (threads.mts, R4.40): one thread per output chunk or exit, queued per process so a filter that blocks does
// not let a later chunk overtake it. A thread's edits to a shared buffer are sequenced by the scheduler at
// its end (R4.41). The waiting primitives (make-process for the hub's reply, kill-process, call-process,
// process-wait, accept-process-output) are generator primitives that yield S.Block.
//
// Logging (R15.10): sids, names of events and error codes; never a command string, input or output.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sha256 } from './files.mts';
import { HubError, PTY_INPUT_FRAME, KILL_TIMEOUT_MS, REPLY_TIMEOUT_MS } from './hub.mts';
import { jsonToScheme } from './threads.mts';
import type { Server, Log, Lisp, Ed as Edwin, EdBuffer, SchemeValue } from './main.mts';
import type { Hub, HubMessage, HubRequest, PtyOpenReply, Summary } from './hub.mts';
import type { Scheduler, SchemeGen } from './threads.mts';
import type { SBuf } from './buffers.mts';
import type { By } from './proto.mts';

type Scheme = Lisp['S'];
/* How a process ended, as pty.exit, a pty.open reply or a Summary has it. */
export interface ExitInfo { code?: number | null; signal?: number | null; reason?: string }
/* pty.exit as the hub sends it (HubMessage types `code` as an err's string code). */
export interface PtyExitMsg { t?: string; sid?: string; code?: number | null; signal?: number | null; reason?: string }
export type ProcessStatus = 'starting' | 'run' | 'exit' | 'signal' | 'failed' | 'deleted';
/* What spawnG opens: command null for an interactive shell; who names the primitive in errors. */
export interface SpawnOptions {
  name: string; command: string | null; shell?: string | null; cwd?: string | null; env?: Record<string, string> | null;
  cols: number; rows: number; buffer?: EdBuffer | null; filter?: SchemeValue | null; sentinel?: SchemeValue | null;
  card?: boolean; noquery?: boolean; collect?: boolean; who: string;
}
export interface ProcessInit extends Omit<SpawnOptions, 'shell'> { sid: string; argv: string[]; shell: string }
/* The spawn of pty.open (wb_proto::hub::SpawnPty). */
interface SpawnPty { argv: string[]; shell: string; cwd?: string; env?: Record<string, string> }
/* A callback thread waiting in a process's queue; done resolves the exit promise in order. */
type QueueItem = { kind: 'out' | 'exit'; job: (self: Processes) => SchemeGen } | { kind: 'done'; job: () => void };
/* accept-process-output waiting for output from one of PROCS. */
interface OutWaiter { procs: Process[]; resolve: (v: boolean) => void }

export const name = 'process';
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;
export const ENV_MAX = 32;                                  // SpawnPty.env: at most 32 entries (wb_proto::hub::SpawnPty)
export const SID_PREFIX = 'ed-';
/* Shells whose -c syntax accepts the TERM prefix of R4.44 (the hub fixes TERM, crates/wb-hub/src/env.rs). */
export const POSIX_SHELLS = ['bash', 'sh', 'zsh'];
export const TERM_PREFIX = 'export TERM=dumb NO_COLOR=1; ';
export const LIST_BUFFER = '*Process List*';
export const LIST_BUFFER_ID = 'name:' + LIST_BUFFER;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCM_FILE = path.join(HERE, '..', 'scm', 'process.scm');
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const SERVER_BY: By = { kind: 'server' };

/* A fresh sid: `ed-` and 16 base32 characters (80 random bits), matching ^[A-Za-z0-9_-]{1,64}$ (R4.43). */
export function newSid(): string {
  const bytes = randomBytes(10); let bits = 0, acc = 0, out = '';
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += BASE32[(acc >> bits) & 31]; } }
  return SID_PREFIX + out;
}

/* Terminal output as plain text (R4.44): CSI, OSC (BEL or ST terminated), DCS and other escape sequences
   are removed, as are the other C0 controls except tab and newline; CRLF becomes LF and a bare CR is
   dropped (the hub's children write to a terminal). */
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1bP[^\x1b]*(?:\x1b\\)?|\x1b[ -\/]*[0-~]?|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
export function stripAnsi(text: unknown): string {
  return String(text).replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}

/* Emacs's sentinel event string for an exit (code, signal, reason). */
export function exitEvent(code: number | null | undefined, signal: number | null | undefined, reason: string | null | undefined): string {
  if (reason === 'spawn_failed') return 'failed\n';
  if (reason === 'hub_restart') return 'exited abnormally with code 255 (hub restart)\n';
  if (signal !== null && signal !== undefined) return signal === 2 ? 'interrupt\n' : signal === 15 ? 'terminated\n' : signal === 1 ? 'hangup\n' : 'killed\n';
  if (code === 0) return 'finished\n';
  return `exited abnormally with code ${code === null || code === undefined ? '?' : code}\n`;
}

export class Process {
  declare name: string; declare sid: string; declare command: string | null; declare argv: string[]; declare shell: string;
  declare cwd: string | null; declare env: Record<string, string> | null; declare cols: number; declare rows: number; declare card: boolean;
  declare buffer: EdBuffer | null; declare mark: SchemeValue | null; // an Edwin marker (edwin/src)
  declare filter: SchemeValue | null; declare sentinel: SchemeValue | null; declare plist: Map<string, SchemeValue>; declare queryOnExit: boolean;
  declare pid: number | null; declare epoch: number | null; declare stream: number | null; declare out: number; declare startedAt: number;
  declare status: ProcessStatus;
  declare exitCode: number | null; declare exitSignal: number | null; declare exitReason: string | null; declare alive: boolean; declare exited: boolean;
  declare collect: string | null; declare unseen: number;
  declare queue: QueueItem[]; declare busy: boolean; declare deleted: boolean;
  declare exitPromise: Promise<number | null>; declare resolveExit: (v: number | null) => void;
  constructor(o: ProcessInit) {
    this.name = o.name; this.sid = o.sid; this.command = o.command; this.argv = o.argv; this.shell = o.shell; this.cwd = o.cwd || null; this.env = o.env || null;
    this.cols = o.cols; this.rows = o.rows; this.card = !!o.card; this.buffer = null; this.mark = null;
    this.filter = o.filter || null; this.sentinel = o.sentinel || null; this.plist = new Map(); this.queryOnExit = !o.noquery;
    this.pid = null; this.epoch = null; this.stream = null; this.out = 0; this.startedAt = Date.now();
    this.status = 'starting';                             // starting | run | exit | signal | failed | deleted
    this.exitCode = null; this.exitSignal = null; this.exitReason = null; this.alive = false; this.exited = false;
    this.collect = o.collect ? '' : null;                 // accumulated raw output (call-process, shell-run), or null
    this.unseen = 0;                                      // output chunks processed since the last accept-process-output
    this.queue = []; this.busy = false; this.deleted = false;
    this.exitPromise = new Promise(r => { this.resolveExit = r; });
    this.exitPromise.catch(() => {});
    if (o.buffer) this.setBuffer(o.buffer);
  }
  setBuffer(b: EdBuffer | null): void {
    if (this.mark) this.mark.release();
    this.buffer = b || null;
    this.mark = b ? b.marker(b.rope.length, 'after') : null;
  }
  __print(): string { return `#<process ${this.name}>`; }
  toString(): string { return this.__print(); }
  get __type(): string { return 'process'; }
}

export class Processes {
  declare server: Server; declare log: Log; declare L: Lisp; declare S: Scheme; declare Ed: Edwin; declare E: SchemeValue; // E: Edwin's editor state (edwin/src)
  declare byId: Map<string, Process>; declare outWaiters: OutWaiter[];
  declare onCard: ((p: Process) => void) | null; declare listTimer: NodeJS.Timeout | null;
  constructor(server: Server) {
    this.server = server; this.log = server.log; this.L = server.L; this.S = server.L.S; this.Ed = server.Ed; this.E = server.Ed.E;
    this.byId = new Map();                                 // sid -> Process
    this.outWaiters = [];                                  // accept-process-output: {procs, resolve}
    this.onCard = null;                                    // hook point for :card t once the board family exists (EW-M4)
    this.listTimer = null;
  }
  get hub(): Hub { return this.server.hub; }
  get threads(): Scheduler { return this.server.threads; }
  all(): Process[] { return [...this.byId.values()]; }
  byName(nm: string): Process | null { for (const p of this.byId.values()) if (p.name === nm) return p; return null; }
  byBuffer(b: EdBuffer): Process | null { for (const p of this.byId.values()) if (p.buffer === b) return p; return null; }
  hubErr(e: unknown, who: string): SchemeValue { return this.hub.toCondition(e, who); }

  /* ---------- spawning (R4.43) ---------- */
  /* Open a hub PTY for O = {name, command (null for an interactive shell), shell, cwd, env, cols, rows,
     buffer, filter, sentinel, card, collect, who}; a generator: waits for the hub's reply. */
  *spawnG(o: SpawnOptions): SchemeGen {
    const S = this.S, hub = this.hub;
    if (!hub.up) throw new S.SchemeError('hub-error', `${o.who}: hub unreachable`, []);
    const shell = o.shell || hub.defaultShell();
    const argv = o.command === null || o.command === undefined ? [shell] : [shell, '-c', o.command];
    const sid = newSid();
    const p = new Process({ ...o, sid, argv, shell });
    const spawn: SpawnPty = { argv, shell };
    if (o.cwd) spawn.cwd = o.cwd;
    if (o.env) spawn.env = o.env;
    this.byId.set(sid, p);                                 // registered first, so an event arriving with the reply finds it
    this.log.info('process', { event: 'spawn', sid, shell, card: p.card });
    let reply: PtyOpenReply;
    try { reply = yield new S.Block(hub.request({ t: 'pty.open', sid, cols: p.cols, rows: p.rows, spawn }), 'the hub'); }
    catch (e) {
      this.byId.delete(sid); p.status = 'failed'; p.exited = true; p.resolveExit(null);
      this.log.info('process', { event: 'refused', sid, code: e.code || null });
      if (e instanceof HubError && e.code !== 'unavailable' && e.code !== 'timeout') throw new S.SchemeError('process-error', `${o.who}: ${e.message}`, [e.code]);
      throw this.hubErr(e, o.who);
    }
    p.pid = reply.pid === undefined ? null : reply.pid; p.epoch = reply.epoch; p.stream = reply.stream; p.out = reply.out || 0;
    p.status = 'run'; p.alive = true;
    if (reply.cwd && !p.cwd) p.cwd = reply.cwd;
    if (reply.exit) this.finish(p, reply.exit);           // a spawn that died before the reply
    else if (p.card && this.onCard) { try { this.onCard(p); } catch (e) { this.log.warn('process', { event: 'card', sid, error: e.message }); } }
    this.scheduleList();
    return p;
  }

  /* ---------- hub events ---------- */
  onOut(msg: HubMessage): void {
    const p = this.byId.get(msg.sid!); if (!p) return;
    p.out = typeof msg.out === 'number' ? msg.out : p.out;
    this.deliver(p, msg.d);
  }
  deliver(p: Process, d: string | undefined): void {
    if (typeof d !== 'string' || !d) return;
    if (p.collect !== null) p.collect += d;
    this.server.hub.emit('process.out', p, d);           // wb.mts: wb-session-output-functions for our own sessions
    if (p.filter) this.enqueue(p, 'out', function* (self: Processes): SchemeGen { yield* self.S.applyG(p.filter, [p, d]); });
    else if (p.buffer) this.enqueue(p, 'out', function* (self: Processes): SchemeGen { self.insertAtMark(p, d); });
    else this.wakeOut(p);
  }
  onExit(msg: PtyExitMsg): void {
    const p = this.byId.get(msg.sid!); if (!p || p.exited) return;
    this.finish(p, { code: msg.code === undefined ? null : msg.code, signal: msg.signal === undefined ? null : msg.signal, reason: msg.reason || 'exited' });
  }
  /* The Summary of one of our sessions changed: an exit we did not see as pty.exit (disconnected then) counts. */
  onSession(s: Summary): void {
    const p = this.byId.get(s.sid); if (!p) return;
    if (p.alive && s.alive === false && !p.exited) { const ex = s.pty && s.pty.exit; this.finish(p, ex ? { code: ex.code, signal: ex.signal, reason: ex.reason } : { code: null, signal: null, reason: 'unknown' }); }
    this.scheduleList();
  }
  onGone(msg: HubMessage): void {
    const p = this.byId.get(msg.sid!); if (!p) return;
    if (!p.exited) this.finish(p, { code: null, signal: null, reason: 'deleted' });
    this.byId.delete(msg.sid!); p.deleted = true; p.status = 'deleted';
    this.scheduleList();
  }
  /* The hub came back: re-attach to every live process, resuming its stream where we left it. */
  onUp(): void {
    const S = this.S;
    for (const p of this.byId.values()) {
      if (!p.alive || p.exited) continue;
      const req: HubRequest & { t: 'pty.open'; resume?: { stream: number; out: number } } = { t: 'pty.open', sid: p.sid, cols: p.cols, rows: p.rows };
      if (p.stream !== null) req.resume = { stream: p.stream, out: p.out };
      this.hub.request(req).then(r => {
        if (p.exited) return;
        p.epoch = r.epoch; p.stream = r.stream; p.out = r.out || 0;
        if (r.resumed && typeof r.replay === 'string' && r.replay) this.deliver(p, r.replay);   // a snapshot (not resumed) would repeat what the buffer holds
        if (r.exit) this.finish(p, r.exit);
        this.log.info('process', { event: 'reattached', sid: p.sid, resumed: !!r.resumed });
      }, e => {
        this.log.info('process', { event: 'reattach failed', sid: p.sid, code: e.code || null });
        if (e instanceof HubError && (e.code === 'not_found' || e.code === 'kind_mismatch')) { this.finish(p, { code: null, signal: null, reason: 'deleted' }); this.byId.delete(p.sid); p.deleted = true; }
      });
    }
  }
  finish(p: Process, ex: ExitInfo): void {
    if (p.exited) return;
    p.exited = true; p.alive = false; p.exitCode = ex.code === undefined ? null : ex.code; p.exitSignal = ex.signal === undefined ? null : ex.signal; p.exitReason = ex.reason || 'exited';
    p.status = ex.reason === 'spawn_failed' ? 'failed' : p.exitSignal !== null ? 'signal' : 'exit';
    this.log.info('process', { event: 'exit', sid: p.sid, code: p.exitCode, signal: p.exitSignal, reason: p.exitReason });
    const event = exitEvent(p.exitCode, p.exitSignal, p.exitReason);
    this.server.hub.emit('process.exit', p, event);
    if (p.sentinel) this.enqueue(p, 'exit', function* (self: Processes): SchemeGen { yield* self.S.applyG(p.sentinel, [p, event]); });
    else if (p.buffer) this.enqueue(p, 'exit', function* (self: Processes): SchemeGen { self.insertAtMark(p, `\nProcess ${p.name} ${event}`); });
    this.enqueue(p, 'done', () => p.resolveExit(p.status === 'signal' ? p.exitSignal : p.exitCode));
    this.scheduleList();
  }

  /* ---------- the per-process queue of callback threads ---------- */
  enqueue(p: Process, kind: 'done', job: () => void): void;
  enqueue(p: Process, kind: 'out' | 'exit', job: (self: Processes) => SchemeGen): void;
  enqueue(p: Process, kind: QueueItem['kind'], job: QueueItem['job']): void { p.queue.push({ kind, job } as QueueItem); this.pump(p); }
  pump(p: Process): void {
    if (p.busy || !p.queue.length) return;
    const { kind, job } = p.queue.shift()!;
    if (kind === 'done') { job(); this.pump(p); return; }
    p.busy = true;
    const self = this;
    const t = this.threads.spawn(function* () { return yield* job(self); }, { kind: 'background', name: `process ${p.name}`, debugOnError: false, buffer: p.buffer && this.E.buffers.includes(p.buffer) ? p.buffer : null });
    t.done.then(() => {}, () => {}).then(() => { p.busy = false; if (kind === 'out') this.wakeOut(p); this.pump(p); });
  }
  /* Output in the process buffer at the process mark (an after marker, so it advances); point follows as
     Edwin's point does for any insertion at it. No read-only check, as Emacs binds inhibit-read-only. */
  insertAtMark(p: Process, text: string): void {
    const b = p.buffer;
    if (!b || !this.E.buffers.includes(b) || !text) return;
    if (!p.mark || p.mark.buffer !== b || p.mark.pos === null) p.setBuffer(b);
    const pos = Math.min(p.mark.pos, b.rope.length);
    const saved = this.E.current;
    this.E.current = b;
    const t = this.threads.current; if (t) this.threads.holdCurrent(t);
    try { this.Ed.editText(b, pos, 0, text); b.modified = true; }
    finally { this.E.current = saved; }
  }
  wakeOut(p: Process): void { p.unseen++; const rest: OutWaiter[] = []; for (const w of this.outWaiters) { if (w.procs.includes(p)) { w.resolve(true); for (const q of w.procs) q.unseen = 0; } else rest.push(w); } this.outWaiters = rest; }

  /* ---------- status from the Summary (R4.43) ---------- */
  statusOf(p: Process): ProcessStatus {
    const s = this.hub.sessions.get(p.sid);
    if (s && !p.deleted) {
      if (s.alive) return p.exited ? p.status : 'run';
      const ex = s.pty && s.pty.exit;
      if (ex) return ex.reason === 'spawn_failed' ? 'failed' : ex.signal !== null && ex.signal !== undefined ? 'signal' : 'exit';
      return p.exited ? p.status : 'exit';
    }
    return p.status;
  }
  exitStatusOf(p: Process): number {
    const s = this.hub.sessions.get(p.sid);
    const ex = s && !s.alive && s.pty ? s.pty.exit : null;
    if (ex) return ex.signal !== null && ex.signal !== undefined ? ex.signal : (ex.code === null || ex.code === undefined ? 0 : ex.code);
    if (!p.exited) return 0;
    return p.exitSignal !== null ? p.exitSignal : (p.exitCode === null ? 0 : p.exitCode);
  }
  live(p: Process): boolean { return !p.exited && !p.deleted && this.statusOf(p) === 'run'; }

  /* ---------- *Process List* (R9.22: card-less processes are listed here) ---------- */
  render(): string {
    const rows = [['Process', 'PID', 'Status', 'Buffer', 'Shell', 'Session', 'Card', 'Command']];
    for (const p of this.all()) {
      const st = this.statusOf(p); const ex = p.exited ? this.exitStatusOf(p) : null;
      rows.push([p.name, p.pid === null ? '--' : String(p.pid), st === 'run' ? 'run' : ex === null ? st : `${st} ${ex}`, p.buffer && this.E.buffers.includes(p.buffer) ? p.buffer.name : '(none)', p.shell, p.sid, p.card ? 'yes' : 'no', p.command === null ? `(${p.shell})` : p.command]);
    }
    /* Sessions of an earlier edwind run, still in the hub's list under the ed- prefix. */
    for (const s of this.hub.sessions.values()) {
      if (!s.sid.startsWith(SID_PREFIX) || this.byId.has(s.sid) || s.kind !== 'pty') continue;
      const ex = s.pty && s.pty.exit;
      rows.push(['(earlier run)', s.pty && s.pty.pid !== undefined ? String(s.pty.pid) : '--', s.alive ? 'run' : ex ? `exit ${ex.signal !== null && ex.signal !== undefined ? ex.signal : ex.code}` : 'exit', '(none)', s.pty && s.pty.argv ? path.basename(s.pty.argv[0] || '') : '?', s.sid, 'no', s.pty && s.pty.argv ? s.pty.argv.slice(1).join(' ') : '']);
    }
    const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (i === rows[0].length - 1 ? 0 : [...r[i]].length))));
    const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
    return rows.map(line).join('\n') + '\n';
  }
  listBuffer(): SBuf {
    const { Ed, buffers } = this.server;
    let sb = buffers.byId.get(LIST_BUFFER_ID);
    if (sb) return sb;
    const ed = Ed.getBufferCreate(LIST_BUFFER); ed.mode = 'special-mode'; ed.readOnly = true;
    sb = buffers.resolve(LIST_BUFFER_ID, false) as SBuf;
    sb.readOnly = 'server special buffer';
    return sb;
  }
  async refreshList(create?: boolean): Promise<SBuf | null> {
    const sb = create ? this.listBuffer() : this.server.buffers.byId.get(LIST_BUFFER_ID);
    if (!sb) return null;
    await this.server.buffers.replaceText(sb, this.render(), SERVER_BY);
    sb.savedText = sb.text; sb.savedHash = sha256(sb.savedText);
    return sb;
  }
  scheduleList(): void {
    if (this.listTimer || !this.server.buffers || !this.server.buffers.byId.has(LIST_BUFFER_ID)) return;
    this.listTimer = setTimeout(() => { this.listTimer = null; this.refreshList(false).catch(e => this.log.warn('process', { event: 'list', error: e.message })); }, 50);
    this.listTimer.unref();
  }

  shutdown(): void { if (this.listTimer) clearTimeout(this.listTimer); for (const w of this.outWaiters) w.resolve(false); this.outWaiters = []; }
}

/* ---------- the module ---------- */
export async function install(server: Server): Promise<void> {
  const { L, Ed } = server, S = L.S, E = Ed.E;
  const P = new Processes(server);
  server.processes = P;
  const hub = server.hub;
  hub.on('pty.out', m => P.onOut(m));
  hub.on('pty.exit', m => P.onExit(m as unknown as PtyExitMsg));
  hub.on('session', s => P.onSession(s));
  hub.on('gone', m => P.onGone(m));
  hub.on('up', () => P.onUp());
  server.statusProviders.push(() => ({ processes: P.byId.size }));
  /* A killed shared buffer leaves its processes without one; output to a buffer Edwin no longer lists is
     discarded (insertAtMark checks), as Emacs discards output to a killed buffer. */
  server.buffers.on('killed', sb => { for (const p of P.byId.values()) if (p.buffer === sb.ed) p.setBuffer(null); });

  const D = (nm: string, args: string, doc: string, fn: (args: SchemeValue[]) => SchemeValue, gen?: (args: SchemeValue[]) => SchemeGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
  const blocking = (nm: string, args: string, doc: string, gen: (args: SchemeValue[]) => SchemeGen) => D(nm, args, doc, () => { throw new S.SchemeError('cannot-block', `${nm}: cannot wait here`, []); }, gen);
  const sleep = (ms: number) => new Promise(r => { const h = setTimeout(r, ms); h.unref(); });
  const isKw = (x: SchemeValue): boolean => x instanceof S.Sym && x.name.length > 1 && x.name[0] === ':';
  /* Keyword arguments as an object of raw Scheme values. */
  const kw = (args: SchemeValue[], who: string): Record<string, SchemeValue> => {
    const o: Record<string, SchemeValue> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!isKw(args[i])) throw new S.SchemeError('wrong-type-argument', `${who}: expected a keyword, got ${S.write(args[i])}`, [args[i]]);
      if (i + 1 >= args.length) throw new S.SchemeError('wrong-number-of-arguments', `${who}: ${args[i].name} needs a value`, []);
      o[args[i].name.slice(1)] = args[i + 1];
    }
    return o;
  };
  const proc = (x: SchemeValue, who: string): Process => { if (!(x instanceof Process)) throw S.typeErr('process', x, who); return x; };
  const absent = (x: SchemeValue): boolean => x === undefined || x === false;
  const optStr = (x: SchemeValue, k: string, who: string): string | null => { if (absent(x)) return null; if (typeof x !== 'string') throw S.typeErr('string', x, `${who} ${k}`); return x; };
  const optProc = (x: SchemeValue, k: string, who: string): SchemeValue | null => { if (absent(x)) return null; if (typeof x !== 'function') throw S.typeErr('procedure', x, `${who} ${k}`); return x; };
  const bufferArg = (x: SchemeValue, who: string): EdBuffer | null => {
    if (absent(x)) return null;
    if (x === true) return E.current;
    if (x instanceof Ed.Buffer) return x;
    if (typeof x === 'string') return Ed.getBufferCreate(x);
    throw S.typeErr('buffer, buffer name or #t', x, `${who} :buffer`);
  };
  const envArg = (x: SchemeValue, who: string): Record<string, string> | null => {
    if (absent(x)) return null;
    const out: Record<string, string> = {};
    const put = (k: SchemeValue, v: SchemeValue) => { out[k instanceof S.Sym ? k.name : String(k)] = String(v); };
    if (x instanceof Map) for (const [k, v] of x) put(k, v);
    else for (const e of S.arr(x)) { if (e instanceof S.Pair) put(e.car, e.cdr); else if (typeof e === 'string' && e.includes('=')) { const i = e.indexOf('='); put(e.slice(0, i), e.slice(i + 1)); } else throw new S.SchemeError('wrong-type-argument', `${who} :env: an alist of names to values`, [e]); }
    if (Object.keys(out).length > ENV_MAX) throw new S.SchemeError('error', `${who} :env: at most ${ENV_MAX} entries`, []);
    return out;
  };
  const sizeArg = (x: SchemeValue, who: string): [number, number] => {
    if (absent(x)) return [DEFAULT_COLS, DEFAULT_ROWS];
    let cols: SchemeValue, rows: SchemeValue;
    if (x instanceof S.Pair) { cols = x.car; rows = x.cdr instanceof S.Pair ? x.cdr.car : x.cdr; }
    else if (Array.isArray(x)) [cols, rows] = x;
    else throw S.typeErr('(cols . rows)', x, `${who} :size`);
    return [S.int(cols, who), S.int(rows, who)];
  };
  const cwdArg = (x: SchemeValue, who: string): string | null => { const s = optStr(x, ':cwd', who); if (s !== null && !path.isAbsolute(s)) throw new S.SchemeError('error', `${who} :cwd must be an absolute path`, [s]); return s; };
  /* Options common to make-process, call-process and shell-run. */
  const spawnOpts = (o: Record<string, SchemeValue>, who: string) => {
    const [cols, rows] = sizeArg(o.size, who);
    return { shell: optStr(o.shell, ':shell', who), cwd: cwdArg(o.cwd, who), env: envArg(o.env, who), cols, rows, who };
  };
  const requireHub = (who: string): void => { if (!hub.up) throw new S.SchemeError('hub-error', `${who}: hub unreachable`, []); };
  const secs = (x: SchemeValue, who: string): number => { const n = S.num(x, who); if (!(n >= 0)) throw new S.SchemeError('range-error', `${who}: seconds must be non-negative`, [x]); return n; };

  blocking('make-process', '&rest :name :command :shell :cwd :env :size :buffer :filter :sentinel :card :noquery', 'Start COMMAND (a string in SHELL\'s syntax) as a hub PTY session (R4.43) and return the process.', function* (args) {
    const who = 'make-process', o = kw(args, who);
    const command = optStr(o.command, ':command', who);
    if (command === null) throw new S.SchemeError('error', `${who}: :command is required`, []);
    const nm = optStr(o.name, ':name', who) || command.split(/\s+/)[0] || 'process';
    return yield* P.spawnG({ ...spawnOpts(o, who), name: nm, command, buffer: bufferArg(o.buffer, who), filter: optProc(o.filter, ':filter', who), sentinel: optProc(o.sentinel, ':sentinel', who), card: S.truthy(o.card) && o.card !== undefined, noquery: S.truthy(o.noquery) && o.noquery !== undefined });
  });
  /* (%call-process command . opts) -> (status . output): a card-less PTY run to completion (R4.44). */
  blocking('%call-process', 'command &rest :shell :cwd :env :size :timeout', 'Run COMMAND to completion in a card-less hub PTY; (exit-status . output) with ANSI sequences stripped.', function* ([command, ...rest]) {
    const who = 'call-process';
    S.str(command, who);
    const o = kw(rest, who);
    for (const k of ['buffer', 'display', 'infile', 'destination']) delete o[k];   // the Scheme wrapper handles the destination
    const so = spawnOpts(o, who);
    requireHub(who);
    const shell = so.shell || hub.defaultShell();
    const cmd = POSIX_SHELLS.includes(shell) ? TERM_PREFIX + command : command;
    const p: Process = yield* P.spawnG({ ...so, shell, name: 'call-process', command: cmd, buffer: null, filter: null, sentinel: null, card: false, collect: true });
    const timeout = absent(o.timeout) ? null : secs(o.timeout, who);
    let r: Promise<{ ok?: boolean; v?: number | null; timeout?: boolean }> = p.exitPromise.then(v => ({ ok: true, v }));
    if (timeout !== null) r = Promise.race([r, sleep(timeout * 1000).then(() => ({ timeout: true }))]);
    const got = yield new S.Block(r, `process ${p.sid}`);
    if (got.timeout) {
      P.byId.delete(p.sid); p.deleted = true;
      hub.request({ t: 'pty.kill', sid: p.sid, forget: true }, KILL_TIMEOUT_MS).catch(() => {});
      throw new S.SchemeError('timeout', `${who}: the command did not finish in ${timeout} s`, [p]);
    }
    const out = stripAnsi(p.collect || '');
    /* The session is a corpse now: forget it so call-process leaves nothing in the hub's list. */
    P.byId.delete(p.sid); p.deleted = true;
    if (hub.up) hub.request({ t: 'pty.kill', sid: p.sid, forget: true }, KILL_TIMEOUT_MS).catch(() => {});
    return S.cons(P.exitStatusOf(p), out);
  });
  D('process?', 'x', '#t if X is a process.', ([x]) => x instanceof Process);
  L.alias('processp', 'process?');
  D('process-list', '', 'Every process of this image (card-less ones included, R9.22).', () => S.listOf(P.all()));
  D('get-process', 'name', 'The process named NAME, or #f.', ([n]) => (n instanceof Process ? n : P.byName(S.str(n, 'get-process')) || false));
  D('get-buffer-process', 'buffer', 'The process whose buffer is BUFFER, or #f.', ([b]) => P.byBuffer(Ed.toBuffer(b)) || false);
  D('process-name', 'process', 'The name of PROCESS.', ([p]) => proc(p, 'process-name').name);
  D('process-id', 'process', 'The pid of PROCESS, or #f.', ([p]) => { const q = proc(p, 'process-id'); return q.pid === null ? false : q.pid; });
  D('process-sid', 'process', 'The hub session id of PROCESS (ed-…).', ([p]) => proc(p, 'process-sid').sid);
  D('process-command', 'process', 'The argv the hub ran: (shell "-c" command), or (shell) for an interactive shell.', ([p]) => S.listOf(proc(p, 'process-command').argv));
  D('process-shell', 'process', 'The hub shell PROCESS runs in.', ([p]) => proc(p, 'process-shell').shell);
  D('process-cwd', 'process', 'The working directory PROCESS started in, or #f.', ([p]) => proc(p, 'process-cwd').cwd || false);
  D('process-buffer', 'process', 'The buffer of PROCESS, or #f.', ([p]) => { const b = proc(p, 'process-buffer').buffer; return b && E.buffers.includes(b) ? b : false; });
  D('set-process-buffer', 'process buffer', 'Send the output of PROCESS to BUFFER (#f for none); the process mark moves to its end.', ([p, b]) => { proc(p, 'set-process-buffer').setBuffer(bufferArg(b, 'set-process-buffer')); return b; });
  D('process-mark', 'process', 'The marker where output of PROCESS is inserted.', ([p]) => { const q = proc(p, 'process-mark'); if (!q.mark) q.mark = new Ed.Marker(null, null, 'after'); return q.mark; });
  D('process-filter', 'process', 'The filter of PROCESS, or #f.', ([p]) => proc(p, 'process-filter').filter || false);
  D('set-process-filter', 'process filter', 'Call FILTER with (process string) for each chunk of output, on a background thread; #f inserts into the buffer again.', ([p, f]) => { proc(p, 'set-process-filter').filter = optProc(f, 'filter', 'set-process-filter'); return f; });
  D('process-sentinel', 'process', 'The sentinel of PROCESS, or #f.', ([p]) => proc(p, 'process-sentinel').sentinel || false);
  D('set-process-sentinel', 'process sentinel', 'Call SENTINEL with (process event) when PROCESS exits, on a background thread.', ([p, f]) => { proc(p, 'set-process-sentinel').sentinel = optProc(f, 'sentinel', 'set-process-sentinel'); return f; });
  D('process-status', 'process', 'run, exit, signal, failed or deleted, from the hub\'s session Summary (R4.43).', ([p]) => S.intern(P.statusOf(proc(p, 'process-status'))));
  D('process-exit-status', 'process', 'The exit code of PROCESS, or the signal number when it was killed; 0 while it runs.', ([p]) => P.exitStatusOf(proc(p, 'process-exit-status')));
  D('process-live-p', 'process', '#t while PROCESS runs.', ([p]) => P.live(proc(p, 'process-live-p')));
  L.alias('process-live?', 'process-live-p');
  D('process-card-p', 'process', '#t if PROCESS was made with :card t.', ([p]) => proc(p, 'process-card-p').card);
  D('process-type', 'process', 'Always real: every process is a hub PTY.', ([p]) => (proc(p, 'process-type'), S.intern('real')));
  D('process-get', 'process prop', 'The value of PROP on PROCESS, or #f.', ([p, k]) => { const v = proc(p, 'process-get').plist.get(S.sym(k, 'process-get').name); return v === undefined ? false : v; });
  D('process-put', 'process prop value', 'Set PROP on PROCESS.', ([p, k, v]) => { proc(p, 'process-put').plist.set(S.sym(k, 'process-put').name, v); return v; });
  D('process-plist', 'process', 'The properties of PROCESS as a plist.', ([p]) => S.listOf([...proc(p, 'process-plist').plist].flatMap(([k, v]) => [S.intern(k), v])));
  D('process-query-on-exit-flag', 'process', 'Whether exiting asks about PROCESS (recorded only).', ([p]) => proc(p, 'process-query-on-exit-flag').queryOnExit);
  D('set-process-query-on-exit-flag', 'process flag', 'Record whether exiting asks about PROCESS.', ([p, f]) => { proc(p, 'set-process-query-on-exit-flag').queryOnExit = S.truthy(f); return f; });
  D('process-send-string', 'process string', 'Send STRING to PROCESS as pty.input, split at 1 MiB (R4.43).', ([p, s]) => {
    const q = proc(p, 'process-send-string'); S.str(s, 'process-send-string');
    if (q.exited || q.deleted) throw new S.SchemeError('process-error', `process-send-string: ${q.name} is not running`, [q]);
    try { hub.ptyInput(q.sid, s); } catch (e) { throw P.hubErr(e, 'process-send-string'); }
    return S.UNSPEC;
  });
  D('process-send-eof', 'process', 'Send end of input (C-d) to PROCESS.', ([p]) => { const q = proc(p, 'process-send-eof'); try { hub.ptyInput(q.sid, '\x04'); } catch (e) { throw P.hubErr(e, 'process-send-eof'); } return q; });
  D('interrupt-process', 'process', 'Send C-c to PROCESS (R4.43).', ([p]) => { const q = proc(p, 'interrupt-process'); try { hub.ptyInput(q.sid, '\x03'); } catch (e) { throw P.hubErr(e, 'interrupt-process'); } return q; });
  const killG = (who: string, forgetOf: (q: Process) => boolean) => function* ([p]: SchemeValue[]): SchemeGen {
    const q = proc(p, who);
    if (q.deleted) return q;
    const forget = forgetOf(q);
    try { yield new S.Block(hub.request({ t: 'pty.kill', sid: q.sid, forget }, KILL_TIMEOUT_MS), `pty.kill ${q.sid}`); }
    catch (e) { if (!(e instanceof HubError && e.code === 'not_found')) throw P.hubErr(e, who); }
    if (forget) { P.byId.delete(q.sid); q.deleted = true; if (!q.exited) P.finish(q, { code: null, signal: null, reason: 'killed' }); q.status = 'deleted'; P.scheduleList(); }
    return q;
  };
  blocking('kill-process', 'process', 'End PROCESS with pty.kill; a card-less process is also forgotten by the hub (R4.43).', killG('kill-process', q => !q.card));
  blocking('delete-process', 'process', 'Kill PROCESS, forget its hub session and drop it from the process list.', killG('delete-process', () => true));
  blocking('accept-process-output', '[process [seconds]]', 'Wait for output from PROCESS (any process when #f) to arrive and its filter to run, unless some did since the last call; #t if some did, #f after SECONDS.', function* ([p, s]) {
    const procs = absent(p) ? P.all() : [proc(p, 'accept-process-output')];
    if (!procs.length) return false;
    /* As in Emacs, output that arrived since the last call counts: the filter or the insertion already ran. */
    if (procs.some(q => q.unseen > 0)) { for (const q of procs) q.unseen = 0; return true; }
    let r = new Promise(resolve => P.outWaiters.push({ procs, resolve }));
    if (!absent(s)) r = Promise.race([r, sleep(secs(s, 'accept-process-output') * 1000).then(() => false)]);
    return yield new S.Block(r, 'process output');
  });
  blocking('process-wait', 'process [seconds]', 'Wait until PROCESS exits; its exit status, or the timeout condition after SECONDS.', function* ([p, s]) {
    const q = proc(p, 'process-wait');
    let r: Promise<{ v?: number | null; timeout?: boolean }> = q.exitPromise.then(v => ({ v }));
    if (!absent(s)) r = Promise.race([r, sleep(secs(s, 'process-wait') * 1000).then(() => ({ timeout: true }))]);
    const got = yield new S.Block(r, `process ${q.sid}`);
    if (got.timeout) throw new S.SchemeError('timeout', `process-wait: ${q.name} did not exit in ${s} s`, [q]);
    return P.exitStatusOf(q);
  });
  blocking('%process-list-refresh', '', 'Render *Process List* and share it as name:*Process List*; the buffer id.', function* () {
    yield new S.Block(P.refreshList(true), 'the process list');
    return LIST_BUFFER_ID;
  });
  D('%process-summary', 'process', 'The hub Summary of PROCESS as an alist, or #f.', ([p]) => { const s = hub.sessions.get(proc(p, '%process-summary').sid); return s ? jsonToScheme(S, s) : false; });

  L.evalText(fs.readFileSync(SCM_FILE, 'utf8'));
}

export async function shutdown(server: Server): Promise<void> { if (server.processes) server.processes.shutdown(); }
