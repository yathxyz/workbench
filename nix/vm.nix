# VM test, PTY steps (40-nix-deploy-security 1.7 with DESIGN 9.4's edits; the ACP parts arrive
# with the agents): boot, the network edge, a PTY surviving a web restart and resuming from the
# ring, confinement and environment inside a card, nothing auto-running, kill-forget then reopen,
# a nushell card, a deploy-style switch, an OOM kill, hub.sock peer credentials, and a hub
# stop/start that leaves a corpse with the last screen.
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
        };

        # Canaries: set-environment exports (a login would pick them up) and the hub's own environment.
        environment.variables.ANTHROPIC_API_KEY = "leak-canary";
        environment.sessionVariables.WB_CANARY = "$(echo canary-from-set-environment)";
        systemd.services.workbench-hub.environment.WB_TEST_CANARY = "leak-canary-2";

        # Small enough for the OOM step; the specialisation raises it to prove a switch applies
        # slice changes without restarting the hub.
        systemd.slices.workbench.sliceConfig.MemoryMax = "400M";
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

      with subtest("3/4: a PTY survives a web restart and resumes from the ring"):
          r = wbctl("pty-open s1 --spawn --send 'echo MARK$((0+1)); echo PID=$$' --expect 'PID=[0-9]+'")
          shell_pid = first("PID=([0-9]+)", r["output"])
          stream, mark_out = r["hello"]["stream"], r["lastOut"]
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
          # T-S16 in the VM: /api/mv into ~/.ssh is refused, and the source stays put.
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

      with subtest("9: hub stop and start leave a corpse with the last screen"):
          cgroup = wb.succeed("systemctl show -p ControlGroup --value workbench-hub").strip()
          assert cgroup, "no control group"
          wb.succeed("systemctl stop workbench-hub")
          procs = f"/sys/fs/cgroup{cgroup}/cgroup.procs"
          wb.succeed(f"test ! -e {procs} || test -z \"$(cat {procs})\"")
          wb.fail(f"kill -0 {shell_pid}")
          wb.succeed("systemctl start workbench-hub")
          out = json.loads(wb.wait_until_succeeds(f"wbctl --hub {HUB_SOCK} sessions", timeout=30))
          s1 = next(s for s in out["sessions"] if s["sid"] == "s1")
          assert s1["alive"] is False and s1["pty"]["exit"]["reason"] == "hub_restart", s1
          # The web reconnects to the new hub on its own; retry until it has.
          r = wbctl("pty-attach s1 --wait-exit", retry=True)
          assert r["hello"]["new"] is False and "MARK1" in (r["replay"] or ""), r
          assert r["exit"]["reason"] == "hub_restart", r["exit"]
    '';
}
