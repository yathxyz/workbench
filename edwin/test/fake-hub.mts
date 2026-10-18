// A fake hub for the process and wb suites: a Node net server on a unix socket speaking the hub protocol of
// crates/wb-proto/src/hub.rs (hello first, NDJSON, rid replies, watch events). It spawns nothing: a
// "program" is a JS function scripted by the test that writes pty.out and ends with pty.exit, and an
// interactive shell (a single-item argv) runs each input line as such a program while flipping the
// Summary's fg.leader, as the real hub's 2 s poll would. edwind never starts a process itself (R4.45): every
// process in these suites is a line on this socket.
import net from 'node:net';
import fs from 'node:fs';

/* A line of the hub protocol (crates/wb-proto/src/hub.rs). */
export type HubMsg = Record<string, any>; // any: wire JSON
export interface PtyExit { code: number | null; signal: number | null; reason: string; at: number }
export interface PtyFg { comm: string; pgid: number; leader: boolean }
/* A live PTY has pid and fg, an exited one exit. */
export interface PtyInfo { argv: string[]; pid?: number; fg?: PtyFg; exit?: PtyExit }
export interface AcpLast { seq: number; ts: number; outcome: string; error: string | null }
export interface AcpInfo {
  agent: string; agentSessionId: string; revivable: boolean; activity: string; pending: unknown[];
  last: AcpLast | null; headSeq: number; seenSeq: number; title: string; modeId: string;
}
interface SummaryBase { sid: string; host: string; createdAt: number; updatedAt?: number; alive: boolean; viewers: number; cwd: string; fault: null }
export interface PtySummary extends SummaryBase { kind: 'pty'; pty: PtyInfo }
export interface AcpSummary extends SummaryBase { kind: 'acp'; acp: AcpInfo }
export type SessionSummary = PtySummary | AcpSummary;
/* A PTY session: its output ring, its byte count and stream epoch, the input it got, and the program reading it. */
export interface PtySession {
  summary: PtySummary;
  ring: string; out: number; stream: number; inputs: string[]; program: null; inputFn: ((d: string) => void) | null;
  pendingInputs?: string[]; lastCode?: number; spawn?: HubMsg; shell?: string; cols?: number; rows?: number;
}
export interface AcpSession { summary: AcpSummary }
export type HubSession = PtySession | AcpSession;
/* One event of an ACP session's journal. */
export interface AcpEvent { seq: number; ts?: number; e?: string; [field: string]: unknown }
/* What a scripted program gets: write output, read input, wait. */
export interface ProgramIO { write(d: string): void; input(fn: (d: string) => void): void; delay(ms: number): Promise<void>; sess: PtySession }
export type Program = (io: ProgramIO, sess: PtySession, command: string) => Promise<number | void> | number | void;
/* A programs entry under 'refuse:COMMAND': the hub refuses the spawn with this error. */
export interface Refusal { code: string; message: string }
export interface HubConn { sock: net.Socket; watching: boolean; attached: Set<string>; hello: boolean; client?: unknown }
/* A request as the hub recorded it: the line, and the index of its connection. */
export type HubRequest = HubMsg & { conn: number };
interface HubWaiter { pred: (r: HubRequest) => boolean; n: number; resolve: () => void }
export interface FakeHubOptions { shells?: string[]; defaultShell?: string; proto?: number; sessions?: Map<string, HubSession> | null; host?: string }
export interface AddPtyOptions { alive?: boolean; viewers?: number; cwd?: string; argv?: string[]; leader?: boolean; exit?: PtyExit | null; env?: Record<string, string> }
export interface AddAcpOptions { alive?: boolean; agent?: string; title?: string; cwd?: string; headSeq?: number }

const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -\/]*[0-~]?/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '');

