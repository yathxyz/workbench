import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TMP, check, shot, sleep, state, until, watchErrors } from './shared.mts';

const { browser } = state;
async function page(url: string, w = 1500, h = 950): Promise<import('playwright-core').Page> {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  watchErrors(p);
  await p.goto(url); await sleep(1500); return p;
}

// ---------------- demo mode
// The demo as one file, built here from the web root: the APP part of index.html with the styles, the bridge
// source, vendor.js, keys.js and app.js inline, and no font link.
function demoPage() {
  const rd = (f: string) => fs.readFileSync(path.join(ROOT!, f), 'utf8'), js = (f: string) => rd(f).replaceAll('</script', '<\\/script');
  const body = rd('index.html').split('<!--APP-->')[1].split('<!--/APP-->')[0];
  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body>
<title>Workbench</title>
<style>
${rd('vendor/xterm.css')}
${rd('style.css')}
</style>
${body}
<script>window.WB_BRIDGE_SRC = ${JSON.stringify(rd('bridge.js')).replaceAll('</script', '<\\/script')};</script>
<script>
${js('vendor/vendor.js')}
</script>
<script>
${js('keys.js')}
</script>
<script>
${js('app.js')}
</script>
</body></html>`;
}
const wrapped = path.join(TMP, 'wb-wrapped.html');
fs.writeFileSync(wrapped, demoPage());
const demoHosts = new Set();
let p = await browser.newPage({ viewport: { width: 1500, height: 950 } });
watchErrors(p); p.on('request', r => demoHosts.add(new URL(r.url()).host));
await p.goto('file://' + wrapped); await sleep(1500);
// The demo writes today's journal page; the app takes the local date, and so do these checks.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NOW = new Date(), DAY = ymd(NOW), Y = DAY.slice(0, 4), YM = DAY.slice(0, 7), DAYP = DAY.replaceAll('-', '/'), PREV = ymd(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1));
state.DAY = DAY;
check('demo boots', await p.evaluate(() => !!window.__canvas.S && !window.__canvas.DAEMON));
await p.evaluate(() => window.__canvas.newArtifact('hello1'));
await sleep(2500);
let st: any = await p.evaluate(() => { const n = Object.values<BoardNode>(window.__canvas.S.nodes).find(n => n.kind === 'artifact')!; const L = window.__canvas.live[n.id]; return { hello: L.hello, head: n.head, notice: L.notice.hidden, caps: n.capabilities }; });   // any: reused by every check for its own result shape
check('demo artifact handshake', st.hello === true && st.notice === true && !!st.head, JSON.stringify(st));
const artFrame = async (pg: import('playwright-core').Page, i = 0) => (await pg.$$('.art-frame'))[i].contentFrame();
let fr = await artFrame(p);
check('frame present', !!fr);
await fr!.click('#count'); await sleep(800);
check('db set/get through bridge', (await fr!.textContent('#out'))!.includes('count = 1'), await fr!.textContent('#out'));
await fr!.click('#count'); await sleep(600);
check('db persists', (await fr!.textContent('#out'))!.includes('count = 2'));
await fr!.click('#ask'); await sleep(800);
const grantVisible = await p.evaluate(() => !document.querySelector<HTMLElement>('#grant')!.hidden);
check('grant prompt shown for sample', grantVisible);
await p.click('#grant-allow'); await sleep(800);
check('sample absent in demo rejects with code', (await fr!.textContent('#out'))!.includes('failed: sampling_disabled'), await fr!.textContent('#out'));
const nsCheck = await fr!.evaluate(async () => { const s = await wb.use('sample'); const d = await wb.use('db'); const x = await wb.use('nope'); const perm = await wb.use('permissions'); return { frozen: Object.isFrozen(s) && Object.isFrozen(d), same: (await wb.use('db')) === d, nope: x, st: await perm.state('sample'), limits: await s.limits() }; });
check('namespaces frozen, memoised, unknown null, permissions state', nsCheck.frozen && nsCheck.same && nsCheck.nope === null && nsCheck.st === 'granted', JSON.stringify(nsCheck));
// artifact.publish from inside the page -> new version, frame reloads
fr!.evaluate(() => { wb.use('artifact').then(a => a.publish('<title>Hi2</title><p id=v2>second</p>')).catch(() => {}); }).catch(() => {});
await sleep(800); if (await p.evaluate(() => !document.querySelector<HTMLElement>('#grant')!.hidden)) await p.click('#grant-allow');
await sleep(1500);
fr = await artFrame(p);
st = await p.evaluate(() => { const n = Object.values<BoardNode>(window.__canvas.S.nodes).find(n => n.kind === 'artifact')!; return { versions: n.versions!.length, head: n.head, html: n.html }; });
check('artifact.publish makes a version and reloads', st.versions === 2 && st.html.includes('second') && !!(await fr!.$('#v2')), JSON.stringify(st).slice(0, 200));
// db query / onSnapshot
const q = await fr!.evaluate(async () => { try { const db = await wb.use('db'); const col = db.collection('items'); await col.doc('a').set({ n: 3, tag: 'x' }); await col.doc('b').set({ n: 1, tag: 'x' }); await col.doc('c').set({ n: 2, tag: 'y' });
  const got = await col.where('tag', '==', 'x').orderBy('n', 'desc').get(); let snaps = 0; const un = col.onSnapshot((s: { size: number }) => { snaps = s.size; }); await new Promise(r => setTimeout(r, 100)); await col.doc('d').set({ n: 9 }); await new Promise(r => setTimeout(r, 100)); un();
  return { ids: got.docs.map((d: { id: string }) => d.id), size: got.size, snaps }; } catch (e) { return { error: JSON.stringify(e), msg: String(e && e.message) }; } });
check('db query where/orderBy and onSnapshot', q.ids?.join() === 'a,b' && q.snaps === 4, JSON.stringify(q));
// N55: the leader pressed inside an artifact reaches the board through the bridge and takes the keyboard out of the frame
await fr!.click('body', { position: { x: 5, y: 5 } }).catch(() => {}); await p.keyboard.press('Control+Space'); await sleep(300);
st = await p.evaluate(() => ({ leader: !document.getElementById('which-key')!.hidden, inFrame: document.activeElement?.tagName === 'IFRAME' }));
await p.keyboard.press('Escape');
check('N55: the leader inside an artifact opens the board\'s leader and leaves the frame', st.leader && !st.inFrame, JSON.stringify(st));
// a leader picked while the artifact is open reaches it too; Shift-F1 stays the page's
await p.evaluate(() => window.__canvas.setLeader('F1'));
const wkOpen = () => p.evaluate(() => !document.getElementById('which-key')!.hidden);
const inArt = (k: string) => fr!.click('body', { position: { x: 5, y: 5 } }).catch(() => {}).then(() => p.keyboard.press(k)).then(() => sleep(250)).then(wkOpen);
st = { old: await inArt('Control+Space') }; if (st.old) await p.keyboard.press('Escape');
st.shift = await inArt('Shift+F1'); if (st.shift) await p.keyboard.press('Escape');
st.f1 = await inArt('F1'); await p.keyboard.press('Escape');
await p.evaluate(() => window.__canvas.setLeader('C-SPC'));
check('N55: after the leader changes, an open artifact hands back the new one and no longer the old; Shift-F1 stays in the page', !st.old && !st.shift && st.f1, JSON.stringify(st));
// N68 (F-A36): two fingers in an artifact pinch the board's camera. The frame keeps its touches, so bridge.js reports them
// ({t:'touch'}) and the board pinches with them; the page's own touchmove is held (preventDefault) while two are down.
st = { z0: await p.evaluate(() => window.__canvas.S.cam.z) };
const ftouch = (type: string, xs: number[]) => fr!.evaluate(([type, xs]) => { const t = (x: number, i: number) => new Touch({ identifier: i + 1, target: document.body, clientX: x, clientY: 60 }); const ts = xs.map(t); const e = new TouchEvent(type, { touches: type === 'touchend' ? [] : ts, changedTouches: ts, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }, [type, xs] as [string, number[]]);
await ftouch('touchstart', [100, 160]); await sleep(150);
st.held = await ftouch('touchmove', [70, 190]); await sleep(150);
st.mid = await p.evaluate(() => ({ z: window.__canvas.S.cam.z, panning: document.querySelector('#viewport')!.classList.contains('panning') }));
await ftouch('touchend', []); await sleep(200);
st.end = await p.evaluate(() => ({ z: window.__canvas.S.cam.z, touching: document.querySelector('#viewport')!.classList.contains('touching'), ids: window.__canvas.FTOUCH.ids.size }));
check('N68: two fingers in an artifact pinch the board\'s camera (spread 60 to 120 px: zoom 2x) and the page does not scroll meanwhile; lifting them ends the pinch', st.held && st.mid.panning && Math.abs(st.mid.z / st.z0 - 2) < 0.03 && !st.end.touching && st.end.ids === 0, JSON.stringify(st));
await p.evaluate((z: number) => { const C = window.__canvas; C.S.cam.z = z; C.applyCam(); }, st.z0);
// F-A25: an html fence in a page torn out as a block card, bound to the block (hypernotes H0). The demo has no edwind:
// the page is read-only, and the board's own edits (pageSetText, pageEdit, tear_out_block) change its text.
const blockFrame = (sel: string) => until(async () => { for (const f of p.frames()) { try { if (await f.$(sel)) return f; } catch {} } return null; }, 8000);
st = await p.evaluate(async () => {
  const c = window.__canvas, pg = c.openPage('hn-blocks', null, true);
  await c.pageSetText(pg, '# hn\n\n```html {#chart card=420x260}\n<p id=hnv>one</p>\n```\n\n```js\n```html\n```\n\n~~~html\n<b id=hnw>two</b>\n~~~\n');
  const ids = c.htmlBlocks(c.pageText(pg.id)).map((b: { id: string | null }) => b.id);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // the chips are placed after the text is drawn
  const tear = [...c.live[pg.id].el.querySelectorAll('.fr-tear')];
  tear[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const byWidget = Object.values<ArtifactNode>(c.S.nodes).find(n => n.block?.page === pg.id);
  const out = await c.AGENT_TOOLS.find((t: AgentTool) => t.name === 'tear_out_block').run({ page: 'hn-blocks', block: 'chart' });
  const chart = Object.values<ArtifactNode>(c.S.nodes).find(n => n.block?.page === pg.id && n.block!.id === 'chart');
  return { page: pg.id, ids, tears: tear.length, widget: byWidget?.block?.id, info: c.pageText(pg.id).includes('~~~html {#block1}'), out, chart: chart && { id: chart.id, w: chart.w, h: chart.h, caps: Object.keys(chart.capabilities).join(), html: 'html' in chart, edge: c.S.edges.some((e: Edge) => e.from === pg.id && e.to === chart.id && e.type === 'ref') } };
});
check('block cards: the fence button and tear_out_block make cards bound to page blocks; an id is written for a block without one', st.ids.join() === 'chart,' && st.tears === 2 && st.widget === 'block1' && st.info && st.out.startsWith('created') && st.chart?.w === 420 && st.chart.h === 260 && st.chart.caps === 'sample,db' && !st.chart.html && st.chart.edge, JSON.stringify(st));
let bf = await blockFrame('#hnv');
const bfOrigin = bf && await bf.evaluate(() => origin);
check('block card: the block renders in an opaque-origin frame', !!bf && bfOrigin === 'null' && (await bf.textContent('#hnv')) === 'one', String(bfOrigin));
await p.evaluate(id => { const c = window.__canvas, d = c.pageText(id), i = d.indexOf('one'); c.pageEdit(c.S.nodes[id], i, i + 3, 'uno'); }, st.page);
bf = await until(async () => { const f = await blockFrame('#hnv'); return f && (await f.textContent('#hnv')) === 'uno' ? f : null; }, 6000);
check('block card: an edit to the block reloads the card', !!bf);
const gone = await p.evaluate(async ([pid, cid]) => {
  const c = window.__canvas, d = c.pageText(pid), a = d.indexOf('```html {#chart'), b = d.indexOf('```\n', d.indexOf('<p id=hnv>')) + 4;
  c.pageEdit(c.S.nodes[pid], a, b, ''); await new Promise(r => setTimeout(r, 900));
  const L = c.live[cid]; return { hidden: L.notice.hidden, text: L.notice.textContent };
}, [st.page, st.chart?.id]);
check('block card: a removed block leaves a notice in the card', !gone.hidden && gone.text.includes('no html block #chart'), JSON.stringify(gone));
const adopted = await p.evaluate(async pid => {   // another tab removed the page: the adopted board leaves its cards a notice
  const c = window.__canvas, b = JSON.parse(JSON.stringify({ nodes: c.S.nodes, edges: c.S.edges, strokes: c.S.strokes, shapes: c.S.shapes }));
  delete b.nodes[pid]; b.edges = b.edges.filter((e: Edge) => e.from !== pid && e.to !== pid);
  c.boardAdopt(b); await new Promise(r => setTimeout(r, 100));
  const card = Object.values<ArtifactNode>(c.S.nodes).find(n => n.block?.page === pid && n.block!.id === 'block1'), L = card && c.live[card.id];
  return { page: !!c.S.nodes[pid], hidden: L?.notice.hidden, text: L?.notice.textContent };
}, st.page);
check('block card: a page removed in another tab leaves a notice in its cards', !adopted.page && adopted.hidden === false && adopted.text === 'The page this card came from is gone.', JSON.stringify(adopted));
await p.evaluate(pid => { const c = window.__canvas; for (const n of Object.values<ArtifactNode>(c.S.nodes)) if (n.block?.page === pid) c.removeNode(n.id); if (c.S.nodes[pid]) c.removeNode(pid); }, st.page);
// N71 (F-A39): with no edwind there is no page editor: a page card and the Editor view show the text read-only with a
// notice, the text has no editable element, and no CodeMirror is left anywhere in the page
st = await p.evaluate(async () => {
  const c = window.__canvas, pg = c.openPage('ro-page', null, true);
  await c.pageSetText(pg, '# ro\n\nline two\n');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const body = c.live[pg.id].el, pre = body.querySelector('pre.ro-text') as HTMLElement | null;
  const card = { text: pre?.textContent, editable: !!body.querySelector('[contenteditable=""], [contenteditable="true"], textarea, .cm-editor') || pre?.isContentEditable, notice: body.querySelector('.ro-off')?.textContent };
  c.ED.node = null; c.S.edPage = pg.id; c.setView('editor');
  const ed = { text: document.querySelector('#ed-host .ed-ro')?.textContent, notice: document.querySelector('#ed-host .fr-off')?.textContent };
  c.setView('canvas'); c.removeNode(pg.id);
  return { card, ed, cm: !!document.querySelector('[class^="cm-"], [class*=" cm-"]') };
});
check('N71: no edwind: a page card and the Editor view show the text read-only with the demo notice; no CodeMirror in the page',
  st.card.text === '# ro\n\nline two\n' && !st.card.editable && /^Read-only in the demo/.test(st.card.notice) && st.ed.text === st.card.text && st.ed.notice === st.card.notice && !st.cm, JSON.stringify(st));
// node kinds around terminals (web, artifacts, sketch) in demo mode; there is no Emacs card
st = await p.evaluate(() => { const w = window.__canvas.newWeb('example.org/a'); const s = window.__canvas.newSketch(); const L = window.__canvas.live[w.id]; return { url: w.url, name: w.name, frame: !!L.frame, bar: !!L.urlInput, sketch: s.kind, agentHidden: !document.querySelector('#add-agent'), emacsGone: !document.querySelector('#add-emacs') }; });
check('web and sketch nodes, agent button hidden', st.url === 'https://example.org/a' && st.name === 'example.org' && st.frame && st.bar && st.sketch === 'sketch' && st.agentHidden && st.emacsGone, JSON.stringify(st));
await p.evaluate(() => { for (const n of Object.values<BoardNode>(window.__canvas.S.nodes)) if (n.kind === 'web' || n.kind === 'sketch') window.__canvas.removeNode(n.id); });
// review view
await p.evaluate(() => window.__canvas.setView('review')); await sleep(600);
check('review shows a card', (await p.textContent('#rv-face'))!.trim().length > 0 && (await p.textContent('#rv-due')) === '10', await p.textContent('#rv-due'));
await p.keyboard.press('Space'); await sleep(200);
check('reveal shows answer and intervals', !(await p.$eval('#rv-answer', (e: HTMLElement) => e.hidden)) && (await p.textContent('#rv-iv3'))!.length > 0);
await p.keyboard.press('3'); await sleep(300);
st = await p.evaluate(() => ({ log: window.__canvas.S.reviews, due: document.querySelector('#rv-due')!.textContent, done: document.querySelector('#rv-done')!.textContent }));
check('grade appends a log line', st.log?.length === 1 && st.log[0].g === 3 && st.due === '9' && st.done === '1', JSON.stringify(st));
check('grade: a log line kept in the board names the browser as its device', st.log?.[0]?.dev === 'browser', JSON.stringify(st.log?.[0]));
await p.keyboard.press('u'); await sleep(300);
st = await p.evaluate(() => ({ log: window.__canvas.S.reviews.length, due: document.querySelector('#rv-due')!.textContent }));
check('undo retracts', st.log === 2 && st.due === '10', JSON.stringify(st));
await p.click('#rv-modes button[data-mode="type"]'); await sleep(200); await p.fill('#rv-typein', 'excellence virtue'); await p.keyboard.press('Enter'); await sleep(200);
check('type mode diff', (await p.textContent('#rv-diff'))!.includes('excellence'));
await p.click('#rv-modes button[data-mode="pen"]'); await sleep(300);
check('pen mode canvas', !(await p.$eval('#rv-inkwrap', (e: HTMLElement) => e.hidden)));
// list_due tool
const due = await p.evaluate(async () => window.__canvas.AGENT_TOOLS.find((t: AgentTool) => t.name === 'list_due').run({ limit: 3 }));
check('list_due tool', due.split('\n').length === 3, due);
const cf = await p.evaluate(async () => window.__canvas.AGENT_TOOLS.find((t: AgentTool) => t.name === 'create_flashcard').run({ front: 'Q?', back: 'A', deck: 'test' }));
check('create_flashcard demo', cf.startsWith('added to page cards'), cf);
// palette has the new commands
const cmds = await p.evaluate(() => window.__canvas.CMDS.map((c: PaletteItem) => c.l).filter((l: string) => /Artifact|Review/.test(l)));
check('palette commands', cmds.length >= 9, cmds.join(' | '));
// N78's view is not conditional on the optional mesh API (the demo has neither API nor hub).
await p.evaluate(() => window.__canvas.setView('agents'));
check('N78: Agents is available without the mesh API', await p.evaluate(() => window.__canvas.S.view === 'agents' && !document.querySelector<HTMLElement>('#v-agents')!.hidden && !window.__canvas.INFO?.mesh));
await p.evaluate(() => window.__canvas.setView('review'));
// phone mode
await p.setViewportSize({ width: 420, height: 800 }); await sleep(300);
check('phone mode', (await p.evaluate(() => document.body.dataset.mode)) === 'phone');
await p.setViewportSize({ width: 1500, height: 950 }); await sleep(300);
await shot(p, 'wb-review');
await p.evaluate(() => window.__canvas.setView('canvas')); await sleep(300);
await shot(p, 'wb-canvas');
// ribbon mode, workspaces, focus tabs, optimiser, leader key, neighbours
let v10: any = await p.evaluate(() => {   // any: reused by each check for its own result shape
  const C = window.__canvas, S = C.S;
  const f = Object.values<BoardNode>(S.nodes).find((n): n is FrameNode => n.kind === 'frame' && !n.in && C.kidsOf(n.id).filter((k: BoardNode) => k.kind !== 'frame').length >= 2)!;
  C.setMode(f, 'tile', true);
  const ks = C.kidsOf(f.id).filter((k: BoardNode) => k.kind !== 'frame');
  const ys = new Set(ks.map((k: BoardNode) => k.y)), hs = new Set(ks.map((k: BoardNode) => k.h));
  const cls = document.querySelector(`[data-id="${f.id}"]`)?.classList.contains('m-tile');
  return { id: f.id, ys: ys.size, hs: hs.size, n: ks.length, cls, btn: !document.querySelector(`[data-id="${f.id}"] .fmodes [data-m="ribbon"]`), btns: document.querySelectorAll(`[data-id="${f.id}"] .fmodes button`).length };
});
check('v18.1: the ribbon mode button is gone (four mode buttons); the folder tiles', v10.n >= 2 && v10.cls && v10.btn && v10.btns === 4, JSON.stringify(v10));
v10 = await p.evaluate(id => {
  const C = window.__canvas, S = C.S; C.wsEnter(S.nodes[id], true);
  const inside = new Set([id, ...Object.values<BoardNode>(S.nodes).filter(n => { let c = n; let g = 0; while (c && c.in && g++ < 20) { if (c.in === id) return true; c = S.nodes[c.in]; } return false; }).map(n => n.id)]);
  const all = [...document.querySelectorAll<HTMLElement>('#world .node, #world .frame')];
  const out = all.filter(e => e.classList.contains('outside')).length;
  const wrong = all.filter(e => e.classList.contains('outside') === inside.has(e.dataset.id)).length;
  return { inws: document.body.classList.contains('in-ws'), out, wrong, st: document.querySelector('#st-ws')!.textContent, saved: S.ws === id, top: C.wsTop().length };
}, v10.id);
check('enter workspace: outside dims, breadcrumb in the status bar, persisted', v10.inws && v10.out > 0 && v10.wrong === 0 && v10.st.includes('⌂') && v10.saved && v10.top >= 1, JSON.stringify(v10));
await p.keyboard.press('Escape'); await sleep(700);
v10 = await p.evaluate(() => ({ inws: document.body.classList.contains('in-ws'), out: document.querySelectorAll('.outside').length, st: document.querySelector('#st-ws')!.textContent, ws: window.__canvas.S.ws }));
check('Esc leaves the workspace', !v10.inws && v10.out === 0 && v10.st === '' && !v10.ws, JSON.stringify(v10));
v10 = await p.evaluate(async () => {
  const C = window.__canvas, S = C.S; const n = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'buffer' || n.kind === 'term')!;
  const before = { x: n.x, y: n.y, w: n.w, h: n.h };
  C.goAddr('board:/', false);   // a camera flight is pending, as when restoring the address after a reload
  C.focusOpen(n);
  await new Promise(requestAnimationFrame);
  const vw = document.querySelector('#viewport')!.clientWidth;
  const el = document.querySelector(`.node[data-id="${n.id}"]`)!;
  const r = el.getBoundingClientRect(), vr = document.querySelector('#viewport')!.getBoundingClientRect();
  return { id: n.id, before, w: n.w, vw, fits: n.w >= vw - 4, body: document.body.classList.contains('focus'), focused: el.classList.contains('focused'), tabs: [...document.querySelectorAll('#focus-tabs .ft')].map(t => t.textContent), on: document.querySelector('#focus-tabs .ft.on')?.textContent, left: Math.round(r.left - vr.left), top: Math.round(r.top - vr.top), hiddenOther: getComputedStyle(document.querySelector(`.node:not([data-id="${n.id}"])`)!).visibility, persisted: (S.focusTabs || []).includes(n.id) };
});
check('focus tab fills the main area; strip shows canvas + tab; others hidden', v10.fits && v10.body && v10.focused && v10.tabs.length === 2 && !!v10.on && v10.tabs[0].includes('canvas') && v10.left >= -2 && v10.left <= 2 && v10.top >= 88 && v10.top <= 92 && v10.hiddenOther === 'hidden' && v10.persisted, JSON.stringify(v10));
await p.keyboard.press('Escape'); await sleep(300);
let v10b: any = await p.evaluate(a => { const n = window.__canvas.S.nodes[a.id]; return { same: n.x === a.before.x && n.y === a.before.y && n.w === a.before.w && n.h === a.before.h, body: document.body.classList.contains('focus'), strip: !document.querySelector<HTMLElement>('#focus-tabs')!.hidden, tabs: document.querySelectorAll('#focus-tabs .ft').length }; }, v10);   // any: reused by each check for its own result shape
check('Esc returns to the canvas, node rect restored, tab stays', v10b.same && !v10b.body && v10b.strip && v10b.tabs === 2, JSON.stringify(v10b));
await p.click('#focus-tabs .ft:nth-child(2)'); await sleep(300);
v10b = await p.evaluate(() => ({ body: document.body.classList.contains('focus'), cur: window.__canvas.FOCUS.cur }));
check('clicking the tab re-opens the focus', v10b.body && !!v10b.cur, JSON.stringify(v10b));
await p.evaluate(() => window.__canvas.focusClose(window.__canvas.FOCUS.cur)); await sleep(300);
v10b = await p.evaluate(() => ({ body: document.body.classList.contains('focus'), hidden: document.querySelector<HTMLElement>('#focus-tabs')!.hidden, tabs: window.__canvas.FOCUS.tabs.length }));
check('closing the last tab hides the strip', !v10b.body && v10b.hidden && v10b.tabs === 0, JSON.stringify(v10b));
// optimiser: no overlapping top-level items afterwards, snapped to the grid, undoable
v10 = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const roots = () => Object.values<BoardNode>(S.nodes).filter(n => !n.in && !C.stashed(n));
  const a = roots()[0], b = roots()[1]; b.x = a.x + 10; b.y = a.y + 10; // force an overlap
  C.optimise(null);
  const rs = roots(); let overlaps = 0;
  const top = (k: BoardNode) => k.kind === 'frame' ? 32 : 0;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const p = rs[i], q = rs[j]; if (p.x < q.x + q.w && q.x < p.x + p.w && p.y - top(p) < q.y + q.h && q.y - top(q) < p.y + p.h) overlaps++; }
  const snapped = rs.every(k => (k.x % 24 === 0) && ((k.y - top(k)) % 24 === 0 || k.y % 24 === 0));
  return { n: rs.length, overlaps, snapped, undo: !!document.body && C.CMDS.some((c: PaletteItem) => c.l.startsWith('Layout: optimise')) };
});
check('optimise the board: no overlaps, grid snapped', v10.n >= 3 && v10.overlaps === 0 && v10.snapped && v10.undo, JSON.stringify(v10));
await p.keyboard.press('Control+z'); await sleep(300);
// leader key
await p.keyboard.press('Control+Space'); await sleep(200);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, shown: !document.querySelector<HTMLElement>('#which-key')!.hidden, rows: document.querySelectorAll('#which-key b').length }));
check('Ctrl-Space opens the which-key popup', v10.on && v10.shown && v10.rows >= 20, JSON.stringify(v10));
await p.keyboard.press('z'); await sleep(600);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, shown: !document.querySelector<HTMLElement>('#which-key')!.hidden }));
check('leader z runs fit-all and closes the popup', !v10.on && !v10.shown, JSON.stringify(v10));
// what the terminal sends to its program: NUL is Ctrl-Space (the textarea's own keydown listeners never see the
// passed key, because xterm handles it in the capture phase and stops it)
await p.evaluate(() => { const ta = document.querySelector<HTMLTextAreaElement>('#side-term .xterm-helper-textarea') || document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea'); ta!.focus(); window.__got = 0;
  Object.values<LiveEntry>(window.__canvas.live).find(L => L?.term?.textarea === ta)!.term.onData((d: string) => { if (d === '\x00') window.__got++; }); });
