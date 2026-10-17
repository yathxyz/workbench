// The debugger, the inspector and introspection of the server image (spec §4.7 R4.35, R4.37; §4.9
// R4.48, R4.50).
//
// A condition no handler takes suspends its thread at the signal point when debug-on-error is true
// (commands run for a frame; false for cli calls, R13.10, and background threads, which log). The
// *Backtrace* buffer, a server special buffer, shows the newest session: the report, the numbered
// restarts and the stack with one line per frame; it is displayed in the calling frame, or the most
// recent frame when a thread has none. The keys of backtrace-mode (debug.scm) run server commands that
// read the frame number from the line at point: RET locals, e eval in the frame's environment, v inspect
// a local, r invoke a restart, c continue a continuable condition, q abort. Everything else goes on
// meanwhile: the thread is parked, its buffers released, other threads and clients served.
//
// The inspector (*Inspector*) walks records, pairs, vectors, hash tables, buffers, threads, clients,
// procedures and plain host objects, numbered so a part can be entered and the path popped. apropos,
// find-definition, room, list-threads and list-clients render their own special buffers. The primitive
// registry (R4.48) lists every JS primitive with its arity, documentation, where it runs and its source
// line in edwin/src or edwin/server; `edwind --primitives` prints it as JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtoError } from './proto.mts';
import { Thread, jsonToScheme } from './threads.mts';
import type { Restart, Resume, SchemeGen, SchemeSymbol } from './threads.mts';
import type { By } from './proto.mts';
import type { Client } from './session.mts';
import type { SBuf } from './buffers.mts';
import type { Ed as Edwin, Lisp, Log, SchemeValue, Server } from './main.mts';

/* The evaluator S of edwin/src (scheme.js), untyped JavaScript like the rest of L. */
type Scheme = Lisp['S'];
export interface SourceLoc { file?: string | null; line: number; col?: number }
/* The parts of a procedure the debugger reads: compound procedures have a scope (parameter name -> frame slot). */
export interface SchemeProc { procName?: string; scope?: { names: Map<SchemeSymbol, number> } }
/* One entry of S.conditionBacktrace, innermost first. */
export interface StackFrame { proc: SchemeProc | null; frame: SchemeValue[] | null; loc: SourceLoc | null }
/* What a thread yields to stop in the debugger (S.Suspend). */
export interface Suspension { condition: SchemeValue; continuable: boolean }
/* An inspected object: a title, free lines and the numbered parts. */
export interface Description { title: string; lines: string[]; parts: [string, SchemeValue][] }
export interface AproposItem { name: string; kind: 'command' | 'function' | 'variable' | 'macro'; where: string; doc: string }
export interface DefinitionLocation { file: string | null; line: number | null; kind: 'procedure' | 'primitive' | 'macro' }
export type RoomInfo = { heapUsedMiB: number; heapTotalMiB: number; rssMiB: number; externalMiB: number; buffers: number; chars: number; journalBytes: number; threads: number; clients: number; imageEntries: number };
export interface ClientInfo { cid: string | null; kind: string | null; device: string | null; session: string | null; buffers: string[] }
export interface PrimitiveEntry { name: string; args: string; doc: string; where: string; command: boolean; blocking: boolean; source: string | null }

export const name = 'debug';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDWIN = path.join(HERE, '..');
const SCM_FILE = path.join(HERE, '..', 'scm', 'debug.scm');
const SERVER_BY: By = { kind: 'server' };
export const BACKTRACE = '*Backtrace*', INSPECTOR = '*Inspector*', THREADS = '*Threads*', CLIENTS = '*Clients*', APROPOS = '*Apropos*';

/* A read-only special buffer the server renders, shared as name:NAME (image.mts does the same for *image-log*).
   TEXT replaces its contents as one server batch; CLIENT (if any) is told to display it. Returns the SBuf. */
