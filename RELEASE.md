# 🚀 GianoReader Release v0.9.4

This release brings **images and inline formatting into the side-by-side translation**, enables **translation in Original view** (the faithful EPUB iframe now sits next to a translated panel), and adds a **percentage-based scroll sync** with a dedicated on/off toggle, offset preservation for manual realignment, and double-click re-alignment.

---

## 📝 Changelog (v0.9.3 → v0.9.4)

### 🖼️ Images & Inline Formatting in the Translated Panel

- **Persistent image resolution**: Chapter images are remapped to persistent blob URLs (via epubjs `resources.substitute` / `archive.createUrl`) *before* other spine items are unloaded, so figures no longer break in the reflowed text view.
- **Segment model**: `extractParagraphs` now returns typed segments — `text` (translated, formatting preserved) and `image` (standalone figures, mirrored identically in both panels). Block images (`<figure>`, standalone `<img>`, `<svg>`) are extracted in document order and never sent to the translator.
- **Inline images preserved through translation**: Images inside a text paragraph (e.g. an icon mid-sentence) are replaced with placeholder tokens (`⟦IMGn⟧`) before translation and re-inserted in place afterward. If a translation engine drops a token, the image is appended to the paragraph so it is never lost.
- **Inline formatting**: Block-level inline wrappers (`<em>`, `<strong>`, whole-block links) are re-applied around the translated text; internal links keep their `data-epub-href`. Falls back to clean text (with images still re-inserted) when formatting is scattered mid-sentence.
- **Styling**: Standalone figures render centered (`.segment-image`) with captions; inline images render as `1.5em` glyphs aligned to the text baseline (`.inline-img`).

### 🔀 Translation in Original View

- **Translated panel in Original mode (EPUB)**: Switching to Original view now keeps the faithful epubjs iframe on the left *and* generates the lazy translation in the right panel — previously the right panel stayed empty. Works on chapter navigation and when re-showing the translation panel.

### ↕️ Percentage-Based Scroll Sync + Offset

- **Iframe-aware sync**: Scroll synchronization now understands the EPUB iframe (scroll happens inside the frame document) and syncs it to the translation panel by percentage. The listener re-binds on iframe load.
- **Sync toggle**: A new chain-link button in the header toggles scroll sync on/off (default on). It is available in **both** text and original views, so sync can always be re-enabled after switching modes.
- **Offset preservation**: When sync is re-enabled after manual scrolling, the current gap between the two panels is captured and maintained (no abrupt snap) — enabling manual realignment.
- **Red percentage indicator**: When sync is off, the reading-percentage label turns red instead of showing a text notice, so the toolbar controls don't shift.
- **Double-click to realign**: Double-clicking the percentage resets the offset and aligns both panels to the same percentage.

### 🧪 Testing

- New regression tests: image-segment extraction, `src` remapping, inline-image token round-trip (including lost-token fallback and multi-image ordering), inline-formatting preservation, and percentage-sync/offset math. All 71 tests in `regression.test.js` pass.

---

# 🚀 GianoReader Release v0.9.3

This release introduces a **three-tier translation engine** (FREE · BASIC · PRO) with official **Google Cloud Translation API** support, **Vietnamese** as the 22nd language, a `translate_free` Tauri command that bypasses WebView2 CORS, and web client improvements for offline bookmarks management and graceful library fallback.

---

## 📝 Changelog (v0.9.0 → v0.9.3)

### 🌐 Three-Tier Translation Engine (FREE / BASIC / PRO)

- **Google Cloud Translation Basic tier**: Added support for the official Google Cloud Translation API v2/v3. Replaces the FREE/PRO toggle with a three-way mode selector (FREE · BASIC · PRO).
  - **FREE**: Unchanged — unofficial Google Translate endpoint, no API key required.
  - **BASIC**: Official Google Cloud Translation API with NMT or Translation LLM model selection. Requires a Google Cloud Project ID and API Key, stored securely in preferences. Cost ~$0.01–0.02 per novel.
  - **PRO**: Unchanged — OpenRouter LLMs.
- **`translate_free` Tauri command**: The Rust backend now exposes a `translate_free` command that calls the Google Translate endpoint server-side, bypassing WebView2 CORS restrictions. The frontend retains full control of chunking and paragraph realignment.
- **`translation_mode` preference**: New field in the preferences schema (`"free"` / `"basic"` / `"pro"`). Validated on read/write and persisted across sessions. Includes a regression test ensuring the value survives round-trips.
- **Google Cloud credentials UI**: New "Basic" tab in Settings with Project ID and API Key inputs, translation model selector, and secure storage via the preferences API.
- **`GOOGLE_CLOUD_SETUP.MD`**: New setup guide with configuration steps, pricing breakdown, troubleshooting, and documentation of the three-tier architecture.
- **CSP update**: `tauri.conf.json` updated to allow local server connections required by the new translation backend.

