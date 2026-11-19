import { check, sleep, state } from '../shared.mts';
import { ACWD, acpView, acpWs, stubSection } from '../acp.mts';

await stubSection('N41', async () => {
  const { AP } = state;
  const t1 = Date.now();
  const id = await AP.evaluate((cwd: string) => window.__canvas.addNode({ kind: 'acp', name: 'n41', agent: 'stub', cwd, x: 3000, y: 2600, w: 560, h: 400, _spawn: false }).id, ACWD);
  await sleep(10000);
  const ws = acpWs(AP, id, t1), v = await acpView(AP, id);
  check('N41: an /acp open that gets not_found makes exactly one socket in 10 s, and the card offers Start new session',
    ws.length === 1 && ws[0].recv.some(m => m.t === 'error' && m.code === 'not_found') && v!.st === 'exited' && /No session for this card/.test(v!.state) && /Start new session/.test(v!.state), JSON.stringify({ sockets: ws.length, recv: ws.map(w => w.recv.map(m => m.t + ((m as { code?: string }).code ? ':' + (m as { code?: string }).code : ''))), st: v?.st, state: v?.state }));
  await AP.evaluate((id: string) => window.__canvas.removeNode(id), id);
});
