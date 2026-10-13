// A test client for the edit protocol and a launcher for edwind in a temp directory, shared by the
// conformance, crash and disk suites.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const EDWIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAIN = path.join(EDWIN, 'server/main.mjs');

/* A temp directory with a 0700 socket dir, notes, state, config, and an edit.json. */
export function makeDir(extra = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'edwind-'));
  fs.chmodSync(root, 0o700);
  const dirs = { sock: path.join(root, 'run'), notes: path.join(root, 'notes'), state: path.join(root, 'state'), config: path.join(root, 'config'), home: path.join(root, 'home') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const cfg = { socket: path.join(dirs.sock, 'edit.sock'), stateDir: dirs.state, notesDir: dirs.notes, configDir: dirs.config, writablePaths: [root], refusePaths: [path.join(dirs.home, '.ssh'), path.join(dirs.home, '.config/systemd'), path.join(dirs.home, '.local/share/systemd')], host: 'test', logLevel: 'info', ...extra };
  const file = path.join(root, 'edit.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { root, dirs, cfg, file };
}

/* Start edwind on DIR; resolves to the child once the socket accepts. */
/* The Node flags bin/edwind runs with (R14.11, R16.16): the same list nix/package.nix composes in the wrapper,
   so the gate suites test edwind as the unit runs it. Node's permission model (`--permission`, R14.12) is not
   among them: Node 22 and 24 disable fsync and fdatasync under it, which R8.3 and R8.7 need; edwind guards
   child_process in-process instead (main.mjs guardProcesses). The stack is sized to the soft limit
   (`ulimit -s`) minus headroom, at most 32000 KiB; the Scheme cap of 10,000 frames needs about 7 MiB. */
export function nodeFlags({ stackKiB } = {}) {
  if (stackKiB === undefined) {
    const lim = spawnSync('sh', ['-c', 'ulimit -s'], { encoding: 'utf8' }).stdout.trim();
    stackKiB = lim === 'unlimited' ? 32000 : Math.min(32000, Math.max(984, Number(lim) - 1200));
  }
  return ['--disallow-code-generation-from-strings', '--frozen-intrinsics', '--no-warnings=ExperimentalWarning', `--stack-size=${stackKiB}`];
}

/* Every edwind this process started dies with it, whatever the test did. */
const children = new Set();
process.once('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } } });

export function startEdwind(dir, { nodeArgs, env = {} } = {}) {
  if (!nodeArgs) nodeArgs = nodeFlags();
  const child = spawn(process.execPath, [...nodeArgs, MAIN, '--config', dir.file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: dir.dirs.home, ...env } });
  child.logs = '';
  children.add(child); child.once('exit', () => children.delete(child));
  child.stderr.on('data', d => { child.logs += d; if (process.env.EDWIND_LOG) process.stderr.write(d); });
  child.stdout.on('data', d => { child.logs += d; });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    child.once('exit', code => { if (!child.ready) reject(new Error(`edwind exited with ${code}: ${child.logs}`)); });
    const poll = () => {
      if (child.ready) return;
      const s = net.connect(dir.cfg.socket);
      s.once('connect', () => { s.destroy(); child.ready = true; resolve(child); });
      s.once('error', () => { if (Date.now() > deadline) reject(new Error(`edwind did not listen: ${child.logs}`)); else setTimeout(poll, 50); });
    };
    setTimeout(poll, 50);
  });
}
export function stopEdwind(child, sig = 'SIGTERM') {
  return new Promise(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('exit', () => resolve()); child.kill(sig); });
}

