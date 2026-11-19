import { check, section, sleep, until } from '../shared.mts';
import { barOf, boardFile, dpage, moveCard, puts, settled, status } from '../daemon.mts';
import { caddyMode, hasCaddyModes, skipCaddy } from '../caddy.mts';

if (!hasCaddyModes) skipCaddy('N3');
else {
  // N3: expiry in the middle of a session
  await section('N3', async () => {
    const P = await dpage(); await settled(P);
    caddyMode('expired'); let t0 = Date.now();
    let mv: { id: string; x: number };
    try {
      mv = await moveCard(P, 35);
      await until(() => P.evaluate(() => window.__canvas.SAVE.paused === 'auth'), 8000); await sleep(3000);
      const st = { b: await barOf(P), paused: await P.evaluate(() => window.__canvas.SAVE.paused), puts: puts(t0).length };
      // A Caddy reload closes the proxied sockets, so the page may see the expiry before its debounced PUT: at most one PUT.
      check('N3: an expired sign-in pauses saving behind the Signed out bar, which says the move is not saved, after at most one PUT', st.b.key === 'auth' && /^Signed out: changes since \d\d:\d\d are not saved yet/.test(st.b.text) && st.paused === 'auth' && st.puts <= 1, JSON.stringify(st));
    } finally { caddyMode('live'); }
    t0 = Date.now();
    await P.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => puts(t0).length, 8000); await settled(P); await sleep(500);
    const e = puts(t0)[0], disk = boardFile()?.nodes?.[mv.id];
    check('N3: signed in again, focus clears the bar and one PUT with If-Match saves the move', (await barOf(P)).hidden && puts(t0).length === 1 && !!e?.h['if-match'] && await status(e) === 204 && disk?.x === mv.x, JSON.stringify({ puts: puts(t0).length, im: e?.h['if-match'], disk, x: mv.x }));
    await P.close();
  });
}
