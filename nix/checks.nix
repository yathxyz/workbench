# `nix flake check`: package (with cargo test), clippy, fmt, the end-to-end security suite, the
# browser suite, the VM test.
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
in
{
  package = workbench;

  clippy = workbench.overrideAttrs (old: {
    pname = "workbench-clippy";
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
        ];
      }
      ''
        export HOME=$TMPDIR BASH=${pkgs.bashInteractive}/bin/bash
        python3 -I ${tests}/test_security.py --web-root ${workbench-web}
        touch $out
      '';

  # tests/ui.mjs (the frontend's) in headless Chromium from nixpkgs. It starts the harness from
  # WB_HARNESS and imports Playwright from WB_PLAYWRIGHT. WB_HARNESS_TCP lets the browser reach
  # the harness's Caddy on 127.0.0.1:18443; the sandbox's private network namespace makes that
  # safe, and the harness refuses it anywhere else.
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
        ];
        WB_PLAYWRIGHT = "${pkgs.playwright-driver}/index.mjs";
        WB_HARNESS = "${tests}/harness.py";
        WB_WEB_ROOT = "${workbench-web}";
        WB_HARNESS_TCP = "1";
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

  vm = pkgs.testers.runNixOSTest (import ./vm.nix { inherit self; });
}
