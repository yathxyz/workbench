import fs from 'node:fs';
import { check, section, skip, sleep, state, until } from '../shared.mts';
import { EXIT_HUB, H, hubCtl, ptyOf, sessions, termText, typeIn } from '../daemon.mts';

const { T, tid } = state;

// N7 and N8 (first case) stop the hub through the harness (M1-N)
await section('N7/N8', async () => {
  if (!await hubCtl('stop')) { for (const n of ['N7', 'N8 (stateDir wipe)']) skip(n, 'the harness did not acknowledge "stop hub" on stdin (M1-N open request)'); return; }
  await until(() => T.evaluate(() => document.querySelector('#st-net')!.textContent === 'hub down'), 10000);
  const chip = await T.evaluate(() => document.querySelector('#st-net')!.textContent);
  const t0 = Date.now(); await sleep(10000);
  const tries = ptyOf(T, tid, t0).length;
  check('N7: hub down shows the chip, and a 1013 socket does not retry in a loop', chip === 'hub down' && tries <= 1, JSON.stringify({ chip, tries }));
  await hubCtl('start');
  // The exit text first arrives when the hub stops. The reconnect's hello then resets the screen, and the corpse's exit
  // prints the text again a moment later, so the check waits for the reconnected card and judges one snapshot of the page.
  const n7 = () => T.evaluate(({ id, EXIT_HUB }) => {
    const C = window.__canvas, b = C.live[id].backend, buf = C.live[id].term.buffer.active, rows = [];
    for (let i = 0; i < buf.length; i++) rows.push(buf.getLine(i).translateToString(true));
    return { text: rows.join('\n').includes(EXIT_HUB), back: b.ws?.readyState === 1 && b.dead && b.exitReason === 'hub_restart', toast: document.querySelector('#toast')!.textContent, attn: C.attnItems().filter((a: RgEntry) => a.key === id).length };
  }, { id: tid!, EXIT_HUB });
  const st = await until(async () => { const s = await n7(); return s.text && s.back && /hub restarted/.test(s.toast) ? s : null; }, 20000) || await n7();
  check('N7: after the hub restarts the card shows the hub_restart text, the toast says so, and the card is not "ended"', st.text && st.back && /hub restarted/.test(st.toast) && st.attn === 0, JSON.stringify(st));
  // N8 (amended): a live shell, then a wiped stateDir: the card says No session, and Enter starts a shell with the marker.
  // The card already shows both lines from N7, so the check counts new ones.
  const count = async (k: string) => (await termText(T, tid!)).split(k).length - 1, NOSESS = '[No session: press Enter', MARKER = '[new shell';
  await typeIn(T, tid!, '\r'); await until(async () => (await sessions()).find(s => s.sid === tid)?.alive, 10000);
  const n0 = await count(NOSESS), m0 = await count(MARKER);
  await hubCtl('stop'); fs.rmSync(H.stateDir, { recursive: true, force: true }); await hubCtl('start');
  const noSess = await until(async () => await count(NOSESS) > n0, 20000);
  await typeIn(T, tid!, '\r');
  const marker = await until(async () => await count(MARKER) > m0, 10000);
  const alive = !!(await sessions()).find(s => s.sid === tid)?.alive;
  check('N8: after a stateDir wipe the card says No session; Enter starts a shell with the [new shell] marker', noSess && marker && alive, JSON.stringify({ noSess, marker, alive, tail: (await termText(T, tid!)).slice(-300) }));
});
