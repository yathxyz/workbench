import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { state, until, watchErrors } from './shared.mts';

const PORT = 18443;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const EXIT_HUB = 'the Workbench hub restarted';   // app.js EXIT_TEXT.hub_restart
export const MEDIA: { path: string; body: string }[] = [];

// The harness's stdout is JSON lines: the info line first, then one {event, what} per control line sent to its stdin.
/* The harness's info line (harness.py info()) and its answers to control lines. */
interface UiHarnessInfo { web: string; caddy: string; caddySocket: string; hubSocket: string; webSocket: string; editSocket: string; caddyAdmin: string; stateDir: string; boardsDir: string; notesDir: string; host: string; boardFile: string; api: string; apiTokenFiles: { near: string; far: string } }
interface UiHarnessEvent { event: string; what: string }
const hEvents: (UiHarnessEvent | UiHarnessInfo)[] = []; let hOut = '';
let harness: ChildProcessWithoutNullStreams;
export let H: UiHarnessInfo;
export let ctx: BrowserContext;
export let hlog = '';

// Harness controls: SIGHUP restarts wb-web; stdin lines "stop hub" / "start hub" (M1-N, acknowledged on stderr too),
// "stop edit" / "start edit" / "restart edit" (edwind) and "board FILE" (install a board file), each answered with one
// JSON event line on stdout: harnessCtl resolves with that event.
const harnessSays = (text: string, from?: number) => until(() => hlog.indexOf(text, from) >= 0, 20000);
export const harnessCtl = (line: string) => { const n = hEvents.length; harness.stdin.write(line + '\n'); return until(() => hEvents[n] as UiHarnessEvent | undefined, 30000); };
export const hubCtl = (verb: 'stop' | 'start') => { const from = hlog.length; harness.stdin.write(verb + ' hub\n'); return harnessSays(`harness: wb-hub ${verb === 'stop' ? 'stopped' : 'started'}`, from); };
export async function webRestart() { const from = hlog.length; harness.kill('SIGHUP'); return harnessSays('harness: wb-web restarted', from); }

// The forwarder. Linux keeps the owner of each TCP socket in /proc/net/tcp; the browser's end of a loopback
// connection is the entry whose local port is the accepted socket's remote port.
const hexPort = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
function peerUid(c: net.Socket): number {
  const local = '0100007F:' + hexPort(c.remotePort!), remote = '0100007F:' + hexPort(PORT);
  for (const l of fs.readFileSync('/proc/net/tcp', 'utf8').split('\n')) { const f = l.trim().split(/\s+/); if (f[1] === local && f[2] === remote) return Number(f[7]); }
  return -1;
}
const FWD = { down: false, socks: new Set<net.Socket>() };

export const netCut = () => { FWD.down = true; for (const s of FWD.socks) s.destroy(); FWD.socks.clear(); };
export const netBack = () => { FWD.down = false; };
export const api = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(ORIGIN + p, { ...init, headers: { Origin: ORIGIN, ...init.headers } });
export const boardFile = (): Board | undefined => { const f = fs.readdirSync(H.boardsDir).find(x => x.endsWith('.json')); return f && JSON.parse(fs.readFileSync(path.join(H.boardsDir, f), 'utf8')); };
export const sessions = async (): Promise<SessionSummary[]> => (await (await api('/api/sessions')).json()).sessions || [];

type UiPtyOpen = Extract<PtyClientMsg, { t: 'open' }>; type UiAcpOpen = Extract<AcpClientMsg, { t: 'open' }>;
/* A request of the daemon phase (REQ), and a socket's first open and hello, with an /acp socket's frames (WSL). */
interface UiReqLog { r: import('playwright-core').Request; m: string; url: string; h: Record<string, string>; t: number }
interface UiSocketLog { url: string; p: import('playwright-core').Page; t: number; open: (Partial<UiPtyOpen & UiAcpOpen> & { t: 'open'; id: string }) | null; hello: (Partial<Extract<PtyServerMsg, { t: 'hello' }> & Extract<AcpServerMsg, { t: 'hello' }>> & { t: 'hello' }) | null; helloT?: number; closed: number | null; sent: AcpClientMsg[]; recv: AcpServerMsg[] }
export const REQ: UiReqLog[] = [], WSL: UiSocketLog[] = [];
export const status = async (e: UiReqLog) => (await e.r.response().catch(() => null))?.status();
export const puts = (since = 0) => REQ.filter(e => e.m === 'PUT' && e.url === ORIGIN + '/api/board' && e.t >= since);