await p.keyboard.press('Control+Space'); await sleep(120);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, got: window.__got }));
await p.keyboard.press('Control+Space'); await sleep(200);
v10 = await p.evaluate(a => ({ ...a, on2: window.__canvas.LEADER.on, got2: window.__got }), v10);
check('leader twice passes the key through and closes', v10.on && v10.got === 0 && !v10.on2 && v10.got2 === 1, JSON.stringify(v10));
// N64 (F-A33): a held leader is one press, so its auto-repeat sends nothing to the terminal (Playwright marks a second
// down of a key that is still down as a repeat); a keyup lost while the page is not focused does not leave Space held
await p.evaluate(() => { window.__got = 0; });
await p.keyboard.down('Control'); for (let i = 0; i < 4; i++) await p.keyboard.down('Space');
await p.keyboard.up('Space'); await p.keyboard.up('Control'); await sleep(200);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, got: window.__got }));
await p.keyboard.press('Escape'); await sleep(100);
await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
await p.keyboard.down('Space'); v10.held = await p.evaluate(() => window.__canvas.spaceHeld);
v10.after = await p.evaluate(() => { window.dispatchEvent(new Event('blur')); return window.__canvas.spaceHeld; });
await p.keyboard.up('Space');
check('N64: a held leader opens the leader once and sends nothing to the terminal; a window blur lets go of Space', v10.on && v10.got === 0 && v10.held && !v10.after, JSON.stringify(v10));
// N65 (F-A34): a right-click opens the palette at the pointer with the actions of the card, folder or canvas under it;
// Shift+right-click and a text field keep the browser's menu (a bubble listener sees the event not prevented); Delete removes
{
  const rc = async (pt: BoardPoint, shift?: boolean) => {
    if (shift) await p.keyboard.down('Shift'); await p.mouse.click(pt.x, pt.y, { button: 'right' }); if (shift) await p.keyboard.up('Shift'); await sleep(150);
    return p.evaluate(() => { const P = document.getElementById('palette')!, r = P.querySelector('.pal')!.getBoundingClientRect();
      return { open: !P.hidden, at: P.classList.contains('at'), x: Math.round(r.left), y: Math.round(r.top), labels: [...P.querySelectorAll('#pal-list .pi .l')].map(e => e.textContent), cm: window.__cm.slice(), active: window.__canvas.activeId }; });
  };
  type N65Menu = Awaited<ReturnType<typeof rc>>;
  const close = async () => { await p.keyboard.press('Escape'); await sleep(100); };
  const pick = (l: string) => p.evaluate(l => [...document.querySelectorAll<HTMLElement>('#pal-list .pi')].find(x => x.querySelector('.l')!.textContent === l)?.click(), l);
  const ids = await p.evaluate(() => {
    const C = window.__canvas, S = C.S; window.__rcCam = { ...S.cam };
    window.__cm = []; window.addEventListener('contextmenu', e => window.__cm.push(e.defaultPrevented));   // bubble phase: after the board's capture listener
    const minX = Math.min(...Object.values<BoardNode>(S.nodes).filter(n => !n.in).map(n => n.x));
    const n = C.addNode({ kind: 'sketch', name: 'rc-card', x: minX - 3000, y: 0, w: 360, h: 220 });
    const f = C.addNode({ kind: 'frame', name: 'rc-folder', mode: 'free', shape: 'folder', x: minX - 2560, y: 0, w: 420, h: 300 });
    Object.assign(S.cam, { x: minX - 3450, y: -150, z: 1 }); C.applyCam(); (document.activeElement as HTMLElement | null)?.blur();   // clear of the folder tree on the left
    return { n: n.id, f: f.id };
  });
  await sleep(300);
  const pts = await p.evaluate(({ n, f }) => {
    const c = (r: DOMRect) => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    const card = document.querySelector(`.node[data-id="${n}"]`)!.getBoundingClientRect(), fr = document.querySelector(`.frame[data-id="${f}"]`)!.getBoundingClientRect();
    return { card: c(document.querySelector(`.node[data-id="${n}"] .hdr .name`)!.getBoundingClientRect()), folder: c(document.querySelector(`.frame[data-id="${f}"] .fname`)!.getBoundingClientRect()),
      bg: { x: Math.round(card.left + 20), y: Math.round(card.bottom + 120) }, inside: { x: Math.round(fr.left + 60), y: Math.round(fr.top + 80) } };
  }, ids);
  const r = {} as { card: N65Menu; folder: N65Menu; bg: N65Menu; inside: N65Menu; shift: N65Menu; input: N65Menu; made: { dx: number; dy: number } | null; armed: { kept: boolean; open: boolean; sel: string | null | undefined }; deleted: boolean };
  r.card = await rc(pts.card); await close();
  r.folder = await rc(pts.folder); await close();
  r.bg = await rc(pts.bg); await close();
  r.inside = await rc(pts.inside); await pick('New page here'); await sleep(700);
  r.made = await p.evaluate(({ f, inside }) => { const C = window.__canvas, k = C.kidsOf(f).find((k: BoardNode) => k.kind === 'buffer'), e = k && document.querySelector(`.node[data-id="${k.id}"]`)!.getBoundingClientRect();
    return k ? { dx: Math.round(e.left - inside.x), dy: Math.round(e.top - inside.y) } : null; }, { f: ids.f, inside: pts.inside });
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  r.shift = await rc(pts.bg, true);
  await p.evaluate(n => { const i = document.createElement('input'); i.id = 'rc-in'; i.style.cssText = 'position:relative;z-index:9'; window.__canvas.live[n].body.append(i); }, ids.n);
  const ip = await p.evaluate(() => { const b = document.getElementById('rc-in')!.getBoundingClientRect(); return { x: Math.round(b.left + 10), y: Math.round(b.top + b.height / 2) }; });
  r.input = await rc(ip);
  await rc(pts.card); await pick('Delete'); await sleep(200);   // the first pick only asks again
  r.armed = await p.evaluate(n => ({ kept: !!window.__canvas.S.nodes[n], open: !document.getElementById('palette')!.hidden,
    sel: document.querySelector('#pal-list .pi.sel .l')?.textContent }), ids.n);
  await pick('Delete: pick again to confirm'); await sleep(200);
  r.deleted = await p.evaluate(n => !window.__canvas.S.nodes[n], ids.n);
  await p.evaluate(({ f }) => { const C = window.__canvas; for (const k of C.kidsOf(f)) C.removeNode(k.id); C.removeNode(f); Object.assign(C.S.cam, window.__rcCam); C.applyCam(); }, ids);
  const has = (o: N65Menu, ...ls: string[]) => o.open && o.at && ls.every(l => o.labels.includes(l));
  const native = (o: N65Menu, before: number) => !o.open && o.cm.length === before + 1 && o.cm.at(-1) === false;
  check('N65: right-click opens the palette at the pointer: a card\'s actions with Delete, a folder\'s without its hidden buttons, New … here on the canvas and inside a folder (into it, at the pointer); Shift+right-click and a text field keep the native menu; Delete removes the card on its second pick',
    has(r.card, 'Delete', 'Tag…', 'Arrange: move and resize with the keys') && r.card.active === ids.n && Math.abs(r.card.x - pts.card.x) < 24 && Math.abs(r.card.y - pts.card.y) < 24
      && has(r.folder, 'Free', 'Workspace', 'Delete the folder (its items move up one level)') && !r.folder.labels.some(l => /unreachable|List this directory|click twice/.test(l)) && r.folder.active === ids.f
      && has(r.bg, 'New page here', 'New shell here', 'New folder here', 'Fit everything') && has(r.inside, 'New page here')
      && !!r.made && Math.abs(r.made.dx) <= 3 && Math.abs(r.made.dy) <= 3 && native(r.shift, 0) && native(r.input, 1) && r.armed.kept && r.armed.open && r.armed.sel === 'Delete: pick again to confirm' && r.deleted,
    JSON.stringify({ pts, ...r }));
}
// N66 (F-A34): closing the menu gives the keys back to the shell; the menu key follows the keys (the dock's terminal),
// not the selected card; a Shift-F10 the page did not get leaves the next right-click a mouse one; selected ink is hit by
// its box; where the menu would be empty the browser's stays; '.' in the graph with nothing selected opens nothing
{
  const st = () => p.evaluate(() => { const P = document.getElementById('palette')!, b = P.querySelector('.pal')!.getBoundingClientRect();
    return { open: !P.hidden, title: (document.getElementById('pal-in') as HTMLInputElement | null)!.placeholder, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), iw: innerWidth, ih: innerHeight,
      items: [...P.querySelectorAll<HTMLElement>('#pal-list .pi')].map(e => [e.querySelector('.l')!.textContent, e.querySelector('.s')!.textContent]), cm: window.__cm.slice() }; });
  type N66Menu = Awaited<ReturnType<typeof st>>;
  const ids = await p.evaluate(() => {
    const C = window.__canvas, S = C.S; window.__rcCam = { ...S.cam };
    const minX = Math.min(...Object.values<BoardNode>(S.nodes).filter(n => !n.in).map(n => n.x));
    const sh = C.addNode({ kind: 'term', backend: 'fake', name: 'rc-sh', env: {}, x: minX - 3000, y: 0, w: 440, h: 260 });
    const mk = (x: number, y: number) => ({ id: 'rcst' + x + '-' + y, color: 'ink', size: 4, sim: 0, owner: null, pts: [[x, y, .5], [x + 80, y + 10, .5], [x + 160, y, .5]] });
    S.strokes.push(mk(minX - 2400, 40), mk(minX - 2400, 80)); C.renderInk(null);
    Object.assign(S.cam, { x: minX - 3450, y: -150, z: 1 }); C.applyCam(); (document.activeElement as HTMLElement | null)?.blur();
    return { sh: sh.id, minX };
  });
  await sleep(500);
  const pts = await p.evaluate(id => { const C = window.__canvas, r = C.live[id].term.element.getBoundingClientRect(), c = C.live[id].el.getBoundingClientRect();
    return { term: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }, out: { x: Math.round(c.left + 40), y: Math.round(c.bottom + 80) } }; }, ids.sh);
  const keys = () => p.evaluate(id => document.activeElement === window.__canvas.live[id].term.textarea, ids.sh);
  const r = {} as { start: boolean; menu: N66Menu; esc: boolean; outside: { keys: boolean; open: boolean }; copy: boolean; dock: { active: boolean; x: number; y: number }; dockMenu: N66Menu; f10: N66Menu; ink: N66Menu & { n: number }; status: N66Menu & { native?: boolean } };
  await p.mouse.click(pts.term.x, pts.term.y); await sleep(150);
  r.start = await keys();
  await p.mouse.click(pts.term.x, pts.term.y, { button: 'right' }); await sleep(150);
  r.menu = await st();
  await p.keyboard.press('Escape'); await sleep(150); r.esc = await keys();
  await p.mouse.click(pts.term.x, pts.term.y, { button: 'right' }); await sleep(150);
  await p.mouse.click(pts.out.x, pts.out.y); await sleep(150); r.outside = { keys: await keys(), open: (await st()).open };
  await p.mouse.click(pts.term.x, pts.term.y, { button: 'right' }); await sleep(150);
  await p.evaluate(() => [...document.querySelectorAll<HTMLElement>('#pal-list .pi')].find(x => x.querySelector('.l')!.textContent === 'Copy')?.click()); await sleep(150);
  r.copy = await keys();
  // the menu key with the keys in the docked terminal while the canvas shell stays the selected card
  await p.evaluate(() => { const C = window.__canvas; if (!(document.body.classList.contains('side-open') && C.S.sideTab === 'term')) C.toggleDockTerm(); });
  await sleep(500);
  await p.evaluate(id => { const C = window.__canvas, d = C.live.dock.term; C.live[id].term.clearSelection(); d.write('dock text\r\n'); }, ids.sh); await sleep(150);
  r.dock = await p.evaluate(id => { const C = window.__canvas, d = C.live.dock.term; d.focus(); d.selectAll(); const b = d.element.getBoundingClientRect();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    document.activeElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return { active: C.activeId === id, x: Math.round(b.left), y: Math.round(b.top) }; }, ids.sh);
  r.dockMenu = await st();
  await p.keyboard.press('Escape'); await sleep(100);
  await p.evaluate(() => { const C = window.__canvas; if (document.body.classList.contains('side-open')) C.toggleDockTerm(); (document.activeElement as HTMLElement | null)?.blur(); });
  await sleep(400);
  // a Shift-F10 something took (as xterm does, for the program): the right-click after it is the mouse's
  await p.evaluate(() => { const d = document.createElement('div'); d.addEventListener('keydown', e => e.preventDefault()); document.body.append(d);
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); d.remove(); });
  const out2 = await p.evaluate(id => { const c = window.__canvas.live[id].el.getBoundingClientRect(); return { x: Math.round(c.left + 40), y: Math.round(c.bottom + 80) }; }, ids.sh);
  await p.mouse.click(out2.x, out2.y, { button: 'right' }); await sleep(150);
  r.f10 = await st();
  await p.keyboard.press('Escape'); await sleep(100);
  // selected ink: a right-click on it gives the selection's commands
  const ink = await p.evaluate(({ minX }) => { const C = window.__canvas; C.pickClear(); C.pickInRect({ x: minX - 2420, y: 20 }, { x: minX - 2220, y: 110 });
    const b = document.querySelector(`path.stroke[data-id="rcst${minX - 2400}-40"]`)!.getBoundingClientRect();
    return { n: C.SEL.strokes.size, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; }, ids);
  await p.mouse.click(ink.x, ink.y, { button: 'right' }); await sleep(150);
  r.ink = { n: ink.n, ...(await st()) };
  await p.keyboard.press('Escape'); await sleep(100);
  // the status line: nothing to offer, so the browser's menu
  const sp = await p.evaluate(() => { const b = document.getElementById('status')!.getBoundingClientRect(); return { x: Math.round(b.right - 6), y: Math.round(b.top + b.height / 2) }; });
  const cm0 = (await st()).cm.length;
  await p.mouse.click(sp.x, sp.y, { button: 'right' }); await sleep(150);
  r.status = await st(); r.status.native = r.status.cm.length === cm0 + 1 && r.status.cm.at(-1) === false;
  await p.evaluate(({ sh }) => { const C = window.__canvas; C.pickClear(); C.S.strokes = C.S.strokes.filter((s: Stroke) => !s.id.startsWith('rcst')); C.renderInk(null);
    C.removeNode(sh); Object.assign(C.S.cam, window.__rcCam); C.applyCam(); }, ids);
  const pal = (o: N66Menu) => o.items.map(x => x[0]), clampTo = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
  check('N66: closing the right-click menu (Esc, a press outside, Copy) gives the keys back to the shell; the menu key in the dock is the dock\'s Terminal menu at the dock, not the selected card\'s; a Shift-F10 the page did not get leaves the next right-click at the pointer; a right-click on selected ink gives the Selection menu; the status line keeps the browser\'s menu',
    r.start && r.menu.open && r.menu.title === 'Actions of rc-sh' && r.esc && r.outside.keys && !r.outside.open && r.copy
      && r.dock.active && r.dockMenu.open && r.dockMenu.title === 'Terminal' && r.dockMenu.items.some(([l, s]) => l === 'Copy' && s === '') && Math.abs(r.dockMenu.x - clampTo(r.dock.x + 14, 16, r.dockMenu.iw - r.dockMenu.w - 16)) < 4 && Math.abs(r.dockMenu.y - clampTo(r.dock.y + 14, 16, r.dockMenu.ih - r.dockMenu.h - 16)) < 4
      && r.f10.open && r.f10.title === 'Canvas' && pal(r.f10).includes('New page here') && Math.abs(r.f10.x - out2.x) < 24 && Math.abs(r.f10.y - out2.y) < 24
      && r.ink.n === 2 && r.ink.open && r.ink.title === 'Selection' && !r.status.open && r.status.native,
    JSON.stringify(r));
}
await p.evaluate(() => (document.activeElement as HTMLElement | null)!.blur());
await p.evaluate(() => { const C = window.__canvas; const f = C.wsTop()[0]; C.wsEnter(f, true); });
await p.keyboard.press('Control+Space'); await sleep(120); await p.keyboard.press('u'); await sleep(700);
check('leader u leaves the workspace', await p.evaluate(() => !window.__canvas.WS.cur && !document.body.classList.contains('in-ws')));
// neighbours
v10 = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const minX = Math.min(...Object.values<BoardNode>(S.nodes).filter(n => !n.in).map(n => n.x));   // two cards left of everything, on one row
  const a = C.addNode({ kind: 'page', name: 'nb-a', x: minX - 1200, y: 100, w: 200, h: 120 }), b = C.addNode({ kind: 'page', name: 'nb-b', x: minX - 900, y: 100, w: 200, h: 120 });
  const r = C.neighbour(a, 'l'); const l = C.neighbour(a, 'h');
  return { right: r ? r.id === b.id : false, leftNone: !l };
});
// middle-drag and Alt-drag over a terminal body pan; the middle button does not paste
await p.evaluate(() => { const C = window.__canvas, S = C.S; const t = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'term'); C.jumpNode(t, 1); });
await sleep(700);
let mid = await p.evaluate(() => { const C = window.__canvas, S = C.S; const t = Object.values<BoardNode>(S.nodes).find(n => n.kind === 'term')!; const el = document.querySelector(`.node[data-id="${t.id}"] .body`)!; const r = el.getBoundingClientRect(); window.__pastes = 0; document.addEventListener('paste', () => window.__pastes++); return { x: r.left + r.width / 2, y: r.top + r.height / 2, cx: C.S.cam.x }; });
await p.mouse.move(mid.x, mid.y); await p.mouse.down({ button: 'middle' }); await p.mouse.move(mid.x - 120, mid.y, { steps: 4 }); await p.mouse.up({ button: 'middle' }); await sleep(200);
let mid2: any = await p.evaluate(() => ({ cx: window.__canvas.S.cam.x, pastes: window.__pastes, panning: document.querySelector('#viewport')!.classList.contains('panning') }));   // any: reused by two checks with different result shapes
check('middle-drag over a terminal body pans and does not paste', Math.abs(mid2.cx - mid.cx) > 50 && mid2.pastes === 0 && !mid2.panning, JSON.stringify({ mid, mid2 }));
const cx0 = await p.evaluate(() => window.__canvas.S.cam.x);
await p.keyboard.down('Alt'); await p.mouse.move(mid.x, mid.y); await p.mouse.down(); await p.mouse.move(mid.x + 90, mid.y + 30, { steps: 4 }); await p.mouse.up(); await p.keyboard.up('Alt'); await sleep(200);
mid2 = await p.evaluate(a => ({ cx0: a, cx: window.__canvas.S.cam.x, z: window.__canvas.S.cam.z, moved: a - window.__canvas.S.cam.x }), cx0);
check('Alt-drag over a terminal body pans', mid2.moved > 60 / mid2.z && mid2.moved < 120 / mid2.z, JSON.stringify(mid2));
// nested folder: the parent's mode buttons stay reachable when the child's tab overlaps them
let nest: any = await p.evaluate(() => {   // any: the folders' ids, then the measured points
  const C = window.__canvas, S = C.S;
  const outer = Object.values<BoardNode>(S.nodes).find(n => n.name === 'canvas-workbench') as FrameNode, inner = Object.values<BoardNode>(S.nodes).find(n => n.name === 'machines') as FrameNode;
  C.setMode(outer, 'free', true);
  outer.w = Math.max(outer.w, 1100); C.placeAny(outer);   // a folder under 250 screen px drops its tab buttons, so keep the parent wide at the test's zoom
  // put the child folder right under the parent's tab row, as pack/tile/ribbon do (PAD + LABEL_H), and zoom out so the child's screen-size tab pokes into the parent's row
  const dx = (outer.x + 28 + 200) - inner.x, dy = (outer.y + 28 + 32) - inner.y;
  const moved = [inner, ...Object.values<BoardNode>(S.nodes).filter(n => n.in === inner.id)]; for (const m of moved) { m.x += dx; m.y += dy; C.placeAny(m); }
  C.separateAll(); // clears loose nodes off the parent's tab row; the child stays (siblings only)
  C.jumpNode(outer, 0.4);
  return { outer: outer.id, inner: inner.id };
});
await sleep(900);
nest = await p.evaluate(a => {
  const q = (id: string) => `.frame[data-id="${id}"]`;
  document.querySelector(q(a.outer))!.classList.remove('active'); document.querySelector(q(a.inner))!.classList.add('active'); // the reported state: the child is the active folder
  const btn = document.querySelector(q(a.outer) + ' > .flabel .fmodes button[data-m="pack"]')!; const b = btn.getBoundingClientRect();
  const under = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  const tab = document.querySelector(q(a.outer) + ' > .flabel .ftab')!.getBoundingClientRect();
  const innerTab = document.querySelector(q(a.inner) + ' > .flabel .ftab')!.getBoundingClientRect();
  const overlap = innerTab.left < b.right && b.left < innerTab.right && innerTab.top < b.bottom && b.top < innerTab.bottom;
  const C = window.__canvas, S = C.S, sc = Object.values<BoardNode>(S.nodes).find(n => n.name === 'scratch'), ou = S.nodes[a.outer];
  return { ...a, bx: b.left + b.width / 2, by: b.top + b.height / 2, tx: tab.left + 10, ty: tab.top + tab.height / 2, overlap, underBefore: under?.closest<HTMLElement>('.frame')?.dataset.id, z: S.cam.z };
}, nest);
await p.mouse.move(nest.tx, nest.ty); await sleep(150); await p.mouse.move(nest.bx, nest.by); await sleep(150);
const nestHover = await p.evaluate(a => document.elementFromPoint(a.bx, a.by)?.closest<HTMLElement>('.frame')?.dataset.id, nest);
check('hovering the parent tab raises its buttons above the nested tab', (!nest.overlap || nest.underBefore !== nest.outer) && nestHover === nest.outer, JSON.stringify({ nest, nestHover }));
await p.mouse.click(nest.bx, nest.by); await sleep(300);
check('the raised button works (parent switched to pack)', await p.evaluate(a => window.__canvas.S.nodes[a.outer].mode === 'pack', nest));
await p.evaluate(a => window.__canvas.setMode(window.__canvas.S.nodes[a.outer], 'free', true), nest);
// packages: Tab folds the active folder to its tab, Tab unfolds; Shift-Tab folds the others on the level
let pk = await p.evaluate(() => { const C = window.__canvas, S = C.S; const f = Object.values<BoardNode>(S.nodes).find(n => n.name === 'scratch') as FrameNode; if (f.mode === 'stack') C.setMode(f, 'free', true); C.jumpNode(f, 0.6); return { id: f.id, mode: f.mode || 'free', w: f.w, h: f.h }; });
await sleep(800); await p.keyboard.press('Tab'); await sleep(300);
let pk2: any = await p.evaluate(a => { const f = window.__canvas.S.nodes[a.id]; const el = document.querySelector(`.frame[data-id="${a.id}"]`)!; return { mode: f.mode, packed: !!f.packed, h: f.h, cls: el.classList.contains('packed'), deckHidden: el.querySelector<HTMLElement>('.deck')!.hidden, tree: [...document.querySelectorAll('#tp-list .tp-row')].some(r => r.textContent.includes('package of')) }; }, pk);   // any: reused by each check for its own result shape
check('Tab folds the active folder into a package', pk2.mode === 'stack' && pk2.packed && pk2.h <= 12 && pk2.cls && pk2.deckHidden && pk2.tree, JSON.stringify(pk2));
await p.keyboard.press('Tab'); await sleep(500);
pk2 = await p.evaluate(a => { const f = window.__canvas.S.nodes[a.id]; return { mode: f.mode || 'free', packed: !!f.packed, w: f.w, h: f.h }; }, pk);
check('Tab again unfolds to the previous mode and size', pk2.mode === pk.mode && !pk2.packed && pk2.w === pk.w && pk2.h === pk.h, JSON.stringify({ pk, pk2 }));
await p.keyboard.press('Shift+Tab'); await sleep(400);
pk2 = await p.evaluate(a => { const C = window.__canvas, S = C.S; const top = Object.values<BoardNode>(S.nodes).filter((n): n is FrameNode => n.kind === 'frame' && !n.in); return { me: S.nodes[a.id].mode || 'free', othersPacked: top.filter(f => f.id !== a.id).every(f => f.mode === 'stack' && f.packed), n: top.length }; }, pk);
check('Shift-Tab packages the other top-level folders and keeps the active one open', pk2.me !== 'stack' && pk2.othersPacked && pk2.n >= 3, JSON.stringify(pk2));
await p.keyboard.press('Shift+Tab'); await sleep(400);
pk2 = await p.evaluate(() => { const S = window.__canvas.S; return Object.values<BoardNode>(S.nodes).filter((n): n is FrameNode => n.kind === 'frame' && !n.in).every(f => f.mode !== 'stack'); });
check('Shift-Tab again unfolds them all', pk2);
// boundaries: a folder dropped onto another inside a free folder pushes it aside, tab included; unfolding pushes neighbours
let sep: any = await p.evaluate(() => {   // any: reused by each check for its own result shape
  const C = window.__canvas, S = C.S;
  const outer = Object.values<BoardNode>(S.nodes).find(n => n.name === 'canvas-workbench') as FrameNode, inner = Object.values<BoardNode>(S.nodes).find(n => n.name === 'machines') as FrameNode, lab = Object.values<BoardNode>(S.nodes).find(n => n.name === 'homelab') as FrameNode;
  C.setMode(outer, 'free', true); if (lab.mode === 'stack') C.setMode(lab, 'free', true); C.jumpNode(outer, 0.5);
  // drop homelab exactly onto machines
  C.adopt(lab, outer, { x: inner.x + 40, y: inner.y + 40 });
  const dx = inner.x + 30 - lab.x, dy = inner.y + 30 - lab.y; for (const m of [lab, ...Object.values<BoardNode>(S.nodes).filter(n => n.in === lab.id)]) { m.x += dx; m.y += dy; }
  C.adopt(lab, outer, { x: lab.x + 10, y: lab.y + 10 });
  const ov = (A: BoardPoint & BoardSize, B: BoardPoint & BoardSize) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  const A = C.footprint(inner), B = C.footprint(lab);
  const kids = C.kidsOf(outer.id);
  const inside = kids.every((k: BoardNode) => k.x >= outer.x && k.x + k.w <= outer.x + outer.w && k.y + k.h <= outer.y + outer.h);
  let pairs = 0; for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (ov(C.footprint(kids[i]), C.footprint(kids[j]))) pairs++;
  return { overlap: ov(A, B), pairs, inside, labIn: lab.in === outer.id, n: kids.length };
});
check('a folder dropped onto another is pushed aside (tabs included) and the parent grows', !sep.overlap && sep.pairs === 0 && sep.inside && sep.labIn && sep.n >= 4, JSON.stringify(sep));
sep = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const lab = Object.values<BoardNode>(S.nodes).find(n => n.name === 'homelab') as FrameNode, outer = S.nodes[lab.in!];
  C.packFold(lab); // package it, then park a page right under the package where the open folder will be
  const page = C.kidsOf(outer.id).find((k: BoardNode) => k.kind === 'buffer'); const px = page.x, py = page.y;
  page.x = lab.x + 20; page.y = lab.y + 60; C.adopt(page, outer, { x: page.x + 5, y: page.y + 5 });
  C.unfold(lab);
  const ov = (A: BoardPoint & BoardSize, B: BoardPoint & BoardSize) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  return { overlap: ov(C.footprint(lab), C.footprint(page)), mode: lab.mode || 'free', moved: page.x !== lab.x + 20 || page.y !== lab.y + 60 };
});
check('unfolding a package pushes what sat in its place', !sep.overlap && sep.mode !== 'stack', JSON.stringify(sep));
sep = await p.evaluate(() => { const C = window.__canvas; C.CMDS.find((c: PaletteItem) => c.l.startsWith('Layout: keep a boundary')).run(); const off = C.S.noOverlap === false; C.CMDS.find((c: PaletteItem) => c.l.startsWith('Layout: keep a boundary')).run(); return { off, on: C.S.noOverlap !== false }; });
// a real mouse drag of a folder tab onto another folder: it lands inside, and nothing overlaps at any level afterwards
const noOverlapAnywhere = () => p.evaluate(() => {
  const C = window.__canvas, S = C.S; const ov = (A: BoardPoint & BoardSize, B: BoardPoint & BoardSize) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  const levels = [null, ...Object.values<BoardNode>(S.nodes).filter((n): n is FrameNode => n.kind === 'frame' && (n.mode || 'free') === 'free' && !C.stashed(n))];
  const bad = [];
  for (const f of levels) { const items = Object.values<BoardNode>(S.nodes).filter(n => (n.in || null) === (f ? f.id : null) && !C.stashed(n)); for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (ov(C.footprint(items[i]), C.footprint(items[j]))) bad.push((f ? f.name : '/') + ': ' + items[i].name + ' × ' + items[j].name); }
  return bad;
});
let dr: any = await p.evaluate(() => {   // any: the folders' ids, then the measured points, then a count
  const C = window.__canvas, S = C.S; const outer = Object.values<BoardNode>(S.nodes).find(n => n.name === 'canvas-workbench') as FrameNode, inner = Object.values<BoardNode>(S.nodes).find(n => n.name === 'machines') as FrameNode, lab = Object.values<BoardNode>(S.nodes).find(n => n.name === 'homelab') as FrameNode;
  C.setMode(outer, 'free', true); if (lab.mode === 'stack') C.setMode(lab, 'free', true); C.adopt(lab, null, null, true); C.moveTree(lab, outer.x - lab.w - 300 - lab.x, inner.y - lab.y); C.separateAll(); C.jumpNode(lab, 0.3);
  return { lab: lab.id, inner: inner.id };
});
await sleep(900);
const bad0 = await noOverlapAnywhere();
dr = await p.evaluate(a => { const r = document.querySelector(`.frame[data-id="${a.lab}"] > .flabel .ftab`)!.getBoundingClientRect(); const t = document.querySelector(`.frame[data-id="${a.inner}"]`)!.getBoundingClientRect(); return { ...a, sx: r.left + r.width / 2, sy: r.top + r.height / 2, tx: t.left + t.width * .6, ty: t.top + t.height * .6 }; }, dr);
await p.mouse.move(dr.sx, dr.sy); await p.mouse.down(); await p.mouse.move(dr.sx + 20, dr.sy + 20, { steps: 3 }); await p.mouse.move(dr.tx, dr.ty, { steps: 8 }); await p.mouse.up(); await sleep(400);
let bad = await noOverlapAnywhere();
const where = await p.evaluate(a => window.__canvas.S.nodes[a.lab].in && window.__canvas.S.nodes[window.__canvas.S.nodes[a.lab].in].name, dr);
check('dragging a folder tab onto another folder: it lands inside and nothing overlaps on any level', bad.length === 0 && where === 'machines', JSON.stringify({ bad0, bad, where: where || null, dr }));
// a board saved with overlaps gets cleaned on load
dr = await p.evaluate(() => { const C = window.__canvas, S = C.S; const a = Object.values<BoardNode>(S.nodes).filter(n => !n.in && n.kind !== 'frame')[0], f = Object.values<BoardNode>(S.nodes).find((n): n is FrameNode => n.kind === 'frame' && !n.in)!; C.SEP.off++; C.moveTree(a, f.x + 10 - a.x, f.y + 10 - a.y); C.SEP.off--; return C.separateAll(); });
bad = await noOverlapAnywhere();
check('separateAll cleans an overlapping board', dr > 0 && bad.length === 0, JSON.stringify({ dr, bad }));
check('boundary toggle in the palette', sep.off && sep.on, JSON.stringify(sep));
check('i3 neighbour picks the node to the right, none to the left of the leftmost', v10.right && v10.leftNone, JSON.stringify(v10));
// ---- cascading folder modes and the process perspective (demo mode)
st = await p.evaluate(() => { const C = window.__canvas, S = C.S, f = S.nodes.fCW, inner = S.nodes.fMach;
  C.setModeCascade(f, 'tile'); const a = [f.mode, inner.mode];
  document.querySelector('.frame[data-id="fCW"] .fmodes button[data-m="pack"]')!.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })); const b = [f.mode, inner.mode];
  C.setMode(f, 'free'); const c = [f.mode, inner.mode];
  C.setModeCascade(f, 'free'); const d = [f.mode, inner.mode];
  return { a, b, c, d }; });
