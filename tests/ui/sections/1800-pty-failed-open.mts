import { check, section, sleep, until, watchErrors } from '../shared.mts';
import { ORIGIN, ctx, settled, termText, typeIn } from '../daemon.mts';

// DELTA-1 §C.1: Enter between a failed open's error and the server's 1000 close starts the shell on a new socket.
// The /pty sockets of this page are mocked: each card's first socket fails and closes 1.5 s later, the next one spawns.
await section('§C.1', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const tried = new Set<string>(), log: { id: string; spawn?: boolean; again: boolean }[] = [];
  await P.routeWebSocket(/\/pty$/, ws => {
    let first: PtyClientMsg | null = null;
    ws.onMessage(m => {
      let o: PtyClientMsg; try { o = JSON.parse(m as string); } catch { return; }
      if (o.t !== 'open') return;
      log.push({ id: o.id, spawn: o.spawn, again: !!first });
      if (first) return;
      first = o;
      if (tried.has(o.id)) return ws.send(JSON.stringify({ t: 'hello', new: true, epoch: 2, stream: 2, out: 0, resumed: false, cwd: '/' }));
      tried.add(o.id);
      ws.send(JSON.stringify({ t: 'error', error: 'no session', code: 'not_found' }));
      setTimeout(() => ws.close({ code: 1000 }), 1500);
    });
  });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    const id = await P.evaluate(() => window.__canvas.addNode({ kind: 'term', backend: 'pty', name: 'c1', x: 300, y: 300, w: 500, h: 260, env: {} }).id);
    await until(async () => (await termText(P, id)).includes('No session: press Enter'), 8000);
    await typeIn(P, id, '\r');
    await until(() => log.filter(e => e.id === id && !e.again).length >= 2, 5000);
    await sleep(2000);   // past the old socket's close
    const text = await termText(P, id), dead = await P.evaluate(id => window.__canvas.live[id].backend.dead, id), mine = log.filter(e => e.id === id);
    check('§C.1: Enter before a failed open\'s close spawns on a new socket, and the card is live without "connection closed"',
      mine.length === 2 && !mine[1].again && mine[1].spawn === true && !text.includes('connection closed') && text.includes('[new shell') && dead === false, JSON.stringify({ mine, dead, tail: text.slice(-300) }));
    await P.evaluate(id => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});
