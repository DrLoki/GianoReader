# 🚀 GianoReader Release v0.10.0

This release brings **full PDF support** to side-by-side translation. The layout engine of PDF X-Ray now runs inside the app: it recognises columns, boxes, tables, headings, footnotes and running heads, puts paragraphs back together across columns and pages, and writes the translation **over the original page**, in the same position and style. It was tested on complex layouts such as multi-column RPG rulebooks.

Translations are now **saved per book**, so reopening a chapter costs no new requests. The new **Book translation** window shows how much of the book is translated, completes the translation in the background and **downloads the translated book as an EPUB** (from an EPUB or from a PDF).

Books now **reopen where you left off**, and the two panels stay **aligned paragraph by paragraph** while you scroll. Settings shows how much of your **Google Cloud free quota** you used this month.

It also makes library scans incremental and adds sorting to the library, makes translation and data saving more reliable, and hardens the web server used by the mobile PWA.

> [!IMPORTANT]
> If you use the BASIC engine (your Google Cloud key) from the phone, set a web server password: without one, the server now answers BASIC requests with the FREE engine.

---

## 📝 Changelog (v0.9.5 → v0.10.0)

### 💾 Saved Translations

- **Translations are kept per book**: Every translated paragraph is saved on your computer, in one file per book (`translations/` in the app data folder; IndexedDB in browser mode). Translations are stored separately for each target language and engine (FREE, BASIC, PRO).
- **No repeated requests**: Going back to a chapter, reopening the book or restarting the app shows the saved translation at once, with no new requests and no new costs for BASIC and PRO.
- **Edited books keep their translations**: Paragraphs are matched by their text, so if you edit the book file, the paragraphs that did not change keep their translation.
- **Cleanup**: The saved translations of a book are deleted when the book is deleted from the library. The book details panel shows which translations are saved and how complete they are.

### 📚 Book Translation Window

- **New "Book translation" button** (the "A文" icon in the translation panel header). It shows how much of the book is translated in the current language and engine, with paragraph and chapter counts, the characters still to translate, a progress bar for each chapter (click one to open it) and the other saved languages or engines.
- **Complete translation**: Translates in the background every paragraph not yet translated, while you keep reading. **Stop** ends it and keeps what was done. With BASIC and PRO, the number of characters is shown and must be confirmed first, since these engines use your paid key. With FREE, requests are spaced out to avoid the endpoint's rate limit.
- **Download translated book**: Saves an EPUB with the translated text. For an EPUB, the copy keeps the original layout, styles, images and table of contents (formatting inside a paragraph, such as italic or links, is not kept). For a PDF, a new simple EPUB is created with one section per chapter or page. Paragraphs not translated yet stay in the original language, and you are asked to confirm when the book is not fully translated.
- **Retranslate chapter** translates the chapter on screen again and replaces its saved translation. **Delete saved translations** removes them for the current language and engine.

### 📖 Reading

- **Reopen where you left off**: The reading position of each book (chapter, or PDF section, and scroll position) is saved automatically shortly after you scroll or navigate, when you open another book and when you close the app. Opening the same file again brings you back there. Opening a bookmark still goes to the bookmark. On close, the app waits up to 2 seconds for pending saves, which also makes saving the translations on close reliable.
- **Panels aligned by paragraph**: In Text view, scrolling one panel keeps the paragraph with the same number at the top of the other one. Before, the panels were matched by scroll percentage, so they drifted apart by several paragraphs when the translation was longer or shorter than the original. A manual offset (sync turned off, one panel moved, sync turned on again) is kept all along the chapter. Original view (EPUB page or PDF) keeps the percentage sync.
- **Double-click realignment**: Double-clicking the percentage in the translation panel header now brings the right panel to the same paragraph as the left one, at the same point inside it, instead of the same percentage.
- **Narrow fonts**: New condensed fonts help a translation that is longer than the original fit in the same space. **Roboto Condensed** comes with the app, so it is available everywhere. The font list also offers the narrow fonts of each system: Arial Narrow, Bahnschrift SemiCondensed (Windows), Avenir Next Condensed (macOS), Liberation Sans Narrow and DejaVu Sans Condensed (Linux). The list shows only the fonts installed on your computer.
- **Font controls no longer stuck**: After a PDF in Original view, the font family and text size controls could stay greyed out, even with another book open. They now follow the current file and view.
- **Clickable links in both panels**: Links in the book (notes, cross-references, web addresses) now show the hand cursor, and they also work in the translation panel when the link covers the whole paragraph. Links to web pages open in the system browser.

