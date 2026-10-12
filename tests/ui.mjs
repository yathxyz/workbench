// Frontend checks in headless Chromium (DESIGN §9.5, 30 §10, DELTA-1 §A.5 and §B.6).
//
//   WB_PLAYWRIGHT=<playwright>/index.mjs WB_HARNESS=tests/harness.py node tests/ui.mjs <web-root>
//
// <web-root> (or $WB_WEB_ROOT) is the built web output (`nix build .#workbench-web`: web/ plus vendor/ and fonts/). The
// harness takes wb-hub, wb-web and caddy from PATH; the Caddy configs for the expired and login-page modes sit next to
// it in caddy/.
// Each check prints ok, FAIL or skip. The exit status is 0 only when every check ran and passed.
//
// Demo phase: the page inlined the way tools/build-artifact.py inlines it, opened from file://.
// Daemon phase: the harness's Caddy listens only on a unix socket. A forwarder on 127.0.0.1:18443 (the harness's
// publicOrigin) joins the browser to it and drops connections from every other local user, who would otherwise
// reach a shell through the proxy secret Caddy adds. The harness runs without WB_HARNESS_TCP, whose TCP entry would
// take that port; the forwarder stays because N6 cuts it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const ROOT = process.argv[2] || process.env.WB_WEB_ROOT, HARNESS = process.env.WB_HARNESS;
if (!ROOT || !HARNESS) { console.error('usage: WB_PLAYWRIGHT=… WB_HARNESS=tests/harness.py node tests/ui.mjs <web-root>'); process.exit(2); }
const fails = [], skips = [];
const check = (name, ok, info = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name, ok ? '' : info); if (!ok) fails.push(name); };
const skip = (name, why) => { console.log('skip ' + name + ': ' + why); skips.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000, step = 100) => { const end = Date.now() + ms; for (;;) { let v; try { v = await f(); } catch {} if (v || Date.now() > end) return v; await sleep(step); } };

const browser = await chromium.launch();
process.on('uncaughtException', e => { console.log('UNCAUGHT', e); process.exit(2); });   // the harness stops when our end of its stdin closes
const errors = [];
const watchErrors = p => { p.on('pageerror', e => errors.push(String(e))); p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); }); };
async function page(url, w = 1500, h = 950) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  watchErrors(p);
  await p.goto(url); await sleep(1500); return p;
}

