{
  description = "X-Music — a customizable music player with a real library engine";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Pinned so the better-sqlite3 native build and the runtime agree on one ABI.
        electron = pkgs.electron_43;
        nodejs = pkgs.nodejs_22;

        # Shared libraries the Electron binary and the better-sqlite3 prebuild dlopen at runtime.
        runtimeLibs = with pkgs; [
          glib nss nspr at-spi2-atk at-spi2-core cups dbus libdrm expat
          libxkbcommon mesa alsa-lib pango cairo gtk3 gdk-pixbuf
          libx11 libxcomposite libxdamage libxext libxfixes libxrandr libxcb
          stdenv.cc.cc.lib
        ];
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "x-music";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = self;

          npmDepsHash = "sha256-hLewKQSDy6L5YU90gWnAtq8k2803ouiNvaMe9o6IF5A=";
          inherit nodejs;

          nativeBuildInputs = with pkgs; [ makeWrapper copyDesktopItems autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];

          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

          # The postinstall electron-rebuild needs the network, and better-sqlite3 ships N-API prebuilds Electron can load.
          npmRebuildFlags = [ "--ignore-scripts" ];

          buildPhase = ''
            runHook preBuild
            npx electron-vite build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            npm prune --omit=dev --ignore-scripts
            # Only the host platform's prebuild can be patched to find libstdc++.
            find node_modules/better-sqlite3/prebuilds -name "*.node" ! -name "linux-${pkgs.stdenv.hostPlatform.node.arch}.node" -delete
            mkdir -p $out/lib/x-music
            cp -r out package.json node_modules $out/lib/x-music/
            makeWrapper ${electron}/bin/electron $out/bin/x-music \
              --add-flags $out/lib/x-music \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.mpv ]} \
              --set-default X_MUSIC_ALLOW_WRITES 1 \
              --unset ELECTRON_RUN_AS_NODE
            runHook postInstall
          '';

          desktopItems = [
            (pkgs.makeDesktopItem {
              name = "x-music";
              desktopName = "X-Music";
              comment = "Music player";
              exec = "x-music %U";
              icon = "audio-x-generic";
              categories = [ "Audio" "AudioVideo" "Player" ];
            })
          ];

          meta.mainProgram = "x-music";
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            electron
            mpv                 # playback engine (§8.1)
            sqlite              # sqlite3 CLI for inspecting the library database
            python3             # node-gyp dependency for native module builds
            pkg-config
            gcc
            gnumake
          ] ++ runtimeLibs;

          shellHook = ''
            # VSCode's integrated terminal exports this, which makes the Electron
            # binary run as bare node and die on the ESM main. Always clear it.
            unset ELECTRON_RUN_AS_NODE

            # Use the nixpkgs Electron; the npm-downloaded binary is not patchelf'd
            # and cannot run on NixOS.
            export ELECTRON_SKIP_BINARY_DOWNLOAD=1
            export ELECTRON_OVERRIDE_DIST_PATH="${electron}/libexec/electron"
            export ELECTRON_EXEC="${electron}/bin/electron"

            # node-gyp builds better-sqlite3 against Electron's headers, not Node's.
            export npm_config_runtime=electron
            export npm_config_target="${electron.version}"
            export npm_config_disturl=https://electronjs.org/headers
            export npm_config_build_from_source=true

            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath runtimeLibs}:$LD_LIBRARY_PATH"

            echo "x-music dev shell · node $(node -v) · electron ${electron.version} · mpv $(mpv --version | head -1 | cut -d' ' -f2)"
          '';
        };
      });
}
