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
