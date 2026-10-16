# `nix flake check`: package (with cargo test), clippy, fmt, Edwin's headless core and Scheme, the black-box
# conformance suite, the end-to-end security suite, the browser suite, the key contexts, the adapter probe against
# the stub, the VM test, the module's assertions. The harness registers wb-fake-acp (the package's `fake` output) as
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
  # The address suite cuts bufferAddress and friends out of web/app.js, so it sees that one file too.
  edwinApp = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../edwin
      ../web/app.js
    ];
  };
  # The edwind suites check MAX_LINE against wb-proto's (R7.2), so they see that one file of the crates.
  edwind = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../edwin
      ../crates/wb-proto/src/limits.rs
    ];
  };
  # fast-check for the OT properties: a dev dependency pinned in tools/package-lock.json (R15.1), installed
  # from the lock with no scripts, as nix/vendor.nix does.
  edwinDevDeps = pkgs.stdenv.mkDerivation {
    pname = "workbench-edwin-dev-deps";
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
    frames:
    pkgs.runCommand "workbench-ui${lib.optionalString frames "-frames"}"
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
        ${lib.optionalString frames "export WB_FRAMES=1"}
        node ${tests}/ui.mjs
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

  # Edwin's editing core in Node with no browser and no page stand-ins (step E0 of the edwind plan).
  edwin-headless = pkgs.runCommand "workbench-edwin-headless" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwin}/test/headless.test.mjs
    touch $out
  '';

  # Edwin's Scheme: the language (R4.3-R4.10, R4.31-R4.34), the editor-level forms (hooks, advice,
  # minor modes, buffer-locals, markers) and the shadow-stack cost bound (R4.34, at most 10%).
  edwin-scheme = pkgs.runCommand "workbench-edwin-scheme" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwin}/test/scheme*.test.mjs
    touch $out
  '';

  # The evaluator budgets (E2 gate): the shadow stack at most 10% (R4.34) and generator mode at most 3x direct
  # (R4.38, measured 1.2x). The bench recurses 1,000 deep in both modes, so it needs more stack than Node's default.
  edwin-bench = pkgs.runCommand "workbench-edwin-bench" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --stack-size=6900 ${edwin}/test/scheme-bench.mjs
    touch $out
  '';

  # The worker pool's Node host (E2): jobs on worker_threads, the main-thread fallback, cancellation.
  edwin-pool = pkgs.runCommand "workbench-edwin-pool" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwin}/test/pool.test.mjs
    touch $out
  '';

  # The OT properties (R16.1–R16.4): fast-check over random sessions, plus the undo properties and the
  # wire checks (R7.7, R7.8, R7.14, R6.16, R6.17). OT_RUNS raises the run count; the check uses the default.
  edwin-ot = pkgs.runCommand "workbench-edwin-ot" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export NODE_PATH=${edwinDevDeps}/node_modules
    node --test ${edwin}/test/ot.test.mjs
    touch $out
  '';

  # The board's key contexts (DESIGN §6.4) over the shipped web/keys.js: one command per key in every context
  # stack, every card keeps the keys it needs, the leader's Esc leaves any card.
  web-keys = pkgs.runCommand "workbench-web-keys" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    WB_KEYS=${workbench-web}/keys.js node --test ${tests}/keys.test.mjs
    touch $out
  '';

  # The intrinsics lockdown every thread of edwind runs in place of --frozen-intrinsics (R14.11, R16.16).
  edit-lockdown = pkgs.runCommand "workbench-edit-lockdown" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwind}/edwin/test/lockdown.test.mjs
    touch $out
  '';

  # A real edwind in a temp directory, under bin/edwind's Node flags, over every §7 message and error code,
  # the limits, chunking, resend, replay, the E1 server commands and the socket checks (R14.3, R16.12, R16.16, R16.17).
  edit-conformance = pkgs.runCommand "workbench-edit-conformance" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/conformance.test.mjs
    touch $out
  '';

  # SIGKILL at 1,000 random points under a three-client load, a journal torn at every byte offset, and a
  # full disk during save and journal append (R16.5–R16.7). About thirteen minutes.
  edit-crash = pkgs.runCommand "workbench-edit-crash" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/crash.test.mjs
    touch $out
  '';

  # External writes, the three-way merge, the conflict and deleted marks, CRLF, atomic save (R8.12–R8.15).
  edit-disk = pkgs.runCommand "workbench-edit-disk" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/disk.test.mjs
    touch $out
  '';

  # Shared anchors (R9.12) and the frame's small server commands (E3): the after-marker rule through every writer,
  # relocation after a disk revert, survival across restart and compaction, user-init, capf-candidates, sel.
  edit-anchors = pkgs.runCommand "workbench-edit-anchors" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/anchors.test.mjs
    touch $out
  '';

  # The E2 gates of the edwind spec (§17.1): the image log and its replication (edit-image), the notes index,
  # its grammar and the /api shapes (edit-notes), the block addresses against the golden file (edit-address).
  edit-image = pkgs.runCommand "workbench-edit-image" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/image.test.mjs
    touch $out
  '';
  edit-notes = pkgs.runCommand "workbench-edit-notes" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/notes.test.mjs
    touch $out
  '';
  edit-address = pkgs.runCommand "workbench-edit-address" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export NODE_PATH=${edwinDevDeps}/node_modules
    node --test ${edwinApp}/edwin/test/address.test.mjs
    touch $out
  '';

  # markdown-mode (E3, §10.1, R10.1-R10.5): the parity table's commands, faces, overlays, folding, the keyword
  # table shared with Org, journal-today, and the incremental font-lock budget (a keystroke in 10,000 lines
  # re-fontifies in 2 ms), in the headless runtime.
  edwin-markdown = pkgs.runCommand "workbench-edwin-markdown" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    node --test ${edwin}/test/markdown.test.mjs
    touch $out
  '';

  # The frame runtime (E3 H1, §6.3, §7, §9.5): Edwin's core as a protocol client against a real edwind:
  # open and snap, batches and acks, transform against pending edits, undo by group, reconnect and resend,
  # image replication, server commands and ask, anchors, server-only stubs.
  edit-frame = pkgs.runCommand "workbench-edit-frame" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/frame.test.mjs
    touch $out
  '';

  # The Lisp machine (E2, §4.6–§4.9): threads, held buffers, ask and answer, interrupt, timers, server
  # commands; the debugger, the inspector, introspection and the primitive registry.
  edit-lisp = pkgs.runCommand "workbench-edit-lisp" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/threads.test.mjs ${edwind}/edwin/test/debug.test.mjs
    touch $out
  '';

  # Processes through the hub (R4.43-R4.45) and the section 5 session API, against the fake hub.
  edit-process = pkgs.runCommand "workbench-edit-process" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/process.test.mjs ${edwind}/edwin/test/wb.test.mjs
    touch $out
  '';

  # The Scheme boundary (R16.15, R4.52) and the credential rules (R16.19, in models.test.mjs).
  edit-security = pkgs.runCommand "workbench-edit-security" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
    export HOME=$TMPDIR
    node --test ${edwind}/edwin/test/security.test.mjs ${edwind}/edwin/test/models.test.mjs
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
  # through ui.mjs's own 127.0.0.1:18443 forwarder, which accepts only this build's uid. The suite
  # runs once per page editor: `ui` with CodeMirror pages, `ui-frames` with pages as Edwin frames
  # (WB_FRAMES=1: the harness writes web.json frames: true and the frames section runs; edwind comes
  # from the workbench package on PATH). Two checks rather than one run after the other: each run
  # takes a browser session of several minutes, and the sandbox gives each its own loopback.
  ui = uiCheck false;
  ui-frames = uiCheck true;

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
        editFrames = [ "services.workbench.edit.frames requires" ];
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
        editFrames.services.workbench.edit = {
          enable = false;
          frames = true;
        };
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
