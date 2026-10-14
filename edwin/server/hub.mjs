// The hub client (spec §5.1, R5.7, R4.43–R4.45, R3.2): edwind as one client of hub.sock, the way wb-web's
// control connection is (crates/wb-web/src/hub.rs). It speaks wb_proto::hub unchanged: NDJSON lines, the
// hub's hello first, our hello within HELLO_TIMEOUT, one `watch` for Summary changes, and requests with a
// nonzero u64 `rid` that get exactly one `ok` or `err` reply (DESIGN §3.2). Other modules reach it as
// server.hub: request(), send(), ptyInput(), the `sessions` map and events named after the hub's message
// types (`session`, `gone`, `pty.out`, `pty.exit`, `pty.fg`, `acp.ev`, `acp.replayed`, `acp.info`, `err`),
// plus `up` and `down` for the connection itself. edwind never starts a process itself (R4.45): everything a
// process needs goes through this connection.
//
// Logging (R15.10): sids, event names and error codes only; never a command, input or output.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export const name = 'hub';
/* Constants of the hub protocol, reproduced from the Rust crates. */
export const PROTO = 1;                                   // wb_proto::hub::PROTO
export const MAX_LINE = 16 << 20;                          // wb_proto::limits::MAX_LINE (a longer line closes the connection)
export const PTY_INPUT_FRAME = 1 << 20;                    // wb_proto::limits::PTY_INPUT_FRAME (largest `d` of one pty.input, in bytes)
export const CAPTURE_MAX = 1000;                           // wb_proto::limits::CAPTURE_MAX
export const FG_POLL_MS = 2000;                            // wb_proto::limits::FG_POLL
export const HELLO_TIMEOUT_MS = 5000;                      // wb_proto::limits::HELLO_TIMEOUT
export const CMD_TIMEOUT_DEFAULT_MS = 60000;               // wb_proto::limits::CMD_TIMEOUT_DEFAULT (R5.6)
/* The control connection's policy, as crates/wb-web/src/hub.rs has it (DESIGN §3.2.10). */
export const CONNECT_TIMEOUT_MS = 2000;                    // CONNECT_TIMEOUT
export const BACKOFF_MIN_MS = 250;                         // BACKOFF_MIN
export const BACKOFF_MAX_MS = 5000;                        // BACKOFF_MAX
export const STABLE_MS = 5000;                             // STABLE: a connection up this long resets the backoff
export const REPLY_TIMEOUT_MS = 10000;                     // REPLY_TIMEOUT
/* A pty.kill or acp.kill with forget waits for the exit (about 3 s for a PTY, 8 s for an agent, conn.rs LINGER). */
export const KILL_TIMEOUT_MS = 30000;
export const DEFAULT_SOCKET = '/run/workbench-hub/hub.sock'; // DESIGN §3.2.1
const CLIENT = 'edwind';

/* A failed hub request: `code` is the hub's error code (wb_proto::hub::ErrorCode), or `unavailable` when
   the hub cannot be reached, or `timeout` when it did not answer in time. */
export class HubError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* Split TEXT into pieces of at most PTY_INPUT_FRAME UTF-8 bytes without cutting a surrogate pair: 256 Ki
   UTF-16 code units encode to at most 768 KiB (3 bytes each) or, in pairs, 4 bytes per two units. */
export function inputFrames(text) {
  const UNITS = 1 << 18, out = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + UNITS);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(i, end)); i = end;
  }
  return out;
}

export class Hub extends EventEmitter {
  constructor(server, socketPath) {
    super();
    this.server = server; this.log = server.log; this.path = socketPath;
    this.status = 'down';                               // down | up | incompatible
    this.info = null;                                    // the hub's hello: version, build, host, shells, defaultShell, agents
    this.sessions = new Map();                           // sid -> Summary, from watch (R5.7); empty while down
    this.sock = null; this.pending = new Map(); this.nextRid = 1;
    this.backoff = BACKOFF_MIN_MS; this.timer = null; this.stopped = false; this.upSince = 0;
    this.upWaiters = [];
    this.setMaxListeners(0);
  }

