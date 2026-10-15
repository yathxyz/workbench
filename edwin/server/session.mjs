// Client sessions (spec §7.2, §7.4, §7.9, R14.13–R14.14): one Client per connection with the hello
// handshake, a send queue that drops a slow client past 4 MiB of edits, sel and msg, bulk frames written
// only as the socket drains, pings, and the dispatch of every message to the buffers, the sequencer and
// the E1 server commands (buffer-list, server-edit, undo) and form evaluation under a deadline.
import { createRequire } from 'node:module';
import { PROTO, MAX_LINE, LineReader, ProtoError, encode, isObj, str, int, rid as ridOf, ops as opsOf, undo as undoOf, CLIENT_QUEUE_CAP, PING_EVERY_MS, HELLO_TIMEOUT_MS, SEL_PER_SECOND, CHUNK } from './proto.mjs';
import { randomId } from './journal.mjs';

const require = createRequire(import.meta.url);

/* Deadlines in ms of runnable time (R14.13). */
export const DEADLINE_FRAME_MS = 2000;
export const DEADLINE_CLI_MS = 30000;

/* R4.14 definitional heads, for the image log (image.mjs extends the set). */
export const DEFINITIONAL = new Set(['define', 'define-command', 'define-record-type', 'define-syntax', 'define-macro', 'define-minor-mode', 'define-derived-mode', 'defvar', 'defvar-local', 'defcustom', 'defface', 'set!', 'setq', 'setq-default', 'add-hook!', 'remove-hook!', 'advice-add', 'advice-remove', 'define-key', 'keymap-set', 'global-set-key', 'evil-define-key', 'evil-ex-define-cmd', 'define-snippet', 'put', 'provide', 'require']);