// ---------------- demo mode
// tools/build-artifact.py's page, built here from the web root: the APP part of index.html with the styles,
// the bridge source, vendor.js and app.js inline, and no font link.
function demoPage() {
  const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8'), js = f => rd(f).replaceAll('</script', '<\\/script');
  const body = rd('index.html').split('<!--APP-->')[1].split('<!--/APP-->')[0];
  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body>
<title>Workbench</title>
<style>
${rd('vendor/xterm.css')}
${rd('style.css')}
</style>
${body}
<script>window.CANVAS_HOSTED = true; window.CLAUDE_BRIDGE_SRC = ${JSON.stringify(rd('bridge.js')).replaceAll('</script', '<\\/script')};</script>
<script>
${js('vendor/vendor.js')}
</script>
<script>
${js('app.js')}
</script>
</body></html>`;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ui-'));
const wrapped = path.join(TMP, 'wb-wrapped.html');
fs.writeFileSync(wrapped, demoPage());
const demoHosts = new Set();
let p = await browser.newPage({ viewport: { width: 1500, height: 950 } });
watchErrors(p); p.on('request', r => demoHosts.add(new URL(r.url()).host));
await p.goto('file://' + wrapped); await sleep(1500);
// The demo writes today's journal page; the app takes the local date, and so do these checks.
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NOW = new Date(), DAY = ymd(NOW), Y = DAY.slice(0, 4), YM = DAY.slice(0, 7), DAYP = DAY.replaceAll('-', '/'), PREV = ymd(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1));
check('demo boots', await p.evaluate(() => !!window.__canvas.S && !window.__canvas.DAEMON));
await p.evaluate(() => window.__canvas.newArtifact('hello1'));
await sleep(2500);
let st = await p.evaluate(() => { const n = Object.values(window.__canvas.S.nodes).find(n => n.kind === 'artifact'); const L = window.__canvas.live[n.id]; return { hello: L.hello, head: n.head, notice: L.notice.hidden, caps: n.capabilities }; });
check('demo artifact handshake', st.hello === true && st.notice === true && !!st.head, JSON.stringify(st));
const artFrame = async (pg, i = 0) => (await pg.$$('.art-frame'))[i].contentFrame();
let fr = await artFrame(p);
check('frame present', !!fr);
await fr.click('#count'); await sleep(800);
check('db set/get through bridge', (await fr.textContent('#out')).includes('count = 1'), await fr.textContent('#out'));
await fr.click('#count'); await sleep(600);
check('db persists', (await fr.textContent('#out')).includes('count = 2'));
await fr.click('#ask'); await sleep(800);
const grantVisible = await p.evaluate(() => !document.querySelector('#grant').hidden);
check('grant prompt shown for sample', grantVisible);
await p.click('#grant-allow'); await sleep(800);
check('sample absent in demo rejects with code', (await fr.textContent('#out')).includes('failed: sampling_disabled'), await fr.textContent('#out'));
const nsCheck = await fr.evaluate(async () => { const s = await claude.use('sample'); const d = await claude.use('db'); const x = await claude.use('nope'); const perm = await claude.use('permissions'); return { frozen: Object.isFrozen(s) && Object.isFrozen(d), same: (await claude.use('db')) === d, nope: x, st: await perm.state('sample'), limits: await s.limits() }; });
check('namespaces frozen, memoised, unknown null, permissions state', nsCheck.frozen && nsCheck.same && nsCheck.nope === null && nsCheck.st === 'granted', JSON.stringify(nsCheck));
// artifact.publish from inside the page -> new version, frame reloads
fr.evaluate(() => { claude.use('artifact').then(a => a.publish('<title>Hi2</title><p id=v2>second</p>')).catch(() => {}); }).catch(() => {});
await sleep(800); if (await p.evaluate(() => !document.querySelector('#grant').hidden)) await p.click('#grant-allow');
await sleep(1500);
fr = await artFrame(p);
st = await p.evaluate(() => { const n = Object.values(window.__canvas.S.nodes).find(n => n.kind === 'artifact'); return { versions: n.versions.length, head: n.head, html: n.html }; });
check('artifact.publish makes a version and reloads', st.versions === 2 && st.html.includes('second') && !!(await fr.$('#v2')), JSON.stringify(st).slice(0, 200));
// db query / onSnapshot
const q = await fr.evaluate(async () => { try { const db = await claude.use('db'); const col = db.collection('items'); await col.doc('a').set({ n: 3, tag: 'x' }); await col.doc('b').set({ n: 1, tag: 'x' }); await col.doc('c').set({ n: 2, tag: 'y' });
  const got = await col.where('tag', '==', 'x').orderBy('n', 'desc').get(); let snaps = 0; const un = col.onSnapshot(s => { snaps = s.size; }); await new Promise(r => setTimeout(r, 100)); await col.doc('d').set({ n: 9 }); await new Promise(r => setTimeout(r, 100)); un();
  return { ids: got.docs.map(d => d.id), size: got.size, snaps }; } catch (e) { return { error: JSON.stringify(e), msg: String(e && e.message) }; } });
check('db query where/orderBy and onSnapshot', q.ids?.join() === 'a,b' && q.snaps === 4, JSON.stringify(q));
// v8 nodes in demo mode
st = await p.evaluate(() => { const w = window.__canvas.newWeb('example.org/a'); const s = window.__canvas.newSketch(); const L = window.__canvas.live[w.id]; return { url: w.url, name: w.name, frame: !!L.frame, bar: !!L.urlInput, sketch: s.kind, agentHidden: !document.querySelector('#add-agent'), emacsOff: document.querySelector('#add-emacs').disabled }; });
check('web and sketch nodes, agent button hidden', st.url === 'https://example.org/a' && st.name === 'example.org' && st.frame && st.bar && st.sketch === 'sketch' && st.agentHidden && st.emacsOff, JSON.stringify(st));
await p.evaluate(() => { for (const n of Object.values(window.__canvas.S.nodes)) if (n.kind === 'web' || n.kind === 'sketch') window.__canvas.removeNode(n.id); });
// review view
await p.evaluate(() => window.__canvas.setView('review')); await sleep(600);
check('review shows a card', (await p.textContent('#rv-face')).trim().length > 0 && (await p.textContent('#rv-due')) === '10', await p.textContent('#rv-due'));
await p.keyboard.press('Space'); await sleep(200);
check('reveal shows answer and intervals', !(await p.$eval('#rv-answer', e => e.hidden)) && (await p.textContent('#rv-iv3')).length > 0);
await p.keyboard.press('3'); await sleep(300);
st = await p.evaluate(() => ({ log: window.__canvas.S.reviews, due: document.querySelector('#rv-due').textContent, done: document.querySelector('#rv-done').textContent }));
check('grade appends a log line', st.log?.length === 1 && st.log[0].g === 3 && st.due === '9' && st.done === '1', JSON.stringify(st));
await p.keyboard.press('u'); await sleep(300);
st = await p.evaluate(() => ({ log: window.__canvas.S.reviews.length, due: document.querySelector('#rv-due').textContent }));
check('undo retracts', st.log === 2 && st.due === '10', JSON.stringify(st));
await p.click('#rv-modes button[data-mode="type"]'); await sleep(200); await p.fill('#rv-typein', 'excellence virtue'); await p.keyboard.press('Enter'); await sleep(200);
check('type mode diff', (await p.textContent('#rv-diff')).includes('excellence'));
await p.click('#rv-modes button[data-mode="pen"]'); await sleep(300);
check('pen mode canvas', !(await p.$eval('#rv-inkwrap', e => e.hidden)));
// list_due tool
const due = await p.evaluate(async () => window.__canvas.AGENT_TOOLS.find(t => t.name === 'list_due').run({ limit: 3 }));
check('list_due tool', due.split('\n').length === 3, due);
const cf = await p.evaluate(async () => window.__canvas.AGENT_TOOLS.find(t => t.name === 'create_flashcard').run({ front: 'Q?', back: 'A', deck: 'test' }));
check('create_flashcard demo', cf.startsWith('added to page cards'), cf);
// palette has the new commands
const cmds = await p.evaluate(() => window.__canvas.CMDS.map(c => c.l).filter(l => /Artifact|Review/.test(l)));
check('palette commands', cmds.length >= 9, cmds.join(' | '));
// phone mode
await p.setViewportSize({ width: 420, height: 800 }); await sleep(300);
check('phone mode', (await p.evaluate(() => document.body.dataset.mode)) === 'phone');
await p.setViewportSize({ width: 1500, height: 950 }); await sleep(300);
await p.screenshot({ path: path.join(TMP, 'wb-review.png') });
await p.evaluate(() => window.__canvas.setView('canvas')); await sleep(300);
await p.screenshot({ path: path.join(TMP, 'wb-canvas.png') });
// v10: ribbon mode, workspaces, focus tabs, optimiser, leader key, neighbours
let v10 = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const f = Object.values(S.nodes).find(n => n.kind === 'frame' && !n.in && C.kidsOf(n.id).filter(k => k.kind !== 'frame').length >= 2);
  C.setMode(f, 'tile', true);
  const ks = C.kidsOf(f.id).filter(k => k.kind !== 'frame');
  const ys = new Set(ks.map(k => k.y)), hs = new Set(ks.map(k => k.h));
  const cls = document.querySelector(`[data-id="${f.id}"]`)?.classList.contains('m-tile');
  return { id: f.id, ys: ys.size, hs: hs.size, n: ks.length, cls, btn: !document.querySelector(`[data-id="${f.id}"] .fmodes [data-m="ribbon"]`), btns: document.querySelectorAll(`[data-id="${f.id}"] .fmodes button`).length };
});
check('v18.1: the ribbon mode button is gone (four mode buttons); the folder tiles', v10.n >= 2 && v10.cls && v10.btn && v10.btns === 4, JSON.stringify(v10));
v10 = await p.evaluate(id => {
  const C = window.__canvas, S = C.S; C.wsEnter(S.nodes[id], true);
  const inside = new Set([id, ...Object.values(S.nodes).filter(n => { let c = n; let g = 0; while (c && c.in && g++ < 20) { if (c.in === id) return true; c = S.nodes[c.in]; } return false; }).map(n => n.id)]);
  const all = [...document.querySelectorAll('#world .node, #world .frame')];
  const out = all.filter(e => e.classList.contains('outside')).length;
  const wrong = all.filter(e => e.classList.contains('outside') === inside.has(e.dataset.id)).length;
  return { inws: document.body.classList.contains('in-ws'), out, wrong, st: document.querySelector('#st-ws').textContent, saved: S.ws === id, top: C.wsTop().length };
}, v10.id);
check('enter workspace: outside dims, breadcrumb in the status bar, persisted', v10.inws && v10.out > 0 && v10.wrong === 0 && v10.st.includes('⌂') && v10.saved && v10.top >= 1, JSON.stringify(v10));
await p.keyboard.press('Escape'); await sleep(700);
v10 = await p.evaluate(() => ({ inws: document.body.classList.contains('in-ws'), out: document.querySelectorAll('.outside').length, st: document.querySelector('#st-ws').textContent, ws: window.__canvas.S.ws }));
check('Esc leaves the workspace', !v10.inws && v10.out === 0 && v10.st === '' && !v10.ws, JSON.stringify(v10));
v10 = await p.evaluate(() => {
  const C = window.__canvas, S = C.S; const n = Object.values(S.nodes).find(n => n.kind === 'buffer' || n.kind === 'term');
  const before = { x: n.x, y: n.y, w: n.w, h: n.h }; C.focusOpen(n);
  const vw = document.querySelector('#viewport').clientWidth;
  const el = document.querySelector(`.node[data-id="${n.id}"]`);
  const r = el.getBoundingClientRect(), vr = document.querySelector('#viewport').getBoundingClientRect();
  return { id: n.id, before, w: n.w, vw, fits: n.w >= vw - 4, body: document.body.classList.contains('focus'), focused: el.classList.contains('focused'), tabs: [...document.querySelectorAll('#focus-tabs .ft')].map(t => t.textContent), on: document.querySelector('#focus-tabs .ft.on')?.textContent, left: Math.round(r.left - vr.left), top: Math.round(r.top - vr.top), hiddenOther: getComputedStyle(document.querySelector(`.node:not([data-id="${n.id}"])`)).visibility, persisted: (S.focusTabs || []).includes(n.id) };
});
check('focus tab fills the main area; strip shows canvas + tab; others hidden', v10.fits && v10.body && v10.focused && v10.tabs.length === 2 && !!v10.on && v10.tabs[0].includes('canvas') && v10.left >= -2 && v10.left <= 2 && v10.top >= 88 && v10.top <= 92 && v10.hiddenOther === 'hidden' && v10.persisted, JSON.stringify(v10));
await p.keyboard.press('Escape'); await sleep(300);
let v10b = await p.evaluate(a => { const n = window.__canvas.S.nodes[a.id]; return { same: n.x === a.before.x && n.y === a.before.y && n.w === a.before.w && n.h === a.before.h, body: document.body.classList.contains('focus'), strip: !document.querySelector('#focus-tabs').hidden, tabs: document.querySelectorAll('#focus-tabs .ft').length }; }, v10);
check('Esc returns to the canvas, node rect restored, tab stays', v10b.same && !v10b.body && v10b.strip && v10b.tabs === 2, JSON.stringify(v10b));
await p.click('#focus-tabs .ft:nth-child(2)'); await sleep(300);
v10b = await p.evaluate(() => ({ body: document.body.classList.contains('focus'), cur: window.__canvas.FOCUS.cur }));
check('clicking the tab re-opens the focus', v10b.body && !!v10b.cur, JSON.stringify(v10b));
await p.evaluate(() => window.__canvas.focusClose(window.__canvas.FOCUS.cur)); await sleep(300);
v10b = await p.evaluate(() => ({ body: document.body.classList.contains('focus'), hidden: document.querySelector('#focus-tabs').hidden, tabs: window.__canvas.FOCUS.tabs.length }));
check('closing the last tab hides the strip', !v10b.body && v10b.hidden && v10b.tabs === 0, JSON.stringify(v10b));
// optimiser: no overlapping top-level items afterwards, snapped to the grid, undoable
v10 = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const roots = () => Object.values(S.nodes).filter(n => !n.in && !C.stashed(n));
  const a = roots()[0], b = roots()[1]; b.x = a.x + 10; b.y = a.y + 10; // force an overlap
  C.optimise(null);
  const rs = roots(); let overlaps = 0;
  const top = k => k.kind === 'frame' ? 32 : 0;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const p = rs[i], q = rs[j]; if (p.x < q.x + q.w && q.x < p.x + p.w && p.y - top(p) < q.y + q.h && q.y - top(q) < p.y + p.h) overlaps++; }
  const snapped = rs.every(k => (k.x % 24 === 0) && ((k.y - top(k)) % 24 === 0 || k.y % 24 === 0));
  return { n: rs.length, overlaps, snapped, undo: !!document.body && C.CMDS.some(c => c.l.startsWith('Layout: optimise')) };
});
check('optimise the board: no overlaps, grid snapped', v10.n >= 3 && v10.overlaps === 0 && v10.snapped && v10.undo, JSON.stringify(v10));
await p.keyboard.press('Control+z'); await sleep(300);
// leader key
await p.keyboard.press('Control+Space'); await sleep(200);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, shown: !document.querySelector('#which-key').hidden, rows: document.querySelectorAll('#which-key b').length }));
check('Ctrl-Space opens the which-key popup', v10.on && v10.shown && v10.rows >= 20, JSON.stringify(v10));
await p.keyboard.press('z'); await sleep(600);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, shown: !document.querySelector('#which-key').hidden }));
check('leader z runs fit-all and closes the popup', !v10.on && !v10.shown, JSON.stringify(v10));
await p.evaluate(() => { const ta = document.querySelector('#side-term .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea'); ta.focus(); window.__got = 0; ta.addEventListener('keydown', e => { if (e.ctrlKey && e.code === 'Space') window.__got++; }); });
await p.keyboard.press('Control+Space'); await sleep(120);
v10 = await p.evaluate(() => ({ on: window.__canvas.LEADER.on, got: window.__got }));
await p.keyboard.press('Control+Space'); await sleep(200);
v10 = await p.evaluate(a => ({ ...a, on2: window.__canvas.LEADER.on, got2: window.__got }), v10);
check('leader twice passes the key through and closes', v10.on && v10.got === 0 && !v10.on2 && v10.got2 === 1, JSON.stringify(v10));
await p.evaluate(() => document.activeElement.blur());
await p.evaluate(() => { const C = window.__canvas; const f = C.wsTop()[0]; C.wsEnter(f, true); });
await p.keyboard.press('Control+Space'); await sleep(120); await p.keyboard.press('u'); await sleep(700);
check('leader u leaves the workspace', await p.evaluate(() => !window.__canvas.WS.cur && !document.body.classList.contains('in-ws')));
// neighbours
v10 = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const minX = Math.min(...Object.values(S.nodes).filter(n => !n.in).map(n => n.x));   // two cards left of everything, on one row
  const a = C.addNode({ kind: 'page', name: 'nb-a', x: minX - 1200, y: 100, w: 200, h: 120 }), b = C.addNode({ kind: 'page', name: 'nb-b', x: minX - 900, y: 100, w: 200, h: 120 });
  const r = C.neighbour(a, 'l'); const l = C.neighbour(a, 'h');
  return { right: r ? r.id === b.id : false, leftNone: !l };
});
// middle-drag and Alt-drag over a terminal body pan; the middle button does not paste
await p.evaluate(() => { const C = window.__canvas, S = C.S; const t = Object.values(S.nodes).find(n => n.kind === 'term'); C.jumpNode(t, 1); });
await sleep(700);
let mid = await p.evaluate(() => { const C = window.__canvas, S = C.S; const t = Object.values(S.nodes).find(n => n.kind === 'term'); const el = document.querySelector(`.node[data-id="${t.id}"] .body`); const r = el.getBoundingClientRect(); window.__pastes = 0; document.addEventListener('paste', () => window.__pastes++); return { x: r.left + r.width / 2, y: r.top + r.height / 2, cx: C.S.cam.x }; });
await p.mouse.move(mid.x, mid.y); await p.mouse.down({ button: 'middle' }); await p.mouse.move(mid.x - 120, mid.y, { steps: 4 }); await p.mouse.up({ button: 'middle' }); await sleep(200);
let mid2 = await p.evaluate(() => ({ cx: window.__canvas.S.cam.x, pastes: window.__pastes, panning: document.querySelector('#viewport').classList.contains('panning') }));
check('middle-drag over a terminal body pans and does not paste', Math.abs(mid2.cx - mid.cx) > 50 && mid2.pastes === 0 && !mid2.panning, JSON.stringify({ mid, mid2 }));
const cx0 = await p.evaluate(() => window.__canvas.S.cam.x);
await p.keyboard.down('Alt'); await p.mouse.move(mid.x, mid.y); await p.mouse.down(); await p.mouse.move(mid.x + 90, mid.y + 30, { steps: 4 }); await p.mouse.up(); await p.keyboard.up('Alt'); await sleep(200);
mid2 = await p.evaluate(a => ({ cx0: a, cx: window.__canvas.S.cam.x, z: window.__canvas.S.cam.z, moved: a - window.__canvas.S.cam.x }), cx0);
check('Alt-drag over a terminal body pans', mid2.moved > 60 / mid2.z && mid2.moved < 120 / mid2.z, JSON.stringify(mid2));
// nested folder: the parent's mode buttons stay reachable when the child's tab overlaps them
let nest = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const outer = Object.values(S.nodes).find(n => n.name === 'canvas-workbench'), inner = Object.values(S.nodes).find(n => n.name === 'machines');
  C.setMode(outer, 'free', true);
  outer.w = Math.max(outer.w, 1100); C.placeAny(outer);   // v18: a folder under 250 screen px drops its tab buttons, so keep the parent wide at the test's zoom
  // put the child folder right under the parent's tab row, as pack/tile/ribbon do (PAD + LABEL_H), and zoom out so the child's screen-size tab pokes into the parent's row
  const dx = (outer.x + 28 + 200) - inner.x, dy = (outer.y + 28 + 32) - inner.y;
  const moved = [inner, ...Object.values(S.nodes).filter(n => n.in === inner.id)]; for (const m of moved) { m.x += dx; m.y += dy; C.placeAny(m); }
  C.separateAll(); // clears loose nodes off the parent's tab row; the child stays (siblings only)
  C.jumpNode(outer, 0.4);
  return { outer: outer.id, inner: inner.id };
});
await sleep(900);
nest = await p.evaluate(a => {
  const q = id => `.frame[data-id="${id}"]`;
  document.querySelector(q(a.outer)).classList.remove('active'); document.querySelector(q(a.inner)).classList.add('active'); // the reported state: the child is the active folder
  const btn = document.querySelector(q(a.outer) + ' > .flabel .fmodes button[data-m="pack"]'); const b = btn.getBoundingClientRect();
  const under = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  const tab = document.querySelector(q(a.outer) + ' > .flabel .ftab').getBoundingClientRect();
  const innerTab = document.querySelector(q(a.inner) + ' > .flabel .ftab').getBoundingClientRect();
  const overlap = innerTab.left < b.right && b.left < innerTab.right && innerTab.top < b.bottom && b.top < innerTab.bottom;
  const C = window.__canvas, S = C.S, sc = Object.values(S.nodes).find(n => n.name === 'scratch'), ou = S.nodes[a.outer];
  return { ...a, bx: b.left + b.width / 2, by: b.top + b.height / 2, tx: tab.left + 10, ty: tab.top + tab.height / 2, overlap, underBefore: under?.closest('.frame')?.dataset.id, z: S.cam.z };
}, nest);
await p.mouse.move(nest.tx, nest.ty); await sleep(150); await p.mouse.move(nest.bx, nest.by); await sleep(150);
const nestHover = await p.evaluate(a => document.elementFromPoint(a.bx, a.by)?.closest('.frame')?.dataset.id, nest);
check('hovering the parent tab raises its buttons above the nested tab', (!nest.overlap || nest.underBefore !== nest.outer) && nestHover === nest.outer, JSON.stringify({ nest, nestHover }));
await p.mouse.click(nest.bx, nest.by); await sleep(300);
check('the raised button works (parent switched to pack)', await p.evaluate(a => window.__canvas.S.nodes[a.outer].mode === 'pack', nest));
await p.evaluate(a => window.__canvas.setMode(window.__canvas.S.nodes[a.outer], 'free', true), nest);
// packages: Tab folds the active folder to its tab, Tab unfolds; Shift-Tab folds the others on the level
let pk = await p.evaluate(() => { const C = window.__canvas, S = C.S; const f = Object.values(S.nodes).find(n => n.name === 'scratch'); if (f.mode === 'stack') C.setMode(f, 'free', true); C.jumpNode(f, 0.6); return { id: f.id, mode: f.mode || 'free', w: f.w, h: f.h }; });
await sleep(800); await p.keyboard.press('Tab'); await sleep(300);
let pk2 = await p.evaluate(a => { const f = window.__canvas.S.nodes[a.id]; const el = document.querySelector(`.frame[data-id="${a.id}"]`); return { mode: f.mode, packed: !!f.packed, h: f.h, cls: el.classList.contains('packed'), deckHidden: el.querySelector('.deck').hidden, tree: [...document.querySelectorAll('#tp-list .tp-row')].some(r => r.textContent.includes('package of')) }; }, pk);
check('Tab folds the active folder into a package', pk2.mode === 'stack' && pk2.packed && pk2.h <= 12 && pk2.cls && pk2.deckHidden && pk2.tree, JSON.stringify(pk2));
await p.keyboard.press('Tab'); await sleep(500);
pk2 = await p.evaluate(a => { const f = window.__canvas.S.nodes[a.id]; return { mode: f.mode || 'free', packed: !!f.packed, w: f.w, h: f.h }; }, pk);
check('Tab again unfolds to the previous mode and size', pk2.mode === pk.mode && !pk2.packed && pk2.w === pk.w && pk2.h === pk.h, JSON.stringify({ pk, pk2 }));
await p.keyboard.press('Shift+Tab'); await sleep(400);
pk2 = await p.evaluate(a => { const C = window.__canvas, S = C.S; const top = Object.values(S.nodes).filter(n => n.kind === 'frame' && !n.in); return { me: S.nodes[a.id].mode || 'free', othersPacked: top.filter(f => f.id !== a.id).every(f => f.mode === 'stack' && f.packed), n: top.length }; }, pk);
check('Shift-Tab packages the other top-level folders and keeps the active one open', pk2.me !== 'stack' && pk2.othersPacked && pk2.n >= 3, JSON.stringify(pk2));
await p.keyboard.press('Shift+Tab'); await sleep(400);
pk2 = await p.evaluate(() => { const S = window.__canvas.S; return Object.values(S.nodes).filter(n => n.kind === 'frame' && !n.in).every(f => f.mode !== 'stack'); });
check('Shift-Tab again unfolds them all', pk2);
// boundaries: a folder dropped onto another inside a free folder pushes it aside, tab included; unfolding pushes neighbours
let sep = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const outer = Object.values(S.nodes).find(n => n.name === 'canvas-workbench'), inner = Object.values(S.nodes).find(n => n.name === 'machines'), lab = Object.values(S.nodes).find(n => n.name === 'homelab');
  C.setMode(outer, 'free', true); if (lab.mode === 'stack') C.setMode(lab, 'free', true); C.jumpNode(outer, 0.5);
  // drop homelab exactly onto machines
  C.adopt(lab, outer, { x: inner.x + 40, y: inner.y + 40 });
  const dx = inner.x + 30 - lab.x, dy = inner.y + 30 - lab.y; for (const m of [lab, ...Object.values(S.nodes).filter(n => n.in === lab.id)]) { m.x += dx; m.y += dy; }
  C.adopt(lab, outer, { x: lab.x + 10, y: lab.y + 10 });
  const ov = (A, B) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  const A = C.footprint(inner), B = C.footprint(lab);
  const kids = C.kidsOf(outer.id);
  const inside = kids.every(k => k.x >= outer.x && k.x + k.w <= outer.x + outer.w && k.y + k.h <= outer.y + outer.h);
  let pairs = 0; for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (ov(C.footprint(kids[i]), C.footprint(kids[j]))) pairs++;
  return { overlap: ov(A, B), pairs, inside, labIn: lab.in === outer.id, n: kids.length };
});
check('a folder dropped onto another is pushed aside (tabs included) and the parent grows', !sep.overlap && sep.pairs === 0 && sep.inside && sep.labIn && sep.n >= 4, JSON.stringify(sep));
sep = await p.evaluate(() => {
  const C = window.__canvas, S = C.S;
  const lab = Object.values(S.nodes).find(n => n.name === 'homelab'), outer = S.nodes[lab.in];
  C.packFold(lab); // package it, then park a page right under the package where the open folder will be
  const page = C.kidsOf(outer.id).find(k => k.kind === 'buffer'); const px = page.x, py = page.y;
  page.x = lab.x + 20; page.y = lab.y + 60; C.adopt(page, outer, { x: page.x + 5, y: page.y + 5 });
  C.unfold(lab);
  const ov = (A, B) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  return { overlap: ov(C.footprint(lab), C.footprint(page)), mode: lab.mode || 'free', moved: page.x !== lab.x + 20 || page.y !== lab.y + 60 };
});
check('unfolding a package pushes what sat in its place', !sep.overlap && sep.mode !== 'stack', JSON.stringify(sep));
sep = await p.evaluate(() => { const C = window.__canvas; C.CMDS.find(c => c.l.startsWith('Layout: keep a boundary')).run(); const off = C.S.noOverlap === false; C.CMDS.find(c => c.l.startsWith('Layout: keep a boundary')).run(); return { off, on: C.S.noOverlap !== false }; });
// a real mouse drag of a folder tab onto another folder: it lands inside, and nothing overlaps at any level afterwards
const noOverlapAnywhere = () => p.evaluate(() => {
  const C = window.__canvas, S = C.S; const ov = (A, B) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  const levels = [null, ...Object.values(S.nodes).filter(n => n.kind === 'frame' && (n.mode || 'free') === 'free' && !C.stashed(n))];
  const bad = [];
  for (const f of levels) { const items = Object.values(S.nodes).filter(n => (n.in || null) === (f ? f.id : null) && !C.stashed(n)); for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (ov(C.footprint(items[i]), C.footprint(items[j]))) bad.push((f ? f.name : '/') + ': ' + items[i].name + ' × ' + items[j].name); }
  return bad;
});
let dr = await p.evaluate(() => {
  const C = window.__canvas, S = C.S; const outer = Object.values(S.nodes).find(n => n.name === 'canvas-workbench'), inner = Object.values(S.nodes).find(n => n.name === 'machines'), lab = Object.values(S.nodes).find(n => n.name === 'homelab');
  C.setMode(outer, 'free', true); if (lab.mode === 'stack') C.setMode(lab, 'free', true); C.adopt(lab, null, null, true); C.moveTree(lab, outer.x - lab.w - 300 - lab.x, inner.y - lab.y); C.separateAll(); C.jumpNode(lab, 0.3);
  return { lab: lab.id, inner: inner.id };
});
await sleep(900);
const bad0 = await noOverlapAnywhere();
dr = await p.evaluate(a => { const r = document.querySelector(`.frame[data-id="${a.lab}"] > .flabel .ftab`).getBoundingClientRect(); const t = document.querySelector(`.frame[data-id="${a.inner}"]`).getBoundingClientRect(); return { ...a, sx: r.left + r.width / 2, sy: r.top + r.height / 2, tx: t.left + t.width * .6, ty: t.top + t.height * .6 }; }, dr);
await p.mouse.move(dr.sx, dr.sy); await p.mouse.down(); await p.mouse.move(dr.sx + 20, dr.sy + 20, { steps: 3 }); await p.mouse.move(dr.tx, dr.ty, { steps: 8 }); await p.mouse.up(); await sleep(400);
let bad = await noOverlapAnywhere();
const where = await p.evaluate(a => window.__canvas.S.nodes[a.lab].in && window.__canvas.S.nodes[window.__canvas.S.nodes[a.lab].in].name, dr);
check('dragging a folder tab onto another folder: it lands inside and nothing overlaps on any level', bad.length === 0 && where === 'machines', JSON.stringify({ bad0, bad, where: where || null, dr }));
// a board saved with overlaps gets cleaned on load
dr = await p.evaluate(() => { const C = window.__canvas, S = C.S; const a = Object.values(S.nodes).filter(n => !n.in && n.kind !== 'frame')[0], f = Object.values(S.nodes).find(n => n.kind === 'frame' && !n.in); C.SEP.off++; C.moveTree(a, f.x + 10 - a.x, f.y + 10 - a.y); C.SEP.off--; return C.separateAll(); });
bad = await noOverlapAnywhere();
check('separateAll cleans an overlapping board', dr > 0 && bad.length === 0, JSON.stringify({ dr, bad }));
check('boundary toggle in the palette', sep.off && sep.on, JSON.stringify(sep));
check('i3 neighbour picks the node to the right, none to the left of the leftmost', v10.right && v10.leftNone, JSON.stringify(v10));
// ---- v11: cascading folder modes and the process perspective (demo mode)
st = await p.evaluate(() => { const C = window.__canvas, S = C.S, f = S.nodes.fCW, inner = S.nodes.fMach;
  C.setModeCascade(f, 'tile'); const a = [f.mode, inner.mode];
  document.querySelector('.frame[data-id="fCW"] .fmodes button[data-m="pack"]').dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })); const b = [f.mode, inner.mode];
  C.setMode(f, 'free'); const c = [f.mode, inner.mode];
  C.setModeCascade(f, 'free'); const d = [f.mode, inner.mode];
  return { a, b, c, d }; });
check('cascade applies a mode to the nested folders too (call, Shift-click); a plain click does not', st.a.join() === 'tile,tile' && st.b.join() === 'pack,pack' && st.c.join() === 'free,pack' && st.d.join() === 'free,free', JSON.stringify(st));
st = await p.evaluate(() => { const C = window.__canvas, S = C.S; const frames = Object.values(S.nodes).filter(n => n.kind === 'frame').map(f => [f.id, f.in || null, f.mode]); const snapIn = Object.fromEntries(Object.values(S.nodes).map(n => [n.id, n.in || null])); const pos = Object.fromEntries(Object.values(S.nodes).map(n => [n.id, [n.x, n.y, n.w, n.h]]));
  C.perspSet('process');
  const derived = Object.values(S.nodes).filter(n => n.kind === 'frame').map(f => ({ owner: f.owner, derived: f.derived, kids: C.kidsOf(f.id).map(k => k.id).sort().join() }));
  const manualGone = frames.every(([id]) => !S.nodes[id]), dim = document.querySelectorAll('.node.persp-dim').length, chip = !!document.querySelector('#persp-chip'), persp = S.persp;
  const refused = (() => { const build = S.nodes.build, pf = Object.values(S.nodes).find(f => f.owner === 'calc'); C.adopt(build, pf, null, true); return build.in !== pf.id; })();
  C.perspSet('manual');
  const back = frames.every(([id, inn, mode]) => S.nodes[id] && (S.nodes[id].in || null) === inn && S.nodes[id].mode === mode), inOk = Object.values(S.nodes).every(n => (n.in || null) === snapIn[n.id]), posOk = Object.values(S.nodes).every(n => JSON.stringify([n.x, n.y, n.w, n.h]) === JSON.stringify(pos[n.id])), noDerived = !Object.values(S.nodes).some(n => n.derived) && !document.querySelector('#persp-chip') && !S.manual;
  return { derived, manualGone, dim, chip, persp, refused, back, inOk, posOk, noDerived }; });
check('process perspective derives a folder per spawning shell, nested as the spawn tree', st.persp === 'process' && st.manualGone && st.chip && st.dim > 0 && st.derived.some(d => d.owner === 'ops' && d.derived === 'process' && d.kids === 'build,logs,ops') && st.derived.some(d => d.owner === 'calc' && d.kids === 'calc,whatif'), JSON.stringify(st));
check('a drop into a derived folder is refused; back to manual restores folders, membership and positions exactly', st.refused && st.back && st.inOk && st.posOk && st.noDerived, JSON.stringify(st));
// ---- v11 step 2: the filesystem perspective (demo mode, seed filesystem)
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = ms => new Promise(r => setTimeout(r, ms));
  C.perspSet('fs');
  const frames = () => Object.values(S.nodes).filter(n => n.kind === 'frame' && n.derived === 'fs').map(f => [f.fsPath, f.in ? S.nodes[f.in].fsPath : null, C.kidsOf(f.id).map(k => k.name).sort().join()]);
  const a = frames(), home = Object.values(S.nodes).find(f => f.derived === 'fs' && f.fsPath === '/home/me');
  const listed = await C.fsExpand(home), listedAgain = await C.fsExpand(home);
  const ghosts = Object.values(S.nodes).filter(n => n.kind === 'ghost').map(g => g.name + (g.dir ? '/' : '') + (g.link ? '→' + g.link : '')).sort();
  const edges0 = C.PERSP.edges.length;
  C.ghostOpen(Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === 'projects')); await sl(50);
  C.ghostOpen(Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === 'canvas')); await sl(50);
  const edges = C.PERSP.edges.map(e => S.nodes[e.from]?.name + '>' + S.nodes[e.to]?.fsPath), proj = Object.values(S.nodes).find(f => f.derived === 'fs' && f.fsPath === '/home/me/projects');
  const sh = Object.values(S.nodes).find(n => n.kind === 'term' && n.backend !== 'pty' && !n.emacs && S.nodes[n.in]?.fsPath === '/home/me'); C.adopt(sh, proj, null, true); const shIn = S.nodes[sh.in]?.fsPath, cwd = sh.cwd;
  C.adopt(Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === 'todo.txt'), proj, null, true);
  return { a, listed, listedAgain, ghosts, edges0, edges, shIn, cwd, asked: !document.querySelector('#ask').hidden && document.querySelector('#ask-label').textContent }; });
check('filesystem perspective: directory folders nested by path, shells in their cwd', st.a.some(([pth, inn, kids]) => pth === '/home/me' && inn === null && kids.includes('sh')) && st.a.some(([pth, inn, kids]) => pth === '/home/me/projects/canvas' && inn === '/home/me/projects' && kids === 'build,ops'), JSON.stringify(st.a));
check('listing a directory makes ghost cards once; a symlink ghost gets a dashed edge when its target is on the board', st.listed === 3 && st.listedAgain === 0 && st.ghosts.join() === 'canvas-readme.md,notes/→/home/me/projects/canvas,todo.txt' && st.edges0 === 1 && st.edges.join() === 'notes>/home/me/projects/canvas', JSON.stringify(st));
check('dropping a shell into a directory is cd; dropping a file asks before mv', st.shIn === '/home/me/projects' && st.cwd === '/home/me/projects' && String(st.asked).startsWith('Move /home/me/todo.txt into /home/me/projects?'), JSON.stringify(st));
await p.fill('#ask-in', 'yes'); await p.keyboard.press('Enter'); await sleep(300);
st = await p.evaluate(() => { const C = window.__canvas, S = C.S; const gf = Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === 'todo.txt'); const moved = !!S.fs.c.home.c.me.c.projects.c['todo.txt'] && !S.fs.c.home.c.me.c['todo.txt'] && gf.path === '/home/me/projects/todo.txt' && S.nodes[gf.in].fsPath === '/home/me/projects';
  const page = C.ghostOpen(gf), pageIn = S.nodes[page.in]?.fsPath, text = page.text, ghostGone = !Object.values(S.nodes).some(n => n.kind === 'ghost' && n.name === 'todo.txt');
  C.perspSet('manual'); const clean = !Object.values(S.nodes).some(n => n.kind === 'ghost' || n.derived) && !C.PERSP.edges.length && !document.querySelector('.node.k-ghost'); C.removeNode(page.id); return { moved, pageIn, text, ghostGone, clean }; });
check('mv after the confirm; opening a ghost file makes it real in place; back to manual clears ghosts and derived folders', st.moved && st.pageIn === '/home/me/projects' && st.text.startsWith('buy pens') && st.ghostGone && st.clean, JSON.stringify(st));
// ---- v12: addresses, one navigator over every relation, the hash, the tag perspective
st = await p.evaluate(async ({ y, ym }) => { const C = window.__canvas, S = C.S; await C.notesLoad(true);
  const addrs = ['fCW', 'fMach', 'build'].map(id => C.addrOf(S.nodes[id]));
  const res = Object.fromEntries(['board:/canvas-workbench/machines', 'fs:~', 'tag:agent', 'note:hosts', 'journal:' + ym, 'link:hosts', 'proc:@x/1', 'bogus'].map(a => { const r = C.resolveAddr(a); return [a, r.error ? 'ERR' : r.key + '|' + r.addr + '|' + r.entries.length]; }));
  const root = C.rgEntries('root').map(e => e.name), tags = C.rgEntries('tag:').map(e => e.name + ':' + e.meta), agent = C.rgEntries('tag:agent').map(e => e.name);
  const notes = C.rgEntries('note:').map(e => e.name + ':' + e.meta), plans = C.rgEntries(C.addrToKey('note:plans')).map(e => e.kind + ':' + e.name.trim());
  const journal = [C.rgEntries('journal:').map(e => e.name).join(), C.rgEntries('journal:' + y).map(e => e.name).join(), C.rgEntries('journal:' + ym).map(e => e.name).join()];
  const links = C.rgEntries('link:').map(e => e.name + ':' + e.meta), lh = C.rgEntries('link:hosts').map(e => e.name + ':' + e.kind);
  C.goAddr('tag:agent'); const v1 = C.RG.dir + ' ' + location.hash;
  C.setView('canvas'); C.goAddr('board:/canvas-workbench/machines'); const v2 = location.hash + ' ' + document.body.dataset.view;
  const ls = await C.AGENT_TOOLS.find(t => t.name === 'list_addr').run({ addr: 'journal:' + ym });
  const cd = await C.AGENT_TOOLS.find(t => t.name === 'cd_shell').run({ addr: 'fs:/home/me/projects', shell: 'sh' });
  return { addrs, res, root, tags, agent, notes, plans, journal, links, lh, v1, v2, ls, cd }; }, { y: Y, ym: YM.replace('-', '/') });
check('addresses: board paths; resolve finds folders, files, tags, notes, journal days and links; reserved and bogus refused', st.addrs.join() === 'board:/canvas-workbench,board:/canvas-workbench/machines,board:/canvas-workbench/machines/build' && st.res['board:/canvas-workbench/machines'].startsWith('fMach|') && +st.res['fs:~'].split('|')[2] >= 2 && st.res['tag:agent'] === 'tag:agent|tag:agent|1' && st.res['note:hosts'].startsWith('note:hosts|note:hosts|') && st.res['journal:' + YM.replace('-', '/')].endsWith('|1') && st.res['link:hosts'].endsWith('|1') && st.res['proc:@x/1'] === 'ERR' && st.res['bogus'] === 'ERR', JSON.stringify(st.res));
check('navigator root lists every relation; tag, note, journal and link trees list', st.root.slice(-8).join() === '# tags,¶ notes,▦ journal,⇄ links,⌗ tmux,⚙ processes,⊙ units,! attention' && st.tags.join() === '#agent:1' && st.agent.join() === 'claude' && st.notes.some(x => x.startsWith('plans:')) && st.plans.length > 0 && st.plans.every(x => x.startsWith('iblock:')) && st.journal.join('|') === `${Y}|${YM}|${DAY}` && st.links.some(x => x.startsWith('hosts:')) && st.lh.join() === 'pi:ghost', JSON.stringify(st));
check('goAddr opens the navigator or the canvas and writes the hash; wb-style ls and cd work', st.v1 === 'tag:agent #tag:agent' && st.v2 === '#board:/canvas-workbench/machines canvas' && st.ls.includes('journal:' + DAYP) && st.cd === 'sh: cd /home/me/projects', JSON.stringify({ v1: st.v1, v2: st.v2, ls: st.ls, cd: st.cd }));
await p.goBack(); await sleep(500);
st = await p.evaluate(() => [location.hash, window.__canvas.RG.dir, document.body.dataset.view || null]);
check('browser back returns to the previous address', st[0] === '#tag:agent' && st[1] === 'tag:agent', JSON.stringify(st));
st = await p.evaluate(() => { const C = window.__canvas, S = C.S; C.setView('canvas'); C.perspSet('tag'); const fr = () => Object.values(S.nodes).filter(n => n.derived === 'tag').map(f => [f.tag, f.in ? S.nodes[f.in].tag : null, C.kidsOf(f.id).map(k => k.name + (k.alias ? '*' : '')).sort().join()]);
  const a = fr(); const n = S.nodes.build; C.setTags(n, ['grc/vocab', 'agent']); C.perspRebuild(); const b = fr();
  const copy = Object.values(S.nodes).find(x => x.kind === 'ghost' && x.alias === 'build'), copyAddr = C.addrOf(copy), buildAddr = C.addrOf(n);
  const agentF = Object.values(S.nodes).find(f => f.derived === 'tag' && f.tag === 'agent'), sh = Object.values(S.nodes).find(x => x.name === 'sh' && x.kind === 'term'); C.adopt(sh, agentF, null, true); const shTags = C.tagsOf(sh);
  C.perspSet('manual'); const clean = !Object.values(S.nodes).some(x => x.derived || x.kind === 'ghost'); C.setTags(n, ['grc/vocab', 'agent'], { remove: true }); C.setTags(sh, ['agent'], { remove: true });
  return { a, b, copyAddr, buildAddr, shTags, clean }; });
check('tag perspective: one folder per tag nested by /, the node under its first tag, a copy under the others; drop into a tag folder tags; back to manual is clean', st.a.length === 1 && st.a[0][0] === 'agent' && st.b.some(([t, inn, k]) => t === 'grc/vocab' && inn === 'grc' && k === 'build') && st.b.some(([t, , k]) => t === 'agent' && k === 'build*,claude') && st.copyAddr === 'board:/canvas-workbench/machines/build' && st.buildAddr === st.copyAddr && st.shTags.includes('agent') && st.clean, JSON.stringify(st));
// ---- v14 demo: the host's own trees (seeded), the status line, the Attention query, hard links and mounts
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = ms => new Promise(r => setTimeout(r, ms));
  const roots = C.rgEntries('proc:').map(e => e.name), kids = C.rgEntries('proc:800').map(e => [e.name, !!e.n, e.meta]);
  const units = C.rgEntries('unit:').map(e => e.name), uprocs = C.rgEntries('unit:caddy.service').map(e => e.name);
  const r1 = C.resolveAddr('proc:/800'), r2 = C.resolveAddr('unit:/postgresql.service'), k = C.addrToKey('proc:@nohost/1'), parent = C.rgParent('proc:1000'), ulabel = C.keyToAddr('unit:caddy.service');
  C.perspSet('proc', true); await sl(100);
  const pf = Object.values(S.nodes).filter(f => f.kind === 'frame' && f.derived === 'proc').map(f => [f.name, C.kidsOf(f.id).map(x => x.kind + ':' + x.name.replace(/^[· ]+/, '')).join('|')]);
  const dimmed = Object.values(S.nodes).filter(n => n.kind === 'buffer' && C.live[n.id]?.el.classList.contains('persp-dim')).length;
  C.perspSet('unit', true); await sl(100);
  const uf = Object.values(S.nodes).filter(f => f.kind === 'frame' && f.derived === 'unit').map(f => [f.name, C.tagsOf(f).join(), C.kidsOf(f.id).length, C.kidsOf(f.id).filter(x => x.kind === 'ghost' && x.unitState === 'failed').map(x => x.name).join()]);
  const failedGhost = Object.values(S.nodes).find(x => x.kind === 'ghost' && x.unitState === 'failed'), gaddr = failedGhost && C.addrOf(failedGhost);
  C.perspSet('manual', true);
  C.statusRender(); const stc = [...document.querySelectorAll('#st-host .stc')].map(b => b.textContent + (b.classList.contains('bad') ? '!' : ''));
  const attn = C.rgEntries('attn:').map(e => e.name), wbls = (await C.AGENT_TOOLS.find(t => t.name === 'list_addr').run({ addr: 'attn:' })).split('\n'), would = await C.AGENT_TOOLS.find(t => t.name === 'unit_control').run({ unit: 'unit:/caddy.service', verb: 'restart' }), did = await C.AGENT_TOOLS.find(t => t.name === 'unit_control').run({ unit: 'caddy.service', verb: 'restart', confirm: true });
  return { roots, kids, units, uprocs, r1: r1.error || r1.addr, r2: r2.error || r2.addr, k, parent, ulabel, pf, dimmed, uf, gaddr, stc, attn, wbls, would, did }; });
check('proc: and unit: in the navigator: process tree with the card marked, units failed first with their processes; addresses resolve', st.roots.includes('systemd 1') && st.kids.some(([n, hasN, m]) => n === 'bash 1000' && hasN && /card /.test(m)) && st.units[0] === '✗ postgresql.service' && st.uprocs.join() === 'caddy 611' && st.r1 === 'proc:/800' && st.r2 === 'unit:/postgresql.service' && st.k === null && st.parent === 'proc:800' && st.ulabel === 'unit:/caddy.service', JSON.stringify(st));
check('processes perspective: each shell in a folder with its OS processes as ghosts; units perspective: a folder per host with unit ghosts, shells under their unit', st.pf.some(([n, k]) => k.startsWith('term:') && /ghost:node 1002\|ghost:chromium 1003/.test(k)) && st.pf.length >= 3 && st.dimmed > 0 && st.uf.some(([n, t, c, f]) => n === 'units' && f === 'postgresql.service' && c >= 5) && st.uf.some(([n, t, c]) => n === 'workbench.service' && t.includes('active') && c >= 1) && st.gaddr === 'unit:/postgresql.service', JSON.stringify({ pf: st.pf, uf: st.uf, dimmed: st.dimmed, gaddr: st.gaddr }));
check('status line counts (failed units red) and the Attention query with one address per item; unit control asks for a confirm', st.stc.includes('✗ 1!') && st.stc.some(x => /^✦ \d/.test(x)) && st.attn.includes('postgresql.service failed') && st.wbls.some(l => l.startsWith('unit:/postgresql.service')) && /^would restart caddy.service/.test(st.would) && /^restart caddy.service: ok/.test(st.did), JSON.stringify({ stc: st.stc, attn: st.attn, wbls: st.wbls, would: st.would, did: st.did }));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = ms => new Promise(r => setTimeout(r, ms));
  C.perspSet('fs', true); const home = Object.values(S.nodes).find(f => f.derived === 'fs' && f.fsPath === '/home/me'); await C.fsExpand(home);
  const g1 = Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === 'canvas-readme.md'), ghost1 = g1 && [g1.nlink, g1.hardlink || null, C.live[g1.id].body.textContent];
  const frameAt = p => Object.values(S.nodes).find(f => f.kind === 'frame' && f.derived === 'fs' && f.fsPath === p), ghostAt = nm => Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === nm);
  if (!frameAt('/home/me/projects')) { C.ghostOpen(ghostAt('projects')); await sl(50); }
  if (!frameAt('/home/me/projects/canvas')) { C.ghostOpen(ghostAt('canvas')); await sl(50); } else await C.fsExpand(frameAt('/home/me/projects/canvas'));
  const g2 = ghostAt('README.md'), ghost2 = g2 && [g2.nlink, g2.hardlink === g1?.id, C.live[g2.id].body.textContent];
  const edges = C.PERSP.edges.filter(e => e.type === 'hardlink').map(e => S.nodes[e.from]?.name + '>' + S.nodes[e.to]?.name);
  const mnt = C.fsFrameFor('', '/mnt', { x: 3000, y: 3000 }); await C.fsExpand(mnt); const gm = Object.values(S.nodes).find(n => n.kind === 'ghost' && n.name === 'data'), gmount = gm && [gm.mount, C.live[gm.id].body.textContent];
  const d = C.ghostOpen(gm); await sl(50); const mounted = d && [d.mount, C.live[d.id].el.classList.contains('d-mount')];
  const rows = C.rgEntries('fs:/mnt').map(e => e.name + ':' + e.meta).concat(C.rgEntries('fs:/home/me').filter(e => e.meta).map(e => e.name + ':' + e.meta));
  C.perspSet('manual', true);
  return { ghost1, ghost2, edges, gmount, mounted, rows }; });
check('filesystem perspective: hard links are ghosts with a dashed edge to the other name (one inode); mount points carry a badge', st.ghost1?.[0] === 2 && st.ghost1[1] === null && /×2/.test(st.ghost1[2]) && st.ghost2?.[0] === 2 && st.ghost2[1] === true && /also \/home\/me\/canvas-readme.md/.test(st.ghost2[2]) && st.edges.join() === 'README.md>canvas-readme.md' && st.gmount?.[0] === true && /⛁/.test(st.gmount[1]) && st.mounted?.[0] === true && st.mounted[1] && st.rows.includes('data:mount') && st.rows.includes('canvas-readme.md:hardlink ×2'), JSON.stringify(st));
// ---- v18 (tab backgrounds cut off on small items; ⊞ again cycles aspect ratios, the screen's first)
st = await p.evaluate(() => { const C = window.__canvas, LH = 32;
  const f = C.addNode({ kind: 'frame', name: 'aspect', mode: 'free', shape: 'folder', x: 6000, y: 6000, w: 900, h: 400 });
  [0, 1, 2].forEach(i => C.addNode({ kind: 'term', backend: 'fake', name: 'a' + i, env: {}, in: f.id, x: 6000 + 40 + i * 250, y: 6060, w: 200, h: 140 }));
  const area0 = 900 * (400 + LH);
  C.setMode(f, 'tile', true); const r = { first: f.aspect, ratio: f.w / (f.h + LH), want: C.screenAspect(), area: f.w * (f.h + LH) / area0, fid: f.id };
  document.querySelector(`.frame[data-id="${f.id}"] .fmodes button[data-m="tile"]`).click(); r.second = f.aspect; r.r2 = f.w / f.h;
  C.setMode(f, 'tile', true); r.third = f.aspect; r.r3 = f.w / f.h; r.areaKept = f.w * f.h / (f.w * (f.h + LH)) > 0.9;
  r.panes = C.kidsOf(f.id).every(k => k.x >= f.x && k.x + k.w <= f.x + f.w + 1 && k.y + k.h <= f.y + f.h + 1);
  for (let i = 0; i < C.ASPECTS.length - 2; i++) C.setMode(f, 'tile', true); r.wrapped = f.aspect;
  C.setMode(f, 'pack', true); r.afterPack = f.aspect; C.setMode(f, 'tile', true); r.again = f.aspect;
  r.before = [f.w, f.h]; C.wsEnter(f, true); r.after = [f.w, f.h]; r.grown = f.w > r.before[0] && f.h > r.before[1] && f.w / (f.h + LH) > r.ratio - 0.02 && f.w / (f.h + LH) < r.ratio + 0.02; return r; });
await sleep(600);
{ const ws = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid], c = C.S.cam, a = C.camArea(); const r = { fillW: c.z * f.w / (a.vw * 0.88), fillH: c.z * (f.h + 32) / (a.vh * 0.86) }; C.wsLeave(); return r; }, st);
  check('⊞ on a folder tiles it in the screen\'s ratio keeping its area; ⊞ again (click or setMode) cycles 16:9, 3:2 … and wraps to screen; pack forgets the ratio; Enter grows it to the screen and fills the view with it', st.grown && st.first === 'screen' && Math.abs(st.ratio - st.want) < 0.02 && Math.abs(st.area - 1) < 0.05 && st.second === '16:9' && Math.abs(st.r2 - 16 / 9) < 0.02 && st.third === '3:2' && Math.abs(st.r3 - 1.5) < 0.02 && st.panes && st.wrapped === 'screen' && st.afterPack === undefined && st.again === 'screen' && Math.abs(ws.fillW - 1) < 0.02 && Math.abs(ws.fillH - 1) < 0.02, JSON.stringify({ st, ws })); }
await sleep(500);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; C.jumpFolder(f); const r = {};
  const fe = document.querySelector(`.frame[data-id="${fid}"]`), tab = fe.querySelector('.ftab'), k = C.kidsOf(fid)[0], ne = document.querySelector(`.node[data-id="${k.id}"]`);
  const measure = () => { const a = fe.getBoundingClientRect(), b = tab.getBoundingClientRect(), hb = ne.querySelector('.hdr').getBoundingClientRect(), bt = ne.querySelector('.hdr .btns').getBoundingClientRect(); return { fw: a.width, tw: b.width, modes: getComputedStyle(fe.querySelector('.fmodes')).display, tags: getComputedStyle(ne.querySelector('.hdr .tags')).display, btnsIn: bt.right <= hb.right + 1, cls: [fe.classList.contains('t-tiny'), ne.classList.contains('t-tiny')] }; };
  C.S.cam.z = 1; C.applyCam(); r.z1 = measure();
  C.zoomAt(innerWidth / 2, innerHeight / 2, 0.15); r.far = measure(); r.z = C.S.cam.z;
  C.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 0.15); r.back = measure(); r.fid = fid; return r; }, st);
check('a tab never runs past its folder: zoomed far out the tab is at most the folder\'s width, the mode buttons go (t-tiny), and a card\'s header keeps its buttons inside and drops its tags; zooming back restores both', st.z1.tw <= st.z1.fw + 2 && st.z1.modes !== 'none' && !st.z1.cls[0] && st.far.tw <= st.far.fw + 2 && st.far.modes === 'none' && st.far.tags === 'none' && st.far.btnsIn && st.far.cls.every(Boolean) && st.back.modes !== 'none' && st.back.tags !== 'none' && !st.back.cls[0], JSON.stringify(st));
await p.evaluate(({ fid }) => { const C = window.__canvas; C.S.cam.z = 1; C.applyCam(); C.jumpFolder(C.S.nodes[fid]); }, st); await sleep(300);

// ---- v19.1 ("no intuitive way to unfocus from a node, all other aggregators are hidden. What do I even press?")
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = ms => new Promise(r => setTimeout(r, ms));
  const tops = Object.values(S.nodes).filter(n => n.kind === 'frame' && !n.in); const f = tops[0], g = tops[1];
  C.wsEnter(f, true); await sl(50);
  const bar = document.querySelector('#ws-bar'); const r = { barShown: !bar.hidden, name: document.querySelector('#ws-name').textContent, wsCur: document.querySelector(`.frame[data-id="${f.id}"]`).classList.contains('ws-cur'), fws: !!document.querySelector(`.frame[data-id="${f.id}"] .fws`), outsideG: document.querySelector(`.frame[data-id="${g.id}"]`).classList.contains('outside') };
  document.querySelector('#ws-up').click(); r.afterLeave = C.WS.cur; r.barHidden = bar.hidden;
  document.querySelector(`.frame[data-id="${f.id}"] .fws`).click(); r.viaTab = C.WS.cur === f.id;
  document.querySelector(`.frame[data-id="${g.id}"] .fgrid`).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 7, pointerType: 'mouse', clientX: 10, clientY: 10 }));
  await sl(50); r.afterClickOutside = C.WS.cur; r.wentThere = document.querySelector(`.frame[data-id="${g.id}"]`).classList.contains('active');
  return r; });
check('workspace: a bar at the top names it with a ⇱ Leave button that works; ⌂ on the tab enters; the other folders are dimmed and a click on one leaves the workspace and activates it', st.barShown && st.name.includes('⌂') && st.wsCur && st.fws && st.outsideG && st.afterLeave === null && st.barHidden && st.viaTab && st.afterClickOutside === null && st.wentThere, JSON.stringify(st));

// ---- v19 (a rectangle selection to remove handwriting and nodes; the selection can become a node)
st = await p.evaluate(() => { const C = window.__canvas, S = C.S;
  const pg = C.addNode({ kind: 'page', name: 'selpage', x: 12000, y: 12000, w: 240, h: 140 });
  const mk = (x, y) => ({ id: 'tst' + x + '-' + y, color: 'ink', size: 4, sim: 0, owner: null, pts: [[x, y, .5], [x + 40, y + 10, .5], [x + 80, y, .5]] });
  S.strokes.push(mk(12400, 12000), mk(12400, 12040), mk(12400, 12080)); C.renderInk(null);
  const sh = C.addShape({ type: 'rect', x: 12400, y: 12200, w: 100, h: 60 });
  C.pickInRect({ x: 12380, y: 11980 }, { x: 12520, y: 12300 });   // the ink and the shape, not the page to the left
  const r = { strokes: C.SEL.strokes.size, shapes: C.SEL.shapes.size, nodes: C.PICKED.size, chip: !document.querySelector('#pick-chip').hidden, pickedPaths: document.querySelectorAll('path.stroke.picked').length, tool: !!document.querySelector('[data-tool="area"]'), sketchBtn: !document.querySelector('#pick-chip [data-act=sketch]').hidden };
  const n = C.sketchFromSelection(); r.sk = n && { kind: n.kind, owned: S.strokes.filter(s => s.owner === n.id).length, inside: S.strokes.filter(s => s.owner === n.id).every(s => s.pts.every(([x, y]) => x >= 0 && y >= 0 && x <= n.w && y <= n.h)), picked: C.PICKED.has(n.id), strokesLeft: C.SEL.strokes.size };
  C.pickClear(); C.pickInRect({ x: 11900, y: 11900 }, { x: 12700, y: 12400 });   // everything: the page, the sketch card, the shape
  r.all = { nodes: C.PICKED.size, shapes: C.SEL.shapes.size };
  C.removeSelection(); r.after = { page: !!S.nodes[pg.id], sketch: !!(n && S.nodes[n.id]), strokes: S.strokes.filter(s => s.id.startsWith('tst')).length, shape: S.shapes.some(s => s.id === sh.id), chip: !document.querySelector('#pick-chip').hidden };
  r.undo = C.removeUndo() && S.shapes.some(s => s.id === sh.id); C.removeSelection; S.shapes = S.shapes.filter(s => s.id !== sh.id);
  C.setTool?.('area'); r.cursorClass = document.querySelector('#viewport').classList.contains('tool-area'); C.setTool?.('select');
  return r; });
check('area selection: a rectangle picks the ink and the shape inside it (not the card outside) and shows the chip; Sketch card turns the ink into a sketch card owning the strokes; a bigger rectangle takes cards too and Delete removes all; Ctrl-Z brings the shape back; the ⬚ tool exists', st.strokes === 3 && st.shapes === 1 && st.nodes === 0 && st.chip && st.pickedPaths === 3 && st.tool && st.sketchBtn && st.sk && st.sk.kind === 'sketch' && st.sk.owned === 3 && st.sk.inside && st.sk.picked && st.sk.strokesLeft === 0 && st.all.nodes === 2 && st.all.shapes === 1 && !st.after.page && !st.after.sketch && st.after.strokes === 0 && !st.after.shape && !st.after.chip && st.undo && st.cursorClass, JSON.stringify(st));

// ---- v18.2 (▦): a packed folder is no wider than its rows
st = await p.evaluate(() => { const C = window.__canvas;
  const f = C.addNode({ kind: 'frame', name: 'packw', mode: 'free', shape: 'folder', x: 8000, y: 8000, w: 1600, h: 400 });
  const ks = [0, 1].map(i => C.addNode({ kind: 'term', backend: 'fake', name: 'p' + i, env: {}, in: f.id, x: 8000 + 40 + i * 300, y: 8060, w: 200, h: 140 }));
  const w0 = f.w; C.setMode(f, 'pack', true); const r = { w0, w: f.w, h: f.h, oneRow: new Set(ks.map(k => k.y)).size === 1, inside: ks.every(k => k.x >= f.x && k.x + k.w <= f.x + f.w) };
  C.setMode(f, 'tile', true); C.setMode(f, 'pack', true); r.w2 = f.w;   // from tile too
  C.setMode(f, 'pack', true); r.w3 = f.w;   // a second pack keeps it
  return r; });
check('pack shrinks the folder to its widest row plus padding instead of keeping its last mode\'s width; stable on re-pack; same from tile', st.w0 === 1600 && st.w === 200 + 24 + 200 + 56 && st.oneRow && st.inside && st.w2 === st.w && st.w3 === st.w, JSON.stringify(st));

// ---- v17.1 ("selected something in the graph and everything else is hidden"): Esc and ✕ clear the selection; the rest stays readable
await p.evaluate(() => { const C = window.__canvas; C.setView('graph'); });
await sleep(600);
st = await p.evaluate(() => { const C = window.__canvas; const id = [...C.G.N.keys()][0]; C.graphSelect?.(id); return { sel: C.G.sel, card: !document.querySelector('#g-card').hidden, x: !!document.querySelector('#g-card .gc-x'), hint: document.querySelector('#g-card .gc-hint')?.textContent || '' }; });
await p.keyboard.press('Escape'); await sleep(100);
const gs = await p.evaluate(() => { const C = window.__canvas; const r = { sel: C.G.sel, card: !document.querySelector('#g-card').hidden }; C.graphSelect([...C.G.N.keys()][0]); document.querySelector('#g-card .gc-x').click(); r.afterX = C.G.sel; C.setView('canvas'); return r; });
check('graph: a selection shows a card with ✕ and a hint; Esc clears it, so does ✕', st.sel && st.card && st.x && /Esc, ✕ or a click on empty space/.test(st.hint) && gs.sel === null && !gs.card && gs.afterX === null, JSON.stringify({ st, gs }));

// ---- v17 demo: spiral tiling, pane shares by dragging an edge, no ribbon ↔ tile ratchet, folder resize drives packing down to a stack
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S;
  const f = C.addNode({ kind: 'frame', name: 'tiles', mode: 'free', shape: 'folder', x: 4000, y: 4000, w: 800, h: 500 });
  const ks = [0, 1, 2, 3].map(i => C.addNode({ kind: 'term', backend: 'fake', name: 't' + i, env: {}, in: f.id, x: 4000 + 40 + i * 150, y: 4000 + 60, w: 200, h: 140 }));
  const rel = () => C.kidsOf(f.id).sort((a, b) => a.order - b.order).map(k => [k.name, k.x - f.x, k.y - f.y, k.w, k.h]);
  const size0 = [f.w, f.h]; C.setMode(f, 'tile', true); const tiled = rel(), sizeT = [f.w, f.h];
  const sizes = []; for (const m of ['free', 'tile', 'free', 'tile']) { C.setMode(f, m, true); sizes.push(f.w + 'x' + f.h); }
  const handles = ['.rs', '.rse', '.rsb'].map(h => !!document.querySelector(`.frame[data-id="${f.id}"] ${h}`) && !!document.querySelector(`.node[data-id="${ks[0].id}"] ${h}`));
  C.jumpNode(ks[0]); await new Promise(r => setTimeout(r, 400));
  return { fid: f.id, k0: ks[0].id, size0, sizeT, tiled, sizes, handles }; });
const tf = st;
check('tile is dwm\'s golden spiral: the first pane takes 0.618 of the width, the next 0.618 of the remaining height on the right, then inward; leaving and re-entering tile gives the same size; corner and edge handles exist on cards and folders', st.tiled[0][0] === 't0' && Math.abs(st.tiled[0][3] - Math.round((st.sizeT[0] - 24) * 0.618)) <= 1 && st.tiled[1][1] > st.tiled[0][3] && Math.abs(st.tiled[1][4] - Math.round((st.sizeT[1] - 24) * 0.618)) <= 1 && st.tiled[2][2] > st.tiled[1][4] && st.tiled[3][1] < st.tiled[2][1] && st.tiled[3][2] === st.tiled[2][2] && st.sizes[1] === st.sizes[3] && st.sizes[1] === st.sizeT.join('x') && st.sizes[0] === st.sizes[2] && st.handles.every(Boolean), JSON.stringify(st));
let rh = await p.evaluate(({ k0 }) => { const e = document.querySelector(`.node[data-id="${k0}"] .rse`).getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, tf);
await p.mouse.move(rh.x, rh.y); await p.mouse.down(); await p.mouse.move(rh.x + 60, rh.y, { steps: 5 }); await p.mouse.move(rh.x + 120, rh.y, { steps: 5 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid, k0 }) => { const C = window.__canvas, f = C.S.nodes[fid]; return { mfact: f.mfact, k0w: C.S.nodes[k0].w, fw: f.w, right: C.kidsOf(fid).filter(k => k.id !== k0).every(k => k.x >= C.S.nodes[k0].x + C.S.nodes[k0].w) }; }, tf);
check('dragging a tiled pane\'s right edge raises its share (mfact) and the folder retiles live, the other panes staying to its right', st.mfact > 0.7 && st.mfact < 0.85 && st.k0w > 0.7 * (st.fw - 24) && st.fw === tf.sizeT[0] && st.right, JSON.stringify(st));
await p.evaluate(({ fid }) => { const C = window.__canvas; C.setMode(C.S.nodes[fid], 'pack', true); C.jumpFolder(C.S.nodes[fid]); }, tf); await sleep(500);
let gh = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; const e = document.querySelector(`.frame[data-id="${fid}"] .rs`).getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2, w: f.w, h: f.h, kw: C.kidsOf(fid).map(k => k.w) }; }, tf);
await p.mouse.move(gh.x, gh.y); await p.mouse.down(); await p.mouse.move(gh.x - 100, gh.y - 60, { steps: 6 }); await p.mouse.move(gh.x - 200, gh.y - 120, { steps: 6 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; return { mode: f.mode, w: f.w, h: f.h, scale: f.packScale, kw: C.kidsOf(fid).map(k => [k.w, k.h, !!k.prePack]), inside: C.kidsOf(fid).every(k => k.x + k.w <= f.x + f.w + 1 && k.y + k.h <= f.y + f.h + 1) }; }, tf);
check('a packed folder dragged smaller keeps the dragged size: items re-flow and shrink together to fit (originals remembered)', st.mode === 'pack' && st.w < gh.w && st.scale > 0.35 && st.scale < 1 && st.kw.every(([w, h, p]) => w < 200 && p) && st.inside, JSON.stringify({ st, gh }));
gh = await p.evaluate(({ fid }) => { const e = document.querySelector(`.frame[data-id="${fid}"] .rs`).getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, tf);
await p.mouse.move(gh.x, gh.y); await p.mouse.down(); await p.mouse.move(gh.x - 300, gh.y - 200, { steps: 8 }); await p.mouse.move(gh.x - 600, gh.y - 400, { steps: 8 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; return { mode: f.mode, w: f.w, h: f.h, prev: f.prevMode, grip: getComputedStyle(document.querySelector(`.frame[data-id="${fid}"] .rs`)).display }; }, tf);
check('dragged below a deck\'s size the folder stacks, remembering pack; the deck keeps a grip', st.mode === 'stack' && st.w === 300 && st.prev === 'pack' && st.grip !== 'none', JSON.stringify(st));
gh = await p.evaluate(({ fid }) => { const e = document.querySelector(`.frame[data-id="${fid}"] .rs`).getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; }, tf);
await p.mouse.move(gh.x, gh.y); await p.mouse.down(); await p.mouse.move(gh.x + 200, gh.y + 150, { steps: 8 }); await p.mouse.move(gh.x + 400, gh.y + 300, { steps: 8 }); await p.mouse.up(); await sleep(300);
st = await p.evaluate(({ fid }) => { const C = window.__canvas, f = C.S.nodes[fid]; const r = { mode: f.mode, w: f.w, h: f.h, kw: C.kidsOf(fid).map(k => k.w) }; C.setMode(f, 'free', true); r.restored = C.kidsOf(fid).every(k => k.w === 200 && !k.prePack); C.removeNode(fid); return r; }, tf);
check('a deck dragged open unstacks into pack at the dragged size; back in free mode the cards have their own sizes again', st.mode === 'pack' && st.w > 300 && st.kw.every(w => w > 110) && st.restored, JSON.stringify(st));

// ---- v16 demo: the heading tree of a note, links with backlink counts, the journal and link perspectives, ]d / [d, the outline pane
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = ms => new Promise(r => setTimeout(r, ms)); await C.notesLoad(true);
  const top = C.rgEntries(C.addrToKey('note:plans')).map(e => e.name + '|' + e.meta + '|' + e.dir), h1 = C.rgEntries(C.addrToKey('note:plans')).find(e => e.dir), sub = h1 ? C.rgEntries(h1.key).map(e => e.name) : [], up = h1 ? C.rgParent(C.rgEntries(h1.key)[0].key) === h1.key : false;
  const byHeading = C.resolveAddr('note:plans#Rollout'), byAnchor = C.addrToKey('note:^freeze') || C.addrToKey('note:plans#^freeze');
  const root = C.rgEntries('link:').map(e => e.name + ' ' + e.meta), plans = C.rgEntries('link:plans').map(e => e.name + ' ' + e.meta + ' ' + e.kind), bl = (await C.AGENT_TOOLS.find(x => x.name === 'backlinks').run({ title: 'log' })).split('\n');
  const jk = C.addrToKey('journal:today'), jd = C.journalDays().map(d => d.day);
  C.perspSet('journal', true); await sl(100); const jf = Object.values(S.nodes).filter(f => f.kind === 'frame' && f.derived === 'journal').map(f => f.name + ':' + C.kidsOf(f.id).map(k => k.kind + ':' + k.name).join('|')).sort();
  C.perspSet('manual', true); C.linkPerspFrom('plans'); await sl(100); const lf = Object.values(S.nodes).filter(f => f.kind === 'frame' && f.derived === 'link').map(f => f.name + ':' + C.kidsOf(f.id).map(k => k.kind + ':' + k.name + (k.meta ? '(' + k.meta + ')' : '')).join('|'));
  const ghost = Object.values(S.nodes).find(n => n.kind === 'ghost' && n.linkTitle === 'ops'); const made = C.ghostOpen(ghost); await sl(50); const madeIn = made && S.nodes[made.in]?.derived === 'link', dimmed = Object.values(S.nodes).filter(n => n.kind === 'term' && C.live[n.id]?.el.classList.contains('persp-dim')).length;
  C.perspSet('manual', true); const stays = !!C.findPage('ops'); C.removeNode(C.findPage('ops').id);
  C.jumpNode(C.findPage('plans')); C.renderTree(); const outline = [...document.querySelectorAll('#tp-list .tp-row.tp-h')].map(r => r.querySelector('.tp-nm').textContent + '@' + r.style.getPropertyValue('--d'));
  return { top, sub, up, byHeading: byHeading.error || byHeading.addr, byAnchor, root, plans, bl, jk, jd, jf, lf, madeIn, dimmed, stays, outline }; });
check('note: lists a note\'s headings as a tree (h1 › its h2s), h goes up; [[Title#Heading]] and a bare ^anchor resolve; the outline pane shows the focused page\'s headings', st.top.length === 1 && /^Canvas workspace\|h1\|true$/.test(st.top[0]) && st.sub.join() === 'Rollout,Ideas' && st.up && st.byHeading === 'note:plans#Rollout' && /^note:/.test(st.byAnchor || '') && st.outline.length >= 3 && st.outline[0].startsWith('Canvas workspace@') && st.outline.some(x => /^Rollout@/.test(x)) && +st.outline.find(x => /^Rollout@/.test(x)).split('@')[1] === +st.outline[0].split('@')[1] + 1, JSON.stringify(st));
check('link: lists pages most linked-to first with → out ← in counts; descending shows targets (×n when linked twice) and titles with no page; the backlinks tool', st.root[0] === 'log → 1 ← 2' && st.root.includes('plans → 3 ← 1') && st.plans[0] === 'log ×2 → 1 ← 2 buffer' && st.plans.some(x => /^ops no page yet ghost$/.test(x)) && st.bl[0] === 'log: ← 2 in, → 1 out' && st.bl.some(l => /^plans:\d+ · /.test(l)), JSON.stringify({ root: st.root, plans: st.plans, bl: st.bl }));
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

// ---- v15 demo: tasks are keyword blocks with planning lines under them; four columns; keys; dispatch into a shell tagged #agent
await p.evaluate(() => window.__canvas.setView('canvas'));
st = await p.evaluate(async () => { const C = window.__canvas, S = C.S, sl = ms => new Promise(r => setTimeout(r, ms));
  const pg = C.addNode({ kind: 'buffer', name: 'todo', x: 1500, y: 1500, w: 420, h: 300, text: '# todo\n\n- TODO Write the v15 tests [#A]\n  SCHEDULED: <2026-10-01 Wed>\n  cover the four columns\n- NEXT Ship version 30\n  DEADLINE: <2099-01-01 Fri>\n- HOLD Wait for the build host\n- CANCELLED Old idea\n' });
  const sh = C.addNode({ kind: 'term', backend: 'fake', name: 'agentsh', env: {}, x: 2000, y: 1500, w: 440, h: 300 }); C.setTags(sh, ['agent']); await sl(300);
  C.setView('tasks'); await sl(200);
  const cols = [...document.querySelectorAll('#tk-board .tk-col')].map(c => c.dataset.col + ':' + [...c.querySelectorAll('.tk-card')].filter(x => x.querySelector('.tk-page').title.startsWith('board:/todo:')).length);
  const card = [...document.querySelectorAll('.tk-card')].find(c => /Write the v15 tests/.test(c.textContent)), meta = card?.querySelector('.tk-meta')?.textContent, over = !!card?.querySelector('.tk-meta .over');
  const hold = [...document.querySelectorAll('.tk-card')].find(c => /Wait for the build host/.test(c.textContent)), holdCol = hold?.closest('.tk-col').dataset.col, holdTitle = hold?.querySelector('.tk-t').textContent;
  const t = C.allTasks().find(x => x.text.startsWith('Write the v15')); const ttext = C.taskText(t), found = C.findTask('todo:3')?.line === 3 && C.findTask('board:/todo:3')?.node === t.node;
  C.statusRender(); const stc = [...document.querySelectorAll('#st-host .stc')].map(b => b.textContent); const attn = C.rgEntries('attn:').map(e => e.name);
  const ls = (await C.AGENT_TOOLS.find(x => x.name === 'list_tasks').run({ status: 'open' })).split('\n');
  card.click(); return { pg: pg.id, sh: sh.id, cols, meta, over, holdCol, holdTitle, ttext, found, stc, attn, ls }; });
const tk = st;
check('tasks view: four columns over the keyword set, priority and dates as meta, overdue in red, HOLD shown in Waiting with its keyword; list_tasks addresses', st.cols.join() === 'TODO:1,NEXT:1,WAITING:1,DONE:1' && /#A/.test(st.meta) && /2026-10-01/.test(st.meta) && st.over && st.holdCol === 'WAITING' && /^HOLD Wait/.test(st.holdTitle) && st.ttext === 'Write the v15 tests cover the four columns' && st.found && st.stc.some(x => /^☐ \d+ \(\d+ due\)/.test(x)) && st.attn.some(x => /^overdue Write the v15 tests/.test(x)) && st.ls.some(l => /^board:\/todo:3 · TODO · Write the v15 tests \[#A\] · scheduled 2026-10-01$/.test(l)), JSON.stringify(st));
await p.keyboard.press('t'); await sleep(200);
const pgText1 = await p.evaluate(id => window.__canvas.live[id].view.state.doc.toString(), tk.pg);
await p.keyboard.press('d'); await sleep(900);
st = await p.evaluate(({ pg, sh }) => { const C = window.__canvas; const text = C.live[pg].view.state.doc.toString(); const m = text.match(/session:: board:(\S+)/), target = m && (C.findNode(m[1]) || C.findNode(m[1].replace(/^\//, ''))), term = target ? C.termLines(C.live[target.id], 20).join('|') : '', agentTag = target && C.tagsOf(target).includes('agent'); const cols = [...document.querySelectorAll('#tk-board .tk-col')].map(c => c.dataset.col + ':' + [...c.querySelectorAll('.tk-card')].filter(x => x.querySelector('.tk-page').title.startsWith('board:/todo:')).length); const sess = [...document.querySelectorAll('.tk-card .tk-meta .sess')].map(x => x.textContent); return { text, term, agentTag, cols, sess }; }, tk);
// st.term joins the terminal's rows with |, and a narrow card wraps the pasted line.
check('t cycles the keyword in the page; d pastes title + body into a shell tagged #agent and writes session:: / dispatched:: under the task', /- NEXT Write the v15 tests \[#A\]/.test(pgText1) && st.agentTag && /Write the v15 tests cover the four columns/.test(st.term.replaceAll('|', '')) && /\n  session:: board:\/\S+\n  dispatched:: 20\d\d-\d\d-\d\dT\d\d:\d\d\n  SCHEDULED: <2026-10-01 Wed>/.test(st.text) && st.cols.join() === 'TODO:0,NEXT:2,WAITING:1,DONE:1' && st.sess.some(x => /^⇢ board:\//.test(x)), JSON.stringify({ pgText1, st }));
await p.keyboard.press('T'); await sleep(200);
st = await p.evaluate(async ({ pg, sh }) => { const C = window.__canvas; const text = C.live[pg].view.state.doc.toString(); const r = await C.AGENT_TOOLS.find(x => x.name === 'set_task').run({ task: 'todo:3', keyword: 'DONE' }); const text2 = C.live[pg].view.state.doc.toString(); C.setView('canvas'); C.removeNode(pg); C.removeNode(sh); return { text, r, text2 }; }, tk);
check('T cycles back (NEXT → TODO); set_task writes a keyword by reference', /- TODO Write the v15 tests/.test(st.text) && st.r === 'board:/todo:3 → DONE' && /- DONE Write the v15 tests/.test(st.text2), JSON.stringify(st));
// ---- fix 1 rendering without a server (30 §1.2-§1.4, F-A19): diffs, elicitation forms, url requests, agent text as text
st = await p.evaluate(() => {
  const C = window.__canvas, A = C.AcpBackend.prototype, rows = d => [...d.querySelectorAll('pre > div')].map(r => r.className + ':' + r.textContent);
  const lines = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join('\n');
  const fresh = C.lineDiff({ path: '/w/new.txt', oldText: null, newText: 'x\ny' });
  const many = rows(C.lineDiff({ path: '/w/m', oldText: lines(30, i => 'l' + i), newText: lines(30, i => (i === 15 ? 'L15' : 'l' + i)) }));
  const f = C.elicitForm({ type: 'object', required: ['name'], properties: { color: { type: 'string', enum: ['red', 'green'] }, n: { type: 'integer', minimum: 1, maximum: 5 }, ok: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } }, name: { type: 'string', minLength: 2 } } });
  const q = (k, s) => f.el.querySelector(`.fld[data-key="${k}"] ${s}`), empty = f.check();
  q('name', 'input').value = 'x'; const short = f.check();
  q('name', 'input').value = 'xy'; q('n', 'input').value = '9'; const big = f.check();
  q('n', 'input').value = '3'; q('color', 'select').value = 'green'; q('ok', 'input').checked = true; q('tags', 'input[value="b"]').checked = true;
  const full = f.check();
  const url = u => { const d = A.elicitPanel.call({ answerElicitation() {} }, 1, { request: { mode: 'url', url: u, message: 'Sign in', elicitationId: 'e' } }); return { off: d.querySelector('button.open').disabled, host: d.querySelector('code b')?.textContent ?? null, links: d.querySelectorAll('a').length }; };
  const XSS = '<img src=x onerror="window.__xss=1">';
  const perm = A.permPanel.call({ n: { agent: 'stub' }, answerPermission() {} }, 1, { toolCall: { title: XSS, kind: 'edit', content: [{ type: 'diff', path: '/w/' + XSS, oldText: 'a', newText: '<script>window.__xss=2</script>' }] },
    options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'a', name: 'Always', kind: 'allow_always' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }] });
  document.body.append(perm);
  const out = { diff: rows(C.lineDiff({ path: '/w/a.txt', oldText: 'a\nb\nc', newText: 'a\nB\nc' })), fresh: rows(fresh), freshPath: fresh.querySelector('.dp').textContent, many,
    empty, short, big, full, js: url('javascript:alert(1)'), data: url('data:text/html,<b>x</b>'), http: url('http://example.org/'), https: url('https://example.org/login?x=1'),
    markup: perm.querySelectorAll('img, script').length, title: perm.querySelector('.ph .tt').textContent, btns: [...perm.querySelectorAll('.acts button')].map(b => (b.className || '-') + '|' + b.dataset.kind + '|' + b.textContent),
    button: document.querySelector('#add-acp')?.disabled };
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
await p.close();
check('N16 demo: the inlined page asks fonts.googleapis.com for nothing', !demoHosts.has('fonts.googleapis.com'), [...demoHosts].join());

// ---------------- daemon phase: wb-hub, wb-web and Caddy from the harness
const PORT = 18443, ORIGIN = `http://127.0.0.1:${PORT}`;
const EXIT_HUB = 'the Workbench hub restarted';   // app.js EXIT_TEXT.hub_restart
// Without WB_HARNESS_TCP: the browser goes through the forwarder below, which N6 cuts, and the harness's own TCP
// entry would take its port.
const { WB_HARNESS_TCP, ...harnessEnv } = process.env;
const harness = spawn('python3', ['-I', HARNESS, '--web-root', ROOT], { stdio: ['pipe', 'pipe', 'pipe'], env: harnessEnv });
let hlog = ''; harness.stderr.on('data', d => { hlog += d; });
const H = await new Promise((res, rej) => {
  let out = ''; harness.stdout.on('data', d => { out += d; const i = out.indexOf('\n'); if (i >= 0) try { res(JSON.parse(out.slice(0, i))); } catch (e) { rej(e); } });
  harness.on('exit', c => rej(new Error(`harness exited with ${c}\n${hlog}`)));
});
// Harness controls: SIGHUP restarts wb-web; "stop hub" / "start hub" on stdin are M1-N's (acknowledged on stderr).
const harnessSays = (text, from) => until(() => hlog.indexOf(text, from) >= 0, 20000);
const hubCtl = verb => { const from = hlog.length; harness.stdin.write(verb + ' hub\n'); return harnessSays(`harness: wb-hub ${verb === 'stop' ? 'stopped' : 'started'}`, from); };
async function webRestart() { const from = hlog.length; harness.kill('SIGHUP'); return harnessSays('harness: wb-web restarted', from); }

// The forwarder. Linux keeps the owner of each TCP socket in /proc/net/tcp; the browser's end of a loopback
// connection is the entry whose local port is the accepted socket's remote port.
const hexPort = n => n.toString(16).toUpperCase().padStart(4, '0');
function peerUid(c) {
  const local = '0100007F:' + hexPort(c.remotePort), remote = '0100007F:' + hexPort(PORT);
  for (const l of fs.readFileSync('/proc/net/tcp', 'utf8').split('\n')) { const f = l.trim().split(/\s+/); if (f[1] === local && f[2] === remote) return Number(f[7]); }
  return -1;
}
const FWD = { down: false, socks: new Set() };
const fwd = net.createServer(c => {
  if (FWD.down || c.remoteAddress !== '127.0.0.1' || peerUid(c) !== process.getuid()) return c.destroy();
  const u = net.connect(H.caddySocket);
  const end = () => { c.destroy(); u.destroy(); FWD.socks.delete(c); FWD.socks.delete(u); };
  for (const s of [c, u]) { FWD.socks.add(s); s.on('error', end); s.on('close', end); }
  c.pipe(u); u.pipe(c);
});
await new Promise((res, rej) => { fwd.once('error', rej); fwd.listen(PORT, '127.0.0.1', res); });
const netCut = () => { FWD.down = true; for (const s of FWD.socks) s.destroy(); FWD.socks.clear(); };
const netBack = () => { FWD.down = false; };
const api = (p, init = {}) => fetch(ORIGIN + p, { ...init, headers: { Origin: ORIGIN, ...init.headers } });
const boardFile = () => { const f = fs.readdirSync(H.boardsDir).find(x => x.endsWith('.json')); return f && JSON.parse(fs.readFileSync(path.join(H.boardsDir, f), 'utf8')); };
const sessions = async () => (await (await api('/api/sessions')).json()).sessions || [];

// Every request and WebSocket of the daemon phase. Service workers are blocked so page.route sees every request.
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
const REQ = [], WSL = [];
ctx.on('request', r => REQ.push({ r, m: r.method(), url: r.url(), h: r.headers(), t: Date.now() }));
const status = async e => (await e.r.response().catch(() => null))?.status();
const puts = (since = 0) => REQ.filter(e => e.m === 'PUT' && e.url === ORIGIN + '/api/board' && e.t >= since);
// Each socket's first open and first hello, into WSL; an /acp socket also keeps every frame (sent, recv).
function record(p) {
  p.on('websocket', ws => {
    const w = { url: ws.url(), p, t: Date.now(), open: null, hello: null, closed: null, sent: [], recv: [] }, acp = w.url.endsWith('/acp'); WSL.push(w);
    ws.on('framesent', f => { let m; try { m = JSON.parse(f.payload); } catch { return; } if (acp) w.sent.push(m); if (!w.open && m.t === 'open') w.open = m; });
    ws.on('framereceived', f => { let m; try { m = JSON.parse(f.payload); } catch { return; } if (acp) w.recv.push(m); if (!w.hello && m.t === 'hello') { w.hello = m; w.helloT = Date.now(); } });
    ws.on('close', () => { w.closed = Date.now(); });
  });
}
async function dpage(boot = true) {
  const p = await ctx.newPage(); watchErrors(p); record(p);
  await p.goto(ORIGIN + '/');
  if (boot) await until(() => p.evaluate(() => window.__canvas?.BOOTED));
  return p;
}
const ptyOf = (p, id, since = 0) => WSL.filter(w => w.p === p && w.url.endsWith('/pty') && w.t >= since && (!id || w.open?.id === id));
const termText = (p, id) => p.evaluate(id => { const b = window.__canvas.live[id]?.term?.buffer.active; if (!b) return ''; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\n'); }, id);
async function newTerm(p, name) {   // a pty card made in the page, so it spawns; resolves once its shell answered
  const id = await p.evaluate(name => window.__canvas.addNode({ kind: 'term', backend: 'pty', name, x: 200, y: 200, w: 640, h: 300, env: {} }).id, name);
  await until(() => ptyOf(p, id).some(w => w.hello));
  return id;
}
const typeIn = (p, id, s) => p.evaluate(({ id, s }) => window.__canvas.live[id].backend.input(s), { id, s });
const moveCard = (p, dx = 40) => p.evaluate(dx => { const C = window.__canvas, n = Object.values(C.S.nodes).find(n => n.kind === 'buffer'); C.moveTree(n, dx, 0); C.dirty(); return { id: n.id, x: n.x }; }, dx);
const settled = p => until(() => p.evaluate(() => { const s = window.__canvas.SAVE; return !s.busy && !s.pending && !s.paused; }), 8000);
const barOf = p => p.evaluate(() => { const b = document.querySelector('#bar'); return { hidden: b.hidden, key: b.dataset.key, text: b.querySelector('.msg').textContent }; });
const palLabels = p => p.evaluate(() => [...document.querySelectorAll('#pal-list .pi .l')].map(x => x.textContent));
// One failing step must not hide the checks after it (30 §10.1).
async function section(name, f) { try { await f(); } catch (e) { check(name + ' (threw)', false, String(e?.message || e).split('\n')[0]); } }
let A, T, tid, pid0, t0;

await section('daemon boot', async () => {
  A = await dpage();
  st = await A.evaluate(() => { const C = window.__canvas; return { daemon: C.DAEMON, hub: C.INFO?.hub?.status, s: !!C.S }; });
  check('daemon boots', st.daemon && st.hub === 'up' && st.s, JSON.stringify(st));
  check('assistant pane is gone', await A.evaluate(() => !document.querySelector('#side-chat') && !window.__canvas.S.chat && !document.querySelector('#add-agent')));
  check('N16: no request leaves 127.0.0.1 while booting', REQ.every(e => !/^(https?|wss?):/.test(e.url) || new URL(e.url).hostname === '127.0.0.1'), REQ.filter(e => !e.url.startsWith(ORIGIN)).map(e => e.url).join());
  const css = REQ.find(e => e.url === ORIGIN + '/fonts/fonts.css'), files = REQ.filter(e => e.url.startsWith(ORIGIN + '/fonts/') && e !== css);
  const codes = await Promise.all(files.map(status));
  check('N16: fonts.css and a font file load from /fonts/', !!css && await status(css) === 200 && codes.includes(200), JSON.stringify({ css: !!css, files: files.map(e => e.url), codes }));
  // N4b: a fresh boardsDir; the seeded board's first save
  if (!puts().length) await moveCard(A);
  await until(() => puts().length, 5000);
  const e = puts()[0];
  check('N4b: the first PUT carries If-Match "empty" and gets 204', !!e && e.h['if-match'] === '"empty"' && await status(e) === 204, JSON.stringify(e && { im: e.h['if-match'], st: await status(e) }));
  await settled(A);
});

// DELTA-1 §A.4: index.html preloads a font file, and the service worker caches every font file fonts.css names at
// install, so a launch after one visit renders in them offline. Its own context: the daemon context blocks workers.
await section('§A.4', async () => {
  const css = await (await api('/fonts/fonts.css')).text(), want = [...css.matchAll(/url\("([^"]+)"\)/g)].map(m => '/fonts/' + m[1]);
  const html = await (await api('/')).text(), pre = [...html.matchAll(/<link [^>]*rel="preload"[^>]*>/g)].map(l => l[0].match(/href="([^"]+)"/)?.[1]).filter(Boolean).map(h => new URL(h, ORIGIN + '/').pathname);
  check('§A.4: index.html preloads a font file fonts.css names', pre.length > 0 && pre.every(h => want.includes(h)), JSON.stringify({ pre, want }));
  const sctx = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const p = await sctx.newPage(); await p.goto(ORIGIN + '/icon.svg');
    const have = await p.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no active service worker after 15 s')), 15000))]);
      const out = []; for (const k of await caches.keys()) for (const q of await (await caches.open(k)).keys()) out.push(new URL(q.url).pathname);
      return out;
    });
    check('§A.4: the service worker caches every font file fonts.css names when it installs', want.length >= 4 && want.every(w => have.includes(w)), JSON.stringify({ want, have }));
  } finally { await sctx.close(); }
});

// DELTA-1 §A.5 in both schemes: square corners, Modus backgrounds, the terminal theme, the mono face, no blur
await section('§A.5', async () => {
  const MODUS = { light: { bgDim: 'rgb(239, 233, 221)', bgMain: '#fbf7f0' }, dark: { bgDim: 'rgb(29, 34, 53)', bgMain: '#0d0e1c' } };
  const looks = () => A.evaluate(() => {
    const C = window.__canvas, cs = (sel, k) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[k] : null; };
    const term = Object.values(C.live).find(L => L.term)?.term;
    const blurred = [];
    for (const e of document.querySelectorAll('*')) for (const ps of [null, '::before', '::after']) {
      const bs = getComputedStyle(e, ps).boxShadow; if (!bs || bs === 'none') continue;
      for (const sh of bs.split(/,(?![^(]*\))/)) { const n = sh.replace(/[a-z-]+\([^)]*\)|inset/g, '').trim().split(/\s+/).map(parseFloat); if ((n[2] || 0) > 0) blurred.push((e.id || e.className || e.tagName) + (ps || '') + ': ' + bs); }
    }
    return {
      radius: ['.node', '#add-shell', '#repl-menu', '#pal-in', '.frame.shape-round'].map(s => cs(s, 'borderTopLeftRadius')), body: cs('body', 'backgroundColor'),
      edgeLabels: document.querySelectorAll('#edges rect').length, pills: [...document.querySelectorAll('#edges rect')].filter(r => parseFloat(r.getAttribute('rx') || 0) > 0).length,
      termBg: term?.options.theme.background?.toLowerCase(),
      fontCheck: document.fonts.check('13px "JetBrainsMono Nerd Font Mono"'),
      fontLoaded: [...document.fonts].some(f => f.family.replace(/"/g, '') === 'JetBrainsMono Nerd Font Mono' && f.status === 'loaded'),
      blurred: blurred.slice(0, 5),
    };
  });
  for (const [scheme, how] of [['light', 'auto'], ['dark', 'auto'], ['dark', 'dark'], ['light', 'light']]) {
    await A.emulateMedia({ colorScheme: how === 'auto' ? scheme : scheme === 'dark' ? 'light' : 'dark' });   // the override must beat the system scheme
    await A.evaluate(t => window.__canvas.setTheme(t), how); await sleep(300);
    const l = await looks(), m = MODUS[scheme];
    check(`§A.5 ${scheme} (${how === 'auto' ? 'prefers-color-scheme' : 'data-theme'}): radius 0, square edge labels, Modus backgrounds, terminal bg-main, mono face loaded, no blurred shadow`,
      l.radius.every(r => r === '0px') && l.edgeLabels > 0 && !l.pills && l.body === m.bgDim && l.termBg === m.bgMain && l.fontCheck && l.fontLoaded && !l.blurred.length, JSON.stringify(l));
  }
  await A.evaluate(() => window.__canvas.setTheme('auto')); await A.emulateMedia({ colorScheme: 'light' }); await settled(A);
  // the graph view's glyphs are canvas paths, out of reach of computed styles
  const g = await A.evaluate(async () => {
    const C = window.__canvas, P = CanvasRenderingContext2D.prototype, keep = { roundRect: P.roundRect, rect: P.rect }, n = { roundRect: 0, rect: 0 };
    for (const k in keep) P[k] = function (...a) { n[k]++; return keep[k].apply(this, a); };
    try { C.setView('graph'); await new Promise(r => setTimeout(r, 800)); } finally { Object.assign(P, keep); C.setView('canvas'); }
    return n;
  });
  check('§A.5: the graph view draws square glyphs, never a rounded rectangle', g.rect > 0 && g.roundRect === 0, JSON.stringify(g));
});

// DELTA-1 §B.5: every new-terminal path starts the device's shell; here the agent tool's
await section('§B.5', async () => {
  st = await A.evaluate(async () => {
    const C = window.__canvas, before = new Set(Object.keys(C.S.nodes));
    await C.AGENT_TOOLS.find(t => t.name === 'create_node').run({ kind: 'shell', name: 'b5' });
    const made = Object.values(C.S.nodes).filter(n => !before.has(n.id)), r = { want: C.shellDefault(), got: made.map(n => n.shell) };
    made.forEach(n => C.removeNode(n.id));
    return r;
  });
  check('§B.5: a shell made by the create_node tool carries the default shell', !!st.want && st.got.length === 1 && st.got[0] === st.want, JSON.stringify(st));
  await settled(A);
});

// N32: web cards open only http(s); their frames never get allow-same-origin
await section('N32', async () => {
  st = await A.evaluate(async () => {
    const C = window.__canvas, frameOf = n => C.live[n.id].frame;
    const bad = ['javascript:window.__n32=1', 'data:text/html,<script>parent.__n32=2</script>'].map(url => C.addNode({ kind: 'web', name: 'n32', url, x: 3000, y: 3000, w: 400, h: 300 }));
    const typed = C.newWeb('javascript:window.__n32=3'), ok = C.newWeb('http://127.0.0.1:9/');
    let tool; try { await C.AGENT_TOOLS.find(t => t.name === 'open_web').run({ url: 'javascript:window.__n32=4' }); tool = 'ran'; } catch (e) { tool = 'refused'; }
    await new Promise(r => setTimeout(r, 300));
    const opened = [], open = window.open, tabs = n => [...C.live[n.id].el.querySelectorAll('button')].filter(b => b.textContent === '↗');
    window.open = u => { opened.push(String(u)); return null; };
    try { for (const n of [...bad, ok]) for (const b of tabs(n)) b.click(); } finally { window.open = open; }
    const r = { srcs: bad.map(n => frameOf(n).getAttribute('src')), notes: bad.map(n => C.live[n.id].note.textContent), typed: typed.url, typedSrc: frameOf(typed).getAttribute('src'), tool, ran: window.__n32 ?? null,
      okSrc: frameOf(ok).getAttribute('src'), sandbox: frameOf(ok).getAttribute('sandbox'), buttons: [...bad, ok].map(n => tabs(n).length), opened };
    for (const n of [...bad, typed, ok]) C.removeNode(n.id);
    return r;
  });
  check('N32: javascript: and data: web cards are refused; an http card\'s frame has no allow-same-origin', st.srcs.every(s => s === null) && st.notes.every(t => t.startsWith('Refused')) && st.typed === '' && st.typedSrc === null && st.tool === 'refused' && st.ran === null && st.okSrc === 'http://127.0.0.1:9/' && !/allow-same-origin/.test(st.sandbox), JSON.stringify(st));
  check('N32: ↗ opens a tab only for the http card', st.buttons.every(k => k === 2) && st.opened.length === 2 && st.opened.every(u => u === 'http://127.0.0.1:9/'), JSON.stringify({ buttons: st.buttons, opened: st.opened }));
  await settled(A);
});

// N31: note titles and headings are text, never markup. The notes index is a stub until M5, so the page gets
// the index rows a notes file with these headings would give.
await section('N31', async () => {
  const XSS = '<img src=x onerror="window.__xss31=1">', B31 = '<b onmouseover="window.__xss31=2">bold</b>';
  const rows = [
    { id: 'x31', path: 'xss31.md', title: 'xss31', kind: 'file', tags: [], body: '# ' + XSS, line: 1 },
    { id: 'x31#5', path: 'xss31.md', title: XSS, kind: 'heading', level: 1, tags: [], body: 'body', line: 5 },
    { id: 'x31#7', path: 'xss31.md', title: B31, kind: 'heading', level: 2, tags: [], body: '', line: 7 },
    { id: 'x32', path: 'evil.md', title: XSS, kind: 'file', tags: [], body: '', line: 1 },
  ];
  await A.route('**/api/nodes*', r => r.fulfill({ json: { root: H.notesDir, nodes: rows } }));
  st = await A.evaluate(async () => {
    const C = window.__canvas, sl = ms => new Promise(r => setTimeout(r, ms)); await C.notesLoad(true);
    const key = C.addrToKey('note:xss31'), heads = key ? C.rgEntries(key).map(e => e.name.trim()) : [];
    C.goAddr('note:'); await sl(400); const list = document.body.innerText.includes('<img src=x');
    C.goAddr('note:xss31'); await sl(400); const tree = document.body.innerText.includes('<img src=x') && document.body.innerText.includes('<b onmouseover');
    const r = { heads, list, tree, ran: window.__xss31 ?? null, markup: document.querySelectorAll('img[src="x"], b[onmouseover]').length };
    C.setView('canvas'); return r;
  });
  await A.unroute('**/api/nodes*');
  check('N31: a note title and headings with markup render as text', st.heads.some(h => h.startsWith('<img')) && st.list && st.tree && st.ran === null && st.markup === 0, JSON.stringify(st));
});

// N5: a failing PUT shows the save bar and retries with growing gaps; recovery clears the bar
await section('N5', async () => {
  await A.route('**/api/board', r => r.request().method() === 'PUT' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced"}' }) : r.continue());
  t0 = Date.now(); await moveCard(A);
  await until(() => puts(t0).length >= 3, 10000);
  const ts = puts(t0).map(e => e.t), gaps = ts.slice(1).map((t, i) => t - ts[i]), b = await barOf(A);
  check('N5: a 500 on PUT shows the save bar and retries with growing gaps', ts.length >= 3 && gaps.every((g, i) => !i || g >= gaps[i - 1]) && !b.hidden && b.key === 'save', JSON.stringify({ gaps, b }));
  await A.unroute('**/api/board');
  check('N5: after recovery the bar clears', !!await settled(A) && (await barOf(A)).hidden, JSON.stringify(await barOf(A)));
});

// N4: another writer saves while this tab has an unsaved move (an outside write before the move would simply be
// taken in, F-A7); Overwrite with this tab wins
await section('N4', async () => {
  const mv = await moveCard(A, 25);
  const cur = await api('/api/board'), etag = cur.headers.get('ETag'), theirs = await cur.json();
  theirs.nodes[mv.id].name = 'changed elsewhere';
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(theirs) });
  await until(async () => (await barOf(A)).key === 'conflict', 5000);
  const b = await barOf(A);
  check('N4: an outside write during an unsaved edit shows the conflict bar', r.status === 204 && !b.hidden && b.key === 'conflict' && /This tab: 1 change/.test(b.text), JSON.stringify({ put: r.status, b }));
  t0 = Date.now();
  await A.click('#bar .acts button:has-text("Overwrite with this tab")', { timeout: 5000 });
  await until(() => puts(t0).length, 5000); await settled(A);
  const disk = boardFile()?.nodes?.[mv.id];
  check('N4: Overwrite with this tab saves (204) and the file holds this tab\'s version', !!puts(t0)[0] && await status(puts(t0)[0]) === 204 && disk?.x === mv.x && disk?.name !== 'changed elsewhere' && (await barOf(A)).hidden, JSON.stringify({ disk, x: mv.x }));
});