### 📊 BASIC Monthly Usage

- **Free quota at a glance**: Settings → BASIC shows the characters translated with your Google Cloud key this month, against the 500,000 characters per month of Google's free tier, with a bar that turns red when you go over it.
- **Counted by the app**: Google does not let a key read its own usage, so Giano Reader counts the characters it sends, the way Google bills them (every character, spaces included, once a request is accepted). The count includes the translations made on the desktop and the BASIC translations the web server makes for the phone, and starts over every month. Characters translated with the same key outside Giano Reader are not included: the Google Cloud console has the billed figure.

### 🌍 Translation Reliability

- **Automatic retries**: A failed block (network error, rate limit) is tried again twice, after 1.5 and 4 seconds, before the original text is shown.
- **Long paragraphs with FREE**: The free Google endpoint only accepts GET requests and rejects URLs over about 16 KB. Batches are now limited to 4500 UTF-8 **bytes** (not characters), and a single longer paragraph is split at a word or sentence boundary and sent in several requests. Before, a very long paragraph, or text in a non-Latin script, could fail to translate. The same rule applies on the desktop, on the web server and in the PWA offline translator.
- **PRO paragraph alignment**: Paragraphs sent to an LLM are numbered (`⟦1⟧`, `⟦2⟧`…), so the answer is matched back by number instead of by blank lines. A model that merges or splits paragraphs no longer shifts the translation out of place.
- **Fast scrolling**: Chunks are translated as soon as they come into view, or are about to, even when a fast scroll jumps over several of them. Before, scrolling fast could leave the rest of the chapter showing the original text as a placeholder. A chapter that is already fully saved is shown translated at once.
- **Clearer status**: The ✓ in the panel header appears only when every chunk has finished, and ⚠ appears if one failed.
- **Nested blocks**: A block that contains other blocks (`<li><p>…</p></li>`, nested lists, a `<blockquote>` of paragraphs) now contributes only its own text, so text is no longer repeated. Chapters with no block tags (text directly in `<div>` or `<pre>`) are split into one paragraph per line instead of coming out empty. The desktop, the server and the PWA follow the same rule.

### 📂 Faster Library Scan

- **Incremental scan**: Scanning a folder again skips the books already in the library, recognised by path, size and modification date. The summary now reads *"X added, Y updated, Z unchanged"*. PDF files are scanned too.
- **Edited files are analysed again**: Metadata, cover and page count are read again when a file changed. What you entered yourself is kept: reading status, notes, rating and any field you edited in the book details, such as a corrected title.
- **A scan never removes books**: Books on a drive that is not connected stay in the library. Use the library check command to remove missing files.
- **Lighter scans**: Results are saved in groups, so an interruption does not lose the work done. PDF documents are released right after their metadata is read, and the cover of the book being opened is reused instead of opening the EPUB twice.

### 🗂️ Library Sorting & Publisher

- **Sort the library**: A new menu in the library sorts the books by date added, title or author. The choice is remembered.
- **Publisher**: The publisher is read from the EPUB metadata, shown and editable in the book details, and included in the library search, on the desktop and in the phone app (also for books saved offline).

### 📄 PDF

