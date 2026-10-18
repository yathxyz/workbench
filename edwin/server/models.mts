// The model layer (spec §12, §14.3, R14.4–R14.7, R12.13–R12.14, R16.15, R16.19): edwind holds the provider
// keys and runs every model call, for the board's `sample` (forwarded by wb-web, §12.2) and for gptel in the
// server image (§12.3).
//
// Backends are objects in the gptel style (R12.1): a name, a kind (the two kinds the spec names,
// `anthropic` for the Messages API and `openai` for any compatible chat-completions endpoint), an endpoint
// URL, the models it lists, its tiers and, optionally, a credential. The default backend `workbench` comes
// from edit.json `models` (R12.3, §15.2); edwin/scm/models.scm adds the Scheme constructors and gptel-send.
//
// Credentials (R14.5–R14.7): `(credential NAME)` is an opaque handle for the file NAME in
// $CREDENTIALS_DIRECTORY (systemd LoadCredential), bound to the origin of the backend it is configured for.
// The handle holds the name and the origin only; the key is read from the file when a request needs it and
// goes nowhere but the one request header. Printing gives #<credential NAME>; nothing else can reach the
// key: not string-append, not equal?, not the image writer, not a log line, not a condition's irritants.
//
// Network (R14.4): one primitive, `http-request`, an HTTPS client (plain http only to loopback). A
// credential is attached only to a request on its own origin (else the condition `credential-origin`);
// redirects are followed only on the same origin while a credential is attached; a cross-origin redirect
// fails the request. Scheme code may call http-request on any URL without a credential.
//
// Threads: http-request and the model calls are generator primitives (yield S.Block while they wait), so
// the image keeps sequencing edits meanwhile; a gptel stream runs on a background thread attributed to
// {kind: "agent", agent: "gptel:<backend>"} (R12.9) and every chunk wait is a blocking point that lets its
// edits out to every frame (R4.41). A `sample` runs on a background thread too, with JS callbacks that send
// the stream to wb-web.
//
// Limits and accounting (§12.4): at most MAX_CONCURRENT model requests run at once (the rest queue), each
// under a 10 min deadline, with the provider's rate-limit retry (3 attempts, exponential, retry-after
// honoured). Each request logs one line (backend, model, tier, tokens, latency, caller; never the prompt or
// the key) and appends the same to <stateDir>/usage.jsonl, which `model-usage` sums over the last 30 days.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { ProtoError } from './proto.mts';
import { jsonToScheme } from './threads.mts';
import type { IncomingHttpHeaders } from 'node:http';
import type { Server, Log, Lisp, SchemeValue, ModelsConfig, ModelBackendConfig } from './main.mts';
import type { Client } from './session.mts';
import type { WireMessage } from './proto.mts';
import type { SchemeGen, Thread } from './threads.mts';

/* The evaluator S of edwin/src, untyped JavaScript like the rest of L. */
type Scheme = Lisp['S'];
/* A generator primitive's body: yields S.Block while it waits, returns R. */
type Gen<R> = Generator<SchemeValue, R, SchemeValue>;
type PrimFn = (args: SchemeValue[]) => SchemeValue;
type PrimGen = (args: SchemeValue[]) => SchemeGen;

/* ---------- backends and requests ---------- */
export type BackendKind = 'anthropic' | 'openai';
/* Tier name -> model (R12.6). */
export type Tiers = Record<string, string>;
interface KindInfo { endpoint: string; header: string; prefix: string; headers: Record<string, string>; images: boolean }
export interface BackendOptions {
  name: string; kind: BackendKind; baseUrl?: string; url?: string | null; endpoint?: string;
  credential?: Credential | null; models?: string[]; tiers?: Tiers | null; headers?: Record<string, string>; stream?: boolean;
}
export interface BackendInfo { name: string; kind: BackendKind; url: string; origin: string | null; credential: string | null; models: string[]; tiers: Tiers }
export interface ImageInput { data: string; media_type?: string }
/* One message of a request: role user, assistant or system. */
export interface ChatMessage { role: string; content: string; images?: ImageInput[] }
export interface ToolSpec { name: string; description?: string; inputSchema?: unknown }
/* A model request (REQ of completeG), from the board's sample or from gptel. */
export interface ModelRequest {
  model: string | null; tier: string; system?: string; messages: ChatMessage[]; tools: ToolSpec[];
  maxTokens?: number; effort?: string | null; temperature?: number; caller: string;
}
export interface ToolCallRequest { callId: string; name: string; input: unknown }
/* The callbacks of completeG: onText(full) synchronous, onTextG(full) between chunks, toolG(call) the tool's result. */
export interface ModelHooks {
  onText?: (full: string) => void;
  onTextG?: ((full: string) => SchemeGen) | null;
  toolG?: (call: ToolCallRequest) => Gen<string>;
}
export interface Usage { input: number; output: number }
export interface ModelResult { text: string; truncated: boolean; model: string | null; tier: string; usage: Usage; rounds: number }
/* A model request running now (model-requests). */
export interface RequestRecord { backend: string; model: string | null; tier: string | null; caller: string; startedAt: number }
/* One line of usage.jsonl (R12.14). */
export type UsageLine = { at: string; backend: string; model: string | null; tier: string | null; inputTokens: number; outputTokens: number; latencyMs: number; caller: string; error?: string };
export interface UsageRow { requests: number; inputTokens: number; outputTokens: number }
export interface UsageSummary {
  days: number; since: string; requests: number; errors: number; inputTokens: number; outputTokens: number; latencyMs: number;
  byModel: Record<string, UsageRow>; byCaller: Record<string, UsageRow>; byBackend: Record<string, UsageRow>;
}
/* A board sample being streamed to wb-web (§12.2). */
export interface ToolAnswer { error?: string; result?: unknown }
export interface SampleStream {
  sid: string; client: Client; tab: string | null; text: string;
  pending: Map<string, { resolve: (a: ToolAnswer) => void; reject: (e: unknown) => void }>;
  ended: boolean; thread: Thread | null;
}
type SampleError = { t: 'sample.error'; sid: string; code: string; message: string; text?: string };

/* ---------- the HTTP engine's shapes ---------- */
/* A body chunk handler: a plain function, or a generator function run between chunks. */
export type ChunkHandler = (chunk: string) => Gen<unknown> | void;
export interface HttpRequestOptions {
  url: string; method?: string; headers?: Record<string, unknown>; body?: string;
  credential?: Credential | null; credentialHeader?: string; credentialPrefix?: string;
  timeoutMs?: number; ctl: Ctl; who?: string;
  onResponse?: (status: number, headers: IncomingHttpHeaders) => ChunkHandler | null;
}
interface StartOptions { method: string; headers: Record<string, string>; body: string | undefined; ctl: Ctl }
interface HttpStart { status: number; headers: IncomingHttpHeaders; queue: BodyQueue }
export interface HttpResult { status: number; headers: IncomingHttpHeaders; body: string; url: string }
export interface SseParser { push(chunk: string): void; end(): void }

/* ---------- the providers' wire shapes ---------- */
interface ProviderError { message?: string; type?: string }
interface AnthropicUsage { input_tokens?: number; output_tokens?: number }
interface AnthropicBlock { type: string; id?: string; name?: string; text?: string; input?: unknown }
type AnthropicEvent =
  | { type: 'message_start'; message?: { usage?: AnthropicUsage } }
  | { type: 'content_block_start'; index: number; content_block: AnthropicBlock }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'thinking_delta' | 'signature_delta' | 'citations_delta' } }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: 'error'; error?: ProviderError }
  | { type: 'ping' | 'content_block_stop' | 'message_stop' };
interface OpenAIUsage { prompt_tokens?: number; completion_tokens?: number }
interface OpenAIToolCallDelta { index?: number; id?: string; function?: { name?: string; arguments?: string } }
interface OpenAIDelta { content?: string | null; tool_calls?: OpenAIToolCallDelta[] }
interface OpenAIChoice { finish_reason?: string | null; delta?: OpenAIDelta; message?: OpenAIDelta }
interface OpenAIChunk { error?: ProviderError; usage?: OpenAIUsage; choices?: OpenAIChoice[] }
/* A whole (non-streamed) answer of either kind, or an error body. */
interface ProviderAnswer {
  type?: string; stop_reason?: string | null; content?: AnthropicBlock[];
  usage?: AnthropicUsage & OpenAIUsage; choices?: OpenAIChoice[];
  error?: ProviderError; message?: string;
}
/* A content block of a round, as parserOf collects it. */
interface RoundBlock { type: string; id?: string; name?: string; text?: string; json?: string }
interface ToolCall { id: string; name: string; input: unknown; args?: string }
interface ParsedRound { content: string; calls: ToolCall[]; truncated: boolean; blocks?: (RoundBlock | undefined)[] }
interface Parser { event(d: string): void; whole(j: ProviderAnswer | null): void; result(): ParsedRound }
interface ContentPart { type: string; text?: string; [k: string]: unknown }
/* A message in the provider's shape. */
interface ProviderMessage { role: string; content: string | ContentPart[] | null; tool_calls?: unknown[]; tool_call_id?: string }
interface ProviderTool { name?: string; description?: string; input_schema?: unknown; type?: string; function?: { name: string; description: string; parameters: unknown } }
interface ProviderBody {
  model: string | null; messages: ProviderMessage[]; stream: boolean;
  max_tokens?: number; system?: string; tools?: ProviderTool[]; temperature?: number; output_config?: { effort: string };
  stream_options?: { include_usage: boolean }; max_completion_tokens?: number; reasoning_effort?: string;
}
interface ToolResult { callId: string; result: unknown }
interface GateTicket { promise: Promise<void>; cancel: () => void }
interface WaitingTicket extends GateTicket { resolve: () => void; granted: boolean }