// N36: the camera is per device; a clean tab takes another tab's board; a dirty one asks
await section('N36', async () => {
  const B = await dpage(); await settled(A); await settled(B);
  t0 = Date.now();
  await A.mouse.move(700, 500); await A.mouse.wheel(0, 240); await sleep(1500);
  const s0 = await A.evaluate(() => ({ pending: window.__canvas.SAVE.pending, cam: Object.keys(localStorage).some(k => k.startsWith('wb-cam-')) }));
  check('N36: a pan in A saves no board (the camera goes to localStorage)', !puts(t0).length && !s0.pending && s0.cam, JSON.stringify({ puts: puts(t0).length, s0 }));
  const camB = await B.evaluate(() => ({ ...window.__canvas.S.cam }));
  const mvA = await moveCard(A, 60);
  await until(() => B.evaluate(id => window.__canvas.S.nodes[id].x, mvA.id).then(x => x === mvA.x), 5000); await sleep(1000);
  const s = await B.evaluate(id => ({ x: window.__canvas.S.nodes[id].x, cam: { ...window.__canvas.S.cam }, pending: window.__canvas.SAVE.pending }), mvA.id), b = await barOf(B);
  check('N36: a clean B takes A\'s move without a bar and keeps its own camera', s.x === mvA.x && b.hidden && JSON.stringify(s.cam) === JSON.stringify(camB) && !s.pending, JSON.stringify({ s, b, camB }));
  await B.route('**/api/board', r => r.request().method() === 'PUT' ? r.abort() : r.continue());
  await moveCard(B, -30); await sleep(800);
  await settled(A); await moveCard(A, 20);
  await until(async () => (await barOf(B)).key === 'conflict', 6000);
  const b2 = await barOf(B);
  check('N36: B with an unsaved edit shows the conflict bar with counts', !b2.hidden && b2.key === 'conflict' && /This tab: [1-9]\d* changes?; server: newer/.test(b2.text), JSON.stringify(b2));
  await B.close(); await settled(A);
});