check('cascade applies a mode to the nested folders too (call, Shift-click); a plain click does not', st.a.join() === 'tile,tile' && st.b.join() === 'pack,pack' && st.c.join() === 'free,pack' && st.d.join() === 'free,free', JSON.stringify(st));
st = await p.evaluate(() => { const C = window.__canvas, S = C.S; const kid = C.spawnChild(S.nodes.labsh).id; const frames = Object.values<BoardNode>(S.nodes).filter(n => n.kind === 'frame').map((f): [string, string | null, FrameMode] => [f.id, f.in || null, f.mode]); const snapIn = Object.fromEntries(Object.values<BoardNode>(S.nodes).map(n => [n.id, n.in || null])); const pos = Object.fromEntries(Object.values<BoardNode>(S.nodes).map(n => [n.id, [n.x, n.y, n.w, n.h]]));
  C.perspSet('process');
  const derived = Object.values<BoardNode>(S.nodes).filter(n => n.kind === 'frame').map(f => ({ owner: f.owner, derived: f.derived, kids: C.kidsOf(f.id).map((k: BoardNode) => k.id).sort().join() }));
  const manualGone = frames.every(([id]) => !S.nodes[id]), dim = document.querySelectorAll('.node.persp-dim').length, chip = !!document.querySelector('#persp-chip'), persp = S.persp;
  const refused = (() => { const build = S.nodes.build, pf = Object.values<FrameNode>(S.nodes).find(f => f.owner === 'labsh')!; C.adopt(build, pf, null, true); return build.in !== pf.id; })();
  C.perspSet('manual');
  const back = frames.every(([id, inn, mode]) => S.nodes[id] && (S.nodes[id].in || null) === inn && S.nodes[id].mode === mode), inOk = Object.values<BoardNode>(S.nodes).every(n => (n.in || null) === snapIn[n.id]), posOk = Object.values<BoardNode>(S.nodes).every(n => JSON.stringify([n.x, n.y, n.w, n.h]) === JSON.stringify(pos[n.id])), noDerived = !Object.values<FrameNode>(S.nodes).some(n => n.derived) && !document.querySelector('#persp-chip') && !S.manual;
  C.removeNode(kid);
  return { derived, manualGone, dim, chip, persp, refused, back, inOk, posOk, noDerived, kid }; });
