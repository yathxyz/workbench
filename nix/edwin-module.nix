# programs.edwin: Edwin on a NixOS desktop, as services.emacs is for Emacs. The edwin package on the path, and
# optionally edwind as a systemd user service (edwin --fg-daemon), so every edwin and `edwin -g` the user starts
# is a frame of the same buffers, and EDITOR=edwin.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.programs.edwin;
in
{
  options.programs.edwin = {
    enable = mkEnableOption "Edwin on the desktop (edwin, edwin -g, edwin --daemon)";
    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.edwin;
      defaultText = lib.literalExpression "workbench.packages.\${system}.edwin";
      description = "The edwin package.";
    };
    daemon = {
      enable = mkEnableOption "edwind as a systemd user service for every user, on $XDG_RUNTIME_DIR/edwin/edit.sock";
      notesDir = mkOption {
        type = types.str;
        default = "%h/notes";
        description = "The notes directory edwind serves (EDWIN_NOTES_DIR); %h is the user's home.";
      };
      memoryMiB = mkOption {
        type = types.ints.positive;
        default = 1024;
        description = "V8 heap limit for edwind (--max-old-space-size).";
      };
    };
    defaultEditor = mkOption {
      type = types.bool;
      default = false;
      description = "Set EDITOR and VISUAL to edwin (a terminal frame that attaches to the daemon when it runs).";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    environment.variables = mkIf cfg.defaultEditor {
      EDITOR = lib.mkOverride 900 "edwin";
      VISUAL = lib.mkOverride 900 "edwin";
    };
    systemd.user.services.edwind = mkIf cfg.daemon.enable {
      description = "edwind, Edwin's text daemon";
      wantedBy = [ "default.target" ];
      environment = {
        EDWIN_NOTES_DIR = cfg.daemon.notesDir;
        EDWIND_MEMORY_MIB = toString cfg.daemon.memoryMiB;
      };
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/edwin --fg-daemon";
        Restart = "on-failure";
        RestartSec = 1;
        UMask = "0077";
        # The server's worker thread sizes its own stack (32 MiB) for the Scheme cap.
        LimitSTACK = "64M";
      };
    };
  };
}
