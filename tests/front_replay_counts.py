"""Linux diagnostic runs only: count successful writes on the two replay sockets.

prepare before the WS upgrade; begin before ACP open; finish before closing
the WS, after receiving the replay and its trailing viewer info. Keep other
connections stable across the upgrade. The benchmark supplies the exact total
unmasked WS wire length, including the info even if it shared the final write.
"""

import os
from pathlib import Path
import re
import shutil
import time


# UnixStream and TcpStream in the Linux relay use these byte-returning calls.
# send(2)/recv(2) are sendto/recvfrom syscalls on x86-64. A writev/sendmsg
# result is bytes accepted across all iovecs, *not* iovcnt or requested size.
_WRITES = ('write', 'writev', 'sendto', 'sendmsg')
_READS = ('read', 'readv', 'recvfrom', 'recvmsg')
_CALL = re.compile(rb'^\s*(\d+)\s+(\w+)\((0x[0-9a-f]+|\d+),.*\)\s+= (0x[0-9a-f]+|\d+)\b')


def _sockets(pid):
    sockets = {}
    for fd in (Path('/proc') / str(pid) / 'fd').iterdir():
        try:
            target = os.readlink(fd)
        except FileNotFoundError:  # unrelated, short-lived fd
            continue
        m = re.fullmatch(r'socket:\[(\d+)]', target)
        if m:
            sockets[int(fd.name)] = int(m[1])
    return sockets


def _classify(pid, fds):
    # The harness runs in a private netns. Join only the daemon's new socket
    # inodes; specifically require connected Unix streams and established TCP.
    net = Path('/proc') / str(pid) / 'net'
    tcp = set()
    for file in ('tcp', 'tcp6'):
        if (net / file).exists():
            for row in (net / file).read_text().splitlines()[1:]:
                cols = row.split()
                if cols[3] == '01':
                    tcp.add(int(cols[9]))
    unix = set()
    for row in (net / 'unix').read_text().splitlines()[1:]:
        cols = row.split(maxsplit=7)
        if cols[4:6] == ['0001', '03']:
            unix.add(int(cols[6]))
    return ([fd for fd, ino in fds.items() if ino in unix],
            [fd for fd, ino in fds.items() if ino in tcp])


class ReplayCounts:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.strace = shutil.which('strace')
        if not self.strace:
            raise RuntimeError('replay write counts require Linux strace on PATH')

    def command(self, name, argv):
        calls = _WRITES if name == 'hub' else _WRITES + _READS
        # -D preserves the actual daemon pid and parent, unlike wrapping an
        # existing service in `strace -p`. Follow Tokio workers but detach at
        # child exec. Raw arguments NEVER dereference a payload or credential.
        # -z emits complete successful records even across thread interleaving.
        return [self.strace, '-D', '-f', '-b', 'execve', '-qq', '-z', '--always-show-pid',
                '-e', 'signal=none', '-e', 'raw=all', '-e', 'trace=' + ','.join(calls),
                '-o', str(self.directory / f'{name}.trace'), *argv]

    def prepare(self, hub_pid, web_pid):
        return _Phase(self.directory, hub_pid, web_pid)


class _Trace:
    def __init__(self, directory, name, pid):
        self.pid = pid
        self.path = directory / f'{name}.trace'
        self.offset = self.path.stat().st_size
        self.before = set(_sockets(pid).values())
        self.threads = set()

    def new_sockets(self):
        return {fd: ino for fd, ino in _sockets(self.pid).items() if ino not in self.before}

    def totals(self):
        # Exclude any child with its own descriptor table. Include Tokio workers
        # that appeared since the last sample; async socket workers are persistent.
        self.threads.update(int(task.name) for task in (Path('/proc') / str(self.pid) / 'task').iterdir())
        counts = {}
        with self.path.open('rb') as trace:
            trace.seek(self.offset)
            for line in trace:
                m = _CALL.match(line)
                if not m or int(m[1]) not in self.threads:
                    continue
                n = int(m[4], 0)
                if n > 0:
                    key = int(m[3], 0), m[2].decode() in _WRITES
                    calls, size, largest = counts.get(key, (0, 0, 0))
                    counts[key] = calls + 1, size + n, max(largest, n)
            end = trace.tell()
        return counts, end


class _Phase:
    def __init__(self, directory, hub_pid, web_pid):
        self.hub = _Trace(directory, 'hub', hub_pid)
        self.web = _Trace(directory, 'web', web_pid)

    def begin(self):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            h, w = self.hub.new_sockets(), self.web.new_sockets()
            if len(h) == 1 and len(w) == 2:
                hu, _ = _classify(self.hub.pid, h)
                wu, wt = _classify(self.web.pid, w)
                if len(hu) == len(wu) == len(wt) == 1:
                    self.tx, self.rx, self.tcp = hu[0], wu[0], wt[0]
                    hc, he = self.hub.totals()
                    wc, we = self.web.totals()
                    # The HTTP upgrade and the asynchronous two-way Unix hello
                    # are setup, not replay. The latter finishes with web's hello.
                    if ((self.tx, True) in hc and (self.rx, True) in wc and (self.tcp, True) in wc
                            and hc[self.tx, True][1] == wc.get((self.rx, False), (0, 0, 0))[1]):
                        self.hub.offset, self.web.offset = he, we
                        self.hub_inode, self.web_inode = h[self.tx], w[self.tcp]
                        return
            time.sleep(0.005)
        raise RuntimeError('could not isolate one new hub Unix / web TCP relay after its handshakes')

    def finish(self, web_wire_bytes):
        if (_sockets(self.hub.pid).get(self.tx) != self.hub_inode or
                _sockets(self.web.pid).get(self.tcp) != self.web_inode):
            raise RuntimeError('replay socket closed or replaced before counts were collected')
        deadline = time.monotonic() + 5
        while True:
            hc, _ = self.hub.totals()
            wc, _ = self.web.totals()
            hn, hb, hm = hc.get((self.tx, True), (0, 0, 0))
            wn, wb, wm = wc.get((self.tcp, True), (0, 0, 0))
            # Bytes can reach the reader before strace logs syscall exit. Fence
            # each sender against the receiving end's independently observed
            # bytes; never substitute reads (or frames) for write counts.
            rx = wc.get((self.rx, False), (0, 0, 0))[1]
            if hb == rx > 0 and wb == web_wire_bytes > 0:
                return {'hubToWeb': {'writes': hn, 'bytes': hb, 'largestWrite': hm},
                        'webToBrowser': {'writes': wn, 'bytes': wb, 'largestWrite': wm}}
            if time.monotonic() >= deadline:
                raise RuntimeError(f'incomplete replay trace: hub sent {hb}, web read {rx}; '
                                   f'web sent {wb}, client measured {web_wire_bytes}')
            time.sleep(0.005)
