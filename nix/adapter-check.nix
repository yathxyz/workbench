# lib.adapterCheck { pkgs, agents }: tests/adapter_probe.py against a real wb-hub with the given
# agents, offline and without credentials. Each agent gets one session; the probe checks the
# agent's initialize result, never prompts, and ends the session with a forgetting kill.
#
# `agents` has the shape of services.workbench.agents ({ label, package, exe, args ? [ ],
# env ? { } }), except that every agent needs a package: the build sandbox has no
# /etc/profiles, so an agent given by an absolute exe alone cannot run here. Example:
#   agents.codex = { label = "Codex"; package = pkgs.codex-acp; exe = "bin/codex-acp";
#                    env.RUST_LOG = "error"; };
{ pkgs, agents }:
let
  inherit (pkgs) lib;
  workbench = pkgs.callPackage ./package.nix { edwind = pkgs.callPackage ./edwind.nix { }; };
  tests = lib.fileset.toSource {
    root = ../tests;
    fileset = lib.fileset.unions [
      ../tests/adapter_probe.py
      ../tests/wbctl.py
    ];
  };
  # hub.json's agents object, with the store path as argv[0]: wb-hub only needs it absolute.
  hubAgents = lib.mapAttrs (
    name: a:
    assert lib.assertMsg (
      a.package or null != null
    ) "lib.adapterCheck: agents.${name} needs a package (the sandbox has no /etc/profiles)";
    {
      label = a.label or name;
      argv = [ "${a.package}/${a.exe}" ] ++ a.args or [ ];
      env = a.env or { };
    }
  ) agents;
in
assert lib.assertMsg (agents != { }) "lib.adapterCheck: agents is empty";
pkgs.runCommand "workbench-adapters"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.bashInteractive
      pkgs.coreutils
      workbench
    ];
    agents = builtins.toJSON hubAgents;
    passAsFile = [ "agents" ];
  }
  ''
    # wb-hub reads HOME, USER and LOGNAME for its children; the sandbox sets none of them.
    export HOME=$TMPDIR USER=nixbld LOGNAME=nixbld BASH=${pkgs.bashInteractive}/bin/bash
    python3 -I ${tests}/adapter_probe.py --agents "$agentsPath"
    touch $out
  ''
