# VM test, M0 subset: boot, the network edge, a PTY surviving a web restart, confinement and
# environment inside a card, hub.sock peer credentials, and a hub stop/start.
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
        nodes,
        pkgs,
        ...
      }:
      let
        home = config.users.users.alice.home;
      in
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

        # The read-only paths exist, so the units mount them read-only rather than skipping them.
        systemd.tmpfiles.rules = map (d: "d ${home}/${d} 0700 alice users -") [
          ".ssh"
          ".config"
          ".config/systemd"
          ".local"
          ".local/share"
          ".local/share/systemd"
        ];

        environment.systemPackages = [
          pkgs.git
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


      def wbctl(args):
          return json.loads(proxy.succeed(f"wbctl --url http://wb.test {args}"))


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

      with subtest("3/4: a PTY survives a web restart"):
          r = wbctl("pty-open s1 --spawn --send 'echo MARK$((0+1)); echo PID=$$' --expect 'PID=[0-9]+'")
          shell_pid = first("PID=([0-9]+)", r["output"])
          hub_pid = main_pid("workbench-hub")
          wb.succeed("systemctl restart workbench-web")
          wb.wait_for_unit("workbench-web.service")
          wb.wait_for_open_port(8090, WB_IP)
          assert main_pid("workbench-hub") == hub_pid, "the hub restarted"
          wb.succeed(f"kill -0 {shell_pid}")
          r = wbctl("pty-attach s1")
          assert "MARK1" in (r["replay"] or ""), r

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
              opts = wb.succeed(f"awk '$5 == \"{HOME}/.ssh\" {{print $6}}' /proc/{main_pid(unit)}/mountinfo").strip()
              assert opts.split(",")[0] == "ro", f"{unit}: ~/.ssh mount options {opts!r}"

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

      with subtest("9: hub stop and start"):
          cgroup = wb.succeed("systemctl show -p ControlGroup --value workbench-hub").strip()
          assert cgroup, "no control group"
          wb.succeed("systemctl stop workbench-hub")
          procs = f"/sys/fs/cgroup{cgroup}/cgroup.procs"
          wb.succeed(f"test ! -e {procs} || test -z \"$(cat {procs})\"")
          wb.fail(f"kill -0 {shell_pid}")
          wb.succeed("systemctl start workbench-hub")
          out = json.loads(wb.wait_until_succeeds(f"wbctl --hub {HUB_SOCK} sessions", timeout=30))
          assert out["sessions"] == [], out
    '';
}
