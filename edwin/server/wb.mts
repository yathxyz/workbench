// Workbench objects, the session family and the events (spec §5: R5.2, R5.3 session API, R5.4, R5.7, R5.8;
// §13.3). The spec puts these primitives in edwin/src/wb.js; server-only code of this repository lives in
// edwin/server, so they are here (a recorded deviation) and edwin/scm/wb.scm wraps them.
//
// Sessions are handles: one interned object per sid (eq? after interning), printed #<session pty ed-…>,
// valid for ever; reading a forgotten session raises stale-object (§5.2). Their facts come from the hub's
// Summaries, which the one `watch` of hub.mts keeps current (R5.7); the hub down raises hub-error.
//
// The board family (cards, edges, views) is absent until EW-M4 lands: (featurep 'wb-board) is #f (R5.3).
// card-send, card-read, card-interrupt and card-kill take a session (or a process); card-session accepts a
// session or a process. The card events (wb-card-*-functions) need no leader: they come from diffing
// successive saves of the board file in boardsDir (fs.watch on the directory, the file is replaced
// atomically), and fire after a save.
//
// Every event runs its hook's procedures on a background thread (threads.mts), never from the event
// handler itself. wb-session-output-functions attaches edwind to a PTY it did not spawn only while the hook
// is non-empty and the session has viewers (R5.7), and detaches when the hook empties; the output of
// edwind's own processes reaches the hook too. Calls are rate-limited to one per session per 100 ms with
// the text coalesced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubError, KILL_TIMEOUT_MS, FG_POLL_MS, CAPTURE_MAX, CMD_TIMEOUT_DEFAULT_MS } from './hub.mts';
import { Process, stripAnsi } from './process.mts';
import { jsonToScheme } from './threads.mts';
import type { Server, Log, Lisp, SchemeValue } from './main.mts';
import type { Hub, Summary, SessionKind, HubMessage, AcpEvent } from './hub.mts';
import type { Scheduler, SchemeGen, Thread } from './threads.mts';
import type { SBuf } from './buffers.mts';

/* The evaluator S of edwin/src, untyped JavaScript like the rest of L. */
type Scheme = Lisp['S'];
/* A function receiving the acp.* messages of one session, and {t: 'down'} when the hub goes away. */
export type AcpCollector = (m: HubMessage) => void;
/* The output of one session waiting to reach wb-session-output-functions. */
interface OutPending { text: string; timer: NodeJS.Timeout | null; last: number }
interface SessionWaiter { sid: string; resolve: (s: Summary | null) => void }
/* A node of the board file (boardsDir/<host>.json), as saved by the board. */
export interface BoardNode { id?: string; x?: unknown; y?: unknown; [k: string]: unknown }
export type BoardNodes = Record<string, BoardNode>;
type PrimFn = (args: SchemeValue[]) => SchemeValue;
type PrimGen = (args: SchemeValue[]) => SchemeGen;

export const name = 'wb';
export const OUTPUT_COALESCE_MS = 100;
export const BOARD_DEBOUNCE_MS = 200;
export const SHELL_RUN_TIMEOUT_S = 600;
export const CAPTURE_DEFAULT = 200;                        // crates/wb-hub/src/conn.rs CAPTURE_DEFAULT
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCM_FILE = path.join(HERE, '..', 'scm', 'wb.scm');
export const HOOKS = {
  'wb-session-exit-functions': 'Called with (session exit-code) when a hub session ends (§5).',
  'wb-session-output-functions': 'Called with (session text) for PTY output, at most once per session per 100 ms (§5, R5.7).',
  'wb-acp-turn-end-functions': 'Called with (session stop-reason) when an agent session\'s turn ends (§5).',
  'wb-page-saved-functions': 'Called with (buffer) when edwind saves a page (§5).',
  'wb-card-created-functions': 'Called with (card-id node) after a board save added a card (§5).',
  'wb-card-deleted-functions': 'Called with (card-id node) after a board save removed a card (§5).',
  'wb-card-moved-functions': 'Called with (card-id node) after a board save moved a card (§5).',
};

export class Session {
  declare sid: string;
  declare kind: SessionKind | undefined;
  constructor(sid: string) { this.sid = sid; }
  __print() { return `#<session ${this.kind || '?'} ${this.sid}>`; }
  toString() { return this.__print(); }
  get __type() { return 'session'; }
}

