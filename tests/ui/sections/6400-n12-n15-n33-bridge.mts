import { check, section, sleep, until } from '../shared.mts';
import { api, boardFile, dpage, settled } from '../daemon.mts';

// fix 6 and M5-W3 (N12-N15, N33): artifacts in server mode. wb-web keeps the versions and the db; the page runs the
// head in an opaque-origin srcdoc frame with the bridge, as block cards and the demo do.
await section('N12-N15, N33', async () => {
  const P = await dpage();
  try {
    const id: string = await P.evaluate(async () => (await window.__canvas.newArtifact('n12')).id);
    const frameOf = async () => (await P.$(`.node[data-id="${id}"] .art-frame`))?.contentFrame();
    const live = await until(() => P.evaluate((id: string) => { const C = window.__canvas, L = C.live[id], f = L?.frame as HTMLIFrameElement; return L?.hello ? { srcdoc: f.hasAttribute('srcdoc'), src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox'), notice: L.notice.hidden, head: C.S.nodes[id].head } : null; }, id), 10000);
    const srv = await (await api('/api/artifact/' + id)).json();
    const disk = await until(() => { const d = boardFile()?.nodes?.[id] as ArtifactNode | undefined; return d?.head ? d : undefined; }, 8000);   // the save waits out its debounce
    check('N12: a new artifact is published to wb-web and runs its head in a srcdoc frame; the board keeps the head, not the page',
      !!live && live.srcdoc && live.src === null && live.notice && !!live.head && srv.meta?.head === live.head && srv.content?.kind === 'page' && srv.url === null && !!disk && disk.head === live.head && disk.html === undefined, JSON.stringify({ live, head: srv.meta?.head, disk: disk && { head: disk.head, html: !!disk.html } }));
    const fr = await frameOf();
    const origin = await fr!.evaluate(() => self.origin);
    await fr!.click('#count'); await sleep(600);
    check('N33: the artifact frame\'s origin is null, it has no allow-same-origin, and the bridge answers (db)', origin === 'null' && !/allow-same-origin/.test(live?.sandbox || '') && (await fr!.textContent('#out'))!.includes('count = 1'), JSON.stringify({ origin, sandbox: live?.sandbox, out: await fr!.textContent('#out') }));
    // N13: artifact.publish from inside the page makes a version on the server and the frame reloads; a stale writer gets 409.
    fr!.evaluate(() => { wb.use('artifact').then(a => a.publish('<title>Hi2</title><p id=v2>second</p>')).catch(() => {}); }).catch(() => {});
    await until(() => P.evaluate(() => !document.querySelector<HTMLElement>('#grant')!.hidden), 3000); if (await P.evaluate(() => !document.querySelector<HTMLElement>('#grant')!.hidden)) await P.click('#grant-allow');
    const v2 = await until(async () => { const f = await frameOf(); return f && await f.$('#v2').catch(() => null) ? f : null; }, 8000);
    const s2 = await (await api('/api/artifact/' + id)).json();
    const stale = await api('/api/artifact/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: 'x', ifMatch: srv.meta.head }) });
    const sj = await stale.json();
    check('N13: artifact.publish makes a second version on wb-web and the frame reloads with it; a PUT naming the old head is 409 with the current head',
      !!v2 && s2.meta.versions.length === 2 && s2.content.html.includes('second') && await P.evaluate((id: string) => window.__canvas.S.nodes[id].head, id) === s2.meta.head && stale.status === 409 && sj.error?.code === 'conflict' && sj.error?.head === s2.meta.head, JSON.stringify({ v2: !!v2, versions: s2.meta?.versions?.length, status: stale.status, sj }));
    // N14: the db is on wb-web (N33's count): a node whose board copy lost it takes it back.
    const db = await (await api('/api/db/' + id)).json();
    const restored = await P.evaluate(async (id: string) => { const C = window.__canvas, n = C.S.nodes[id]; n.db = { docs: {} }; C.dbLoad(n); for (let i = 0; i < 50 && !n.db.docs['data/counter']; i++) await new Promise(r => setTimeout(r, 100)); return n.db.docs['data/counter'] || null; }, id);
    check('N14: the db is kept by wb-web (GET /api/db), and a node without it takes it back from there', db.docs?.['data/counter']?.n === 1 && restored?.n === 1, JSON.stringify({ db, restored }));
    // N15: another writer (another tab, wb) publishes; reloading the card shows that head and its versions.
    const other = await api('/api/artifact/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '<p id=v3>third</p>', ifMatch: s2.meta.head }) });
    const oj = await other.json();
    await P.evaluate((id: string) => { const C = window.__canvas; C.artMount(C.S.nodes[id], C.live[id]); }, id);
    const v3 = await until(async () => { const f = await frameOf(); return f && await f.$('#v3').catch(() => null) ? true : null; }, 8000);
    const node = await P.evaluate((id: string) => { const n = window.__canvas.S.nodes[id]; return { head: n.head, versions: n.versions.length }; }, id);
    check('N15: a version published elsewhere is what a reload of the card runs, and the node takes its head and versions', other.status === 200 && !!v3 && node.head === oj.version && node.versions === 3, JSON.stringify({ status: other.status, v3, node, version: oj.version }));
    // A files publish with its own script and new capabilities (a capabilities change made elsewhere reaches the node).
    const files = await api('/api/artifact/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: { 'index.html': '<p id=v4>four</p><script src="./app.js"></script>', 'app.js': "document.getElementById('v4').dataset.ran = '1';" }, capabilities: { db: {}, downloads: {} }, ifMatch: oj.version }) });
    await P.evaluate((id: string) => { const C = window.__canvas; C.artMount(C.S.nodes[id], C.live[id]); }, id);
    const ran = await until(async () => { const f = await frameOf(); return f && await f.evaluate(() => document.getElementById('v4')?.dataset.ran).catch(() => null); }, 8000);
    const caps = await P.evaluate((id: string) => Object.keys(window.__canvas.S.nodes[id].capabilities).sort().join(), id);
    check('N15: a files artifact runs its own script (inlined: there is no origin to serve it from), and capabilities published elsewhere reach the node', files.status === 200 && ran === '1' && caps === 'db,downloads', JSON.stringify({ status: files.status, ran, caps }));
    await P.evaluate((id: string) => window.__canvas.removeNode(id), id); await settled(P);
  } finally { await P.close(); }
});
