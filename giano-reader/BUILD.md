# Build & Sviluppo

## Requisiti

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/tools/install) (toolchain stabile)
- [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) per il tuo sistema operativo

Su Windows assicurati di avere installato:
- Microsoft Visual Studio C++ Build Tools
- WebView2 Runtime (incluso in Windows 11, scaricabile per Windows 10)

---

## Installazione

```bash
git clone https://github.com/DrLoki/GianoReader.git
cd giano-reader
npm install
```

---

## Avvio in sviluppo

```bash
npm run tauri dev
```

Apre l'app in modalità sviluppo con hot-reload e DevTools abilitati.

---

## Build

```bash
npm run tauri build
```

Genera il pacchetto installabile nella cartella `src-tauri/target/release/bundle/`.

---

## Pulizia cache (necessaria dopo aver rinominato/spostato la cartella del progetto)

Cargo memorizza i path assoluti nella cache. Se sposti o rinomini la cartella padre del progetto, la build fallirà con errori di path non trovato. Pulisci la cache prima di ricompilare:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
npm run tauri build
```
