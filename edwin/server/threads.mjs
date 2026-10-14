// The scheduler of the server image (spec §4.8: R4.38–R4.42, R4.46; §4.6: R4.27–R4.29; R14.13).
//
// Every evaluation in edwind runs as a thread: a generator (scheme.js in generator mode) driven here.
// Command threads (call{form}, call{cmd}, agent tools) run until they finish, block or pass their
// deadline; every COMMAND_BREAK_MS they let the event loop run (I/O, interrupt and answer messages,
// edits to buffers they do not hold) and continue before any other thread. Background threads
// (make-thread, timers, process filters, model streams) run in SLICE_MS slices, round robin. A thread
// yields Block (a promise: sleep, ask, join, I/O), PREEMPT (its slice is over) or Suspend (the debugger
// holds it); the thread's state (shadow stack, handlers, restarts, parameter bindings, current buffer,
// echo area) is swapped by Scheme.switchTo and hooks.threadSwitch.
//
// Held buffers (R4.41): a thread holds every shared buffer it edits or makes current, from then until
// its next blocking point or its end. Client edits to a held buffer wait in the sequencer; the thread's
// own edits (Edwin's edit log, origin local) are sequenced as one batch at release, attributed to the
// thread's by (the frame's cid for a command run for a frame, R4.28). A thread that holds a buffer for
// more than HOLD_MS of runnable time gets the timeout condition. A server-made batch (applyBatch) or a
// second thread editing a held buffer first flushes the holder's pending edits as a batch, so the
// history stays in rope order; such a holder may then see its positions move (recorded choice).
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtoError } from './proto.mjs';
import { DEADLINE_FRAME_MS, DEADLINE_CLI_MS } from './session.mjs';