export class Wb {
  declare server: Server; declare log: Log; declare L: Lisp; declare S: Scheme;
  declare handles: Map<string, Session>;
  declare attached: Map<string, true>;
  declare attaching: Set<string>;
  declare outPending: Map<string, OutPending>;
  declare sessionWaiters: SessionWaiter[];
  declare acpCollectors: Map<string, Set<AcpCollector>>;
  declare boardNodes: BoardNodes | null; declare boardTimer: NodeJS.Timeout | null; declare boardWatcher: fs.FSWatcher | null;
  constructor(server: Server) {
    this.server = server; this.log = server.log; this.L = server.L; this.S = server.L.S;
    this.handles = new Map();                              // sid -> Session (interned, §5.2)
    this.attached = new Map();                             // sid -> true: PTYs attached for wb-session-output-functions
    this.attaching = new Set();
    this.outPending = new Map();                           // sid -> {text, timer, last}
    this.sessionWaiters = [];                              // {sid, resolve}: the next Summary of a session
    this.acpCollectors = new Map();                        // sid -> Set of functions receiving acp.* messages
    this.boardNodes = null; this.boardTimer = null; this.boardWatcher = null;
  }
  get hub(): Hub { return this.server.hub; }
  get threads(): Scheduler { return this.server.threads; }
  handle(sid: string): Session { let h = this.handles.get(sid); if (!h) { h = new Session(sid); this.handles.set(sid, h); } const s = this.hub.sessions.get(sid); if (s) h.kind = s.kind; return h; }
  /* Run the procedures of hook NAME with ARGS on one background thread. */
  runHook(nm: string, args: SchemeValue[]): Thread | null {
    const S = this.S, fns = this.L.hookFns(nm);
    if (!fns.length) return null;
    return this.threads.spawn(function* () { for (const f of fns) yield* S.applyG(f, args); }, { kind: 'background', name: nm, debugOnError: false });
  }
  /* ---------- Summary changes ---------- */
  onSession(s: Summary, prev: Summary | null) {
    const h = this.handle(s.sid);
    if (prev && prev.alive && !s.alive) {
      const ex = s.pty && s.pty.exit;
      this.runHook('wb-session-exit-functions', [h, ex && ex.code !== null && ex.code !== undefined ? ex.code : false]);
    }
    if (s.acp && s.acp.last && prev && (!prev.acp || !prev.acp.last || prev.acp.last.seq !== s.acp.last.seq)) this.runHook('wb-acp-turn-end-functions', [h, s.acp.last.outcome || 'end_turn']);
    const rest: SessionWaiter[] = []; for (const w of this.sessionWaiters) { if (w.sid === s.sid) w.resolve(s); else rest.push(w); } this.sessionWaiters = rest;
    this.reconcile();
  }
  onGone(m: HubMessage) { this.attached.delete(m.sid!); const rest: SessionWaiter[] = []; for (const w of this.sessionWaiters) { if (w.sid === m.sid) w.resolve(null); else rest.push(w); } this.sessionWaiters = rest; }
  onDown() { this.attached.clear(); this.attaching.clear(); for (const w of this.sessionWaiters) w.resolve(null); this.sessionWaiters = []; for (const set of this.acpCollectors.values()) for (const f of set) f({ t: 'down' }); }
  nextSummary(sid: string): Promise<Summary | null> { return new Promise(resolve => this.sessionWaiters.push({ sid, resolve })); }

