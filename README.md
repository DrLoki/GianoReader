# Giano Reader

Desktop EPUB reader with integrated side-by-side translation powered by Google Translate. Built with [Tauri 2](https://tauri.app/) + Vite + vanilla JavaScript.

---

## Features

- Open and read EPUB files
- Navigable table of contents (TOC)
- Chapter navigation with progress bar and chapter tick marks
- Side-by-side translation (original + translated) with synchronized scroll
- Lazy translation: starts from your current reading position, expands downward as you scroll
- Bookmarks with chapter and scroll position, import/export as JSON
- 6 themes: Dark (default), Light, Monokai, Solarized Dark, Nord, Sepia
- Text zoom (A+ / A-)
- Book cover and metadata display
- UI language support with RTL (Arabic)
- SVG icons (Font Awesome 6 Free) instead of emoji
- Language dropdowns with SVG flag images (compatible with WebView2 on Windows)

## Supported translation languages

Italian, English, French, German, Spanish, Portuguese, Russian, Chinese, Japanese, Arabic, Filipino, Albanian.

---

For build requirements and instructions see [BUILD.md](giano-reader/BUILD.md).

---

## Project structure

```
giano-reader/
├── index.html              # HTML entry point — all UI markup
├── package.json
├── vite.config.js          # Vite: port 1420, ignores src-tauri/
├── public/
│   ├── favicon.ico
│   ├── logo.png
│   ├── icons/              # SVG UI icons (Font Awesome 6 Free, SIL OFL 1.1)
│   │   ├── gear.svg
│   │   ├── xmark.svg
│   │   ├── book-bookmark.svg
│   │   ├── star.svg
│   │   ├── arrows-left-right-to-line.svg
│   │   ├── file-image.svg
│   │   ├── upload.svg
│   │   └── download.svg
│   └── flags/              # SVG flag images for language dropdowns
│       ├── it.svg, gb.svg, fr.svg, de.svg, es.svg, pt.svg
│       ├── ru.svg, cn.svg, jp.svg, sa.svg, ph.svg, al.svg
├── src/
│   ├── main.js             # All frontend logic: reader, UI, bookmarks, scroll sync
│   ├── translator.js       # Google Translate integration (chunked, lazy)
│   ├── i18n.js             # UI translations (12 languages); exports t(lang, key, vars)
│   └── style.css           # All styles (dark mode via body.dark)
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json     # Window config, CSP, bundle settings
    ├── capabilities/
    │   └── default.json    # Tauri capability declarations
    └── src/
        ├── main.rs         # Tauri entry point (calls lib::run)
        └── lib.rs          # Plugin registration + DevTools in debug builds
```

---

## How translation works

Uses the unofficial Google Translate public endpoint (`translate.googleapis.com`) — no API key required. Text is split into ~4500-character chunks and translated lazily: the visible block first, then subsequent ones as you scroll. When opening a bookmark, translation starts directly from the saved position.

> **Note:** The unofficial endpoint is suitable for personal use only. For commercial or high-volume use, the [official Google Cloud Translation API](https://cloud.google.com/translate) is recommended.

---

## Icons and flags

UI icons are SVG files from [Font Awesome 6 Free](https://fontawesome.com/license/free) (SIL OFL 1.1 for icons, MIT for code), stored in `public/icons/`.

Language dropdowns use custom SVG flags in `public/flags/` instead of Unicode emoji, to ensure compatibility with WebView2 on Windows (which does not render flag emoji in HTML elements).

---

## Main dependencies

| Package | Purpose |
|---|---|
| [epubjs](https://github.com/futurepress/epub.js/) | EPUB parsing and rendering |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | Native file open/save dialogs |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | Filesystem read/write access |
| Vite 6 | Build tool and dev server |

---

## License

MIT
