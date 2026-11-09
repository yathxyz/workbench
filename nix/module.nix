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
  # wb-web runs from the release profile when there is one; the hub always runs `package` (N-12).
  frontBin = if cfg.releaseProfile != null then "${cfg.releaseProfile}/bin" else "${cfg.package}/bin";
  pinnedRelease = self.packages.${system}.release;
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
      webRoot = if cfg.releaseProfile != null then "${cfg.releaseProfile}/web" else "${cfg.webPackage}";
      # The same list edwind refuses (R14.8); wb-web's /api/mv reads it instead of its built-in copy.
      refusePaths = readOnlyUserPaths;
    }
    # With edwind, wb-web forwards the notes endpoints and `sample` over its socket (R15.5) and relays
    # /edit to it; page cards are then Edwin frames, reported as /api/info `edit` (R9.21), on the frame
    # runtime of the same Edwin, served at /edwin/.
    // lib.optionalAttrs (edit.socket != null) {
      editSocket = edit.socket;
      edwinWebRoot = edit.webRoot;
    }
    // lib.optionalAttrs (cfg.media.providers != { }) {
      media.providers = lib.mapAttrs (
        name: p:
        {
          inherit (p) api baseUrl models;
        }
        // lib.optionalAttrs (p.apiKeyFile != null) {
          keyFile = "/run/credentials/workbench-web.service/media-${name}";
        }
      ) cfg.media.providers;
    }
  );
  mediaCredentials = lib.mapAttrsToList (name: p: "media-${name}:${p.apiKeyFile}") (
    lib.filterAttrs (_: p: p.apiKeyFile != null) cfg.media.providers
  );

  edit = cfg.edit;

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

    releaseProfile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/nix/var/nix/profiles/workbench";
      description = ''
        A Nix profile holding the flake's `release` output (N-12). When set, wb-web runs from it and
        serves its web root, so a release reaches it by switching the profile and restarting that one
        unit; the hub stays on `package`, since restarting it ends every session. The module
        resets the profile to this flake's own release whenever the profile is older, so the web is never
        older than the hub. `package` and `webPackage` must then be the flake's defaults.
      '';
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

    # Image providers for the canvas's media cards (F-A41): wb-web calls them, so their keys stay on the server.
    media.providers = mkOption {
      default = { };
      description = "Image providers for media cards, by name. A key file is loaded with LoadCredential as media-NAME and web.json names only its credential path. Describe and expand cards use edwind's models (`sample`) instead.";
      example = lib.literalExpression ''
        {
          openai = { api = "openai"; baseUrl = "https://api.openai.com/v1"; apiKeyFile = "/run/secrets/openai"; models = [ "gpt-image-1" ]; };
          xai = { api = "openai"; baseUrl = "https://api.x.ai/v1"; apiKeyFile = "/run/secrets/xai"; models = [ "grok-2-image" ]; };
          hf = { api = "huggingface"; baseUrl = "https://router.huggingface.co/hf-inference"; apiKeyFile = "/run/secrets/hf"; models = [ "black-forest-labs/FLUX.1-schnell" ]; };
        }
      '';
      type = types.attrsOf (
        types.submodule {
          options = {
            api = mkOption {
              type = types.enum [
                "openai"
                "huggingface"
              ];
              description = "openai: the OpenAI image API (OpenAI, xAI, LocalAI and others that copy it). huggingface: Hugging Face Inference.";
            };
            baseUrl = mkOption {
              type = types.str;
              description = "https, or http to loopback; the key is sent only here.";
            };
            apiKeyFile = mkOption {
              type = types.nullOr types.path;
              default = null;
              description = "Root-readable key file, sent as a bearer token; null for a local server that takes none.";
            };
            models = mkOption {
              type = types.nonEmptyListOf types.str;
              description = "Models the card offers; the first is the default.";
            };
          };
        }
      );
    };

    # edwind, Edwin's text daemon, which the host runs (edwin's services.edwind). Spec: the edwind artifact, §15.
    edit = {
      socket = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = lib.literalExpression "config.services.edwind.socket";
        description = "edwind's socket, owned by services.workbench.user. Set, `wb edit`, `wb buf` and `wb eval` work, wb-web forwards the notes endpoints and `sample` to it, and page cards are Edwin frames on its buffers (edwind spec R9.21). Null, page cards are read-only.";
      };
      webRoot = mkOption {
        type = types.nullOr types.path;
        default = null;
        example = lib.literalExpression "inputs.edwin.packages.\${system}.edwin-web";
        description = "edwin-web from the same Edwin as the edwind on edit.socket, which wb-web serves at /edwin/ (the frame runtime and its Scheme). Required with edit.socket.";
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
        assertion =
          cfg.releaseProfile == null
          || (
            cfg.package == self.packages.${system}.workbench
            && cfg.webPackage == self.packages.${system}.workbench-web
          );
        message = "services.workbench.releaseProfile pins the hub with this flake's release, so package and webPackage must keep their defaults.";
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
        assertion = edit.socket == null || edit.webRoot != null;
        message = "services.workbench.edit.webRoot is required with edit.socket: page cards are Edwin frames, served from it at /edwin/.";
      }
      {
        assertion = lib.all (p: isLoopbackHttp p.baseUrl) (lib.attrValues cfg.media.providers);
        message = "services.workbench.media.providers.*.baseUrl must be https, or http to loopback.";
      }
      {
        assertion = lib.all isName (lib.attrNames cfg.media.providers);
        message = "services.workbench.media.providers: names must match ^[a-z0-9-]{1,32}$.";
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
    // lib.optionalAttrs (edit.socket != null) {
      "workbench/agents.md".source = agentsMd;
    }
    // lib.mapAttrs' (name: a: lib.nameValuePair "workbench/agents/${name}" { source = a.package; }) (
      lib.filterAttrs (_: a: a.package != null) cfg.agents
    );

    # Without these directories systemd could not mount the paths above. Mode "-" leaves an
    # existing parent's mode alone.
    systemd.tmpfiles.rules =
      map (d: "d ${d} - ${cfg.user} ${userCfg.group} -") pinnedUserPaths
      ++ map (d: "d ${d} 0700 ${cfg.user} ${userCfg.group} -") readOnlyUserPaths;

    # R13.5: only shells inside Workbench (the hub sets WB_SESSION) get the editor variables.
    environment.interactiveShellInit = mkIf (edit.socket != null && edit.setEditor) ''
      if [ -n "$WB_SESSION" ]; then
        export EDITOR="wb edit --wait" VISUAL="wb edit --wait" WB_EDIT_SOCK=${edit.socket}
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

    # N-12: the release profile is never older than the release this module pins, which is the hub's
    # build after its next restart. Runs before wb-web at boot and again at every switch that changes the
    # pin; --no-block, because wb-web is ordered after this one.
    systemd.services.workbench-release-profile = mkIf (cfg.releaseProfile != null) {
      description = "Workbench release profile no older than the pinned release";
      wantedBy = [
        "multi-user.target"
        "workbench-web.service"
      ];
      before = [ "workbench-web.service" ];
      path = [
        config.nix.package
        config.systemd.package
      ];
      script = ''
        current=$(cat ${cfg.releaseProfile}/lastModified 2>/dev/null || echo 0)
        if [ "$current" -lt "$(cat ${pinnedRelease}/lastModified)" ]; then
          nix-env -p ${cfg.releaseProfile} --set ${pinnedRelease}
          systemctl try-restart --no-block workbench-web.service
        fi
      '';
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
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
      # what guarantees wb-web comes up. edwind is the host's: wb-web runs without it and reconnects
      # when it appears (R15.7).
      wants = [
        "workbench-hub.service"
        "network-online.target"
      ];
      after = [
        "workbench-hub.service"
        "network-online.target"
      ];
      stopIfChanged = false;
      restartTriggers = [ webJson ];
      startLimitIntervalSec = 0;
      path = [ config.systemd.package ];
      environment.RUST_LOG = cfg.logLevel;
      serviceConfig = {
        Type = "exec";
        ExecStart = "${frontBin}/wb-web --config /etc/workbench/web.json";
        User = cfg.user;
        Group = userCfg.group;
        Slice = "workbench.slice";
        UMask = "0077";
        RuntimeDirectory = "workbench-web";
        RuntimeDirectoryMode = "0700";
        LoadCredential = [ "proxy-secret:${cfg.proxySecretFile}" ] ++ mediaCredentials;
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
