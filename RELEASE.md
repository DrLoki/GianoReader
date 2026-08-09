# 🚀 GianoReader Release v0.9.0

This release introduces **Web Server Mode** — an embedded HTTP server that exposes the EPUB library to any device on the local network via a mobile-first PWA web client. Also includes a responsive dual-panel reading layout, lazy translation with sentinel-based loading, and full REST API for books, chapters, bookmarks, and preferences.

---

## ⚠️ Post-Install Migration Required

The app identifier has changed from `com.bolzonella.giano-reader` to `giano-reader`. After installing v0.9.0, run the migration script **once** to preserve your existing data (library, bookmarks, reading state):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/migrate-appdata.ps1
```

This moves your data from `%LOCALAPPDATA%\com.bolzonella.giano-reader\` to `%LOCALAPPDATA%\giano-reader\` and removes the old directory. If you skip this step, the app will start fresh with an empty library.

---

## 📝 Changelog (v0.8.3 → v0.9.0)

### 🌐 Web Server Mode
- **Embedded HTTP Server (axum)**: Toggle a local web server directly from the desktop app's Settings panel. Serves the EPUB library on a configurable port (default 8888) to any device on the LAN.
- **QR Code for Quick Access**: Displays a QR code in Settings with the LAN URL for instant mobile connection.
- **REST API**: Full JSON API for books, chapters, covers, TOC, reading state, bookmarks, preferences, and translation.
- **Persistence (sled)**: Server-side key-value store for reading state, bookmarks, and user preferences — shared across all connected devices.

### 📱 Mobile-First PWA Web Client
- **Responsive Dual-Panel Layout**: Side-by-side Original + Translated panels on tablets/wide screens (≥768px); single-panel slide view on mobile portrait with swipe and tab switching.
- **Lazy Translation (Sentinel Pattern)**: Translates paragraphs in chunks of 12 as the user scrolls through the translated panel — same proven approach as the desktop app. IntersectionObserver with `root: translatedSlot`.
- **IndexedDB Translation Cache**: Translated paragraphs are cached locally per (bookId, chapter, paragraphId, targetLang) to avoid repeated API calls.
- **Synchronized Scroll (Wide Mode)**: Bidirectional proportional scroll sync between Original and Translated panels on wide screens.
- **Chapter Navigation**: Bottom bar with Previous/Next chapter buttons and settings gear.
- **Settings Bottom Sheet**: Slide-up sheet for theme (light/dark/sepia), translation language, font size, UI language. Changes persist immediately via the API.
- **Library Screen**: Book grid with covers, progress indicators, and a Bookmarks tab showing all bookmarks across all books.
- **Bookmarks**: Create bookmarks at current reading position; tap to navigate directly to the bookmarked chapter and paragraph.
- **Auto-Skip Empty Chapters**: If a chapter has no paragraphs (cover/title pages), automatically advances to the first chapter with content.
- **Disconnected Overlay**: Full-screen overlay with reconnect button when the server becomes unreachable.
- **Installable PWA**: Web manifest with standalone display mode for home-screen installation.

### 🏗️ Architecture
- **Rust Backend**: Minimal surface — axum server, sled persistence, EPUB parser (spine navigation, paragraph extraction, cover serving), Google Translate bridge (chunked batching).
- **TypeScript Web Client**: Strict TypeScript, Web Components (no Shadow DOM), CSS custom properties for theming. Vite build targeting es2021/chrome105/safari13.
- **rust-embed**: Web client `dist/` is embedded into the Tauri binary at compile time — no external files needed.
- **CORS**: All origins allowed for LAN device access.

### 📊 Real Progress Bar (Desktop & Mobile)
- **Proportional Chapter Ticks (Desktop)**: Progress bar tick marks are now positioned proportionally to the actual text length of each chapter — short chapters get less space, long chapters more. Chapter lengths are computed in background after book load.
- **Intra-Chapter Scroll Tracking (Desktop)**: The progress thumb moves smoothly as you scroll within a chapter, not just when you switch chapters. The indicator now shows a percentage (e.g. "42%") instead of "Ch. X / Y".
- **Click-to-Navigate Respects Proportions (Desktop)**: Clicking the progress bar now navigates to the correct chapter based on its proportional position.
- **Mobile Progress Bar (Web Client)**: New 3px accent-colored progress bar between the reading content and the bottom navigation. Shows real-time scroll percentage with a small label on the right.

### 🛠️ Developer Mode
- **`--dev` Launch Flag**: Launch the installed app with `"Giano Reader.exe" --dev` to open WebView2 DevTools (F12) in production builds. Useful for diagnosing translation errors, TTS issues, or network problems without rebuilding.

### 🔧 Bug Fixes & Improvements
- **JSON Serialization**: Added `#[serde(rename_all = "camelCase")]` to all REST response models (`BookSummary`, `ChapterResponse`, `TocEntry`, `Paragraph`) — fixes field name mismatches between Rust backend and TypeScript client.
- **Touch Scroll Fix**: Added `touch-action: pan-y` and passive pointer listeners to the card UI for reliable mobile scrolling.
- **API State Validation**: `getReadingState` now checks `response.ok` before parsing, preventing malformed state from breaking navigation.
- **UI Language Live Update**: Changing the interface language in Settings now re-renders the current view immediately without requiring a page refresh.
- **TTS Error Diagnostics**: Enhanced OpenRouter TTS error logging with full response body, headers, and request details for easier debugging.
- **App Identifier Changed**: From `com.bolzonella.giano-reader` to `giano-reader` (see migration warning above).
- **Release Profile**: Removed `panic = "abort"` for better error handling in production.
---

