{
  inputs = {
    nixpkgs_.url = "github:deemp/flakes?dir=source-flake/nixpkgs";
    nixpkgs.follows = "nixpkgs_/nixpkgs";
    flake-utils_.url = "github:deemp/flakes?dir=source-flake/flake-utils";
    flake-utils.follows = "flake-utils_/flake-utils";
    devshell.url = "github:deemp/flakes?dir=devshell";
  };
  outputs = inputs: inputs.flake-utils.lib.eachDefaultSystem
    (system:
      let
        pkgs = inputs.nixpkgs.legacyPackages.${system};
        inherit (inputs.devshell.lib.${system}) mkCommands mkRunCommands mkRunCommandsDir mkShell;

        tools = [ pkgs.nodejs_18 ];

        devShells.default = mkShell {
          packages = tools;
          bash.extra = "export NODE_OPTIONS=--openssl-legacy-provider";
          commands =
            mkCommands "tools" tools ++
            [
              { name = "init"; command = "${pkgs.nodejs_18}/bin/npm i"; help = "install dependencies"; }
              { name = "build"; command = "NODE_OPTIONS=--openssl-legacy-provider ${pkgs.nodejs_18}/bin/npm run build"; help = "build project"; }
            ];
        };
      in
      {
        inherit devShells;
      });
}
