self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.workbench;
  inherit (lib)
    mkDefault
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  system = pkgs.stdenv.hostPlatform.system;
  userCfg = config.users.users.${cfg.user};
  home = userCfg.home;
  json = pkgs.formats.json { };

  # The non-secret variables a NixOS login would provide, as literal stable paths.
  # __NIXOS_SET_ENVIRONMENT_DONE stops /etc/bashrc and /etc/profile from sourcing
  # /etc/set-environment, which may export secrets from environment.sessionVariables.
  profiles = [
    "${home}/.nix-profile"
    "${home}/.local/state/nix/profile"
    "/etc/profiles/per-user/${cfg.user}"
    "/nix/var/nix/profiles/default"
    "/run/current-system/sw"
  ];
  under = suffix: lib.concatMapStringsSep ":" (p: "${p}/${suffix}") profiles;
  childSetEnv = {
    __NIXOS_SET_ENVIRONMENT_DONE = "1";
    PATH = "/run/wrappers/bin:" + under "bin";
    NIX_PROFILES = lib.concatStringsSep " " (lib.reverseList profiles);
    TERMINFO_DIRS = under "share/terminfo";
    XDG_CONFIG_DIRS = "/etc/xdg:" + under "etc/xdg";
    XDG_DATA_DIRS = under "share";
    LOCALE_ARCHIVE = "/run/current-system/sw/lib/locale/locale-archive";
    TZDIR = "/etc/zoneinfo";
    NIX_PATH = lib.concatStringsSep ":" config.nix.nixPath;
    WB_SOCKET = "/run/workbench-web/web.sock";
  };

  # Set on the hub unit by value and copied into every child (child.passEnv).
  hubEnv = {
    LANG = config.i18n.defaultLocale;
  }
  // cfg.environment;

  agentArgv0 = name: a: if a.package != null then "/etc/workbench/agents/${name}/${a.exe}" else a.exe;

  hubJson = json.generate "workbench-hub.json" {
    socket = "/run/workbench-hub/hub.sock";
    stateDir = "${home}/.local/state/workbench/hub";
    host = cfg.host;
    child = {
      shell = cfg.shell;
      passEnv = lib.attrNames hubEnv;
      setEnv = childSetEnv;
    };
    agents = lib.mapAttrs (name: a: {
      inherit (a) label env;
      argv = [ (agentArgv0 name a) ] ++ a.args;
    }) cfg.agents;
  };

  webJson = json.generate "workbench-web.json" {
    listen = "${cfg.listenAddress}:${toString cfg.port}";
    inherit (cfg)
      publicOrigin
      trustedProxy
      host
      shell
      boardsDir
      notesDir
      ;
    proxySecretFile = "/run/credentials/workbench-web.service/proxy-secret";
    socket = "/run/workbench-web/web.sock";
    hubSocket = "/run/workbench-hub/hub.sock";
    stateDir = "${home}/.local/state/workbench/web";
    webRoot = "${cfg.webPackage}";
    sample = null;
  };

  # Both units: the card-side escape hatches the brief closes. The tmpfiles rules below create
  # them, so a unit that cannot mount one fails instead of running without it.
  readOnlyUserPaths = [
    "${home}/.ssh"
    "${home}/.config/systemd"
    "${home}/.local/share/systemd"
  ];

  # The writable parents of the read-only paths below $HOME, bound onto themselves in both
  # units. A mount point cannot be renamed, so a card cannot move ~/.config aside and create a
  # fresh ~/.config/systemd that the user manager would read outside NoNewPrivileges.
  pinnedUserPaths = [
    "${home}/.config"
    "${home}/.local"
    "${home}/.local/share"
  ];

  isIPv4 = s: builtins.match "[0-9]{1,3}(\\.[0-9]{1,3}){3}" s != null;