# 🚀 GianoReader Release v0.8.3

This release introduces a **Resizable Library Modal**, a **Clean Library** tool to detect and remove broken book links, complete **TTS Voice Gender Indicators** across all models, the full **Gemini TTS 30-voice catalog**, and **TTS Audio Download** with native Save dialog support.

---

## 📝 Changelog (v0.8.2 → v0.8.3)

### 📚 Library Modal Enhancements
- **Resizable Library Modal**: The library modal window is now user-resizable (drag from bottom-right corner). Supports grow up to 90vw × 90vh with minimum constraints (320×300px) to prevent accidental collapse.
- **Clean Library Tool**: New toolbar button (broken-link icon) that scans all books in the library and verifies file existence on disk. Displays results in a styled in-app modal listing broken entries (title + path), with a one-click "Remove" action to purge invalid entries. Fully localized across all 20 supported languages.

### 🎙️ TTS Voice Improvements
- **Gender Indicators on All Models**: Added ♀️/♂️ labels to Grok Voice TTS (Eve ♀️, Ara ♀️, Rex ♂️, Sal ♂️, Leo ♂️) and OpenAI fallback voices (Alloy ♀️, Echo ♂️, Fable ♂️, Onyx ♂️, Nova ♀️, Shimmer ♀️).
- **Complete Gemini TTS Voice Catalog**: Expanded from 6 to all 30 official Google Gemini TTS voices, organized in Female/Male optgroups with style descriptors (e.g., "Kore ♀️ — Firm", "Puck ♂️ — Upbeat").

### ⬇️ TTS Audio Download
- **Native Save Dialog**: The TTS download button now opens a native "Save As" file dialog (via Tauri plugin-dialog) letting users choose where to save the audio file. Browser fallback remains for non-Tauri environments.
- **Gemini WAV Support**: Gemini TTS sessions now store PCM audio for download. The assembled output is exported as a proper WAV file (24kHz 16-bit mono with RIFF header), while other models continue to export MP3.
- **Download Button Repositioned**: Moved to the far right of the TTS toolbar, after the progress percentage indicator, for clearer visual hierarchy.
- **Activation Fix**: The download button now correctly activates for all PRO models (including Gemini) once playback begins, resolving the issue where it remained permanently disabled.

### 🌐 Localization
- **20-Language Coverage for Clean Library**: All new UI strings (`libCheck`, `libCheckRunning`, `libCheckAllGood`, `libCheckBroken`, `libCheckConfirm`, `libCheckRemoveAction`, `libCheckRemoved`) translated across English, Italian, Chinese, Hindi, Spanish, French, Bengali, Portuguese, Russian, Japanese, Indonesian, German, Korean, Thai, Filipino, Arabic, Albanian, Swedish, Ukrainian, and Slovenian.

---

# 🚀 GianoReader Release v0.8.2