export const name = 'models';
export const MAX_CONCURRENT = 4;                     // R12.13
export const REQUEST_DEADLINE_MS = 10 * 60 * 1000;   // R12.13
export const RETRY_ATTEMPTS = 3;                     // R12.13
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;     // R12.7
export const MAX_TOOL_ROUNDS = 8;
export const USAGE_DAYS = 30;                        // R12.14
export const DEFAULT_TIERS = { default: 'claude-opus-5-5', quick: 'claude-haiku-5-5' };   // R12.3, R12.6
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';                              // R12.3
export const DEFAULT_BACKEND = 'workbench';
export const MAX_REDIRECTS = 5;
export const CREDENTIAL_NAME = /^[a-z0-9-]{1,32}$/;   // the names nix/module.nix accepts
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCM_FILE = path.join(HERE, '..', 'scm', 'models.scm');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const KINDS: Record<BackendKind, KindInfo> = {
  anthropic: { endpoint: '/v1/messages', header: 'x-api-key', prefix: '', headers: { 'anthropic-version': '2023-06-01' }, images: true },
  openai: { endpoint: '/v1/chat/completions', header: 'authorization', prefix: 'Bearer ', headers: {}, images: true },
};
const RETRY_STATUS = new Set([429, 503, 529]);
/* BASE plus the path ENDPOINT, keeping any path of BASE (a proxy prefix). */
export const joinUrl = (base: string, endpoint: string): string => new URL(String(endpoint).replace(/^\/+/, ''), String(base).endsWith('/') ? String(base) : String(base) + '/').href;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/* The headers that describe a request body (the fetch standard's request-body-header names, with the framing
   ones): a redirect that drops the body drops them too, so the next hop never waits for a body that is not sent. */
const BODY_HEADERS = ['content-length', 'transfer-encoding', 'content-type', 'content-encoding', 'content-language', 'content-location'];

/* ---------- credentials (R14.5–R14.7) ---------- */
/* The handle: a frozen object with the name and the origin and nothing else. The key is never a property. */
export class Credential {
  declare name: string; declare origin: string | null;
  constructor(name: string, origin: string | null) { this.name = name; this.origin = origin; Object.freeze(this); }
  __print() { return `#<credential ${this.name}>`; }
  toString() { return this.__print(); }
  toJSON() { return this.__print(); }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.__print(); }
}
export const credentialsDirectory = (): string | null => process.env.CREDENTIALS_DIRECTORY || null;
/* The key of handle C, read from its file now, or null when the directory or the file is missing or empty. */
export function readSecret(c: Credential): string | null {
  const dir = credentialsDirectory();
  if (!dir || !CREDENTIAL_NAME.test(c.name)) return null;
  try { const s = fs.readFileSync(path.join(dir, c.name), 'utf8').replace(/\r?\n$/, '').trim(); return s || null; } catch (e) { return null; }
}
export const originOf = (url: string): string | null => { try { return new URL(String(url)).origin; } catch (e) { return null; } };
export const isLoopback = (url: string): boolean => { try { return LOOPBACK.has(new URL(String(url)).hostname); } catch (e) { return false; } };

/* ---------- backends ---------- */
export class Backend {
  declare name: string; declare kind: BackendKind; declare url: string; declare origin: string | null;
  declare credential: Credential | null; declare models: string[]; declare tiers: Tiers | null;
  declare headers: Record<string, string>; declare stream: boolean; declare images: boolean;
  constructor(o: BackendOptions) {
    this.name = o.name; this.kind = o.kind;
    const k = KINDS[o.kind];
    const base = o.baseUrl || DEFAULT_BASE_URL;
    this.url = o.url || joinUrl(base, o.endpoint || k.endpoint);
    this.origin = originOf(this.url);
    this.credential = o.credential || null;            // a Credential or null
    this.models = Array.isArray(o.models) ? o.models.map(String) : [];
    this.tiers = o.tiers && typeof o.tiers === 'object' ? { ...o.tiers } : null;
    this.headers = o.headers || {};
    this.stream = o.stream !== false;
    this.images = k.images;
  }
  __print() { return `#<gptel-backend ${this.name}>`; }
  toString() { return this.__print(); }
  toJSON() { return this.__print(); }
  /* The model for TIER (R12.6): the tier's model, else the default tier's, else the first model listed. */
  modelForTier(tier: string): string | null {
    const t = this.tiers || {};
    return t[tier] || t.default || this.models[0] || null;
  }
  /* R12.6: MODEL overrides when the backend lists it, else the tier applies. */
  resolve(modelTier: unknown, model: unknown): { model: string | null; tier: string } {
    const tier = typeof modelTier === 'string' && this.tiers && this.tiers[modelTier] ? modelTier : 'default';
    if (typeof model === 'string' && model && this.models.includes(model)) return { model, tier };
    return { model: this.modelForTier(tier), tier };
  }
  /* A safe description: never the key. */
  info(): BackendInfo { return { name: this.name, kind: this.kind, url: this.url, origin: this.origin, credential: this.credential ? this.credential.name : null, models: this.models, tiers: this.tiers || {} }; }
}

/* ---------- a gate of N slots (R12.13) ---------- */
export class Gate {
  declare n: number; declare busy: number; declare waiters: WaitingTicket[];
  constructor(n: number) { this.n = n; this.busy = 0; this.waiters = []; }
  /* A ticket: its promise resolves when a slot is free. cancel() is for a ticket whose holder will not use the
     slot (its thread was interrupted while it waited): it withdraws a ticket still waiting, and gives back a slot
     already granted, which nobody would release otherwise. */
  acquire(): GateTicket {
    if (this.busy < this.n) { this.busy++; let held = true; return { promise: Promise.resolve(), cancel: () => { if (held) { held = false; this.release(); } } }; }
    const t = {} as WaitingTicket; t.granted = false; t.promise = new Promise<void>(r => { t.resolve = r; }); this.waiters.push(t);
    t.cancel = () => { const i = this.waiters.indexOf(t); if (i >= 0) this.waiters.splice(i, 1); else if (t.granted) { t.granted = false; this.release(); } };
    return t;
  }
  release() { const w = this.waiters.shift(); if (w) { w.granted = true; w.resolve(); } else this.busy = Math.max(0, this.busy - 1); }
  get queued() { return this.waiters.length; }
}

/* ---------- the HTTP engine ---------- */
/* Body chunks of one response, consumed one promise at a time by the generator. */
class BodyQueue {
  declare items: string[]; declare waiter: (() => void) | null; declare ended: boolean; declare error: unknown;
  constructor() { this.items = []; this.waiter = null; this.ended = false; this.error = null; }
  push(x: string) { this.items.push(x); this.wake(); }
  end() { this.ended = true; this.wake(); }
  fail(e: unknown) { this.error = e; this.ended = true; this.wake(); }
  wake() { const w = this.waiter; if (w) { this.waiter = null; w(); } }
  /* Resolves to a string chunk, or null at the end; rejects on a stream error. */
  next(): Promise<string | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve(null);
    return new Promise<void>(r => { this.waiter = r; }).then(() => this.next());
  }
}
const sleep = (ms: number) => new Promise<void>(r => { const h = setTimeout(r, ms); h.unref(); });
const hostOf = (url: string) => { try { return new URL(url).host; } catch (e) { return '?'; } };
const retryAfterMs = (h: string | undefined): number | null => {
  if (!h) return null;
  const n = Number(h); if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(h); return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
};

/* The engine: a generator over Node's http/https, used by `http-request` and by the model calls. It yields
   S.Block while it waits, and never puts a header value in a message or a condition. */
