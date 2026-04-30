# Build & Development

## Requirements

- [Node.js](https://nodejs.org/) >= 22 (version used in development: 22.2.0)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) for your operating system

On Windows, make sure you have installed:
- Microsoft Visual Studio C++ Build Tools
- WebView2 Runtime (included in Windows 11, downloadable for Windows 10)

---

## Setup

```bash
git clone https://github.com/DrLoki/GianoReader.git
cd giano-reader
npm install
```

---

## Development

```bash
npm run tauri dev
```

Launches the app in development mode with hot-reload and DevTools enabled.

---

## Frontend only (no Tauri shell)

```bash
npm run dev    # Vite dev server on port 1420
npm run build  # Vite build → dist/
```

Useful for rapid UI iteration. File open/save dialogs and filesystem access will fall back to browser APIs (`<input type="file">` and `<a download>`).

---

## Production build

```bash
npm run tauri build
```

Outputs the installable package to `src-tauri/target/release/bundle/`.

Release profile settings (defined in `Cargo.toml`):
- LTO enabled
- `opt-level = "s"` (size optimisation)
- `strip = true`
- `panic = "abort"`

---

## Running tests

```bash
npm test
```

Runs the Vitest test suite (single-run, no watch mode). Tests live in `src/library.test.js`.

---

## Release builds (all platforms)

Each installer format must be compiled on its native OS:

| Output | Built on |
|---|---|
| `.msi` + NSIS `.exe` | Windows |
| `.dmg` + `.app` (universal) | macOS |
| `.deb` + `.AppImage` | Linux |

### Automated via GitHub Actions

The repository includes `.github/workflows/release.yml`. Push a version tag to trigger a full multi-platform build and draft release:

```bash
git tag v0.7.2
git push origin v0.7.2
```

GitHub Actions will:
1. Build on `windows-latest`, `macos-latest`, and `ubuntu-22.04` in parallel.
2. Produce a universal macOS binary (Intel + Apple Silicon).
3. Create a **draft** GitHub Release with all installers attached.

Review the draft at `https://github.com/<owner>/<repo>/releases` and publish when ready.

### Manual build on each platform

```bash
# Run this on the target OS
cd giano-reader
npm run tauri build
```

Outputs land in `src-tauri/target/release/bundle/`.

### macOS code signing (optional)

To distribute outside the Mac App Store without Gatekeeper warnings, add these secrets to your GitHub repository (`Settings → Secrets → Actions`):

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` export of your Developer ID certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` file |
| `APPLE_SIGNING_IDENTITY` | Certificate name (e.g. `Developer ID Application: Your Name (TEAMID)`) |
| `APPLE_ID` | Apple ID email used for notarisation |
| `APPLE_PASSWORD` | App-specific password for the Apple ID |
| `APPLE_TEAM_ID` | 10-character Apple Team ID |

Then uncomment the corresponding `env:` lines in `release.yml`.

---

## Clearing the Cargo cache

Cargo stores absolute paths in its cache. If you move or rename the project's parent folder, the build will fail with path-not-found errors. Clean the cache before rebuilding:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

---

## Build targets

| Target | Value |
|---|---|
| ES target | `es2021` |
| Browser targets | `chrome105`, `safari13` |
| Minification | Disabled when `TAURI_DEBUG` is set |
| Source maps | Enabled in debug builds |