  /* ---------- wb-session-output-functions attachments (R5.7) ---------- */
  outputWanted() { return this.hub.up && this.L.hookFns('wb-session-output-functions').length > 0; }
  reconcile() {
    if (!this.outputWanted()) { for (const sid of [...this.attached.keys()]) this.detach(sid); return; }
    for (const s of this.hub.sessions.values()) {
      if (s.kind !== 'pty' || !s.alive || !(s.viewers >= 1)) continue;
      if (this.server.processes && this.server.processes.byId.has(s.sid)) continue;   // our own: attached by the spawn
      if (this.attached.has(s.sid) || this.attaching.has(s.sid)) continue;
      this.attach(s.sid);
    }
  }
  attach(sid: string) {
    this.attaching.add(sid);
    /* The size is applied only to a sole viewer (attach_live); with viewers >= 1 it is not, and edwind never resizes (R5.7). */
    this.hub.request({ t: 'pty.open', sid, cols: 80, rows: 24 }).then(() => { this.attaching.delete(sid); if (this.outputWanted()) { this.attached.set(sid, true); this.log.info('wb', { event: 'attached', sid }); } else this.detach(sid); },
      (e: HubError) => { this.attaching.delete(sid); this.log.debug('wb', { event: 'attach failed', sid, code: e.code || null }); });
  }
  detach(sid: string) {
    this.attached.delete(sid);
    if (this.hub.up) this.hub.request({ t: 'pty.detach', sid }).catch(() => {});
    this.log.info('wb', { event: 'detached', sid });
  }
  onOut(m: HubMessage) { if (this.attached.has(m.sid!) && typeof m.d === 'string') this.coalesce(m.sid!, m.d); }
  coalesce(sid: string, d: string) {
    let p = this.outPending.get(sid);
    if (!p) { p = { text: '', timer: null, last: 0 }; this.outPending.set(sid, p); }
    p.text += d;
    if (p.timer) return;
    const wait = Math.max(0, p.last + OUTPUT_COALESCE_MS - Date.now());
    p.timer = setTimeout(() => { p!.timer = null; p!.last = Date.now(); const text = p!.text; p!.text = ''; if (!text) return; this.runHook('wb-session-output-functions', [this.handle(sid), text]); }, wait);
    p.timer.unref();
  }

  /* ---------- ACP attachments (card-read, acp-prompt) ---------- */
  collect(sid: string, fn: AcpCollector): () => void { let set = this.acpCollectors.get(sid); if (!set) { set = new Set(); this.acpCollectors.set(sid, set); } set.add(fn); return () => { set!.delete(fn); if (!set!.size) this.acpCollectors.delete(sid); }; }
  onAcp(m: HubMessage) { const set = this.acpCollectors.get(m.sid!); if (set) for (const f of set) f(m); }
  /* The Org transcript of a replay's events (§5.3 card-read for an ACP session). */
  static transcript(events: (AcpEvent | null | undefined)[]): string {
    const out: string[] = [];
    let agent = '';
    const flush = () => { if (agent.trim()) out.push('* Agent', '', agent.trimEnd(), ''); agent = ''; };
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.e === 'prompt') { flush(); const text = (Array.isArray(ev.prompt) ? ev.prompt : []).map(b => (b && b.type === 'text' ? b.text : b && b.type ? `[${b.type}]` : '')).join('\n'); out.push('* User', '', text, ''); }
      else if (ev.e === 'update' && ev.update && ev.update.sessionUpdate === 'agent_message_chunk' && ev.update.content && ev.update.content.type === 'text') agent += ev.update.content.text || '';
      else if (ev.e === 'turn_end') flush();
      else if (ev.e === 'turn_error') { flush(); out.push(`* Error: ${ev.message || ev.code || 'turn failed'}`, ''); }
    }
    flush();
    return out.join('\n');
  }

  /* ---------- board file events (§5 events, no leader needed) ---------- */
  boardFile(): string | null { const d = this.server.cfg.boardsDir; return d ? path.join(d, `${this.server.cfg.host}.json`) : null; }
  readBoardNodes(): BoardNodes | null {
    const f = this.boardFile();
    try { const j: { nodes?: unknown } | null = JSON.parse(fs.readFileSync(f!, 'utf8')); const n = j && j.nodes; if (!n) return {}; if (Array.isArray(n)) { const o: BoardNodes = {}; for (const x of n) if (x && x.id) o[x.id] = x; return o; } return typeof n === 'object' ? n as BoardNodes : {}; }
    catch (e) { return null; }
  }
  watchBoard() {
    const f = this.boardFile(); if (!f) return;
    const dir = path.dirname(f), base = path.basename(f);
    this.boardNodes = this.readBoardNodes();
    try { this.boardWatcher = fs.watch(dir, (ev, fn) => { if (fn && fn !== base) return; this.scheduleBoardDiff(); }); this.boardWatcher.unref(); }
    catch (e) { this.log.debug('wb', { event: 'no board watch', error: e.code || e.message }); }
  }
  scheduleBoardDiff() { if (this.boardTimer) clearTimeout(this.boardTimer); this.boardTimer = setTimeout(() => { this.boardTimer = null; this.boardDiff(); }, BOARD_DEBOUNCE_MS); this.boardTimer.unref(); }
  boardDiff() {
    const now = this.readBoardNodes(); if (!now) return;
    const S = this.S, prev = this.boardNodes || {};
    this.boardNodes = now;
    for (const id of Object.keys(now)) {
      if (!prev[id]) this.runHook('wb-card-created-functions', [id, jsonToScheme(S, now[id])]);
      else if (prev[id].x !== now[id].x || prev[id].y !== now[id].y) this.runHook('wb-card-moved-functions', [id, jsonToScheme(S, now[id])]);
    }
    for (const id of Object.keys(prev)) if (!now[id]) this.runHook('wb-card-deleted-functions', [id, jsonToScheme(S, prev[id])]);
  }
  shutdown() {
    if (this.boardWatcher) this.boardWatcher.close();
    if (this.boardTimer) clearTimeout(this.boardTimer);
    for (const p of this.outPending.values()) if (p.timer) clearTimeout(p.timer);
    for (const w of this.sessionWaiters) w.resolve(null);
  }
}

