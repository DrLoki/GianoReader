# Giano Reader — User Manual

## Table of Contents

1. [Introduction](#introduction)
2. [Installation](#installation)
3. [Opening a Book](#opening-a-book)
4. [Main Interface](#main-interface)
5. [Reading and Navigation](#reading-and-navigation)
6. [Translation](#translation)
7. [Library](#library)
8. [Bookmarks](#bookmarks)
9. [Web Server Mode](#web-server-mode)
10. [How to Access Remotely via Tailscale](#web-access-with-tailscale)
11. [Settings](#settings)
12. [FAQ](#faq)

---

## Introduction

**Giano Reader** is a desktop EPUB reader with built-in side-by-side translation via Google Translate and OpenRouter. It displays the original text and the translation in two synchronized panels, translating lazily starting from your current reading position.

It works as a desktop application (Windows, macOS, Linux) via Tauri, and in a limited fallback mode in the web browser.

Starting with **v0.9.0**, Giano Reader includes a **Web Server Mode** that lets you read your EPUB library from any device on your local network (phone, tablet, another computer) through a mobile-first web interface — no app installation required on the client device.

---

## Installation

### Windows

1. Download the `.msi` or `.exe` installer from the releases page.
2. Run the file and follow the setup wizard.
3. Once completed, launch **Giano Reader** from the Start Menu or desktop.

> **Requirement:** WebView2 Runtime. It is pre-installed in Windows 11; on Windows 10 it is installed automatically if not already present.

### macOS

1. Download the `.dmg` file.
2. Open the `.dmg` and drag the app into the **Applications** folder.
3. On first launch, if macOS blocks the app (unverified developer), go to **System Settings → Privacy & Security** and click **Open Anyway**.

### Linux

1. Download the `.deb` package (Debian/Ubuntu) or `.AppImage`.
2. For the `.deb`: `sudo dpkg -i giano-reader_*.deb`
3. For the `.AppImage`: make the file executable (`chmod +x`) and run it directly.

---

## Opening a Book

Click the **+ Open book** button in the left sidebar. A native file dialog will open to let you select an `.epub` file.

Once the book is loaded:

- The title and author will appear at the top of the sidebar.
- The table of contents (TOC) is populated automatically.
- The first chapter containing actual text will be displayed.
- The book is added automatically to the Library (desktop app only).

> **Browser Note:** In the web browser, the native dialog is not available. A standard `<input type="file">` is used instead. Library management and automatic bookmark reopening require the desktop app.

---

## Main Interface

```text
┌──────────────────┬───────────────────────┬──────────────────────┐
│          Sidebar │        Original Panel │    Translation Panel │
│                  │                       │                      │
│   + Open book    │   Original text       │   Translated text    │
│   ─────────────  │   of the chapter      │   (lazy, from        │
│   TOC (Index)    │                       │    reading point)    │
│                  │                       │                      │
│   [Bookmarks]    │                       │                      │
│   [Library]      │                       │                      │
│   [Settings]     │                       │                      │
└──────────────────┴───────────────────────┴──────────────────────┘
             Progress bar with tick marks per chapter
```

### Progress Bar

The bar at the bottom shows your reading position. Each tick mark corresponds to a chapter in the EPUB spine. Hovering over a tick shows the chapter title; clicking it navigates directly to that chapter.

### Sidebar Buttons

| Button | Function |
| --- | --- |
| **+ Open book** | Opens an EPUB file |
| Bookmark icon | Opens the bookmarks modal |
| Star icon | Adds a bookmark at the current position |
| Library icon | Opens the Library |
| Gear icon | Opens Settings |
| Arrows icon | Hides/shows the translation panel |
| Image icon | Toggles between text view and original EPUB view |

---

## Reading and Navigation

### Chapter Navigation

- Use the **‹** and **›** buttons on the sides of the progress bar.
- Click a chapter title in the **table of contents** in the sidebar.
- Click a **tick mark** on the progress bar.

### Scrolling

The two panels (original and translation) scroll in a synchronized manner: moving one causes the other to scroll proportionally.

**Keyboard Shortcuts:**

| Key | Action |
| --- | --- |
| `↓` / `↑` | Scrolls by 3 lines |
| `Space` | Scrolls down by one page |
| `Shift + Space` | Scrolls up by one page |

### Original EPUB View

Click the **image** icon (file-image) to toggle the original EPUB view: the chapter is rendered in an iframe with its native, original EPUB styling. In this mode, synchronized scrolling is disabled. Internal links within the book work normally.

### Paragraph-Level Helpers & Interactive Alignment

To make comparative reading natural and highly efficient, Giano Reader features three interactive paragraph-level helpers:

- **Synchronized Hover Highlight:** By default, hovering over any paragraph in either the original or the translation panel will instantly highlight it with a subtle background tint and a colored border at the side. In perfect synchronization, the corresponding paragraph in the opposite panel is highlighted as well, letting you easily track complex narratives. This is fully compatible with RTL (Right-to-Left) layouts like Arabic.
- **Chromatic Paragraph Pairing:** Click the **Palette** icon in the translation header to toggle chromatic pairing. When active, adjacent paragraphs in the original and translated panels are color-coded in alternating HSL colors. Giano Reader dynamically uses customized palettes optimized separately for light and dark/nord/solarized backgrounds to maintain high text contrast and readability.
- **Paragraph Numbers Toggle:** Click the **#** (hash) icon in the translation header to toggle inline paragraph numbers. This displays small, unobtrusive numbers at the start of each text block, aiding in precise academic comparison and line-by-line verification across both languages.

---

## Translation

### Dual Translation Mode (FREE / BASIC / PRO)

Giano Reader supports a three-tier translation architecture to meet different needs — from zero-config simplicity to commercial-grade quality to AI-powered literary excellence:

#### 1. FREE Mode (Google Translate)

The basic translation uses the unofficial public endpoint of Google Translate (`translate.googleapis.com`) — **no API key required**. Text is split into ~4500-character chunks and translated **lazily**:

- Upon loading a chapter, the visible block is translated immediately.
- As you scroll down, subsequent blocks are automatically translated.
- Previous blocks (above the initial position) are translated in the background.

#### 2. BASIC Mode (Google Cloud Translation API v3)

For higher-quality translations without requiring an LLM, you can activate **BASIC** mode which uses the official Google Cloud Translation API v2:

- **Activation:** Configure your Google Cloud API Key in **Settings → Basic** tab. Once configured, the **BASIC** option appears in the translation mode dropdown in the sidebar.
- **Advantages over FREE:** The official API provides more accurate NMT translations, is not subject to CORS restrictions or aggressive rate limiting of the free endpoint, and uses native array-based translation (no paragraph joining/splitting workaround), supporting batches of up to ~25,000 characters and 128 paragraphs per request.
- **Cost:** Approximately $0.01–0.02 per average novel. Free tier includes 500,000 characters/month. See the [Google Cloud Setup Guide](GOOGLE_CLOUD_SETUP.md) for detailed pricing.

> **Setup:** See [`GOOGLE_CLOUD_SETUP.md`](GOOGLE_CLOUD_SETUP.md) for a complete step-by-step guide on creating a Google Cloud project, enabling the API, and obtaining an API key.

#### 3. PRO Mode (OpenRouter API)

For a premium, context-aware translation that preserves literary style, nuances, and vocabulary consistency, you can activate the **PRO** mode based on the **OpenRouter** API:

- **Activation:** Paste a valid API Key in **Settings → PRO** tab. As soon as it is entered and a model is selected, the **PRO** option will appear in the translation mode dropdown in the sidebar.
- **Model Selection:** You can load the list of available models directly from OpenRouter servers and select your preferred one. Fast and efficient models are highly recommended (such as `google/gemini-2.5-flash` or `meta-llama/llama-3-8b-instruct`) to reduce response times to just a few seconds.
- **Timing & Network:** When using PRO mode, OpenRouter uses *Chunked Transfer Encoding*. Consequently, the translation is generated in the background and rendered as soon as it is finished; paragraphs currently being translated remain grayed out until the process completes.

### Changing Translation Language

Use the dropdown menu with flags in the sidebar. Changing the language automatically restarts the translation of the current chapter in the active mode.

### Hiding the Translation Panel

Click the **arrows** icon (arrows-left-right-to-line) to hide or show the translation panel. This is useful for reading the original text full-screen.

---

## Library

The Library gathers your EPUB files in a single view with covers, metadata, and reading status. It is available exclusively in the desktop app (Tauri).

### Opening the Library

Click the **library** icon in the sidebar to open the modal containing your book grid.

---

### Adding Books to the Library

There are two ways to populate your Library:

#### 1. Automatic Addition on Open

Every time you open an EPUB file via **+ Open book**, the book is automatically added to the Library (if not already present). The cover is extracted in the background and updated as soon as it becomes available.

#### 2. Scanning a Folder

This is the primary method for importing an existing collection:

1. Open the Library by clicking the library icon.
2. Click the **Select folder** button (upload icon).
3. Choose the root folder that contains your EPUB files.
4. Giano Reader scans the folder and its subfolders up to the configured scan depth (default: 3 levels).
5. For every `.epub` file found, Giano Reader automatically extracts: title, author, publisher, year, language, description, cover, and estimated page count.
6. Upon completion, a summary is displayed: *"Scan complete: X added, Y already in library."*

> **Scan Depth:** You can change the number of nested subfolder levels explored in **Settings** (using the *Search depth* field, value from 1 to 10). Increase this value if you have a highly nested folder hierarchy.

#### 3. Importing from a JSON File

If you have previously exported your Library (or want to transfer it from another device):

1. Open the Library.
2. Click the **import** icon (up arrow).
3. Select the previously exported `.json` file.
4. The books are added to the existing ones; duplicates (matching file paths) are ignored.

---

### Navigating the Library

- **Search** by title or author using the search field at the top of the modal.
- **Filter by status** using the dropdown menu (All / To read / Reading / Read).
- Click a **card** to open the book directly in the reader.

---

### Book Details Panel (Details & Notes)

Each card has an **ⓘ** button that opens the book details panel. From here you can:

- Edit title, author, publisher, year, language.
- Set the **reading status**: To read / Reading / Read.
- Add freeform **personal notes**.
- View file information (name, size, estimated pages).
- **Delete** the book from the Library (does not delete the actual file from disk).

Click **Save** to confirm changes.

> When you open a book from the Library, its status automatically changes from *To read* to *Reading* (unless it was already set to *Reading* or *Read*).

---

### Exporting the Library

1. Open the Library.
2. Click the **export** icon (down arrow).
3. Choose where to save the `giano-library.json` file.

The JSON file contains all metadata and covers (as data URLs). It can be re-imported on another device or used as a backup.

---

### Clearing the Library

Click the **trash** icon (lib-clear) in the Library toolbar. You will be prompted to confirm before proceeding. This operation removes all records from the Library but **does not delete the EPUB files from your disk**.

---

## Bookmarks

### Adding a Bookmark

1. Navigate to the chapter and position you want to save.
2. Click the **star** icon in the sidebar.

The bookmark saves: absolute file path, current chapter, and scroll position (percentage).

> The star button is only active when a book is opened in the desktop app (which provides absolute file paths).

### Opening a Bookmark

1. Click the **bookmark** icon to open the modal.
2. Click the title or icon of the desired bookmark.
3. The file is opened, and reading resumes from the saved chapter and position.

If the file has been moved or renamed, a file picker dialog will prompt you to locate it manually. The path is then updated automatically for all future openings.

### Importing / Exporting Bookmarks

Use the **import** and **export** buttons in the bookmarks modal to save or load bookmarks as a `giano-bookmarks.json` file.

---

## Web Server Mode

**New in v0.9.0.** Web Server Mode turns your GianoReader desktop app into a local HTTP server, allowing any device on your LAN (phone, tablet, etc.) to access your EPUB library and read with lazy translation through a mobile-optimised web interface.

### Enabling Web Server Mode

1. Open **Settings** (gear icon in the sidebar).
2. Find the **Web Server Mode** section (visible only in the desktop app).
3. Optionally change the **port** (default: 8888, range 1024–65535).
4. Toggle the switch **ON**.
5. A QR code and URL are displayed (e.g. `http://192.168.1.42:8888`).
6. Scan the QR code or type the URL on your mobile device's browser.

### Password Protection

You can optionally protect access to your library and bookmarks with a password:

1. Open **Settings → Web Server** tab.
2. Enter a password in the **Password** field (below the Cloudflare Worker Subdomain).
3. The password is synced to the running server automatically.

When a password is set:

- The web client shows a login prompt on first access.
- Entering the correct password grants full access to the library, bookmarks, reading state, and chapters.
- Entering an incorrect password (or leaving the field empty and clicking "Sign in") enters **Guest Mode**: the user can still load a local EPUB file and read/translate it, but cannot browse the server library or bookmarks.
- **Translation in Guest Mode**: if a Google Cloud API Key has been configured on the server, BASIC translation mode is available even in guest mode (the `/api/translate` endpoint is public and does not require authentication). The user can select BASIC in the translation mode dropdown in settings.
- Book covers are always accessible without password (they are loaded via `<img>` tags which cannot send authentication headers).

To remove password protection, clear the Password field in Settings.

### Web Client Features

The mobile web interface provides:

- **Library grid** — browse all your EPUB books with covers and progress.
- **Card UI reading** — swipe or tap between Original and Translated text cards.
- **Lazy translation** — paragraphs are translated on-the-fly as you scroll, using the same Google Translate engine (FREE mode) or Google Cloud Translation API (BASIC mode).
- **Bookmarks** — save and navigate bookmarks from your phone.
- **Settings** — change theme (light/dark/sepia), font size, translation language, and UI language.
- **Reading progress sync** — your position is saved automatically and restored on reconnect.

### Network Requirements

- Both the desktop computer (server) and the mobile device (client) must be on the same local network (Wi-Fi/LAN).
- The web client requires an active connection to the server; it does not work offline.
- If no LAN IP is available, the server URL shows `127.0.0.1` with a warning that other devices cannot connect.

### Stopping the Server

Toggle the switch **OFF** in Settings, or close GianoReader. The server stops accepting connections within 2 seconds.

---

## Web Access With Tailscale


Using **Tailscale** is the safest and easiest way to access your locally hosted instance of the [Giano Reader](https://github.com/DrLoki/GianoReader/blob/main/RELEASE.md) web app from your smartphone or tablet, without exposing your home network to the public internet.

This guide will walk you through the setup process step by step.

## Prerequisites
* **The Host Machine (Server):** The computer (Windows, macOS, or Linux) currently running the Giano Reader web app.
* **A Mobile Device:** Your Android or iOS smartphone/tablet.
* **A Tailscale Account:** It's completely free for personal use.

---

### Step 1: Install Tailscale on the Host Machine

1. Go to [Tailscale.com](https://tailscale.com/) and create a free account.
2. Download and install the Tailscale client for your host machine's operating system.
3. Open the Tailscale app and **log in** with your account.
4. Once connected, Tailscale will assign a private IP address to your machine (it usually starts with `100.x.x.x`). 
5. Find this IP address by clicking the Tailscale icon in your system tray/menu bar. **Copy this IP**—you will need it later.

### Step 2: Configure Giano Reader for Network Access

Enable the Web Server mode from the Giano Reader settings and note the port on which the app is exposed (by default 8888).

### Step 3: Install Tailscale on Your Mobile Device

1. Open the **App Store** (iOS) or **Google Play Store** (Android).
2. Search for and install the **Tailscale** app.
3. Open the app, agree to the VPN configuration prompts, and **log in using the exact same account** you used on your host machine.
4. Make sure the toggle switch in the app is set to **Active / Connected**. 

*(Your phone is now securely connected to the same virtual local network as your computer).*

### Step 4: Access Giano Reader from Your Smartphone or Desktop Browser

1. Open your preferred mobile or desktop browser (Chrome, Safari, Edge, etc.).
2. In the address bar, type your host machine's Tailscale IP address or local LAN IP followed by the Giano Reader port (default port is `8888`). 
   
   **Format:** `http://<IP-Address>:<Port>`
   **Example:** `http://100.115.92.4:8888` or `http://localhost:8888`

3. Press Enter. The Giano Reader web client will load.

> [!TIP]
> **Installing Giano Reader as a PWA (Progressive Web App):**
> Giano Reader is a full Progressive Web App and can be installed as a standalone app on both mobile devices and desktop computers:
>
> * **On iOS (Safari):** Tap the **Share** icon at the bottom of the screen, scroll down, and tap **"Add to Home Screen"**.
> * **On Android (Chrome):** Tap the **3-dot menu** in the top right corner and select **"Add to Home screen"** or **"Install app"**.
> * **On Desktop (Chrome / Edge):**
>   - If accessing via `http://localhost:8888` or `http://127.0.0.1:8888`, click the **Install** icon in the address bar (or 3-dot menu → **"Install Giano Reader..."**).
>   - If accessing via a **LAN / Tailscale IP** (e.g. `http://192.168.1.5:8888` or `http://100.x.x.x:8888`), Chromium blocks PWA installation on non-localhost HTTP by default. To enable installation:
>     1. Navigate to `chrome://flags/#unsafely-treat-insecure-origin-as-secure` in Chrome (or `edge://flags` in Edge).
>     2. Add your server URL (e.g. `http://192.168.1.5:8888,http://100.115.92.4:8888`).
>     3. Set the flag to **Enabled** and click **Relaunch**.
>     4. Reload the Giano Reader page and the **Install** button will appear in the address bar.

### 💡 Zero-Configuration Alternative: Automatic HTTPS with Tailscale Serve

If you prefer not to configure flags on individual client browsers, you can enable native HTTPS across your entire Tailscale network with a single command on your host computer:

1. Enable **MagicDNS** and **HTTPS Certificates** in your [Tailscale Admin Console](https://login.tailscale.com/admin/dns).
2. On your host machine (where Giano Reader is running with Web Server Mode enabled on port `8888`), open a terminal and run:
   ```bash
   tailscale serve --bg https / http://127.0.0.1:8888
   ```
3. Tailscale will automatically provision a valid, trusted TLS/SSL certificate and assign an HTTPS URL for your device:
   ```
   https://<your-machine-name>.<your-tailnet>.ts.net
   ```

**Key Advantages:**
* **Instant PWA Installation:** Because the connection is recognized as a genuine Secure Context (HTTPS), Chrome and Edge on both desktop and mobile will immediately show the native **Install App** button without any need to touch `chrome://flags`.
* **Complete Offline Support:** Service Workers register and precache books and chapters automatically.
* **End-to-End Encryption:** Encrypted network transport across your private Tailscale network.

---

## Settings

Open Settings by clicking the **gear** icon in the sidebar.

| Setting | Description |
| --- | ---|
| **Interface language** | UI text language (21 languages available with automatic i18n alignment) |
| **Theme** | Dark (default), Light, Monokai, Solarized Dark, Nord, Sepia |
| **Font** | Font family for reading text |
| **Font size** | Slider from 12px to 32px |
| **Search depth** | Subfolder depth level for library scanning (1–10, default 3) |
| **Google Cloud API Key** | API key for Google Cloud Translation API v2 (for BASIC mode). See [`GOOGLE_CLOUD_SETUP.md`](GOOGLE_CLOUD_SETUP.md) |
| **OpenRouter API Key** | API Key to enable advanced PRO translation using artificial intelligence models |
| **Fetch models** | Clicking the button fetches the list of available models from OpenRouter |
| **OpenRouter Model (PRO)** | Dropdown selector to choose the LLM model to use for PRO translations |
| **Cloudflare Worker Subdomain** | Cloudflare subdomain prefix for your CORS proxy worker (e.g. `happy-reader` to use `https://giano-translate-proxy.happy-reader.workers.dev`). If empty, direct Google Translate endpoint is used. |
| **Password** | Optional password to protect the Web Server. When set, accessing the library and bookmarks from the web client requires entering this password. Translation and preferences remain accessible without authentication. |
| **Web Server Mode** | Toggle to start/stop the embedded HTTP server for mobile access (default port: 8888) |

All settings are saved automatically. In the desktop application (Tauri), the Library and Bookmarks databases are stored in dedicated JSON files directly in the filesystem (`giano-library.json` and `giano-bookmarks.json` in the app's standard data directory), permanently bypassing browser storage quota limitations (`localStorage`) and avoiding "storage quota exceeded" errors when importing large ebook collections.

---

## FAQ (Frequently Asked Questions)

**The book won't open or stays stuck on loading.**
Some EPUBs generated by Calibre may take longer than usual to load. Wait up to 20 seconds. If the problem persists, try re-exporting the file from Calibre as an EPUB 2 file.

**The translation doesn't start or shows errors.**
Check your internet connection. The FREE Google Translate endpoint is unofficial and may be subject to CORS or temporary blocks. You can set up your own Cloudflare Worker CORS proxy (see `CLOUDFLARE_WORKER_SETUP.md`) and enter your subdomain in Settings under **Cloudflare Worker Subdomain**. Alternatively, configure Google Cloud Translation API for BASIC mode (see [`GOOGLE_CLOUD_SETUP.md`](GOOGLE_CLOUD_SETUP.md)) or an OpenRouter API key for PRO AI translation.

**Bookmarks do not open automatically.**
Automatic bookmark reopening requires the desktop application (Tauri). In the browser, you will need to open the file manually and navigate to the indicated chapter.

**The Library cannot find my EPUB files.**
Check the **Search depth** in Settings: if your files are stored in deeply nested subfolders, increase this value (e.g., from 3 to 5 or higher) and scan the folder again.

**The cover does not appear in the Library.**
Some EPUBs do not define a cover image in their manifest. In this case, GianoReader displays a generic cover placeholder. This is not an error.

**How do I remove a book from the Library without deleting it from disk?**
Open the book details panel (the **ⓘ** button) and click **Remove from library**. The actual EPUB file remains completely intact on your disk.

**I enabled Web Server Mode but my phone can't connect.**
Make sure both devices are on the same Wi-Fi network. Check that your firewall is not blocking the port (default 8888). If the URL shows `127.0.0.1`, your computer has no LAN IP — try connecting to a network with a router.

**The web client shows "Disconnected".**
GianoReader must be running with Web Server Mode active. If you closed the app or toggled the server off, the web client loses connectivity. Reopen GianoReader, enable Web Server Mode, and tap "Reconnect" on the phone.

**How do I open the browser DevTools for debugging?**
Launch the application with the `--dev` flag to enable DevTools (F12). For example on Windows: `"C:\Program Files\Giano Reader\Giano Reader.exe" --dev`. This opens the WebView2 developer console on startup, useful for diagnosing translation errors, network issues, or TTS failures. Without the flag, DevTools are disabled in production builds.

**Why doesn't the PWA "Install" button appear in Chrome or Edge on desktop?**
Chromium browsers require a Secure Context (HTTPS or `localhost`) to register Service Workers and allow PWA installation. If you are opening Giano Reader on another PC using a LAN IP (e.g. `http://192.168.1.5:8888`), Chromium marks HTTP as insecure and disables installation. To enable it:
1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` in Chrome (or `edge://flags` in Edge).
2. Enter the server origin (e.g. `http://192.168.1.5:8888`).
3. Set the option to **Enabled** and click **Relaunch**.
4. Refresh the page to see the **Install** button.

**I set a password but other users can still see book covers.**
This is by design. Book covers are served publicly because web browsers load `<img>` tags without the ability to send authentication headers. The library listing, bookmarks, reading state, and chapter content remain protected.

**I entered the wrong password on the web client and now I'm in offline mode. How do I retry?**
Open the settings sheet in the web client and tap "Switch back to Server mode (Online)". This clears the offline flag and reloads the page, showing the password prompt again.
