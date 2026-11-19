import fs from 'node:fs';
import path from 'node:path';
import type * as TailPw from 'playwright-core';
import { section, skip, sleep, state, TMP, until, watchErrors } from './shared.mts';
import { ctx, ORIGIN, WSL } from './daemon.mts';

export type TailPage = TailPw.Page;
/* The journal events of one kind, e.g. AcpEvOf<'turn_end'>. */
export type AcpEvOf<E extends JournalEvent['e']> = TailJsonRead<Extract<JournalEvent, { e: E }>>;
/* A wire message as the checks read it: its JSON payloads (JsonValue, JsonObject, arrays of them) as any. */
export type TailJsonRead<T> = { [K in keyof T]: JsonValue extends T[K] ? any : JsonObject extends T[K] ? any : JsonObject[] extends T[K] ? any : T[K] }; // any: payloads the checks read field by field
/* One /acp socket of a gated page: the page's end, the server's end, and the server frames held back. */
interface AcpGateSock { ws: TailPw.WebSocketRoute; server: TailPw.WebSocketRoute; buf: (string | Buffer)[] }
/* What gatedPage hands its checks to steer the page's /acp and /rpc sockets. */
interface AcpGate {
  hold: boolean; refuse: boolean;
  drop: (m: TailJsonRead<AcpClientMsg> | null) => boolean; rpcDrop: (m: HubMsg) => boolean;
  sent: (TailJsonRead<AcpClientMsg> | null)[]; recv: (AcpServerMsg | null)[]; socks: AcpGateSock[];
  release: () => void; kick: () => void;
}
/* What acpView reads from an acp card: its backend's state and what its DOM shows. */
interface AcpView {
  st: string; tx: string; badge: string; seq: number; epoch: number; alive: boolean; activity?: string; promptable: boolean;
  items: string[]; asst: number; perm: number; form: number; url: number;
  state: string; revive: boolean; ta: string; ro: boolean; go: string; mode: string; modes: string[];
}

/* What the checks below leave on the page's window. */
declare global {
  interface Window {
    __m3: string[]; __oldAllow: HTMLButtonElement; __n17: string[]; __n17b: Record<string, string[]>; __n17o: MutationObserver;
    __opened: Parameters<Window['open']>[]; __n39: string[]; __toasts: string[]; __speech?: string; __n52: string[];
    __edwin?: { state: string; frame: EdwinFrame | null }; __kt: Record<string, number>; __mt: Record<string, number>; __two: string;
    __n58: { tool: string; input: AgentToolInput }[];
  }
}

