// For tests/terminal.rs, as edwin-daemon would start it: an edwind on SOCKET serving NOTES until SIGTERM; its
// pid in PIDFILE once the socket accepts, and edwind's log in PIDFILE.log once it has stopped.
import fs from 'node:fs';
import { makeDir, startEdwind, stopEdwind } from '../../test/edit-client.mts';
const [socket, notes, pidfile] = process.argv.slice(2);
// The terminal's hang-up when the frame exits is not the end (Node resets nohup's ignored SIGHUP at start).
process.on('SIGHUP', () => {});
const child = await startEdwind(makeDir({ socket, notesDir: notes }));
fs.writeFileSync(pidfile, String(process.pid));
process.on('SIGTERM', async () => { await stopEdwind(child); fs.writeFileSync(pidfile + '.log', child.logs); process.exit(0); });
