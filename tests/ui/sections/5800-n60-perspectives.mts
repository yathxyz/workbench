import { spawn } from 'node:child_process';
import { check, section, sleep, until } from '../shared.mts';
import { H, dpage, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N60 (F-A29): desks D3. A perspective is a place beside the Board; the columns layout; revert on a pinned desk; the desk
// tools and `wb desk ls` over web.sock; a second window on the same desk gives way, and going there swaps.
await section('N60', async () => {
  const leader = async (p: TailPage, ...keys: string[]) => { await p.keyboard.press('Control+Space'); await sleep(120); for (const k of keys) { await p.keyboard.press(k); await sleep(150); } await sleep(300); };
  const rect = (p: TailPage, id: string) => p.evaluate((id: string) => { const n = window.__canvas.S.nodes[id]; return [n.x, n.y, n.w, n.h]; }, id);
  const over = (a: number[], b: number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const geo = (p: TailPage) => p.evaluate(() => JSON.stringify(Object.values<BoardNode & { derived?: FrameDerived }>(window.__canvas.S.nodes).filter(n => n.kind !== 'ghost' && !n.derived).map(n => [n.id, n.in || null, n.x, n.y, n.w, n.h]).sort()));
  let D: TailPage | undefined, E: TailPage | null | undefined;
  try {
    D = await dpage(); await settled(D);
    const m = await D.evaluate(() => { const C = window.__canvas, S = C.S; C.perspSet('manual', true); C.focusHide(); if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true);
      for (const k of [3, 4]) if (C.deskAt(k)) { C.deskGo(k, true); C.deskDelete(); }
      const cs = Object.values<BoardNode>(S.nodes).filter(n => n.kind !== 'frame' && n.kind !== 'term' && !C.stashed(n) && !(S.sticky || []).includes(n.id)).slice(0, 4);
      C.pickClear(); (document.activeElement as HTMLElement | null)?.blur?.(); return { ids: cs.map(n => n.id), names: cs.map(n => n.name) }; });
    const g0 = await geo(D), pager = () => D!.evaluate(() => ({ place: window.__canvas.deskPlace(), pager: [...document.querySelectorAll('#st-desk .dk')].map(b => b.textContent) }));
    await leader(D, 'v', 't'); const p1 = await pager();
    await leader(D, '0'); const p2 = await pager(), g1 = await geo(D);
    await leader(D, '`'); const p3 = await pager();
    await leader(D, '0'); await settled(D);
    check('N60: leader v t shows the tag perspective as a place (v tag in the pager); leader 0 is the Board as it was; leader ` returns to the perspective',
      p1.place === 'persp:tag' && p1.pager.includes('v tag') && p2.place === 0 && p2.pager.includes('v tag') && g1 === g0 && p3.place === 'persp:tag', JSON.stringify({ p1, p2, p3, same: g1 === g0 }));
    const three = m.ids.slice(0, 3);
    await D.evaluate((ids: string[]) => { const C = window.__canvas; C.pickClear(); for (const id of ids) C.pickToggle(id, true); (document.activeElement as HTMLElement | null)?.blur?.(); }, three);
    await leader(D, 'm', '3'); await leader(D, '3'); await leader(D, 'd', 't'); await leader(D, 'd', 't');
    const cols = await D.evaluate((ids: string[]) => { const C = window.__canvas, S = C.S; return { cur: C.DESK.cur, layout: C.deskAt(3)?.layout, z: S.cam.z, r: ids.map(id => { const n = S.nodes[id]; return [n.x, n.y, n.w, n.h]; }) }; }, three);
    const right = three[cols.r.indexOf([...cols.r].sort((a, b) => b[0] - a[0])[0])];
    await D.evaluate((id: string) => { const C = window.__canvas; C.pickClear(); C.activate(id); }, right); await sleep(800);
    const vis = await D.evaluate((id: string) => { const r = document.querySelector(`.node[data-id="${id}"]`)!.getBoundingClientRect(), v = document.querySelector('#viewport')!.getBoundingClientRect(); return { l: r.left, r: r.right, vl: v.left, vr: v.right }; }, right);
    await leader(D, 'd', 'p');
    const pinned = await rect(D, right);
    await D.evaluate((id: string) => { const C = window.__canvas; C.moveTree(C.S.nodes[id], 240, 160); C.dirty(); }, right);
    await leader(D, 'd', 'u'); await settled(D);
    const back = await rect(D, right), saved = await D.evaluate(() => { const d = window.__canvas.deskAt(3); return { pinned: window.__canvas.deskPinned(d), saved: !!d?.saved }; });
    check('N60: leader d t twice makes desk 3 columns: one row, one height, zoom 1, no overlap; selecting the last card brings it whole into view; leader d p, a move, leader d u puts it back',
      cols.cur === 3 && cols.layout === 'columns' && cols.z === 1 && cols.r.every(r => r[1] === cols.r[0][1] && r[3] === cols.r[0][3]) && !cols.r.some((p, i) => cols.r.some((q, j) => i < j && over(p, q)))
      && vis.l >= vis.vl && vis.r <= vis.vr && saved.pinned && saved.saved && JSON.stringify(back) === JSON.stringify(pinned), JSON.stringify({ cols, vis, pinned, back, saved }));
    const ls = await D.evaluate(() => window.__canvas.AGENT_TOOLS.find((t: AgentTool) => t.name === 'list_desks').run({}));
    const sent = await D.evaluate((id: string) => window.__canvas.AGENT_TOOLS.find((t: AgentTool) => t.name === 'send_to_desk').run({ desk: 4, items: [id] }), m.ids[3]);
    const on4 = await D.evaluate((id: string) => id in (window.__canvas.deskAt(4)?.members || {}), m.ids[3]);
    await D.evaluate(() => dispatchEvent(new Event('focus'))); await sleep(600);
    const wb = await new Promise<{ code: number | null; out?: string; err: string }>(res => { const c = spawn('wb', ['desk', 'ls', '--socket', H.webSocket]); let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; }); c.on('error', e => res({ code: -1, err: String(e) })); c.on('close', code => res({ code, out, err })); });
    check('N60: list_desks lists desk 3 (pinned, columns, shown) with its cards; send_to_desk puts a card on desk 4; wb desk ls prints that listing from the tab over web.sock',
      /^3: 3 item\(s\), pinned in the board, with a saved state, columns \[shown\]$/m.test(ls) && three.every((id, i) => ls.includes(m.names[i])) && on4 && /desk 4/.test(sent)
      && wb.code === 0 && /^3: 3 item\(s\)/m.test(wb.out!) && /^4: 1 item\(s\)/m.test(wb.out!), JSON.stringify({ ls, sent, on4, wb }));
    // D shows desk 3, and the device's view says so: a second window comes up there, gives way, then takes it by a swap
    E = await dpage(); await until(() => E!.evaluate(() => window.__canvas.WIN.seen.size > 0), 5000); await sleep(400);
    const e0 = await E.evaluate(() => window.__canvas.DESK.cur);
    await E.evaluate(() => window.__canvas.deskGo(3, true)); await sleep(800);
    const sw = { D: await D.evaluate(() => window.__canvas.DESK.cur), E: await E.evaluate(() => window.__canvas.DESK.cur), mark: await D.evaluate(() => !!document.querySelector('#st-desk .dk.away[data-slot="3"]')) };
    check('N60: a second window that comes up on desk 3 shows the Board instead; going to desk 3 there swaps: the first window shows the Board, its pager marking desk 3 as shown elsewhere',
      e0 === 0 && sw.E === 3 && sw.D === 0 && sw.mark, JSON.stringify({ e0, sw }));
    // desk to desk: D on desk 4 goes to desk 3, which E shows; E takes desk 4
    await D.evaluate(() => window.__canvas.deskGo(4, true)); await sleep(500);
    await D.evaluate(() => window.__canvas.deskGo(3, true)); await sleep(800);
    const sw2 = { D: await D.evaluate(() => window.__canvas.DESK.cur), E: await E.evaluate(() => window.__canvas.DESK.cur) };
    check('N60: from desk 4, going to desk 3 that the other window shows swaps the two: that window takes desk 4', sw2.D === 3 && sw2.E === 4, JSON.stringify(sw2));
    await E.close(); E = null; await sleep(300);
    await D.evaluate(() => { const C = window.__canvas; for (const k of [3, 4]) if (C.deskAt(k)) { C.deskGo(k, true); C.deskDelete(); } C.deskGo(0, true); C.pickClear(); });
    await settled(D);
  } finally { await E?.close().catch(() => {}); await D?.close(); }
});
