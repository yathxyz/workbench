import { check, section, state } from '../shared.mts';
import { H } from '../daemon.mts';

const { A } = state;

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
  const st = await A.evaluate(async () => {
    const C = window.__canvas, sl = (ms: number) => new Promise(r => setTimeout(r, ms)); await C.notesLoad(true);
    const key = C.addrToKey('note:xss31'), heads = key ? C.rgEntries(key).map((e: RgEntry) => e.name.trim()) : [];
    C.goAddr('note:'); await sl(400); const list = document.body.innerText.includes('<img src=x');
    C.goAddr('note:xss31'); await sl(400); const tree = document.body.innerText.includes('<img src=x') && document.body.innerText.includes('<b onmouseover');
    const r = { heads, list, tree, ran: window.__xss31 ?? null, markup: document.querySelectorAll('img[src="x"], b[onmouseover]').length };
    C.setView('canvas'); return r;
  });
  await A.unroute('**/api/nodes*');
  check('N31: a note title and headings with markup render as text', st.heads.some((h: string) => h.startsWith('<img')) && st.list && st.tree && st.ran === null && st.markup === 0, JSON.stringify(st));
});
