import { check, section, sleep, state, until } from '../shared.mts';
import { barOf, dpage, moveCard, puts, settled, status } from '../daemon.mts';

const { A } = state;

// N36: the camera is per device; a clean tab takes another tab's board; a dirty one asks
await section('N36', async () => {
  const B = await dpage(); await settled(A); await settled(B);
  const t0 = Date.now();
  await A.mouse.move(700, 500); await A.mouse.wheel(0, 240); await sleep(1500);
  const s0 = await A.evaluate(() => ({ pending: window.__canvas.SAVE.pending, cam: Object.keys(localStorage).some(k => k.startsWith('wb-cam-')) }));
  check('N36: a pan in A saves no board (the camera goes to localStorage)', !puts(t0).length && !s0.pending && s0.cam, JSON.stringify({ puts: puts(t0).length, s0 }));
  const camB = await B.evaluate(() => ({ ...window.__canvas.S.cam }));
  const mvA = await moveCard(A, 60);
  await until(() => B.evaluate(id => window.__canvas.S.nodes[id].x, mvA.id).then(x => x === mvA.x), 5000); await sleep(1000);
  const s = await B.evaluate(id => ({ x: window.__canvas.S.nodes[id].x, cam: { ...window.__canvas.S.cam }, pending: window.__canvas.SAVE.pending }), mvA.id), b = await barOf(B);
  check('N36: a clean B takes A\'s move without a bar and keeps its own camera', s.x === mvA.x && b.hidden && JSON.stringify(s.cam) === JSON.stringify(camB) && !s.pending, JSON.stringify({ s, b, camB, mvA, aBar: await barOf(A), aSave: await A.evaluate(() => ({ pending: window.__canvas.SAVE.pending, busy: window.__canvas.SAVE.busy, paused: window.__canvas.SAVE.paused })), puts: await Promise.all(puts(t0).map(status)) }));
  await B.route('**/api/board', r => r.request().method() === 'PUT' ? r.abort() : r.continue());
  await moveCard(B, -30); await sleep(800);
  await settled(A); await moveCard(A, 20);
  await until(async () => (await barOf(B)).key === 'conflict', 6000);
  const b2 = await barOf(B);
  check('N36: B with an unsaved edit shows the conflict bar with counts', !b2.hidden && b2.key === 'conflict' && /This tab: [1-9]\d* changes?; server: newer/.test(b2.text), JSON.stringify(b2));
  await B.close(); await settled(A);
});
