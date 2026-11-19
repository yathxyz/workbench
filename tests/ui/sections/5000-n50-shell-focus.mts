import { check, section, sleep, until } from '../shared.mts';
import { dpage, newTerm, termText } from '../daemon.mts';
import { focusFlights } from '../focus-flights.mts';

// N50: Enter on the active shell card puts the keyboard in that shell where the card stands; Shift-Enter opens it full screen.
await section('N50', async () => {
  const P = await dpage(); await P.bringToFront();
  try {
    const id = await newTerm(P, 'n50');
    await P.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); }, id); await sleep(600);
    await P.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await P.keyboard.press('Enter'); await sleep(400);
    const inTerm = await P.evaluate((id: string) => ({ term: !!document.activeElement?.closest(`.node[data-id="${id}"]`) && document.activeElement.classList.contains('xterm-helper-textarea'), focus: window.__canvas.FOCUS.cur }), id);
    await P.keyboard.type('echo n50-$((6*7))\r');
    const typed = await until(async () => (await termText(P, id)).includes('n50-42'), 5000);
    await P.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await P.keyboard.press('Shift+Enter'); await sleep(400);
    const tab = await P.evaluate(() => window.__canvas.FOCUS.cur);
    await P.evaluate(() => window.__canvas.focusHide());
    check('N50: Enter on the active shell card puts the keyboard in its terminal on the canvas; Shift-Enter opens it as a focus tab', inTerm.term && !inTerm.focus && !!typed && tab === id, JSON.stringify({ inTerm, typed: !!typed, tab, id }));
    await focusFlights(P, id);
  } finally { await P.close(); }
});
