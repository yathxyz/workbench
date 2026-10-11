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
async function dpage(boot = true) {
  const p = await ctx.newPage(); watchErrors(p);
  p.on('websocket', ws => {
    const w = { url: ws.url(), p, t: Date.now(), open: null, hello: null, closed: null }; WSL.push(w);
    ws.on('framesent', f => { if (w.open) return; try { const m = JSON.parse(f.payload); if (m.t === 'open') w.open = m; } catch {} });
    ws.on('framereceived', f => { if (w.hello) return; try { const m = JSON.parse(f.payload); if (m.t === 'hello') { w.hello = m; w.helloT = Date.now(); } } catch {} });
    ws.on('close', () => { w.closed = Date.now(); });
  });
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
      radius: ['.node', '#add-shell', '#repl-menu', '#pal-in'].map(s => cs(s, 'borderTopLeftRadius')), body: cs('body', 'backgroundColor'),
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
    check(`§A.5 ${scheme} (${how === 'auto' ? 'prefers-color-scheme' : 'data-theme'}): radius 0, Modus backgrounds, terminal bg-main, mono face loaded, no blurred shadow`,
      l.radius.every(r => r === '0px') && l.body === m.bgDim && l.termBg === m.bgMain && l.fontCheck && l.fontLoaded && !l.blurred.length, JSON.stringify(l));
  }
  await A.evaluate(() => window.__canvas.setTheme('auto')); await A.emulateMedia({ colorScheme: 'light' }); await settled(A);
});

// N32: web cards open only http(s); their frames never get allow-same-origin
await section('N32', async () => {
  st = await A.evaluate(async () => {
    const C = window.__canvas, frameOf = n => C.live[n.id].frame;
    const bad = ['javascript:window.__n32=1', 'data:text/html,<script>parent.__n32=2</script>'].map(url => C.addNode({ kind: 'web', name: 'n32', url, x: 3000, y: 3000, w: 400, h: 300 }));
    const typed = C.newWeb('javascript:window.__n32=3'), ok = C.newWeb('http://127.0.0.1:9/');
    let tool; try { await C.AGENT_TOOLS.find(t => t.name === 'open_web').run({ url: 'javascript:window.__n32=4' }); tool = 'ran'; } catch (e) { tool = 'refused'; }
    await new Promise(r => setTimeout(r, 300));
    const r = { srcs: bad.map(n => frameOf(n).getAttribute('src')), notes: bad.map(n => C.live[n.id].note.textContent), typed: typed.url, typedSrc: frameOf(typed).getAttribute('src'), tool, ran: window.__n32 ?? null,
      okSrc: frameOf(ok).getAttribute('src'), sandbox: frameOf(ok).getAttribute('sandbox') };
    for (const n of [...bad, typed, ok]) C.removeNode(n.id);
    return r;
  });
  check('N32: javascript: and data: web cards are refused; an http card\'s frame has no allow-same-origin', st.srcs.every(s => s === null) && st.notes.every(t => t.startsWith('Refused')) && st.typed === '' && st.typedSrc === null && st.tool === 'refused' && st.ran === null && st.okSrc === 'http://127.0.0.1:9/' && !/allow-same-origin/.test(st.sandbox), JSON.stringify(st));
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
  const P = await ctx.newPage(); watchErrors(P);
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
  // The exit text can arrive when the hub stops; the toast waits for wb-web to see the hub again.
  await until(async () => (await termText(T, tid)).includes(EXIT_HUB) && /hub restarted/.test(await T.evaluate(() => document.querySelector('#toast').textContent)), 20000);
  st = await T.evaluate(id => ({ toast: document.querySelector('#toast').textContent, attn: window.__canvas.attnItems().filter(a => a.key === id).length }), tid);
  check('N7: after the hub restarts the card shows the hub_restart text, the toast says so, and the card is not "ended"', (await termText(T, tid)).includes(EXIT_HUB) && /hub restarted/.test(st.toast) && st.attn === 0, JSON.stringify(st));
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

// N30: a board with cmd and env, loaded in a fresh page, runs nothing
await section('N30', async () => {
  const pwned = path.join(TMP, 'pwned30');
  const cur = await api('/api/board'), etag = cur.headers.get('ETag'), board = await cur.json();
  board.nodes.n30 = { id: 'n30', kind: 'term', backend: 'pty', name: 'n30', x: 100, y: 100, w: 500, h: 260, cmd: `touch '${pwned}'`, env: { BASH_ENV: path.join(TMP, 'x') } };
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(board) });
  const before = (await sessions()).map(s => s.sid).sort().join();
  const P = await dpage();
  await until(async () => (await termText(P, 'n30')).includes('No session: press Enter'), 8000); await sleep(500);
  const after = (await sessions()).map(s => s.sid).sort().join(), text = await termText(P, 'n30');
  check('N30: a cmd/env card from the board spawns nothing and says No session: press Enter', r.status === 204 && text.includes('No session: press Enter') && !fs.existsSync(pwned) && after === before && !after.split(',').includes('n30'),
    JSON.stringify({ put: r.status, before, after, file: fs.existsSync(pwned), text: text.slice(0, 200) }));
  await P.evaluate(() => window.__canvas.removeNode('n30')); await settled(P); await P.close();
});

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
