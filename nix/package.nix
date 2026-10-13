{
  lib,
  stdenv,
  rustPlatform,
  nodejs,
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
  # edwind's identity for welcome.build (R15.14): the hash part of the store path of what bin/edwind runs.
  edwinSrc = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../edwin/src
      ../edwin/scm
      ../edwin/server
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
      # wb-cli's integration tests start a real edwind (crates/wb-cli/tests/common/mod.rs).
      ../edwin/src
      ../edwin/scm
      ../edwin/server
    ];
  };
  cargoLock.lockFile = ../Cargo.lock;

  nativeBuildInputs = [ nodejs ];

  # wb-hub sends it in its hello and wb-web compares it with its own (option_env!).
  # The hash part of the hub source's store path.
  env.WB_HUB_BUILD = builtins.substring 11 32 (toString hubSrc);
  env.WB_EDIT_BUILD = builtins.substring 11 32 (toString edwinSrc);

  # Tests run in checkPhase against the release build: wb-proto, the hub and the web,
  # unit and integration. They need no network, agents or systemd; PTYs work in the sandbox.
  cargoTestFlags = [ "--workspace" ];
  # Test fixtures take the shell from $BASH; the builder's bash sets it without exporting it.
  preCheck = ''
    export BASH
    export WB_EDWIND_MAIN="$PWD/edwin/server/main.mjs" WB_NODE=${nodejs}/bin/node
  '';

  # wb-fake-acp, the scripted test agent, goes to its own output and never to $out/bin.
  outputs = [
    "out"
    "fake"
  ];
  postInstall = ''
    mkdir -p $fake/bin
    mv $out/bin/wb-fake-acp $fake/bin/

    # edwind: Edwin's core, Scheme files and the server (R15.3), and the wrapper with the Node flags of
    # R14.11. R14.12's permission model is not among them: Node disables fsync under it, which the journal
    # and atomic save need (R8.3, R8.7); edwind guards child_process in-process instead (edwin/README.md, E1).
    # The stack is sized to the soft limit minus headroom, at most 32000 KiB (the unit sets LimitSTACK).
    mkdir -p $out/share/edwin
    cp -r edwin/src edwin/scm edwin/server $out/share/edwin/
    cat > $out/bin/edwind <<EOF
    #!${stdenv.shell}
    : "\''${EDWIND_MEMORY_MIB:=1024}"
    lim=\$(ulimit -s)
    if [ "\$lim" = unlimited ]; then stack=32000; else stack=\$((lim - 1200)); fi
    [ "\$stack" -gt 32000 ] && stack=32000
    [ "\$stack" -lt 984 ] && stack=984
    export WB_EDIT_BUILD=$WB_EDIT_BUILD
    exec ${nodejs}/bin/node --disallow-code-generation-from-strings --frozen-intrinsics \
      --no-warnings=ExperimentalWarning --max-old-space-size="\$EDWIND_MEMORY_MIB" --stack-size="\$stack" \
      $out/share/edwin/server/main.mjs "\$@"
    EOF
    chmod 555 $out/bin/edwind
  '';

  meta = {
    description = "Workbench hub, web front, edwind and the wb CLI";
    mainProgram = "wb";
    platforms = [ "x86_64-linux" ];
  };
}
