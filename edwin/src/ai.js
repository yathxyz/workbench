/* gptel for Edwin: chat with a language model from an Org buffer, one-shot answers and rewrites in
   any buffer, through a provider-agnostic backend layer. The first backend is the artifact's Claude
   'sample' capability; OpenAI-compatible servers (OpenRouter, xAI, Groq, Mistral, Ollama, llama.cpp),
   the Anthropic Messages API and a Claude connector reached through the artifact's 'mcp' capability
   are the others. Every backend takes one neutral request shape and runs the whole tool loop inside,
   so the chat code never sees provider details. The Scheme API is documented at the top of ai.scm. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, truthy, listOf, arr, NIL, Sym } = L;
const { D, CMD } = L;
const cur = () => E.current;
const { bol, eol } = Ed;
const str = x => { if (typeof x !== 'string') signal('wrong-type-argument', 'expected a string, got', x); return x; };
const KEY_PFX = 'gptel/keys/';          // where older versions kept keys, as files (migrated at load)
const SECRET_PFX = 'lmacs:secret:gptel/'; // storage prefix outside the file namespace
const SANDBOX = 'blocked by the artifact sandbox: run Edwin from your own host, or use an mcp backend';

L.defvar('gptel-backend', 'Claude', 'Name of the backend gptel-send uses (see gptel-backends).');
L.defvar('gptel-model', false, 'Model for gptel-backend, or #f for the preset’s choice. A tier name (quick, default, complex) is accepted for Claude.');
L.defvar('gptel-fallback-backends', NIL, 'Backend names tried in order when the current one is exhausted (rate limited, out of usage) or unavailable (down, overloaded, not usable in this view).');
L.defvar('gptel-preset', 'default', 'Name of the active preset (see gptel-presets).');
L.defvar('gptel-effort', false, 'Thinking effort for Claude backends: "low", "medium", "high" or #f.');
L.defvar('gptel-system-prompt', 'Short, direct answers. Skip extra context unless it changes correctness.', 'The default system prompt.');
L.defvar('gptel-chat-directory', 'roam/chats/', 'Prefix of the files gptel chats are saved in.');
L.defvar('gptel-memory-file', 'roam/chats/memory.org', 'Long-term notes sent as context with every assistant request.');
L.defvar('gptel-max-rounds', 8, 'Most tool rounds one request may make.');

/* ---------- errors: one shape for every provider ---------- */
class AIError extends Error {
  constructor(code, message, opts) { super(message); this.code = code; this.exhausted = !!(opts && opts.exhausted); this.transient = !!(opts && opts.transient); this.text = opts && opts.text || ''; this.status = opts && opts.status; }
}
const cancelled = text => new AIError('cancelled', 'Aborted', { text });
const isAbort = e => e && (e.name === 'AbortError' || e.code === 'cancelled');
const QUOTA_RE = /quota|credit|billing|balance|limit|exhaust|usage|insufficient/i;
/* Classify an HTTP failure: 429, and 402/403 with a quota message, are exhaustion; 5xx (529 overloaded
   included) and 408 mean the backend is down for now. Both are worth a fallback. */
function httpError(status, bodyText, url) {
  let msg = bodyText;
  try { const j = JSON.parse(bodyText); msg = (j.error && (j.error.message || j.error.type)) || j.message || j.detail || bodyText; } catch (e) { /* plain text */ }
  msg = String(msg || '').replace(/\s+/g, ' ').slice(0, 300);
  const exhausted = status === 429 || ((status === 402 || status === 403) && QUOTA_RE.test(msg));
  const hint = status === 401 ? ' (set a key with M-x gptel-set-api-key)' : '';
  return new AIError(exhausted ? 'rate_limited' : 'http', `HTTP ${status} from ${hostOf(url)}: ${msg}${hint}`, { exhausted, status, transient: status >= 500 || status === 408 });
}
const hostOf = url => { try { return new URL(url).host; } catch (e) { return url; } };
/* An error event inside a stream: overloaded or server-side errors are transient. */
const streamError = (name, err) => new AIError('http', `${name}: ${err && err.message || (err ? JSON.stringify(err) : 'error')}`, { transient: /overload|server|api_error|unavailable|timeout/i.test(String(err && (err.type || err.code) || '')) });

/* ---------- the artifact runtime: window.claude and its capabilities ---------- */
const hasClaude = () => typeof claude !== 'undefined' && claude && typeof claude.use === 'function';
const caps = new Map();
function useCap(name) {
  if (!hasClaude()) return Promise.resolve(null);
  if (!caps.has(name)) caps.set(name, Promise.resolve().then(() => claude.use(name)).catch(() => null));
  return caps.get(name);
}
/* Hosts the page's CSP refused: the definitive sign of the sandbox. */
const cspBlocked = new Set();
Ed.host.onCspViolation(e => { if (e.blockedURI) cspBlocked.add(hostOf(e.blockedURI)); });

/* ---------- API keys: never in init.scm, never files ---------- */
/* Keys live under their own storage prefix, not in Ed.Store: the Store is the file namespace that
   grep, find-file, recent files and project search list, and the model's grep tool reads it. */
const secretMem = new Map();
function getKey(name) {
  try { const v = Ed.host.storage.get(SECRET_PFX + name); if (v !== null) return v; } catch (e) { /* no storage */ }
  return secretMem.has(name) ? secretMem.get(name) : null;
}
function setKey(name, key) {
  if (key) { secretMem.set(name, key); try { Ed.host.storage.set(SECRET_PFX + name, key); } catch (e) { /* memory only */ } }
  else { secretMem.delete(name); try { Ed.host.storage.remove(SECRET_PFX + name); } catch (e) { /* memory only */ } }
}
/* Move keys saved as gptel/keys/<backend> files by older versions out of the file Store. */
function migrateKeys() {
  for (const n of Ed.Store.list()) if (n.startsWith(KEY_PFX)) { const v = Ed.Store.get(n); if (v && !getKey(n.slice(KEY_PFX.length))) setKey(n.slice(KEY_PFX.length), v); Ed.Store.del(n); }
}
try { migrateKeys(); } catch (e) { console.error(e); }
/* :key may be a string, a procedure returning a string, or 'store (the stored key). Absent means stored. */
function keyOf(b) {
  const k = b.key;
  if (typeof k === 'function') { const v = L.apply(k, []); return typeof v === 'string' && v ? v : null; }
  if (typeof k === 'string' && k !== 'store') return k;
  return getKey(b.name);
}

/* ---------- helpers shared by the HTTP backends ---------- */
const joinRounds = (a, b) => a && b ? a + '\n\n' + b : a || b;
async function doFetch(b, url, headers, body, signal) {
  let resp;
  try { resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, mode: 'cors' }); }
  catch (e) {
    if (isAbort(e)) throw cancelled();
    if (hasClaude() || cspBlocked.has(hostOf(url))) { b._avail = SANDBOX; throw new AIError('blocked', SANDBOX); }
    throw new AIError('network', `cannot reach ${hostOf(url)}: ${e.message}`, { transient: true });
  }
  if (!resp.ok) { let t = ''; try { t = await resp.text(); } catch (e) { /* empty */ } throw httpError(resp.status, t, url); }
  return resp;
}
/* Read a text/event-stream body, calling onData with each non-empty data: payload (except [DONE]). */
async function readSSE(resp, onData) {
  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const line = l => { l = l.replace(/\r$/, ''); if (l.startsWith('data:')) { const d = l.slice(5).trim(); if (d && d !== '[DONE]') onData(d); } };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) { line(buf.slice(0, k)); buf = buf.slice(k + 1); }
    }
    if (buf) line(buf);
  } catch (e) { if (isAbort(e)) throw cancelled(); throw e; }
}
const parseJSON = s => { try { return JSON.parse(s); } catch (e) { return null; } };
/* Run one page tool for a provider: the result is a string (an error becomes "Error: ..." so the model carries on). */
async function runTool(tools, name, input, signal) {
  const t = (tools || []).find(x => x.name === name);
  if (!t) return `Error: unknown tool ${name}`;
  if (typeof input === 'string') input = input.trim() ? parseJSON(input) : {};
  if (!input || typeof input !== 'object') return 'Error: tool input is not a JSON object';
  try {
    const r = await t.execute(input, { signal });
    const s = typeof r === 'string' ? r : JSON.stringify(r === undefined ? null : r);
    return s.length > 32000 ? s.slice(0, 32000) + '\n[truncated]' : s;
  } catch (e) { return 'Error: ' + (e && e.message || String(e)); }
}
/* Probe the endpoint once per session: any HTTP answer means reachable; a TypeError inside the
   artifact means the page's CSP refused the host. Outside the artifact a failed probe does not block
   (CORS on HEAD differs from POST at some providers): the real request reports its own error. */
