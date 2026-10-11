# vendor.js (global `V`) and xterm.css, bundled from the pinned npm lock in tools/.
# Install scripts never run, and the bundler is nixpkgs esbuild, built from source.
{
  lib,
  stdenv,
  nodejs,
  esbuild,
  importNpmLock,
}:
stdenv.mkDerivation {
  pname = "workbench-vendor";
  version = (lib.importJSON ../tools/package.json).version;

  src = lib.fileset.toSource {
    root = ../tools;
    fileset = lib.fileset.unions [
      ../tools/package.json
      ../tools/package-lock.json
      ../tools/vendor-entry.js
    ];
  };

  npmDeps = importNpmLock {
    package = lib.importJSON ../tools/package.json;
    packageLock = lib.importJSON ../tools/package-lock.json;
  };
  npmFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    esbuild
  ];

  buildPhase = ''
    runHook preBuild
    esbuild vendor-entry.js --bundle --minify --format=iife --global-name=V --outfile=vendor.js
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm444 vendor.js $out/vendor.js
    install -Dm444 node_modules/@xterm/xterm/css/xterm.css $out/xterm.css
    runHook postInstall
  '';
}