export const name = 'threads';
export const SLICE_MS = 5;
export const COMMAND_BREAK_MS = 20;
export const HOLD_MS = 250;
export const CMD_TIMEOUT_DEFAULT_MS = 60000;
export const ASK_KINDS = ['string', 'completing', 'y-or-n', 'yes-or-no', 'number', 'char'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCM_FILE = path.join(HERE, '..', 'scm', 'threads.scm');
const ABORTED = { toString() { return '#<aborted>'; } };
/* The end of a thread whose abort restart was invoked (R4.37): the call's result is the aborted condition. */
export class Aborted extends Error { constructor() { super('Aborted'); } }

let nextId = 1;

export class Thread {
  constructor(sched, opts) {
    this.sched = sched;
    this.id = nextId++;
    this.name = opts.name || ('thread-' + this.id);
    this.kind = opts.kind || 'background';           // command | background
    this.client = opts.client || null;                 // the client the command runs for, if any
    this.rid = opts.rid === undefined ? null : opts.rid;
    this.by = opts.by || { kind: 'server', thread: this.name };
    this.ts = new sched.S.ThreadState(this.name);
    this.ts.data = { current: opts.buffer || null, echo: '', inhibitRO: false };
    this.state = 'new';                                 // new | runnable | running | blocked | suspended | done
    this.waiting = null;                                // what a blocked thread waits for (a string)
    this.gen = null; this.resume = null; this.waitToken = 0;
    this.remainingMs = opts.deadlineMs === undefined || opts.deadlineMs === null ? Infinity : opts.deadlineMs;
    this.runnableMs = 0; this.startedAt = Date.now();
    this.held = new Set(); this.holdSince = 0; this.owned = new Set();     // mutexes held, released at the end
    this.suspend = null;                                // the Suspend yielded, while suspended
    /* debug-on-error (R4.35, R13.10): commands run for a frame may suspend in the debugger; cli calls and background threads report. */
    this.result = undefined; this.error = null; this.debugOnError = opts.debugOnError !== undefined ? opts.debugOnError : this.kind === 'command' && !!this.client && this.client.kind === 'frame';
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    this.done.catch(() => {});                          // joiners see the error through thread-join
    this.ask = null;                                    // the pending ask {resolve, reject}, if any
  }
  toString() { return `#<thread ${this.id} ${this.name}>`; }
  __print() { return this.toString(); }
  get alive() { return this.state !== 'done'; }
  /* Deliver condition C to the thread at its next step (quit, timeout, thread-cancelled). */
  interrupt(c) {
    if (!this.alive) return false;
    if (this.state === 'blocked' || this.state === 'suspended') {
      if (this.state === 'suspended' && this.sched.onUnsuspend) this.sched.onUnsuspend(this);
      this.waitToken++; this.resume = { throw: c }; this.ask = null; this.suspend = null; this.sched.ready(this);
    } else this.pendingThrow = c;
    return true;
  }
  /* Kill: invoke the thread's abort restart (R4.37). */
  kill() {
    if (!this.alive) return false;
    const S = this.sched.S;
    return this.interrupt(new S.Unwind(this.abortTag, this.abortRestart, []));
  }
  info() {
    return { id: this.id, name: this.name, kind: this.kind, state: this.state, waiting: this.waiting, client: this.client ? this.client.cid : null, rid: this.rid,
      runnableMs: Math.round(this.runnableMs), remainingMs: this.remainingMs === Infinity ? null : Math.round(this.remainingMs), held: [...this.held].map(sb => sb.id), startedAt: this.startedAt };
  }
}

export class Scheduler {
  constructor(server) {
    this.server = server; this.log = server.log; this.L = server.L; this.S = server.L.S; this.Ed = server.Ed;
    this.threads = new Map(); this.queue = []; this.current = null; this.scheduled = false;
    this.main = this.S.threadState;
    this.main.data = { current: null, echo: '', inhibitRO: false };
    this.lag = monitorEventLoopDelay({ resolution: 10 }); this.lag.enable();
    this.acks = [];                                     // recent ack latencies (ms), R15.11
    this.timers = new Map(); this.idleTimers = new Set(); this.lastInputAt = Date.now();
    this.stopping = false;
  }

  /* ---------- threads ---------- */
  /* Start a thread running BODY, a generator function of the thread, under an abort restart. */
  spawn(body, opts = {}) {
    const S = this.S, t = new Thread(this, opts);
    const tag = {};
    t.abortTag = tag;
    t.abortRestart = new S.Restart(S.intern('abort'), opts.kind === 'command' ? 'Abort the command.' : 'Abort the thread.', null, () => ABORTED, tag, true);
    const self = this;
    t.gen = (function* () {
      const r = yield* S.establishG([t.abortRestart], tag, function* () { return yield* body(t); });
      if (r === ABORTED) throw new Aborted();
      return r;
    })();
    this.threads.set(t.id, t);
    this.ready(t);
    return t;
  }
  /* Queue T. A command thread whose event-loop break is over goes first (FRONT: nothing else runs while a
     command runs, R4.39); a thread resuming from a blocking point queues behind the runnable ones. */
  ready(t, front = false) {
    if (t.state === 'done') return;
    t.state = 'runnable';
    if (front) { let i = 0; while (i < this.queue.length && this.queue[i].kind === 'command') i++; this.queue.splice(i, 0, t); }
    else this.queue.push(t);
    this.schedule();
  }
  schedule() { if (this.scheduled || this.stopping) return; this.scheduled = true; setImmediate(() => { this.scheduled = false; this.pump(); }); }
  pump() {
    const t = this.queue.shift();
    if (!t) return;
    if (t.state !== 'runnable') { this.schedule(); return; }
    this.step(t);
    if (this.queue.length) this.schedule();
  }
  step(t) {
    const S = this.S;
    const now = performance.now();
    const slice = t.kind === 'command' ? COMMAND_BREAK_MS : SLICE_MS;
    t.ts.sliceEnd = now + slice;
    let budget = t.remainingMs;
    if (t.held.size) budget = Math.min(budget, Math.max(0, HOLD_MS - (t.runnableMs - t.holdSince)));
    t.ts.deadlineAt = budget === Infinity ? Infinity : now + budget;
    t.ts.canSuspend = true;
    t.state = 'running'; this.current = t;
    let r, threw = null;
    let how = t.resume; t.resume = null;
    if (t.pendingThrow) { how = { throw: t.pendingThrow }; t.pendingThrow = null; }
    this.L.resetOps();
    S.switchTo(t.ts);
    try { r = how && how.throw !== undefined ? t.gen.throw(how.throw) : t.gen.next(how ? how.value : undefined); }
    catch (e) { threw = e; }
    const end = performance.now();
    t.runnableMs += end - now;
    if (t.remainingMs !== Infinity) t.remainingMs = Math.max(0, t.remainingMs - (end - now));
    if (S.threadState !== this.main) S.switchTo(this.main);
    this.current = null;
    if (threw !== null) { this.finish(t, threw, undefined); return; }
    if (r.done) { this.finish(t, null, r.value); return; }
    const y = r.value;
    if (y === S.PREEMPT) { this.ready(t, t.kind === 'command'); return; }
    if (y instanceof S.Block) {
      t.state = 'blocked'; t.waiting = y.what || 'a promise';
      this.release(t);
      const token = ++t.waitToken;
      Promise.resolve(y.promise).then(
        v => { if (t.waitToken === token && t.state === 'blocked') { t.resume = { value: v }; t.waiting = null; this.ready(t); } },
        e => { if (t.waitToken === token && t.state === 'blocked') { t.resume = { throw: e }; t.waiting = null; this.ready(t); } });
      return;
    }
    if (y instanceof S.Suspend) {
      t.state = 'suspended'; t.waiting = 'the debugger'; t.suspend = y;
      this.release(t);
      if (this.onSuspend) { try { this.onSuspend(t, y); } catch (e) { this.log.error('debugger', { error: e.stack || String(e) }); t.resumeFromDebugger({ throw: y.condition }); } }
      else t.resumeFromDebugger({ value: undefined });
      return;
    }
    /* Anything else yielded is a bug in a primitive: treat it as a value. */
    t.resume = { value: y }; this.ready(t);
  }
  finish(t, error, value) {
    t.state = 'done'; t.waiting = null; t.suspend = null;
    this.release(t);
    /* A mutex a finished thread still holds is released, so a forgotten mutex-unlock! blocks nobody for good. */
    for (const m of t.owned) { m.owner = null; const w = m.waiters.shift(); if (w) w(true); }
    t.owned.clear();
    this.threads.delete(t.id);
    if (error !== null) { t.error = error; t.rejectDone(error); if (t.kind === 'background' && !(error instanceof Aborted)) this.reportBackground(t, error); }
    else { t.result = value; t.resolveDone(value); }
  }
  reportBackground(t, e) {
    const S = this.S;
    if (e instanceof S.Unwind || e instanceof Aborted) return; // aborted
    const report = e instanceof S.SchemeError ? S.errorMessage(e) : e instanceof S.Raise ? 'raised ' + S.write(e.obj) : (e && e.message) || String(e);
    this.log.warn('thread', { thread: t.name, event: 'error', report });
    try { this.Ed.message(`Thread ${t.name}: ${report}`); } catch (x) { /* no echo area */ }
  }
  /* The debugger (or anything holding a suspended thread) lets it go on: {value} continues a continuable
     condition, {throw} delivers a condition or an Unwind to a restart. */
  resumeThread(t, how) {
    if (t.state !== 'suspended') return false;
    t.suspend = null; t.waiting = null; t.resume = how; this.ready(t); return true;
  }

  /* ---------- held buffers (R4.41) ---------- */
  hold(t, sb, from = sb.ed.ver) {
    if (sb.hold && sb.hold.thread !== t) this.flush(sb);
    if (!sb.hold) { sb.hold = { thread: t, from }; }
    if (!t.held.has(sb)) { if (!t.held.size) t.holdSince = t.runnableMs; t.held.add(sb); }
  }
  /* Sequence the holder's pending edits of SB as one batch (nothing if there are none). */
  flush(sb) {
    const h = sb.hold; if (!h) return null;
    const b = sb.ed, ops = [];
    for (const e of b.log) if (e.v > h.from && e.o === 'local') ops.push([e.pos, e.del, e.ins]);
    h.from = b.ver;
    if (!ops.length) return null;
    const seq = this.server.buffers.seq;
    const entry = seq.recordApplied(sb, ops, h.thread.by);
    const p = seq.commit(sb, entry, null).catch(e => this.log.error('hold', { buf: sb.id, error: e.message }));
    return p;
  }
  /* A blocking point or the end of thread T: its edits are sequenced, the buffers released and the
     waiting client edits applied in order. */
  release(t) {
    if (!t.held.size) return;
    const held = [...t.held]; t.held.clear();
    for (const sb of held) {
      if (!sb.hold || sb.hold.thread !== t) continue;
      this.flush(sb);
      sb.hold = null;
      this.server.buffers.seq.drainHeld(sb);
    }
  }

  /* ---------- running Scheme for clients ---------- */
  deadlineFor(client) { return client ? (client.kind === 'cli' ? DEADLINE_CLI_MS : DEADLINE_FRAME_MS) : null; }
  byFor(client, t) {
    if (!client) return { kind: 'server', thread: t ? t.name : 'server' };
    const by = client.by(); by.via = 'server'; return by;
  }
  /* The buffer a call runs in: ctx/buf names a shared buffer, else the server's own current buffer. */
  bufferFor(buf) {
    if (typeof buf === 'string') { const sb = this.server.buffers.byId.get(buf); if (sb) return sb.ed; }
    return null;
  }
  /* Evaluate the forms of TEXT in the image for CLIENT: a command thread; the result object of §7.4. */
  evalForms(client, text, { buf, ctx = {}, deadlineMs, name: nm } = {}) {
    const { L, S, Ed } = this;
    let forms;
    try { forms = L.readAll(text); } catch (e) { return Promise.resolve(this.errorResult(e, null, [], '', client)); }
    const outParts = [];
    const port = S.makeOutputPort(s => outParts.push(s), 'call');
    const self = this;
    const t = this.spawn(function* (thread) {
      const undo = S.bindDyn(S.currentOutputPort, port);
      try { let v = S.UNSPEC; for (const f of forms) v = yield* S.evalFormG(f); return v; }
      finally { undo(); }
    }, { kind: 'command', client, rid: ctx.rid, name: nm || 'call', by: this.byFor(client), deadlineMs: deadlineMs === undefined ? this.deadlineFor(client) : deadlineMs, buffer: this.bufferFor(buf) });
    this.applyCtx(t, ctx);
    this.holdCurrent(t);
    return t.done.then(v => {
      const msg = t.ts.data.echo;
      const note = this.server.image.record(client, forms);
      const r = { value: S.write(v) };
      const out = outParts.join('');
      if (out) r.out = out;
      const m = [msg, note].filter(Boolean).join('\n'); if (m) r.msg = m;
      return r;
    }, e => this.errorResult(e, t, outParts, t.ts.data.echo, client));
  }
  isServerCommand(cmd) { const f = this.L.fnOrNull(this.S.intern(cmd)); return !!f && f.interactive !== undefined && (f.where === 'server' || f.where === 'both'); }
  /* Run the server command named CMD (a Scheme command declared :where 'server) for CLIENT. */
  runCommand(client, cmd, args, ctx, buf) {
    const { L, S } = this;
    const f = L.fnOrNull(S.intern(cmd));
    if (!f || !this.isServerCommand(cmd)) throw new ProtoError('bad_request', `unknown command ${cmd}`);
    const self = this;
    const outParts = [];
    const port = S.makeOutputPort(s => outParts.push(s), 'call');
    const sargs = (Array.isArray(args) ? args : []).map(a => jsonToScheme(S, a));
    const t = this.spawn(function* (thread) {
      const undo = S.bindDyn(S.currentOutputPort, port);
      try {
        if (!sargs.length && f.interactive !== undefined && f.interactive !== '') return yield* self.callInteractivelyG(f);
        return yield* S.applyG(f, sargs);
      } finally { undo(); }
    }, { kind: 'command', client, rid: ctx.rid, name: cmd, by: this.byFor(client), deadlineMs: this.deadlineFor(client), buffer: this.bufferFor(buf) });
    this.applyCtx(t, ctx);
    this.holdCurrent(t);
    return t.done.then(v => {
      const r = { value: S.write(v) };
      const out = outParts.join(''); if (out) r.out = out;
      const msg = t.ts.data.echo; if (msg) r.msg = msg;
      return r;
    }, e => this.errorResult(e, t, outParts, t.ts.data.echo, client));
  }
  /* A thread's current buffer is held from the moment it is made current (R4.41). */
  holdCurrent(t) {
    const b = t === this.current ? this.Ed.E.current : t.ts.data.current;
    if (!b) return;
    const sb = this.server.buffers.ofEd(b);
    if (sb && !sb.special) this.hold(t, sb);
  }
  /* The caller's point, mark and prefix (§7.4 ctx) land in the thread's current buffer. */
  applyCtx(t, ctx) {
    const b = t.ts.data.current;
    if (!b || !ctx) return;
    if (Number.isInteger(ctx.point)) b.pt = Math.max(0, Math.min(b.rope.length, ctx.point - 1));
    if (Number.isInteger(ctx.mark)) { b.mark = Math.max(0, Math.min(b.rope.length, ctx.mark - 1)); b.markActive = true; }
    if (ctx.prefix !== undefined && ctx.prefix !== null) t.prefix = ctx.prefix;
  }
  errorResult(e, t, outParts, msg, client) {
    const { S } = this;
    const error = this.server.conditionOf(e);
    if (e instanceof Aborted || (t && e instanceof S.Unwind)) { error.condition = 'aborted'; error.report = 'Aborted'; error.backtrace = []; }
    if (t) error.thread = t.id;
    const r = { error };
    const out = outParts.join(''); if (out) r.out = out;
    if (msg) r.msg = msg;
    this.log.info('call', { kind: client ? client.kind : 'server', condition: error.condition });
    return r;
  }

  /* ---------- ask (R4.29, §7.4) ---------- */
  /* Ask the frame of thread T for input; the thread blocks until answer{rid, value|quit}. */
  *askG(t, kind, prompt, init, table) {
    const S = this.S;
    if (!t) throw new S.SchemeError('user-error', `Cannot read input here: ${prompt}`, []);
    if (!t.client || t.client.kind !== 'frame') throw new S.SchemeError('user-error', `No frame to ask: ${prompt}`, []);
    if (t.rid === null) throw new S.SchemeError('user-error', `No call to ask through: ${prompt}`, []);
    if (t.ask) throw new S.SchemeError('error', 'Command attempted to use minibuffer while in minibuffer', []);
    const msg = { t: 'ask', rid: t.rid, kind, prompt };
    if (init !== undefined && init !== false && init !== null) msg.init = init;
    if (table !== undefined && table !== null) msg.table = table;
    const p = new Promise((resolve, reject) => { t.ask = { resolve, reject, kind }; });
    t.client.send(msg);
    try { return yield new S.Block(p, 'an answer'); }
    finally { t.ask = null; }
  }
  onAnswer(client, msg) {
    const S = this.S;
    const t = this.threadOfCall(client, msg.rid);
    if (!t || !t.ask) return;
    const a = t.ask; t.ask = null;
    if (msg.quit === true) { a.reject(new S.SchemeError('quit', 'Quit', [])); return; }
    a.resolve(msg.value === undefined ? false : msg.value);
  }
  onInterrupt(client, msg) {
    const S = this.S;
    const quit = () => new S.SchemeError('quit', 'Quit', []);
    if (typeof msg.rid === 'string') { const t = this.threadOfCall(client, msg.rid); if (t) t.interrupt(quit()); return; }
    for (const t of this.threads.values()) if (t.client === client && t.kind === 'command') t.interrupt(quit());
  }
  threadOfCall(client, rid) { for (const t of this.threads.values()) if (t.client === client && t.rid === rid) return t; return null; }
  /* call-interactively for a server command: the interactive spec's readers go through ask. */
  *callInteractivelyG(f) {
    const { L, S, Ed } = this;
    let spec = f.interactive;
    if (spec === undefined) throw new S.SchemeError('wrong-type-argument', `${f.procName || 'procedure'} is not a command`, []);
    let args;
    if (typeof spec === 'function' && !spec.jsSpec) spec = yield* S.applyG(spec, []);
    if (typeof spec === 'string') args = yield* this.specArgsG(spec);
    else if (spec === false || spec === undefined || spec === S.UNSPEC) args = [];
    else if (typeof spec === 'function') throw new S.SchemeError('error', 'This command reads its arguments in a frame only', []);
    else args = S.arr(spec);
    return yield* S.applyG(f, args);
  }
  *specArgsG(spec) {
    const { L, S, Ed } = this, E = Ed.E, t = this.current;
    const out = [];
    const items = spec.split('\n').filter(x => x).map(x => x.replace(/^[*^@]+/, ''));
    const str = (kind, prompt, init, table) => this.askG(t, kind, prompt, init, table);
    const names = f => { try { return S.arr(f()).map(x => x instanceof S.Sym ? x.name : String(x)); } catch (e) { return undefined; } };
    for (const item of items) {
      if (!item) continue;
      const code = item[0], prompt = item.slice(1);
      switch (code) {
        case 'p': out.push(Ed.prefixNumeric(t && t.prefix !== undefined ? t.prefix : null)); break;
        case 'P': out.push(t && t.prefix !== undefined && t.prefix !== null ? t.prefix : false); break;
        case 'r': { const b = E.current; if (b.mark === null) throw new S.SchemeError('error', 'The mark is not set now, so there is no region', []); out.push(Math.min(b.pt, b.mark) + 1, Math.max(b.pt, b.mark) + 1); break; }
        case 'd': out.push(E.current.pt + 1); break;
        case 'm': if (E.current.mark === null) throw new S.SchemeError('error', 'The mark is not set now', []); out.push(E.current.mark + 1); break;
        case 'i': out.push(false); break;
        case 's': case 'M': out.push(String(yield* str('string', prompt, ''))); break;
        case 'n': { const v = String(yield* str('number', prompt, '')); const n = Number(v); if (v.trim() === '' || isNaN(n)) throw new S.SchemeError('error', 'Please enter a number.', []); out.push(n); break; }
        case 'N': if (t && t.prefix !== undefined && t.prefix !== null) out.push(Ed.prefixNumeric(t.prefix)); else { const v = String(yield* str('number', prompt, '')); out.push(Number(v) || 0); } break;
        case 'x': out.push(L.read(String(yield* str('string', prompt, '')))); break;
        case 'X': out.push(yield* S.evalFormG(L.read(String(yield* str('string', prompt, ''))))); break;
        case 'C': out.push(S.intern(String(yield* str('completing', prompt, '', names(Ed.commandNames))))); break;
        case 'a': out.push(S.intern(String(yield* str('completing', prompt, '', names(Ed.functionNames))))); break;
        case 'v': out.push(S.intern(String(yield* str('completing', prompt, '', names(Ed.variableNames))))); break;
        case 'b': case 'B': out.push(String(yield* str('completing', prompt, '', names(Ed.bufferNames)))); break;
        case 'f': case 'F': out.push(String(yield* str('string', prompt, ''))); break;
        case 'k': case 'K': case 'c': case '<': out.push(String(yield* str('char', prompt, ''))); break;
        default: throw new S.SchemeError('error', `Unknown interactive code ${code}`, []);
      }
    }
    return out;
  }

  /* ---------- timers (R4.46) ---------- */
  noteInput() { this.lastInputAt = Date.now(); for (const tm of this.idleTimers) { tm.fired = false; this.armIdle(tm); } }
  makeTimer(fn, args, { at, repeat, idle, label }) {
    const id = Symbol('timer');
    const tm = { id, fn, args, repeat, idle: !!idle, handle: null, fired: false, label: label || 'timer', __print: () => '#<timer>' };
    const obj = { __print: () => `#<timer ${tm.label}>`, id, timer: tm };
    this.timers.set(id, tm);
    if (idle) { tm.secs = at; this.idleTimers.add(tm); this.armIdle(tm); }
    else {
      const fire = () => {
        this.fireTimer(tm);
        if (typeof repeat === 'number' && repeat > 0 && this.timers.has(id)) { tm.handle = setTimeout(fire, repeat * 1000); tm.handle.unref(); }
        else this.timers.delete(id);
      };
      tm.handle = setTimeout(fire, Math.max(0, at)); tm.handle.unref();
    }
    return obj;
  }
  armIdle(tm) {
    if (tm.handle) clearTimeout(tm.handle);
    if (tm.fired && !tm.repeat) return;
    const wait = Math.max(0, tm.secs * 1000 - (Date.now() - this.lastInputAt));
    tm.handle = setTimeout(() => {
      if (!this.timers.has(tm.id)) return;
      if (Date.now() - this.lastInputAt < tm.secs * 1000) { this.armIdle(tm); return; }
      tm.fired = true; this.fireTimer(tm);
      if (!tm.repeat) { this.timers.delete(tm.id); this.idleTimers.delete(tm); }
    }, wait);
    tm.handle.unref();
  }
  fireTimer(tm) {
    const S = this.S;
    this.spawn(function* () { return yield* S.applyG(tm.fn, tm.args); }, { kind: 'background', name: tm.label, debugOnError: false });
  }
  cancelTimer(obj) {
    const tm = obj && obj.timer ? obj.timer : (obj && obj.id ? this.timers.get(obj.id) : null);
    if (!tm) return false;
    if (tm.handle) clearTimeout(tm.handle);
    this.timers.delete(tm.id); this.idleTimers.delete(tm);
    return true;
  }

  /* ---------- status (R15.11) ---------- */
  noteAck(ms) { this.acks.push(ms); if (this.acks.length > 500) this.acks.splice(0, this.acks.length - 500); }
  p95(xs) { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] * 100) / 100; }
  status() {
    const lag = this.lag.count ? Math.round(this.lag.percentile(95) / 1e4) / 100 : null;
    return { loopLagP95Ms: lag, ackP95Ms: this.p95(this.acks), threads: this.threads.size, threadsSuspended: [...this.threads.values()].filter(t => t.state === 'suspended').length };
  }
  shutdown() {
    this.stopping = true;
    for (const tm of this.timers.values()) if (tm.handle) clearTimeout(tm.handle);
    this.timers.clear(); this.idleTimers.clear();
    for (const t of [...this.threads.values()]) { t.state = 'done'; t.rejectDone(new Error('edwind is stopping')); }
    this.threads.clear(); this.queue.length = 0;
    this.lag.disable();
  }
}