export async function showSpecial(server: Server, bufName: string, text: string, client: Client | null | undefined, how: string = 'other-window'): Promise<SBuf> {
  const { Ed, buffers } = server;
  const id = 'name:' + bufName;
  let sb = buffers.byId.get(id);
  if (!sb) {
    const ed = Ed.getBufferCreate(bufName); ed.mode = 'special-mode'; ed.readOnly = true;
    sb = buffers.resolve(id, false) as SBuf;
    sb.readOnly = 'server special buffer';
  }
  await buffers.replaceText(sb, text, SERVER_BY);
  sb.savedText = sb.text; sb.savedHash = null; // a rendering is never "modified"
  if (client && !client.closed) client.send({ t: 'display', buf: sb.id, how });
  return sb;
}
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ---------- the debugger ---------- */
class Session {
  declare dbg: Debugger;
  declare S: Scheme;
  declare thread: Thread;
  declare cond: SchemeValue;
  declare continuable: boolean;
  declare frames: StackFrame[];
  declare restarts: Restart[];
  declare at: number;
  constructor(dbg: Debugger, thread: Thread, suspend: Suspension) {
    this.dbg = dbg; this.S = dbg.S;
    this.thread = thread; this.cond = suspend.condition; this.continuable = suspend.continuable;
    this.frames = (() => { try { return this.S.conditionBacktrace(this.cond) || []; } catch (e) { return []; } })();
    this.restarts = []; for (let n = thread.ts.restarts; n; n = n.next) this.restarts.push(n.r);
    this.at = Date.now();
  }
  report(): string { return this.dbg.Ed.errorText(this.cond); }
  conditionName(): string { const c = this.cond; return c instanceof this.S.SchemeError ? c.kind : c instanceof this.S.Raise ? 'raise' : 'error'; }
  frame(n: number): StackFrame { const f = this.frames[n]; if (!f) this.dbg.fail(`No stack frame ${n}`); return f; }
  /* The locals of frame N: [[name, value], ...] by parameter name (R4.35). */
  locals(n: number): [string, SchemeValue][] {
    const f = this.frame(n), out: [string, SchemeValue][] = [];
    if (!f.proc || !f.proc.scope || !f.frame) return out;
    for (const [sym, k] of f.proc.scope.names) out.push([sym.name, f.frame[k]]);
    return out;
  }
  environment(n: number): SchemeValue | null { const f = this.frame(n); return f.proc && f.proc.scope && f.frame ? new this.S.Environment(f.proc.scope, f.frame) : null; }
  render(): string {
    const S = this.S, t = this.thread;
    const out = [`Debugger entered: ${this.conditionName()}`, this.report(), ''];
    out.push(`Thread ${t.id} (${t.name}, ${t.kind}${t.client ? ', for ' + t.client.kind + ' ' + t.client.cid!.slice(0, 8) : ''}) is suspended${this.continuable ? '; the condition is continuable (c)' : ''}.`, '');
    out.push('Restarts:');
    this.restarts.forEach((r, i) => out.push(`  ${i}: [${r.name ? r.name.name : 'anonymous'}] ${S.restartReport(r)}`));
    if (!this.restarts.length) out.push('  (none)');
    out.push('', 'Backtrace (innermost first; RET locals, e eval, v inspect, r restart, c continue, q abort):');
    this.frames.forEach((f, i) => {
      const nm = f.proc && f.proc.procName ? f.proc.procName : 'anonymous';
      const params = f.proc && f.proc.scope ? [...f.proc.scope.names.keys()].map(s => s.name) : [];
      const args = params.map(p => { const k = f.proc!.scope!.names.get(S.intern(p)); const v = f.frame ? f.frame[k!] : undefined; return v === undefined ? p : `${p}=${clip(S.write(v), 40)}`; });
      const loc = f.loc ? ` at ${f.loc.file || ''}:${f.loc.line}${f.loc.col !== undefined ? ':' + f.loc.col : ''}` : '';
      out.push(`  ${pad(i + ':', 4)}(${[nm, ...args].join(' ')})${loc}`);
    });
    if (!this.frames.length) out.push('  (no Scheme frames)');
    return out.join('\n') + '\n';
  }
}

