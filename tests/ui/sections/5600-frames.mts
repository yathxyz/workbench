import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TMP, check, section, sleep, until, watchErrors } from '../shared.mts';
import { H, ORIGIN, api, barOf, ctx, dpage, harnessCtl, pageText, palLabels, puts, record, settled } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

// R16.9-R16.11 on Edwin frames: two tabs on one page, presence, edwind stopped and restarted while a tab holds unacked
// edits, the R9.18 notice, board migration (R8.16-R8.19), the frame cap and the zoomed-out snapshot (R9.4, R9.5, Q8),
// the console page, agent tools through the replica (R13.7), click-to-point under zoom (R9.9). Each check names a
// behaviour; the DOM read is the frame's lines (.ln), the mode line's sync field (.ml-sync), the notice (.fr-off) and
// the presence layer (.ed-presence). edwind is stopped and started through the harness's stdin controls.
await section('frames', async () => {
  let st: any;   // Each snapshot has its own shape.
  const card = (id: string) => `.node[data-id="${id}"]`;
  const frDom = (p: TailPage, id: string) => p.evaluate((id: string) => [...document.querySelectorAll(`.node[data-id="${id}"] .edwin-frame .ln`)].map(l => l.textContent).join('\n'), id);
  const frLive = (p: TailPage, id: string) => p.evaluate((id: string) => !!window.__canvas.live[id]?.frame, id);
  const frSync = (p: TailPage, id: string) => p.evaluate((id: string) => document.querySelector(`.node[data-id="${id}"] .edwin-frame .ml-sync`)?.textContent ?? null, id);
  const frOff = (p: TailPage, id: string) => p.evaluate((id: string) => { const e = document.querySelector<HTMLElement>(`.node[data-id="${id}"] .fr-off`); return e ? { hidden: e.hidden, shown: getComputedStyle(e).display !== 'none', text: e.textContent } : null; }, id);
  const frPresence = (p: TailPage, id: string) => p.evaluate((id: string) => [...document.querySelectorAll(`.node[data-id="${id}"] .edwin-frame .ed-presence .pc span`)].map(s => s.textContent), id);
  const online = (p: TailPage) => until(() => p.evaluate(() => window.__perf?.frame?.online), 30000);
  const show = async (p: TailPage, id: string) => { await p.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id], 1); }, id); await sleep(700); };
  const vim = true;   // an Edwin frame starts in evil's normal state
  // Enter on the card puts the keyboard in its frame; then to the end of the text, inserting
  const enterPage = async (p: TailPage, id: string) => { await p.bringToFront(); await show(p, id); await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await p.keyboard.press('Enter'); await until(() => frLive(p, id), 5000); await sleep(200); };
  const appendAt = async (p: TailPage) => { if (vim) { await p.keyboard.press('Shift+G'); await p.keyboard.press('Shift+A'); } else await p.keyboard.press('Control+End'); };
  const leave = async (p: TailPage) => { await p.keyboard.press('Escape'); await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await sleep(100); };
  const noteFile = (buf: string) => path.join(H.notesDir, buf);
  const readNote = (buf: string) => { try { return fs.readFileSync(noteFile(buf), 'utf8'); } catch (e) { return null; } };
  const mk = (p: TailPage, name: string, text: string, x: number, y: number) => p.evaluate((a: { name: string; text: string; x: number; y: number }) => window.__canvas.addNode({ kind: 'buffer', name: a.name, x: a.x, y: a.y, w: 480, h: 340, text: a.text }).id, { name, text, x, y });
  const bufOf = (p: TailPage, id: string) => until(() => p.evaluate((id: string) => window.__canvas.S.nodes[id]?.buf || null, id), 15000);

  // (g) the console page over /edit: boots, goes online, one frame with the menubar
  const K = await ctx.newPage(); watchErrors(K); record(K);
  try {
    await K.goto(ORIGIN + '/edwin/');
    const state = await until(() => K.evaluate(() => window.__edwin?.state === 'online' ? 'online' : null), 30000);
    st = await K.evaluate(() => ({ st: document.querySelector<HTMLElement>('#status .st')?.dataset.state, text: document.querySelector('#status .st')?.textContent, menubar: document.querySelectorAll('.edwin-frame[data-kind="console"] nav.ed-menubar').length, items: document.querySelector('.edwin-frame nav.ed-menubar')?.children.length || 0, lines: document.querySelectorAll('.edwin-frame .ln').length, kind: document.querySelector<HTMLElement>('.edwin-frame')?.dataset.kind, buffer: window.__edwin?.frame?.buffer?.name }));
    check('frames: the console page at /edwin/ boots the runtime, connects to edwind (state online) and shows one frame with the menubar', state === 'online' && st.st === 'online' && st.text === 'online' && st.menubar === 1 && st.items > 0 && st.lines > 0 && st.kind === 'console' && st.buffer === '*scratch*', JSON.stringify(st));
  } finally { await K.close(); }

  // (a) two tabs on one page: A makes the page, B opens the board once the page is saved with its buffer id
  const A2 = await dpage(); await A2.bringToFront(); await online(A2);
  const two = await mk(A2, 'fr-two', '# fr-two\n\nline one\nline two', 12000, 12000);
  const twoBuf = await bufOf(A2, two); await settled(A2);
  const B2 = await dpage(); await online(B2);
  await show(B2, two); await until(() => frLive(B2, two), 10000);
  // the time from A's keydown to the character in B's frame DOM, per character, on a shared clock
  await A2.evaluate(() => { window.__kt = {}; document.addEventListener('keydown', e => { if (e.key.length === 1) window.__kt[e.key] = Date.now(); }, true); });
  await B2.evaluate((id: string) => { window.__mt = {}; const host = document.querySelector(`.node[data-id="${id}"] .fr-host`); new MutationObserver(() => { const t = host!.textContent; for (const ch of 'QWERTYUIOP') if (!window.__mt[ch] && t.includes('from-A' + ch)) window.__mt[ch] = Date.now(); }).observe(host!, { subtree: true, childList: true, characterData: true }); }, two);
  await enterPage(A2, two); await appendAt(A2);
  await A2.keyboard.press('Enter'); await A2.keyboard.type('from-A');
  const lat = [];
  for (const ch of 'QWERTYUIOP') {   // each marker is from-A plus one letter, removed again before the next
    await A2.keyboard.type(ch);
    const seen = await until(() => B2.evaluate((ch: string) => window.__mt[ch] || null, ch), 2000, 5);
    const kt = await A2.evaluate((ch: string) => window.__kt[ch], ch);
    lat.push(seen && kt ? seen - kt : null);
    await A2.keyboard.press('Backspace'); await sleep(60);
  }
  await A2.keyboard.type('Z');
  const bSeen = await until(async () => (await frDom(B2, two)).includes('from-AZ'), 2000, 20);
  const bText = await pageText(B2, two), aText = await pageText(A2, two);
  const latOk = lat.filter(x => x != null).sort((a, b) => a - b), p95 = latOk.length ? latOk[Math.min(latOk.length - 1, Math.floor(0.95 * latOk.length))] : null;
  check('frames: typing in tab A\'s page frame appears in tab B\'s frame of the same page within 2 s, and B\'s text equals A\'s', !!bSeen && /\nfrom-AZ$/.test(aText) && bText === aText, JSON.stringify({ bSeen: !!bSeen, aTail: aText.slice(-20), bTail: bText.slice(-20) }));
  console.log(`note frames: remote edit to another tab's frame DOM, ${latOk.length} samples: median ${latOk[Math.floor(latOk.length / 2)] ?? '-'} ms, p95 ${p95 ?? '-'} ms (budget p95 <= 60 ms, §16.5; measured, not asserted: one browser process paints both tabs)`);
  // B types at the top of the same page while A's insertion stays at the end: both merge to one text
  await leave(A2);
  await enterPage(B2, two);
  if (vim) { await B2.keyboard.type('gg'); await B2.keyboard.press('Shift+I'); } else await B2.keyboard.press('Control+Home');
  await B2.keyboard.type('B-top ');
  await enterPage(A2, two); await appendAt(A2); await A2.keyboard.type(' A-end');
  const merged = await until(async () => { const a = await pageText(A2, two), b = await pageText(B2, two); return a === b && a.includes('B-top ') && a.includes('A-end') ? a : null; }, 5000);
  check('frames: tab B\'s typing at the top and tab A\'s at the end of the same page merge: both tabs show one text with both', !!merged && /^B-top # fr-two\n/.test(merged) && /from-AZ A-end$/.test(merged), JSON.stringify({ merged: merged && merged.slice(0, 40) + ' … ' + merged.slice(-30), a: (await pageText(A2, two)).slice(-30), b: (await pageText(B2, two)).slice(-30) }));

  // (b) presence: B's frame shows A's cursor with a label, and it follows A's point (both tabs share this browser
  // profile's device id, so the label is the same in both directions: the movement tells A's cursor apart)
  await leave(B2); await enterPage(A2, two); await A2.keyboard.press('ArrowLeft'); await sleep(300);
  const presPos = (p: TailPage, id: string) => p.evaluate((id: string) => [...document.querySelectorAll<HTMLElement>(`.node[data-id="${id}"] .edwin-frame .ed-presence .pc`)].map(c => ({ label: c.textContent, top: parseFloat(c.style.top), left: parseFloat(c.style.left) })), id);
  const pres0 = await until(async () => { const l = await presPos(B2, two); return l.length ? l : null; }, 5000);
  await A2.keyboard.press('ArrowUp'); await sleep(300);
  const pres1 = await until(async () => { const l = await presPos(B2, two); return l.length && pres0 && l[0].top < pres0[0].top ? l : null; }, 5000);
  check('frames: tab B shows tab A\'s cursor in the page with a label, and the cursor moves up a line when A\'s point does', Array.isArray(pres0) && pres0.length === 1 && pres0[0].label.length > 0 && Array.isArray(pres1) && pres1.length === 1 && pres1[0].label === pres0[0].label && pres1[0].top < pres0[0].top, JSON.stringify({ pres0, pres1: pres1 || await presPos(B2, two) }));

  // (h) agent tools go through the replica: read_node returns the frame's text, write_page changes it in the frame
  await leave(A2);
  const tools = await A2.evaluate(async (id: string) => {
    const C = window.__canvas, n = C.S.nodes[id], T = (name: string) => C.AGENT_TOOLS.find((t: AgentTool) => t.name === name);
    const read1 = await T('read_node').run({ path: n.name });
    const wrote = await T('write_page').run({ path: n.name, text: '- written by a tool' });
    const read2 = await T('read_node').run({ path: n.name });
    return { read1, wrote, read2, text: C.pageText(id) };
  }, two);
  const toolDom = await until(async () => (await frDom(A2, two)).includes('- written by a tool'), 5000, 50);
  const toolB = await until(async () => (await pageText(B2, two)).endsWith('- written by a tool'), 5000);
  check('frames: read_node returns the page frame\'s text and write_page appends to it; the frame shows the new line in both tabs', tools.read1 === merged && /^ok, .* lines$/.test(tools.wrote) && tools.read2 === merged + '\n- written by a tool' && tools.read2 === tools.text && !!toolDom && !!toolB, JSON.stringify({ read1: tools.read1.slice(-30), wrote: tools.wrote, read2: tools.read2.slice(-40), toolDom: !!toolDom, toolB: !!toolB }));

  // (i) block cards on frames (F-A25): the fence line of a page frame carries the tear-out chip, tear_out_block reads
  // the page through the replica, and an edit to the block in the other tab reloads the card here
  const blk = await mk(A2, 'fr-blocks', '# fr-blocks\n\n```html {#frv card=300x200}\n<p id=frv>one</p>\n```\n\n~~~html\n<b>two</b>\n~~~\n', 12000, 13000);
  await bufOf(A2, blk); await settled(A2);
  await show(A2, blk); await until(() => frLive(A2, blk), 10000);
  const tearChips = (id: string) => A2.evaluate((id: string) => document.querySelectorAll(`.node[data-id="${id}"] .fr-anchors .fr-tear`).length, id);
  const chips = await until(async () => (await tearChips(blk)) === 2 ? 2 : null, 5000);
  await A2.evaluate((id: string) => document.querySelectorAll(`.node[data-id="${id}"] .fr-anchors .fr-tear`)[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), blk);
  const torn = await until(() => A2.evaluate((id: string) => { const C = window.__canvas, n = Object.values<BoardNode & { block?: ArtifactNode['block'] }>(C.S.nodes).find(m => m.block?.page === id); return n ? { block: n.block!.id, info: C.pageText(id).includes('~~~html {#block1}'), edge: C.S.edges.some((e: Edge) => e.from === id && e.to === n.id && e.type === 'ref') } : null; }, blk), 5000);
  const tornOut = await A2.evaluate(() => window.__canvas.AGENT_TOOLS.find((t: AgentTool) => t.name === 'tear_out_block').run({ page: 'fr-blocks', block: 'frv' }).catch((e: Error) => 'error: ' + e.message));
  const blockFrameA = async () => { for (const f of A2.frames()) { try { if (await f.$('#frv')) return f; } catch {} } return null; };
  let bfA = await until(blockFrameA, 8000);
  const bfText = bfA ? await bfA.textContent('#frv') : null;
  check('frames: the fence lines of a page frame carry the tear-out chip; the chip and tear_out_block make block cards bound to the page (an id is written for the block without one) and the card renders the block', chips === 2 && torn?.block === 'block1' && torn.info && torn.edge && /^created/.test(tornOut) && bfText === 'one', JSON.stringify({ chips, torn, tornOut, bfText }));
  // Both tabs typed in fr-two above, and each tab's frame cached the page's first lines on its node: tab B must still
  // take tab A's board (a page snapshot is derived from the file, not a change of B's own).
  const tookB = await until(() => B2.evaluate((id: string) => !!window.__canvas.S.nodes[id] || null, blk), 15000);
  const barsAB = [await barOf(A2), await barOf(B2)];
  check('frames: after both tabs typed in one page neither shows the conflict bar, and tab B takes tab A\'s new page', !!tookB && barsAB.every(b => b.hidden || b.key !== 'conflict'), JSON.stringify({ tookB, barsAB }));
  if (tookB) {
    await show(B2, blk); await until(() => frLive(B2, blk), 10000);
    const edited = await B2.evaluate((id: string) => { const C = window.__canvas, n = C.S.nodes[id], t = C.pageText(id), i = t.indexOf('>one<'); return i >= 0 && C.pageEdit(n, i + 1, i + 4, 'uno'); }, blk);
    bfA = await until(async () => { const f = await blockFrameA(); return f && (await f.textContent('#frv')) === 'uno' ? f : null; }, 8000);
    check('frames: an edit to the block in tab B reaches tab A\'s replica and reloads the block card there', edited === true && !!bfA, JSON.stringify({ edited, reloaded: !!bfA }));
  }
  await A2.evaluate((id: string) => { const C = window.__canvas; for (const n of Object.values<BoardNode & { block?: ArtifactNode['block'] }>(C.S.nodes)) if (n.block?.page === id) C.removeNode(n.id); C.removeNode(id); }, blk);
  await settled(A2); await settled(B2);

  // N79: a host process opens a file the same way as a click, through the leader tab.
  const openFile = (input: AgentToolInput) => {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string; err: string }>();
    const c = spawn('wb', ['open_file', '--socket', H.webSocket, '--json', JSON.stringify(input)]);
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('error', e => resolve({ code: -1, out, err: String(e) })); c.on('close', code => resolve({ code, out, err }));
    return promise;
  };
  const name79 = 'n79-open-file.md', rel79 = '~/' + name79;
  const home79 = (await (await api('/api/info')).json()).home as string, abs79 = path.join(home79, name79);
  fs.writeFileSync(abs79, 'first\nsecond\nthird\nfourth');
  fs.writeFileSync(noteFile('bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  fs.mkdirSync(path.join(home79, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home79, '.ssh', name79), 'refused');
  await A2.bringToFront(); await A2.evaluate(() => dispatchEvent(new Event('focus'))); await sleep(300);
  const frame79 = () => A2.evaluate((buf: string) => Object.values<BoardNode>(window.__canvas.S.nodes).flatMap(n => {
    if (n.kind !== 'buffer' || n.buf !== buf) return [];
    const l = window.__canvas.live[n.id], frame = l?.frame;
    return [{ id: n.id, focused: frame?.focused, point: frame?.point(), frames: l?.el?.querySelectorAll('.edwin-frame').length }];
  }), rel79);
  const point79 = (pt: number) => until(async () => { const frames = await frame79(); return frames.some(f => f.focused && f.point === pt) ? frames : null; }, 10000);
  const result79 = (r: Awaited<ReturnType<typeof openFile>>, file: string, line: number) => r.code === 0 && r.out.trim() === JSON.stringify({ file, line });
  const open79 = await openFile({ file: abs79, line: 3 }), at3 = await point79('first\nsecond\n'.length);
  check('N79: wb open_file over web.sock opens the file in a focused Edwin frame at line 3', result79(open79, abs79, 3) && at3?.length === 1 && at3[0].frames === 1, JSON.stringify({ open79, at3 }));
  const reopen79 = await openFile({ file: rel79, line: 1 }), at1 = await point79(0);
  check('N79: opening the same file via ~/ moves point to line 1 without a second frame', result79(reopen79, rel79, 1) && at1?.length === 1 && at1[0].id === at3?.[0].id && at1[0].frames === 1, JSON.stringify({ reopen79, at1 }));
  const past79 = await openFile({ file: rel79, line: 99 }), atEnd = await point79('first\nsecond\nthird\n'.length);
  await leave(A2);
  const keep79 = await openFile({ file: rel79 }), kept = await point79('first\nsecond\nthird\n'.length);
  check('N79: open_file reports the clamped line and leaves point where a click would if line is omitted', result79(past79, rel79, 4) && atEnd?.length === 1 && result79(keep79, rel79, 4) && kept?.length === 1, JSON.stringify({ past79, atEnd, keep79, kept }));
  const refuse79 = async (input: AgentToolInput, why: RegExp) => {
    const r = await openFile(input);
    check(`N79: open_file refuses ${JSON.stringify(input)} with ${why.source}`, r.code === 1 && why.test(r.err), JSON.stringify(r));
  };
  await refuse79({ file: path.join(home79, 'n79-missing.md') }, /file not found/);
  await refuse79({ file: noteFile('bin.md') }, /not UTF-8 text/);
  await refuse79({ file: '~/.ssh/' + name79 }, /: refused/);
  await refuse79({ file: name79 }, /absolute path/);
  for (const line of [0, -1, 1.5, '2', null]) await refuse79({ file: abs79, line }, /line must be a positive integer/);
  await leave(A2);
  await A2.evaluate((ids: string[]) => { for (const id of ids) window.__canvas.removeNode(id); }, (await frame79()).map(f => f.id));
  await settled(A2); await settled(B2);

  // (j) notes and files open as Edwin pages (noteOpen, ghostOpen); the frame starts at the note's line. A file edwind
  // will not edit (here: not UTF-8 text) opens nothing: no card, and a toast says why.
  fs.writeFileSync(noteFile('open-me.md'), '# open me\n\nsecond body line\nthird');
  fs.writeFileSync(noteFile('ghost-me.md'), '# ghost me\n');
  await A2.bringToFront();
  const opened = await A2.evaluate(async () => { const n = await window.__canvas.noteOpen({ path: 'open-me.md', line: 3 }); return n && { id: n.id, kind: n.kind, buf: n.buf || null }; });
  const openPt = opened && await until(() => A2.evaluate((id: string) => { const L = window.__canvas.live[id]; return L?.frame?.focused ? L.frame.point() : null; }, opened.id), 10000);
  await leave(A2);
  const ghost = await A2.evaluate((abs: string) => window.__canvas.addNode({ kind: 'ghost', ghost: true, name: 'ghost-me.md', path: abs, in: undefined, x: 12000, y: 14500, w: 220, h: 54 }).id, noteFile('ghost-me.md'));
  const fromGhost = await A2.evaluate(async (id: string) => { const C = window.__canvas, n = await C.ghostOpen(C.S.nodes[id]); return n && { id: n.id, kind: n.kind, buf: n.buf || null, ghostGone: !C.S.nodes[id] }; }, ghost);
  await leave(A2);
  const bin = await A2.evaluate(async () => { const before = Object.keys(window.__canvas.S.nodes).length; const n = await window.__canvas.noteOpen({ path: 'bin.md' }); return { opened: !!n, added: Object.keys(window.__canvas.S.nodes).length - before, toast: document.querySelector('#toast')?.textContent || '' }; });
  check('frames: a note and a file ghost open as Edwin page cards on their files, the frame at the note\'s line; a file edwind will not edit (not UTF-8) opens no card and says why',
    opened?.kind === 'buffer' && opened.buf === 'open-me.md' && openPt === '# open me\n\n'.length && fromGhost?.kind === 'buffer' && fromGhost.buf === 'ghost-me.md' && fromGhost.ghostGone && !bin.opened && bin.added === 0 && /bin\.md does not open as a page/.test(bin.toast),
    JSON.stringify({ opened, openPt, fromGhost, bin }));

  // (k) a page whose file moves through POST /api/mv (edwind's rename-file) keeps editing the same text: the node and the
  // served board take the new id, tab B's open replica follows, typing lands in the moved file, and neither tab shows
  // the conflict bar
  if (opened?.id) {
    const mvPage = opened.id;
    await enterPage(A2, mvPage); await appendAt(A2); await A2.keyboard.type(' before-move'); await leave(A2);
    await until(async () => (await frSync(A2, mvPage)) === '', 10000);
    await until(() => B2.evaluate((id: string) => !!window.__canvas.S.nodes[id] || null, mvPage), 15000);
    await show(B2, mvPage); await until(() => frLive(B2, mvPage), 10000);
    fs.mkdirSync(noteFile('moved'), { recursive: true });
    const mv = await A2.evaluate(async ([src, dst]: string[]) => { try { return await window.__canvas.fsMv(null, src, dst); } catch (e) { return { error: e.message }; } }, [noteFile('open-me.md'), noteFile('moved')]);
    const bufA = await until(() => A2.evaluate((id: string) => window.__canvas.S.nodes[id]?.buf === 'moved/open-me.md' || null, mvPage), 5000);
    const served = await until(async () => (await (await api('/api/board')).json()).nodes[mvPage]?.buf === 'moved/open-me.md' || null, 10000);
    const bufB = await until(() => B2.evaluate((id: string) => window.__canvas.live[id]?.buf?.id === 'moved/open-me.md' || null, mvPage), 10000);
    await enterPage(A2, mvPage); await appendAt(A2); await A2.keyboard.type(' after-move'); await leave(A2);
    const disk = await until(() => { const t = readNote('moved/open-me.md'); return t && t.includes('after-move') ? t : null; }, 15000);
    const textB = await until(async () => { const t = await pageText(B2, mvPage); return t.endsWith('after-move') ? t : null; }, 5000);
    await settled(A2); await settled(B2);
    const barsMv = [await barOf(A2), await barOf(B2)];
    check('frames: a page whose file moves through /api/mv keeps editing the same text: the node and the served board take the new id, the other tab\'s replica follows, typing lands in the moved file, no conflict bar',
      mv?.from === 'open-me.md' && mv.to === 'moved/open-me.md' && !!bufA && !!served && !!bufB && disk === '# open me\n\nsecond body line\nthird before-move after-move' && readNote('open-me.md') === null && !!textB && barsMv.every(b => b.hidden || b.key !== 'conflict'),
      JSON.stringify({ mv, bufA, served, bufB, disk, textB: textB && textB.slice(-40), barsMv }));
    // A board saved by a tab that did not follow the move (it had no replica of the page open) names the old id: the
    // tabs that heard of the move take that board, put the new id back on the page and save it.
    const cur = await api('/api/board'), etag = cur.headers.get('ETag')!, stale = await cur.json();
    stale.nodes[mvPage].buf = 'open-me.md';
    const put = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(stale) });
    const healed = await until(async () => (await (await api('/api/board')).json()).nodes[mvPage]?.buf === 'moved/open-me.md' || null, 10000);
    await settled(A2); await settled(B2);
    const healedA = await A2.evaluate((id: string) => window.__canvas.S.nodes[id]?.buf, mvPage);
    const barsHeal = [await barOf(A2), await barOf(B2)];
    check('frames: a board from a tab that did not follow a move (the page on the old id) is taken and made to follow it again, without the conflict bar',
      put.status === 204 && !!healed && healedA === 'moved/open-me.md' && barsHeal.every(b => b.hidden || b.key !== 'conflict'), JSON.stringify({ put: put.status, healed, healedA, barsHeal }));
  }
  await A2.evaluate((ids: (string | undefined)[]) => { for (const id of ids) if (id && window.__canvas.S.nodes[id]) window.__canvas.removeNode(id); }, [opened?.id, fromGhost?.id]);
  await settled(A2); await settled(B2);

  // (d) edwind down: the card shows the R9.18 notice, the mode line says offline, typing still works locally
  await enterPage(A2, two); await appendAt(A2);
  const stopped = await harnessCtl('stop edit');
  const offA = await until(async () => /⚠ offline/.test(await frSync(A2, two) || ''), 10000);
  const offB = await until(async () => /⚠ offline/.test(await frSync(B2, two) || ''), 10000);
  await A2.keyboard.type(' while-down');
  st = { stopped, offA, offB, notice: await frOff(A2, two), noticeB: await frOff(B2, two), text: await pageText(A2, two), sync: await frSync(A2, two), body: await A2.evaluate(() => document.body.classList.contains('edit-off')), status: (await (await api('/api/status')).json()).edit, info: (await (await api('/api/info')).json()) };
  // A note opened while edwind is down says so at once (no wait for a connection that was up before) and opens nothing.
  const downOpen = await A2.evaluate(async () => { const t0 = performance.now(); const n = await window.__canvas.noteOpen({ path: 'ghost-me.md' }); return { opened: !!n, ms: performance.now() - t0, toast: document.querySelector('#toast')?.textContent || '' }; });
  check('frames: with edwind down a note opens nothing at once and the toast says edwind is not running', !downOpen.opened && downOpen.ms < 1000 && /edwind is not running/.test(downOpen.toast), JSON.stringify(downOpen));
  await A2.evaluate(() => dispatchEvent(new Event('focus'))); await sleep(300);
  await refuse79({ file: abs79 }, /edwind is not running/);
  check('frames: with edwind down the page card shows the notice that editing is off, the mode line says offline and typing still goes into the page (unacked)', st.stopped?.event === 'stopped' && st.offA && st.offB && st.notice?.shown && !st.notice.hidden && st.notice.text === 'Editing is off: edwind is not running' && st.noticeB?.shown && /while-down$/.test(st.text) && /•/.test(st.sync) && /⚠ offline/.test(st.sync) && st.body && !st.status?.up && st.info.edit === true && st.info.editUp === false, JSON.stringify({ ...st, text: st.text.slice(-30), info: { edit: st.info.edit, editUp: st.info.editUp } }));

  // (c) edwind back: both tabs reconnect, the unacked edit is acked, reaches the other tab and the file on disk
  const started = await harnessCtl('start edit');
  const onA = await until(async () => !/⚠ offline/.test(await frSync(A2, two) || ''), 20000);
  const onB = await until(async () => !/⚠ offline/.test(await frSync(B2, two) || ''), 20000);
  const acked = await until(async () => !/•/.test(await frSync(A2, two) || ''), 20000);
  // the file's form of the text: edwind writes a trailing newline when the file has one (files.mts, the newline policy)
  const onDisk = (buf: string, text: string) => { const d = readNote(buf); return d != null && d.replace(/\n$/, '') === text.replace(/\n$/, ''); };
  const diskA = await until(() => (readNote(twoBuf) || '').includes(' while-down') ? readNote(twoBuf) : null, 15000);
  const textA = await pageText(A2, two), textB = await until(async () => { const t = await pageText(B2, two); return t === textA ? t : null; }, 5000);
  st = { started, onA, onB, acked, disk: !!diskA, same: textB === textA, notice: await frOff(A2, two), sync: await frSync(A2, two), status: (await (await api('/api/status')).json()).edit };
  check('frames: after edwind restarts both tabs reconnect (the mode line loses offline), the edit typed while it was down is acked, on disk and in the other tab, and the notice goes', st.started?.event === 'started' && st.onA && st.onB && st.acked && st.disk && st.same && /while-down$/.test(textA) && onDisk(twoBuf, textA) && st.notice && !st.notice.shown && st.sync === '' && st.status?.up === true, JSON.stringify({ ...st, disk: (diskA || '').slice(-30), textA: textA.slice(-30) }));

  // (c') a restart in the middle of typing: nothing typed is lost, in either tab or on disk
  await leave(A2); await enterPage(A2, two); await appendAt(A2);
  const burst = ' 0123456789abcdefghijklmnopqrstuvwxyz';
  const typing = A2.keyboard.type(burst, { delay: 30 });
  await sleep(250);
  const restarted = await harnessCtl('restart edit');
  await typing;
  const backA = await until(async () => { const s = await frSync(A2, two); return s === '' ? true : null; }, 30000);
  const burstText = await pageText(A2, two);
  const burstB = await until(async () => (await pageText(B2, two)) === burstText ? true : null, 10000);
  const burstDisk = await until(() => onDisk(twoBuf, burstText) ? true : null, 15000);
  check('frames: edwind restarted in the middle of typing loses nothing: the page ends with every character typed, the other tab and the file on disk have the same text', restarted?.event === 'restarted' && !!backA && burstText.endsWith(burst) && !!burstB && !!burstDisk, JSON.stringify({ restarted, backA: !!backA, tail: burstText.slice(-40), burstB: !!burstB, disk: (readNote(twoBuf) || '').slice(-40) }));
  await leave(A2);

  // (R16.11) click-to-point under the canvas zoom: a click on a character puts the point there at z = 0.5, 1 and 2;
  // a drag selects from the pressed character to the released one
  await show(A2, two); await A2.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const clickAt = async (z: number, k: number) => {
    await A2.evaluate((z: number) => { const C = window.__canvas; C.S.cam.z = z; C.applyCam(); C.jumpNode(C.S.nodes[window.__two], 1); }, z); await sleep(500);
    await A2.evaluate((z: number) => { const C = window.__canvas; if (Math.abs(C.S.cam.z - z) > 1e-6) { C.S.cam.z = z; C.applyCam(); } }, z); await sleep(300);
    const spot = await A2.evaluate(([id, k]: (string | number)[]) => { const ln = [...document.querySelectorAll<HTMLElement>(`.node[data-id="${id}"] .edwin-frame .ln`)].find(l => l.textContent.startsWith('line two')); if (!ln) return null; const tn = [...ln.childNodes].flatMap(n => n.nodeType === 3 ? [n] : [...n.childNodes].filter(c => c.nodeType === 3)) as Text[]; let left = k as number; for (const t of tn) { if (left <= t.length - 1) { const r = document.createRange(); r.setStart(t, left); r.setEnd(t, left + 1); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, o: +ln.dataset.o!, z: window.__canvas.S.cam.z }; } left -= t.length; } return null; }, [two, k]);
    if (!spot) return { z, k, spot: null };
    await A2.mouse.click(spot.x, spot.y); await sleep(250);
    const pt = await A2.evaluate((id: string) => { const L = window.__canvas.live[id]; return { pt: L.frame?.point(), focused: !!L.frame?.focused }; }, two);
    return { z: spot.z, k, want: spot.o + k, got: pt.pt, focused: pt.focused, ok: pt.pt === spot.o + k };
  };
  await A2.evaluate((id: string) => { window.__two = id; }, two);
  const clicks = [await clickAt(0.5, 5), await clickAt(1, 3), await clickAt(2, 7)];
  // a drag from character 2 to character 6 of the same line at z = 1 selects that range (mark at the press, point at the release)
  await A2.evaluate(() => { const C = window.__canvas; C.S.cam.z = 1; C.applyCam(); C.jumpNode(C.S.nodes[window.__two], 1); }); await sleep(500);
  const drag = await A2.evaluate(([id]: string[]) => { const ln = [...document.querySelectorAll<HTMLElement>(`.node[data-id="${id}"] .edwin-frame .ln`)].find(l => l.textContent.startsWith('line two')); const tn = ln && [...ln.childNodes].flatMap(n => n.nodeType === 3 ? [n] : [...n.childNodes].filter(c => c.nodeType === 3)) as Text[]; if (!tn || !tn.length) return null; const at = (k: number) => { let left = k; for (const t of tn) { if (left <= t.length - 1) { const r = document.createRange(); r.setStart(t, left); r.setEnd(t, left + 1); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } left -= t.length; } return null; }; return { from: at(2), to: at(6), o: +ln.dataset.o! }; }, [two]);
  let dragSt = null;
  if (drag && drag.from && drag.to) {
    await A2.mouse.move(drag.from.x, drag.from.y); await A2.mouse.down(); await A2.mouse.move(drag.from.x + 3, drag.from.y); await A2.mouse.move(drag.to.x, drag.to.y, { steps: 4 }); await A2.mouse.up(); await sleep(250);
    dragSt = await A2.evaluate((id: string) => { const L = window.__canvas.live[id], b = L.frame?.buffer; return { pt: L.frame?.point(), mark: b ? b.mark : null }; }, two);
  }
  await leave(A2);
  await A2.evaluate(() => { const C = window.__canvas; C.S.cam.z = 1; C.applyCam(); });
  check('frames: a click on a character in a page frame puts the point on that character at zoom 0.5, 1 and 2, and a drag selects from the pressed character to the released one', clicks.every(c => c.ok && c.focused) && !!dragSt && dragSt.mark === drag!.o + 2 && dragSt.pt === drag!.o + 6, JSON.stringify({ clicks, drag: dragSt, o: drag?.o }));
  await settled(A2);

  // N69 (F-A37): the board's keymaps are Edwin keymaps. wb-keys is provided; the leader is a prefix in global-map; a
  // define-key in wb-canvas-map binds a board command on the canvas, and one in wb-leader-map runs a Scheme command
  // from the leader; which-key and the checker see both; giving the key back removes the row.
  const k4 = await A2.evaluate(async () => {
    const C = window.__canvas, L = C.FR.L, W = WBKeys, tick = () => new Promise(r => setTimeout(r, 50));
    const ev = (src: string) => { let v: unknown; for (const f of L.readAll(src)) { L.resetOps?.(); v = L.ev(f); } return v; };   // as evil-ex's : (form) does
    const out: { feat: boolean; lead: boolean; g?: WBKeyRow; y?: WBKeyRow; errs?: string[] } = { feat: ev("(featurep 'wb-keys)") === true, lead: L.get('global-map').map.get(C.KM4.leader) === C.KM4.obj.get('leader') };
    ev('(define n69-hits 0)');
    ev('(define-command (n69-mark) "Count a hit for N69." (interactive) (set! n69-hits (+ n69-hits 1)))');
    ev('(define-key wb-canvas-map "g" \'wb-hints)');
    ev('(define-key wb-leader-map "y" \'n69-mark)');
    await tick();
    out.g = W.MAPS.canvas.find(r => r[0] === 'g'); out.y = W.MAPS.leader.find(r => r[0] === 'y');
    out.errs = W.check({ commands: new Set(Object.keys(C.KC)) }).errors;
    return out;
  });
  await A2.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.__canvas.focusHide(); }); await sleep(100);
  await A2.keyboard.press('g'); await sleep(300);
  const k4h = await A2.evaluate(() => window.__canvas.HINTS.on); await A2.keyboard.press('Escape'); await sleep(150);
  await A2.keyboard.press('Control+Space'); await sleep(200);
  const k4w = await A2.evaluate(() => [...document.querySelectorAll('#which-key span')].some(e => e.querySelector('b')?.textContent === 'y' && /n69-mark/.test(e.textContent || '')));
  await A2.keyboard.press('y'); await sleep(400);
  const k4n = await A2.evaluate(() => (() => { const L = window.__canvas.FR.L; let v: unknown; for (const f of L.readAll('n69-hits')) v = L.ev(f); return v; })());
  const k4b = await A2.evaluate(async () => { const C = window.__canvas; C.KM4.obj.get('canvas').map.delete('g'); C.KM4.obj.get('leader').map.delete('y'); await new Promise(r => setTimeout(r, 50)); return { g: !!WBKeys.MAPS.canvas.find(r => r[0] === 'g'), y: !!WBKeys.MAPS.leader.find(r => r[0] === 'y') }; });
  check('N69: wb-keys is provided and the leader is a prefix in global-map; define-key in wb-canvas-map binds g to hints on the canvas, and in wb-leader-map binds y to a Scheme command that the leader runs and which-key lists; the checker stays clean; deleting the keys removes the rows',
    k4.feat && k4.lead && JSON.stringify(k4.g?.slice(0, 2)) === '["g","hints"]' && JSON.stringify(k4.y?.slice(0, 2)) === '["y","edwin:n69-mark"]' && Array.isArray(k4.errs) && !k4.errs.length && k4h && k4w && k4n === 1 && !k4b.g && !k4b.y,
    JSON.stringify({ k4, k4h, k4w, k4n, k4b }));
  await B2.close(); await A2.close();

  // (e) migration: a board written by an app.js before buf (pages with text and an anchor, no buf), installed as the
  // served board before any tab loads it; the first frame runtime that loads it moves the pages into edwind
  const base = await (await api('/api/board')).json();
  const m1Text = '# Mig One\n\nfirst body line\nsecond body line\n', m2Text = '# mig two\n\n- TODO a task\n', m3Text = '# Mig Three\n\nthird body\n';
  const pre = { v: 5, fs: base.fs, views: {}, nodes: {
    m1: { id: 'm1', kind: 'buffer', name: 'Mig One', x: 100, y: 100, w: 480, h: 340, text: m1Text, anchors: [{ id: 'a-m1', label: 'spot', pos: m1Text.indexOf('second'), quote: 'second body line', prefix: 'first body line\n' }] },
    m2: { id: 'm2', kind: 'buffer', name: 'mig two', x: 700, y: 100, w: 480, h: 340, text: m2Text },
    m3: { id: 'm3', kind: 'buffer', name: 'Mig Three!', x: 100, y: 600, w: 480, h: 340, text: m3Text },
  }, edges: [], strokes: [], shapes: [], cam: { x: 0, y: 0, z: 1 } };
  const preFile = path.join(TMP, 'pre-edwind-board.json'); fs.writeFileSync(preFile, JSON.stringify(pre));
  const installed = await harnessCtl('board ' + preFile);
  const M = await ctx.newPage(); watchErrors(M); record(M);
  const migLog = []; M.on('console', m => { if (/edwin: migrated/.test(m.text())) migLog.push(m.text()); });
  await M.goto(ORIGIN + '/'); await until(() => M.evaluate(() => window.__canvas?.BOOTED)); await until(() => M.evaluate(() => window.__perf?.frame?.ready), 30000); await M.bringToFront();
  const bufs = await until(() => M.evaluate(() => { const C = window.__canvas, b = ['m1', 'm2', 'm3'].map(id => C.S.nodes[id]?.buf || null); return b.every(Boolean) ? b : null; }), 20000);
  // The board save that carries the bufs goes out once the pages are migrated, after buf shows in the tab; settled()
  // can come back before that PUT is sent. A fixed wait raced it, so the served board is polled until all three bufs landed.
  const servedNow = async () => (await api('/api/board')).json();
  const served = await until(async () => { const b = await servedNow(); return ['m1', 'm2', 'm3'].every(id => b.nodes?.[id]?.buf) ? b : null; }, 15000) || await servedNow();
  await settled(M);
  const files = ['notes/mig-one.md', 'notes/mig-two.md', 'notes/mig-three.md'].map(readNote);
  const servedPages = ['m1', 'm2', 'm3'].map(id => served.nodes[id]).map(n => n && { buf: n.buf, text: 'text' in n, anchors: 'anchors' in n });
  const preCopy = (() => { try { return fs.readFileSync(path.join(H.boardsDir, H.host + '.pre-edwind.json')); } catch (e) { return null; } })();
  const anchors = await M.evaluate(() => { const C = window.__canvas; return C.pageAnchors(C.S.nodes.m1); });
  // leader / opens the palette: the dock's shell has the keyboard after a load, and C-k is its there (F-A23)
  await M.keyboard.press('Control+Space'); await M.keyboard.press('/'); await sleep(150); await M.fill('#pal-in', 'Mig One#spot'); await sleep(250); const pal = await palLabels(M); await M.keyboard.press('Escape');
  // R8.19 copies the board as stored when the first buf arrives. The tab may have saved it once before that (its own
  // defaults: theme, the dock terminal), so the copy holds the installed board, every field of it, plus those, and no buf.
  const within = (a: any, b: any): boolean => a && typeof a === 'object' && !Array.isArray(a) ? !!b && typeof b === 'object' && Object.keys(a).every(k => within(a[k], b[k])) : JSON.stringify(a) === JSON.stringify(b); // any: two JSON values of any shape, compared field by field
  const preKept = (() => { try { const c = JSON.parse(preCopy as unknown as string); return within(pre, c) && Object.values<BoardNode & { buf?: string }>(c.nodes).every(n => !n.buf); } catch (e) { return false; } })();
  st = { installed, bufs, files: files.map(f => f && f.slice(0, 20)), servedPages, preCopy: !!preCopy, preKept, anchors, pal: pal.includes('Mig One#spot'), migLog: migLog.length };
  check('frames: a board with page texts and no buf is migrated on first load: every page gets buf notes/<slug>.md, the files hold the texts, the anchor is back at its place and the palette finds it, the served board carries no text, the board from before the first buf is kept as <host>.pre-edwind.json with every page text and anchor', st.installed?.event === 'board' && bufs?.join() === 'notes/mig-one.md,notes/mig-two.md,notes/mig-three.md' && files[0] === m1Text && files[1] === m2Text && files[2] === m3Text && servedPages.every((n, i) => n && n.buf === bufs[i] && !n.text && !n.anchors) && st.preCopy && st.preKept && anchors.length === 1 && anchors[0].id === 'a-m1' && anchors[0].pos === m1Text.indexOf('second') && anchors[0].label === 'spot' && st.pal && migLog.length === 3, JSON.stringify(st));
  // a second load migrates nothing more
  const M2 = await ctx.newPage(); watchErrors(M2); record(M2);
  const migLog2 = []; M2.on('console', m => { if (/edwin: migrated/.test(m.text())) migLog2.push(m.text()); });
  await M2.goto(ORIGIN + '/'); await until(() => M2.evaluate(() => window.__canvas?.BOOTED)); await until(() => M2.evaluate(() => window.__perf?.frame?.online), 30000); await sleep(2500);
  const served2 = await (await api('/api/board')).json();
  st = { migLog2: migLog2.length, bufs2: ['m1', 'm2', 'm3'].map(id => served2.nodes[id]?.buf), puts: puts().length };
  check('frames: a second load of the migrated board migrates nothing more (no migrated line in the console) and the buffers stay', st.migLog2 === 0 && st.bufs2.join() === bufs!.join(), JSON.stringify(st));
  await M.close();

  // (f) the frame cap and the zoomed-out snapshot: 40 pages in view make at most 24 live frames; below reading zoom
  // every page card is a snapshot of its first lines and no frame is live
  await M2.bringToFront();
  await M2.evaluate(() => { const C = window.__canvas; for (let i = 0; i < 40; i++) C.addNode({ kind: 'buffer', name: 'cap' + i, x: 3000 + (i % 10) * 320, y: 3000 + Math.floor(i / 10) * 240, w: 300, h: 220, text: `# cap ${i}\n\n` + Array.from({ length: 14 }, (_, k) => `cap ${i} line ${k}`).join('\n') }); });
  const capBufs = await until(() => M2.evaluate(() => Object.values<BoardNode & { buf?: string }>(window.__canvas.S.nodes).filter(n => /^cap\d+$/.test(n.name) && n.buf).length === 40), 40000);
  await M2.evaluate(() => { const C = window.__canvas, z = 0.47; C.S.cam.z = z; C.S.cam.x = 4590 - (innerWidth / 2) / z; C.S.cam.y = 3480 - (innerHeight / 2) / z; C.applyCam(); C.frSchedule(); });
  const liveN = await until(() => M2.evaluate(() => { const f = window.__perf!.frame; return f.live >= f.cap ? f.live : null; }), 20000);
  await sleep(1000);
  st = await M2.evaluate(() => { const C = window.__canvas, f = window.__perf!.frame, vis = Object.values<BoardNode>(C.S.nodes).filter(n => /^cap\d+$/.test(n.name)).filter(n => { const e = document.querySelector(`.node[data-id="${n.id}"]`), r = e!.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; }).length; return { z: C.S.cam.z, live: f.live, cap: f.cap, inView: vis, liveEls: document.querySelectorAll('.node.fr-live').length }; });
  await M2.evaluate(() => { const C = window.__canvas; C.zoomAt(innerWidth / 2, innerHeight / 2, 0.6); C.frSchedule(); }); await sleep(800);
  const far = await M2.evaluate(() => { const C = window.__canvas, f = window.__perf!.frame, n = Object.values<BoardNode>(C.S.nodes).find(n => n.name === 'cap7'), e = document.querySelector(`.node[data-id="${n!.id}"] .lod`); return { z: C.S.cam.z, live: f.live, lod: getComputedStyle(e!).display, title: e!.querySelector('b')!.textContent, snap: e!.querySelector('pre')!.textContent, text: C.pageText(n!.id) }; });
  await M2.evaluate(() => { const C = window.__canvas; C.zoomAt(innerWidth / 2, innerHeight / 2, 0.5 / C.S.cam.z); C.frSchedule(); }); await sleep(800);   // above 0.48: the far look goes (F-A36)
  const near = await M2.evaluate(() => { const C = window.__canvas, f = window.__perf!.frame, n = Object.values<BoardNode>(C.S.nodes).find(n => n.name === 'cap7'); return { z: C.S.cam.z, live: f.live, lod: getComputedStyle(document.querySelector(`.node[data-id="${n!.id}"] .lod`)!).display }; });
  check('frames: with 40 pages in view at reading zoom at most 24 frames are live; zoomed out below 0.45 every page is a snapshot of its first 12 lines and no frame is live; zooming back in brings the frames back', !!capBufs && st.inView >= 40 && liveN === 24 && st.live <= st.cap && st.live === 24 && st.liveEls === st.live && far.z < 0.45 && far.live === 0 && far.lod === 'block' && far.title === 'cap7' && far.snap === far.text.split('\n').slice(0, 12).join('\n') && near.z >= 0.45 && near.lod === 'none' && near.live === 24, JSON.stringify({ capBufs: !!capBufs, liveN, st, far: { ...far, snap: far.snap.slice(0, 30), text: far.text.slice(0, 30) }, near }));
  await settled(M2);
  await M2.close();

  // (g) a migration whose board save never lands: this tab's PUTs to /api/board fail, as for a tab closed, asleep or
  // offline before its save. The page is held (no frame, no edit through the replica) until that PUT's 204, so its file
  // keeps the page text and the next load links the same file again (R8.18), not <slug>-2.md with the old text while the
  // edited file is left unlinked. Once the next tab's save lands, the page takes edits.
  const keep = await (await api('/api/board')).json(), keepFile = path.join(TMP, 'before-held-board.json'); fs.writeFileSync(keepFile, JSON.stringify(keep));
  const hText = '# Held One\n\noriginal body\n', hEdited = hText + 'typed after the migration\n';
  const hFile = path.join(TMP, 'held-board.json');
  fs.writeFileSync(hFile, JSON.stringify({ v: 5, fs: keep.fs, views: {}, nodes: { h1: { id: 'h1', kind: 'buffer', name: 'Held One', x: 100, y: 100, w: 480, h: 340, text: hText } }, edges: [], strokes: [], shapes: [], cam: { x: 0, y: 0, z: 1 } }));
  const hInst = await harnessCtl('board ' + hFile);
  const R = await ctx.newPage();
  let blocked = 0; await R.route('**/api/board', route => { if (route.request().method() === 'PUT') { blocked++; return route.abort(); } return route.continue(); });
  await R.goto(ORIGIN + '/'); await until(() => R.evaluate(() => window.__canvas?.BOOTED)); await until(() => R.evaluate(() => window.__perf?.frame?.ready), 30000);
  const hBuf = await until(() => R.evaluate(() => window.__canvas.S.nodes.h1?.buf || null), 20000);
  await until(() => blocked > 0, 10000);
  await R.evaluate(() => { const C = window.__canvas; C.frFocus(C.S.nodes.h1); C.frSchedule(); }); await sleep(500);
  const held = await R.evaluate(() => { const C = window.__canvas; return { hold: C.FR.hold.has('h1'), frame: !!C.live.h1?.frame, edit: C.pageEdit(C.S.nodes.h1, 0, 0, 'x') }; });
  const setOk = await R.evaluate((t: string) => { const C = window.__canvas; return C.pageSetText(C.S.nodes.h1, t); }, hEdited);
  const replica = await R.evaluate(() => window.__canvas.live.h1?.buf?.text ?? null);
  await R.close({ runBeforeUnload: false });
  const servedH = (await (await api('/api/board')).json()).nodes.h1 || {};
  const R2 = await ctx.newPage(); watchErrors(R2);
  const hLog = []; R2.on('console', m => { if (/edwin: migrated/.test(m.text())) hLog.push(m.text()); });
  await R2.goto(ORIGIN + '/'); await until(() => R2.evaluate(() => window.__canvas?.BOOTED)); await until(() => R2.evaluate(() => window.__perf?.frame?.ready), 30000);
  const hBuf2 = await until(() => R2.evaluate(() => window.__canvas.S.nodes.h1?.buf || null), 20000);
  const servedH2 = await until(async () => (await (await api('/api/board')).json()).nodes.h1?.buf || null, 15000);
  const shown = await until(() => R2.evaluate(() => { const t = window.__canvas.pageText('h1'); return t || null; }), 5000);
  const setOk2 = await R2.evaluate((t: string) => { const C = window.__canvas; return C.pageSetText(C.S.nodes.h1, t); }, hEdited);
  const shown2 = await until(() => R2.evaluate((t: string) => window.__canvas.pageText('h1') === t || null, hEdited), 5000);
  st = { hInst: hInst?.event, blocked, hBuf, held, setOk, replica: replica === hText, served: { buf: servedH.buf || null, text: servedH.text === hText }, hBuf2, servedH2, shown: shown === hText, second: readNote('notes/held-one-2.md') !== null, hLog: hLog.length, setOk2, shown2: !!shown2 };
  check('frames: a migrated page takes no frame and no edit until the board save carrying its buf lands; when that save never lands, the next load links the same file again (no -2 file), and the page takes edits once its save landed', st.hInst === 'board' && blocked > 0 && hBuf === 'notes/held-one.md' && held.hold && !held.frame && held.edit === false && setOk === false && st.replica && !st.served.buf && st.served.text && hBuf2 === hBuf && servedH2 === hBuf && st.shown && !st.second && st.hLog === 1 && setOk2 === true && st.shown2, JSON.stringify(st));
  await settled(R2); await R2.close();

  // (h) two tabs load a board with a page to migrate at once: both open the empty file before either fills it. edwind
  // fills a file only while it is empty, in one step (notes-fill), so it has the page text once and both tabs link it.
  const tText = '# Twice Loaded\n\nbody\n';
  fs.writeFileSync(hFile, JSON.stringify({ v: 5, fs: keep.fs, views: {}, nodes: { t1: { id: 't1', kind: 'buffer', name: 'Twice Loaded', x: 100, y: 100, w: 480, h: 340, text: tText } }, edges: [], strokes: [], shapes: [], cam: { x: 0, y: 0, z: 1 } }));
  const tInst = await harnessCtl('board ' + hFile);
  const tabs = [await ctx.newPage(), await ctx.newPage()]; tabs.forEach(watchErrors);
  await Promise.all(tabs.map(t => t.goto(ORIGIN + '/')));
  const tBufs = await Promise.all(tabs.map(async t => { await until(() => t.evaluate(() => window.__canvas?.BOOTED)); return until(() => t.evaluate(() => window.__canvas.S.nodes.t1?.buf || null), 40000); }));
  await sleep(1000);
  const tSt = { tInst: tInst?.event, tBufs, file: readNote('notes/twice-loaded.md'), second: readNote('notes/twice-loaded-2.md') !== null };
  check('frames: two tabs that load a board with the same page to migrate at once link the same file, which has the page text once', tSt.tInst === 'board' && tSt.tBufs.every(b => b === 'notes/twice-loaded.md') && tSt.file === tText && !tSt.second, JSON.stringify(tSt));
  for (const t of tabs) await t.close({ runBeforeUnload: false });
  await harnessCtl('board ' + keepFile);   // the board as it was, for the sections after this one
});
