{ lib, rustPlatform }:
let
  cargoToml = lib.importTOML ../Cargo.toml;
in
rustPlatform.buildRustPackage {
  pname = "workbench";
  version = cargoToml.workspace.package.version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
    ];
  };
  cargoLock.lockFile = ../Cargo.lock;

  # Tests run in checkPhase against the release build: wb-proto, the hub and the web,
  # unit and integration. They need no network, agents or systemd; PTYs work in the sandbox.
  cargoTestFlags = [ "--workspace" ];
  # Test fixtures take the shell from $BASH; the builder's bash sets it without exporting it.
  preCheck = ''
    export BASH
  '';

  # wb-fake-acp is a test fixture and is never installed to $out/bin.
  postInstall = ''
    rm $out/bin/wb-fake-acp
  '';

  meta = {
    description = "Workbench hub, web front and wb CLI";
    mainProgram = "wb";
    platforms = [ "x86_64-linux" ];
  };
}
