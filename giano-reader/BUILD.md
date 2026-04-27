# Build & Development

## Requirements

- [Node.js](https://nodejs.org/) >= 18
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

## Production build

```bash
npm run tauri build
```

Outputs the installable package to `src-tauri/target/release/bundle/`.

---

## Clearing the Cargo cache

Cargo stores absolute paths in its cache. If you move or rename the project's parent folder, the build will fail with path-not-found errors. Clean the cache before rebuilding:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
npm run tauri build
```
