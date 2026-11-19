import { check, section, state, until } from '../shared.mts';
import { barOf, moveCard, puts, settled } from '../daemon.mts';

const { A } = state;

// N5: a failing PUT shows the save bar and retries with growing gaps; recovery clears the bar
await section('N5', async () => {
  await A.route('**/api/board', r => r.request().method() === 'PUT' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced"}' }) : r.continue());
  const t0 = Date.now(); await moveCard(A);
  await until(() => puts(t0).length >= 3, 10000);
  const ts = puts(t0).map(e => e.t), gaps = ts.slice(1).map((t, i) => t - ts[i]), b = await barOf(A);
  check('N5: a 500 on PUT shows the save bar and retries with growing gaps', ts.length >= 3 && gaps.every((g, i) => !i || g >= gaps[i - 1]) && !b.hidden && b.key === 'save', JSON.stringify({ gaps, b }));
  await A.unroute('**/api/board');
  check('N5: after recovery the bar clears', !!await settled(A) && (await barOf(A)).hidden, JSON.stringify(await barOf(A)));
});
