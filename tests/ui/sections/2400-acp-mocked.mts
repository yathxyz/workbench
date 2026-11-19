import type * as TailPw from 'playwright-core';
import { check, section, sleep, until, watchErrors } from '../shared.mts';
import { ctx, ORIGIN, settled } from '../daemon.mts';
import { ACWD, acpClick, acpSay, acpView, toastOf, type TailJsonRead } from '../acp.mts';

/* A mocked /acp socket: what the page sent, its open, and the script's handler for the frames after it. */
interface AcpMockSock { ws: TailPw.WebSocketRoute; sent: AcpMockSent[]; open?: Extract<AcpClientMsg, { t: 'open' }>; on?: (o: AcpMockSent) => void }
/* A mocked socket once it has its open, as a script gets it. */
type AcpMockOpen = AcpMockSock & { open: Extract<AcpClientMsg, { t: 'open' }> };
/* A frame the page sent, as the checks read it. */
type AcpMockSent = TailJsonRead<AcpClientMsg>;
/* How a mocked hello's session summary differs from a live, idle one. */
interface AcpMockOpts {
  alive?: boolean; state?: SessionState; fault?: { code: string; message: string }; revivable?: boolean;
  pending?: { req: number; kind: string; title: string; ts: number }[]; seen?: number; from?: number; reset?: boolean;
}