// DELTA-1 §B.6: the new-terminal action offers /api/info.shells; the next one defaults to the last pick. The page is
// given a second shell when the server offers fewer than two, since the picker only opens for a choice.
await section('§B.6', async () => {
  const P = await ctx.newPage(); watchErrors(P); record(P);
  await P.route('**/api/info', r => r.fetch().then(async res => {
    const info = await res.json(); if (!(info.shells?.length >= 2)) Object.assign(info, { shells: ['bash', 'sh'], defaultShell: info.defaultShell || 'bash' });
    await r.fulfill({ response: res, json: info });
  }).catch(() => {}));
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    await P.evaluate(() => localStorage.removeItem('wb-shell'));
    const ids = () => P.evaluate(() => Object.values(window.__canvas.S.nodes).filter(n => n.kind === 'term').map(n => n.id));
    const newShell = async () => { if (!await P.isVisible('#add-shell')) await P.click('#toggle-new', { timeout: 5000 }); await P.click('#add-shell', { timeout: 5000 }); await sleep(300); return palLabels(P); };
    const before = await ids(), listed = await newShell();
    const info = await P.evaluate(() => ({ shells: window.__canvas.INFO.shells, def: window.__canvas.INFO.defaultShell }));
    const pick = info.shells.find(s => s !== info.def);
    await P.click(`#pal-list .pi:has(.l:text-is("${pick}"))`, { timeout: 5000 }); await sleep(500);
    const first = (await ids()).find(id => !before.includes(id));
    const one = await P.evaluate(id => ({ shell: window.__canvas.S.nodes[id]?.shell, badge: document.querySelector(`.node[data-id="${id}"] .hdr .badge`)?.textContent }), first);
    const listed2 = await newShell();
    await P.keyboard.press('Enter'); await sleep(500);
    const second = (await ids()).find(id => !before.includes(id) && id !== first);
    const two = await P.evaluate(id => window.__canvas.S.nodes[id]?.shell, second);
    check('§B.6: the picker lists /api/info.shells; the card keeps and shows the shell; the next terminal defaults to the last pick',
      [...listed].sort().join() === [...info.shells].sort().join() && listed[0] === info.def && one.shell === pick && one.badge?.includes(pick) && listed2[0] === pick && two === pick, JSON.stringify({ listed, info, one, listed2, two }));
    const sent = id => ptyOf(P, id).some(w => w.open?.spawn === true && w.open?.shell === pick);
    await until(() => sent(first) && sent(second), 5000);
    check('§B.6: both terminals\' /pty opens spawn with the picked shell', sent(first) && sent(second), JSON.stringify([first, second].map(id => ptyOf(P, id).map(w => w.open))));
    await P.evaluate(ids => ids.forEach(id => window.__canvas.removeNode(id)), [first, second].filter(Boolean));
    await settled(P);
  } finally { await P.close(); }
});

