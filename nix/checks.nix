# `nix flake check`: package (with cargo test), clippy, fmt, the black-box conformance suite, the end-to-end security
# suite, the browser suite, the key contexts, the board's addresses against Edwin's, the adapter probe against the
# stub, the VM test, the module's assertions; flake.nix adds the edwin input's own checks. The harness registers
# wb-fake-acp (the package's `fake` output) as its `stub` agent, so every check that starts it has that output on PATH.
{
  pkgs,
  self,
  edwin,
  workbench,
  workbench-web,
}:
let
  inherit (pkgs) lib;
  tests = lib.fileset.toSource {
    root = ../tests;
    fileset = ../tests;
  };
  # The address suite cuts bufferAddress and friends out of web/app.ts, so it sees that one file too.
  addressTree = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../tests/address.test.mts
      ../tests/address-seeds.json
      ../web/app.ts
    ];
  };
  # Everything tsc reads (the typecheck check).
  typed = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      (lib.fileset.difference ../web (lib.fileset.maybeMissing ../web/vendor))
      ../tests
      ../tools/vendor-entry.js
      ../tools/strip.mts
    ];
  };
  # fast-check for the address properties and the TypeScript tools: dev dependencies pinned in
  # tools/package-lock.json (R15.1), installed from the lock with no scripts, as nix/vendor.nix does.
  devDeps = pkgs.stdenv.mkDerivation {
    pname = "workbench-dev-deps";
    version = (lib.importJSON ../tools/package.json).version;
    src = lib.fileset.toSource {
      root = ../tools;
      fileset = lib.fileset.unions [
        ../tools/package.json
        ../tools/package-lock.json
      ];
    };
    npmDeps = pkgs.importNpmLock {
      package = lib.importJSON ../tools/package.json;
      packageLock = lib.importJSON ../tools/package-lock.json;
    };
    npmFlags = [ "--ignore-scripts" ];
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.importNpmLock.npmConfigHook
    ];
    dontBuild = true;
    installPhase = ''
      mkdir -p $out
      cp -r node_modules $out/
    '';
  };
  uiCheck =
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
        node ${tests}/ui.mts
        touch $out
      '';
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

  # The board's key contexts (DESIGN §6.4) over the shipped keys.js (stripped from web/keys.ts): one command per key in every context
  # stack, every card keeps the keys it needs, the leader's Esc leaves any card.
  web-keys = pkgs.runCommand "workbench-web-keys" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    WB_KEYS=${workbench-web}/keys.js node --test ${tests}/keys.test.mts
    touch $out
  '';

  # tsc --strict over the TypeScript: the page (web/tsconfig.json and tsconfig.sw.json) and the suites
  # (tests/tsconfig.json). Node and tools/strip.mts only strip the types; this checks them. The page's library
  # types come from the vendored packages (tools/vendor-entry.js).
  typecheck = pkgs.runCommand "workbench-typecheck" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    cp -r ${typed} src && chmod -R u+w src && cd src
    ln -s ${devDeps}/node_modules tools/node_modules
    for p in web web/tsconfig.sw.json tests; do node tools/node_modules/typescript/bin/tsc -p $p; done
    touch $out
  '';

  # The block addresses (edwind spec §16.1 row edit-address): web/app.ts's bufferAddress, fmtAddr and
  # resolveBufferAddress against Edwin's scm/address.scm over generated cases, with Edwin's source tree as WB_EDWIN.
  edit-address = pkgs.runCommand "workbench-edit-address" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export NODE_PATH=${devDeps}/node_modules WB_EDWIN=${edwin}
    node --test ${addressTree}/tests/address.test.mts
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

  # tests/ui.mts (the frontend's) in headless Chromium from nixpkgs. It starts the harness from
  # WB_HARNESS and imports Playwright from WB_PLAYWRIGHT. The browser reaches the harness's Caddy
  # through ui.mts's own 127.0.0.1:18443 forwarder, which accepts only this build's uid. Pages are
  # Edwin frames (edwind comes from the workbench package on PATH); the demo section runs without
  # edwind, where pages are read-only (edwind spec R9.21).
  ui = uiCheck;

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
        editWritable = [ "services.workbench.edit.writablePaths" ];
        editUrl = [ "services.workbench.edit.models.*.baseUrl" ];
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
        editWritable.services.workbench.edit.writablePaths = [ "work/roam" ];
        editUrl.services.workbench.edit.models.openai.baseUrl = "http://api.example.org/v1";
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
