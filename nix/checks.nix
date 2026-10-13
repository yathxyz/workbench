# `nix flake check`: package (with cargo test), clippy, fmt, Edwin's headless core and Scheme, the black-box
# conformance suite, the end-to-end security suite, the browser suite, the adapter probe against the stub, the VM test,
# the module's assertions. The harness registers wb-fake-acp (the package's `fake` output) as
# its `stub` agent, so every check that starts it has that output on PATH.
{
  pkgs,
  self,
  workbench,
  workbench-web,
}:
let
  inherit (pkgs) lib;
  tests = lib.fileset.toSource {
    root = ../tests;
    fileset = ../tests;
  };
  edwin = lib.fileset.toSource {
    root = ../edwin;
    fileset = ../edwin;
  };
in
{
  package = workbench;

  clippy = workbench.overrideAttrs (old: {
    pname = "workbench-clippy";
    outputs = [ "out" ];
    nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.clippy ];
    buildPhase = ''
      runHook preBuild
      cargo clippy --workspace --all-targets --offline -- -D warnings
      runHook postBuild
    '';
    doCheck = false;
    installPhase = "touch $out";
    postInstall = "";
  });

  fmt =
    pkgs.runCommand "workbench-fmt"
      {
        nativeBuildInputs = [
          pkgs.cargo
          pkgs.rustfmt
        ];
      }
      ''
        cp -r ${workbench.src} src
        chmod -R u+w src
        cd src
        HOME=$TMPDIR cargo fmt --all --check
        touch $out
      '';

  # Edwin's editing core in Node with no browser and no page stand-ins (step E0 of the edwind plan).
  edwin-headless = pkgs.runCommand "workbench-edwin-headless" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwin}/test/headless.test.mjs
    touch $out
  '';

  # Edwin's Scheme: the language (R4.3-R4.10, R4.31-R4.34), the editor-level forms (hooks, advice,
  # minor modes, buffer-locals, markers) and the shadow-stack cost bound (R4.34, at most 10%).
  edwin-scheme = pkgs.runCommand "workbench-edwin-scheme" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwin}/test/scheme*.test.mjs
    node ${edwin}/test/scheme-bench.mjs
    touch $out
  '';

  # tests/test_daemon.py over the harness: real wb-hub, wb-web and Caddy, as in `security`.
  conformance =
    pkgs.runCommand "workbench-conformance"
      {
        nativeBuildInputs = [
          pkgs.python3
          pkgs.bashInteractive
          pkgs.coreutils
          pkgs.caddy
          workbench
          workbench.fake
        ];
      }
      ''
        export HOME=$TMPDIR BASH=${pkgs.bashInteractive}/bin/bash
        python3 -I ${tests}/test_daemon.py --web-root ${workbench-web}
        touch $out
      '';

  # Real wb-hub and wb-web behind a real Caddy on loopback; sockets stay under $TMPDIR (/build).
  security =
    pkgs.runCommand "workbench-security"
      {
        nativeBuildInputs = [
          pkgs.python3
          pkgs.bashInteractive
          pkgs.coreutils
          pkgs.caddy
          workbench
          workbench.fake
        ];
      }
      ''
        export HOME=$TMPDIR BASH=${pkgs.bashInteractive}/bin/bash
        python3 -I ${tests}/test_security.py --web-root ${workbench-web}
        touch $out
      '';

  # tests/ui.mjs (the frontend's) in headless Chromium from nixpkgs. It starts the harness from
  # WB_HARNESS and imports Playwright from WB_PLAYWRIGHT. The browser reaches the harness's Caddy
  # through ui.mjs's own 127.0.0.1:18443 forwarder, which accepts only this build's uid.
  ui =
    pkgs.runCommand "workbench-ui"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.python3
          pkgs.bashInteractive
          pkgs.coreutils
          pkgs.caddy
          workbench
          workbench.fake
        ];
        WB_PLAYWRIGHT = "${pkgs.playwright-driver}/index.mjs";
        WB_HARNESS = "${tests}/harness.py";
        WB_WEB_ROOT = "${workbench-web}";
        # Chromium and its headless shell; the default launch uses the headless shell.
        PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers.override {
          withFirefox = false;
          withWebkit = false;
        };
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
        # Fallback fonts only: the page must render with the fonts wb-web serves.
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.liberation_ttf ]; };
      }
      ''
        export HOME=$TMPDIR BASH=${pkgs.bashInteractive}/bin/bash
        node ${tests}/ui.mjs
        touch $out
      '';

  # lib.adapterCheck against the stub, so the probe and its plumbing run here too; the real
  # adapters run in the consumer's flake.
  adapters = self.lib.adapterCheck {
    inherit pkgs;
    agents.stub = {
      label = "Stub";
      package = workbench.fake;
      exe = "bin/wb-fake-acp";
    };
  };

  vm = pkgs.testers.runNixOSTest (import ./vm.nix { inherit self; });

  # The module's assertions refuse what wb-hub would refuse at its next start, so a bad name
  # fails the evaluation instead of the first hub restart after a deploy.
  module =
    let
      failing =
        extra:
        let
          sys = pkgs.nixos {
            imports = [
              self.nixosModules.workbench
              extra
            ];
            system.stateVersion = lib.trivial.release;
            users.users.alice.isNormalUser = true;
            services.workbench = {
              enable = true;
              user = "alice";
              listenAddress = "192.0.2.2";
              trustedProxy = "192.0.2.1";
              publicOrigin = "https://wb.example.org";
              proxySecretFile = "/run/secrets/workbench-proxy-secret";
              firewall.interface = "wg0";
            };
          };
        in
        map (a: a.message) (
          lib.filter (a: !a.assertion && lib.hasPrefix "services.workbench" a.message) sys.config.assertions
        );
      expect = {
        valid = [ ];
        shellName = [ "services.workbench.shells: names" ];
        environmentName = [ "services.workbench.environment and agents" ];
        agentEnvName = [ "services.workbench.environment and agents" ];
        fixedName = [ "services.workbench.environment must not set" ];
      };
      got = lib.mapAttrs (_: failing) {
        valid = { };
        shellName.services.workbench.shells = {
          bash.paths = [ "/run/current-system/sw/bin/bash" ];
          my_sh.paths = [ "/run/current-system/sw/bin/sh" ];
        };
        environmentName.services.workbench.environment."FOO-BAR" = "x";
        agentEnvName.services.workbench.agents.x = {
          label = "X";
          exe = "/run/current-system/sw/bin/true";
          env."1X" = "x";
        };
        fixedName.services.workbench.environment.SHELL = "/bin/sh";
      };
      matches = lib.mapAttrs (
        case: prefixes:
        lib.length got.${case} == lib.length prefixes
        && lib.all (p: lib.any (lib.hasPrefix p) got.${case}) prefixes
      ) expect;
    in
    pkgs.runCommand "workbench-module" { } (
      if lib.all lib.id (lib.attrValues matches) then
        "touch $out"
      else
        ''
          echo ${lib.escapeShellArg (builtins.toJSON got)}
          exit 1
        ''
    );
}
