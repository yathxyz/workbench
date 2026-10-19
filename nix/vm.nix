# VM test (40-nix-deploy-security 1.7 with DESIGN 9.4's edits): boot, the network edge, a PTY
# and an ACP card with a pending permission surviving a web restart, confinement and environment
# inside a card, nothing auto-running, kill-forget then reopen for both kinds, a nushell card, a
# deploy-style switch, an OOM kill, hub.sock peer credentials, and a hub stop/start that leaves
# a PTY corpse with the last screen, journals ending in the death invariant, and a revivable
# agent. The agent is `stub`, wb-fake-acp acting on prompt keywords. Step 10 is edwind (the edwind spec
# R16.18, E1 part): the unit, `wb buf` and `wb eval` round trips, a restart that loses nothing, the web
# restart leaving it alone, and edit.sock refused to another uid (R16.12). Step 11 is `wb` board tools
# (DESIGN 3.3, fix 4): web.sock's modes, and `wb read_node` from a card without a page (exit 7) and
# with wbctl's page open on /rpc (the page's text, exit 0).
{ self }:
let
  secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  wrongSecret = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
  wbctlFor =
    pkgs:
    pkgs.writeShellScriptBin "wbctl" ''
      exec ${pkgs.python3}/bin/python3 -I ${../tests/wbctl.py} "$@"
    '';
