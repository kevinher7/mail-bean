{
  description = "E-mail extractor for Actual Budget";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    forAllSystems = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.buildNpmPackage {
        pname = "mail-bean";
        version = "0.2.0";
        src = ./.;

        npmDepsHash = "sha256-pnoHlxPeUYj6rt4m4m6nwYHRTdKXOzoJazaADdQtYrs=";

        nodejs = pkgs.nodejs_22;
        nativeBuildInputs = [pkgs.python3];

        meta.mainProgram = "mail-bean";
      };
    });
  };
}
