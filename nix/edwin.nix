# edwin, Edwin on the desktop (edwin/native, DT1 and DT2): the terminal program (`edwin`, `edwin -nw`), the
# window (`edwin -g`), and the user's own daemon (`edwin --daemon`, which runs edwind through edwin-daemon), as
# Emacs ships emacs, emacs --daemon and emacsclient. Each edwin attaches to a running edwind by itself.
{
  lib,
  rustPlatform,
  fetchurl,
  writeShellScript,
  nodejs,
  makeFontsConf,
  dejavu_fonts,
  edwind,
  coreutils,
  util-linux,
  # What the window loads at run time (winit and wgpu open them with dlopen).
  libxkbcommon,
  wayland,
  vulkan-loader,
  libGL,
  libx11,
  libxcursor,
  libxrandr,
  libxi,
}:
let
  # The prebuilt V8 the v8 crate links (its build script would download it): a fixed-output fetch, so the
  # build itself stays offline. The version follows Cargo.toml's `v8 = "=130.0.1"`.
  rustyV8 = fetchurl {
    url = "https://github.com/denoland/rusty_v8/releases/download/v130.0.1/librusty_v8_release_x86_64-unknown-linux-gnu.a.gz";
    sha256 = "1f9pzbpc2bg1a0i0sknz43wypk761wx7p3mn4byvhcvph5l6m9rh";
  };
  windowLibs = [
    libxkbcommon
    wayland
    vulkan-loader
    libGL
    libx11
    libxcursor
    libxrandr
    libxi
  ];
  # edwin --daemon: edwind for this user on $XDG_RUNTIME_DIR/edwin/edit.sock, where every edwin looks first
  # after $EDWIN_SOCKET. The config is EDWIND_CONFIG when set, else one made at each start from
  # EDWIN_NOTES_DIR (~/notes): state in ~/.local/state/edwin/edwind, the user's Scheme in ~/.config/edwin.
  # In the background unless --fg (what a systemd user service runs).
  daemon = writeShellScript "edwin-daemon" ''
    set -eu
    PATH=${
      lib.makeBinPath [
        coreutils
        util-linux
      ]
    }:$PATH
    fg=; [ "''${1:-}" = --fg ] && { fg=1; shift; }
    cfg=''${EDWIND_CONFIG:-}
    if [ -z "$cfg" ]; then
      run=''${XDG_RUNTIME_DIR:?edwin --daemon needs XDG_RUNTIME_DIR (or EDWIND_CONFIG)}/edwin
      home=''${HOME:?}
      notes=''${EDWIN_NOTES_DIR:-$home/notes}
      state=''${XDG_STATE_HOME:-$home/.local/state}/edwin
      mkdir -p -m 700 "$run" "$state/edwind"
      mkdir -p "$notes"
      if [ -S "$run/edit.sock" ] && ${nodejs}/bin/node -e 'require("net").connect(process.argv[1]).on("connect", () => process.exit(0)).on("error", () => process.exit(1))' "$run/edit.sock"; then
        echo "edwin: an edwind already runs on $run/edit.sock" >&2; exit 1
      fi
      cfg=$run/edwind.json
      ${nodejs}/bin/node -e 'const [f, sock, notes, state, conf] = process.argv.slice(1);
        require("fs").writeFileSync(f, JSON.stringify({ socket: sock, notesDir: notes, stateDir: state, configDir: conf,
          refusePaths: ["~/.ssh", "~/.config/systemd", "~/.local/share/systemd"] }), { mode: 0o600 });' \
        "$cfg" "$run/edit.sock" "$(realpath "$notes")" "$state/edwind" "''${XDG_CONFIG_HOME:-$home/.config}/edwin"
    fi
    if [ -n "$fg" ]; then exec ${edwind}/bin/edwind --config "$cfg"; fi
    log=''${XDG_STATE_HOME:-''${HOME:?}/.local/state}/edwin/edwind.log
    mkdir -p "''${log%/*}"
    setsid -f ${edwind}/bin/edwind --config "$cfg" </dev/null >>"$log" 2>&1
    echo "edwin: edwind started (log: $log)" >&2
  '';
in
rustPlatform.buildRustPackage {
  pname = "edwin";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../edwin;
    # An in-tree build leaves its target/ beside the sources.
    fileset = lib.fileset.difference ../edwin (lib.fileset.maybeMissing ../edwin/native/target);
  };
  buildAndTestSubdir = "native";
  cargoRoot = "native";
  cargoLock.lockFile = ../edwin/native/Cargo.lock;

  env.RUSTY_V8_ARCHIVE = rustyV8;
  # build.rs embeds the ICU data the v8 crate carries; here the crate is in the vendored sources.
  # sources.rs embeds the core and native/js as JavaScript: each .ts stripped to the .js beside it.
  nativeBuildInputs = [ nodejs ];
  preBuild = ''
    node ${../tools/strip.mts} --in-place src native/js
    export EDWIN_ICU_DATA=$(find -L "$NIX_BUILD_TOP/cargo-vendor-dir" -path '*/v8-130.0.1/third_party/icu/flutter_desktop/icudtl.dat' | head -n1)
    test -f "$EDWIN_ICU_DATA"
  '';

  # The pseudo-terminal suite (the edwind attach test runs node on edwin/test) and the window's unit tests,
  # which skip without a GPU adapter; tests/gui.rs skips without Xvfb and xdotool.
  nativeCheckInputs = [ nodejs ];
  # The window's renders need a font (and a GPU adapter, which the sandbox lacks, so they skip after it).
  preCheck = ''
    export HOME=$TMPDIR FONTCONFIG_FILE=${makeFontsConf { fontDirectories = [ dejavu_fonts ]; }}
  '';

  postInstall = ''
    ln -s ${daemon} $out/bin/edwin-daemon
    ln -s ${edwind}/bin/edwind $out/bin/edwind
  '';
  # After the fixup's RPATH shrinking, which would drop libraries no DT_NEEDED names.
  postFixup = ''
    patchelf --add-rpath ${lib.makeLibraryPath windowLibs} $out/bin/edwin
  '';

  meta = {
    description = "Edwin on the desktop: a terminal editor and $EDITOR, a window, and a daemon its frames share";
    mainProgram = "edwin";
    platforms = [ "x86_64-linux" ];
  };
}