check('process perspective derives a folder per spawning shell, nested as the spawn tree', st.persp === 'process' && st.manualGone && st.chip && st.dim > 0 && st.derived.some((d: { owner?: string; derived?: string; kids: string }) => d.owner === 'ops' && d.derived === 'process' && d.kids === 'build,logs,ops') && st.derived.some((d: { owner?: string; derived?: string; kids: string }) => d.owner === 'labsh' && d.kids === ['labsh', st.kid].sort().join()), JSON.stringify(st));
check('a drop into a derived folder is refused; back to manual restores folders, membership and positions exactly', st.refused && st.back && st.inOk && st.posOk && st.noDerived, JSON.stringify(st));
// ---- the filesystem perspective (demo mode, seed filesystem)
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = (ms: number) => new Promise(r => setTimeout(r, ms));
  C.perspSet('fs');
  const frames = () => Object.values<BoardNode>(S.nodes).filter((n): n is FrameNode => n.kind === 'frame' && n.derived === 'fs').map(f => [f.fsPath, f.in ? S.nodes[f.in].fsPath : null, C.kidsOf(f.id).map((k: BoardNode) => k.name).sort().join()]);
  const a = frames(), home = Object.values<FrameNode>(S.nodes).find(f => f.derived === 'fs' && f.fsPath === '/home/me');
  const listed = await C.fsExpand(home), listedAgain = await C.fsExpand(home);
  const ghosts = Object.values<BoardNode>(S.nodes).filter(n => n.kind === 'ghost').map(g => g.name + (g.dir ? '/' : '') + (g.link ? '→' + g.link : '')).sort();
  const edges0 = C.PERSP.edges.length;
  C.ghostOpen(Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === 'projects')); await sl(50);
  C.ghostOpen(Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === 'canvas')); await sl(50);
  const edges = C.PERSP.edges.map((e: Edge) => S.nodes[e.from]?.name + '>' + S.nodes[e.to]?.fsPath), proj = Object.values<FrameNode>(S.nodes).find(f => f.derived === 'fs' && f.fsPath === '/home/me/projects');
  const sh = Object.values<BoardNode>(S.nodes).find((n): n is TermNode => n.kind === 'term' && n.backend !== 'pty' && S.nodes[n.in!]?.fsPath === '/home/me')!; C.adopt(sh, proj, null, true); const shIn = S.nodes[sh.in!]?.fsPath, cwd = sh.cwd;
  C.adopt(Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === 'todo.txt'), proj, null, true);
  return { a, listed, listedAgain, ghosts, edges0, edges, shIn, cwd, asked: !document.querySelector<HTMLElement>('#ask')!.hidden && document.querySelector('#ask-label')!.textContent }; });
check('filesystem perspective: directory folders nested by path, shells in their cwd', st.a.some(([pth, inn, kids]: [string, string | null, string]) => pth === '/home/me' && inn === null && kids.includes('sh')) && st.a.some(([pth, inn, kids]: [string, string | null, string]) => pth === '/home/me/projects/canvas' && inn === '/home/me/projects' && kids === 'build,ops'), JSON.stringify(st.a));
check('listing a directory makes ghost cards once; a symlink ghost gets a dashed edge when its target is on the board', st.listed === 3 && st.listedAgain === 0 && st.ghosts.join() === 'canvas-readme.md,notes/→/home/me/projects/canvas,todo.txt' && st.edges0 === 1 && st.edges.join() === 'notes>/home/me/projects/canvas', JSON.stringify(st));
check('dropping a shell into a directory is cd; dropping a file asks before mv', st.shIn === '/home/me/projects' && st.cwd === '/home/me/projects' && String(st.asked).startsWith('Move /home/me/todo.txt into /home/me/projects?'), JSON.stringify(st));
await p.fill('#ask-in', 'yes'); await p.keyboard.press('Enter'); await sleep(300);
st = await p.evaluate(() => { const C = window.__canvas, S = C.S; const gf = Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === 'todo.txt')!; const moved = !!S.fs.c.home.c.me.c.projects.c['todo.txt'] && !S.fs.c.home.c.me.c['todo.txt'] && gf.path === '/home/me/projects/todo.txt' && S.nodes[gf.in!].fsPath === '/home/me/projects';
  const page = C.ghostOpen(gf), pageIn = S.nodes[page.in]?.fsPath, text = page.text, ghostGone = !Object.values<BoardNode>(S.nodes).some(n => n.kind === 'ghost' && n.name === 'todo.txt');
  C.perspSet('manual'); const clean = !Object.values<FrameNode | GhostNode>(S.nodes).some(n => n.kind === 'ghost' || n.derived) && !C.PERSP.edges.length && !document.querySelector('.node.k-ghost'); C.removeNode(page.id); return { moved, pageIn, text, ghostGone, clean }; });
check('mv after the confirm; opening a ghost file makes it real in place; back to manual clears ghosts and derived folders', st.moved && st.pageIn === '/home/me/projects' && st.text.startsWith('buy pens') && st.ghostGone && st.clean, JSON.stringify(st));
// ---- addresses, one navigator over every relation, the hash, the tag perspective
st = await p.evaluate(async ({ y, ym }) => { const C = window.__canvas, S = C.S; await C.notesLoad(true);
  const addrs = ['fCW', 'fMach', 'build'].map(id => C.addrOf(S.nodes[id]));
  const res = Object.fromEntries(['board:/canvas-workbench/machines', 'fs:~', 'tag:agent', 'note:hosts', 'journal:' + ym, 'link:hosts', 'proc:@x/1', 'bogus'].map(a => { const r = C.resolveAddr(a); return [a, r.error ? 'ERR' : r.key + '|' + r.addr + '|' + r.entries.length]; }));
  const root = C.rgEntries('root').map((e: RgEntry) => e.name), tags = C.rgEntries('tag:').map((e: RgEntry) => e.name + ':' + e.meta), agent = C.rgEntries('tag:agent').map((e: RgEntry) => e.name);
  const notes = C.rgEntries('note:').map((e: RgEntry) => e.name + ':' + e.meta), plans = C.rgEntries(C.addrToKey('note:plans')).map((e: RgEntry) => e.kind + ':' + e.name.trim());
  const journal = [C.rgEntries('journal:').map((e: RgEntry) => e.name).join(), C.rgEntries('journal:' + y).map((e: RgEntry) => e.name).join(), C.rgEntries('journal:' + ym).map((e: RgEntry) => e.name).join()];
  const links = C.rgEntries('link:').map((e: RgEntry) => e.name + ':' + e.meta), lh = C.rgEntries('link:hosts').map((e: RgEntry) => e.name + ':' + e.kind);
  C.goAddr('tag:agent'); const v1 = C.RG.dir + ' ' + location.hash;
  C.setView('canvas'); C.goAddr('board:/canvas-workbench/machines'); const v2 = location.hash + ' ' + document.body.dataset.view;
  const ls = await C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'list_addr').run({ addr: 'journal:' + ym });
  const cd = await C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'cd_shell').run({ addr: 'fs:/home/me/projects', shell: 'sh' });
  return { addrs, res, root, tags, agent, notes, plans, journal, links, lh, v1, v2, ls, cd }; }, { y: Y, ym: YM.replace('-', '/') });
check('addresses: board paths; resolve finds folders, files, tags, notes, journal days and links; reserved and bogus refused', st.addrs.join() === 'board:/canvas-workbench,board:/canvas-workbench/machines,board:/canvas-workbench/machines/build' && st.res['board:/canvas-workbench/machines'].startsWith('fMach|') && +st.res['fs:~'].split('|')[2] >= 2 && st.res['tag:agent'] === 'tag:agent|tag:agent|1' && st.res['note:hosts'].startsWith('note:hosts|note:hosts|') && st.res['journal:' + YM.replace('-', '/')].endsWith('|1') && st.res['link:hosts'].endsWith('|1') && st.res['proc:@x/1'] === 'ERR' && st.res['bogus'] === 'ERR', JSON.stringify(st.res));
check('navigator root lists every relation; tag, note, journal and link trees list', st.root.slice(-7).join() === '# tags,¶ notes,▦ journal,⇄ links,⚙ processes,⊙ units,! attention' && st.tags.join() === '#agent:1' && st.agent.join() === 'claude' && st.notes.some((x: string) => x.startsWith('plans:')) && st.plans.length > 0 && st.plans.every((x: string) => x.startsWith('iblock:')) && st.journal.join('|') === `${Y}|${YM}|${DAY}` && st.links.some((x: string) => x.startsWith('hosts:')) && st.lh.join() === 'pi:ghost', JSON.stringify(st));
check('goAddr opens the navigator or the canvas and writes the hash; wb-style ls and cd work', st.v1 === 'tag:agent #tag:agent' && st.v2 === '#board:/canvas-workbench/machines canvas' && st.ls.includes('journal:' + DAYP) && st.cd === 'sh: cd /home/me/projects', JSON.stringify({ v1: st.v1, v2: st.v2, ls: st.ls, cd: st.cd }));
st = await p.evaluate(() => { const C = window.__canvas, cd = C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'cd_shell'), H = { name: 'cdhost', url: 'https://cdhost.invalid' };
  C.HOSTLIST.push(H); const sh = C.addNode({ kind: 'term', backend: 'fake', name: 'cdsh', env: {}, hostUrl: H.url, x: 14000, y: 14400, w: 300, h: 200 });   // runs on cdhost, in no host folder
  const run = (addr: string) => { try { return cd.run({ addr, shell: 'cdsh' }); } catch (e) { return 'ERR ' + e.message; } };
  const r = { there: run('fs:@cdhost/srv'), here: run('fs:/srv') };
  C.HOSTLIST.splice(C.HOSTLIST.indexOf(H), 1); C.removeNode(sh.id); return r; });
check('cd_shell: a shell on another host by its hostUrl (outside that host\'s folder) takes cd to that host\'s fs: address and refuses a local one', /: cd \/srv$/.test(st.there) && /another host/.test(st.here), JSON.stringify(st));
// The cd_shell check changed the active card; establish this check's own two history entries.
await p.evaluate(async () => { const C = window.__canvas; C.goAddr('tag:agent'); C.goAddr('board:/canvas-workbench/machines'); await new Promise(r => setTimeout(r, 0)); });
await p.goBack();
await p.waitForFunction(() => location.hash === '#tag:agent' && window.__canvas.RG.dir === 'tag:agent' && document.body.dataset.view === 'ranger');
st = await p.evaluate(() => [location.hash, window.__canvas.RG.dir, document.body.dataset.view || null]);
check('browser back returns to the previous address', st[0] === '#tag:agent' && st[1] === 'tag:agent', JSON.stringify(st));
st = await p.evaluate(() => { const C = window.__canvas, S = C.S; C.setView('canvas'); C.perspSet('tag'); const fr = () => Object.values<FrameNode>(S.nodes).filter(n => n.derived === 'tag').map(f => [f.tag, f.in ? S.nodes[f.in].tag : null, C.kidsOf(f.id).map((k: BoardNode & { alias?: string }) => k.name + (k.alias ? '*' : '')).sort().join()]);
  const a = fr(); const n = S.nodes.build; C.setTags(n, ['grc/vocab', 'agent']); C.perspRebuild(); const b = fr();
  const copy = Object.values<BoardNode>(S.nodes).find((x): x is GhostNode => x.kind === 'ghost' && x.alias === 'build'), copyAddr = C.addrOf(copy), buildAddr = C.addrOf(n);
  const agentF = Object.values<FrameNode>(S.nodes).find(f => f.derived === 'tag' && f.tag === 'agent'), sh = Object.values<BoardNode>(S.nodes).find(x => x.name === 'sh' && x.kind === 'term'); C.adopt(sh, agentF, null, true); const shTags = C.tagsOf(sh);
  C.perspSet('manual'); const clean = !Object.values<FrameNode>(S.nodes).some(x => x.derived || (x as BoardNode).kind === 'ghost'); C.setTags(n, ['grc/vocab', 'agent'], { remove: true }); C.setTags(sh, ['agent'], { remove: true });
  return { a, b, copyAddr, buildAddr, shTags, clean }; });
