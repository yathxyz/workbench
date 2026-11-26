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
  worker = cfg.agentUser;
  workerEnabled = worker != null;
  distinctWorker = workerEnabled && worker != "root" && worker != cfg.user;
  workerHome = "/var/lib/${worker}";
  workerRoot = "${workerHome}/work";
  workerSocket = "/run/workbench-worker/agent.sock";
  workerSources = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./worker.py
      ./worker_checkout.py
    ];
  };
  json = pkgs.formats.json { };

  # The non-secret variables a NixOS login would provide, as literal stable paths.
  # __NIXOS_SET_ENVIRONMENT_DONE stops /etc/bashrc and /etc/profile from sourcing
  # /etc/set-environment, which may export secrets from environment.sessionVariables.
  childEnv =
    user: userHome:
    let
      profiles = [
        "${userHome}/.nix-profile"
        "${userHome}/.local/state/nix/profile"
        "/etc/profiles/per-user/${user}"
        "/nix/var/nix/profiles/default"
        "/run/current-system/sw"
      ];
      under = suffix: lib.concatMapStringsSep ":" (p: "${p}/${suffix}") profiles;
    in
    {
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
  childSetEnv = childEnv cfg.user home;

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
  # wb-hub's rules for shell, agent and host names and for variable names.
  isName = n: builtins.match "[a-z0-9-]{1,32}" n != null;
  isHostName = n: builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*" n != null;
  isEnvName = n: builtins.match "[A-Za-z_][A-Za-z0-9_]{0,63}" n != null;

  # Set on the hub unit by value and copied into every child (child.passEnv).
  hubEnv = {
    LANG = config.i18n.defaultLocale;
  }
  // cfg.environment;

  agentArgv0 = name: a: if a.package != null then "/etc/workbench/agents/${name}/${a.exe}" else a.exe;
  agentCommands = lib.mapAttrs (name: a: {
    inherit (a) env;
    argv = [ (agentArgv0 name a) ] ++ a.args;
  }) cfg.agents;

  workerJson = json.generate "workbench-worker.json" {
    root = workerRoot;
    git = "/etc/workbench/bin/git";
    agents = agentCommands;
    env = hubEnv // childEnv worker workerHome;
    shell = "/run/current-system/sw/bin/bash";
  };

  allShellPaths = lib.concatMap (s: s.paths) (lib.attrValues cfg.shells);

  hubJson = json.generate "workbench-hub.json" (
    {
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
      agents = lib.mapAttrs (name: a: agentCommands.${name} // { inherit (a) label; }) cfg.agents;
    }
    // lib.optionalAttrs workerEnabled {
      agentWorker = {
        root = workerRoot;
        socket = workerSocket;
      };
    }
    // lib.optionalAttrs (cfg.gitPackage != null) {
      git = "/etc/workbench/bin/git";
    }
    // lib.optionalAttrs (cfg.worktreeRoot != null) {
      inherit (cfg) worktreeRoot;
    }
    # Only when set, so that a hub without hosts keeps its config, and its sessions.
    // lib.optionalAttrs (cfg.hosts != { }) {
      hosts = lib.mapAttrs (_: h: {
        inherit (h) argv;
        agents = lib.mapAttrs (_: a: { inherit (a) label; }) h.agents;
      }) cfg.hosts;
    }
  );

  webJson = json.generate "workbench-web.json" (
    {
      listen = "${cfg.listenAddress}:${toString cfg.port}";
      inherit (cfg)
        publicOrigin
        trustedProxy
        host
        attachCommand
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
    # The mesh API (design §3.8.1): web.json names only each token's credential path.
    // lib.optionalAttrs (cfg.api.clients != { }) {
      api = {
        listen = "${cfg.api.listenAddress}:${toString cfg.api.port}";
        clients = lib.mapAttrs (
          name: c:
          {
            tokenFile = "/run/credentials/workbench-web.service/api-${name}";
            inherit (c) scopes;
          }
          // lib.optionalAttrs (c.host != null) { inherit (c) host; }
          // lib.optionalAttrs (c.address != null) { inherit (c) address; }
        ) cfg.api.clients;
      };
    }
  );
  apiCredentials = lib.mapAttrsToList (name: c: "api-${name}:${c.tokenFile}") cfg.api.clients;
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

    gitPackage = mkOption {
      type = types.nullOr types.package;
      default = pkgs.git;
      defaultText = lib.literalExpression "pkgs.git";
      description = "Git for local ACP worktrees and isolated clones. Null disables managed worktrees and is incompatible with agentUser.";
    };

    worktreeRoot = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/srv/wt";
      description = ''
        Absolute runtime directory under which the hub mirrors main checkout paths for new managed
        local ACP worktrees. It must be writable by the service user. When null, the hub places
        worktrees beside the main checkout instead. This option does not apply to agentUser's clones.
      '';
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
      description = "User for the hub, web, owner terminals and SSH launches. Local agents also run as this user unless agentUser is set. The home directory comes from users.users.<user>.home.";
    };

    agentUser = mkOption {
      type = types.nullOr (types.strMatching "[a-z_][a-z0-9_-]{0,30}");
      default = null;
      example = "wb-agent";
      description = ''
        Optional dedicated system user and group for local ACP agents. Use a new name, distinct
        from the owner. The module creates a private home in /var/lib and starts each local agent
        over a private socket in its own systemd unit. Its checkout is a worker-owned clone, not
        a worktree in the owner's repository. Requires gitPackage. PTYs and SSH launches are unchanged.
      '';
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

    attachCommand = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/current-system/sw/bin/attach-agent";
      description = ''
        Command that opens an observed agent's existing terminal. The absolute path must match
        ^/[A-Za-z0-9._/+-]+$. It gets one argument, host:claude:id or host:tmux:pane:socket,
        and carries the terminal over stdio. Closing it must leave the agent running.
      '';
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

    hosts = mkOption {
      default = { };
      description = ''
        Other hosts of the mesh whose agents cards can start, by name (a host name must
        differ from host). For an agent A of host H, session S and directory C, the hub
        runs argv followed by A, the lowercase hex of C and S, in its home directory, with
        the child environment but none of agents.<name>.env. argv is typically ssh to the
        host's launcher, which maps A to a command, changes to C, sets WB_SESSION=S and
        runs it with its own standard input and output. Changing this restarts the hub.
      '';
      example = lib.literalExpression ''
        {
          laptop = {
            argv = [ "/run/current-system/sw/bin/ssh" "-T" "-oBatchMode=yes" "alice@198.51.100.7" "workbench-agent" ];
            agents.claude.label = "Claude";
          };
        }
      '';
      type = types.attrsOf (
        types.submodule {
          options = {
            argv = mkOption {
              type = types.nonEmptyListOf types.str;
              description = "The command that reaches the host's launcher; argv[0] is an absolute stable path.";
            };
            agents = mkOption {
              default = { };
              description = "The agents the host's launcher knows, by name.";
              type = types.attrsOf (
                types.submodule {
                  options.label = mkOption {
                    type = types.str;
                    description = "Name shown in the UI.";
                  };
                }
              );
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

    # The mesh API (design §3.8): a second listener of wb-web, for the hosts that report their agent
    # sessions and for the clients that read and steer the hub. It exists when a client is defined.
    api = {
      listenAddress = mkOption {
        type = types.str;
        default = cfg.listenAddress;
        defaultText = lib.literalExpression "config.services.workbench.listenAddress";
        example = "192.0.2.2";
        description = "IPv4 literal the API listens on: the host's address on the mesh interface. Never a wildcard. The API is plain HTTP and relies on the mesh for encryption.";
      };
      port = mkOption {
        type = types.port;
        default = 8091;
        description = "TCP port the API listens on.";
      };
      openFirewall = mkOption {
        type = types.bool;
        default = false;
        description = "Accept the API port on firewall.interface, from any address. A request still needs a client's token.";
      };
      clients = mkOption {
        default = { };
        description = "The API's clients, by name. A token file is loaded with LoadCredential as api-NAME. No client means no API.";
        example = lib.literalExpression ''
          {
            devbox-agents = { tokenFile = "/run/secrets/workbench-api-devbox"; scopes = [ "events" ]; host = "devbox"; address = "192.0.2.2"; };
            owner = { tokenFile = "/run/secrets/workbench-api-owner"; scopes = [ "read" "control" ]; };
          }
        '';
        type = types.attrsOf (
          types.submodule {
            options = {
              tokenFile = mkOption {
                type = types.str;
                description = "Root-readable file holding the client's token: 64 lowercase hex characters.";
              };
              scopes = mkOption {
                type = types.nonEmptyListOf (
                  types.enum [
                    "events"
                    "read"
                    "control"
                  ]
                );
                description = "events: send session events. read: every GET. control: start, prompt, answer and end sessions, permission requests included.";
              };
              host = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "The host name this client's events are filed under. Required with the events scope.";
              };
              address = mkOption {
                type = types.nullOr types.str;
                default = null;
                example = "192.0.2.7";
                description = "The only peer address the token is accepted from; null accepts it from any.";
              };
            };
          }
        );
      };
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
        assertion = !workerEnabled || distinctWorker;
        message = "services.workbench.agentUser must differ from root and services.workbench.user.";
      }
      {
        assertion = !workerEnabled || cfg.gitPackage != null;
        message = "services.workbench.agentUser requires gitPackage for its private clones.";
      }
      {
        assertion =
          !distinctWorker
          || (
            let
              u = config.users.users.${worker};
              g = config.users.groups.${worker};
            in
            u.name == worker
            && u.isSystemUser
            && !u.isNormalUser
            && u.createHome
            && u.home == workerHome
            && !(lib.hasPrefix "${lib.removeSuffix "/" (toString home)}/" "${workerHome}/")
            && !(lib.hasPrefix "${workerHome}/" "${home}/")
            && lib.elem u.homeMode [ "700" "0700" ]
            && u.uid != 0
            && (u.uid == null || u.uid != userCfg.uid)
            && u.group == worker
            && u.extraGroups == [ ]
            && lib.all (group: !lib.elem worker group.members) (lib.attrValues config.users.groups)
            && g.name == worker
            && !builtins.hasAttr worker config.ids.gids
            && (g.gid == null || !(lib.elem g.gid (lib.attrValues config.ids.gids)))
            && g.members == [ ]
            && lib.all (other: other.name == worker || other.group != worker) (lib.attrValues config.users.users)
          );
        message = "services.workbench.agentUser requires its own unprivileged account and group, with no supplementary groups.";
      }
      {
        assertion =
          let
            # extra-trusted-users is free-form in nix.settings, so it may also be a
            # single whitespace-separated string.
            entries =
              (config.nix.settings.trusted-users or [ ])
              ++ lib.toList (config.nix.settings.extra-trusted-users or [ ]);
            names = lib.filter builtins.isString (
              builtins.split "[[:space:]]+" (lib.concatStringsSep " " entries)
            );
          in
          !distinctWorker || lib.intersectLists [ worker "@${worker}" "*" ] names == [ ];
        message = "services.workbench.agentUser must not be a trusted Nix user, directly or through its group.";
      }
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
        assertion =
          cfg.worktreeRoot == null
          || (
            lib.hasPrefix "/" cfg.worktreeRoot
            && lib.all (part: !(lib.elem part [ "." ".." ".git" ])) (lib.splitString "/" cfg.worktreeRoot)
          );
        message = "services.workbench.worktreeRoot must be an absolute path without components named ., .. or .git.";
      }
      {
        assertion = lib.all isName (lib.attrNames cfg.agents);
        message = "services.workbench.agents: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        assertion = lib.all (n: isHostName n && n != cfg.host) (lib.attrNames cfg.hosts);
        message = "services.workbench.hosts: names must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and differ from host.";
      }
      {
        assertion = lib.all (
          h: lib.hasPrefix "/" (lib.head h.argv) && lib.all isName (lib.attrNames h.agents)
        ) (lib.attrValues cfg.hosts);
        message = "services.workbench.hosts.<name>: argv[0] must be absolute and agent names must match ^[a-z0-9-]{1,32}$.";
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
        assertion = lib.all isName (lib.attrNames cfg.api.clients);
        message = "services.workbench.api.clients: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        assertion =
          cfg.api.clients == { } || (isIPv4 cfg.api.listenAddress && cfg.api.listenAddress != "0.0.0.0");
        message = "services.workbench.api.listenAddress must be a non-wildcard IPv4 literal.";
      }
      {
        assertion =
          cfg.api.clients == { } || cfg.api.listenAddress != cfg.listenAddress || cfg.api.port != cfg.port;
        message = "services.workbench.api must not listen where the browser's listener does.";
      }
      {
        assertion = lib.all (c: c.host != null || !lib.elem "events" c.scopes) (
          lib.attrValues cfg.api.clients
        );
        message = "services.workbench.api.clients.*: the events scope needs a host.";
      }
      {
        assertion = !cfg.api.openFirewall || (cfg.firewall.enable && cfg.firewall.interface != null);
        message = "services.workbench.api.openFirewall needs firewall.enable and firewall.interface.";
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

    users.users = lib.optionalAttrs distinctWorker {
      ${worker} = {
        isSystemUser = true;
        description = "Workbench local ACP worker";
        group = worker;
        home = workerHome;
        createHome = true;
        homeMode = "700";
      };
    };
    users.groups = lib.optionalAttrs distinctWorker { ${worker} = { }; };

    environment.etc = {
      "workbench/hub.json".source = hubJson;
      "workbench/web.json".source = webJson;
    }
    // lib.optionalAttrs workerEnabled {
      "workbench/worker.json".source = workerJson;
    }
    // lib.optionalAttrs (cfg.gitPackage != null) {
      "workbench/bin/git".source = lib.getExe' cfg.gitPackage "git";
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
      ++ map (d: "d ${d} 0700 ${cfg.user} ${userCfg.group} -") readOnlyUserPaths
      ++ lib.optional workerEnabled "d ${workerRoot} 0700 ${worker} ${worker} -";

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

    systemd.sockets.workbench-worker = mkIf workerEnabled {
      description = "Workbench local agent worker socket";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = workerSocket;
        Accept = true;
        # systemd owns the parent; only the hub UID (not everyone in its primary group) may connect.
        DirectoryMode = "0755";
        SocketUser = cfg.user;
        SocketMode = "0600";
        RemoveOnStop = true;
      };
    };

    systemd.services."workbench-worker@" = mkIf workerEnabled {
      description = "Workbench local agent worker";
      # A rejected request must not leave a permanently failed instance in PID 1.
      unitConfig.CollectMode = "inactive-or-failed";
      serviceConfig = {
        Type = "exec";
        ExecStart = "${pkgs.python3}/bin/python3 -I ${workerSources}/worker.py /etc/workbench/worker.json";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        User = worker;
        Group = worker;
        Slice = "workbench.slice";
        UMask = "0077";
        KillMode = "control-group";
        TimeoutStopSec = 2;
        # The launcher is PID 1 in a namespace per connection: neither this agent nor
        # another instance sharing its UID can SIGSTOP the hangup monitor.
        PrivatePIDs = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        # Pin the home, whose parent is root-owned. Never resolve the worker-writable
        # child "work" as root; the launcher and checkout code open it without following links.
        ReadWritePaths = [ workerHome ];
        InaccessiblePaths = [ "-${home}" ];
        # Mask the parent, not today's secret directories or symlink targets:
        # credential providers can create or replace either after this instance starts.
        TemporaryFileSystem = [ "/run:ro" ];
        BindReadOnlyPaths = [
          "/run/current-system"
          "-/etc/resolv.conf"
        ];
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

    systemd.services.workbench-hub = {
      description = "Workbench hub (PTYs and ACP agents)";
      wantedBy = [ "multi-user.target" ];
      wants = lib.optional workerEnabled "workbench-worker.socket";
      after = lib.optional workerEnabled "workbench-worker.socket";
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
        LoadCredential = [ "proxy-secret:${cfg.proxySecretFile}" ] ++ mediaCredentials ++ apiCredentials;
        Restart = "always";
        RestartSec = 2;
        OOMScoreAdjust = 100;

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        # Boards, notes, state and /api/mv; the read-only paths below take precedence inside it.
        ReadWritePaths = [ home ];
        ReadOnlyPaths = readOnlyUserPaths;
        # Metadata for worker sessions comes from the hub, never from the
        # worker's filesystem, including PTY cwd aliases into that home.
        InaccessiblePaths = lib.optional workerEnabled workerHome;
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

    networking.firewall.extraCommands = mkIf cfg.firewall.enable (
      ''
        iptables -A nixos-fw -i ${lib.escapeShellArg cfg.firewall.interface} -s ${lib.escapeShellArg cfg.trustedProxy} -d ${lib.escapeShellArg cfg.listenAddress} -p tcp --dport ${toString cfg.port} -j nixos-fw-accept
      ''
      + lib.optionalString (cfg.api.openFirewall && cfg.api.clients != { }) ''
        iptables -A nixos-fw -i ${lib.escapeShellArg cfg.firewall.interface} -d ${lib.escapeShellArg cfg.api.listenAddress} -p tcp --dport ${toString cfg.api.port} -j nixos-fw-accept
      ''
    );
  };
}