/* A protocol client: NDJSON over the socket, with awaitable requests and a message queue. */
export class EditClient {
  constructor(sockPath, { kind = 'cli', cid = randomBytes(16).toString('hex'), device } = {}) {
    this.path = sockPath; this.kind = kind; this.cid = cid; this.device = device || `${kind}:${cid.slice(0, 6)}`;
    this.queue = []; this.waiters = []; this.buf = ''; this.closed = false; this.rid = 0;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.path);
      this.sock.setEncoding('utf8');
      this.sock.once('connect', resolve); this.sock.once('error', reject);
      this.sock.on('data', d => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (line) this.push(JSON.parse(line)); } });
      this.sock.on('close', () => { this.closed = true; for (const w of this.waiters.splice(0)) w.reject(new Error('closed')); });
    });
  }
  push(msg) {
    if (msg.t === 'ping') { this.sendRaw({ t: 'pong', rid: msg.rid }); return; }
    const i = this.waiters.findIndex(w => w.pred(msg));
    if (i >= 0) { const [w] = this.waiters.splice(i, 1); w.resolve(msg); } else this.queue.push(msg);
  }
  sendRaw(obj) { this.sock.write(JSON.stringify(obj) + '\n'); }
  send(obj) { this.sendRaw(obj); }
  /* The next message matching PRED (queued or future). */
  next(pred = () => true, timeout = 10000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      this.waiters.push(w);
      const t = setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) { this.waiters.splice(k, 1); reject(new Error(`timeout waiting for ${pred.toString().slice(0, 80)}; queue: ${JSON.stringify(this.queue).slice(0, 400)}`)); } }, timeout).unref();
      w.resolve = m => { clearTimeout(t); resolve(m); };
    });
  }
  async hello(extra = {}) { this.send({ t: 'hello', proto: 1, cid: this.cid, kind: this.kind, device: this.device, caps: {}, ...extra }); return this.next(m => m.t === 'welcome' || m.t === 'error'); }
  newRid() { return 'r' + (++this.rid); }
  /* A request with a rid; resolves with the matching result or error. */
  async request(msg) { const rid = this.newRid(); this.send({ ...msg, rid }); return this.next(m => m.rid === rid && (m.t === 'result' || m.t === 'error')); }
  /* open: collects snap/chunk/edits/acks until opened; returns {text, ver, meta, edits, acks, error}. */
  async open(buf, { since, create } = {}) {
    const rid = this.newRid();
    const msg = { t: 'open', rid, buf }; if (since !== undefined) msg.since = since; if (create) msg.create = true;
    this.send(msg);
    const out = { text: null, ver: null, meta: null, edits: [], acks: [], error: null, moved: null };
    for (;;) {
      const m = await this.next(x => (x.rid === rid) || (x.buf === buf && ['edits', 'ack', 'moved', 'meta'].includes(x.t)));
      if (m.t === 'error') { out.error = m; return out; }
      if (m.t === 'snap') { out.text = m.text; out.ver = m.ver; out.meta = m.meta; if (m.more) { let more = true; while (more) { const c = await this.next(x => x.t === 'chunk' && x.rid === rid); out.text += c.text; more = c.more; } } }
      else if (m.t === 'edits') out.edits.push(m);
      else if (m.t === 'ack') out.acks.push(m);
      else if (m.t === 'moved') { out.moved = m.to; return out; }
      else if (m.t === 'meta') out.meta = m;
      else if (m.t === 'opened') { out.ver = m.ver; return out; }
    }
  }
  seqs = new Map();
  /* One edit; resolves with the ack or error for it. */
  async edit(buf, base, ops, undo) {
    const seq = (this.seqs.get(buf) || 0) + 1; this.seqs.set(buf, seq);
    const msg = { t: 'edit', buf, base, seq, ops }; if (undo) msg.undo = undo;
    this.send(msg);
    return this.next(m => (m.t === 'ack' || m.t === 'error') && m.seq === seq); // the ack carries the canonical id
  }
  call(cmd, args = [], ctx = {}, buf) { const m = { t: 'call', cmd, args, ctx }; if (buf) m.buf = buf; return this.request(m); }
  form(form) { return this.request({ t: 'call', form, ctx: {} }); }
  close() { this.closed = true; this.sock.end(); this.sock.destroy(); for (const w of this.waiters.splice(0)) w.reject(new Error('client closed')); }
}