export class Debugger {
  declare server: Server;
  declare S: Scheme;
  declare L: Lisp;
  declare Ed: Edwin;
  declare log: Log;
  declare sessions: Map<number, Session>;
  declare current: Session | null;
  declare inspector: SchemeValue[];
  declare _sources: Map<string, string> | undefined;
  constructor(server: Server) {
    this.server = server; this.S = server.L.S; this.L = server.L; this.Ed = server.Ed; this.log = server.log;
    this.sessions = new Map(); // thread id -> Session
    this.current = null;
    this.inspector = [];       // the inspector's path: objects, outermost first
  }
  /* A frame to show the debugger in: the thread's own client when it is a frame, else the newest frame. */
  frameFor(t: Pick<Thread, 'client'>): Client | null {
    if (t.client && t.client.kind === 'frame' && !t.client.closed) return t.client;
    let last = null; for (const c of this.server.clients) if (c.kind === 'frame' && !c.closed) last = c;
    return last;
  }
  wants(t: Thread | null): boolean { return !!t && t.debugOnError && this.L.truthy(this.L.get('debug-on-error')) && this.frameFor(t) !== null; }
  async onSuspend(t: Thread, suspend: Suspension): Promise<void> {
    const s = new Session(this, t, suspend);
    this.sessions.set(t.id, s); this.current = s;
    this.log.info('debugger', { thread: t.id, condition: s.conditionName(), frames: s.frames.length });
    await this.refresh(this.frameFor(t));
  }
  async refresh(client: Client | null): Promise<SBuf> {
    const s = this.current;
    const text = s ? s.render() : 'No thread is in the debugger.\n';
    return showSpecial(this.server, BACKTRACE, text, client);
  }
  fail(msg: string): never { throw new this.S.SchemeError('error', msg, []); }
  session(id?: number | null): Session {
    if (id === undefined || id === null) { if (!this.current) this.fail('No thread is in the debugger'); return this.current; }
    const s = this.sessions.get(Number(id)); if (!s) this.fail(`Thread ${id} is not in the debugger`); return s;
  }
  drop(t: Thread): void {
    const s = this.sessions.get(t.id); if (!s) return;
    this.sessions.delete(t.id);
    if (this.current === s) this.current = [...this.sessions.values()].pop() || null;
    this.refresh(null).catch(() => {});
  }
  /* The thread leaves the debugger: resumed (continue, a restart) or aborted. */
  leave(s: Pick<Session, 'thread'>, how: Resume): void {
    this.sessions.delete(s.thread.id);
    if (this.current === s) this.current = [...this.sessions.values()].pop() || null;
    const ok = this.server.threads.resumeThread(s.thread, how);
    if (!ok) this.fail(`Thread ${s.thread.id} is no longer suspended`);
    this.refresh(null).catch(() => {});
  }
  restart(s: Session, k: number, args?: SchemeValue[]): string {
    const r = s.restarts[k]; if (!r) this.fail(`No restart ${k}`);
    this.leave(s, { throw: new this.S.Unwind(r.tag, r, args || []) });
    return r.name ? r.name.name : 'anonymous';
  }
  abort(s: Session): string { this.leave(s, { throw: new this.S.Unwind(s.thread.abortTag, s.thread.abortRestart, []) }); return 'abort'; }
  continue_(s: Session, value: SchemeValue): boolean {
    if (!s.continuable) this.fail('The condition is not continuable; use a restart or abort');
    this.leave(s, { value }); return true;
  }
  /* Evaluate TEXT in the lexical environment of frame N, on a short-lived command thread for CLIENT. */
  async evalIn(s: Pick<Session, 'environment'>, n: number, text: string, client: Client): Promise<SchemeValue> {
    const { S, L } = this;
    const env = s.environment(n) || S.globalEnvironment;
    const forms = L.readAll(text);
    const t = this.server.threads.spawn(function* () { let v = S.UNSPEC; for (const f of forms) v = yield* S.evalInG(f, env); return v; },
      { kind: 'command', client, name: 'debugger-eval', by: this.server.threads.byFor(client), deadlineMs: this.server.threads.deadlineFor(client), debugOnError: false });
    return t.done;
  }

