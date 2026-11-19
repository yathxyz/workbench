import { check, section, sleep, until } from '../shared.mts';
import { dpage, netBack, netCut, newTerm, sessions, settled } from '../daemon.mts';

// §3.5.1: removing a card while its socket waits for the network still ends its session once the server is back
await section('kill while reconnecting', async () => {
  const P = await dpage();
  try {
    const id = await newTerm(P, 'reap');
    netCut();
    const waiting = await until(() => P.evaluate(id => window.__canvas.live[id]?.el.classList.contains('net-wait'), id), 8000);
    await P.evaluate(id => window.__canvas.removeNode(id), id);
    await sleep(500); netBack();
    const gone = await until(async () => !(await sessions()).some(s => s.sid === id), 20000);
    check('§3.5.1: a card removed while it reconnects ends its session when the server is back', waiting && gone, JSON.stringify({ waiting, gone, left: (await sessions()).filter(s => s.sid === id) }));
    await settled(P);
  } finally { netBack(); await P.close(); }
});
