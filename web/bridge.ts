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
  if (window.claude && typeof window.claude.use === 'function') return;
  const CONTRACT = '0.2.75';
  let port = null, hello = null, keys = null, seq = 0;
  const pending = new Map();   // id -> {resolve, reject, onEvent}
  const helloWaiters = [];

  const err = (code, message, extra) => Object.assign({ code, message }, extra || {});
  const sclone = v => { try { structuredClone(v); return true; } catch { return false; } };

  function send(m, transfer) { if (port) port.postMessage(m, transfer || []); }
  function call(cap, method, args, opt = {}) {
    const id = 'c' + (++seq);
    return new Promise((resolve, reject) => {
      const rec = { resolve, reject, onEvent: opt.onEvent || null, tools: opt.tools || null };
      pending.set(id, rec);
      if (opt.signal) {
        if (opt.signal.aborted) { pending.delete(id); return reject(err('cancelled', 'signal already aborted')); }
        opt.signal.addEventListener('abort', () => { if (pending.has(id)) send({ t: 'cancel', id }); }, { once: true });
      }
      send({ t: 'call', id, cap, method, args });
    });
  }
  function onMessage(ev) {
    const m = ev.data; if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') { hello = m; keys = m.keys || null; helloWaiters.splice(0).forEach(f => f(m)); return; }
    if (m.t === 'keys') { keys = m.keys || null; return; }   // the user picked another leader
    const rec = pending.get(m.id); if (!rec) return;
    if (m.t === 'ok') { pending.delete(m.id); rec.resolve(m.value); }
    else if (m.t === 'err') { pending.delete(m.id); rec.reject(m.error || err('upstream_error', 'unknown error')); }
    else if (m.t === 'ev') {
      if (m.event === 'tool') runTool(m.id, rec, m.data);
      else if (m.event === 'end') { pending.delete(m.id); }
      else rec.onEvent?.(m.event, m.data);
    }
  }
  async function runTool(id, rec, { callId, name, input }) {
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
  function waitHello() {
    if (hello) return Promise.resolve(hello);
    return new Promise(res => { helloWaiters.push(res); setTimeout(() => res(null), 10_000); });
  }

  // ---------------------------------------------------------------- handshake: ask the host for a port
  const ch = new MessageChannel();
  port = ch.port1; port.onmessage = onMessage;
  const say = () => { try { window.parent.postMessage({ claude: 'hello', contract: CONTRACT }, '*', [ch.port2]); } catch {} };
  if (window.parent !== window) say();

  // ---------------------------------------------------------------- namespaces
  const freeze = o => Object.freeze(o);

  function makeSample() {
    const sample = function (input, options) {
      const o = options == null ? {} : options;
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
        onEvent: (event, data) => { if (event === 'text' && o.onText && data.text !== last) { const delta = data.text.slice(last.length); last = data.text; try { o.onText({ text: data.text, delta }); } catch (e) { console.error(e); } } } });
    };
    sample.json = async (input, options) => {
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
      publish: arg => {
        if (typeof arg === 'string') return call('artifact', 'publish', { html: arg });
        if (arg && typeof arg === 'object') return call('artifact', 'publish', { files: arg });
        return Promise.reject(err('invalid_request', 'publish takes an html string or a files object'));
      },
    });
  }

  function makeDb() {
    const snapDoc = (path, d) => freeze({ id: path.split('/').pop(), path, exists: d != null, data: () => (d == null ? undefined : structuredClone(d)) });
    const qsnap = (docs) => { const list = docs.map(x => snapDoc(x.path, x.data)); return freeze({ docs: list, size: list.length, empty: !list.length, docChanges: () => list.map(d => ({ type: 'added', doc: d })) }); };
    const subscribe = (method, args, cb, onErr) => {
      let live = true; const id = 'c' + (++seq);
      pending.set(id, { resolve: () => {}, reject: e => { if (live && onErr) onErr(e); }, onEvent: (event, data) => {
        if (!live) return;
        if (event === 'doc') cb(snapDoc(data.path, data.data));
        else if (event === 'query') cb(qsnap(data.docs));
      } });
      send({ t: 'call', id, cap: 'db', method, args });
      return () => { live = false; pending.delete(id); send({ t: 'cancel', id }); };
    };
    const docRef = path => freeze({
      id: path.split('/').pop(), path,
      get: async () => { const d = await call('db', 'get', { path }); return snapDoc(path, d); },
      set: data => call('db', 'set', { path, data }),
      update: data => call('db', 'update', { path, data }),
      delete: () => call('db', 'delete', { path }),
      collection: sub => colRef(path + '/' + sub),
      onSnapshot: (cb, onErr) => subscribe('watchDoc', { path }, cb, onErr),
    });
    const query = (path, q) => freeze({
      where: (field, op, value) => query(path, { ...q, where: [...q.where, [field, op, value]] }),
      orderBy: (field, dir) => query(path, { ...q, orderBy: [field, dir || 'asc'] }),
      limit: n => query(path, { ...q, limit: n }),
      get: async () => qsnap(await call('db', 'query', { path, q })),
      onSnapshot: (cb, onErr) => subscribe('watchQuery', { path, q }, cb, onErr),
      doc: id => docRef(path + '/' + (id || Math.random().toString(36).slice(2, 12))),
      add: async data => { const r = docRef(path + '/' + Math.random().toString(36).slice(2, 12)); await r.set(data); return r; },
      path,
    });
    const colRef = path => query(path, { where: [], orderBy: null, limit: null });
    return freeze({ doc: docRef, collection: colRef });
  }

  function makePermissions() {
    return freeze({
      state: name => call('permissions', 'state', { name }),
      request: names => call('permissions', 'request', { names: Array.isArray(names) ? names : [names] }),
      manage: () => call('permissions', 'manage', {}),
    });
  }
  function makeDownloads() { return freeze({ save: ({ filename, data }) => call('downloads', 'save', { filename, data }) }); }
  function makeUser() {
    return freeze({ id: () => call('user', 'id', {}), me: () => call('user', 'me', {}), isOwner: () => call('user', 'isOwner', {}), canEdit: () => call('user', 'canEdit', {}),
      can: level => call('user', 'can', { level }), profiles: ids => call('user', 'profiles', { ids }), search: q => call('user', 'search', { q }) });
  }
  function makeRoom() {
    const handlers = new Map();
    pending.set('room', { resolve() {}, reject() {}, onEvent: (event, data) => { for (const h of handlers.get(data.type) || []) try { h(data.payload, data.from); } catch (e) { console.error(e); } } });
    return freeze({
      emit: (type, payload) => call('room', 'emit', { type, payload }),
      on: (type, fn) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); },
      presence: () => call('room', 'presence', {}), onPeers: fn => { handlers.set('__peers', new Set([fn])); return () => handlers.delete('__peers'); }, join: () => call('room', 'join', {}),
    });
  }
  const builders = { sample: makeSample, artifact: makeArtifact, self: makeArtifact, db: makeDb, permissions: makePermissions, downloads: makeDownloads, user: makeUser, room: makeRoom };

  const memo = new Map();
  function use(name) {
    if (typeof name !== 'string') return Promise.resolve(null);
    if (memo.has(name)) return memo.get(name);
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
  const leaderOf = e => e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey ? '<f1>'
    : (e.code === 'Space' || e.key === ' ') && e.ctrlKey && !e.metaKey && !e.shiftKey ? (e.altKey ? 'C-M-SPC' : 'C-SPC') : null;
  window.addEventListener('keydown', e => {
    const want = keys && keys.leader;
    if (want && leaderOf(e) === want) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) send({ t: 'key', key: 'leader' }); }   // a held leader is one press
  }, true);
  window.addEventListener('message', ev => { if (ev.data && ev.data.claude === 'ping') say(); });
})();