function probeAvailable(b, url) {
  if (b._avail !== undefined) return b._avail;
  if (cspBlocked.has(hostOf(url))) return (b._avail = SANDBOX);
  b._avail = (async () => {
    try { await fetch(url, { method: 'HEAD', mode: 'cors', signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined }); return true; }
    catch (e) { if (hasClaude() || cspBlocked.has(hostOf(url))) return SANDBOX; return true; }
  })().then(v => (b._avail = v));
  return b._avail;
}

/* ---------- backends ---------- */
const backends = {};
function register(b) { backends[b.name] = b; return b.name; }

/* Sample codes that mean "not usable here or right now" (sample.d.ts): another backend may answer. */
const SAMPLE_TRANSIENT = new Set(['tools_unavailable', 'capability_disabled', 'capability_removed', 'not_declared', 'upstream_error']);
/* Claude through the artifact's sample capability: no system role, so instructions go in a leading
   user turn; page tools pass straight through; the tier comes from the preset or gptel-model. */
function makeClaude(o) {
  const b = {
    name: o.name || 'Claude', kind: 'claude', models: ['default', 'quick', 'complex'],
    async available() {
      if (!hasClaude()) return 'Claude is available in the published artifact only';
      if (!(await useCap('sample'))) return 'Claude sampling is not available in this view';
      return true;
    },
    async stream(req, { onText, signal }) {
      const sample = await useCap('sample');
      if (!sample) throw new AIError('unavailable', 'Claude sampling is not available in this view');
      const sys = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const turns = [];
      if (sys) turns.push({ role: 'user', content: 'Instructions:\n' + sys });
      for (const m of req.messages) if (m.role === 'user' || m.role === 'assistant') turns.push({ role: m.role, content: m.content });
      if (!turns.length || turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: 'Continue.' });
      const opts = { signal, cache: false, onText: u => onText(u.text) };
      const tier = ['quick', 'default', 'complex'].includes(req.model) ? req.model : req.modelTier || 'default';
      opts.modelTier = tier;
      if (req.model && req.model !== tier) opts.model = req.model;
      if (req.effort) opts.effort = req.effort;
      if (req.tools && req.tools.length) opts.tools = req.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: (input, ctx) => t.execute(input, ctx) }));
      try {
        const r = await sample(turns, opts);
        return { text: r.text, truncated: !!r.truncated, tier: r.modelTierApplied };
      } catch (e) {
        if (!e || e.code === undefined) throw e;
        if (e.code === 'cancelled') throw cancelled(e.text);
        const exhausted = e.code === 'rate_limited' || e.code === 'not_granted' || e.code === 'sampling_disabled';
        throw new AIError(e.code, `Claude: ${e.message || e.code}`, { exhausted, transient: SAMPLE_TRANSIENT.has(e.code), text: e.text });
      }
    },
  };
  return register(b);
}

/* OpenAI chat completions over fetch, with SSE streaming and the function-calling loop. Also
   covers xAI, OpenRouter, Groq, Mistral, Ollama and llama.cpp. */