// Attach once for the entire daemon phase; N11 reads the accumulated requests and sockets.
export async function startDaemon(child: ChildProcessWithoutNullStreams) {
  harness = child;
  harness.stderr.on('data', d => { hlog += d; });
  harness.stdout.on('data', d => { hOut += d; let i; while ((i = hOut.indexOf('\n')) >= 0) { const line = hOut.slice(0, i); hOut = hOut.slice(i + 1); try { hEvents.push(JSON.parse(line)); } catch (e) { hEvents.push({ event: 'error', what: 'unparsable: ' + line }); } } });
  H = await new Promise<UiHarnessInfo>((res, rej) => {
    const t = setInterval(() => { if (hEvents.length) { clearInterval(t); res(hEvents.shift() as UiHarnessInfo); } }, 20);
    harness.on('exit', c => { clearInterval(t); rej(new Error(`harness exited with ${c}\n${hlog}`)); });
  });

  const fwd = net.createServer(c => {
    if (FWD.down || c.remoteAddress !== '127.0.0.1' || peerUid(c) !== process.getuid!()) return c.destroy();
    const u = net.connect(H.caddySocket);
    const end = () => { c.destroy(); u.destroy(); FWD.socks.delete(c); FWD.socks.delete(u); };
    for (const s of [c, u]) { FWD.socks.add(s); s.on('error', end); s.on('close', end); }
    c.pipe(u); u.pipe(c);
  });
  await new Promise<void>((res, rej) => { fwd.once('error', rej); fwd.listen(PORT, '127.0.0.1', res); });

  // Every request and WebSocket of the daemon phase. Service workers are blocked so page.route sees every request.
  ctx = await state.browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
  ctx.on('request', r => REQ.push({ r, m: r.method(), url: r.url(), h: r.headers(), t: Date.now() }));
  return fwd;
}

// Each socket's first open and first hello, into WSL; an /acp socket also keeps every frame (sent, recv).
export function record(p: import('playwright-core').Page): void {
  p.on('websocket', ws => {
    const w: UiSocketLog = { url: ws.url(), p, t: Date.now(), open: null, hello: null, closed: null, sent: [], recv: [] }, acp = w.url.endsWith('/acp'); WSL.push(w);
    ws.on('framesent', f => { let m: PtyClientMsg | AcpClientMsg; try { m = JSON.parse(f.payload as string); } catch { return; } if (acp) w.sent.push(m as AcpClientMsg); if (!w.open && m.t === 'open') w.open = m; });
    ws.on('framereceived', f => { let m: PtyServerMsg | AcpServerMsg; try { m = JSON.parse(f.payload as string); } catch { return; } if (acp) w.recv.push(m as AcpServerMsg); if (!w.hello && m.t === 'hello') { w.hello = m; w.helloT = Date.now(); } });
    ws.on('close', () => { w.closed = Date.now(); });
  });
}
export async function dpage(boot = true): Promise<import('playwright-core').Page> {
  const p = await ctx.newPage(); watchErrors(p); record(p);
  await p.goto(ORIGIN + '/');
  if (boot) await until(() => p.evaluate(() => window.__canvas?.BOOTED));
  if (boot) await until(() => p.evaluate(() => window.__perf?.frame?.ready), 30000);   // the Scheme boot blocks the tab's main thread
  return p;
}
export const ptyOf = (p: import('playwright-core').Page, id?: string | null, since = 0) => WSL.filter(w => w.p === p && w.url.endsWith('/pty') && w.t >= since && (!id || w.open?.id === id));
export const termText = (p: import('playwright-core').Page, id: string) => p.evaluate((id): string => { const b = window.__canvas.live[id]?.term?.buffer.active; if (!b) return ''; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\n'); }, id);
export async function newTerm(p: import('playwright-core').Page, name: string): Promise<string> {   // a pty card made in the page, so it spawns; resolves once its shell answered
  const id = await p.evaluate(name => window.__canvas.addNode({ kind: 'term', backend: 'pty', name, x: 200, y: 200, w: 640, h: 300, env: {} }).id, name);
  await until(() => ptyOf(p, id).some(w => w.hello));
  return id;
}
export const typeIn = (p: import('playwright-core').Page, id: string, s: string) => p.evaluate(({ id, s }) => window.__canvas.live[id].backend.input(s), { id, s });
export const moveCard = (p: import('playwright-core').Page, dx = 40) => p.evaluate(dx => { const C = window.__canvas, n = Object.values<BoardNode>(C.S.nodes).find(n => n.kind === 'buffer')!; C.moveTree(n, dx, 0); C.dirty(); return { id: n.id, x: n.x }; }, dx);
// Every change of the page is on disk: none in flight, none still inside the 500 ms save debounce (unsaved).
export const settled = (p: import('playwright-core').Page) => until(() => p.evaluate(() => { const C = window.__canvas, s = C.SAVE; return !s.busy && !s.pending && !C.unsaved(); }), 8000);
export const barOf = (p: import('playwright-core').Page) => p.evaluate(() => { const b = document.querySelector<HTMLElement>('#bar')!; return { hidden: b.hidden, key: b.dataset.key, text: b.querySelector('.msg')!.textContent }; });
export const palLabels = (p: import('playwright-core').Page) => p.evaluate(() => [...document.querySelectorAll('#pal-list .pi .l')].map(x => x.textContent));
// The one place a page's text is read for an assertion: the board's pageText (the replica text).
export const pageText = (p: import('playwright-core').Page, id: string) => p.evaluate((id): string => window.__canvas.pageText(id), id);

export const boardState = (p: Page) => p.evaluate(() => ({ view: document.body.dataset.view, palette: !document.getElementById('palette')!.hidden, tree: document.body.classList.contains('tree-open'),
  dock: document.body.classList.contains('side-open'), ws: window.__canvas.WS.cur, leader: !document.getElementById('which-key')!.hidden }));