/* JSON from the wire as Scheme values: objects become alists with symbol keys, arrays lists. */
export function jsonToScheme(S, v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return S.listOf(v.map(x => jsonToScheme(S, x)));
  if (typeof v === 'object') return S.listOf(Object.entries(v).map(([k, x]) => S.cons(S.intern(k), jsonToScheme(S, x))));
  return v;
}
/* Scheme values as JSON for the wire: symbols as strings, alists with symbol keys as objects, other lists as arrays. */
export function schemeToJson(S, v, depth = 0) {
  if (depth > 64) return null;
  if (v === S.NIL) return [];
  if (v === S.UNSPEC || v === undefined) return null;
  if (v instanceof S.Sym) return v.name;
  if (v instanceof S.Char) return String.fromCodePoint(v.code);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof S.Pair) {
    const items = S.arr(v);
    if (items.length && items.every(p => p instanceof S.Pair && p.car instanceof S.Sym)) { const o = {}; for (const p of items) o[p.car.name] = schemeToJson(S, p.cdr, depth + 1); return o; }
    return items.map(x => schemeToJson(S, x, depth + 1));
  }
  if (Array.isArray(v)) return v.map(x => schemeToJson(S, x, depth + 1));
  if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[typeof k === 'string' ? k : S.write(k)] = schemeToJson(S, x, depth + 1); return o; }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return S.write(v);
}

