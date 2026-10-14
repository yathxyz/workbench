// The image log (spec §4.4, R4.14–R4.21, R7.19, R13.9, §18.2 Q2): how one image spans many runtimes and
// survives restarts. It records definitions, not effects.
//
// image.jsonl in stateDir is one JSON object per line:
//   {t:"epoch", epoch, at}              the image epoch (R4.20); rewritten by reset, compaction and revert
//   {t:"form", gen, at, by, form}       one definitional form: its generation, the time, the caller's by()
//                                       (origin cli:<session> for wb eval, R13.9) and the form as `write` prints it
// A torn last line is dropped at load. A replay failure is kept in memory on the entry (`failed`) and never
// written: the next start replays again.
//
// The module installs the server commands image-log, image-compact, image-reset, image-save-to-init,
// image-problems, image-revert-entry and image-entries (§4.6, reached by call{cmd}), the server-only
// primitives %image-server?, %declare-definitional, %share-variable and %image-command, and the status fields.
// main.mjs calls record() from evalForm and replay() from start(); session.mjs calls sendAfter() for image?.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeAtomic, sha256 } from './files.mjs';
import { ProtoError } from './proto.mjs';

export const name = 'image';

/* Limits (R4.21); the environment lowers them for the gate suite. */
const envNum = (k, dflt) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : dflt; };
export const ENTRY_MAX = envNum('EDWIND_IMAGE_ENTRY_BYTES', 1 << 20);
export const COMPACT_ENTRIES = envNum('EDWIND_IMAGE_COMPACT_ENTRIES', 10000);
export const COMPACT_BYTES = envNum('EDWIND_IMAGE_COMPACT_BYTES', 16 << 20);
export const VAR_MAX = 64 * 1024;
export const LOG_BUFFER = '*image-log*';
export const LOG_BUFFER_ID = 'name:' + LOG_BUFFER;

/* The definitional heads of R4.14, plus the E2 forms of R4.16–R4.18 and declare-definitional itself (so a
   declaration made at run time is logged and reaches every runtime). */
export const HEADS = ['define', 'define-command', 'define-record-type', 'define-syntax', 'define-macro', 'define-minor-mode', 'define-derived-mode', 'defvar', 'defvar-local', 'defcustom', 'defface', 'set!', 'setq', 'setq-default', 'add-hook!', 'remove-hook!', 'advice-add', 'advice-remove', 'define-key', 'keymap-set', 'global-set-key', 'evil-define-key', 'evil-ex-define-cmd', 'define-snippet', 'put', 'provide', 'require', 'defvar-shared', 'on-server', 'on-frames', 'declare-definitional'];
/* Heads whose second element names what they define: a later entry with the same name supersedes an earlier
   one at compaction. Every other head (set!, define-key, add-hook!, on-server, ...) is keyed by its whole form. */
const NAMED = new Set(['define', 'define-command', 'define-record-type', 'define-syntax', 'define-macro', 'define-minor-mode', 'define-derived-mode', 'defvar', 'defvar-local', 'defvar-shared', 'defcustom', 'defface', 'define-snippet', 'evil-ex-define-cmd']);

export const randomEpoch = () => randomBytes(8).toString('hex');
/* The origin shown in image-log and the Q2 banner. */
export const originOf = by => {
  if (!by || !by.kind) return 'server';
  if (by.kind === 'cli') return by.session ? 'cli:' + by.session : 'cli@' + (by.device || '?');
  if (by.kind === 'frame' || by.kind === 'web') return by.kind + '@' + (by.device || by.cid || '?');
  return by.kind;
};
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const SERVER_BY = { kind: 'server' };

/* A Scheme value as JSON for var{name, value} (R4.18): booleans, numbers, strings, proper lists and vectors
   (both arrays), hash tables with string keys (objects). Anything else is refused by name. */
