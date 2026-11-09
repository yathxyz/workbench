# The web root: web/ with its TypeScript stripped to JavaScript (tools/strip.mts), the vendored xterm bundle,
# pdf.js under vendor/pdfjs/, and the fonts, converted to woff2 from nixpkgs at build time with a generated
# fonts/fonts.css. No font file lives in the repo. Text files get a gzip sibling (see the end). Edwin's console
# and frame runtime are not here: wb-web serves the host's edwin-web at /edwin/ (web.json edwinWebRoot), from
# the Edwin whose edwind it talks to.
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
  cp -r pdfjs/package/cmaps $out/vendor/pdfjs/cmaps   # Adobe CMaps for CJK fonts that name one (getDocument's cMapUrl)
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

  # Each text file over 1 KiB also as <file>.gz, which wb-web sends to clients that accept gzip (3.3 of 4.6 MB
  # saved). Fonts, images and the binary CMaps are compressed already.
  chmod -R u+w $out
  find $out -type f -size +1k \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.json' \
    -o -name '*.map' -o -name '*.svg' -o -name '*.scm' -o -name '*.txt' -o -name '*.md' -o -name '*.wasm' \) \
    -exec gzip -9 -n -k {} +
''
