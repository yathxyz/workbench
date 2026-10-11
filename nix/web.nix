# webRoot: the SPA in web/ plus the built vendor bundle.
{
  lib,
  runCommand,
  vendor,
}:
let
  web = lib.fileset.toSource {
    root = ../web;
    fileset = lib.fileset.difference ../web (lib.fileset.maybeMissing ../web/vendor);
  };
in
runCommand "workbench-web" { } ''
  cp -r ${web} $out
  chmod -R u+w $out
  install -Dm444 -t $out/vendor ${vendor}/vendor.js ${vendor}/xterm.css
''
