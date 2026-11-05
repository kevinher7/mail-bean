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
        version = "0.1.1";
        src = ./.;

        npmDepsHash = "sha256-ZBJfDeMl1M1bl9P64e62J87/UHUzqeEaKyh1PTmRlh8=";

        nodejs = pkgs.nodejs_22;
        nativeBuildInputs = [pkgs.python3];

        meta.mainProgram = "mail-bean";
      };
    });
  };
}
