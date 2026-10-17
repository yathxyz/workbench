/* claude.js: the page side of the Workbench artifact bridge.
 *
 * Injected first into every artifact page the Workbench hosts. Defines the one entry point the runtime
 * contract (0.2.75) promises, `window.claude.use(name)`, and talks to the host page over a MessageChannel.
 * Nothing here knows about the daemon: the host decides which capabilities are served and answers each call.
 *
 * Wire protocol (page -> host over the port):
 *   {t:'call', id, cap, method, args}         one request; answered by {t:'ok', id, value} or {t:'err', id, error}
 *   {t:'ev', id, event, data}   (host -> page) a streamed event for a live call: text, snapshot, peers, tool
 *   {t:'tool_result'|'tool_error', id, callId, result|message}   the page answering a tool round-trip
 *   {t:'cancel', id}                           the page's AbortSignal fired
 *   {t:'key', key:'leader'}                    the board's leader key was pressed in the page (hello.keys.leader names it)
 *   {t:'keys', keys:{leader}}   (host -> page) the leader changed; hello.keys is the first one
 * The host opens with {t:'hello', contract, served:[names]} on the port; without it use() resolves null after 10 s.
 */
(() => {
  'use strict';
  // ---- types (the page's side of the wire; the host's side is ArtHostMsg/ArtPageMsg in board.d.ts)
  interface BridgeKeys { leader?: string }
  interface BridgeError { code: string; message: string; [extra: string]: unknown }
  /* Host to page, over the port. */
  type BridgeHostMsg =
    | { t: 'hello'; contract: string; served?: string[]; keys?: BridgeKeys | null }
    | { t: 'keys'; keys?: BridgeKeys | null }
    | { t: 'ok'; id: string; value: unknown }
    | { t: 'err'; id: string; error?: BridgeError }
    | { t: 'ev'; id: string; event: string; data: unknown };
  type BridgeHello = Extract<BridgeHostMsg, { t: 'hello' }>;
  /* Page to host, over the port. */
  type BridgePageMsg =
    | { t: 'call'; id: string; cap: string; method: string; args: unknown }
    | { t: 'cancel'; id: string }
    | { t: 'key'; key: 'leader' }
    | { t: 'tool_result'; id: string; callId: string; result: string }
    | { t: 'tool_error'; id: string; callId: string; message: string };
  type BridgeOnEvent = (event: string, data: any) => void; // any: each call's events carry their own shapes, read by its handler
  /* A tool the page lends sample(): the model calls it through the host. */
  type BridgeToolValue = string | number | boolean | object | null | undefined;
  interface BridgeTool { name: string; description: string; inputSchema?: unknown; execute(input: unknown, ctx: { signal: AbortSignal }): BridgeToolValue | Promise<BridgeToolValue> }
  interface BridgeToolCall { callId: string; name: string; input?: unknown }
  /* A live call: its promise and its event handler. */
  interface BridgePending { resolve(value: unknown): void; reject(error: unknown): void; onEvent: BridgeOnEvent | null; tools?: BridgeTool[] | null }
  interface BridgeCallOpts { signal?: AbortSignal; onEvent?: BridgeOnEvent; tools?: BridgeTool[] | null }
  type BridgeSampleInput = string | unknown[];
  interface BridgeSampleOptions {
    signal?: AbortSignal; onText?: (t: { text: string; delta: string }) => void; tools?: BridgeTool[]; images?: Blob[];
    modelTier?: string; model?: string; effort?: string; cache?: unknown;
  }
  interface BridgeSampleResult { text: string }
  interface BridgeDocSnapshot { id: string | undefined; path: string; exists: boolean; data(): unknown }
  interface BridgeQuerySnapshot { docs: BridgeDocSnapshot[]; size: number; empty: boolean; docChanges(): { type: string; doc: BridgeDocSnapshot }[] }
  type BridgeSnapshotListener = (snap: BridgeDocSnapshot | BridgeQuerySnapshot) => void;
  interface BridgeDocWire { path: string; data: unknown }
  /* A db event: doc carries path and data, query carries docs. */
  interface BridgeDbEvent { path: string; data: unknown; docs: BridgeDocWire[] }
  interface BridgeQueryState { where: [string, string, unknown][]; orderBy: [string, string] | null; limit: number | null }
  interface BridgeDocRef {
    id: string | undefined; path: string;
    get(): Promise<BridgeDocSnapshot>; set(data: unknown): Promise<unknown>; update(data: unknown): Promise<unknown>; delete(): Promise<unknown>;
    collection(sub: string): BridgeQuery;
    onSnapshot(cb: (snap: BridgeDocSnapshot) => void, onErr?: (e: unknown) => void): () => void;
  }
  interface BridgeQuery {
    where(field: string, op: string, value: unknown): BridgeQuery; orderBy(field: string, dir?: string): BridgeQuery; limit(n: number): BridgeQuery;
    get(): Promise<BridgeQuerySnapshot>;
    onSnapshot(cb: (snap: BridgeQuerySnapshot) => void, onErr?: (e: unknown) => void): () => void;
    doc(id?: string): BridgeDocRef; add(data: unknown): Promise<BridgeDocRef>; path: string;
  }
  type BridgeRoomHandler = (payload: unknown, from: unknown) => void;
  interface BridgeRoomEvent { type: string; payload: unknown; from: unknown }
  if (window.claude && typeof window.claude.use === 'function') return;
  const CONTRACT = '0.2.75';
  let port: MessagePort | null = null, hello: BridgeHello | null = null, keys: BridgeKeys | null = null, seq = 0;
  const pending = new Map<string, BridgePending>();   // id -> {resolve, reject, onEvent}
  const helloWaiters: ((h: BridgeHello | null) => void)[] = [];

  const err = (code: string, message: string, extra?: Record<string, unknown>): BridgeError => Object.assign({ code, message }, extra || {});
  const sclone = (v: unknown) => { try { structuredClone(v); return true; } catch { return false; } };

  function send(m: BridgePageMsg, transfer?: Transferable[]) { if (port) port.postMessage(m, transfer || []); }
  function call<T = unknown>(cap: string, method: string, args: unknown, opt: BridgeCallOpts = {}): Promise<T> {
    const id = 'c' + (++seq);
    return new Promise((resolve, reject) => {
      const rec: BridgePending = { resolve, reject, onEvent: opt.onEvent || null, tools: opt.tools || null };
      pending.set(id, rec);
      if (opt.signal) {
        if (opt.signal.aborted) { pending.delete(id); return reject(err('cancelled', 'signal already aborted')); }
        opt.signal.addEventListener('abort', () => { if (pending.has(id)) send({ t: 'cancel', id }); }, { once: true });
      }
      send({ t: 'call', id, cap, method, args });
    });
  }
  function onMessage(ev: MessageEvent) {
    const m = ev.data as BridgeHostMsg | null; if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') { hello = m; keys = m.keys || null; helloWaiters.splice(0).forEach(f => f(m)); return; }
    if (m.t === 'keys') { keys = m.keys || null; return; }   // the user picked another leader
    const rec = pending.get(m.id); if (!rec) return;
    if (m.t === 'ok') { pending.delete(m.id); rec.resolve(m.value); }
    else if (m.t === 'err') { pending.delete(m.id); rec.reject(m.error || err('upstream_error', 'unknown error')); }
    else if (m.t === 'ev') {
      if (m.event === 'tool') runTool(m.id, rec, m.data as BridgeToolCall);
      else if (m.event === 'end') { pending.delete(m.id); }
      else rec.onEvent?.(m.event, m.data);
    }
  }
  async function runTool(id: string, rec: BridgePending, { callId, name, input }: BridgeToolCall) {
    const tool = rec.tools?.find(t => t.name === name);
    if (!tool) return send({ t: 'tool_error', id, callId, message: 'no such tool ' + name });
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 150_000);
    try {
      let r = await tool.execute(input || {}, { signal: ctl.signal });
      if (r !== undefined && typeof r !== 'string') r = JSON.stringify(r);
      if (r && r.length > 32_768) r = r.slice(0, 32_768);
      send({ t: 'tool_result', id, callId, result: r ?? '' });
    } catch (e) { send({ t: 'tool_error', id, callId, message: String(e?.message || e) }); }
    finally { clearTimeout(timer); }
  }
  function waitHello(): Promise<BridgeHello | null> {
    if (hello) return Promise.resolve(hello);
    return new Promise(res => { helloWaiters.push(res); setTimeout(() => res(null), 10_000); });
  }

  // ---------------------------------------------------------------- handshake: ask the host for a port
  const ch = new MessageChannel();
  port = ch.port1; port.onmessage = onMessage;
  const say = () => { try { window.parent.postMessage({ claude: 'hello', contract: CONTRACT }, '*', [ch.port2]); } catch {} };
  if (window.parent !== window) say();

  // ---------------------------------------------------------------- namespaces
  const freeze = <T,>(o: T): T => Object.freeze(o);

  function makeSample() {
    const sample = function (input: BridgeSampleInput, options?: BridgeSampleOptions | null): Promise<BridgeSampleResult> {
      const o: BridgeSampleOptions = options == null ? {} : options;
      if (o && (typeof o !== 'object' || Array.isArray(o))) return Promise.reject(err('invalid_request', 'options must be a plain object'));
      if (typeof input !== 'string' && !Array.isArray(input)) return Promise.reject(err('invalid_request', 'input must be a string or a turn list'));
      if (o.signal && !(o.signal instanceof AbortSignal)) return Promise.reject(err('invalid_request', 'signal must be an AbortSignal (pass ctl.signal)'));
      if (o.onText && typeof o.onText !== 'function') return Promise.reject(err('invalid_request', 'onText must be a function'));
      const tools = Array.isArray(o.tools) ? o.tools : null;
      if (o.tools && !tools) return Promise.reject(err('invalid_request', 'tools must be an array'));
      for (const t of tools || []) if (!t || typeof t.name !== 'string' || typeof t.description !== 'string' || typeof t.execute !== 'function')
        return Promise.reject(err('invalid_request', 'each tool needs name, description and execute'));
      const images = Array.isArray(o.images) ? o.images : undefined;
      if (images && !images.every(b => b instanceof Blob)) return Promise.reject(err('invalid_request', 'images must be Blobs'));
      const args = { input, modelTier: o.modelTier, model: o.model, effort: o.effort, cache: o.cache, images,
        tools: tools ? tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : undefined };
      if (!sclone(args)) return Promise.reject(err('invalid_request', 'arguments must be structured-cloneable'));
      let last = '';
      return call('sample', 'sample', args, { signal: o.signal, tools,
        onEvent: (event, data: { text: string }) => { if (event === 'text' && o.onText && data.text !== last) { const delta = data.text.slice(last.length); last = data.text; try { o.onText({ text: data.text, delta }); } catch (e) { console.error(e); } } } });
    };
    sample.json = async (input: BridgeSampleInput, options?: BridgeSampleOptions | null): Promise<unknown> => {
      const r = await sample(input, options);
      const text = r.text;
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      let body = fence ? fence[1] : text;
      const i = Math.min(...['{', '['].map(c => body.indexOf(c)).filter(k => k >= 0));
      if (!Number.isFinite(i)) throw err('invalid_json', 'no JSON value in the reply', { text });
      body = body.slice(i); const j = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
      try { return JSON.parse(body.slice(0, j + 1)); } catch { throw err('invalid_json', 'the reply held no parseable JSON', { text }); }
    };
    sample.limits = () => call('sample', 'limits', {});
    return freeze(sample);
  }

  function makeArtifact() {
    return freeze({
      publish: (arg: string | Record<string, unknown>) => {
        if (typeof arg === 'string') return call('artifact', 'publish', { html: arg });
        if (arg && typeof arg === 'object') return call('artifact', 'publish', { files: arg });
        return Promise.reject(err('invalid_request', 'publish takes an html string or a files object'));
      },
    });
  }

  function makeDb() {
    const snapDoc = (path: string, d: unknown): BridgeDocSnapshot => freeze({ id: path.split('/').pop(), path, exists: d != null, data: () => (d == null ? undefined : structuredClone(d)) });
    const qsnap = (docs: BridgeDocWire[]): BridgeQuerySnapshot => { const list = docs.map(x => snapDoc(x.path, x.data)); return freeze({ docs: list, size: list.length, empty: !list.length, docChanges: () => list.map(d => ({ type: 'added', doc: d })) }); };
    const subscribe = (method: string, args: unknown, cb: BridgeSnapshotListener, onErr?: (e: unknown) => void) => {
      let live = true; const id = 'c' + (++seq);
      pending.set(id, { resolve: () => {}, reject: e => { if (live && onErr) onErr(e); }, onEvent: (event, data: BridgeDbEvent) => {
        if (!live) return;
        if (event === 'doc') cb(snapDoc(data.path, data.data));
        else if (event === 'query') cb(qsnap(data.docs));
      } });
      send({ t: 'call', id, cap: 'db', method, args });
      return () => { live = false; pending.delete(id); send({ t: 'cancel', id }); };
    };
    const docRef = (path: string): BridgeDocRef => freeze({
      id: path.split('/').pop(), path,
      get: async () => { const d = await call('db', 'get', { path }); return snapDoc(path, d); },
      set: data => call('db', 'set', { path, data }),
      update: data => call('db', 'update', { path, data }),
      delete: () => call('db', 'delete', { path }),
      collection: sub => colRef(path + '/' + sub),
      onSnapshot: (cb, onErr) => subscribe('watchDoc', { path }, cb as BridgeSnapshotListener, onErr),
    });
    const query = (path: string, q: BridgeQueryState): BridgeQuery => freeze({
      where: (field, op, value) => query(path, { ...q, where: [...q.where, [field, op, value]] }),
      orderBy: (field, dir) => query(path, { ...q, orderBy: [field, dir || 'asc'] }),
      limit: n => query(path, { ...q, limit: n }),
      get: async () => qsnap(await call<BridgeDocWire[]>('db', 'query', { path, q })),
      onSnapshot: (cb, onErr) => subscribe('watchQuery', { path, q }, cb as BridgeSnapshotListener, onErr),
      doc: id => docRef(path + '/' + (id || Math.random().toString(36).slice(2, 12))),
      add: async data => { const r = docRef(path + '/' + Math.random().toString(36).slice(2, 12)); await r.set(data); return r; },
      path,
    });
    const colRef = (path: string): BridgeQuery => query(path, { where: [], orderBy: null, limit: null });
    return freeze({ doc: docRef, collection: colRef });
  }

  function makePermissions() {
    return freeze({
      state: (name: string) => call('permissions', 'state', { name }),
      request: (names: string | string[]) => call('permissions', 'request', { names: Array.isArray(names) ? names : [names] }),
      manage: () => call('permissions', 'manage', {}),
    });
  }
  function makeDownloads() { return freeze({ save: ({ filename, data }: { filename: string; data: unknown }) => call('downloads', 'save', { filename, data }) }); }
  function makeUser() {
    return freeze({ id: () => call('user', 'id', {}), me: () => call('user', 'me', {}), isOwner: () => call('user', 'isOwner', {}), canEdit: () => call('user', 'canEdit', {}),
      can: (level: string) => call('user', 'can', { level }), profiles: (ids: string[]) => call('user', 'profiles', { ids }), search: (q: string) => call('user', 'search', { q }) });
  }
  function makeRoom() {
    const handlers = new Map<string, Set<BridgeRoomHandler>>();
    pending.set('room', { resolve() {}, reject() {}, onEvent: (event, data: BridgeRoomEvent) => { for (const h of handlers.get(data.type) || []) try { h(data.payload, data.from); } catch (e) { console.error(e); } } });
    return freeze({
      emit: (type: string, payload: unknown) => call('room', 'emit', { type, payload }),
      on: (type: string, fn: BridgeRoomHandler) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn); return () => handlers.get(type)!.delete(fn); },
      presence: () => call('room', 'presence', {}), onPeers: (fn: BridgeRoomHandler) => { handlers.set('__peers', new Set([fn])); return () => handlers.delete('__peers'); }, join: () => call('room', 'join', {}),
    });
  }
  const builders: Record<string, () => unknown> = { sample: makeSample, artifact: makeArtifact, self: makeArtifact, db: makeDb, permissions: makePermissions, downloads: makeDownloads, user: makeUser, room: makeRoom };

  const memo = new Map<string, Promise<unknown>>();
  function use(name: string): Promise<unknown> {
    if (typeof name !== 'string') return Promise.resolve(null);
    if (memo.has(name)) return memo.get(name)!;
    const p = (async () => {
      await new Promise(r => setTimeout(r, 0));  // never synchronous
      const h = await waitHello(); if (!h) return null;
      const served = new Set(h.served || []);
      if (!served.has(name) && !(name === 'self' && served.has('artifact')) && name !== 'permissions') return null;
      const b = builders[name]; return b ? b() : null;
    })();
    memo.set(name, p); return p;
  }
  window.claude = freeze({ use });
  // The board's leader key goes back to the board (hello.keys.leader, Edwin notation): keys typed in this frame never
  // reach the host page, so without this the keyboard could not leave an artifact (Workbench DESIGN §6.4, K3).
  const leaderOf = (e: KeyboardEvent) => e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey ? '<f1>'
    : (e.code === 'Space' || e.key === ' ') && e.ctrlKey && !e.metaKey && !e.shiftKey ? (e.altKey ? 'C-M-SPC' : 'C-SPC') : null;
  window.addEventListener('keydown', e => {
    const want = keys && keys.leader;
    if (want && leaderOf(e) === want) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) send({ t: 'key', key: 'leader' }); }   // a held leader is one press
  }, true);
  window.addEventListener('message', ev => { if (ev.data && ev.data.claude === 'ping') say(); });
})();