// N40: a wb-web restart with an open terminal resumes it, and the scrollback above the viewport stays
await section('N40', async () => {
  T = await dpage();
  tid = await newTerm(T, 'n40');
  await typeIn(T, tid, 'echo MARK40-$((6*7)); seq 1 120\r');
  await until(async () => (await termText(T, tid)).includes('\n120'));
  pid0 = (await sessions()).find(s => s.sid === tid)?.pty?.pid;
  t0 = Date.now();
  if (!await webRestart()) return check('N40: the harness restarts wb-web on SIGHUP', false, hlog.slice(-500));
  const w = await until(() => ptyOf(T, tid, t0).find(w => w.hello), 15000);
  const s = await T.evaluate(id => { const b = window.__canvas.live[id].term.buffer.active; let at = -1; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).includes('MARK40-42')) at = i; return { at, top: b.viewportY, len: b.length }; }, tid);
  const pid1 = (await sessions()).find(s => s.sid === tid)?.pty?.pid;
  check('N40: after a wb-web restart the terminal reconnects with resumed:true and keeps the scrollback above the viewport', w?.hello?.resumed === true && s.at >= 0 && s.at < s.top && pid1 === pid0, JSON.stringify({ hello: w?.hello && { ...w.hello, replay: undefined }, s, pid0, pid1 }));
});

// N6: the server unreachable for 5 s. The forwarder drops every connection, since the harness cannot stop wb-web alone.
await section('N6', async () => {
  await typeIn(T, tid, 'echo MARK6\r'); await until(async () => (await termText(T, tid)).includes('\nMARK6'));
  t0 = Date.now(); netCut();
  await sleep(1500);
  const during = await T.evaluate(id => ({ chip: document.querySelector('#st-net').textContent, hidden: document.querySelector('#st-net').hidden, wait: document.querySelector(`.node[data-id="${id}"]`).classList.contains('net-wait') }), tid);
  await sleep(3500);
  const tBack = Date.now(); netBack();
  const back = await until(() => ptyOf(T, tid, tBack).find(w => w.hello), 20000);
  const ts = ptyOf(T, null, t0).filter(w => w.t < tBack).map(w => w.t), gaps = ts.slice(1).map((t, i) => t - ts[i]), last = gaps.at(-1) || 0;
  const pid1 = (await sessions()).find(s => s.sid === tid)?.pty?.pid, screen = await termText(T, tid);
  check('N6: while unreachable the chip reads reconnecting… and the card waits', !during.hidden && during.chip === 'reconnecting…' && during.wait, JSON.stringify(during));
  check('N6: socket attempts back off (at least 3, each gap at least half the previous)', ts.length >= 3 && gaps.every((g, i) => !i || g >= 0.5 * gaps[i - 1]), JSON.stringify(gaps));
  // 30 §10 says within 2x the last gap, but with equal jitter a gap in [d/2, d] is followed by one in [d, 2d]: up to 4x.
  check('N6: after the outage the card reconnects within 4x the last gap and keeps its screen and process', !!back && back.helloT - tBack <= 4 * last + 1000 && pid1 === pid0 && screen.includes('MARK6') && !(await T.evaluate(id => document.querySelector(`.node[data-id="${id}"]`).classList.contains('net-wait'), tid)), JSON.stringify({ took: back && back.helloT - tBack, last, pid0, pid1 }));
});

// N8, second case: exit in a shell, then Enter starts a new one without the [new shell] marker
await section('N8 exit', async () => {
  await typeIn(T, tid, 'exit\r');
  await until(() => T.evaluate(id => window.__canvas.live[id].backend.dead, tid), 8000);
  await typeIn(T, tid, '\r');
  await until(async () => (await sessions()).find(s => s.sid === tid)?.alive, 8000); await sleep(800);
  check('N8: exit, then Enter starts a new shell without the [new shell] marker', !(await termText(T, tid)).includes('[new shell') && !!(await sessions()).find(s => s.sid === tid)?.alive, (await termText(T, tid)).slice(-300));
});

// N7 and N8 (first case) stop the hub through the harness (M1-N)
await section('N7/N8', async () => {
  if (!await hubCtl('stop')) { for (const n of ['N7', 'N8 (stateDir wipe)']) skip(n, 'the harness did not acknowledge "stop hub" on stdin (M1-N open request)'); return; }
  await until(() => T.evaluate(() => document.querySelector('#st-net').textContent === 'hub down'), 10000);
  const chip = await T.evaluate(() => document.querySelector('#st-net').textContent);
  t0 = Date.now(); await sleep(10000);
  const tries = ptyOf(T, tid, t0).length;
  check('N7: hub down shows the chip, and a 1013 socket does not retry in a loop', chip === 'hub down' && tries <= 1, JSON.stringify({ chip, tries }));
  await hubCtl('start');
  // The exit text first arrives when the hub stops. The reconnect's hello then resets the screen, and the corpse's exit
  // prints the text again a moment later, so the check waits for the reconnected card and judges one snapshot of the page.
  const n7 = () => T.evaluate(({ id, EXIT_HUB }) => {
    const C = window.__canvas, b = C.live[id].backend, buf = C.live[id].term.buffer.active, rows = [];
    for (let i = 0; i < buf.length; i++) rows.push(buf.getLine(i).translateToString(true));
    return { text: rows.join('\n').includes(EXIT_HUB), back: b.ws?.readyState === 1 && b.dead && b.exitReason === 'hub_restart', toast: document.querySelector('#toast').textContent, attn: C.attnItems().filter(a => a.key === id).length };
  }, { id: tid, EXIT_HUB });
  st = await until(async () => { const s = await n7(); return s.text && s.back && /hub restarted/.test(s.toast) ? s : null; }, 20000) || await n7();
  check('N7: after the hub restarts the card shows the hub_restart text, the toast says so, and the card is not "ended"', st.text && st.back && /hub restarted/.test(st.toast) && st.attn === 0, JSON.stringify(st));
  // N8 (amended): a live shell, then a wiped stateDir: the card says No session, and Enter starts a shell with the marker.
  // The card already shows both lines from N7, so the check counts new ones.
  const count = async k => (await termText(T, tid)).split(k).length - 1, NOSESS = '[No session: press Enter', MARKER = '[new shell';
  await typeIn(T, tid, '\r'); await until(async () => (await sessions()).find(s => s.sid === tid)?.alive, 10000);
  const n0 = await count(NOSESS), m0 = await count(MARKER);
  await hubCtl('stop'); fs.rmSync(H.stateDir, { recursive: true, force: true }); await hubCtl('start');
  const noSess = await until(async () => await count(NOSESS) > n0, 20000);
  await typeIn(T, tid, '\r');
  const marker = await until(async () => await count(MARKER) > m0, 10000);
  const alive = !!(await sessions()).find(s => s.sid === tid)?.alive;
  check('N8: after a stateDir wipe the card says No session; Enter starts a shell with the [new shell] marker', noSess && marker && alive, JSON.stringify({ noSess, marker, alive, tail: (await termText(T, tid)).slice(-300) }));
});
await section('cleanup', async () => { await T.evaluate(id => window.__canvas.removeNode(id), tid); await settled(T); await T.close(); await A.close(); });

// N30: a board with cmd and env, loaded in a fresh page, runs nothing. The No session line shows a board's cmd with its
// control characters escaped and names its env (SEC-2), and a board's `replay` is never typed into the shell Enter starts.
await section('N30', async () => {
  const pwned = path.join(TMP, 'pwned30'), replayed = path.join(TMP, 'replayed30');
  const cur = await api('/api/board'), etag = cur.headers.get('ETag'), board = await cur.json();
  board.nodes.n30 = { id: 'n30', kind: 'term', backend: 'pty', name: 'n30', x: 100, y: 100, w: 500, h: 260, cmd: `touch '${pwned}'`, env: { BASH_ENV: path.join(TMP, 'x') } };
  board.nodes.n30e = { id: 'n30e', kind: 'term', backend: 'pty', name: 'n30e', x: 100, y: 400, w: 1400, h: 260, cmd: 'echo n30e\x1b[2K\rbash', env: { PROMPT_COMMAND: 'true' } };
  board.nodes.n30r = { id: 'n30r', kind: 'term', backend: 'pty', name: 'n30r', x: 100, y: 700, w: 500, h: 260, env: {}, replay: `touch '${replayed}'\r` };
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(board) });
  const before = (await sessions()).map(s => s.sid).sort().join();
  const P = await dpage();
  await until(async () => (await termText(P, 'n30')).includes('No session: press Enter'), 8000); await sleep(500);
  const after = (await sessions()).map(s => s.sid).sort().join(), text = await termText(P, 'n30');
  check('N30: a cmd/env card from the board spawns nothing and says No session: press Enter', r.status === 204 && text.includes('No session: press Enter') && !fs.existsSync(pwned) && after === before && !after.split(',').includes('n30'),
    JSON.stringify({ put: r.status, before, after, file: fs.existsSync(pwned), text: text.slice(0, 200) }));
  await until(async () => (await termText(P, 'n30e')).includes('No session'), 8000);
  const etext = (await termText(P, 'n30e')).split('\n').join('');
  check('N30: the No session line shows a board cmd\'s control characters escaped and names its env', etext.includes('start echo n30e\\x1b[2K\\x0dbash with env PROMPT_COMMAND]'), JSON.stringify(etext.slice(0, 300)));
  await until(async () => (await termText(P, 'n30r')).includes('No session'), 8000);
  await typeIn(P, 'n30r', '\r');
  const spawned = await until(async () => (await sessions()).find(s => s.sid === 'n30r')?.alive, 8000); await sleep(2500);
  check('N30: Enter on a board card with replay starts its shell and types nothing into it', !!spawned && !fs.existsSync(replayed), JSON.stringify({ spawned: !!spawned, typed: fs.existsSync(replayed) }));
  await P.evaluate(() => ['n30', 'n30e', 'n30r'].forEach(id => window.__canvas.removeNode(id))); await settled(P); await P.close();
});