- **Translation laid over the page**: In Original view, the right panel shows the PDF pages with the translation written over the original text, in the same position, with the original font family, weight, italic, alignment and line spacing. When the translation is longer than the original, the text shrinks (down to 45 %) to fit its box, and a box that still overflows gets a dashed orange outline. Page numbers are not translated. This needs the desktop app; in a browser the previous simple overlay is used.
- **New layout engine**: The PDF layout analysis of the companion project PDF X-Ray now runs inside the app (Rust). It rebuilds lines and blocks with a recursive XY-Cut, recognises columns, boxes, tables, headings, captions, footnotes, running heads and page numbers, works out the reading order, and stitches paragraphs split across columns, pages, figures or boxes, rejoining hyphenated words. Tagged PDFs use their structure tree. Each logical paragraph is translated once, as a whole, and the translation is split over its pieces on the page. Pages are analysed together with the 2 pages before and after the ones shown, so a paragraph that continues on the next page is handled correctly.
- **Your font on the page**: In Original view, the translation boxes laid over the page use the font family you chose (for example a narrow one, so that less text has to shrink). Changing it updates the boxes already translated without redrawing the page. If you never chose a font, the boxes keep the family of the original text. Text size stays tied to the original in this view.
- **Ornaments and decorated pages**: Fonts used only for ornaments (friezes, symbols stacked in a margin) are recognised, and their glyphs are kept out of the text instead of being read as words or breaking the column detection. An ornamental border drawn along a page edge is no longer taken for a sidebar, and boxes with rounded corners are now recognised as boxes, like square ones. A large heading no longer bridges the gutter between two columns.
- **Better text view**: The text view and the "Book translation" window use the same paragraphs. Justified text is no longer split into fragments, which happened because wide word spacing was taken for a column gap. Typographic ligatures (ﬁ, ﬀ, ﬂ…) are expanded, so words such as "different" or "identified" no longer lose letters.
- **Scroll sync in Original view**: Pages that were not painted yet were squeezed by the panel layout, so the original panel was much shorter than the translation panel and a small scroll on one side jumped several pages on the other. Both panels now have the same height and scroll page by page together.
- **Sharp, lighter pages**: Page canvases are painted at the screen's pixel density (up to 2×), so text is sharp on HiDPI screens. Only pages near the viewport are painted, and pages far away are freed, which saves memory on long documents.
- **Table of contents**: An outline entry now leads to the chapter that contains its start page. Before, entries could point to the wrong chapter when the outline was not in page order.
- **Page labels** such as "Page N / Total" are shown in the interface language when a PDF is read by pages.

### 🛡️ Data Safety

- **Unreadable data files are never overwritten**: If the library or bookmarks file exists but cannot be read, the app shows a warning (once per file) and does not save over it. Before, it was treated as empty and the next save could replace it with an empty list.
- **Atomic writes**: Data files are written to a temporary file and then renamed, so a crash during a save cannot leave a half-written file.
- **Opening an invalid file**: A new EPUB or PDF is checked before the current book is closed. A damaged file no longer leaves the reader on a broken book.
- **Fast navigation**: Pressing the arrows quickly no longer lets a slow chapter load overwrite the newer one. Theme, font or zoom changes made in quick succession no longer add a duplicate iframe or canvases.
- **Window position**: The window position and size are saved half a second after you move or resize it, not only on close, which did not always finish in time. Leaving maximized mode restores the previous position.
- **Progress bar**: Chapter lengths are saved in the library entry, so they are not read again at every opening while the file is unchanged.

### 🔒 Security

- **BASIC requires a server password**: Without a password, any device on the network can reach the web server, so it now answers BASIC requests with the FREE engine. Set a password to use BASIC (your paid Google Cloud key) from the phone. Settings shows a reminder when a key is configured without a password.
- **Password stored as a digest**: The web server password is saved as a salted SHA-256 digest instead of plain text. A password saved by an older version is still accepted and converted on the next change of the server secrets.
- **No API key in error messages**: Translation errors returned by the server no longer include the request URL, which could contain the Google Cloud key or the text being translated.
- **Stricter inline styles**: The sanitizer keeps only an allowlist of text and box formatting properties in a book's inline styles. Anything that can load a resource or cover the app's own interface (`background`, `position`, `z-index`…) is removed, and CSS escapes can no longer get around the filter.
- **QR code made locally**: The web server's QR code is drawn on your computer instead of by `api.qrserver.com`, so it works offline and your LAN address is not sent to an outside service. That host was removed from the CSP.
- **Filesystem permissions**: The app can only rename files in its data folder and delete only its temporary files and saved translations.

### 🌐 Web Server & PWA

- **LAN address only**: The QR code and the shown address always use the computer's IP address. The `<computer-name>.local` address was dropped because Android does not resolve it.
- **Lighter covers**: The PWA library grid now gets the small cover thumbnail kept by the desktop library (about 200 px wide) instead of the full image from the EPUB, which could weigh several MB per book.
- **Bookmarks from the phone open on the desktop**: Bookmarks created in the PWA now store the book's file path and title, and the scroll position of the paragraph. The desktop can open them at the right place. A bookmark is reported as saved only if the file was actually written.
- **Reliable offline download**: A network or server error in the middle of a download now stops it with an error instead of saving a truncated book. A book with no readable chapter is not saved.
- **Clear errors**: API calls that get an error status now fail with a message instead of reading the error as if it were data.
- **Text size changes only the book**: The "Font size" setting of the PWA now enlarges only the book text. Before, it scaled the whole interface (headers, buttons, sheets).
- **Offline import over plain HTTP**: Book import no longer depends on `crypto.subtle`, which browsers do not provide on `http://<LAN address>` pages.

