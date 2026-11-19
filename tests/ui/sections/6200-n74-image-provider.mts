import { check, section } from '../shared.mts';
import { MEDIA, dpage, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// N74 (F-A41): media cards against the stub provider (harness --media). imagine with two variations lands both in the
// blob store; text piped in leads the prompt; edit gets the picked variation as multipart; a moved input or setting makes
// a card stale (amber) and "run stale" runs the chain in order; → takes the pick out; describe without a model says so.
await section('N74', async () => {
  let D: TailPage | undefined;
  try {
    D = await dpage(); await settled(D);
    MEDIA.length = 0;
    const st = await D.evaluate(async () => {
      const C = window.__canvas, S = C.S, out: Record<string, any> = {}; // any: each step's findings, read by the checks below
      if (C.WS.cur) C.wsLeave(); if (C.DESK.cur) C.deskGo(0, true); C.pickClear();
      out.info = C.INFO.media;
      const a = C.opNew('imagine'); a.prompt = 'a red square'; a.n = 2; C.live[a.id].op.prompt.value = a.prompt;
      out.a = { ok: await C.opRun(a, true), images: a.out?.images?.map((i: OpImage) => i.blob), pick: a.out?.pick, stale: C.opStale(a), cls: C.live[a.id].el.classList.contains('op-stale'), thumbs: C.live[a.id].op.out.querySelectorAll('.op-var img').length };
      // a page piped in leads the prompt
      const pg = C.addNode({ kind: 'buffer', name: 'n69 context', text: 'in the style of a woodcut', x: a.x - 500, y: a.y, w: 300, h: 200 });
      const b = C.opNew('imagine'); b.prompt = 'a lighthouse';
      S.edges.push({ id: 'n69e1', from: pg.id, to: b.id, type: 'pipe' }); C.dirty();
      out.b = { ins: C.opInputs(b).map((i: { from: BoardNode; text?: string }) => i.from.name + ':' + (i.text || '')), ok: await C.opRun(b, true) };
      // edit fed by a: the picked variation
      const e = C.opNew('edit', a); e.prompt = 'make it blue'; C.live[e.id].op.prompt.value = e.prompt;
      out.e = { input: C.opInputs(e)[0]?.image?.blob === a.out.images[0].blob, ok: await C.opRun(e, true), images: e.out?.images?.length };
      // a new pick upstream makes the edit stale; run stale runs it again
      a.out.pick = 1; C.dirty();
      out.stale = { e: C.opStale(e), a: C.opStale(a), input: C.opInputs(e)[0]?.image?.blob === a.out.images[1].blob };
      await C.opRunStale();
      out.after = { e: C.opStale(e), err: e.out?.err };
      // a changed prompt is stale; the old prompt is not
      a.prompt = 'a red circle'; out.prompt = C.opStale(a); a.prompt = 'a red square'; out.back = C.opStale(a);
      // → takes the pick out as an image card on the same bytes
      const had = new Set(Object.keys(S.nodes)); await C.opExtract(a);
      const x = Object.values<BoardNode>(S.nodes).find(m => !had.has(m.id) && m.kind === 'image') as ImageNode | undefined;
      out.extract = x && { blob: x.blob === a.out.images[1].blob, edge: S.edges.some((ed: Edge) => ed.from === a.id && ed.to === x.id && ed.type === 'spawn') };
      // describe has no model in the harness: it says so on the card
      const d = C.opNew('describe', x); out.d = { ok: await C.opRun(d, true), err: d.out?.err };
      // a card with no provider chosen yet, no image for edit: told, not sent
      const e2 = C.opNew('edit'); out.e2 = { ok: await C.opRun(e2, true), err: e2.out?.err };
      out.made = [a.id, pg.id, b.id, e.id, x?.id, d.id, e2.id].filter(Boolean);
      return out;
    });
    const sent = MEDIA.map(m => m.path), gen = MEDIA.filter(m => m.path === '/v1/images/generations').map(m => JSON.parse(m.body)), edits = MEDIA.filter(m => m.path === '/v1/images/edits');
    check('N74: /api/info lists the stub provider; imagine with two variations calls the provider once and keeps two blob hashes, shown as thumbnails, not stale',
      st.info?.[0]?.name === 'stub' && st.info[0].models[0] === 'stub-image' && st.a.ok && st.a.images?.length === 2 && st.a.images.every((h: string) => /^[0-9a-f]{64}$/.test(h)) && st.a.images[0] !== st.a.images[1] && st.a.pick === 0 && !st.a.stale && !st.a.cls && st.a.thumbs === 2
      && gen[0]?.model === 'stub-image' && gen[0].prompt === 'a red square' && gen[0].n === 2, JSON.stringify({ st: st.a, info: st.info, sent, gen }));
    check('N74: text piped in from a page leads the prompt; edit sends the picked variation as multipart; a new pick upstream makes the edit stale and "run stale" runs it again; a changed prompt is stale, the old one is not; → takes the pick out as an image card on the same bytes',
      st.b.ok && gen[1]?.prompt === 'in the style of a woodcut\n\na lighthouse' && st.e.input && st.e.ok && st.e.images === 1 && edits.length === 2 && /name="model"\r\n\r\nstub-image/.test(edits[0].body) && /filename="image\.png"/.test(edits[0].body)
      && st.stale.e && !st.stale.a && st.stale.input && !st.after.e && !st.after.err && st.prompt && !st.back && st.extract?.blob && st.extract.edge, JSON.stringify({ b: st.b, e: st.e, stale: st.stale, after: st.after, prompt: st.prompt, back: st.back, extract: st.extract, sent }));
    check('N74: describe without a model on the server fails on the card and says why; edit with no image piped in says so and sends nothing',
      !st.d.ok && /language model/.test(st.d.err || '') && !st.e2.ok && /needs an image/.test(st.e2.err || '') && edits.length === 2, JSON.stringify({ d: st.d, e2: st.e2 }));
    await D.evaluate((ids: string[]) => { for (const id of ids) if (window.__canvas.S.nodes[id]) window.__canvas.removeNode(id); window.__canvas.pickClear(); }, st.made);
    await settled(D);
  } finally { await D?.close(); }
});