function makeOpenAI(o) {
  const host = o.host || 'api.openai.com', endpoint = o.endpoint || '/v1/chat/completions';
  const url = /^https?:\/\//.test(host) ? host + endpoint : `${o.protocol || 'https'}://${host}${endpoint}`;
  const b = {
    name: o.name, kind: 'openai', models: o.models || [], key: o.key, url, streamOn: o.stream !== false, headers: o.headers || {},
    available() { return probeAvailable(b, url); },
    async stream(req, { onText, signal }) {
      const key = keyOf(b);
      const headers = { 'content-type': 'application/json', ...b.headers };
      if (key) headers.authorization = 'Bearer ' + key;
      const msgs = [];
      for (const m of req.messages) if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') msgs.push({ role: m.role, content: m.content });
      const tools = req.tools && req.tools.length ? req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } } })) : undefined;
      /* OpenAI reasoning models (o-series, gpt-5 except -chat) take only the default temperature, and
         api.openai.com wants max_completion_tokens (max_tokens is refused by those models). Other
         compatible servers, and routed names like openai/gpt-5.5, keep max_tokens. */
      const bare = String(req.model || '').replace(/^.*\//, ''), reasoning = /^(o\d|gpt-5)/i.test(bare) && !/-chat/i.test(bare);
      const tokensParam = hostOf(url) === 'api.openai.com' || (reasoning && bare === req.model) ? 'max_completion_tokens' : 'max_tokens';
      let text = '', usage;
      const maxRounds = req.maxRounds || 8;
      for (let round = 0; round < maxRounds; round++) {
        const body = { model: req.model, messages: msgs, stream: b.streamOn };
        if (tools) body.tools = tools;
        if (req.maxTokens) body[tokensParam] = req.maxTokens;
        if (typeof req.temperature === 'number' && !reasoning) body.temperature = req.temperature;
        const resp = await doFetch(b, url, headers, body, signal);
        let content = '', finish = null;
        const calls = [];
        if (b.streamOn && /text\/event-stream/.test(resp.headers.get('content-type') || '')) {
          await readSSE(resp, d => {
            const j = parseJSON(d); if (!j) return;
            if (j.error) throw streamError(b.name, j.error);
            if (j.usage) usage = j.usage;
            const ch = j.choices && j.choices[0]; if (!ch) return;
            if (ch.finish_reason) finish = ch.finish_reason;
            const delta = ch.delta || ch.message || {};
            if (typeof delta.content === 'string' && delta.content) { content += delta.content; onText(joinRounds(text, content)); }
            for (const tc of delta.tool_calls || []) {
              const i = typeof tc.index === 'number' ? tc.index : calls.length;
              const c = calls[i] || (calls[i] = { id: '', name: '', args: '' });
              if (tc.id) c.id += tc.id;
              if (tc.function) { if (tc.function.name) c.name += tc.function.name; if (tc.function.arguments) c.args += tc.function.arguments; }
            }
          });
        } else {
          const j = parseJSON(await resp.text());
          if (!j) throw new AIError('http', `${b.name}: unreadable answer`);
          if (j.error) throw new AIError('http', `${b.name}: ${j.error.message || JSON.stringify(j.error)}`);
          usage = j.usage;
          finish = j.choices && j.choices[0] && j.choices[0].finish_reason || null;
          const m = j.choices && j.choices[0] && j.choices[0].message || {};
          if (typeof m.content === 'string') { content = m.content; onText(joinRounds(text, content)); }
          for (const tc of m.tool_calls || []) calls.push({ id: tc.id || '', name: tc.function && tc.function.name || '', args: tc.function && tc.function.arguments || '' });
        }
        text = joinRounds(text, content);
        const live = calls.filter(Boolean);
        if (!live.length) return { text, usage, truncated: finish === 'length' };
        msgs.push({ role: 'assistant', content: content || null, tool_calls: live.map((c, i) => ({ id: c.id || 'call_' + i, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
        for (let i = 0; i < live.length; i++) {
          if (signal && signal.aborted) throw cancelled(text);
          const r = await runTool(req.tools, live[i].name, live[i].args, signal);
          msgs.push({ role: 'tool', tool_call_id: live[i].id || 'call_' + i, content: r });
        }
      }
      /* Still asking for tools after the last allowed round: say so instead of passing this off as the answer. */
      return { text, usage, truncated: true, rounds: maxRounds };
    },
  };
  return register(b);
}

/* The Anthropic Messages API: x-api-key, SSE content_block events, and the tool_use / tool_result loop. */
function makeAnthropic(o) {
  const host = o.host || 'api.anthropic.com', endpoint = o.endpoint || '/v1/messages';
  const url = /^https?:\/\//.test(host) ? host + endpoint : `${o.protocol || 'https'}://${host}${endpoint}`;
  const b = {
    name: o.name, kind: 'anthropic', models: o.models || ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], key: o.key, url, streamOn: o.stream !== false, headers: o.headers || {},
    available() { return probeAvailable(b, url); },
    async stream(req, { onText, signal }) {
      const key = keyOf(b);
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...b.headers };
      if (key) headers['x-api-key'] = key;
      const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const msgs = [];
      for (const m of req.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const last = msgs[msgs.length - 1];
        if (last && last.role === m.role && typeof last.content === 'string') last.content += '\n\n' + m.content;
        else msgs.push({ role: m.role, content: m.content });
      }
      if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: 'Continue.' });
      const tools = req.tools && req.tools.length ? req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } })) : undefined;
      let text = '', usage;
      const maxRounds = req.maxRounds || 8;
      for (let round = 0; round < maxRounds; round++) {
        const body = { model: req.model, max_tokens: req.maxTokens || 4096, messages: msgs, stream: b.streamOn };
        if (system) body.system = system;
        if (tools) body.tools = tools;
        if (req.effort) body.output_config = { effort: req.effort };
        const resp = await doFetch(b, url, headers, body, signal);
        const blocks = [];
        let content = '', stop = null;
        const addText = s => { if (!s) return; content += s; onText(joinRounds(text, content)); };
        if (b.streamOn && /text\/event-stream/.test(resp.headers.get('content-type') || '')) {
          await readSSE(resp, d => {
            const j = parseJSON(d); if (!j) return;
            switch (j.type) {
              case 'content_block_start': blocks[j.index] = { type: j.content_block.type, id: j.content_block.id, name: j.content_block.name, text: j.content_block.text || '', json: '' }; break;
              case 'content_block_delta': {
                const bl = blocks[j.index] || (blocks[j.index] = { type: 'text', text: '', json: '' });
                if (j.delta.type === 'text_delta') { bl.text += j.delta.text; addText(j.delta.text); }
                else if (j.delta.type === 'input_json_delta') bl.json += j.delta.partial_json;
                break;
              }
              case 'message_delta': if (j.delta && j.delta.stop_reason) stop = j.delta.stop_reason; if (j.usage) usage = j.usage; break;
              case 'error': throw streamError(b.name, j.error);
              default: break;
            }
          });
        } else {
          const j = parseJSON(await resp.text());
          if (!j) throw new AIError('http', `${b.name}: unreadable answer`);
          if (j.type === 'error') throw new AIError('http', `${b.name}: ${j.error && j.error.message || 'error'}`);
          stop = j.stop_reason; usage = j.usage;
          for (const c of j.content || []) {
            if (c.type === 'text') { blocks.push({ type: 'text', text: c.text }); addText(c.text); }
            else if (c.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, json: JSON.stringify(c.input || {}) });
          }
        }
        text = joinRounds(text, content);
        const uses = blocks.filter(x => x && x.type === 'tool_use');
        if (!uses.length || stop !== 'tool_use') return { text, usage, truncated: stop === 'max_tokens' };
        const assistant = [];
        for (const x of blocks) {
          if (!x) continue;
          if (x.type === 'text' && x.text) assistant.push({ type: 'text', text: x.text });
          else if (x.type === 'tool_use') assistant.push({ type: 'tool_use', id: x.id, name: x.name, input: parseJSON(x.json || '{}') || {} });
        }
        msgs.push({ role: 'assistant', content: assistant });
        const results = [];
        for (const u of uses) {
          if (signal && signal.aborted) throw cancelled(text);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(req.tools, u.name, parseJSON(u.json || '{}') || {}, signal) });
        }
        msgs.push({ role: 'user', content: results });
      }
      return { text, usage, truncated: true, rounds: maxRounds };
    },
  };
  return register(b);
}

/* A chat tool on one of the viewer's claude.ai connectors, through the artifact's mcp capability:
   callTool(server, tool, {messages, model}); the answer is payload.text, payload.content, or the
   result's text blocks. No streaming; page tools are not offered (the connector cannot call back). */
/* Upstream throttling and outages arrive as server_unavailable (mcp.d.ts); the others mean the connector is not usable from here. */
const MCP_TRANSIENT = new Set(['server_unavailable', 'server_not_connected', 'server_not_found', 'not_in_manifest', 'upstream_error']);
function makeMcp(o) {
  const b = {
    name: o.name, kind: 'mcp', server: o.server, tool: o.tool || 'chat', models: o.models || [],
    async available() {
      if (!hasClaude()) return 'Claude connectors are available in the published artifact only';
      if (!(await useCap('mcp'))) return `the mcp capability is not available in this view: publish with capabilities {mcp: {servers: [{server: "${b.server}", tools: ["${b.tool}"]}]}}`;
      return true;
    },
    async stream(req, { onText, signal }) {
      const mcp = await useCap('mcp');
      if (!mcp) throw new AIError('unavailable', 'the mcp capability is not available in this view');
      let res;
      try { res = await mcp.callTool(b.server, b.tool, { messages: req.messages.map(m => ({ role: m.role, content: m.content })), model: req.model }, { signal }); }
      catch (e) {
        if (!e || e.code === undefined) throw e;
        if (e.code === 'cancelled') throw cancelled();
        throw new AIError(e.code, `${b.name}: ${e.message || e.code}`, { exhausted: e.code === 'rate_limited', transient: !!e.retryable || MCP_TRANSIENT.has(e.code) });
      }
      const p = res && res.payload;
      const blocksText = c => Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('') : typeof c === 'string' ? c : '';
      let text = typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : p && p.content !== undefined ? blocksText(p.content) : blocksText(res && res.content);
      text = String(text || '');
      if (!text) throw new AIError('empty', `${b.name}: empty answer`);
      onText(text);
      return { text };
    },
  };
  return register(b);
}
function mcpManifest() {
  const servers = new Map();
  for (const n in backends) { const b = backends[n]; if (b.kind !== 'mcp') continue; if (!servers.has(b.server)) servers.set(b.server, new Set()); servers.get(b.server).add(b.tool); }
  return { servers: [...servers].map(([server, tools]) => ({ server, tools: [...tools] })) };
}

/* ---------- presets and tools, in the neutral form ---------- */
const presets = {};
const TOOLS = {};
function defTool(name, description, inputSchema, execute) { TOOLS[name] = { name, description, inputSchema, execute }; }
/* Feed the key of command NAME at the next safe point: the command loop parked at top level with no
   operator, prefix key, register name or minibuffer waiting for a key. A key fed earlier would be read
   by that reader as its argument and the command would be lost. */
