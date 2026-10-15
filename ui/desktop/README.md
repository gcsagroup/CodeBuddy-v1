# goose Desktop App

Native desktop app for goose built with [Electron](https://www.electronjs.org/) and [ReactJS](https://react.dev/). 

# Building and running
goose uses [Hermit](https://github.com/cashapp/hermit) to manage dependencies, so you will need to have it installed and activated.

```
git clone git@github.com:aaif-goose/goose.git
cd goose
source ./bin/activate-hermit
cd ui/desktop
pnpm install
pnpm run start
```

## Platform-specific build requirements

### Linux
For building on Linux distributions, you'll need additional system dependencies:

**Debian/Ubuntu:**
```bash
sudo apt install dpkg fakeroot
```

**Arch/Manjaro:**
```bash
sudo pacman -S dpkg fakeroot
```

**Fedora/RHEL:**
```bash
sudo dnf install dpkg-dev fakeroot
```

# Building notes

This is an Electron Forge app using Vite and React. The desktop app launches the bundled `goose` CLI binary and talks to its ACP server.

## Building for different platforms

### macOS

Use `pnpm run bundle:mac` on a native arm64 or x64 Mac. See the build, signing,
system dependency and acceptance guides:
[繁體中文 (default)](../../documentation/codebuddy/MACOS_ZH_TW.md) ·
[简体中文](../../documentation/codebuddy/MACOS_ZH_CN.md) ·
[English](../../documentation/codebuddy/MACOS_EN.md).

Mac builds and real-device acceptance are pending; Windows checks do not establish macOS support.

### Linux
For Linux builds, first ensure you have the required system dependencies installed (see above), then:

1. Build the Rust binary:
```bash
cd ../..  # Go to project root
cargo build --release -p goose-cli --bin goose
```

2. Copy the binary to the expected location:
```bash
mkdir -p src/bin
cp ../../target/release/goose src/bin/
```

3. Build the application:
```bash
# For ZIP distribution (works on all Linux distributions)
pnpm run make --targets=@electron-forge/maker-zip

# For DEB package (Debian/Ubuntu)
pnpm run make --targets=@electron-forge/maker-deb

# For Flatpak (requires flatpak and flatpak-builder)
pnpm run make --targets=@electron-forge/maker-flatpak
```

The built application will be available in:
- ZIP: `out/make/zip/linux/x64/goose-linux-x64-{version}.zip`
- DEB: `out/make/deb/x64/goose_{version}_amd64.deb`
- Flatpak: `out/make/flatpak/x86_64/*.flatpak`
- Executable: `out/goose-linux-x64/goose`

### Windows
Use the existing Windows build process as documented.


# Running with an external ACP backend

From the project root, start the ACP backend:

```bash
GOOSE_SERVER__SECRET_KEY=test cargo run -p goose-cli --bin goose -- serve --platform desktop --host 127.0.0.1 --port 3000
```

Then start the desktop app from `ui/desktop`:

```bash
GOOSE_EXTERNAL_BACKEND=true GOOSE_EXTERNAL_BACKEND_URL=http://127.0.0.1:3000 GOOSE_SERVER__SECRET_KEY=test pnpm run start-gui
```