export class FakeHub {
  declare path: string; declare shells: string[]; declare defaultShell: string; declare proto: number; declare host: string;
  declare sessions: Map<string, HubSession>;
  declare conns: HubConn[]; declare requests: HubRequest[]; declare waiters: HubWaiter[]; declare pid: number;
  declare programs: Map<string, Program | Refusal>;
  declare acpReplies: Map<string, (prompt: string) => string>;
  declare acpReplays: Map<string, AcpEvent[]>;
  declare server: net.Server | null;
  constructor(path: string, { shells = ['bash', 'nu'], defaultShell = 'bash', proto = 1, sessions = null, host = 'testhost' }: FakeHubOptions = {}) {
    this.path = path; this.shells = shells; this.defaultShell = defaultShell; this.proto = proto; this.host = host;
    this.sessions = sessions || new Map();                  // sid -> {summary, ring, out, stream, program, acp}
    this.conns = []; this.requests = []; this.waiters = []; this.pid = 4000;
    /* command -> async (io, sess) => exit code; io: {write(text), input(fn), delay(ms)} */
    this.programs = new Map();
    this.acpReplies = new Map();                            // sid -> (promptText) => reply text
    this.acpReplays = new Map();                            // sid -> [journal events]
    this.server = null;
  }
  start(): Promise<this> {
    try { fs.unlinkSync(this.path); } catch (e) { /* none */ }
    this.server = net.createServer(sock => this.serve(sock));
    return new Promise((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.path, () => { fs.chmodSync(this.path, 0o600); resolve(this); }); });
  }
  stop(): Promise<void> {
    return new Promise(resolve => { for (const c of this.conns) c.sock.destroy(); this.conns = []; if (!this.server) return resolve(); this.server.close(() => resolve()); this.server = null; });
  }
  /* The requests so far matching PRED; waits until N have arrived. */
  waitFor(pred: (r: HubRequest) => boolean, n = 1, timeout = 10000): Promise<HubRequest[]> {
    const matching = () => this.requests.filter(pred);
    if (matching().length >= n) return Promise.resolve(matching());
    return new Promise((resolve, reject) => {
      const w: HubWaiter = { pred, n, resolve: () => resolve(matching()) };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`fake hub: waited for ${n} request(s) matching ${pred.toString().slice(0, 80)}; have ${JSON.stringify(this.requests.slice(-5))}`)); } }, timeout).unref();
    });
  }
  record(conn: HubConn, req: HubMsg): void {
    this.requests.push({ conn: this.conns.indexOf(conn), ...req });
    const rest = []; for (const w of this.waiters) { if (this.requests.filter(w.pred).length >= w.n) w.resolve(); else rest.push(w); } this.waiters = rest;
  }
  line(conn: HubConn, msg: HubMsg): void { if (!conn.sock.destroyed) conn.sock.write(JSON.stringify(msg) + '\n'); }
  publish(sess: HubSession): void { sess.summary.updatedAt = Date.now(); for (const c of this.conns) if (c.watching) this.line(c, { t: 'session', session: sess.summary }); }
  toAttached(sid: string, msg: HubMsg): void { for (const c of this.conns) if (c.attached.has(sid)) this.line(c, msg); }
  gone(sid: string, epoch: number): void { for (const c of this.conns) if (c.watching || c.attached.has(sid)) { this.line(c, { t: 'gone', sid, epoch }); c.attached.delete(sid); } }

  /* A PTY session the test seeds (one edwind did not spawn), alive with VIEWERS viewers. */
  addPty(sid: string, { alive = true, viewers = 1, cwd = '/home/test', argv = ['/bin/bash'], leader = true, exit = null, env = {} }: AddPtyOptions = {}): PtySession {
    const pid = ++this.pid;
    const sess: PtySession = { ring: '', out: 0, stream: Date.now(), inputs: [], program: null, inputFn: null, summary: { sid, kind: 'pty', host: this.host, createdAt: Date.now(), updatedAt: Date.now(), alive, viewers, cwd, fault: null, pty: { argv, ...(alive ? { pid, fg: { comm: 'bash', pgid: pid, leader } } : { exit: exit || { code: 0, signal: null, reason: 'exited', at: Date.now() } }) } } };
    this.sessions.set(sid, sess); this.publish(sess);
    return sess;
  }
  addAcp(sid: string, { alive = true, agent = 'agent', title = 'Fix flaky test', cwd = '/home/test', headSeq = 0 }: AddAcpOptions = {}): AcpSession {
    const sess: AcpSession = { summary: { sid, kind: 'acp', host: this.host, createdAt: Date.now(), updatedAt: Date.now(), alive, viewers: 1, cwd, fault: null, acp: { agent, agentSessionId: 'c0ffee', revivable: true, activity: 'none', pending: [], last: null, headSeq, seenSeq: headSeq, title, modeId: 'default' } } };
    this.sessions.set(sid, sess); this.publish(sess);
    return sess;
  }
  /* Output for SID's attached connections, as the real hub emits it. */
  emitOut(sid: string, d: string): void { const s = this.sessions.get(sid) as PtySession | undefined; if (!s) return; s.ring += d; s.out += Buffer.byteLength(d); this.toAttached(sid, { t: 'pty.out', sid, d, out: s.out }); }
  exitSession(sid: string, { code = 0, signal = null, reason = 'exited' }: { code?: number | null; signal?: number | null; reason?: string } = {}): void {
    const s = this.sessions.get(sid) as PtySession | undefined; if (!s || !s.summary.alive) return;
    s.summary.alive = false; s.summary.pty = { argv: s.summary.pty.argv, exit: { code, signal, reason, at: Date.now() } };
    s.program = null; s.inputFn = null;
    this.toAttached(sid, { t: 'pty.exit', sid, code, signal, reason });
    this.publish(s);
  }
  setLeader(sid: string, leader: boolean): void { const s = this.sessions.get(sid) as PtySession | undefined; if (!s || !s.summary.alive) return; s.summary.pty.fg = { comm: leader ? 'bash' : 'make', pgid: leader ? s.summary.pty.pid! : s.summary.pty.pid! + 1, leader }; this.publish(s); }

  /* ---------- programs ---------- */
  /* Run COMMAND for SESS: the scripted program, or the built-in echo/exit/sleep/false/not-found behaviour. */
  async run(sess: PtySession, command: string, { interactive = false }: { interactive?: boolean } = {}): Promise<number> {
    const sid = sess.summary.sid;
    /* A program that reads input gets what arrived before it asked, as a real child reads the PTY's queue. */
    const io: ProgramIO = { write: d => this.emitOut(sid, d), input: fn => { sess.inputFn = fn; for (const d of (sess.pendingInputs || []).splice(0)) fn(d); }, delay: ms => sleep(ms), sess };
    let code: number | void = 0;
    const prog = this.programs.get(command) || this.programs.get(command.replace(/^export TERM=dumb NO_COLOR=1; /, ''));
    try {
      if (prog) code = await (prog as Program)(io, sess, command);
      else {
        const bare = command.replace(/^export TERM=dumb NO_COLOR=1; /, '');
        let m;
        if ((m = /^echo (.*)$/.exec(bare))) { io.write(m[1].replace(/^'|'$/g, '') + '\r\n'); code = 0; }
        else if ((m = /^exit (\d+)$/.exec(bare))) code = Number(m[1]);
        else if ((m = /^sleep (\d+(?:\.\d+)?)$/.exec(bare))) { await sleep(Number(m[1]) * 1000); code = 0; }
        else if (bare === 'cat') { code = await new Promise<number>(resolve => { io.input(d => { if (d === '\x04') resolve(0); else if (d === '\x03') resolve(130); else io.write(d.replace(/\n/g, '\r\n')); }); }); }
        else if (bare === 'true') code = 0;
        else { io.write(`bash: ${bare.split(' ')[0]}: command not found\r\n`); code = 127; }
      }
    } catch (e) { code = 1; }
    if (typeof code !== 'number') code = 0;
    if (!interactive) this.exitSession(sid, { code });
    return code;
  }
  /* The interactive shell: echoes input, runs each line, flips fg.leader around it. */
  startShell(sess: PtySession): void {
    const sid = sess.summary.sid;
    let line = '';
    sess.inputFn = async d => {
      if (d === '\x03') { this.emitOut(sid, '^C\r\n'); line = ''; return; }
      if (d === '\x04') { this.exitSession(sid, { code: 0 }); return; }
      this.emitOut(sid, d.replace(/\n/g, '\r\n'));
      line += d;
      const i = line.indexOf('\n');
      if (i < 0) return;
      const cmd = line.slice(0, i); line = line.slice(i + 1);
      this.setLeader(sid, false);
      sess.inputFn = null;
      const code = await this.run(sess, cmd, { interactive: true });
      if (!this.sessions.has(sid) || !sess.summary.alive) return;
      this.emitOut(sid, `$ `);
      this.setLeader(sid, true);
      sess.lastCode = code;
      this.startShell(sess);
    };
  }

  /* ---------- a connection ---------- */
  serve(sock: net.Socket): void {
    const conn: HubConn = { sock, watching: false, attached: new Set(), hello: false };
    this.conns.push(conn);
    sock.setEncoding('utf8');
    this.line(conn, { t: 'hello', proto: this.proto, server: 'wb-hub', version: '0.1.0', host: this.host, pid: 1, startedAt: 1700000000000, agents: [{ name: 'agent', label: 'Agent' }], shells: this.shells, defaultShell: this.defaultShell });
    let buf = '';
    sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) this.dispatch(conn, JSON.parse(l)); } });
    sock.on('error', () => {});
    sock.on('close', () => { const i = this.conns.indexOf(conn); if (i >= 0) this.conns.splice(i, 1); for (const sid of conn.attached) { const s = this.sessions.get(sid); if (s && s.summary.viewers > 0) { s.summary.viewers--; this.publish(s); } } });
  }
  err(conn: HubConn, rid: unknown, code: string, message: string, sid?: string): void { const m: HubMsg = { t: 'err', code, message }; if (rid !== undefined && rid !== null) m.rid = rid; if (sid) m.sid = sid; this.line(conn, m); }
  dispatch(conn: HubConn, req: HubMsg): void {
    if (!conn.hello) {
      conn.hello = true;
      if (req.t !== 'hello') { this.err(conn, null, 'bad_request', 'expected hello'); conn.sock.destroy(); return; }
      if (req.proto !== this.proto) { this.err(conn, null, 'proto', `this hub speaks proto ${this.proto}, not ${req.proto}`); conn.sock.destroy(); return; }
      conn.client = req.client; this.record(conn, req); return;
    }
    this.record(conn, req);
    const { rid, sid } = req;
    const summaries = () => [...this.sessions.values()].map(s => s.summary);
    const ok = (result: HubMsg) => this.line(conn, { t: 'ok', rid, ...result });
    const sess = sid ? this.sessions.get(sid) : null;
    switch (req.t) {
      case 'list': return ok({ sessions: summaries() });
      case 'watch': conn.watching = true; return ok({ sessions: summaries() });
      case 'pty.open': {
        if (!SID_RE.test(sid)) return this.err(conn, rid, 'bad_request', 'invalid sid');
        if (sess && sess.summary.kind !== 'pty') return this.err(conn, rid, 'kind_mismatch', `${sid} is a acp session`);
        if (req.spawn && (!sess || !sess.summary.alive)) {
          const sp = req.spawn;
          if (!Array.isArray(sp.argv) || !sp.argv.length) return this.err(conn, rid, 'bad_request', 'argv must have 1 to 256 items');
          const shell = sp.shell || this.defaultShell;
          if (!this.shells.includes(shell)) return this.err(conn, rid, 'bad_request', `shell ${shell} not available`);
          if (sp.env && Object.keys(sp.env).length > 32) return this.err(conn, rid, 'bad_request', 'env has more than 32 entries');
          const refuse = this.programs.get('refuse:' + (sp.argv[2] || ''));
          if (refuse) return this.err(conn, rid, (refuse as Refusal).code, (refuse as Refusal).message);
          const pid = ++this.pid, now = Date.now();
          const s: PtySession = (sess as PtySession | null | undefined) || { ring: '', out: 0, stream: now, inputs: [], program: null, inputFn: null, summary: { sid, kind: 'pty', host: this.host, createdAt: now, alive: true, viewers: 0, cwd: sp.cwd || '/home/test', fault: null, pty: {} as PtyInfo } };
          s.summary.alive = true; s.summary.pty = { argv: ['/bin/' + shell, ...sp.argv.slice(1)], pid, fg: { comm: shell, pgid: pid, leader: true } }; s.summary.cwd = sp.cwd || s.summary.cwd; s.spawn = sp; s.shell = shell; s.cols = req.cols; s.rows = req.rows;
          s.summary.viewers++; conn.attached.add(sid);
          this.sessions.set(sid, s);
          ok({ new: true, pid, cwd: s.summary.cwd, epoch: s.summary.createdAt, stream: s.stream, out: s.out, resumed: false });
          this.publish(s);
          this.line(conn, { t: 'pty.fg', sid, comm: shell, cwd: s.summary.cwd });
          if (sp.argv.length === 1) { this.startShell(s); this.emitOut(sid, '$ '); }
          else setTimeout(() => this.run(s, sp.argv[2] || ''), 5);
          return;
        }
        if (!sess) return this.err(conn, rid, 'not_found', `no session ${sid}`);
        const resumed = !!(req.resume && req.resume.stream === (sess as PtySession).stream && req.resume.out <= (sess as PtySession).out);
        const replay = resumed ? (sess as PtySession).ring.slice(Buffer.byteLength((sess as PtySession).ring) - ((sess as PtySession).out - req.resume.out)) : (sess as PtySession).ring;
        conn.attached.add(sid); sess.summary.viewers++;
        ok({ new: false, ...((sess as PtySession).summary.pty.pid ? { pid: (sess as PtySession).summary.pty.pid } : {}), cwd: sess.summary.cwd, ...((sess as PtySession).summary.pty.exit ? { exit: (sess as PtySession).summary.pty.exit } : {}), epoch: sess.summary.createdAt, stream: (sess as PtySession).stream, out: (sess as PtySession).out, resumed, replay });
        this.publish(sess);
        return;
      }
      case 'pty.detach': conn.attached.delete(sid); if (sess && sess.summary.viewers > 0) { sess.summary.viewers--; this.publish(sess); } return ok({});
      case 'pty.input': {
        if (Buffer.byteLength(req.d) > (1 << 20)) return this.err(conn, null, 'bad_request', 'pty.input is limited to 1048576 bytes', sid);
        if (!sess || sess.summary.kind !== 'pty' || !sess.summary.alive) return; // as the hub: input to no pty session goes nowhere
        (sess as PtySession).inputs.push(req.d);
        if ((sess as PtySession).inputFn) (sess as PtySession).inputFn!(req.d); else ((sess as PtySession).pendingInputs || ((sess as PtySession).pendingInputs = [])).push(req.d);
        return;
      }
      case 'pty.resize': return;
      case 'pty.kill': {
        if (!sess) return this.err(conn, rid, 'not_found', `no session ${sid}`);
        if (sess.summary.alive) this.exitSession(sid, { code: null, signal: 1, reason: 'killed' });
        if (req.forget) { const epoch = sess.summary.createdAt; this.sessions.delete(sid); ok({}); this.gone(sid, epoch); return; }
        return ok({});
      }
      case 'pty.capture': {
        if (!sess) return this.err(conn, rid, 'not_found', `no session ${sid}`);
        if (sess.summary.kind !== 'pty') return this.err(conn, rid, 'kind_mismatch', `${sid} is a acp session`);
        const lines = stripAnsi((sess as PtySession).ring).split('\n').map(l => l.trimEnd()); while (lines.length && !lines[lines.length - 1]) lines.pop();
        return ok({ text: lines.slice(-Math.min(req.lines || 200, 1000)).join('\n') });
      }
      case 'acp.open': {
        if (!sess) return this.err(conn, rid, 'not_found', `no session ${sid}`);
        if (sess.summary.kind !== 'acp') return this.err(conn, rid, 'kind_mismatch', `${sid} is a pty session`);
        conn.attached.add(sid);
        const events = this.acpReplays.get(sid) || [];
        const head = sess.summary.acp.headSeq;
        ok({ new: false, summary: sess.summary, session: {}, head, from: (req.since || 0) + 1, reset: false });
        for (const ev of events) if (ev.seq > (req.since || 0)) this.line(conn, { t: 'acp.ev', sid, ev });
        this.line(conn, { t: 'acp.replayed', sid, head, truncated: false });
        return;
      }
      case 'acp.detach': conn.attached.delete(sid); return ok({});
      case 'acp.prompt': {
        if (!sess) return this.err(conn, rid, 'not_found', `no session ${sid}`);
        if (!sess.summary.alive) return this.err(conn, rid, 'not_alive', 'the agent is not running');
        ok({});
        const a = (sess.summary as AcpSummary).acp; const text = (req.prompt || []).map((b: { text?: string }) => b.text || '').join('');
        const reply = (this.acpReplies.get(sid) || (t => `You said: ${t}`))(text);
        const ev = (body: HubMsg) => { a.headSeq++; const e: AcpEvent = { seq: a.headSeq, ts: Date.now(), ...body }; (this.acpReplays.get(sid) || this.acpReplays.set(sid, []).get(sid)!).push(e); this.toAttached(sid, { t: 'acp.ev', sid, ev: e }); };
        a.activity = 'turn'; this.publish(sess);
        ev({ e: 'prompt', prompt: req.prompt });
        setTimeout(() => {
          const half = Math.ceil(reply.length / 2);
          ev({ e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, half) } } });
          ev({ e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(half) } } });
          ev({ e: 'turn_end', stopReason: 'end_turn' });
          a.activity = 'none'; a.last = { seq: a.headSeq, ts: Date.now(), outcome: 'end_turn', error: null }; this.publish(sess);
        }, 20);
        return;
      }
      case 'acp.cancel': return ok({});
      case 'acp.kill': { if (!sess) return this.err(conn, rid, 'not_found', `no session ${sid}`); sess.summary.alive = false; (sess.summary as AcpSummary).acp.activity = 'none'; this.publish(sess); return ok({}); }
      default: return this.err(conn, rid, 'unknown_type', `unknown request ${JSON.stringify(req.t)}`);
    }
  }
}
