import { check, section, state, until } from '../shared.mts';
import { api, barOf, boardFile, moveCard, puts, settled, status } from '../daemon.mts';

const { A } = state;

// N4: another writer saves while this tab has an unsaved move (an outside write before the move would simply be
// taken in, F-A7); Overwrite with this tab wins
await section('N4', async () => {
  const mv = await moveCard(A, 25);
  const cur = await api('/api/board'), etag = cur.headers.get('ETag'), theirs = await cur.json();
  theirs.nodes[mv.id].name = 'changed elsewhere';
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag! }, body: JSON.stringify(theirs) });
  await until(async () => (await barOf(A)).key === 'conflict', 5000);
  const b = await barOf(A);
  check('N4: an outside write during an unsaved edit shows the conflict bar', r.status === 204 && !b.hidden && b.key === 'conflict' && /This tab: 1 change/.test(b.text), JSON.stringify({ put: r.status, b }));
  const t0 = Date.now();
  await A.click('#bar .acts button:has-text("Overwrite with this tab")', { timeout: 5000 });
  await until(() => puts(t0).length, 5000); await settled(A);
  const disk = boardFile()?.nodes?.[mv.id];
  check('N4: Overwrite with this tab saves (204) and the file holds this tab\'s version', !!puts(t0)[0] && await status(puts(t0)[0]) === 204 && disk?.x === mv.x && disk?.name !== 'changed elsewhere' && (await barOf(A)).hidden, JSON.stringify({ disk, x: mv.x }));
});