export function toJSON(S, v, name) {
  const bad = what => new S.SchemeError('error', `${name}: a shared variable holds JSON-serialisable values only; ${what}`, []);
  const conv = x => {
    if (x === true || x === false || typeof x === 'string') return x;
    if (typeof x === 'number') { if (!Number.isFinite(x)) throw bad(`${x} is not finite`); return x; }
    if (typeof x === 'bigint') { if (x > BigInt(Number.MAX_SAFE_INTEGER) || x < -BigInt(Number.MAX_SAFE_INTEGER)) throw bad(`${x} is beyond 2^53`); return Number(x); }
    if (x === S.NIL) return [];
    if (x instanceof S.Pair) { const out = []; let p = x; while (p instanceof S.Pair) { out.push(conv(p.car)); p = p.cdr; } if (p !== S.NIL) throw bad('an improper list'); return out; }
    if (Array.isArray(x)) return x.map(conv);
    if (x instanceof Map) { const o = {}; for (const [k, val] of x) { if (typeof k !== 'string') throw bad('a hash table key that is not a string'); o[k] = conv(val); } return o; }
    if (x instanceof S.Sym) throw bad(`the symbol ${x.name} (use a string)`);
    if (x === undefined) throw bad('an unbound value');
    throw bad(`${S.write(x)} has no JSON form`);
  };
  const json = conv(v);
  const bytes = Buffer.byteLength(JSON.stringify(json));
  if (bytes > VAR_MAX) throw new S.SchemeError('error', `${name}: a shared variable's value is at most ${VAR_MAX >> 10} KiB (this one is ${bytes} bytes)`, []);
  return json;
}
/* JSON back to a Scheme value (the inverse of toJSON): arrays become lists, objects hash tables. */
export function fromJSON(S, j) {
  if (j === null || j === undefined) return false;
  if (Array.isArray(j)) return S.listOf(j.map(x => fromJSON(S, x)));
  if (typeof j === 'object') { const m = new Map(); for (const [k, v] of Object.entries(j)) m.set(k, fromJSON(S, v)); return m; }
  if (typeof j === 'number' && Number.isInteger(j)) return BigInt(j);
  return j;
}
/* A server command's JSON result as a Scheme value for %image-command: objects become alists. */
function resultToScheme(S, j) {
  if (j === null || j === undefined) return false;
  if (Array.isArray(j)) return S.listOf(j.map(x => resultToScheme(S, x)));
  if (typeof j === 'object') return S.listOf(Object.entries(j).map(([k, v]) => S.cons(S.intern(k), resultToScheme(S, v))));
  if (typeof j === 'number' && Number.isInteger(j)) return BigInt(j);
  return j;
}
/* A Scheme argument of %image-command as JSON (symbols become strings, alists stay lists). */
function argToJSON(S, x) {
  if (x instanceof S.Sym) return x.name;
  if (typeof x === 'bigint') return Number(x);
  if (x === S.NIL) return [];
  if (x instanceof S.Pair) return S.arr(x).map(y => argToJSON(S, y));
  if (x === undefined) return null;
  return x;
}

