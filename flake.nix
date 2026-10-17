{
  description = "Workbench: a browser canvas over PTYs and ACP agents";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      edwind = pkgs.callPackage ./nix/edwind.nix { };
      workbench = pkgs.callPackage ./nix/package.nix { inherit edwind; };
      # Edwin on the desktop: edwin (terminal and window), edwin --daemon and edwind (nix/edwin.nix).
      edwin = pkgs.callPackage ./nix/edwin.nix { inherit edwind; };
      vendor = pkgs.callPackage ./nix/vendor.nix { };
      workbench-web = pkgs.callPackage ./nix/web.nix { inherit vendor; };
      # What a release profile holds (N-12): the binaries, the web root and the commit they came from.
      release = pkgs.runCommand "workbench-release" { } ''
        mkdir $out
        ln -s ${workbench}/bin $out/bin
        ln -s ${workbench-web} $out/web
        echo ${self.rev or self.dirtyRev or "unknown"} > $out/rev
        echo ${toString self.lastModified} > $out/lastModified
      '';
    in
    {
      packages.${system} = {
        default = workbench;
        inherit
          workbench
          workbench-web
          vendor
          release
          edwin
          edwind
          ;
        # The scripted ACP agent the VM, ui and conformance checks register as `stub`.
        fake-acp = workbench.fake;
      };

      # nix run .#edwin -- FILE (-g for a window, --daemon for the user's edwind); nix run .#edwind -- --config F.
      apps.${system} = {
        edwin = {
          type = "app";
          program = "${edwin}/bin/edwin";
        };
        edwind = {
          type = "app";
          program = "${edwind}/bin/edwind";
        };
      };

      # lib.adapterCheck { pkgs, agents }: a check that runs real ACP adapters against a real
      # wb-hub, offline and initialize-only (nix/adapter-check.nix). For the consumer's flake.
      lib.adapterCheck = import ./nix/adapter-check.nix;

      nixosModules.workbench = import ./nix/module.nix self;
      nixosModules.default = self.nixosModules.workbench;
      # programs.edwin: the edwin package, edwind as a user service, EDITOR=edwin (nix/edwin-module.nix).
      nixosModules.edwin = import ./nix/edwin-module.nix self;

      checks.${system} = import ./nix/checks.nix {
        inherit
          pkgs
          self
          workbench
          workbench-web
          ;
      };

      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ workbench ];
        packages = with pkgs; [
          clippy
          rustfmt
          rust-analyzer
          esbuild
          nodejs
          python3
          caddy
        ];
      };
    };
}
