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

  # wb-hub sets these in every PTY child itself (DESIGN 3.7.3 step 1) and refuses them in
  # child.passEnv and child.setEnv.
  fixedChildEnv = [
    "HOME"
    "USER"
    "LOGNAME"
    "SHELL"
    "WB_SESSION"
    "TERM"
    "COLORTERM"
  ];
  # wb-hub's rules for shell and agent names and for variable names.
  isName = n: builtins.match "[a-z0-9-]{1,32}" n != null;
  isEnvName = n: builtins.match "[A-Za-z_][A-Za-z0-9_]{0,63}" n != null;

  # Set on the hub unit by value and copied into every child (child.passEnv).
  hubEnv = {
    LANG = config.i18n.defaultLocale;
  }
  // cfg.environment;

  agentArgv0 = name: a: if a.package != null then "/etc/workbench/agents/${name}/${a.exe}" else a.exe;

  allShellPaths = lib.concatMap (s: s.paths) (lib.attrValues cfg.shells);

  hubJson = json.generate "workbench-hub.json" {
    socket = "/run/workbench-hub/hub.sock";
    stateDir = "${home}/.local/state/workbench/hub";
    host = cfg.host;
    # Attribute set order, so alphabetical.
    shells = lib.mapAttrsToList (name: s: {
      inherit name;
      inherit (s) paths args;
    }) cfg.shells;
    inherit (cfg) defaultShell;
    child = {
      passEnv = lib.attrNames hubEnv;
      setEnv = childSetEnv;
    };
    agents = lib.mapAttrs (name: a: {
      inherit (a) label env;
      argv = [ (agentArgv0 name a) ] ++ a.args;
    }) cfg.agents;
  };

  webJson = json.generate "workbench-web.json" (
    {
      listen = "${cfg.listenAddress}:${toString cfg.port}";
      inherit (cfg)
        publicOrigin
        trustedProxy
        host
        boardsDir
        notesDir
        ;
      proxySecretFile = "/run/credentials/workbench-web.service/proxy-secret";
      socket = "/run/workbench-web/web.sock";
      hubSocket = "/run/workbench-hub/hub.sock";
      stateDir = "${home}/.local/state/workbench/web";
      webRoot = "${cfg.webPackage}";
      # The same list edit.json carries (R14.8); wb-web's /api/mv reads it instead of its built-in copy.
      refusePaths = readOnlyUserPaths;
    }
    # With edwind, wb-web forwards the notes endpoints and `sample` over edit.sock (R15.5) and relays
    # /edit to it; `frames` switches the board's page editor (R9.20), reported as /api/info `edit`.
    // lib.optionalAttrs edit.enable {
      inherit editSocket;
      frames = edit.frames;
    }
  );

  # edwind (edwin/server, the edwind spec §15). `~` in writablePaths is the service user's home.
  edit = cfg.edit;
  expandHome = p: if p == "~" then home else if lib.hasPrefix "~/" p then home + lib.removePrefix "~" p else p;
  editWritable = map expandHome edit.writablePaths;
  editStateDir = "${home}/.local/state/workbench/edit";
  editConfigDir = "${home}/.config/edwin";
  editSocket = "/run/workbench-edit/edit.sock";
  # Backends with a key file get a LoadCredential entry and name it here; the key never enters the config.
  editBackend =
    name: b:
    lib.filterAttrs (_: v: v != null) {
      inherit (b) baseUrl;
      credential = if b.apiKeyFile != null then "${name}-api-key" else null;
    };
  editCredentials =
    lib.optional (edit.models.anthropic.apiKeyFile != null) "anthropic-api-key:${edit.models.anthropic.apiKeyFile}"
    ++ lib.optional (edit.models.openai.apiKeyFile != null) "openai-api-key:${edit.models.openai.apiKeyFile}"
    ++ lib.mapAttrsToList (name: c: "${name}:${c.file}") edit.credentials;
  editJson = json.generate "workbench-edit.json" {
    socket = editSocket;
    hubSocket = "/run/workbench-hub/hub.sock";
    webSocket = "/run/workbench-web/web.sock";
    stateDir = editStateDir;
    configDir = editConfigDir;
    inherit (cfg)
      notesDir
      boardsDir
      host
      logLevel
      ;
    writablePaths = editWritable;
    refusePaths = readOnlyUserPaths;
    models = {
      anthropic = editBackend "anthropic" edit.models.anthropic;
      openai = editBackend "openai" edit.models.openai;
      tiers = edit.models.tiers;
      credentials = lib.mapAttrs (_: c: { inherit (c) origin; }) edit.credentials;
    };
  };
  isLoopbackHttp =
    url:
    lib.hasPrefix "https://" url
    || lib.any (h: lib.hasPrefix h url) [
      "http://localhost"
      "http://127.0.0.1"
      "http://[::1]"
    ];
  # R13.6: what an agent needs to know to work with pages that may be open in Workbench.
  agentsMd = pkgs.writeText "workbench-agents.md" ''
    # Working with Workbench pages

    Pages under the notes directory may be open in Workbench, where every change is sequenced by edwind.
    Do not write page files directly; go through `wb`:

    - `wb buf read NAME` prints a page (or `wb buf read NAME --lines A-B` for a range).
    - `wb buf write NAME --patch PATCH` applies a unified diff you made against what `wb buf read` printed,
      so concurrent edits merge instead of being overwritten; `--append` adds to the end.
    - `wb eval FORM` runs Lisp on the server image, for example to open a page or define a command.

    NAME is a path under the notes directory, an absolute path or `~/…`. Other files are yours to write as usual.
  '';

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

    shells = mkOption {
      type = types.attrsOf (
        types.submodule {
          options = {
            paths = mkOption {
              type = types.nonEmptyListOf types.str;
              description = "Absolute, stable candidate paths (never /nix/store), tried in order at every spawn; the first that exists and is executable runs.";
            };
            args = mkOption {
              type = types.listOf types.str;
              default = [ "-i" ];
              description = "Arguments that start the shell interactive when a card names no command.";
            };
          };
        }
      );
      default = lib.genAttrs [ "bash" "fish" "nu" "zsh" ] (x: {
        paths = [
          "/etc/profiles/per-user/${cfg.user}/bin/${x}"
          "/run/current-system/sw/bin/${x}"
        ];
      });
      defaultText = lib.literalExpression ''
        lib.genAttrs [ "bash" "fish" "nu" "zsh" ] (x: {
          paths = [ "/etc/profiles/per-user/''${user}/bin/''${x}" "/run/current-system/sw/bin/''${x}" ];
        })
      '';
      description = ''
        The shells a card can start, by name; cards offer those with an existing path and never
        use $SHELL. Each starts interactive and non-login, with the hub's scrubbed environment.
        The shell's system-wide startup files still run in cards, so environment.shellInit,
        environment.interactiveShellInit, programs.bash.* and their zsh and fish counterparts
        apply. Only /etc/set-environment is skipped (through __NIXOS_SET_ENVIRONMENT_DONE=1),
        because it may export secrets set in environment.variables or
        environment.sessionVariables.
      '';
    };

    defaultShell = mkOption {
      type = types.str;
      default = "bash";
      description = "The shell, a name in shells, that a card gets when it names none.";
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

    # edwind, the text daemon (edwin/server). Spec: the edwind artifact, §15.2.
    edit = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Run edwind on edit.sock, so `wb edit`, `wb buf` and `wb eval` work. The board is unchanged.";
      };
      frames = mkOption {
        type = types.bool;
        default = false;
        description = "Page cards become Edwin frames over /edit, and the board migrates pages to edwind buffers (edwind spec R8.16, R9.20). Written to web.json as `frames`; /api/info reports it as `edit`. Requires edit.enable. Off by default until E4.";
      };
      memoryMiB = mkOption {
        type = types.ints.positive;
        default = 1024;
        description = "V8 heap limit for edwind (--max-old-space-size); MemoryMax is this plus 25%.";
      };
      writablePaths = mkOption {
        type = types.listOf types.str;
        default = [ "~" ];
        description = "Where edwind may write besides notesDir, its state and ~/.config/edwin. `~` is the service user's home. The refusal list (~/.ssh, ~/.config/systemd, ~/.local/share/systemd) always applies.";
      };
      models = {
        anthropic = {
          apiKeyFile = mkOption {
            type = types.nullOr types.path;
            default = null;
            description = "Root-readable Anthropic key file, loaded as the credential anthropic-api-key.";
          };
          baseUrl = mkOption {
            type = types.str;
            default = "https://api.anthropic.com";
            description = "https, or http to loopback; the credential is bound to this origin.";
          };
        };
        openai = {
          apiKeyFile = mkOption {
            type = types.nullOr types.path;
            default = null;
            description = "Root-readable key file for an OpenAI-compatible backend, loaded as openai-api-key.";
          };
          baseUrl = mkOption {
            type = types.nullOr types.str;
            default = null;
            description = "Base URL of the OpenAI-compatible backend; https, or http to loopback.";
          };
        };
        tiers = mkOption {
          type = types.attrsOf types.str;
          default = {
            default = "claude-opus-5-5";
            quick = "claude-haiku-5-5";
          };
          description = "Model names by tier (R12.6).";
        };
      };
      credentials = mkOption {
        default = { };
        description = "More LoadCredential entries, readable from Scheme only as (credential \"name\") handles bound to origin.";
        type = types.attrsOf (
          types.submodule {
            options = {
              file = mkOption {
                type = types.path;
                description = "Root-readable secret file.";
              };
              origin = mkOption {
                type = types.str;
                description = "The only origin (scheme://host[:port]) http-request may send this credential to.";
              };
            };
          }
        );
      };
      setEditor = mkOption {
        type = types.bool;
        default = true;
        description = "Set EDITOR and VISUAL to `wb edit --wait` and WB_EDIT_SOCK in interactive shells inside Workbench (R13.5).";
      };
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
        assertion = lib.all isName (lib.attrNames cfg.agents);
        message = "services.workbench.agents: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        assertion = lib.all isName (lib.attrNames cfg.shells);
        message = "services.workbench.shells: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        assertion = lib.all isEnvName (
          lib.attrNames cfg.environment ++ lib.concatMap (a: lib.attrNames a.env) (lib.attrValues cfg.agents)
        );
        message = "services.workbench.environment and agents.<name>.env: variable names must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$.";
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
        assertion = !edit.frames || edit.enable;
        message = "services.workbench.edit.frames requires services.workbench.edit.enable.";
      }
      {
        assertion = lib.all (p: p == "~" || lib.hasPrefix "~/" p || lib.hasPrefix "/" p) edit.writablePaths;
        message = "services.workbench.edit.writablePaths: entries must be absolute or start with ~.";
      }
      {
        assertion =
          isLoopbackHttp edit.models.anthropic.baseUrl
          && (edit.models.openai.baseUrl == null || isLoopbackHttp edit.models.openai.baseUrl)
          && lib.all (c: isLoopbackHttp c.origin) (lib.attrValues edit.credentials);
        message = "services.workbench.edit.models.*.baseUrl and edit.credentials.*.origin must be https, or http to loopback.";
      }
      {
        assertion = lib.all isName (lib.attrNames edit.credentials);
        message = "services.workbench.edit.credentials: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        assertion = lib.hasAttr cfg.defaultShell cfg.shells;
        message = "services.workbench.defaultShell (${cfg.defaultShell}) must be a name in services.workbench.shells.";
      }
      {
        assertion = lib.all (p: lib.hasPrefix "/" p && !(lib.hasInfix "/nix/store" p)) allShellPaths;
        message = "services.workbench.shells: paths must be absolute and stable (never /nix/store), such as /run/current-system/sw/bin/bash.";
      }
      {
        assertion =
          lib.intersectLists (lib.attrNames cfg.environment) (lib.attrNames childSetEnv ++ fixedChildEnv)
          == [ ];
        message = "services.workbench.environment must not set ${
          lib.concatStringsSep ", " (lib.attrNames childSetEnv ++ fixedChildEnv)
        }; the module or the hub sets them.";
      }
    ];

    environment.etc = {
      "workbench/hub.json".source = hubJson;
      "workbench/web.json".source = webJson;
    }
    // lib.optionalAttrs edit.enable {
      "workbench/edit.json".source = editJson;
      "workbench/agents.md".source = agentsMd;
    }
    // lib.mapAttrs' (name: a: lib.nameValuePair "workbench/agents/${name}" { source = a.package; }) (
      lib.filterAttrs (_: a: a.package != null) cfg.agents
    );

    # Without these directories systemd could not mount the paths above. Mode "-" leaves an
    # existing parent's mode alone.
    systemd.tmpfiles.rules =
      map (d: "d ${d} - ${cfg.user} ${userCfg.group} -") pinnedUserPaths
      ++ map (d: "d ${d} 0700 ${cfg.user} ${userCfg.group} -") readOnlyUserPaths
      # edwind's state and config directories exist before the unit starts (R14.10); the parents are the
      # user's, left as they are when present.
      ++ lib.optionals edit.enable (
        map (d: "d ${d} - ${cfg.user} ${userCfg.group} -") [
          "${home}/.local/state"
          "${home}/.local/state/workbench"
        ]
        ++ map (d: "d ${d} 0700 ${cfg.user} ${userCfg.group} -") [
          editStateDir
          editConfigDir
        ]
      );

    # R13.5: only shells inside Workbench (the hub sets WB_SESSION) get the editor variables.
    environment.interactiveShellInit = mkIf (edit.enable && edit.setEditor) ''
      if [ -n "$WB_SESSION" ]; then
        export EDITOR="wb edit --wait" VISUAL="wb edit --wait" WB_EDIT_SOCK=${editSocket}
      fi
    '';

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
      # Never Requires/BindsTo/PartOf: a web restart must not touch the hub. network-online
      # makes a first-boot failure on a missing listen address less likely; Restart=always is
      # what guarantees wb-web comes up.
      # wants/after edwind, never Requires or BindsTo: wb-web runs without it (R15.7).
      wants = [
        "workbench-hub.service"
        "network-online.target"
      ]
      ++ lib.optional edit.enable "workbench-edit.service";
      after = [
        "workbench-hub.service"
        "network-online.target"
      ]
      ++ lib.optional edit.enable "workbench-edit.service";
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

    # edwind (R14.10, R14.11, R15.3). It restarts on its own at a deploy; frames and wb ride through
    # (R15.8). Edits and the image log are on disk before they are acknowledged, so a restart loses nothing.
    systemd.services.workbench-edit = mkIf edit.enable {
      description = "Workbench edwind (text buffers and the Lisp machine)";
      wantedBy = [ "multi-user.target" ];
      wants = [ "workbench-hub.service" ];
      after = [ "workbench-hub.service" ];
      stopIfChanged = false;
      restartTriggers = [ editJson ];
      startLimitIntervalSec = 0;
      environment.EDWIND_MEMORY_MIB = toString edit.memoryMiB;
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/edwind --config /etc/workbench/edit.json";
        User = cfg.user;
        Group = userCfg.group;
        Slice = "workbench.slice";
        UMask = "0077";
        RuntimeDirectory = "workbench-edit";
        RuntimeDirectoryMode = "0700";
        # edwind is TypeScript that Node strips at load; the compile cache keeps the stripped code, so only
        # the first start after a deploy pays for it (about 240 ms).
        CacheDirectory = "workbench-edit";
        CacheDirectoryMode = "0700";
        Environment = [ "NODE_COMPILE_CACHE=%C/workbench-edit" ];
        LoadCredential = editCredentials;
        Restart = "always";
        RestartSec = 1;
        TimeoutStopSec = 10;
        OOMScoreAdjust = 100;
        MemoryMax = "${toString (edit.memoryMiB * 5 / 4)}M";
        # The server runs on a worker thread whose stack main.mts sizes itself (32 MiB, the Scheme cap of
        # 10,000 frames needs about 8 MiB); the limit only has to admit that thread's stack.
        LimitSTACK = "64M";

        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        # The home plus writable paths outside it; the more specific mounts below win inside the home.
        ReadWritePaths = lib.unique (
          [
            home
            cfg.notesDir
            editStateDir
            editConfigDir
          ]
          ++ lib.filter (p: !(lib.hasPrefix "${home}/" p) && p != home) editWritable
        );
        ReadOnlyPaths = readOnlyUserPaths ++ [ "-${cfg.boardsDir}" ];
        BindPaths = pinnedUserPaths;
        InaccessiblePaths = [ "-/run/user" ];
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        ProtectClock = true;
        ProtectHostname = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        CapabilityBoundingSet = "";
        # No MemoryDenyWriteExecute: V8's JIT needs it.
      };
    };

    networking.firewall.extraCommands = mkIf cfg.firewall.enable ''
      iptables -A nixos-fw -i ${lib.escapeShellArg cfg.firewall.interface} -s ${lib.escapeShellArg cfg.trustedProxy} -d ${lib.escapeShellArg cfg.listenAddress} -p tcp --dport ${toString cfg.port} -j nixos-fw-accept
    '';
  };
}
