import { check, section, state, until } from '../shared.mts';
import { ORIGIN, REQ, dpage, moveCard, puts, settled, status } from '../daemon.mts';

await section('daemon boot', async () => {
  const A = state.A = await dpage();
  const st = await A.evaluate(() => { const C = window.__canvas; return { daemon: C.DAEMON, hub: C.INFO?.hub?.status, s: !!C.S }; });
  check('daemon boots', st.daemon && st.hub === 'up' && st.s, JSON.stringify(st));
  check('assistant pane is gone', await A.evaluate(() => !document.querySelector('#side-chat') && !window.__canvas.S.chat && !document.querySelector('#add-agent')));
  check('N16: no request leaves 127.0.0.1 while booting', REQ.every(e => !/^(https?|wss?):/.test(e.url) || new URL(e.url).hostname === '127.0.0.1'), REQ.filter(e => !e.url.startsWith(ORIGIN)).map(e => e.url).join());
  const css = REQ.find(e => e.url === ORIGIN + '/fonts/fonts.css'), files = REQ.filter(e => e.url.startsWith(ORIGIN + '/fonts/') && e !== css);
  const codes = await Promise.all(files.map(status));
  check('N16: fonts.css and a font file load from /fonts/', !!css && await status(css) === 200 && codes.includes(200), JSON.stringify({ css: !!css, files: files.map(e => e.url), codes }));
  // N4b: a fresh boardsDir; the seeded board's first save
  if (!puts().length) await moveCard(A);
  await until(() => puts().length, 5000);
  const e = puts()[0];
  check('N4b: the first PUT carries If-Match "empty" and gets 204', !!e && e.h['if-match'] === '"empty"' && await status(e) === 204, JSON.stringify(e && { im: e.h['if-match'], st: await status(e) }));
  await settled(A);
});