function feedAtTopLevel(name) {
  const k = `<cmd:${name}>`;
  if (globalThis.EdPool && typeof EdPool.deliver === 'function') EdPool.deliver(() => Ed.feedKey(k));
  else Ed.feedKey(k);
}
/* Confirmations run inside the command loop (the minibuffer is a recursive edit there): the tool
   queues its question and feeds a command key; gptel-confirm asks and answers the promise. An aborted
   request withdraws its question and counts as declined. */
const confirms = [];
function confirmInLoop(prompt, signal) {
  if (signal && signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const c = { prompt, resolve };
    confirms.push(c);
    if (signal) signal.addEventListener('abort', () => { const i = confirms.indexOf(c); if (i >= 0) { confirms.splice(i, 1); resolve(false); } }, { once: true });
    feedAtTopLevel('gptel-confirm');
  });
}
const aborted = ctx => !!(ctx && ctx.signal && ctx.signal.aborted);
CMD('gptel-confirm', async () => {
  const c = confirms.shift();
  if (!c) return [];
  let ok = false;
  try { ok = /^y/i.test((await Ed.readMini(c.prompt + ' (y or n) ', '')).trim()); } finally { c.resolve(ok); }
  return [];
}, '', 'Answer a pending tool confirmation (used by gptel tools; not for M-x).', () => false);
const bufNamed = name => E.buffers.find(b => b.name === name) || E.buffers.find(b => b.file === name);
defTool('list_buffers', 'List the open buffers: name, mode, size and file. Returns one line per buffer.', { type: 'object', properties: {} },
  () => E.buffers.filter(b => b !== E.minibuf).map(b => `${b.name}\t${b.mode}\t${b.rope.length} chars${b.file ? '\t' + b.file : ''}`).join('\n'));
defTool('read_buffer', 'Return the text of an open buffer by name (the first 30000 characters). Use list_buffers for the names.',
  { type: 'object', properties: { name: { type: 'string', description: 'Buffer name' } }, required: ['name'] },
  ({ name }) => { const b = bufNamed(String(name)); if (!b) throw new Error('no buffer named ' + name); const t = b.rope.slice(0, 30000); return b.rope.length > 30000 ? t + '\n[truncated]' : t; });
/* Pure so it can run in a worker: FILES is [[name, text], ...]. */
function grepFiles(a) {
  const re = new RegExp(a.regex, 'i' + (a.flags || '')), out = [];
  for (const [name, text] of a.files) {
    let pos = 0, line = 1;
    while (pos <= text.length && out.length < a.max) {
      const k = text.indexOf('\n', pos), end = k < 0 ? text.length : k, s = text.slice(pos, end);
      if (re.test(s)) out.push(`${name}:${line}: ${s.slice(0, 200)}`);
      if (k < 0) break;
      pos = k + 1; line++;
    }
    if (out.length >= a.max) break;
  }
  return out.join('\n');
}
if (globalThis.EdPool && typeof EdPool.define === 'function') { try { EdPool.define('gptel-grep', grepFiles); } catch (e) { /* main thread */ } }
defTool('grep', 'Search the saved files (and, optionally, only those whose name contains FILE) for a regular expression. Returns file:line: text, at most 200 matches.',
  { type: 'object', properties: { regex: { type: 'string' }, file: { type: 'string', description: 'Only files whose name contains this' } }, required: ['regex'] },
  async ({ regex, file }) => {
    try { new RegExp(String(regex)); } catch (e) { throw new Error('bad regex: ' + e.message); }
    const names = Ed.Store.list().filter(n => !file || n.includes(String(file)));
    const files = names.map(n => [n, Ed.Store.get(n) || '']);
    const args = { regex: String(regex), files, max: 200 };
    if (globalThis.EdPool && EdPool.ok && typeof EdPool.run === 'function') { try { return await EdPool.run('gptel-grep', args); } catch (e) { /* fall through */ } }
    return grepFiles(args) || '(no matches)';
  });
defTool('eval_scheme', 'Evaluate Scheme code in the editor and return the printed result. The user confirms first.',
  { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  async ({ code }, ctx) => {
    code = String(code);
    if (!(await confirmInLoop(`Run Scheme ${code.replace(/\s+/g, ' ').slice(0, 60)}?`, ctx && ctx.signal))) return 'The user declined.';
    if (aborted(ctx)) throw new Error('request aborted');
    try { return L.write(L.evalText(code)); } catch (e) { throw new Error(Ed.errorText(e)); }
  });
defTool('insert_text', 'Insert text at point in a buffer (the current one unless BUFFER is given). The user confirms first.',
  { type: 'object', properties: { text: { type: 'string' }, buffer: { type: 'string' } }, required: ['text'] },
  async ({ text, buffer }, ctx) => {
    const b = buffer ? bufNamed(String(buffer)) : cur();
    if (!b) throw new Error('no buffer named ' + buffer);
    if (!(await confirmInLoop(`Insert ${String(text).length} chars into ${b.name}?`, ctx && ctx.signal))) return 'The user declined.';
    if (aborted(ctx) || !alive(b)) throw new Error('request aborted');
    Ed.insertText(b, String(text)); Ed.render(); return 'Inserted.';
  });
defTool('write_file', 'Save CONTENT as the file NAME (replacing it). The user confirms first.',
  { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] },
  async ({ name, content }, ctx) => {
    if (!(await confirmInLoop(`Write ${String(content).length} chars to ${name}?`, ctx && ctx.signal))) return 'The user declined.';
    if (aborted(ctx)) throw new Error('request aborted');
    writeFile(String(name), String(content)); return 'Wrote ' + name;
  });
defTool('remember', 'Save one durable fact about the user or their preferences to long-term memory (memory.org), shown in future conversations.',
  { type: 'object', properties: { fact: { type: 'string', description: 'One self-contained sentence' } }, required: ['fact'] },
  ({ fact }) => { remember(String(fact)); return 'Saved to memory.'; });

/* Save a file and keep a visiting buffer in step. */
function writeFile(name, content) {
  Ed.Store.set(name, content);
  const b = E.buffers.find(x => x.file === name);
  if (b) { const pt = b.pt; Ed.replaceText(b, 0, b.rope.length, content); b.pt = Math.min(pt, b.rope.length); b.modified = false; }
}
const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const memoryFile = () => String(L.get('gptel-memory-file'));
const chatDir = () => String(L.get('gptel-chat-directory'));
function ensureMemory() {
  if (Ed.Store.get(memoryFile()) === null) Ed.Store.set(memoryFile(), `:PROPERTIES:\n:ID: ${uuid()}\n:END:\n#+title: Assistant memory\n#+filetags: :memory:\n\n`);
}
function remember(fact) {
  ensureMemory();
  writeFile(memoryFile(), (Ed.Store.get(memoryFile()) || '') + `- [${today()}] ${fact.trim()}\n`);
}
function memoryText() { ensureMemory(); const t = Ed.Store.get(memoryFile()) || ''; return t.length > 20000 ? t.slice(-20000) : t; }

/* ---------- requests: build, send with fallback ---------- */
function presetNamed(name) { const p = presets[name]; if (!p) signal('user-error', `No gptel preset named ${name}`); return p; }
const strOf = x => x instanceof Sym ? x.name : typeof x === 'string' ? x : null;
function modelFor(b, req) {
  const primary = req.backend || String(L.get('gptel-backend'));
  let m = b.name === primary ? strOf(L.get('gptel-model')) : null;
  if (!m && req.presetBackend === b.name) m = req.presetModel;
  if (typeof m === 'string' && m) return m;
  const tier = req.modelTier || 'default';
  if (b.kind === 'claude') return tier;
  const ms = b.models || [];
  if (!ms.length) return req.presetModel || 'default';
  return tier === 'complex' ? ms[ms.length - 1] : ms[0];
}
/* Try the current backend, then each fallback, on exhaustion or unavailability; ONSTART tells the
   caller which backend is about to answer so the chat heading can name it. */