check('tag perspective: one folder per tag nested by /, the node under its first tag, a copy under the others; drop into a tag folder tags; back to manual is clean', st.a.length === 1 && st.a[0][0] === 'agent' && st.b.some(([t, inn, k]: [string, string | null, string]) => t === 'grc/vocab' && inn === 'grc' && k === 'build') && st.b.some(([t, , k]: [string, string | null, string]) => t === 'agent' && k === 'build*,claude') && st.copyAddr === 'board:/canvas-workbench/machines/build' && st.buildAddr === st.copyAddr && st.shTags.includes('agent') && st.clean, JSON.stringify(st));
// ---- the host's own trees (seeded), the status line, the Attention query, hard links and mounts
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = (ms: number) => new Promise(r => setTimeout(r, ms));
  const roots = C.rgEntries('proc:').map((e: RgEntry) => e.name), kids = C.rgEntries('proc:800').map((e: RgEntry) => [e.name, !!e.n, e.meta]);
  const units = C.rgEntries('unit:').map((e: RgEntry) => e.name), uprocs = C.rgEntries('unit:caddy.service').map((e: RgEntry) => e.name);
  const r1 = C.resolveAddr('proc:/800'), r2 = C.resolveAddr('unit:/postgresql.service'), k = C.addrToKey('proc:@nohost/1'), parent = C.rgParent('proc:1000'), ulabel = C.keyToAddr('unit:caddy.service');
  C.perspSet('proc', true); await sl(100);
  const pf = Object.values<BoardNode>(S.nodes).filter((f): f is FrameNode => f.kind === 'frame' && f.derived === 'proc').map(f => [f.name, C.kidsOf(f.id).map((x: BoardNode) => x.kind + ':' + x.name.replace(/^[· ]+/, '')).join('|')]);
  const dimmed = Object.values<BoardNode>(S.nodes).filter((n): n is PageNode => n.kind === 'buffer' && C.live[n.id]?.el.classList.contains('persp-dim')).length;
  C.perspSet('unit', true); await sl(100);
  const uf = Object.values<BoardNode>(S.nodes).filter((f): f is FrameNode => f.kind === 'frame' && f.derived === 'unit').map(f => [f.name, C.tagsOf(f).join(), C.kidsOf(f.id).length, C.kidsOf(f.id).filter((x: BoardNode) => x.kind === 'ghost' && x.unitState === 'failed').map((x: BoardNode) => x.name).join()]);
  const failedGhost = Object.values<BoardNode>(S.nodes).find((x): x is GhostNode => x.kind === 'ghost' && x.unitState === 'failed'), gaddr = failedGhost && C.addrOf(failedGhost);
  C.perspSet('manual', true);
  C.statusRender(); const stc = [...document.querySelectorAll('#st-host .stc')].map(b => b.textContent + (b.classList.contains('bad') ? '!' : ''));
  const attn = C.rgEntries('attn:').map((e: RgEntry) => e.name), wbls = (await C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'list_addr').run({ addr: 'attn:' })).split('\n');
  return { roots, kids, units, uprocs, r1: r1.error || r1.addr, r2: r2.error || r2.addr, k, parent, ulabel, pf, dimmed, uf, gaddr, stc, attn, wbls }; });
check('proc: and unit: in the navigator: process tree with the card marked, units failed first with their processes; addresses resolve', st.roots.includes('systemd 1') && st.kids.some(([n, hasN, m]: [string, boolean, string]) => n === 'bash 1000' && hasN && /card /.test(m)) && st.units[0] === '✗ postgresql.service' && st.uprocs.join() === 'caddy 611' && st.r1 === 'proc:/800' && st.r2 === 'unit:/postgresql.service' && st.k === null && st.parent === 'proc:800' && st.ulabel === 'unit:/caddy.service', JSON.stringify(st));
check('processes perspective: each shell in a folder with its OS processes as ghosts; units perspective: a folder per host with unit ghosts, shells under their unit', st.pf.some(([n, k]: [string, string]) => k.startsWith('term:') && /ghost:node 1002\|ghost:chromium 1003/.test(k)) && st.pf.length >= 3 && st.dimmed > 0 && st.uf.some(([n, t, c, f]: [string, string, number, string]) => n === 'units' && f === 'postgresql.service' && c >= 5) && st.uf.some(([n, t, c]: [string, string, number, string]) => n === 'workbench.service' && t.includes('active') && c >= 1) && st.gaddr === 'unit:/postgresql.service', JSON.stringify({ pf: st.pf, uf: st.uf, dimmed: st.dimmed, gaddr: st.gaddr }));
check('status line counts (failed units red) and the Attention query with one address per item', st.stc.includes('✗ 1!') && st.stc.some((x: string) => /^✦ \d/.test(x)) && st.attn.includes('postgresql.service failed') && st.wbls.some((l: string) => l.startsWith('unit:/postgresql.service')), JSON.stringify({ stc: st.stc, attn: st.attn, wbls: st.wbls }));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = (ms: number) => new Promise(r => setTimeout(r, ms));
  C.perspSet('fs', true); const home = Object.values<FrameNode>(S.nodes).find(f => f.derived === 'fs' && f.fsPath === '/home/me'); await C.fsExpand(home);
  const g1 = Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === 'canvas-readme.md'), ghost1 = g1 && [g1.nlink, g1.hardlink || null, C.live[g1.id].body.textContent];
  const frameAt = (p: string) => Object.values<BoardNode>(S.nodes).find((f): f is FrameNode => f.kind === 'frame' && f.derived === 'fs' && f.fsPath === p), ghostAt = (nm: string) => Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === nm);
  if (!frameAt('/home/me/projects')) { C.ghostOpen(ghostAt('projects')); await sl(50); }
  if (!frameAt('/home/me/projects/canvas')) { C.ghostOpen(ghostAt('canvas')); await sl(50); } else await C.fsExpand(frameAt('/home/me/projects/canvas'));
  const g2 = ghostAt('README.md'), ghost2 = g2 && [g2.nlink, g2.hardlink === g1?.id, C.live[g2.id].body.textContent];
  const edges = C.PERSP.edges.filter((e: Edge) => e.type === 'hardlink').map((e: Edge) => S.nodes[e.from]?.name + '>' + S.nodes[e.to]?.name);
  const mnt = C.fsFrameFor('', '/mnt', { x: 3000, y: 3000 }); await C.fsExpand(mnt); const gm = Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.name === 'data'), gmount = gm && [gm.mount, C.live[gm.id].body.textContent];
  const d = C.ghostOpen(gm); await sl(50); const mounted = d && [d.mount, C.live[d.id].el.classList.contains('d-mount')];
  const rows = C.rgEntries('fs:/mnt').map((e: RgEntry) => e.name + ':' + e.meta).concat(C.rgEntries('fs:/home/me').filter((e: RgEntry) => e.meta).map((e: RgEntry) => e.name + ':' + e.meta));
  C.perspSet('manual', true);
  return { ghost1, ghost2, edges, gmount, mounted, rows }; });
check('filesystem perspective: hard links are ghosts with a dashed edge to the other name (one inode); mount points carry a badge', st.ghost1?.[0] === 2 && st.ghost1[1] === null && /×2/.test(st.ghost1[2]) && st.ghost2?.[0] === 2 && st.ghost2[1] === true && /also \/home\/me\/canvas-readme.md/.test(st.ghost2[2]) && st.edges.join() === 'README.md>canvas-readme.md' && st.gmount?.[0] === true && /⛁/.test(st.gmount[1]) && st.mounted?.[0] === true && st.mounted[1] && st.rows.includes('data:mount') && st.rows.includes('canvas-readme.md:hardlink ×2'), JSON.stringify(st));
// symlinks (the seed's notes → projects/canvas, and a link to a file made here) and a path under a file
st = await p.evaluate(() => { const C = window.__canvas, S = C.S;
  S.fs.c.tmp.c.lnk = { t: 'd', c: { 'f.txt': { t: 'f', d: 'hello link\n' }, 'f-link': { t: 'l', d: '/tmp/lnk/f.txt' }, 'd-link': { t: 'l', d: '/home/me/projects/canvas' } } };
  const prev = (dir: string, nm: string) => { try { C.rgPreview(C.rgEntries(dir).find((x: RgEntry) => x.name === nm)); return document.querySelector('#rg-prev')!.textContent; } catch (e) { return 'threw ' + e; } };
  const sh = C.addNode({ kind: 'term', backend: 'fake', name: 'lnsh', env: {}, x: 14000, y: 14000, w: 300, h: 200 }), b = C.live[sh.id].backend;
  const run = (l: string) => { try { return b.exec(l); } catch (e) { return 'threw ' + e; } };
  const r = { pf: prev('fs:/tmp/lnk', 'f-link'), pd: prev('fs:/home/me', 'notes'), lsDir: run('ls /tmp/lnk/d-link'), lsFile: run('ls /tmp/lnk/f-link'), rm: run('rm /tmp/lnk/f.txt/x'), still: !!S.fs.c.tmp.c.lnk.c['f.txt'] };
  delete S.fs.c.tmp.c.lnk; C.rgPreview(undefined); C.removeNode(sh.id); return r; });
check('symlinks: the navigator previews a link to a file as that file and a link to a directory without throwing; the simulated shell\'s ls lists a linked directory and names a linked file; rm under a file does nothing', st.pf === 'hello link\n' && !st.pd.startsWith('threw') && st.lsDir.includes('README.md') && st.lsFile === '/tmp/lnk/f-link' && st.rm === '' && st.still, JSON.stringify(st));
// ---- tab backgrounds cut off on small items; ⊞ again cycles aspect ratios, the screen's first
st = await p.evaluate(() => { const C = window.__canvas, LH = 32;
  const f = C.addNode({ kind: 'frame', name: 'aspect', mode: 'free', shape: 'folder', x: 6000, y: 6000, w: 900, h: 400 });
  [0, 1, 2].forEach(i => C.addNode({ kind: 'term', backend: 'fake', name: 'a' + i, env: {}, in: f.id, x: 6000 + 40 + i * 250, y: 6060, w: 200, h: 140 }));
  const area0 = 900 * (400 + LH);
  C.setMode(f, 'tile', true); const r = { first: f.aspect, ratio: f.w / (f.h + LH), want: C.screenAspect(), area: f.w * (f.h + LH) / area0, fid: f.id } as { ratio: number; before?: number[]; [k: string]: unknown };
  document.querySelector<HTMLElement>(`.frame[data-id="${f.id}"] .fmodes button[data-m="tile"]`)!.click(); r.second = f.aspect; r.r2 = f.w / f.h;
  C.setMode(f, 'tile', true); r.third = f.aspect; r.r3 = f.w / f.h; r.areaKept = f.w * f.h / (f.w * (f.h + LH)) > 0.9;
  r.panes = C.kidsOf(f.id).every((k: BoardNode) => k.x >= f.x && k.x + k.w <= f.x + f.w + 1 && k.y + k.h <= f.y + f.h + 1);
  for (let i = 0; i < C.ASPECTS.length - 2; i++) C.setMode(f, 'tile', true); r.wrapped = f.aspect;
  C.setMode(f, 'pack', true); r.afterPack = f.aspect; C.setMode(f, 'tile', true); r.again = f.aspect;
  r.before = [f.w, f.h]; C.wsEnter(f, true); r.after = [f.w, f.h]; r.grown = f.w > r.before[0] && f.h > r.before[1] && f.w / (f.h + LH) > r.ratio - 0.02 && f.w / (f.h + LH) < r.ratio + 0.02; return r; });
await sleep(600);
{ const ws = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid], c = C.S.cam, a = C.camArea(); const r = { fillW: c.z * f.w / (a.vw * 0.88), fillH: c.z * (f.h + 32) / (a.vh * 0.86) }; C.wsLeave(); return r; }, st);
  check('⊞ on a folder tiles it in the screen\'s ratio keeping its area; ⊞ again (click or setMode) cycles 16:9, 3:2 … and wraps to screen; pack forgets the ratio; Enter grows it to the screen and fills the view with it', st.grown && st.first === 'screen' && Math.abs(st.ratio - st.want) < 0.02 && Math.abs(st.area - 1) < 0.05 && st.second === '16:9' && Math.abs(st.r2 - 16 / 9) < 0.02 && st.third === '3:2' && Math.abs(st.r3 - 1.5) < 0.02 && st.panes && st.wrapped === 'screen' && st.afterPack === undefined && st.again === 'screen' && Math.abs(ws.fillW - 1) < 0.02 && Math.abs(ws.fillH - 1) < 0.02, JSON.stringify({ st, ws })); }
await sleep(500);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; C.jumpFolder(f); const r: Record<string, unknown> = {};
  const fe = document.querySelector(`.frame[data-id="${fid}"]`)!, tab = fe.querySelector('.ftab')!, k = C.kidsOf(fid)[0], ne = document.querySelector(`.node[data-id="${k.id}"]`)!;
  const measure = () => { const a = fe.getBoundingClientRect(), b = tab.getBoundingClientRect(), hb = ne.querySelector('.hdr')!.getBoundingClientRect(), bt = ne.querySelector('.hdr .btns')!.getBoundingClientRect(); return { fw: a.width, tw: b.width, modes: getComputedStyle(fe.querySelector('.fmodes')!).display, tags: getComputedStyle(ne.querySelector('.hdr .tags')!).display, btnsIn: bt.right <= hb.right + 1, cls: [fe.classList.contains('t-tiny'), ne.classList.contains('t-tiny')] }; };
  C.S.cam.z = 1; C.applyCam(); r.z1 = measure();
  C.zoomAt(innerWidth / 2, innerHeight / 2, 0.15); r.far = measure(); r.z = C.S.cam.z;
  C.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 0.15); r.back = measure(); r.fid = fid; return r; }, st);
check('a tab never runs past its folder: zoomed far out the tab is at most the folder\'s width, the mode buttons go (t-tiny), and a card\'s header keeps its buttons inside and drops its tags; zooming back restores both', st.z1.tw <= st.z1.fw + 2 && st.z1.modes !== 'none' && !st.z1.cls[0] && st.far.tw <= st.far.fw + 2 && st.far.modes === 'none' && st.far.tags === 'none' && st.far.btnsIn && st.far.cls.every(Boolean) && st.back.modes !== 'none' && st.back.tags !== 'none' && !st.back.cls[0], JSON.stringify(st));
await p.evaluate(({ fid }) => { const C = window.__canvas; C.S.cam.z = 1; C.applyCam(); C.jumpFolder(C.S.nodes[fid]); }, st); await sleep(300);

// ---- leaving a workspace ("no intuitive way to unfocus from a node, all other aggregators are hidden. What do I even press?")
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = (ms: number) => new Promise(r => setTimeout(r, ms));
  const tops = Object.values<BoardNode>(S.nodes).filter((n): n is FrameNode => n.kind === 'frame' && !n.in); const f = tops[0], g = tops[1];
  C.wsEnter(f, true); await sl(50);
  const bar = document.querySelector<HTMLElement>('#ws-bar')!; const r: Record<string, unknown> = { barShown: !bar.hidden, name: document.querySelector('#ws-name')!.textContent, wsCur: document.querySelector(`.frame[data-id="${f.id}"]`)!.classList.contains('ws-cur'), fws: !!document.querySelector(`.frame[data-id="${f.id}"] .fws`), outsideG: document.querySelector(`.frame[data-id="${g.id}"]`)!.classList.contains('outside') };
  document.querySelector<HTMLElement>('#ws-up')!.click(); r.afterLeave = C.WS.cur; r.barHidden = bar.hidden;
  document.querySelector<HTMLElement>(`.frame[data-id="${f.id}"] .fws`)!.click(); r.viaTab = C.WS.cur === f.id;
  document.querySelector(`.frame[data-id="${g.id}"] .fgrid`)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 7, pointerType: 'mouse', clientX: 10, clientY: 10 }));
  await sl(50); r.afterClickOutside = C.WS.cur; r.wentThere = document.querySelector(`.frame[data-id="${g.id}"]`)!.classList.contains('active');
  return r; });
check('workspace: a bar at the top names it with a ⇱ Leave button that works; ⌂ on the tab enters; the other folders are dimmed and a click on one leaves the workspace and activates it', st.barShown && st.name.includes('⌂') && st.wsCur && st.fws && st.outsideG && st.afterLeave === null && st.barHidden && st.viaTab && st.afterClickOutside === null && st.wentThere, JSON.stringify(st));