  /* ---------- connection ---------- */
  start() { this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sock) this.sock.destroy();
    this.failPending(new HubError('unavailable', 'edwind is stopping'));
  }
  get up() { return this.status === 'up'; }
  /* Resolves once the hub is up, or rejects with hub unreachable after MS. */
  whenUp(ms = 0) {
    if (this.up) return Promise.resolve();
    if (!ms) return Promise.reject(new HubError('unavailable', 'hub unreachable'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: setTimeout(() => { const i = this.upWaiters.indexOf(w); if (i >= 0) this.upWaiters.splice(i, 1); reject(new HubError('unavailable', 'hub unreachable')); }, ms) };
      w.timer.unref(); this.upWaiters.push(w);
    });
  }
  connect() {
    if (this.stopped) return;
    const sock = net.connect(this.path);
    this.sock = sock;
    let buf = '', hello = false, connected = false, closed = false;
    const connectTimer = setTimeout(() => { if (!connected) { this.log.debug('hub', { event: 'connect timeout' }); sock.destroy(); } }, CONNECT_TIMEOUT_MS); connectTimer.unref();
    const helloTimer = setTimeout(() => { if (!hello) { this.log.debug('hub', { event: 'no hello' }); sock.destroy(); } }, HELLO_TIMEOUT_MS + CONNECT_TIMEOUT_MS); helloTimer.unref();
    sock.setEncoding('utf8');
    sock.on('connect', () => { connected = true; clearTimeout(connectTimer); });
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (e) { this.log.warn('hub', { event: 'undecodable line skipped' }); continue; }
        if (!hello) { hello = true; clearTimeout(helloTimer); this.onHello(msg); }
        else this.onMessage(msg);
      }
      if (buf.length > MAX_LINE) { this.log.warn('hub', { event: 'line too long' }); sock.destroy(); }
    });
    sock.on('error', e => { if (this.status !== 'up') this.log.debug('hub', { event: 'not reachable', error: e.code || e.message }); else this.log.warn('hub', { event: 'connection failed', error: e.code || e.message }); });
    sock.on('close', () => {
      if (closed) return; closed = true;
      clearTimeout(connectTimer); clearTimeout(helloTimer);
      if (this.sock === sock) this.sock = null;
      this.onClose();
    });
  }
  onHello(msg) {
    if (!msg || msg.t !== 'hello') { this.log.warn('hub', { event: 'first line was not a hello' }); this.sock.destroy(); return; }
    if (msg.proto !== PROTO) {
      /* DESIGN §3.2.3: a proto mismatch; the hub would answer our hello with err{proto} and close. */
      this.status = 'incompatible'; this.log.warn('hub', { event: 'incompatible', proto: msg.proto });
      this.sock.destroy(); return;
    }
    this.info = { version: msg.version, build: msg.build || null, host: msg.host, pid: msg.pid, startedAt: msg.startedAt, agents: Array.isArray(msg.agents) ? msg.agents : [], shells: Array.isArray(msg.shells) ? msg.shells : [], defaultShell: typeof msg.defaultShell === 'string' ? msg.defaultShell : '' };
    this.write({ t: 'hello', proto: PROTO, client: `${CLIENT}/${this.server.build || 'dev'}` });
    /* One watch per connection (R5.7): its reply is the session list, then `session` and `gone` events. */
    const rid = this.rid();
    this.expect(rid, REPLY_TIMEOUT_MS).then(r => {
      this.sessions.clear();
      for (const s of Array.isArray(r.sessions) ? r.sessions : []) if (s && typeof s.sid === 'string') this.sessions.set(s.sid, s);
      this.status = 'up'; this.upSince = Date.now();
      this.log.info('hub', { event: 'up', version: this.info.version, host: this.info.host, shells: this.info.shells, sessions: this.sessions.size });
      for (const w of this.upWaiters.splice(0)) { clearTimeout(w.timer); w.resolve(); }
      this.emit('up');
    }, e => { this.log.warn('hub', { event: 'watch failed', code: e.code }); if (this.sock) this.sock.destroy(); });
    this.write({ t: 'watch', rid });
  }
  onMessage(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'ok': { const p = this.pending.get(msg.rid); if (p) { this.pending.delete(msg.rid); clearTimeout(p.timer); const { t, rid, ...result } = msg; p.resolve(result); } return; }
      case 'err': {
        if (msg.rid !== undefined && msg.rid !== null) { const p = this.pending.get(msg.rid); if (p) { this.pending.delete(msg.rid); clearTimeout(p.timer); p.reject(new HubError(msg.code || 'internal', msg.message || '')); } return; }
        this.log.warn('hub', { event: 'err', sid: msg.sid || null, code: msg.code });
        this.emit('err', msg); return;
      }
      case 'session': {
        const s = msg.session; if (!s || typeof s.sid !== 'string') return;
        const prev = this.sessions.get(s.sid) || null;
        this.sessions.set(s.sid, s); this.emit('session', s, prev); return;
      }
      case 'gone': {
        const cur = this.sessions.get(msg.sid);
        if (cur && cur.createdAt === msg.epoch) this.sessions.delete(msg.sid);
        this.emit('gone', msg); return;
      }
      case 'hello': return;                                 // never twice
      default: this.emit(msg.t, msg);                        // pty.out, pty.exit, pty.fg, acp.ev, acp.replayed, acp.info, or something newer
    }
  }
  onClose() {
    const wasUp = this.status === 'up';
    if (this.status !== 'incompatible') this.status = 'down';
    this.sessions.clear();
    this.failPending(new HubError('unavailable', 'the hub connection closed'));
    if (wasUp) { this.log.info('hub', { event: 'down' }); this.emit('down'); }
    if (this.stopped) return;
    /* Backoff 250 ms doubling to 5 s with ±25 % jitter; a connection that stayed up STABLE_MS starts over. */
    if (wasUp && Date.now() - this.upSince >= STABLE_MS) this.backoff = BACKOFF_MIN_MS;
    let wait = this.status === 'incompatible' ? BACKOFF_MAX_MS : this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    wait = Math.round(wait * (0.75 + Math.random() / 2));
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, wait); this.timer.unref();
  }
  failPending(err) { for (const [rid, p] of this.pending) { clearTimeout(p.timer); p.reject(err); } this.pending.clear(); }

  /* ---------- requests ---------- */
  rid() { const r = this.nextRid++; if (this.nextRid > Number.MAX_SAFE_INTEGER) this.nextRid = 1; return r; }
  write(obj) {
    if (!this.sock || this.sock.destroyed) throw new HubError('unavailable', 'hub unreachable');
    this.sock.write(JSON.stringify(obj) + '\n');
  }
  expect(rid, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(rid)) reject(new HubError('timeout', 'the hub did not answer in time')); }, timeoutMs); timer.unref();
      this.pending.set(rid, { resolve, reject, timer });
    });
  }
  /* Send MSG with a fresh rid; resolves with the `ok` reply's fields, rejects with a HubError. */
  request(msg, timeoutMs = REPLY_TIMEOUT_MS) {
    if (!this.up) return Promise.reject(new HubError('unavailable', 'hub unreachable'));
    const rid = this.rid();
    const p = this.expect(rid, timeoutMs);
    try { this.write({ ...msg, rid }); } catch (e) { this.pending.delete(rid); return Promise.reject(e); }
    return p;
  }
  /* A message without a reply (pty.input, pty.resize). Throws HubError when down. */
  send(msg) { if (!this.up) throw new HubError('unavailable', 'hub unreachable'); this.write(msg); }
  /* pty.input for SID, split at PTY_INPUT_FRAME (R4.43). */
  ptyInput(sid, text) { for (const d of inputFrames(String(text))) this.send({ t: 'pty.input', sid, d }); }
  /* The shell a spawn without an explicit one uses: bash when the hub offers it, else the hub's default (R4.43). */
  defaultShell() { if (!this.info) return 'bash'; return this.info.shells.includes('bash') ? 'bash' : (this.info.defaultShell || this.info.shells[0] || 'bash'); }
  statusFields() { return { hub: this.status, hubVersion: this.info ? this.info.version : null, hubSessions: this.sessions.size }; }
}