### 🇻🇳 Vietnamese Language Support

- **Vietnamese (`vi`)**: Added as the 22nd supported language for both translation target and UI language. Fully localized across all UI strings.
- **`vn.svg` flag**: Added Vietnam flag to the language selector dropdown.
- **`password-prompt` component** (web client): New secure credential entry component used by the BASIC tier settings flow.

### 📱 Web Client — Offline & Bookmarks Improvements

- **Graceful offline fallback**: `getBooks()` now always loads local (IndexedDB) books first, merges server books on top, and deduplicates. `getBookmarks()` returns an empty array instead of throwing on network failure. The disconnected overlay is dismissed automatically when cached books load successfully.
- **Offline toast**: Shows an informational toast when the library falls back to the local cache, with new i18n keys (`offlineFallback`) in English and Italian.
- **Navigation fix**: Replaced full page reload with a navigation event when toggling offline mode, avoiding unnecessary state loss.
- **Bookmarks local database** (`local-db.ts`): Expanded IndexedDB layer with full bookmark CRUD support — create, list, delete, and navigate — mirroring the server API for complete offline operation. Includes a dedicated unit test suite (`local-db.test.ts`).
- **Icon registry** (`icons.ts`): New centralized icon registry module used across web client components.

### 🧪 Testing

- **`openrouterSelectModel` i18n key**: Added missing translation key for the OpenRouter model dropdown placeholder.

### 🌐 Persian (Farsi) Support

- **New language — `fa`**: Persian is the 21st supported language for both translation target and UI language. Fully localized across all ~130 UI strings.
- **RTL layout**: Persian joins Arabic in `RTL_LANGS`. Selecting Persian as the UI language activates the `html.rtl` class, flipping the sidebar, panels, toolbar, modals, and text direction right-to-left. No CSS changes needed — all existing `html.rtl` selectors apply automatically.
- **Iran flag**: Added `ir.svg` flag icon for the language selector dropdown.

### 🔄 In-App Updater

- **Auto-Update**: Integrated Tauri's built-in updater (`tauri-plugin-updater`). The app checks for new releases on startup and prompts the user with a dismissible dialog showing the version number and install/later options. Download progress is shown in real time.
- **Updater UI strings**: All update-related strings (`updateAvailable`, `updateMsg`, `updateInstall`, `updateLater`, `updateDownloading`, `updateError`) localized across all 21 supported languages.

### 📚 EPUB Parser Improvements

- **Headings, lists, and blockquotes**: Paragraph extraction now captures `<h1>`–`<h6>`, `<li>`, and `<blockquote>` elements in addition to `<p>`. Nested blockquotes are handled recursively; leaf blockquotes are parsed directly.
- **Native element IDs preserved**: `id` attributes on block-level elements are extracted and stored in a `native_id` field on the `Paragraph` model, enabling precise cross-reference and anchor navigation within EPUB documents.
- **NCX document-order TOC**: Replaced playOrder-based sorting with a custom NCX parser that preserves the original document order and handles nested `navPoint` entries recursively. Fixes corrupted TOC structure common in Calibre-converted EPUBs. Falls back to the crate's default parser if the custom one returns empty results.
- **TOC hierarchy in web client**: Recursive TOC flattening with level-based indentation for the new `TocSheet` component.

### 🌍 Translation Reliability

- **Batch mismatch fallback** (`translator.js` + Rust backend): When the translation engine strips or modifies `\n\n` separators (e.g. when merging short dialogue lines), the realigned split count is verified against the expected paragraph count. On mismatch, each paragraph in the batch is retranslated individually to prevent text loss and misalignment.
- **Empty translation guard** (web client): Empty or whitespace-only translation results are no longer cached or silently accepted. Cached empty entries are ignored on retrieval to force retranslation; the reading screen surfaces an error with a retry option.

### 📱 Web Client — TOC Sheet & Navigation

- **`TocSheet` component**: New slide-up sheet displaying the hierarchical table of contents with level-based indentation. Supports direct chapter navigation via spine index lookup.
- **Navigation icons**: Five new SVG icons added (`chevron-left`, `chevron-right`, `house`, `list`, `trash-solid`) for navigation controls and UI actions.
- **Library screen layout**: Improved vertical distribution of book cards (`flex: 1` on book-info); offline button and progress control aligned to the bottom via `margin-top: auto`.

### 📶 PWA Offline Mode & Cloudflare Worker