export const ACWD = fs.mkdtempSync(path.join(TMP, 'acp-'));
export const acpWs = (p: TailPage, id?: string | null, since = 0) => WSL.filter(w => w.p === p && w.url.endsWith('/acp') && w.t >= since && (!id || w.open?.id === id));
export const acpSent = <T extends AcpClientMsg['t']>(p: TailPage, id: string | null, t: T, since = 0) => acpWs(p, id, since).flatMap(w => w.sent.filter((m): m is TailJsonRead<Extract<AcpClientMsg, { t: T }>> & { rid?: number } => m.t === t));
// Journal events the page received after seq `after`, once each, from sockets opened since `since` (a new session's seq
// starts again at 1, so a check across Start new session passes `since`).
export const acpEvs = <E extends JournalEvent['e']>(p: TailPage, id: string | null, e: E | null, after = 0, since = 0): AcpEvOf<E>[] => {
  const m = new Map<number, AcpEvOf<E>>();
  for (const w of acpWs(p, id, since)) for (const f of w.recv) if (f.t === 'ev' && f.ev?.seq > after && (!e || f.ev.e === e)) m.set(f.ev.seq, f.ev as AcpEvOf<E>);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
};
// The card paints once per frame (30 §1.3): a view waits out a pending paint, so its DOM shows every frame taken so far.
export const acpView = (p: TailPage, id: string) => p.evaluate(async (id: string): Promise<AcpView | null> => {
  const C = window.__canvas, L = C.live[id], b = L?.backend; if (!b) return null;
  for (let i = 0; b.raf && i < 10; i++) await new Promise<void>(r => { requestAnimationFrame(() => r()); setTimeout(r, 100); });
  const vis = (e: HTMLElement | null | undefined) => !!e && !e.hidden && !e.closest('[hidden]'), st = L.body.querySelector('.ag-state');
  return { st: b.state(), tx: b.stateText(), badge: L.hdr.querySelector('.badge').textContent, seq: b.seq, epoch: b.epoch, alive: !!b.sum?.alive, activity: b.sum?.acp?.activity, promptable: b.promptable(),
    items: b.items.map((i: { k: string; status?: string; title?: string; text?: string }) => i.k + ':' + (i.k === 'tool' ? i.status + ' ' + (i.title || '') : i.text || '')), asst: L.body.querySelectorAll('.ag-log .ag-asst').length,
    perm: L.body.querySelectorAll('.ag-perm').length, form: L.body.querySelectorAll('.ag-form').length, url: L.body.querySelectorAll('.ag-url').length,
    state: vis(st) ? st.textContent : '', revive: vis(L.revive), ta: L.ta.value, ro: L.ta.readOnly, go: L.body.querySelector('.ag-row .go').textContent,
    mode: L.body.querySelector('.ag-mode').value, modes: [...L.body.querySelectorAll('.ag-mode option')].map(o => o.value) };
}, id);
export const toastOf = (p: TailPage) => p.evaluate(() => document.querySelector('#toast')?.textContent || '');
export const acpClick = (p: TailPage, id: string, sel: string) => p.evaluate(({ id, sel }: { id: string; sel: string }) => { const b = window.__canvas.live[id].body.querySelector(sel); b?.click(); return !!b; }, { id, sel });
export const acpIdle = (p: TailPage, id: string, ms = 20000) => until(async () => { const v = await acpView(p, id); return v?.promptable && (v.st === 'idle' || v.st === 'done') ? v : null; }, ms);
export async function acpNew(p: TailPage) {   // through newAgentCard (30 §1.1): the picker only when there is more than one agent, then the folder
  const before = await p.evaluate(() => Object.keys(window.__canvas.S.nodes));
  await p.evaluate(() => window.__canvas.newAgentCard());
  if (await p.evaluate(() => document.querySelector<HTMLElement>('#ask')!.hidden)) { await p.fill('#pal-in', 'stub'); await sleep(200); await p.keyboard.press('Enter'); }
  await until(() => p.evaluate(() => !document.querySelector<HTMLElement>('#ask')!.hidden), 5000);
  await p.fill('#ask-in', ACWD); await p.keyboard.press('Enter');
  return until(() => p.evaluate((before: string[]) => Object.values<BoardNode>(window.__canvas.S.nodes).find(n => n.kind === 'acp' && !before.includes(n.id))?.id, before));
}
// Brings a card into view: a far zoom hides card bodies (visibility), and Playwright only types into visible fields.
export const acpShow = (p: TailPage, id: string) => p.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); }, id);
export async function acpSay(p: TailPage, id: string, text: string) {   // the composer, as a user types it
  await until(async () => (await acpView(p, id))?.promptable, 20000);
  await acpShow(p, id);
  const ta = `.node[data-id="${id}"] .ag-in textarea`;
  await p.fill(ta, text); await p.press(ta, 'Enter');
}
// A second page whose /acp sockets pass through a route: `hold` keeps server frames back until release(), `refuse` closes
// new sockets 1011 at once, kick() drops the open ones with 1011, and drop(frame) keeps a page frame from the server.
// rpcDrop(frame) keeps a server frame on /rpc from the page.
export async function gatedPage() {
  const P = await ctx.newPage(); watchErrors(P);
  const g = { hold: false, refuse: false, drop: () => false, rpcDrop: () => false, sent: [], recv: [], socks: [] } as Omit<AcpGate, 'release' | 'kick'> as AcpGate;
  await P.routeWebSocket(/\/rpc$/, ws => { const server = ws.connectToServer(); server.onMessage(m => { if (!g.rpcDrop(JSON.parse(m as string))) ws.send(m); }); });
  const code = (c: number | undefined) => ([1005, 1006, 1015].includes(c as number) ? 1011 : c || 1000);   // codes a close frame cannot carry
  await P.routeWebSocket(/\/acp$/, ws => {
    if (g.refuse) return void ws.close({ code: 1011 });
    const server = ws.connectToServer(), s: AcpGateSock = { ws, server, buf: [] }; g.socks.push(s);
    const parse = (m: string | Buffer) => { try { return JSON.parse(m as string); } catch { return null; } };
    ws.onMessage(m => { const o = parse(m); g.sent.push(o); if (!g.drop(o)) server.send(m); });
    server.onMessage(m => { g.recv.push(parse(m)); if (g.hold) s.buf.push(m); else ws.send(m); });
    ws.onClose(c => server.close({ code: code(c) }));
    server.onClose(c => ws.close({ code: code(c) }));
  });
  g.release = () => { g.hold = false; for (const s of g.socks) while (s.buf.length) s.ws.send(s.buf.shift()!); };
  g.kick = () => { for (const s of g.socks.splice(0)) { s.ws.close({ code: 1011 }); s.server.close({ code: 1000 }); } };
  await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
  return { P, g };
}

// Without a stub, report all missing checks in N-number order, not their live dependency order.
const missingStub: string[] = [];
export function stubSection(name: string, run: () => unknown) {
  if (state.STUB) return section(name, run);
  missingStub.push(name);
}
export function reportStubSkips() {
  for (const name of missingStub.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    skip(name, 'no stub agent in /api/info.agents (wb-fake-acp registered as `stub` in the test hub)');
  }
}
