import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check, HARNESS, skip, state, until } from '../shared.mts';
import { H, hubCtl, netBack, netCut } from '../daemon.mts';
import { ACWD, acpIdle, acpView, acpWs, stubSection } from '../acp.mts';

await stubSection('N28', async () => {
  const { AP, AID } = state;
  const id = AID, before = await acpIdle(AP, id);
  netCut();
  await until(() => AP.evaluate((id: string) => window.__canvas.live[id].el.classList.contains('net-wait'), id), 10000);
  if (!await hubCtl('stop')) { netBack(); return skip('N28', 'the harness did not acknowledge "stop hub"'); }
  fs.rmSync(H.stateDir, { recursive: true, force: true }); await hubCtl('start');
  // the same sid again, from another client: a new incarnation the card has not seen
  const r = spawnSync('python3', ['-I', path.join(path.dirname(HARNESS), 'wbctl.py'), '--hub', H.hubSocket, 'raw', JSON.stringify({ t: 'acp.open', rid: 1, sid: id, since: 0, spawn: { agent: 'stub', cwd: ACWD } })], { encoding: 'utf8', timeout: 20000 });
  const t1 = Date.now(); netBack();
  const w = await until(() => acpWs(AP, id, t1).find(w => w.hello), 40000), after = await until(async () => { const v = await acpView(AP, id); return v?.promptable ? v : null; }, 20000);
  const first = w?.recv.find(m => m.t === 'ev'), now = await acpView(AP, id), last = Math.max(0, ...(w?.recv || []).filter(m => m.t === 'ev').map(m => m.ev.seq));
  check('N28: a hello with reset (stateDir wiped, the session recreated) clears the card and repopulates its transcript from seq 1',
    r.status === 0 && w?.hello!.reset === true && w.open!.epoch === before?.epoch && first?.ev.seq === 1 && !!after && after.epoch !== before!.epoch && after.asst === 0 && after.items.length < before!.items.length
    && after.items.includes('note:agent started') && after.items.includes('note:session ready') && now?.seq === last,
    JSON.stringify({ wbctl: r.status, err: (r.stderr || '').slice(0, 200), reset: w?.hello?.reset, first: first?.ev, before: before?.items.length, after: after?.items, seq: now?.seq, last }));
});