  /* ---------- the inspector ---------- */
  /* The parts of OBJECT: {title, lines: [string], parts: [[label, value]]}. */
  describe(x: SchemeValue): Description {
    const { S, Ed } = this, server = this.server;
    const parts: [string, SchemeValue][] = [], lines: string[] = [];
    let title: string;
    if (x === S.NIL) title = 'the empty list';
    else if (x instanceof S.Pair) {
      const items: SchemeValue[] = []; let p = x; while (p instanceof S.Pair) { items.push(p.car); p = p.cdr; }
      title = `a list of ${items.length}${p === S.NIL ? '' : ' (improper, tail ' + S.write(p) + ')'}`;
      items.forEach((v, i) => parts.push([String(i), v]));
    } else if (Array.isArray(x)) { title = `a vector of ${x.length}`; x.forEach((v: SchemeValue, i: number) => parts.push([String(i), v])); }
    else if (x instanceof Map) { title = `a hash table of ${x.size}`; for (const [k, v] of x) parts.push([S.write(k), v]); }
    else if (x instanceof S.Record) { title = `a record of type ${x.type.name}`; x.type.fieldNames.forEach((f: SchemeValue, i: number) => parts.push([f instanceof S.Sym ? f.name : String(f), x.fields[i]])); }
    else if (x instanceof S.RecordType) { title = `the record type ${x.name}`; parts.push(['fields', S.listOf(x.fieldNames)]); }
    else if (x instanceof Ed.Buffer) {
      title = `the buffer ${x.name}`;
      const sb = server.buffers.ofEd(x);
      parts.push(['size', x.rope.length], ['point', x.pt + 1], ['mark', x.mark === null ? false : x.mark + 1], ['mode', S.intern(x.mode || 'fundamental-mode')], ['read-only', !!x.readOnly], ['modified', !!x.modified]);
      if (x.file) parts.push(['file', x.file]);
      if (sb) parts.push(['shared-id', sb.id], ['version', sb.ver], ['clients', S.listOf([...sb.clients])]);
      if (x.locals && x.locals.size) parts.push(['locals', x.locals]);
    } else if (x instanceof Thread) { title = `the thread ${x.id} (${x.name})`; for (const [k, v] of Object.entries(x.info())) parts.push([k, jsonToScheme(S, v)]); }
    else if (x && x.constructor && x.constructor.name === 'Client' && x.cid) { title = `the client ${x.cid.slice(0, 8)} (${x.kind})`; parts.push(['cid', x.cid], ['kind', S.intern(x.kind)], ['device', x.device], ['session', x.session || false], ['buffers', S.listOf([...x.buffers].map((sb: SBuf) => sb.id))], ['closed', !!x.closed]); }
    else if (typeof x === 'function') {
      title = x.procName ? `the procedure ${x.procName}` : 'an anonymous procedure';
      parts.push(['kind', S.intern(typeof x.params === 'string' ? 'primitive' : 'compound')]);
      if (x.params !== undefined) parts.push(['parameters', typeof x.params === 'string' ? x.params : S.write(x.params)]);
      if (x.doc) parts.push(['documentation', x.doc]);
      parts.push(['where', S.intern(x.where || 'both')]);
      if (x.interactive !== undefined) parts.push(['interactive', x.interactive === '' ? true : x.interactive]);
      if (x.loc) parts.push(['source', `${x.loc.file || ''}:${x.loc.line}`]);
      if (x.src) parts.push(['definition', x.src]);
    } else if (x instanceof S.Sym) { title = `the symbol ${x.name}`; const v = this.L.get(x.name); if (v !== undefined) parts.push(['value', v]); if (S.gdoc.get(x.name)) parts.push(['documentation', S.gdoc.get(x.name)]); const f = this.L.fnOrNull(x); if (f) parts.push(['procedure', f]); }
    else if (x instanceof S.SchemeError) { title = `the condition ${x.kind}`; parts.push(['report', Ed.errorText(x)], ['irritants', S.listOf(x.irritants || [])]); }
    else if (typeof x === 'string') { title = `a string of ${x.length}`; lines.push(S.write(x)); }
    else if (typeof x === 'number' || typeof x === 'bigint' || typeof x === 'boolean' || x instanceof S.Char) { title = `the ${typeof x === 'boolean' ? 'boolean' : x instanceof S.Char ? 'character' : 'number'} ${S.write(x)}`; }
    else if (x && typeof x.__inspect === 'function') { const d = x.__inspect(); title = d.title || S.write(x); for (const [k, v] of d.parts || []) parts.push([k, v]); for (const l of d.lines || []) lines.push(l); }
    else if (x && typeof x === 'object') { title = S.write(x); for (const k of Object.keys(x)) if (typeof x[k] !== 'function') parts.push([k, x[k]]); }
    else title = S.write(x);
    return { title, lines, parts };
  }
  renderInspector(): string {
    const { S } = this;
    if (!this.inspector.length) return 'Nothing is being inspected.\n';
    const x = this.inspector[this.inspector.length - 1];
    const d = this.describe(x);
    const out = [`Inspecting ${d.title}`, `Path depth ${this.inspector.length} (RET or a number enters a part, l pops, q quits)`, ''];
    for (const l of d.lines) out.push(l);
    d.parts.forEach(([k, v], i) => out.push(`  ${pad(i + ':', 4)}${pad(k, 18)} ${clip(S.write(v), 100)}`));
    return out.join('\n') + '\n';
  }
  async inspect(x: SchemeValue, client: Client | null): Promise<SBuf> { this.inspector.push(x); return showSpecial(this.server, INSPECTOR, this.renderInspector(), client); }
  async inspectNth(n: number, client: Client | null): Promise<SBuf> {
    const x = this.inspector[this.inspector.length - 1];
    if (x === undefined) this.fail('Nothing is being inspected');
    const d = this.describe(x); const p = d.parts[n];
    if (!p) this.fail(`No part ${n}`);
    return this.inspect(p[1], client);
  }
  async inspectPop(client: Client | null): Promise<SBuf> { if (this.inspector.length > 1) this.inspector.pop(); return showSpecial(this.server, INSPECTOR, this.renderInspector(), client); }