export class Client {
  constructor(server, socket) {
    this.server = server; this.socket = socket; this.log = server.log;
    this.cid = null; this.kind = null; this.device = null; this.session = null; this.caps = {};
    this.buffers = new Set(); this.closed = false; this.hello = false;
    this.queue = []; this.queued = 0; this.writing = false; this.bulk = [];
    this.selTimes = [];
    this.calls = new Set();
    this.reader = new LineReader(line => this.onLine(line), () => this.send({ t: 'error', code: 'too_large', msg: `line longer than ${MAX_LINE} bytes` }));
    socket.on('data', chunk => { try { this.reader.push(chunk); } catch (e) { this.fail(e); } });
    socket.on('error', e => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') this.log.warn('client', { cid: this.cid, error: e.code || e.message }); });
    socket.on('close', () => this.onClose());
    socket.on('drain', () => { this.writing = false; this.pump(); });
    this.helloTimer = setTimeout(() => { if (!this.hello) { this.log.info('client', { event: 'no hello', cid: null }); this.destroy(); } }, HELLO_TIMEOUT_MS);
    this.pinger = setInterval(() => { if (this.hello) this.send({ t: 'ping', rid: 'p' + Date.now() }); }, PING_EVERY_MS);
    this.pinger.unref();
  }
  /* Attribution (§7.9, R13.2). */
  by() {
    if (this.kind === 'frame') return { kind: 'frame', cid: this.cid, device: this.device };
    if (this.kind === 'cli') return this.session ? { kind: 'cli', device: this.device, session: this.session } : { kind: 'cli', device: this.device };
    return { kind: 'web', cid: this.cid, device: this.device };
  }
  deadlineMs() { return this.kind === 'cli' ? DEADLINE_CLI_MS : DEADLINE_FRAME_MS; }

  /* ---------- sending ---------- */
  /* Small frames: queued and written as the socket allows. */
  send(obj) { if (this.closed) return; this.queue.push(encode(obj)); this.pump(); }
  /* edits, sel and msg count toward the slow-client cap (R14.14). */
  sendBulkish(obj) {
    if (this.closed) return;
    const line = encode(obj);
    this.queued += line.length;
    /* Everything not yet on the wire counts: our queue and what Node holds for a socket that stopped draining. */
    const held = this.queued + this.socket.writableLength;
    if (held > CLIENT_QUEUE_CAP) {
      this.log.warn('client', { cid: this.cid, event: 'slow_client', queued: held });
      this.queue = []; this.queued = 0;
      try { this.socket.write(encode({ t: 'error', code: 'slow_client', msg: 'the client is not reading fast enough' })); } catch (e) { /* closing */ }
      this.destroy(); return;
    }
    this.queue.push(line); this.pump();
  }
  /* Bulk frames (snap, chunk, image): written one at a time, each after the previous one drained. */
  sendBulk(obj) { if (this.closed) return; this.queue.push(encode(obj)); this.pump(); }
  pump() {
    if (this.closed || this.writing) return;
    while (this.queue.length && !this.closed) {
      const line = this.queue.shift();
      if (this.queued) this.queued = Math.max(0, this.queued - line.length);
      if (!this.socket.write(line)) { this.writing = true; return; } // the drain event resumes
    }
  }
  destroy() { if (this.closed) return; this.closed = true; try { this.socket.end(); } catch (e) { /* closing */ } setTimeout(() => this.socket.destroy(), 100).unref(); }
  onClose() {
    this.closed = true; clearTimeout(this.helloTimer); clearInterval(this.pinger);
    this.server.buffers.detachAll(this);
    this.server.clients.delete(this);
    this.log.info('client', { event: 'disconnect', cid: this.cid, kind: this.kind });
  }
  fail(e) { this.log.error('client', { cid: this.cid, error: e.stack || String(e) }); this.destroy(); }

  /* ---------- receiving ---------- */
  onLine(line) {
    if (!line.trim()) return;
    if (this.server.onInput) this.server.onInput(this);
    let msg;
    try { msg = JSON.parse(line); } catch (e) { this.send({ t: 'error', code: 'bad_request', msg: 'not JSON' }); return; }
    if (!isObj(msg) || typeof msg.t !== 'string') { this.send({ t: 'error', code: 'bad_request', msg: 'a message is an object with t' }); return; }
    const rid = (() => { try { return ridOf(msg); } catch (e) { return undefined; } })();
    const p = this.dispatch(msg);
    if (p && typeof p.then === 'function') p.catch(e => this.reportError(e, rid, msg));
  }
  reportError(e, rid, msg) {
    if (e instanceof ProtoError) { const out = { t: 'error', code: e.code, msg: e.message, ...e.extra }; if (rid !== undefined) out.rid = rid; if (msg && typeof msg.buf === 'string' && out.buf === undefined) out.buf = msg.buf; if (msg && msg.t === 'edit' && Number.isInteger(msg.seq) && out.seq === undefined) out.seq = msg.seq; this.send(out); return; }
    this.log.error('dispatch', { cid: this.cid, t: msg && msg.t, error: e.stack || String(e) });
    const out = { t: 'error', code: 'bad_request', msg: 'internal error: ' + (e.message || String(e)) };
    if (rid !== undefined) out.rid = rid;
    this.send(out);
  }
  dispatch(msg) {
    try {
      if (!this.hello) { if (msg.t !== 'hello') throw new ProtoError('bad_request', 'hello comes first'); return this.onHello(msg); }
      switch (msg.t) {
        case 'hello': throw new ProtoError('bad_request', 'already said hello');
        case 'ping': this.send({ t: 'pong', rid: msg.rid }); return;
        case 'pong': return;
        case 'open': return this.onOpen(msg);
        case 'close': { const sb = this.server.buffers.live(str(msg, 'buf')); if (sb) this.server.buffers.close(this, sb); return; }
        case 'edit': return this.onEdit(msg);
        case 'sel': return this.onSel(msg);
        case 'save': case 'revert': return this.onSaveRevert(msg);
        case 'call': return this.onCall(msg);
        case 'image?': return this.onImageQuery(msg);
        default: {
          /* The E2 modules' message types (sample, tool_result, answer, interrupt, …); an unknown t is
             ignored (R7.4). */
          const h = this.server.handlers.get(msg.t);
          return h ? h(this, msg) : undefined;
        }
      }
    } catch (e) { this.reportError(e, (() => { try { return ridOf(msg); } catch (x) { return undefined; } })(), msg); }
  }
  onHello(msg) {
    const proto = msg.proto;
    if (!Number.isInteger(proto)) throw new ProtoError('bad_request', 'hello.proto must be an integer');
    if (proto !== PROTO && proto !== PROTO - 1) { this.send({ t: 'error', code: 'proto', msg: `protocol ${proto} is not supported; this edwind speaks ${PROTO}` }); this.destroy(); return; }
    const cid = str(msg, 'cid');
    if (!/^[0-9a-fA-F]{8,64}$/.test(cid)) throw new ProtoError('bad_request', 'cid must be 8 to 64 hex digits');
    const kind = str(msg, 'kind');
    if (!['frame', 'cli', 'web'].includes(kind)) throw new ProtoError('bad_request', 'kind must be frame, cli or web');
    this.cid = cid; this.kind = kind; this.device = str(msg, 'device', true) || kind + ':' + cid.slice(0, 8);
    this.session = str(msg, 'session', true) || null; this.caps = isObj(msg.caps) ? msg.caps : {};
    this.hello = true; clearTimeout(this.helloTimer);
    this.send({ t: 'welcome', proto: PROTO, build: this.server.build, boot: this.server.boot, imageEpoch: this.server.image.epoch, gen: this.server.image.gen, caps: {} });
    this.log.info('client', { event: 'connect', cid, kind, device: this.device });
    if (this.server.stopping) { this.send({ t: 'error', code: 'shutting_down', msg: 'edwind is stopping' }); this.destroy(); }
  }
  onOpen(msg) {
    const rid = ridOf(msg), buf = str(msg, 'buf'), since = int(msg, 'since', true);
    const create = msg.create === true;
    this.server.buffers.open(this, msg, { rid, since, create });
  }
  onEdit(msg) {
    const buf = str(msg, 'buf'), base = int(msg, 'base'), seq = int(msg, 'seq');
    const ops = opsOf(msg), undo = undoOf(msg);
    const sb = this.server.buffers.get(buf);
    return this.server.buffers.seq.edit(this, sb, { base, seq, ops, undo }).catch(e => { if (e instanceof ProtoError) { e.extra = { buf: sb.id, seq, ...e.extra }; } throw e; });
  }
  onSel(msg) {
    const buf = str(msg, 'buf');
    const now = Date.now();
    this.selTimes = this.selTimes.filter(t => now - t < 1000);
    if (this.selTimes.length >= SEL_PER_SECOND) return; // throttled: presence is best effort
    this.selTimes.push(now);
    const sb = this.server.buffers.live(buf);
    if (!sb || !Array.isArray(msg.ranges)) return;
    const out = { t: 'sel', buf: sb.id, by: this.by(), ranges: msg.ranges };
    for (const c of sb.clients) if (c !== this) c.sendBulkish(out);
  }
  async onSaveRevert(msg) {
    const rid = ridOf(msg), buf = str(msg, 'buf');
    const sb = this.server.buffers.get(buf);
    const value = msg.t === 'save' ? await this.server.buffers.save(sb) : await this.server.buffers.revert(sb);
    if (msg.t === 'save' && sb.serverEdit) sb.serverEdit.saved = true;
    this.send({ t: 'result', rid, value });
  }
  onImageQuery(msg) {
    const rid = ridOf(msg), from = int(msg, 'from');
    const value = this.server.image.sendAfter(this, from);
    this.send({ t: 'result', rid, value });
  }

  /* ---------- call (§7.4) ---------- */
  async onCall(msg) {
    const rid = ridOf(msg);
    if (rid === undefined) throw new ProtoError('bad_request', 'call needs a rid');
    const ctx = isObj(msg.ctx) ? { ...msg.ctx, rid } : { rid };
    const args = Array.isArray(msg.args) ? msg.args : [];
    let out;
    if (typeof msg.form === 'string') out = await this.server.evalForm(this, msg.form, ctx, msg.buf);
    else if (typeof msg.cmd === 'string') out = await this.server.command(this, msg.cmd, args, ctx, msg.buf);
    else throw new ProtoError('bad_request', 'call needs cmd or form');
    if (out === undefined) return; // a delayed result (server-edit --wait, D20)
    this.send({ t: 'result', rid, ...out });
  }
}
