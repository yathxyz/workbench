// For tests/terminal.rs: an edwind on a fresh directory with one note, a.md. Prints {socket, notes}; on a
// line from stdin, prints a.md as edwind and the disk have it, stops edwind and exits.
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from '../../test/edit-client.mts';
const dir = makeDir();
fs.writeFileSync(path.join(dir.dirs.notes, 'a.md'), '# Shared page\n');
const child = await startEdwind(dir);
console.log(JSON.stringify({ socket: dir.cfg.socket, notes: dir.dirs.notes }));
process.stdin.once('data', async () => {
  const c = new EditClient(dir.cfg.socket);
  await c.connect(); await c.hello();
  const o = await c.open('a.md');
  c.close();
  console.log(JSON.stringify({ server: o.text, disk: fs.readFileSync(path.join(dir.dirs.notes, 'a.md'), 'utf8') }));
  await stopEdwind(child);
  process.exit(0);
});
