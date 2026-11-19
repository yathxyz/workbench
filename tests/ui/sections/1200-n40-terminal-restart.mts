import { check, section, state, until } from '../shared.mts';
import { dpage, hlog, newTerm, ptyOf, sessions, termText, typeIn, webRestart } from '../daemon.mts';

// N40: a wb-web restart with an open terminal resumes it, and the scrollback above the viewport stays
await section('N40', async () => {
  const T = state.T = await dpage();
  const tid = state.tid = await newTerm(T, 'n40');
  await typeIn(T, tid, 'echo MARK40-$((6*7)); seq 1 120\r');
  await until(async () => (await termText(T, tid!)).includes('\n120'));
  const pid0 = state.pid0 = (await sessions()).find(s => s.sid === tid)?.pty?.pid;
  const t0 = Date.now();
  if (!await webRestart()) return check('N40: the harness restarts wb-web on SIGHUP', false, hlog.slice(-500));
  const w = await until(() => ptyOf(T, tid, t0).find(w => w.hello), 15000);
  const s = await T.evaluate(id => { const b = window.__canvas.live[id].term.buffer.active; let at = -1; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).includes('MARK40-42')) at = i; return { at, top: b.viewportY, len: b.length }; }, tid);
  const pid1 = (await sessions()).find(s => s.sid === tid)?.pty?.pid;
  check('N40: after a wb-web restart the terminal reconnects with resumed:true and keeps the scrollback above the viewport', w?.hello?.resumed === true && s.at >= 0 && s.at < s.top && pid1 === pid0, JSON.stringify({ hello: w?.hello && { ...w.hello, replay: undefined }, s, pid0, pid1 }));
});
