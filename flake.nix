{
  description = "Workbench: a browser canvas over PTYs and ACP agents";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      workbench = pkgs.callPackage ./nix/package.nix { };
      vendor = pkgs.callPackage ./nix/vendor.nix { };
      workbench-web = pkgs.callPackage ./nix/web.nix { inherit vendor; };
    in
    {
      packages.${system} = {
        default = workbench;
        inherit workbench workbench-web vendor;
        # The scripted ACP agent the VM, ui and conformance checks register as `stub`.
        fake-acp = workbench.fake;
      };

      # lib.adapterCheck { pkgs, agents }: a check that runs real ACP adapters against a real
      # wb-hub, offline and initialize-only (nix/adapter-check.nix). For the consumer's flake.
      lib.adapterCheck = import ./nix/adapter-check.nix;

      nixosModules.workbench = import ./nix/module.nix self;
      nixosModules.default = self.nixosModules.workbench;

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