// DELTA-1 §C.1: Enter between a failed open's error and the server's 1000 close starts the shell on a new socket.
// The /pty sockets of this page are mocked: each card's first socket fails and closes 1.5 s later, the next one spawns.
await section('§C.1', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const tried = new Set(), log = [];
  await P.routeWebSocket(/\/pty$/, ws => {
    let first = null;
    ws.onMessage(m => {
      let o; try { o = JSON.parse(m); } catch { return; }
      if (o.t !== 'open') return;
      log.push({ id: o.id, spawn: o.spawn, again: !!first });
      if (first) return;
      first = o;
      if (tried.has(o.id)) return ws.send(JSON.stringify({ t: 'hello', new: true, epoch: 2, stream: 2, out: 0, resumed: false, cwd: '/' }));
      tried.add(o.id);
      ws.send(JSON.stringify({ t: 'error', error: 'no session', code: 'not_found' }));
      setTimeout(() => ws.close({ code: 1000 }), 1500);
    });
  });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    const id = await P.evaluate(() => window.__canvas.addNode({ kind: 'term', backend: 'pty', name: 'c1', x: 300, y: 300, w: 500, h: 260, env: {} }).id);
    await until(async () => (await termText(P, id)).includes('No session: press Enter'), 8000);
    await typeIn(P, id, '\r');
    await until(() => log.filter(e => e.id === id && !e.again).length >= 2, 5000);
    await sleep(2000);   // past the old socket's close
    const text = await termText(P, id), dead = await P.evaluate(id => window.__canvas.live[id].backend.dead, id), mine = log.filter(e => e.id === id);
    check('§C.1: Enter before a failed open\'s close spawns on a new socket, and the card is live without "connection closed"',
      mine.length === 2 && !mine[1].again && mine[1].spawn === true && !text.includes('connection closed') && text.includes('[new shell') && dead === false, JSON.stringify({ mine, dead, tail: text.slice(-300) }));
    await P.evaluate(id => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});

// SEC-2 (§3.5.1): a spawn is sent once. Each card's first /pty socket here takes the open and closes 1011 before any hello,
// as a hub lost after spawning would; the reconnect must attach (spawn:false), and the mock then answers not_found.
await section('SEC-2 reconnect', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const log = [];
  await P.routeWebSocket(/\/pty$/, ws => {
    let first = true;
    ws.onMessage(m => {
      let o; try { o = JSON.parse(m); } catch { return; }
      if (o.t !== 'open' || !first) return;
      first = false; log.push({ id: o.id, spawn: o.spawn });
      if (log.filter(e => e.id === o.id).length === 1) return void setTimeout(() => ws.close({ code: 1011 }), 100);
      ws.send(JSON.stringify({ t: 'error', error: 'no session', code: 'not_found' }));
      setTimeout(() => ws.close({ code: 1000 }), 200);
    });
  });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    const id = await P.evaluate(() => window.__canvas.addNode({ kind: 'term', backend: 'pty', name: 'sec2', x: 300, y: 300, w: 500, h: 260, env: {} }).id);
    await until(async () => (await termText(P, id)).includes('No session: press Enter'), 10000);
    const mine = log.filter(e => e.id === id);
    check('SEC-2: a socket closed after a spawn but before hello reconnects with spawn:false and offers Enter', mine.length === 2 && mine[0].spawn === true && mine[1].spawn === false, JSON.stringify(mine));
    await P.evaluate(id => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});

// §3.5.1: removing a card while its socket waits for the network still ends its session once the server is back
await section('kill while reconnecting', async () => {
  const P = await dpage();
  try {
    const id = await newTerm(P, 'reap');
    netCut();
    const waiting = await until(() => P.evaluate(id => window.__canvas.live[id]?.el.classList.contains('net-wait'), id), 8000);
    await P.evaluate(id => window.__canvas.removeNode(id), id);
    await sleep(500); netBack();
    const gone = await until(async () => !(await sessions()).some(s => s.sid === id), 20000);
    check('§3.5.1: a card removed while it reconnects ends its session when the server is back', waiting && gone, JSON.stringify({ waiting, gone, left: (await sessions()).filter(s => s.sid === id) }));
    await settled(P);
  } finally { netBack(); await P.close(); }
});

