import { spawn } from 'node:child_process';
import { check, section, sleep } from '../shared.mts';
import { H, dpage, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N70 (F-A38): query desks. A desk whose members are the cards a query matches: words all match, -word negates, commas
// are alternatives; a card that starts to match joins the shown desk; nothing is sent to it or taken off it; the
// agent tool query_desk and `wb desk query` make one; list_desks and the pinned record carry the query.
await section('N70', async () => {
  let D: TailPage | undefined;
  try {
    D = await dpage(); await settled(D);
    const q = await D.evaluate(() => {
      const C = window.__canvas, S = C.S; C.perspSet('manual', true); C.focusHide(); if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true);
      for (const k of [5, 6]) if (C.deskAt(k)) { C.deskGo(k, true); C.deskDelete(); }
      const mk = (name: string, x: number, tags: string[]) => { const n = C.addNode({ kind: 'buffer', name, x, y: 40000, w: 300, h: 200, text: '# ' + name }); n.tags = tags; return n.id; };
      const a = mk('n70-alpha', 40000, ['n70']), b = mk('n70-beta', 40400, []), c = mk('n70-gamma', 40800, ['n70', 'old']); C.dirty();
      const ids = (q: string) => C.deskQuery(q).sort().join();
      return { a, b, c, tag: ids('tag:n70'), neg: ids('tag:n70 -tag:old'), bare: ids('n70-beta'), alt: ids('kind:page,shell name:n70'), board: ids('board:/n70-alpha'),
        none: ids('kind:agent name:n70'), bad: C.deskQueryParse('kind:bogus'), empty: C.deskQueryParse('  ') };
    });
    const sorted = (...x: string[]) => x.sort().join();
    check('N70: a query matches by tag, negated tag, bare name, kind alternatives with name:, board path; kind:agent matches none of the pages; a bad kind and an empty query are refused',
      q.tag === sorted(q.a, q.c) && q.neg === q.a && q.bare === q.b && q.alt === sorted(q.a, q.b, q.c) && q.board === q.a && q.none === '' && /not a kind/.test(q.bad) && /at least one word/.test(q.empty), JSON.stringify(q));
    const made = await D.evaluate(() => window.__canvas.AGENT_TOOLS.find((t: AgentTool) => t.name === 'query_desk').run({ query: 'tag:n70 -tag:old', desk: 5 }));
    const on5 = await D.evaluate((ids: string[]) => { const C = window.__canvas, d = C.deskAt(5); return { cur: C.DESK.cur, layout: d?.layout, members: Object.keys(d?.members || {}).sort().join(), shown: ids.map(id => !C.deskOff(C.S.nodes[id])) }; }, [q.a, q.b, q.c]);
    const tick = await D.evaluate((b: string) => { const C = window.__canvas; C.S.nodes[b].tags = ['n70']; C.deskQueryTick(); return { has: b in C.deskAt(5).members, shown: !C.deskOff(C.S.nodes[b]) }; }, q.b);
    const refuse = await D.evaluate((a: string) => { const C = window.__canvas; C.pickClear(); C.activate(a); const off = C.deskSend(0); C.deskGo(0, true); C.activate(a); const to = C.deskSend(5); return { off, to, still: a in C.deskAt(5).members }; }, q.a);
    check('N70: query_desk makes desk 5 (tiled) and shows the matching card only; a card that starts to match joins it while shown; a card is neither taken off it nor sent to it',
      /1 item\(s\) match tag:n70 -tag:old/.test(made) && on5.cur === 5 && on5.layout === 'tile' && on5.members === q.a && on5.shown.join() === 'true,false,false' && tick.has && tick.shown
      && /query desk holds what its query matches/.test(refuse.off) && /query desk holds what its query matches/.test(refuse.to) && refuse.still, JSON.stringify({ made, on5, tick, refuse }));
    await D.evaluate(() => { window.__canvas.deskGo(5, true); window.__canvas.deskPin(); });
    const rec = await D.evaluate(() => { const C = window.__canvas, s = JSON.parse(C.serialize()); return { pinned: (s.desks || []).find((d: Desk) => d.slot === 5), ls: C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'list_desks').run({}) }; });
    await D.evaluate(() => { window.__canvas.deskGo(0, true); dispatchEvent(new Event('focus')); }); await sleep(600);
    const wb = await new Promise<{ code: number | null; out?: string; err: string }>(res => { const c = spawn('wb', ['desk', 'query', '6', 'n70-beta', '--socket', H.webSocket]); let out = '', err = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; }); c.on('error', e => res({ code: -1, err: String(e) })); c.on('close', code => res({ code, out, err })); });
    const on6 = await D.evaluate(() => { const C = window.__canvas, d = C.deskAt(6); return { cur: C.DESK.cur, query: d?.query, n: Object.keys(d?.members || {}).length }; });
    check('N70: the pinned desk record keeps the query and list_desks shows it; wb desk query 6 n70-beta makes desk 6 with that card and shows it',
      rec.pinned?.query === 'tag:n70 -tag:old' && /^5 tag:n70 -tag:old: 2 item\(s\) matching the query tag:n70 -tag:old, pinned/m.test(rec.ls) && wb.code === 0 && /Desk 6/.test(wb.out!) && on6.cur === 6 && on6.query === 'n70-beta' && on6.n === 1,
      JSON.stringify({ rec: rec.pinned, ls: rec.ls.split('\n').filter((l: string) => /^5 /.test(l)), wb, on6 }));
    await D.evaluate((ids: string[]) => { const C = window.__canvas; for (const k of [5, 6]) if (C.deskAt(k)) { C.deskGo(k, true); C.deskDelete(); } C.deskGo(0, true); for (const id of ids) C.removeNode(id); }, [q.a, q.b, q.c]);
    await settled(D);
  } finally { await D?.close(); }
});
