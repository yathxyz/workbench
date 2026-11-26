"""Worker-uid side of checkout transfer. Never given the owner's repository path."""

import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tempfile
import json


DIR = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY
MAX_BUNDLE = 2 << 30
CHUNK = 128 << 10


def open_root(root):
    """Pin each component, not just the leaf (the worker can rename its home contents)."""
    path = Path(root)
    if not path.is_absolute() or path == Path('/') or '..' in path.parts:
        raise ValueError('invalid worker root')
    fd = os.open('/', DIR)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('worker root must be worker-owned and private')
        return fd
    except BaseException:
        os.close(fd)
        raise


def checkout_name(root, cwd, sid):
    if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', sid):
        raise ValueError('invalid checkout session id')
    path = Path(cwd)
    if str(path) != cwd or path.parent != Path(root):
        raise ValueError('checkout must be a direct child of the worker root')
    epoch = path.name.removeprefix(sid + '-')
    if (epoch == path.name or not re.fullmatch(r'0|[1-9][0-9]{0,19}', epoch)
            or int(epoch) >= 1 << 64):
        raise ValueError('checkout does not belong to this session')
    return path.name


def branch_ref(branch):
    if (not isinstance(branch, str) or not re.fullmatch(r'[A-Za-z0-9._/-]{1,255}', branch)
            or branch == 'HEAD' or branch.startswith('-') or branch.endswith('.')
            or '..' in branch or any(not p or p.startswith('.') or p.endswith('.lock')
                                     for p in branch.split('/'))):
        raise ValueError('invalid checkout branch')
    return 'refs/heads/' + branch


def git(cfg, *args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL):
    # No config from the worker's provider login/home. Local config, including
    # any attempted helper, stays inside this worker unit. Never use a remote.
    subprocess.run([cfg['git'], '--no-replace-objects', '--no-lazy-fetch',
                    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                    '-c', 'hook.reference-transaction.enabled=false',
                    '-c', 'hook.post-index-change.enabled=false', *args],
                   stdin=stdin, stdout=stdout, check=True, timeout=120,
                   env={'PATH': os.path.dirname(cfg['git']), 'GIT_CONFIG_GLOBAL': '/dev/null',
                        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_ALLOW_PROTOCOL': '', 'LC_ALL': 'C'})


def respond(sock, **fields):
    sock.sendall(json.dumps(fields, separators=(',', ':')).encode() + b'\n')


def receive_pack(sock, pack, header, full):
    size, fmt = header['size'], header['format']
    if type(size) is not int or not 0 < size <= MAX_BUNDLE or fmt not in ('sha1', 'sha256'):
        raise ValueError('invalid bundle size or object format')
    # Our deliberately narrow subset of v3: no prerequisite, filter, extra
    # capability, or second ref. Git sees only a pack on stdin, never a URL.
    prefix = f'# v3 git bundle\n@object-format={fmt}\n'.encode()
    suffix = f' {full}\n\n'.encode()
    digits = 40 if fmt == 'sha1' else 64
    length = len(prefix) + digits + len(suffix)
    if size <= length:
        raise ValueError('truncated bundle')
    lead = sock.recv(length, socket.MSG_WAITALL)
    if (len(lead) != length or not lead.startswith(prefix) or not lead.endswith(suffix)
            or not re.fullmatch(b'[0-9a-f]+', lead[len(prefix):-len(suffix)])):
        raise ValueError('unexpected bundle header')
    left = size - length
    while left:
        data = sock.recv(min(CHUNK, left))
        if not data:
            raise ValueError('truncated bundle')
        pack.write(data)
        left -= len(data)
    pack.seek(0)
    return lead[len(prefix):-len(suffix)].decode()


def handle(cfg, header, sock):
    """Called in the per-connection child. The supervisor kills it on disconnect."""
    root_fd = None
    replying = False
    try:
        op = header['op']
        keys = {'op', 'sid', 'cwd', 'branch'}
        if op == 'create':
            keys |= {'size', 'format'}
        if op not in ('create', 'export', 'remove') or set(header) != keys:
            raise ValueError('invalid checkout request fields')
        name = checkout_name(cfg['root'], header['cwd'], header['sid'])
        full = branch_ref(header['branch'])
        root_fd = open_root(cfg['root'])
        if op == 'remove':
            # Even if status is clean and HEAD was fetched, ignored files,
            # other refs/reflogs, or concurrent worker writes may be unique.
            # Only manual removal releases the record. Do not follow a link.
            try:
                os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                respond(sock, missing=True)
                return
            raise ValueError('worker checkout retained; fetch wanted commits, then remove it manually')
        with tempfile.TemporaryFile() as bundle:
            if op == 'create':
                tip = receive_pack(sock, bundle, header, full)
                # EEXIST includes dangling symlinks. Never reuse or recursively
                # delete a reservation, even if interrupted before publication.
                os.mkdir(name, mode=0o700, dir_fd=root_fd)
            fd = os.open(name, DIR, dir_fd=root_fd)
            try:
                os.fchdir(fd)
            finally:
                os.close(fd)
            if op == 'create':
                git(cfg, 'init', '--quiet', '--template=', '--object-format=' + header['format'],
                    '--initial-branch=' + header['branch'], '.')
                git(cfg, 'index-pack', '--strict', '--stdin', stdin=bundle)
                git(cfg, 'update-ref', '--no-deref', full, tip, '')
                git(cfg, 'reset', '--hard', '--quiet', tip, '--')
                respond(sock, ok=True)
            else:
                git(cfg, 'bundle', 'create', '--quiet', '--version=3', '-', full, stdout=bundle)
                size = bundle.tell()
                if not 0 < size <= MAX_BUNDLE:
                    raise ValueError('worker bundle exceeds transfer limit')
                bundle.seek(0)
                replying = True
                respond(sock, size=size)
                while data := bundle.read(CHUNK):
                    sock.sendall(data)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        if replying:
            raise  # Never splice a JSON diagnostic into a pack.
        respond(sock, error=str(error)[:512])
    finally:
        if root_fd is not None:
            os.close(root_fd)
