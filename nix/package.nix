{
  lib,
  stdenv,
  rustPlatform,
  nodejs,
  edwind,
}:
let
  root = ../.;
  cargoToml = lib.importTOML ../Cargo.toml;
  # The hub's identity: it changes exactly when the hub or protocol sources or the lock change,
  # so a web-only deploy never marks the running hub stale (DESIGN N-4, 3.2.3 rule 5).
  hubSrc = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../crates/wb-hub
      ../crates/wb-proto
      ../Cargo.lock
    ];
  };
in
rustPlatform.buildRustPackage {
  pname = "workbench";
  version = cargoToml.workspace.package.version;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
    ];
  };
  cargoLock.lockFile = ../Cargo.lock;

  nativeBuildInputs = [ nodejs ];

  # wb-hub sends it in its hello and wb-web compares it with its own (option_env!).
  # The hash part of the hub source's store path.
  env.WB_HUB_BUILD = builtins.substring 11 32 (toString hubSrc);

  # Tests run in checkPhase against the release build: wb-proto, the hub and the web,
  # unit and integration. They need no network, agents or systemd; PTYs work in the sandbox.
  cargoTestFlags = [ "--workspace" ];
  # Test fixtures take the shell from $BASH; the builder's bash sets it without exporting it.
  preCheck = ''
    export BASH
    # wb-cli's integration tests start a real edwind (crates/wb-cli/tests/common/mod.rs).
    export WB_EDWIND_MAIN=${edwind}/share/edwin/server/main.mts WB_NODE=${nodejs}/bin/node
  '';

  # wb-fake-acp, the scripted test agent, goes to its own output and never to $out/bin.
  outputs = [
    "out"
    "fake"
  ];
  postInstall = ''
    mkdir -p $fake/bin
    mv $out/bin/wb-fake-acp $fake/bin/

    # edwind (the edwin input), which wb edit and the workbench-edit unit run.
    ln -s ${edwind}/bin/edwind $out/bin/edwind
    mkdir -p $out/share
    ln -s ${edwind}/share/edwin $out/share/edwin
  '';

  meta = {
    description = "Workbench hub, web front, edwind and the wb CLI";
    mainProgram = "wb";
    platforms = [ "x86_64-linux" ];
  };
}