export class ImageLog {
  constructor(file) {
    this.file = file; this.gen = 0; this.entries = []; this.epoch = null; this.bytes = 0;
    this.heads = new Set(HEADS); this.shared = new Map();
    this.server = null; this.refreshTimer = null; this.epochTimer = null;
    /* After an automatic compaction that left the log over a limit, the next one waits for a tenth more. */
    this.autoFloor = { entries: 0, bytes: 0 };
    this.load();
  }
  load() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; } // a torn last line
      if (o.t === 'epoch') { this.epoch = o.epoch; continue; }
      if (o.t === 'form' && Number.isInteger(o.gen) && typeof o.form === 'string') { this.entries.push(o); this.gen = Math.max(this.gen, o.gen); this.bytes += line.length + 1; }
    }
  }
  /* The epoch changes only when the image is reset, compacted or an entry is reverted (R4.20); a fresh log gets one. */
  ensureEpoch(make = randomEpoch) {
    if (this.epoch) return this.epoch;
    this.epoch = make();
    fs.appendFileSync(this.file, JSON.stringify({ t: 'epoch', epoch: this.epoch, at: Date.now() }) + '\n', { mode: 0o600 });
    return this.epoch;
  }
  /* Append a definitional form with the next generation; the line is on disk (fdatasync) when this returns. */
  append(form, by) {
    const entry = { t: 'form', gen: this.gen + 1, at: Date.now(), by, form };
    const line = JSON.stringify(entry) + '\n';
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, line); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
    this.entries.push(entry); this.gen = entry.gen; this.bytes += line.length;
    return entry;
  }
  after(gen) { return this.entries.filter(e => e.gen > gen); }
  /* Write the whole log fresh: the epoch line, then the entries (reset, compaction, revert). */
  rewrite() {
    const lines = [JSON.stringify({ t: 'epoch', epoch: this.epoch, at: Date.now() })];
    for (const e of this.entries) lines.push(JSON.stringify({ t: 'form', gen: e.gen, at: e.at, by: e.by, form: e.form }));
    const text = lines.join('\n') + '\n';
    writeAtomic(this.file, text);
    this.bytes = text.length - lines[0].length - 1;
  }

  /* ---------- the server side ---------- */
  /* Bind to the server once Edwin is loaded: the primitives of the Scheme side (emacs.scm, "image log"). */
  attach(server) {
    if (this.server) return;
    this.server = server;
    const { L } = server, S = L.S;
    const serverOnly = fn => { fn.where = 'server'; return fn; };
    serverOnly(L.D('%image-server?', '', '#t in the server image. Frames have no such primitive; emacs.scm tests for it.', () => true));
    serverOnly(L.D('%declare-definitional', 'symbol', 'Make forms whose head is SYMBOL definitional (R4.14): logged and replicated.', ([h]) => { this.heads.add(S.sym(h, 'declare-definitional').name); return S.intern(S.sym(h).name); }));
    serverOnly(L.D('%share-variable', 'symbol [doc]', 'Replicate the global SYMBOL: every assignment broadcasts var{name, value} (R4.18).', ([n, doc]) => this.shareVariable(S.sym(n, 'defvar-shared').name, typeof doc === 'string' ? doc : null)));
    serverOnly(L.D('%image-command', 'name . args', 'Run the image server command NAME (image-log, image-compact, image-reset, image-save-to-init, image-problems, image-revert-entry, image-entries) as the server.', ([n, ...args]) => {
      const cmd = typeof n === 'string' ? n : S.sym(n, '%image-command').name;
      if (!COMMANDS[cmd]) throw new S.SchemeError('error', `%image-command: unknown command ${cmd}`, []);
      const r = COMMANDS[cmd](this, null, args.map(a => argToJSON(S, a)));
      if (r && typeof r.then === 'function') { r.catch(e => server.log.warn('image', { cmd, error: e.message })); return S.intern(cmd); }
      return resultToScheme(S, r.value);
    }));
  }
  /* Replay the log after the boot files (R4.19, R15.9): a failing form is kept, marked and never stops the start. */
  replay(server) {
    this.attach(server);
    const { L, Ed, log } = server;
    let failed = 0;
    for (const e of this.entries) {
      delete e.failed;
      try { L.resetOps(); L.evalText(e.form); } catch (err) { e.failed = { error: Ed.errorText(err), at: Date.now() }; failed++; log.warn('image', { event: 'replay_failed', gen: e.gen, error: e.failed.error }); }
      finally { L.resetOps(); L.S.resetStack(); }
    }
    log.info('image', { event: 'replay', entries: this.entries.length, failed, epoch: this.epoch, gen: this.gen });
  }
  /* Is FORM (a read datum) definitional (R4.14)? begin and progn of only such forms count. */
  isDefinitional(form) {
    const S = this.server.L.S;
    if (!(form instanceof S.Pair) || !(form.car instanceof S.Sym)) return false;
    const head = form.car.name;
    if (head === 'begin' || head === 'progn') { let p = form.cdr, n = 0; while (p instanceof S.Pair) { if (!this.isDefinitional(p.car)) return false; p = p.cdr; n++; } return p === S.NIL && n > 0; }
    if (!this.heads.has(head)) return false;
    if (head === 'set!' || head === 'setq') return form.cdr instanceof S.Pair && form.cdr.car instanceof S.Sym;
    return true;
  }
  /* The compaction key of a form text (R4.20, R4.21): "head name" for the heads that name a definition, else
     the form itself. A begin of definitions is keyed as a whole. */
  keyOf(text) {
    const S = this.server.L.S;
    try {
      const f = S.read(text);
      if (f instanceof S.Pair && f.car instanceof S.Sym && NAMED.has(f.car.name) && f.cdr instanceof S.Pair) {
        let n = f.cdr.car;
        if (n instanceof S.Pair) n = n.car; // (define (name . args) ...)
        if (n instanceof S.Sym) return `${f.car.name} ${n.name}`;
      }
    } catch (e) { /* keyed by text */ }
    return text;
  }
  /* The name a form defines, for the Q2 banner; null for an effect. */
  nameOf(text) { const k = this.keyOf(text); return k === text ? null : k.slice(k.indexOf(' ') + 1); }

  /* After evalForm evaluated FORMS (read data) for CLIENT without a condition: log and broadcast the
     definitional ones (R4.15). Returns a note for the echo area, or null. */
  record(client, forms) {
    const { L, log } = this.server, S = L.S;
    const notes = [], texts = [], gens = [];
    for (const f of forms) {
      if (!this.isDefinitional(f)) continue;
      const text = S.write(f);
      const bytes = Buffer.byteLength(text);
      if (bytes > ENTRY_MAX) { notes.push(`Not logged to the image: a form of ${bytes} bytes is over the ${ENTRY_MAX >> 10} KiB limit (R4.21)`); log.warn('image', { event: 'too_large', bytes, by: client.kind }); continue; }
      const entry = this.append(text, client.by());
      texts.push(text); gens.push(entry.gen);
      log.info('image', { gen: entry.gen, by: client.kind });
    }
    if (texts.length) {
      this.broadcast({ t: 'image', gen: gens[gens.length - 1], forms: texts });
      const by = client.by();
      if (by.kind === 'cli') { // Q2: every frame hears that an agent or a shell changed the image
        const names = texts.map(t => this.nameOf(t) || (t.length > 60 ? t.slice(0, 57) + '...' : t)).join(', ');
        this.broadcast({ t: 'msg', text: `Image changed by ${originOf(by)}: ${names} (M-x image-log)`, level: 'info' }, true);
      }
      this.scheduleRefresh();
      if (this.overLimit()) this.compact({ auto: true });
    }
    return notes.length ? notes.join('\n') : null;
  }
  /* To every frame and web client (never cli): image, var and msg (R4.15, R4.18). */
  broadcast(obj, bulkish = false) {
    for (const c of this.server.clients) if (c.hello && !c.closed && (c.kind === 'frame' || c.kind === 'web')) { if (bulkish) c.sendBulkish(obj); else c.sendBulk(obj); }
  }
  /* image?{from} (§7.4): the entries after FROM as image messages of at most 100 forms, then the current
     value of every shared variable (an assignment made inside a procedure is not a logged form). */
  sendAfter(client, from) {
    const entries = this.after(from);
    for (let i = 0; i < entries.length; i += 100) { const slice = entries.slice(i, i + 100); client.sendBulk({ t: 'image', gen: slice[slice.length - 1].gen, forms: slice.map(e => e.form) }); }
    if (client.kind !== 'cli') for (const v of this.sharedValues()) client.sendBulk({ t: 'var', ...v });
    return { gen: this.gen };
  }

  /* ---------- shared variables (R4.18) ---------- */
  shareVariable(name, doc) {
    const { L } = this.server, S = L.S;
    const box = S.gbox(name);
    const desc = Object.getOwnPropertyDescriptor(box, 'value');
    let cur = desc && desc.get ? desc.get.call(box) : box.value;
    if (cur !== undefined) toJSON(S, cur, name); // the initial value must be shareable too
    this.shared.set(name, { doc });
    L.magic(name, () => cur, v => { const json = toJSON(S, v, name); cur = v; this.broadcast({ t: 'var', name, value: json }); }, doc || undefined);
    if (cur !== undefined) this.broadcast({ t: 'var', name, value: toJSON(S, cur, name) });
    return S.intern(name);
  }
  /* The current values, for a client that (re)connects. */
  sharedValues() {
    const { L } = this.server, S = L.S, out = [];
    for (const name of this.shared.keys()) { let v; try { v = L.get(name); } catch (e) { continue; } if (v !== undefined) { try { out.push({ name, value: toJSON(S, v, name) }); } catch (e) { /* not shareable now */ } } }
    return out;
  }

  /* ---------- managing the world (R4.20, R4.21, Q2) ---------- */
  /* A new epoch after the log changed shape: the file is rewritten under it, and every frame and web client is
     told and disconnected, so its reconnect sees welcome.imageEpoch differ and starts a fresh runtime (R7.19).
     The disconnect is deferred so the caller's result goes out first. */
  changeEpoch(reason) {
    this.epoch = randomEpoch();
    this.rewrite();
    this.server.log.info('image', { event: 'epoch', reason, epoch: this.epoch, entries: this.entries.length, gen: this.gen });
    this.scheduleRefresh();
    if (this.epochTimer) clearTimeout(this.epochTimer);
    this.epochTimer = setTimeout(() => {
      this.epochTimer = null;
      for (const c of [...this.server.clients]) if (c.hello && !c.closed && (c.kind === 'frame' || c.kind === 'web')) { c.send({ t: 'msg', text: `Image ${reason}: the frame runtime restarts`, level: 'info' }); c.destroy(); }
    }, 20);
    this.epochTimer.unref();
    return this.epoch;
  }
  overLimit() {
    return (this.entries.length > COMPACT_ENTRIES && this.entries.length >= this.autoFloor.entries) || (this.bytes > COMPACT_BYTES && this.bytes >= this.autoFloor.bytes);
  }
  /* Keep the last definition per name (R4.20); effects keyed by their text are deduplicated the same way. */
  compact({ auto = false } = {}) {
    const last = new Map();
    for (const e of this.entries) last.set(this.keyOf(e.form), e.gen);
    const before = this.entries.length;
    this.entries = this.entries.filter(e => last.get(this.keyOf(e.form)) === e.gen);
    const dropped = before - this.entries.length;
    this.changeEpoch(auto ? 'compacted automatically' : 'compacted');
    this.autoFloor = { entries: this.entries.length + Math.ceil(COMPACT_ENTRIES / 10), bytes: this.bytes + Math.ceil(COMPACT_BYTES / 10) };
    return { kept: this.entries.length, dropped, gen: this.gen, epoch: this.epoch, auto };
  }
  /* Move the log aside as image.<time>.jsonl and start fresh at generation 0. */
  reset(reason = 'reset') {
    const archived = path.join(path.dirname(this.file), `image.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    try { fs.renameSync(this.file, archived); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.entries = []; this.gen = 0;
    this.changeEpoch(reason);
    return { archived, gen: 0, epoch: this.epoch };
  }
  /* Append the live entries to <configDir>/init.scm, then reset (R4.20). Failed entries go in as comments. */
  saveToInit(configDir) {
    const file = path.join(configDir, 'init.scm');
    const lines = [`\n;;; image log saved ${stamp(Date.now())} (${this.entries.length} entries)`];
    let saved = 0;
    for (const e of this.entries) {
      lines.push(`;; gen ${e.gen}, ${stamp(e.at)}, ${originOf(e.by)}`);
      if (e.failed) { lines.push(`;; failed at replay: ${e.failed.error}`); for (const l of e.form.split('\n')) lines.push(';; ' + l); }
      else { lines.push(e.form); saved++; }
    }
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    const r = this.reset('saved to init.scm');
    return { file, saved, ...r };
  }
  /* Q2: remove one entry. A definition cannot be undone in place, so the epoch changes and every frame
     rebuilds from the log without it; the server image keeps the definition until its next start. */
  revertEntry(gen) {
    const i = this.entries.findIndex(e => e.gen === gen);
    if (i < 0) return null;
    const [e] = this.entries.splice(i, 1);
    this.changeEpoch(`entry ${gen} reverted`);
    return { gen: e.gen, form: e.form, by: e.by, epoch: this.epoch };
  }
  problems() { return this.entries.filter(e => e.failed).map(e => ({ gen: e.gen, at: e.at, by: e.by, origin: originOf(e.by), form: e.form, error: e.failed.error })); }
  list() { return this.entries.map(e => ({ gen: e.gen, at: e.at, by: e.by, origin: originOf(e.by), form: e.form, failed: e.failed ? e.failed.error : undefined })); }

  /* ---------- the *image-log* buffer (R4.20) ---------- */
  render() {
    const out = [`Image log: ${this.entries.length} entries, generation ${this.gen}, epoch ${this.epoch}`, `(${this.file})`, ''];
    for (const e of this.entries) {
      out.push(`#${e.gen}  ${stamp(e.at)}  ${originOf(e.by)}${e.failed ? '  FAILED AT REPLAY: ' + e.failed.error : ''}`);
      out.push(e.form, '');
    }
    return out.join('\n');
  }
  /* The shared buffer for the log, made on demand: Edwin's read-only special buffer, shared as name:*image-log*. */
  logBuffer(create) {
    const { Ed, buffers } = this.server;
    let sb = buffers.byId.get(LOG_BUFFER_ID);
    if (sb || !create) return sb || null;
    const ed = Ed.getBufferCreate(LOG_BUFFER); ed.mode = 'special-mode'; ed.readOnly = true;
    sb = buffers.resolve(LOG_BUFFER_ID, false);
    sb.readOnly = 'server special buffer';
    return sb;
  }
  /* Put the current rendering in the buffer as one server batch, so attached clients see it (R6.4). */
  async refresh(create = false) {
    const sb = this.logBuffer(create);
    if (!sb) return null;
    await this.server.buffers.replaceText(sb, this.render(), SERVER_BY);
    sb.savedText = sb.text; sb.savedHash = sha256(sb.savedText); // a rendering is never "modified"
    return sb;
  }
  scheduleRefresh() {
    if (this.refreshTimer || !this.server || !this.server.buffers || !this.server.buffers.byId.has(LOG_BUFFER_ID)) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh().catch(e => this.server.log.warn('image', { event: 'refresh', error: e.message })); }, 0);
  }
}

