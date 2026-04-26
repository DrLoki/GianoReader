# 🎭 Giano Reader

Applicazione desktop per leggere ebook in formato **EPUB** e **MOBI/AZW** con traduzione integrata tramite Google Translate. Costruita con [Tauri 2](https://tauri.app/) + Vite + JavaScript vanilla.

---

## Funzionalità

- Apertura file EPUB, MOBI, AZW, AZW3
- Visualizzazione indice (TOC) navigabile
- Navigazione capitoli (avanti/indietro) con barra di avanzamento e tacche per capitolo
- Traduzione in 10 lingue con vista affiancata (originale + traduzione) e scroll sincronizzato
- Traduzione lazy: parte dal punto di lettura corrente, espande verso il basso scorrendo
- Segnalibri con salvataggio di capitolo e posizione di scroll precisa
- Import/export segnalibri tramite file JSON
- Dark mode
- Zoom testo (A+ / A-)
- Visualizzazione copertina e metadati del libro

## Lingue di traduzione supportate

Italiano, Inglese, Francese, Tedesco, Spagnolo, Portoghese, Russo, Cinese, Giapponese, Arabo.

---

Per istruzioni su requisiti, installazione e build vedi [BUILD.md](BUILD.md).

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

Viene usato l'endpoint pubblico di Google Translate (`translate.googleapis.com`) senza necessità di API key. Il testo viene suddiviso in chunk e tradotto in modo lazy: prima il blocco visibile, poi i successivi man mano che si scorre. Quando si apre un segnalibro, la traduzione parte direttamente dalla posizione salvata.

> **Nota:** L'endpoint non ufficiale è adatto a uso personale. Per uso commerciale o ad alto volume si consiglia l'[API ufficiale di Google Cloud Translation](https://cloud.google.com/translate) con chiave.

---

## Dipendenze principali

| Pacchetto | Scopo |
|---|---|
| [epubjs](https://github.com/futurepress/epub.js/) | Rendering EPUB |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | Dialogo apertura/salvataggio file |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | Lettura/scrittura file dal filesystem |
| Vite | Build tool frontend |

---

## Licenza

MIT