/* ---------- the module ---------- */
export async function install(server: Server) {
  const { L, Ed } = server, S = L.S, E = Ed.E;
  const W = new Wb(server);
  server.wb = W;
  const hub = server.hub, P = server.processes;
  for (const [nm, doc] of Object.entries(HOOKS)) L.defvar(nm, S.NIL, doc);
  /* Setting wb-session-output-functions (add-hook!, set!) attaches or detaches at once. */
  { const box = S.gbox('wb-session-output-functions'); let val = box.value; Object.defineProperty(box, 'value', { get: () => val, set: (v: SchemeValue) => { val = v; queueMicrotask(() => W.reconcile()); }, configurable: true }); }
  hub.on('session', (s, prev) => W.onSession(s, prev));
  hub.on('gone', m => W.onGone(m));
  hub.on('down', () => W.onDown());
  hub.on('up', () => W.reconcile());
  hub.on('pty.out', m => W.onOut(m));
  hub.on('process.out', (p, d) => { if (W.outputWanted()) W.coalesce(p.sid, d); });
  for (const t of ['acp.ev', 'acp.replayed', 'acp.info'] as const) hub.on(t, m => W.onAcp(m));
  server.buffers.on('saved', (sb: SBuf) => W.runHook('wb-page-saved-functions', [sb.ed]));
  W.watchBoard();
  server.statusProviders.push(() => ({ wbAttached: W.attached.size }));

  const D = (nm: string, args: string, doc: string, fn: PrimFn, gen?: PrimGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
  const blocking = (nm: string, args: string, doc: string, gen: PrimGen) => D(nm, args, doc, () => { throw new S.SchemeError('cannot-block', `${nm}: cannot wait here`, []); }, gen);
  const sleep = (ms: number) => new Promise<void>(r => { const h = setTimeout(r, ms); h.unref(); });
  const absent = (x: SchemeValue) => x === undefined || x === false;
  const requireHub = (who: string) => { if (!hub.up) throw new S.SchemeError('hub-error', `${who}: hub unreachable`, []); };
  const hubErr = (e: unknown, who: string) => hub.toCondition(e, who);
  /* A target (§5.3): a session handle, a sid string or a process; its sid. */
  const sidOf = (x: SchemeValue, who: string): string => {
    if (x instanceof Session) return x.sid;
    if (x instanceof Process) return x.sid;
    if (typeof x === 'string') return x;
    throw S.typeErr('session, sid or process', x, who);
  };
  /* The Summary of X, or stale-object (hub-error while the hub is down). */
  const summaryOf = (x: SchemeValue, who: string): Summary => {
    requireHub(who);
    const sid = sidOf(x, who), s = hub.sessions.get(sid);
    if (!s) throw new S.SchemeError('stale-object', `${who}: the hub has no session ${sid}`, [W.handle(sid)]);
    return s;
  };
  const field = (s: Summary, f: string, who: string): SchemeValue => {
    const al = (v: unknown) => (v === null || v === undefined ? false : jsonToScheme(S, v));
    switch (f) {
      case 'sid': case 'id': return s.sid;
      case 'kind': return S.intern(s.kind);
      case 'agent': return s.acp ? s.acp.agent : false;
      case 'cwd': return s.cwd;
      case 'alive': return !!s.alive;
      case 'exit': return al(s.pty ? s.pty.exit : null);
      case 'title': return s.acp ? (s.acp.title || false) : s.pty && s.pty.fg ? s.pty.fg.comm : s.pty && s.pty.argv && s.pty.argv.length ? path.basename(s.pty.argv[0]) : false;
      case 'viewers': return s.viewers || 0;
      case 'pid': return s.pty && s.pty.pid !== undefined ? s.pty.pid : false;
      case 'fg': return al(s.pty ? s.pty.fg : null);
      case 'fault': return al(s.fault);
      case 'host': return s.host;
      case 'created-at': return s.createdAt;
      case 'updated-at': return s.updatedAt;
      case 'activity': return s.acp ? S.intern(s.acp.activity) : false;
      case 'summary': return jsonToScheme(S, s);
      default: throw new S.SchemeError('error', `${who}: unknown session field ${f}`, [S.intern(f)]);
    }
  };

  D('session?', 'x', '#t if X is a session handle.', ([x]) => x instanceof Session);
  D('session-id', 'session', 'The sid of SESSION.', ([s]) => { if (!(s instanceof Session)) throw S.typeErr('session', s, 'session-id'); return s.sid; });
  D('session-list', '', 'A handle for every hub session (R5.7).', () => { requireHub('session-list'); return S.listOf([...hub.sessions.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(s => W.handle(s.sid))); });
  D('session-get', 'id-or-session [field]', 'With one argument the interned handle of the session ID (a sid or a handle); with FIELD (kind, agent, cwd, alive, exit, title, viewers, pid, fg, fault, host, created-at, updated-at, activity, summary) that fact from its Summary.', ([x, f]: SchemeValue[]) => {
    const s = summaryOf(x, 'session-get');
    if (f === undefined) return W.handle(s.sid);
    return field(s, S.sym(f, 'session-get').name, 'session-get');
  });
  D('session-summary', 'session', 'The hub Summary of SESSION as an alist.', ([x]) => jsonToScheme(S, summaryOf(x, 'session-summary')));
  D('%session-handle-or-false', 'sid', 'The handle of SID when the hub lists it, else #f.', ([sid]) => (hub.sessions.has(S.str(sid, '%session-handle-or-false')) ? W.handle(sid) : false));
  D('card-session', 'target', 'The session of TARGET: a session handle, or a process (its hub session). Cards arrive with the board family (EW-M4).', ([x]) => {
    if (x instanceof Session) return x;
    if (x instanceof Process) return W.handle(x.sid);
    throw S.typeErr('session or process (cards need the board family, which is absent until EW-M4)', x, 'card-session');
  });
  blocking('%card-send', 'target string', 'pty.input for a PTY session (no attach needed); acp.prompt with one text block for an agent session.', function* ([x, text]: SchemeValue[]) {
    const who = 'card-send', s = summaryOf(x, who); S.str(text, who);
    if (s.kind === 'acp') { try { yield new S.Block(hub.request({ t: 'acp.prompt', sid: s.sid, prompt: [{ type: 'text', text }] }), 'acp.prompt'); } catch (e) { throw hubErr(e, who); } return W.handle(s.sid); }
    try { hub.ptyInput(s.sid, text); } catch (e) { throw hubErr(e, who); }
    return W.handle(s.sid);
  });
  blocking('%card-read', 'target lines', 'The last LINES lines of a PTY (pty.capture) or the Org transcript of an agent session (an acp.open replay).', function* ([x, n]: SchemeValue[]) {
    const who = 'card-read', s = summaryOf(x, who);
    const lines = absent(n) ? CAPTURE_DEFAULT : Math.min(CAPTURE_MAX, Math.max(1, S.int(n, who)));
    if (s.kind !== 'acp') { try { const r: { text?: unknown } = yield new S.Block(hub.request({ t: 'pty.capture', sid: s.sid, lines }), 'pty.capture'); return typeof r.text === 'string' ? r.text : ''; } catch (e) { throw hubErr(e, who); } }
    const events: (AcpEvent | undefined)[] = [];
    let done!: { resolve: (m: HubMessage) => void; reject: (e: Error) => void };
    const replayed = new Promise<HubMessage>((resolve, reject) => { done = { resolve, reject }; });
    const stop = W.collect(s.sid, m => { if (m.t === 'acp.ev') events.push(m.ev); else if (m.t === 'acp.replayed') done.resolve(m); else if (m.t === 'down') done.reject(new HubError('unavailable', 'the hub connection closed')); });
    try {
      yield new S.Block(hub.request({ t: 'acp.open', sid: s.sid, since: 0 }), 'acp.open');
      yield new S.Block(Promise.race([replayed, sleep(CMD_TIMEOUT_DEFAULT_MS).then(() => { throw new HubError('timeout', 'the replay did not finish in time'); })]), 'acp replay');
    } catch (e) { throw hubErr(e, who); }
    finally { stop(); if (hub.up) hub.request({ t: 'acp.detach', sid: s.sid }).catch(() => {}); }
    return Wb.transcript(events);
  });
  blocking('card-interrupt', 'target', 'C-c to a PTY session; acp.cancel to an agent session.', function* ([x]: SchemeValue[]) {
    const who = 'card-interrupt', s = summaryOf(x, who);
    try { if (s.kind === 'acp') yield new S.Block(hub.request({ t: 'acp.cancel', sid: s.sid }), 'acp.cancel'); else hub.ptyInput(s.sid, '\x03'); } catch (e) { throw hubErr(e, who); }
    return W.handle(s.sid);
  });
  blocking('%card-kill', 'target', 'pty.kill or acp.kill without forget (the session stays listed as exited).', function* ([x]: SchemeValue[]) {
    const who = 'card-kill', s = summaryOf(x, who);
    try { yield new S.Block(hub.request({ t: s.kind === 'acp' ? 'acp.kill' : 'pty.kill', sid: s.sid, forget: false }, KILL_TIMEOUT_MS), 'kill'); } catch (e) { throw hubErr(e, who); }
    return W.handle(s.sid);
  });
  /* acp-prompt: attach from the Summary's headSeq (no replay), send the prompt, collect the agent's text until
     turn_end, detach (§5.3). */
  function* acpPromptG(x: SchemeValue, text: string, timeoutS: number | null, who: string): SchemeGen {
    const s = summaryOf(x, who); S.str(text, who);
    if (s.kind !== 'acp') throw new S.SchemeError('wrong-type-argument', `${who}: ${s.sid} is not an agent session`, [W.handle(s.sid)]);
    let agent = '', settle!: { resolve: (reason: string) => void; reject: (e: unknown) => void };
    const ended = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
    let replayedResolve!: (m: HubMessage) => void; const replayed = new Promise<HubMessage>(r => { replayedResolve = r; });
    const stop = W.collect(s.sid, m => {
      if (m.t === 'acp.replayed') { replayedResolve(m); return; }
      if (m.t === 'down') { settle.reject(new HubError('unavailable', 'the hub connection closed')); return; }
      if (m.t !== 'acp.ev' || !m.ev) return;
      const ev = m.ev;
      if (ev.e === 'update' && ev.update && ev.update.sessionUpdate === 'agent_message_chunk' && ev.update.content && ev.update.content.type === 'text') agent += ev.update.content.text || '';
      else if (ev.e === 'turn_end') settle.resolve(ev.stopReason || 'end_turn');
      else if (ev.e === 'turn_error') settle.reject(new S.SchemeError('error', `${who}: ${ev.message || ev.code || 'the turn failed'}`, []));
      else if (ev.e === 'exit') settle.reject(new S.SchemeError('error', `${who}: the agent exited`, []));
    });
    try {
      const since = s.acp && typeof s.acp.headSeq === 'number' ? s.acp.headSeq : 0;
      yield new S.Block(hub.request({ t: 'acp.open', sid: s.sid, since, epoch: s.createdAt }), 'acp.open');
      yield new S.Block(Promise.race([replayed, sleep(CMD_TIMEOUT_DEFAULT_MS).then(() => { throw new HubError('timeout', 'the replay did not finish in time'); })]), 'acp replay');
      yield new S.Block(hub.request({ t: 'acp.prompt', sid: s.sid, prompt: [{ type: 'text', text }] }), 'acp.prompt');
      let p: Promise<unknown> = ended;
      if (timeoutS !== null) p = Promise.race([p, sleep(timeoutS * 1000).then(() => { throw new S.SchemeError('timeout', `${who}: the turn did not end in ${timeoutS} s`, []); })]);
      yield new S.Block(p, `the turn of ${s.sid}`);
    } catch (e) { throw hubErr(e, who); }
    finally { stop(); if (hub.up) hub.request({ t: 'acp.detach', sid: s.sid }).catch(() => {}); }
    return agent;
  }
  const secsOpt = (x: SchemeValue, who: string): number | null => (absent(x) ? null : (() => { const n = S.num(x, who); if (!(n >= 0)) throw new S.SchemeError('range-error', `${who}: seconds must be non-negative`, [x]); return n; })());
  blocking('acp-prompt', 'session text [timeout]', 'Send TEXT to the agent SESSION and wait for the turn to end; the agent\'s message. Permission requests go to the board as today (§5.3).', function* ([x, text, to]: SchemeValue[]) { return yield* acpPromptG(x, text, secsOpt(to, 'acp-prompt'), 'acp-prompt'); });
  D('acp-prompt-async', 'session text [timeout]', 'acp-prompt on a background thread; a mailbox that receives the agent\'s message, or (error . report) when the turn fails.', ([x, text, to]: SchemeValue[]) => {
    const who = 'acp-prompt-async'; summaryOf(x, who); S.str(text, who); const timeoutS = secsOpt(to, who);
    const mb = L.call('make-mailbox', []);
    W.threads.spawn(function* () {
      try { const v = yield* acpPromptG(x, text, timeoutS, who); L.call('mailbox-send!', [mb, v]); }
      catch (e) { L.call('mailbox-send!', [mb, S.cons(S.intern('error'), S.errorMessage(e))]); }
    }, { kind: 'background', name: who, debugOnError: false });
    return mb;
  });
  /* shell-run (§5.3): an interactive shell in a hub PTY with :card t, the command sent with a newline, then
     wait until the Summary shows the shell itself in the foreground again (pty.fg.leader true), which the
     hub re-polls about every 2 s, or the timeout; the output since the send, ANSI stripped. */
  blocking('%shell-run', 'command shell cwd timeout', 'Run COMMAND in a new shell card and wait for the shell prompt to return; the output.', function* ([command, shell, cwd, to]: SchemeValue[]) {
    const who = 'shell-run'; S.str(command, who);
    const timeoutS = absent(to) ? SHELL_RUN_TIMEOUT_S : S.num(to, who);
    const p = yield* P.spawnG({ who, name: 'shell-run', command: null, shell: absent(shell) ? null : S.str(shell, who), cwd: absent(cwd) ? null : S.str(cwd, who), env: null, cols: 120, rows: 40, buffer: null, filter: null, sentinel: null, card: true, collect: true });
    const deadline = Date.now() + timeoutS * 1000;
    const waitSummary = (ms: number) => Promise.race([W.nextSummary(p.sid), sleep(ms).then(() => undefined)]);
    /* The shell is up once the hub has polled a foreground group (fg present); one poll period at most. */
    for (let i = 0; i < 2; i++) { const s = hub.sessions.get(p.sid); if (s && s.pty && s.pty.fg) break; yield new S.Block(waitSummary(FG_POLL_MS), 'the shell'); }
    p.collect = '';
    const sentAt = Date.now();
    try { hub.ptyInput(p.sid, command + '\n'); } catch (e) { throw hubErr(e, who); }
    let sawBusy = false;
    for (;;) {
      const s = hub.sessions.get(p.sid);
      if (p.exited || (s && !s.alive)) break;                                   // the shell itself ended
      const fg = s && s.pty && s.pty.fg;
      if (fg && !fg.leader) sawBusy = true;
      else if (fg && fg.leader && (sawBusy || Date.now() - sentAt >= FG_POLL_MS)) break;
      const left = deadline - Date.now();
      if (left <= 0) throw new S.SchemeError('timeout', `${who}: the command did not finish in ${timeoutS} s`, [p]);
      yield new S.Block(waitSummary(Math.min(left, FG_POLL_MS)), 'the shell prompt');
    }
    return stripAnsi(p.collect || '');
  });
  D('%wb-run-hook', 'hook . args', 'Run HOOK\'s procedures with ARGS on a background thread (the events of §5); the thread.', ([h, ...a]: SchemeValue[]) => W.runHook(S.sym(h, '%wb-run-hook').name, a) || false);

  L.evalText(fs.readFileSync(SCM_FILE, 'utf8'));
}

export async function shutdown(server: Server) { if (server.wb) server.wb.shutdown(); }
