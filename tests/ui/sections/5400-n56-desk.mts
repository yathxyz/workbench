import { check, section, sleep, state, until, watchErrors } from '../shared.mts';
import { ORIGIN, barOf, boardFile, dpage, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

const { browser } = state;

/* A card's place as the desk checks compare it: folder, rectangle, order. */
type TailGeom = Pick<BoardNodeBase, 'in' | 'x' | 'y' | 'w' | 'h' | 'order'>;
/* The cards N56 follows: a page in a folder, a top folder, the page's folder, another loose card. */
interface DeskMarks { a: string; f: string; ain: string | null | undefined; other: string | null }

// N56: desks (§10.8, D1). A desk shows its members at its own rectangles and hides the rest; the board file keeps the
// Board's geometry whichever desk is shown; leader digits, Alt-Shift-digits, m and ` drive it; a card made on a desk joins
// it and a spawned card joins its parent's desks; a scratch desk stays on the device and a pinned one reaches the other.
await section('N56', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
  const devB = async () => { const p = await ctx2.newPage(); watchErrors(p); await p.goto(ORIGIN + '/'); await until(() => p.evaluate(() => window.__canvas?.BOOTED)); return p; };
  const leader = async (p: TailPage, ...keys: string[]) => { await p.keyboard.press('Control+Space'); await sleep(120); for (const k of keys) { await p.keyboard.press(k); await sleep(150); } await sleep(300); };
  const geom = (p: TailPage) => p.evaluate(() => Object.fromEntries(Object.values<BoardNode>(window.__canvas.S.nodes).map(n => [n.id, { in: n.in, x: n.x, y: n.y, w: n.w, h: n.h, order: n.order }])));
  const g6 = (n: TailGeom | undefined) => n && [n.in || null, n.x, n.y, n.w, n.h, n.order ?? null], diffOf = (pos: Record<string, unknown>, nodes: Record<string, TailGeom>) => Object.entries(pos).filter(([id, v]) => JSON.stringify(g6(nodes[id])) !== JSON.stringify(v)).slice(0, 3).map(([id, v]) => [id, v, g6(nodes[id])]);
  const sameAs = (pos: Record<string, unknown>, nodes: Record<string, TailGeom>) => !diffOf(pos, nodes).length;
  let B: TailPage | undefined, D: TailPage | undefined, m: DeskMarks;
  try {
    D = await dpage(); await settled(D);
    m = await D.evaluate(() => { const C = window.__canvas, S = C.S; C.perspSet('manual', true); C.focusHide(); if (C.WS.cur) C.wsLeave();
      const a = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'buffer' && n.in && !C.stashed(n)), up = new Set(); for (let c = a; c?.in; c = S.nodes[c.in]) up.add(c.in); const f = C.wsTop().find((f: FrameNode) => !up.has(f.id) && !C.stashed(f) && f.mode !== 'stack');
      const other = Object.values<BoardNode>(S.nodes).find(n => n.kind !== 'frame' && n !== a && !n.in);
      C.pickClear(); C.pickToggle(a!.id, true); C.pickToggle(f.id, true); (document.activeElement as HTMLElement | null)?.blur?.(); return { a: a!.id, f: f.id, ain: a!.in, other: other?.id || null }; });
    const pos = Object.fromEntries(Object.entries(await geom(D)).map(([id, n]) => [id, g6(n)]));
    await leader(D, 'm', '2'); await leader(D, '2');
    const on = await D.evaluate((m: DeskMarks) => { const C = window.__canvas, S = C.S, a = S.nodes[m.a];
      const shown = Object.values<BoardNode>(S.nodes).filter(n => !C.stashed(n)).map(n => n.id).sort(), want = [m.a, m.f, ...Object.values<BoardNode>(S.nodes).filter(n => { for (let c = n; c; c = c.in && S.nodes[c.in]) if (c.in === m.f) return true; return false; }).map(n => n.id)].sort();
      const hid = m.other && document.querySelector(`[data-id="${m.other}"]`)?.classList.contains('stashed');
      C.moveTree(a, 300, 40); C.dirty();
      return { cur: C.DESK.cur, ok: JSON.stringify(shown) === JSON.stringify(want), shown: shown.length, want: want.length, ain: a.in || null, hid, a: [a.x, a.y, a.w, a.h], pager: [...document.querySelectorAll<HTMLElement>('#st-desk .dk')].filter(b => b.dataset.slot !== '9').map(b => b.textContent + (b.classList.contains('on') ? '*' : '')).join(' ') }; }, m);
    await sleep(800); await settled(D);
    let disk = boardFile()!;
    const view = await D.evaluate(() => JSON.parse(localStorage.getItem(window.__canvas.viewKey()) as string));
    const sd = view?.scratch?.find((d: Desk) => d.slot === 2);
    check('N56: leader m 2 and leader 2 show desk 2 with only its items, the card loose out of its hidden folder; the board file keeps the Board exactly and no scratch desk',
      on.cur === 2 && on.ok && on.ain === null && (on.hid ?? true) && on.pager === '0 2*' && sameAs(pos, disk.nodes) && !(disk.desks || []).length && view?.desk === 2 && JSON.stringify(sd?.members?.[m.a]) === JSON.stringify(on.a),
      JSON.stringify({ on, sd, desks: disk.desks, diff: diffOf(pos, disk.nodes) }));
    // The keyboard must be on the board: a page load focuses the docked terminal 60 ms after boot, which can land after
    // the blur above, and a terminal keeps Alt-Shift-0 for itself.
    await D.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await D.keyboard.press('Alt+Shift+Digit0'); await sleep(400);
    const back = await geom(D), cur0 = await D.evaluate(() => window.__canvas.DESK.cur);
    await leader(D, '`');
    const again = await D.evaluate((id: string) => { const C = window.__canvas, a = C.S.nodes[id]; return { cur: C.DESK.cur, a: [a.x, a.y, a.w, a.h] }; }, m.a);
    check('N56: Alt-Shift-0 puts every item back on the Board exactly; leader ` returns to desk 2 and its own rectangles',
      cur0 === 0 && sameAs(pos, back) && again.cur === 2 && JSON.stringify(again.a) === JSON.stringify(on.a), JSON.stringify({ cur0, again, a: on.a, diff: diffOf(pos, back) }));
    const made = await D.evaluate((m: DeskMarks) => { const C = window.__canvas, S = C.S, a = S.nodes[m.a];
      const n = C.addNode({ kind: 'buffer', name: 'n52-new', x: a.x, y: a.y + a.h + 400, w: 320, h: 200 }); const joined = C.DESK.mem.has(n.id) && !C.stashed(n);
      C.deskGo(0, true); const onBoard = !C.stashed(n);
      const k = C.spawnChild(n, 'n52-kid'); const kid = C.deskAt(2).members[k.id];
      return { n: n.id, k: k.id, joined, onBoard, kid, rel: kid && [kid[0] - (C.deskAt(2).members[n.id] || [0, 0])[0]], dx: k.x - n.x }; }, m);
    check('N56: a card made on a desk joins it and has a place on the Board; a card spawned on the Board joins its parent\'s desks beside the parent',
      made.joined && made.onBoard && !!made.kid && made.rel?.[0] === made.dx, JSON.stringify(made));
    await D.evaluate(() => { const C = window.__canvas; C.deskGo(2, true); C.deskPin(); }); await sleep(800); await settled(D);
    disk = boardFile()!;
    B = await devB();
    const b1 = await B.evaluate((m: DeskMarks) => { const C = window.__canvas; const d = C.deskAt(2); return { pinned: C.deskPinned(d), cur: C.DESK.cur, has: !!d && m.a in d.members }; }, m);
    await B.evaluate(() => window.__canvas.deskGo(2, true));
    await sleep(700); await settled(B);
    const mv = await D.evaluate((m: DeskMarks) => { const C = window.__canvas, S = C.S; C.deskGo(0, true); const n = S.nodes[m.other!] || Object.values<BoardNode>(S.nodes).find(n => n.kind !== 'frame' && !n.in && !(n.id in C.deskAt(2).members)); C.moveTree(n, 90, 0); C.dirty(); return { id: n.id, x: n.x }; }, m);
    await settled(D);
    const took = await until(() => B!.evaluate((mv: { id: string; x: number }) => { const C = window.__canvas; return C.DESK.cur === 2 && JSON.parse(C.serialize()).nodes[mv.id]?.x === mv.x; }, mv), 6000);
    const b2 = await B.evaluate((m: DeskMarks) => { const C = window.__canvas, a = C.S.nodes[m.a]; return { cur: C.DESK.cur, a: [a.x, a.y], hidden: C.stashed(C.S.nodes[m.ain!]) }; }, m), bar = await barOf(B);
    check('N56: a pinned desk is in the board file and on the other device; a device on a desk takes another device\'s move and stays on its desk',
      (disk.desks || []).some((d: Desk) => d.slot === 2 && m.a in d.members) && b1.pinned && b1.has && b1.cur === 0 && !!took && b2.cur === 2 && b2.a[0] === on.a[0] && b2.hidden && bar.hidden, JSON.stringify({ b1, b2, took, bar, desks: disk.desks?.length }));
    await D.evaluate((made: { k: string; n: string }) => { const C = window.__canvas; C.deskGo(2, true); C.deskDelete(); for (const id of [made.k, made.n]) if (C.S.nodes[id]) C.removeNode(id); }, made);
    await settled(D);
  } finally { await B?.close(); await D?.close(); await ctx2.close(); }
});
