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
        version = "0.3.0";
        src = ./.;

        npmDepsHash = "sha256-VFBqnpdETvTB3yH0xQ98v7dWOfXGu0qZtNT6MRdGNwM=";

        nodejs = pkgs.nodejs_22;
        nativeBuildInputs = [pkgs.python3];

        passthru.actualApiVersion =
          (nixpkgs.lib.importJSON ./package-lock.json)
          .packages."node_modules/@actual-app/api".version;

        meta.mainProgram = "mail-bean";
      };
    });
  };
}