export class Http {
  declare S: Scheme; declare log: Log;
  constructor(S: Scheme, log: Log) { this.S = S; this.log = log; }
  err(kind: string, msg: string, irritants: SchemeValue[] = []): SchemeValue { return new this.S.SchemeError(kind, msg, irritants); }
  /* Refuse what R14.4 and R15.4 forbid. */
  checkUrl(url: string, who: string): URL {
    let u: URL;
    try { u = new URL(url); } catch (e) { throw this.err('http-error', `${who}: not a URL: ${String(url).slice(0, 200)}`); }
    if (u.protocol === 'http:') { if (!LOOPBACK.has(u.hostname)) throw this.err('http-error', `${who}: plain http is allowed to loopback only (${u.host})`); }
    else if (u.protocol !== 'https:') throw this.err('http-error', `${who}: ${u.protocol} is not http or https`);
    return u;
  }
  /* Start one request; resolves to {status, headers, queue} once the response headers arrive. CTL.req holds
     the live request so the caller can destroy it when its thread is interrupted. */
  start(u: URL, { method, headers, body, ctl }: StartOptions): Promise<HttpStart> {
    return new Promise((resolve, reject) => {
      if (ctl.timedOut) { reject(this.err('timeout', `the request to ${u.host} passed its deadline`)); return; }
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const fail = (e: unknown) => { if (settled) return; settled = true; reject(e); };
      /* The condition for a connection that ends early: the thread's own cancel or deadline, else an HTTP error. */
      const reason = (what: string) => (ctl.timedOut ? this.err('timeout', `the request to ${u.host} passed its deadline`) : ctl.aborted ? this.err('cancelled', 'the request was cancelled') : this.err('http-error', what));
      const req = mod.request(u, { method, headers }, res => {
        settled = true;
        const q = new BodyQueue();
        res.setEncoding('utf8');
        res.on('data', d => q.push(d));
        res.on('end', () => q.end());
        res.on('close', () => { if (!res.complete) q.fail(reason(`the connection to ${u.host} closed before the response ended`)); });
        res.on('error', (e: NodeJS.ErrnoException) => q.fail(reason(`reading from ${u.host} failed: ${e.code || e.message}`)));
        ctl.res = res;
        resolve({ status: res.statusCode!, headers: res.headers, queue: q });
      });
      ctl.req = req;
      req.on('error', (e: NodeJS.ErrnoException) => fail(reason(`cannot reach ${u.host}: ${e.code || e.message}`)));
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }
  /* The request as a whole: redirects, the credential rule, the body read in chunks.
     OPTS: url, method, headers (object), body (string), credential (Credential|null), credentialHeader,
     credentialPrefix, timeoutMs, ctl (a Ctl), who, onResponse. ONCHUNK, if given, is a generator function or a
     function called with each body chunk as it arrives (then the returned body is ''); OPTS.onResponse(status,
     headers), if given, returns the chunk handler to use for this response (null reads the body whole). */
  *requestG(opts: HttpRequestOptions, onChunk?: ChunkHandler | null): Gen<HttpResult> {
    const S = this.S, who = opts.who || 'http-request';
    const ctl = opts.ctl;
    let url = String(opts.url), method = (opts.method || 'GET').toUpperCase(), body = opts.body;
    const cred = opts.credential || null;
    let u = this.checkUrl(url, who);
    if (cred) {
      if (!(cred instanceof Credential)) throw S.typeErr('credential', cred, who);
      if (u.origin !== cred.origin) throw this.err('credential-origin', `${who}: ${cred.__print()} is bound to ${cred.origin}, not ${u.origin}`, [cred]);
    }
    if (opts.timeoutMs) ctl.arm(opts.timeoutMs);
    try { return yield* this.hopsG(u, method, body, cred, opts, onChunk); }
    finally { ctl.disarm(); }
  }
  *hopsG(u: URL, method: string, body: string | undefined, cred: Credential | null, opts: HttpRequestOptions, onChunk: ChunkHandler | null | undefined): Gen<HttpResult> {
    const S = this.S, who = opts.who || 'http-request', ctl = opts.ctl;
    let bodyDropped = false;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(opts.headers || {})) headers[String(k).toLowerCase()] = String(v);
      if (bodyDropped) for (const k of BODY_HEADERS) delete headers[k];
      if (cred) {
        const secret = readSecret(cred);
        if (secret === null) throw this.err('user-error', `${who}: ${cred.__print()} is not available: no readable file ${cred.name} in the credentials directory (LoadCredential)`, [cred]);
        headers[String(opts.credentialHeader || 'authorization').toLowerCase()] = (opts.credentialPrefix === undefined ? (String(opts.credentialHeader || 'authorization').toLowerCase() === 'authorization' ? 'Bearer ' : '') : opts.credentialPrefix) + secret;
      }
      if (body !== undefined && body !== null && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const r: HttpStart = yield new S.Block(this.start(u, { method, headers, body, ctl }), `${who} ${u.host}`);
      if (REDIRECT_STATUS.has(r.status) && r.headers.location) {
        ctl.res!.resume();
        if (hop >= MAX_REDIRECTS) throw this.err('http-error', `${who}: too many redirects from ${hostOf(opts.url)}`);
        let next: URL;
        try { next = new URL(r.headers.location, u); } catch (e) { throw this.err('http-error', `${who}: a redirect from ${u.host} named no valid location`); }
        /* R14.4: with a credential attached a redirect may stay on the origin only. */
        if (cred && next.origin !== u.origin) throw this.err('credential-origin', `${who}: ${u.host} redirected to another origin (${next.host}) while ${cred.__print()} was attached; the request was not followed`, [cred]);
        u = this.checkUrl(next.href, who);
        if (r.status === 301 || r.status === 302 || r.status === 303) { if (method !== 'GET' && method !== 'HEAD') method = 'GET'; if (body !== undefined && body !== null) bodyDropped = true; body = undefined; }
        continue;
      }
      const handler = opts.onResponse ? opts.onResponse(r.status, r.headers) : onChunk;
      let text = '';
      for (;;) {
        const chunk: string | null = yield new S.Block(r.queue.next(), `${who} body from ${u.host}`);
        if (chunk === null) break;
        if (handler) { const v = handler(chunk); if (v && typeof v.next === 'function') yield* v; } else text += chunk;
      }
      ctl.req = null; ctl.res = null;
      return { status: r.status, headers: r.headers, body: text, url: u.href };
    }
  }
}
/* The live request of one requestG, so an interrupted thread can tear it down. */
export class Ctl {
  declare req: http.ClientRequest | null; declare res: http.IncomingMessage | null; declare timer: NodeJS.Timeout | null;
  declare aborted: boolean; declare timedOut: boolean;
  constructor() { this.req = null; this.res = null; this.timer = null; this.aborted = false; this.timedOut = false; }
  arm(ms: number) { this.disarm(); this.timer = setTimeout(() => { this.timedOut = true; if (this.req) { try { this.req.destroy(new Error('timeout')); } catch (e) { /* gone */ } } }, ms); this.timer.unref(); }
  disarm() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  destroy() { this.aborted = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } if (this.req) { try { this.req.destroy(); } catch (e) { /* gone */ } } this.req = null; this.res = null; }
}

/* ---------- SSE ---------- */
/* A line-oriented text/event-stream parser: ONDATA gets each data: payload (except [DONE]). */
export function sseParser(onData: (d: string) => void): SseParser {
  let buf = '';
  const line = (l: string) => { l = l.replace(/\r$/, ''); if (l.startsWith('data:')) { const d = l.slice(5).trim(); if (d && d !== '[DONE]') onData(d); } };
  return { push(chunk: string) { buf += chunk; let k; while ((k = buf.indexOf('\n')) >= 0) { line(buf.slice(0, k)); buf = buf.slice(k + 1); } }, end() { if (buf) { line(buf); buf = ''; } } };
}
const parseJSON = <T = unknown,>(s: string): T | null => { try { return JSON.parse(s); } catch (e) { return null; } };
/* An upstream error's message, short and without the request. */
const upstreamMessage = (status: number, text: string) => {
  const j = parseJSON<ProviderAnswer>(text);
  const m = j && (j.error && (j.error.message || j.error.type) || j.message);
  return `HTTP ${status}${m ? ': ' + String(m).slice(0, 300) : ''}`;
};