// ---- a rectangle selection to remove handwriting and nodes; the selection can become a node
st = await p.evaluate(() => { const C = window.__canvas, S = C.S;
  const pg = C.addNode({ kind: 'page', name: 'selpage', x: 12000, y: 12000, w: 240, h: 140 });
  const mk = (x: number, y: number) => ({ id: 'tst' + x + '-' + y, color: 'ink', size: 4, sim: 0, owner: null, pts: [[x, y, .5], [x + 40, y + 10, .5], [x + 80, y, .5]] });
  S.strokes.push(mk(12400, 12000), mk(12400, 12040), mk(12400, 12080)); C.renderInk(null);
  const sh = C.addShape({ type: 'rect', x: 12400, y: 12200, w: 100, h: 60 });
  C.pickInRect({ x: 12380, y: 11980 }, { x: 12520, y: 12300 });   // the ink and the shape, not the page to the left
  const r: Record<string, unknown> = { strokes: C.SEL.strokes.size, shapes: C.SEL.shapes.size, nodes: C.PICKED.size, chip: !document.querySelector<HTMLElement>('#pick-chip')!.hidden, pickedPaths: document.querySelectorAll('path.stroke.picked').length, tool: !!document.querySelector('[data-tool="area"]'), sketchBtn: !document.querySelector<HTMLElement>('#pick-chip [data-act=sketch]')!.hidden };
  const n = C.sketchFromSelection(); r.sk = n && { kind: n.kind, owned: S.strokes.filter((s: Stroke) => s.owner === n.id).length, inside: S.strokes.filter((s: Stroke) => s.owner === n.id).every((s: Stroke) => s.pts.every(([x, y]) => x >= 0 && y >= 0 && x <= n.w && y <= n.h)), picked: C.PICKED.has(n.id), strokesLeft: C.SEL.strokes.size };
  C.pickClear(); C.pickInRect({ x: 11900, y: 11900 }, { x: 12700, y: 12400 });   // everything: the page, the sketch card, the shape
  r.all = { nodes: C.PICKED.size, shapes: C.SEL.shapes.size };
  C.removeSelection(); r.after = { page: !!S.nodes[pg.id], sketch: !!(n && S.nodes[n.id]), strokes: S.strokes.filter((s: Stroke) => s.id.startsWith('tst')).length, shape: S.shapes.some((s: Shape) => s.id === sh.id), chip: !document.querySelector<HTMLElement>('#pick-chip')!.hidden };
  r.undo = C.removeUndo() && S.shapes.some((s: Shape) => s.id === sh.id); C.SEL.shapes.add(sh.id); C.removeSelection(); r.again = !S.shapes.some((s: Shape) => s.id === sh.id);
  C.setTool?.('area'); r.cursorClass = document.querySelector('#viewport')!.classList.contains('tool-area'); C.setTool?.('select');
  return r; });
check('area selection: a rectangle picks the ink and the shape inside it (not the card outside) and shows the chip; Sketch card turns the ink into a sketch card owning the strokes; a bigger rectangle takes cards too and Delete removes all; Ctrl-Z brings the shape back and Delete takes it again; the ⬚ tool exists', st.strokes === 3 && st.shapes === 1 && st.nodes === 0 && st.chip && st.pickedPaths === 3 && st.tool && st.sketchBtn && st.sk && st.sk.kind === 'sketch' && st.sk.owned === 3 && st.sk.inside && st.sk.picked && st.sk.strokesLeft === 0 && st.all.nodes === 2 && st.all.shapes === 1 && !st.after.page && !st.after.sketch && st.after.strokes === 0 && !st.after.shape && !st.after.chip && st.undo && st.again && st.cursorClass, JSON.stringify(st));

// draw_shape (agent tool) between two arrows: an arrow has no box, so each end sits unbound at that arrow's midpoint
st = await p.evaluate(() => { const C = window.__canvas, S = C.S, draw = C.AGENT_TOOLS.find((t: AgentTool) => t.name === 'draw_shape');
  const a0 = C.addShape({ type: 'arrow', x1: 13000, y1: 13000, x2: 13200, y2: 13000 }), a1 = C.addShape({ type: 'arrow', x1: 13000, y1: 13200, x2: 13200, y2: 13400 });
  let id: string | null = null, err = ''; try { id = draw.run({ shape: 'arrow', from: a0.id, to: a1.id }); } catch (e) { err = String(e); }
  const s = S.shapes.find((x: Shape) => x.id === id), g = id && document.querySelector(`#shapes [data-id="${id}"]`);
  const r = { err, ends: s ? [s.x1, s.y1, s.x2, s.y2] : null, bound: !!(s?.a || s?.b), drawn: !!g, nan: !!g && /NaN/.test(g.innerHTML) };
  for (const x of [a0.id, a1.id, id]) if (x) C.SEL.shapes.add(x); C.removeSelection(); return r; });
check('draw_shape from an arrow to an arrow: each end sits at that arrow\'s midpoint, unbound, and draws without NaN', !st.err && JSON.stringify(st.ends) === '[13100,13000,13100,13300]' && !st.bound && st.drawn && !st.nan, JSON.stringify(st));

// ---- ▦: a packed folder is no wider than its rows
st = await p.evaluate(() => { const C = window.__canvas;
  const f = C.addNode({ kind: 'frame', name: 'packw', mode: 'free', shape: 'folder', x: 8000, y: 8000, w: 1600, h: 400 });
  const ks = [0, 1].map(i => C.addNode({ kind: 'term', backend: 'fake', name: 'p' + i, env: {}, in: f.id, x: 8000 + 40 + i * 300, y: 8060, w: 200, h: 140 }));
  const w0 = f.w; C.setMode(f, 'pack', true); const r: Record<string, unknown> = { w0, w: f.w, h: f.h, oneRow: new Set(ks.map(k => k.y)).size === 1, inside: ks.every(k => k.x >= f.x && k.x + k.w <= f.x + f.w) };
  C.setMode(f, 'tile', true); C.setMode(f, 'pack', true); r.w2 = f.w;   // from tile too
  C.setMode(f, 'pack', true); r.w3 = f.w;   // a second pack keeps it
  return r; });
check('pack shrinks the folder to its widest row plus padding instead of keeping its last mode\'s width; stable on re-pack; same from tile', st.w0 === 1600 && st.w === 200 + 24 + 200 + 56 && st.oneRow && st.inside && st.w2 === st.w && st.w3 === st.w, JSON.stringify(st));

// ---- clearing a graph selection ("selected something in the graph and everything else is hidden"): Esc and ✕ clear the selection; the rest stays readable
await p.evaluate(() => { const C = window.__canvas; C.setView('graph'); });
await sleep(600);
st = await p.evaluate(() => { const C = window.__canvas; const id = [...C.G.N.keys()][0]; C.graphSelect?.(id); return { sel: C.G.sel, card: !document.querySelector<HTMLElement>('#g-card')!.hidden, x: !!document.querySelector('#g-card .gc-x'), hint: document.querySelector('#g-card .gc-hint')?.textContent || '' }; });
await p.keyboard.press('Escape'); await sleep(100);
const gs = await p.evaluate(() => { const C = window.__canvas; const r: Record<string, unknown> = { sel: C.G.sel, card: !document.querySelector<HTMLElement>('#g-card')!.hidden }; C.graphSelect([...C.G.N.keys()][0]); document.querySelector<HTMLElement>('#g-card .gc-x')!.click(); r.afterX = C.G.sel;
  C.cardActions(); r.pal = !document.getElementById('palette')!.hidden; return r; });   // N66: '.' with nothing selected lists no stale buttons
if (gs.pal) { await p.keyboard.press('Escape'); await sleep(100); }
await p.evaluate(() => window.__canvas.setView('canvas'));
check('graph: a selection shows a card with ✕ and a hint; Esc clears it, so does ✕; then \'.\' opens no palette (N66)', st.sel && st.card && st.x && /Esc, ✕ or a click on empty space/.test(st.hint) && gs.sel === null && !gs.card && gs.afterX === null && !gs.pal, JSON.stringify({ st, gs }));
// the assistant pane is gone: the graph card has no Ask assistant and the palette no Handwriting → ask the assistant
await p.evaluate(() => window.__canvas.setView('graph')); await sleep(600);
st = await p.evaluate(() => { const C = window.__canvas; C.graphSelect([...C.G.N.keys()][0]);
  const card = !document.querySelector<HTMLElement>('#g-card')!.hidden, ask = [...document.querySelectorAll('#g-card button')].some(b => b.textContent === 'Ask assistant'); C.graphSelect(null);
  return { card, ask, ink: C.CMDS.some((c: PaletteItem) => c.l === 'Handwriting → ask the assistant') }; });
await p.evaluate(() => window.__canvas.setView('canvas'));
check('graph: the card offers no Ask assistant, and the palette no Handwriting → ask the assistant', st.card && !st.ask && !st.ink, JSON.stringify(st));
// the palette's Fullscreen: headless Chromium refuses a request without a user gesture; that is a toast, not an unhandled rejection
st = await p.evaluate(async () => { const C = window.__canvas; let unhandled = 0; const on = () => { unhandled++; }; addEventListener('unhandledrejection', on);
  document.querySelector('#toast')!.textContent = ''; C.CMDS.find((c: PaletteItem) => c.l === 'Fullscreen (browser)').run(); await new Promise(r => setTimeout(r, 300));
  const r = { unhandled, full: !!document.fullscreenElement, toast: document.querySelector('#toast')!.textContent };
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); removeEventListener('unhandledrejection', on); return r; });
check('Fullscreen (browser): a refused request says so in a toast and leaves no unhandled rejection', st.unhandled === 0 && (st.full || st.toast === 'Fullscreen is not available here.'), JSON.stringify(st));

// ---- spiral tiling, pane shares by dragging an edge, no ribbon ↔ tile ratchet, folder resize drives packing down to a stack
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S;
  const f = C.addNode({ kind: 'frame', name: 'tiles', mode: 'free', shape: 'folder', x: 4000, y: 4000, w: 800, h: 500 });
  const ks = [0, 1, 2, 3].map(i => C.addNode({ kind: 'term', backend: 'fake', name: 't' + i, env: {}, in: f.id, x: 4000 + 40 + i * 150, y: 4000 + 60, w: 200, h: 140 }));
  const rel = () => C.kidsOf(f.id).sort((a: BoardNode, b: BoardNode) => a.order! - b.order!).map((k: BoardNode) => [k.name, k.x - f.x, k.y - f.y, k.w, k.h]);
  const size0 = [f.w, f.h]; C.setMode(f, 'tile', true); const tiled = rel(), sizeT = [f.w, f.h];
  const sizes = []; for (const m of ['free', 'tile', 'free', 'tile']) { C.setMode(f, m, true); sizes.push(f.w + 'x' + f.h); }
  const handles = ['.rs', '.rse', '.rsb'].map(h => !!document.querySelector(`.frame[data-id="${f.id}"] ${h}`) && !!document.querySelector(`.node[data-id="${ks[0].id}"] ${h}`));
  C.jumpNode(ks[0]); await new Promise(r => setTimeout(r, 400));
  return { fid: f.id, k0: ks[0].id, size0, sizeT, tiled, sizes, handles }; });
const tf = st;
check('tile is dwm\'s golden spiral: the first pane takes 0.618 of the width, the next 0.618 of the remaining height on the right, then inward; leaving and re-entering tile gives the same size; corner and edge handles exist on cards and folders', st.tiled[0][0] === 't0' && Math.abs(st.tiled[0][3] - Math.round((st.sizeT[0] - 24) * 0.618)) <= 1 && st.tiled[1][1] > st.tiled[0][3] && Math.abs(st.tiled[1][4] - Math.round((st.sizeT[1] - 24) * 0.618)) <= 1 && st.tiled[2][2] > st.tiled[1][4] && st.tiled[3][1] < st.tiled[2][1] && st.tiled[3][2] === st.tiled[2][2] && st.sizes[1] === st.sizes[3] && st.sizes[1] === st.sizeT.join('x') && st.sizes[0] === st.sizes[2] && st.handles.every(Boolean), JSON.stringify(st));
let rh = await p.evaluate(({ k0 }) => { const e = document.querySelector(`.node[data-id="${k0}"] .rse`)!.getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, tf);
await p.mouse.move(rh.x, rh.y); await p.mouse.down(); await p.mouse.move(rh.x + 60, rh.y, { steps: 5 }); await p.mouse.move(rh.x + 120, rh.y, { steps: 5 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid, k0 }) => { const C = window.__canvas, f = C.S.nodes[fid]; return { mfact: f.mfact, k0w: C.S.nodes[k0].w, fw: f.w, right: C.kidsOf(fid).filter((k: BoardNode) => k.id !== k0).every((k: BoardNode) => k.x >= C.S.nodes[k0].x + C.S.nodes[k0].w) }; }, tf);
check('dragging a tiled pane\'s right edge raises its share (mfact) and the folder retiles live, the other panes staying to its right', st.mfact > 0.7 && st.mfact < 0.85 && st.k0w > 0.7 * (st.fw - 24) && st.fw === tf.sizeT[0] && st.right, JSON.stringify(st));
await p.evaluate(({ fid }) => { const C = window.__canvas; C.setMode(C.S.nodes[fid], 'pack', true); C.jumpFolder(C.S.nodes[fid]); }, tf); await sleep(500);
let gh: any = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; const e = document.querySelector(`.frame[data-id="${fid}"] .rs`)!.getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2, w: f.w, h: f.h, kw: C.kidsOf(fid).map((k: BoardNode) => k.w) }; }, tf);   // any: the handle's point and the folder's size, then the point alone
await p.mouse.move(gh.x, gh.y); await p.mouse.down(); await p.mouse.move(gh.x - 100, gh.y - 60, { steps: 6 }); await p.mouse.move(gh.x - 200, gh.y - 120, { steps: 6 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; return { mode: f.mode, w: f.w, h: f.h, scale: f.packScale, kw: C.kidsOf(fid).map((k: BoardNode) => [k.w, k.h, !!k.prePack]), inside: C.kidsOf(fid).every((k: BoardNode) => k.x + k.w <= f.x + f.w + 1 && k.y + k.h <= f.y + f.h + 1) }; }, tf);
check('a packed folder dragged smaller keeps the dragged size: items re-flow and shrink together to fit (originals remembered)', st.mode === 'pack' && st.w < gh.w && st.scale > 0.35 && st.scale < 1 && st.kw.every(([w, h, p]: [number, number, boolean]) => w < 200 && p) && st.inside, JSON.stringify({ st, gh }));
gh = await p.evaluate(({ fid }) => { const e = document.querySelector(`.frame[data-id="${fid}"] .rs`)!.getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, tf);
await p.mouse.move(gh.x, gh.y); await p.mouse.down(); await p.mouse.move(gh.x - 300, gh.y - 200, { steps: 8 }); await p.mouse.move(gh.x - 600, gh.y - 400, { steps: 8 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; return { mode: f.mode, w: f.w, h: f.h, prev: f.prevMode, grip: getComputedStyle(document.querySelector(`.frame[data-id="${fid}"] .rs`)!).display }; }, tf);
check('dragged below a deck\'s size the folder stacks, remembering pack; the deck keeps a grip', st.mode === 'stack' && st.w === 300 && st.prev === 'pack' && st.grip !== 'none', JSON.stringify(st));
gh = await p.evaluate(({ fid }) => { const e = document.querySelector(`.frame[data-id="${fid}"] .rs`)!.getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, tf);
await p.mouse.move(gh.x, gh.y); await p.mouse.down(); await p.mouse.move(gh.x + 200, gh.y + 150, { steps: 8 }); await p.mouse.move(gh.x + 400, gh.y + 300, { steps: 8 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; const r: Record<string, unknown> = { mode: f.mode, w: f.w, h: f.h, kw: C.kidsOf(fid).map((k: BoardNode) => k.w) }; C.setMode(f, 'free', true); r.restored = C.kidsOf(fid).every((k: BoardNode) => k.w === 200 && !k.prePack); C.removeNode(fid); return r; }, tf);
check('a deck dragged open unstacks into pack at the dragged size; back in free mode the cards have their own sizes again', st.mode === 'pack' && st.w > 300 && st.kw.every((w: number) => w > 110) && st.restored, JSON.stringify(st));

// ---- the heading tree of a note, links with backlink counts, the journal and link perspectives, ]d / [d, the outline pane
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = (ms: number) => new Promise(r => setTimeout(r, ms)); await C.notesLoad(true);
  const top = C.rgEntries(C.addrToKey('note:plans')).map((e: RgEntry) => e.name + '|' + e.meta + '|' + e.dir), h1 = C.rgEntries(C.addrToKey('note:plans')).find((e: RgEntry) => e.dir), sub = h1 ? C.rgEntries(h1.key).map((e: RgEntry) => e.name) : [], up = h1 ? C.rgParent(C.rgEntries(h1.key)[0].key) === h1.key : false;
  const byHeading = C.resolveAddr('note:plans#Rollout'), byAnchor = C.addrToKey('note:^freeze') || C.addrToKey('note:plans#^freeze');
  const root = C.rgEntries('link:').map((e: RgEntry) => e.name + ' ' + e.meta), plans = C.rgEntries('link:plans').map((e: RgEntry) => e.name + ' ' + e.meta + ' ' + e.kind), bl = (await C.AGENT_TOOLS.find((x: AgentTool) => x.name === 'backlinks').run({ title: 'log' })).split('\n');
  const jk = C.addrToKey('journal:today'), jd = C.journalDays().map((d: { day: string }) => d.day);
  C.perspSet('journal', true); await sl(100); const jf = Object.values<BoardNode>(S.nodes).filter((f): f is FrameNode => f.kind === 'frame' && f.derived === 'journal').map(f => f.name + ':' + C.kidsOf(f.id).map((k: BoardNode) => k.kind + ':' + k.name).join('|')).sort();
  C.perspSet('manual', true); C.linkPerspFrom('plans'); await sl(100); const lf = Object.values<BoardNode>(S.nodes).filter((f): f is FrameNode => f.kind === 'frame' && f.derived === 'link').map(f => f.name + ':' + C.kidsOf(f.id).map((k: BoardNode & { meta?: string }) => k.kind + ':' + k.name + (k.meta ? '(' + k.meta + ')' : '')).join('|'));
  const ghost = Object.values<BoardNode>(S.nodes).find((n): n is GhostNode => n.kind === 'ghost' && n.linkTitle === 'ops'); const made = C.ghostOpen(ghost); await sl(50); const madeIn = made && S.nodes[made.in]?.derived === 'link', dimmed = Object.values<BoardNode>(S.nodes).filter((n): n is TermNode => n.kind === 'term' && C.live[n.id]?.el.classList.contains('persp-dim')).length;
  C.perspSet('manual', true); const stays = !!C.findPage('ops'); C.removeNode(C.findPage('ops').id);
  C.jumpNode(C.findPage('plans')); C.renderTree(); const outline = [...document.querySelectorAll<HTMLElement>('#tp-list .tp-row.tp-h')].map(r => r.querySelector('.tp-nm')!.textContent + '@' + r.style.getPropertyValue('--d'));
  return { top, sub, up, byHeading: byHeading.error || byHeading.addr, byAnchor, root, plans, bl, jk, jd, jf, lf, madeIn, dimmed, stays, outline }; });