// ---- fix 1: acp cards (30 §10 N17-N26; DESIGN §9.5 N27-N29, N39, N41, N42) against the stub agent: wb-fake-acp under the
// agent key `stub`, scripted by prompt keyword (DESIGN §9.2). N26 needs no agent; the others skip when /api/info lists no
// `stub`. One card (AID) carries most checks in turn; each check leaves it idle.
const ACWD = fs.mkdtempSync(path.join(TMP, 'acp-'));
const acpWs = (p, id, since = 0) => WSL.filter(w => w.p === p && w.url.endsWith('/acp') && w.t >= since && (!id || w.open?.id === id));
const acpSent = (p, id, t, since = 0) => acpWs(p, id, since).flatMap(w => w.sent.filter(m => m.t === t));
// Journal events the page received after seq `after`, once each, from sockets opened since `since` (a new session's seq
// starts again at 1, so a check across Start new session passes `since`).
const acpEvs = (p, id, e, after = 0, since = 0) => {
  const m = new Map();
  for (const w of acpWs(p, id, since)) for (const f of w.recv) if (f.t === 'ev' && f.ev?.seq > after && (!e || f.ev.e === e)) m.set(f.ev.seq, f.ev);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
};
// The card paints once per frame (30 §1.3): a view waits out a pending paint, so its DOM shows every frame taken so far.
const acpView = (p, id) => p.evaluate(async id => {
  const C = window.__canvas, L = C.live[id], b = L?.backend; if (!b) return null;
  for (let i = 0; b.raf && i < 10; i++) await new Promise(r => { requestAnimationFrame(() => r()); setTimeout(r, 100); });
  const vis = e => !!e && !e.hidden && !e.closest('[hidden]'), st = L.body.querySelector('.ag-state');
  return { st: b.state(), tx: b.stateText(), badge: L.hdr.querySelector('.badge').textContent, seq: b.seq, epoch: b.epoch, alive: !!b.sum?.alive, activity: b.sum?.acp?.activity, promptable: b.promptable(),
    items: b.items.map(i => i.k + ':' + (i.k === 'tool' ? i.status + ' ' + (i.title || '') : i.text || '')), asst: L.body.querySelectorAll('.ag-log .ag-asst').length,
    perm: L.body.querySelectorAll('.ag-perm').length, form: L.body.querySelectorAll('.ag-form').length, url: L.body.querySelectorAll('.ag-url').length,
    state: vis(st) ? st.textContent : '', revive: vis(L.revive), ta: L.ta.value, ro: L.ta.readOnly, go: L.body.querySelector('.ag-row .go').textContent,
    mode: L.body.querySelector('.ag-mode').value, modes: [...L.body.querySelectorAll('.ag-mode option')].map(o => o.value) };
}, id);
const toastOf = p => p.evaluate(() => document.querySelector('#toast')?.textContent || '');
const acpClick = (p, id, sel) => p.evaluate(({ id, sel }) => { const b = window.__canvas.live[id].body.querySelector(sel); b?.click(); return !!b; }, { id, sel });
const acpIdle = (p, id, ms = 20000) => until(async () => { const v = await acpView(p, id); return v?.promptable && (v.st === 'idle' || v.st === 'done') ? v : null; }, ms);
async function acpNew(p) {   // through newAgentCard (30 §1.1): the picker only when there is more than one agent, then the folder
  const before = await p.evaluate(() => Object.keys(window.__canvas.S.nodes));
  await p.evaluate(() => window.__canvas.newAgentCard());
  if (await p.evaluate(() => document.querySelector('#ask').hidden)) { await p.fill('#pal-in', 'stub'); await sleep(200); await p.keyboard.press('Enter'); }
  await until(() => p.evaluate(() => !document.querySelector('#ask').hidden), 5000);
  await p.fill('#ask-in', ACWD); await p.keyboard.press('Enter');
  return until(() => p.evaluate(before => Object.values(window.__canvas.S.nodes).find(n => n.kind === 'acp' && !before.includes(n.id))?.id, before));
}
// Brings a card into view: a far zoom hides card bodies (visibility), and Playwright only types into visible fields.
const acpShow = (p, id) => p.evaluate(id => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); }, id);
async function acpSay(p, id, text) {   // the composer, as a user types it
  await until(async () => (await acpView(p, id))?.promptable, 20000);
  await acpShow(p, id);
  const ta = `.node[data-id="${id}"] .ag-in textarea`;
  await p.fill(ta, text); await p.press(ta, 'Enter');
}
// A second page whose /acp sockets pass through a route: `hold` keeps server frames back until release(), `refuse` closes
// new sockets 1011 at once, kick() drops the open ones with 1011, and drop(frame) keeps a page frame from the server.
// rpcDrop(frame) keeps a server frame on /rpc from the page.
async function gatedPage() {
  const P = await ctx.newPage(); watchErrors(P);
  const g = { hold: false, refuse: false, drop: () => false, rpcDrop: () => false, sent: [], recv: [], socks: [] };
  await P.routeWebSocket(/\/rpc$/, ws => { const server = ws.connectToServer(); server.onMessage(m => { if (!g.rpcDrop(JSON.parse(m))) ws.send(m); }); });
  const code = c => ([1005, 1006, 1015].includes(c) ? 1011 : c || 1000);   // codes a close frame cannot carry
  await P.routeWebSocket(/\/acp$/, ws => {
    if (g.refuse) return void ws.close({ code: 1011 });
    const server = ws.connectToServer(), s = { ws, server, buf: [] }; g.socks.push(s);
    const parse = m => { try { return JSON.parse(m); } catch { return null; } };
    ws.onMessage(m => { const o = parse(m); g.sent.push(o); if (!g.drop(o)) server.send(m); });
    server.onMessage(m => { g.recv.push(parse(m)); if (g.hold) s.buf.push(m); else ws.send(m); });
    ws.onClose(c => server.close({ code: code(c) }));
    server.onClose(c => ws.close({ code: code(c) }));
  });
  g.release = () => { g.hold = false; for (const s of g.socks) while (s.buf.length) s.ws.send(s.buf.shift()); };
  g.kick = () => { for (const s of g.socks.splice(0)) { s.ws.close({ code: 1011 }); s.server.close({ code: 1000 }); } };
  await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
  return { P, g };
}
let AP = null, AID = null, STUB = false, STUCK = false, RECONNECT = false;
await section('acp boot', async () => {
  AP = await dpage();
  st = await AP.evaluate(() => ({ agents: (window.__canvas.INFO?.agents || []).map(a => a.name), off: document.querySelector('#add-acp').disabled }));
  STUB = st.agents.includes('stub'); STUCK = st.agents.includes('stuck'); RECONNECT = st.agents.includes('reconnect');
  check('fix 1: the Agent button is enabled exactly when the server lists agents', st.off === !st.agents.length, JSON.stringify(st));
});
// N26 needs no agent: a board acp card mounts, and opens (if the server has /acp) without spawn fields
await section('N26', async () => {
  const cur = await api('/api/board'), etag = cur.headers.get('ETag'), board = await cur.json();
  board.nodes.n26a = { id: 'n26a', kind: 'agent', name: 'old-chat', x: 100, y: 1300, w: 400, h: 300, tier: 'quick', turns: [{}], log: [{ t: 'user', text: 'hi' }, { t: 'assistant', text: 'hello' }] };
  board.nodes.n26b = { id: 'n26b', kind: 'acp', name: 'agent26', agent: 'stub', cwd: ACWD, x: 600, y: 1300, w: 560, h: 520 };
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(board) });
  const P = await dpage();
  try {
    await sleep(1500);
    st = await P.evaluate(() => { const C = window.__canvas, a = C.S.nodes.n26a, b = C.S.nodes.n26b; return { a: a && { kind: a.kind, text: a.text, log: 'log' in a, turns: 'turns' in a }, b: b && { kind: b.kind, agent: b.agent, cwd: b.cwd }, mounted: !!C.live.n26b?.backend }; });
    const spawned = acpWs(P, 'n26b').some(w => 'agent' in w.open || 'cwd' in w.open);
    check('N26: migrateV9 still turns a legacy agent node into a page and leaves an acp node as it was; a board acp card opens without spawn fields',
      r.status === 204 && st.a?.kind === 'buffer' && /\(former agent node\)/.test(st.a.text) && /> hi\n\nhello/.test(st.a.text) && !st.a.log && !st.a.turns && st.b?.kind === 'acp' && st.b.agent === 'stub' && st.b.cwd === ACWD && st.mounted && !spawned, JSON.stringify({ put: r.status, st, spawned }));
    await P.evaluate(() => ['n26a', 'n26b'].forEach(id => window.__canvas.removeNode(id))); await settled(P);
  } finally { await P.close(); }
});
// F-A1, F-A2, F-A3, F-A4, F-A5 and seen on mocked /acp sockets: the server side is scripted here, so these run without an
// agent. `script(s, n)` answers the n-th open of a card; `s.on` takes the frames after it.
await section('acp mocked', async () => {
  const P = await ctx.newPage(); watchErrors(P);
  const socks = []; let script = () => {};
  await P.routeWebSocket(/\/acp$/, ws => {
    const s = { ws, sent: [] }; socks.push(s);
    ws.onMessage(m => { let o; try { o = JSON.parse(m); } catch { return; } s.sent.push(o); if (o.t === 'open' && !s.open) { s.open = o; script(s, socks.filter(x => x.open?.id === o.id).length); } else s.on?.(o); });
  });
  const send = (s, ...ms) => { for (const m of ms) s.ws.send(JSON.stringify(m)); };
  const info = (id, epoch, head, x = {}) => ({ sid: id, kind: 'acp', host: 'h', createdAt: epoch, updatedAt: epoch, alive: x.alive ?? true, viewers: 1, cwd: ACWD, state: x.state || 'idle', ...(x.fault ? { fault: x.fault } : {}),
    acp: { agent: 'stub', agentSessionId: 'a', revivable: x.revivable ?? true, activity: 'none', pending: x.pending || [], headSeq: head, seenSeq: x.seen ?? head, title: null, modeId: null } });
  const hello = (id, epoch, head, x = {}) => ({ t: 'hello', status: 'attached', info: info(id, epoch, head, x), head, from: x.from ?? 1, reset: !!x.reset });
  const ev = (seq, e, x = {}) => ({ t: 'ev', ev: { seq, ts: seq, e, ...x } });
  const opensOf = id => socks.filter(s => s.open?.id === id);
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED));
    // F-A4: a failed open is final; Start new session then opens with the spawn fields
    script = (s, n) => {
      if (n === 1) { send(s, { t: 'error', error: 'no session', code: 'not_found' }); setTimeout(() => s.ws.close({ code: 1000 }), 100); }
      else send(s, hello(s.open.id, 500, 2), ev(1, 'spawn', { pid: 1, via: 'new' }), ev(2, 'session', { via: 'new', sessionId: 'a' }), { t: 'replayed', head: 2, truncated: false });
    };
    const m1 = await P.evaluate(cwd => window.__canvas.addNode({ kind: 'acp', name: 'm1', agent: 'stub', cwd, x: 3000, y: 3400, w: 560, h: 420, _spawn: false }).id, ACWD);
    await sleep(4000);
    const v1 = await acpView(P, m1), n1 = opensOf(m1).length;
    await acpClick(P, m1, '.ag-state .acts button.go');
    const v1b = await until(async () => { const v = await acpView(P, m1); return v.promptable ? v : null; }, 5000), o2 = opensOf(m1)[1]?.open;
    check('F-A4 (mocked): an open that gets not_found makes one socket and shows No session; Start new session opens again with agent and cwd from since 0',
      n1 === 1 && !('agent' in opensOf(m1)[0].open) && v1.st === 'exited' && /No session for this card/.test(v1.state) && !!v1b && o2?.agent === 'stub' && o2.cwd === ACWD && o2.since === 0, JSON.stringify({ n1, v1: v1 && { st: v1.st, state: v1.state }, o2 }));
    await P.evaluate(id => window.__canvas.removeNode(id), m1);

    // F-A5 and F-A1: a prompt lost with its socket stays in the composer; the reconnect sends since and epoch; reset clears
    let echo = false;
    script = (s, n) => {
      if (n === 1) { send(s, hello(s.open.id, 1000, 2), ev(1, 'spawn', { pid: 1, via: 'new' }), ev(2, 'session', { via: 'new', sessionId: 'a' }), { t: 'replayed', head: 2, truncated: false }); s.on = o => { if (o.t === 'prompt') s.ws.close({ code: 1011 }); }; }
      else if (n === 2) {
        send(s, hello(s.open.id, 1000, 3), ev(3, 'update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' }, messageId: 'x' } }), { t: 'replayed', head: 3, truncated: false });
        s.on = o => { if (o.t === 'prompt') { echo = true; send(s, ev(4, 'prompt', { prompt: o.blocks })); setTimeout(() => s.ws.close({ code: 1011 }), 300); } };
      } else if (n === 3) {
        send(s, hello(s.open.id, 2000, 2, { reset: true }), ev(1, 'spawn', { pid: 2, via: 'new' }), ev(2, 'permission', { toolCall: { toolCallId: 't1', title: 'Edit a file', kind: 'edit' }, options: [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }] }), { t: 'replayed', head: 2, truncated: false });
        s.on = o => { if (o.t === 'permission') send(s, { t: 'error', error: 'stale', code: 'stale', rid: o.rid }); if (o.t === 'kill' && o.forget) setTimeout(() => s.ws.close({ code: 1000 }), 300); };
      } else send(s, hello(s.open.id, 3000, 1, { state: 'done', seen: 0 }), ev(1, 'spawn', { pid: 3, via: 'new' }), { t: 'replayed', head: 1, truncated: false });
    };
    const m2 = await P.evaluate(cwd => window.__canvas.addNode({ kind: 'acp', name: 'm2', agent: 'stub', cwd, x: 3000, y: 3400, w: 560, h: 420 }).id, ACWD);
    const TEXT = 'mocked prompt';
    await acpSay(P, m2, TEXT);
    const back = await until(async () => { const v = await acpView(P, m2); return opensOf(m2).length === 2 && v.promptable && v.asst === 1 ? v : null; }, 10000), o2b = opensOf(m2)[1]?.open;
    check('F-A5 (mocked): a prompt whose socket dropped before the echo is back in the composer, editable, after the reconnect; the reconnect sends since and epoch',
      !!back && back.ta === TEXT && !back.ro && back.go === 'Send' && o2b?.since === 2 && o2b.epoch === 1000 && !('agent' in o2b), JSON.stringify({ back: back && { ta: back.ta, ro: back.ro, go: back.go }, o2b }));
    await acpSay(P, m2, TEXT);
    const cleared = await until(async () => { const v = await acpView(P, m2); return echo && v.ta === '' && !v.ro ? v : null; }, 5000);
    check('F-A5 (mocked): the echo of this tab\'s prompt empties the composer', !!cleared, JSON.stringify(await acpView(P, m2)));
    const reset = await until(async () => { const v = await acpView(P, m2); return opensOf(m2).length === 3 && v.epoch === 2000 && v.perm === 1 ? v : null; }, 10000), o3 = opensOf(m2)[2]?.open;
    check('F-A1 (mocked): a hello with reset clears the transcript and the replay from seq 1 rebuilds it, with the pending permission', !!reset && o3?.since === 4 && o3.epoch === 1000 && reset.asst === 0 && !reset.items.some(x => x.startsWith('user:')) && reset.seq === 2, JSON.stringify({ o3, items: reset?.items, seq: reset?.seq }));
    await acpClick(P, m2, '.ag-perm button[data-kind="allow_once"]');
    const answer = await until(() => opensOf(m2)[2].sent.find(m => m.t === 'permission'), 5000);   // the route hears it a little later
    const stale = await until(async () => /belongs to an ended session/.test(await toastOf(P)) && (await acpView(P, m2)).perm === 0, 5000);
    check('F-A2 (mocked): an answer carries the epoch and the option; stale toasts "this request belongs to an ended session" and drops the panel', answer?.req === 2 && answer.epoch === 2000 && answer.outcome?.outcome === 'selected' && answer.outcome.optionId === 'y' && answer.rid != null && stale, JSON.stringify({ answer, toast: await toastOf(P) }));
    // F-A3: Start new session waits for the close 1000, never shows ended, and opens fresh; seen goes for a done state
    await P.evaluate(id => {
      const C = window.__canvas, L = C.live[id], b = L.hdr.querySelector('.badge'); window.__m3 = [];
      new MutationObserver(() => window.__m3.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
      C.jumpNode(C.S.nodes[id]); C.CMDS.find(c => c.l.startsWith('Agent: start a new session')).run();
    }, m2);
    const fresh = await until(async () => { const v = await acpView(P, m2); return v.epoch === 3000 ? v : null; }, 10000), o4 = opensOf(m2)[3]?.open, badges = await P.evaluate(() => [...new Set(window.__m3)]);
    const kill = opensOf(m2)[2].sent.find(m => m.t === 'kill'), seen = await until(() => opensOf(m2)[3]?.sent.find(m => m.t === 'seen'), 5000);
    check('F-A3 (mocked): Start new session sends kill forget, shows ending…, waits for the close, then opens with agent and cwd from since 0 and a fresh transcript',
      kill?.forget === true && badges.some(t => /ending…$/.test(t)) && !badges.some(t => /· ended$/.test(t)) && !!fresh && o4?.agent === 'stub' && o4.since === 0 && fresh.items.length === 1, JSON.stringify({ kill, badges, o4, items: fresh?.items }));
    check('§3.4.6 (mocked): a done card that is active in a visible, focused page sends seen with the head seq', seen?.seq === 1, JSON.stringify(opensOf(m2)[3]?.sent));
    await P.evaluate(id => window.__canvas.removeNode(id), m2);

    // ROB-2: a panel left from an ended incarnation never answers the new one's request, even one with the same req
    const permEv = (seq, title) => ev(seq, 'permission', { toolCall: { toolCallId: 't' + seq, title, kind: 'execute' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
    const mocked = name => P.evaluate(([name, cwd]) => window.__canvas.addNode({ kind: 'acp', name, agent: 'stub', cwd, x: 3000, y: 3400, w: 560, h: 420, _spawn: false }).id, [name, ACWD]);
    script = (s, n) => {
      if (n === 1) send(s, hello(s.open.id, 4000, 2), ev(1, 'spawn', { pid: 4, via: 'new' }), permEv(2, 'Old tool'), { t: 'replayed', head: 2, truncated: false });
      else send(s, hello(s.open.id, 5000, 2, { reset: true }), ev(1, 'spawn', { pid: 5, via: 'new' }), permEv(2, 'New tool'), { t: 'replayed', head: 2, truncated: false });
    };
    const m3 = await mocked('m3');
    await until(async () => (await acpView(P, m3))?.perm === 1, 5000);
    await P.evaluate(id => { window.__oldAllow = window.__canvas.live[id].body.querySelector('.ag-perm button[data-kind="allow_once"]'); }, m3);
    opensOf(m3)[0].ws.close({ code: 1011 });
    const fresh3 = await until(async () => { const v = await acpView(P, m3); return v.epoch === 5000 && v.perm === 1 ? v : null; }, 10000);
    const oldGone = await P.evaluate(() => { window.__oldAllow.click(); return !window.__oldAllow.isConnected; });
    await sleep(300);
    const leaked = opensOf(m3)[1]?.sent.filter(m => m.t === 'permission') || [];
    await acpClick(P, m3, '.ag-perm button[data-kind="allow_once"]');
    const own = await until(() => opensOf(m3)[1]?.sent.find(m => m.t === 'permission'), 5000);
    check('ROB-2 (mocked): after a hello with reset, a click on the old incarnation\'s panel sends nothing; the new panel answers with the new epoch',
      !!fresh3 && oldGone && !leaked.length && own?.req === 2 && own.epoch === 5000, JSON.stringify({ fresh: !!fresh3, oldGone, leaked, own }));
    await P.evaluate(id => window.__canvas.removeNode(id), m3);

    // §3.4.7: an answer lost with its socket can be given again after the reconnect; a request the hub no longer holds goes
    script = (s, n) => {
      if (n === 1) { send(s, hello(s.open.id, 6000, 3), ev(1, 'spawn', { pid: 6, via: 'new' }), permEv(2, 'First tool'), permEv(3, 'Second tool'), { t: 'replayed', head: 3, truncated: false }); s.on = o => { if (o.t === 'permission') s.ws.close({ code: 1011 }); }; }
      else send(s, hello(s.open.id, 6000, 3, { state: 'waiting_permission', pending: [{ req: 2, kind: 'permission', title: 'First tool', ts: 2 }] }), { t: 'replayed', head: 3, truncated: false });
    };
    const m4 = await mocked('m4');
    await until(async () => (await acpView(P, m4))?.perm === 2, 5000);
    await acpClick(P, m4, '.ag-perm button[data-kind="allow_once"]');
    const lost = await until(() => opensOf(m4)[0].sent.find(m => m.t === 'permission'), 5000);
    const panelOf = () => P.evaluate(id => [...window.__canvas.live[id].body.querySelectorAll('.ag-perm')].map(p => p.querySelector('.tt').textContent + (p.classList.contains('sent') ? ' (sent)' : '')), m4);
    const again = await until(async () => { const ps = await panelOf(); return opensOf(m4).length === 2 && ps.length === 1 && ps[0] === 'First tool' ? ps : null; }, 10000);
    await acpClick(P, m4, '.ag-perm button[data-kind="allow_once"]');
    const resent = await until(() => opensOf(m4)[1]?.sent.find(m => m.t === 'permission'), 5000);
    check('§3.4.7 (mocked): an answer lost with its socket can be given again after the reconnect, and a request the hub no longer holds goes',
      lost?.req === 2 && !!again && resent?.req === 2 && resent.epoch === 6000, JSON.stringify({ lost: lost?.req, panels: await panelOf(), opens: opensOf(m4).length, resent }));
    await P.evaluate(id => window.__canvas.removeNode(id), m4);

    // F-A16: a dead session that cannot be revived offers Start new session, also when it has a fault (a quarantined record)
    script = s => send(s, hello(s.open.id, 7000, 2, { alive: false, revivable: false, state: 'error', fault: { code: 'load_failed', message: 'the record could not be read' } }),
      ev(1, 'spawn', { pid: 7, via: 'new' }), ev(2, 'exit', { reason: 'hub_restart' }), { t: 'replayed', head: 2, truncated: false });
    const m5 = await mocked('m5');
    const v5 = await until(async () => { const v = await acpView(P, m5); return /Fault: the record could not be read/.test(v?.state || '') ? v : null; }, 5000);
    const acts5 = await P.evaluate(id => [...window.__canvas.live[id].body.querySelectorAll('.ag-state .acts button')].map(b => b.textContent), m5);
    check('F-A16 (mocked): a dead, faulted session that cannot be revived shows its fault, no ↻, and Start new session', !!v5 && !v5.revive && acts5.includes('Start new session'), JSON.stringify({ state: v5?.state, revive: v5?.revive, acts5 }));
    await P.evaluate(id => window.__canvas.removeNode(id), m5);

    // 30 §1.5: the docked terminal is never a board node, so its live session is no orphan; a session without a card is
    const orphans = await P.evaluate(cwd => {
      const C = window.__canvas, base = { kind: 'pty', host: 'h', createdAt: 1, updatedAt: 1, alive: true, viewers: 1, cwd, state: '', pty: { fg: { comm: 'bash' } } };
      C.SESS.dock = { ...base, sid: 'dock' }; C.SESS['zz-orphan'] = { ...base, sid: 'zz-orphan' };
      const keys = C.attnItems().map(i => i.key).filter(k => k.startsWith('orphan:'));
      delete C.SESS.dock; delete C.SESS['zz-orphan']; return keys;
    }, ACWD);
    check('30 §1.5 (mocked): the docked terminal\'s session is not listed as running without a card; a session without a card is', orphans.includes('orphan:zz-orphan') && !orphans.includes('orphan:dock'), JSON.stringify(orphans));
  } finally { await P.close(); }
});
if (!STUB) for (const n of ['N17', 'N18', 'N19', 'N20', 'N21', 'N22', 'N23', 'N24', 'N25', 'N27', 'N28', 'N29', 'N39', 'N41', 'N42']) skip(n, 'no stub agent in /api/info.agents (wb-fake-acp registered as `stub` in the test hub)');
else {
  await section('N17', async () => {
    await AP.evaluate(() => {   // every text each acp card's badge shows, from its first paint, by card id
      const seen = window.__n17b = {};
      window.__n17o = new MutationObserver(() => {
        for (const n of document.querySelectorAll('.node.k-acp')) { const b = n.querySelector('.badge'), s = seen[n.dataset.id] ||= []; if (b && s.at(-1) !== b.textContent) s.push(b.textContent); }
      });
      window.__n17o.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const id = AID = await acpNew(AP);
    await until(async () => { const v = await acpView(AP, id); return v?.promptable && v.tx === 'idle'; }, 20000);
    const seen = await AP.evaluate(id => { window.__n17o.disconnect(); return (window.__n17b[id] || []).map(t => t.split(' · ').at(-1)); }, id), open = acpWs(AP, id)[0]?.open;
    check('N17: newAgentCard opens with agent and cwd from since 0, and the badge goes … → idle', open?.agent === 'stub' && open?.cwd === ACWD && open?.since === 0 && seen[0] === '…' && seen.at(-1) === 'idle', JSON.stringify({ open, seen }));
    // A page takes the focus, so the turn's end stays done until the card is looked at.
    const nb = await AP.evaluate(() => { const C = window.__canvas, b = C.addNode({ kind: 'buffer', name: 'n17', x: 3000, y: 3000, w: 300, h: 200, text: '# n17' }); C.jumpNode(b); return b.id; });
    await AP.evaluate(id => { const b = window.__canvas.live[id].hdr.querySelector('.badge'); window.__n17 = []; new MutationObserver(() => window.__n17.push(b.className)).observe(b, { attributes: true }); }, id);
    const v0 = await acpView(AP, id), seen0 = acpSent(AP, id, 'seen').length, recv0 = acpWs(AP, id).map(w => w.recv.length);
    await AP.evaluate(id => window.__canvas.live[id].backend.input('stream\r'), id);
    // /rpc may bring the done summary before /acp brings the turn's events, so done counts once turn_end is folded.
    const done = await until(async () => { const v = await acpView(AP, id), end = acpEvs(AP, id, 'turn_end', v0.seq)[0]; return v.st === 'done' && end && v.seq >= end.seq ? v : null; }, 20000, 50);
    await sleep(500);
    // The three chunks come at once and the card paints once per frame (30 §1.3), so `running` is checked in the info
    // frames the card took (its state is info.state) and `done` in the painted badge.
    const infos = acpWs(AP, id).flatMap((w, i) => w.recv.slice(recv0[i] || 0)).filter(f => f.t === 'info').map(f => f.info?.state).filter((s, i, a) => s !== a[i - 1]);
    const states = await AP.evaluate(() => [...new Set(window.__n17)]), chunks = acpEvs(AP, id, 'update', v0.seq).filter(e => e.update?.sessionUpdate === 'agent_message_chunk').length, noSeen = acpSent(AP, id, 'seen').length === seen0;
    check('N17: "stream" renders its chunks in one .ag-asst item, and the turn goes running → done while the card is not looked at', !!done && done.asst === v0.asst + 1 && chunks >= 2 && infos.indexOf('running') >= 0 && infos.indexOf('running') < infos.lastIndexOf('done') && states.includes('badge st-done') && noSeen, JSON.stringify({ infos, states, asst: [v0.asst, done?.asst], chunks, noSeen }));
    const treeOf = () => AP.evaluate(id => document.querySelector(`#tp-list .tp-row[data-id="${id}"] .tp-mt`)?.textContent ?? null, id);
    const tree = await until(async () => { const t = await treeOf(); return /· done/.test(t || '') ? t : null; }, 3000);
    check('N17: the Folders tree row shows the card\'s state as it changes (30 §1.6)', !!tree, JSON.stringify({ tree: await treeOf() }));
    await AP.evaluate(id => window.__canvas.jumpNode(window.__canvas.S.nodes[id]), id);
    const idle = await until(async () => { const v = await acpView(AP, id); return v.st === 'idle' ? v : null; }, 10000);
    const sent = acpSent(AP, id, 'seen');
    check('N17: once the card is active in a visible, focused page, seen goes with the head seq and the state becomes idle', !!idle && sent.length === seen0 + 1 && sent.at(-1).seq === done?.seq, JSON.stringify({ sent, st: idle?.st, head: done?.seq }));
    await AP.evaluate(nb => window.__canvas.removeNode(nb), nb);
  });
  await section('N18', async () => {
    const id = AID, s0 = (await acpView(AP, id)).seq;
    await acpSay(AP, id, 'tool');
    const v = await acpIdle(AP, id);
    const sts = acpEvs(AP, id, 'update', s0).map(e => e.update).filter(u => /^tool_call/.test(u?.sessionUpdate || '')).map(u => u.status || (u.sessionUpdate === 'tool_call' ? 'pending' : '')).filter((x, i, a) => x && x !== a[i - 1]);
    st = await AP.evaluate(id => { const t = [...window.__canvas.live[id].body.querySelectorAll('.ag-log .ag-tool')].at(-1); return t && { status: t.dataset.status, glyph: t.querySelector('.tg').textContent, add: t.querySelectorAll('.ag-diff .add').length, del: t.querySelectorAll('.ag-diff .del').length }; }, id);
    check('N18: "tool" goes pending → in_progress → completed and its diff has .add and .del rows', !!v && sts.join() === 'pending,in_progress,completed' && st?.status === 'completed' && st.glyph === '✓' && st.add > 0 && st.del > 0, JSON.stringify({ sts, st }));
  });
  await section('N19', async () => {
    const id = AID; await settled(AP);
    const { P: B, g } = await gatedPage();
    try {
      await until(async () => (await acpView(B, id))?.promptable, 20000);
      const s0 = (await acpView(AP, id)).seq;
      await acpSay(AP, id, 'perm');
      const both = await until(async () => (await acpView(AP, id)).perm === 1 && (await acpView(B, id)).perm === 1, 15000);
      const btns = await AP.evaluate(id => [...window.__canvas.live[id].body.querySelectorAll('.ag-perm button')].map(b => b.dataset.kind + '|' + b.textContent), id);
      g.hold = true;   // B hears nothing more until its own click went out
      await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]');
      const goneA = await until(async () => (await acpView(AP, id)).perm === 0, 10000), res = await until(() => acpEvs(AP, id, 'permission_resolved', s0)[0], 5000);
      const stillB = (await acpView(B, id)).perm === 1;
      await acpClick(B, id, '.ag-perm button[data-kind="allow_once"]');
      await until(() => g.sent.some(m => m?.t === 'permission'), 5000); await sleep(500); g.release();
      const goneB = await until(async () => (await acpView(B, id)).perm === 0, 10000), late = await until(async () => /already answered/.test(await toastOf(B)), 5000);
      check('N19: a permission shows in both pages; allow in one clears the other, whose late click toasts already answered', both && goneA && res?.by === 'user' && stillB && goneB && late && g.recv.some(m => m?.t === 'error' && m.code === 'already_resolved'), JSON.stringify({ both, goneA, res, stillB, goneB, late, toast: await toastOf(B) }));
      check('N19: the allow_always button says the agent remembers it', btns.some(x => /^allow_always\|.+ · remembered by /.test(x)), btns.join(' / '));
      await acpIdle(AP, id);
    } finally { await B.close(); }
  });
  await section('N20', async () => {
    const id = AID, s0 = (await acpView(AP, id)).seq;
    await acpSay(AP, id, 'form');
    const ev = await until(() => acpEvs(AP, id, 'elicitation', s0)[0], 15000);
    await until(async () => (await acpView(AP, id)).form === 1, 5000);
    st = await AP.evaluate(({ id, schema }) => {
      const box = window.__canvas.live[id].body.querySelector('.ag-form'), acc = [...box.querySelectorAll('.acts button')].find(b => b.textContent === 'Accept');
      const need = new Set(schema.required || []), want = {}, kinds = [], fire = e => e.dispatchEvent(new Event('input', { bubbles: true }));
      const fill = (k, p) => {
        const row = box.querySelector(`.fld[data-key="${CSS.escape(k)}"]`), sel = row.querySelector('select'), many = row.querySelectorAll('.multi input'), inp = row.querySelector('input, textarea');
        if (sel) { const o = [...sel.options].find(o => o.value !== ''); sel.value = o.value; want[k] = o.value; kinds.push('enum'); fire(sel); }
        else if (many.length) { many[0].checked = true; want[k] = [many[0].value]; kinds.push('multi'); fire(many[0]); }
        else if (inp?.type === 'checkbox') { inp.checked = true; want[k] = true; kinds.push('boolean'); fire(inp); }
        else if (inp?.type === 'number') { const v = p.minimum ?? 1; inp.value = String(v); want[k] = v; kinds.push(p.type); fire(inp); }
        else if (inp) { const v = 'n20'.padEnd(p.minLength || 0, 'x'); inp.value = v; want[k] = v; kinds.push('string'); fire(inp); }
      };
      const props = Object.entries(schema.properties || {});
      for (const [k, p] of props) if (!need.has(k)) fill(k, p);
      // A required enum has no empty option, so it starts on its first choice (30 §1.4); clear it to see Accept wait.
      for (const k of need) { const sel = box.querySelector(`.fld[data-key="${CSS.escape(k)}"] select`); if (sel) { sel.selectedIndex = -1; fire(sel); } }
      const before = acc.disabled;
      for (const [k, p] of props) if (need.has(k)) fill(k, p);
      const after = acc.disabled; acc.click();
      return { before, after, want, kinds, need: [...need] };
    }, { id, schema: ev?.request?.requestedSchema || {} });
    const res = await until(() => acpEvs(AP, id, 'elicitation_resolved', s0)[0], 10000);
    const sorted = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
    // The hub journals the response it forwards verbatim (10 §11.3 `elicitation`), so the journal shows what the stub got.
    check('N20: a form shows enum, integer, boolean and multi-select fields; Accept stays off until the required field is filled; the stub gets the exact content',
      ['enum', 'integer', 'boolean', 'multi'].every(k => st.kinds.includes(k)) && st.need.length > 0 && st.before === true && st.after === false && res?.response?.action === 'accept' && sorted(res.response.content) === sorted(st.want), JSON.stringify({ st, res }));
    await acpIdle(AP, id);
  });
  await section('N21', async () => {
    const id = AID, s0 = (await acpView(AP, id)).seq;
    await AP.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });   // no real tab
    await acpSay(AP, id, 'url');
    const ev = await until(() => acpEvs(AP, id, 'elicitation', s0)[0], 15000);
    await until(async () => (await acpView(AP, id)).url === 1, 5000);
    const href = String(ev?.request?.url || '');
    st = await AP.evaluate(id => {
      const C = window.__canvas, d = C.live[id].body.querySelector('.ag-url'), o = d.querySelector('button.open');
      const js = C.AcpBackend.prototype.elicitPanel.call({ answerElicitation() {} }, 1, { request: { mode: 'url', url: 'javascript:alert(1)', message: 'm', elicitationId: 'x' } });
      return { off: o.disabled, host: d.querySelector('code b')?.textContent ?? null, links: d.querySelectorAll('a').length, jsOff: js.querySelector('button.open').disabled };
    }, id);
    if (!st.off) await acpClick(AP, id, '.ag-url button.open');
    const opened = await AP.evaluate(() => window.__opened);
    const waiting = await until(async () => (await acpView(AP, id)).items.some(x => /waiting/.test(x)), 5000);
    const complete = await until(() => acpEvs(AP, id, 'elicitation_complete', s0)[0], 15000);
    const shown = await until(async () => (await acpView(AP, id)).items.some(x => /completed/.test(x)), 5000);
    const u = href.startsWith('https:') ? new URL(href) : null;
    check('N21: Open is disabled for a javascript: URL; for https: it shows the host, opens with noopener, sends accept, and the log waits until elicitation/complete',
      st.jsOff && !!u && !st.off && st.host === u.host && st.links === 0 && opened.length === 1 && opened[0][0] === u.href && /noopener/.test(opened[0][2]) && acpSent(AP, id, 'elicitation').some(m => m.response?.action === 'accept') && waiting && !!complete && shown, JSON.stringify({ href, st, opened, waiting, complete: !!complete, shown }));
    await acpIdle(AP, id);
  });
  await section('N22', async () => {
    const id = AID, s0 = (await acpView(AP, id)).seq, c0 = acpSent(AP, id, 'cancel').length;
    await acpSay(AP, id, 'slow');
    await until(async () => (await acpView(AP, id)).activity === 'turn', 10000);
    await AP.click(`.node[data-id="${id}"] .ag-row .stop`);
    const end = await until(() => acpEvs(AP, id, 'turn_end', s0)[0], 15000), v = await until(async () => { const v = await acpView(AP, id); return v.st === 'idle' ? v : null; }, 10000);
    check('N22: Stop sends cancel; the turn ends cancelled and the card is idle, not done', acpSent(AP, id, 'cancel').length === c0 + 1 && end?.stopReason === 'cancelled' && !!v, JSON.stringify({ cancels: acpSent(AP, id, 'cancel').length - c0, end, st: v?.st }));
    const m0 = await acpView(AP, id), other = m0.modes.find(m => m !== m0.mode);
    if (other != null) await AP.selectOption(`.node[data-id="${id}"] .ag-mode`, other);
    const follow = await until(async () => { const v = await acpView(AP, id); return acpEvs(AP, id, null, m0.seq).some(e => e.e === 'mode' || e.update?.sessionUpdate === 'current_mode_update') && v.mode === other ? v : null; }, 10000);
    check('N22: the mode select (two modes) sends set_mode and follows the mode the agent reports', m0.modes.length === 2 && other != null && acpSent(AP, id, 'set_mode').some(m => m.modeId === other) && !!follow, JSON.stringify({ modes: m0.modes, mode: m0.mode, other, sent: acpSent(AP, id, 'set_mode'), now: follow?.mode }));
  });
  await section('N24', async () => {
    const id = AID;
    await acpSay(AP, id, 'perm');
    await until(async () => { const v = await acpView(AP, id); return v.perm === 1 && v.st === 'waiting_permission'; }, 15000);
    st = await AP.evaluate(id => { const C = window.__canvas; C.statusRender(); const chip = [...document.querySelectorAll('#st-host .stc')].find(b => b.textContent.startsWith('✦')); return { chip: chip?.textContent, bad: chip?.classList.contains('bad'), attn: C.attnItems().filter(i => i.key === id).map(i => i.name) }; }, id);
    check('N24: a card waiting for permission makes the ✦ chip read 1 waiting with class bad, and Attention says needs permission', /· 1 waiting$/.test(st.chip || '') && st.bad && st.attn.some(n => /needs permission$/.test(n)), JSON.stringify(st));
    await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]'); await acpIdle(AP, id);
    const pg = await AP.evaluate(() => window.__canvas.addNode({ kind: 'buffer', name: 'n24', x: 3000, y: 2000, w: 420, h: 240, text: '# n24\n\n- TODO Say hello from n24\n- TODO Second n24 task\n' }).id);
    await sleep(500);
    const s1 = (await acpView(AP, id)).seq;
    const r = await AP.evaluate(async () => { const C = window.__canvas, t = C.allTasks().find(t => /Say hello from n24/.test(t.text)); try { return await C.dispatchTask(t); } catch (e) { return { error: e.message }; } });
    const prompt = await until(() => acpEvs(AP, id, 'prompt', s1).find(e => JSON.stringify(e.prompt).includes('Say hello from n24')), 10000);
    const addr = await AP.evaluate(id => window.__canvas.addrOf(window.__canvas.S.nodes[id]), id), text1 = await AP.evaluate(pg => window.__canvas.live[pg].view.state.doc.toString(), pg);
    check('N24: dispatchTask sends the task to the idle acp card and writes session:: with its address', !!addr && r.session === addr && !!prompt && text1.includes('session:: ' + addr), JSON.stringify({ r, addr, prompt: !!prompt, text1 }));
    await acpIdle(AP, id);
    await acpSay(AP, id, 'slow');
    await until(async () => (await acpView(AP, id)).activity === 'turn', 10000);
    const r2 = await AP.evaluate(async shell => { const C = window.__canvas, t = C.allTasks().find(t => /Second n24 task/.test(t.text)); try { return await C.dispatchTask(t, { shell }); } catch (e) { return { error: e.message }; } }, r.shell);
    const text2 = await AP.evaluate(pg => window.__canvas.live[pg].view.state.doc.toString(), pg);
    check('N24: dispatch to a busy card fails with is busy and writes no session:: into the task', /is busy/.test(r2.error || '') && !/Second n24 task\n\s+session::/.test(text2), JSON.stringify({ r2, text2 }));
    await acpClick(AP, id, '.ag-row .stop'); await acpIdle(AP, id);   // N22 clicks Stop for real; here the n24 page may cover it
    await AP.evaluate(pg => window.__canvas.removeNode(pg), pg);
  });
  await section('N23', async () => {
    const id = AID, name = await AP.evaluate(id => window.__canvas.S.nodes[id].name, id), before = (await acpIdle(AP, id))?.items || [];
    // A page takes the focus, so the interrupted turn stays unseen until the card is looked at.
    const nb = await AP.evaluate(() => { const C = window.__canvas, b = C.addNode({ kind: 'buffer', name: 'n23', x: 3000, y: 3000, w: 300, h: 200, text: '# n23' }); C.jumpNode(b); return b.id; });
    const seen0 = acpSent(AP, id, 'seen').length;
    await AP.evaluate(id => window.__canvas.live[id].backend.input('slow\r'), id);
    const turn = await until(async () => (await acpView(AP, id)).activity === 'turn', 15000);
    if (!await hubCtl('stop')) { await AP.evaluate(nb => window.__canvas.removeNode(nb), nb); return skip('N23', 'the harness did not acknowledge "stop hub"'); }
    await sleep(1000); const t1 = Date.now(); await hubCtl('start');
    // ↻ shows from the exit the card saw before the stop; the state is read once the card is attached to the new hub.
    const err = await until(async () => { const v = await acpView(AP, id); return v.st === 'error' && v.revive && acpWs(AP, id, t1).some(w => w.hello && !w.closed) ? v : null; }, 40000);
    const head = await AP.evaluate(id => window.__canvas.live[id].backend.sum?.acp?.headSeq, id), last = acpEvs(AP, id, 'turn_error').at(-1);
    const attn = await AP.evaluate(id => window.__canvas.attnItems().filter(i => i.key === id).map(i => i.name), id), unseen = acpSent(AP, id, 'seen').length === seen0;
    check('N23: a mid-turn hub restart shows error (interrupted) with ↻ and "failed" in Attention while the card is not looked at, and sends no seen',
      turn && !!err && last?.code === 'interrupted' && attn.includes(name + ' failed') && unseen, JSON.stringify({ turn, st: (await acpView(AP, id))?.st, last, attn, unseen }));
    await AP.evaluate(id => window.__canvas.jumpNode(window.__canvas.S.nodes[id]), id);
    const det = await until(async () => { const v = await acpView(AP, id); return v.st === 'detached' && v.revive ? v : null; }, 10000), seen = acpSent(AP, id, 'seen');
    check('N23: once the card is looked at, seen goes with the head seq and the state becomes detached with ↻', !!det && seen.length === seen0 + 1 && seen.at(-1).seq === head, JSON.stringify({ st: (await acpView(AP, id))?.st, seen, head }));
    await AP.evaluate(id => window.__canvas.live[id].revive.click(), id);
    const back = await until(async () => { const v = await acpView(AP, id); return v.alive && v.promptable ? v : null; }, 30000);
    const intact = !!back && before.length > 0 && before.every((x, i) => back.items[i] === x);
    if (back) await acpSay(AP, id, 'stream');
    const more = back && await until(async () => { const v = await acpView(AP, id); return v.asst > back.asst && v.promptable ? v : null; }, 20000);
    check('N23: ↻ revives it with its transcript, and a new prompt works', !!det && acpSent(AP, id, 'revive').length >= 1 && intact && !!more, JSON.stringify({ intact, before: before.length, after: back?.items.length, more: !!more }));
    await AP.evaluate(nb => window.__canvas.removeNode(nb), nb);
  });
  await section('N25', async () => {
    const id = AID, epoch = (await acpIdle(AP, id))?.epoch;
    await settled(AP); await AP.close();   // the session stays: a page that goes sends no kill
    // the test hook: the node leaves the board without a kill, as a lost card would
    const cur = await api('/api/board'), etag = cur.headers.get('ETag'), board = await cur.json(); delete board.nodes[id];
    const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(board) });
    AP = await dpage();
    const item = await until(() => AP.evaluate(id => { const i = window.__canvas.attnItems().find(i => i.key === 'orphan:' + id); return i && { name: i.name, attn: i.attn, meta: i.meta }; }, id), 10000);
    const t1 = Date.now();
    if (item) await AP.evaluate(id => window.__canvas.attnItems().find(i => i.key === 'orphan:' + id).go(), id);
    const w = await until(() => acpWs(AP, id, t1).find(w => w.hello), 10000);
    check('N25: a live session with no card is listed as running without a card; adopting it makes a card with the same id that attaches without spawning',
      r.status === 204 && /running without a card$/.test(item?.name || '') && item.attn === 'bad' && item.meta === ACWD && !!w && !('agent' in w.open) && w.hello.info?.createdAt === epoch && await AP.evaluate(id => window.__canvas.S.nodes[id]?.kind === 'acp', id), JSON.stringify({ put: r.status, item, open: w?.open, epoch, got: w?.hello?.info?.createdAt }));
    await acpIdle(AP, id);
  });
  // N27 needs the request in the middle: `reconnect` = wb-fake-acp --scenario permission-reconnect, whose prompt streams 116
  // chunks, asks a permission and streams 80 more. In a fresh session: spawn 1, session 2, prompt 3, the request at 120, head 200.
  await section('N27', async () => {
    if (!RECONNECT) return skip('N27', 'no `reconnect` agent (wb-fake-acp --scenario permission-reconnect) in /api/info.agents');
    const id = await AP.evaluate(cwd => window.__canvas.addNode({ kind: 'acp', name: 'n27', agent: 'reconnect', cwd, x: 3000, y: 2600, w: 560, h: 520 }).id, ACWD);
    await acpSay(AP, id, 'go');
    const pre = await until(async () => { const v = await acpView(AP, id); return v?.perm === 1 && v.seq >= 200 ? v : null; }, 20000);
    await sleep(500);
    const logOf = () => AP.evaluate(id => [...window.__canvas.live[id].body.querySelectorAll('.ag-log > *')].map(e => e.className + ':' + e.textContent), id), dom0 = await logOf();
    await settled(AP); await AP.reload(); await until(() => AP.evaluate(() => window.__canvas?.BOOTED));
    const after = await until(async () => { const v = await acpView(AP, id); return v?.perm === 1 && v.seq >= 200 ? v : null; }, 20000);
    await sleep(500);
    const dom1 = await logOf(), items = after?.items || [], at = items.findIndex(x => x.startsWith('tool:')), perm = acpEvs(AP, id, 'permission')[0];
    const inOrder = items.length === 200 && at === 119 && items[at] === 'tool:pending Run `make check`'
      && items.slice(3, at).every((x, i) => x === 'asst:before ' + (i + 1)) && items.slice(at + 1).every((x, i) => x === 'asst:after ' + (i + 117));
    await acpClick(AP, id, '.ag-perm button[data-kind="allow_once"]');
    const res = await until(() => acpEvs(AP, id, 'permission_resolved', 200)[0], 10000);
    check('N27: a reload with a permission pending at seq 120 of 200 renders all 200 items in order with the request in its place, and the panel answers',
      !!pre && !!after && perm?.seq === 120 && after.seq === 200 && inOrder && JSON.stringify(items) === JSON.stringify(pre.items) && dom1.length === dom0.length && dom1.every((t, i) => t === dom0[i]) && res?.by === 'user',
      JSON.stringify({ seq: after?.seq, perm: perm?.seq, n: items.length, at, around: items.slice(at - 1, at + 2), same: JSON.stringify(items) === JSON.stringify(pre?.items), n0: dom0.length, n1: dom1.length, diff: dom1.findIndex((t, i) => t !== dom0[i]), res }));
    await AP.evaluate(id => window.__canvas.removeNode(id), id); await settled(AP);
  });
  await section('N28', async () => {
    const id = AID, before = await acpIdle(AP, id);
    netCut();
    await until(() => AP.evaluate(id => window.__canvas.live[id].el.classList.contains('net-wait'), id), 10000);
    if (!await hubCtl('stop')) { netBack(); return skip('N28', 'the harness did not acknowledge "stop hub"'); }
    fs.rmSync(H.stateDir, { recursive: true, force: true }); await hubCtl('start');
    // the same sid again, from another client: a new incarnation the card has not seen
    const r = spawnSync('python3', ['-I', path.join(path.dirname(HARNESS), 'wbctl.py'), '--hub', H.hubSocket, 'raw', JSON.stringify({ t: 'acp.open', rid: 1, sid: id, since: 0, spawn: { agent: 'stub', cwd: ACWD } })], { encoding: 'utf8', timeout: 20000 });
    const t1 = Date.now(); netBack();
    const w = await until(() => acpWs(AP, id, t1).find(w => w.hello), 40000), after = await until(async () => { const v = await acpView(AP, id); return v?.promptable ? v : null; }, 20000);
    const first = w?.recv.find(m => m.t === 'ev'), now = await acpView(AP, id), last = Math.max(0, ...(w?.recv || []).filter(m => m.t === 'ev').map(m => m.ev.seq));
    check('N28: a hello with reset (stateDir wiped, the session recreated) clears the card and repopulates its transcript from seq 1',
      r.status === 0 && w?.hello.reset === true && w.open.epoch === before?.epoch && first?.ev.seq === 1 && !!after && after.epoch !== before.epoch && after.asst === 0 && after.items.length < before.items.length
      && after.items.includes('note:agent started') && after.items.includes('note:session ready') && now?.seq === last,
      JSON.stringify({ wbctl: r.status, err: (r.stderr || '').slice(0, 200), reset: w?.hello?.reset, first: first?.ev, before: before?.items.length, after: after?.items, seq: now?.seq, last }));
  });
  await section('N29', async () => {
    const id = AID; await acpIdle(AP, id); await settled(AP);
    const { P: S2, g } = await gatedPage();
    try {
      await until(async () => (await acpView(S2, id))?.promptable, 20000);
      await acpSay(AP, id, 'perm');
      await until(async () => (await acpView(S2, id)).perm === 1 && (await acpView(AP, id)).perm === 1, 15000);
      const old = (await acpView(S2, id)).epoch;
      // The stale tab loses its socket and stays off while the other tab starts a new session; /rpc's `gone` would tell
      // it first (ROB-19), so it is held back here and the answer reaches the hub's epoch check.
      g.rpcDrop = m => m.t === 'gone' && m.sid === id;
      g.refuse = true; g.kick();
      await until(() => S2.evaluate(id => window.__canvas.live[id].el.classList.contains('net-wait'), id), 5000);
      const t1 = Date.now();
      await AP.evaluate(id => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); C.CMDS.find(c => c.l.startsWith('Agent: start a new session')).run(); }, id);
      const fresh = await until(async () => { const v = await acpView(AP, id); return v.promptable && v.epoch !== old ? v : null; }, 30000);
      const opens = g.sent.filter(m => m?.t === 'open').length;
      g.hold = true; g.refuse = false;   // it reconnects, but hears nothing before it answers the old request
      await until(() => g.sent.filter(m => m?.t === 'open').length > opens, 40000);
      const clicked = await acpClick(S2, id, '.ag-perm button[data-kind="allow_once"]');
      await until(() => g.sent.some(m => m?.t === 'permission'), 5000); await sleep(800); g.release();
      const toast = await until(async () => /belongs to an ended session/.test(await toastOf(S2)), 10000);
      await sleep(1000);
      const got = acpEvs(AP, id, null, 0, t1).filter(e => /^permission/.test(e.e));
      check('N29: a stale tab that answers a permission after Start new session in another tab toasts "this request belongs to an ended session", and the new session gets nothing',
        !!fresh && clicked && g.sent.find(m => m?.t === 'permission')?.epoch === old && g.recv.some(m => m?.t === 'error' && m.code === 'stale') && toast && !got.length, JSON.stringify({ fresh: !!fresh, clicked, sent: g.sent.find(m => m?.t === 'permission') ?? null, errors: g.recv.filter(m => m?.t === 'error'), toast: await toastOf(S2), got }));
    } finally { await S2.close(); }
  });
  // N39 needs an agent that only SIGKILL ends: `stuck` = wb-fake-acp --scenario kill-stubborn, which ignores EOF and SIGTERM
  // and never ends a prompt (the keyword stub has no such prompt). The name shares no fuzzy match with `stub` (acpNew).
  await section('N39', async () => {
    if (!STUCK) return skip('N39', 'no `stuck` agent (wb-fake-acp --scenario kill-stubborn) in /api/info.agents');
    const id = await AP.evaluate(cwd => window.__canvas.addNode({ kind: 'acp', name: 'n39', agent: 'stuck', cwd, x: 3000, y: 2600, w: 560, h: 400 }).id, ACWD);
    await until(async () => (await acpView(AP, id))?.promptable, 20000);
    await AP.evaluate(id => window.__canvas.live[id].backend.input('n39\r'), id);   // a turn that never ends
    const turn = await until(async () => (await acpView(AP, id)).activity === 'turn', 10000);
    await AP.evaluate(id => {
      const L = window.__canvas.live[id], b = L.hdr.querySelector('.badge'), s = L.body.querySelector('.ag-state'); window.__n39 = [];
      new MutationObserver(() => window.__n39.push(b.textContent + ' | ' + (s.hidden ? '' : s.textContent))).observe(L.el, { childList: true, characterData: true, subtree: true, attributes: true });
    }, id);
    const e0 = (await acpView(AP, id)).epoch;
    await AP.evaluate(id => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); C.CMDS.find(c => c.l.startsWith('Agent: start a new session')).run(); }, id);
    const fresh = await until(async () => { const v = await acpView(AP, id); return v.promptable && v.epoch !== e0 ? v : null; }, 40000);
    const seen = await AP.evaluate(() => [...new Set(window.__n39)]);
    check('N39: Start new session on a card whose agent ignores SIGTERM shows ending…, then a fresh transcript, never ended elsewhere', !!turn && seen.some(t => /ending…/.test(t)) && !seen.some(t => /· ended |ended elsewhere/.test(t)) && !!fresh && fresh.asst === 0, JSON.stringify({ turn: !!turn, seen: seen.slice(0, 12), fresh: fresh && fresh.items }));
    await AP.evaluate(id => window.__canvas.removeNode(id), id);
  });
  await section('N41', async () => {
    const t1 = Date.now();
    const id = await AP.evaluate(cwd => window.__canvas.addNode({ kind: 'acp', name: 'n41', agent: 'stub', cwd, x: 3000, y: 2600, w: 560, h: 400, _spawn: false }).id, ACWD);
    await sleep(10000);
    const ws = acpWs(AP, id, t1), v = await acpView(AP, id);
    check('N41: an /acp open that gets not_found makes exactly one socket in 10 s, and the card offers Start new session',
      ws.length === 1 && ws[0].recv.some(m => m.t === 'error' && m.code === 'not_found') && v.st === 'exited' && /No session for this card/.test(v.state) && /Start new session/.test(v.state), JSON.stringify({ sockets: ws.length, recv: ws.map(w => w.recv.map(m => m.t + (m.code ? ':' + m.code : ''))), st: v?.st, state: v?.state }));
    await AP.evaluate(id => window.__canvas.removeNode(id), id);
  });
  await section('N42', async () => {
    const id = AID; await acpIdle(AP, id); await settled(AP);
    const { P: D, g } = await gatedPage();
    try {
      await until(async () => (await acpView(D, id))?.promptable, 20000);
      g.drop = m => m?.t === 'prompt';   // the prompt never arrives, so there is no echo
      const ta = `.node[data-id="${id}"] .ag-in textarea`, TEXT = 'n42 draft survives a restart';
      await acpShow(D, id); await D.fill(ta, TEXT); await D.press(ta, 'Enter');
      const pending = await until(async () => { const v = await acpView(D, id); return v.ro && v.go === 'Sending…' ? v : null; }, 5000);
      await webRestart();
      const back = await until(async () => { const v = await acpView(D, id); return v?.promptable ? v : null; }, 30000);
      check('N42: a prompt typed before a wb-web restart, with no echo, is still in the composer after the reconnect',
        !!pending && !!back && back.ta === TEXT && !back.ro && back.go === 'Send' && g.sent.filter(m => m?.t === 'open').length >= 2, JSON.stringify({ pending: !!pending, back: back && { ta: back.ta, ro: back.ro, go: back.go } }));
    } finally { await D.close(); }
  });
  await section('acp cleanup', async () => { await AP.evaluate(id => window.__canvas.removeNode(id), AID); await settled(AP); });
}
await AP?.close();

