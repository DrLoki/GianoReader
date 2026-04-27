# Giano Reader

Applicazione desktop per leggere ebook in formato **EPUB** con traduzione integrata tramite Google Translate. Costruita con [Tauri 2](https://tauri.app/) + Vite + JavaScript vanilla.

---

## Funzionalità

- Apertura file EPUB
- Visualizzazione indice (TOC) navigabile
- Navigazione capitoli (avanti/indietro) con barra di avanzamento e tacche per capitolo
- Traduzione in 12 lingue con vista affiancata (originale + traduzione) e scroll sincronizzato
- Traduzione lazy: parte dal punto di lettura corrente, espande verso il basso scorrendo
- Segnalibri con salvataggio di capitolo e posizione di scroll precisa, import/export JSON
- Temi: dark (default), light, monokai, solarized-dark, nord, sepia
- Zoom testo (A+ / A-)
- Visualizzazione copertina e metadati del libro
- Supporto lingue UI con RTL (arabo)
- Icone SVG (Font Awesome 6 Free) al posto delle emoji
- Dropdown lingua con bandiere SVG (compatibile con WebView2 su Windows)

## Lingue di traduzione supportate

Italiano, Inglese, Francese, Tedesco, Spagnolo, Portoghese, Russo, Cinese, Giapponese, Arabo, Filipino, Albanese.

---

Per istruzioni su requisiti, installazione e build vedi [BUILD.md](BUILD.md).

---

## Struttura del progetto

```
giano-reader/
├── index.html              # Entry point HTML — tutto il markup UI
├── package.json
├── vite.config.js          # Vite: porta 1420, ignora src-tauri/
├── public/
│   ├── favicon.ico
│   ├── logo.png
│   ├── icons/              # Icone SVG UI (Font Awesome 6 Free, SIL OFL 1.1)
│   │   ├── gear.svg
│   │   ├── xmark.svg
│   │   ├── book-bookmark.svg
│   │   ├── star.svg
│   │   ├── arrows-left-right-to-line.svg
│   │   ├── file-image.svg
│   │   ├── upload.svg
│   │   └── download.svg
│   └── flags/              # Bandiere SVG per il dropdown lingua
│       ├── it.svg, gb.svg, fr.svg, de.svg, es.svg, pt.svg
│       ├── ru.svg, cn.svg, jp.svg, sa.svg, ph.svg, al.svg
├── src/
│   ├── main.js             # Logica principale: reader, UI, segnalibri, scroll sync
│   ├── translator.js       # Integrazione Google Translate (chunked, lazy)
│   ├── i18n.js             # Traduzioni UI (12 lingue); esporta t(lang, key, vars)
│   └── style.css           # Tutti gli stili (dark mode via body.dark)
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json     # Config finestra, CSP, bundle
    ├── capabilities/
    │   └── default.json    # Dichiarazioni capability Tauri
    └── src/
        ├── main.rs         # Entry point Tauri (chiama lib::run)
        └── lib.rs          # Registrazione plugin + DevTools in debug
```

---

## Come funziona la traduzione

Viene usato l'endpoint pubblico di Google Translate (`translate.googleapis.com`) senza necessità di API key. Il testo viene suddiviso in chunk da ~4500 caratteri e tradotto in modo lazy: prima il blocco visibile, poi i successivi man mano che si scorre. Quando si apre un segnalibro, la traduzione parte direttamente dalla posizione salvata.

> **Nota:** L'endpoint non ufficiale è adatto a uso personale. Per uso commerciale o ad alto volume si consiglia l'[API ufficiale di Google Cloud Translation](https://cloud.google.com/translate) con chiave.

---

## Icone e bandiere

Le icone UI sono file SVG da [Font Awesome 6 Free](https://fontawesome.com/license/free) (licenza SIL OFL 1.1 per i font/icone, MIT per il codice), salvati in `public/icons/`.

I dropdown di selezione lingua usano bandiere SVG custom in `public/flags/` invece delle emoji Unicode, per garantire la compatibilità con WebView2 su Windows (che non renderizza le flag emoji nei controlli HTML).

---

## Dipendenze principali

| Pacchetto | Scopo |
|---|---|
| [epubjs](https://github.com/futurepress/epub.js/) | Parsing e rendering EPUB |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | Dialogo apertura/salvataggio file nativo |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | Lettura/scrittura file dal filesystem |
| Vite 6 | Build tool e dev server |

---

## Licenza

MIT