- **Offline support** (`sw.js`): Service worker rewritten to serve the web client fully offline. Caches all static assets at install time; API requests fall back to an `IndexedDB`-backed local database (`local-db.ts`) when the desktop server is unreachable.
- **Local database** (`local-db.ts`): Full `IndexedDB` implementation mirroring the server API — books, chapters, paragraphs, bookmarks, preferences, and reading state — so the PWA works independently of the Tauri backend.
- **Cloudflare Worker CORS proxy**: When offline (disconnected from the desktop server), the web client routes Google Translate requests through a user-deployed Cloudflare Worker to bypass CORS restrictions. Added captcha/rate-limit detection: returns HTTP 429 with a `CAPTCHA_REQUIRED` JSON error when Google responds with HTML or detects unusual traffic.
- **Setup guide** (`CLOUDFLARE_WORKER_SETUP.md`): Updated with deployment instructions, mitigation strategies for rate limits, volume recommendations, and an explanation that the Tauri desktop app calls Google Translate directly without a proxy.
- **Settings sheet reorganized** (web client): Collapsible sections group interface language, theme, font, display settings, keyboard shortcuts, and offline mode indicator for better mobile usability.

### 🐛 Bug Fixes

- **TOC anchor navigation**: Added fallback logic that maps TOC anchors to the closest paragraph in the viewer when the anchor has no direct 1:1 match in the rendered content. Tracks `currentChapterBody` to preserve the original chapter DOM for accurate positional mapping; resets on EPUB load and chapter display.
- **TOC tooltip debounce**: Introduced a debounce timer for TOC tooltip translation requests, preventing excessive API calls when the user hovers quickly over multiple TOC entries.
- **Book search filter**: Fixed a regression where the status filter was not applied correctly when searching the library by title or author.

### 🧪 Testing

- **Offline-parity preservation tests**: Property-based tests lock the current `extractParagraphs` behavior and validate online/offline paragraph extraction parity (Requirements 3.1–3.6).
- **Translator batch fallback tests**: New unit tests for the batch mismatch fallback path in both `translator.js` and the Rust backend.

---

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
- **Clean Library Tool**: New toolbar button (broken-link icon) that scans all books in the library and verifies file existence on disk. Displays results in a styled in-app modal listing broken entries (title + path), with a one-click "Remove" action to purge invalid entries. Fully localized across all 21 supported languages.

### 🎙️ TTS Voice Improvements

- **Gender Indicators on All Models**: Added ♀️/♂️ labels to Grok Voice TTS (Eve ♀️, Ara ♀️, Rex ♂️, Sal ♂️, Leo ♂️) and OpenAI fallback voices (Alloy ♀️, Echo ♂️, Fable ♂️, Onyx ♂️, Nova ♀️, Shimmer ♀️).
- **Complete Gemini TTS Voice Catalog**: Expanded from 6 to all 30 official Google Gemini TTS voices, organized in Female/Male optgroups with style descriptors (e.g., "Kore ♀️ — Firm", "Puck ♂️ — Upbeat").

### ⬇️ TTS Audio Download

- **Native Save Dialog**: The TTS download button now opens a native "Save As" file dialog (via Tauri plugin-dialog) letting users choose where to save the audio file. Browser fallback remains for non-Tauri environments.
- **Gemini WAV Support**: Gemini TTS sessions now store PCM audio for download. The assembled output is exported as a proper WAV file (24kHz 16-bit mono with RIFF header), while other models continue to export MP3.
- **Download Button Repositioned**: Moved to the far right of the TTS toolbar, after the progress percentage indicator, for clearer visual hierarchy.
- **Activation Fix**: The download button now correctly activates for all PRO models (including Gemini) once playback begins, resolving the issue where it remained permanently disabled.

### 🌐 Localization

- **21-Language Coverage for Clean Library**: All new UI strings (`libCheck`, `libCheckRunning`, `libCheckAllGood`, `libCheckBroken`, `libCheckConfirm`, `libCheckRemoveAction`, `libCheckRemoved`) translated across English, Italian, Chinese, Hindi, Spanish, French, Bengali, Portuguese, Russian, Japanese, Indonesian, German, Korean, Thai, Filipino, Arabic, Persian, Albanian, Swedish, Ukrainian, and Slovenian.

---

# 🚀 GianoReader Release v0.8.2

This release introduces a **Unified Reader Toolbar** for side-by-side reading layout customization, a new **Dual-Pane Hide/Show Toggle** with automatic scroll-sync restoration, **On-Hover TOC Chapter Translations** in the sidebar, complete multi-language localized labels across all 20 supported languages, and a thorough **Dead Code Removal** of the obsolete Python sidecar pipeline.

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

- **Multi-language Support**: Added localized titles and tooltips for the new `hideOriginal` action across all **20 supported languages** (English, Chinese, Hindi, Spanish, French, Bengali, Portuguese, Russian, Japanese, Indonesian, German, Korean, Italian, Thai, Tagalog, Arabic, Albanian, and more) inside the i18n module.

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