/* ---------- the module ---------- */
export class Models {
  declare server: Server; declare log: Log; declare L: Lisp; declare S: Scheme;
  declare cfg: ModelsConfig;
  declare credentials: Map<string, string | null>;
  declare backends: Map<string, Backend>;
  declare gate: Gate; declare http: Http; declare usageFile: string;
  declare streams: Map<string, SampleStream>;
  declare requests: Map<number, RequestRecord>;
  declare stopped: boolean;
  constructor(server: Server) {
    this.server = server; this.log = server.log; this.L = server.L; this.S = server.L.S;
    this.cfg = server.cfg.models && typeof server.cfg.models === 'object' ? server.cfg.models : {};
    this.credentials = new Map();                       // name -> origin (R14.4 binding)
    this.backends = new Map();                          // name -> Backend
    this.gate = new Gate(MAX_CONCURRENT);
    this.http = new Http(this.S, this.log);
    this.usageFile = path.join(server.cfg.stateDir, 'usage.jsonl');
    this.streams = new Map();                           // `${cid}/${sid}` -> a sample stream
    this.requests = new Map();                          // thread id -> {backend, model, tier, caller, startedAt}
    this.stopped = false;
  }

  /* ---------- configuration (R12.3, §15.2) ---------- */
  configure() {
    const c = this.cfg;
    const tiers: Tiers = c.tiers && typeof c.tiers === 'object' && Object.keys(c.tiers).length ? { ...c.tiers } : { ...DEFAULT_TIERS };
    for (const [bname, kind] of [['anthropic', 'anthropic'], ['openai', 'openai']] as const) {
      const b = c[bname];
      if (!b || typeof b !== 'object') { if (bname === 'anthropic') this.bindBackend(DEFAULT_BACKEND, kind, { baseUrl: DEFAULT_BASE_URL }, tiers); continue; }
      if (bname === 'openai' && !b.baseUrl) continue;      // unset means no such backend (§15.2)
      this.bindBackend(bname === 'anthropic' ? DEFAULT_BACKEND : bname, kind, b, tiers);
    }
    /* edit.credentials: more LoadCredential entries, each bound to an origin (R14.4). */
    for (const [nm, e] of Object.entries(c.credentials && typeof c.credentials === 'object' ? c.credentials : {})) {
      const origin = e && originOf(e.origin);
      if (CREDENTIAL_NAME.test(nm) && origin) this.credentials.set(nm, origin);
      else this.log.warn('models', { credential: nm, event: 'ignored', reason: 'bad name or origin' });
    }
  }
  bindBackend(bname: string, kind: BackendKind, b: ModelBackendConfig, tiers: Tiers) {
    const baseUrl = b.baseUrl || DEFAULT_BASE_URL;
    let credential = null;
    if (b.credential) {
      if (!CREDENTIAL_NAME.test(String(b.credential))) { this.log.warn('models', { backend: bname, event: 'ignored credential', reason: 'bad name' }); }
      else { this.credentials.set(String(b.credential), originOf(baseUrl)); credential = new Credential(String(b.credential), originOf(baseUrl)); }
    }
    const models = [...new Set(Object.values(tiers).map(String))];
    this.backends.set(bname, new Backend({ name: bname, kind, baseUrl, credential, models, tiers }));
  }
  /* (credential NAME): the handle, or a condition. */
  credential(nm: SchemeValue): Credential {
    const S = this.S;
    if (typeof nm !== 'string') throw S.typeErr('string', nm, 'credential');
    const origin = this.credentials.get(nm);
    if (!origin) throw new S.SchemeError('user-error', `credential: no credential named ${JSON.stringify(nm)} is configured (edit.json models or services.workbench.edit.credentials)`, []);
    return new Credential(nm, origin);
  }
  /* R12.4: a backend is usable with a readable credential, or with none on a loopback origin (a local server). */
  usable(b: Backend | null | undefined): boolean {
    if (!b) return false;
    if (b.credential) return readSecret(b.credential) !== null;
    return isLoopback(b.url);
  }
  backendNamed(x: SchemeValue, who = 'gptel'): Backend {
    if (x instanceof Backend) return x;
    const nm = x instanceof this.S.Sym ? x.name : typeof x === 'string' ? x : null;
    const b = nm ? this.backends.get(nm) : null;
    if (!b) throw new this.S.SchemeError('user-error', `${who}: no backend named ${nm === null ? this.S.write(x) : JSON.stringify(nm)} (gptel-backends lists them)`, []);
    return b;
  }
  currentBackend(): Backend | null {
    let nm: string | null = null;
    try { const v = this.L.get('gptel-backend'); nm = v instanceof this.S.Sym ? v.name : typeof v === 'string' ? v : null; } catch (e) { /* unbound */ }
    return (nm && this.backends.get(nm)) || this.backends.get(DEFAULT_BACKEND) || [...this.backends.values()][0] || null;
  }
  /* The backend a request may use now: the current one when usable, else a user-error naming what is missing (R12.4). */
  requireUsable(b: Backend, who: string): Backend {
    if (this.usable(b)) return b;
    const S = this.S;
    if (b.credential) throw new S.SchemeError('user-error', `${who}: backend ${b.name} has no usable credential: ${b.credential.__print()} is not loaded (services.workbench.edit.models or LoadCredential)`, []);
    throw new S.SchemeError('user-error', `${who}: backend ${b.name} at ${b.origin} has no credential and is not local`, []);
  }
  status() {
    const b = this.currentBackend();
    const on = this.usable(b);
    return { sample: on, models: on && b!.tiers ? { ...b!.tiers } : {}, modelRequests: this.requests.size, modelQueued: this.gate.queued };
  }