This release introduces a **Unified Reader Toolbar** for side-by-side reading layout customization, a new **Dual-Pane Hide/Show Toggle** with automatic scroll-sync restoration, **On-Hover TOC Chapter Translations** in the sidebar, complete multi-language localized labels across all 19 supported languages, and a thorough **Dead Code Removal** of the obsolete Python sidecar pipeline.

---

## 📝 Changelog (v0.8.0 → v0.8.2)

### 🖥️ Unified Reader Header & Layout Customization
- **Unified Toolbar UI**: Consolidated the dual independent header sections into a single, clean **Unified Header Toolbar** at the top of the reader area. This eliminates duplicated controls and matches the premium, minimalist design of GianoReader.
- **Header Grid Layout**: Positioned the original viewer controls on the left, layout toggle controls in the center, and translation engine configurations on the right, divided by elegant high-contrast divider lines.

### 📖 Enhanced Dual-Pane Visibility & Scroll Synchronization
- **Hide Original Panel Control**: Introduced the new `Hide Original Panel` action button (`#hide-original-btn`). Users can now hide either the original text pane or the translation pane completely to maximize reading space, or display them side-by-side.
- **Dynamic Splitter Hiding**: The vertical pane splitter/divider (`#divider`) automatically hides when either pane is collapsed, maximizing screen real estate.
- **Bidirectional Scroll-Sync Restoration**:
  - When revealing the translation panel, if the user has scrolled, the system dynamically translates the chapter and perfectly restores the scroll view position.
  - When revealing the original panel, its scroll position is instantly computed and synchronized based on the exact progress percentage of the translation panel, ensuring a seamless comparative reading experience.

### 🧭 Interactive Sidebar Chapter Translations
- **On-Hover TOC Translation**: Implemented automatic background translation for chapter titles in the sidebar. Hovering (`mouseenter`) or focusing (`focus`) any Table of Contents (TOC) link automatically schedules a translation in the active target language.
- **Asynchronous Tooltip Caching**: Features a localized loading state in the tooltip (`...`) during translation. Once loaded, the translation is cached locally via dataset attributes (`data-translated-title`) so subsequent hovers display the translated title tooltip instantly, without repeating network requests.

### 🌐 Global Localization Updates
- **Multi-language Support**: Added localized titles and tooltips for the new `hideOriginal` action across all **19 supported languages** (English, Chinese, Hindi, Spanish, French, Bengali, Portuguese, Russian, Japanese, Indonesian, German, Korean, Italian, Thai, Tagalog, Arabic, Albanian, and more) inside the i18n module.

### 🎨 Visual & Icon Styling Refinements
- **Theme-Compliant SVG Icons**: Configured SVGs inside the layout toggle buttons to use CSS `currentColor`, aligning with the active color palette across sepia, dark, solarized, monokai, and light reader themes without visual filters.

### 🧹 Dead Code Removal — Python Sidecar Pipeline
- **Complete Sidecar Removal**: Removed all dead code related to the obsolete Python sidecar PDF semantic extraction pipeline (superseded by the JS-only XY-Cut segmentation engine).
- **Python Sidecar Directory Deleted**: Removed the entire `python-sidecar/` directory including source files, tests, and cache artifacts.
- **8 Obsolete JS Modules Deleted**: Removed `sidecar-lifecycle.js`, `pdf-reflow-pipeline.js`, `pdf-navigator-reflow.js`, `pdf-navigator-ui.js`, `reflow-renderer.js`, `cache-manager.js`, `lazy-translation.js`, and `scroll-sync.js` along with their test files.
- **Rust Backend Stripped**: Removed all sidecar Tauri commands (`start_sidecar`, `stop_sidecar`, `extract_page`, `compute_pdf_hash`, `get_cache_dir`), infrastructure structs, and the `giano-assets://` protocol handler from `lib.rs`.
- **Leaner Dependencies**: Removed `sha2`, `uuid`, `percent-encoding`, and `tokio` from `Cargo.toml` — the Rust backend now only keeps `tauri`, `serde`, `image`, and `sysinfo`.
- **Dead i18n Keys Cleaned**: Removed 6 sidecar-related error message keys from all locale objects in `i18n.js`.
- **Verified Clean Build**: All 418 tests pass, `cargo check` and `npm run build` succeed with no stale references.

---

# 🚀 GianoReader Release v0.8.0