// N1-N3: the login page and expired sign-ins, by swapping the test Caddy's config through its admin socket (N-6)
const CADDY = path.join(path.dirname(HARNESS), 'caddy');
function caddyMode(mode) {
  const r = spawnSync('caddy', ['reload', '--config', path.join(CADDY, mode + '.Caddyfile'), '--adapter', 'caddyfile', '--address', 'unix/' + H.caddyAdmin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`caddy reload ${mode}: ${r.stderr}`);
}
if (!['expired', 'loginpage'].every(m => fs.existsSync(path.join(CADDY, m + '.Caddyfile')))) for (const n of ['N1', 'N2', 'N3']) skip(n, `no expired/loginpage Caddyfile in ${CADDY}`);
else {
  const LS_KEY = 'canvas-proto-board-v5';
  for (const [n, mode, kind] of [['N1', 'loginpage', 'not_json'], ['N2', 'expired', 'signed_out']]) await section(n, async () => {
    caddyMode(mode); t0 = Date.now();
    const P = await dpage(false);
    try {
      await until(() => P.evaluate(() => !document.querySelector('#boot-msg').hidden), 8000); await sleep(800);
      st = await P.evaluate(k => ({ shown: !document.querySelector('#boot-msg').hidden, kind: document.querySelector('#boot-msg').dataset.kind, s: !!window.__canvas.S, ls: localStorage.getItem(k) }), LS_KEY);
      check(`${n}: booting against the ${mode} mode shows the boot screen, keeps S null, writes no localStorage board and sends no PUT`, st.shown && st.kind === kind && !st.s && st.ls === null && !puts(t0).length, JSON.stringify(st));
    } finally { await P.close(); caddyMode('live'); }
  });
  // N3: expiry in the middle of a session
  await section('N3', async () => {
    const P = await dpage(); await settled(P);
    caddyMode('expired'); t0 = Date.now();
    let mv;
    try {
      mv = await moveCard(P, 35);
      await until(() => P.evaluate(() => window.__canvas.SAVE.paused === 'auth'), 8000); await sleep(3000);
      st = { b: await barOf(P), paused: await P.evaluate(() => window.__canvas.SAVE.paused), puts: puts(t0).length };
      // A Caddy reload closes the proxied sockets, so the page may see the expiry before its debounced PUT: at most one PUT.
      check('N3: an expired sign-in pauses saving behind the Signed out bar, which says the move is not saved, after at most one PUT', st.b.key === 'auth' && /^Signed out: changes since \d\d:\d\d are not saved yet/.test(st.b.text) && st.paused === 'auth' && st.puts <= 1, JSON.stringify(st));
    } finally { caddyMode('live'); }
    t0 = Date.now();
    await P.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => puts(t0).length, 8000); await settled(P); await sleep(500);
    const e = puts(t0)[0], disk = boardFile()?.nodes?.[mv.id];
    check('N3: signed in again, focus clears the bar and one PUT with If-Match saves the move', (await barOf(P)).hidden && puts(t0).length === 1 && !!e?.h['if-match'] && await status(e) === 204 && disk?.x === mv.x, JSON.stringify({ puts: puts(t0).length, im: e?.h['if-match'], disk, x: mv.x }));
    await P.close();
  });
}

// The docked terminal is never the active card: it sizes its PTY while it holds the keyboard, so widening the pane reaches the shell
await section('dock size', async () => {
  const P = await dpage(); await P.bringToFront();
  try {
    // boot mounts the dock without spawning (BOOTED is still false then); open the pane and start its shell
    await P.evaluate(() => { const C = window.__canvas; if (!(document.body.classList.contains('side-open') && C.S.sideTab === 'term')) C.toggleDockTerm(); });
    await until(() => P.evaluate(() => { const b = window.__canvas.live.dock?.backend; return !!(b?.helloSeen || b?.dead); }));
    if (await P.evaluate(() => !!window.__canvas.live.dock.backend.dead)) await typeIn(P, 'dock', '\r');
    await until(() => P.evaluate(() => { const b = window.__canvas.live.dock.backend; return !b.dead && b.helloSeen; }));
    await P.click('#side-term-body');
    const cols0 = await P.evaluate(() => window.__canvas.live.dock.term.cols);
    await P.evaluate(() => document.documentElement.style.setProperty('--pane-w', '900px'));
    await until(() => P.evaluate(c => window.__canvas.live.dock.term.cols > c, cols0)); await sleep(300);
    const sz = await P.evaluate(() => { const t = window.__canvas.live.dock.term; return { cols: t.cols, rows: t.rows, focused: document.activeElement === t.textarea }; });
    await typeIn(P, 'dock', 'stty size\r');
    const seen = await until(() => termText(P, 'dock').then(x => x.includes(`${sz.rows} ${sz.cols}`)));
    check('the docked terminal holding the keyboard sizes its PTY when the pane widens', sz.focused && sz.cols > cols0 && !!seen, JSON.stringify({ cols0, sz, tail: (await termText(P, 'dock')).trim().split('\n').slice(-3) }));
  } finally { await P.close(); }
});

// N49: a server without a model says nothing about one at load, and no boot request is refused.
await section('N49', async () => {
  const since = Date.now(), P = await ctx.newPage(); watchErrors(P); record(P);
  await P.addInitScript(() => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast'); if (t?.classList.contains('show') && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent); }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true }); });
  try {
    await P.goto(ORIGIN + '/'); await until(() => P.evaluate(() => window.__canvas?.BOOTED)); await sleep(2500);
    const toasts = await P.evaluate(() => window.__toasts), sample = await P.evaluate(() => window.__canvas.INFO.sample);
    const refused = []; for (const e of REQ.filter(e => e.t >= since && e.url.startsWith(ORIGIN + '/api/'))) if (await status(e) >= 400) refused.push(e.url);
    check('N49: with /api/info.sample false the load shows no toast about a model or an API key, and no /api request of the load is refused', sample === false && !toasts.some(t => /claude|anthropic|api.?key|model/i.test(t)) && !refused.length, JSON.stringify({ sample, toasts, refused }));
  } finally { await P.close(); }
});

// N50: Enter on the active shell card puts the keyboard in that shell where the card stands; Shift-Enter opens it full screen.
await section('N50', async () => {
  const P = await dpage(); await P.bringToFront();
  try {
    const id = await newTerm(P, 'n50');
    await P.evaluate(id => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); }, id); await sleep(600);
    await P.evaluate(() => document.activeElement?.blur()); await P.keyboard.press('Enter'); await sleep(400);
    const inTerm = await P.evaluate(id => ({ term: !!document.activeElement?.closest(`.node[data-id="${id}"]`) && document.activeElement.classList.contains('xterm-helper-textarea'), focus: window.__canvas.FOCUS.cur }), id);
    await P.keyboard.type('echo n50-$((6*7))\r');
    const typed = await until(async () => (await termText(P, id)).includes('n50-42'), 5000);
    await P.evaluate(() => document.activeElement?.blur()); await P.keyboard.press('Shift+Enter'); await sleep(400);
    const tab = await P.evaluate(() => window.__canvas.FOCUS.cur);
    await P.evaluate(() => window.__canvas.focusHide());
    check('N50: Enter on the active shell card puts the keyboard in its terminal on the canvas; Shift-Enter opens it as a focus tab', inTerm.term && !inTerm.focus && !!typed && tab === id, JSON.stringify({ inTerm, typed: !!typed, tab, id }));
  } finally { await P.close(); }
});

// N11: over the whole daemon phase's request log
await section('N11', async () => {
  st = { token: REQ.filter(e => /[?&#]token=/.test(e.url)).map(e => e.url), xtoken: REQ.filter(e => 'x-token' in e.h).map(e => e.url), ws: [...new Set(WSL.map(w => w.url))] };
  const P = await dpage(false); st.manifest = await P.evaluate(() => document.querySelector('link[rel=manifest]')?.getAttribute('crossorigin')); await P.close();
  check('N11: no token in any URL or header; WebSocket URLs have no query; the manifest goes with credentials', !st.token.length && !st.xtoken.length && st.ws.length > 0 && st.ws.every(u => /^ws:\/\/127\.0\.0\.1:18443\/(rpc|pty|acp)$/.test(u)) && st.manifest === 'use-credentials', JSON.stringify(st));
});

await ctx.close(); await browser.close();
harness.stdin.end(); fwd.close();
// serviceWorkers: 'block' is an init script that touches navigator.serviceWorker in every frame; in a sandboxed web or
// artifact frame without allow-same-origin that read throws. The error is Playwright's, not the page's.
const realErrors = errors.filter(e => !/favicon|net::ERR|Failed to load resource|WebSocket connection to|Refused to (connect|frame|load)|Content Security Policy|manifest|sw\.js|ERR_FILE_NOT_FOUND|Failed to read the 'serviceWorker' property from 'Navigator'/.test(e));
check('no page errors', realErrors.length === 0, realErrors.slice(0, 6).join('\n'));
console.log('FAILS:', fails); console.log('SKIPS:', skips);
if (fails.length) console.log(hlog.slice(-1500));
else if (!skips.length) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fails.length || skips.length ? 1 : 0);
