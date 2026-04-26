# 🎭 Giano Reader

Applicazione desktop per leggere ebook in formato **EPUB** e **MOBI/AZW** con traduzione integrata tramite Google Translate. Costruita con [Tauri 2](https://tauri.app/) + Vite + JavaScript vanilla.

---

## Funzionalità

- Apertura file EPUB, MOBI, AZW, AZW3
- Visualizzazione indice (TOC) navigabile
- Navigazione capitoli (avanti/indietro)
- Tacche capitoli sulla barra di avanzamento con tooltip al passaggio del mouse
- Traduzione del capitolo corrente in 10 lingue con vista affiancata (originale + traduzione) e scroll sincronizzato
- Dark mode
- Zoom testo (A+ / A-)
- Visualizzazione copertina e metadati del libro

## Lingue di traduzione supportate

Italiano, Inglese, Francese, Tedesco, Spagnolo, Portoghese, Russo, Cinese, Giapponese, Arabo.

---

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
# Clona il repository
git clone https://github.com/tuo-utente/giano-reader.git
cd giano-reader

# Installa le dipendenze npm
npm install
```

---

## Avvio in sviluppo

```bash
cd giano-reader
npm run tauri dev
```

Apre l'app in modalità sviluppo con hot-reload e DevTools abilitati.

---

## Build

```bash
cd giano-reader
npm run tauri build
```

Genera il pacchetto installabile nella cartella `src-tauri/target/release/bundle/`.

---

## Struttura del progetto

```
giano-reader/
├── index.html              # Entry point HTML
├── package.json
├── vite.config.js          # Configurazione Vite
├── src/
│   ├── main.js             # Logica principale (reader + UI)
│   ├── translator.js       # Integrazione Google Translate
│   ├── mobi.js             # Parser MOBI/AZW
│   └── style.css
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json     # Configurazione Tauri
    └── src/
        ├── main.rs
        └── lib.rs
```

---

## Come funziona la traduzione

Viene usato l'endpoint pubblico di Google Translate (`translate.googleapis.com`) senza necessità di API key. Il testo del capitolo viene suddiviso in blocchi da ~4500 caratteri per rispettare i limiti della richiesta, tradotto in sequenza e riassemblato.

> **Nota:** L'endpoint non ufficiale è adatto a uso personale. Per un'applicazione commerciale o ad alto volume si consiglia l'[API ufficiale di Google Cloud Translation](https://cloud.google.com/translate) con chiave.

---

## Dipendenze principali

| Pacchetto | Scopo |
|---|---|
| [epubjs](https://github.com/futurepress/epub.js/) | Rendering EPUB |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | Dialogo apertura file |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | Lettura file dal filesystem |
| Vite | Build tool frontend |

---

## Licenza

MIT
