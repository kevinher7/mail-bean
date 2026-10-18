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

        npmDepsHash = "sha256-fiQY8Yw9Q9V4dRMewNOg4rT1mHK1ZncYfUxRC+2snp4=";

        nodejs = pkgs.nodejs_22;
        nativeBuildInputs = [pkgs.python3];

        meta.mainProgram = "mail-bean";
      };
    });
  };
}
