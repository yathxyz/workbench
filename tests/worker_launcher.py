"""Header framing, allowlists and fd-based cwd confinement for the worker launcher."""

import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nix"))
import worker


class Framing(unittest.TestCase):
    def test_header_does_not_consume_following_bytes(self):
        data = bytes(range(256))
        a, b = socket.socketpair()
        with a, b:
            a.sendall(b'{"op":"create"}\n' + data)
            self.assertEqual(worker.read_header(b), {"op": "create"})
            self.assertEqual(b.recv(len(data)), data)

    def test_bad_wire_headers(self):
        for data in (b"{}", b"{}" + b" " * worker.HEADER_MAX + b"\n", b"\xff\n", b"bad\n", b"[]\n",
                     b'{"agent":"one","agent":"two"}\n'):
            with self.subTest(data=data[:10]):
                a, b = socket.socketpair()
                with a, b:
                    a.sendall(data)
                    a.shutdown(socket.SHUT_WR)
                    with self.assertRaises(ValueError):
                        worker.read_header(b)


class AgentCommand(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.root = self.base / "work"
        self.root.mkdir(mode=0o700)
        self.cwd = self.root / "s-42"
        self.cwd.mkdir()
        self.outside = self.base / "work-other"
        self.outside.mkdir()
        self.cfg = {
            "root": str(self.root), "shell": "/bin/sh", "env": {"PATH": "/worker/bin", "LANG": "C"},
            "agents": {"stub": {"argv": [sys.executable, "-I"], "env": {"LANG": "C.UTF-8"}}},
        }
        self.header = {
            "op": "agent", "agent": "stub", "cwd": str(self.cwd), "sid": "s",
            "env": ["PATH", "LANG", "USER", "HOME", "LOGNAME", "SHELL", "WB_SESSION"],
        }
        env = patch.dict(os.environ, {"HOME": "/var/lib/worker", "USER": "worker", "LOGNAME": "worker",
                                      "PATH": "/owner", "CREDENTIALS_DIRECTORY": "/secrets"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_command_and_environment_from_config_only(self):
        self.cfg["agents"]["stub"]["env"]["HOME"] = "/owner"
        argv, env, fd = worker.agent_command(self.cfg, self.header)
        self.addCleanup(os.close, fd)
        self.assertEqual(argv, [sys.executable, "-I"])
        self.assertEqual(env, {"PATH": "/worker/bin", "LANG": "C.UTF-8", "HOME": "/var/lib/worker",
                               "USER": "worker", "LOGNAME": "worker", "SHELL": "/bin/sh", "WB_SESSION": "s"})
        self.assertTrue(os.path.samestat(os.fstat(fd), self.cwd.stat()))

    def test_rejects_unknown_fields_names_types_and_paths(self):
        for bad in ({"op": "other"}, {"extra": True}, {"argv": ["anything"]}, {"agent": "stub -x"},
                    {"agent": "unknown"}, {"agent": []}, {"sid": "../s"}, {"sid": "s" * 65},
                    {"sid": ""}, {"cwd": None}, {"cwd": "relative"}, {"cwd": str(self.outside)},
                    {"cwd": str(self.root)}, {"cwd": str(self.root / "missing")}, {"cwd": "a\0b"},
                    {"env": {"PATH": "/owner"}}, {"env": ["LANG=C"]}, {"env": ["LANG", "LANG"]},
                    {"env": ["CREDENTIALS_DIRECTORY"]}, {"env": [1]}):
            with self.subTest(change=bad), self.assertRaises((ValueError, OSError)):
                worker.agent_command(self.cfg, self.header | bad)
        for key in self.header:
            with self.subTest(missing=key), self.assertRaises(ValueError):
                worker.agent_command(self.cfg, {k: v for k, v in self.header.items() if k != key})

    def test_in_tree_symlink_resolves_to_pinned_directory(self):
        alias = self.root / "alias"
        alias.symlink_to(self.cwd)
        fd = worker.open_cwd(str(self.root), str(alias))
        self.addCleanup(os.close, fd)
        self.cwd.rename(self.root / "renamed")
        self.cwd.symlink_to(self.outside)
        self.assertTrue(os.path.samestat(os.fstat(fd), (self.root / "renamed").stat()))
        with self.assertRaises(ValueError):
            worker.open_cwd(str(self.root), str(alias))

    def test_replacing_root_with_symlink_never_accepts_outside_directory(self):
        self.root.rename(self.base / "old-work")
        self.root.symlink_to(self.outside)
        (self.outside / "s-42").mkdir()
        with self.assertRaises((ValueError, OSError)):
            worker.open_cwd(str(self.root), str(self.cwd))


if __name__ == "__main__":
    unittest.main()
