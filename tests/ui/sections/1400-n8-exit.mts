import { check, section, sleep, state, until } from '../shared.mts';
import { sessions, termText, typeIn } from '../daemon.mts';

const { T, tid } = state;

// N8, second case: exit in a shell, then Enter starts a new one without the [new shell] marker
await section('N8 exit', async () => {
  await typeIn(T, tid!, 'exit\r');
  await until(() => T.evaluate(id => window.__canvas.live[id].backend.dead, tid!), 8000);
  await typeIn(T, tid!, '\r');
  await until(async () => (await sessions()).find(s => s.sid === tid)?.alive, 8000); await sleep(800);
  check('N8: exit, then Enter starts a new shell without the [new shell] marker', !(await termText(T, tid!)).includes('[new shell') && !!(await sessions()).find(s => s.sid === tid)?.alive, (await termText(T, tid!)).slice(-300));
});
