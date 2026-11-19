import fs from 'node:fs';
import path from 'node:path';
import { TMP, check, section, sleep, until } from '../shared.mts';
import { api, dpage, sessions, settled, termText, typeIn } from '../daemon.mts';

// N30: a board with cmd and env, loaded in a fresh page, runs nothing. The No session line shows a board's cmd with its
// control characters escaped and names its env (SEC-2), and a board's `replay` is never typed into the shell Enter starts.
await section('N30', async () => {
  const pwned = path.join(TMP, 'pwned30'), replayed = path.join(TMP, 'replayed30');
  const cur = await api('/api/board'), etag = cur.headers.get('ETag'), board = await cur.json();
  board.nodes.n30 = { id: 'n30', kind: 'term', backend: 'pty', name: 'n30', x: 100, y: 100, w: 500, h: 260, cmd: `touch '${pwned}'`, env: { BASH_ENV: path.join(TMP, 'x') } };
  board.nodes.n30e = { id: 'n30e', kind: 'term', backend: 'pty', name: 'n30e', x: 100, y: 400, w: 1400, h: 260, cmd: 'echo n30e\x1b[2K\rbash', env: { PROMPT_COMMAND: 'true' } };
  board.nodes.n30r = { id: 'n30r', kind: 'term', backend: 'pty', name: 'n30r', x: 100, y: 700, w: 500, h: 260, env: {}, replay: `touch '${replayed}'\r` };
  const r = await api('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag! }, body: JSON.stringify(board) });
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
