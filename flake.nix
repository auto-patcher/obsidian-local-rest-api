{
  description = "Obsidian Local REST API - REST API and MCP server for Obsidian";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    (
      if builtins.pathExists ./settings.nix then
        { lib.settingsModule = import ./settings.nix; }
      else
        { lib.settingsModule = { }; }
    )
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        node = pkgs.nodejs_22;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            node
            pkgs.git
          ];

          shellHook = ''
            echo "Obsidian Local REST API dev environment loaded"
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
          '';
        };

        packages.default = pkgs.stdenv.mkDerivation {
          name = "obsidian-local-rest-api";
          src = ./.;

          buildInputs = [
            node
            pkgs.git
          ];

          buildPhase = ''
            npm ci
            npm run typecheck
            npm run build
            npm run build-docs
          '';

          installPhase = ''
            mkdir -p $out/lib
            cp main.js $out/lib/
            cp main.css $out/lib/
            cp manifest.json $out/lib/
            mkdir -p $out/docs
            cp docs/openapi.yaml $out/docs/
          '';

          meta = {
            description = "Obsidian Local REST API - REST API and MCP server for Obsidian";
            longDescription = ''
              A secure REST API and Model Context Protocol (MCP) server for Obsidian.
              Provides full CRUD operations, surgical patching, search, and command execution.
            '';
            homepage = "https://github.com/coddingtonbear/obsidian-local-rest-api";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };

        formatter = pkgs.nixfmt;
      }
    );
}