This major release introduces the **Premium AI-Powered Translations Engine** using OpenRouter, complete **Filesystem Database Migration** for unlimited library sizes, custom **Tauri security capabilities**, a new **Paragraph-Level Helpers & Interactive Alignment** feature and an **Unit & Integration Test Suite** for no regressions testing.

---

## 📝 Changelog (v0.7.4 → v0.8.0)

### 🧠 Premium Translations Engine (FREE / PRO)
- **OpenRouter API Integration**: Integrated OpenRouter support to unlock context-aware, highly natural literary translations via advanced LLMs.
- **FREE / PRO Translation Switch**: Added a dynamic switch in the sidebar to toggle between standard Google Translate (FREE) and premium AI translation (PRO). The switch automatically reveals itself only when a valid OpenRouter API Key is configured in Settings.
- **Dynamic Model Loader**: Added an interactive "Fetch models" action in Settings to load the latest high-performance LLMs directly from OpenRouter servers.
- **Model Selection Dropdown**: Added a dropdown menu to choose between fast premium models (like `google/gemini-2.5-flash` or `meta-llama/llama-3-8b-instruct`) or any custom models.
- **Timing & Speed Diagnostics**: Integrated advanced asynchronous loading states and timing metrics to trace server response speeds and generation latencies.

### 💾 Storage Architecture & Scalability
- **Local Filesystem JSON Databases**: Migrated the entire book library and bookmarks database from standard `localStorage` (which is limited to ~5MB) to secure, persistent local JSON files on disk (`giano-library.json` and `giano-bookmarks.json` inside the app's system data directory).
- **Unlimited Capacity**: This migration permanently solves the browser `QuotaExceededError` exception, allowing you to manage massive libraries with thousands of ebooks and cover images.
- **Automated Data Migration**: Implemented a background migration runner on startup that seamlessly moves existing books and bookmarks from legacy `localStorage` to the new filesystem databases without any data loss.
- **Browser Fallback**: Maintained standard browser-compatible fallbacks for web-only testing.

### ⚙️ Tauri Security & Capabilities (ACL)
- **Tauri Security Fine-Tuning**: Configured security capability rules in `src-tauri/capabilities/default.json` and `tauri.conf.json`, explicitly granting ACL permissions for local filesystem reading, writing, and file metadata states.
- **EPUB Import Fix**: Resolves the runtime error `"Command plugin:fs|stat not allowed by ACL"`, ensuring large EPUB files open cleanly on Windows, macOS, and Linux without permission crashes.

### 📖 Paragraph-Level Helpers & Interactive Alignment
- **Synchronized Hover Highlight**: Hovering any paragraph instantly highlights it with a subtle background accent and a matching side-border indicator (aligned cleanly without shifting text layout, fully RTL compatible). The corresponding translated paragraph highlights in perfect synchronization.
- **Chromatic Paragraph Pairing**: Clicking the Palette icon color-codes adjacent paragraphs in alternating, contrast-optimized HSL colors. Includes dynamic color themes tailored separately for light and dark/monokai/solarized backgrounds.
- **Paragraph Numbers Toggle**: Clicking the `#` button toggles inline paragraph numbers at the start of each text block, facilitating academic research and precise alignment checking across different languages.

### 🎨 UI Refinements & Layout Polish
- **Paragraph Highlighting Shifting Fix**: Resolved a visual bug where highlighting paragraphs in comparative reading mode added a left-border that shifted text blocks horizontally. The border highlight now occupies a stable spacing with no text movement.
- **Translation Mode Button Polish**: Fixed a rendering bug where the "FREE/PRO" text button had an invisible background and transparent text in light themes, ensuring high-contrast typography and standard border coloring across all theme colors.
- **Settings Layout Polish**: Aligned the "Optimal Limit" RAM button horizontally with the "Max file size (MB)" input box in the Settings modal, matching GianoReader's red accent colors and Font Awesome icons.
- **Flag-Based Custom Selectors**: Replaced default flag emojis with high-resolution SVG flags inside language dropdowns for flawless rendering on Windows (WebView2).

### 🧪 Comprehensive Quality Assurance
- **Unit & Integration Test Suite**: Developed a robust suite of **118 Vitest unit and integration tests** validating OpenRouter API routing, fallback logic, settings persistence, bookmark structures, and theme adjustments under JSDOM.
- All 118 tests pass successfully (`✓ 118 passed`) in under 2 seconds.
