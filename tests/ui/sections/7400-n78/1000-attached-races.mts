import type * as TailPw from 'playwright-core';
import { check, section, until, watchErrors } from '../../shared.mts';
import { ORIGIN, boardFile, ctx, sessions, settled, termText, typeIn } from '../../daemon.mts';
import { acpClick, acpIdle, acpView } from '../../acp.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({ D, owner, cwd, meshApi, startPty, isAlive, closeCard }: N78Fixture) {
  await section('N78 attached races', async () => {
    await settled(D); await settled(owner);
    const P = await ctx.newPage(); watchErrors(P);
    const agent = 'n78_race_acp', shell = 'n78_race_pty', ids = [agent, shell];
    const held = new Map<string, { open: Extract<PtyClientMsg | AcpClientMsg, { t: 'open' }>; release: () => void }>();
    const messages: { id: string; msg: PtyClientMsg | AcpClientMsg }[] = [];
    let agentReply: Extract<AcpServerMsg, { t: 'hello' }> | undefined, shellReply: Extract<PtyServerMsg, { t: 'hello' }> | undefined;
    let hideIncarnation = false, latest: { ws: TailPw.WebSocketRoute; message: string | Buffer; session: SessionSummary } | undefined;
    await P.routeWebSocket(/\/rpc$/, ws => {
      const server = ws.connectToServer();
      server.onMessage(message => {
        const m = JSON.parse(message as string) as HubMsg;
        if (hideIncarnation && m.t === 'gone' && m.sid === agent) return;
        if (hideIncarnation && m.t === 'session' && m.session.sid === agent) { latest = { ws, message, session: m.session }; return; }
        ws.send(message);
      });
    });
    await P.routeWebSocket(/\/(pty|acp)$/, ws => {
      const server = ws.connectToServer(); let id = '';
      ws.onMessage(message => {
        const m = JSON.parse(message as string) as PtyClientMsg | AcpClientMsg;
        if (m.t === 'open') id = m.id;
        messages.push({ id, msg: m });
        // Pause only the explicit replacement open, before the hub decides whether it is new or attached.
        if (m.t === 'open' && ids.includes(m.id) && ('agent' in m || 'spawn' in m && m.spawn)) held.set(m.id, { open: m, release: () => server.send(message) });
        else server.send(message);
      });
      server.onMessage(message => {
        const m = JSON.parse(message as string) as PtyServerMsg | AcpServerMsg;
        if (m.t === 'hello' && id === agent) agentReply = m as Extract<AcpServerMsg, { t: 'hello' }>;
        if (m.t === 'hello' && id === shell) shellReply = m as Extract<PtyServerMsg, { t: 'hello' }>;
        ws.send(message);
      });
    });
    try {
      await P.goto(ORIGIN + '/'); await P.waitForFunction(() => window.__canvas?.BOOTED);
      await P.evaluate(({ agent, shell, cwd }) => {
        const C = window.__canvas; C.setView('canvas');
        C.addNode({ id: agent, kind: 'acp', name: 'n78 borrowed agent', agent: 'stub', cwd, x: 100, y: 100, w: 560, h: 520, adopted: true, _spawn: false });
        C.addNode({ id: shell, kind: 'term', backend: 'pty', name: 'n78 borrowed shell', env: {}, x: 700, y: 100, w: 560, h: 520, adopted: true, _spawn: false });
      }, { agent, shell, cwd });
      await until(async () => /No session for this card/.test((await acpView(P, agent))?.state || '') && (await termText(P, shell)).includes('No session: press Enter'), 10000);
      await acpClick(P, agent, '.ag-state .acts button.go'); await typeIn(P, shell, '\r');
      if (!await until(() => held.size === 2, 10000)) throw new Error('N78 replacement opens were not held');
      const beforeHello = await P.evaluate((ids: string[]) => {
        const C = window.__canvas, saved = JSON.parse(C.serialize()); return ids.every(id => C.S.nodes[id].adopted && saved.nodes[id].adopted);
      }, ids);
      const created = await meshApi('/sessions', 'POST', { sid: agent, agent: 'stub', cwd });
      if (created.status !== 201) throw new Error('N78 raced ACP spawn: ' + created.status + ' ' + await created.text());
      await startPty(shell);
      for (const h of held.values()) h.release();
      const attachedAgent = await acpIdle(P, agent), attachedShell = await until(() => P.evaluate((id: string) => window.__canvas.live[id].backend.helloSeen && !window.__canvas.live[id].backend.dead, shell), 15000);
      await settled(P);
      const borrowedAfterHello = await P.evaluate((ids: string[]) => ids.every(id => window.__canvas.S.nodes[id].adopted === true), ids);
      const saved = boardFile(), savedBorrowed = ids.every(id => saved?.nodes[id]?.adopted === true);
      const closedAgent = await closeCard(agent, P), closedShell = await closeCard(shell, P); await settled(P);
      const kills = messages.filter(m => ids.includes(m.id) && m.msg.t === 'kill');
      const agentOpen = held.get(agent)!.open, shellOpen = held.get(shell)!.open;
      check('N78: requested ACP/PTY replacements stay borrowed until hello; attached responses preserve the saved mark and closing their cards leaves both sessions live',
        beforeHello && !!attachedAgent && !!attachedShell && agentReply?.status === 'attached' && shellReply?.new === false && borrowedAfterHello && savedBorrowed
        && 'agent' in agentOpen && 'spawn' in shellOpen && shellOpen.spawn === true
        && closedAgent.removed && closedShell.removed && !kills.length && await isAlive(agent) && await isAlive(shell),
        JSON.stringify({ beforeHello, status: agentReply?.status, new: shellReply?.new, borrowedAfterHello, savedBorrowed, closedAgent, closedShell, kills }));

      await P.evaluate((id: string) => window.__canvas.meshOpen(id), agent); await acpIdle(P, '$agents');
      const oldComposer = await P.locator('#mesh-detail .ag-in textarea').elementHandle(), oldEpoch = (await acpView(P, '$agents'))!.epoch;
      hideIncarnation = true;
      await meshApi('/sessions/' + agent + '?forget=true', 'DELETE');
      await until(async () => !(await sessions()).some(s => s.sid === agent), 15000);
      const recreated = await meshApi('/sessions', 'POST', { sid: agent, agent: 'stub', cwd });
      if (recreated.status !== 201) throw new Error('N78 incarnation spawn: ' + recreated.status + ' ' + await recreated.text());
      const incarnation = await until(() => latest?.session.alive && latest.session.createdAt !== oldEpoch ? latest : null, 15000);
      if (!incarnation) throw new Error('N78 new incarnation was not reported');
      // Deliver a real new summary without its preceding gone: the row/sid/kind stay the same.
      hideIncarnation = false; incarnation.ws.send(incarnation.message);
      const fresh = await until(async () => { const v = await acpView(P, '$agents'); return v?.promptable && v.epoch === incarnation.session.createdAt ? v : null; }, 20000);
      const replacedComposer = await oldComposer!.evaluate(e => !e.isConnected);
      const selected = await P.evaluate((id: string) => window.__canvas.MESH.open === id && !window.__canvas.S.nodes[id], agent);
      check('N78: a changed hub createdAt remounts the same selected row onto its new incarnation without adding a card or killing the viewer',
        !!fresh && fresh.epoch === incarnation.session.createdAt && fresh.epoch !== oldEpoch && replacedComposer && selected
        && !messages.some(m => m.id === agent && m.msg.t === 'kill') && await isAlive(agent),
        JSON.stringify({ oldEpoch, epoch: fresh?.epoch, expected: incarnation.session.createdAt, replacedComposer, selected }));
    } finally {
      await P.evaluate((ids: string[]) => { const C = window.__canvas; C.setView('canvas'); for (const id of ids) if (C.S.nodes[id]) C.removeNode(id); }, ids);
      for (const id of ids) await meshApi('/sessions/' + id + '?forget=true', 'DELETE');
      await settled(P); await P.close();
    }
  });
}