// F-A1, F-A2, F-A3, F-A4, F-A5 and seen on mocked /acp sockets: the server side is scripted here, so these run without an
// agent. `script(s, n)` answers the n-th open of a card; `s.on` takes the frames after it.
await section('acp mocked', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const socks: AcpMockSock[] = []; let script: (s: AcpMockOpen, n: number) => void = () => {};
  await P.routeWebSocket(/\/acp$/, ws => {
    const s: AcpMockSock = { ws, sent: [] }; socks.push(s);
    ws.onMessage(m => { let o: AcpMockSent; try { o = JSON.parse(m as string); } catch { return; } s.sent.push(o); if (o.t === 'open' && !s.open) { s.open = o; script(s as AcpMockOpen, socks.filter(x => x.open?.id === o.id).length); } else s.on?.(o); });
  });
  const send = (s: AcpMockSock, ...ms: object[]) => { for (const m of ms) s.ws.send(JSON.stringify(m)); };
  const info = (id: string, epoch: number, head: number, x: AcpMockOpts = {}) => ({ sid: id, kind: 'acp', host: 'h', createdAt: epoch, updatedAt: epoch, alive: x.alive ?? true, viewers: 1, cwd: ACWD, state: x.state || 'idle', ...(x.fault ? { fault: x.fault } : {}),
    acp: { agent: 'stub', agentSessionId: 'a', revivable: x.revivable ?? true, activity: 'none', pending: x.pending || [], headSeq: head, seenSeq: x.seen ?? head, title: null, modeId: null } });
  const hello = (id: string, epoch: number, head: number, x: AcpMockOpts = {}) => ({ t: 'hello', status: 'attached', info: info(id, epoch, head, x), head, from: x.from ?? 1, reset: !!x.reset });
  const ev = (seq: number, e: JournalEvent['e'], x: object = {}) => ({ t: 'ev', ev: { seq, ts: seq, e, ...x } });
  const opensOf = (id: string) => socks.filter(s => s.open?.id === id);
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    // F-A4: a failed open is final; Start new session then opens with the spawn fields
    script = (s, n) => {
      if (n === 1) { send(s, { t: 'error', error: 'no session', code: 'not_found' }); setTimeout(() => s.ws.close({ code: 1000 }), 100); }
      else send(s, hello(s.open.id, 500, 2), ev(1, 'spawn', { pid: 1, via: 'new' }), ev(2, 'session', { via: 'new', sessionId: 'a' }), { t: 'replayed', head: 2, truncated: false });
    };
    const m1 = await P.evaluate((cwd: string) => window.__canvas.addNode({ kind: 'acp', name: 'm1', agent: 'stub', cwd, x: 3000, y: 3400, w: 560, h: 420, _spawn: false }).id, ACWD);
    await sleep(4000);
    const v1 = await acpView(P, m1), n1 = opensOf(m1).length;
    await acpClick(P, m1, '.ag-state .acts button.go');
    const v1b = await until(async () => { const v = await acpView(P, m1); return v!.promptable ? v : null; }, 5000), o2 = opensOf(m1)[1]?.open;
    check('F-A4 (mocked): an open that gets not_found makes one socket and shows No session; Start new session opens again with agent and cwd from since 0',
      n1 === 1 && !('agent' in opensOf(m1)[0].open!) && v1!.st === 'exited' && /No session for this card/.test(v1!.state) && !!v1b && o2?.agent === 'stub' && o2.cwd === ACWD && o2.since === 0, JSON.stringify({ n1, v1: v1 && { st: v1.st, state: v1.state }, o2 }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), m1);

    // F-A5 and F-A1: a prompt lost with its socket stays in the composer; the reconnect sends since and epoch; reset clears
    let echo = false;
    script = (s, n) => {
      if (n === 1) { send(s, hello(s.open.id, 1000, 2), ev(1, 'spawn', { pid: 1, via: 'new' }), ev(2, 'session', { via: 'new', sessionId: 'a' }), { t: 'replayed', head: 2, truncated: false }); s.on = o => { if (o.t === 'prompt') s.ws.close({ code: 1011 }); }; }
      else if (n === 2) {
        send(s, hello(s.open.id, 1000, 3), ev(3, 'update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' }, messageId: 'x' } }), { t: 'replayed', head: 3, truncated: false });
        s.on = o => { if (o.t === 'prompt') { echo = true; send(s, ev(4, 'prompt', { prompt: o.blocks })); setTimeout(() => s.ws.close({ code: 1011 }), 300); } };
      } else if (n === 3) {
        send(s, hello(s.open.id, 2000, 2, { reset: true }), ev(1, 'spawn', { pid: 2, via: 'new' }), ev(2, 'permission', { toolCall: { toolCallId: 't1', title: 'Edit a file', kind: 'edit' }, options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }] }), { t: 'replayed', head: 2, truncated: false });
        s.on = o => { if (o.t === 'permission') send(s, { t: 'error', error: 'stale', code: 'stale', rid: o.rid }); if (o.t === 'kill' && o.forget) setTimeout(() => s.ws.close({ code: 1000 }), 300); };
      } else send(s, hello(s.open.id, 3000, 1, { state: 'done', seen: 0 }), ev(1, 'spawn', { pid: 3, via: 'new' }), { t: 'replayed', head: 1, truncated: false });
    };
    const m2 = await P.evaluate((cwd: string) => window.__canvas.addNode({ kind: 'acp', name: 'm2', agent: 'stub', cwd, x: 3000, y: 3400, w: 560, h: 420 }).id, ACWD);
    const TEXT = 'mocked prompt';
    await acpSay(P, m2, TEXT);
    const back = await until(async () => { const v = await acpView(P, m2); return opensOf(m2).length === 2 && v!.promptable && v!.asst === 1 ? v : null; }, 10000), o2b = opensOf(m2)[1]?.open;
    check('F-A5 (mocked): a prompt whose socket dropped before the echo is back in the composer, editable, after the reconnect; the reconnect sends since and epoch',
      !!back && back.ta === TEXT && !back.ro && back.go === 'Send' && o2b?.since === 2 && o2b.epoch === 1000 && !('agent' in o2b), JSON.stringify({ back: back && { ta: back.ta, ro: back.ro, go: back.go }, o2b }));
    await acpSay(P, m2, TEXT);
    const cleared = await until(async () => { const v = await acpView(P, m2); return echo && v!.ta === '' && !v!.ro ? v : null; }, 5000);
    check('F-A5 (mocked): the echo of this tab\'s prompt empties the composer', !!cleared, JSON.stringify(await acpView(P, m2)));
    const reset = await until(async () => { const v = await acpView(P, m2); return opensOf(m2).length === 3 && v!.epoch === 2000 && v!.perm === 1 ? v : null; }, 10000), o3 = opensOf(m2)[2]?.open;
    check('F-A1 (mocked): a hello with reset clears the transcript and the replay from seq 1 rebuilds it, with the pending permission', !!reset && o3?.since === 4 && o3.epoch === 1000 && reset.asst === 0 && !reset.items.some(x => x.startsWith('user:')) && reset.seq === 2, JSON.stringify({ o3, items: reset?.items, seq: reset?.seq }));
    await acpClick(P, m2, '.ag-perm button[data-kind="allow_once"]');
    const answer = await until(() => opensOf(m2)[2].sent.find(m => m.t === 'permission'), 5000);   // the route hears it a little later
    const stale = await until(async () => /belongs to an ended session/.test(await toastOf(P)) && (await acpView(P, m2))!.perm === 0, 5000);
    check('F-A2 (mocked): an answer carries the epoch and the option; stale toasts "this request belongs to an ended session" and drops the panel', answer?.req === 2 && answer.epoch === 2000 && answer.outcome?.outcome === 'selected' && answer.outcome.optionId === 'y' && answer.rid != null && stale, JSON.stringify({ answer, toast: await toastOf(P) }));
    // F-A3: Start new session waits for the close 1000, never shows ended, and opens fresh; seen goes for a done state
    await P.evaluate((id: string) => {
      const C = window.__canvas, L = C.live[id], b = L.hdr.querySelector('.badge'); window.__m3 = [];
      new MutationObserver(() => window.__m3.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
      C.jumpNode(C.S.nodes[id]); C.CMDS.find((c: PaletteItem) => c.l.startsWith('Agent: start a new session')).run();
    }, m2);
    const fresh = await until(async () => { const v = await acpView(P, m2); return v!.epoch === 3000 ? v : null; }, 10000), o4 = opensOf(m2)[3]?.open, badges = await P.evaluate(() => [...new Set(window.__m3)]);
    const kill = opensOf(m2)[2].sent.find(m => m.t === 'kill'), seen = await until(() => opensOf(m2)[3]?.sent.find(m => m.t === 'seen'), 5000);
    check('F-A3 (mocked): Start new session sends kill forget, shows ending…, waits for the close, then opens with agent and cwd from since 0 and a fresh transcript',
      kill?.forget === true && badges.some(t => /ending…$/.test(t)) && !badges.some(t => /· ended$/.test(t)) && !!fresh && o4?.agent === 'stub' && o4.since === 0 && fresh.items.length === 1, JSON.stringify({ kill, badges, o4, items: fresh?.items }));
    check('§3.4.6 (mocked): a done card that is active in a visible, focused page sends seen with the head seq', seen?.seq === 1, JSON.stringify(opensOf(m2)[3]?.sent));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), m2);

    // ROB-2: a panel left from an ended incarnation never answers the new one's request, even one with the same req
    const permEv = (seq: number, title: string) => ev(seq, 'permission', { toolCall: { toolCallId: 't' + seq, title, kind: 'execute' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
    const mocked = (name: string) => P.evaluate(([name, cwd]: string[]) => window.__canvas.addNode({ kind: 'acp', name, agent: 'stub', cwd, x: 3000, y: 3400, w: 560, h: 420, _spawn: false }).id, [name, ACWD]);
    script = (s, n) => {
      if (n === 1) send(s, hello(s.open.id, 4000, 2), ev(1, 'spawn', { pid: 4, via: 'new' }), permEv(2, 'Old tool'), { t: 'replayed', head: 2, truncated: false });
      else send(s, hello(s.open.id, 5000, 2, { reset: true }), ev(1, 'spawn', { pid: 5, via: 'new' }), permEv(2, 'New tool'), { t: 'replayed', head: 2, truncated: false });
    };
    const m3 = await mocked('m3');
    await until(async () => (await acpView(P, m3))?.perm === 1, 5000);
    await P.evaluate((id: string) => { window.__oldAllow = window.__canvas.live[id].body.querySelector('.ag-perm button[data-kind="allow_once"]'); }, m3);
    opensOf(m3)[0].ws.close({ code: 1011 });
    const fresh3 = await until(async () => { const v = await acpView(P, m3); return v!.epoch === 5000 && v!.perm === 1 ? v : null; }, 10000);
    const oldGone = await P.evaluate(() => { window.__oldAllow.click(); return !window.__oldAllow.isConnected; });
    await sleep(300);
    const leaked = opensOf(m3)[1]?.sent.filter(m => m.t === 'permission') || [];
    await acpClick(P, m3, '.ag-perm button[data-kind="allow_once"]');
    const own = await until(() => opensOf(m3)[1]?.sent.find(m => m.t === 'permission'), 5000);
    check('ROB-2 (mocked): after a hello with reset, a click on the old incarnation\'s panel sends nothing; the new panel answers with the new epoch',
      !!fresh3 && oldGone && !leaked.length && own?.req === 2 && own.epoch === 5000, JSON.stringify({ fresh: !!fresh3, oldGone, leaked, own }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), m3);

    // §3.4.7: an answer lost with its socket can be given again after the reconnect; a request the hub no longer holds goes
    script = (s, n) => {
      if (n === 1) { send(s, hello(s.open.id, 6000, 3), ev(1, 'spawn', { pid: 6, via: 'new' }), permEv(2, 'First tool'), permEv(3, 'Second tool'), { t: 'replayed', head: 3, truncated: false }); s.on = o => { if (o.t === 'permission') s.ws.close({ code: 1011 }); }; }
      else send(s, hello(s.open.id, 6000, 3, { state: 'waiting_permission', pending: [{ req: 2, kind: 'permission', title: 'First tool', ts: 2 }] }), { t: 'replayed', head: 3, truncated: false });
    };
    const m4 = await mocked('m4');
    await until(async () => (await acpView(P, m4))?.perm === 2, 5000);
    await acpClick(P, m4, '.ag-perm button[data-kind="allow_once"]');
    const lost = await until(() => opensOf(m4)[0].sent.find(m => m.t === 'permission'), 5000);
    const panelOf = () => P.evaluate((id: string) => [...window.__canvas.live[id].body.querySelectorAll('.ag-perm')].map(p => p.querySelector('.tt').textContent + (p.classList.contains('sent') ? ' (sent)' : '')), m4);
    const again = await until(async () => { const ps = await panelOf(); return opensOf(m4).length === 2 && ps.length === 1 && ps[0] === 'First tool' ? ps : null; }, 10000);
    await acpClick(P, m4, '.ag-perm button[data-kind="allow_once"]');
    const resent = await until(() => opensOf(m4)[1]?.sent.find(m => m.t === 'permission'), 5000);
    check('§3.4.7 (mocked): an answer lost with its socket can be given again after the reconnect, and a request the hub no longer holds goes',
      lost?.req === 2 && !!again && resent?.req === 2 && resent.epoch === 6000, JSON.stringify({ lost: lost?.req, panels: await panelOf(), opens: opensOf(m4).length, resent }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), m4);

    // F-A16: a dead session that cannot be revived offers Start new session, also when it has a fault (a quarantined record)
    script = s => send(s, hello(s.open.id, 7000, 2, { alive: false, revivable: false, state: 'error', fault: { code: 'load_failed', message: 'the record could not be read' } }),
      ev(1, 'spawn', { pid: 7, via: 'new' }), ev(2, 'exit', { reason: 'hub_restart' }), { t: 'replayed', head: 2, truncated: false });
    const m5 = await mocked('m5');
    const v5 = await until(async () => { const v = await acpView(P, m5); return /Fault: the record could not be read/.test(v?.state || '') ? v : null; }, 5000);
    const acts5 = await P.evaluate((id: string) => [...window.__canvas.live[id].body.querySelectorAll('.ag-state .acts button')].map(b => b.textContent), m5);
    check('F-A16 (mocked): a dead, faulted session that cannot be revived shows its fault, no ↻, and Start new session', !!v5 && !v5.revive && acts5.includes('Start new session'), JSON.stringify({ state: v5?.state, revive: v5?.revive, acts5 }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), m5);

    // 30 §1.5: the docked terminal is never a board node, so its live session is no orphan; a session without a card is
    const orphans = await P.evaluate((cwd: string) => {
      const C = window.__canvas, base = { kind: 'pty', host: 'h', createdAt: 1, updatedAt: 1, alive: true, viewers: 1, cwd, state: '', pty: { fg: { comm: 'bash' } } };
      C.SESS.dock = { ...base, sid: 'dock' }; C.SESS['zz-orphan'] = { ...base, sid: 'zz-orphan' };
      const keys = C.attnItems().map((i: { key: string }) => i.key).filter((k: string) => k.startsWith('orphan:'));
      delete C.SESS.dock; delete C.SESS['zz-orphan']; return keys;
    }, ACWD);
    check('30 §1.5 (mocked): the docked terminal\'s session is not listed as running without a card; a session without a card is', orphans.includes('orphan:zz-orphan') && !orphans.includes('orphan:dock'), JSON.stringify(orphans));
    await settled(P);
  } finally { await P.close(); }
});
