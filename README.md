# 🎭 Giano Reader

![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6.0-646CFF?logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?logo=javascript&logoColor=black)

> **Read globally, understand locally. The dual-faced reader for language explorers.**

<p align="center">
  <img width="1021" height="704" alt="5EgwP4AOvV" src="https://github.com/user-attachments/assets/4848e1c7-e997-4f6a-87b4-4565fbcd38d0" />
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
- **Dual-Mode Translation (FREE / PRO)**: Toggle between lightweight free translation and premium context-aware AI translation
  - **FREE Mode**: Direct, instant paragraph translation via Google Translate (no API key required)
  - **PRO Mode**: Context-aware, natural, literary translations via **OpenRouter** (supports models like `google/gemini-2.5-flash`, `meta-llama/llama-3-8b-instruct`, etc.)
- **Dynamic Model Fetching**: Load and select the newest premium models directly from OpenRouter within Giano Reader Settings
- **Interactive Paragraph Pairing**: Instantly highlight corresponding paragraphs with matching color codes (using custom 5-color palettes tailored for light and dark themes) to follow complex narratives effortlessly
- **Word-Level Bidirectional Hover Alignment**: Hovering a word in the original text highlights the corresponding word in the translation (and vice versa) for immediate word-by-word comparison
- **Paragraph Numbers Toggle**: Show/hide small paragraph numbers at the start of each text block for precise, high-accuracy study alignment
- Lazy translation: starts from your current reading position, expands downward as you scroll
- Original EPUB view mode (rendered in an iframe with native styling)
- Bookmarks with chapter and scroll position, import/export as JSON
- **Filesystem Database Migration**: Tauri desktop app stores library metadata and bookmarks in secure, local JSON files on disk, ensuring virtually unlimited storage and preventing browser `QuotaExceededError` limits
- Book detail panel: editable title, author, publisher, year, language, status, personal notes
- 6 themes: Dark (default), Light, Monokai, Solarized Dark, Nord, Sepia
- Custom font family and font size controls
- Configurable folder scan depth (1–10 levels)
- UI language support with RTL (Arabic)
- SVG icons (Font Awesome 6 Free) instead of emoji
- Language dropdowns with SVG flag images (compatible with WebView2 on Windows)
- Window geometry persistence across restarts (Tauri only)
- **i18n Developer Automations**: Integrated script in `.antigravity/` to automatically align and synchronize all 17 translation locales instantly

## 🌍 Supported Languages

Giano Reader supports 17 interface languages:
English, Chinese, Hindi, Spanish, French, Bengali, Portuguese, Russian, Japanese, Indonesian, German, Korean, Italian, Thai, Filipino, Arabic, Albanian.

---

## 📥 Download & Install
You can find the ready-to-use installers for Windows (.msi), macOS (.dmg), and Linux (.AppImage) here:

👉 [Download Giano Reader v0.8.0](https://github.com/DrLoki/GianoReader/releases/tag/v0.8.0)

> [!IMPORTANT]
> **Migration Note (from v0.7.x to v0.8.x):**  
> Before installing version 0.8.x, it is highly recommended to **export your Library** (using the export feature in Settings) to prevent any potential data or metadata loss during the schema migration.

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
│   ├── i18n.js             # UI translations (17 languages); exports t(lang, key, vars)
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

Giano Reader implements a flexible dual-mode translation engine:

*   **FREE Mode**: Uses the unofficial Google Translate public endpoint (`translate.googleapis.com`) — **no API key required**. Text is split into ~4500-character chunks and translated lazily: the visible block first, then subsequent ones as you scroll.
*   **PRO Mode**: Uses **OpenRouter APIs** to query advanced Large Language Models (LLMs) like Gemini and Llama. This provides premium literary-grade, context-aware translations that respect the author's writing style. To activate it, simply paste your OpenRouter API Key into Settings. Once active, Giano will query OpenRouter asynchronously, and the text will be displayed block-by-block.

For both modes, translation is entirely **lazy**: the app begins translating from your current reading position and expands downward as you scroll. When you open a bookmark, translation starts directly from the saved position, saving bandwidth and system load.

---

## 📚 Advanced Learning & Reading Helpers

Giano Reader includes premium tools designed to speed up comprehension and make comparative reading natural:

*   **Paragraph Coloring (Palette)**: Clicking the palette icon (`[Palette]`) in the translation header activates high-contrast paragraph matching. The original paragraphs and their corresponding translations are colored in matching background tints, letting your eyes instantly jump between the two versions. Giano includes separate, hand-tailored 5-color palettes optimized for both dark and light modes to maintain excellent text contrast.
*   **Word-Level Bidirectional Alignment**: When paragraph coloring is turned off, hovering over any individual word in the original text will automatically highlight the corresponding translated word (and vice versa). This is incredibly powerful for identifying sentence structures, vocabulary counterparts, and idioms.
*   **Paragraph Numbers (`#`)**: Clicking the `#` button toggles small inline paragraph numbers at the start of each text block. This helps you track structural alignment across chapters.

---

## Library

The library scans local folders for EPUB files and stores book metadata (title, author, publisher, year, language, description, cover thumbnail, estimated page count, file size) persistently. 

To prevent web browser storage quota limitations (`localStorage` is limited to ~5MB), **Giano Reader desktop (Tauri) automatically migrates all library metadata and bookmarks to secure JSON files directly on your local filesystem** (`giano-library.json` and `giano-bookmarks.json` in the app's system data directory). This supports virtually unlimited library sizes and prevents `QuotaExceededError` crashes when scanning thousands of ebooks. The browser version retains a fast fallback storage mode. Books can be filtered by reading status (To read / Reading / Read) and searched by title or author. The scan depth (1–10 folder levels) is configurable in Settings.

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