  /* ---------- introspection ---------- */
  threadsText(): string {
    const ts = [...this.server.threads.threads.values()];
    const out = [`${ts.length} thread${ts.length === 1 ? '' : 's'} (thread-kill N invokes a thread's abort restart; suspended ones are in *Backtrace*)`, '', `  ${pad('id', 5)}${pad('state', 11)}${pad('kind', 11)}${pad('client', 10)}${pad('runnable', 10)}${pad('held', 6)}name / waiting for`];
    for (const t of ts) out.push(`  ${pad(t.id, 5)}${pad(t.state, 11)}${pad(t.kind, 11)}${pad(t.client ? t.client.kind + ':' + t.client.cid!.slice(0, 4) : '-', 10)}${pad(Math.round(t.runnableMs) + ' ms', 10)}${pad(t.held.size, 6)}${t.name}${t.waiting ? ' (waiting for ' + t.waiting + ')' : ''}`);
    return out.join('\n') + '\n';
  }
  clientsText(): string {
    const cs = [...this.server.clients];
    const out = [`${cs.length} client${cs.length === 1 ? '' : 's'}`, '', `  ${pad('cid', 10)}${pad('kind', 7)}${pad('device', 24)}${pad('buffers', 9)}session`];
    for (const c of cs) out.push(`  ${pad(c.cid ? c.cid.slice(0, 8) : '-', 10)}${pad(c.kind || '-', 7)}${pad(clip(c.device || '-', 22), 24)}${pad(c.buffers.size, 9)}${c.session || ''}`);
    return out.join('\n') + '\n';
  }
  clientInfo(c: Client): ClientInfo { return { cid: c.cid, kind: c.kind, device: c.device, session: c.session, buffers: [...c.buffers].map(sb => sb.id) }; }
  apropos(pattern: string): AproposItem[] {
    const { S, L, Ed } = this;
    let re: RegExp; try { re = new RegExp(pattern, 'i'); } catch (e) { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const first = (d: unknown) => (d ? String(d).split('\n')[0] : '');
    const out: AproposItem[] = [];
    for (const [nm, box] of S.globals) {
      if (!re.test(nm)) continue;
      const v = box.value;
      if (typeof v === 'function') out.push({ name: nm, kind: v.interactive !== undefined ? 'command' : 'function', where: v.where || 'both', doc: first(v.doc) });
      else if (v !== undefined) out.push({ name: nm, kind: 'variable', where: 'both', doc: first(S.gdoc.get(nm)) });
    }
    for (const nm of S.macros.keys()) if (re.test(nm)) out.push({ name: nm, kind: 'macro', where: 'both', doc: first(S.gdoc.get(nm)) });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }
  aproposText(pattern: string, items: AproposItem[]): string {
    const out = [`${items.length} match${items.length === 1 ? '' : 'es'} for ${JSON.stringify(pattern)}`, ''];
    for (const it of items) out.push(`${pad(it.name, 34)} ${pad(it.kind, 9)}${pad(it.where, 7)} ${it.doc}`);
    return out.join('\n') + '\n';
  }
  /* Where NAME is defined: {file, line, kind} for a Scheme procedure (its lambda's location), a JS primitive
     (the registry's line in edwin/src or edwin/server) or a macro; null when unknown. */
  findDefinition(nm: string): DefinitionLocation | null {
    const { S, L } = this;
    const f = L.fnOrNull(S.intern(nm));
    if (f && typeof f.params !== 'string') { const l = f.loc; return l && l.line !== undefined ? { file: l.file || null, line: l.line, kind: 'procedure' } : null; }
    const p = this.registry().find(r => r.name === nm);
    if (p && p.source) { const [file, line] = p.source.split(':'); return { file, line: line === undefined ? null : Number(line), kind: 'primitive' }; }
    if (S.macros.has(nm)) return { file: null, line: null, kind: 'macro' };
    return null;
  }
  room(): RoomInfo {
    const m = process.memoryUsage();
    const bufs = this.server.buffers.all();
    let journalBytes = 0;
    try { const d = path.join(this.server.cfg.stateDir, 'buffers'); for (const f of fs.readdirSync(d)) { try { journalBytes += fs.statSync(path.join(d, f)).size; } catch (e) { /* gone */ } } } catch (e) { /* no journals yet */ }
    return { heapUsedMiB: Math.round(m.heapUsed / 1048576 * 10) / 10, heapTotalMiB: Math.round(m.heapTotal / 1048576 * 10) / 10, rssMiB: Math.round(m.rss / 1048576 * 10) / 10, externalMiB: Math.round(m.external / 1048576 * 10) / 10,
      buffers: bufs.length, chars: bufs.reduce((n, sb) => n + sb.ed.rope.length, 0), journalBytes, threads: this.server.threads ? this.server.threads.threads.size : 0, clients: this.server.clients.size, imageEntries: this.server.image.entries.length };
  }

  /* ---------- the primitive registry (R4.48) ---------- */
  /* Source lines of the definers: D('name', CMD('name', pred('name', blocking('name', G('name' in edwin/src
     and edwin/server. The scan is textual and runs once. */
  sourceMap(): Map<string, string> {
    if (this._sources) return this._sources;
    const map = new Map<string, string>(), files = new Map<string, string>();
    const scan = (dir: string, rel: string) => {
      let names: string[] = []; try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const f of names) {
        if (!/\.(js|mjs|mts)$/.test(f)) continue;
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
          const re = /\b(?:D|CMD|pred|blocking|G|def|serverOnly\(L\.D|L\.D|L\.CMD)\(\s*'([^']+)'/g;
          let m: RegExpExecArray | null; while ((m = re.exec(line))) if (!map.has(m[1])) map.set(m[1], `${rel}/${f}:${i + 1}`);
        });
        /* Primitives defined in loops (caar, <, ...) have no definer line: the file where the name is quoted. */
        const quoted = /'([^'\s]+)'/g; let q: RegExpExecArray | null; const text = lines.join('\n');
        while ((q = quoted.exec(text))) if (!files.has(q[1])) files.set(q[1], `${rel}/${f}`);
      }
    };
    scan(path.join(EDWIN, 'src'), 'edwin/src'); scan(path.join(EDWIN, 'server'), 'edwin/server');
    for (const [nm, file] of files) if (!map.has(nm)) map.set(nm, file);
    this._sources = map; return map;
  }
  /* The definer's file:line from the stack def captured (scheme.js def), relative to the repository: the first
     frame that is not one of the definer helpers (D, CMD, pred, G, blocking, ...). */
  defSource(f: SchemeValue): string | null {
    if (!f.defAt) return null;
    const HELPERS = new Set(['def', 'D', 'CMD', 'pred', 'G', 'blocking', 'serverOnly', 'defineConditionType', 'alias']);
    for (const raw of String(f.defAt).split('\n').slice(1)) {
      const m = /^\s*at\s+(?:([^\s(]+)\s+\()?(?:file:\/\/)?([^():\s]+\.(?:m?js|mts)):(\d+)(?::\d+)?\)?\s*$/.exec(raw);
      if (!m) continue;
      const [, fn, file, line] = m;
      if (fn && HELPERS.has(fn.replace(/^.*\./, ''))) continue;
      const i = file.indexOf('/edwin/');
      if (i < 0) continue;
      return `${file.slice(i + 1)}:${line}`;
    }
    return null;
  }
  /* Every JS primitive of the image: name, arity (the parameter string), documentation, where it runs, source. */
  registry(): PrimitiveEntry[] {
    const { S } = this, src = this.sourceMap(), out: PrimitiveEntry[] = [];
    for (const [nm, box] of S.globals) {
      const f = box.value;
      if (typeof f !== 'function' || f.scope || !(typeof f.params === 'string' || f.defAt)) continue; // compound procedures are Scheme
      const source = this.defSource(f) || src.get(nm) || src.get(f.procName) || null;
      out.push({ name: nm, args: typeof f.params === 'string' ? f.params : '', doc: f.doc ? String(f.doc).split('\n')[0] : '', where: f.where || (source && source.startsWith('edwin/server/') ? 'server' : 'both'), command: f.interactive !== undefined, blocking: typeof f.gen === 'function', source });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }
}

/* ---------- the module ---------- */
export async function install(server: Server): Promise<void> {
  const { L, Ed } = server, S = L.S;
  const dbg = new Debugger(server);
  server.debugger = dbg;
  const sched = server.threads;
  if (!sched) throw new Error('debug.mts needs threads.mts installed first');
  L.defvar('debug-on-error', true, 'Non-nil means a condition no handler takes suspends its thread in the debugger (R4.35). Commands run for frames only; cli calls and background threads report instead.');

  /* The evaluator asks here when a condition reaches the top without a handler (scheme.js debugG). */
  S.hooks.debugG = function* (cond: SchemeValue, continuable: boolean): SchemeGen {
    const t = sched.current;
    /* A deadline (R14.13) or a cancelled thread ends the thread; it is not a bug to debug. */
    if (cond instanceof S.SchemeError && (cond.kind === 'timeout' || cond.kind === 'thread-cancelled')) return undefined;
    if (!dbg.wants(t)) return undefined;
    const v = yield new S.Suspend(cond, continuable); // the scheduler parks the thread; the debugger resumes it
    return { value: v };
  };
  sched.onSuspend = (t: Thread, y: Suspension) => dbg.onSuspend(t, y).catch((e: Error) => { server.log.error('debugger', { error: e.stack || String(e) }); dbg.leave(dbg.sessions.get(t.id) || { thread: t }, { throw: y.condition }); });
  /* A suspended thread resumed by other means (interrupt, thread-kill) leaves the debugger. */
  sched.onUnsuspend = (t: Thread) => dbg.drop(t);
  const D = (nm: string, args: string, doc: string, fn: (args: SchemeValue[]) => SchemeValue, gen?: (args: SchemeValue[]) => SchemeGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
  const cur = () => sched.current;
  const frameClient = () => { const t = cur(); return t && t.client && t.client.kind === 'frame' ? t.client : dbg.frameFor(t || { client: null }); };
  const blockOn = (p: Promise<unknown>) => new S.Block(p, 'the display');
  const sess = (x: SchemeValue) => dbg.session(x === undefined || x === false ? undefined : S.num(x, 'debugger'));
  const num = (x: SchemeValue, who: string): number => { const n = S.num(x, who); if (!Number.isInteger(n) || n < 0) throw new S.SchemeError('range-error', `${who}: expected a non-negative integer`, [x]); return n; };

  /* Primitives behind the backtrace-mode commands of debug.scm (and usable from wb eval). */
  D('debugger-sessions', '', 'The ids of the threads suspended in the debugger.', () => S.listOf([...dbg.sessions.keys()]));
  D('debugger-frames', '[thread]', 'The stack of the thread in the debugger as a list of (index name args location).', ([th]) => { const s = sess(th); return S.listOf(s.frames.map((f, i) => S.listOf([i, S.intern(f.proc && f.proc.procName ? f.proc.procName : 'anonymous'), S.listOf(s.locals(i).map(([k, v]) => S.cons(S.intern(k), v === undefined ? false : v))), f.loc ? `${f.loc.file || ''}:${f.loc.line}` : false]))); });
  D('debugger-locals', 'frame [thread]', 'The locals of stack FRAME as an alist (RET in *Backtrace*).', ([n, th]) => S.listOf(sess(th).locals(num(n, 'debugger-locals')).map(([k, v]) => S.cons(S.intern(k), v === undefined ? false : v))));
  D('debugger-restarts', '[thread]', 'The restarts of the thread in the debugger: (index name report).', ([th]) => S.listOf(sess(th).restarts.map((r, i) => S.listOf([i, r.name || false, S.restartReport(r)]))));
  D('debugger-condition', '[thread]', 'The condition the thread in the debugger stopped at.', ([th]) => sess(th).cond);
  D('debugger-invoke-restart', 'index [thread . args]', 'Invoke restart INDEX of the thread in the debugger (r in *Backtrace*).', ([k, th, ...args]) => S.intern(dbg.restart(sess(th), num(k, 'debugger-invoke-restart'), args)));
  D('debugger-continue', '[value thread]', 'Continue a continuable condition with VALUE (c in *Backtrace*).', ([v, th]) => dbg.continue_(sess(th), v === undefined ? S.UNSPEC : v));
  D('debugger-abort', '[thread]', 'Invoke the abort restart of the thread in the debugger (q in *Backtrace*).', ([th]) => S.intern(dbg.abort(sess(th))));
  D('debugger-select', 'thread', 'Show THREAD (an id) in *Backtrace*.', ([th]) => { dbg.current = sess(th); return th; });
  D('%debugger-refresh', '', 'Render *Backtrace* for the calling frame.', () => { throw new S.SchemeError('cannot-block', '%debugger-refresh: cannot wait here', []); }, function* () { yield blockOn(dbg.refresh(frameClient())); return S.UNSPEC; });
  D('debugger-eval', 'frame form [thread]', 'Evaluate FORM in the lexical environment of stack FRAME (e in *Backtrace*).', () => { throw new S.SchemeError('cannot-block', 'debugger-eval: cannot wait here', []); },
    function* ([n, form, th]) { const s = sess(th); const env = s.environment(num(n, 'debugger-eval')) || S.globalEnvironment; return yield* S.evalInG(form, env); });
  D('inspect', 'object', 'Open *Inspector* on OBJECT (R4.50).', () => { throw new S.SchemeError('cannot-block', 'inspect: cannot wait here', []); }, function* ([x]) { yield blockOn(dbg.inspect(x, frameClient())); return S.UNSPEC; });
  D('%inspect-nth', 'n', 'Enter part N of the inspected object.', () => { throw new S.SchemeError('cannot-block', 'inspect: cannot wait here', []); }, function* ([n]) { yield blockOn(dbg.inspectNth(num(n, 'inspect'), frameClient())); return S.UNSPEC; });
  D('%inspect-pop', '', 'Back to the enclosing inspected object.', () => { throw new S.SchemeError('cannot-block', 'inspect: cannot wait here', []); }, function* () { yield blockOn(dbg.inspectPop(frameClient())); return S.UNSPEC; });
  D('inspector-object', '', 'The object the inspector shows, or #f.', () => (dbg.inspector.length ? dbg.inspector[dbg.inspector.length - 1] : false));
  D('%show-special', 'name text', 'Render TEXT in the server special buffer NAME and display it in the calling frame.', () => { throw new S.SchemeError('cannot-block', '%show-special: cannot wait here', []); }, function* ([nm, text]) { const sb = yield blockOn(showSpecial(server, S.str(nm, '%show-special'), S.str(text, '%show-special'), frameClient())); return sb.id; });
  D('%threads-text', '', 'The *Threads* listing.', () => dbg.threadsText());
  D('%clients-text', '', 'The *Clients* listing.', () => dbg.clientsText());
  D('list-clients-internal', '', 'The connected clients.', () => S.listOf([...server.clients]));
  D('apropos-internal', 'pattern', 'Names matching PATTERN (a regexp) as (name kind where doc).', ([p]) => S.listOf(dbg.apropos(S.str(p, 'apropos')).map(it => S.listOf([S.intern(it.name), S.intern(it.kind), S.intern(it.where), it.doc]))));
  D('%apropos-text', 'pattern', 'The *Apropos* listing for PATTERN.', ([p]) => { const pat = S.str(p, 'apropos'); return dbg.aproposText(pat, dbg.apropos(pat)); });
  D('find-definition-location', 'name', 'Where NAME is defined: (file line kind), or #f.', ([n]) => { const r = dbg.findDefinition(n instanceof S.Sym ? n.name : S.str(n, 'find-definition')); return r ? S.listOf([r.file || false, r.line === null ? false : r.line, S.intern(r.kind)]) : false; });
  D('room-internal', '', 'Heap, buffers and journal sizes as an alist (R4.50).', () => jsonToScheme(S, dbg.room()));
  D('primitive-registry', '', 'Every JS primitive: (name args doc where command? blocking? source) (R4.48).', () => S.listOf(dbg.registry().map(p => S.listOf([S.intern(p.name), p.args, p.doc, S.intern(p.where), p.command, p.blocking, p.source || false]))));
  D('primitive-where', 'name', 'Where the primitive NAME runs: server, frame or both; #f for a compound procedure.', ([n]) => { const f = L.fnOrNull(n); if (!f || f.scope) return false; return S.intern(f.where || 'both'); });

  /* Server commands reached by call{cmd} (wb, and frames in E3); a Scheme condition becomes bad_request. */
  const num0 = <D extends number | undefined>(a: unknown[], i: number, dflt: D): number | D => (Array.isArray(a) && a[i] !== undefined && a[i] !== null ? Number(a[i]) : dflt);
  const define = server.defineCommand.bind(server);
  server.defineCommand = (nm, fn) => define(nm, async (...a) => { try { return await fn(...a); } catch (e) { if (e instanceof S.SchemeError) throw new ProtoError('bad_request', S.errorMessage(e)); throw e; } });
  server.defineCommand('debugger-state', () => ({ value: { current: dbg.current ? dbg.current.thread.id : null, sessions: [...dbg.sessions.values()].map(s => ({ thread: s.thread.id, condition: s.conditionName(), report: s.report(), continuable: s.continuable, frames: s.frames.length, restarts: s.restarts.map(r => ({ name: r.name ? r.name.name : null, report: S.restartReport(r) })) })) } }));
  server.defineCommand('debugger-frames', (client, args) => { const s = dbg.session(num0(args, 0, undefined)); return { value: s.frames.map((f, i) => ({ index: i, name: f.proc && f.proc.procName ? f.proc.procName : 'anonymous', locals: Object.fromEntries(s.locals(i).map(([k, v]) => [k, v === undefined ? null : S.write(v)])), loc: f.loc ? `${f.loc.file || ''}:${f.loc.line}` : null })) }; });
  server.defineCommand('debugger-eval', async (client, args) => { const s = dbg.session(num0(args, 2, undefined)); const n = num0(args, 0, 0); if (typeof args[1] !== 'string') throw new ProtoError('bad_request', 'debugger-eval needs [frame, form]'); const v = await dbg.evalIn(s, n, args[1], client); return { value: S.write(v) }; });
  server.defineCommand('debugger-restart', (client, args) => ({ value: dbg.restart(dbg.session(num0(args, 1, undefined)), num0(args, 0, 0), ((args[2] || []) as unknown[]).map(a => jsonToScheme(S, a))) }));
  server.defineCommand('debugger-continue', (client, args) => ({ value: dbg.continue_(dbg.session(num0(args, 1, undefined)), args[0] === undefined ? S.UNSPEC : jsonToScheme(S, args[0])) }));
  server.defineCommand('debugger-abort', (client, args) => ({ value: dbg.abort(dbg.session(num0(args, 0, undefined))) }));
  server.defineCommand('debugger-show', async (client, args) => { if (args[0] !== undefined) dbg.current = dbg.session(num0(args, 0, undefined)); const sb = await dbg.refresh(client); return { value: { buf: sb.id } }; });
  server.defineCommand('inspect', async (client, args) => { if (typeof args[0] !== 'string') throw new ProtoError('bad_request', 'inspect needs a form'); const v = await dbg.evalIn({ environment: () => null }, 0, args[0], client); const sb = await dbg.inspect(v, client); return { value: { buf: sb.id, title: dbg.describe(v).title } }; });
  server.defineCommand('client-list', () => ({ value: [...server.clients].map(c => dbg.clientInfo(c)) }));
  server.defineCommand('apropos-list', (client, args) => { const p = typeof args[0] === 'string' ? args[0] : ''; return { value: dbg.apropos(p) }; });
  server.defineCommand('definition-of', (client, args) => { if (typeof args[0] !== 'string') throw new ProtoError('bad_request', 'find-definition needs a name'); const r = dbg.findDefinition(args[0]); return r ? { value: r, msg: r.file ? `${args[0]} is defined at ${r.file}:${r.line}` : `${args[0]} is a ${r.kind} without a recorded location` } : { value: null, msg: `No definition found for ${args[0]}` }; });
  server.defineCommand('room-info', () => { const r = dbg.room(); return { value: r, msg: `Heap ${r.heapUsedMiB} of ${r.heapTotalMiB} MiB, RSS ${r.rssMiB} MiB; ${r.buffers} buffers, ${r.chars} chars; journals ${Math.round(r.journalBytes / 1024)} KiB; ${r.threads} threads, ${r.clients} clients` }; });
  server.defineCommand('primitives', () => ({ value: dbg.registry() }));
  server.defineCommand = define;
  server.statusProviders.push(() => ({ debugger: dbg.sessions.size }));

  L.evalText(fs.readFileSync(SCM_FILE, 'utf8'));
}
