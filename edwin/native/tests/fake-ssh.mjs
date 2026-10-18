// For tests/terminal.rs: ssh as edwin runs it (ssh -o BatchMode=yes … -W SOCKET -- ssh://HOST), with HOST on this
// machine: standard input and output are joined to SOCKET here. HOST "unreachable" fails as ssh does.
import net from 'node:net';
const a = process.argv.slice(2);
const fail = (msg, code = 255) => { process.stderr.write(msg + '\n'); process.exit(code); };
if (!a.includes('BatchMode=yes')) fail('fake-ssh: edwin must run ssh in batch mode (it holds the terminal)', 2);
const w = a[a.indexOf('-W') + 1], dest = a[a.length - 1];
if (dest === 'ssh://unreachable') fail('ssh: Could not resolve hostname unreachable: Name or service not known');
const s = net.connect(w);
s.on('error', e => fail(`channel 0: open failed: connect failed: ${e.code}\nstdio forwarding failed`));
s.on('connect', () => { process.stdin.pipe(s); s.pipe(process.stdout); });
s.on('close', () => process.exit(0));