/* ---------- the module ---------- */
export async function install(server) {
  const { L } = server, S = L.S;
  /* Conditions other modules signal for hub trouble (R4.43, R4.44): hub-error when the hub cannot be
     reached or refuses a request; process-error for a refused spawn or a dead process. */
  for (const k of ['hub-error', 'process-error', 'stale-object', 'no-leader']) S.defineConditionType(k, 'error');
  const hub = new Hub(server, server.cfg.hubSocket || DEFAULT_SOCKET);
  server.hub = hub;
  /* A HubError as the Scheme condition it stands for. */
  hub.toCondition = (e, who) => {
    if (e instanceof S.SchemeError) return e;
    if (e instanceof HubError) {
      if (e.code === 'unavailable' || e.code === 'timeout' || e.code === 'proto') return new S.SchemeError('hub-error', `${who}: ${e.message}`, [e.code]);
      return new S.SchemeError('hub-error', `${who}: ${e.message}`, [e.code]);
    }
    return new S.SchemeError('error', `${who}: ${e && e.message ? e.message : String(e)}`, []);
  };
  server.statusProviders.push(() => hub.statusFields());
  const D = (nm, args, doc, fn) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; return f; };
  D('hub-status', '', 'The hub connection: up, down or incompatible.', () => S.intern(hub.status));
  D('hub-shells', '', 'The shells the hub offers, and its default, as (shells . default); #f while down.', () => (hub.up ? S.cons(S.listOf(hub.info.shells), hub.defaultShell()) : false));
  hub.start();
}

export async function shutdown(server) { if (server.hub) server.hub.stop(); }