in
{
  name = "workbench";

  nodes = {
    wb =
      {
        config,
        lib,
        nodes,
        pkgs,
        ...
      }:
      {
        imports = [ self.nixosModules.workbench ];
        virtualisation.memorySize = 2048;
        virtualisation.cores = 2;

        users.users.alice = {
          uid = 1000;
          isNormalUser = true;
          extraGroups = [ "wheel" ];
          linger = true;
        };
        users.users.bob.isNormalUser = true;
        # Passwordless sudo, so that NoNewPrivileges is what stops sudo in a card.
        security.sudo.wheelNeedsPassword = false;
        nix.settings.experimental-features = [ "nix-command" ];

        services.workbench = {
          enable = true;
          user = "alice";
          listenAddress = config.networking.primaryIPAddress;
          trustedProxy = nodes.proxy.networking.primaryIPAddress;
          publicOrigin = "http://wb.test";
          firewall.interface = "eth1";
          proxySecretFile = "${pkgs.writeText "proxy-secret" secret}";
          # edwind runs by default (edit.enable), and with it page cards are Edwin frames (R9.21).
          agents.stub = {
            label = "Stub";
            package = self.packages.${pkgs.stdenv.hostPlatform.system}.fake-acp;
            exe = "bin/wb-fake-acp";
          };
        };

        # Canaries: set-environment exports (a login would pick them up) and the hub's own environment.
        environment.variables.ANTHROPIC_API_KEY = "leak-canary";
        environment.sessionVariables.WB_CANARY = "$(echo canary-from-set-environment)";
        systemd.services.workbench-hub.environment.WB_TEST_CANARY = "leak-canary-2";

        # Small enough for the OOM step; the specialisation raises it to prove a switch applies
        # slice changes without restarting the hub.
        systemd.slices.workbench.sliceConfig.MemoryMax = "400M";
        # The OOM step needs the cgroup OOM killer; the test instrumentation's panic_on_oom = 2
        # would panic the whole VM instead.
        boot.kernel.sysctl."vm.panic_on_oom" = 0;
        specialisation.changed.configuration = {
          services.workbench.logLevel = lib.mkForce "debug";
          systemd.slices.workbench.sliceConfig.MemoryMax = lib.mkForce "500M";
        };

        environment.systemPackages = [
          pkgs.git
          pkgs.nushell
          pkgs.python3
          pkgs.socat
          (wbctlFor pkgs)
          # `wb` for step 10; the units run their own copy from services.workbench.package.
          config.services.workbench.package
        ];
      };

    proxy =
      { nodes, pkgs, ... }:
      {
        services.caddy = {
          enable = true;
          virtualHosts."http://wb.test".extraConfig = ''
            reverse_proxy ${nodes.wb.networking.primaryIPAddress}:8090 {
              header_up X-Workbench-Proxy-Secret {env.CADDY_UPSTREAM_SECRET_WORKBENCH}
            }
          '';
          environmentFile = pkgs.writeText "caddy-env" "CADDY_UPSTREAM_SECRET_WORKBENCH=${secret}\n";
        };
        networking.hosts."127.0.0.1" = [ "wb.test" ];
        environment.systemPackages = [ (wbctlFor pkgs) ];
      };

    peer = { };
  };

  testScript =
    { nodes, ... }:
    ''
      import json
      import re
      import shlex

      WB_IP = "${nodes.wb.networking.primaryIPAddress}"
      SECRET = "${secret}"
      WRONG = "${wrongSecret}"
      HOME = "${nodes.wb.users.users.alice.home}"
      HUB_SOCK = "/run/workbench-hub/hub.sock"
      ACP_DIR = f"{HOME}/.local/state/workbench/hub/acp"


      def first(pattern, text):
          m = re.search(pattern, text)
          assert m is not None, f"{pattern!r} not in {text!r}"
          return m.group(1)


      def http_code(node, url, *headers, prefix=""):
          hs = " ".join(f"-H {shlex.quote(h)}" for h in headers)
          return node.succeed(f"{prefix}curl -s -o /dev/null -w '%{{http_code}}' -m 10 {hs} {url}").strip()


      def wbctl(args, retry=False):
          cmd = f"wbctl --url http://wb.test {args}"
          return json.loads(proxy.wait_until_succeeds(cmd, timeout=60) if retry else proxy.succeed(cmd))


      def wbctl_any(args):
          """For results that exit 1, such as an open that is refused."""
          _, out = proxy.execute(f"wbctl --url http://wb.test {args}")
          return json.loads(out)


      def sessions():
          return json.loads(wb.succeed(f"wbctl --hub {HUB_SOCK} sessions"))["sessions"]


      def in_card(sid, tag, cmd):
          """Type cmd in the card, then `echo TAG=$?`; return (status, live output)."""
          line = f"{cmd}; echo {tag}=$?"
          r = wbctl(f"pty-attach {sid} --send {shlex.quote(line)} --expect {shlex.quote(tag + '=[0-9]+')}")
          return int(first(tag + "=([0-9]+)", r["output"])), r["output"]


      def journal_tail(sid, n):
          """The last n events of an ACP session's journal, without seq and ts."""
          lines = wb.succeed(f"tail -n {n} {ACP_DIR}/{sid}.jsonl").splitlines()
          return [{k: v for k, v in json.loads(line).items() if k not in ("seq", "ts")} for line in lines]


      def last_session(r):
          return [e for e in r["events"] if e["e"] == "session"][-1]


      def main_pid(unit):
          return wb.succeed(f"systemctl show -p MainPID --value {unit}").strip()


      def as_user(user, cmd):
          return f"setpriv --reuid={user} --regid=users --init-groups {cmd}"


      start_all()

      with subtest("1: boot"):
          wb.wait_for_unit("workbench-hub.service")
          wb.wait_for_file(HUB_SOCK)
          wb.wait_for_unit("workbench-web.service")
          wb.wait_for_open_port(8090, WB_IP)
          proxy.wait_for_unit("caddy.service")
          proxy.wait_for_open_port(80)
          peer.wait_for_unit("multi-user.target")

      with subtest("2: the network edge"):
          rc, _ = peer.execute(f"curl -s -o /dev/null -m 5 http://{WB_IP}:8090/")
          assert rc == 28, f"peer: expected a timeout (curl 28), got {rc}"
          direct = f"http://{WB_IP}:8090/api/info"
          assert http_code(proxy, direct, "Host: wb.test") == "403"
          assert http_code(proxy, direct, "Host: wb.test", f"X-Workbench-Proxy-Secret: {SECRET}") == "200"
          assert http_code(proxy, "http://wb.test/api/info") == "200"
          assert http_code(proxy, "http://wb.test/api/info", f"X-Workbench-Proxy-Secret: {WRONG}") == "200"
          code = http_code(wb, direct, "Host: wb.test", f"X-Workbench-Proxy-Secret: {SECRET}", prefix="runuser -u bob -- ")
          assert code == "403", f"bob on wb: {code}"

      with subtest("3/4: a PTY and an ACP card survive a web restart"):
          r = wbctl("pty-open s1 --spawn --send 'echo MARK$((0+1)); echo PID=$$' --expect 'PID=[0-9]+'")
          shell_pid = first("PID=([0-9]+)", r["output"])
          stream, mark_out = r["hello"]["stream"], r["lastOut"]
          r = wbctl(f"acp-new a1 --agent stub --cwd {HOME} --prompt ask-permission --until-permission")
          assert len(r["pending"]) == 1, r["pending"]
          a1_req, a1_epoch = r["pending"][0]["req"], r["createdAt"]
          hub_pid = main_pid("workbench-hub")
          wb.succeed("systemctl restart workbench-web")
          wb.wait_for_unit("workbench-web.service")
          wb.wait_for_open_port(8090, WB_IP)
          assert main_pid("workbench-hub") == hub_pid, "the hub restarted"
          wb.succeed(f"kill -0 {shell_pid}")
          r = wbctl("pty-attach s1 --send 'echo TAIL$((1+1))' --expect TAIL2")
          assert "MARK1" in (r["replay"] or ""), r
          # From the offset after MARK1: the ring tail only, with no snapshot of the screen.
          r = wbctl(f"pty-attach s1 --resume {stream},{mark_out}")
          assert r["hello"]["resumed"] is True, r["hello"]
          assert "TAIL2" in r["replay"] and "MARK1" not in r["replay"], r["replay"]
          # The same incarnation, with the same request still pending; answering it ends the turn.
          r = wbctl("acp-attach a1")
          assert r["createdAt"] == a1_epoch and [p["req"] for p in r["pending"]] == [a1_req], r
          r = wbctl("acp-attach a1 --permission allow_once --expect PONG")
          assert r["pending"] == [], r["pending"]

      with subtest("5: confinement and environment inside a card"):
          rc, out = in_card("s1", "T1", "sudo -n true")
          assert rc != 0 and "no new privileges" in out.lower(), out
          rc, _ = in_card("s1", "T2", "systemd-run --user true")
          assert rc != 0, "systemd-run --user worked"
          rc, _ = in_card("s1", "T3", "ls /run/user")
          assert rc != 0, "/run/user is readable"
          rc, out = in_card("s1", "T4", "touch ~/.ssh/x")
          assert rc != 0 and "Read-only file system" in out, out
          rc, out = in_card("s1", "T5", "mkdir -p ~/.config/systemd/user/x")
          assert rc != 0 and "Read-only file system" in out, out
          # The writable parents cannot be moved aside to make a fresh ~/.config/systemd.
          for i, d in enumerate([".config", ".local", ".local/share"]):
              rc, out = in_card("s1", f"T5{'abc'[i]}", f"mv ~/{d} ~/{d}.x")
              assert rc != 0 and "busy" in out.lower(), out
          rc, out = in_card("s1", "T5d", "touch ~/.config/wb-probe && rm ~/.config/wb-probe")
          assert rc == 0, out
          rc, out = in_card("s1", "T6", "nix path-info /run/current-system")
          assert rc == 0, out
          rc, out = in_card("s1", "T7", "command -v ls git")
          assert rc == 0, out
          rc, _ = in_card("s1", "T8", "env > /tmp/card-env")
          assert rc == 0
          env = wb.succeed("cat /tmp/card-env")
          # Controls: the canaries are live, so their absence below means something.
          login = wb.succeed("runuser -l alice -c 'echo $WB_CANARY $ANTHROPIC_API_KEY'").split()
          assert login == ["canary-from-set-environment", "leak-canary"], login
          wb.succeed(f"grep -qa leak-canary-2 /proc/{hub_pid}/environ")
          assert "WB_SESSION=s1" in env, env
          for bad in ["leak-canary", "leak-canary-2", "canary-from-set-environment", "CREDENTIALS_DIRECTORY",
                      "NOTIFY_SOCKET", "INVOCATION_ID", "JOURNAL_STREAM", "XDG_RUNTIME_DIR"]:
              assert bad not in env, f"{bad} reached a card"
          assert wb.succeed(f"cat /proc/{shell_pid}/oom_score_adj").strip() == "800"
          assert wb.succeed(f"cat /proc/{hub_pid}/oom_score_adj").strip() == "100"
          for unit in ["workbench-hub", "workbench-web"]:
              for d, want in [(".ssh", "ro"), (".config/systemd", "ro"), (".local/share/systemd", "ro"),
                              (".config", "rw"), (".local", "rw"), (".local/share", "rw")]:
                  opts = wb.succeed(f"awk '$5 == \"{HOME}/{d}\" {{print $6}}' /proc/{main_pid(unit)}/mountinfo").strip()
                  assert opts.split(",")[0] == want, f"{unit}: ~/{d} mount options {opts!r}"
          # T-S16 in the VM: /api/mv into ~/.ssh is refused, and the source stays put. With edit.enable the move is
          # edwind's rename-file (wb-web answers 503 until it reaches edit.sock), so wait for both first.
          wb.wait_for_unit("workbench-edit.service")
          proxy.wait_until_succeeds("curl -sf http://wb.test/api/info | grep -q '\"editUp\":true'", timeout=60)
          wb.succeed("runuser -u alice -- sh -c 'echo key > ~/mv-key'")
          r = wbctl(f"api-mv {HOME}/mv-key {HOME}/.ssh/authorized_keys")
          assert r["status"] == 400, r
          wb.succeed(f"test ! -e {HOME}/.ssh/authorized_keys && test -e {HOME}/mv-key")

      with subtest("5b: nothing auto-runs"):
          r = wbctl_any("pty-open ghost --cmd 'touch /tmp/ghost'")
          assert (r["error"] or {}).get("code") == "not_found" and r["hello"] is None, r
          assert r["close"] == 1000, r
          assert all(s["sid"] != "ghost" for s in sessions()), sessions()
          wb.succeed("test ! -e /tmp/ghost")

      with subtest("5c: kill-forget, then an immediate reopen spawns afresh"):
          r = wbctl("pty-open k1 --spawn --send 'echo K$((0+1))' --expect K1")
          epoch = r["hello"]["epoch"]
          r = wbctl("pty-kill k1")
          assert r["close"] == 1000, r
          r = wbctl("pty-open k1 --spawn")
          assert r["hello"]["new"] is True and r["hello"]["epoch"] != epoch, r["hello"]
          r = wbctl(f"acp-new a2 --agent stub --cwd {HOME} --prompt stream")
          epoch = r["createdAt"]
          wbctl("acp-kill a2 --forget")
          # The kill returned only once the session was gone: no registry entry, no files.
          assert all(s["sid"] != "a2" for s in sessions()), sessions()
          wb.succeed(f"test -z \"$(find {ACP_DIR} -maxdepth 1 -name 'a2.*')\"")
          r = wbctl(f"acp-new a2 --agent stub --cwd {HOME}")
          assert r["hello"]["status"] == "new" and r["createdAt"] != epoch, r["hello"]
          assert not [e for e in r["events"] if e["e"] == "prompt"], r["events"]

      with subtest("5d: a nushell card"):
          hello = json.loads(wb.succeed(f"wbctl --hub {HUB_SOCK} raw '{{\"t\":\"list\",\"rid\":1}}'").splitlines()[0])
          assert hello["shells"] == ["bash", "nu"] and hello["defaultShell"] == "bash", hello
          # The sum keeps --expect from matching the echo of the typed line.
          line = '^env | save -f /tmp/nu-env; echo ("NU" + "-HI")'
          wbctl(f"pty-open n1 --spawn --shell nu --send {shlex.quote(line)} --expect NU-HI")
          env = wb.succeed("cat /tmp/nu-env")
          assert "WB_SESSION=n1" in env and "SHELL=/run/current-system/sw/bin/nu" in env, env
          for bad in ["leak-canary", "canary-from-set-environment", "CREDENTIALS_DIRECTORY", "NOTIFY_SOCKET"]:
              assert bad not in env, f"{bad} reached a nushell card"

      with subtest("6: a deploy-style switch restarts the web, never the hub"):
          web_pid = main_pid("workbench-web")
          wb.succeed("/run/current-system/specialisation/changed/bin/switch-to-configuration test")
          wb.wait_for_unit("workbench-web.service")
          wb.wait_for_open_port(8090, WB_IP)
          assert main_pid("workbench-hub") == hub_pid, "the switch restarted the hub"
          # The hub's unit now says debug while the running hub kept info: it was skipped.
          assert "RUST_LOG=debug" in wb.succeed("systemctl show -p Environment --value workbench-hub")
          wb.succeed(f"grep -qa RUST_LOG=info /proc/{hub_pid}/environ")
          new_web = main_pid("workbench-web")
          assert new_web != web_pid, "the switch did not restart the web"
          wb.succeed(f"grep -qa RUST_LOG=debug /proc/{new_web}/environ")
          assert wb.succeed("cat /sys/fs/cgroup/workbench.slice/memory.max").strip() == "524288000"
          wb.succeed(f"kill -0 {shell_pid}")
          r = wbctl("pty-attach s1", retry=True)
          assert "MARK1" in (r["replay"] or ""), r
          info = json.loads(proxy.succeed("curl -sf http://wb.test/api/info"))
          assert info["hub"]["stale"] is False, info["hub"]
          r = wbctl("acp-attach a1 --prompt ask-permission --permission allow_once --expect PONG")
          assert r["createdAt"] == a1_epoch, r["createdAt"]

      with subtest("7: an OOM kill takes the card, never the hub"):
          cmd = shlex.quote("exec python3 -c 'b = bytearray(1 << 30)'")
          r = wbctl(f"pty-open s2 --spawn --cmd {cmd} --wait-exit")
          assert r["exit"]["signal"] == 9, r["exit"]
          assert wb.succeed("systemctl is-active workbench-hub").strip() == "active"
          assert wb.succeed("systemctl show -p NRestarts --value workbench-hub").strip() == "0"
          assert main_pid("workbench-hub") == hub_pid
          wb.succeed(f"kill -0 {shell_pid}")

      with subtest("8: hub.sock peer credentials"):
          rc, out = wb.execute(as_user("bob", f"socat -t2 - UNIX-CONNECT:{HUB_SOCK} </dev/null 2>&1"))
          assert rc != 0 and "Permission denied" in out, out
          # connect() needs write permission on the socket too, so open both to reach SO_PEERCRED.
          wb.succeed(f"chmod 0755 /run/workbench-hub && chmod 0666 {HUB_SOCK}")
          n = wb.succeed("set -o pipefail; " + as_user("bob", f"socat -t2 - UNIX-CONNECT:{HUB_SOCK} </dev/null | wc -c"))
          assert n.strip() == "0", f"bob got {n.strip()} bytes"
          n = wb.succeed("set -o pipefail; " + as_user("alice", f"socat -t2 - UNIX-CONNECT:{HUB_SOCK} </dev/null | wc -c"))
          assert int(n) > 0, "alice got no hello"
          wb.succeed(f"chmod 0700 /run/workbench-hub && chmod 0600 {HUB_SOCK}")

      with subtest("9: hub stop and start: a PTY corpse, the death invariant, a revive"):
          # a3 is mid-turn, waiting for a permission, when the hub stops.
          r = wbctl(f"acp-new a3 --agent stub --cwd {HOME} --prompt ask-permission --until-permission")
          a3_req = r["pending"][0]["req"]
          cgroup = wb.succeed("systemctl show -p ControlGroup --value workbench-hub").strip()
          assert cgroup, "no control group"
          wb.succeed("systemctl stop workbench-hub")
          procs = f"/sys/fs/cgroup{cgroup}/cgroup.procs"
          wb.succeed(f"test ! -e {procs} || test -z \"$(cat {procs})\"")
          wb.fail(f"kill -0 {shell_pid}")
          last = journal_tail("a1", 1)[-1]
          assert last["e"] == "exit" and last["reason"] == "hub_restart", last
          tail = journal_tail("a3", 3)
          # `code` is turn_error's reason code; on `exit` it is the agent's exit status, which is not checked.
          got = [(e["e"], e.get("req"), e.get("by"), e.get("code") if e["e"] != "exit" else None, e.get("reason")) for e in tail]
          assert got == [("permission_resolved", a3_req, "hub", None, None), ("turn_error", None, None, "interrupted", None),
                         ("exit", None, None, None, "hub_restart")], tail
          wb.succeed("systemctl start workbench-hub")
          out = json.loads(wb.wait_until_succeeds(f"wbctl --hub {HUB_SOCK} sessions", timeout=30))
          s1 = next(s for s in out["sessions"] if s["sid"] == "s1")
          assert s1["alive"] is False and s1["pty"]["exit"]["reason"] == "hub_restart", s1
          # The web reconnects to the new hub on its own; retry until it has.
          r = wbctl("pty-attach s1 --wait-exit", retry=True)
          assert r["hello"]["new"] is False and "MARK1" in (r["replay"] or ""), r
          assert r["exit"]["reason"] == "hub_restart", r["exit"]
          states = {s["sid"]: s["state"] for s in json.loads(proxy.succeed("curl -sf http://wb.test/api/sessions"))["sessions"]}
          # a1 was idle, so it is detached; a3's interrupted turn shows as an error until seen.
          assert states.get("a1") == "detached" and states.get("a3") == "error", states
          r = wbctl("acp-revive a1 --prompt ask-permission --permission allow_once --expect PONG")
          assert last_session(r)["via"] == "resume", last_session(r)

      with subtest("10: edwind: the unit, wb buf and wb eval, a restart, the web restart, edit.sock peers"):
          EDIT_SOCK = "/run/workbench-edit/edit.sock"
          wb.wait_for_unit("workbench-edit.service")
          wb.wait_until_succeeds(f"test -S {EDIT_SOCK}", timeout=30)
          assert wb.succeed(f"stat -c %a /run/workbench-edit {EDIT_SOCK}").split() == ["700", "600"]
          assert wb.succeed(f"stat -c %U /run/workbench-edit {EDIT_SOCK}").split() == ["alice", "alice"]
          edit_pid = main_pid("workbench-edit")
          wb.succeed(f"grep -qa -- --disallow-code-generation-from-strings /proc/{edit_pid}/cmdline")
          wb.fail(f"grep -qa -- --frozen-intrinsics /proc/{edit_pid}/cmdline")
          wb.succeed("journalctl -u workbench-edit.service -o cat | grep -q 'listen .*\"lockdown\":\"locked\"'")

          def wb_cli(cmd, stdin=None):
              pipe = f"printf %s {shlex.quote(stdin)} | " if stdin is not None else ""
              return wb.succeed("set -o pipefail; " + pipe + as_user("alice", f"env HOME={HOME} wb {cmd}"))

          # R16.18: a write and a read round trip; wb eval on the server image.
          wb.succeed(f"mkdir -p {HOME}/work/roam && chown alice:users {HOME}/work {HOME}/work/roam")
          wb_cli("buf write t.md --append --create -", "hello\n")
          assert wb_cli("buf read t.md") == "hello\n"
          assert wb_cli("eval '(+ 1 2)'").strip() == "3"
          # The unit's stack carries the Scheme cap of 10,000 frames (R4.34, LimitSTACK).
          assert wb_cli("eval '(define (f n) (if (= n 0) 0 (+ 1 (f (- n 1))))) (f 9900)'").strip() == "9900"
          assert "t.md" in wb_cli("buf ls")

          # A restart of edwind loses nothing: the lines before it are there, and writes continue.
          for i in range(1, 6):
              wb_cli("buf write t.md --append -", f"line {i}\n")
          hub_pid_before = main_pid("workbench-hub")
          wb.succeed("systemctl restart workbench-edit")
          wb.wait_until_succeeds(f"test -S {EDIT_SOCK}", timeout=30)
          assert main_pid("workbench-edit") != edit_pid, "edwind did not restart"
          wb.wait_until_succeeds("set -o pipefail; " + as_user("alice", f"env HOME={HOME} wb buf read t.md | grep -q 'line 5'"), timeout=30)
          wb_cli("buf write t.md --append -", "after\n")
          text = wb_cli("buf read t.md")
          assert text == "hello\n" + "".join(f"line {i}\n" for i in range(1, 6)) + "after\n", text
          assert main_pid("workbench-hub") == hub_pid_before, "the edwind restart touched the hub"

          # A web restart leaves edwind and the hub alone (R15.7, R15.8).
          edit_pid = main_pid("workbench-edit")
          wb.succeed("systemctl restart workbench-web")
          wb.wait_for_open_port(8090, WB_IP)
          assert main_pid("workbench-edit") == edit_pid, "the web restart touched edwind"
          assert main_pid("workbench-hub") == hub_pid_before, "the web restart touched the hub"

          # R9.21: with edwind, /api/info reports edit: true (pages are Edwin frames) and editUp: true
          # (wb-web reaches edwind over edit.sock after both restarts).
          info = json.loads(proxy.succeed("curl -sf http://wb.test/api/info"))
          assert info["edit"] is True, info
          assert info["editUp"] is True, info

          # R16.12: another uid cannot reach edit.sock (the directory is 0700), and wb refuses a socket it
          # does not own before sending anything.
          rc, out = wb.execute(as_user("bob", f"socat -t2 - UNIX-CONNECT:{EDIT_SOCK} </dev/null 2>&1"))
          assert rc != 0 and "ermission denied" in out, (rc, out)
          rc, out = wb.execute(as_user("bob", "env HOME=/tmp wb buf ls 2>&1"))
          assert rc != 0, out

      with subtest("11: wb board tools from a card go to the page over web.sock"):
          WEB_SOCK = "/run/workbench-web/web.sock"
          PAGE_TEXT = "WBCTL-PAGE-NODE-X"
          wb.wait_until_succeeds(f"test -S {WEB_SOCK}", timeout=30)
          assert wb.succeed(f"stat -c %a /run/workbench-web {WEB_SOCK}").split() == ["700", "600"]
          assert wb.succeed(f"stat -c %U /run/workbench-web {WEB_SOCK}").split() == ["alice", "alice"]
          # The card finds web.sock through WB_SOCKET, which the hub sets in every child.
          wbctl("pty-open w1 --spawn --send 'echo W$((0+1))' --expect W1")
          read = "wb read_node --json '{\"path\":\"x\"}'"
          # No /rpc client at all (no browser in this test): exit 7 and the message.
          rc, out = in_card("w1", "W2", read)
          assert rc == 7 and "wb: no Workbench page is open" in out, (rc, out)
          # wbctl's page: one /rpc client through the proxy, as a tab; it answers one read_node and ends.
          proxy.succeed(f"wbctl --url http://wb.test page --text {PAGE_TEXT} --count 1 --seconds 120 </dev/null >/tmp/page.out 2>&1 &")
          proxy.wait_until_succeeds("grep -q ready /tmp/page.out", timeout=30)
          rc, out = in_card("w1", "W3", read)
          assert rc == 0 and PAGE_TEXT in out, (rc, out)
          proxy.wait_until_succeeds("grep -q done /tmp/page.out", timeout=30)
          lines = [json.loads(line) for line in proxy.succeed("cat /tmp/page.out").splitlines()]
          assert {"cmd": {"tool": "read_node", "input": {"path": "x"}}} in lines, lines
          assert lines[-1] == {"done": True, "answered": 1, "closed": None}, lines
    '';
}
