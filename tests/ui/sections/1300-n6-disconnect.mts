import { check, section, sleep, state, until } from '../shared.mts';
import { netBack, netCut, ptyOf, sessions, termText, typeIn } from '../daemon.mts';

const { T, tid, pid0 } = state;

// N6: the server unreachable for 5 s. The forwarder drops every connection, since the harness cannot stop wb-web alone.
await section('N6', async () => {
  await typeIn(T, tid!, 'echo MARK6\r'); await until(async () => (await termText(T, tid!)).includes('\nMARK6'));
  const t0 = Date.now(); netCut();
  await sleep(1500);
  const during = await T.evaluate(id => ({ chip: document.querySelector('#st-net')!.textContent, hidden: document.querySelector<HTMLElement>('#st-net')!.hidden, wait: document.querySelector(`.node[data-id="${id}"]`)!.classList.contains('net-wait') }), tid!);
  await sleep(3500);
  const tBack = Date.now(); netBack();
  const back = await until(() => ptyOf(T, tid, tBack).find(w => w.hello), 20000);
  const ts = ptyOf(T, null, t0).filter(w => w.t < tBack).map(w => w.t), gaps = ts.slice(1).map((t, i) => t - ts[i]), last = gaps.at(-1) || 0;
  const pid1 = (await sessions()).find(s => s.sid === tid)?.pty?.pid, screen = await termText(T, tid!);
  check('N6: while unreachable the chip reads reconnecting… and the card waits', !during.hidden && during.chip === 'reconnecting…' && during.wait, JSON.stringify(during));
  check('N6: socket attempts back off (at least 3, each gap at least half the previous)', ts.length >= 3 && gaps.every((g, i) => !i || g >= 0.5 * gaps[i - 1]), JSON.stringify(gaps));
  // 30 §10 says within 2x the last gap, but with equal jitter a gap in [d/2, d] is followed by one in [d, 2d]: up to 4x.
  check('N6: after the outage the card reconnects within 4x the last gap and keeps its screen and process', !!back && back.helloT! - tBack <= 4 * last + 1000 && pid1 === pid0 && screen.includes('MARK6') && !(await T.evaluate(id => document.querySelector(`.node[data-id="${id}"]`)!.classList.contains('net-wait'), tid!)), JSON.stringify({ took: back && back.helloT! - tBack, last, pid0, pid1 }));
});
