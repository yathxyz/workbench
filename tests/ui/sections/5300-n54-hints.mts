import { check, section, sleep } from '../shared.mts';
import { boardState, dpage, newTerm, palLabels, settled } from '../daemon.mts';

await section('N54', async () => {
  const P = await dpage(); await P.bringToFront();
  try {
    const id = await newTerm(P, 'n54');
    await P.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); (document.activeElement as HTMLElement | null)?.blur(); }, id); await sleep(600);
    const errs = await P.evaluate(() => WBKeys.check({ commands: new Set(Object.keys(window.__canvas.KC)) }).errors);
    await P.keyboard.press('f');
    const label = await P.evaluate((id: string) => window.__canvas.HINTS.items.find((i: { node?: BoardNode; label: string }) => i.node?.id === id)?.label, id);
    if (label) await P.keyboard.type(label);
    const picked = await P.evaluate((id: string) => ({ hints: window.__canvas.HINTS.on, sel: document.querySelector<HTMLElement>('.active[data-id]')?.dataset.id === id }), id);
    const at = () => P.evaluate((id: string) => { const n = window.__canvas.S.nodes[id]; return [n.x, n.y, n.w, n.h].join(); }, id);
    const a0 = await at();
    await P.keyboard.press('m'); await P.keyboard.press('l'); await P.keyboard.press('L');
    const a1 = await at(), on = await P.evaluate(() => window.__canvas.ARR.on);
    await P.keyboard.press('Escape'); const a2 = await at();
    await P.keyboard.press('.'); await sleep(200);
    const acts = await palLabels(P); await P.keyboard.press('Escape');
    const dock0 = (await boardState(P)).dock;
    await P.keyboard.press('Control+Shift+P'); await P.keyboard.type('fold');
    const sel = async () => P.evaluate(() => [...document.querySelectorAll('#pal-list .pi')].findIndex(x => x.classList.contains('sel')));
    const p0 = await sel(); await P.keyboard.press('Control+j'); const p1 = await sel(); await P.keyboard.press('Control+k'); const p2 = await sel();
    const dock = (await boardState(P)).dock; await P.keyboard.press('Escape');
    check('N54: no context binds a key twice and every bound command exists; f then a label selects the card; m moves and resizes it and Esc puts it back; . lists its actions; C-j and C-k move the palette selection',
      !errs.length && !!label && !picked.hints && picked.sel && on && a1 !== a0 && a2 === a0 && acts.some(l => /^Arrange/.test(l)) && p1 === p0 + 1 && p2 === p0 && dock === dock0,
      JSON.stringify({ errs: errs.slice(0, 3), label, picked, a0, a1, a2, on, acts: acts.slice(0, 6), p: [p0, p1, p2], dock, dock0 }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});