### 🛠️ Build & CI

- **Tests on every push**: A new `tests.yml` workflow runs the Vitest suites of both projects, the PWA type check and `cargo test` on pushes to `main` and on pull requests. A release is built only from a commit whose tests pass.
- **New dependencies**: `jszip` (translated EPUB export) and `qrcode-generator` (local QR code).
- **Removed unused code**: The old `intermediate-json`, `protocol-messages` and `translation-batcher` modules and their tests.
- **Dependency audit**: `npm audit` reports no vulnerabilities in either project. `@xmldom/xmldom` (used by epubjs) is pinned to 0.8.15 or later, Vite is updated to 6.4.6, and the PWA moves from Vitest 3 to Vitest 4.

### 🧪 Testing

- New Vitest suites: `translation-cache`, `book-export`, `library-scan`, `lazy-chunks`, `pro-segments`, `retry`, `storage-file`, `qr-code`, `text-limits`, `text-blocks`, `pdf-lazy-render`, `pdf-toc-mapping` and `tts-pause-prefetch`. On the PWA side: `sha256`, `text-limits` and `text-blocks`.
- New Vitest suite `pdf-layout` (paragraph selection, box style, page window and extraction cache). The PDF layout engine brings its Rust unit tests and its pipeline tests on sample pages (no text lost with any setting, drop caps, run-in headings, hanging indents, stitching across columns and pages, Tagged PDF).
- New Rust tests for password hashing and conversion of an old plain-text password, BASIC gating, byte-limit splitting, UTF-8-safe error truncation, error messages with the URL removed, and the bookmark scroll position.
- The Chinese locale had renamed placeholders (`libScanDone`), which broke the scan summary. They are fixed, and a test now checks that every locale uses the same placeholders as English.


## 📝 Changelog (v0.9.4 → v0.9.5)

### ⭐ Book Ratings

- **Rate your books from 1 to 5 stars**: In the desktop app, open the book details panel (ⓘ) and click a star. Click the current star again to remove the rating. Rated books show their stars on the Library card.
- **Rate from the phone**: In the PWA, tap the stars under a book in the library. If saving fails, the previous rating comes back and a message is shown. Books imported on the phone or downloaded for offline use keep their rating on the phone.
- **Filter by rating**: Both the desktop Library and the PWA have a rating filter next to the status filter: all ratings, an exact star count, or *Not rated*.
- **Synced with the desktop library**: Ratings set from the phone are saved in the desktop library file, and ratings set on the desktop show up on the phone. Before every save, the desktop takes the newer rating from disk, so a rating set from the phone is not overwritten by later desktop edits. Ratings can only be set from the phone for books that are in the desktop Library.
- **API**: New password-protected endpoint `PUT /api/books/{id}/rating` (body `{ "rating": 1-5 }`, or `null` to clear). The server changes only the rating fields of the matching library entry and writes the file atomically. It does not write if the file cannot be read.

### 🇧🇷 Brazilian Portuguese

- **New language `pt-BR`** for both translation and the interface, on desktop and in the PWA, with a Brazilian flag.
- **Two Portuguese variants**: The existing *Português* is now **Português (Portugal)**. Its interface text was rewritten in European Portuguese (*ficheiro*, *Definições*, *Transferir*…), and the previous Brazilian wording moved to *Português (Brasil)*.
- **Different translations for each variant**: Google treats `pt` as Brazilian Portuguese, so the European variant is now requested as `pt-PT` (FREE, BASIC, PRO and the PWA offline translator). Before, the Portuguese option always produced Brazilian Portuguese.

> [!NOTE]
> If you use Portuguese with Brazilian spelling, switch the translation and interface language to **Português (Brasil)**.

### 🔒 Desktop App Security