  /* ---------- one model request (shared by sample and gptel) ---------- */
  /* REQ: {model, tier, system, messages: [{role, content, images?}], tools: [{name, description, inputSchema}],
     maxTokens, effort, temperature, caller}. HOOKS: onText(full) (synchronous), onTextG(full) (a generator run
     between chunks, for Scheme callbacks) and toolG({callId, name, input}) (a generator returning the result
     string). Returns {text, truncated, model, tier, usage: {input, output}, rounds}. */
  *completeG(b: Backend, req: ModelRequest, hooks: ModelHooks): Gen<ModelResult> {
    const S = this.S;
    const ctl = new Ctl();
    const usage = { input: 0, output: 0 };
    const startedAt = Date.now();
    const t = this.server.threads ? this.server.threads.current : null;
    const rec: RequestRecord = { backend: b.name, model: req.model, tier: req.tier || null, caller: req.caller || 'gptel', startedAt };
    let text = '', truncated = false, rounds = 0, error: unknown = null;
    const ticket = this.gate.acquire();
    try { yield new S.Block(ticket.promise, 'a model slot'); } catch (e) { ticket.cancel(); throw e; }
    if (t) this.requests.set(t.id, rec);
    try {
      const msgs = this.messagesOf(b, req);
      const deadline = startedAt + REQUEST_DEADLINE_MS;
      for (rounds = 1; rounds <= MAX_TOOL_ROUNDS; rounds++) {
        const body = this.bodyOf(b, req, msgs);
        const r = yield* this.callG(b, body, ctl, deadline, usage, hooks, s => joinRounds(text, s));
        text = joinRounds(text, r.content);
        if (!r.calls.length) { truncated = !!r.truncated; break; }
        if (!hooks.toolG) { truncated = true; break; }
        this.pushAssistant(b, msgs, r);
        const results: ToolResult[] = [];
        for (const c of r.calls) results.push({ callId: c.id, result: yield* hooks.toolG({ callId: c.id, name: c.name, input: c.input }) });
        this.pushResults(b, msgs, results);
        if (rounds === MAX_TOOL_ROUNDS) truncated = true;
      }
      return { text, truncated, model: req.model, tier: req.tier, usage, rounds };
    } catch (e) { error = e; throw e; }
    finally {
      ctl.destroy();
      this.gate.release();
      if (t) this.requests.delete(t.id);
      this.account(rec, usage, Date.now() - startedAt, error);
    }
  }
  /* One HTTP call with the rate-limit retry (R12.13). Streamed text reaches HOOKS.onText at once and
     HOOKS.onTextG between two chunks (a blocking point of the thread); FULL maps a round's text to the whole. */
  *callG(b: Backend, body: ProviderBody, ctl: Ctl, deadline: number, usage: Usage, hooks: ModelHooks, full: (round: string) => string): Gen<ParsedRound> {
    const S = this.S;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: b.stream ? 'text/event-stream' : 'application/json', ...KINDS[b.kind].headers, ...b.headers };
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new S.SchemeError('timeout', `the model request to ${b.name} passed its ${REQUEST_DEADLINE_MS / 60000} min deadline`, []);
      let pending: string | null = null;
      const parse = this.parserOf(b, usage, content => { const t = full(content); pending = t; if (hooks.onText) hooks.onText(t); });
      const sse = sseParser(parse.event);
      const flushG = function* () { if (pending !== null && hooks.onTextG) { const t = pending; pending = null; yield* hooks.onTextG(t); } pending = null; };
      let streaming = false;
      const r = yield* this.http.requestG({
        url: b.url, method: 'POST', headers, body: JSON.stringify(body), credential: b.credential, credentialHeader: KINDS[b.kind].header, credentialPrefix: KINDS[b.kind].prefix, timeoutMs: remaining, ctl, who: `gptel ${b.name}`,
        onResponse: (status, h) => { streaming = status >= 200 && status < 300 && /text\/event-stream/.test(String(h['content-type'] || '')); return streaming ? function* (chunk: string) { sse.push(chunk); yield* flushG(); } : null; },
      });
      if (streaming) { sse.end(); yield* flushG(); return parse.result(); }
      if (r.status >= 200 && r.status < 300) { parse.whole(parseJSON<ProviderAnswer>(r.body)); yield* flushG(); return parse.result(); }
      if (RETRY_STATUS.has(r.status) && attempt + 1 < RETRY_ATTEMPTS) {
        const wait = Math.min(retryAfterMs(r.headers['retry-after']) ?? 1000 * 2 ** attempt, Math.max(0, deadline - Date.now()));
        this.log.info('model', { backend: b.name, event: 'retry', status: r.status, attempt: attempt + 1, waitMs: wait });
        yield new S.Block(sleep(wait), 'a retry');
        continue;
      }
      throw new S.SchemeError('http-error', `${b.name}: ${upstreamMessage(r.status, r.body)}`, [r.status]);
    }
  }
  /* The conversation in the provider's shape. REQ.messages are {role: user|assistant|system, content, images}. */
  messagesOf(b: Backend, req: ModelRequest): ProviderMessage[] {
    const out: ProviderMessage[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const parts: ContentPart[] = [];
      if (typeof m.content === 'string' && m.content) parts.push({ type: 'text', text: m.content });
      for (const im of m.images || []) {
        if (!im || typeof im.data !== 'string') continue;
        const mt = typeof im.media_type === 'string' ? im.media_type : 'image/png';
        parts.push(b.kind === 'anthropic' ? { type: 'image', source: { type: 'base64', media_type: mt, data: im.data } } : { type: 'image_url', image_url: { url: `data:${mt};base64,${im.data}` } });
      }
      const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts.length ? parts : '';
      const last = out[out.length - 1];
      if (b.kind === 'anthropic' && last && last.role === m.role && typeof last.content === 'string' && typeof content === 'string') last.content += '\n\n' + content;
      else out.push({ role: m.role, content });
    }
    if (b.kind === 'anthropic' && (!out.length || out[out.length - 1].role !== 'user')) out.push({ role: 'user', content: 'Continue.' });
    return out;
  }
  bodyOf(b: Backend, req: ModelRequest, msgs: ProviderMessage[]): ProviderBody {
    const system = req.messages.filter(m => m.role === 'system').map(m => m.content).concat(req.system ? [req.system] : []).filter(Boolean).join('\n\n');
    const tools = Array.isArray(req.tools) && req.tools.length ? req.tools : null;
    if (b.kind === 'anthropic') {
      const body: ProviderBody = { model: req.model, max_tokens: req.maxTokens || 4096, messages: msgs, stream: b.stream };
      if (system) body.system = system;
      if (tools) body.tools = tools.map(t => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } }));
      if (typeof req.temperature === 'number') body.temperature = req.temperature;
      if (req.effort) body.output_config = { effort: req.effort };
      return body;
    }
    const body: ProviderBody = { model: req.model, messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs, stream: b.stream };
    if (b.stream) body.stream_options = { include_usage: true };
    if (tools) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
    if (req.maxTokens) body.max_completion_tokens = req.maxTokens;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (req.effort) body.reasoning_effort = req.effort;
    return body;
  }
  /* The SSE and whole-body readers of each kind. Both give {content, calls: [{id, name, input}], truncated}. */
  parserOf(b: Backend, usage: Usage, onDelta: (content: string) => void): Parser {
    let content = '', stop: string | null | undefined = null; const blocks: (RoundBlock | undefined)[] = [], calls: ToolCall[] = [];
    const addText = (s: string | undefined) => { if (!s) return; content += s; onDelta(content); };
    if (b.kind === 'anthropic') {
      return {
        event: d => {
          const j = parseJSON<AnthropicEvent>(d); if (!j) return;
          switch (j.type) {
            case 'message_start': if (j.message && j.message.usage) usage.input += j.message.usage.input_tokens || 0; break;
            case 'content_block_start': blocks[j.index] = { type: j.content_block.type, id: j.content_block.id, name: j.content_block.name, text: j.content_block.text || '', json: '' }; if (j.content_block.type === 'text' && j.content_block.text) addText(j.content_block.text); break;
            case 'content_block_delta': { const bl = blocks[j.index] || (blocks[j.index] = { type: 'text', text: '', json: '' }); if (j.delta.type === 'text_delta') { bl.text! += j.delta.text; addText(j.delta.text); } else if (j.delta.type === 'input_json_delta') bl.json! += j.delta.partial_json; break; }
            case 'message_delta': if (j.delta && j.delta.stop_reason) stop = j.delta.stop_reason; if (j.usage) usage.output += j.usage.output_tokens || 0; break;
            case 'error': throw new this.S.SchemeError('http-error', `${b.name}: ${j.error && j.error.message || 'stream error'}`, []);
            default: break;
          }
        },
        whole: j => {
          if (!j) throw new this.S.SchemeError('http-error', `${b.name}: unreadable answer`, []);
          if (j.type === 'error') throw new this.S.SchemeError('http-error', `${b.name}: ${j.error && j.error.message || 'error'}`, []);
          stop = j.stop_reason; if (j.usage) { usage.input += j.usage.input_tokens || 0; usage.output += j.usage.output_tokens || 0; }
          for (const c of j.content || []) { if (c.type === 'text') { blocks.push({ type: 'text', text: c.text }); addText(c.text); } else if (c.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, json: JSON.stringify(c.input || {}) }); }
        },
        result: () => {
          for (const x of blocks) if (x && x.type === 'tool_use') calls.push({ id: x.id || `call_${calls.length}`, name: x.name!, input: parseJSON(x.json || '{}') || {} });
          return { content, calls: stop === 'tool_use' || calls.length ? calls : [], truncated: stop === 'max_tokens', blocks };
        },
      };
    }
    let finish: string | null = null; const tc: { id: string; name: string; args: string }[] = [];
    return {
      event: d => {
        const j = parseJSON<OpenAIChunk>(d); if (!j) return;
        if (j.error) throw new this.S.SchemeError('http-error', `${b.name}: ${j.error.message || 'stream error'}`, []);
        if (j.usage) { usage.input += j.usage.prompt_tokens || 0; usage.output += j.usage.completion_tokens || 0; }
        const ch = j.choices && j.choices[0]; if (!ch) return;
        if (ch.finish_reason) finish = ch.finish_reason;
        const delta = ch.delta || ch.message || {};
        if (typeof delta.content === 'string') addText(delta.content);
        for (const c of delta.tool_calls || []) { const i = typeof c.index === 'number' ? c.index : tc.length; const x = tc[i] || (tc[i] = { id: '', name: '', args: '' }); if (c.id) x.id += c.id; if (c.function) { if (c.function.name) x.name += c.function.name; if (c.function.arguments) x.args += c.function.arguments; } }
      },
      whole: j => {
        if (!j) throw new this.S.SchemeError('http-error', `${b.name}: unreadable answer`, []);
        if (j.error) throw new this.S.SchemeError('http-error', `${b.name}: ${j.error.message || 'error'}`, []);
        if (j.usage) { usage.input += j.usage.prompt_tokens || 0; usage.output += j.usage.completion_tokens || 0; }
        const ch = j.choices && j.choices[0]; if (!ch) return;
        finish = ch.finish_reason || null;
        const m = ch.message || {};
        if (typeof m.content === 'string') addText(m.content);
        for (const c of m.tool_calls || []) tc.push({ id: c.id || '', name: c.function && c.function.name || '', args: c.function && c.function.arguments || '' });
      },
      result: () => {
        for (const x of tc) if (x) calls.push({ id: x.id || `call_${calls.length}`, name: x.name, input: parseJSON(x.args || '{}') || {}, args: x.args });
        return { content, calls, truncated: finish === 'length' };
      },
    };
  }
  pushAssistant(b: Backend, msgs: ProviderMessage[], r: ParsedRound) {
    if (b.kind === 'anthropic') {
      const content: ContentPart[] = [];
      for (const x of r.blocks || []) { if (!x) continue; if (x.type === 'text' && x.text) content.push({ type: 'text', text: x.text }); else if (x.type === 'tool_use') content.push({ type: 'tool_use', id: x.id, name: x.name, input: parseJSON(x.json || '{}') || {} }); }
      msgs.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: r.content || '' }] });
    } else msgs.push({ role: 'assistant', content: r.content || null, tool_calls: r.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || JSON.stringify(c.input || {}) } })) });
  }
  pushResults(b: Backend, msgs: ProviderMessage[], results: ToolResult[]) {
    if (b.kind === 'anthropic') msgs.push({ role: 'user', content: results.map(x => ({ type: 'tool_result', tool_use_id: x.callId, content: String(x.result) })) });
    else for (const x of results) msgs.push({ role: 'tool', tool_call_id: x.callId, content: String(x.result) });
  }

  /* ---------- accounting (R12.14, R15.10) ---------- */
  account(rec: RequestRecord, usage: Usage, latencyMs: number, error: unknown) {
    const line: UsageLine = { at: new Date().toISOString(), backend: rec.backend, model: rec.model, tier: rec.tier, inputTokens: usage.input, outputTokens: usage.output, latencyMs, caller: rec.caller };
    if (error) line.error = this.codeOf(error);
    this.log.info('model', line);
    try { fs.appendFileSync(this.usageFile, JSON.stringify(line) + '\n', { mode: 0o600 }); } catch (e) { this.log.warn('models', { usage: 'append failed', error: e.message }); }
  }
  /* The last DAYS days of usage.jsonl, summed. */
  usage(days = USAGE_DAYS): UsageSummary {
    const since = Date.now() - days * 86400000;
    const out: UsageSummary = { days, since: new Date(since).toISOString(), requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, byModel: {}, byCaller: {}, byBackend: {} };
    let text = '';
    try { text = fs.readFileSync(this.usageFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return out; }
    for (const l of text.split('\n')) {
      if (!l) continue;
      const j = parseJSON<UsageLine>(l); if (!j || !j.at || Date.parse(j.at) < since) continue;
      out.requests++; if (j.error) out.errors++;
      out.inputTokens += j.inputTokens || 0; out.outputTokens += j.outputTokens || 0; out.latencyMs += j.latencyMs || 0;
      for (const [k, key] of [['byModel', j.model], ['byCaller', j.caller], ['byBackend', j.backend]] as const) {
        const m = out[k][key || '?'] || (out[k][key || '?'] = { requests: 0, inputTokens: 0, outputTokens: 0 });
        m.requests++; m.inputTokens += j.inputTokens || 0; m.outputTokens += j.outputTokens || 0;
      }
    }
    return out;
  }
  /* A condition's code for the wire and the usage log; never its irritants. */
  codeOf(e: any): string { // any: a condition of the evaluator, or whatever else was thrown
    const S = this.S;
    if (e instanceof S.Unwind) return 'cancelled';
    if (e instanceof S.SchemeError) {
      if (e.kind === 'cancelled' || e.kind === 'quit') return 'cancelled';
      if (e.kind === 'timeout') return 'timeout';
      if (e.kind === 'user-error') return 'sampling_disabled';
      if (e.kind === 'credential-origin') return 'credential_origin';
      if (e.kind === 'http-error') return 'upstream_error';
      return 'error';
    }
    return 'error';
  }
  messageOf(e: any): string { // any: a condition of the evaluator, or whatever else was thrown
    const S = this.S;
    if (e instanceof S.Unwind) return 'cancelled';
    if (e instanceof S.SchemeError) return S.errorMessage(e);
    return e && e.message ? e.message : String(e);
  }

  /* ---------- sample for the board (§12.2) ---------- */
  /* The request of a board sample: INPUT is a string or a list of {role, content}; IMAGES go on the last user
     message (crates/wb-web/src/sample.rs forwards input, modelTier, model, effort, images, tools as sent). */
  sampleRequest(b: Backend, msg: WireMessage): ModelRequest {
    const { input, images, tools, effort } = msg;
    let messages: ChatMessage[];
    if (typeof input === 'string') messages = [{ role: 'user', content: input }];
    else if (Array.isArray(input)) messages = input.filter(m => m && typeof m === 'object' && typeof m.role === 'string').map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }));
    else throw new ProtoError('bad_request', 'sample.input is a string or a list of messages');
    if (!messages.length) throw new ProtoError('bad_request', 'sample.input is empty');
    if (Array.isArray(images) && images.length) {
      let i = messages.length - 1; while (i >= 0 && messages[i].role !== 'user') i--;
      if (i < 0) { messages.push({ role: 'user', content: '' }); i = messages.length - 1; }
      messages[i] = { ...messages[i], images: images.filter(x => x && typeof x === 'object' && typeof x.data === 'string') };
    }
    const { model, tier } = b.resolve(msg.modelTier, msg.model);
    return { model, tier, messages, tools: Array.isArray(tools) ? tools.filter(t => t && typeof t.name === 'string') : [], effort: typeof effort === 'string' && effort ? effort : null, caller: 'board' };
  }
  streamKey(client: Client, sid: string): string { return `${client.cid}/${sid}`; }
  onSample(client: Client, msg: WireMessage) {
    const S = this.S;
    const sid = msg.sid;
    if (typeof sid !== 'string' || !sid) throw new ProtoError('bad_request', 'sample needs a sid');
    const fail = (code: string, message: string, text?: string) => { const m: SampleError = { t: 'sample.error', sid, code, message }; if (text) m.text = text; client.send(m); };
    /* §7.9: streams are routed only for wb-web, the one client that can deliver them to a tab. */
    if (client.kind !== 'web') { fail('bad_request', 'sample streams are routed for web clients only'); return; }
    if (this.streams.has(this.streamKey(client, sid))) { fail('bad_request', `stream ${sid} is already running`); return; }
    const b = this.currentBackend();
    if (!this.usable(b)) { fail('sampling_disabled', b && b.credential ? `no language model: ${b.credential.__print()} is not loaded` : 'no language model is configured'); return; }
    if (Buffer.byteLength(JSON.stringify(msg.input ?? '')) + Buffer.byteLength(JSON.stringify(msg.images ?? [])) > MAX_PROMPT_BYTES) { fail('too_large', `the prompt is over ${MAX_PROMPT_BYTES >> 20} MiB`); return; }
    let req: ModelRequest;
    try { req = this.sampleRequest(b!, msg); } catch (e) { fail('bad_request', e.message); return; }
    const stream: SampleStream = { sid, client, tab: typeof msg.tab === 'string' ? msg.tab : null, text: '', pending: new Map(), ended: false, thread: null };
    const key = this.streamKey(client, sid);
    this.streams.set(key, stream);
    const self = this;
    const send = (m: WireMessage) => { if (!stream.ended && !client.closed) client.send(m); };
    const cancelled = () => new S.SchemeError('cancelled', 'the sample was cancelled', []);
    stream.thread = this.server.threads.spawn(function* () {
      try {
        const r = yield* self.completeG(b!, req, {
          onText: full => { if (client.closed) throw cancelled(); if (full !== stream.text) { stream.text = full; send({ t: 'sample.text', sid, text: full }); } },
          /* R12.5: the tool runs in the tab that asked; the thread waits for its tool_result or tool_error. */
          *toolG(call: ToolCallRequest) {
            if (client.closed) throw cancelled();
            const p = new Promise<ToolAnswer>((resolve, reject) => { stream.pending.set(call.callId, { resolve, reject }); });
            send({ t: 'sample.tool', sid, callId: call.callId, name: call.name, input: call.input });
            const a: ToolAnswer = yield new S.Block(p, `tool ${call.name} in the tab`);
            return a.error !== undefined ? `Error: ${a.error}` : (typeof a.result === 'string' ? a.result : JSON.stringify(a.result ?? ''));
          },
        });
        send({ t: 'sample.done', sid, text: r.text, truncated: r.truncated, modelTierApplied: r.tier, modelApplied: r.model });
      } catch (e) {
        const m: SampleError = { t: 'sample.error', sid, code: self.codeOf(e), message: self.messageOf(e) };
        if (stream.text) m.text = stream.text;
        send(m);
      } finally { stream.ended = true; self.streams.delete(key); }
    }, { kind: 'background', name: `sample ${sid}`, by: { kind: 'web', cid: client.cid, device: client.device, tab: stream.tab }, debugOnError: false });
  }
  onToolAnswer(client: Client, msg: WireMessage) {
    const s = this.streams.get(this.streamKey(client, typeof msg.sid === 'string' ? msg.sid : ''));
    if (!s || typeof msg.callId !== 'string') return;
    const p = s.pending.get(msg.callId); if (!p) return;
    s.pending.delete(msg.callId);
    if (msg.t === 'tool_error') p.resolve({ error: typeof msg.message === 'string' ? msg.message : 'tool error' });
    else p.resolve({ result: msg.result === undefined ? '' : msg.result });
  }
  /* R12.8: cancel aborts the HTTP request (the thread is interrupted at its wait and tears it down). */
  onCancel(client: Client, msg: WireMessage) {
    const s = this.streams.get(this.streamKey(client, typeof msg.sid === 'string' ? msg.sid : ''));
    if (!s || !s.thread) return;
    s.thread.interrupt(new this.S.SchemeError('cancelled', 'the sample was cancelled', []));
  }
  limits() { const b = this.currentBackend(); return { maxPromptBytes: MAX_PROMPT_BYTES, images: !!(b && b.images), tools: true }; }

  /* ---------- Scheme (models.scm builds on these) ---------- */
  /* A request alist from Scheme: ((prompt . "…") | (messages . (((role . "user") (content . "…")) …))
     (system . "…") (model . "…") (tier . quick) (max-tokens . n) (effort . "low") (temperature . x) (caller . "gptel")). */
  requestOf(b: Backend, alist: SchemeValue, who: string): ModelRequest {
    const S = this.S;
    const o: Record<string, SchemeValue> = {};
    for (const p of S.arr(alist)) { if (!(p instanceof S.Pair) || !(p.car instanceof S.Sym)) throw new S.SchemeError('wrong-type-argument', `${who}: a request is an alist with symbol keys`, [alist]); o[p.car.name] = p.cdr; }
    const strOrNull = (v: SchemeValue): string | null => v === undefined || v === false ? null : v instanceof S.Sym ? v.name : typeof v === 'string' ? v : null;
    let messages: ChatMessage[] = [];
    if (typeof o.prompt === 'string') messages.push({ role: 'user', content: o.prompt });
    if (o.messages !== undefined && o.messages !== false) {
      for (const m of S.arr(o.messages)) {
        const mo: Record<string, SchemeValue> = {}; for (const p of S.arr(m)) if (p instanceof S.Pair && p.car instanceof S.Sym) mo[p.car.name] = p.cdr;
        const role = strOrNull(mo.role), content = typeof mo.content === 'string' ? mo.content : null;
        if (role && content !== null) messages.push({ role, content });
      }
    }
    if (!messages.length) throw new S.SchemeError('user-error', `${who}: nothing to send`, []);
    const { model, tier } = b.resolve(strOrNull(o.tier) || 'default', strOrNull(o.model));
    const req: ModelRequest = { model, tier, messages, tools: [], caller: strOrNull(o.caller) || 'gptel' };
    if (typeof o.system === 'string' && o.system) req.system = o.system;
    if (typeof o['max-tokens'] === 'number') req.maxTokens = o['max-tokens'];
    if (typeof o.temperature === 'number') req.temperature = o.temperature;
    const effort = strOrNull(o.effort); if (effort) req.effort = effort;
    return req;
  }
  resultAlist(r: ModelResult): SchemeValue {
    return jsonToScheme(this.S, { text: r.text, truncated: r.truncated, model: r.model, tier: r.tier, 'input-tokens': r.usage.input, 'output-tokens': r.usage.output, rounds: r.rounds });
  }

  /* ---------- install ---------- */
  install() {
    const { server, L, S } = this;
    this.configure();
    server.statusProviders.push(() => this.status());
    server.onMessage('sample', (client, msg) => this.onSample(client, msg));
    server.onMessage('tool_result', (client, msg) => this.onToolAnswer(client, msg));
    server.onMessage('tool_error', (client, msg) => this.onToolAnswer(client, msg));
    server.onMessage('cancel', (client, msg) => this.onCancel(client, msg));
    /* `call{cmd: "sample-limits"}` (§12.2, crates/wb-web/src/sample.rs limits()). */
    server.defineCommand('sample-limits', () => ({ value: this.limits() }));
    server.defineCommand('model-usage', (client, args) => { const d = Array.isArray(args) && Number.isInteger(args[0]) && (args[0] as number) > 0 ? args[0] as number : USAGE_DAYS; return { value: this.usage(d) }; });
    server.defineCommand('model-backends', () => ({ value: [...this.backends.values()].map(b => ({ ...b.info(), usable: this.usable(b) })) }));
    this.definePrimitives();
    L.defvar('gptel-tiers', jsonToScheme(S, (this.backends.get(DEFAULT_BACKEND) || { tiers: DEFAULT_TIERS }).tiers || DEFAULT_TIERS), 'Alist of tier name to model for the default backend (R12.6).');
    L.defvar('gptel-backend', DEFAULT_BACKEND, 'Name of the backend gptel uses.');
    L.evalText(fs.readFileSync(SCM_FILE, 'utf8'));
    /* The frame-side default names no server backend: point gptel at the configured one (R12.3). */
    const cur = L.get('gptel-backend');
    if (!this.backends.has(cur instanceof S.Sym ? cur.name : String(cur))) L.set('gptel-backend', DEFAULT_BACKEND);
    this.log.info('models', { backends: [...this.backends.keys()], credentials: [...this.credentials.keys()], sample: this.status().sample, credentialsDirectory: !!credentialsDirectory() });
  }
  definePrimitives() {
    const { server, L, S } = this, self = this;
    const D = (nm: string, args: string, doc: string, fn: PrimFn, gen?: PrimGen) => { const f = L.D(nm, args, doc, fn); f.where = 'server'; if (gen) f.gen = gen; return f; };
    const blocking = (nm: string, args: string, doc: string, gen: PrimGen) => D(nm, args, doc, () => { throw new S.SchemeError('cannot-block', `${nm}: cannot wait here`, []); }, gen);
    /* Keyword arguments as an object; symbol values become strings, lists arrays. */
    const keys = (args: SchemeValue[], who: string): Record<string, SchemeValue> => {
      const o: Record<string, SchemeValue> = {};
      for (let i = 0; i < args.length; i += 2) {
        const k = args[i];
        if (!(k instanceof S.Sym) || k.name[0] !== ':') throw new S.SchemeError('wrong-type-argument', `${who}: expected a keyword, got ${S.write(k)}`, [k]);
        if (i + 1 >= args.length) throw new S.SchemeError('wrong-number-of-arguments', `${who}: ${k.name} needs a value`, []);
        o[k.name.slice(1)] = args[i + 1];
      }
      return o;
    };
    const alistToObj = (v: SchemeValue, who: string): Record<string, string> => { const o: Record<string, string> = {}; if (v === undefined || v === false) return o; for (const p of S.arr(v)) { if (!(p instanceof S.Pair)) throw new S.SchemeError('wrong-type-argument', `${who}: expected an alist`, [v]); o[p.car instanceof S.Sym ? p.car.name : S.str(p.car, who)] = p.cdr instanceof S.Sym ? p.cdr.name : typeof p.cdr === 'string' ? p.cdr : S.write(p.cdr); } return o; };

    /* Credentials (R14.7, R16.15). */
    D('credential', 'name', 'The opaque handle for the credential file NAME in $CREDENTIALS_DIRECTORY, bound to its backend\'s origin (R14.7). Prints as #<credential NAME>; only http-request can use it, as a request header.', ([nm]) => this.credential(nm));
    D('credential?', 'x', '#t if X is a credential handle.', ([x]) => x instanceof Credential);
    D('credential-name', 'credential', 'The name of CREDENTIAL (never its contents).', ([c]) => { if (!(c instanceof Credential)) throw S.typeErr('credential', c, 'credential-name'); return c.name; });
    D('credential-origin', 'credential', 'The origin CREDENTIAL is bound to.', ([c]) => { if (!(c instanceof Credential)) throw S.typeErr('credential', c, 'credential-origin'); return c.origin; });
    D('credential-available?', 'credential', '#t if the file behind CREDENTIAL is loaded and readable.', ([c]) => { if (!(c instanceof Credential)) throw S.typeErr('credential', c, 'credential-available?'); return readSecret(c) !== null; });
    D('credential-names', '', 'The configured credential names.', () => S.listOf([...this.credentials.keys()]));

    /* http-request (R14.4). */
    blocking('http-request', 'url [:method m] [:headers alist] [:body string] [:credential c] [:credential-header name] [:timeout secs] [:on-chunk proc]',
      'An HTTPS request (plain http to loopback only); an alist ((status . n) (headers . alist) (body . string) (url . final-url)). A credential is sent only to its own origin, as the header :credential-header (default authorization, with Bearer); a cross-origin redirect fails the request while a credential is attached. With :on-chunk, PROC gets each body chunk as it arrives and body is "".',
      function* ([url, ...rest]: SchemeValue[]) {
        const o = keys(rest, 'http-request');
        const ctl = new Ctl();
        const onChunk = o['on-chunk'] !== undefined && o['on-chunk'] !== false ? S.proc(o['on-chunk'], 'http-request') : null;
        const timeout = o.timeout === undefined || o.timeout === false ? REQUEST_DEADLINE_MS : S.num(o.timeout, 'http-request') * 1000;
        try {
          const r = yield* self.http.requestG({
            url: S.str(url, 'http-request'), method: o.method === undefined ? 'GET' : (o.method instanceof S.Sym ? o.method.name : S.str(o.method, 'http-request')),
            headers: alistToObj(o.headers, 'http-request'), body: o.body === undefined || o.body === false ? undefined : S.str(o.body, 'http-request'),
            credential: o.credential === undefined || o.credential === false ? null : o.credential,
            credentialHeader: o['credential-header'] === undefined ? undefined : S.str(o['credential-header'], 'http-request'),
            timeoutMs: timeout, ctl, who: 'http-request',
          }, onChunk ? function* (chunk: string) { yield* S.applyG(onChunk, [chunk]); } : null);
          return S.listOf([S.cons(S.intern('status'), r.status), S.cons(S.intern('headers'), S.listOf(Object.entries(r.headers).map(([k, v]) => S.cons(k, Array.isArray(v) ? v.join(', ') : String(v))))), S.cons(S.intern('body'), r.body), S.cons(S.intern('url'), r.url)]);
        } finally { ctl.destroy(); }
      });

    /* Backends. */
    D('%make-backend', 'name kind . keys', 'Define backend NAME of KIND (anthropic or openai): :key (a credential or #f) :host :protocol :endpoint :url :models :tiers :headers :stream. Returns the backend.', ([nm, kind, ...rest]: SchemeValue[]) => {
      const who = 'gptel-make-backend';
      const bname = nm instanceof S.Sym ? nm.name : S.str(nm, who);
      const k = kind instanceof S.Sym ? kind.name : S.str(kind, who);
      if (!KINDS[k as BackendKind]) throw new S.SchemeError('user-error', `${who}: kind is anthropic or openai, not ${k}`, []);
      const o = keys(rest, who);
      let url: string | null = typeof o.url === 'string' ? o.url : null;
      if (!url) {
        const host = typeof o.host === 'string' && o.host ? o.host : (k === 'anthropic' ? new URL(DEFAULT_BASE_URL).host : null);
        if (!host) throw new S.SchemeError('user-error', `${who}: an openai backend needs :host or :url`, []);
        const base = /^https?:\/\//.test(host) ? host : `${typeof o.protocol === 'string' ? o.protocol : (o.protocol instanceof S.Sym ? o.protocol.name : 'https')}://${host}`;
        url = new URL(typeof o.endpoint === 'string' ? o.endpoint : KINDS[k as BackendKind].endpoint, base.endsWith('/') ? base : base + '/').href;
      }
      self.http.checkUrl(url, who);
      let credential: Credential | null = null;
      if (o.key !== undefined && o.key !== false) {
        if (typeof o.key === 'string') throw new S.SchemeError('user-error', `${who}: :key takes a (credential NAME) handle, never a string (R12.2)`, []);
        if (!(o.key instanceof Credential)) throw S.typeErr('credential', o.key, who);
        if (o.key.origin !== originOf(url)) throw new S.SchemeError('credential-origin', `${who}: ${o.key.__print()} is bound to ${o.key.origin}, not ${originOf(url)}`, [o.key]);
        credential = o.key;
      }
      const models = o.models === undefined || o.models === false ? [] : S.arr(o.models).map((x: SchemeValue) => x instanceof S.Sym ? x.name : S.str(x, who));
      const tiers = o.tiers === undefined || o.tiers === false ? null : alistToObj(o.tiers, who);
      const b = new Backend({ name: bname, kind: k, url, credential, models: models.length ? models : Object.values(tiers || {}), tiers, headers: alistToObj(o.headers, who), stream: o.stream === undefined ? true : S.truthy(o.stream) });
      self.backends.set(bname, b);
      return b;
    });
    D('%backend', 'name-or-backend', 'The backend named NAME, or a user-error.', ([x]) => this.backendNamed(x));
    D('%backends', '', 'The names of the defined backends.', () => S.listOf([...this.backends.keys()]));
    D('gptel-backend?', 'x', '#t if X is a backend object.', ([x]) => x instanceof Backend);
    D('%backend-info', 'name-or-backend', 'An alist describing the backend: name kind url origin credential (its name) models tiers usable.', ([x]) => { const b = this.backendNamed(x); return jsonToScheme(S, { ...b.info(), usable: this.usable(b) }); });
    D('%backend-usable?', 'name-or-backend', '#t when the backend can be used now (R12.4).', ([x]) => this.usable(this.backendNamed(x)));
    D('%current-backend', '', 'The backend gptel-backend names, or the default.', () => this.currentBackend() || false);

    /* One request on the calling thread (blocking): the Scheme callback runs between chunks, at a blocking point. */
    blocking('%model-request', 'backend request [on-text]', 'Run REQUEST (an alist: prompt or messages, system, model, tier, max-tokens, effort, temperature, caller) on BACKEND, waiting for the answer; ON-TEXT gets the cumulative text as it streams. Returns an alist (text truncated model tier input-tokens output-tokens rounds).',
      function* ([bx, alist, onText]: SchemeValue[]) {
        const b = self.requireUsable(self.backendNamed(bx, 'gptel'), 'gptel');
        const req = self.requestOf(b, alist, 'gptel');
        const cb = onText === undefined || onText === false ? null : S.proc(onText, '%model-request');
        const r = yield* self.completeG(b, req, { onTextG: cb ? function* (t) { yield* S.applyG(cb, [t]); } : null });
        return self.resultAlist(r);
      });
    /* The same on a new background thread attributed to the agent gptel:<backend> (R12.9); returns the thread. */
    D('%model-stream', 'backend request on-text on-done on-error', 'Start REQUEST on BACKEND on a background thread whose edits are attributed to the agent "gptel:<backend>". ON-TEXT gets the cumulative text as it streams, ON-DONE the result alist, ON-ERROR the condition. Returns the thread.', ([bx, alist, onText, onDone, onError]: SchemeValue[]) => {
      const b = self.requireUsable(self.backendNamed(bx, 'gptel'), 'gptel');
      const req = self.requestOf(b, alist, 'gptel');
      const cb = onText === undefined || onText === false ? null : S.proc(onText, '%model-stream');
      const done = onDone === undefined || onDone === false ? null : S.proc(onDone, '%model-stream');
      const fail = onError === undefined || onError === false ? null : S.proc(onError, '%model-stream');
      return server.threads.spawn(function* () {
        try {
          const r = yield* self.completeG(b, req, { onTextG: cb ? function* (t) { yield* S.applyG(cb, [t]); } : null });
          if (done) yield* S.applyG(done, [self.resultAlist(r)]);
          return r.text;
        } catch (e) {
          if (fail && !(e instanceof S.Unwind)) { yield* S.applyG(fail, [e instanceof S.SchemeError ? e : new S.SchemeError('error', self.messageOf(e), [])]); return false; }
          throw e;
        }
      }, { kind: 'background', name: `gptel ${b.name}`, by: { kind: 'agent', agent: `gptel:${b.name}` }, debugOnError: false });
    });
    /* The usage summary with Scheme-style keys: ((days . 30) (requests . n) (input-tokens . n) (by-model . ((name . ((requests . n) ...)))) ...). */
    const kebab = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    const usageAlist = (u: UsageSummary) => { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(u)) { if (k.startsWith('by')) { const g: Record<string, Record<string, unknown>> = {}; for (const [nm, row] of Object.entries(v as Record<string, UsageRow>)) { const r: Record<string, unknown> = {}; for (const [rk, rv] of Object.entries(row)) r[kebab(rk)] = rv; g[nm] = r; } o[kebab(k)] = g; } else o[kebab(k)] = v; } return jsonToScheme(S, o); };
    D('%model-usage', '[days]', 'The usage of the last DAYS days (default 30) as an alist (R12.14): days since requests errors input-tokens output-tokens latency-ms by-model by-caller by-backend.', ([d]: SchemeValue[]) => usageAlist(this.usage(d === undefined || d === false ? USAGE_DAYS : S.num(d, 'model-usage'))));
    D('%model-requests', '', 'The model requests running now, as alists.', () => S.listOf([...this.requests.values()].map(r => jsonToScheme(S, { ...r, runningMs: Date.now() - r.startedAt }))));
  }
  shutdown() {
    this.stopped = true;
    for (const s of this.streams.values()) { s.ended = true; if (s.thread) s.thread.interrupt(new this.S.SchemeError('cancelled', 'edwind is stopping', [])); }
    this.streams.clear();
  }
}
const joinRounds = (a: string, b: string) => (a && b ? a + '\n\n' + b : a || b || '');

export async function install(server: Server) {
  const m = new Models(server);
  server.models = m;
  m.install();
}
export async function shutdown(server: Server) { if (server.models) server.models.shutdown(); }