/* The server commands: (image, client or null, args) -> result. */
const needForce = (args, cmd) => { const a = args[0]; if (a === true || (a && typeof a === 'object' && a.force === true)) return; throw new ProtoError('bad_request', `${cmd} needs {force: true}: the caller confirms`); };
const COMMANDS = {
  'image-log': async (image, client) => {
    const sb = await image.refresh(true);
    if (client) client.send({ t: 'display', buf: sb.id, how: 'other-window' });
    return { value: { buf: sb.id, entries: image.entries.length, gen: image.gen }, msg: `Image log: ${image.entries.length} entries` };
  },
  'image-entries': image => ({ value: image.list() }),
  'image-problems': image => { const p = image.problems(); return { value: p, msg: p.length ? `${p.length} image entr${p.length === 1 ? 'y' : 'ies'} failed at replay` : 'Every image entry replayed' }; },
  'image-compact': image => { const r = image.compact(); return { value: r, msg: `Image compacted: ${r.dropped} superseded entr${r.dropped === 1 ? 'y' : 'ies'} dropped, ${r.kept} kept` }; },
  'image-reset': (image, client, args) => { needForce(args, 'image-reset'); const r = image.reset(); return { value: r, msg: `Image reset; the old log is ${path.basename(r.archived)}` }; },
  'image-save-to-init': (image, client, args) => { needForce(args, 'image-save-to-init'); const r = image.saveToInit(image.server.cfg.configDir); return { value: r, msg: `${r.saved} entr${r.saved === 1 ? 'y' : 'ies'} appended to ${r.file}; image reset` }; },
  'image-revert-entry': (image, client, args) => {
    const a = args[0], gen = Number.isInteger(a) ? a : (a && typeof a === 'object' && Number.isInteger(a.gen) ? a.gen : null);
    if (gen === null) throw new ProtoError('bad_request', 'image-revert-entry needs {gen}');
    const r = image.revertEntry(gen);
    if (!r) throw new ProtoError('bad_request', `no image entry with generation ${gen}`);
    return { value: r, msg: `Image entry ${gen} reverted; frames rebuild without it (the server keeps it until restart)` };
  },
};

export async function install(server) {
  const image = server.image;
  image.attach(server);
  for (const [cmd, fn] of Object.entries(COMMANDS)) server.defineCommand(cmd, (client, args) => fn(image, client, args || []));
  server.statusProviders.push(() => ({ imageGen: image.gen, imageEpoch: image.epoch, imageEntries: image.entries.length, imageBytes: image.bytes, imageProblems: image.problems().length }));
}
export async function shutdown(server) {
  const image = server.image;
  if (image.refreshTimer) { clearTimeout(image.refreshTimer); image.refreshTimer = null; }
  if (image.epochTimer) { clearTimeout(image.epochTimer); image.epochTimer = null; }
}
