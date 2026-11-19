import { check, section, until, watchErrors } from '../shared.mts';
import { ORIGIN, ctx, settled, termText } from '../daemon.mts';

// SEC-2 (§3.5.1): a spawn is sent once. Each card's first /pty socket here takes the open and closes 1011 before any hello,
// as a hub lost after spawning would; the reconnect must attach (spawn:false), and the mock then answers not_found.
await section('SEC-2 reconnect', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const log: { id: string; spawn?: boolean }[] = [];
  await P.routeWebSocket(/\/pty$/, ws => {
    let first = true;
    ws.onMessage(m => {
      let o: PtyClientMsg; try { o = JSON.parse(m as string); } catch { return; }
      if (o.t !== 'open' || !first) return;
      first = false; log.push({ id: o.id, spawn: o.spawn });
      if (log.filter(e => e.id === o.id).length === 1) return void setTimeout(() => ws.close({ code: 1011 }), 100);
      ws.send(JSON.stringify({ t: 'error', error: 'no session', code: 'not_found' }));
      setTimeout(() => ws.close({ code: 1000 }), 200);
    });
  });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    const id = await P.evaluate(() => window.__canvas.addNode({ kind: 'term', backend: 'pty', name: 'sec2', x: 300, y: 300, w: 500, h: 260, env: {} }).id);
    await until(async () => (await termText(P, id)).includes('No session: press Enter'), 10000);
    const mine = log.filter(e => e.id === id);
    check('SEC-2: a socket closed after a spawn but before hello reconnects with spawn:false and offers Enter', mine.length === 2 && mine[0].spawn === true && mine[1].spawn === false, JSON.stringify(mine));
    await P.evaluate(id => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});