check('note: lists a note\'s headings as a tree (h1 › its h2s), h goes up; [[Title#Heading]] and a bare ^anchor resolve; the outline pane shows the focused page\'s headings', st.top.length === 1 && /^Canvas workspace\|h1\|true$/.test(st.top[0]) && st.sub.join() === 'Rollout,Ideas' && st.up && st.byHeading === 'note:plans#Rollout' && /^note:/.test(st.byAnchor || '') && st.outline.length >= 3 && st.outline[0].startsWith('Canvas workspace@') && st.outline.some((x: string) => /^Rollout@/.test(x)) && +st.outline.find((x: string) => /^Rollout@/.test(x)).split('@')[1] === +st.outline[0].split('@')[1] + 1, JSON.stringify(st));
check('link: lists pages most linked-to first with → out ← in counts; descending shows targets (×n when linked twice) and titles with no page; the backlinks tool', st.root[0] === 'log → 1 ← 2' && st.root.includes('plans → 3 ← 1') && st.plans[0] === 'log ×2 → 1 ← 2 buffer' && st.plans.some((x: string) => /^ops no page yet ghost$/.test(x)) && st.bl[0] === 'log: ← 2 in, → 1 out' && st.bl.some((l: string) => /^plans:\d+ · /.test(l)), JSON.stringify({ root: st.root, plans: st.plans, bl: st.bl }));
check('journal:today resolves to the day; the journal perspective nests year › month › day pages; the links perspective nests the MOC from a root, a no-page ghost becomes a page in place, the rest dims', st.jk === 'journal:' + DAYP && st.jd.length === 1 && st.jf.length === 2 && st.jf[0] === `${YM}:buffer:${DAY}` && st.jf[1] === `${Y}:frame:${YM}` && st.lf.length === 1 && /^⇄ plans:buffer:plans\|buffer:log\|ghost:ops\(no page yet\)\|ghost:graph\(no page yet\)$/.test(st.lf[0]) && st.madeIn && st.dimmed > 0 && st.stays, JSON.stringify({ jk: st.jk, jd: st.jd, jf: st.jf, lf: st.lf, madeIn: st.madeIn, dimmed: st.dimmed, stays: st.stays }));
await p.evaluate(() => { const C = window.__canvas; C.setView('ranger'); C.rgGo(C.addrToKey('journal:today')); });
await p.keyboard.press('['); await p.keyboard.press('d'); await sleep(200);
st = await p.evaluate(() => ({ dir: window.__canvas.RG.dir, toast: document.querySelector('#toast')?.textContent || '' }));
await p.evaluate(prev => { const C = window.__canvas; const n = C.addNode({ kind: 'buffer', name: prev, x: 3000, y: 3000, w: 300, h: 200, text: '# ' + prev + '\n\n- yesterday' }); C.notesLoad(true); }, PREV);
await p.keyboard.press('['); await p.keyboard.press('d'); await sleep(300);
const st2 = await p.evaluate(() => window.__canvas.RG.dir);
await p.keyboard.press(']'); await p.keyboard.press('d'); await sleep(300);
const st3 = await p.evaluate(prev => { const C = window.__canvas; const d = C.RG.dir; C.removeNode(C.findPage(prev).id); C.setView('canvas'); return d; }, PREV);
check('[d / ]d in the navigator step to the previous / next day that has an entry', /earlier/.test(st.toast) && st.dir === 'journal:' + DAYP && st2 === 'journal:' + PREV.replaceAll('-', '/') && st3 === 'journal:' + DAYP, JSON.stringify({ st, st2, st3 }));

// ---- tasks are keyword blocks with planning lines under them; four columns; keys; dispatch into a shell tagged #agent
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = (ms: number) => new Promise(r => setTimeout(r, ms));
  const pg = C.addNode({ kind: 'buffer', name: 'todo', x: 1500, y: 1500, w: 420, h: 300, text: '# todo\n\n- TODO Write the v15 tests [#A]\n  SCHEDULED: <2026-10-01 Wed>\n  cover the four columns\n- NEXT Ship version 30\n  DEADLINE: <2099-01-01 Fri>\n- HOLD Wait for the build host\n- CANCELLED Old idea\n' });
  const sh = C.addNode({ kind: 'term', backend: 'fake', name: 'agentsh', env: {}, x: 2000, y: 1500, w: 440, h: 300 }); C.setTags(sh, ['agent']); await sl(300);
  C.setView('tasks'); await sl(200);
  const cols = [...document.querySelectorAll<HTMLElement>('#tk-board .tk-col')].map(c => c.dataset.col + ':' + [...c.querySelectorAll('.tk-card')].filter(x => x.querySelector<HTMLElement>('.tk-page')!.dataset.addr!.startsWith('board:/todo:')).length);
  const card = [...document.querySelectorAll<HTMLElement>('.tk-card')].find(c => /Write the v15 tests/.test(c.textContent))!, meta = card?.querySelector('.tk-meta')?.textContent, over = !!card?.querySelector('.tk-meta .over');
  const hold = [...document.querySelectorAll('.tk-card')].find(c => /Wait for the build host/.test(c.textContent)), holdCol = hold?.closest<HTMLElement>('.tk-col')!.dataset.col, holdTitle = hold?.querySelector('.tk-t')!.textContent;
  const t = C.allTasks().find((x: TaskRow) => x.text.startsWith('Write the v15')); const ttext = C.taskText(t), found = C.findTask('todo:3')?.line === 3 && C.findTask('board:/todo:3')?.node === t.node;
  C.statusRender(); const stc = [...document.querySelectorAll('#st-host .stc')].map(b => b.textContent); const attn = C.rgEntries('attn:').map((e: RgEntry) => e.name);
  const ls = (await C.AGENT_TOOLS.find((x: AgentTool) => x.name === 'list_tasks').run({ status: 'open' })).split('\n');
  card.click(); return { pg: pg.id, sh: sh.id, cols, meta, over, holdCol, holdTitle, ttext, found, stc, attn, ls }; });
