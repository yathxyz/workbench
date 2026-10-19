{
  description = "Workbench: a browser canvas over PTYs and ACP agents";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  # Edwin: edwind, the text daemon, and the frame runtime the page serves at /edwin/.
  inputs.edwin = {
    url = "github:yathxyz/edwin";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      edwin,
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (edwin.packages.${system}) edwind edwin-web;
      workbench = pkgs.callPackage ./nix/package.nix { inherit edwind; };
      vendor = pkgs.callPackage ./nix/vendor.nix { };
      workbench-web = pkgs.callPackage ./nix/web.nix { inherit vendor edwin-web; };
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
          ;
        # The scripted ACP agent the VM, ui and conformance checks register as `stub`.
        fake-acp = workbench.fake;
      };

      # lib.adapterCheck { pkgs, agents }: a check that runs real ACP adapters against a real
      # wb-hub, offline and initialize-only (nix/adapter-check.nix). For the consumer's flake.
      lib.adapterCheck = args: import ./nix/adapter-check.nix ({ inherit edwind; } // args);

      nixosModules.workbench = import ./nix/module.nix self;
      nixosModules.default = self.nixosModules.workbench;

      # Edwin's own checks come along, so a release gate over these names still proves the pinned edwin.
      checks.${system} =
        edwin.checks.${system}
        // import ./nix/checks.nix {
          inherit
            pkgs
            self
            edwin
            workbench
            workbench-web
            ;
        };

      # edwind on PATH for tests/harness.py, and WB_EDWIND_MAIN for wb-cli's tests. Against a local edwin
      # checkout: nix develop --override-input edwin git+file:///path/to/edwin.
      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ workbench ];
        WB_EDWIND_MAIN = "${edwind}/share/edwin/server/main.mts";
        packages = with pkgs; [
          edwind
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