- **Sandboxed Original view**: The EPUB iframe in Original view now uses `sandbox="allow-same-origin"` without `allow-scripts`, so scripts embedded in a book no longer run. Before, they ran with the app's own origin and could reach the Tauri APIs. Link clicks, anchors and scroll sync are now handled from the parent window.
- **Whitelist HTML sanitizer**: New `src/html-sanitizer.js` replaces the old denylist (which only removed four event attributes). Text view, translated panel and image blocks now keep only allowed tags and attributes. Every `on*` handler, `<iframe>`, `<object>`, `<form>`, SVG animation and `<foreignObject>` is removed, along with scriptable URLs.
- **Safe external links**: `open_browser_url` accepts only absolute http(s) URLs. On Windows it opens them through `rundll32 url.dll,FileProtocolHandler` instead of `cmd /C start`, which treated `&` in a link as a command separator. The frontend applies the same validation.
- **Escaping fixes**: `escapeHtml` now also escapes quotes (it is used inside attributes). The *Clean Library* dialog now escapes book titles and paths.
- **Narrower filesystem permissions**: Writes are limited to the app data folder, plus files picked in a save dialog. Reads are still allowed anywhere, as the library needs that.
- **Stricter CSP**: `'unsafe-inline'` was removed from the desktop `script-src`.

### 🌐 LAN Web Server Hardening

- **Password protection**: Constant-time password check, with a 5-minute lockout after 10 wrong attempts from one IP.
- **Protected endpoints**: `POST /translate` (which can use your paid Google Cloud key) and `PUT /preferences` now require the password. The password and API key can only be changed from the desktop, through the new `set_web_server_secrets` command.
- **No cross-origin access**: The permissive CORS layer was removed, so web pages opened on the phone can no longer read your library. Security headers and a strict CSP are added to every response.
- **Sanitized chapter HTML**: The server rebuilds allowed tags with whitelisted attributes only, drops `javascript:` / `data:` links and decodes HTML entities in paragraph text.
- **Reliable server lifecycle**: Starting the server again on the same port returns the running instance. Starting it on a different port is refused, instead of leaving an unreachable server running. A server that stopped on an error is now reported as stopped.

### 🔖 Bookmarks Sync (Desktop ↔ Phone)

- **No more lost bookmarks**: The desktop no longer keeps an in-memory copy of the bookmarks forever. It reads them from disk and merges on every save (`src/bookmarks-sync.js`), so bookmarks created or deleted from the PWA survive desktop edits.
- **Safer server writes**: The server serializes bookmark and preference updates with locks. It also refuses to write when the bookmarks file cannot be parsed, where before it could overwrite the file with an empty list.

### ⚡ Performance & Robustness

- **EPUB caches**: Metadata, book paths and recently read chapters are cached in memory and invalidated when a file (or the desktop library) changes.
- **HTTP client**: A single shared HTTP client with connect and request timeouts is used for every translation call. A stalled endpoint can no longer hang translation.
- **Chapter count**: Chapter responses now include `totalChapters`, so clients know when they reach the end of the book.

### 📱 Web Client (PWA)

- **Back button**: The Android/browser back button returns to the library, or closes an open sheet, instead of closing the app.
- **Updates**: A new service worker version is applied on the next return to the library, so you never lose your reading position.
- **Progress and links**: Whole-book progress is calculated from chapter and scroll position. Footnote and cross-chapter links are resolved through the TOC.
- **Password prompt**: Password prompt and offline translation fixes.
- **App version in Settings**: The PWA Settings panel now shows the app version (Connection section).
- **Refresh translation**: A new button translates the current chapter again, bypassing the cache, which helps when a paragraph came back untranslated.
- **Steadier scrolling**: The card reading view no longer jumps when the browser tries to scroll the container on its own.

### 🏷️ Single Source for the Version Number

- The version is now defined only in `giano-reader/package.json`. `tauri.conf.json` reads it from there, and Vite injects it at build time into the desktop Settings panel and the PWA, so it no longer needs updating by hand in the code.

### 🧪 Testing

- New Vitest suites for the sanitizer (`html-sanitizer.test.js`) and bookmark merging (`bookmarks-sync.test.js`).
- New Rust tests for URL validation, auth lockout, sanitizer and entity decoding.
- New tests for book ratings: rating merge and filters (`library-sync.test.js`, `utils/rating.test.ts`), PWA library stars and filter (`library-screen.rating.test.ts`), local storage of ratings, and the Rust endpoint and atomic library write (`library_rating.rs`, `handlers/books.rs`).
- New Rust test for the Portuguese language codes sent to Google.
- Known issue: `i18n-locale.property.test.js` still reports missing keys in the `sv`, `uk` and `sl` locales. Run `node .antigravity/translate_i18n.mjs` to fill them.

---

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
