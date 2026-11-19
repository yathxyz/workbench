import { check, section, sleep, until } from '../shared.mts';
import { boardFile, dpage, newTerm, settled, typeIn } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N58: desks D2 (§10.8, F-A28). Tile and promote on a desk, a sticky card, the overview and the recent-places ring, the
// scratch overlay, and the attention desk with leader ! crossing desks. Each check reads the page's own state and, where
// the Board is at stake, the board file.
await section('N58', async () => {
  const leader = async (p: TailPage, ...keys: string[]) => { await p.keyboard.press('Control+Space'); await sleep(120); for (const k of keys) { await p.keyboard.press(k); await sleep(150); } await sleep(300); };
  const rect = (p: TailPage, id: string) => p.evaluate((id: string) => { const n = window.__canvas.S.nodes[id]; return [n.x, n.y, n.w, n.h]; }, id);
  const over = (a: number[], b: number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  let D: TailPage | undefined, tid: string | null | undefined;
  try {
    D = await dpage(); await settled(D);
    const m = await D.evaluate(() => { const C = window.__canvas, S = C.S; C.perspSet('manual', true); C.focusHide(); if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true);
      for (const d of C.deskList()) if (d.slot === 3) { C.deskGo(3, true); C.deskDelete(); }
      const ok = (n: BoardNode) => n.kind !== 'frame' && n.kind !== 'term' && !C.stashed(n) && !(S.sticky || []).includes(n.id), loose = Object.values<BoardNode>(S.nodes).find(n => ok(n) && !n.in);   // a loose card for sticky: a pack folder places its cards itself
      const cs = Object.values<BoardNode>(S.nodes).filter(n => ok(n) && n !== loose).slice(0, 4); cs.splice(3, 0, loose || cs.pop()!);
      C.pickClear(); for (const n of cs.slice(0, 3)) C.pickToggle(n.id, true); (document.activeElement as HTMLElement | null)?.blur?.();
      return { ids: cs.map(n => n.id), names: cs.map(n => n.name) }; });
    const [a, b, c, s, o] = m.ids;
    await leader(D, 'm', '3'); await leader(D, '3'); await leader(D, 'd', 't');
    const tile = await D.evaluate((ids: string[]) => { const C = window.__canvas, S = C.S; return { cur: C.DESK.cur, layout: C.deskAt(3)?.layout, r: ids.map(id => { const n = S.nodes[id]; return [n.x, n.y, n.w, n.h]; }), shown: Object.values<BoardNode>(S.nodes).filter(n => !C.stashed(n)).length }; }, [a, b, c]);
    await D.evaluate((a: string) => { const C = window.__canvas; C.pickClear(); C.activate(a); }, a);
    const here = await rect(D, a);
    await leader(D, 'd', 'b'); await leader(D, '0'); await sleep(600); await settled(D);
    const board = await rect(D, a), disk = boardFile()!.nodes[a];
    const crowd = await D.evaluate((a: string) => { const C = window.__canvas, S = C.S, n = S.nodes[a], r = [n.x, n.y, n.w, n.h], ov = (p: number[], q: number[]) => p[0] < q[0] + q[2] && q[0] < p[0] + p[2] && p[1] < q[1] + q[3] && q[1] < p[1] + p[3];
      return Object.values<BoardNode>(S.nodes).filter(m => m !== n && !C.stashed(m) && (m.in || null) === (n.in || null)).filter(m => ov(r, [m.x, m.y - (m.kind === 'frame' ? 30 : 0), m.w, m.h + (m.kind === 'frame' ? 30 : 0)])).map(m => m.id); }, a);
    check('N58: leader d t tiles desk 3 (three cards in cells that do not overlap); leader d b promotes a card: on the Board and in the board file it stands at its desk place, with nothing under it',
      tile.cur === 3 && tile.layout === 'tile' && tile.shown === 3 && !tile.r.some((p, i) => tile.r.some((q, j) => i < j && over(p, q))) && JSON.stringify(board) === JSON.stringify(here) && disk?.x === here[0] && disk?.y === here[1] && !crowd.length,
      JSON.stringify({ tile, here, board, disk: disk && [disk.x, disk.y], crowd }));
    await D.evaluate((s: string) => { const C = window.__canvas; C.pickClear(); C.activate(s); (document.activeElement as HTMLElement | null)?.blur?.(); }, s);
    await leader(D, 'd', 's'); await leader(D, '3');
    const st = await D.evaluate((s: string) => { const C = window.__canvas, n = C.S.nodes[s]; const r = { cur: C.DESK.cur, shown: !C.stashed(n), member: s in C.deskAt(3).members, x: n.x }; C.moveTree(n, 60, 0); C.dirty(); return r; }, s);
    await leader(D, '0'); await sleep(600); await settled(D);
    const st2 = await D.evaluate((s: string) => window.__canvas.S.nodes[s].x, s), fileS = boardFile()!;
    check('N58: leader d s makes a card sticky: it shows on desk 3 without being a member, and a move there is its move on the Board and in the board file',
      st.cur === 3 && st.shown && !st.member && st2 === st.x + 60 && (fileS.sticky || []).includes(s) && fileS.nodes[s]?.x === st.x + 60, JSON.stringify({ st, st2, sticky: fileS.sticky, fx: fileS.nodes[s]?.x }));
    await leader(D, 'g');
    const ov = await D.evaluate(() => [...document.querySelectorAll<HTMLElement>('#overview .ov-desk')].map(p => p.dataset.slot));
    for (let i = 0; i < ov.indexOf('3'); i++) { await D.keyboard.press('ArrowRight'); await sleep(120); }   // from the Board, first
    await D.keyboard.press('Enter'); await sleep(500);
    const ov1 = await D.evaluate(() => ({ cur: window.__canvas.DESK.cur, open: !!document.querySelector('#overview') }));
    await leader(D, 'g'); await D.keyboard.type(m.names[1].toLowerCase().slice(0, 4)); await sleep(200);
    const hits = await D.evaluate(() => document.querySelectorAll('#overview .ov-box.hit').length);
    await D.keyboard.press('Escape'); await sleep(200);
    await D.keyboard.press('Alt+2'); await sleep(400); await leader(D, 'w');
    const ring = await D.evaluate(() => [...document.querySelectorAll('#ring .rg-item')].map(x => x.textContent));
    await D.keyboard.press('Enter'); await sleep(500);
    const r1 = await D.evaluate(() => ({ view: document.body.dataset.view, cur: window.__canvas.DESK.cur }));
    check('N58: leader g shows the Board first and desk 3; → to it then Enter goes there; letters mark the matching cards; after Alt-2, leader w then Enter returns to desk 3 on the canvas',
      ov[0] === '0' && ov.includes('3') && ov1.cur === 3 && !ov1.open && hits > 0 && ring.length >= 2 && /desk · 3/.test(ring[1]) && r1.view === 'canvas' && r1.cur === 3, JSON.stringify({ ov, ov1, hits, ring, r1 }));
    await leader(D, '0');
    await D.evaluate((o: string) => { const C = window.__canvas; C.pickClear(); C.activate(o); (document.activeElement as HTMLElement | null)?.blur?.(); }, o);
    const o0 = await rect(D, o);
    await leader(D, 'm', 'x');
    const hid = await D.evaluate((o: string) => window.__canvas.stashed(window.__canvas.S.nodes[o]), o);
    await leader(D, 'x');
    const shown = await D.evaluate((o: string) => { const C = window.__canvas, n = C.S.nodes[o], r = document.querySelector(`.node[data-id="${o}"]`)!.getBoundingClientRect(), v = document.querySelector('#viewport')!.getBoundingClientRect(), saved = JSON.parse(C.serialize()).nodes[o];
      return { st: C.stashed(n), inView: r.left >= v.left && r.top >= v.top && r.right <= v.right && r.bottom <= v.bottom, saved: [saved.x, saved.y, saved.w, saved.h] }; }, o);
    await leader(D, 'x');
    const after = await D.evaluate((o: string) => ({ st: window.__canvas.stashed(window.__canvas.S.nodes[o]) }), o), o1 = await rect(D, o);
    check('N58: leader m x puts a card in the scratch overlay (hidden on the Board); leader x shows it inside the view while a save keeps its place; leader x hides it at that place',
      hid && !shown.st && shown.inView && JSON.stringify(shown.saved) === JSON.stringify(o0) && after.st && JSON.stringify(o1) === JSON.stringify(o0), JSON.stringify({ hid, shown, after, o0, o1 }));
    await leader(D, 'm', 'x');   // out again
    tid = await newTerm(D, 'n58');
    await typeIn(D, tid, 'exit\r'); await until(() => D!.evaluate((id: string) => window.__canvas.live[id].backend.dead, tid!), 8000);
    await D.evaluate(() => window.__canvas.statusRender());
    const pg = await D.evaluate(() => { const b = document.querySelector<HTMLElement>('#st-desk .dk[data-slot="9"]'); return b ? { bad: +b.dataset.bad! } : null; });
    await leader(D, '9');
    const d9 = await D.evaluate((id: string) => { const C = window.__canvas; return { cur: C.DESK.cur, shown: !C.stashed(C.S.nodes[id]), layout: C.deskAt(9)?.layout }; }, tid);
    await leader(D, '3'); await D.evaluate((a: string) => window.__canvas.activate(a), a); await leader(D, '!');
    const nx = await D.evaluate(() => { const C = window.__canvas, n = C.S.nodes[C.activeId] || null; return { cur: C.DESK.cur, act: n?.id, bad: C.attnItems().some((i: RgEntry) => i.attn === 'bad' && i.n?.id === n?.id), shown: n && !C.stashed(n) }; });
    check('N58: a shell that ended puts a 9 with a badge in the pager; leader 9 shows it on the tiled attention desk; leader ! from desk 3 goes to a card that needs a look, shown',
      pg?.bad! >= 1 && d9.cur === 9 && d9.shown && d9.layout === 'tile' && nx.bad && nx.shown, JSON.stringify({ pg, d9, nx }));
    await D.evaluate(({ tid, s }: { tid: string; s: string }) => { const C = window.__canvas; C.deskGo(0, true); C.removeNode(tid); C.pickClear(); C.activate(s); }, { tid, s }); tid = null;
    await leader(D, 'd', 's');
    await D.evaluate(() => { const C = window.__canvas; C.deskGo(3, true); C.deskDelete(); });
    await settled(D);
  } finally { if (tid) await D?.evaluate((id: string) => window.__canvas.removeNode(id), tid).catch(() => {}); await D?.close(); }
});