/* ---------- the module ---------- */
export async function install(server) {
  const { L, Ed } = server, S = L.S, E = Ed.E;
  const sched = new Scheduler(server);
  server.threads = sched;
  S.watchdog.limitMs = Infinity;                       // deadlines replace the frame watchdog (R14.13)

  /* Thread state the evaluator does not own: the current buffer, the echo area, inhibit-read-only. */
  S.hooks.threadSwitch = (prev, next) => {
    prev.data = { current: E.current, echo: E.echo, inhibitRO: E.inhibitRO };
    const d = next.data || sched.main.data;
    if (d.current && (E.buffers.includes(d.current) || d.current === E.minibuf)) E.current = d.current;
    else if (!E.buffers.includes(E.current)) E.current = E.buffers[0] || E.current;
    E.echo = d.echo || ''; E.inhibitRO = !!d.inhibitRO;
  };
  /* Held buffers: a local edit from a thread, or making a shared buffer current, holds it. */
  const prevEdited = Ed.hooks.edited;
  Ed.hooks.edited = b => {
    if (prevEdited) prevEdited(b);
    const t = sched.current;
    if (!t || E.editOrigin !== 'local') return;
    const sb = server.buffers.ofEd(b);
    if (sb && !sb.special) sched.hold(t, sb, b.ver - 1); // the edit is logged already
  };
  const prevFloor = Ed.hooks.logFloor;
  Ed.hooks.logFloor = b => { const own = prevFloor ? prevFloor(b) : Infinity; const sb = server.buffers.ofEd(b); return sb && sb.hold ? Math.min(own, sb.hold.from) : own; };
  const holdCurrent = () => { const t = sched.current; if (t) sched.holdCurrent(t); };
  for (const nm of ['set-buffer', 'switch-to-buffer']) { const f = L.fnOrNull(S.intern(nm)); if (f) { const inner = f; const wrapped = args => { const r = inner(args); holdCurrent(); return r; }; Object.assign(wrapped, { procName: inner.procName, doc: inner.doc, params: inner.params, interactive: inner.interactive, where: inner.where }); S.gdef(nm, wrapped); } }
  const wcb = L.fnOrNull(S.intern('%with-current-buffer'));
  if (wcb && wcb.gen) { const g = wcb.gen; wcb.gen = function* (args) { const saved = E.current; E.current = Ed.toBuffer(args[0]); holdCurrent(); E.current = saved; return yield* g(args); }; }
  /* Edits to held buffers wait; server batches flush the holder first; acks are timed (R15.11). */
  const seq = server.buffers.seq;
  seq.holdOf = sb => (sb.hold ? sb.hold.thread : null);
  seq.flushHold = sb => sched.flush(sb);
  const edit0 = seq.edit.bind(seq);
  seq.edit = async (client, sb, msg) => { const t0 = performance.now(); const r = await edit0(client, sb, msg); sched.noteAck(performance.now() - t0); return r; };
  server.statusProviders.push(() => sched.status());
  server.onMessage('answer', (client, msg) => sched.onAnswer(client, msg));
  server.onMessage('interrupt', (client, msg) => sched.onInterrupt(client, msg));
  server.onInput = () => sched.noteInput();

  /* ---------- primitives (all server-only, R4.49) ---------- */
  const D = (nm, args, doc, fn, gen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
  const blocking = (nm, args, doc, gen) => D(nm, args, doc, () => { throw new S.SchemeError('cannot-block', `${nm}: cannot wait here`, []); }, gen);
  const thr = (x, who) => { if (!(x instanceof Thread)) throw S.typeErr('thread', x, who); return x; };
  const secs = (x, who) => { const n = S.num(x, who); if (!(n >= 0)) throw new S.SchemeError('range-error', `${who}: seconds must be non-negative`, [x]); return n; };
  const sleep = ms => new Promise(r => { const h = setTimeout(r, ms); h.unref(); });
  const cur = () => sched.current;

  D('current-thread', '', 'The running thread.', () => cur() || false);
  D('thread?', 'x', '#t if X is a thread.', ([x]) => x instanceof Thread);
  D('thread-name', 'thread', 'The name of THREAD.', ([t]) => thr(t, 'thread-name').name);
  D('thread-id', 'thread', 'The number of THREAD.', ([t]) => thr(t, 'thread-id').id);
  D('thread-state', 'thread', 'One of runnable, running, blocked, suspended, done.', ([t]) => S.intern(thr(t, 'thread-state').state));
  D('thread-alive?', 'thread', '#t while THREAD has not finished.', ([t]) => thr(t, 'thread-alive?').alive);
  D('all-threads', '', 'Every live thread.', () => S.listOf([...sched.threads.values()]));
  D('thread-kill', 'thread', 'Invoke the abort restart of THREAD (R4.37).', ([t]) => thr(t, 'thread-kill').kill());
  D('thread-interrupt', 'thread condition', 'Signal CONDITION in THREAD at its next step.', ([t, c]) => thr(t, 'thread-interrupt').interrupt(c instanceof S.SchemeError ? c : new S.SchemeError('quit', 'Quit', [])));
  D('make-thread', 'thunk [name]', 'Run THUNK on a new background thread (preempted every 5 ms, R4.40).', ([f, nm]) => {
    S.proc(f, 'make-thread');
    const parent = cur();
    return sched.spawn(function* () { return yield* S.applyG(f, []); }, { kind: 'background', name: nm === undefined || nm === false ? undefined : S.write(nm).replace(/^"|"$/g, ''), by: parent && parent.by.kind !== 'server' ? { ...parent.by } : undefined, debugOnError: false });
  });
  blocking('thread-join', 'thread [timeout]', 'Wait for THREAD to finish and return its value; its condition is re-signalled here; TIMEOUT seconds give the timeout condition.', function* ([t, to]) {
    thr(t, 'thread-join');
    if (t === cur()) throw new S.SchemeError('error', 'thread-join: a thread cannot join itself', []);
    let p = t.done.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
    if (to !== undefined && to !== false) p = Promise.race([p, sleep(secs(to, 'thread-join') * 1000).then(() => ({ timeout: true }))]);
    const r = yield new S.Block(p, 'thread ' + t.name);
    if (r.timeout) throw new S.SchemeError('timeout', `thread-join: ${t.name} did not finish in time`, [t]);
    if (r.ok) return r.v;
    if (r.e instanceof Aborted || r.e instanceof S.Unwind) throw new S.SchemeError('thread-cancelled', `Thread ${t.name} was aborted`, [t]);
    if (r.e instanceof S.SchemeError) { const c = new S.SchemeError('thread-died', `Thread ${t.name}: ${S.errorMessage(r.e)}`, [t]); c.payload = r.e; throw c; }
    throw new S.SchemeError('thread-died', `Thread ${t.name}: ${r.e && r.e.message ? r.e.message : String(r.e)}`, [t]);
  });
  blocking('thread-yield', '', 'Let other threads and waiting edits run; a blocking point (R4.41).', function* () { return yield new S.Block(Promise.resolve(S.UNSPEC), 'thread-yield'); });
  const sleepG = who => function* ([s]) { yield new S.Block(sleep(secs(s, who) * 1000), `${who} ${s}`); return S.UNSPEC; };
  blocking('thread-sleep!', 'seconds', 'Suspend the thread for SECONDS.', sleepG('thread-sleep!'));
  blocking('sleep-for', 'seconds', 'Suspend the thread for SECONDS (a blocking point).', sleepG('sleep-for'));
  blocking('sit-for', 'seconds', 'Suspend the thread for SECONDS; #t.', function* ([s]) { yield new S.Block(sleep(secs(s, 'sit-for') * 1000), `sit-for ${s}`); return true; });
  /* Mutexes and mailboxes (R4.40). */
  class Mutex { constructor(nm) { this.name = nm || null; this.owner = null; this.waiters = []; } __print() { return `#<mutex${this.name ? ' ' + this.name : ''}>`; } }
  class Mailbox { constructor(nm) { this.name = nm || null; this.items = []; this.waiters = []; } __print() { return `#<mailbox${this.name ? ' ' + this.name : ''}>`; } }
  D('make-mutex', '[name]', 'A mutex.', ([nm]) => new Mutex(nm === undefined || nm === false ? null : String(nm)));
  D('mutex?', 'x', '#t if X is a mutex.', ([x]) => x instanceof Mutex);
  D('mutex-owner', 'mutex', 'The thread holding MUTEX, or #f.', ([m]) => { if (!(m instanceof Mutex)) throw S.typeErr('mutex', m, 'mutex-owner'); return m.owner || false; });
  blocking('mutex-lock!', 'mutex [timeout]', 'Take MUTEX, waiting while another thread holds it; #t, or #f after TIMEOUT seconds.', function* ([m, to]) {
    if (!(m instanceof Mutex)) throw S.typeErr('mutex', m, 'mutex-lock!');
    const me = cur();
    if (m.owner === me) throw new S.SchemeError('error', 'mutex-lock!: the thread holds the mutex already', [m]);
    while (m.owner) {
      let p = new Promise(r => m.waiters.push(r));
      if (to !== undefined && to !== false) p = Promise.race([p, sleep(secs(to, 'mutex-lock!') * 1000).then(() => 'timeout')]);
      if ((yield new S.Block(p, 'mutex ' + (m.name || ''))) === 'timeout') return false;
    }
    m.owner = me; if (me) me.owned.add(m); return true;
  });
  D('mutex-unlock!', 'mutex', 'Release MUTEX and wake one waiter.', ([m]) => {
    if (!(m instanceof Mutex)) throw S.typeErr('mutex', m, 'mutex-unlock!');
    if (m.owner) m.owner.owned.delete(m);
    m.owner = null; const w = m.waiters.shift(); if (w) w(true); return S.UNSPEC;
  });
  D('make-mailbox', '[name]', 'A mailbox: a queue of values between threads.', ([nm]) => new Mailbox(nm === undefined || nm === false ? null : String(nm)));
  D('mailbox?', 'x', '#t if X is a mailbox.', ([x]) => x instanceof Mailbox);
  D('mailbox-send!', 'mailbox value', 'Put VALUE in MAILBOX and wake a receiver.', ([mb, v]) => { if (!(mb instanceof Mailbox)) throw S.typeErr('mailbox', mb, 'mailbox-send!'); mb.items.push(v); const w = mb.waiters.shift(); if (w) w(); return S.UNSPEC; });
  D('mailbox-empty?', 'mailbox', '#t if MAILBOX holds nothing.', ([mb]) => { if (!(mb instanceof Mailbox)) throw S.typeErr('mailbox', mb, 'mailbox-empty?'); return !mb.items.length; });
  blocking('mailbox-receive!', 'mailbox [timeout [default]]', 'The next value of MAILBOX, waiting for one; after TIMEOUT seconds DEFAULT (or the timeout condition).', function* ([mb, to, dflt]) {
    if (!(mb instanceof Mailbox)) throw S.typeErr('mailbox', mb, 'mailbox-receive!');
    while (!mb.items.length) {
      let p = new Promise(r => mb.waiters.push(r));
      if (to !== undefined && to !== false) p = Promise.race([p, sleep(secs(to, 'mailbox-receive!') * 1000).then(() => 'timeout')]);
      if ((yield new S.Block(p, 'mailbox ' + (mb.name || ''))) === 'timeout') { if (dflt !== undefined) return dflt; throw new S.SchemeError('timeout', 'mailbox-receive!: nothing arrived in time', [mb]); }
    }
    return mb.items.shift();
  });
  /* (%with-timeout secs thunk): THUNK's value, or the timeout condition signalled in the thread when SECS pass first. */
  blocking('%with-timeout', 'seconds thunk', 'Call THUNK; signal timeout in this thread if SECONDS pass first (with-timeout expands into this).', function* ([s, f]) {
    const t = cur(), ms = secs(s, 'with-timeout') * 1000;
    const cond = new S.SchemeError('timeout', `Timed out after ${s} s`, [s]);
    let fired = false;
    const h = setTimeout(() => { fired = true; if (t && t.alive) t.interrupt(cond); }, ms); h.unref();
    try { return yield* S.applyG(f, []); } finally { clearTimeout(h); }
  });
  /* Blocking from JS: a module's generator primitive yields (S.Block promise). This helper is for Scheme code. */
  blocking('%block-on', 'promise', 'Wait for a JS promise (for primitives written in Scheme over JS objects).', function* ([p]) { return yield new S.Block(p, 'a promise'); });

  /* Timers (R4.46): each firing is a background thread. */
  const timeArg = (x, who) => {
    if (typeof x === 'number') return Math.max(0, x) * 1000;
    if (typeof x === 'string') {
      let m = /^\s*(\d+(?:\.\d+)?)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|hr)?\s*$/.exec(x);
      if (m) return Number(m[1]) * (/^min/.test(m[2] || '') ? 60000 : /^(hour|hr)/.test(m[2] || '') ? 3600000 : 1000);
      m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(x);
      if (m) { const d = new Date(); const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2], +(m[3] || 0)); let ms = at - d; if (ms < 0) ms += 86400000; return ms; }
    }
    throw new S.SchemeError('wrong-type-argument', `${who}: a time is a number of seconds or a string like "5 min" or "14:30"`, [x]);
  };
  const timerFn = (f, who) => { if (typeof f !== 'function' && !(f instanceof S.Sym)) throw S.typeErr('procedure', f, who); return f; };
  D('run-at-time', 'time repeat function . args', 'Call FUNCTION at TIME (seconds from now, or "N sec", "N min", "HH:MM"), then every REPEAT seconds; a timer.', ([at, rep, f, ...a]) => sched.makeTimer(timerFn(f, 'run-at-time'), a, { at: timeArg(at, 'run-at-time'), repeat: typeof rep === 'number' && rep > 0 ? rep : null, label: S.write(f) }));
  D('run-with-timer', 'secs repeat function . args', 'Call FUNCTION after SECS seconds, then every REPEAT seconds; a timer. Each call runs as a background thread.', ([s, rep, f, ...a]) => sched.makeTimer(timerFn(f, 'run-with-timer'), a, { at: secs(s, 'run-with-timer') * 1000, repeat: typeof rep === 'number' && rep > 0 ? rep : null, label: S.write(f) }));
  D('run-with-idle-timer', 'secs repeat function . args', 'Call FUNCTION once no client has sent input for SECS seconds; with REPEAT true, once per idle period.', ([s, rep, f, ...a]) => sched.makeTimer(timerFn(f, 'run-with-idle-timer'), a, { at: secs(s, 'run-with-idle-timer'), repeat: S.truthy(rep), idle: true, label: S.write(f) }));
  D('cancel-timer', 'timer', 'Stop TIMER.', ([t]) => sched.cancelTimer(t));
  D('timer-list', '', 'The pending timers.', () => S.listOf([...sched.timers.values()].map(tm => ({ __print: () => `#<timer ${tm.label}>`, id: tm.id, timer: tm }))));
  D('timerp', 'x', '#t if X is a timer.', ([x]) => !!(x && x.timer));

  /* Minibuffer input from a server command goes to the calling frame as ask (R4.29). */
  const askStr = (kind) => function* ([prompt, init, ...rest]) {
    let table;
    if (kind === 'completing') { table = init; init = rest[2]; }
    const t = cur();
    const tab = table === undefined ? undefined : table instanceof Map ? [...table.keys()].map(k => String(k)) : S.arr(table).map(x => x instanceof S.Pair ? (x.car instanceof S.Sym ? x.car.name : String(x.car)) : x instanceof S.Sym ? x.name : String(x));
    const v = yield* sched.askG(t, kind, S.str(prompt, 'read'), typeof init === 'string' ? init : undefined, tab);
    return v === null ? false : v;
  };
  blocking('read-string', 'prompt [initial]', 'Read a string in the calling frame\'s minibuffer (ask).', askStr('string'));
  blocking('read-from-minibuffer', 'prompt [initial]', 'Read a string in the calling frame\'s minibuffer (ask).', askStr('string'));
  blocking('completing-read', 'prompt table [predicate require initial]', 'Read a choice among TABLE in the calling frame\'s minibuffer (ask).', askStr('completing'));
  blocking('read-number', 'prompt [default]', 'Read a number in the calling frame\'s minibuffer (ask).', function* ([prompt, d]) {
    const v = yield* sched.askG(cur(), 'number', S.str(prompt, 'read-number'), d === undefined || d === false ? undefined : String(d));
    const n = Number(v); if (v === '' || v === null || isNaN(n)) throw new S.SchemeError('error', 'Please enter a number.', []); return n;
  });
  const yn = (kind) => function* ([prompt]) { const v = yield* sched.askG(cur(), kind, S.str(prompt, kind)); return v === true || v === 'y' || v === 'yes'; };
  blocking('y-or-n-p', 'prompt', 'Ask y or n in the calling frame (ask); #t for yes.', yn('y-or-n'));
  blocking('yes-or-no-p', 'prompt', 'Ask for yes or no in the calling frame (ask); #t for yes.', yn('yes-or-no'));
  blocking('read-char', '[prompt]', 'Read one character in the calling frame (ask).', function* ([prompt]) { const v = yield* sched.askG(cur(), 'char', prompt === undefined ? '' : S.str(prompt, 'read-char')); return typeof v === 'string' && v.length ? S.mkchar(v.codePointAt(0)) : false; });
  blocking('read-key', '[prompt]', 'Read one key in the calling frame (ask).', function* ([prompt]) { return yield* sched.askG(cur(), 'char', prompt === undefined ? '' : S.str(prompt, 'read-key')); });
  /* call-interactively on the server reads through ask. */
  const ci = L.fnOrNull(S.intern('call-interactively'));
  if (ci) ci.gen = function* ([c]) { return yield* sched.callInteractivelyG(L.toFn(c)); };

  /* Introspection of the scheduler for list-threads and the inspector. */
  D('%thread-info', 'thread', 'An alist describing THREAD.', ([t]) => jsonToScheme(S, thr(t, '%thread-info').info()));
  D('%thread-suspended-condition', 'thread', 'The condition a suspended THREAD stopped at, or #f.', ([t]) => (thr(t, '%thread-suspended-condition').suspend ? t.suspend.condition : false));
  server.defineCommand('thread-list', () => ({ value: [...sched.threads.values()].map(t => t.info()) }));
  server.defineCommand('thread-kill', (client, args) => { const id = Number(Array.isArray(args) ? args[0] : NaN); const t = sched.threads.get(id); if (!t) throw new ProtoError('bad_request', `no thread ${args && args[0]}`); return { value: t.kill() }; });

  L.evalText(fs.readFileSync(SCM_FILE, 'utf8'));
}

export async function shutdown(server) { if (server.threads) server.threads.shutdown(); }