const tk = st;
check('tasks view: four columns over the keyword set, priority and dates as meta, overdue in red, HOLD shown in Waiting with its keyword; list_tasks addresses', st.cols.join() === 'TODO:1,NEXT:1,WAITING:1,DONE:1' && /#A/.test(st.meta) && /2026-10-01/.test(st.meta) && st.over && st.holdCol === 'WAITING' && /^HOLD Wait/.test(st.holdTitle) && st.ttext === 'Write the v15 tests cover the four columns' && st.found && st.stc.some((x: string) => /^☐ \d+ \(\d+ due\)/.test(x)) && st.attn.some((x: string) => /^overdue Write the v15 tests/.test(x)) && st.ls.some((l: string) => /^board:\/todo:3 · TODO · Write the v15 tests \[#A\] · scheduled 2026-10-01$/.test(l)), JSON.stringify(st));
await p.keyboard.press('t'); await sleep(200);
const pgText1 = await p.evaluate(id => window.__canvas.pageText(id), tk.pg);
await p.keyboard.press('d'); await sleep(900);
st = await p.evaluate(({ pg, sh }) => { const C = window.__canvas; const text = C.pageText(pg); const m = text.match(/session:: board:(\S+)/), target = m && (C.findNode(m[1]) || C.findNode(m[1].replace(/^\//, ''))), term = target ? C.termLines(C.live[target.id], 20).join('|') : '', agentTag = target && C.tagsOf(target).includes('agent'); const cols = [...document.querySelectorAll<HTMLElement>('#tk-board .tk-col')].map(c => c.dataset.col + ':' + [...c.querySelectorAll('.tk-card')].filter(x => x.querySelector<HTMLElement>('.tk-page')!.dataset.addr!.startsWith('board:/todo:')).length); const sess = [...document.querySelectorAll('.tk-card .tk-meta .sess')].map(x => x.textContent); return { text, term, agentTag, cols, sess }; }, tk);
// st.term joins the terminal's rows with |, and a narrow card wraps the pasted line.
check('t cycles the keyword in the page; d pastes title + body into a shell tagged #agent and writes session:: / dispatched:: under the task', /- NEXT Write the v15 tests \[#A\]/.test(pgText1) && st.agentTag && /Write the v15 tests cover the four columns/.test(st.term.replaceAll('|', '')) && /\n  session:: board:\/\S+\n  dispatched:: 20\d\d-\d\d-\d\dT\d\d:\d\d\n  SCHEDULED: <2026-10-01 Wed>/.test(st.text) && st.cols.join() === 'TODO:0,NEXT:2,WAITING:1,DONE:1' && st.sess.some((x: string) => /^⇢ board:\//.test(x)), JSON.stringify({ pgText1, st }));
await p.keyboard.press('T'); await sleep(200);
st = await p.evaluate(async ({ pg, sh }) => { const C = window.__canvas; const text = C.pageText(pg); const r = await C.AGENT_TOOLS.find((x: AgentTool) => x.name === 'set_task').run({ task: 'todo:3', keyword: 'DONE' }); const text2 = C.pageText(pg); C.setView('canvas'); C.removeNode(pg); C.removeNode(sh); return { text, r, text2 }; }, tk);
check('T cycles back (NEXT → TODO); set_task writes a keyword by reference', /- TODO Write the v15 tests/.test(st.text) && st.r === 'board:/todo:3 → DONE' && /- DONE Write the v15 tests/.test(st.text2), JSON.stringify(st));
// N61 (F-A30): a long source path and a long unbroken title stay inside their column; the view (window less dock) picks 4, 2 or 1 columns
const tkFit = async () => p.evaluate(async () => { const C = window.__canvas, sl = (ms: number) => new Promise(r => setTimeout(r, ms)); C.setView('tasks'); await sl(250);
  const cols = getComputedStyle(document.querySelector('#tk-board')!).gridTemplateColumns.split(' ').length, out = [];
  for (const col of document.querySelectorAll<HTMLElement>('#tk-board .tk-col')) { const cr = col.getBoundingClientRect(); for (const c of col.querySelectorAll('.tk-card, .tk-page .tl')) { const r = c.getBoundingClientRect(); if (r.left < cr.left - 0.5 || r.right > cr.right + 0.5) out.push(col.dataset.col + ':' + c.className); } }
  const card = [...document.querySelectorAll('.tk-card')].find(c => /Sequence_the_whole/.test(c.textContent)), t = card?.querySelector('.tk-t'), pg = card?.querySelector<HTMLElement>('.tk-page');
  return { vw: document.querySelector('#v-tasks')!.clientWidth, cols, out, lines: t ? Math.round(t.getBoundingClientRect().height / (parseFloat(getComputedStyle(t).lineHeight) || 18)) : 0, tail: pg?.querySelector('.tl')?.textContent, title: pg?.title, clipped: pg ? pg.querySelector('.hd')!.scrollWidth > pg.querySelector('.hd')!.clientWidth : null }; });
const LONGPG = '20220203010311-repeat_expansion_mediated_cytotoxicity_in_neurons';
const longId = await p.evaluate(n => window.__canvas.addNode({ kind: 'buffer', name: n, x: 1500, y: 2100, w: 420, h: 200, text: '# ' + n + '\n\n- TODO Sequence_the_whole_' + 'x'.repeat(90) + '_genome\n' }).id, LONGPG);
const fitW = await tkFit();
// The dock takes its width from the view, so the middle size is set from the view's width, not the window's.
await p.setViewportSize({ width: 1500 - fitW.vw + 760, height: 950 }); const fitM = await tkFit();
await p.setViewportSize({ width: 500, height: 950 }); const fitS = await tkFit();
await p.setViewportSize({ width: 1500, height: 950 });
await p.evaluate(id => { const C = window.__canvas; C.setView('canvas'); C.removeNode(id); }, longId);
check('tasks view (F-A30): a long source path and an unbroken title stay inside the column (title wraps, path keeps its tail, full path on hover); 4, 2 or 1 columns by the view\'s width', [fitW, fitM, fitS].every(f => f.cols === (f.vw > 960 ? 4 : f.vw > 560 ? 2 : 1) && !f.out.length && f.lines >= 2 && /\d$/.test(f.tail || '') && f.title?.startsWith(LONGPG)) && fitW.cols === 4 && fitM.cols === 2 && fitS.cols === 1 && fitW.clipped, JSON.stringify({ fitW, fitM, fitS }));
// ---- fix 1 rendering without a server (30 §1.2-§1.4, F-A19): diffs, elicitation forms, url requests, agent text as text
st = await p.evaluate(() => {
  const C = window.__canvas, A = C.AcpBackend.prototype, rows = (d: Element) => [...d.querySelectorAll('pre > div')].map(r => r.className + ':' + r.textContent);
  const lines = (k: number, f: (i: number) => string) => Array.from({ length: k }, (_, i) => f(i)).join('\n');
  const fresh = C.lineDiff({ path: '/w/new.txt', oldText: null, newText: 'x\ny' });
  const many = rows(C.lineDiff({ path: '/w/m', oldText: lines(30, i => 'l' + i), newText: lines(30, i => (i === 15 ? 'L15' : 'l' + i)) }));
  const f = C.elicitForm({ type: 'object', required: ['name'], properties: { color: { type: 'string', enum: ['red', 'green'] }, n: { type: 'integer', minimum: 1, maximum: 5 }, ok: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } }, name: { type: 'string', minLength: 2 } } });
  const q = (k: string, s: string) => f.el.querySelector(`.fld[data-key="${k}"] ${s}`), empty = f.check();
  q('name', 'input').value = 'x'; const short = f.check();
  q('name', 'input').value = 'xy'; q('n', 'input').value = '9'; const big = f.check();
  q('n', 'input').value = '3'; q('color', 'select').value = 'green'; q('ok', 'input').checked = true; q('tags', 'input[value="b"]').checked = true;
  const full = f.check();
  const url = (u: string) => { const d = A.elicitPanel.call({ answerElicitation() {} }, 1, { request: { mode: 'url', url: u, message: 'Sign in', elicitationId: 'e' } }); return { off: d.querySelector('button.open').disabled, host: d.querySelector('code b')?.textContent ?? null, links: d.querySelectorAll('a').length }; };
  const XSS = '<img src=x onerror="window.__xss=1">';
  const perm = A.permPanel.call({ n: { agent: 'stub' }, answerPermission() {} }, 1, { toolCall: { title: XSS, kind: 'edit', content: [{ type: 'diff', path: '/w/' + XSS, oldText: 'a', newText: '<script>window.__xss=2</script>' }] },
    options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'a', name: 'Always', kind: 'allow_always' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }] });
  document.body.append(perm);
  const out = { diff: rows(C.lineDiff({ path: '/w/a.txt', oldText: 'a\nb\nc', newText: 'a\nB\nc' })), fresh: rows(fresh), freshPath: fresh.querySelector('.dp').textContent, many,
    empty, short, big, full, js: url('javascript:alert(1)'), data: url('data:text/html,<b>x</b>'), http: url('http://example.org/'), https: url('https://example.org/login?x=1'),
    markup: perm.querySelectorAll('img, script').length, title: perm.querySelector('.ph .tt').textContent, btns: [...perm.querySelectorAll('.acts button')].map(b => (b.className || '-') + '|' + b.dataset.kind + '|' + b.textContent),
    button: document.querySelector<HTMLInputElement>('#add-acp')?.disabled };
  perm.remove(); return out;
});
await sleep(300);
check('fix 1 (no server): lineDiff marks the changed lines, keeps 3 lines of context, folds the rest, and shows a missing oldText as a new file',
  st.diff.join() === 'ctx:  a,del:- b,add:+ B,ctx:  c' && st.fresh.join() === 'add:+ x,add:+ y' && st.freshPath === '/w/new.txt (new file)' && st.many.length === 10 && st.many[0] === 'gap:… 12 unchanged lines' && st.many[4] === 'del:- l15' && st.many[5] === 'add:+ L15' && st.many[9] === 'gap:… 11 unchanged lines', JSON.stringify({ diff: st.diff, fresh: st.fresh, many: st.many }));
check('fix 1 (no server): an elicitation form checks required, minLength and maximum, and returns the exact content',
  !st.empty.ok && st.empty.err === 'name is required' && st.short.err === 'name: at least 2 characters' && st.big.err === 'n: at most 5' && st.full.ok && JSON.stringify(st.full.content) === JSON.stringify({ color: 'green', n: 3, ok: true, tags: ['b'], name: 'xy' }), JSON.stringify({ empty: st.empty, short: st.short, big: st.big, full: st.full }));
check('F-A19 (no server): a url request can be opened only when it is https:, shows its host in bold, and renders no link',
  st.js.off && st.data.off && st.http.off && !st.https.off && st.https.host === 'example.org' && st.js.host === null && [st.js, st.data, st.http, st.https].every(u => u.links === 0), JSON.stringify({ js: st.js, data: st.data, http: st.http, https: st.https }));
check('fix 1 (no server): agent text in a permission request stays text; allow_always says remembered; reject is not the primary button; the Agent button is off in the demo',
  st.markup === 0 && st.title.startsWith('<img') && await p.evaluate(() => window.__xss === undefined) && st.btns[0] === 'go|allow_once|Allow' && st.btns[1] === 'go|allow_always|Always · remembered by stub' && st.btns[2] === '-|reject_once|Reject' && st.button === true, JSON.stringify({ markup: st.markup, btns: st.btns, button: st.button }));
st = await p.evaluate(() => { const A = window.__canvas.AcpBackend.prototype;   // apply on a stand-in: the two requests waiting, and the notes it adds
  const fake = { pending: new Map<number, object>([[5, { kind: 'elicitation', request: { message: 'q' } }], [7, { kind: 'permission', toolCall: {}, options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }] }]]), items: [] as { text?: string }[], add(it: { text?: string }) { this.items.push(it); return it; } };
  let threw: string | null = null; try { A.apply.call(fake, { e: 'permission_resolved', seq: 6, req: 5, outcome: { outcome: 'selected', optionId: 'y' } }); A.apply.call(fake, { e: 'permission_resolved', seq: 8, req: 7, outcome: { outcome: 'selected', optionId: 'y' } }); } catch (e) { threw = String(e); }
  return { threw, notes: fake.items.map(i => i.text), left: fake.pending.size }; });
check('fix 1 (no server): a permission_resolved that names an elicitation is noted as answered instead of throwing; one that names a permission still says allowed', st.threw === null && st.notes.join('|') === 'answered: y|allowed: Allow' && st.left === 0, JSON.stringify(st));
await p.close();
check('N16 demo: the inlined page asks fonts.googleapis.com for nothing', !demoHosts.has('fonts.googleapis.com'), [...demoHosts].join());

// ---------------- N57: touch and the camera (demo page, a touch screen). Cards far from the seed board, so every
// touch below lands on what it names; CDP touches go through the browser's own gesture handling.
{
  const tc = await browser.newContext({ viewport: { width: 1500, height: 950 }, hasTouch: true });
  const T = await tc.newPage(); watchErrors(T);
  await T.goto('file://' + wrapped); await sleep(1500);
  const cdp = await tc.newCDPSession(T);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: number[][]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const gesture = async (from: number[][], to: number[][], steps = 10, rest = 0) => {   // fingers from → to, one frame a step; rest: ms still before the lift
    await touch('touchStart', from);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', from.map(([x, y], k) => [x + (to[k][0] - x) * i / steps, y + (to[k][1] - y) * i / steps])); if (i < steps) await sleep(16); }
    if (rest) await sleep(rest);   // else the lift follows the last move at once, as a flick's does
    await touch('touchEnd', []);
  };
  const cam = () => T.evaluate(() => ({ ...window.__canvas.S.cam }));
  const home = () => T.evaluate(() => { const C = window.__canvas; Object.assign(C.S.cam, { x: 19400, y: 19700, z: 1 }); C.applyCam(); });
  const ids = await T.evaluate(() => {
    const C = window.__canvas, S = C.S;
    const pg = C.addNode({ kind: 'buffer', name: 'n56-page', x: 20000, y: 20000, w: 480, h: 380, text: '# n56\n' + Array.from({ length: 120 }, (_, i) => '- line ' + i).join('\n') }).id;
    const a = C.addNode({ kind: 'buffer', name: 'n56-a', x: 19700, y: 20000, w: 220, h: 130, text: '# a' }).id;
    const b = C.addNode({ kind: 'buffer', name: 'n56-b', x: 19700, y: 20250, w: 220, h: 130, text: '# b' }).id;
    const c = C.addNode({ kind: 'buffer', name: 'n56-c', x: 20600, y: 20000, w: 220, h: 130, text: '# c' }).id;
    S.edges.push({ id: 'n56-ab', from: a, to: b, type: 'spawn' }, { id: 'n56-pc', from: pg, to: c, type: 'pipe' });
    return { pg, a, b, c };
  });
  await home(); await sleep(400);
  const mid: [number, number] = [600 + 240, 300 + 190];   // the page's middle
  const bg = await T.evaluate((): [number, number] | null => { const bare = (x: number, y: number) => ['viewport', 'world'].includes(document.elementFromPoint(x, y)?.id!); for (let y = 500; y < 860; y += 20) for (let x = 1050; x < 1460; x += 20) if (bare(x, y) && bare(x - 320, y) && bare(x - 160, y) && [[-40, -40], [40, -40], [-40, 40], [40, 40], [-360, -40], [-360, 40]].every(([dx, dy]) => bare(x + dx, y + dy))) return [x, y]; return null; });   // 40 px clear: the browser's touch adjustment snaps a finger to a handle's hit area (F-A36 R4) nearby
  const hits = await T.evaluate(([bg, mid]) => [!!bg, !!document.elementFromPoint(...mid)?.closest('.node .body')], [bg, mid] as const);
  let c0 = await cam();
  await gesture([[mid[0] - 50, mid[1]], [mid[0] + 50, mid[1]]], [[mid[0] - 100, mid[1]], [mid[0] + 100, mid[1]]]);
  let c1 = await cam();
  check('N57: two fingers on a page zoom the camera (a pinch over a card was ignored)', hits[0] && hits[1] && Math.abs(c1.z / c0.z - 2) < 0.05, JSON.stringify({ hits, z0: c0.z, z1: c1.z }));
  await home(); await sleep(200); c0 = await cam();
  await gesture([bg!], [[bg![0] - 300, bg![1]]], 6); await sleep(2500); c1 = await cam();   // a glide has run out by then
  const glided = (c1.x - c0.x) - 300;
  await home(); await sleep(200); c0 = await cam();
  await gesture([bg!], [[bg![0] - 300, bg![1]]], 6, 150); await sleep(900); const c2 = await cam();
  check('N57: a one-finger pan that lifts while moving glides on; one that rests before the lift stays', glided > 60 && Math.abs(c2.x - c0.x - 300) < 1, JSON.stringify({ glided, rested: c2.x - c0.x - 300 }));
  await gesture([bg!], [[bg![0] - 300, bg![1]]], 6); await sleep(2500);   // a touch flick, then a quick middle-button drag
  await T.mouse.move(...bg!); await T.mouse.down({ button: 'middle' }); for (let i = 1; i <= 6; i++) await T.mouse.move(bg![0] - 50 * i, bg![1]);
  await T.mouse.up({ button: 'middle' }); const m0 = await cam(); await sleep(600); const m1 = await cam();
  check('N57: a mouse pan after a touch flick does not glide', m1.x === m0.x && m1.y === m0.y, JSON.stringify({ m0, m1 }));
  await T.evaluate(() => { const C = window.__canvas; Object.assign(C.S.cam, { x: 15000, y: 15000, z: 0.3 }); C.applyCam(); });
  await sleep(200);
  await T.evaluate(id => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); }, ids.pg);   // a flight to z 1 of 380 ms
  await sleep(60); await touch('touchStart', [bg!]); await sleep(600); const held = await cam(); await touch('touchEnd', []);
  check('N57: a finger down during a flight stops it where it is (the flight overwrote the hand)', held.z < 0.95, JSON.stringify(held));   // the flight lands at z 1; it may pull back below 0.3 on the way
  await home(); await sleep(400);
  const hdr = (id: string) => T.evaluate((id): [number, number] => { const r = document.querySelector(`.node[data-id="${id}"] .hdr`)!.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; }, id);
  const drag = async (h: [number, number], dy: number) => { await T.mouse.move(...h); await T.mouse.down(); for (let i = 1; i <= 8; i++) await T.mouse.move(h[0], h[1] + i * dy / 8); await T.mouse.up(); await sleep(300); };
  await drag(await hdr(ids.b), 10);   // draws the board's edges
  await T.evaluate(() => { window.__n56 = document.querySelector('.redge[data-edge="n56-pc"]'); });
  await drag(await hdr(ids.a), 40);
  const kept = await T.evaluate(() => ({ same: document.querySelector('.redge[data-edge="n56-pc"]') === window.__n56 && !!window.__n56, ab: !!document.querySelector('.redge[data-edge="n56-ab"]') }));
  check('N57: dragging a card redraws its own edges and keeps the drawing of the others', kept.same && kept.ab, JSON.stringify(kept));

  // N68 (F-A36): motion and touch R1-R5. A double tap on bare canvas zooms 2x about the finger and makes no page; one
  // finger on a page scrolls the page; a mouse notch eases the zoom while a trackpad step is at once; the far look has
  // hysteresis; a layout change plays as a FLIP; a new card enters and a removed one leaves a fading ghost; on a coarse
  // pointer the small handles have 44 px hit areas.
  await home(); await sleep(400);
  const vr = await T.evaluate(() => { const r = document.querySelector('#viewport')!.getBoundingClientRect(); return [r.left, r.top]; });
  const under = (c: { x: number; y: number; z: number }, p: number[]) => [c.x + (p[0] - vr[0]) / c.z, c.y + (p[1] - vr[1]) / c.z];
  const nodesN = () => T.evaluate(() => Object.keys(window.__canvas.S.nodes).length);
  const tap = async (p: number[]) => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); };
  c0 = await cam(); const k0 = await nodesN();
  await tap(bg!); await sleep(150); await tap(bg!); await sleep(700);
  c1 = await cam(); const k1 = await nodesN(), w0 = under(c0, bg!), w1 = under(c1, bg!);
  check('N68: a double tap on bare canvas zooms 2x about the finger (the point under it stays) and makes no page', Math.abs(c1.z / c0.z - 2) < 0.02 && Math.hypot(w1[0] - w0[0], w1[1] - w0[1]) < 2 && k1 === k0, JSON.stringify({ z0: c0.z, z1: c1.z, w0, w1, k0, k1 }));
  await home(); await sleep(300); c0 = await cam();
  const sc0 = await T.evaluate((id: string) => Math.max(...[...document.querySelectorAll(`.node[data-id="${id}"] *`)].map(e => e.scrollTop)), ids.pg);
  await gesture([[mid[0], mid[1] + 100]], [[mid[0], mid[1] - 100]], 10, 150); await sleep(300);
  const sc1 = await T.evaluate((id: string) => Math.max(...[...document.querySelectorAll(`.node[data-id="${id}"] *`)].map(e => e.scrollTop)), ids.pg); c1 = await cam();
  check('N68: one finger dragged on a page scrolls the page and leaves the camera', sc1 > sc0 && c1.x === c0.x && c1.y === c0.y && c1.z === c0.z, JSON.stringify({ sc0, sc1, c0, c1 }));
  await home(); await sleep(300);
  const wh = await T.evaluate(async (p: number[]) => {
    const C = window.__canvas, vp = document.querySelector('#viewport')!, z0 = C.S.cam.z;
    const wheel = (dy: number) => vp.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, clientX: p[0], clientY: p[1], bubbles: true, cancelable: true }));
    wheel(100); const zNow = C.S.cam.z, easing = !!C.WHEEL.raf;
    wheel(100); wheel(100);
    await new Promise(r => setTimeout(r, 400)); const zEnd = C.S.cam.z;
    const zt = C.S.cam.z; wheel(4); const zPad = C.S.cam.z;
    return { z0, zNow, easing, zEnd, want: z0 * Math.exp(-0.75), zt, zPad, padWant: zt * Math.exp(-0.04) };
  }, bg!);
  check('N68: a mouse notch with Ctrl eases the zoom (nothing jumps in the event) and three notches end at their product; a trackpad step zooms at once', wh.zNow === wh.z0 && wh.easing && Math.abs(wh.zEnd / wh.want - 1) < 0.005 && Math.abs(wh.zPad / wh.padWant - 1) < 0.001, JSON.stringify(wh));
  await sleep(300);
  const lod = await T.evaluate(() => {
    const C = window.__canvas, far = () => document.querySelector('#world')!.classList.contains('far'), at = (z: number) => { C.S.cam.z = z; C.applyCam(); return far(); };
    return [at(0.6), at(0.44), at(0.41), at(0.46), at(0.47), at(0.49), at(0.44)];
  });
  check('N68: the far look comes on below 0.42 and goes above 0.48: a camera that rests near 0.45 does not flip it', JSON.stringify(lod) === JSON.stringify([false, false, true, true, true, false, false]), JSON.stringify(lod));
  await home(); await sleep(400);
  const flip = await T.evaluate(async (id: string) => {
    const C = window.__canvas, n = C.S.nodes[id], e = document.querySelector<HTMLElement>(`.node[data-id="${id}"]`)!, raf = () => new Promise(r => requestAnimationFrame(r));
    C.settle(); n.x += 200; C.placeAny(n); const left = parseFloat(e.style.left);
    await raf(); await raf(); const mid = { flip: e.classList.contains('flip'), x: e.getBoundingClientRect().left };
    await new Promise(r => setTimeout(r, 500)); const end = { flip: e.classList.contains('flip'), x: e.getBoundingClientRect().left, t: e.style.transform };
    n.x -= 200; C.placeAny(n);
    return { left, mid, end };
  }, ids.c);
  check('N68: a layout change plays as a FLIP: the card is laid out at its end at once, runs there on a transform, and ends with no transform or flip class', flip.mid.flip && flip.end.x - flip.mid.x > 20 && !flip.end.flip && flip.end.t === '', JSON.stringify(flip));
  const enter = await T.evaluate(async () => {
    const C = window.__canvas, n = C.addNode({ kind: 'buffer', name: 'n68-new', x: 20100, y: 20500, w: 220, h: 130, text: '# new' }), e = document.querySelector(`.node[data-id="${n.id}"]`)!;
    const entering = e.classList.contains('entering');
    await new Promise(r => setTimeout(r, 450)); const after = e.classList.contains('entering');
    C.removeNode(n.id); const ghost = document.querySelectorAll('.node-ghost').length;
    await new Promise(r => setTimeout(r, 400));
    return { entering, after, ghost, gone: document.querySelectorAll('.node-ghost').length };
  });
  check('N68: a new card enters (class entering, gone when its animation ends); a removed card leaves a fading ghost that goes', enter.entering && !enter.after && enter.ghost === 1 && enter.gone === 0, JSON.stringify(enter));
  const hit = await T.evaluate((id: string) => {
    const coarse = matchMedia('(pointer: coarse)').matches, q = (s: string) => document.querySelector<HTMLElement>(`.node[data-id="${id}"] ${s}`);
    const h = (e: HTMLElement | null) => { if (!e) return null; const b = getComputedStyle(e, '::before'); return b.content === 'none' ? 0 : parseFloat(b.height); };
    return { coarse, rs: h(q('.rs')), hb: h(q('.hdr .hb')) };
  }, ids.c);
  check('N68: on a touch screen (pointer: coarse) a card\'s resize handle and header buttons have hit areas of at least 44 px', hit.coarse ? (hit.rs ?? 0) >= 44 && (hit.hb === null || hit.hb >= 44) : true, JSON.stringify(hit));
  await tc.close();
}

// ---------------- N62: a pen's barrel button (F-A31). CDP pen events: the button pressed in hover (middle as X11 Wacom
// drivers send it, right as Windows Ink does) pans and inks nothing; the tip landing while the barrel is held, a barrel
// pressed in the middle of a stroke, and a tip that lands where a barrel pan just ended all pan; plain strokes still ink.
{
  const T = await page('file://' + wrapped);
  const cdp = await T.context().newCDPSession(T);
  const BIT = { none: 0, left: 1, right: 2, middle: 4 };
  const pen = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, button: 'none' | 'left' | 'middle' | 'right' = 'none', buttons = 0) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, pointerType: 'pen', clickCount: type === 'mouseMoved' ? 0 : 1 });
  await pen('mouseMoved', 700, 400); await sleep(600);   // the first pen event turns on tablet mode
  const pg = await T.evaluate(() => window.__canvas.addNode({ kind: 'buffer', name: 'n62-page', x: 30700, y: 30300, w: 360, h: 260, text: '# n62' }).id);
  const home = () => T.evaluate(() => { const C = window.__canvas; Object.assign(C.S.cam, { x: 30000, y: 30000, z: 1 }); C.applyCam(); window.__n62menus ??= 0; });
  await home(); await sleep(300);
  await T.evaluate(() => addEventListener('contextmenu', e => { if (!e.defaultPrevented) window.__n62menus++; }));
  const at = await T.evaluate((): [number, number] | null => { const bare = (x: number, y: number) => ['viewport', 'world'].includes(document.elementFromPoint(x, y)?.id!); for (let y = 300; y < 800; y += 20) for (let x = 400; x < 1200; x += 20) if (bare(x, y) && bare(x + 260, y)) return [x, y]; return null; });
  const onPage = await T.evaluate((id): [number, number] => { const r = document.querySelector(`.node[data-id="${id}"] .body`)!.getBoundingClientRect(); return [r.x + 40, r.y + 60]; }, pg);
  const run = async (from: [number, number] | null, steps: [string, string | number][]) => {   // steps: ['down'|'up', button] or ['move', dx]; → strokes added, camera moved, menus opened
    await home(); await sleep(400);
    const st = () => T.evaluate(() => ({ n: window.__canvas.S.strokes.length, x: window.__canvas.S.cam.x, m: window.__n62menus + (!document.getElementById('palette')!.hidden as unknown as number) }));
    const a = await st(); let held = 0, [x, y] = from!;
    for (const [k, v] of steps) {
      if (k === 'down') { held |= BIT[v as keyof typeof BIT]; await pen('mousePressed', x, y, v as keyof typeof BIT, held); }
      else if (k === 'up') { held &= ~BIT[v as keyof typeof BIT]; await pen('mouseReleased', x, y, v as keyof typeof BIT, held); }
      else if (k === 'wait') await sleep(v as number);
      else for (let i = 0; i < 8; i++) { x += (v as number) / 8; await pen('mouseMoved', x, y, 'none', held); await sleep(10); }
    }
    await sleep(150); const b = await st();
    return { ink: b.n - a.n, pan: Math.round(a.x - b.x), menus: b.m - a.m };
  };
  const r: Record<string, Record<string, Awaited<ReturnType<typeof run>>>> = {};
  for (const t of ['select', 'pen', 'erase']) {
    await T.evaluate(t => window.__canvas.setTool(t), t);
    r[t] = {
      mid: await run(at, [['down', 'middle'], ['move', 200], ['up', 'middle']]),
      right: await run(at, [['down', 'right'], ['move', 200], ['up', 'right']]),
      card: await run(onPage, [['down', 'middle'], ['move', 200], ['up', 'middle']]),
      tip: await run(at, [['down', 'middle'], ['move', 20], ['down', 'left'], ['move', 200], ['up', 'left'], ['up', 'middle']]),
      late: await run(at, [['down', 'left'], ['move', 24], ['down', 'right'], ['move', 200], ['up', 'right'], ['up', 'left']]),
      tap: await run(at, [['down', 'middle'], ['move', 200], ['up', 'middle'], ['wait', 60], ['down', 'left'], ['up', 'left']]),
    };
  }
  await T.evaluate(() => window.__canvas.setTool('pen'));
  const stroke = await run(at, [['down', 'left'], ['move', 120], ['up', 'left']]), dot = await run(at, [['down', 'left'], ['up', 'left']]);
  const pans = (o: { ink: number; pan: number; menus: number }, d = 200) => o.ink === 0 && Math.abs(o.pan - d) < 2 && o.menus === 0;
  check('N62: a pen\'s barrel button (middle or right) in hover pans the camera, over the canvas and over a page, with every tool, and leaves no ink or menu',
    ['select', 'pen', 'erase'].every(t => pans(r[t].mid) && pans(r[t].right) && pans(r[t].card)), JSON.stringify(r));
  check('N62: the tip landing while the barrel is held, a barrel pressed mid-stroke, and a tip that lands where a barrel pan just ended all pan and leave no ink',
    ['select', 'pen', 'erase'].every(t => pans(r[t].tip, 220) && pans(r[t].late) && pans(r[t].tap)), JSON.stringify(r));
  check('N62: a plain pen stroke and a pen tap well after a pan still ink and do not move the camera', stroke.ink === 1 && stroke.pan === 0 && dot.ink === 1 && dot.pan === 0, JSON.stringify({ stroke, dot }));
  await T.close();
}
