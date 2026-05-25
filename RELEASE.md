# 🚀 GianoReader Release v0.8.1

This release introduces a **Unified Reader Toolbar** for side-by-side reading layout customization, a new **Dual-Pane Hide/Show Toggle** with automatic scroll-sync restoration, **On-Hover TOC Chapter Translations** in the sidebar, and complete multi-language localized labels across all 19 supported languages.

---

## 📝 Changelog (v0.8.0 → v0.8.1)

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
