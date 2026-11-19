import { check, section, sleep, state, until, watchErrors } from '../shared.mts';
import { ORIGIN, api, ctx, pageText, palLabels, record, settled } from '../daemon.mts';

const { DAY } = state;

// The frame's DOM (R16.8: the checks name behaviours, this map names where each one shows): the text to click into, a
// line, a completion candidate, a wiki link, the rendered ((ref)), a task keyword mark, the element whose colours the
// theme check reads (a frame's background is the card body's: look falls back to it).
const Q = { content: '.edwin-frame .text', line: '.edwin-frame .ln', opts: '.corfu .cand', link: '.markdown-wiki-link', ref: '.markdown-block-ref-display', task: '[class*="markdown-task-"]', look: '.edwin-frame' };
/* The frame DOM's selectors. */
type PageSelectors = typeof Q;

// R16.8: page cards, driven through the UI (keys, clicks, the palette, header buttons); each check names a behaviour
// the page kept from its CodeMirror days, as an Edwin frame. The page's text is read through pageText only.
// The browser's speech engine is replaced by one that says window.__speech: dictation is the page's own path from
// a recognition result to an insertion at the cursor.
await section('pages', async () => {
  let st: any;   // Each snapshot has its own shape.
  const P = await ctx.newPage(); watchErrors(P); record(P);
  await P.addInitScript(() => {
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      declare onaudiostart?: () => void; declare onresult: SpeechRecognitionLike['onresult']; declare onend: SpeechRecognitionLike['onend'];
      start() { setTimeout(() => { this.onaudiostart?.(); this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: window.__speech || '' }], { isFinal: true })] }); }, 50); }
      stop() { setTimeout(() => this.onend?.(), 0); }
      abort() { this.stop(); }
    } as new () => SpeechRecognitionLike;
  });
  await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED)); await P.bringToFront();
  await until(() => P.evaluate(() => window.__perf?.frame?.online), 20000);   // replicas open once the /edit socket is up
  try {
    const edit = (await (await api('/api/status')).json()).edit;
    check('pages: wb-web reaches the editing server the harness started (/api/status.edit.up)', edit?.up === true, JSON.stringify(edit));
    const mk = (name: string, text: string, x: number, y: number) => P.evaluate((a: { name: string; text: string; x: number; y: number }) => window.__canvas.addNode({ kind: 'buffer', name: a.name, x: a.x, y: a.y, w: 480, h: 340, text: a.text }).id, { name, text, x, y });
    const alpha = await mk('pg-alpha', '# pg-alpha\n\n- ref: ((pg-beta))\n- item one', 9000, 9000);
    const beta = await mk('pg-beta', 'Beta first line\n- more about beta', 9600, 9000);
    const tasksPg = await mk('pg-tasks', '# pg-tasks\n\n- TODO Alpha task', 9000, 9500);
    const card = (id: string) => `.node[data-id="${id}"]`;
    const show = async (id: string) => { await P.evaluate((id: string) => { const C = window.__canvas; C.jumpNode(C.S.nodes[id], 1); }, id); await sleep(700); };
    const active = () => P.evaluate(() => document.querySelector<HTMLElement>('#world .node.active')?.dataset.id || null);
    const inPage = (id: string) => P.evaluate((id: string) => !!document.activeElement?.closest(`.node[data-id="${id}"] .body`), id);
    const leave = async () => { await P.keyboard.press('Escape'); await P.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await sleep(100); };
    const vim = true;   // an Edwin frame starts in evil's normal state
    // the keyboard into the card (Enter on the active card), then to the end of the text, inserting
    const enterPage = async (id: string) => { await show(id); await P.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await P.keyboard.press('Enter'); await sleep(300); };
    const appendAt = async () => { if (vim) { await P.keyboard.press('Shift+G'); await P.keyboard.press('Shift+A'); } else await P.keyboard.press('Control+End'); };
    const gotoLine = async (n: number) => { if (vim) await P.keyboard.type(n + 'G'); else { await P.keyboard.press('Control+Home'); for (let i = 1; i < n; i++) await P.keyboard.press('ArrowDown'); } };
    // The palette opens with leader / (keys.js: the leader map), which reaches the board from every card: since F-A23 C-k is
    // the program's in a shell (the dock has the keyboard after a load) and Edwin's in a page frame (R9.7); N53 covers C-k itself
    const openPalette = async () => { await P.keyboard.press('Control+Space'); await P.keyboard.press('/'); };
    const palette = async (label: string) => { await openPalette(); await sleep(150); await P.fill('#pal-in', '>' + label); await sleep(150); const first = (await palLabels(P))[0]; await P.keyboard.press('Enter'); await sleep(300); return first; };

    // typing: click into the page, type, the text is in the page
    await show(alpha);
    await sleep(800);   // the new pages' files are being made and opened; the first click must land on a frame
    await P.click(card(alpha) + ' ' + Q.content); await sleep(100); await appendAt();
    await P.keyboard.type(' typed-here');
    st = { inPage: await inPage(alpha), text: await pageText(P, alpha) };
    check('pages: clicking into a page card and typing puts the text in the page', st.inPage && /- item one typed-here$/.test(st.text), JSON.stringify(st));
    await leave();

    // Enter on the selected card puts the keyboard in it (F-A21); Shift-Enter opens it as a focus tab; Esc returns
    await P.keyboard.press('Enter'); await sleep(300);
    st = { inPage: await inPage(alpha), focus: await P.evaluate(() => window.__canvas.FOCUS.cur), active: await active() };
    if (vim) await P.keyboard.press('Shift+A'); await P.keyboard.type(' by-enter'); st.text = await pageText(P, alpha);
    await leave();
    const rect0 = await P.evaluate((id: string) => { const n = window.__canvas.S.nodes[id]; return { x: n.x, y: n.y, w: n.w, h: n.h }; }, alpha);
    await P.keyboard.press('Shift+Enter'); await sleep(400);
    st.tab = await P.evaluate((id: string) => ({ cur: window.__canvas.FOCUS.cur, body: document.body.classList.contains('focus'), focused: document.querySelector(`.node[data-id="${id}"]`)!.classList.contains('focused'), on: document.querySelector('#focus-tabs .ft.on')?.textContent }), alpha);
    check('pages: Enter on the selected page card puts the keyboard in its text; Shift-Enter opens it as a focus tab', st.inPage && !st.focus && st.active === alpha && / by-enter$/.test(st.text) && st.tab.cur === alpha && st.tab.body && st.tab.focused && st.tab.on?.includes('pg-alpha'), JSON.stringify(st));
    await P.keyboard.press('Escape'); await sleep(400);
    st = await P.evaluate((a: { id: string; r: BoardSize & BoardPoint }) => { const n = window.__canvas.S.nodes[a.id]; return { cur: window.__canvas.FOCUS.cur, body: document.body.classList.contains('focus'), same: n.w === a.r.w && n.h === a.r.h && n.x === a.r.x && n.y === a.r.y, tabs: [...document.querySelectorAll('#focus-tabs .ft')].map(t => t.textContent) }; }, { id: alpha, r: rect0 });
    check('pages: Esc leaves the focus tab, the card gets its place back and the tab stays in the strip', !st.cur && !st.body && st.same && st.tabs.some((t: string) => t.includes('pg-alpha')), JSON.stringify(st));
    await P.evaluate(() => window.__canvas.focusClose(window.__canvas.FOCUS.tabs[0]));

    // wiki-link completion: [[ then letters lists node names; accepting closes the link; clicking the link opens that page
    await enterPage(alpha); await appendAt();
    await P.keyboard.press('Enter'); await P.keyboard.type('see [[pg-b');
    const opts = await until(() => P.evaluate((q: string) => { const o = [...document.querySelectorAll(q)].map(l => l.textContent); return o.length ? o : null; }, Q.opts), 5000);
    await sleep(300);   // a person reads the list before accepting
    await P.keyboard.press('Enter'); await sleep(200);
    st = { opts, text: await pageText(P, alpha) };
    check('pages: [[ plus letters offers page names to complete; accepting one closes the link with ]]', Array.isArray(opts) && opts.some(o => /pg-beta/.test(o)) && /\n- see \[\[pg-beta\]\]$/.test(st.text), JSON.stringify(st));
    await leave();
    await P.click(card(alpha) + ' ' + Q.link); await sleep(900);
    st = { active: await active(), z: await P.evaluate(() => window.__canvas.S.cam.z) };
    check('pages: clicking a [[link]] opens the linked page', st.active === beta, JSON.stringify(st));
    await leave();

    // block refs render as the referenced text, raw on the cursor's line
    await show(alpha);
    const ref = () => P.evaluate(([id, Q]: readonly [string, PageSelectors]) => { const e = document.querySelector(`.node[data-id="${id}"]`); const w = [...e!.querySelectorAll(Q.ref)].find(x => x.textContent); return { widget: w ? w.textContent : null, raw: [...e!.querySelectorAll(Q.line)].some(l => l.textContent.includes('((pg-beta))')) }; }, [alpha, Q] as const);
    const r0 = await ref();
    await enterPage(alpha); await gotoLine(3); await sleep(200);
    const r1 = await ref();
    await gotoLine(1); await sleep(200);
    const r2 = await ref();
    await leave();
    check('pages: a ((block ref)) shows the referenced text, and the raw reference on the line the cursor is on', r0.widget === 'Beta first line' && !r0.raw && r1.widget === null && r1.raw && r2.widget === 'Beta first line', JSON.stringify({ r0, r1, r2 }));

    // an anchor at the cursor from the header button: a chip in the text, no change to the text
    await enterPage(alpha); await gotoLine(4); const t0 = await pageText(P, alpha);
    await P.click(card(alpha) + ' .hb[title^="Drop a named anchor"]'); await sleep(200);
    st = { asked: await P.evaluate(() => !document.querySelector<HTMLElement>('#ask')!.hidden && document.activeElement?.id === 'ask-in') };
    await P.fill('#ask-in', 'spot'); await P.keyboard.press('Enter'); await sleep(300);
    st.chip = await P.evaluate((id: string) => [...document.querySelectorAll(`.node[data-id="${id}"] .anchor-chip`)].map(c => c.textContent), alpha);
    st.same = (await pageText(P, alpha)) === t0;
    await openPalette(); await sleep(150); await P.fill('#pal-in', 'pg-alpha#spot'); await sleep(200); st.palette = await palLabels(P); await P.keyboard.press('Escape');
    check('pages: the anchor button asks for a name and drops a chip at the cursor that the palette finds as page#name; the text stays', st.asked && st.chip.join() === '⚓spot' && st.same && st.palette.includes('pg-alpha#spot'), JSON.stringify(st));
    await leave();

    // ink on a line: a pen stroke over a text line sticks to that line
    await show(alpha);
    await P.keyboard.press('p'); await sleep(100);
    const lineBox = await P.locator(card(alpha) + ' ' + Q.line).nth(3).boundingBox();
    const y = lineBox!.y + lineBox!.height / 2, x0 = lineBox!.x + 20;
    await P.mouse.move(x0, y); await P.mouse.down(); for (let i = 1; i <= 6; i++) await P.mouse.move(x0 + i * 15, y + (i % 2) * 2); await P.mouse.up(); await sleep(300);
    await P.keyboard.press('v');
    st = await P.evaluate((id: string) => { const C = window.__canvas, s = C.S.strokes.filter((s: Stroke) => s.owner === id); return { strokes: s.length, aid: s[0]?.aid || null, paths: document.querySelectorAll(`.node[data-id="${id}"] .ink-lines path`).length }; }, alpha);
    check('pages: a pen stroke across a text line is kept with the page, anchored to that line, and drawn in the page', st.strokes === 1 && /^ink-/.test(st.aid || '') && st.paths >= 1, JSON.stringify(st));

    // outline keys: Enter continues a bullet or a numbered item, outdents then ends an empty one; Tab and Shift-Tab indent
    await enterPage(alpha); await gotoLine(4); await P.keyboard.press('End'); if (vim) await P.keyboard.press('Shift+A');
    await P.keyboard.press('Enter'); await P.keyboard.type('item two');
    await P.keyboard.press('Enter'); await P.keyboard.press('Tab'); await P.keyboard.type('sub');
    await P.keyboard.press('Shift+Tab'); const outdented = (await pageText(P, alpha)).split('\n')[5];
    await P.keyboard.press('Tab');
    await P.keyboard.press('Enter'); await P.keyboard.type('sub2');
    // Enter on an empty item: out one level, then out of the list. (On today's page the markdown language's Enter runs
    // before outlineEnter; in a tight list of two items it first makes the list loose with a blank line, so the empty
    // item here is the third of its list.)
    await P.keyboard.press('Enter'); await P.keyboard.press('Enter'); await P.keyboard.press('Enter');
    await P.keyboard.type('1. first'); await P.keyboard.press('Enter'); await P.keyboard.type('second');
    await leave();
    st = { lines: (await pageText(P, alpha)).split('\n').slice(3, 9), outdented };
    check('pages: Enter in a list continues the bullet, numbers the next item, outdents an empty item and ends the list; Tab and Shift-Tab indent and outdent', st.lines.join('|') === '- item one typed-here by-enter|- item two|  - sub|  - sub2|1. first|2. second' && outdented === '- sub', JSON.stringify(st));

    // task cycling: t / T on the selected task in the tasks view change the keyword in the page
    await P.keyboard.press('Alt+Digit6'); await sleep(400);
    await P.locator('.tk-card', { hasText: 'Alpha task' }).first().click(); await sleep(150);
    await P.keyboard.press('t'); await until(async () => /- NEXT Alpha task/.test(await pageText(P, tasksPg)), 3000);
    const k1 = await pageText(P, tasksPg);
    await P.keyboard.press('T'); await until(async () => /- TODO Alpha task/.test(await pageText(P, tasksPg)), 3000);
    const k2 = await pageText(P, tasksPg);
    await P.keyboard.press('Alt+Digit1'); await sleep(300);
    await show(tasksPg);
    st = { k1: k1.split('\n')[2], k2: k2.split('\n')[2], mark: await P.evaluate(([id, q]: string[]) => document.querySelector(`.node[data-id="${id}"] ${q}`)?.textContent, [tasksPg, Q.task]) };
    check('pages: t and T on the selected task in the tasks view cycle its keyword in the page, which shows the keyword marked', st.k1 === '- NEXT Alpha task' && st.k2 === '- TODO Alpha task' && st.mark === 'TODO', JSON.stringify(st));

    // the journal command opens today's page, creating it when the board has none
    await P.evaluate((day: string) => { const C = window.__canvas, n = C.findPage(day); if (n) C.removeNode(n.id); }, DAY);
    const ran = await palette('Open today');
    await sleep(900);
    st = await P.evaluate((day: string) => { const C = window.__canvas, n = C.findPage(day); return { page: !!n, active: n && document.querySelector<HTMLElement>('#world .node.active')?.dataset.id === n.id, name: n?.name }; }, DAY);
    check('pages: the journal command opens today\'s page, creating it when there is none', /today/i.test(ran || '') && st.page && st.active && st.name === DAY, JSON.stringify({ ran, st }));
    await leave();

    // dictation inserts what the speech engine heard at the cursor
    await enterPage(alpha); await gotoLine(2);
    await P.evaluate(() => { window.__speech = 'dictated words'; });
    await palette('Dictate into the page');
    const heard = await until(async () => /dictated words/.test(await pageText(P, alpha)), 5000);
    st = { line2: (await pageText(P, alpha)).split('\n')[1], heard: !!heard };
    await P.evaluate(() => document.querySelector<HTMLElement>(`.hb.mic.on`)?.click());
    await leave();
    check('pages: dictation inserts the recognised text at the cursor', st.heard && st.line2 === 'dictated words', JSON.stringify(st));

    // a theme switch re-renders the page card in the new colours
    const look = () => P.evaluate(([id, q]: string[]) => { const e = document.querySelector(`.node[data-id="${id}"] ${q}`), cs = getComputedStyle(e!), bs = getComputedStyle(document.querySelector(`.node[data-id="${id}"] .body`)!); return { bg: cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? bs.backgroundColor : cs.backgroundColor, fg: cs.color, token: getComputedStyle(document.documentElement).getPropertyValue('--buf-bg').trim() }; }, [alpha, Q.look]);
    const l0 = await look();
    await palette('Theme: Modus Vivendi'); await sleep(300);
    const l1 = await look();
    await palette('Theme: follow the system'); await sleep(300);
    const l2 = await look();
    check('pages: switching the theme re-colours the page card, and switching back restores it', l0.bg !== l1.bg && l0.fg !== l1.fg && l0.token !== l1.token && l2.bg === l0.bg, JSON.stringify({ l0, l1, l2 }));

    // far out, a page card shows a snapshot of its first lines
    await show(alpha);
    const vp = await P.locator('#viewport').boundingBox();
    await P.mouse.move(vp!.x + vp!.width / 2, vp!.y + vp!.height / 2);
    await P.keyboard.down('Control');
    for (let i = 0; i < 40 && await P.evaluate(() => window.__canvas.S.cam.z >= 0.40); i++) { await P.mouse.wheel(0, 120); await sleep(30); }   // the far look comes on below 0.42 and goes above 0.48 (F-A36)
    await P.keyboard.up('Control'); await sleep(400);
    const text = await pageText(P, alpha);
    st = await P.evaluate((id: string) => { const e = document.querySelector(`.node[data-id="${id}"] .lod`); return { z: window.__canvas.S.cam.z, shown: getComputedStyle(e!).display, title: e!.querySelector('b')!.textContent, snap: e!.querySelector('pre')!.textContent }; }, alpha);
    await P.keyboard.down('Control');
    for (let i = 0; i < 40 && await P.evaluate(() => window.__canvas.S.cam.z < 0.5); i++) { await P.mouse.wheel(0, -120); await sleep(30); }
    await P.keyboard.up('Control'); await sleep(300);
    st.after = await P.evaluate((id: string) => getComputedStyle(document.querySelector(`.node[data-id="${id}"] .lod`)!).display, alpha);
    check('pages: zoomed out below reading size a page card shows its name and its first lines; zooming back in shows the text again', st.z < 0.45 && st.shown === 'block' && st.title === 'pg-alpha' && st.snap === text.split('\n').slice(0, 12).join('\n') && st.after === 'none', JSON.stringify({ ...st, snap: st.snap.slice(0, 60) }));
    await settled(P);
  } finally { await P.close(); }
});
