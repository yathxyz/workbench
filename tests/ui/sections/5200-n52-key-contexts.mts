import { check, section, sleep, until } from '../shared.mts';
import { boardState, dpage, newTerm, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N52-N54: the key contexts (§6.4). A card keeps the keys it needs, the leader's Esc leaves it, the board has hints,
// card actions and arrange mode, and no context binds a key twice.
const inTermOf = (p: TailPage, id: string) => p.evaluate((id: string) => !!document.activeElement?.closest(`.node[data-id="${id}"]`) && document.activeElement.classList.contains('xterm-helper-textarea'), id);

await section('N52', async () => {
  const P = await dpage(); await P.bringToFront();
  try {
    const id = await newTerm(P, 'n52');
    await P.evaluate((id: string) => { const C = window.__canvas; C.typeInto(C.S.nodes[id]); window.__n52 = []; C.live[id].term.onData((d: string) => window.__n52.push(d)); }, id);
    await until(() => inTermOf(P, id));
    const s0 = await boardState(P);
    for (const k of ['Control+k', 'Control+j', 'Alt+b', 'Alt+v', 'Alt+1', 'Alt+Shift+Digit5', 'Alt+ArrowLeft', 'Escape']) await P.keyboard.press(k);
    await sleep(300);
    const got = await P.evaluate(() => window.__n52.join('')), s1 = await boardState(P), still = await inTermOf(P, id);
    await P.keyboard.press('Control+c');
    await P.keyboard.press('Control+Backquote'); await sleep(200); const docked = (await boardState(P)).dock;
    await P.keyboard.press('Control+Backquote'); await sleep(200);
    const want = ['\x0b', '\n', '\x1bb', '\x1bv', '\x1b1', '\x1b%', '\x1b'];
    check('N52: in a shell, C-k, C-j, M-b, M-v, M-1, M-%, M-← and Esc reach the program and change nothing on the board; Ctrl-` still toggles the dock',
      want.every(w => got.includes(w)) && JSON.stringify(s0) === JSON.stringify(s1) && still && docked !== s1.dock, JSON.stringify({ got, s0, s1, still, docked }));
    // K3: the leader's Esc leaves the shell, the card stays selected; the leader twice is the leader for the program
    await P.keyboard.press('Control+Space'); await P.keyboard.press('Escape'); await sleep(200);
    const left = await P.evaluate((id: string) => ({ ctx: window.__canvas.keyContext(), sel: document.querySelector<HTMLElement>('.active[data-id]')?.dataset.id === id }), id);
    await P.evaluate((id: string) => { const C = window.__canvas; C.typeInto(C.S.nodes[id]); }, id); await until(() => inTermOf(P, id));
    await P.evaluate(() => { window.__n52.length = 0; });
    await P.keyboard.press('Control+Space'); await P.keyboard.press('Control+Space'); await sleep(200);
    const nul = await P.evaluate(() => window.__n52.join('')), still2 = await inTermOf(P, id);
    // a page is an Edwin frame, which owns every key but the leader (edwind spec R9.7, the `edwin` interior of keys.js), so
    // C-k is Edwin's and the palette stays shut; the leader's Esc leaves it
    const pageInterior = 'edwin';
    const pg = await P.evaluate(() => { const C = window.__canvas, n = Object.values<BoardNode>(C.S.nodes).find(n => n.kind === 'buffer' && !C.stashed(n)); C.typeInto(n); return n!.id; });
    // typeInto may first bring the page into view; the keyboard is in it once its element has the focus
    const inPage = () => until(() => P.evaluate(([id, k]: string[]) => !!document.activeElement?.closest(`.node[data-id="${id}"]`) && window.__canvas.keyContext().interior === k, [pg, pageInterior]));
    await inPage();
    await P.keyboard.press('Control+k'); const pal = (await boardState(P)).palette; await P.keyboard.press('Escape');
    await P.evaluate((id: string) => window.__canvas.typeInto(window.__canvas.S.nodes[id]), pg); await inPage();
    await P.keyboard.press('Control+Space'); await P.keyboard.press('Escape'); await sleep(200);
    const leftPage = await P.evaluate((id: string) => ({ ctx: window.__canvas.keyContext(), sel: document.querySelector<HTMLElement>('.active[data-id]')?.dataset.id === id }), pg);
    check('N53: the leader\'s Esc leaves a shell and a page with the card still selected; the leader twice reaches the shell; C-k in a page is Edwin\'s (the palette stays shut)',
      !left.ctx.interior && left.sel && nul === '\x00' && still2 && !pal && !leftPage.ctx.interior && leftPage.sel, JSON.stringify({ left, nul, still2, pal, leftPage }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});
