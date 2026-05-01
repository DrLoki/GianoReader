# 🎭 Giano Reader

![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?logo=javascript&logoColor=black)

> **Read globally, understand locally. The dual-faced reader for language explorers.**

<p align="center">
  <img src="https://github.com/user-attachments/assets/b546c87e-60c2-4727-a374-0a76a5a3b91f" alt="Giano Reader Screenshot" width="800">
</p>

### 📖 Bridging the Gap in Foreign Literature

**Giano Reader** is a lightweight, high-performance desktop application designed for those who refuse to let a language barrier stand between them and a great book. 

Named after the Roman god of dualities and transitions, Giano provides a **synchronized, side-by-side reading experience**. It is specifically crafted for language learners who want to dive into foreign literature without losing the flow, the context, or the original book's formatting.

---

### 🚀 Why Giano Reader?

*   **⚡ Lightweight & Native:** Built with **Tauri 2**, offering a snappy desktop experience with a minimal system footprint.
*   **🔗 Fluid Synchronization:** As you scroll the original text, the translation follows perfectly. Never lose your place again.
*   **🧠 Context-Aware:** Unlike standard translators, Giano preserves the "soul" of the EPUB, rendering native styles while providing a modern translation overlay.
*   **⏳ Smart Lazy Translation:** Our chunking logic means you don't have to wait for the whole book to be processed—it translates as you read, starting from your current position.

---

## ✨ Key Features

- Open and read EPUB files
- Navigable table of contents (TOC)
- Chapter navigation with progress bar and chapter tick marks
- Side-by-side translation (original + translated) with synchronized scroll
- Lazy translation: starts from your current reading position, expands downward as you scroll
- Original EPUB view mode (rendered in an iframe with native styling)
- Bookmarks with chapter and scroll position, import/export as JSON
- Library: scan folders for EPUB files, store metadata and covers, filter by status
- Book detail panel: editable title, author, publisher, year, language, status, personal notes
- 6 themes: Dark (default), Light, Monokai, Solarized Dark, Nord, Sepia
- Custom font family and font size controls
- Configurable folder scan depth (1–10 levels)
- UI language support with RTL (Arabic)
- SVG icons (Font Awesome 6 Free) instead of emoji
- Language dropdowns with SVG flag images (compatible with WebView2 on Windows)
- Window geometry persistence across restarts (Tauri only)

## 🌍 Supported Languages

Italian, English, French, German, Spanish, Portuguese, Russian, Chinese, Japanese, Arabic, Filipino, Albanian.

---

## 📦 Build Instructions

For build requirements and instructions see [BUILD.md](giano-reader/BUILD.md).

## Quick Start

1. Clone the repo: `git clone https://github.com/user/giano-reader.git`
2. Install dependencies: `npm install`
3. Run in dev mode: `npm run tauri dev`

---

## 🛠 Project Structure

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
│   ├── main.js             # All frontend logic: reader, UI, bookmarks, library, scroll sync
│   ├── translator.js       # Google Translate integration (chunked, lazy)
│   ├── i18n.js             # UI translations (12 languages); exports t(lang, key, vars)
│   ├── settings-utils.js   # Pure utility functions (no DOM); used by main.js and tests
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

## ⚙️ How Translation Works

Uses the unofficial Google Translate public endpoint (`translate.googleapis.com`) — no API key required. Text is split into ~4500-character chunks and translated lazily: the visible block first, then subsequent ones as you scroll. When opening a bookmark, translation starts directly from the saved position.

> **Note:** The unofficial endpoint is suitable for personal use only. For commercial or high-volume use, the [official Google Cloud Translation API](https://cloud.google.com/translate) is recommended.

---

## Library

The library scans local folders for EPUB files and stores metadata (title, author, publisher, year, language, description, cover thumbnail, estimated page count, file size) in `localStorage`. Books can be filtered by reading status (To read / Reading / Read) and searched by title or author. The scan depth (1–10 folder levels) is configurable in Settings.

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

## ⚖️ License
This project is licensed under a custom license. See the [LICENSE](LICENSE) file for details.