async function send(req, { onText, signal, onStart }) {
  const primary = req.backend || String(L.get('gptel-backend'));
  const names = [primary, ...arr(L.get('gptel-fallback-backends')).map(x => x instanceof Sym ? x.name : String(x))].filter((n, i, a) => a.indexOf(n) === i);
  const tried = [];
  for (const name of names) {
    const b = backends[name];
    if (!b) { tried.push(`${name}: no such backend`); continue; }
    let ok;
    try { ok = await b.available(); } catch (e) { ok = e && e.message || String(e); }
    if (ok !== true) { tried.push(`${name}: ${ok}`); continue; }
    const r = { ...req, model: modelFor(b, req) };
    if (onStart) onStart(b, r.model);
    let streamed = false;
    try {
      const res = await b.stream(r, { onText: t => { streamed = true; onText(t); }, signal });
      return { ...res, backend: b, model: r.model, tried };
    } catch (e) {
      if (!(e instanceof AIError)) e = new AIError('error', `${name}: ${e && e.message || e}`);
      /* A transient failure after text began is reported, not retried elsewhere: the answer would restart. */
      if (e.code === 'cancelled' || !(e.exhausted || (e.transient && !streamed))) throw e;
      tried.push(`${name}: ${e.message}`);
    }
  }
  throw new AIError('unavailable', tried.length === 1 ? tried[0] : 'no backend answered: ' + tried.join('; '));
}
function buildRequest(preset, messages, opts) {
  const req = { messages, tools: [], modelTier: preset.modelTier || 'default', backend: preset.backend || null, presetBackend: preset.backend || null, presetModel: preset.model || null, maxRounds: Number(L.get('gptel-max-rounds')) || 8 };
  if (preset.temperature !== undefined) req.temperature = preset.temperature;
  if (preset.maxTokens) req.maxTokens = preset.maxTokens;
  const effort = L.get('gptel-effort'); if (typeof effort === 'string') req.effort = effort;
  for (const n of preset.tools || []) { const t = TOOLS[n]; if (t) req.tools.push(t); }
  return Object.assign(req, opts || {});
}
function systemFor(preset) {
  let s = preset.system || '';
  if (preset.memory) s = (s ? s + '\n\n' : '') + 'Long-term memory about the user (memory.org):\n' + memoryText();
  return s;
}

/* ---------- chat buffers: Org, * prompts and ** answers ---------- */
const isChat = b => !!b && (b.gptel === true || b.name === '*gptel*' || (!!b.file && b.file.startsWith(chatDir()) && b.file !== memoryFile()));
/* An answer heading is one sendChat writes: "** Claude" or "** <backend> <model>". Any other "** "
   line is an ordinary subheading and belongs to the turn it is in. */
