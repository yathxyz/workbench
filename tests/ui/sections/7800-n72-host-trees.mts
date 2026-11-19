import { check, section, until } from '../shared.mts';
import { api, dpage, newTerm, sessions, settled } from '../daemon.mts';

// M5-W3: the host trees. A board shell's process is listed with its card; units answer their shape whatever the host has.
await section('N72', async () => {
  const P = await dpage();
  try {
    const id = await newTerm(P, 'n68');
    const pid = await until(async () => (await sessions()).find(s => s.sid === id)?.pty?.pid, 10000);
    const procs = (await (await api('/api/proc')).json()).procs as ProcInfo[];
    const me = procs.find(p => p.pid === pid), units = await (await api('/api/units')).json(), stat = await (await api('/api/status')).json();
    check('N72: /api/proc lists a board shell\'s process with its card; /api/units and /api/status.units answer their shapes',
      !!me && me.node === id && me.ppid > 0 && typeof me.cmd === 'string' && Array.isArray(units.units) && (units.error === null || typeof units.error === 'string') && typeof stat.units?.total === 'number', JSON.stringify({ me, units: { n: units.units?.length, error: units.error }, su: stat.units }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});
