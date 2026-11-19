import { check, skip, sleep, state, until } from '../shared.mts';
import { settled } from '../daemon.mts';
import { ACWD, acpClick, acpEvs, acpSay, acpView, stubSection } from '../acp.mts';

// N27 needs the request in the middle: `reconnect` = wb-fake-acp --scenario permission-reconnect, whose prompt streams 116
// chunks, asks a permission and streams 80 more. In a fresh session: spawn 1, session 2, prompt 3, the request at 120, head 200.
await stubSection('N27', async () => {
  const { AP, RECONNECT } = state;
  if (!RECONNECT) return skip('N27', 'no `reconnect` agent (wb-fake-acp --scenario permission-reconnect) in /api/info.agents');
  const id = await AP.evaluate((cwd: string) => window.__canvas.addNode({ kind: 'acp', name: 'n27', agent: 'reconnect', cwd, x: 3000, y: 2600, w: 560, h: 520 }).id, ACWD);
  await acpSay(AP, id, 'go');
  const pre = await until(async () => { const v = await acpView(AP, id); return v?.perm === 1 && v.seq >= 200 ? v : null; }, 20000);
  await sleep(500);
  const logOf = () => AP.evaluate((id: string) => [...window.__canvas.live[id].body.querySelectorAll('.ag-log > *')].map(e => e.className + ':' + e.textContent), id), dom0 = await logOf();
  await settled(AP); await AP.reload(); await until(() => AP.evaluate(() => window.__canvas?.BOOTED));
  const after = await until(async () => { const v = await acpView(AP, id); return v?.perm === 1 && v.seq >= 200 ? v : null; }, 20000);
  await sleep(500);
  const dom1 = await logOf(), items = after?.items || [], at = items.findIndex(x => x.startsWith('tool:')), perm = acpEvs(AP, id, 'permission')[0];
  const inOrder = items.length === 200 && at === 119 && items[at] === 'tool:pending Run `make check`'
    && items.slice(3, at).every((x, i) => x === 'asst:before ' + (i + 1)) && items.slice(at + 1).every((x, i) => x === 'asst:after ' + (i + 117));
  await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]');
  const res = await until(() => acpEvs(AP, id, 'permission_resolved', 200)[0], 10000);
  check('N27: a reload with a permission pending at seq 120 of 200 renders all 200 items in order with the request in its place, and the panel answers',
    !!pre && !!after && perm?.seq === 120 && after.seq === 200 && inOrder && JSON.stringify(items) === JSON.stringify(pre.items) && dom1.length === dom0.length && dom1.every((t, i) => t === dom0[i]) && res?.by === 'user',
    JSON.stringify({ seq: after?.seq, perm: perm?.seq, n: items.length, at, around: items.slice(at - 1, at + 2), same: JSON.stringify(items) === JSON.stringify(pre?.items), n0: dom0.length, n1: dom1.length, diff: dom1.findIndex((t, i) => t !== dom0[i]), res }));
  await AP.evaluate((id: string) => window.__canvas.removeNode(id), id); await settled(AP);
});
