# The web root: web/ as committed, the vendored xterm bundle, and the fonts, converted to woff2
# from nixpkgs at build time with a generated fonts/fonts.css. No font file lives in the repo.
{
  lib,
  runCommand,
  vendor,
  nerd-fonts,
  noto-fonts,
  woff2,
}:
let
  web = lib.fileset.toSource {
    root = ../web;
    fileset = lib.fileset.difference ../web (lib.fileset.maybeMissing ../web/vendor);
  };
  mono = "${nerd-fonts.jetbrains-mono}/share/fonts/truetype/NerdFonts/JetBrainsMono";
  noto = "${noto-fonts}/share/fonts/noto";
in
runCommand "workbench-web" { nativeBuildInputs = [ woff2 ]; } ''
  cp -r ${web} $out
  chmod -R u+w $out
  install -Dm444 -t $out/vendor ${vendor}/vendor.js ${vendor}/xterm.css

  mkdir fonts
  cp ${mono}/JetBrainsMonoNerdFontMono-{Regular,Bold}.ttf ${noto}/NotoSans{,-Italic}.ttf fonts/
  chmod u+w fonts/*
  for f in fonts/*.ttf; do woff2_compress "$f"; done
  install -Dm444 -t $out/fonts fonts/*.woff2

  # Noto Sans is a variable font: one file per style covers every weight.
  cat > $out/fonts/fonts.css <<'EOF'
  @font-face {
    font-family: "JetBrainsMono Nerd Font Mono";
    src: url("JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "JetBrainsMono Nerd Font Mono";
    src: url("JetBrainsMonoNerdFontMono-Bold.woff2") format("woff2");
    font-weight: 700;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Noto Sans";
    src: url("NotoSans.woff2") format("woff2");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "Noto Sans";
    src: url("NotoSans-Italic.woff2") format("woff2");
    font-weight: 100 900;
    font-style: italic;
    font-display: swap;
  }
  EOF
  chmod 444 $out/fonts/fonts.css
''