in
{
  options.services.workbench = {
    enable = mkEnableOption "Workbench, a browser canvas over PTYs and ACP agents";

    package = mkOption {
      type = types.package;
      default = self.packages.${system}.workbench;
      defaultText = lib.literalExpression "workbench.packages.\${system}.workbench";
      description = "The package providing wb-hub, wb-web and wb.";
    };

    webPackage = mkOption {
      type = types.package;
      default = self.packages.${system}.workbench-web;
      defaultText = lib.literalExpression "workbench.packages.\${system}.workbench-web";
      description = "The web root served by wb-web.";
    };

    user = mkOption {
      type = types.str;
      description = "The user both units, every shell and every agent run as. The home directory comes from users.users.<user>.home.";
    };

    host = mkOption {
      type = types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "The host name shown in the UI and used for the board file name.";
    };

    listenAddress = mkOption {
      type = types.str;
      example = "192.0.2.2";
      description = "IPv4 literal wb-web listens on. Never a wildcard.";
    };

    port = mkOption {
      type = types.port;
      default = 8090;
      description = "TCP port wb-web listens on.";
    };

    publicOrigin = mkOption {
      type = types.str;
      example = "https://wb.example.org";
      description = "The origin browsers use. Host and Origin must match it.";
    };

    trustedProxy = mkOption {
      type = types.str;
      example = "192.0.2.1";
      description = "IP literal of the reverse proxy. Requests from any other source are refused.";
    };

    proxySecretFile = mkOption {
      type = types.str;
      example = "/run/secrets/workbench-proxy-secret";
      description = "Root-readable file holding the 64-hex secret header value; passed to wb-web with LoadCredential.";
    };

    firewall = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Accept the port only from trustedProxy on firewall.interface.";
      };
      interface = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "wg0";
        description = "Interface the proxy's traffic arrives on. Required when firewall.enable is true.";
      };
    };

    shell = mkOption {
      type = types.str;
      default = "/run/current-system/sw/bin/bash";
      description = "Absolute, stable path of the POSIX shell cards start.";
    };

    boardsDir = mkOption {
      type = types.str;
      default = "${home}/work/boards";
      defaultText = lib.literalExpression ''"''${home}/work/boards"'';
      description = "Directory holding <host>.json boards.";
    };

    notesDir = mkOption {
      type = types.str;
      default = "${home}/work/roam";
      defaultText = lib.literalExpression ''"''${home}/work/roam"'';
      description = "Notes directory.";
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        EDITOR = "nvim";
        PAGER = "less";
      };
      description = "Extra non-secret variables set on the hub and passed to every child.";
    };

    agents = mkOption {
      default = { };
      description = "ACP agents cards can start, by name.";
      type = types.attrsOf (
        types.submodule {
          options = {
            label = mkOption {
              type = types.str;
              description = "Name shown in the UI.";
            };
            package = mkOption {
              type = types.nullOr types.package;
              default = null;
              description = "Package linked at /etc/workbench/agents/<name>; exe is then relative to it.";
            };
            exe = mkOption {
              type = types.str;
              example = "bin/agent-acp";
              description = "Executable, relative to package, or an absolute stable path when package is null.";
            };
            args = mkOption {
              type = types.listOf types.str;
              default = [ ];
              description = "Arguments after the executable.";
            };
            env = mkOption {
              type = types.attrsOf types.str;
              default = { };
              description = "Extra non-secret environment for this agent.";
            };
          };
        }
      );
    };

    logLevel = mkOption {
      type = types.str;
      default = "info";
      description = "RUST_LOG for both units. Never passed to children.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = !config.networking.nftables.enable;
        message = "services.workbench: the source restriction uses networking.firewall.extraCommands (iptables); port it before enabling networking.nftables.";
      }
      {
        assertion = isIPv4 cfg.listenAddress && cfg.listenAddress != "0.0.0.0";
        message = "services.workbench.listenAddress must be a non-wildcard IPv4 literal.";
      }
      {
        assertion = !cfg.firewall.enable || (cfg.firewall.interface != null && isIPv4 cfg.trustedProxy);
        message = "services.workbench.firewall needs firewall.interface and an IPv4 trustedProxy.";
      }
      {
        assertion = lib.all (n: builtins.match "[a-z0-9-]{1,32}" n != null) (lib.attrNames cfg.agents);
        message = "services.workbench.agents: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        assertion = lib.all (a: a.package != null || lib.hasPrefix "/" a.exe) (lib.attrValues cfg.agents);
        message = "services.workbench.agents.<name>.exe must be absolute when package is null.";
      }
      {
        assertion = lib.all (v: !(lib.hasInfix "/nix/store" v) && !(lib.hasInfix "$" v)) (
          lib.attrValues childSetEnv
        );
        message = "services.workbench: the child environment must hold literal stable paths only (no /nix/store paths, no $ expansions); check nix.nixPath.";
      }
      {
        assertion = lib.intersectLists (lib.attrNames cfg.environment) (lib.attrNames childSetEnv) == [ ];
        message = "services.workbench.environment must not set ${lib.concatStringsSep ", " (lib.attrNames childSetEnv)}; the module sets them.";
      }
    ];

    environment.etc = {
      "workbench/hub.json".source = hubJson;
      "workbench/web.json".source = webJson;
    }
    // lib.mapAttrs' (name: a: lib.nameValuePair "workbench/agents/${name}" { source = a.package; }) (
      lib.filterAttrs (_: a: a.package != null) cfg.agents
    );

    # Without these directories systemd could not mount the paths above. Mode "-" leaves an
    # existing parent's mode alone.
    systemd.tmpfiles.rules =
      map (d: "d ${d} - ${cfg.user} ${userCfg.group} -") pinnedUserPaths
      ++ map (d: "d ${d} 0700 ${cfg.user} ${userCfg.group} -") readOnlyUserPaths;

    systemd.slices.workbench = {
      description = "Workbench: hub, web, shells and agents";
      sliceConfig = {
        MemoryMax = mkDefault "20G";
        CPUWeight = mkDefault 100;
        TasksMax = mkDefault 8192;
      };
    };

    systemd.services.workbench-hub = {
      description = "Workbench hub (PTYs and ACP agents)";
      wantedBy = [ "multi-user.target" ];
      # A deploy never restarts the hub: that would end every session.
      restartIfChanged = false;
      environment = hubEnv // {
        RUST_LOG = cfg.logLevel;
      };
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/wb-hub --config /etc/workbench/hub.json";
        User = cfg.user;
        Group = userCfg.group;
        Slice = "workbench.slice";
        RuntimeDirectory = "workbench-hub";
        RuntimeDirectoryMode = "0700";
        # SIGTERM to the hub only, so it can snapshot and flush; SIGKILL to the rest after it exits.
        KillMode = "mixed";
        TimeoutStopSec = 15;
        # One child's OOM kill must not stop the unit and end every session.
        OOMPolicy = "continue";
        # Children raise themselves to 800, so the OOM killer takes a session, never the hub.
        OOMScoreAdjust = 100;
        Restart = "on-failure";
        RestartSec = 2;

        # Guard-rails for cards. Nothing here may touch /dev/ptmx or /dev/pts, so there is
        # no PrivateDevices, ProtectClock or device policy, and no ProtectSystem/ProtectHome:
        # cards need the filesystem view an ssh shell has.
        NoNewPrivileges = true;
        InaccessiblePaths = [ "-/run/user" ];
        ReadOnlyPaths = readOnlyUserPaths;
        BindPaths = pinnedUserPaths;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        LockPersonality = true;
        CapabilityBoundingSet = "";
      };
    };

    systemd.services.workbench-web = {
      description = "Workbench web front";
      wantedBy = [ "multi-user.target" ];
      # Never Requires/BindsTo/PartOf: a web restart must not touch the hub.
      wants = [ "workbench-hub.service" ];
      after = [ "workbench-hub.service" ];
      stopIfChanged = false;
      restartTriggers = [ webJson ];
      startLimitIntervalSec = 0;
      path = [ config.systemd.package ];
      environment.RUST_LOG = cfg.logLevel;
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/wb-web --config /etc/workbench/web.json";
        User = cfg.user;
        Group = userCfg.group;
        Slice = "workbench.slice";
        UMask = "0077";
        RuntimeDirectory = "workbench-web";
        RuntimeDirectoryMode = "0700";
        LoadCredential = [ "proxy-secret:${cfg.proxySecretFile}" ];
        Restart = "always";
        RestartSec = 2;
        OOMScoreAdjust = 100;

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        # Boards, notes, state and /api/mv; the read-only paths below take precedence inside it.
        ReadWritePaths = [ home ];
        ReadOnlyPaths = readOnlyUserPaths;
        BindPaths = pinnedUserPaths;
        PrivateDevices = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        CapabilityBoundingSet = "";
      };
    };

    networking.firewall.extraCommands = mkIf cfg.firewall.enable ''
      iptables -A nixos-fw -i ${lib.escapeShellArg cfg.firewall.interface} -s ${lib.escapeShellArg cfg.trustedProxy} -d ${lib.escapeShellArg cfg.listenAddress} -p tcp --dport ${toString cfg.port} -j nixos-fw-accept
    '';
  };
}
