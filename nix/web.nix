# The web root: web/ with its TypeScript stripped to JavaScript (tools/strip.mts), the vendored xterm bundle,
# pdf.js under vendor/pdfjs/, the Edwin console and frame runtime under edwin/, and the fonts, converted to
# woff2 from nixpkgs at build time with a generated fonts/fonts.css. No font file lives in the repo.
{
  lib,
  runCommand,
  fetchurl,
  nodejs,
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
  # Served at /edwin/ (edwind spec R9.19): the console page as /edwin/ (wb-web aliases a directory to
  # its index.html), the 13 core files under src/ and the Scheme sources under scm/, which the frame
  # runtime fetches as text/plain. The console page is edwin/console/index.html; until that file
  # exists the standalone edwin/index.html stands in for it.
  console =
    if builtins.pathExists ../edwin/console/index.html then
      ../edwin/console/index.html
    else
      ../edwin/index.html;
  edwinSrc = lib.fileset.toSource {
    root = ../edwin/src;
    fileset = lib.fileset.fileFilter (f: f.hasExt "ts" && !lib.hasSuffix ".d.ts" f.name) ../edwin/src;
  };
  edwinScm = lib.fileset.toSource {
    root = ../edwin/scm;
    fileset = lib.fileset.fileFilter (f: f.hasExt "scm") ../edwin/scm;
  };
  # pdf.js for the pdf card (F-A40), which loads it only when a card mounts. Pinned here rather than in tools/'s
  # npm lock, where the package's optional @napi-rs/canvas binaries would come along for nothing. Keep it current:
  # it parses untrusted files in the page's origin (CVE-2024-4367 was a font that ran script).
  # The legacy build: the modern one needs Map.prototype.getOrInsertComputed, which browsers from 2025 lack.
  pdfjs = fetchurl {
    url = "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz";
    hash = "sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==";
  };
  mono = "${nerd-fonts.jetbrains-mono}/share/fonts/truetype/NerdFonts/JetBrainsMono";
  noto = "${noto-fonts}/share/fonts/noto";
in
runCommand "workbench-web" { nativeBuildInputs = [ nodejs woff2 ]; } ''
  node ${../tools/strip.mts} --web ${web} $out
  chmod -R u+w $out
  install -Dm444 -t $out/vendor ${vendor}/vendor.js ${vendor}/xterm.css
  mkdir pdfjs && tar xzf ${pdfjs} -C pdfjs
  install -Dm444 -t $out/vendor/pdfjs pdfjs/package/legacy/build/pdf.min.mjs pdfjs/package/legacy/build/pdf.worker.min.mjs pdfjs/package/LICENSE
  install -Dm444 ${console} $out/edwin/index.html
  node ${../tools/strip.mts} $out/edwin/src ${edwinSrc}/*.ts
  install -Dm444 -t $out/edwin/scm ${edwinScm}/*.scm

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