function isAnswerLabel(label) {
  if (label === 'Claude') return true;
  for (const n in backends) if (label === n || label.startsWith(n + ' ')) return true;
  return false;
}
/* The closing line of the block LINE opens (#+begin_x or a markdown fence), or null. */
function blockEnd(line) {
  let m = /^\s*#\+begin_(\S+)/i.exec(line);
  if (m) return new RegExp('^\\s*#\\+end_' + m[1].replace(/[^\w-]/g, '') + '\\b', 'i');
  m = /^\s*(`{3,}|~{3,})/.exec(line);
  return m ? new RegExp('^\\s*' + (m[1][0] === '`' ? '`' : '~') + '{' + m[1].length + ',}\\s*$') : null;
}
/* Keep an answer from adding Org headings, as gptel's markdown conversion does: a "* item" bullet at
   column 0 becomes "- item", and a line starting with * inside a block gets Org's comma escape. With
   FINAL, a block the answer left open is closed, so it cannot swallow the next prompt. */
function orgSafe(text, final) {
  if (!/(^|\n)(\*|\s*```|\s*~~~|\s*#\+begin_)/i.test(text)) return text;
  let end = null, close = '';
  const out = text.split('\n').map(line => {
    if (end) { if (end.test(line)) { end = null; return line; } return line[0] === '*' ? ',' + line : line; }
    if ((end = blockEnd(line))) { const m = /^\s*#\+begin_(\S+)/i.exec(line); close = m ? '#+end_' + m[1] : /^\s*([`~]+)/.exec(line)[1]; return line; }
    return /^\*+( |$)/.test(line) ? line.replace(/^\*+ ?/, '- ') : line;
  }).join('\n');
  return final && end ? out + (out.endsWith('\n') ? '' : '\n') + close : out;
}
function parseChat(text) {
  const turns = [];
  let t = null, drawer = false, block = null;
  for (const line of text.split('\n')) {
    if (block) { if (block.test(line)) block = null; if (t) t.lines.push(line.replace(/^,(?=\*|#\+)/, '')); continue; }
    if (line.startsWith('* ') || line === '*') { t = { role: 'user', lines: [line.slice(2)] }; turns.push(t); drawer = false; }
    else if ((line.startsWith('** ') || line === '**') && isAnswerLabel(line.slice(3).trim())) { t = { role: 'assistant', label: line.slice(3), lines: [] }; turns.push(t); drawer = false; }
    else if (!t) continue;
    else if (/^:PROPERTIES:\s*$/.test(line)) drawer = true;
    else if (drawer) { if (/^:END:\s*$/.test(line)) drawer = false; }
    else { t.lines.push(line); block = blockEnd(line); }
  }
  return turns.map(x => ({ role: x.role, content: x.lines.join('\n').trim() })).filter(x => x.content);
}
function presetOfBuffer(b) {
  const head = b.rope.slice(0, Math.min(b.rope.length, 2000));
  const m = /^:GPTEL_PRESET:\s*(\S+)/m.exec(head);
  if (m && presets[m[1]]) return presets[m[1]];
  return presetNamed(String(L.get('gptel-preset')));
}
const labelFor = (b, model) => b.kind === 'claude' ? 'Claude' : `${b.name} ${model}`;

/* One request per buffer; the modeline shows "<backend>: thinking|writing" while it runs. */
const active = new Map();
/* ai.js loads before evil-ex.js (boot evaluates ai.scm), which sets H.look: wrap it at the first request. */
let looked = false;
function ensureLook() {
  if (looked) return;
  looked = true;
  const prevLook = H.look;
  H.look = (b, w) => {
    const o = prevLook ? prevLook(b, w) : {};
    const a = active.get(b);
    if (a && a.phase) o.extra = (o.extra ? o.extra + ' ' : '') + `${a.backend}: ${a.phase}`;
    return o;
  };
}
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => { renderPending = false; try { Ed.render(); } catch (e) { console.error(e); } }, 40);
}
const alive = b => E.buffers.includes(b);
/* A growing answer region [s, e) that follows the user's other edits through a temp marker. SET edits
   only the part that changed (a streamed delta is an insert at the end), so the edit log and undo
   history grow with the answer, not with its square. */
function region(b, s, e) {
  const start = { pos: s }, end = { pos: e === undefined ? s : e };
  b.temps.add(start); b.temps.add(end);
  return {
    get s() { return Math.min(start.pos, b.rope.length); }, get e() { return Math.min(Math.max(end.pos, start.pos), b.rope.length); },
    set(text) {
      const s0 = this.s, e0 = this.e, old = b.rope.slice(s0, e0);
      if (old !== text) {
        let p = 0, q = 0;
        if (text.startsWith(old)) p = old.length;
        else {
          const m = Math.min(old.length, text.length);
          while (p < m && old.charCodeAt(p) === text.charCodeAt(p)) p++;
          while (q < m - p && old.charCodeAt(old.length - 1 - q) === text.charCodeAt(text.length - 1 - q)) q++;
        }
        Ed.replaceText(b, s0 + p, e0 - q, text.slice(p, text.length - q));
      }
      start.pos = s0; end.pos = s0 + text.length; start.dead = end.dead = false;
    },
    reset(pos) { start.pos = end.pos = pos; start.dead = end.dead = false; },
    release() { b.temps.delete(start); b.temps.delete(end); },
  };
}
function fail(e, b) {
  if (e instanceof AIError) { if (e.code === 'cancelled') Ed.message('gptel: aborted'); else Ed.message('gptel: ' + e.message); }
  else Ed.reportError(e);
}
function describe(res) {
  const name = res.backend.name;
  const note = res.rounds ? ` (stopped after ${res.rounds} tool rounds)` : res.truncated ? ' (cut short)' : '';
  if (res.tried && res.tried.length) return `gptel: ${res.tried.map(t => t.split(':')[0]).join(', ')} did not answer (${res.tried[0].replace(/^[^:]*: /, '').slice(0, 80)}); ${name} answered${note}`;
  return `gptel: ${name} answered${note}`;
}
/* Every send edits B: a read-only buffer is refused before the request goes out, as Emacs refuses the edit. */
const busy = b => { ensureLook(); if (active.has(b)) signal('user-error', 'gptel: a request is already running in this buffer (C-c C-k aborts it)'); Ed.checkRO(b); };
function sendChat(b) {
  busy(b);
  const upto = eol(b.rope, b.pt);
  const turns = parseChat(b.rope.slice(0, upto));
  if (!turns.length || turns[turns.length - 1].role !== 'user') signal('user-error', 'gptel: nothing to send; type your prompt under a "* " heading');
  const preset = presetOfBuffer(b);
  const sys = systemFor(preset);
  const messages = sys ? [{ role: 'system', content: sys }, ...turns] : turns;
  const req = buildRequest(preset, messages);
  const ctl = new AbortController();
  const st = { ctl, backend: req.backend || String(L.get('gptel-backend')), phase: 'thinking' };
  active.set(b, st);
  let reg = null, last = '';
  const run = async () => {
    try {
      const res = await send(req, {
        signal: ctl.signal,
        onStart(be, model) {
          st.backend = be.name; st.phase = 'thinking'; last = '';
          if (!alive(b)) { ctl.abort(); return; }
          const heading = `** ${labelFor(be, model)}\n`;
          if (!reg) {
            const len = b.rope.length, tail = len ? b.rope.slice(Math.max(0, len - 2)) : '\n\n';
            const pad = tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
            /* Point stays where it was (before the heading even when it was at the end): text typed
               while the answer streams goes into the prompt, never onto the answer's last line. */
            const pt = b.pt; b.pt = len; Ed.insertText(b, pad + heading); b.pt = pt;
            reg = region(b, b.rope.length);
          } else { const ls = bol(b.rope, Math.max(0, reg.s - 1)); Ed.replaceText(b, ls, reg.e, heading); reg.reset(ls + heading.length); }
          scheduleRender();
        },
        onText(text) {
          if (!alive(b)) { ctl.abort(); return; }
          st.phase = 'writing'; last = text; reg.set(orgSafe(text)); scheduleRender();
        },
      });
      if (!alive(b)) return;
      reg.set(orgSafe(res.text, true) || (res.rounds ? `[no answer: stopped after ${res.rounds} tool rounds]` : ''));
      resume.set(b, describe(res)); feedAtTopLevel('gptel-resume');
    } catch (e) {
      if (alive(b) && reg && e instanceof AIError && (e.text ? reg.e === reg.s : last)) reg.set(orgSafe(e.text || last, true));
      fail(e, b);
    } finally { active.delete(b); if (reg) reg.release(); scheduleRender(); }
  };
  run();
}
/* After an answer: a fresh "* " heading at the end, point there in insert state, the file saved. */
const resume = new Map();
CMD('gptel-resume', '', '', 'Continue a chat after its answer (used by gptel-send; not for M-x).', () => {
  const b = [...resume.keys()].find(alive), why = b && resume.get(b); resume.clear();
  if (!b) return false;
  const tail = b.rope.length ? b.rope.slice(Math.max(0, b.rope.length - 2)) : '\n\n';
  b.pt = b.rope.length;
  Ed.insertText(b, (tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n') + '* ');
  b.pt = b.rope.length;
  if (b.file) { Ed.Store.set(b.file, b.text); b.modified = false; }
  if (b === cur() && !E.mini && E.evil && EC.stateOf(b) && EC.stateOf(b) !== 'insert') EC.enterInsert(b, 1, false);
  Ed.message(why);
  return false;
});

/* ---------- one-shot in any other buffer, and rewrites ---------- */
/* The active region (Evil visual selection or Emacs mark), deactivated, or null. */
function takeRegion(b) {
  if (E.evil && EC.stateOf(b) === 'visual') { const [s, e] = EC.visualBounds(b); EC.setState(b, 'normal'); return [s, e]; }
  if (b.markActive && b.mark !== null && b.mark !== b.pt) { b.markActive = false; return [Math.min(b.pt, b.mark), Math.max(b.pt, b.mark)]; }
  return null;
}
const WORDISH = /[\p{L}\p{N}_.,;:!?'"-]/u;
function sendOneShot(b) {
  busy(b);
  let prompt, at;
  const r = takeRegion(b);
  if (r) { prompt = b.rope.slice(r[0], r[1]); at = r[1]; }
  else {
    /* The prompt ends at the end of the word at point, as gptel--at-word-end does: under Evil's
       normal state the cursor character is after point and belongs to the prompt. */
    let end = b.pt;
    while (end < b.rope.length && WORDISH.test(b.rope.at(end))) end++;
    prompt = b.rope.slice(Math.max(0, end - 8000), end); at = end;
  }
  if (!prompt.trim()) signal('user-error', 'gptel: nothing to send');
  const preset = presetNamed(String(L.get('gptel-preset')));
  const sys = preset.system || '';
  const req = buildRequest(preset, sys ? [{ role: 'system', content: sys }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }], { tools: [] });
  const ctl = new AbortController();
  const st = { ctl, backend: req.backend || String(L.get('gptel-backend')), phase: 'thinking' };
  active.set(b, st);
  const reg = region(b, at);
  const prefix = at > 0 && b.rope.at(at - 1) !== '\n' ? '\n' : '';
  const suffix = at < b.rope.length && b.rope.at(at) !== '\n' ? '\n' : ''; // the rest of the line goes below the answer
  (async () => {
    try {
      const res = await send(req, { signal: ctl.signal, onStart(be) { st.backend = be.name; st.phase = 'thinking'; if (alive(b)) reg.set(''); }, onText(text) { if (!alive(b)) { ctl.abort(); return; } st.phase = 'writing'; reg.set(prefix + text + suffix); scheduleRender(); } });
      if (!alive(b)) return;
      reg.set(prefix + res.text + suffix); b.pt = reg.e - suffix.length;
      Ed.message(describe(res));
    } catch (e) { fail(e, b); }
    finally { active.delete(b); reg.release(); scheduleRender(); }
  })();
}
let rewrite = null;
function sendRewrite(b, s, e, instruction) {
  busy(b);
  const text = b.rope.slice(s, e);
  const preset = presetNamed(String(L.get('gptel-preset')));
  const req = buildRequest(preset, [
    { role: 'system', content: 'You rewrite text. Reply with only the rewritten text: no commentary, no quotes, no code fence.' },
    { role: 'user', content: `Instruction: ${instruction}\n\nText:\n${text}` }], { tools: [] });
  const ctl = new AbortController();
  const st = { ctl, backend: req.backend || String(L.get('gptel-backend')), phase: 'thinking' };
  active.set(b, st);
  const reg = region(b, s, e); // markers only: the region text stays until confirmed
  (async () => {
    try {
      const res = await send(req, { signal: ctl.signal, onStart(be) { st.backend = be.name; }, onText() { st.phase = 'writing'; scheduleRender(); } });
      if (!alive(b)) return;
      /* The region's own trailing whitespace stays (a linewise selection ends with its newline). */
      const tail = /\s*$/.exec(text)[0];
      rewrite = { b, s: reg.s, e: reg.e, text: res.text.replace(/\s+$/, '') + tail, tail: tail.length };
      Ed.message(describe(res));
      feedAtTopLevel('gptel-rewrite-apply');
    } catch (e) { fail(e, b); }
    finally { active.delete(b); reg.release(); scheduleRender(); }
  })();
}
CMD('gptel-rewrite-apply', async () => {
  const r = rewrite; rewrite = null;
  if (!r || !alive(r.b)) return [false];
  const shown = r.text.trim(), preview = shown.replace(/\s+/g, ' ').slice(0, 50);
  return [(await Ed.readMini(`Replace region with "${preview}${shown.length > 50 ? '...' : ''}"? (y or n) `, '')).trim(), r];
}, '', 'Apply a finished rewrite after confirmation (used by gptel-rewrite; not for M-x).', ([ans, r]) => {
  if (!r || !/^y/i.test(String(ans || ''))) { if (r) Ed.message('gptel: rewrite discarded'); return false; }
  Ed.replaceText(r.b, r.s, r.e, r.text); r.b.pt = r.s + r.text.length - (r.tail || 0); r.b.markActive = false;
  Ed.message('gptel: region rewritten'); return false;
});

/* ---------- commands ---------- */
CMD('gptel-send', '', '', 'Send the chat up to point (in a gptel buffer) or the region / text before point (elsewhere) and insert the answer.', () => {
  const b = cur();
  if (isChat(b)) sendChat(b);
  else sendOneShot(b);
  return false;
});
CMD('gptel-abort', '', '', 'Abort the gptel request running in this buffer (or any running request).', () => {
  /* C-c C-k is also org-capture-kill: in a capture buffer with no request of its own, it drops the capture. */
  if (!active.get(cur()) && cur().capture && L.isCommand(intern('org-capture-kill'))) return Ed.callInteractively(intern('org-capture-kill'));
  const st = active.get(cur()) || [...active.values()][0];
  if (!st) { Ed.message('gptel: nothing to abort'); return false; }
  st.ctl.abort(); return false;
});
CMD('gptel', '', '', 'Open the *gptel* chat buffer (an Org buffer that is not file-backed).', () => {
  const b = Ed.getBufferCreate('*gptel*');
  b.mode = 'org-mode'; b.gptel = true;
  if (!b.rope.length) { b.text = '* '; b.modified = false; }
  Ed.setWindowBuffer(b); b.pt = b.rope.length;
  if (E.evil && EC.stateOf(b) && EC.stateOf(b) !== 'insert') EC.enterInsert(b, 1, false);
  return false;
});
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'chat';
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const orgNow = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}]`; };
CMD('gptel-chat', async () => [await Ed.readMini('Chat topic: ', '')], 'TOPIC', 'Start a saved assistant chat about TOPIC in roam/chats/.', ([topic]) => {
  topic = str(topic).trim(); if (!topic) signal('user-error', 'No topic given');
  ensureMemory();
  const name = `${chatDir()}${stamp()}-${slug(topic)}.org`;
  Ed.Store.set(name, `:PROPERTIES:\n:ID: ${uuid()}\n:GPTEL_PRESET: assistant\n:END:\n#+title: ${topic}\n#+created: ${orgNow()}\n#+filetags: :chat:\n\n* `);
  const b = L.call('find-file', [name]);
  b.mode = 'org-mode'; b.pt = b.rope.length;
  if (E.evil && EC.stateOf(b) && EC.stateOf(b) !== 'insert') EC.enterInsert(b, 1, false);
  return b;
});
function chatFiles() { return Ed.Store.list().filter(n => n.startsWith(chatDir()) && n !== memoryFile() && n.endsWith('.org')).sort().reverse(); }
function chatTitle(n) { const m = /^#\+title:\s*(.*)$/mi.exec((Ed.Store.get(n) || '').slice(0, 2000)); return m ? m[1].trim() : n; }
CMD('gptel-chat-open', async () => {
  const files = chatFiles(); if (!files.length) signal('user-error', 'No saved chats yet (gptel-chat starts one)');
  const byTitle = new Map(files.map(n => [`${chatTitle(n)}  (${n.slice(chatDir().length)})`, n]));
  const pick = await Ed.readMini('Chat: ', '', () => [...byTitle.keys()], { require: true, kind: 'gptel-chat', keepOrder: true });
  return [byTitle.get(pick) || pick];
}, 'FILE', 'Open a saved chat by title.', ([n]) => { const b = L.call('find-file', [str(n)]); b.mode = 'org-mode'; return b; });
CMD('gptel-edit-memory', '', '', 'Visit the assistant memory file.', () => { ensureMemory(); const b = L.call('find-file', [memoryFile()]); b.mode = 'org-mode'; return b; });
CMD('gptel-set-preset', async () => [await Ed.readMini('Preset: ', '', () => Object.keys(presets), { require: true, kind: 'gptel-preset', annotate: n => presets[n].description || '' })], 'NAME', 'Make NAME the active preset.', ([n]) => {
  presetNamed(str(n)); L.set('gptel-preset', n); Ed.message(`gptel preset: ${n}`); return false;
});
const describeBackend = n => { const b = backends[n]; return b ? `${b.kind}${b.models && b.models.length ? '  ' + b.models.slice(0, 3).join(', ') + (b.models.length > 3 ? ', ...' : '') : ''}` : ''; };
CMD('gptel-backend-select', async () => [await Ed.readMini('Backend: ', '', () => Object.keys(backends), { require: true, kind: 'gptel-backend', annotate: describeBackend })], 'NAME', 'Use backend NAME for gptel requests.', ([n]) => {
  if (!backends[str(n)]) signal('user-error', `No gptel backend named ${n}`);
  L.set('gptel-backend', n); L.set('gptel-model', false);
  Promise.resolve(backends[n].available()).then(ok => Ed.message(ok === true ? `gptel backend: ${n}` : `gptel backend: ${n} (${ok})`)).then(scheduleRender);
  return false;
});
CMD('gptel-model-select', async () => {
  const b = backends[String(L.get('gptel-backend'))];
  return [await Ed.readMini(`Model for ${b ? b.name : L.get('gptel-backend')}: `, '', () => b ? b.models.slice() : [], { kind: 'gptel-model' })];
}, 'NAME', 'Use model NAME with the current backend (free text allowed; empty resets to the preset’s choice).', ([n]) => {
  n = str(n).trim(); L.set('gptel-model', n || false); Ed.message(n ? `gptel model: ${n}` : 'gptel model: preset default'); return false;
});
CMD('gptel-set-effort', async () => [await Ed.readMini('Effort (Claude): ', '', () => ['low', 'medium', 'high', 'none'], { require: true, kind: 'gptel-effort' })], 'LEVEL', 'Set the thinking effort for Claude backends.', ([n]) => {
  L.set('gptel-effort', n === 'none' ? false : str(n)); Ed.message(`gptel effort: ${n}`); return false;
});
/* The key is read with the echo area showing only asterisks; a paste is accepted as a whole. */
async function readSecret(prompt) {
  let s = '';
  /* Like read-passwd, keep the key out of keyboard macros, the . register and the repeat record:
     everything nextKey records while it is typed is dropped again. */
  const recs = [E.macro && E.macro.keys, E.ins && E.ins.keys, E.dotCand && E.dotCand.keys].filter(Array.isArray).map(a => [a, a.length]);
  try {
    for (;;) {
      E.prompt = prompt + '*'.repeat(s.length);
      const k = await Ed.nextKey();
      if (k === 'C-g' || k === 'ESC') Ed.quietQuit();
      if (k === 'RET') return s;
      if (k === 'DEL' || k === 'C-h') { s = s.slice(0, -1); continue; }
      if (k === '<cmd:clipboard-yank>' || k === 'C-y') { s += E.pasteText || ''; continue; }
      const ch = Ed.keyChar(k);
      if (ch && ch !== '\n' && ch !== '\t') s += ch;
    }
  } finally { E.prompt = null; for (const [a, n] of recs) if (a.length > n) a.length = n; }
}
CMD('gptel-set-api-key', async () => {
  const names = Object.keys(backends).filter(n => backends[n].kind === 'openai' || backends[n].kind === 'anthropic');
  const d = String(L.get('gptel-backend'));
  const n = (await Ed.readMini(`API key for backend (default ${d}): `, '', () => names, { kind: 'gptel-backend', def: d, annotate: x => getKey(x) ? 'key stored' : 'no key' })).trim() || d;
  return [n, await readSecret(`Key for ${n} (RET to finish, empty clears): `)];
}, 'BACKEND KEY', 'Store the API key for BACKEND in this browser (never in init.scm).', ([n, key]) => {
  setKey(str(n), String(key || '').trim());
  Ed.message(key ? `gptel: key stored for ${n}` : `gptel: key cleared for ${n}`); return false;
});
async function pickMenu(title, items) {
  const labels = items.map(([k, label]) => `${k}  ${label}`);
  const pick = await Ed.readMini(title, '', () => labels, { require: true, kind: 'gptel-menu' });
  const it = items.find(([k, label]) => `${k}  ${label}` === pick || k === pick);
  return it ? it[2] : null;
}
const PRESET_MENU = [
  ['n', 'new assistant chat', 'gptel-chat'], ['o', 'open saved chat', 'gptel-chat-open'], ['M', 'edit memory', 'gptel-edit-memory'],
  ['p', 'set preset', 'gptel-set-preset'], ['b', 'select backend', 'gptel-backend-select'], ['m', 'select model', 'gptel-model-select'],
  ['k', 'set api key', 'gptel-set-api-key'], ['e', 'set effort (Claude)', 'gptel-set-effort']];
const MAIN_MENU = [
  ['s', 'send', 'gptel-send'], ['r', 'rewrite region', 'gptel-rewrite'], ['a', 'abort', 'gptel-abort'], ['c', 'new chat buffer', 'gptel'],
  ['p', 'set preset', 'gptel-set-preset'], ['b', 'select backend', 'gptel-backend-select'], ['m', 'select model', 'gptel-model-select'],
  ['k', 'set api key', 'gptel-set-api-key'], ['e', 'set effort (Claude)', 'gptel-set-effort']];
const menuTitle = () => `gptel [${L.get('gptel-preset')} | ${L.get('gptel-backend')}${L.get('gptel-model') ? ' ' + L.get('gptel-model') : ''}]: `;
CMD('gptel-preset-menu', async () => [await pickMenu(menuTitle(), PRESET_MENU)], 'COMMAND', 'Chat, preset, backend, model and key picks (SPC g l).', ([c]) => c ? Ed.callInteractively(intern(String(c))) : false);
CMD('gptel-menu', async () => [await pickMenu(menuTitle(), MAIN_MENU)], 'COMMAND', 'Send, rewrite, abort and settings (SPC g L).', ([c]) => c ? Ed.callInteractively(intern(String(c))) : false);
CMD('gptel-rewrite', async () => {
  const b = cur();
  const r = takeRegion(b);
  if (!r) signal('user-error', 'gptel-rewrite needs a region');
  return [r[0], r[1], await Ed.readMini('Rewrite instruction: ', '')];
}, 'START END INSTRUCTION', 'Ask the model to rewrite the region per INSTRUCTION; the result replaces it after confirmation.', ([s, e, ins]) => {
  const b = cur();
  sendRewrite(b, s, e, str(ins)); return false;
});

/* ---------- the Scheme constructors (see ai.scm for the documentation) ---------- */
/* An alist (("X-Title" . "Edwin")) or a plist-free object of request headers. */
function toHeaders(v) {
  const o = {};
  if (Array.isArray(v)) for (const p of v) { if (p instanceof L.Pair) o[String(p.car)] = String(p.cdr instanceof L.Pair ? p.cdr.car : p.cdr); }
  else if (v && typeof v === 'object') Object.assign(o, v);
  return o;
}
function plist(args, who) {
  const o = {};
  for (let i = 0; i + 1 < args.length; i += 2) {
    const k = args[i];
    if (!(k instanceof Sym) || k.name[0] !== ':') signal('wrong-type-argument', `${who}: expected a keyword, got`, k);
    let v = args[i + 1];
    if (v instanceof Sym) v = v.name;
    else if (v === NIL || v instanceof L.Pair) v = arr(v).map(x => x instanceof Sym ? x.name : x);
    o[k.name.slice(1).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v;
  }
  return o;
}
D('gptel-make-claude', '&rest PLIST', 'Define the built-in Claude backend (artifact sample capability). :name defaults to "Claude".', a => makeClaude(plist(a, 'gptel-make-claude')));
D('gptel-make-openai', 'NAME &rest PLIST', 'Define an OpenAI-compatible backend: :host :endpoint :protocol :key :models :stream :headers.', ([n, ...a]) => { const o = plist(a, 'gptel-make-openai'); return makeOpenAI({ ...o, headers: toHeaders(o.headers), name: str(n) }); });
D('gptel-make-anthropic', 'NAME &rest PLIST', 'Define an Anthropic Messages API backend: :key :models :host :stream.', ([n, ...a]) => { const o = plist(a, 'gptel-make-anthropic'); return makeAnthropic({ ...o, headers: toHeaders(o.headers), name: str(n) }); });
D('gptel-make-mcp', 'NAME &rest PLIST', 'Define a backend on a claude.ai connector tool: :server :tool :models.', ([n, ...a]) => { const o = plist(a, 'gptel-make-mcp'); if (!o.server) signal('error', 'gptel-make-mcp needs :server'); return makeMcp({ ...o, name: str(n) }); });
D('gptel-make-preset', 'NAME &rest PLIST', 'Define a preset: :description :system :backend :model :model-tier :temperature :max-tokens :tools :memory.', ([n, ...a]) => {
  const name = n instanceof Sym ? n.name : str(n);
  const o = plist(a, 'gptel-make-preset');
  presets[name] = { name, description: o.description || '', system: o.system || '', backend: o.backend || null, model: o.model || null, modelTier: o.modelTier || 'default',
    temperature: typeof o.temperature === 'number' ? o.temperature : undefined, maxTokens: typeof o.maxTokens === 'number' ? o.maxTokens : undefined,
    tools: Array.isArray(o.tools) ? o.tools.map(String) : [], memory: truthy(o.memory) && o.memory !== NIL && o.memory !== undefined };
  return intern(name);
});
D('gptel-backends', '', 'Names of the defined backends.', () => listOf(Object.keys(backends)));
D('gptel-presets', '', 'Names of the defined presets.', () => listOf(Object.keys(presets)));
D('gptel-chat-buffer?', '&optional BUFFER', '#t when BUFFER is a gptel chat buffer.', ([b]) => isChat(b === undefined ? cur() : Ed.toBuffer(b)));

globalThis.EdAI = { backends, presets, tools: TOOLS, AIError, send, buildRequest, parseChat, isChat, mcpManifest, getKey, setKey, keyOf, migrateKeys, grepFiles, memoryText, remember, active, makeClaude, makeOpenAI, makeAnthropic, makeMcp, SANDBOX };
})();
