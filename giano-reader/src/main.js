import ePub from 'epubjs';
import { translateParagraphs } from './translator.js';
import { t, RTL_LANGS } from './i18n.js';
import { clampSearchDepth } from './settings-utils.js';
import { sanitizeTree, isExternalHttpUrl, isSafeResourceUrl, escapeHtmlText } from './html-sanitizer.js';
import { bookmarkKey, mergeBookmarkLists } from './bookmarks-sync.js';
import { normalizeRating, setEntryRating, matchesRatingFilter, ratingStars, mergeLibraryRatings } from './library-sync.js';
import { StorageReadError, readJsonFile, writeJsonFileAtomic } from './storage-file.js';
import { TEXT_BLOCK_TAGS, ownTextSource } from './text-blocks.js';
import { retryWithBackoff, abortableDelay } from './retry.js';
import { qrCodeDataUrl } from './qr-code.js';
import { fileFingerprint, planScan, mergeReanalysis, markEditedFields, pathKey, samePath, dedupeLibrary } from './library-scan.js';
import { filterLibrary, sortLibrary, normalizeLibrarySort } from './library-view.js';
import { BookTranslationCache, textKey, variantKey, parseVariant, mergeCacheData } from './translation-cache.js';
import { buildTranslatedEpub, buildEpubFromChapters, translatedFileName } from './book-export.js';
import { observeChunksLazily } from './lazy-chunks.js';
import { alignByParagraph, syncByParagraph, paragraphOffset } from './paragraph-align.js';
import {
  getBasicUsage, usageSummary, basicQuotaStatus, normalizeWarnPct, setBasicAutoFree,
  monthKey, BASIC_USAGE_EVENT,
} from './basic-usage.js';
import { hideMissingFontOptions } from './font-availability.js';
import { PdfProgress } from './pdf-progress.js';
import { getReadingPosition, setReadingPosition, samePosition, resolveRestoreTarget } from './reading-positions.js';
import JSZip from 'jszip';

// Pause before the 2nd and 3rd attempt at translating a failed block
const TRANSLATION_RETRY_DELAYS_MS = [1500, 4000];
// App version, injected by Vite at build time by reading package.json
// (see vite.config.js): it no longer needs to be updated by hand in the code.
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
import { loadPdf, checkFileSize, validateTextContent, PdfNavigator, extractChapterText, extractPageText, renderPdfCanvas, renderPdfPageShells, renderPdfWithOverlayPlaceholders, renderPdfCoverDataUrl } from './pdf.js';
import { PdfLayoutAnalyzer, selectParagraphs, paragraphTextsForRange, createSegmentBox, fillSegment, restyleSegments } from './pdf-layout.js';
import { clearSegmentationCache } from './pdf-xycut-segmenter.js';
import ttsController, { isProModeAvailable, makeDownloadFilename, LANG_TO_BCP47 } from './tts.js';

// ── Application state ──────────────────────────────────────────────────────
let book = null;                    // current epubjs instance
let currentSpineItems = [];         // list of EPUB spine chapters
let currentSpineIndex = 0;          // current chapter index
let currentChapterParagraphs = [];  // paragraphs of the current chapter
let currentChapterBody = null;      // DOM body of the current chapter (for anchor navigation)
let chapterLengths = [];            // text length per chapter (in characters)
let chapterCumulativePct = [];      // cumulative % position of each chapter (0–100)
let syncingScroll = false;          // lock to avoid loops in synchronized scrolling
let syncScrollEnabled = true;       // sync scroll on/off (user toggle, default on)
let syncOffsetPct = 0;              // offset (percentage delta) kept between the two panels
let syncOffsetPx = 0;               // text view: offset (px) of the right panel from the paragraph-aligned position
let translationAbortController = null;
let lazyObserver = null;            // IntersectionObserver for lazy translation
let currentFilePath = null;         // absolute path of the open file (Tauri only)
let currentViewMode = 'text';       // 'text' | 'original'
let currentFileType = null;         // 'epub' | 'pdf'
let pdfDoc = null;                  // PdfDocument instance (null when EPUB)
let pdfAnalyzer = null;             // PdfLayoutAnalyzer (layout engine cache for the open PDF)
let pdfNav = null;                  // PdfNavigator instance (null when EPUB)
let currentPdfHash = '';            // Stable hash for the current PDF (used for segmentation cache)

const LAZY_CHUNK = 12; // paragraphs per lazy translation chunk
let ttsTranslateChunk = null; // Exposed translateChunk for TTS on-demand translation
let translatedChunksRef = null; // Reference to translatedChunks Set for TTS retry

const DEFAULT_MAX_FILE_SIZE_MB = 150;
const DEFAULT_WARN_FILE_SIZE_MB = 50;

// ── Riferimenti DOM ────────────────────────────────────────────────────────
const openBtn = document.getElementById('open-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const pageInfo = document.getElementById('page-info');
const progressTrack = document.getElementById('progress-track');
const progressFill = document.getElementById('progress-fill');
const progressThumb = document.getElementById('progress-thumb');
const progressTicks = document.getElementById('progress-ticks');
const progressTooltip = document.getElementById('progress-tooltip');
const langSelect = document.getElementById('lang-select');
const originalViewer = document.getElementById('original-viewer');
const translationViewer = document.getElementById('translation-viewer');
const translationLangLabel = document.getElementById('translation-lang-label');
const translationStatus = document.getElementById('translation-status');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const noBookPlaceholder = document.getElementById('no-book-placeholder');
const tocList = document.getElementById('toc-list');
const tocPlaceholder = document.getElementById('toc-placeholder');
const bookInfo = document.getElementById('book-info');
const bookTitle = document.getElementById('book-title');
const bookAuthor = document.getElementById('book-author');
const coverImg = document.getElementById('cover-img');
// Sidebar cover: without an image the <img> is hidden, because an empty `src`
// resolves to the page URL and shows the broken-image icon.
function setSidebarCover(url) {
  if (url) {
    coverImg.src = url;
    coverImg.classList.remove('hidden');
  } else {
    coverImg.removeAttribute('src');
    coverImg.classList.add('hidden');
  }
}
// Bookmarks
const addBookmarkBtn = document.getElementById('add-bookmark-btn');
const bookmarksList = document.getElementById('bookmarks-list');
const bookmarksPlaceholder = document.getElementById('bookmarks-placeholder');
const bookmarksModal = document.getElementById('bookmarks-modal');
const bookmarksOpenBtn = document.getElementById('bookmarks-open-btn');
const bmCloseBtn = document.getElementById('bm-close-btn');
const bmImportBtn = document.getElementById('bm-import-btn');
const bmExportBtn = document.getElementById('bm-export-btn');
const bmImportInput = document.getElementById('bm-import-input');
const bmSearchInput = document.getElementById('bm-search-input');
const bookmarkMissingModal = document.getElementById('bookmark-missing-modal');
const bmMissingName = document.getElementById('bm-missing-name');
const bmRelocateBtn = document.getElementById('bm-relocate-btn');
const bmCancelBtn = document.getElementById('bm-cancel-btn');
// Settings
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const uiLangSelect = document.getElementById('ui-lang-select');
const themeSelect = document.getElementById('theme-select');
const fontFamilySelect = document.getElementById('font-family-select');
const fontSizeRange = document.getElementById('font-size-range');
const fontSizeValue = document.getElementById('font-size-value');
const searchDepthInput = document.getElementById('search-depth-input');
// File size limits
const maxFileSizeMbInput = document.getElementById('max-file-size-mb');
const warnFileSizeMbInput = document.getElementById('warn-file-size-mb');
const optimalLimitBtn = document.getElementById('optimal-limit-btn');
const ramAdvisorError = document.getElementById('ram-advisor-error');
// View toggle — switches between Text_Mode and Original_Mode
const viewToggleBtn = document.getElementById('view-toggle-btn');
const toggleSyncBtn = document.getElementById('toggle-sync-btn');
const syncDisabledNotice = document.getElementById('sync-disabled-notice');
const originalNative = document.getElementById('original-native');
// Hide translation toggle — hides/shows the translation panel
const hideTranslationBtn = document.getElementById('hide-translation-btn');
const translationPanel = document.getElementById('translation-panel');
const divider = document.getElementById('divider');
const hideOriginalBtn = document.getElementById('hide-original-btn');
const originalPanel = document.getElementById('original-panel');

const togglePairingBtn = document.getElementById('toggle-pairing-btn');
const toggleNumbersBtn = document.getElementById('toggle-numbers-btn');
const viewerWrapper = document.getElementById('viewer-wrapper');
const translationModeSelect = document.getElementById('translation-mode-select');
const openrouterKeyInput = document.getElementById('openrouter-key-input');
const openrouterModelSelect = document.getElementById('openrouter-model-select');
const gcloudApiKeyInput = document.getElementById('gcloud-api-key-input');
const basicWarnPctInput = document.getElementById('basic-warn-pct');
const basicAutoFreeToggle = document.getElementById('basic-auto-free');
/** How long the BASIC quota notices stay on screen. */
const BASIC_NOTICE_MS = 8000;

// Web Server Mode
const webServerSettings = document.getElementById('web-server-settings');
const webServerToggle = document.getElementById('web-server-toggle');
const webServerPort = document.getElementById('web-server-port');
const webServerError = document.getElementById('web-server-error');
const webServerInfo = document.getElementById('web-server-info');
const webServerUrl = document.getElementById('web-server-url');
const webServerQr = document.getElementById('web-server-qr');
const webServerWarning = document.getElementById('web-server-warning');

// TTS Controls
const ttsPlayBtn = document.getElementById('tts-play-btn');
const ttsStopBtn = document.getElementById('tts-stop-btn');
const ttsPanelSelect = document.getElementById('tts-panel-select');
const ttsRate = document.getElementById('tts-rate');
const ttsRateValue = document.getElementById('tts-rate-value');
const ttsPitch = document.getElementById('tts-pitch');
const ttsPitchValue = document.getElementById('tts-pitch-value');
const ttsVoiceSelect = document.getElementById('tts-voice-select');
const ttsModeSelect = document.getElementById('tts-mode-select');
const ttsModelSelect = document.getElementById('tts-model-select');
const ttsDownloadBtn = document.getElementById('tts-download-btn');
const ttsProgress = document.getElementById('tts-progress');

let translationHidden = false;
let originalHidden = false;
let pairingEnabled = false;
let showNumbers = false;

hideTranslationBtn.addEventListener('click', () => {
  translationHidden = !translationHidden;
  translationPanel.classList.toggle('hidden', translationHidden);
  divider.classList.toggle('hidden', translationHidden || originalHidden);
  hideTranslationBtn.setAttribute('aria-pressed', String(translationHidden));
  hideTranslationBtn.classList.toggle('active', translationHidden);

  if (!translationHidden) {
    if (currentViewMode === 'text' && currentChapterParagraphs && currentChapterParagraphs.length) {
      const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
      const scrollPct = scrollMax > 1 ? Math.round((originalViewer.scrollTop / scrollMax) * 100) : 0;
      translateCurrentChapter(scrollPct);
      if (scrollPct > 0) {
        restoreScrollPct(scrollPct);
      }
    } else if (currentViewMode === 'original' && currentChapterParagraphs && currentChapterParagraphs.length) {
      // Original view (EPUB or PDF): regenerates the translation in the right panel
      translateCurrentChapter(0);
    }
  } else {
    if (translationAbortController) {
      translationAbortController.abort();
      translationAbortController = null;
    }
    setTranslationStatus('');
    translationViewer.innerHTML = '';
  }
  updateSyncUi();
});

hideOriginalBtn.addEventListener('click', () => {
  originalHidden = !originalHidden;
  originalPanel.classList.toggle('hidden', originalHidden);
  divider.classList.toggle('hidden', originalHidden || translationHidden);
  hideOriginalBtn.setAttribute('aria-pressed', String(originalHidden));
  hideOriginalBtn.classList.toggle('active', originalHidden);

  if (!originalHidden) {
    // If the original panel is shown again, sync its scroll position from the translation panel
    const transMax = Math.max(1, translationViewer.scrollHeight - translationViewer.clientHeight);
    const scrollPct = transMax > 1 ? (translationViewer.scrollTop / transMax) : 0;
    const max = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
    originalViewer.scrollTop = Math.round(scrollPct * max);
  }
});

togglePairingBtn.addEventListener('click', () => {
  pairingEnabled = !pairingEnabled;
  viewerWrapper.classList.toggle('pairing-enabled', pairingEnabled);
  togglePairingBtn.setAttribute('aria-pressed', String(pairingEnabled));
  togglePairingBtn.classList.toggle('active', pairingEnabled);

  const s = loadSettings();
  s.pairingEnabled = pairingEnabled;
  saveSettings(s);
});

toggleNumbersBtn.addEventListener('click', () => {
  showNumbers = !showNumbers;
  viewerWrapper.classList.toggle('show-numbers', showNumbers);
  toggleNumbersBtn.setAttribute('aria-pressed', String(showNumbers));
  toggleNumbersBtn.classList.toggle('active', showNumbers);

  const s = loadSettings();
  s.showNumbers = showNumbers;
  saveSettings(s);
});

// Bidirectional synchronized hover between the panels
viewerWrapper.addEventListener('mouseover', e => {
  if (pairingEnabled || showNumbers) return;
  const p = e.target.closest('.text-panel p[data-idx]');
  if (!p) return;
  const idx = p.dataset.idx;
  const pair = viewerWrapper.querySelectorAll(`.text-panel p[data-idx="${idx}"]`);
  pair.forEach(el => el.classList.add('para-highlight'));
});

viewerWrapper.addEventListener('mouseout', e => {
  if (pairingEnabled || showNumbers) return;
  const p = e.target.closest('.text-panel p[data-idx]');
  if (!p) return;
  const idx = p.dataset.idx;
  const pair = viewerWrapper.querySelectorAll(`.text-panel p[data-idx="${idx}"]`);
  pair.forEach(el => el.classList.remove('para-highlight'));
});


// ── Custom flag dropdown ───────────────────────────────────────────────────
const FLAG_MAP = {
  it: 'it', en: 'gb', fr: 'fr', de: 'de', es: 'es',
  pt: 'pt', 'pt-BR': 'br', ru: 'ru', zh: 'cn', ja: 'jp', ar: 'sa',
  fil: 'ph', sq: 'al', hi: 'in', ko: 'kr', th: 'th',
  bn: 'in', id: 'id', sv: 'se', uk: 'ua', sl: 'si',
  fa: 'ir', vi: 'vn',
};

function createFlagSelect(selectEl) {
  const options = Array.from(selectEl.options).map(o => ({
    value: o.value,
    label: o.text.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim(),
  }));

  // Wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'flag-select-wrapper';
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  selectEl.style.display = 'none';
  wrapper.appendChild(selectEl);

  // Trigger button
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'flag-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  // Dropdown list
  const dropdown = document.createElement('ul');
  dropdown.className = 'flag-select-dropdown hidden';
  dropdown.setAttribute('role', 'listbox');

  function flagImg(value) {
    const code = FLAG_MAP[value];
    return code ? `<img src="/flags/${code}.svg" class="flag-img" alt="${code}" />` : '';
  }

  function renderTrigger(value) {
    const opt = options.find(o => o.value === value) || options[0];
    trigger.innerHTML = `${flagImg(opt.value)}<span>${opt.label}</span>`;
  }

  function close() {
    dropdown.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
  }

  function open() {
    dropdown.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
  }

  options.forEach(opt => {
    const li = document.createElement('li');
    li.className = 'flag-select-option';
    li.setAttribute('role', 'option');
    li.dataset.value = opt.value;
    li.innerHTML = `${flagImg(opt.value)}<span>${opt.label}</span>`;
    li.addEventListener('click', () => {
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      renderTrigger(opt.value);
      dropdown.querySelectorAll('.flag-select-option').forEach(el =>
        el.classList.toggle('selected', el.dataset.value === opt.value)
      );
      close();
    });
    dropdown.appendChild(li);
  });

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.contains('hidden') ? open() : close();
  });

  document.addEventListener('click', close);
  dropdown.addEventListener('click', e => e.stopPropagation());

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);

  // External sync: when selectEl.value changes programmatically
  const origValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  Object.defineProperty(selectEl, 'value', {
    get() { return selectEl.options[selectEl.selectedIndex]?.value ?? ''; },
    set(v) {
      origValueSetter.call(selectEl, v);
      renderTrigger(v);
      dropdown.querySelectorAll('.flag-select-option').forEach(el =>
        el.classList.toggle('selected', el.dataset.value === v)
      );
    },
  });

  renderTrigger(selectEl.value);
  dropdown.querySelectorAll('.flag-select-option').forEach(el =>
    el.classList.toggle('selected', el.dataset.value === selectEl.value)
  );
}

// ── Settings ───────────────────────────────────────────────────────────────
// "Generation" counters: every new navigation / new rendering of the
// original view increments its own counter, and async operations still
// running for the previous one notice they are outdated and stop.
let displayGeneration = 0;
let nativeRenderGeneration = 0;

const SETTINGS_KEY = 'giano-reader-settings';
const THEMES = ['dark', 'light', 'monokai', 'solarized-dark', 'nord', 'sepia'];

// ── IndexedDB Fallback for Browser ─────────────────────────────────────────
const IndexedDBStorage = {
  dbName: 'GianoReaderDB',
  storeName: 'kv',
  db: null,
  async getDB() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  },
  async get(key, defaultValue) {
    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const transaction = db.transaction(this.storeName, 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(key);
        request.onsuccess = () => {
          resolve(request.result !== undefined ? request.result : defaultValue);
        };
        request.onerror = () => resolve(defaultValue);
      });
    } catch {
      return defaultValue;
    }
  },
  async set(key, value) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      throw e;
    }
  }
};

// Read/write errors on data files already reported to the user
const _reportedStorageErrors = new Set();

// Helper for persistent storage (Filesystem in Tauri, IndexedDB/localStorage in Browser)
const PersistentStorage = {
  async get(key, defaultValue = []) {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
      try {
        const fs = await import('@tauri-apps/plugin-fs');
        const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
        const dir = await appLocalDataDir();
        const path = await join(dir, `${key}.json`);
        const file = await readJsonFile(fs, path);
        if (file.found) return file.value;
      } catch (e) {
        // File present but unreadable: it must not be treated as "no data",
        // otherwise the next save would overwrite it with an empty one.
        if (e instanceof StorageReadError) throw e;
        console.warn(`[Storage] error loading ${key} from FS:`, e);
      }
    }
    // Fallback to IndexedDB with migration from localStorage if present
    try {
      const dbVal = await IndexedDBStorage.get(key, null);
      if (dbVal !== null) return dbVal;

      const lsVal = localStorage.getItem(key);
      if (lsVal) {
        const parsed = JSON.parse(lsVal);
        await IndexedDBStorage.set(key, parsed);
        localStorage.removeItem(key); // cleans up localStorage
        return parsed;
      }
    } catch (e) {
      console.warn(`[Storage] error loading/migrating ${key} from IndexedDB:`, e);
    }
    return defaultValue;
  },
  async set(key, value) {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
      try {
        const fs = await import('@tauri-apps/plugin-fs');
        const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
        const dir = await appLocalDataDir();
        if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
        const path = await join(dir, `${key}.json`);
        await writeJsonFileAtomic(fs, path, value);
        // Also clean up IndexedDB and localStorage if saved to file successfully
        try {
          localStorage.removeItem(key);
          const db = await IndexedDBStorage.getDB();
          const transaction = db.transaction(IndexedDBStorage.storeName, 'readwrite');
          transaction.objectStore(IndexedDBStorage.storeName).delete(key);
        } catch { }
        return;
      } catch (e) {
        console.error(`[Storage] error saving ${key} to FS:`, e);
        // The IndexedDB fallback below does not replace the file: if the file
        // exists, it wins on the next read. The user must therefore be warned
        // (once per file) that changes may be lost.
        if (!_reportedStorageErrors.has(`write:${key}`)) {
          _reportedStorageErrors.add(`write:${key}`);
          showAlert(t(loadSettings().uiLang || 'en', 'storageWriteError', { file: `${key}.json` }));
        }
      }
    }
    try {
      await IndexedDBStorage.set(key, value);
    } catch (e) {
      console.error('[Storage] IndexedDB storage error, falling back to localStorage:', e);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        if (err.name === 'QuotaExceededError' || err.code === 22) {
          console.error('[Storage] Quota exceeded on localStorage!');
          showAlert(t(loadSettings().uiLang || 'en', 'storageQuotaError'));
        }
      }
    }
  }
};

// Warns (only once per file) that a data file exists but is not readable.
// Returns true if the error was of this kind and has been handled.
function reportStorageReadError(e) {
  if (!(e instanceof StorageReadError)) return false;
  console.error('[Storage]', e);
  if (!_reportedStorageErrors.has(e.path)) {
    _reportedStorageErrors.add(e.path);
    showAlert(t(loadSettings().uiLang || 'en', 'storageReadError', { file: e.path }));
  }
  return true;
}

// ── Translation cache (one file per book) ──────────────────────────────────
// See translation-cache.js. The file lives in <app data>/translations/<id>.json
// (in browser mode, in IndexedDB). Writes are batched: it saves
// TRANSLATION_CACHE_SAVE_DELAY_MS after the last translation, on book change
// and when the app closes.
const TRANSLATION_CACHE_DIR = 'translations';
const TRANSLATION_CACHE_SAVE_DELAY_MS = 2000;
let currentTranslationCache = null; // cache of the open book
let currentBookFileSize = 0;        // size of the open book file
let chapterLengthsPromise = null;   // chapter reading in progress when an EPUB is opened
const _dirtyTranslationCaches = new Set();
let _translationCacheTimer = null;

function isTauriApp() {
  return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

/** Identifier of a book's cache file: hash of its path. */
function translationCacheId(filePath, title) {
  return textKey(filePath || title || 'untitled');
}

async function translationCacheDir() {
  const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
  return join(await appLocalDataDir(), TRANSLATION_CACHE_DIR);
}

async function loadBookTranslationCache(filePath, title) {
  const id = translationCacheId(filePath, title);
  let data = null;
  try {
    if (isTauriApp()) {
      const fs = await import('@tauri-apps/plugin-fs');
      const { join } = await import('@tauri-apps/api/path');
      const file = await readJsonFile(fs, await join(await translationCacheDir(), `${id}.json`));
      if (file.found) data = file.value;
    } else {
      data = await IndexedDBStorage.get(`translation-cache:${id}`, null);
    }
  } catch (e) {
    // A cache that cannot be read is rebuilt: it only costs a re-translation
    console.warn('[translation-cache] not loaded, starting empty:', e);
  }
  const cache = new BookTranslationCache(data, { filePath: filePath || '', title: title || '' });
  cache.id = id;
  return cache;
}

async function saveBookTranslationCache(cache) {
  if (!cache || !cache.dirty) return;
  cache.dirty = false; // before the await: changes made during the save mark it dirty again
  try {
    if (isTauriApp()) {
      const fs = await import('@tauri-apps/plugin-fs');
      const { join } = await import('@tauri-apps/api/path');
      const dir = await translationCacheDir();
      if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
      await writeJsonFileAtomic(fs, await join(dir, `${cache.id}.json`), cache.toJSON());
    } else {
      await IndexedDBStorage.set(`translation-cache:${cache.id}`, cache.toJSON());
    }
  } catch (e) {
    cache.dirty = true;
    console.warn('[translation-cache] save failed:', e);
  }
}

function scheduleTranslationCacheSave(cache = currentTranslationCache) {
  if (!cache) return;
  _dirtyTranslationCaches.add(cache);
  clearTimeout(_translationCacheTimer);
  _translationCacheTimer = setTimeout(flushTranslationCaches, TRANSLATION_CACHE_SAVE_DELAY_MS);
}

async function flushTranslationCaches() {
  clearTimeout(_translationCacheTimer);
  const caches = [..._dirtyTranslationCaches];
  _dirtyTranslationCaches.clear();
  for (const cache of caches) await saveBookTranslationCache(cache);
}

// ── Last reading position of each book ─────────────────────────────────────
// See reading-positions.js. Saved TO DISK READING_POSITION_SAVE_DELAY_MS after the
// last scroll or navigation, when the book changes and when the app closes;
// restored when the same file is opened again (not when opening a bookmark).
const READING_POSITIONS_KEY = 'giano-reader-positions';
const READING_POSITION_SAVE_DELAY_MS = 2000;
let _readingPositions = {};          // filePath → position (see reading-positions.js)
let _readingPositionsLoaded = false; // false: the map holds only positions captured in this session
let _readingPositionsLoading = null;
let _readingPositionsDirty = false;
let _readingPositionTimer = null;
let _scrollRestorePending = 0;       // restoreScrollPct still applying: the scroll is not the user's

async function loadReadingPositions() {
  if (_readingPositionsLoaded) return _readingPositions;
  if (!_readingPositionsLoading) {
    _readingPositionsLoading = (async () => {
      let stored = {};
      try {
        stored = await PersistentStorage.get(READING_POSITIONS_KEY, {});
      } catch (e) {
        // Unreadable file: positions are not saved this session, so as not to overwrite it
        if (!reportStorageReadError(e)) console.warn('[positions] load error:', e);
        throw e;
      }
      // Positions captured before the load finished win over the ones on disk
      let map = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
      for (const [key, pos] of Object.entries(_readingPositions)) map = setReadingPosition(map, key, pos);
      _readingPositions = map;
      _readingPositionsLoaded = true;
      return map;
    })().finally(() => { _readingPositionsLoading = null; });
  }
  return _readingPositionsLoading;
}

/** Current position of the open book, or null when there is nothing reliable to save. */
function captureReadingPosition() {
  if (!currentFilePath || _scrollRestorePending > 0) return null;
  // Chapter still loading: the scroll would read 0
  if (!currentChapterParagraphs || !currentChapterParagraphs.length) return null;
  const scrollPct = currentReadingScrollPct();
  if (currentFileType === 'pdf') {
    if (!pdfDoc || !pdfNav) return null;
    return { chapterIndex: pdfNav.currentIndex, scrollPct, fileType: 'pdf', pdfMode: pdfNav.mode, updatedAt: Date.now() };
  }
  if (!book || !currentSpineItems.length) return null;
  return { chapterIndex: currentSpineIndex, scrollPct, fileType: 'epub', updatedAt: Date.now() };
}

/** Records the position of the open book in memory (saved by flushReadingPositions). */
function rememberReadingPosition() {
  const pos = captureReadingPosition();
  if (!pos) return;
  const key = currentFilePath;
  if (samePosition(getReadingPosition(_readingPositions, key), pos)) return;
  _readingPositions = setReadingPosition(_readingPositions, key, pos);
  _readingPositionsDirty = true;
}

function scheduleReadingPositionSave() {
  if (!currentFilePath) return;
  clearTimeout(_readingPositionTimer);
  _readingPositionTimer = setTimeout(() => {
    rememberReadingPosition();
    flushReadingPositions();
  }, READING_POSITION_SAVE_DELAY_MS);
}

async function flushReadingPositions() {
  clearTimeout(_readingPositionTimer);
  if (!_readingPositionsDirty) return;
  try {
    await loadReadingPositions(); // merges with the positions of the other books on disk
    _readingPositionsDirty = false;
    await PersistentStorage.set(READING_POSITIONS_KEY, _readingPositions);
  } catch (e) {
    console.warn('[positions] save error:', e);
  }
}

/** Where to reopen the book just loaded: null = default opening. */
async function savedRestoreTarget(filePath, book) {
  if (!filePath) return null;
  try {
    const map = await loadReadingPositions();
    return resolveRestoreTarget(getReadingPosition(map, filePath), book);
  } catch {
    return null;
  }
}

/** Deletes a book's cache file (book removed from the library). */
async function deleteBookTranslationCache(filePath, title) {
  const id = translationCacheId(filePath, title);
  if (currentTranslationCache && currentTranslationCache.id === id) currentTranslationCache.dirty = false;
  try {
    if (isTauriApp()) {
      const fs = await import('@tauri-apps/plugin-fs');
      const { join } = await import('@tauri-apps/api/path');
      const path = await join(await translationCacheDir(), `${id}.json`);
      if (await fs.exists(path)) await fs.remove(path);
    } else {
      await IndexedDBStorage.set(`translation-cache:${id}`, null);
    }
  } catch (e) {
    console.warn('[translation-cache] delete failed:', e);
  }
}

/** Current translation variant: target language and chosen engine. */
function translationVariant(lang) {
  return variantKey(lang, loadSettings().translationMode || 'free');
}

/**
 * Translates `texts` using the open book's cache: texts already translated with the
 * same language and the same engine are not sent to the translator again; the
 * others are translated (with retries) and added to the cache.
 * With `force` the cache is ignored and overwritten (re-translation requested).
 */
async function translateWithCache(texts, lang, signal, { force = false, cache = currentTranslationCache } = {}) {
  const variant = translationVariant(lang);
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((text, i) => {
    const hit = !force && cache ? cache.get(variant, text) : undefined;
    if (hit !== undefined) out[i] = hit;
    else missing.push(i);
  });
  if (!missing.length) return out;

  const fresh = await retryWithBackoff(
    () => translateParagraphs(missing.map(i => texts[i]), lang, signal),
    { signal, delaysMs: TRANSLATION_RETRY_DELAYS_MS }
  );
  missing.forEach((i, k) => {
    out[i] = fresh[k];
    if (cache && !(signal && signal.aborted)) cache.set(variant, texts[i], fresh[k]);
  });
  if (cache && cache.dirty) {
    scheduleTranslationCacheSave(cache);
    refreshBookTranslationModal();
  }
  return out;
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function applyTheme(theme) {
  document.body.classList.remove('dark', ...THEMES.map(t => `theme-${t}`));
  if (theme === 'dark') {
    document.body.classList.add('dark');
  } else {
    document.body.classList.add(`theme-${theme}`);
  }
  if (currentViewMode === 'original') {
    renderNativeView();
  }
}

function applyFont(family) {
  document.documentElement.style.setProperty('--reader-font-family', family);
  if (typeof fontFamilySelect !== 'undefined' && fontFamilySelect) fontFamilySelect.value = family;
  const ctxFontSelect = document.getElementById('ctx-font-select');
  if (ctxFontSelect) ctxFontSelect.value = family;
  if (currentViewMode === 'original') {
    if (currentFileType === 'pdf') {
      // The PDF page itself does not change: only the translation boxes laid
      // over it take the new family (and are fitted again).
      restyleSegments(translationViewer, family);
    } else {
      renderNativeView();
    }
  }
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--font-size', size + 'px');
  if (fontSizeValue) fontSizeValue.textContent = size + 'px';
  if (fontSizeRange) fontSizeRange.value = size;
  const ctxSizeRange = document.getElementById('ctx-size-range');
  const ctxSizeValue = document.getElementById('ctx-size-value');
  if (ctxSizeRange) ctxSizeRange.value = size;
  if (ctxSizeValue) ctxSizeValue.textContent = size + 'px';
  if (currentViewMode === 'original') {
    renderNativeView();
  }
}

function applyUiLang(lang) {
  document.documentElement.lang = lang;
  // RTL support
  const isRtl = RTL_LANGS.has(lang);
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.documentElement.classList.toggle('rtl', isRtl);
  // Sidebar
  openBtn.textContent = t(lang, 'openBook');
  document.querySelector('label[for="lang-select"]').textContent = t(lang, 'translationLanguage');
  tocPlaceholder.textContent = t(lang, 'noBookOpen');
  bookmarksOpenBtn.innerHTML = '<img src="/icons/book-bookmark.svg" class="icon" alt="" /> ' + t(lang, 'bookmarks');
  addBookmarkBtn.title = t(lang, 'addBookmark');
  bookmarksOpenBtn.title = t(lang, 'openBookmarks');
  // Viewer headers
  document.getElementById('original-header-label').textContent = t(lang, 'original');
  // Settings modal labels
  document.querySelector('label[for="ui-lang-select"]').textContent = t(lang, 'interfaceLanguage');
  document.querySelector('label[for="theme-select"]').textContent = t(lang, 'theme');
  document.querySelector('label[for="font-family-select"]').textContent = t(lang, 'fontFamily');
  document.querySelector('label[for="font-size-range"]').textContent = t(lang, 'fontSize');
  const orKeyLabel = document.querySelector('label[for="openrouter-key-input"]');
  if (orKeyLabel) orKeyLabel.textContent = t(lang, 'openrouterApiKey');
  const orFetchBtn = document.getElementById('openrouter-fetch-btn');
  if (orFetchBtn) orFetchBtn.title = t(lang, 'openrouterFetchModels');
  const orModelLabel = document.querySelector('label[for="openrouter-model-select"]');
  if (orModelLabel) orModelLabel.textContent = t(lang, 'openrouterModelPro');
  const orModelPlaceholder = document.getElementById('openrouter-model-placeholder');
  if (orModelPlaceholder) orModelPlaceholder.textContent = t(lang, 'openrouterSelectModel');
  if (translationModeSelect) {
    translationModeSelect.title = t(lang, 'toggleTranslationMode');
    translationModeSelect.setAttribute('aria-label', t(lang, 'toggleTranslationMode'));
  }
  document.getElementById('settings-modal-title').innerHTML = '<img src="/icons/gear.svg" class="icon" alt="" /> ' + t(lang, 'settings');
  settingsCloseBtn.title = t(lang, 'close');

  // Context menu labels
  const ctxPrevText = document.querySelector('#ctx-prev .ctx-text');
  if (ctxPrevText) ctxPrevText.textContent = t(lang, 'prevChapter');
  const ctxNextText = document.querySelector('#ctx-next .ctx-text');
  if (ctxNextText) ctxNextText.textContent = t(lang, 'nextChapter');
  const ctxRefreshText = document.querySelector('#ctx-refresh .ctx-text');
  if (ctxRefreshText) ctxRefreshText.textContent = t(lang, 'refresh');
  const ctxPrintText = document.querySelector('#ctx-print .ctx-text');
  if (ctxPrintText) ctxPrintText.textContent = t(lang, 'print');
  const ctxFontLabel = document.querySelector('.context-menu-group label[for="ctx-font-select"]');
  if (ctxFontLabel) ctxFontLabel.textContent = t(lang, 'fontFamily');
  const ctxSizeLabel = document.querySelector('.context-menu-group label[for="ctx-size-range"]');
  if (ctxSizeLabel) ctxSizeLabel.textContent = t(lang, 'fontSize');
  // Bookmarks modal
  document.getElementById('bm-modal-title').innerHTML = '<img src="/icons/book-bookmark.svg" class="icon" alt="" /> ' + t(lang, 'bookmarks');
  bmCloseBtn.title = t(lang, 'close');
  bmImportBtn.title = t(lang, 'importBookmarks');
  bmExportBtn.title = t(lang, 'exportBookmarks');
  bookmarksPlaceholder.textContent = t(lang, 'noBookmarksSaved');
  if (bmSearchInput) bmSearchInput.placeholder = t(lang, 'bmSearchPlaceholder');
  // Missing file modal
  document.getElementById('bm-missing-modal-title').textContent = t(lang, 'fileNotFound');
  bmRelocateBtn.textContent = t(lang, 'browse');
  bmCancelBtn.textContent = t(lang, 'cancel');
  // Progress bar buttons
  prevBtn.title = t(lang, 'prevChapter');
  nextBtn.title = t(lang, 'nextChapter');
  settingsBtn.title = t(lang, 'settings');
  // View toggle & sync notice
  if (toggleSyncBtn) {
    toggleSyncBtn.title = t(lang, 'toggleSync');
    toggleSyncBtn.setAttribute('aria-label', t(lang, 'toggleSync'));
  }
  {
    // Looked up here and not through the constant at the end of the file: this function
    // runs at startup, before that constant is initialized
    const btBtn = document.getElementById('book-translation-btn');
    if (btBtn) {
      btBtn.title = t(lang, 'bookTranslation');
      btBtn.setAttribute('aria-label', t(lang, 'bookTranslation'));
    }
  }
  if (translationStatus) {
    translationStatus.title = t(lang, 'resyncHint');
  }
  if (viewToggleBtn) {
    viewToggleBtn.title = t(lang, 'viewToggle');
    viewToggleBtn.setAttribute('aria-label', t(lang, 'viewToggle'));
  }
  if (hideTranslationBtn) {
    hideTranslationBtn.title = t(lang, 'hideTranslation');
    hideTranslationBtn.setAttribute('aria-label', t(lang, 'hideTranslation'));
  }
  if (hideOriginalBtn) {
    hideOriginalBtn.title = t(lang, 'hideOriginal');
    hideOriginalBtn.setAttribute('aria-label', t(lang, 'hideOriginal'));
  }
  if (togglePairingBtn) {
    togglePairingBtn.title = t(lang, 'togglePairing');
    togglePairingBtn.setAttribute('aria-label', t(lang, 'togglePairing'));
  }
  if (toggleNumbersBtn) {
    toggleNumbersBtn.title = t(lang, 'toggleNumbers');
    toggleNumbersBtn.setAttribute('aria-label', t(lang, 'toggleNumbers'));
  }
  if (syncDisabledNotice) {
    syncDisabledNotice.textContent = t(lang, 'syncDisabled');
  }
  // Settings about footer
  document.getElementById('settings-developed-by').textContent = t(lang, 'developedBy', { author: 'Giampaolo Bolzonella' });
  document.getElementById('settings-version').textContent = t(lang, 'version', { version: APP_VERSION });
  for (const [id, key] of [['settings-manual-link', 'settingsManualLink'], ['settings-issues-link', 'settingsIssuesLink']]) {
    const a = document.getElementById(id);
    if (a) { a.title = t(lang, key); a.setAttribute('aria-label', t(lang, key)); }
  }
  // Library modal
  const _libBtn = document.getElementById('library-btn');
  const _libModalTitle = document.getElementById('library-modal-title');
  const _libCloseBtn = document.getElementById('lib-close-btn');
  const _libScanBtn = document.getElementById('lib-scan-btn');
  const _libImportBtn = document.getElementById('lib-import-btn');
  const _libExportBtn = document.getElementById('lib-export-btn');
  const _libPlaceholder = document.getElementById('lib-placeholder');
  if (_libBtn) _libBtn.title = t(lang, 'library');
  if (_libModalTitle) _libModalTitle.innerHTML = '<img src="/icons/book-bookmark.svg" class="icon" alt="" /> ' + t(lang, 'library');
  if (_libCloseBtn) _libCloseBtn.title = t(lang, 'close');
  if (_libScanBtn) _libScanBtn.innerHTML = '<img src="/icons/upload.svg" class="icon" alt="" /> ' + t(lang, 'selectFolder');
  if (_libImportBtn) _libImportBtn.title = t(lang, 'libImport');
  if (_libExportBtn) _libExportBtn.title = t(lang, 'libExport');
  if (_libPlaceholder) _libPlaceholder.textContent = t(lang, 'libEmpty');
  const _libClearBtn = document.getElementById('lib-clear-btn');
  if (_libClearBtn) _libClearBtn.title = t(lang, 'libClear');
  const _libCheckBtn = document.getElementById('lib-check-btn');
  if (_libCheckBtn) _libCheckBtn.title = t(lang, 'libCheck');
  const _libSearchInput = document.getElementById('lib-search-input');
  if (_libSearchInput) _libSearchInput.placeholder = t(lang, 'libSearchPlaceholder');
  // Status filter options
  const _libStatusFilter = document.getElementById('lib-status-filter');
  if (_libStatusFilter) {
    const opts = _libStatusFilter.options;
    if (opts[0]) opts[0].textContent = t(lang, 'libFilterAll');
    if (opts[1]) opts[1].textContent = t(lang, 'statusToRead');
    if (opts[2]) opts[2].textContent = t(lang, 'statusReading');
    if (opts[3]) opts[3].textContent = t(lang, 'statusRead');
  }
  // Rating filter: the star options must not be translated
  const _libRatingFilter = document.getElementById('lib-rating-filter');
  if (_libRatingFilter) {
    const allOpt = _libRatingFilter.querySelector('option[value=""]');
    const noneOpt = _libRatingFilter.querySelector('option[value="none"]');
    if (allOpt) allOpt.textContent = t(lang, 'libFilterAllRatings');
    if (noneOpt) noneOpt.textContent = t(lang, 'ratingNone');
  }
  const _libSort = document.getElementById('lib-sort');
  if (_libSort) {
    _libSort.title = t(lang, 'libSortLabel');
    _libSort.setAttribute('aria-label', t(lang, 'libSortLabel'));
    for (const [value, key] of [['added', 'libSortAdded'], ['title', 'libSortTitle'], ['author', 'libSortAuthor']]) {
      const opt = _libSort.querySelector(`option[value="${value}"]`);
      if (opt) opt.textContent = t(lang, key);
    }
  }
  // Search depth label
  const _searchDepthLabel = document.getElementById('search-depth-label');
  if (_searchDepthLabel) _searchDepthLabel.textContent = t(lang, 'searchDepth');
  // File size limit labels
  const _maxLabel = document.getElementById('max-file-size-mb-label');
  const _warnLabel = document.getElementById('warn-file-size-mb-label');
  if (_maxLabel) _maxLabel.textContent = t(lang, 'maxFileSizeMB');
  if (_warnLabel) _warnLabel.textContent = t(lang, 'warnFileSizeMB');
  if (optimalLimitBtn) optimalLimitBtn.title = t(lang,
    (window.__TAURI__ || window.__TAURI_INTERNALS__) ? 'determineOptimalValue' : 'ramAdvisorBrowserOnly');
  // Settings tab labels
  const _tabGeneral = document.getElementById('settings-tab-general');
  const _tabLibrary = document.getElementById('settings-tab-library');
  const _tabBasic = document.getElementById('settings-tab-basic');
  const _tabPro = document.getElementById('settings-tab-pro');
  const _tabWebserver = document.getElementById('settings-tab-webserver');
  if (_tabGeneral) _tabGeneral.textContent = t(lang, 'settingsTabGeneral');
  if (_tabLibrary) _tabLibrary.textContent = t(lang, 'settingsTabLibrary');
  if (_tabBasic) _tabBasic.textContent = t(lang, 'settingsTabBasic');
  if (_tabPro) _tabPro.textContent = t(lang, 'settingsTabPro');
  if (_tabWebserver) _tabWebserver.textContent = t(lang, 'settingsTabWebServer');
  // Google Cloud labels
  const _gcApiKeyLabel = document.getElementById('gcloud-api-key-label');
  if (_gcApiKeyLabel) _gcApiKeyLabel.textContent = t(lang, 'gcloudApiKey');
  const _basicUsageLabel = document.getElementById('basic-usage-label');
  if (_basicUsageLabel) _basicUsageLabel.textContent = t(lang, 'basicUsageLabel');
  const _basicUsageNote = document.getElementById('basic-usage-note');
  if (_basicUsageNote) _basicUsageNote.textContent = t(lang, 'basicUsageNote');
  const _basicWarnPctLabel = document.getElementById('basic-warn-pct-label');
  if (_basicWarnPctLabel) _basicWarnPctLabel.textContent = t(lang, 'basicWarnPctLabel');
  const _basicAutoFreeLabel = document.getElementById('basic-auto-free-label');
  if (_basicAutoFreeLabel) _basicAutoFreeLabel.textContent = t(lang, 'basicAutoFreeLabel');
  const _basicAutoFreeHint = document.getElementById('basic-auto-free-hint');
  if (_basicAutoFreeHint) _basicAutoFreeHint.textContent = t(lang, 'basicAutoFreeHint');
  refreshBasicUsage();
  // Cloudflare subdomain label
  const _cfLabel = document.getElementById('cloudflare-subdomain-label');
  if (_cfLabel) _cfLabel.textContent = t(lang, 'cloudflareWorkerSubdomain');
  // Web Server password label
  const _pwLabel = document.getElementById('web-server-password-label');
  if (_pwLabel) _pwLabel.textContent = t(lang, 'webServerPassword');
}

function updateTranslationModeSelect() {
  if (!translationModeSelect) return;
  const s = loadSettings();

  // Determine which modes are available
  const hasBasic = !!(s.gcloudApiKey && s.gcloudApiKey.trim());
  const hasProKey = (s.openrouterApiKey || '').trim();
  const hasPro = hasProKey.startsWith('sk-or-') && hasProKey.length > 6 && !!(s.openrouterModel);

  const availableModes = ['free'];
  if (hasBasic) availableModes.push('basic');
  if (hasPro) availableModes.push('pro');

  // If only FREE is available, hide the select entirely
  if (availableModes.length <= 1) {
    translationModeSelect.classList.add('hidden');
    // Fallback if current mode is no longer available
    const currentMode = s.translationMode || 'free';
    if (currentMode !== 'free') {
      s.translationMode = 'free';
      saveSettings(s);
      retranslateCurrentChapter();
    }
  } else {
    translationModeSelect.classList.remove('hidden');
    // Rebuild options
    const currentMode = s.translationMode || 'free';
    translationModeSelect.innerHTML = '';
    availableModes.forEach(mode => {
      const opt = document.createElement('option');
      opt.value = mode;
      opt.textContent = mode.toUpperCase();
      if (mode === currentMode) opt.selected = true;
      translationModeSelect.appendChild(opt);
    });

    // If current mode is no longer available, fallback to FREE
    if (!availableModes.includes(currentMode)) {
      s.translationMode = 'free';
      saveSettings(s);
      translationModeSelect.value = 'free';
      // Retranslate with FREE mode
      if (currentChapterParagraphs && currentChapterParagraphs.length) {
        const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
        const scrollPct = scrollMax > 1 ? Math.round((originalViewer.scrollTop / scrollMax) * 100) : 0;
        translateCurrentChapter(scrollPct);
      }
    }
  }
}

// ── TTS Integration ────────────────────────────────────────────────────────

/**
 * Enable or disable all TTS controls based on book load status.
 * @param {boolean} enabled
 */
function enableTTSControls(enabled) {
  if (ttsPlayBtn) ttsPlayBtn.disabled = !enabled;
  if (ttsStopBtn) ttsStopBtn.disabled = !enabled;
  if (ttsPanelSelect) ttsPanelSelect.disabled = !enabled;
  if (ttsRate) ttsRate.disabled = !enabled;
  if (ttsPitch) ttsPitch.disabled = !enabled;
  if (ttsVoiceSelect) ttsVoiceSelect.disabled = !enabled;
  if (ttsModeSelect) ttsModeSelect.disabled = !enabled;
  if (ttsModelSelect) ttsModelSelect.disabled = !enabled;
}

/**
 * Show/hide PRO mode TTS controls based on API key presence.
 */
function updateTTSModeVisibility() {
  if (!ttsModeSelect) return;
  const s = loadSettings();
  const apiKey = (s.openrouterApiKey || '').trim();
  const proAvailable = isProModeAvailable(apiKey);

  // Hide mode selector and its label when PRO is not available
  ttsModeSelect.classList.toggle('hidden', !proAvailable);
  const modeLabel = document.querySelector('label[for="tts-mode-select"]');
  if (modeLabel) modeLabel.classList.toggle('hidden', !proAvailable);

  // Hide model selector when PRO is not available or mode is FREE
  const showModel = proAvailable && ttsModeSelect.value === 'pro';
  if (ttsModelSelect) ttsModelSelect.classList.toggle('hidden', !showModel);

  // If PRO not available and mode is pro, revert to free
  if (!proAvailable && ttsModeSelect.value === 'pro') {
    ttsModeSelect.value = 'free';
    ttsController.updateSettings({ mode: 'free' });
  }
}

/**
 * Populate the TTS voice selector based on current language and mode.
 */
function populateTTSVoices() {
  if (!ttsVoiceSelect) return;
  const state = ttsController.getState();
  const s = loadSettings();

  // Only populate voices for FREE mode
  if (ttsModeSelect && ttsModeSelect.value === 'pro') {
    // Voice options depend on the selected TTS model
    const selectedModel = ttsModelSelect ? ttsModelSelect.value : '';
    let voiceOptions;

    if (selectedModel.includes('grok')) {
      // Grok Voice TTS voices
      voiceOptions = '<option value="eve">Eve ♀️</option><option value="ara">Ara ♀️</option><option value="rex">Rex ♂️</option><option value="sal">Sal ♂️</option><option value="leo">Leo ♂️</option>';
    } else if (selectedModel.includes('gemini')) {
      // Gemini TTS voices (30 prebuilt voices, subset shown)
      voiceOptions =
        '<optgroup label="Female">' +
        '<option value="Zephyr">Zephyr ♀️ — Bright</option>' +
        '<option value="Kore">Kore ♀️ — Firm</option>' +
        '<option value="Leda">Leda ♀️ — Youthful</option>' +
        '<option value="Aoede">Aoede ♀️ — Breezy</option>' +
        '<option value="Callirrhoe">Callirrhoe ♀️ — Easy-going</option>' +
        '<option value="Autonoe">Autonoe ♀️ — Bright</option>' +
        '<option value="Despina">Despina ♀️ — Smooth</option>' +
        '<option value="Erinome">Erinome ♀️ — Clear</option>' +
        '<option value="Laomedeia">Laomedeia ♀️ — Upbeat</option>' +
        '<option value="Achernar">Achernar ♀️ — Soft</option>' +
        '<option value="Pulcherrima">Pulcherrima ♀️ — Forward</option>' +
        '<option value="Vindemiatrix">Vindemiatrix ♀️ — Gentle</option>' +
        '<option value="Sadachbia">Sadachbia ♀️ — Lively</option>' +
        '<option value="Sulafat">Sulafat ♀️ — Warm</option>' +
        '</optgroup>' +
        '<optgroup label="Male">' +
        '<option value="Puck">Puck ♂️ — Upbeat</option>' +
        '<option value="Charon">Charon ♂️ — Informative</option>' +
        '<option value="Fenrir">Fenrir ♂️ — Excitable</option>' +
        '<option value="Orus">Orus ♂️ — Firm</option>' +
        '<option value="Enceladus">Enceladus ♂️ — Breathy</option>' +
        '<option value="Iapetus">Iapetus ♂️ — Clear</option>' +
        '<option value="Umbriel">Umbriel ♂️ — Easy-going</option>' +
        '<option value="Algieba">Algieba ♂️ — Smooth</option>' +
        '<option value="Algenib">Algenib ♂️ — Gravelly</option>' +
        '<option value="Rasalgethi">Rasalgethi ♂️ — Informative</option>' +
        '<option value="Alnilam">Alnilam ♂️ — Firm</option>' +
        '<option value="Schedar">Schedar ♂️ — Even</option>' +
        '<option value="Gacrux">Gacrux ♂️ — Mature</option>' +
        '<option value="Achird">Achird ♂️ — Friendly</option>' +
        '<option value="Zubenelgenubi">Zubenelgenubi ♂️ — Casual</option>' +
        '<option value="Sadaltager">Sadaltager ♂️ — Knowledgeable</option>' +
        '</optgroup>';
    } else if (selectedModel.includes('orpheus')) {
      // Orpheus 3B voices — 8 English preset voices
      voiceOptions =
        '<option value="tara">Tara ♀️</option>' +
        '<option value="leah">Leah ♀️</option>' +
        '<option value="jess">Jess ♀️</option>' +
        '<option value="mia">Mia ♀️</option>' +
        '<option value="zoe">Zoe ♀️</option>' +
        '<option value="leo">Leo ♂️</option>' +
        '<option value="dan">Dan ♂️</option>' +
        '<option value="zac">Zac ♂️</option>';
    } else if (selectedModel.includes('kokoro')) {
      // Kokoro 82M voices — organized by language
      voiceOptions =
        '<optgroup label="🇺🇸 American English">' +
        '<option value="af_heart">Heart ♀️</option>' +
        '<option value="af_bella">Bella ♀️</option>' +
        '<option value="af_nicole">Nicole ♀️</option>' +
        '<option value="af_nova">Nova ♀️</option>' +
        '<option value="af_sarah">Sarah ♀️</option>' +
        '<option value="af_sky">Sky ♀️</option>' +
        '<option value="am_adam">Adam ♂️</option>' +
        '<option value="am_michael">Michael ♂️</option>' +
        '<option value="am_eric">Eric ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇬🇧 British English">' +
        '<option value="bf_emma">Emma ♀️</option>' +
        '<option value="bf_isabella">Isabella ♀️</option>' +
        '<option value="bm_george">George ♂️</option>' +
        '<option value="bm_fable">Fable ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇮🇹 Italian">' +
        '<option value="if_sara">Sara ♀️</option>' +
        '<option value="im_nicola">Nicola ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇫🇷 French">' +
        '<option value="ff_siwis">Siwis ♀️</option>' +
        '</optgroup>' +
        '<optgroup label="🇪🇸 Spanish">' +
        '<option value="ef_dora">Dora ♀️</option>' +
        '<option value="em_alex">Alex ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇧🇷 Portuguese">' +
        '<option value="pf_dora">Dora ♀️</option>' +
        '<option value="pm_alex">Alex ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇯🇵 Japanese">' +
        '<option value="jf_alpha">Alpha ♀️</option>' +
        '<option value="jm_kumo">Kumo ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇨🇳 Chinese">' +
        '<option value="zf_xiaobei">Xiaobei ♀️</option>' +
        '<option value="zm_yunjian">Yunjian ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇮🇳 Hindi">' +
        '<option value="hf_alpha">Alpha ♀️</option>' +
        '<option value="hm_omega">Omega ♂️</option>' +
        '</optgroup>';
    } else if (selectedModel.includes('mai-voice')) {
      // Microsoft MAI-Voice-2 — Azure locale format voices
      voiceOptions =
        '<optgroup label="🇺🇸 English (US)">' +
        '<option value="en-US-Harper:MAI-Voice-2">Harper ♀️</option>' +
        '<option value="en-US-Olivia:MAI-Voice-2">Olivia ♀️</option>' +
        '<option value="en-US-Ethan:MAI-Voice-2">Ethan ♂️</option>' +
        '<option value="en-US-Jasper:MAI-Voice-2">Jasper ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇮🇹 Italian">' +
        '<option value="it-IT-Rosa:MAI-Voice-2">Rosa ♀️</option>' +
        '<option value="it-IT-Luca:MAI-Voice-2">Luca ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇩🇪 German">' +
        '<option value="de-DE-Mia:MAI-Voice-2">Mia ♀️</option>' +
        '<option value="de-DE-Klaus:MAI-Voice-2">Klaus ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇫🇷 French">' +
        '<option value="fr-FR-Soleil:MAI-Voice-2">Soleil ♀️</option>' +
        '<option value="fr-FR-Marc:MAI-Voice-2">Marc ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇪🇸 Spanish">' +
        '<option value="es-ES-Marta:MAI-Voice-2">Marta ♀️</option>' +
        '<option value="es-MX-Valeria:MAI-Voice-2">Valeria ♀️</option>' +
        '<option value="es-MX-Alejo:MAI-Voice-2">Alejo ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇧🇷 Portuguese">' +
        '<option value="pt-BR-Luana:MAI-Voice-2">Luana ♀️</option>' +
        '<option value="pt-BR-Caio:MAI-Voice-2">Caio ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇷🇺 Russian">' +
        '<option value="ru-RU-Masha:MAI-Voice-2">Masha ♀️</option>' +
        '<option value="ru-RU-Lev:MAI-Voice-2">Lev ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇨🇳 Chinese">' +
        '<option value="zh-CN-Mei:MAI-Voice-2">Mei ♀️</option>' +
        '<option value="zh-CN-Bo:MAI-Voice-2">Bo ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇮🇳 Hindi">' +
        '<option value="hi-IN-Kavya:MAI-Voice-2">Kavya ♀️</option>' +
        '<option value="hi-IN-Dhruv:MAI-Voice-2">Dhruv ♂️</option>' +
        '</optgroup>' +
        '<optgroup label="🇰🇷 Korean">' +
        '<option value="ko-KR-Hana:MAI-Voice-2">Hana ♀️</option>' +
        '<option value="ko-KR-Junho:MAI-Voice-2">Junho ♂️</option>' +
        '</optgroup>';
    } else {
      // Fallback generic voices (OpenAI-style)
      voiceOptions = '<option value="alloy">Alloy ♀️</option><option value="echo">Echo ♂️</option><option value="fable">Fable ♂️</option><option value="onyx">Onyx ♂️</option><option value="nova">Nova ♀️</option><option value="shimmer">Shimmer ♀️</option>';
    }

    ttsVoiceSelect.innerHTML = voiceOptions;
    const savedVoice = s.ttsVoice || ttsVoiceSelect.options[0]?.value || 'tara';
    if ([...ttsVoiceSelect.options].some(o => o.value === savedVoice)) {
      ttsVoiceSelect.value = savedVoice;
    } else {
      ttsVoiceSelect.value = ttsVoiceSelect.options[0]?.value || '';
      ttsController.updateSettings({ ttsVoice: ttsVoiceSelect.value });
    }
    return;
  }

  // FREE mode: get voices for the active panel's language
  const langCode = state.panel === 'translation'
    ? (s.translationLang || 'en')
    : (s.sourceLang || s.bookLang || 'en');

  const synth = window.speechSynthesis;
  if (!synth) return;

  const voices = (() => {
    const bcp47Prefix = getLangBcp47Prefix(langCode);
    if (!bcp47Prefix) return [];
    const fullPrefix = bcp47Prefix.toLowerCase();
    const langPart = fullPrefix.split('-')[0];
    return synth.getVoices().filter(v => {
      const voiceLang = v.lang.toLowerCase();
      if (voiceLang === fullPrefix || voiceLang.startsWith(fullPrefix + '-')) return true;
      if (voiceLang === langPart) return true;
      return false;
    });
  })();

  ttsVoiceSelect.innerHTML = '';
  if (voices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = ui('tts_voice_default') || 'Default';
    ttsVoiceSelect.appendChild(opt);
    return;
  }

  voices.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    ttsVoiceSelect.appendChild(opt);
  });

  // Restore saved voice selection
  const savedVoiceURI = s.ttsVoiceURI || '';
  if (savedVoiceURI && voices.some(v => v.voiceURI === savedVoiceURI)) {
    ttsVoiceSelect.value = savedVoiceURI;
  }
}

/**
 * BCP-47 prefix lookup for voice matching.
 */
function getLangBcp47Prefix(langCode) {
  // A single map, shared with the TTS engine (tts.js)
  return LANG_TO_BCP47[langCode] || null;
}

/**
 * Callback for TTS state changes — updates play button icon and control states.
 * @param {{ status: string, currentIndex: number, panel: string }} state
 */
function updateTTSUI(state) {
  if (!ttsPlayBtn) return;

  if (state.status === 'playing') {
    // Show pause icon
    ttsPlayBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="5" y="4" width="4" height="16"/><rect x="15" y="4" width="4" height="16"/></svg>';
    ttsPlayBtn.title = ui('tts_pause');
    ttsPlayBtn.setAttribute('aria-label', ui('tts_pause'));
  } else {
    // Show play icon (idle or paused)
    ttsPlayBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>';
    ttsPlayBtn.title = ui('tts_play');
    ttsPlayBtn.setAttribute('aria-label', ui('tts_play'));
  }

  // Update download button and progress on state changes
  updateTTSDownloadState();

  // Reset progress to "0%" on stop/chapter navigation (buffer cleared),
  // but keep at current value on natural playback end (buffer retained for download)
  if (state.status === 'idle' && !ttsController.hasAudioData()) {
    if (ttsProgress) ttsProgress.textContent = '0%';
    if (ttsDownloadBtn) {
      ttsDownloadBtn.disabled = true;
    }
  }
}

/**
 * Update the download button enabled state and progress indicator visibility
 * based on the current TTS mode and audio data availability.
 */
function updateTTSDownloadState() {
  const mode = ttsModeSelect ? ttsModeSelect.value : 'free';
  const isPro = mode === 'pro';
  const hasAudio = ttsController.hasAudioData();
  const lang = loadSettings().uiLang || 'en';

  if (ttsDownloadBtn) {
    ttsDownloadBtn.disabled = !(isPro && hasAudio);
    ttsDownloadBtn.title = isPro ? t(lang, 'tts_download') : t(lang, 'tts_download_pro_only');
  }

  if (ttsProgress) {
    const ttsState = ttsController.getState();
    const isActive = ttsState.status === 'playing' || ttsState.status === 'paused';
    // Show progress during active TTS playback regardless of mode;
    // only hide when TTS is idle AND mode is not PRO
    if (isActive) {
      ttsProgress.classList.remove('hidden');
    } else {
      ttsProgress.classList.toggle('hidden', !isPro);
    }
  }
}

// ── TTS Download Button ────────────────────────────────────────────────────

if (ttsDownloadBtn) {
  ttsDownloadBtn.addEventListener('click', async () => {
    const blob = ttsController.getAudioBlob();
    if (!blob) return;

    const title = bookTitle.textContent || 'unknown';
    const chapterIdx = currentSpineIndex + 1;
    let filename = makeDownloadFilename(title, chapterIdx);
    const model = ttsModelSelect ? ttsModelSelect.value : '';
    const isGemini = model.includes('gemini');
    if (isGemini) {
      filename = filename.replace(/\.mp3$/, '.wav');
    }

    const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
    if (isTauri) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        const ext = isGemini ? 'wav' : 'mp3';
        const filterName = isGemini ? 'WAV Audio' : 'MP3 Audio';
        const savePath = await save({
          defaultPath: filename,
          filters: [{ name: filterName, extensions: [ext] }]
        });
        if (!savePath) return;
        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(savePath, new Uint8Array(arrayBuffer));
      } catch (err) {
        console.error('[TTS] Download error:', err);
        await showAlert(ui('errorOpening') + errMsg(err));
      }
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  });
}

// ── TTS Event Listeners ────────────────────────────────────────────────────

if (ttsPlayBtn) {
  ttsPlayBtn.addEventListener('click', () => {
    const state = ttsController.getState();
    if (state.status === 'idle' || state.status === 'paused') {
      // In FREE mode, check if voices are available for the target language before playing
      const mode = ttsModeSelect ? ttsModeSelect.value : 'free';
      if (state.status === 'idle' && mode === 'free' && window.speechSynthesis) {
        const s = loadSettings();
        const langCode = state.panel === 'translation'
          ? (s.translationLang || 'en')
          : (s.sourceLang || s.bookLang || 'en');
        const bcp47Prefix = getLangBcp47Prefix(langCode);
        if (bcp47Prefix) {
          const fullPrefix = bcp47Prefix.toLowerCase();
          const langPart = fullPrefix.split('-')[0];
          const voices = window.speechSynthesis.getVoices().filter(v => {
            const voiceLang = v.lang.toLowerCase();
            if (voiceLang === fullPrefix || voiceLang.startsWith(fullPrefix + '-')) return true;
            if (voiceLang === langPart) return true;
            return false;
          });
          if (voices.length === 0) {
            // Build a helpful message with a link to the installation guide
            const guideUrl = 'https://github.com/DrLoki/GianoReader/blob/main/giano-reader/INSTALL_TTS_VOICES.md';
            let msg = ui('tts_no_voice');
            const platform = navigator.platform || '';
            if (platform.startsWith('Win')) {
              msg += '\n\nWindows: Settings → Time & Language → Speech → Add voices';
            } else if (platform.startsWith('Mac') || platform.includes('Mac')) {
              msg += '\n\nmacOS: System Settings → Accessibility → Spoken Content → Manage Voices';
            } else {
              msg += '\n\nLinux: install espeak-ng or speech-dispatcher voices';
            }
            msg += `\n\nFull guide: ${guideUrl}`;
            showAlert(msg);
            return;
          }
        }
      }
      ttsController.play();
    } else if (state.status === 'playing') {
      ttsController.pause();
    }
  });
}

if (ttsStopBtn) {
  ttsStopBtn.addEventListener('click', () => {
    ttsController.stop();
  });
}

if (ttsPanelSelect) {
  ttsPanelSelect.addEventListener('change', () => {
    ttsController.updateSettings({ panel: ttsPanelSelect.value });
    populateTTSVoices();
  });
}

if (ttsRate) {
  ttsRate.addEventListener('input', () => {
    const val = parseFloat(ttsRate.value);
    if (ttsRateValue) ttsRateValue.textContent = val.toFixed(1) + '×';
    ttsController.updateSettings({ rate: val });
  });
}

if (ttsPitch) {
  ttsPitch.addEventListener('input', () => {
    const val = parseFloat(ttsPitch.value);
    if (ttsPitchValue) ttsPitchValue.textContent = val.toFixed(1);
    ttsController.updateSettings({ pitch: val });
  });
}

if (ttsVoiceSelect) {
  ttsVoiceSelect.addEventListener('change', () => {
    const mode = ttsModeSelect ? ttsModeSelect.value : 'free';
    if (mode === 'pro') {
      ttsController.updateSettings({ ttsVoice: ttsVoiceSelect.value });
    } else {
      ttsController.updateSettings({ voiceURI: ttsVoiceSelect.value });
    }
  });
}

if (ttsModeSelect) {
  ttsModeSelect.addEventListener('change', () => {
    ttsController.updateSettings({ mode: ttsModeSelect.value });
    populateTTSVoices();
    updateTTSModeVisibility();
    updateTTSDownloadState();
  });
}

if (ttsModelSelect) {
  ttsModelSelect.addEventListener('change', () => {
    ttsController.updateSettings({ ttsModel: ttsModelSelect.value });
    populateTTSVoices();
  });
}

// ── TTS Initialization ─────────────────────────────────────────────────────

// Hide TTS controls entirely if speechSynthesis is not available (Requirement 2.3)
if (!window.speechSynthesis) {
  const ttsControlsBar = document.getElementById('tts-controls');
  if (ttsControlsBar) ttsControlsBar.classList.add('hidden');
}

/**
 * Trigger translation for a range of paragraph indices.
 * Called by TTS controller when it encounters pending paragraphs.
 * Reuses the translateChunk() function from translateCurrentChapter().
 * If translateChunk is not available or chunks are already in-flight,
 * waits for the pending paragraphs in the range to lose their 'pending' class.
 * @param {number} startIdx - First paragraph index to translate
 * @param {number} endIdx - Last paragraph index to translate (inclusive)
 * @returns {Promise<void>}
 */
async function triggerTranslationForRange(startIdx, endIdx) {
  // Trigger translation chunks if available
  if (ttsTranslateChunk) {
    const startChunk = Math.floor(startIdx / LAZY_CHUNK);
    const endChunk = Math.floor(endIdx / LAZY_CHUNK);
    const promises = [];
    for (let i = startChunk; i <= endChunk; i++) {
      promises.push(ttsTranslateChunk(i));
    }
    await Promise.all(promises);
  }

  // After trigger, verify the TARGET paragraph (startIdx) is actually translated.
  // translateChunk may have returned immediately if chunks were already in-flight
  // (translatedChunks.has(chunkIdx) is true but translation not yet complete).
  const targetEl = translationViewer.querySelector(`[data-idx="${startIdx}"]`);
  if (!targetEl || !targetEl.classList.contains('pending')) return; // Already translated

  // Wait for the TARGET paragraph to lose its `pending` class using
  // MutationObserver (responsive) + polling fallback (reliable)
  await new Promise((resolve) => {
    let observer = null;
    let timeoutId = null;
    let pollId = null;

    const cleanup = () => {
      if (observer) { observer.disconnect(); observer = null; }
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (pollId) { clearInterval(pollId); pollId = null; }
    };

    // Timeout after 30 seconds
    timeoutId = setTimeout(() => {
      console.warn('[TTS] triggerTranslationForRange: timeout waiting for paragraph', startIdx);
      cleanup();
      resolve();
    }, 30000);

    // MutationObserver watches the TARGET paragraph element for class changes
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          if (!targetEl.classList.contains('pending')) {
            cleanup();
            resolve();
            return;
          }
        }
      }
    });

    observer.observe(targetEl, {
      attributes: true,
      attributeFilter: ['class']
    });

    // Polling fallback: check every 300ms in case MutationObserver misses
    pollId = setInterval(() => {
      if (!targetEl.classList.contains('pending')) {
        cleanup();
        resolve();
      }
    }, 300);
  });
}

/**
 * Force-retry translation for a specific chunk by clearing it from
 * the translatedChunks cache, then re-invoking translateChunk.
 * Called by TTS retry logic when translation times out.
 * @param {number} paragraphIdx - A paragraph index within the target chunk
 */
function retryTranslationForChunk(paragraphIdx) {
  if (!ttsTranslateChunk) return;
  const chunkIdx = Math.floor(paragraphIdx / LAZY_CHUNK);
  if (translatedChunksRef) {
    translatedChunksRef.delete(chunkIdx);
  }
  ttsTranslateChunk(chunkIdx);
}

// Initialize TTS controller with DOM references
ttsController.init({
  originalViewer: originalViewer,
  translationViewer: translationViewer,
  onStateChange: updateTTSUI,
  onTranslationNeeded: triggerTranslationForRange,
  onRetryTranslation: retryTranslationForChunk,
  onError: (err) => {
    // Display PRO mode errors (HTTP errors, network failures) to the user
    showAlert(err.message || 'TTS error');
  }
});

// Subscribe to TTS progress changes to update the progress indicator and download button
ttsController._onProgressChange = (pct) => {
  if (ttsProgress) {
    const ttsState = ttsController.getState();
    const isActive = ttsState.status === 'playing' || ttsState.status === 'paused';
    // Only update text content during active playback (reading progress from paragraph transitions).
    // This prevents AudioBufferStore download-buffer progress from overwriting reading position.
    if (isActive) {
      ttsProgress.textContent = pct + '%';
      ttsProgress.classList.remove('hidden');
    }
  }
  updateTTSDownloadState();
};

// Restore TTS settings to UI controls
(function restoreTTSUI() {
  const s = loadSettings();
  if (ttsRate) {
    const rate = s.ttsRate ?? 1.0;
    ttsRate.value = rate;
    if (ttsRateValue) ttsRateValue.textContent = rate.toFixed(1) + '×';
  }
  if (ttsPitch) {
    const pitch = s.ttsPitch ?? 1.0;
    ttsPitch.value = pitch;
    if (ttsPitchValue) ttsPitchValue.textContent = pitch.toFixed(1);
  }
  if (ttsPanelSelect) {
    ttsPanelSelect.value = s.ttsPanel || 'original';
  }
  if (ttsModeSelect) {
    ttsModeSelect.value = s.ttsMode || 'free';
  }
  if (ttsModelSelect) {
    ttsModelSelect.value = s.ttsModel || 'canopylabs/orpheus-3b-0.1-ft';
  }
  updateTTSModeVisibility();
  updateTTSDownloadState();

  // Populate voices once they're loaded (some browsers load async)
  if (window.speechSynthesis) {
    const loadVoices = () => populateTTSVoices();
    if (window.speechSynthesis.getVoices().length > 0) {
      loadVoices();
    }
    // Always listen for voiceschanged — voices may reload asynchronously (common in Chrome)
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
})();

// Init from saved settings
(function initSettings() {
  const s = loadSettings();
  const theme = s.theme || 'dark';
  const uiLang = s.uiLang || 'en';
  applyTheme(theme);
  themeSelect.value = theme;
  uiLangSelect.value = uiLang;
  applyUiLang(uiLang);
  // Pairing & Paragraph Numbers
  pairingEnabled = !!s.pairingEnabled;
  if (viewerWrapper) viewerWrapper.classList.toggle('pairing-enabled', pairingEnabled);
  if (togglePairingBtn) {
    togglePairingBtn.setAttribute('aria-pressed', String(pairingEnabled));
    togglePairingBtn.classList.toggle('active', pairingEnabled);
  }
  showNumbers = !!s.showNumbers;
  if (viewerWrapper) viewerWrapper.classList.toggle('show-numbers', showNumbers);
  if (toggleNumbersBtn) {
    toggleNumbersBtn.setAttribute('aria-pressed', String(showNumbers));
    toggleNumbersBtn.classList.toggle('active', showNumbers);
  }
  // Font family
  const fontFamily = s.fontFamily || 'Georgia, serif';
  applyFont(fontFamily);
  if (fontFamilySelect) fontFamilySelect.value = fontFamily;
  // The pickers list fonts of Windows, macOS and Linux: show only the installed ones
  const missingFonts = hideMissingFontOptions([fontFamilySelect, document.getElementById('ctx-font-select')]);
  if (missingFonts.length) console.log('[fonts] not installed, hidden:', missingFonts.join(', '));
  // Font size
  const fontSize = s.fontSize || 16;
  applyFontSize(fontSize);
  // Search depth
  const searchDepth = s.searchDepth ?? 3;
  if (searchDepthInput) searchDepthInput.value = searchDepth;
  // Translation language
  if (s.translationLang) langSelect.value = s.translationLang;
  // File size limits
  const maxFileSizeMB = typeof s.maxFileSizeMB === 'number' ? s.maxFileSizeMB : DEFAULT_MAX_FILE_SIZE_MB;
  const warnFileSizeMB = typeof s.warnFileSizeMB === 'number' ? s.warnFileSizeMB : DEFAULT_WARN_FILE_SIZE_MB;
  if (maxFileSizeMbInput) maxFileSizeMbInput.value = maxFileSizeMB;
  if (warnFileSizeMbInput) warnFileSizeMbInput.value = warnFileSizeMB;
  // Disable optimal-limit button in browser mode
  if (optimalLimitBtn && !(window.__TAURI__ || window.__TAURI_INTERNALS__)) {
    optimalLimitBtn.disabled = true;
    optimalLimitBtn.title = ui('ramAdvisorBrowserOnly');
  }

  // OpenRouter settings init
  const openrouterApiKey = s.openrouterApiKey || '';
  if (openrouterKeyInput) openrouterKeyInput.value = openrouterApiKey;

  // Google Cloud (Basic mode) settings init
  if (gcloudApiKeyInput) gcloudApiKeyInput.value = s.gcloudApiKey || '';
  if (basicWarnPctInput) basicWarnPctInput.value = normalizeWarnPct(s.basicWarnPct);
  if (basicAutoFreeToggle) basicAutoFreeToggle.checked = !!s.basicAutoFree;
  setBasicAutoFree(!!s.basicAutoFree);


  const translationMode = s.translationMode || 'free';
  if (translationModeSelect) {
    translationModeSelect.value = translationMode;
  }

  if (openrouterModelSelect) {
    if (s.openrouterModels && s.openrouterModels.length > 0) {
      openrouterModelSelect.innerHTML = `<option value="" id="openrouter-model-placeholder">${t(uiLang, 'openrouterSelectModel')}</option>`;
      s.openrouterModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === s.openrouterModel) opt.selected = true;
        openrouterModelSelect.appendChild(opt);
      });
    }
  }

  updateTranslationModeSelect();

  // Replaces the language selects with custom dropdowns (emoji flags)
  createFlagSelect(langSelect);
  createFlagSelect(uiLangSelect);
})();

themeSelect.addEventListener('change', () => {
  const s = loadSettings();
  s.theme = themeSelect.value;
  saveSettings(s);
  applyTheme(s.theme);
});

uiLangSelect.addEventListener('change', () => {
  const s = loadSettings();
  s.uiLang = uiLangSelect.value;
  saveSettings(s);
  applyUiLang(s.uiLang);
});

fontFamilySelect.addEventListener('change', () => {
  const s = loadSettings();
  s.fontFamily = fontFamilySelect.value;
  saveSettings(s);
  applyFont(s.fontFamily);
});

fontSizeRange.addEventListener('input', () => {
  const size = parseInt(fontSizeRange.value, 10);
  fontSizeValue.textContent = size + 'px';
  document.documentElement.style.setProperty('--font-size', size + 'px');
});
fontSizeRange.addEventListener('change', () => {
  const s = loadSettings();
  s.fontSize = parseInt(fontSizeRange.value, 10);
  saveSettings(s);
});

if (searchDepthInput) {
  searchDepthInput.addEventListener('change', () => {
    const clamped = clampSearchDepth(parseInt(searchDepthInput.value, 10));
    searchDepthInput.value = clamped;
    const s = loadSettings();
    s.searchDepth = clamped;
    saveSettings(s);
  });
}

if (maxFileSizeMbInput) {
  maxFileSizeMbInput.addEventListener('change', () => {
    let val = parseInt(maxFileSizeMbInput.value, 10);
    val = Math.max(10, Math.min(2000, isNaN(val) ? DEFAULT_MAX_FILE_SIZE_MB : val));
    maxFileSizeMbInput.value = val;
    // Clamp warn if necessary
    let warn = parseInt(warnFileSizeMbInput.value, 10) || DEFAULT_WARN_FILE_SIZE_MB;
    if (warn >= val) { warn = val - 1; warnFileSizeMbInput.value = warn; }
    const s = loadSettings();
    s.maxFileSizeMB = val;
    s.warnFileSizeMB = warn;
    saveSettings(s);
  });
}

if (warnFileSizeMbInput) {
  warnFileSizeMbInput.addEventListener('change', () => {
    const maxVal = parseInt(maxFileSizeMbInput?.value, 10) || DEFAULT_MAX_FILE_SIZE_MB;
    let val = parseInt(warnFileSizeMbInput.value, 10);
    val = Math.max(10, Math.min(maxVal - 1, isNaN(val) ? DEFAULT_WARN_FILE_SIZE_MB : val));
    warnFileSizeMbInput.value = val;
    const s = loadSettings();
    s.warnFileSizeMB = val;
    saveSettings(s);
  });
}

if (openrouterKeyInput) {
  const handleKeyUpdate = () => {
    const s = loadSettings();
    s.openrouterApiKey = openrouterKeyInput.value.trim();
    saveSettings(s);
    updateTranslationModeSelect();
    updateTTSModeVisibility();
  };
  openrouterKeyInput.addEventListener('change', handleKeyUpdate);
  openrouterKeyInput.addEventListener('input', handleKeyUpdate);
}

if (openrouterModelSelect) {
  openrouterModelSelect.addEventListener('change', () => {
    const s = loadSettings();
    s.openrouterModel = openrouterModelSelect.value;
    saveSettings(s);
    updateTranslationModeSelect();
  });
}

// Google Cloud (Basic mode) settings persistence
if (gcloudApiKeyInput) {
  const handleGcloudKeyUpdate = () => {
    const s = loadSettings();
    s.gcloudApiKey = gcloudApiKeyInput.value.trim();
    saveSettings(s);
    updateTranslationModeSelect();
    // Sync to web server if running
    if (window._syncApiKeysToServer) window._syncApiKeysToServer();
    updateWebServerBasicHint();
  };
  gcloudApiKeyInput.addEventListener('change', handleGcloudKeyUpdate);
  gcloudApiKeyInput.addEventListener('input', handleGcloudKeyUpdate);
}

const openrouterFetchBtn = document.getElementById('openrouter-fetch-btn');
const openrouterStatusMsg = document.getElementById('openrouter-status-msg');
if (openrouterFetchBtn) {
  openrouterFetchBtn.addEventListener('click', async () => {
    const s = loadSettings();
    const apiKey = openrouterKeyInput.value.trim();
    const lang = s.uiLang || 'en';
    if (!apiKey) {
      if (openrouterStatusMsg) {
        openrouterStatusMsg.textContent = t(lang, 'openrouterInvalidKey');
        openrouterStatusMsg.className = 'settings-status-msg error';
        openrouterStatusMsg.classList.remove('hidden');
      }
      return;
    }

    try {
      if (openrouterStatusMsg) {
        openrouterStatusMsg.textContent = t(lang, 'openrouterLoadingModels');
        openrouterStatusMsg.className = 'settings-status-msg loading';
        openrouterStatusMsg.classList.remove('hidden');
      }

      const res = await fetch('https://openrouter.ai/api/v1/models?category=translation');
      if (!res.ok) throw new Error(`Status: ${res.status}`);
      const data = await res.json();

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid format returned by OpenRouter');
      }

      const models = data.data.map(m => ({ id: m.id, name: m.name }));
      models.sort((a, b) => a.name.localeCompare(b.name));

      const s2 = loadSettings();
      s2.openrouterModels = models;
      s2.openrouterApiKey = apiKey;
      saveSettings(s2);
      updateTranslationModeSelect();

      if (openrouterModelSelect) {
        openrouterModelSelect.innerHTML = `<option value="" id="openrouter-model-placeholder">${t(lang, 'openrouterSelectModel')}</option>`;
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          if (m.id === s2.openrouterModel) opt.selected = true;
          openrouterModelSelect.appendChild(opt);
        });
      }

      if (openrouterStatusMsg) {
        openrouterStatusMsg.textContent = t(lang, 'openrouterModelsLoaded');
        openrouterStatusMsg.className = 'settings-status-msg success';
        setTimeout(() => openrouterStatusMsg.classList.add('hidden'), 3000);
      }
    } catch (err) {
      console.error(err);
      if (openrouterStatusMsg) {
        openrouterStatusMsg.textContent = t(lang, 'openrouterErrorLoading') + err.message;
        openrouterStatusMsg.className = 'settings-status-msg error';
      }
    }
  });
}

if (translationModeSelect) {
  translationModeSelect.addEventListener('change', async () => {
    // BASIC chosen with its free tier used up and "switch to FREE at 100%" on:
    // stay on FREE
    if (translationModeSelect.value === 'basic' && await basicLimitReached()) {
      translationModeSelect.value = 'free';
      showNotice(ui('basicQuotaSwitchedToFree'), BASIC_NOTICE_MS);
    }
    const s = loadSettings();
    s.translationMode = translationModeSelect.value;
    saveSettings(s);

    // Trigger re-translation
    retranslateCurrentChapter();
    refreshBookTranslationModal();
  });
}

// Monthly BASIC usage shown in the BASIC settings tab (count kept by the app,
// see basic-usage.js). Refreshed when settings or that tab are opened.
async function refreshBasicUsage() {
  const textEl = document.getElementById('basic-usage-text');
  const fillEl = document.getElementById('basic-usage-fill');
  if (!textEl || !fillEl) return;
  const usage = await getBasicUsage();
  const sum = usageSummary(usage.chars);
  const lang = loadSettings().uiLang || 'en';
  const fmt = n => n.toLocaleString(lang);
  textEl.textContent = t(lang, 'basicUsageText', {
    used: fmt(sum.used),
    free: fmt(sum.freeChars),
    pct: sum.pct.toLocaleString(lang, { maximumFractionDigits: 1 }),
  });
  fillEl.style.width = `${Math.min(100, sum.pct)}%`;
  fillEl.classList.toggle('over', sum.over);
  // The count also includes the web server's BASIC translations
  checkBasicQuota(usage);
}

// ── BASIC quota: warning threshold and automatic switch to FREE ──────────

/** True when "switch to FREE at 100%" is on and this month's free tier is used up. */
async function basicLimitReached() {
  const s = loadSettings();
  if (!s.basicAutoFree) return false;
  const usage = await getBasicUsage();
  return basicQuotaStatus(usage.chars, { autoFree: true, month: usage.month }).limitReached;
}

/** Leaves BASIC for FREE (quota used up): stops BASIC work and re-translates. */
function switchBasicToFree() {
  const s = loadSettings();
  if ((s.translationMode || 'free') !== 'basic') return;
  s.translationMode = 'free';
  saveSettings(s);
  // A background "complete the book" job would keep spending BASIC
  if (bookTranslationJob && bookTranslationJob.kind === 'complete') bookTranslationJob.controller.abort();
  updateTranslationModeSelect();
  if (translationModeSelect) translationModeSelect.value = 'free';
  showNotice(ui('basicQuotaSwitchedToFree'), BASIC_NOTICE_MS);
  retranslateCurrentChapter();
  refreshBookTranslationModal();
}

/**
 * Checks the month's BASIC count against the settings: the warning is shown
 * once a month when the threshold is reached; with "switch to FREE at 100%"
 * a used-up free tier moves the reader from BASIC to FREE.
 */
async function checkBasicQuota(usage) {
  let s = loadSettings();
  if (!(s.gcloudApiKey || '').trim()) return;
  if (!usage) usage = await getBasicUsage();
  s = loadSettings();
  const month = usage.month || monthKey();
  const status = basicQuotaStatus(usage.chars, {
    warnPct: s.basicWarnPct,
    autoFree: !!s.basicAutoFree,
    warnedMonth: s.basicWarnedMonth,
    month,
  });
  if (status.limitReached) {
    switchBasicToFree();
    return;
  }
  if (status.warn) {
    s.basicWarnedMonth = month;
    saveSettings(s);
    const sum = usageSummary(usage.chars);
    const lang = s.uiLang || 'en';
    showNotice(ui('basicQuotaWarning', {
      pct: sum.pct.toLocaleString(lang, { maximumFractionDigits: 1 }),
      used: sum.used.toLocaleString(lang),
      free: sum.freeChars.toLocaleString(lang),
    }), BASIC_NOTICE_MS);
  }
}

// Every BASIC request sent by the desktop updates the count
window.addEventListener(BASIC_USAGE_EVENT, (e) => { checkBasicQuota(e.detail); });

if (basicWarnPctInput) {
  basicWarnPctInput.addEventListener('change', () => {
    const val = normalizeWarnPct(basicWarnPctInput.value);
    basicWarnPctInput.value = val;
    const s = loadSettings();
    // A new threshold gets its own warning this month
    if (s.basicWarnPct !== val) delete s.basicWarnedMonth;
    s.basicWarnPct = val;
    saveSettings(s);
    checkBasicQuota();
  });
}

if (basicAutoFreeToggle) {
  basicAutoFreeToggle.addEventListener('change', () => {
    const s = loadSettings();
    s.basicAutoFree = basicAutoFreeToggle.checked;
    saveSettings(s);
    setBasicAutoFree(s.basicAutoFree);
    checkBasicQuota();
  });
}

settingsBtn.addEventListener('click', () => { updateWebServerBasicHint(); refreshBasicUsage(); settingsModal.classList.remove('hidden'); });
settingsCloseBtn.addEventListener('click', () => { settingsModal.classList.add('hidden'); updateTranslationModeSelect(); });
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) { settingsModal.classList.add('hidden'); updateTranslationModeSelect(); } });

// ── Settings Tabs ──────────────────────────────────────────────────────────
(function initSettingsTabs() {
  const tabs = settingsModal.querySelectorAll('.settings-tab');
  const panels = settingsModal.querySelectorAll('.settings-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      panels.forEach(p => { p.classList.remove('active'); p.hidden = true; });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) { panel.classList.add('active'); panel.hidden = false; }
      if (tab.id === 'settings-tab-basic') refreshBasicUsage();
    });
  });
})();

// ── Cloudflare Worker Subdomain ────────────────────────────────────────────
const cloudflareSubdomainInput = document.getElementById('cloudflare-subdomain-input');
if (cloudflareSubdomainInput) {
  const s = loadSettings();
  if (s.cloudflareWorkerSubdomain) cloudflareSubdomainInput.value = s.cloudflareWorkerSubdomain;
  cloudflareSubdomainInput.addEventListener('change', () => {
    const settings = loadSettings();
    settings.cloudflareWorkerSubdomain = cloudflareSubdomainInput.value.trim();
    saveSettings(settings);
  });
}

// ── Web Server Password ────────────────────────────────────────────────────
const webServerPasswordInput = document.getElementById('web-server-password-input');
const webServerBasicHint = document.getElementById('web-server-basic-hint');

// The server uses BASIC (paid Google Cloud key) only if a
// password is set; otherwise it serves FREE to phones. The warning appears when the
// key is set but the password is not.
function updateWebServerBasicHint() {
  if (!webServerBasicHint) return;
  const s = loadSettings();
  const hasKey = !!(s.gcloudApiKey && s.gcloudApiKey.trim());
  const hasPassword = !!(webServerPasswordInput ? webServerPasswordInput.value : s.webServerPassword);
  webServerBasicHint.textContent = ui('webServerBasicNeedsPassword');
  webServerBasicHint.classList.toggle('hidden', !(hasKey && !hasPassword));
}

if (webServerPasswordInput) {
  const s = loadSettings();
  if (s.webServerPassword) webServerPasswordInput.value = s.webServerPassword;
  webServerPasswordInput.addEventListener('input', updateWebServerBasicHint);
  webServerPasswordInput.addEventListener('change', () => {
    const settings = loadSettings();
    settings.webServerPassword = webServerPasswordInput.value;
    saveSettings(settings);
    // Sync password to running server if active
    if (window._syncPasswordToServer) window._syncPasswordToServer();
  });
}

// ── Web Server Mode ────────────────────────────────────────────────────────
(function initWebServerMode() {
  // Show web server settings only in Tauri
  if (!(window.__TAURI__ || window.__TAURI_INTERNALS__)) return;
  if (webServerSettings) webServerSettings.classList.remove('hidden');

  function showWebServerError(msg) {
    if (webServerError) {
      webServerError.textContent = msg;
      webServerError.classList.remove('hidden');
    }
  }
  function hideWebServerError() {
    if (webServerError) webServerError.classList.add('hidden');
  }

  /**
   * Push the Web Server secrets (Google Cloud key, access password) to the
   * Rust persistence store through a Tauri command. The HTTP API refuses these
   * fields, so a LAN client can never change them. Runs whether or not the
   * server is active: the values are ready the next time it starts.
   */
  async function syncSecretsToServer(secrets) {
    if (!(window.__TAURI__ || window.__TAURI_INTERNALS__)) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_web_server_secrets', secrets);
    } catch (err) {
      console.warn('[web-server] secrets sync failed:', err);
    }
  }

  /** Sync API keys from desktop localStorage to the embedded web server preferences. */
  function syncApiKeysToServer() {
    const s = loadSettings();
    // Empty string clears a key removed in the desktop settings
    syncSecretsToServer({ password: null, gcloudApiKey: s.gcloudApiKey || '' });
  }
  // Expose globally so settings handlers can call it
  window._syncApiKeysToServer = syncApiKeysToServer;

  /** Sync password from desktop localStorage to the embedded web server preferences. */
  function syncPasswordToServer() {
    const s = loadSettings();
    syncSecretsToServer({ password: s.webServerPassword || '', gcloudApiKey: null });
  }
  // Expose globally so password input handler can call it
  window._syncPasswordToServer = syncPasswordToServer;

  let currentServerInfo = null;

  function renderServerUrlAndQr() {
    if (!currentServerInfo) return;
    // Always the LAN IP address: the "<pc-name>.local" address is no
    // longer offered because Android cannot resolve it.
    const lanUrl = currentServerInfo.lan_url || `http://127.0.0.1:${currentServerInfo.port}`;
    const url = lanUrl;

    if (webServerUrl) {
      webServerUrl.textContent = url;
      webServerUrl.href = url;
    }
    if (webServerQr) {
      // QR generated locally: it works without internet and the LAN address
      // is not sent to an external service.
      try {
        webServerQr.src = qrCodeDataUrl(url);
        webServerQr.classList.remove('hidden');
      } catch (err) {
        console.warn('[web-server] QR code generation failed:', err);
        webServerQr.removeAttribute('src');
        webServerQr.classList.add('hidden');
      }
      webServerQr.alt = `QR: ${url}`;
    }

    if (webServerWarning) {
      if (lanUrl.includes('127.0.0.1')) {
        webServerWarning.classList.remove('hidden');
      } else {
        webServerWarning.classList.add('hidden');
      }
    }
  }

  function updateWebServerUI(active, info) {
    if (!webServerToggle) return;
    webServerToggle.checked = active;
    webServerPort.disabled = active;
    currentServerInfo = active ? info : null;

    if (active && info) {
      renderServerUrlAndQr();
      if (webServerInfo) webServerInfo.classList.remove('hidden');
    } else {
      if (webServerInfo) webServerInfo.classList.add('hidden');
      if (webServerWarning) webServerWarning.classList.add('hidden');
    }
    hideWebServerError();
  }

  if (webServerUrl) {
    webServerUrl.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = webServerUrl.getAttribute('href') || webServerUrl.textContent;
      if (!url || url === '#') return;
      if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('open_browser_url', { url });
        } catch {
          window.open(url, '_blank');
        }
      } else {
        window.open(url, '_blank');
      }
    });
  }

  // Load persisted port from settings
  const s = loadSettings();
  if (s.webServerPort && webServerPort) {
    webServerPort.value = s.webServerPort;
  }

  // Toggle event
  if (webServerToggle) {
    webServerToggle.addEventListener('change', async () => {
      hideWebServerError();
      const active = webServerToggle.checked;

      if (active) {
        // Start server
        const port = parseInt(webServerPort.value, 10) || 8888;
        if (port < 1024 || port > 65535) {
          showWebServerError('Port must be between 1024 and 65535');
          webServerToggle.checked = false;
          return;
        }
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const info = await invoke('start_web_server', { port });
          updateWebServerUI(true, info);
          // Persist port
          const settings = loadSettings();
          settings.webServerPort = port;
          saveSettings(settings);
          // Sync API keys to the server's preference store
          syncApiKeysToServer();
          // Sync password to the server
          syncPasswordToServer();
        } catch (err) {
          const msg = typeof err === 'string' ? err : (err && err.message ? err.message : 'Failed to start server');
          showWebServerError(msg);
          webServerToggle.checked = false;
        }
      } else {
        // Stop server
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('stop_web_server');
          updateWebServerUI(false, null);
        } catch (err) {
          const msg = typeof err === 'string' ? err : (err && err.message ? err.message : 'Failed to stop server');
          showWebServerError(msg);
          // Revert toggle to ON since stop failed
          webServerToggle.checked = true;
        }
      }
    });
  }

  // Port input: save on change
  if (webServerPort) {
    webServerPort.addEventListener('change', () => {
      const settings = loadSettings();
      settings.webServerPort = parseInt(webServerPort.value, 10) || 8888;
      saveSettings(settings);
    });
  }

  // Check current server status on load
  (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const info = await invoke('get_server_status');
      if (info) {
        updateWebServerUI(true, info);
      }
    } catch {
      // Server status command may not exist yet - that's fine
    }
  })();
})();

// ── RAM Advisor ────────────────────────────────────────────────────────────
/**
 * Computes the optimal limit from the total RAM.
 * @param {number} totalRamMb - total RAM in MB
 * @returns {number} - value in MB, max 500
 */
function computeOptimalLimit(totalRamMb) {
  return Math.min(Math.floor(totalRamMb / 4), 500);
}

function showRamAdvisorError(msg) {
  if (ramAdvisorError) {
    ramAdvisorError.textContent = msg;
    ramAdvisorError.classList.remove('hidden');
  }
}

if (optimalLimitBtn) {
  optimalLimitBtn.addEventListener('click', async () => {
    if (!(window.__TAURI__ || window.__TAURI_INTERNALS__)) return;
    if (ramAdvisorError) ramAdvisorError.classList.add('hidden');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ramMb = await invoke('get_system_ram');
      if (!ramMb || ramMb === 0) {
        showRamAdvisorError(ui('oomError'));
        return;
      }
      const optimal = computeOptimalLimit(ramMb);
      maxFileSizeMbInput.value = optimal;
      // Clamp warnFileSizeMB if necessary
      const currentWarn = parseInt(warnFileSizeMbInput.value, 10) || DEFAULT_WARN_FILE_SIZE_MB;
      const clampedWarn = Math.min(currentWarn, optimal - 1);
      warnFileSizeMbInput.value = clampedWarn;
      // Persist
      const s = loadSettings();
      s.maxFileSizeMB = optimal;
      s.warnFileSizeMB = clampedWarn;
      saveSettings(s);
    } catch (err) {
      showRamAdvisorError(ui('oomError') + ': ' + errMsg(err));
    }
  });
}

// Shorthand: translate using current UI language
function ui(key, vars) { return t(loadSettings().uiLang || 'en', key, vars); }

// ── UI utilities ───────────────────────────────────────────────────────────
function showLoading(msg) {
  loadingText.textContent = msg || ui('loading');
  loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// Progress card of PDF work (opening, page extraction, layout analysis): the
// logic is in pdf-progress.js (ported from PDF X-Ray), this only draws it.
const pdfProgressEl = document.getElementById('pdf-progress');
let pdfProgressFadeTimer = null;
const pdfProgress = new PdfProgress({
  t: (key, vars) => ui(key, vars),
  paint: (v) => {
    if (!pdfProgressEl) return;
    clearTimeout(pdfProgressFadeTimer);
    if (!v.visible) {
      pdfProgressEl.classList.add('fading');
      pdfProgressFadeTimer = setTimeout(() => pdfProgressEl.classList.add('hidden'), 400);
      return;
    }
    pdfProgressEl.classList.remove('hidden', 'fading');
    pdfProgressEl.classList.toggle('busy', !!v.busy);
    pdfProgressEl.classList.toggle('error', v.state === 'error');
    const pct = Math.max(0, Math.min(100, (v.fraction || 0) * 100));
    pdfProgressEl.setAttribute('aria-valuenow', String(Math.round(pct)));
    document.getElementById('pdf-progress-phase').textContent = v.phase || '';
    document.getElementById('pdf-progress-detail').textContent = v.detail || '';
    document.getElementById('pdf-progress-eta').textContent = v.eta || '';
    document.getElementById('pdf-progress-bar').style.width = pct.toFixed(1) + '%';
  },
});

/** Analysis callbacks that drive the progress card. */
const pdfProgressHooks = {
  onProgress: (done, total, pageNum) => pdfProgress.extract(done, total, pageNum),
  onAnalyze: (pages) => pdfProgress.analyze(pages),
};

/** Ends the progress run of an analysis with its summary. */
function pdfProgressDone(result) {
  const s = result && result.stats;
  pdfProgress.done(s ? ui('pdfProgressSummary', { pages: s.pageCount, paragraphs: s.paragraphCount }) : '');
}
function hideNoBookPlaceholder() {
  noBookPlaceholder.classList.add('hidden');
}
function setTranslationStatus(msg) {
  translationStatus.textContent = msg;
}

// Shows an alert compatible with Tauri (uses the native dialog) and browser (alert)
async function showAlert(msg) {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    try {
      const { message } = await import('@tauri-apps/plugin-dialog');
      await message(msg, { title: 'Giano Reader' });
    } catch {
      alert(msg);
    }
  } else {
    alert(msg);
  }
}

// Silent, non-blocking notification (unlike showAlert, which opens a
// native dialog with the system sound and must be closed by hand). It disappears on its own.
let _noticeTimer = null;
function showNotice(msg, durationMs = 2000) {
  let el = document.getElementById('app-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-notice';
    el.className = 'app-notice hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => el.classList.add('hidden'), durationMs);
}

// Extracts a readable message from any kind of error (string, Error, Tauri object)
function errMsg(err) {
  if (!err) return ui('unknownError');
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// Label of the current PDF unit: chapter title, or "Pag. N / Tot"
// in the interface language when the PDF is navigated by pages.
function pdfUnitLabel() {
  if (!pdfNav) return '';
  if (pdfNav.mode === 'page') {
    return ui('pdf_page_indicator', { n: pdfNav.currentIndex + 1, total: pdfNav.totalUnits });
  }
  return pdfNav.currentLabel;
}

// ── Progress bar ───────────────────────────────────────────────────────────
function updateProgress() {
  // Every scroll and navigation passes from here: save the reading position shortly after
  scheduleReadingPositionSave();
  // PDF navigation
  if (currentFileType === 'pdf' && pdfNav) {
    const total = pdfNav.totalUnits;
    const pct = total <= 1 ? 0 : (pdfNav.currentIndex / (total - 1)) * 100;
    progressFill.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
    pageInfo.textContent = pdfUnitLabel();
    prevBtn.disabled = pdfNav.currentIndex <= 0;
    nextBtn.disabled = pdfNav.currentIndex >= total - 1;
    return;
  }

  // EPUB navigation
  const total = currentSpineItems.length;
  if (!total) {
    progressFill.style.width = '0%';
    progressThumb.style.left = '0%';
    pageInfo.textContent = '-';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  let pct;
  if (chapterCumulativePct.length === total && chapterLengths.length === total) {
    // Proportional progress: chapter start + intra-chapter scroll
    const chapterStart = chapterCumulativePct[currentSpineIndex];
    const totalChars = chapterLengths.reduce((sum, l) => sum + l, 0);
    const chapterWeight = totalChars > 0 ? (chapterLengths[currentSpineIndex] / totalChars) * 100 : 0;

    // Calculate intra-chapter scroll ratio
    const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
    const scrollRatio = originalViewer.scrollTop / scrollMax;
    pct = Math.min(100, chapterStart + chapterWeight * scrollRatio);
  } else {
    // Fallback: uniform distribution
    pct = total === 1 ? 0 : (currentSpineIndex / (total - 1)) * 100;
  }

  progressFill.style.width = `${pct}%`;
  progressThumb.style.left = `${pct}%`;
  pageInfo.textContent = `${Math.round(pct)}%`;
  prevBtn.disabled = currentSpineIndex <= 0;
  nextBtn.disabled = currentSpineIndex >= total - 1;
}

// Click on the bar → navigates to the corresponding chapter
progressTrack.addEventListener('click', e => {
  if (e.target.classList.contains('progress-tick')) return;

  // PDF navigation
  if (currentFileType === 'pdf' && pdfNav) {
    const rect = progressTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const index = Math.round(ratio * (pdfNav.totalUnits - 1));
    if (pdfNav.goTo(index)) {
      displayPdfUnit();
    }
    return;
  }

  // EPUB navigation
  if (!currentSpineItems.length) return;
  const rect = progressTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

  // With proportional progress: find which chapter the click falls into
  if (chapterCumulativePct.length === currentSpineItems.length) {
    const clickPct = ratio * 100;
    let targetIdx = 0;
    for (let i = chapterCumulativePct.length - 1; i >= 0; i--) {
      if (clickPct >= chapterCumulativePct[i]) {
        targetIdx = i;
        break;
      }
    }
    displayChapter(targetIdx);
  } else {
    displayChapter(Math.round(ratio * (currentSpineItems.length - 1)));
  }
});

// Builds the tick marks on the progress bar after the book loads
function buildProgressTicks(spineItems, tocItems) {
  progressTicks.innerHTML = '';
  const total = spineItems.length;
  if (total < 2) return;

  // href → label map from the TOC to show the chapter title in the tooltip
  const labelMap = {};
  function walkToc(items) {
    for (const item of items) {
      const href = item.href?.split('#')[0] || '';
      if (href && !labelMap[href]) labelMap[href] = item.label?.trim() || '';
      if (item.subitems?.length) walkToc(item.subitems);
    }
  }
  if (tocItems) walkToc(tocItems);

  spineItems.forEach((item, i) => {
    // Uses proportional position if available, otherwise uniform
    const pct = chapterCumulativePct.length === total
      ? chapterCumulativePct[i]
      : (i / (total - 1)) * 100;
    const tick = document.createElement('div');
    tick.className = 'progress-tick';
    tick.style.left = `${pct}%`;
    tick.dataset.idx = i;

    const href = item.href?.split('#')[0] || '';
    const label = labelMap[href]
      || labelMap[item.href]
      || href.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      || ui('chapterN', { n: i + 1 });
    tick.dataset.label = label;

    tick.addEventListener('click', e => { e.stopPropagation(); displayChapter(i); });
    tick.addEventListener('mouseenter', () => showTooltip(tick, label, pct));
    tick.addEventListener('mouseleave', hideTooltip);
    progressTicks.appendChild(tick);
  });
}

function showTooltip(tick, label, pct) {
  progressTooltip.textContent = label;
  progressTooltip.style.left = `${pct}%`;
  progressTooltip.classList.add('visible');
}
function hideTooltip() {
  progressTooltip.classList.remove('visible');
}

// Highlights the current chapter's tick mark
function updateActiveTick() {
  progressTicks.querySelectorAll('.progress-tick').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.idx) === currentSpineIndex);
  });
}

// Generic hover tooltip on the bar
progressTrack.addEventListener('mousemove', e => {
  // PDF tooltip
  if (currentFileType === 'pdf' && pdfNav) {
    const rect = progressTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Find the nearest tick by position
    const ticks = progressTicks.querySelectorAll('.progress-tick');
    let nearest = null;
    let minDist = Infinity;
    ticks.forEach(tick => {
      const tickPos = parseFloat(tick.style.left) / 100;
      const dist = Math.abs(tickPos - ratio);
      if (dist < minDist) { minDist = dist; nearest = tick; }
    });
    if (nearest) showTooltip(nearest, nearest.dataset.label, parseFloat(nearest.style.left));
    return;
  }

  // EPUB tooltip
  if (!currentSpineItems.length) return;
  const rect = progressTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  // Same mapping as the bar click: proportional to the chapter
  // length when known, uniform otherwise.
  let idx = Math.round(ratio * (currentSpineItems.length - 1));
  if (chapterCumulativePct.length === currentSpineItems.length) {
    idx = 0;
    for (let i = chapterCumulativePct.length - 1; i >= 0; i--) {
      if (ratio * 100 >= chapterCumulativePct[i]) { idx = i; break; }
    }
  }
  const tick = progressTicks.querySelector(`[data-idx="${idx}"]`);
  if (tick) showTooltip(tick, tick.dataset.label, parseFloat(tick.style.left));
});
progressTrack.addEventListener('mouseleave', hideTooltip);

// ── Text utilities ─────────────────────────────────────────────────────────
function paragraphsToHtml(paragraphs) {
  return paragraphs.filter(p => {
    if (p && p.type === 'image') return !!p.html;
    return ((p && p.text) || p || '').toString().trim();
  }).map(p => {
    if (p && p.type === 'image') return `<div class="segment-image">${p.html}</div>`;
    const html = p.html !== undefined ? p.html : escapeHtml(p);
    return `<p>${html}</p>`;
  }).join('');
}
// Also escapes quotes: the result is used inside attributes as well.
function escapeHtml(s) {
  if (s == null) return '';
  return escapeHtmlText(s);
}

// Inline tags whose formatting must be preserved in the translated text.
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'span', 'small', 'mark', 'code', 'abbr', 'q', 'cite', 'br', 'img']);

// Resolves an image's src/href attribute (relative to the chapter file)
// into a persistent blob/data URL using epubjs resources.
// `imgResolver` is a {originalSrc → resolvedUrl} map built by buildImageResolver.
function resolveImgSrc(rawSrc, imgResolver) {
  if (!rawSrc || !imgResolver) return rawSrc;
  if (/^(blob:|data:|https?:)/i.test(rawSrc)) return rawSrc;
  // Try a direct match, then by basename (EPUBs use various relative paths)
  if (imgResolver.has(rawSrc)) return imgResolver.get(rawSrc);
  const base = rawSrc.split(/[\\/]/).pop();
  if (base && imgResolver.has(base)) return imgResolver.get(base);
  return rawSrc;
}

// Serializes the inline content of an element preserving links, basic
// formatting and images (with remapped src), but removing dangerous attributes.
// Used for the original panel in text mode.
function safeInnerHtml(el, imgResolver = null) {
  const clone = el.cloneNode(true);
  // Remove inline scripts and styles
  clone.querySelectorAll('script, style').forEach(n => n.remove());
  // Normalize links: keep only href, handle the click via JS
  clone.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    // Remove all attributes except href
    Array.from(a.attributes).forEach(attr => {
      if (attr.name !== 'href') a.removeAttribute(attr.name);
    });
    a.setAttribute('data-epub-href', href);
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
  });
  // Remap the src of inline images to persistent blob URLs
  clone.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    const resolved = resolveImgSrc(src, imgResolver);
    if (resolved) img.setAttribute('src', resolved);
    img.setAttribute('loading', 'lazy');
    img.classList.add('inline-img');
    // Remove unneeded handlers/attributes
    Array.from(img.attributes).forEach(attr => {
      if (!['src', 'alt', 'loading', 'width', 'height', 'class'].includes(attr.name)) img.removeAttribute(attr.name);
    });
  });
  // Whitelist of tags/attributes: EPUB markup is untrusted and ends up in the
  // main document, which has access to the Tauri APIs.
  sanitizeTree(clone);
  return clone.innerHTML;
}

// Serializes a standalone image block (img/figure/svg-image) remapping the
// src to blob URLs. Returns the HTML of the image block.
function buildImageBlockHtml(el, imgResolver) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script, style').forEach(n => n.remove());
  const imgs = el.tagName.toLowerCase() === 'img' ? [clone] : Array.from(clone.querySelectorAll('img'));
  imgs.forEach(img => {
    const src = img.getAttribute('src') || '';
    const resolved = resolveImgSrc(src, imgResolver);
    if (resolved) img.setAttribute('src', resolved);
    img.setAttribute('loading', 'lazy');
    Array.from(img.attributes).forEach(attr => {
      if (!['src', 'alt', 'loading', 'width', 'height'].includes(attr.name)) img.removeAttribute(attr.name);
    });
  });
  // Also remap SVG <image href> (some EPUBs use SVG for figures)
  clone.querySelectorAll('image').forEach(im => {
    const href = im.getAttribute('href') || im.getAttribute('xlink:href') || '';
    const resolved = resolveImgSrc(href, imgResolver);
    if (resolved) {
      im.setAttribute('href', resolved);
      im.removeAttribute('xlink:href');
    }
  });
  sanitizeTree(clone, { includeRoot: true });
  return clone.tagName ? clone.outerHTML : clone.innerHTML;
}

// Checks whether an element is a standalone "image" block (figure without text).
function isImageBlock(el) {
  const tag = el.tagName?.toLowerCase();
  if (tag === 'img' || tag === 'figure' || tag === 'svg') return true;
  return false;
}

// Placeholder token for inline images during translation.
// Uses "mathematical brackets" characters (U+27E6/U+27E7) that translation
// engines tend to preserve unaltered.
const INLINE_IMG_TOKEN_OPEN = '\u27E6IMG';
const INLINE_IMG_TOKEN_CLOSE = '\u27E7';
function inlineImgToken(i) { return `${INLINE_IMG_TOKEN_OPEN}${i}${INLINE_IMG_TOKEN_CLOSE}`; }
// Tolerant regex: also captures any spaces inserted by the translator (e.g. "⟦ IMG 0 ⟧").
const INLINE_IMG_TOKEN_RE = /\u27E6\s*IMG\s*(\d+)\s*\u27E7/g;

// Produces the sanitized HTML of a single inline <img> (src remapped).
function inlineImgHtml(img, imgResolver) {
  const clone = img.cloneNode(false);
  const src = clone.getAttribute('src') || '';
  const resolved = resolveImgSrc(src, imgResolver);
  if (resolved) clone.setAttribute('src', resolved);
  clone.setAttribute('loading', 'lazy');
  clone.classList.add('inline-img');
  Array.from(clone.attributes).forEach(attr => {
    if (!['src', 'alt', 'loading', 'width', 'height', 'class'].includes(attr.name)) clone.removeAttribute(attr.name);
  });
  if (!isSafeResourceUrl(clone.getAttribute('src') || '')) clone.removeAttribute('src');
  return clone.outerHTML;
}

// Extracts the text of a block replacing each inline <img> with a
// placeholder token, and returns { text, inlineImages } where inlineImages[i] is the HTML
// of the i-th image. Preserves the document order of the images.
function extractTextWithInlineImages(el, imgResolver) {
  const inlineImages = [];
  const walk = (node) => {
    let out = '';
    node.childNodes.forEach(child => {
      if (child.nodeType === 3) { // text
        out += child.nodeValue;
      } else if (child.nodeType === 1) { // element
        const tag = child.tagName.toLowerCase();
        if (tag === 'img') {
          const idx = inlineImages.length;
          inlineImages.push(inlineImgHtml(child, imgResolver));
          out += ` ${inlineImgToken(idx)} `;
        } else {
          out += walk(child);
        }
      }
    });
    return out;
  };
  const text = walk(el).replace(/\s+/g, ' ').trim();
  return { text, inlineImages };
}

// Extracts segments from a DOM node (body of an EPUB chapter), in document order.
// Returns segment objects:
//   { type: 'text',  text, html, id, inlineImages }  → translated; inline <img>
//        are replaced by ⟦IMGn⟧ tokens in the text and reinserted after translation
//   { type: 'image', html, id, alt }   → not translated, image mirrored in both panels
// `imgResolver` (Map src→blobUrl) remaps image src to persistent URLs.
function extractParagraphs(body, imgResolver = null) {
  const textSelectors = TEXT_BLOCK_TAGS;
  const imageSelectors = ['figure', 'img', 'svg'];
  const allSelectors = [...textSelectors, ...imageSelectors];
  const rawBlocks = body.querySelectorAll?.(allSelectors.join(', '));

  // Filter nested blocks to avoid duplication:
  // - an <img> inside a <figure> or inside a text block must be excluded (already covered)
  // - a text block that contains other blocks (<li><p>…</p></li>, nested
  //   lists, <blockquote> of paragraphs) yields only its own text: see
  //   ownTextSource below
  const blocks = rawBlocks ? Array.from(rawBlocks).filter(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'svg') {
      // Exclude if it is inside a figure (the figure will be taken as a block) or inside a text block
      if (el.closest('figure')) return false;
      if (el.closest(textSelectors.join(', '))) return false;
      return true;
    }
    return true;
  }) : rawBlocks;

  if (blocks && blocks.length > 0) {
    const r = [];
    const seenIds = new Set();
    const takeId = (el) => {
      let id = el.id || null;
      if (!id) {
        let parent = el.parentElement;
        while (parent && parent !== body) {
          if (parent.id) { id = parent.id; break; }
          parent = parent.parentElement;
        }
      }
      if (id && seenIds.has(id)) id = null;
      if (id) seenIds.add(id);
      return id;
    };
    blocks.forEach(el => {
      if (isImageBlock(el)) {
        // Standalone image block: no text to translate
        const html = buildImageBlockHtml(el, imgResolver);
        if (!html) return;
        const alt = el.querySelector?.('img')?.getAttribute('alt')
          || el.getAttribute?.('alt') || '';
        r.push({ type: 'image', html, id: takeId(el), alt });
        return;
      }
      // Text with tokens for inline images (for post-translation realignment)
      // Without the text of nested blocks, which are already blocks of their own
      const source = ownTextSource(el);
      if (!source) return;
      const { text, inlineImages } = extractTextWithInlineImages(source, imgResolver);
      if (!text && !inlineImages.length) return;
      r.push({ type: 'text', text, html: safeInnerHtml(source, imgResolver), id: takeId(el), inlineImages });
    });
    if (r.length) return r;
  }
  // Fallback: split by newline (also works on XMLDocument)
  return (body.textContent || '').split('\n')
    .map(l => l.trim()).filter(l => l.length > 2)
    .map(text => ({ type: 'text', text, html: escapeHtml(text), id: null, inlineImages: [] }));
}

// Builds a src→blobUrl map for all the images referenced in the body
// of the chapter, using epubjs resources (already remapped to blob URLs).
// Returns a Map that covers both the original relative paths and the basenames.
async function buildImageResolver(book, spineItem, body) {
  const resolver = new Map();
  if (!book || !body?.querySelectorAll) return resolver;

  // Collect all the image src/href present in the chapter
  const rawSrcs = new Set();
  body.querySelectorAll('img[src]').forEach(img => {
    const s = img.getAttribute('src');
    if (s) rawSrcs.add(s);
  });
  body.querySelectorAll('image').forEach(im => {
    const s = im.getAttribute('href') || im.getAttribute('xlink:href');
    if (s) rawSrcs.add(s);
  });
  if (!rawSrcs.size) return resolver;

  // Make sure the resources have been remapped to blob URLs by epubjs.
  try {
    if (book.resources && typeof book.resources.replacements === 'function'
        && (!book.resources.replacementUrls || !book.resources.replacementUrls.length)) {
      await book.resources.replacements();
    }
  } catch (e) {
    console.warn('[img] resources.replacements() failed:', e);
  }

  const sectionUrl = spineItem?.url || spineItem?.canonical || spineItem?.href || '';

  for (const raw of rawSrcs) {
    let resolved = null;
    // 1) Via resources.substitute: builds a fragment and lets epubjs
    //    sostituisca l'URL relativo (rispetto a section.url) col blob URL.
    try {
      if (book.resources && typeof book.resources.substitute === 'function') {
        const marker = `<img src="${raw}">`;
        const out = book.resources.substitute(marker, sectionUrl);
        const m = out && out.match(/src="([^"]+)"/);
        if (m && m[1] && m[1] !== raw) resolved = m[1];
      }
    } catch (_) { /* fallback sotto */ }

    // 2) Fallback: resolve the absolute path and create a blob URL from the archive.
    if (!resolved) {
      try {
        const absolute = book.resolve ? book.resolve(raw) : raw;
        if (book.archive && typeof book.archive.createUrl === 'function') {
          resolved = await book.archive.createUrl(absolute, { base64: false });
        }
      } catch (e) {
        // Last attempt: try to resolve relative to the chapter's directory
        try {
          const dir = sectionUrl.replace(/[^/]*$/, '');
          const absolute = book.resolve ? book.resolve(dir + raw) : raw;
          if (book.archive && typeof book.archive.createUrl === 'function') {
            resolved = await book.archive.createUrl(absolute, { base64: false });
          }
        } catch (_) { /* image not resolvable */ }
      }
    }

    if (resolved) {
      resolver.set(raw, resolved);
      const base = raw.split(/[\\/]/).pop();
      if (base && !resolver.has(base)) resolver.set(base, resolved);
    }
  }

  return resolver;
}

// ── Synchronized scroll between the two panels ─────────────────────────────
let activeScrollSource = null;
let syncTimeout = null;
let currentScrollUnbind = null; // function to detach the current sync listeners

// Computes the target scroll percentage given the source one and a stored offset.
// Returns a value in [0,1]. The pure logic is exported for tests.
function computeSyncedPct(sourcePct, offsetPct) {
  const p = sourcePct + offsetPct;
  return Math.min(1, Math.max(0, p));
}

// Abstracts a scrollable element (div .text-panel or EPUB iframe) exposing
// getPct()/setPct() in [0,1] and a way to (dis)connect the scroll listener.
function makeScrollable(kind) {
  if (kind === 'iframe') {
    const frame = document.getElementById('epub-native-frame');
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const scroller = doc?.scrollingElement || doc?.documentElement || doc?.body;
    if (!frame || !win || !scroller) return null;
    return {
      el: win,
      getPct: () => scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight),
      setPct: (p) => { scroller.scrollTop = p * (scroller.scrollHeight - scroller.clientHeight); },
      on: (fn) => win.addEventListener('scroll', fn, { passive: true }),
      off: (fn) => win.removeEventListener('scroll', fn),
    };
  }
  const el = kind === 'translation' ? translationViewer
    : kind === 'nativePdf' ? originalNative
    : originalViewer;
  return {
    el,
    getPct: () => el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight),
    setPct: (p) => { el.scrollTop = p * (el.scrollHeight - el.clientHeight); },
    on: (fn) => { el.onscroll = fn; },
    off: () => { el.onscroll = null; },
  };
}

// Recomputes and stores the current offset between the two panels, so that when
// sync is (re)enabled the scroll continues keeping the delta instead of
// abruptly realigning the percentages (allows manual realignment).
function recomputeSyncOffset() {
  const { left, right } = getSyncPair();
  if (!left || !right) { syncOffsetPct = 0; syncOffsetPx = 0; return; }
  syncOffsetPct = right.getPct() - left.getPct();
  syncOffsetPx = currentViewMode === 'text' ? paragraphOffset(left.el, right.el) : 0;
}

// Determines the pair of scrollable panels based on mode/file type.
function getSyncPair() {
  if (currentViewMode === 'original' && currentFileType === 'pdf') {
    return { left: makeScrollable('nativePdf'), right: makeScrollable('translation') };
  }
  if (currentViewMode === 'original' && book) {
    return { left: makeScrollable('iframe'), right: makeScrollable('translation') };
  }
  return { left: makeScrollable('text'), right: makeScrollable('translation') };
}

// Diagnostics of the scroll sync: localStorage.setItem('giano-debug-scroll', '1') and reload.
function SCROLL_DEBUG() {
  try { return localStorage.getItem('giano-debug-scroll') === '1'; } catch { return false; }
}
function logScrollSync(fromLeft, left, right) {
  const info = (p) => {
    const el = p.el && p.el.scrollTop !== undefined ? p.el : null;
    if (!el) return 'n/a';
    return `top=${Math.round(el.scrollTop)} range=${Math.round(el.scrollHeight - el.clientHeight)} (scrollH=${el.scrollHeight} clientH=${el.clientHeight} clientW=${el.clientWidth}) pct=${p.getPct().toFixed(4)}`;
  };
  console.log(`[scroll-sync] from ${fromLeft ? 'LEFT' : 'RIGHT'} offset=${syncOffsetPct.toFixed(4)}
  left : ${info(left)}
  right: ${info(right)}`);
}

function bindSyncScroll() {
  // Stacca eventuali listener precedenti
  if (currentScrollUnbind) { currentScrollUnbind(); currentScrollUnbind = null; }

  const { left, right } = getSyncPair();
  if (!left || !right) return;

  // generic source→target handler that applies the stored offset
  const handleScroll = (source, target, isLeftSource) => {
    if (!syncScrollEnabled) { updateProgress(); return; }
    if (syncingScroll) return;
    if (activeScrollSource && activeScrollSource !== source) return;
    if (!activeScrollSource) activeScrollSource = source;

    syncingScroll = true;
    const sp = source.getPct();
    if (SCROLL_DEBUG()) logScrollSync(isLeftSource, left, right);
    // Text view: follow the paragraphs (same data-idx at the top of both
    // panels, plus the manual offset in px), so the panels do not drift when
    // the translation is longer/shorter than the original.
    const byParagraph = currentViewMode === 'text'
      && syncByParagraph(source.el, target.el, syncOffsetPx, isLeftSource);
    if (!byParagraph) {
      // offset is defined as right - left; if the source is the right panel
      // (right) the offset must be subtracted, if it is the left one it must be added.
      const targetPct = isLeftSource
        ? computeSyncedPct(sp, syncOffsetPct)
        : computeSyncedPct(sp, -syncOffsetPct);
      target.setPct(targetPct);
    }
    updateProgress();

    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      syncingScroll = false;
      activeScrollSource = null;
    }, 50);
  };

  const onLeft = () => handleScroll(left, right, true);
  const onRight = () => handleScroll(right, left, false);
  left.on(onLeft);
  right.on(onRight);
  // cleanup
  currentScrollUnbind = () => { try { left.off(onLeft); } catch (_) {} try { right.off(onRight); } catch (_) {} };
}

// ── View mode ──────────────────────────────────────────────────────────────
function setViewMode(mode, { skipRender = false } = {}) {
  currentViewMode = mode;
  const isOriginal = mode === 'original';
  // New view → start over with alignment without offset
  syncOffsetPct = 0;
  syncOffsetPx = 0;

  // Shows/hides the containers
  originalViewer.classList.toggle('hidden', isOriginal);
  originalNative.classList.toggle('hidden', !isOriginal);

  // Visual state of the toggle
  viewToggleBtn.setAttribute('aria-pressed', String(isOriginal));
  viewToggleBtn.classList.toggle('active', isOriginal);

  // Scroll sync
  if (isOriginal) {
    originalViewer.onscroll = null;
    translationViewer.onscroll = null;
    if (!skipRender) {
      if (currentFileType === 'pdf' && pdfDoc && pdfNav) {
        renderNativeView();
        // For PDF, also trigger translation overlay
        if (!translationHidden) {
          translateCurrentChapter(0);
        }
      } else if (book && currentSpineItems.length) {
        renderNativeView();
        // EPUB: enables translation in the right panel even in original view.
        // The iframe↔translation scroll sync is hooked up in renderNativeView
        // (frame.onload) and rebound below when the translation is ready.
        if (!translationHidden) {
          translateCurrentChapter(0);
        }
      }
    }
  } else {
    // Switching back to text mode — abort any active PDF overlay translation and clean up
    if (currentFileType === 'pdf') {
      // Abort active translation immediately (Req 6.2)
      if (translationAbortController) translationAbortController.abort();
      if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
      // Remove all overlay placeholders from the Translation Panel DOM (Req 6.2)
      translationViewer.innerHTML = '';
      originalNative.innerHTML = '';
      originalNative.onscroll = null;
    }
    bindSyncScroll();
    if (!skipRender) {
      if (currentFileType === 'pdf' && pdfDoc && pdfNav) {
        displayChapter(pdfNav.currentIndex);
      } else if (book && currentSpineItems.length) {
        displayChapter(currentSpineIndex);
      }
    }
  }

  // The scroll sync toggle is useful when the two panels have different layouts
  // (EPUB original view with iframe, or PDF): show it only there.
  updateSyncUi();
  updateFontControls();
}

// Updates the visibility of the sync toggle and the visual state of the percentage
// based on mode/state. When sync is off, the percentage
// (#translation-status) is highlighted in red — no text warning,
// so the controls do not move.
function updateSyncUi() {
  // The toggle is available in both modes (text and original), so
  // sync can always be re-enabled even after a view change.
  const showToggle = !!(book || (pdfDoc && pdfNav));
  if (toggleSyncBtn) {
    toggleSyncBtn.classList.toggle('hidden', !showToggle);
    toggleSyncBtn.setAttribute('aria-pressed', String(syncScrollEnabled));
    toggleSyncBtn.classList.toggle('active', syncScrollEnabled);
  }
  // Text warning always hidden (replaced by the red percentage)
  if (syncDisabledNotice) syncDisabledNotice.classList.add('hidden');
  // Red percentage when sync is off
  if (translationStatus) {
    translationStatus.classList.toggle('sync-off', showToggle && !syncScrollEnabled);
  }
}

// ── Font controls state ───────────────────────────────────────────────────
// The font family is always available: in the Original view of a PDF it is
// applied to the translation boxes laid over the page (a narrow font helps a
// longer translation fit). The text size is disabled only there, because the
// boxes take the size of the original text. The state is derived from the
// current file and view every time, so it cannot stay stuck after a change.
function updateFontControls() {
  const sizeDisabled = currentFileType === 'pdf' && currentViewMode === 'original';
  const sizeRow = fontSizeRange ? fontSizeRange.closest('.settings-row-inline') : null;
  const ctxSizeRange = document.getElementById('ctx-size-range');
  const ctxSizeGroup = ctxSizeRange ? ctxSizeRange.closest('.context-menu-group') : null;
  const tooltip = sizeDisabled ? ui('pdf_canvas_tooltip') : '';
  [sizeRow, ctxSizeGroup].filter(Boolean).forEach(el => {
    el.classList.toggle('controls-disabled', sizeDisabled);
    el.title = tooltip;
  });
  if (fontSizeRange) fontSizeRange.disabled = sizeDisabled;
  if (ctxSizeRange) ctxSizeRange.disabled = sizeDisabled;
}

// Font family of the PDF translation boxes: the one chosen by the user, or
// (never chosen) the family of the original text.
function pdfOverlayFontFamily() {
  return loadSettings().fontFamily || null;
}

// ── Native view rendering ──────────────────────────────────────────────────
async function renderNativeView() {
  // Called without await from theme/font/zoom: two renderings in quick succession must not
  // both add their own content (duplicate iframes or canvases).
  const myRender = ++nativeRenderGeneration;
  originalNative.innerHTML = '';

  // ── PDF canvas rendering ──────────────────────────────────────────────────
  if (currentFileType === 'pdf') {
    if (!pdfDoc || !pdfNav) {
      originalNative.innerHTML = `<p class="placeholder">${ui('noContent')}</p>`;
      return;
    }
    try {
      const range = pdfNav.pageRange;
      const pageNumbers = [];
      for (let i = range.start; i <= range.end; i++) pageNumbers.push(i);

      // Stops (without adding more canvases) if a more recent rendering starts
      await renderPdfCanvas(pdfDoc.proxy, pageNumbers, originalNative,
        () => myRender === nativeRenderGeneration);
      if (myRender !== nativeRenderGeneration) return;
      updateFontControls();
    } catch (err) {
      if (myRender !== nativeRenderGeneration) return;
      console.error('[native] PDF canvas rendering error:', err);
      originalNative.innerHTML = `<p class="placeholder">${ui('pdf_rendering_unavailable')}</p>`;
    }
    return;
  }

  // ── EPUB iframe rendering ─────────────────────────────────────────────────
  if (book) {
    try {
      const spineItem = currentSpineItems[currentSpineIndex];
      const html = await spineItem.render(book.load.bind(book));
      if (myRender !== nativeRenderGeneration) return;
      const frame = document.createElement('iframe');
      frame.id = 'epub-native-frame';
      frame.className = 'native-frame';
      const bg = getComputedStyle(document.body).backgroundColor || '#1a1a1a';
      const fg = getComputedStyle(document.body).color || '#e0e0e0';
      const font = getComputedStyle(document.documentElement).getPropertyValue('--reader-font-family') || 'Georgia, serif';
      const size = getComputedStyle(document.documentElement).getPropertyValue('--font-size') || '16px';
      // Fonts bundled with the app (e.g. Roboto Condensed) for the book's iframe
      const bundledFonts = `<link rel="stylesheet" href="${new URL('/fonts/roboto-condensed/fonts.css', location.href).href}">`;
      const themeStyle = bundledFonts + `<style>html,body{background:${bg}!important;color:${fg}!important;font-family:${font}!important;font-size:${size}!important;line-height:1.8;padding:1rem;margin:0;max-width:100%;overflow-x:hidden;}img,table,svg{max-width:100%!important;height:auto;}pre{white-space:pre-wrap;overflow-wrap:break-word;}a{color:inherit;}</style>`;
      // Security: EPUB content is untrusted. A srcdoc iframe inherits
      // the parent's origin, so without a sandbox the book's <script>s
      // would run with access to the Tauri APIs (filesystem). "allow-same-origin"
      // WITHOUT "allow-scripts" disables every book script but leaves the
      // parent access to contentDocument (scroll sync, anchors, link clicks).
      frame.setAttribute('sandbox', 'allow-same-origin');
      // When the iframe has loaded its content: intercepts clicks on links
      // (from the parent, since no scripts run in the iframe) and hooks up the
      // scroll sync (scrolling happens inside the iframe's document).
      frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        if (doc) {
          doc.addEventListener('click', e => {
            const a = e.target && e.target.closest ? e.target.closest('a') : null;
            if (!a) return;
            e.preventDefault();
            handleEpubLink(a.getAttribute('href') || '');
          });
        }
        if (currentViewMode === 'original' && !translationHidden) bindSyncScroll();
      });
      frame.srcdoc = themeStyle + html;
      originalNative.replaceChildren(frame);
    } catch (err) {
      if (myRender !== nativeRenderGeneration) return;
      console.error('[native] rendering error:', err);
      originalNative.innerHTML = `<p class="placeholder">${ui('errorChapter')}${errMsg(err)}</p>`;
    }
  } else {
    originalNative.innerHTML = `<p class="placeholder">${ui('noContent')}</p>`;
  }
}

viewToggleBtn.addEventListener('click', () => {
  setViewMode(currentViewMode === 'text' ? 'original' : 'text');
});

// Scroll sync toggle (on by default). On RE-ACTIVATION it does not
// realign the percentages: it stores the current offset between the two panels
// so scrolling continues keeping the delta (manual realignment).
if (toggleSyncBtn) {
  toggleSyncBtn.addEventListener('click', () => {
    syncScrollEnabled = !syncScrollEnabled;
    if (syncScrollEnabled) {
      // Capture the current offset before resuming propagation
      recomputeSyncOffset();
    }
    updateSyncUi();
  });
}

// Double click on the percentage: automatic realignment. In text view the right
// panel is scrolled to the same paragraph as the left one (same paragraph index,
// same point inside it), and the resulting offset is kept for the scroll sync.
// Where there are no matching paragraphs (EPUB iframe, PDF) it falls back to
// the same percentage.
if (translationStatus) {
  translationStatus.style.cursor = 'pointer';
  translationStatus.title = ui('resyncHint');
  translationStatus.addEventListener('dblclick', () => {
    syncOffsetPct = 0;
    syncOffsetPx = 0;
    const { left, right } = getSyncPair();
    if (left && right) {
      syncingScroll = true;
      const byParagraph = currentViewMode === 'text'
        && alignByParagraph(left.el, right.el);
      if (byParagraph) syncOffsetPct = right.getPct() - left.getPct();
      else right.setPct(left.getPct());
      updateProgress();
      setTimeout(() => { syncingScroll = false; activeScrollSource = null; }, 60);
    }
  });
}

// ── Handling of links clicked in the iframe (original mode) ──────────────
// Called by the click listener attached by the parent to the iframe's document.
function handleEpubLink(href) {
  if (!href) return;
  if (isExternalHttpUrl(href)) {
    openExternalLink(href);
    return;
  }
  // Non-http(s) schemes (javascript:, mailto:, file:, …) are not followed
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;

  // Split file and anchor: "chapter02.xhtml#note-1" → file="chapter02.xhtml", anchor="note-1"
  const [filePart, anchor] = href.split('#');

  if (filePart) {
    // Link to another chapter (with or without anchor)
    const spineItem = book.spine.get(filePart);
    let idx = spineItem ? currentSpineItems.indexOf(spineItem) : -1;
    if (idx < 0) {
      const fileBase = filePart.split('/').pop();
      idx = currentSpineItems.findIndex(i => {
        if (i.href === filePart) return true;
        return (i.href || '').split('/').pop() === fileBase;
      });
    }
    if (idx >= 0) {
      displayChapter(idx).then(() => {
        if (anchor) scrollToAnchor(anchor);
      });
    }
  } else if (anchor) {
    // Link to an anchor in the same chapter
    scrollToAnchor(anchor);
  }
}

// Scrolls to the element whose id/name matches the anchor in the current iframe
function scrollToAnchor(anchor) {
  const frame = document.getElementById('epub-native-frame');
  if (!frame || !frame.contentDocument) return;
  const target = frame.contentDocument.getElementById(anchor)
    || frame.contentDocument.querySelector(`[name="${anchor}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Scrolls to the element whose id matches in the original text panel
function scrollToTocAnchor(anchor) {
  if (!anchor) return;

  // 1. Look directly in the viewer (id already propagated by extractParagraphs)
  const target = originalViewer.querySelector(`[id="${anchor}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // 2. Fallback: use the original chapter's DOM to map the position
  //    of the anchor to the nearest paragraph in the viewer.
  if (currentChapterBody && currentViewMode !== 'original') {
    const anchorEl = currentChapterBody.querySelector(`[id="${anchor}"], [name="${anchor}"]`);
    if (anchorEl) {
      // Collect all the blocks extracted in the original document (same selector as extractParagraphs)
      const blockSelectors = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
      const allBlocks = Array.from(currentChapterBody.querySelectorAll(blockSelectors))
        .filter(el => (el.textContent || '').trim());
      if (allBlocks.length) {
        // Find the block immediately after (or containing) the anchor
        let bestIdx = 0;
        for (let i = 0; i < allBlocks.length; i++) {
          // DOM position comparison: if the block comes after the anchor, stop
          const pos = anchorEl.compareDocumentPosition(allBlocks[i]);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
            bestIdx = i;
            break;
          }
          // If the anchor is inside the block or before it, this is the candidate
          if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY || pos === 0) {
            bestIdx = i;
            break;
          }
          bestIdx = i; // keep updating (takes the last "preceding" one)
        }
        // Map the block index → paragraph in the viewer
        const viewerParagraphs = originalViewer.querySelectorAll('p[data-idx]');
        if (viewerParagraphs.length > bestIdx) {
          viewerParagraphs[bestIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        } else if (viewerParagraphs.length > 0) {
          viewerParagraphs[viewerParagraphs.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
    }
  }

  // 3. If in native/original view mode, try the iframe
  if (currentViewMode === 'original') {
    scrollToAnchor(anchor);
  }
}

// Reinserts the inline images into the text (already escaped) replacing the
// ⟦IMGn⟧ tokens with the corresponding <img> HTML. Images whose tokens were
// lost in translation are appended at the end so they are never dropped.
function reinsertInlineImages(safeText, inlineImages) {
  if (!inlineImages || !inlineImages.length) {
    // Remove any leftover tokens (paragraph without images)
    return safeText.replace(INLINE_IMG_TOKEN_RE, '').replace(/\s{2,}/g, ' ').trim();
  }
  const used = new Set();
  let out = safeText.replace(INLINE_IMG_TOKEN_RE, (_m, n) => {
    const idx = parseInt(n, 10);
    if (idx >= 0 && idx < inlineImages.length) {
      used.add(idx);
      return inlineImages[idx];
    }
    return '';
  });
  // Append the images whose tokens were lost during translation
  const missing = inlineImages.filter((_, i) => !used.has(i));
  if (missing.length) {
    out = out.trim() + ' ' + missing.join(' ');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

// Reapplies to the translated text the "block-level" inline formatting
// present in the original segment, reliably in all translation modes
// (FREE/BASIC return plain text; PRO may return markup).
//
// Strategy:
//  - inline images are always reinserted from the ⟦IMGn⟧ tokens
//  - if the whole content is wrapped in ONE inline wrapper (e.g. the whole sentence
//    in <em>/<strong>/<a>) → reapply that wrapper around the translation
//  - links (<a data-epub-href>) that cover the whole block are preserved
//  - otherwise plain text + inline images are used (no loss of
//    content: only some inner italics/bold are not reapplied)
function applyInlineFormatting(originalHtml, translatedText, inlineImages = []) {
  const safeText = escapeHtml(translatedText);
  const withImages = reinsertInlineImages(safeText, inlineImages);

  if (!originalHtml || originalHtml.indexOf('<') === -1) return withImages;

  const tmp = document.createElement('div');
  tmp.innerHTML = originalHtml;

  const elementChildren = Array.from(tmp.childNodes).filter(
    n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())
  );

  // Case: single inline element wrapping all the content (excluding img,
  // already handled by the tokens). Reapply the wrapper around text+images.
  if (elementChildren.length === 1 && elementChildren[0].nodeType === 1) {
    const el = elementChildren[0];
    const tag = el.tagName.toLowerCase();
    if (tag !== 'img' && INLINE_TAGS.has(tag)) {
      const wrapper = el.cloneNode(false);
      wrapper.innerHTML = withImages;
      return wrapper.outerHTML;
    }
  }

  // Case: the block contains a single link covering the whole text → preserve it
  const links = tmp.querySelectorAll('a[data-epub-href]');
  if (links.length === 1 && (links[0].textContent || '').trim() === (tmp.textContent || '').trim()) {
    const a = links[0].cloneNode(false);
    a.innerHTML = withImages;
    return a.outerHTML;
  }

  // Fallback: translated text + reinserted inline images
  return withImages;
}

// Builds the innerHTML of a translated paragraph (number + formatted content).
function buildTranslatedParagraphHtml(segment, translatedText, displayIndex) {
  const originalHtml = segment && segment.html !== undefined ? segment.html : '';
  const inlineImages = (segment && segment.inlineImages) || [];
  const inner = applyInlineFormatting(originalHtml, translatedText, inlineImages);
  return `<span class="para-num">${displayIndex}</span>${inner}`;
}

// Opens an external URL in the system browser (Tauri) or in a new tab (browser).
async function openExternalLink(url) {
  if (!isExternalHttpUrl(url)) return;
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_browser_url', { url });
      return;
    } catch (e) {
      console.warn('[link] Tauri open_browser_url failed:', e);
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Text panels rendering ──────────────────────────────────────────────────
function renderOriginal(paragraphs) {
  originalViewer.innerHTML = '';
  if (paragraphs.length) {
    paragraphs.forEach((p, i) => {
      // Image segment: non-text block, rendered identically in both panels
      if (p && p.type === 'image') {
        const div = document.createElement('div');
        div.dataset.idx = i;
        if (p.id) div.id = p.id;
        div.className = 'segment-image';
        div.innerHTML = p.html;
        originalViewer.appendChild(div);
        return;
      }
      const text = p.text !== undefined ? p.text : p;
      if (!text.trim()) return;
      const html = p.html !== undefined ? p.html : escapeHtml(p);
      const pEl = document.createElement('p');
      pEl.dataset.idx = i;
      if (p.id) pEl.id = p.id;
      pEl.classList.add(`pair-color-${i % 5}`);
      pEl.innerHTML = `<span class="para-num">${i + 1}</span>${html}`;
      originalViewer.appendChild(pEl);
    });
  } else {
    originalViewer.innerHTML = `<p class="placeholder">${ui('noContent')}</p>`;
  }
  originalViewer.scrollTop = 0;
}

// Clicks on EPUB links (<a data-epub-href>) in both text panels: the translation
// keeps the link when it covers the whole block (applyInlineFormatting).
// Delegated once on the panels, so it also covers paragraphs translated later.
// Anchors are looked up in the original panel; the scroll sync moves the other.
function followEpubTextLink(href) {
  if (!href) return;
  if (isExternalHttpUrl(href)) {
    openExternalLink(href);
    return;
  }
  // Non-http(s) schemes (javascript:, file:, …) are not followed
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  const [filePart, anchor] = href.split('#');
  const scrollToAnchor = () => {
    if (!anchor) return;
    const target = originalViewer.querySelector(`[id="${CSS.escape(anchor)}"], [name="${CSS.escape(anchor)}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (filePart) {
    const idx = currentSpineItems.findIndex(i =>
      i.href === filePart || i.href?.endsWith(filePart) || filePart?.endsWith(i.href)
    );
    if (idx >= 0) displayChapter(idx).then(scrollToAnchor);
  } else {
    scrollToAnchor();
  }
}

// Manual and issue tracker links in the settings footer: open them in the
// system browser, never inside the app window.
['settings-manual-link', 'settings-issues-link'].forEach(id => {
  const a = document.getElementById(id);
  if (a) a.addEventListener('click', e => { e.preventDefault(); openExternalLink(a.href); });
});

[originalViewer, translationViewer].forEach(panel => {
  panel.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-epub-href]') : null;
    if (!a || !panel.contains(a)) return;
    e.preventDefault();
    followEpubTextLink(a.getAttribute('data-epub-href') || '');
  });
});
function renderTranslationPlaceholder(msg) {
  translationViewer.innerHTML = `<p class="placeholder">${msg}</p>`;
  translationViewer.scrollTop = 0;
}

/**
 * Shrinks the font size of an overlay element until its content fits within its maxHeight.
 * Reduces font by 0.5px steps down to a minimum of 6px.
 */
function shrinkFontToFit(el) {
  const maxH = parseFloat(el.style.maxHeight);
  if (!maxH || maxH <= 0) return;
  let fontSize = parseFloat(el.style.fontSize);
  const minFontSize = 6;
  // Check if content overflows
  while (el.scrollHeight > maxH && fontSize > minFontSize) {
    fontSize -= 0.5;
    el.style.fontSize = fontSize + 'px';
  }
}

// ── PDF overlay translation ────────────────────────────────────────────────
// Renders the PDF canvas in the translation panel with translated text overlaid
// at the exact position of each paragraph, using the full column width.
async function translatePdfOverlay(startPct = 0, { force = false } = {}) {
  translationAbortController = new AbortController();
  const signal = translationAbortController.signal;

  const lang = langSelect.value;
  const rawLabel = langSelect.options[langSelect.selectedIndex].text;
  translationLangLabel.textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();

  if (!currentChapterParagraphs.length) {
    renderTranslationPlaceholder(ui('noTextToTranslate'));
    return;
  }

  translationViewer.innerHTML = '';
  translationViewer.scrollTop = 0;
  setTranslationStatus('');

  try {
    const pageRange = pdfNav.pageRange;
    const pageNumbers = [];
    for (let i = pageRange.start; i <= pageRange.end; i++) pageNumbers.push(i);

    // Render PDF canvas with overlay placeholders
    const pagesData = await renderPdfWithOverlayPlaceholders(
      pdfDoc.proxy, pageNumbers, translationViewer, currentPdfHash,
      loadSettings().uiLang || 'en'
    );

    if (signal.aborted) return;

    // Enable scroll sync
    bindSyncScroll();

    // Skip translation entirely when all pages have no text (Requirement 7.3)
    if (pagesData.allEmpty) {
      setTranslationStatus('');
      return;
    }

    // Collect all translatable blocks across pages (skip noTranslate placeholders)
    const allBlocks = [];
    for (const page of pagesData) {
      for (const block of page.blocks) {
        if (!block.noTranslate) {
          allBlocks.push(block);
        }
      }
    }

    if (allBlocks.length === 0) {
      setTranslationStatus('');
      return;
    }

    // Translate in chunks
    const total = allBlocks.length;
    const totalChunks = Math.ceil(total / LAZY_CHUNK);
    const translatedChunks = new Set();

    async function translateOverlayChunk(chunkIdx) {
      if (signal.aborted || translatedChunks.has(chunkIdx) || chunkIdx < 0 || chunkIdx >= totalChunks) return;
      translatedChunks.add(chunkIdx);
      const start = chunkIdx * LAZY_CHUNK;
      const end = Math.min(start + LAZY_CHUNK, total);
      const slice = allBlocks.slice(start, end).map(b => b.text);
      setTranslationStatus(`${Math.round((translatedChunks.size / totalChunks) * 100)}%`);

      try {
        const translated = await translateWithCache(slice, lang, signal, { force });
        if (signal.aborted) return;
        for (let i = 0; i < translated.length; i++) {
          const block = allBlocks[start + i];
          block.el.textContent = translated[i] || slice[i];
          block.el.classList.remove('pending');
          block.el.classList.add('translated');
          // Auto-shrink font if text overflows the box
          shrinkFontToFit(block.el);
        }
        if (translatedChunks.size >= totalChunks) setTranslationStatus('✓');
      } catch (err) {
        if (signal.aborted) return;
        // Requirement 4.6: keep placeholders in pending state, continue other batches
        console.warn('[translate-overlay] chunk error', chunkIdx, err);
      }
    }

    // Start from chunk corresponding to startPct
    const startChunk = Math.min(
      Math.floor((startPct / 100) * totalChunks),
      totalChunks - 1
    );

    await translateOverlayChunk(startChunk);
    if (signal.aborted) return;

    // Translate chunks above (fire-and-forget)
    for (let i = startChunk - 1; i >= 0; i--) {
      translateOverlayChunk(i);
    }

    // Lazy: each chunk is translated when it enters (or is about to enter) the view
    lazyObserver = observeChunksLazily({
      root: translationViewer,
      elements: allBlocks.map(b => b && b.el),
      chunkSize: LAZY_CHUNK,
      translateChunk: translateOverlayChunk,
      isDone: (c) => c <= startChunk,
      signal,
    });

  } catch (err) {
    if (signal.aborted) return;
    console.error('[translate-overlay] rendering error:', err);
    renderTranslationPlaceholder(ui('errorChapter') + errMsg(err));
  }
}

// Paragraphs of a PDF page range. On desktop they come from the layout engine
// (columns, boxes, stitching across pages, de-hyphenation, ligatures); the
// simple pdf.js heuristic is the fallback (browser, analysis error, no text).
async function extractPdfUnitText(range, lang) {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    try {
      if (!pdfAnalyzer || pdfAnalyzer.doc !== pdfDoc.proxy) pdfAnalyzer = new PdfLayoutAnalyzer(pdfDoc.proxy);
      const result = await pdfAnalyzer.analyze(range.start, range.end, pdfProgressHooks);
      pdfProgressDone(result);
      const texts = paragraphTextsForRange(result, range.start, range.end);
      if (texts.length) return texts;
    } catch (err) {
      console.error(`[pdf] layout analysis of pages ${range.start}-${range.end} failed, using the simple text extraction:`, err);
      pdfProgress.fail(ui('pdfLayoutFailed', { error: errMsg(err) }));
    }
  }
  // browser or no analysis: the run started on opening ends here
  if (pdfProgress.active) pdfProgress.done();
  return extractChapterText(pdfDoc.proxy, range, lang);
}

// ── PDF layout translation ─────────────────────────────────────────────────
// Original view of a PDF (desktop app): the layout engine (Rust, ported from
// PDF X-Ray) rebuilds the logical paragraphs of the pages (columns, boxes,
// stitching across pages, running heads...) and the translation of each
// paragraph is written inside the box of the original text, over the page.
// Returns false when it cannot be used (browser, analysis error): the caller
// then falls back to `translatePdfOverlay`.
async function translatePdfLayout(startPct = 0, { force = false } = {}) {
  if (!(window.__TAURI__ || window.__TAURI_INTERNALS__)) return false;
  translationAbortController = new AbortController();
  const signal = translationAbortController.signal;

  updateTranslationLangLabel();
  const lang = langSelect.value;
  const range = pdfNav.pageRange;
  const pageNumbers = [];
  for (let i = range.start; i <= range.end; i++) pageNumbers.push(i);

  translationViewer.classList.add('pdf-pages');
  translationViewer.innerHTML = '';
  translationViewer.scrollTop = 0;

  try {
    if (!pdfAnalyzer || pdfAnalyzer.doc !== pdfDoc.proxy) pdfAnalyzer = new PdfLayoutAnalyzer(pdfDoc.proxy);
    setTranslationStatus(ui('pdf_layout_analyzing'));
    const result = await pdfAnalyzer.analyze(range.start, range.end, {
      signal,
      onProgress: (done, total, pageNum) => {
        setTranslationStatus(`${ui('pdf_layout_analyzing')} ${Math.round(done / total * 100)}%`);
        pdfProgress.extract(done, total, pageNum);
      },
      onAnalyze: pdfProgressHooks.onAnalyze,
    });
    if (signal.aborted || !result) return true;
    pdfProgressDone(result);

    const paragraphs = selectParagraphs(result, range.start, range.end);
    if (!paragraphs.length) return false; // scanned / no text: let the old path say so

    const shells = await renderPdfPageShells(pdfDoc.proxy, pageNumbers, translationViewer, () => !signal.aborted);
    if (signal.aborted) return true;
    const shellByPage = new Map(shells.map(s => [s.pageNum, s]));
    bindSyncScroll();

    // One (empty) box per visible segment of each paragraph
    const boxes = new Map(); // paragraph id → [{ el, seg, scale, index }]
    const overlayFont = pdfOverlayFontFamily();
    for (const par of paragraphs) {
      const list = [];
      par.segments.forEach((seg, index) => {
        const shell = shellByPage.get(seg.pageNum);
        if (!shell) return;
        list.push({ el: createSegmentBox(shell.wrapper, par, seg, shell.scale, { fontFamily: overlayFont }), seg, scale: shell.scale, index });
      });
      boxes.set(par.id, list);
    }

    const total = paragraphs.length;
    const totalChunks = Math.ceil(total / LAZY_CHUNK);
    const translatedChunks = new Set();

    async function translateLayoutChunk(chunkIdx) {
      if (signal.aborted || translatedChunks.has(chunkIdx) || chunkIdx < 0 || chunkIdx >= totalChunks) return;
      translatedChunks.add(chunkIdx);
      const slice = paragraphs.slice(chunkIdx * LAZY_CHUNK, (chunkIdx + 1) * LAZY_CHUNK);
      setTranslationStatus(`${Math.round((translatedChunks.size / totalChunks) * 100)}%`);
      try {
        const translated = await translateWithCache(slice.map(p => p.text), lang, signal, { force });
        if (signal.aborted) return;
        const byId = new Map(slice.map((p, i) => [p.id, translated[i] || p.text]));
        const pieces = await pdfAnalyzer.distribute(slice, byId);
        if (signal.aborted) return;
        slice.forEach((par, i) => {
          for (const b of boxes.get(par.id) || []) fillSegment(b.el, pieces[i][b.index] || '', b.seg, b.scale);
        });
        if (translatedChunks.size >= totalChunks) setTranslationStatus('✓');
      } catch (err) {
        if (signal.aborted) return;
        console.warn('[translate-pdf-layout] chunk error', chunkIdx, err);
      }
    }

    const startChunk = Math.min(Math.floor((startPct / 100) * totalChunks), totalChunks - 1);
    await translateLayoutChunk(startChunk);
    if (signal.aborted) return true;
    for (let i = startChunk - 1; i >= 0; i--) translateLayoutChunk(i);

    lazyObserver = observeChunksLazily({
      root: translationViewer,
      elements: paragraphs.map(p => (boxes.get(p.id)[0] || {}).el),
      chunkSize: LAZY_CHUNK,
      translateChunk: translateLayoutChunk,
      isDone: (c) => c <= startChunk,
      signal,
    });
    return true;
  } catch (err) {
    if (signal.aborted) return true;
    console.error('[translate-pdf-layout] failed, falling back to the simple overlay:', err);
    pdfProgress.fail(ui('pdfLayoutFailed', { error: errMsg(err) }));
    return false;
  }
}

// Translation panel label: name of the selected language, without
// any leading flag emoji.
function updateTranslationLangLabel() {
  const option = langSelect.options[langSelect.selectedIndex];
  const rawLabel = option ? option.text : '';
  translationLangLabel.textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();
}
updateTranslationLangLabel(); // initial label, before opening a book

// ── Lazy translation ───────────────────────────────────────────────────────
// startPct: scroll percentage to start from (0-100). Translates first the chunk
// visible at that position, then expands lazily downwards and upwards.
// `force`: ignores the saved translations and replaces them (chapter re-translation)
async function translateCurrentChapter(startPct = 0, { force = false } = {}) {
  const forceRetranslation = force;
  ttsTranslateChunk = null; // Reset on re-entry / chapter change
  translatedChunksRef = null;
  if (translationAbortController) translationAbortController.abort();
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  translationViewer.classList.toggle('pdf-pages', currentFileType === 'pdf' && currentViewMode === 'original');

  if (translationHidden) {
    setTranslationStatus('');
    translationViewer.innerHTML = '';
    return;
  }

  // PDF overlay mode: render canvas + translated text overlay (only in original view mode)
  if (currentFileType === 'pdf' && pdfDoc && pdfNav && currentViewMode === 'original') {
    if (await translatePdfLayout(startPct, { force })) return;
    await translatePdfOverlay(startPct, { force });
    return;
  }

  translationAbortController = new AbortController();
  const signal = translationAbortController.signal;

  const lang = langSelect.value;
  const rawLabel = langSelect.options[langSelect.selectedIndex].text;
  translationLangLabel.textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();

  if (!currentChapterParagraphs.length) {
    renderTranslationPlaceholder(ui('noTextToTranslate'));
    return;
  }

  translationViewer.innerHTML = '';
  translationViewer.scrollTop = 0;
  originalViewer.scrollTop = 0;

  const paragraphs = currentChapterParagraphs;
  const total = paragraphs.length;
  const totalChunks = Math.ceil(total / LAZY_CHUNK);

  // Creates the elements right away: image segments are mirrored (not
  // translated); text segments show the original as a "pending" placeholder.
  const pEls = paragraphs.map((para, i) => {
    if (para && para.type === 'image') {
      const div = document.createElement('div');
      div.dataset.idx = i;
      if (para.id) div.id = para.id;
      div.className = 'segment-image';
      div.innerHTML = para.html;
      translationViewer.appendChild(div);
      return div; // not translatable: translateChunk skips it
    }
    const text = para.text !== undefined ? para.text : para;
    const p = document.createElement('p');
    p.dataset.idx = i;
    p.classList.add('pending', `pair-color-${i % 5}`);
    // Placeholder: original text with inline images already reinserted (no raw tokens)
    p.innerHTML = buildTranslatedParagraphHtml(para, text, i + 1);
    translationViewer.appendChild(p);
    return p;
  });

  setTranslationStatus('');
  bindSyncScroll();

  // Starting chunk based on the scroll percentage
  const startChunk = Math.min(
    Math.floor((startPct / 100) * totalChunks),
    totalChunks - 1
  );

  // Translates a specific chunk by index
  const translatedChunks = new Set();
  translatedChunksRef = translatedChunks;
  // Finished chunks (translated or failed): the "✓" state appears only when all
  // have finished, not when they have merely started; "⚠" if any has failed.
  const finishedChunks = new Set();
  const failedChunks = new Set();
  const markChunkFinished = (chunkIdx, failed) => {
    finishedChunks.add(chunkIdx);
    if (failed) failedChunks.add(chunkIdx); else failedChunks.delete(chunkIdx);
    if (finishedChunks.size >= totalChunks) {
      setTranslationStatus(failedChunks.size ? '⚠' : '✓');
    } else {
      setTranslationStatus(`${Math.round((finishedChunks.size / totalChunks) * 100)}%`);
    }
  };
  async function translateChunk(chunkIdx) {
    if (signal.aborted || translatedChunks.has(chunkIdx) || chunkIdx < 0 || chunkIdx >= totalChunks) return;
    translatedChunks.add(chunkIdx);
    const start = chunkIdx * LAZY_CHUNK;
    const end = Math.min(start + LAZY_CHUNK, total);

    // Consider only the text segments: images are already mirrored
    // and must not be sent to the translator.
    const textIdx = [];
    for (let i = start; i < end; i++) {
      const seg = paragraphs[i];
      if (seg && seg.type === 'image') continue;
      textIdx.push(i);
    }
    if (!textIdx.length) { markChunkFinished(chunkIdx, false); return; }

    const slice = textIdx.map(i => {
      const p = paragraphs[i];
      return p.text !== undefined ? p.text : p;
    });
    if (finishedChunks.size < totalChunks) {
      setTranslationStatus(`${Math.round((finishedChunks.size / totalChunks) * 100)}%`);
    }
    try {
      // A temporary error (network, rate limit) is retried with
      // an increasing pause before giving up and showing the original text.
      // The paragraphs already translated come from the book's cache; the others are
      // translated (with retries) and saved in the cache.
      const translated = await translateWithCache(slice, lang, signal, { force: forceRetranslation });
      if (signal.aborted) return;
      for (let k = 0; k < textIdx.length; k++) {
        const i = textIdx[k];
        const seg = paragraphs[i];
        pEls[i].innerHTML = buildTranslatedParagraphHtml(seg, translated[k] || slice[k], i + 1);
        pEls[i].setAttribute('data-translated', 'true');
        pEls[i].classList.remove('pending');
      }
      markChunkFinished(chunkIdx, false);
    } catch (err) {
      if (signal.aborted) return;
      console.error('[translate] chunk error', chunkIdx, err);
      // Fallback: show the original text (formatted) for the segments of the failed chunk
      for (let k = 0; k < textIdx.length; k++) {
        const i = textIdx[k];
        const seg = paragraphs[i];
        const fallback = seg.text !== undefined ? seg.text : seg;
        pEls[i].innerHTML = buildTranslatedParagraphHtml(seg, fallback, i + 1);
        pEls[i].classList.remove('pending');
      }
      markChunkFinished(chunkIdx, true);
    }
  }

  // Expose translateChunk for TTS on-demand translation
  ttsTranslateChunk = translateChunk;

  // Chunks that are already entirely in the cache are shown immediately, without waiting
  // for scrolling: reading from the cache is synchronous and makes no requests.
  if (!forceRetranslation && currentTranslationCache) {
    const variant = translationVariant(lang);
    for (let c = 0; c < totalChunks; c++) {
      const s = c * LAZY_CHUNK;
      const e = Math.min(s + LAZY_CHUNK, total);
      const hits = [];
      let complete = true;
      for (let i = s; i < e; i++) {
        const seg = paragraphs[i];
        if (seg && seg.type === 'image') continue;
        const text = seg.text !== undefined ? seg.text : seg;
        const hit = currentTranslationCache.get(variant, text);
        if (hit === undefined) { complete = false; break; }
        hits.push([i, hit]);
      }
      if (!complete) continue;
      for (const [i, hit] of hits) {
        pEls[i].innerHTML = buildTranslatedParagraphHtml(paragraphs[i], hit, i + 1);
        pEls[i].setAttribute('data-translated', 'true');
        pEls[i].classList.remove('pending');
      }
      translatedChunks.add(c);
      markChunkFinished(c, false);
    }
  }

  // Translate the visible chunk first, then the previous ones (upwards), then lazily downwards
  await translateChunk(startChunk);
  if (signal.aborted) return;

  // Translate the previous chunks in the background (upwards), without blocking
  // One at a time: launching them all together causes bursts of requests (HTTP 429)
  (async () => {
    for (let i = startChunk - 1; i >= 0; i--) {
      if (signal.aborted) return;
      await translateChunk(i);
    }
  })();

  // Lazy: each untranslated chunk is translated when it enters (or is about to enter)
  // the view, even if fast scrolling skips entire chunks.
  lazyObserver = observeChunksLazily({
    root: translationViewer,
    elements: pEls,
    chunkSize: LAZY_CHUNK,
    translateChunk,
    isDone: (c) => translatedChunks.has(c),
    signal,
  });
}

// ── Size Guard ─────────────────────────────────────────────────────────────
/**
 * Classifies a file's size against the configured limits.
 * @param {number} fileSizeBytes  - file size in bytes
 * @param {number} maxFileSizeMB  - blocking limit in MB
 * @param {number} warnFileSizeMB - warning threshold in MB
 * @returns {'ok' | 'warn' | 'block'}
 */
function sizeGuard(fileSizeBytes, maxFileSizeMB, warnFileSizeMB) {
  const MB = 1_048_576;
  if (fileSizeBytes > maxFileSizeMB * MB) return 'block';
  if (fileSizeBytes > warnFileSizeMB * MB) return 'warn';
  return 'ok';
}

// ── Opening files ──────────────────────────────────────────────────────────
openBtn.addEventListener('click', async () => {
  try {
    let fileData = null, fileName = '', fileSizeBytes = 0;
    const s = loadSettings();
    const maxFileSizeMB = typeof s.maxFileSizeMB === 'number' ? s.maxFileSizeMB : DEFAULT_MAX_FILE_SIZE_MB;
    const warnFileSizeMB = typeof s.warnFileSizeMB === 'number' ? s.warnFileSizeMB : DEFAULT_WARN_FILE_SIZE_MB;

    if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const { readFile, stat } = await import('@tauri-apps/plugin-fs');
      const selected = await open({ filters: [{ name: 'Books', extensions: ['epub', 'pdf'] }] });
      if (!selected) return;
      fileName = selected;
      // Get file size before reading
      const info = await stat(selected);
      fileSizeBytes = info.size;
      const guard = sizeGuard(fileSizeBytes, maxFileSizeMB, warnFileSizeMB);
      if (guard === 'block') {
        const sizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
        const name = selected.split(/[\\/]/).pop();
        await showAlert(ui('fileTooLargeMsg', { name, sizeMB, maxMB: maxFileSizeMB }));
        return;
      }
      if (guard === 'warn') {
        const sizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
        const name = selected.split(/[\\/]/).pop();
        console.warn(ui('fileLargeWarnMsg', { name, sizeMB }));
      }
      showLoading(ui('readingFile'));
      let raw;
      try {
        raw = await readFile(selected);
      } catch (err) {
        hideLoading();
        if (book) { try { book.destroy(); } catch (_) { } book = null; }
        await showAlert(ui('oomErrorMsg', { name: selected.split(/[\\/]/).pop() }));
        return;
      }
      fileData = raw.buffer ?? raw;
    } else {
      const picked = await pickFileViaInput();
      if (!picked) return;
      fileName = picked.name;
      fileSizeBytes = picked.size;
      const guard = sizeGuard(fileSizeBytes, maxFileSizeMB, warnFileSizeMB);
      if (guard === 'block') {
        const sizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
        await showAlert(ui('fileTooLargeMsg', { name: fileName, sizeMB, maxMB: maxFileSizeMB }));
        return;
      }
      if (guard === 'warn') {
        const sizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
        console.warn(ui('fileLargeWarnMsg', { name: fileName, sizeMB }));
      }
      showLoading(ui('readingFile'));
      try {
        fileData = await picked.getBuffer();
      } catch (err) {
        hideLoading();
        if (book) { try { book.destroy(); } catch (_) { } book = null; }
        await showAlert(ui('oomErrorMsg', { name: fileName }));
        return;
      }
    }
    const ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'epub') await loadEpub(fileData, fileName);
    else if (ext === 'pdf') await loadPdfFile(fileData, fileName);
    else await showAlert(ui('unsupportedFormat'));
  } catch (err) {
    console.error('[open]', err);
    await showAlert(ui('errorOpening') + errMsg(err));
  }
});

// Browser fallback: hidden file input
function pickFileViaInput() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.epub,.pdf';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      resolve({
        name: file.name,
        size: file.size,
        getBuffer: () => file.arrayBuffer(),
        // Keep backward compat: buffer is resolved lazily via getBuffer()
      });
    };
    input.click();
  });
}

// ── Load EPUB ─────────────────────────────────────────────────────────────
/**
 * Checks whether an error is of the OOM (Out Of Memory) type.
 * @param {*} err
 * @returns {boolean}
 */
function isOomError(err) {
  const msg = errMsg(err).toLowerCase();
  return msg.includes('out of memory') || msg.includes('allocation failed') || msg.includes('memory');
}

async function loadEpub(arrayBuffer, filePath = '', { restorePosition = true } = {}) {
  // Same spelling as the library entry: translation cache and chapter lengths are keyed by it
  filePath = await libraryPathFor(filePath);
  // Stop TTS before loading new book
  ttsController.stop();
  showLoading(ui('loadingEpub'));

  // The new file is opened and validated (metadata, spine, index) BEFORE
  // touching the current book: if it is not a valid EPUB, the book already open
  // stays as it was instead of leaving a broken screen.
  // Note: we intentionally avoid `book.ready` — it can hang indefinitely
  // on certain EPUBs (e.g. generated by Calibre) because of an internal JSZip problem.
  // `book.loaded.metadata` resolves as soon as the manifest is parsed, which is
  // all we need before proceeding.
  let newBook = null;
  let meta, nav;
  try {
    newBook = ePub(arrayBuffer);
    meta = await Promise.race([
      newBook.loaded.metadata,
      new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout after 20s')), 20000)),
    ]);
    await Promise.race([
      newBook.loaded.spine,
      new Promise((_, rej) => setTimeout(() => rej(new Error('spine timeout after 10s')), 10000)),
    ]);
    nav = await Promise.race([
      newBook.loaded.navigation,
      new Promise((_, rej) => setTimeout(() => rej(new Error('navigation timeout after 10s')), 10000)),
    ]);
  } catch (err) {
    if (newBook) { try { newBook.destroy(); } catch (_) { } }
    hideLoading();
    await showAlert(isOomError(err) ? ui('oomErrorMsg', { name: filePath }) : ui('errorOpening') + errMsg(err));
    return;
  }

  // Valid file: now the previous book can be closed
  rememberReadingPosition();
  flushReadingPositions();
  displayGeneration++; // stops the chapter loads still in progress for the old book
  cancelBookTranslationJob();
  flushTranslationCaches();
  currentTranslationCache = null;
  enableTTSControls(false);
  if (book) {
    try { book.destroy(); } catch (_) { }
  }
  if (pdfDoc && pdfDoc.proxy) {
    try { pdfDoc.proxy.destroy(); } catch (_) { }
  }
  currentSpineItems = [];
  chapterLengths = [];
  chapterCumulativePct = [];
  currentChapterParagraphs = [];
  currentChapterBody = null;
  currentFileType = 'epub';
  updateFontControls();
  pdfDoc = null;
  pdfAnalyzer = null;
  pdfNav = null;

  hideNoBookPlaceholder();
  currentFilePath = filePath || null;
  try {
    book = newBook;
    // Translations already saved for this book: loaded before the first chapter
    currentBookFileSize = arrayBuffer.byteLength || 0;
    const bookCache = await loadBookTranslationCache(filePath, meta.title);
    if (book === newBook) currentTranslationCache = bookCache;
    bookTitle.textContent = meta.title || ui('unknownTitle');
    bookAuthor.textContent = meta.creator || '';
    bookInfo.classList.remove('hidden');
    tocPlaceholder.style.display = 'none';

    // Save the book's source language for TTS voice matching
    if (meta.language) {
      const bookLang = meta.language.split('-')[0].toLowerCase(); // e.g. 'it-IT' → 'it'
      const s = loadSettings();
      s.sourceLang = bookLang;
      saveSettings(s);
    }

    let coverUrl = null;
    try { coverUrl = (await book.coverUrl()) || null; } catch (_) { }
    setSidebarCover(coverUrl);

    // Auto-add to the library when a book is opened (Tauri only, with an absolute path)
    if (filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath))) {
      autoAddToLibrary(arrayBuffer, filePath, meta, undefined, coverUrl);
    }

    currentSpineItems = [];
    book.spine.each(item => currentSpineItems.push(item));
    currentSpineIndex = 0;

    renderToc(nav.toc);

    updateProgress();
    buildProgressTicks(currentSpineItems, nav.toc);
    // Where the user stopped reading this book last time
    const restoreTarget = restorePosition
      ? await savedRestoreTarget(filePath, { fileType: 'epub', unitCount: currentSpineItems.length })
      : null;
    addBookmarkBtn.disabled = false;
    if (bookTranslationBtn) bookTranslationBtn.disabled = false;
    enableTTSControls(true);
    populateTTSVoices();

    // Find the first chapter with real content (skips cover/frontmatter).
    // First pass: look for "chapter/capitolo" in the file name.
    let bestIndex = restoreTarget ? restoreTarget.chapterIndex : -1;
    for (let i = 0; bestIndex < 0 && i < currentSpineItems.length; i++) {
      if (/chapter|capitolo|chap/i.test(currentSpineItems[i].href)) {
        bestIndex = i; break;
      }
    }
    // Chapter lengths already computed on a previous opening (if the file
    // has not changed): they avoid re-reading the chapters here and further below.
    const fileSize = arrayBuffer.byteLength || 0;
    const cachedLengths = await getCachedChapterLengths(filePath, fileSize, currentSpineItems.length);

    // Second pass: first spine item with more than 500 characters of text.
    if (bestIndex < 0) {
      if (cachedLengths) {
        bestIndex = cachedLengths.findIndex(l => l > 500);
      } else {
        for (let i = 0; i < currentSpineItems.length; i++) {
          const body = await loadChapterDocument(currentSpineItems[i]);
          if ((body?.textContent?.trim() || '').length > 500) { bestIndex = i; break; }
        }
      }
    }
    setViewMode('text');
    viewToggleBtn.disabled = false;
    await displayChapter(bestIndex >= 0 ? bestIndex : 0, restoreTarget ? restoreTarget.scrollPct : 0);

    // Compute chapter lengths in background for proportional progress bar
    chapterLengthsPromise = computeChapterLengths(cachedLengths, { filePath, fileSize })
      .finally(() => { chapterLengthsPromise = null; });
  } catch (err) {
    if (book) {
      try { book.destroy(); } catch (_) { }
      book = null;
      currentSpineItems = [];
      chapterLengths = [];
      chapterCumulativePct = [];
      currentChapterParagraphs = [];
      currentFilePath = null;
    }
    await showAlert(isOomError(err) ? ui('oomErrorMsg', { name: filePath }) : ui('errorOpening') + errMsg(err));
  } finally {
    hideLoading();
  }
}

// ── Load PDF ──────────────────────────────────────────────────────────────

// ── PDF Navigation UI ──────────────────────────────────────────────────────

/**
 * Updates the UI after navigating to a new PDF unit (chapter or page).
 * Updates progress bar, page indicator, active tick, and renders content.
 */
function displayPdfUnit(scrollPct = 0) {
  if (!pdfNav) return;
  updateProgress();
  updatePdfActiveTick();
  updatePdfTocActive();
  // Render content for the new unit (handles both text and original modes)
  displayChapter(pdfNav.currentIndex, scrollPct);
}

/**
 * Renders tick marks on the progress bar for PDF navigation units.
 */
function renderPdfTicks() {
  progressTicks.innerHTML = '';
  if (!pdfNav) return;

  const positions = pdfNav.getTickPositions();
  const total = pdfNav.totalUnits;

  positions.forEach((pos, i) => {
    const pct = pos * 100;
    const tick = document.createElement('div');
    tick.className = 'progress-tick';
    tick.style.left = `${pct}%`;
    tick.dataset.idx = i;

    // Determine the navigation unit index this tick corresponds to
    let unitIndex;
    if (pdfNav.mode === 'chapter') {
      unitIndex = i;
    } else if (total <= 20) {
      unitIndex = i;
    } else {
      // Page mode P > 20: ticks are every 10 pages
      unitIndex = i * 10;
    }

    // Label for tooltip
    let label;
    if (pdfNav.mode === 'chapter') {
      const saved = pdfNav.currentIndex;
      pdfNav.goTo(unitIndex);
      label = pdfNav.currentLabel;
      pdfNav.goTo(saved);
    } else {
      label = ui('pdf_page_indicator', { n: unitIndex + 1, total: pdfNav.totalUnits });
    }
    tick.dataset.label = label;
    tick.dataset.unitIndex = unitIndex;

    tick.addEventListener('click', e => {
      e.stopPropagation();
      if (pdfNav.goTo(unitIndex)) {
        displayPdfUnit();
      }
    });
    tick.addEventListener('mouseenter', () => showTooltip(tick, label, pct));
    tick.addEventListener('mouseleave', hideTooltip);
    progressTicks.appendChild(tick);
  });
}

/**
 * Highlights the active tick for the current PDF navigation unit.
 */
function updatePdfActiveTick() {
  const currentUnit = pdfNav.currentIndex;
  progressTicks.querySelectorAll('.progress-tick').forEach(el => {
    const tickUnit = parseInt(el.dataset.unitIndex ?? el.dataset.idx);
    // In page mode P > 20, highlight the tick whose unit range includes the current page
    if (pdfNav.mode === 'page' && pdfNav.totalUnits > 20) {
      const nextTickUnit = tickUnit + 10;
      el.classList.toggle('active', currentUnit >= tickUnit && currentUnit < nextTickUnit);
    } else {
      el.classList.toggle('active', tickUnit === currentUnit);
    }
  });
}

// ── PDF TOC Sidebar ──────────────────────────────────────────────────────────

/**
 * Renders the PDF table of contents in the sidebar.
 * In chapter mode: populates tocList with entries from pdfNav.getTocEntries().
 * In page mode: shows the localized "No table of contents available" placeholder.
 */
function renderPdfToc() {
  tocList.innerHTML = '';

  if (!pdfNav || pdfNav.mode === 'page') {
    // Show placeholder message for page mode (no outline)
    tocPlaceholder.textContent = ui('pdf_toc_placeholder');
    tocPlaceholder.style.display = '';
    return;
  }

  tocPlaceholder.style.display = 'none';

  const entries = pdfNav.getTocEntries();
  entries.forEach(entry => {
    const li = document.createElement('li');
    li.textContent = entry.label;
    li.style.paddingLeft = (entry.level * 16) + 'px';
    li.classList.add('toc-item');
    if (entry.level > 0) li.classList.add('toc-sub-item');

    li.addEventListener('click', () => {
      pdfNav.goTo(entry.index);
      displayPdfUnit();
      updatePdfTocActive();
    });

    tocList.appendChild(li);
  });

  updatePdfTocActive();
}

/**
 * Highlights the active TOC entry matching the current PDF navigation unit.
 */
function updatePdfTocActive() {
  if (!pdfNav || pdfNav.mode === 'page') return;

  const items = tocList.querySelectorAll('.toc-item');
  const entries = pdfNav.getTocEntries();

  items.forEach((item, i) => {
    if (entries[i] && entries[i].index === pdfNav.currentIndex) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
async function loadPdfFile(arrayBuffer, filePath = '', { restorePosition = true } = {}) {
  // Same spelling as the library entry: translation cache and chapter lengths are keyed by it
  filePath = await libraryPathFor(filePath);
  // Stop TTS before loading new book
  ttsController.stop();
  showLoading(ui('readingFile'));

  // The current book is closed only after the new PDF has been opened and
  // validated (further below): an invalid file leaves the one already open untouched.
  // pdf.js transfers the ArrayBuffer to its own worker: the size must be read first.
  const pdfByteLength = arrayBuffer.byteLength;
  const pdfName = (filePath || '').split(/[\\/]/).pop() || '';
  const openStart = performance.now();
  console.info(`[pdf] opening "${pdfName}" (${(pdfByteLength / 1_048_576).toFixed(1)} MB)`);
  pdfProgress.begin();

  try {
    const s = loadSettings();
    const maxMB = typeof s.maxFileSizeMB === 'number' ? s.maxFileSizeMB : DEFAULT_MAX_FILE_SIZE_MB;

    // File size check
    if (!checkFileSize(arrayBuffer.byteLength, maxMB)) {
      console.warn(`[pdf] "${pdfName}" exceeds the ${maxMB} MB limit`);
      pdfProgress.hide();
      hideLoading();
      await showAlert(ui('pdf_error_too_large', { size: (arrayBuffer.byteLength / 1024 / 1024).toFixed(1), max: maxMB }));
      return;
    }

    // Load PDF
    let doc;
    try {
      const filename = (filePath || '').split(/[\\/]/).pop() || '';
      doc = await loadPdf(arrayBuffer, filename, { onProgress: (loaded, total) => pdfProgress.opening(loaded, total) });
    } catch (err) {
      console.error(`[pdf] cannot open "${pdfName}":`, err);
      hideLoading();
      const msg = (err && err.message && err.message.includes('magic bytes'))
        ? ui('pdf_error_invalid')
        : ui('pdf_error_open');
      pdfProgress.fail(`${msg} ${errMsg(err)}`);
      await showAlert(msg);
      return;
    }

    // Validate text content
    let nav;
    try {
      const validation = await validateTextContent(doc.proxy);
      if (validation === 'blocked') {
        console.warn(`[pdf] "${pdfName}" has no extractable text in its first pages`);
        try { doc.proxy.destroy(); } catch (_) { }
        pdfProgress.hide();
        hideLoading();
        await showAlert(ui('pdf_blocked_dialog'));
        return;
      }

      // Create navigator
      nav = await PdfNavigator.create(doc.proxy, doc.outline);
    } catch (err) {
      console.error(`[pdf] cannot read the structure of "${pdfName}":`, err);
      try { doc.proxy.destroy(); } catch (_) { }
      hideLoading();
      pdfProgress.fail(ui('pdf_error_open') + ' ' + errMsg(err));
      await showAlert(ui('pdf_error_open') + ' ' + errMsg(err));
      return;
    }
    console.info(`[pdf] "${pdfName}" opened in ${Math.round(performance.now() - openStart)} ms: ${doc.pageCount} pages, ${nav.totalUnits} ${nav.mode === 'chapter' ? 'chapters' : 'pages'} to navigate`);

    // Valid file: now the previous book can be closed
    rememberReadingPosition();
    flushReadingPositions();
    displayGeneration++; // stops the chapter loads still in progress for the old book
    cancelBookTranslationJob();
    flushTranslationCaches();
    currentTranslationCache = null;
    enableTTSControls(false);
    if (book) {
      try { book.destroy(); } catch (_) { }
      book = null;
    }
    if (pdfDoc && pdfDoc.proxy) {
      try { pdfDoc.proxy.destroy(); } catch (_) { }
    }
    currentSpineItems = [];
    chapterLengths = [];
    chapterCumulativePct = [];
    currentChapterParagraphs = [];
    clearSegmentationCache();
    hideNoBookPlaceholder();

    // Success — set state
    pdfDoc = doc;
    pdfNav = nav;
    currentFileType = 'pdf';
    updateFontControls();
    currentFilePath = filePath || null;

    // Source language for choosing the TTS voice: the one declared by the PDF,
    // if any. Otherwise it is reset, so as not to use that of the last book opened.
    {
      const settings = loadSettings();
      const pdfLang = (doc.language || '').split(/[-_]/)[0].toLowerCase();
      if (/^[a-z]{2,3}$/.test(pdfLang)) settings.sourceLang = pdfLang;
      else delete settings.sourceLang;
      saveSettings(settings);
    }

    // Compute pdfHash from filename + file size (stable, cheap)
    const pdfFilename = (filePath || '').split(/[\\/]/).pop() || '';
    currentPdfHash = `${pdfFilename}:${pdfByteLength}`;

    // Translations already saved for this book: loaded before the first unit
    currentBookFileSize = pdfByteLength;
    const bookCache = await loadBookTranslationCache(filePath, doc.title);
    if (pdfDoc === doc) currentTranslationCache = bookCache;

    // Display title in sidebar
    bookTitle.textContent = doc.title || ui('unknownTitle');
    bookAuthor.textContent = doc.author || '';
    bookInfo.classList.remove('hidden');
    tocPlaceholder.style.display = 'none';
    setSidebarCover(null);

    // Cover = first page of the PDF, rendered in the background. The same
    // thumbnail goes to the library entry (and so to the PWA).
    const isLibraryPath = filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath));
    renderPdfCoverDataUrl(doc.proxy).then(coverDataUrl => {
      if (pdfDoc === doc) setSidebarCover(coverDataUrl);
      if (isLibraryPath) {
        autoAddToLibrary(arrayBuffer, filePath, { title: doc.title, creator: doc.author }, pdfByteLength, coverDataUrl);
      }
    });

    addBookmarkBtn.disabled = false;
    if (bookTranslationBtn) bookTranslationBtn.disabled = false;
    enableTTSControls(true);
    populateTTSVoices();
    // PDFs open in the original view (displayPdfUnit below renders it)
    setViewMode('original', { skipRender: true });
    viewToggleBtn.disabled = false;

    // Initialize PDF progress bar and navigation UI, at the unit where the
    // user stopped reading this PDF last time
    const restoreTarget = restorePosition
      ? await savedRestoreTarget(filePath, { fileType: 'pdf', unitCount: nav.totalUnits, pdfMode: nav.mode })
      : null;
    if (pdfNav !== nav) return; // another book was opened in the meantime
    if (restoreTarget) nav.goTo(restoreTarget.chapterIndex);
    renderPdfTicks();
    renderPdfToc();
    displayPdfUnit(restoreTarget ? restoreTarget.scrollPct : 0);

    hideLoading();
  } catch (err) {
    pdfDoc = null;
    pdfNav = null;
    currentFileType = null;
    updateFontControls();
    console.error(`[pdf] error while opening "${pdfName}":`, err);
    pdfProgress.fail(ui('pdf_error_open') + ' ' + errMsg(err));
    hideLoading();
    await showAlert(ui('pdf_error_open') + ' ' + errMsg(err));
  }
}

// ── Navigate to a chapter (direct parsing, without iframe) ─────────────────
async function displayChapter(index, scrollPct = 0) {
  // Stop TTS on chapter navigation
  ttsController.stop();
  // Every navigation invalidates those still in progress (arrows pressed in rapid
  // succession): a slower load must not overwrite the new one.
  const myGeneration = ++displayGeneration;

  // ── PDF branch ──────────────────────────────────────────────────────────
  if (currentFileType === 'pdf') {
    if (!pdfDoc || !pdfNav) return;
    if (translationAbortController) translationAbortController.abort();

    // Navigate to the requested unit
    pdfNav.goTo(index);
    currentChapterParagraphs = [];
    renderOriginal([]);
    renderTranslationPlaceholder(ui('loadingChapter'));
    updateProgress();

    try {
      // Get the page range for current unit
      const pageRange = pdfNav.pageRange;

      // Get UI language for localized messages
      const s = loadSettings();
      const lang = s.uiLang || 'en';

      // Extract text from all pages in the range
      const paragraphs = await extractPdfUnitText(pageRange, lang);
      if (myGeneration !== displayGeneration) return;

      // Store for translation use
      currentChapterParagraphs = paragraphs;

      // Update progress and ticks
      updateProgress();
      updateActiveTick();

      if (currentViewMode === 'original') {
        await renderNativeView();
        // For PDF, also trigger translation overlay in the translation panel
        if (!translationHidden) {
          await translateCurrentChapter(scrollPct);
        }
        if (myGeneration === displayGeneration && scrollPct > 0) restoreScrollPct(scrollPct);
      } else {
        // Render in the original panel
        renderOriginal(paragraphs);

        // Detect "all scanned-image" case: every paragraph is a notice (starts with '[')
        const allScanned = paragraphs.length > 0 && paragraphs.every(p => {
          const text = (typeof p === 'string') ? p : (p.text || '');
          return text.trimStart().startsWith('[');
        });

        if (allScanned) {
          // Show "no text to translate" message instead of attempting translation
          renderTranslationPlaceholder(ui('pdf_no_text_translate'));
          bindSyncScroll();
        } else {
          // Trigger translation pipeline
          await translateCurrentChapter(scrollPct);
        }

        // Restore scroll position if provided
        if (scrollPct > 0) restoreScrollPct(scrollPct);
      }
    } catch (err) {
      if (myGeneration !== displayGeneration) return;
      console.error('[nav] PDF chapter load error:', err);
      renderOriginal([]);
      renderTranslationPlaceholder(ui('errorChapter') + errMsg(err));
    }
    return;
  }

  // ── EPUB branch ─────────────────────────────────────────────────────────
  if (!book || !currentSpineItems.length) return;
  if (translationAbortController) translationAbortController.abort();

  index = Math.max(0, Math.min(index, currentSpineItems.length - 1));
  currentSpineIndex = index;
  currentChapterParagraphs = [];
  renderOriginal([]);
  renderTranslationPlaceholder(ui('loadingChapter'));
  updateProgress();

  const item = currentSpineItems[index];
  const myIndex = index;

  try {
    const body = await loadChapterDocument(item);
    if (currentSpineIndex !== myIndex || myGeneration !== displayGeneration) return;
    if (!body) throw new Error('documento capitolo null');

    currentChapterBody = body;
    // Build the src→blobUrl map BEFORE extracting the segments, so that the
    // images are remapped to persistent URLs (the subsequent unload of the
    // other chapters does not invalidate the blobs of the current chapter).
    const imgResolver = await buildImageResolver(book, item, body);
    if (currentSpineIndex !== myIndex) return;
    currentChapterParagraphs = extractParagraphs(body, imgResolver);
    if (currentSpineIndex !== myIndex) return;
    updateProgress();
    updateActiveTick();
    if (currentViewMode === 'original') {
      await renderNativeView();
      // Still generate the translation in the right panel (EPUB original view)
      if (!translationHidden) {
        await translateCurrentChapter(scrollPct);
      }
      if (myGeneration === displayGeneration && scrollPct > 0) restoreScrollPct(scrollPct);
    } else {
      renderOriginal(currentChapterParagraphs);
      await translateCurrentChapter(scrollPct);
      if (scrollPct > 0) restoreScrollPct(scrollPct);
    }
    // Unload non-current spine items to free memory (after rendering is complete)
    for (let i = 0; i < currentSpineItems.length; i++) {
      if (i === currentSpineIndex) continue;
      const spineItem = currentSpineItems[i];
      if (typeof spineItem.unload === 'function') {
        try { spineItem.unload(); } catch (e) {
          console.warn('[memory] unload error on spine item', i, e);
        }
      }
    }
  } catch (err) {
    if (currentSpineIndex !== myIndex) return;
    console.error('[nav] chapter load error:', err);
    renderOriginal([]);
    renderTranslationPlaceholder(ui('errorChapter') + errMsg(err));
  }
}

// Loads the HTML document of a spine chapter through the epubjs APIs
async function loadChapterDocument(spineItem) {
  try {
    if (typeof spineItem.unload === 'function') spineItem.unload();
    const result = await spineItem.load(book.load.bind(book));
    const doc = spineItem.document;

    if (doc) {
      const body = doc.body
        || doc.querySelector?.('body')
        || doc.documentElement?.querySelector?.('body')
        || doc.getElementsByTagName?.('body')?.[0];
      if (body) return body;
    }
    if (result) {
      const body = result.querySelector?.('body') || result.getElementsByTagName?.('body')?.[0];
      if (body) return body;
      return result; // fallback: use the root node
    }
  } catch (e) {
    console.error('[nav] loadChapterDocument error:', e);
  }
  return null;
}

// Chapter lengths saved in the book's library entry, valid only
// if the file still has the same size and the same number of chapters.
// They avoid re-reading all the chapters on every opening.
async function getCachedChapterLengths(filePath, fileSize, chapterCount) {
  if (!filePath || !fileSize) return null;
  try {
    const entry = (await loadLibrary()).find(e => samePath(e.filePath, filePath));
    const lengths = entry && entry.chapterLengths;
    if (!Array.isArray(lengths) || lengths.length !== chapterCount) return null;
    if (entry.chapterLengthsFileSize !== fileSize) return null;
    if (!lengths.every(l => Number.isFinite(l) && l >= 0)) return null;
    return lengths;
  } catch {
    return null;
  }
}

async function saveChapterLengthsToLibrary({ filePath, fileSize }, lengths) {
  if (!filePath || !fileSize) return;
  try {
    const lib = await loadLibrary();
    const entry = lib.find(e => samePath(e.filePath, filePath));
    if (!entry) return; // book not in the library (e.g. opened in browser mode)
    entry.chapterLengths = lengths;
    entry.chapterLengthsFileSize = fileSize;
    await saveLibrary(lib);
  } catch (e) {
    console.warn('[library] chapter lengths not saved:', e);
  }
}

/**
 * Computes the text length of each chapter and builds the map
 * of cumulative positions (0–100%) for the proportional progress bar.
 * Run in the background after the book's initial load.
 */
// `cachedLengths`: already known lengths (saved in the library on a previous
// opening); if present, no chapter is re-read.
// `cacheKey`: { filePath, fileSize } with which to save the computed lengths.
async function computeChapterLengths(cachedLengths = null, cacheKey = null) {
  chapterLengths = [];
  chapterCumulativePct = [];
  if (!currentSpineItems.length || !book) return;

  // The computation takes a long time: if another book is opened in the meantime it must
  // be abandoned, otherwise it would write this book's lengths onto the new one.
  const myBook = book;
  const items = currentSpineItems;
  let lengths;

  // In the same chapter read, the book's structure is also recorded
  // (paragraphs per chapter) for the translation cache, if missing: it is needed to
  // know how much of the book is translated.
  const translationCache = currentTranslationCache;
  const needStructure = !!translationCache && !translationCache.getStructure(currentBookFileSize);
  const fileSize = currentBookFileSize;

  if (cachedLengths && !needStructure) {
    lengths = cachedLengths.slice();
  } else {
    lengths = new Array(items.length).fill(0);
    const chapters = [];
    for (let i = 0; i < items.length; i++) {
      let body = null;
      // The chapter on screen is already loaded: reloading it would unload
      if (i === currentSpineIndex && currentChapterBody) {
        body = currentChapterBody;
      } else {
        try { body = await loadChapterDocument(items[i]); } catch { body = null; }
        if (book !== myBook) return;
      }
      lengths[i] = (body?.textContent?.trim() || '').length;
      if (needStructure) {
        chapters.push({ label: epubChapterLabel(i), texts: body ? paragraphTexts(extractParagraphs(body, null)) : [] });
      }
    }
    if (cacheKey && !cachedLengths) saveChapterLengthsToLibrary(cacheKey, lengths);
    if (needStructure && currentTranslationCache === translationCache) {
      translationCache.setStructure(chapters, fileSize);
      scheduleTranslationCacheSave(translationCache);
      refreshBookTranslationModal();
    }
  }

  // If all the chapters are empty, use a uniform distribution
  const totalChars = lengths.reduce((sum, l) => sum + l, 0);
  if (totalChars === 0) {
    const n = lengths.length;
    chapterLengths = lengths;
    chapterCumulativePct = lengths.map((_, i) => (i / Math.max(1, n - 1)) * 100);
    return;
  }

  chapterLengths = lengths;

  // Builds the cumulative positions: start position of each chapter
  const cumulative = [0];
  for (let i = 0; i < lengths.length - 1; i++) {
    cumulative.push(cumulative[i] + lengths[i]);
  }
  chapterCumulativePct = cumulative.map(c => (c / totalChars) * 100);

  // Rebuilds the ticks with the new proportional positions
  buildProgressTicks(currentSpineItems, book.navigation?.toc);
  updateProgress();
}

// ── Table of contents (TOC) ───────────────────────────────────────────────
function renderToc(items, parent = tocList) {
  parent.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = item.label.trim();
    a.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('#toc-list a').forEach(el => el.classList.remove('active'));
      a.classList.add('active');
      if (!book) return;
      const [href, fragment] = item.href.split('#');
      // Try spine.get() first — epubjs resolves relative paths internally
      const spineItem = book.spine.get(href);
      let idx = spineItem ? currentSpineItems.indexOf(spineItem) : -1;
      if (idx < 0) {
        // Fallback: compare basenames (handles mismatched directory prefixes)
        const hrefBase = href.split('/').pop();
        idx = currentSpineItems.findIndex(i => {
          if (i.href === href) return true;
          const iBase = (i.href || '').split('/').pop();
          return iBase === hrefBase;
        });
      }
      if (idx >= 0) {
        if (idx === currentSpineIndex && fragment) {
          // Same chapter — just scroll to the anchor
          scrollToTocAnchor(fragment);
        } else {
          displayChapter(idx).then(() => {
            if (fragment) scrollToTocAnchor(fragment);
          });
        }
      }
    });

    let tooltipDebounceTimer = null;
    const handleTranslateTooltip = () => {
      const currentLang = langSelect.value;
      const originalText = a.textContent.trim();

      // Already translated for this language → show immediately
      if (a.dataset.translatedLang === currentLang && a.dataset.translatedTitle) {
        a.title = a.dataset.translatedTitle;
        return;
      }

      // Debounce: wait for the user to stop on the entry before calling the API
      clearTimeout(tooltipDebounceTimer);
      tooltipDebounceTimer = setTimeout(async () => {
        if (a.dataset.translating === 'true') return;
        a.dataset.translating = 'true';

        try {
          const translated = await translateParagraphs([originalText], currentLang);
          if (translated && translated[0]) {
            a.dataset.translatedTitle = translated[0];
            a.dataset.translatedLang = currentLang;
            a.title = translated[0];
          }
        } catch (err) {
          // 429 = rate limit: handle silently, retry on the next hover
          if (err?.message?.includes('429')) {
            a.title = originalText;
          } else {
            console.warn('Error translating chapter title:', err);
            a.title = originalText;
          }
        } finally {
          a.dataset.translating = 'false';
        }
      }, 400);
    };
    a.addEventListener('mouseleave', () => clearTimeout(tooltipDebounceTimer));
    a.addEventListener('mouseenter', handleTranslateTooltip);
    a.addEventListener('focus', handleTranslateTooltip);

    li.appendChild(a);
    parent.appendChild(li);
    if (item.subitems?.length) {
      const sub = document.createElement('ul');
      sub.style.paddingLeft = '12px';
      renderToc(item.subitems, sub);
      li.appendChild(sub);
    }
  }
}

// ── Chapter navigation ────────────────────────────────────────────────────
prevBtn.addEventListener('click', () => {
  if (currentFileType === 'pdf' && pdfNav) {
    if (pdfNav.prev()) { displayPdfUnit(); }
    return;
  }
  if (!book || currentSpineIndex <= 0) return;
  displayChapter(currentSpineIndex - 1);
});
nextBtn.addEventListener('click', () => {
  if (currentFileType === 'pdf' && pdfNav) {
    if (pdfNav.next()) { displayPdfUnit(); }
    return;
  }
  if (!book || currentSpineIndex >= currentSpineItems.length - 1) return;
  displayChapter(currentSpineIndex + 1);
});

// Language change → saves the choice and re-translates the current chapter
langSelect.addEventListener('change', () => {
  const s = loadSettings();
  s.translationLang = langSelect.value;
  saveSettings(s);
  // Stop TTS if reading the translation panel (language changed)
  const ttsState = ttsController.getState();
  if (ttsState.panel === 'translation' && ttsState.status !== 'idle') {
    ttsController.stop();
  }
  populateTTSVoices();
  retranslateCurrentChapter();
});

// ── Keyboard navigation ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if (e.altKey && e.key === 'ArrowLeft') {
    if (!prevBtn.disabled) prevBtn.click();
    e.preventDefault();
    return;
  }
  if (e.altKey && e.key === 'ArrowRight') {
    if (!nextBtn.disabled) nextBtn.click();
    e.preventDefault();
    return;
  }

  // Left/Right arrow keys navigate PDF units (without alt)
  if (currentFileType === 'pdf' && pdfNav) {
    if (e.key === 'ArrowLeft') {
      if (pdfNav.prev()) { displayPdfUnit(); }
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight') {
      if (pdfNav.next()) { displayPdfUnit(); }
      e.preventDefault();
      return;
    }
  }

  const lineH = 16 * 1.8;
  const pageH = originalViewer.clientHeight * 0.9;
  let delta = 0;
  if (e.key === 'ArrowDown') { delta = lineH * 3; e.preventDefault(); }
  if (e.key === 'ArrowUp') { delta = -lineH * 3; e.preventDefault(); }
  if (e.key === ' ') { delta = e.shiftKey ? -pageH : pageH; e.preventDefault(); }
  if (delta === 0) return;

  const origMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
  const transMax = Math.max(1, translationViewer.scrollHeight - translationViewer.clientHeight);
  syncingScroll = true;
  originalViewer.scrollTop = Math.max(0, Math.min(originalViewer.scrollTop + delta, origMax));
  translationViewer.scrollTop = Math.max(0, Math.min((originalViewer.scrollTop / origMax) * transMax, transMax));
  syncingScroll = false;
});

// ── Bookmarks ─────────────────────────────────────────────────────────────
const BOOKMARKS_KEY = 'giano-reader-bookmarks';
// Bookmark keys seen at the last load/save: they are needed to tell apart,
// when saving, the changes made elsewhere (web server / PWA) from the local ones.
let _knownBookmarkKeys = new Set();

// Always reads from disk: the web server can add or remove bookmarks
// while the desktop app is open (do not use an in-memory cache).
async function loadBookmarks() {
  let stored;
  try {
    stored = await PersistentStorage.get(BOOKMARKS_KEY, []);
  } catch (e) {
    if (!reportStorageReadError(e)) throw e;
    return [];
  }
  const bms = Array.isArray(stored) ? stored : [];
  _knownBookmarkKeys = new Set(bms.map(bookmarkKey));
  return bms;
}
// Saves by merging the local list with the one on disk (see bookmarks-sync.js),
// so bookmarks created/removed from the phone are not overwritten.
async function saveBookmarks(bms) {
  let onDisk;
  try {
    onDisk = await PersistentStorage.get(BOOKMARKS_KEY, []);
  } catch (e) {
    // Unreadable file: do not save, so as not to overwrite the bookmarks on disk
    if (!reportStorageReadError(e)) throw e;
    return bms;
  }
  const merged = mergeBookmarkLists(bms, onDisk, _knownBookmarkKeys);
  await PersistentStorage.set(BOOKMARKS_KEY, merged);
  _knownBookmarkKeys = new Set(merged.map(bookmarkKey));
  return merged;
}

// Returns the label of the current chapter from the progress bar
function getChapterLabel(index) {
  const tick = progressTicks.querySelector(`[data-idx="${index}"]`);
  return tick?.dataset.label || ui('chapterN', { n: index + 1 });
}

// Adds a bookmark for the current chapter
addBookmarkBtn.addEventListener('click', async () => {
  if (!currentFilePath) return;
  const bms = await loadBookmarks();
  const scrollPct = Math.round(currentReadingScrollPct());

  let bm;
  if (currentFileType === 'pdf') {
    bm = {
      id: Date.now(),
      filePath: currentFilePath || '',
      fileName: (currentFilePath || '').split(/[\\/]/).pop() || '',
      bookTitle: (pdfDoc && pdfDoc.title) || bookTitle.textContent || '',
      chapterIndex: pdfNav ? pdfNav.currentIndex : 0,
      chapterLabel: pdfNav ? pdfUnitLabel() : '',
      scrollPct,
      fileType: 'pdf',
      pageNumber: pdfNav ? pdfNav.pageRange.start : 1,
    };
  } else {
    bm = {
      id: Date.now(),
      filePath: currentFilePath || '',
      fileName: currentFilePath
        ? currentFilePath.split(/[\\/]/).pop()
        : (bookTitle.textContent || 'libro'),
      bookTitle: bookTitle.textContent || '',
      chapterIndex: currentSpineIndex,
      chapterLabel: getChapterLabel(currentSpineIndex),
      scrollPct,
    };
  }

  bms.push(bm);
  await saveBookmarks(bms);
  await renderBookmarks();
  showNotice(ui('bookmarkAdded'));
});

// Renders the bookmark list in the modal
async function renderBookmarks(query = '') {
  const bms = await loadBookmarks();
  const q = query.trim().toLowerCase();
  const filtered = q
    ? bms.filter(bm => (bm.bookTitle || bm.fileName || '').toLowerCase().includes(q))
    : bms;

  bookmarksList.innerHTML = '';
  if (!filtered.length) {
    bookmarksList.appendChild(bookmarksPlaceholder);
    bookmarksPlaceholder.style.display = '';
    bookmarksPlaceholder.textContent = q ? ui('libNoResults', { query }) : ui('noBookmarksSaved');
    return;
  }
  for (const bm of filtered) {
    const li = document.createElement('li');
    li.className = 'bookmark-item';
    const title = bm.bookTitle || bm.fileName || bm.bookId || '';
    const chapterLabel = bm.chapterLabel || (bm.chapterIndex != null ? ui('chapterN', { n: Number(bm.chapterIndex) + 1 }) : '');
    li.innerHTML = `
      <span class="bm-icon"><img src="/icons/book-bookmark.svg" class="icon" alt="" /></span>
      <span class="bm-info">
        <span class="bm-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        <span class="bm-chapter">${escapeHtml(chapterLabel)}${bm.scrollPct != null ? ` · ${bm.scrollPct}%` : ''}</span>
      </span>
      <button class="bm-delete" title="${escapeHtml(ui('deleteBookmark'))}" data-id="${escapeHtml(bm.id)}"><img src="/icons/xmark.svg" class="icon" alt="" /></button>
    `;
    li.querySelector('.bm-info').addEventListener('click', () => { closeBookmarksModal(); openBookmark(bm); });
    li.querySelector('.bm-icon').addEventListener('click', () => { closeBookmarksModal(); openBookmark(bm); });
    li.querySelector('.bm-delete').addEventListener('click', async e => {
      e.stopPropagation();
      await deleteBookmark(bm.id);
    });
    bookmarksList.appendChild(li);
  }
}

if (bmSearchInput) {
  bmSearchInput.addEventListener('input', async () => {
    await renderBookmarks(bmSearchInput.value);
  });
}

// Open/close bookmarks modal
async function openBookmarksModal() {
  if (bmSearchInput) bmSearchInput.value = '';
  await renderBookmarks();
  bookmarksModal.classList.remove('hidden');
}
function closeBookmarksModal() {
  bookmarksModal.classList.add('hidden');
}
bookmarksOpenBtn.addEventListener('click', openBookmarksModal);
bmCloseBtn.addEventListener('click', closeBookmarksModal);
bookmarksModal.addEventListener('click', e => { if (e.target === bookmarksModal) closeBookmarksModal(); });

// Exports bookmarks as JSON
bmExportBtn.addEventListener('click', async () => {
  const bms = await loadBookmarks();
  const json = JSON.stringify(bms, null, 2);
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

  if (isTauri) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const filePath = await save({
        defaultPath: 'giano-bookmarks.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, json);
      await showAlert(ui('exportedTo') + filePath);
    } catch (err) {
      await showAlert(ui('exportError') + errMsg(err));
    }
  } else {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'giano-bookmarks.json';
    a.click();
    URL.revokeObjectURL(url);
    await showAlert(ui('savedToDownloads'));
  }
});

// Imports bookmarks from JSON (adds to the existing ones, avoids duplicates by id)
bmImportBtn.addEventListener('click', () => bmImportInput.click());
bmImportInput.addEventListener('change', async () => {
  const file = bmImportInput.files[0];
  if (!file) return;
  bmImportInput.value = '';
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error(ui('invalidFormat'));
    const existing = await loadBookmarks();
    const existingIds = new Set(existing.map(b => b.id));
    const toAdd = imported.filter(b => b && b.id && !existingIds.has(b.id));
    await saveBookmarks([...existing, ...toAdd]);
    await renderBookmarks();
    await showAlert(ui('importedMsg', { added: toAdd.length, skipped: imported.length - toAdd.length }));
  } catch (err) {
    await showAlert(ui('importError') + errMsg(err));
  }
});

async function deleteBookmark(id) {
  const bms = await loadBookmarks();
  await saveBookmarks(bms.filter(b => b.id !== id));
  await renderBookmarks();
}

// Shows the relocation modal and returns the newly chosen path, or null if cancelled
async function askRelocate(bm) {
  const fileName = bm.fileName || bm.bookTitle || '';
  bmMissingName.textContent = fileName;
  document.getElementById('bm-modal-msg').innerHTML =
    t(loadSettings().uiLang || 'en', 'fileNotFoundMsg', { name: `<strong>${escapeHtml(fileName)}</strong>` });
  bookmarkMissingModal.classList.remove('hidden');

  return new Promise(resolve => {
    bmCancelBtn.onclick = () => {
      bookmarkMissingModal.classList.add('hidden');
      resolve(null);
    };
    bmRelocateBtn.onclick = async () => {
      bookmarkMissingModal.classList.add('hidden');
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const filters = bm.fileType === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : [{ name: 'eBook', extensions: ['epub'] }];
        const selected = await open({ filters });
        resolve(selected || null);
      } catch (err) {
        console.error('[bookmark] relocation dialog error:', err);
        resolve(null);
      }
    };
  });
}

// Updates a bookmark's path and reloads the list
async function updateBookmarkPath(bm, newPath) {
  const bms = await loadBookmarks();
  const idx = bms.findIndex(b => b.id === bm.id);
  if (idx >= 0) {
    bms[idx].filePath = newPath;
    bms[idx].fileName = newPath.split(/[\\/]/).pop();
    await saveBookmarks(bms);
    await renderBookmarks();
    bm.filePath = bms[idx].filePath;
    bm.fileName = bms[idx].fileName;
  }
}

// Opens a bookmark: checks the file, handles relocation if needed
async function openBookmark(bm) {
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

  // Bookmarks without an absolute path (e.g. created in browser mode or in earlier versions)
  // cannot be opened automatically: ask for relocation if we are in Tauri
  const hasAbsolutePath = bm.filePath && (
    bm.filePath.startsWith('/') ||          // Unix
    /^[A-Za-z]:[\\\/]/.test(bm.filePath)   // Windows
  );

  const bmFileName = bm.fileName || bm.bookTitle || '';
  const bmChapterLabel = bm.chapterLabel || (bm.chapterIndex != null ? ui('chapterN', { n: Number(bm.chapterIndex) + 1 }) : '');

  if (!hasAbsolutePath) {
    if (isTauri) {
      // Path not absolute: ask user to locate the file
      const newPath = await askRelocate(bm);
      if (!newPath) return;
      await updateBookmarkPath(bm, newPath);
    } else {
      await showAlert(ui('openFileManually', { name: bmFileName, chapter: bmChapterLabel }));
      return;
    }
  }

  if (!isTauri) {
    await showAlert(ui('openFileManually', { name: bmFileName, chapter: bmChapterLabel }));
    return;
  }

  // Check that the file exists before trying to read it
  let fileExists = false;
  try {
    const { exists } = await import('@tauri-apps/plugin-fs');
    fileExists = await exists(bm.filePath);
  } catch {
    // exists() not available: try to open directly and handle the error there
    fileExists = true;
  }

  if (!fileExists) {
    const newPath = await askRelocate(bm);
    if (!newPath) return;
    await updateBookmarkPath(bm, newPath);
  }

  await loadBookmarkFile(bm);
}

// Restores the scroll position saved in the bookmark
function restoreScrollPct(pct) {
  if (pct == null) return;
  const generation = displayGeneration;
  const target = Math.min(1, Math.max(0, pct / 100));
  // Applies to the active reading panel: text, EPUB iframe or PDF canvas.
  // The original view's iframe loads its content asynchronously: if
  // the scroll does not "take" (content not ready yet) it retries for ~2s.
  // Until it is applied, the position on screen is not the user's: it must not be saved
  _scrollRestorePending++;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    _scrollRestorePending = Math.max(0, _scrollRestorePending - 1);
    scheduleReadingPositionSave();
  };
  const apply = (attempt) => {
    if (generation !== displayGeneration) return finish(); // the user has navigated elsewhere in the meantime
    const { left, right } = getSyncPair();
    if (left) left.setPct(target);
    if (right) right.setPct(target);
    const applied = left && (target === 0 || left.getPct() > 0);
    if (!applied && attempt < 20) setTimeout(() => apply(attempt + 1), 100);
    else finish();
  };
  // Double rAF: ensures the layout is computed after the paragraphs are rendered
  requestAnimationFrame(() => requestAnimationFrame(() => apply(0)));
}

// Scroll percentage (0-100) of the active reading panel: the text panel,
// or the EPUB iframe / PDF canvases in the original view.
function currentReadingScrollPct() {
  const { left } = getSyncPair();
  const pct = left ? left.getPct() * 100 : 0;
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
}

// Re-translates the current chapter (language or engine change) without losing the
// reading position: translateCurrentChapter brings the panels back to the top.
function retranslateCurrentChapter() {
  if (!currentChapterParagraphs || !currentChapterParagraphs.length) return;
  const pct = currentReadingScrollPct();
  translateCurrentChapter(pct);
  if (pct > 0) restoreScrollPct(pct);
}

// Reads the file from disk and loads it into the reader, then navigates to the saved chapter
async function loadBookmarkFile(bm) {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const raw = await readFile(bm.filePath);
    const fileData = raw.buffer ?? raw;
    const ext = bm.filePath.split('.').pop().toLowerCase();

    if (ext === 'epub') {
      const previousViewMode = currentViewMode;
      await loadEpub(fileData, bm.filePath, { restorePosition: false });
      if (previousViewMode === 'original') {
        setViewMode('original', { skipRender: true });
      }
      // Index 0 too: loadEpub opens the first "real" chapter, which may not be 0
      if (Number.isInteger(bm.chapterIndex) && bm.chapterIndex >= 0 && bm.chapterIndex < currentSpineItems.length) {
        await displayChapter(bm.chapterIndex, bm.scrollPct ?? 0);
      } else if (bm.scrollPct > 0) {
        restoreScrollPct(bm.scrollPct);
      }
    } else if (ext === 'pdf' || bm.fileType === 'pdf') {
      await loadPdfFile(fileData, bm.filePath, { restorePosition: false });
      // Navigate to saved unit and restore scroll position
      if (pdfNav && typeof bm.chapterIndex === 'number') {
        await displayChapter(bm.chapterIndex, bm.scrollPct ?? 0);
      } else if (bm.scrollPct > 0) {
        restoreScrollPct(bm.scrollPct);
      }
    } else {
      await showAlert(ui('unsupportedFormat'));
    }
  } catch (err) {
    console.error('[bookmark] open error:', err);
    const msg = errMsg(err);
    if (msg.includes('forbidden') || msg.includes('not allowed') || msg.includes('No such file') || msg.includes('os error')) {
      const newPath = await askRelocate(bm);
      if (!newPath) return;
      await updateBookmarkPath(bm, newPath);
      await loadBookmarkFile(bm);
    } else {
      await showAlert(ui('errorOpening') + msg);
    }
  }
}

// Initializes the bookmark list at startup
(async function initBookmarks() {
  await renderBookmarks();
})();

// ── Window geometry persistence (Tauri only) ──────────────────────────────
const WINDOW_STATE_KEY = 'giano-reader-window-state';
// Wait after the last move/resize before saving
const WINDOW_STATE_SAVE_DELAY_MS = 500;

async function saveWindowState() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const isMaximized = await win.isMaximized();
    // When maximized, the previous position and size are kept, so
    // that when leaving maximization the window returns to where it was.
    let previous = {};
    try { previous = JSON.parse(localStorage.getItem(WINDOW_STATE_KEY) || '{}') || {}; } catch { }
    const state = isMaximized ? { ...previous, maximized: true } : { maximized: false };
    if (!isMaximized) {
      const { x, y } = await win.outerPosition();
      const { width, height } = await win.innerSize();
      // Store raw physical pixels — restored with PhysicalSize/PhysicalPosition
      // to avoid scale-factor rounding drift that grows the window each restart
      state.x = x; state.y = y;
      state.width = width; state.height = height;
      state.physical = true;
    }
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[window-state] save error:', err);
  }
}

async function restoreWindowState() {
  try {
    const raw = localStorage.getItem(WINDOW_STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { PhysicalSize, PhysicalPosition, LogicalSize, LogicalPosition } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWindow();

    // Checks whether the coordinates are valid (not negative or excessive) to avoid "lost" windows
    const isValidPos = state.x !== undefined && state.y !== undefined && state.x >= -10000 && state.y >= -10000;

    // First the "normal" geometry (even if the window is to be maximized: it is
    // the one it returns to when leaving maximization), then the maximization
    if (state.physical) {
      if (state.width && state.height) await win.setSize(new PhysicalSize(state.width, state.height));
      if (isValidPos) await win.setPosition(new PhysicalPosition(state.x, state.y));
    } else {
      if (state.width && state.height) await win.setSize(new LogicalSize(state.width, state.height));
      if (isValidPos) await win.setPosition(new LogicalPosition(state.x, state.y));
    }
    if (state.maximized) await win.maximize();
  } catch (err) {
    console.warn('[window-state] restore error:', err);
  }
}

if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
  // Restore the geometry as soon as possible
  restoreWindowState();

  // Save geometry before closing
  window.addEventListener('beforeunload', saveWindowState);

  // Also save when the window is moved or resized, half a
  // second after the last event: the save on close is asynchronous and
  // does not always make it in time. No saving while the window is still.
  (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      let timer = null;
      const scheduleSave = () => {
        clearTimeout(timer);
        timer = setTimeout(saveWindowState, WINDOW_STATE_SAVE_DELAY_MS);
      };
      await win.onMoved(scheduleSave);
      await win.onResized(scheduleSave);
    } catch (err) {
      console.warn('[window-state] cannot listen to window changes:', err);
    }
  })();
}

// Destroy the book when the window closes to free memory
window.addEventListener('beforeunload', () => {
  if (book) { try { book.destroy(); } catch (_) { } }
});

// ── Update check ──────────────────────────────────────────────────────────
/**
 * Checks at startup whether a new version is available through tauri-plugin-updater.
 * Shows a non-blocking modal with the option to download and install.
 * Runs only in the Tauri environment; silenced on network error.
 */
async function checkForUpdates() {
  if (!(window.__TAURI__ || window.__TAURI_INTERNALS__)) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update?.available) return;

    const lang = loadSettings().uiLang || 'en';
    const modal = document.getElementById('update-modal');
    const versionEl = document.getElementById('update-modal-version');
    const titleEl = document.getElementById('update-modal-title');
    const msgEl = document.getElementById('update-modal-msg');
    const installBtn = document.getElementById('update-install-btn');
    const skipBtn = document.getElementById('update-skip-btn');
    const progressWrap = document.getElementById('update-progress-wrap');
    const progressBar = document.getElementById('update-progress-bar');
    const progressLabel = document.getElementById('update-progress-label');

    if (!modal) return;

    const version = update.version || '';
    if (versionEl) versionEl.textContent = version;
    if (titleEl) titleEl.textContent = t(lang, 'updateAvailable');
    if (msgEl) msgEl.innerHTML = t(lang, 'updateMsg', { version: `<strong>${version}</strong>` });
    if (installBtn) installBtn.textContent = t(lang, 'updateInstall');
    if (skipBtn) skipBtn.textContent = t(lang, 'updateLater');

    modal.classList.remove('hidden');

    skipBtn?.addEventListener('click', () => {
      modal.classList.add('hidden');
    }, { once: true });

    installBtn?.addEventListener('click', async () => {
      installBtn.disabled = true;
      skipBtn.disabled = true;
      if (progressWrap) progressWrap.classList.remove('hidden');

      try {
        let downloaded = 0;
        let total = 0;

        await update.downloadAndInstall(event => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0;
          } else if (event.event === 'Progress') {
            downloaded += event.data.chunkLength ?? 0;
            const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
            if (progressBar) progressBar.value = pct;
            if (progressLabel) progressLabel.textContent = t(lang, 'updateDownloading', { pct });
          }
          // 'Finished' → the app will restart automatically
        });

        // If we get here (unlikely), restart manually
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch (err) {
        console.error('[updater] download error:', err);
        if (progressWrap) progressWrap.classList.add('hidden');
        if (msgEl) msgEl.textContent = t(lang, 'updateError', { error: String(err) });
        if (installBtn) installBtn.disabled = false;
        if (skipBtn) skipBtn.disabled = false;
      }
    }, { once: true });

  } catch (err) {
    // Silent error: network not available or endpoint unreachable
    console.info('[updater] check skipped:', err?.message ?? err);
  }
}

// Starts the update check 3 seconds after loading
// (delay so as not to interfere with the app's cold start)
if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
  setTimeout(checkForUpdates, 3000);
}

// ── Library ────────────────────────────────────────────────────────────────
const LIBRARY_KEY = 'giano-reader-library';
let _cachedLibrary = null;

async function loadLibrary() {
  if (_cachedLibrary) return _cachedLibrary;
  let stored;
  try {
    stored = await PersistentStorage.get(LIBRARY_KEY, []);
  } catch (e) {
    // Unreadable file: empty list not cached, so it is retried on the next read
    if (!reportStorageReadError(e)) throw e;
    return [];
  }
  // Older folder scans added a second entry for a book already in the library
  // when its path was spelled differently ("C:\Books/a.epub"): merged here.
  const { library, merged } = dedupeLibrary(Array.isArray(stored) ? stored : []);
  _cachedLibrary = library;
  if (merged.length) {
    console.info(`[library] merged ${merged.length} duplicate entries`);
    await saveLibrary(library);
    for (const { entry, otherPaths } of merged) {
      await mergeTranslationCaches(entry.filePath, otherPaths, entry.title);
    }
  }
  return _cachedLibrary;
}

/**
 * Moves the translations saved under other spellings of a book's path into the
 * cache of `keptPath` (caches are keyed by a hash of the path string).
 * Skipped for the open book: its cache is in memory and would overwrite the merge.
 */
async function mergeTranslationCaches(keptPath, otherPaths, title) {
  try {
    const kept = await loadBookTranslationCache(keptPath, title);
    const others = [];
    for (const p of otherPaths) {
      const other = await loadBookTranslationCache(p, title);
      if (other.id !== kept.id) others.push({ path: p, cache: other });
    }
    const ids = [kept.id, ...others.map(o => o.cache.id)];
    if (currentTranslationCache && ids.includes(currentTranslationCache.id)) return;
    const useful = others.filter(o => Object.keys(o.cache.data.translations).length || o.cache.data.structure);
    if (!useful.length) return;
    for (const { cache } of useful) kept.data = mergeCacheData(kept.data, cache.data);
    kept.dirty = true;
    await saveBookTranslationCache(kept);
    if (kept.dirty) return; // not saved: keep the other files
    for (const { path } of useful) await deleteBookTranslationCache(path, title);
  } catch (e) {
    console.warn('[library] translation caches not merged:', e);
  }
}

/** The path of the library entry for `filePath` (same file, maybe spelled differently), or `filePath`. */
async function libraryPathFor(filePath) {
  if (!filePath) return filePath;
  try {
    const entry = (await loadLibrary()).find(e => samePath(e.filePath, filePath));
    return entry ? entry.filePath : filePath;
  } catch {
    return filePath;
  }
}
async function saveLibrary(entries) {
  // The web server writes the ratings given by the PWA to the same file:
  // before saving, the most recent ones are fetched from disk (library-sync.js).
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    try {
      const onDisk = await PersistentStorage.get(LIBRARY_KEY, null);
      mergeLibraryRatings(entries, onDisk);
    } catch (e) {
      // Unreadable file: do not save, so as not to overwrite the library on disk
      if (reportStorageReadError(e)) {
        _cachedLibrary = entries;
        return;
      }
      console.warn('[Library] rating merge skipped:', e);
    }
  }
  _cachedLibrary = entries;
  await PersistentStorage.set(LIBRARY_KEY, entries);
}

async function addEntries(newEntries) {
  const lib = await loadLibrary();
  const existingPaths = new Set(lib.map(e => pathKey(e.filePath)));
  let added = 0, skipped = 0;
  for (const entry of newEntries) {
    const key = pathKey(entry.filePath);
    if (existingPaths.has(key)) {
      skipped++;
    } else {
      lib.push(entry);
      existingPaths.add(key);
      added++;
    }
  }
  await saveLibrary(lib);
  return { added, skipped };
}

async function removeEntry(id) {
  const lib = await loadLibrary();
  const removed = lib.find(e => e.id === id);
  await saveLibrary(lib.filter(e => e.id !== id));
  // The saved translations of the deleted book are no longer needed
  if (removed) await deleteBookTranslationCache(removed.filePath, removed.title);
  await renderLibraryGrid({ keepPosition: true });
}

async function readDirRecursive(dirPath, maxDepth = 3) {
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');
  const results = [];
  async function walk(path, currentDepth) {
    let entries;
    try { entries = await readDir(path); } catch { return; }
    for (const entry of entries) {
      // Tauri 2 entries have no `path`: joined with the system separator, so
      // the path is spelled like the one the file dialog returns
      const entryPath = entry.path || await join(path, entry.name);
      const isDir = entry.isDirectory === true || entry.children !== undefined;
      if (isDir) {
        if (currentDepth < maxDepth) {
          await walk(entryPath, currentDepth + 1);
        }
      } else {
        const name = (entry.name || '').toLowerCase();
        if (name.endsWith('.epub') || name.endsWith('.pdf')) {
          results.push(entryPath);
        }
      }
    }
  }
  await walk(dirPath, 1); // the root folder is level 1
  return results;
}

async function extractMetadata(filePath) {
  const fileName = filePath.split(/[\\/]/).pop();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const addedAt = Date.now();

  // ── PDF branch ──────────────────────────────────────────────────────────
  if (fileName.toLowerCase().endsWith('.pdf')) {
    const titleFallback = fileName.replace(/\.pdf$/i, '');
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const raw = await readFile(filePath);
      const buffer = raw.buffer ?? raw;
      const fileSize = buffer.byteLength;
      try {
        const doc = await loadPdf(buffer, fileName);
        const coverDataUrl = await renderPdfCoverDataUrl(doc.proxy);
        const entry = { id, filePath, fileName, title: doc.title || titleFallback, author: doc.author || '', publisher: '', language: '', pubdate: '', description: '', fileSize, pageCount: doc.pageCount || 0, coverDataUrl, fileType: 'pdf', status: 'to-read', notes: '', addedAt };
        // Only the metadata was needed: the document must be released, otherwise a
        // scan with many PDFs keeps them all in memory.
        try { await doc.proxy.destroy(); } catch (_) { }
        return entry;
      } catch {
        return { id, filePath, fileName, title: titleFallback, author: '', fileSize: fileSize ?? 0, pageCount: 0, coverDataUrl: null, fileType: 'pdf', status: 'to-read', notes: '', addedAt };
      }
    } catch {
      return { id, filePath, fileName, title: titleFallback, author: '', fileSize: 0, pageCount: 0, coverDataUrl: null, fileType: 'pdf', status: 'to-read', notes: '', addedAt };
    }
  }

  // ── EPUB branch ─────────────────────────────────────────────────────────
  const titleFallback = fileName.replace(/\.epub$/i, '');

  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const raw = await readFile(filePath);
    const buffer = raw.buffer ?? raw;
    const fileSize = buffer.byteLength;

    // We pass the ArrayBuffer directly — as loadEpub() does.
    // Using a blob URL causes internal fetches via XHR that hang in the Tauri WebView.
    let epubBook;
    try {
      epubBook = ePub(buffer);
      await Promise.race([
        epubBook.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('epub ready timeout')), 8000)),
      ]);

      const meta = await Promise.race([
        epubBook.loaded.metadata,
        new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout')), 5000)),
      ]);
      const title = meta.title || titleFallback;
      const author = meta.creator || '';
      const publisher = meta.publisher || '';
      const language = meta.language || '';
      const pubdate = meta.pubdate ? meta.pubdate.slice(0, 4) : '';
      const description = meta.description || '';

      // Estimates the number of pages from the total characters in the spine.
      // Standard editorial estimate: ~1800 characters per page.
      let pageCount = 0;
      try {
        await Promise.race([
          epubBook.loaded.spine,
          new Promise((_, rej) => setTimeout(() => rej(new Error('spine timeout')), 5000)),
        ]);
        let totalChars = 0;
        const spineItems = [];
        epubBook.spine.each(item => spineItems.push(item));
        for (const item of spineItems) {
          try {
            const doc = await Promise.race([
              item.load(epubBook.load.bind(epubBook)),
              new Promise((_, rej) => setTimeout(() => rej(new Error('item timeout')), 3000)),
            ]);
            const body = doc?.body || doc?.querySelector?.('body') || doc;
            if (body) totalChars += (body.textContent || '').length;
            if (typeof item.unload === 'function') item.unload();
          } catch { /* salta questo item */ }
        }
        pageCount = totalChars > 0 ? Math.max(1, Math.round(totalChars / 1800)) : 0;
      } catch { /* page estimate not available */ }

      // Get the cover as a data URL (scaled to max 200px) for localStorage
      let coverDataUrl = null;
      try {
        const coverBlobUrl = await Promise.race([
          epubBook.coverUrl(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cover timeout')), 5000)),
        ]);

        if (coverBlobUrl) {
          // Convert to data URL via canvas BEFORE destroying the book
          coverDataUrl = await new Promise(resolve => {
            const img = new Image();
            const timer = setTimeout(() => resolve(null), 5000);
            img.onload = () => {
              clearTimeout(timer);
              try {
                const maxW = 200;
                const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
                const w = Math.round(img.naturalWidth * scale);
                const h = Math.round(img.naturalHeight * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.80));
              } catch { resolve(null); }
            };
            img.onerror = () => { clearTimeout(timer); resolve(null); };
            img.src = coverBlobUrl;
          });
        }
      } catch { coverDataUrl = null; }

      // Destroy AFTER converting the cover
      epubBook.destroy();
      return { id, filePath, fileName, title, author, publisher, language, pubdate, description, fileSize, pageCount, coverDataUrl, status: 'to-read', notes: '', addedAt };
    } catch (e) {
      try { epubBook?.destroy(); } catch { }
      return { id, filePath, fileName, title: titleFallback, author: '', fileSize: fileSize ?? 0, pageCount: 0, coverDataUrl: null, addedAt };
    }
  } catch {
    return { id, filePath, fileName, title: titleFallback, author: '', fileSize: 0, pageCount: 0, coverDataUrl: null, addedAt };
  }
}

let scanInProgress = false;

// Auto-add a book to the library when opened, extracting cover in background
// `knownSize`: file size when `arrayBuffer` is no longer readable
// (pdf.js transfers it to the worker, leaving it with byteLength 0).
// `knownCoverUrl`: (blob) URL of the cover of the book already open, or null
// if the book has no cover; undefined = to be extracted by reopening the file.
async function autoAddToLibrary(arrayBuffer, filePath, meta, knownSize, knownCoverUrl) {
  try {
    const isPdf = /\.pdf$/i.test(filePath);
    const lib = await loadLibrary();
    const existing = lib.find(e => samePath(e.filePath, filePath));
    if (existing) {
      // Already in library: a PDF added without a cover gets the one just rendered
      if (isPdf && !existing.coverDataUrl && typeof knownCoverUrl === 'string' && knownCoverUrl) {
        existing.coverDataUrl = knownCoverUrl;
        await saveLibrary(lib);
      }
      return;
    }
    const fileName = filePath.split(/[\\/]/).pop();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const addedAt = Date.now();
    const fileSize = knownSize || arrayBuffer.byteLength || 0;

    // ── PDF branch ──────────────────────────────────────────────────────
    if (isPdf) {
      const title = meta.title || fileName.replace(/\.pdf$/i, '');
      const author = meta.creator || '';
      const coverDataUrl = typeof knownCoverUrl === 'string' && knownCoverUrl ? knownCoverUrl : null;
      await addEntries([{ id, filePath, fileName, title, author, publisher: '', language: '', pubdate: '', description: '', fileSize, pageCount: 0, coverDataUrl, fileType: 'pdf', status: 'to-read', notes: '', addedAt }]);
      return;
    }

    // ── EPUB branch ─────────────────────────────────────────────────────
    const title = meta.title || fileName.replace(/\.epub$/i, '');
    const author = meta.creator || '';
    const publisher = meta.publisher || '';
    const language = meta.language || '';
    const pubdate = meta.pubdate ? meta.pubdate.slice(0, 4) : '';
    const description = meta.description || '';
    // Add immediately without cover so the entry appears right away
    await addEntries([{ id, filePath, fileName, title, author, publisher, language, pubdate, description, fileSize, pageCount: 0, coverDataUrl: null, status: 'to-read', notes: '', addedAt }]);
    // Extract cover in background and update the entry. The cover URL of the
    // book that is being opened is reused when the caller has it: opening the
    // EPUB a second time only for the cover would decompress it twice.
    let tmpBook = null;
    try {
      let coverBlobUrl = knownCoverUrl;
      if (coverBlobUrl === undefined) {
        tmpBook = ePub(arrayBuffer);
        await Promise.race([tmpBook.ready, new Promise((_, r) => setTimeout(() => r(new Error('t')), 8000))]);
        coverBlobUrl = await Promise.race([tmpBook.coverUrl(), new Promise((_, r) => setTimeout(() => r(new Error('t')), 5000))]);
      }
      if (coverBlobUrl) {
        const coverDataUrl = await new Promise(resolve => {
          const img = new Image();
          const timer = setTimeout(() => resolve(null), 5000);
          img.onload = () => {
            clearTimeout(timer);
            try {
              const maxW = 200;
              const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
              const w = Math.round(img.naturalWidth * scale);
              const h = Math.round(img.naturalHeight * scale);
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              canvas.getContext('2d').drawImage(img, 0, 0, w, h);
              resolve(canvas.toDataURL('image/jpeg', 0.80));
            } catch { resolve(null); }
          };
          img.onerror = () => { clearTimeout(timer); resolve(null); };
          img.src = coverBlobUrl;
        });
        if (coverDataUrl) {
          const current = await loadLibrary();
          const idx = current.findIndex(e => samePath(e.filePath, filePath));
          if (idx >= 0) { current[idx].coverDataUrl = coverDataUrl; await saveLibrary(current); }
        }
      }
    } catch { /* cover extraction failed, entry already saved without cover */ }
    finally {
      if (tmpBook) { try { tmpBook.destroy(); } catch (_) { } }
    }
  } catch (e) {
    console.warn('[library] autoAdd error:', e);
  }
}

async function scanFolder(rootPath) {
  if (scanInProgress) return;
  scanInProgress = true;
  const scanBtn = document.getElementById('lib-scan-btn');
  const libStatus = document.getElementById('lib-status');
  if (scanBtn) scanBtn.disabled = true;
  libStatus.textContent = ui('libScanning');
  libStatus.classList.remove('hidden');
  try {
    const maxDepth = loadSettings().searchDepth ?? 3;
    const epubPaths = await readDirRecursive(rootPath, maxDepth);
    if (!epubPaths.length) {
      libStatus.textContent = ui('libNoBooksFound');
      return;
    }

    // 1. Size and modification date of every file (fast: the file is not opened)
    const { stat } = await import('@tauri-apps/plugin-fs');
    const files = [];
    for (const path of epubPaths) {
      try {
        files.push({ path, fingerprint: fileFingerprint(await stat(path)) });
      } catch (e) {
        console.warn('[library] cannot stat', path, e);
      }
    }

    // 2. Only new books and those modified after indexing are analyzed.
    //    The scan never removes entries (books on disks that are not connected).
    const plan = planScan(await loadLibrary(), files);
    const toAnalyse = [
      ...plan.added.map(f => ({ ...f, entry: null })),
      ...plan.changed,
    ];

    // 3. Analysis, saving in groups: an interruption does not lose the work done
    const SAVE_EVERY = 10;
    let pendingNew = [];
    let pendingChanged = [];
    const flush = async () => {
      if (!pendingNew.length && !pendingChanged.length) return;
      const lib = await loadLibrary();
      for (const merged of pendingChanged) {
        const idx = lib.findIndex(e => e.id === merged.id);
        if (idx >= 0) lib[idx] = merged;
      }
      const known = new Set(lib.map(e => pathKey(e.filePath)));
      for (const entry of pendingNew) {
        const key = pathKey(entry.filePath);
        if (!known.has(key)) { lib.push(entry); known.add(key); }
      }
      await saveLibrary(lib);
      pendingNew = [];
      pendingChanged = [];
    };

    for (let i = 0; i < toAnalyse.length; i++) {
      const { path, fingerprint, entry } = toAnalyse[i];
      libStatus.textContent = ui('libScanAnalysing', { n: i + 1, total: toAnalyse.length });
      const fresh = await extractMetadata(path);
      if (entry) {
        pendingChanged.push(mergeReanalysis(entry, fresh, fingerprint));
      } else {
        pendingNew.push({ ...fresh, fileSize: fingerprint.size || fresh.fileSize || 0, fileMtime: fingerprint.mtime });
      }
      if (pendingNew.length + pendingChanged.length >= SAVE_EVERY) await flush();
    }
    await flush();

    // 4. Unchanged books indexed before the modification date was recorded:
    //    it is recorded now, so future changes are recognized.
    const missingTime = plan.unchanged.filter(f => f.entry.fileMtime == null && f.fingerprint.mtime != null);
    if (missingTime.length) {
      const lib = await loadLibrary();
      const times = new Map(missingTime.map(f => [f.entry.id, f.fingerprint.mtime]));
      for (const e of lib) if (times.has(e.id)) e.fileMtime = times.get(e.id);
      await saveLibrary(lib);
    }

    libStatus.textContent = ui('libScanSummary', {
      added: plan.added.length,
      updated: plan.changed.length,
      unchanged: plan.unchanged.length,
    });
    await renderLibraryGrid();
  } catch (err) {
    libStatus.textContent = ui('libImportError') + errMsg(err);
  } finally {
    scanInProgress = false;
    if (scanBtn) scanBtn.disabled = false;
  }
}

// The list is drawn in pages of LIB_PAGE_SIZE cards: the next page is added
// when the list is scrolled near its end (no "load more" button).
const LIB_PAGE_SIZE = 60;
const LIB_FILL_MARGIN_PX = 600;
let _libVisible = [];    // entries matching the filters, in display order
let _libRendered = 0;    // how many of them have a card

/**
 * Redraws the library list with the current search, filters and sort order.
 * `keepPosition`: after a book is deleted or edited, the cards already shown
 * and the scroll position are kept instead of going back to the top.
 */
async function renderLibraryGrid({ keepPosition = false } = {}) {
  const lib = await loadLibrary();
  const grid = document.getElementById('lib-grid');
  const placeholder = document.getElementById('lib-placeholder');
  if (!grid || !placeholder) return;
  const { query, status, rating, sort } = getLibFilters();
  _libVisible = sortLibrary(filterLibrary(lib, { query, status, rating }), sort, loadSettings().uiLang || 'en');
  // Updates the modal title with the count
  const titleEl = document.getElementById('library-modal-title');
  if (titleEl) titleEl.textContent = ui('libraryTitle', { count: lib.length });

  const scrollTop = keepPosition ? grid.scrollTop : 0;
  const shown = keepPosition ? _libRendered : 0;
  grid.innerHTML = '';
  _libRendered = 0;

  if (!_libVisible.length) {
    placeholder.classList.remove('hidden');
    placeholder.textContent = query.trim() ? ui('libNoResults', { query }) : ui('libEmpty');
    grid.classList.add('hidden');
    return;
  }
  placeholder.classList.add('hidden');
  grid.classList.remove('hidden');

  appendLibraryCards(Math.max(LIB_PAGE_SIZE, shown));
  grid.scrollTop = scrollTop;
  fillLibraryGrid();
}

/** Adds the cards of the next `count` visible entries. */
function appendLibraryCards(count) {
  const grid = document.getElementById('lib-grid');
  const end = Math.min(_libRendered + count, _libVisible.length);
  const fragment = document.createDocumentFragment();
  for (let i = _libRendered; i < end; i++) fragment.appendChild(createLibraryCard(_libVisible[i]));
  grid.appendChild(fragment);
  _libRendered = end;
}

/** Adds pages of cards while the end of the list is (nearly) in view. */
function fillLibraryGrid() {
  const grid = document.getElementById('lib-grid');
  // Hidden dialog: no size, every page would look "in view"
  if (!grid || !grid.clientHeight) return;
  while (_libRendered < _libVisible.length &&
    grid.scrollHeight - grid.scrollTop - grid.clientHeight < LIB_FILL_MARGIN_PX) {
    appendLibraryCards(LIB_PAGE_SIZE);
  }
}

function createLibraryCard(entry) {
  const card = document.createElement('div');
  card.className = 'lib-book-card';
  card.dataset.id = entry.id;
  // Without a cover: a box with the file type (an <img> with an empty `src`
  // would show the broken-image icon)
  let cover;
  if (entry.coverDataUrl) {
    cover = document.createElement('img');
    cover.className = 'lib-book-cover';
    cover.alt = entry.title || ui('libCoverPlaceholder');
    cover.loading = 'lazy'; // Native lazy loading
    cover.src = entry.coverDataUrl;
  } else {
    const isPdf = entry.fileType === 'pdf' || /\.pdf$/i.test(entry.filePath || '');
    cover = document.createElement('div');
    cover.className = `lib-book-cover lib-cover-placeholder${isPdf ? ' lib-pdf-placeholder' : ''}`;
    cover.textContent = isPdf ? 'PDF' : 'EPUB';
  }
  const info = document.createElement('div');
  info.className = 'lib-book-info';
  // Title row: title text + action buttons right-aligned
  const titleRow = document.createElement('div');
  titleRow.className = 'lib-book-title-row';
  const titleTextEl = document.createElement('span');
  titleTextEl.className = 'lib-book-title';
  titleTextEl.textContent = entry.title || ui('libCoverPlaceholder');
  titleTextEl.title = entry.title || '';
  const infoBtn = document.createElement('button');
  infoBtn.className = 'lib-book-action-btn';
  infoBtn.title = ui('detailInfoBtn');
  infoBtn.innerHTML = 'ⓘ';
  infoBtn.addEventListener('click', async e => { e.stopPropagation(); await openBookDetail(entry.id); });
  const delBtn = document.createElement('button');
  delBtn.className = 'lib-book-action-btn lib-book-action-btn--danger';
  delBtn.title = ui('libDeleteBook');
  delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
  delBtn.addEventListener('click', async e => { e.stopPropagation(); await removeEntry(entry.id); });
  titleRow.appendChild(titleTextEl);
  titleRow.appendChild(infoBtn);
  titleRow.appendChild(delBtn);
  // Author row with status badge
  const authorRow = document.createElement('div');
  authorRow.style.display = 'flex';
  authorRow.style.alignItems = 'center';
  authorRow.style.gap = '6px';
  authorRow.style.justifyContent = 'space-between';
  const authorEl = document.createElement('span');
  authorEl.className = 'lib-book-author';
  authorEl.textContent = entry.author || '';
  authorEl.style.flex = '1';
  authorEl.style.minWidth = '0';
  authorRow.appendChild(authorEl);
  const rating = normalizeRating(entry.rating);
  if (rating) {
    const ratingEl = document.createElement('span');
    ratingEl.className = 'lib-rating';
    ratingEl.textContent = ratingStars(rating);
    ratingEl.title = `${rating}/5`;
    ratingEl.setAttribute('aria-label', `${ui('detailRating')}: ${rating}/5`);
    authorRow.appendChild(ratingEl);
  }
  if (entry.status) {
    const badge = document.createElement('span');
    badge.className = `lib-status-badge lib-status-badge--${entry.status}`;
    const statusLabels = {
      'to-read': ui('statusToRead'),
      'reading': ui('statusReading'),
      'read': ui('statusRead'),
    };
    badge.textContent = statusLabels[entry.status] || entry.status;
    authorRow.appendChild(badge);
  }
  const metaEl = document.createElement('span');
  metaEl.className = 'lib-book-meta';
  const parts = [];
  if (entry.publisher) parts.push(entry.publisher);
  if (entry.pubdate) parts.push(entry.pubdate);
  if (entry.language) parts.push(entry.language.toUpperCase());
  metaEl.textContent = parts.join(' · ');
  const sizeEl = document.createElement('span');
  sizeEl.className = 'lib-book-size';
  const sizeParts = [];
  if (entry.pageCount > 0) sizeParts.push(`~${entry.pageCount} pp.`);
  if (entry.fileSize > 0) {
    const mb = entry.fileSize / (1024 * 1024);
    sizeParts.push(mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(entry.fileSize / 1024)} KB`);
  }
  sizeEl.textContent = sizeParts.join(' · ');
  const metaRow = document.createElement('div');
  metaRow.className = 'lib-book-meta-row';
  metaRow.appendChild(metaEl);
  metaRow.appendChild(sizeEl);
  info.appendChild(titleRow);
  info.appendChild(authorRow);
  info.appendChild(metaRow);
  card.appendChild(cover);
  card.appendChild(info);
  card.addEventListener('click', () => openBookFromLibrary(entry));
  return card;
}

// Open book detail modal for editing metadata
async function openBookDetail(entryId) {
  const lib = await loadLibrary();
  const entry = lib.find(e => e.id === entryId);
  if (!entry) return;
  const modal = document.getElementById('book-detail-modal');
  renderDetailTranslation(entry); // in the background: reads the book's cache file
  // Localize all labels
  document.getElementById('book-detail-title').textContent = entry.title || ui('bookDetail');
  document.querySelector('label[for="detail-title"]').textContent = ui('detailTitle');
  document.querySelector('label[for="detail-author"]').textContent = ui('detailAuthor');
  document.querySelector('label[for="detail-publisher"]').textContent = ui('detailPublisher');
  document.querySelector('label[for="detail-pubdate"]').textContent = ui('detailYear');
  document.querySelector('label[for="detail-language"]').textContent = ui('detailLanguage');
  document.querySelector('label[for="detail-status"]').textContent = ui('detailStatus');
  document.getElementById('detail-rating-label').textContent = ui('detailRating');
  document.querySelector('label[for="detail-description"]').textContent = ui('detailDescription');
  document.querySelector('label[for="detail-notes"]').textContent = ui('detailNotes');
  document.getElementById('book-detail-save-label').textContent = ui('detailSave');
  document.getElementById('book-detail-delete-label').textContent = ui('detailDelete');
  document.getElementById('detail-notes').placeholder = ui('personalNotes');
  // Localize status options
  document.getElementById('detail-status-none').textContent = ui('statusNone');
  document.getElementById('detail-status-to-read').textContent = ui('statusToRead');
  document.getElementById('detail-status-reading').textContent = ui('statusReading');
  document.getElementById('detail-status-read').textContent = ui('statusRead');
  // Fill values
  document.getElementById('book-detail-cover').src = entry.coverDataUrl || '';
  document.getElementById('detail-title').value = entry.title || '';
  document.getElementById('detail-author').value = entry.author || '';
  document.getElementById('detail-publisher').value = entry.publisher || '';
  document.getElementById('detail-pubdate').value = entry.pubdate || '';
  document.getElementById('detail-language').value = entry.language || '';
  document.getElementById('detail-status').value = entry.status || '';
  setDetailRating(entry.rating);
  document.getElementById('detail-description').value = entry.description ? entry.description.replace(/<[^>]+>/g, '') : '';
  document.getElementById('detail-notes').value = entry.notes || '';
  const mb = entry.fileSize ? (entry.fileSize / (1024 * 1024)).toFixed(2) : '?';
  const pages = entry.pageCount > 0 ? `~${entry.pageCount} pages` : '';
  document.getElementById('detail-file-info').textContent = [entry.fileName, `${mb} MB`, pages].filter(Boolean).join(' · ');
  modal.classList.remove('hidden');
  // Wire save button
  const saveBtn = document.getElementById('book-detail-save-btn');
  saveBtn.onclick = async () => {
    const before = { ...entry };
    entry.title = document.getElementById('detail-title').value.trim() || entry.title;
    entry.author = document.getElementById('detail-author').value.trim();
    entry.publisher = document.getElementById('detail-publisher').value.trim();
    entry.pubdate = document.getElementById('detail-pubdate').value.trim();
    entry.language = document.getElementById('detail-language').value.trim();
    entry.status = document.getElementById('detail-status').value;
    setEntryRating(entry, getDetailRating());
    entry.description = document.getElementById('detail-description').value.trim();
    entry.notes = document.getElementById('detail-notes').value.trim();
    // The fields edited here are not overwritten when the book's file
    // changes and the scan re-analyzes it (library-scan.js)
    markEditedFields(entry, before);
    const idx = lib.findIndex(e => e.id === entryId);
    if (idx >= 0) { lib[idx] = entry; await saveLibrary(lib); }
    modal.classList.add('hidden');
    await renderLibraryGrid({ keepPosition: true });
  };
  // Wire delete button
  const delBtn = document.getElementById('book-detail-delete-btn');
  delBtn.onclick = async () => {
    const confirmed = await (async () => {
      const msg = ui('detailDeleteConfirm', { title: entry.title });
      if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
        try {
          const { confirm } = await import('@tauri-apps/plugin-dialog');
          return await confirm(msg, { title: ui('detailDeleteTitle'), kind: 'warning' });
        } catch { /* fallback */ }
      }
      return window.confirm(msg);
    })();
    if (!confirmed) return;
    await removeEntry(entryId);
    modal.classList.add('hidden');
  };
}

async function openBookFromLibrary(entry) {
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  if (isTauri) {
    try {
      const { exists } = await import('@tauri-apps/plugin-fs');
      const fileExists = await exists(entry.filePath);
      if (!fileExists) {
        await showAlert(ui('errorOpening') + entry.filePath);
        return;
      }
    } catch { /* exists() not available, try anyway */ }
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const raw = await readFile(entry.filePath);
      const fileData = raw.buffer ?? raw;
      document.getElementById('library-modal').classList.add('hidden');
      // Advance status: anything except "reading"/"read" → "reading" when book is opened
      if (entry.status !== 'reading' && entry.status !== 'read') {
        const lib = await loadLibrary();
        const idx = lib.findIndex(e => e.id === entry.id);
        if (idx >= 0) { lib[idx].status = 'reading'; await saveLibrary(lib); }
      }
      // Route to the correct loader based on file type
      if (entry.fileType === 'pdf' || (entry.filePath || '').toLowerCase().endsWith('.pdf')) {
        await loadPdfFile(fileData, entry.filePath);
      } else {
        await loadEpub(fileData, entry.filePath);
      }
    } catch (err) {
      await showAlert(ui('errorOpening') + errMsg(err));
    }
  } else {
    await showAlert(ui('libBrowserOnly'));
  }
}

async function exportLibrary() {
  const lib = await loadLibrary();
  const json = JSON.stringify(lib, null, 2);
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  if (isTauri) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const filePath = await save({
        defaultPath: 'giano-library.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, json);
    } catch (err) {
      await showAlert(ui('libExportError') + errMsg(err));
    }
  } else {
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'giano-library.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      await showAlert(ui('libExportError') + errMsg(err));
    }
  }
}

async function importLibrary() {
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  const libStatus = document.getElementById('lib-status');
  let text;
  if (isTauri) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const selected = await open({ filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!selected) return;
      text = await readTextFile(selected);
    } catch (err) {
      await showAlert(ui('libImportError') + errMsg(err));
      return;
    }
  } else {
    text = await new Promise(resolve => {
      const input = document.getElementById('lib-import-input');
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) { resolve(null); return; }
        input.value = '';
        resolve(await file.text());
      };
      input.click();
    });
    if (!text) return;
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      await showAlert(ui('invalidFormat'));
      return;
    }
    const { added, skipped } = await addEntries(parsed);
    libStatus.textContent = ui('libImportedMsg', { added, skipped });
    libStatus.classList.remove('hidden');
    await renderLibraryGrid();
  } catch (err) {
    await showAlert(ui('libImportError') + errMsg(err));
  }
}

// ── Library DOM refs and listeners ────────────────────────────────────────
const libraryBtn = document.getElementById('library-btn');
const libraryModal = document.getElementById('library-modal');
const libCloseBtn = document.getElementById('lib-close-btn');
const libScanBtn = document.getElementById('lib-scan-btn');
const libImportBtn = document.getElementById('lib-import-btn');
const libExportBtn = document.getElementById('lib-export-btn');
const libStatus = document.getElementById('lib-status');
const libGrid = document.getElementById('lib-grid');
const libPlaceholder = document.getElementById('lib-placeholder');
const libSearchInput = document.getElementById('lib-search-input');
const libStatusFilter = document.getElementById('lib-status-filter');
const libRatingFilter = document.getElementById('lib-rating-filter');
const libSortSelect = document.getElementById('lib-sort');

function getLibFilters() {
  return {
    query: libSearchInput.value,
    status: libStatusFilter ? libStatusFilter.value : '',
    rating: libRatingFilter ? libRatingFilter.value : '',
    sort: normalizeLibrarySort(libSortSelect ? libSortSelect.value : ''),
  };
}

libraryBtn.addEventListener('click', async () => {
  libraryModal.classList.remove('hidden');
  libSearchInput.value = '';
  if (libStatusFilter) libStatusFilter.value = '';
  if (libRatingFilter) libRatingFilter.value = '';
  // The sort order is remembered between sessions
  if (libSortSelect) libSortSelect.value = normalizeLibrarySort(loadSettings().librarySort);
  // Re-reads the file: the ratings given by the PWA come from the web server
  _cachedLibrary = null;
  await renderLibraryGrid();
});

function closeLibraryModal() {
  libraryModal.classList.add('hidden');
  // Clears the status message (scan/import outcome) on close
  libStatus.textContent = '';
  libStatus.classList.add('hidden');
}

// Closed only with its button: a click outside the dialog (or a text selection
// released outside it) must not close the library.
libCloseBtn.addEventListener('click', closeLibraryModal);

libScanBtn.addEventListener('click', async () => {
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  if (!isTauri) {
    libStatus.textContent = ui('libBrowserOnly');
    libStatus.classList.remove('hidden');
    return;
  }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true });
    if (!selected) return;
    await scanFolder(selected);
  } catch (err) {
    libStatus.textContent = ui('libImportError') + errMsg(err);
    libStatus.classList.remove('hidden');
  }
});

libImportBtn.addEventListener('click', () => importLibrary());
libExportBtn.addEventListener('click', () => exportLibrary());

// Live search filtering
libSearchInput.addEventListener('input', () => renderLibraryGrid());
if (libStatusFilter) libStatusFilter.addEventListener('change', () => renderLibraryGrid());
if (libRatingFilter) libRatingFilter.addEventListener('change', () => renderLibraryGrid());
if (libSortSelect) {
  libSortSelect.addEventListener('change', () => {
    const settings = loadSettings();
    settings.librarySort = normalizeLibrarySort(libSortSelect.value);
    saveSettings(settings);
    renderLibraryGrid();
  });
}
// Next cards while scrolling, and when the dialog is resized
libGrid.addEventListener('scroll', fillLibraryGrid, { passive: true });
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fillLibraryGrid()).observe(libGrid);

// Book detail rating (1–5 stars): a click on the active star resets the rating
const detailRatingEl = document.getElementById('detail-rating');
function setDetailRating(value) {
  const rating = normalizeRating(value);
  detailRatingEl.dataset.value = rating ? String(rating) : '';
  detailRatingEl.querySelectorAll('.star-btn').forEach(btn => {
    const n = Number(btn.dataset.value);
    btn.classList.toggle('star-btn--on', rating !== null && n <= rating);
    btn.setAttribute('aria-checked', String(n === rating));
  });
}
function getDetailRating() {
  return normalizeRating(Number(detailRatingEl.dataset.value));
}
detailRatingEl.addEventListener('click', e => {
  const btn = e.target.closest('.star-btn');
  if (!btn) return;
  const n = Number(btn.dataset.value);
  setDetailRating(getDetailRating() === n ? null : n);
});

// Book detail modal close
const bookDetailModal = document.getElementById('book-detail-modal');
document.getElementById('book-detail-close-btn').addEventListener('click', () => bookDetailModal.classList.add('hidden'));
// No close on a click outside: it would discard the edits not saved yet

document.getElementById('lib-clear-btn').addEventListener('click', async () => {
  const lib = await loadLibrary();
  if (!lib.length) return;
  const confirmed = await (async () => {
    const msg = ui('libClearConfirm', { count: lib.length });
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
      try {
        const { confirm } = await import('@tauri-apps/plugin-dialog');
        return await confirm(msg, { title: ui('libClear'), kind: 'warning' });
      } catch { /* fallback */ }
    }
    return window.confirm(msg);
  })();
  if (!confirmed) return;
  await saveLibrary([]);
  await renderLibraryGrid();
});

// ── Clean library: verify all book file links ──────────────────────────────
const libCheckModal = document.getElementById('lib-check-modal');
const libCheckTitle = document.getElementById('lib-check-modal-title');
const libCheckCloseBtn = document.getElementById('lib-check-close-btn');
const libCheckMsg = document.getElementById('lib-check-msg');
const libCheckList = document.getElementById('lib-check-list');
const libCheckRemoveBtn = document.getElementById('lib-check-remove-btn');
const libCheckCancelBtn = document.getElementById('lib-check-cancel-btn');

let _brokenEntries = [];

function closeLibCheckModal() {
  libCheckModal.classList.add('hidden');
}
libCheckCloseBtn.addEventListener('click', closeLibCheckModal);
libCheckCancelBtn.addEventListener('click', closeLibCheckModal);
libCheckModal.addEventListener('click', e => { if (e.target === libCheckModal) closeLibCheckModal(); });

libCheckRemoveBtn.addEventListener('click', async () => {
  if (!_brokenEntries.length) return;
  const brokenIds = new Set(_brokenEntries.map(e => e.id));
  const lib = await loadLibrary();
  const cleaned = lib.filter(e => !brokenIds.has(e.id));
  await saveLibrary(cleaned);
  await renderLibraryGrid({ keepPosition: true });
  libStatus.textContent = ui('libCheckRemoved', { count: _brokenEntries.length });
  libStatus.classList.remove('hidden');
  _brokenEntries = [];
  closeLibCheckModal();
});

document.getElementById('lib-check-btn').addEventListener('click', async () => {
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  if (!isTauri) {
    libStatus.textContent = ui('libBrowserOnly');
    libStatus.classList.remove('hidden');
    return;
  }
  const lib = await loadLibrary();
  if (!lib.length) return;

  libStatus.textContent = ui('libCheckRunning');
  libStatus.classList.remove('hidden');

  const { exists } = await import('@tauri-apps/plugin-fs');
  const broken = [];
  for (const entry of lib) {
    try {
      const found = await exists(entry.filePath);
      if (!found) broken.push(entry);
    } catch {
      broken.push(entry);
    }
  }

  libStatus.textContent = '';
  libStatus.classList.add('hidden');

  if (!broken.length) {
    libStatus.textContent = ui('libCheckAllGood');
    libStatus.classList.remove('hidden');
    return;
  }

  // Show in-app modal with broken entries
  _brokenEntries = broken;
  libCheckTitle.textContent = ui('libCheck');
  libCheckMsg.textContent = ui('libCheckBroken');
  libCheckList.innerHTML = broken.map(e =>
    `<li><span class="lib-check-title">${escapeHtml(e.title || '?')}</span><span class="lib-check-path">${escapeHtml(e.filePath)}</span></li>`
  ).join('');
  document.getElementById('lib-check-confirm-msg').textContent = ui('libCheckConfirm');
  libCheckRemoveBtn.textContent = ui('libCheckRemoveAction', { count: broken.length });
  libCheckCancelBtn.textContent = ui('cancel');
  libCheckModal.classList.remove('hidden');
});

// ── Custom Context Menu Logic ──────────────────────────────────────────────
const customContextMenu = document.getElementById('custom-context-menu');
const ctxPrev = document.getElementById('ctx-prev');
const ctxNext = document.getElementById('ctx-next');
const ctxRefresh = document.getElementById('ctx-refresh');
const ctxPrint = document.getElementById('ctx-print');
const ctxFontSelect = document.getElementById('ctx-font-select');
const ctxSizeRange = document.getElementById('ctx-size-range');
const ctxSizeValue = document.getElementById('ctx-size-value');

// Show the context menu on right click (except inside inputs/textareas)
document.addEventListener('contextmenu', e => {
  const target = e.target;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('input') || target.closest('textarea')) {
    return;
  }

  e.preventDefault();

  // Sync the context menu values to current active settings just in case
  const s = loadSettings();
  if (ctxFontSelect) ctxFontSelect.value = s.fontFamily || 'Georgia, serif';
  if (ctxSizeRange) {
    ctxSizeRange.value = s.fontSize || 16;
    if (ctxSizeValue) ctxSizeValue.textContent = (s.fontSize || 16) + 'px';
  }

  // Toggle disabled state for prev/next buttons depending on pagination state
  if (ctxPrev) {
    ctxPrev.classList.toggle('disabled', prevBtn.disabled);
  }
  if (ctxNext) {
    ctxNext.classList.toggle('disabled', nextBtn.disabled);
  }

  // Show and position
  customContextMenu.classList.remove('hidden');

  let x = e.clientX;
  let y = e.clientY;
  const menuWidth = customContextMenu.offsetWidth || 250;
  const menuHeight = customContextMenu.offsetHeight || 300;
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;

  if (x + menuWidth > windowWidth) {
    x = windowWidth - menuWidth - 10;
  }
  if (y + menuHeight > windowHeight) {
    y = windowHeight - menuHeight - 10;
  }

  customContextMenu.style.left = `${x}px`;
  customContextMenu.style.top = `${y}px`;
});

// Hide context menu when clicking outside
document.addEventListener('click', e => {
  if (customContextMenu && !customContextMenu.contains(e.target)) {
    customContextMenu.classList.add('hidden');
  }
});

// Hide context menu on ESC
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && customContextMenu) {
    customContextMenu.classList.add('hidden');
  }
});

// Navigation actions
if (ctxPrev) {
  ctxPrev.addEventListener('click', () => {
    if (!prevBtn.disabled) {
      prevBtn.click();
      customContextMenu.classList.add('hidden');
    }
  });
}
if (ctxNext) {
  ctxNext.addEventListener('click', () => {
    if (!nextBtn.disabled) {
      nextBtn.click();
      customContextMenu.classList.add('hidden');
    }
  });
}
if (ctxRefresh) {
  ctxRefresh.addEventListener('click', () => {
    location.reload();
  });
}
if (ctxPrint) {
  ctxPrint.addEventListener('click', () => {
    window.print();
    customContextMenu.classList.add('hidden');
  });
}

// Font family synchronization
if (ctxFontSelect) {
  ctxFontSelect.addEventListener('change', () => {
    const s = loadSettings();
    s.fontFamily = ctxFontSelect.value;
    saveSettings(s);
    applyFont(s.fontFamily);
  });
}

// Font size synchronization (live slide and final apply)
if (ctxSizeRange) {
  ctxSizeRange.addEventListener('input', () => {
    const val = ctxSizeRange.value;
    if (ctxSizeValue) ctxSizeValue.textContent = val + 'px';
    // Live update style
    document.documentElement.style.setProperty('--font-size', val + 'px');
  });

  ctxSizeRange.addEventListener('change', () => {
    const val = parseInt(ctxSizeRange.value, 10);
    const s = loadSettings();
    s.fontSize = val;
    saveSettings(s);
    applyFontSize(val); // This updates settings modal and everything properly
  });
}

// Adds CTRL + wheel up/down shortcuts to increase/decrease the font size
document.addEventListener('wheel', e => {
  if (e.ctrlKey) {
    e.preventDefault();
    const s = loadSettings();
    let size = s.fontSize || 16;
    if (e.deltaY < 0) {
      size = Math.min(28, size + 1);
    } else if (e.deltaY > 0) {
      size = Math.max(12, size - 1);
    }
    s.fontSize = size;
    saveSettings(s);
    applyFontSize(size);
  }
}, { passive: false });

// ── Book translation: status, completion and download ─────────────────────
// Window opened by the button in the translation panel header. It shows
// how much of the book is translated (in the current language and with the current engine,
// from the translation cache), lets you complete the translation in the
// background and download the translated book as an EPUB.
const bookTranslationBtn = document.getElementById('book-translation-btn');
const bookTranslationModal = document.getElementById('book-translation-modal');
const btEls = {
  title: document.getElementById('bt-modal-title'),
  close: document.getElementById('bt-close-btn'),
  book: document.getElementById('bt-book'),
  progress: document.getElementById('bt-progress'),
  fill: document.getElementById('bt-progress-fill'),
  percent: document.getElementById('bt-percent'),
  summary: document.getElementById('bt-summary'),
  status: document.getElementById('bt-status'),
  chapters: document.getElementById('bt-chapters'),
  variants: document.getElementById('bt-variants'),
  retranslate: document.getElementById('bt-retranslate-btn'),
  clear: document.getElementById('bt-clear-btn'),
  download: document.getElementById('bt-download-btn'),
  complete: document.getElementById('bt-complete-btn'),
};

// Pause between one completion request and the next with the FREE engine,
// to avoid hitting the free endpoint's request limit
const FREE_JOB_PAUSE_MS = 400;

let bookTranslationJob = null;   // { controller, kind: 'measure'|'complete'|'download' }
let bookTranslationMessage = ''; // last status message (stays after the work has finished)

/** Object that identifies the open book: it changes when another one is opened. */
function currentBookToken() {
  return currentFileType === 'pdf' ? pdfDoc : book;
}

function bookUnitCount() {
  if (currentFileType === 'pdf') return pdfNav ? pdfNav.totalUnits : 0;
  return currentSpineItems.length;
}

function currentUnitIndex() {
  return currentFileType === 'pdf' ? (pdfNav ? pdfNav.currentIndex : 0) : currentSpineIndex;
}

/** Texts of the paragraphs to translate (standalone images are not translated). */
function paragraphTexts(paragraphs) {
  return (paragraphs || [])
    .filter(p => !(p && p.type === 'image'))
    .map(p => (p && p.text !== undefined ? p.text : p))
    .filter(t => typeof t === 'string' && t.trim());
}

function epubChapterLabel(index) {
  return getChapterLabel(index);
}

function bookUnitLabel(index) {
  if (currentFileType === 'pdf' && pdfNav) {
    if (pdfNav.mode === 'page') return ui('pdf_page_indicator', { n: index + 1, total: pdfNav.totalUnits });
    return pdfNav.chapterTitleOf(index) || ui('chapterN', { n: index + 1 });
  }
  return epubChapterLabel(index);
}

/** Texts of the paragraphs of a chapter (or PDF unit) of the open book. */
async function readUnitTexts(index) {
  if (index === currentUnitIndex() && currentChapterParagraphs.length) {
    return paragraphTexts(currentChapterParagraphs);
  }
  if (currentFileType === 'pdf') {
    const paragraphs = await extractPdfUnitText(pdfNav.pageRangeOf(index), loadSettings().uiLang || 'en');
    return paragraphTexts(paragraphs);
  }
  const body = await loadChapterDocument(currentSpineItems[index]);
  return body ? paragraphTexts(extractParagraphs(body, null)) : [];
}

/**
 * Reads all the chapters of the open book.
 * @returns {Promise<Array<{ label: string, texts: string[] }>>}
 * @throws AbortError if the work is stopped or another book is opened
 */
async function readBookChapters(signal, onProgress) {
  const token = currentBookToken();
  const total = bookUnitCount();
  const chapters = [];
  for (let i = 0; i < total; i++) {
    if (signal.aborted || currentBookToken() !== token) throw new DOMException('Aborted', 'AbortError');
    if (onProgress) onProgress(i + 1, total);
    chapters.push({ label: bookUnitLabel(i), texts: await readUnitTexts(i) });
  }
  if (currentBookToken() !== token) throw new DOMException('Aborted', 'AbortError');
  return chapters;
}

function cancelBookTranslationJob() {
  if (bookTranslationJob) {
    bookTranslationJob.controller.abort();
    bookTranslationJob = null;
  }
  bookTranslationMessage = '';
  refreshBookTranslationModal();
}

function setBookTranslationMessage(message) {
  bookTranslationMessage = message;
  refreshBookTranslationModal();
}

/** Readable name of a language, from the options of the language selector. */
function languageName(code) {
  const option = Array.from(langSelect.options).find(o => o.value === code);
  return option ? option.text.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim() : code;
}

function variantLabel(variant) {
  const { lang, engine } = parseVariant(variant);
  return `${languageName(lang)} (${engine.toUpperCase()})`;
}

async function askConfirm(message, title = 'Giano Reader') {
  if (isTauriApp()) {
    try {
      const { confirm } = await import('@tauri-apps/plugin-dialog');
      return await confirm(message, { title, kind: 'warning' });
    } catch { /* fallback to the browser dialog */ }
  }
  return window.confirm(message);
}

const formatNumber = (n) => Number(n || 0).toLocaleString(loadSettings().uiLang || undefined);

function refreshBookTranslationModal() {
  if (!bookTranslationModal || bookTranslationModal.classList.contains('hidden')) return;
  const cache = currentTranslationCache;
  const running = !!bookTranslationJob;
  const lang = langSelect.value;
  const engine = loadSettings().translationMode || 'free';
  const variant = variantKey(lang, engine);

  btEls.title.textContent = ui('bookTranslation');
  btEls.retranslate.textContent = ui('btRetranslateChapter');
  btEls.clear.textContent = ui('btClear');
  btEls.download.textContent = ui('btDownload');
  btEls.complete.textContent = running && bookTranslationJob.kind === 'complete' ? ui('btStop') : ui('btComplete');

  if (!cache || !currentBookToken()) {
    btEls.book.textContent = ui('btNoBook');
    btEls.summary.textContent = '';
    btEls.status.textContent = '';
    btEls.chapters.innerHTML = '';
    btEls.variants.textContent = '';
    btEls.fill.style.width = '0%';
    btEls.percent.textContent = '';
    [btEls.retranslate, btEls.clear, btEls.download, btEls.complete].forEach(b => { b.disabled = true; });
    return;
  }

  btEls.book.textContent = `${bookTitle.textContent || ''} · ${variantLabel(variant)}`;
  const stats = cache.stats(variant, currentBookFileSize);
  if (stats) {
    btEls.fill.style.width = `${stats.percent}%`;
    btEls.percent.textContent = `${stats.percent}%`;
    btEls.progress.setAttribute('aria-valuenow', String(stats.percent));
    btEls.summary.textContent = ui('btSummary', {
      translated: formatNumber(stats.translatedParagraphs),
      total: formatNumber(stats.paragraphs),
      complete: formatNumber(stats.completeChapters),
      chapters: formatNumber(stats.chapters.length),
    }) + (stats.missingChars ? ' · ' + ui('btMissingChars', { chars: formatNumber(stats.missingChars) }) : '');

    const current = currentUnitIndex();
    btEls.chapters.innerHTML = stats.chapters.map((ch, i) => `
      <li class="bt-chapter${ch.translated === ch.paragraphs ? ' done' : ''}${i === current ? ' current' : ''}" data-index="${i}" title="${escapeHtml(ch.label)}">
        <span class="bt-chapter-label">${escapeHtml(ch.label || ui('chapterN', { n: i + 1 }))}</span>
        <span class="bt-chapter-bar"><span style="width:${ch.percent}%"></span></span>
        <span class="bt-chapter-count">${formatNumber(ch.translated)}/${formatNumber(ch.paragraphs)}</span>
      </li>`).join('');
  } else {
    btEls.fill.style.width = '0%';
    btEls.percent.textContent = '';
    btEls.progress.setAttribute('aria-valuenow', '0');
    btEls.summary.textContent = ui('btMeasuring');
    btEls.chapters.innerHTML = '';
  }
  btEls.status.textContent = bookTranslationMessage;

  const others = cache.variants(currentBookFileSize).filter(v => v.variant !== variant);
  btEls.variants.textContent = others.length
    ? ui('btOtherVariants', {
      list: others.map(v => `${variantLabel(v.variant)} ${v.percent != null ? v.percent + '%' : formatNumber(v.cached)}`).join(', '),
    })
    : '';

  const hasTranslations = stats
    ? stats.translatedParagraphs > 0
    : cache.variants().some(v => v.variant === variant);
  btEls.retranslate.disabled = running || !currentChapterParagraphs.length;
  btEls.clear.disabled = running || !hasTranslations;
  btEls.download.disabled = running || !hasTranslations;
  btEls.complete.disabled = running && bookTranslationJob.kind !== 'complete';
}

async function openBookTranslationModal() {
  if (!bookTranslationModal) return;
  bookTranslationModal.classList.remove('hidden');
  refreshBookTranslationModal();
  // Book structure not yet known (e.g. PDF): measure it now
  if (currentTranslationCache && !currentTranslationCache.getStructure(currentBookFileSize) && !bookTranslationJob) {
    await measureBookStructure();
  }
}

function closeBookTranslationModal() {
  if (bookTranslationModal) bookTranslationModal.classList.add('hidden');
}

/** Reads the whole book to record its structure in the cache. */
async function measureBookStructure() {
  const cache = currentTranslationCache;
  if (!cache || bookTranslationJob) return;
  // When an EPUB is opened the chapter reading is already in progress: wait for it
  if (chapterLengthsPromise) {
    setBookTranslationMessage(ui('btMeasuring'));
    try { await chapterLengthsPromise; } catch { /* ignored */ }
    if (cache.getStructure(currentBookFileSize)) { setBookTranslationMessage(''); return; }
  }
  if (bookTranslationJob || cache !== currentTranslationCache) return;
  const controller = new AbortController();
  bookTranslationJob = { controller, kind: 'measure' };
  try {
    const chapters = await readBookChapters(controller.signal, (n, total) => setBookTranslationMessage(ui('btReading', { n, total })));
    cache.setStructure(chapters, currentBookFileSize);
    scheduleTranslationCacheSave(cache);
    bookTranslationMessage = '';
  } catch (err) {
    bookTranslationMessage = err && err.name === 'AbortError' ? '' : ui('btFailed', { error: errMsg(err) });
  } finally {
    if (bookTranslationJob && bookTranslationJob.controller === controller) bookTranslationJob = null;
    refreshBookTranslationModal();
  }
}

/**
 * Translates all the paragraphs of the book not yet in the cache, in the
 * current language and with the current engine. Runs in the background: you can keep
 * reading, and the work stops with "Stop" or by opening another book.
 */
async function completeBookTranslation() {
  const cache = currentTranslationCache;
  if (!cache || bookTranslationJob) return;
  const controller = new AbortController();
  const signal = controller.signal;
  bookTranslationJob = { controller, kind: 'complete' };
  refreshBookTranslationModal();
  if (chapterLengthsPromise) { try { await chapterLengthsPromise; } catch { /* ignored */ } }

  const token = currentBookToken();
  const lang = langSelect.value;
  const engine = loadSettings().translationMode || 'free';
  const variant = variantKey(lang, engine);

  try {
    // 1. Text of all the chapters (also updates the book's structure)
    const chapters = await readBookChapters(signal, (n, total) => setBookTranslationMessage(ui('btReading', { n, total })));
    cache.setStructure(chapters, currentBookFileSize);
    scheduleTranslationCacheSave(cache);

    // 2. Paragraphs still to be translated (each text only once)
    const seen = new Set();
    const pending = chapters.map(ch => ch.texts.filter(text => {
      if (cache.has(variant, text) || seen.has(text)) return false;
      seen.add(text);
      return true;
    }));
    const totalChars = pending.flat().reduce((sum, t) => sum + t.length, 0);
    if (!totalChars) {
      setBookTranslationMessage(ui('btAlreadyComplete'));
      return;
    }

    // 3. With a paid engine, confirmation is requested showing the amount of text
    if (engine !== 'free') {
      const ok = await askConfirm(ui('btConfirmPaid', { chars: formatNumber(totalChars), engine: engine.toUpperCase() }), ui('bookTranslation'));
      if (!ok) { setBookTranslationMessage(''); return; }
    }

    // 4. Translation in groups of paragraphs of the same chapter
    let doneChars = 0;
    for (let c = 0; c < pending.length; c++) {
      for (let start = 0; start < pending[c].length; start += LAZY_CHUNK) {
        if (signal.aborted || currentBookToken() !== token) throw new DOMException('Aborted', 'AbortError');
        const group = pending[c].slice(start, start + LAZY_CHUNK);
        setBookTranslationMessage(ui('btTranslating', {
          n: c + 1, total: pending.length, percent: Math.floor((doneChars / totalChars) * 100),
        }));
        await translateWithCache(group, lang, signal, { cache });
        doneChars += group.reduce((sum, t) => sum + t.length, 0);
        if (engine === 'free') await abortableDelay(FREE_JOB_PAUSE_MS, signal);
      }
    }
    setBookTranslationMessage(ui('btDone'));
    // The chapter on screen is now entirely in the cache: redraw it translated
    if (currentBookToken() === token) retranslateCurrentChapter();
  } catch (err) {
    setBookTranslationMessage(err && err.name === 'AbortError' ? ui('btStopped') : ui('btFailed', { error: errMsg(err) }));
  } finally {
    if (bookTranslationJob && bookTranslationJob.controller === controller) bookTranslationJob = null;
    await flushTranslationCaches();
    refreshBookTranslationModal();
  }
}

/** Saves a file chosen by the user (dialog in Tauri, download in the browser). */
async function saveBytesAs(bytes, fileName, filterName, extension) {
  if (isTauriApp()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: fileName, filters: [{ name: filterName, extensions: [extension] }] });
    if (!path) return null;
    await writeFile(path, bytes);
    return path.split(/[\\/]/).pop();
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/epub+zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return fileName;
}

/**
 * Downloads the translated book (EPUB). The paragraphs without a translation in the cache
 * stay in the original language: if the book is not fully translated,
 * asks for confirmation.
 */
async function downloadTranslatedBook() {
  const cache = currentTranslationCache;
  if (!cache || bookTranslationJob) return;
  const lang = langSelect.value;
  const variant = translationVariant(lang);
  const stats = cache.stats(variant, currentBookFileSize);
  if (stats && stats.percent < 100) {
    const ok = await askConfirm(ui('btDownloadPartial', { percent: stats.percent }), ui('bookTranslation'));
    if (!ok) return;
  }

  const controller = new AbortController();
  bookTranslationJob = { controller, kind: 'download' };
  const lookup = (text) => cache.get(variant, text);
  const fileName = translatedFileName(currentFilePath || bookTitle.textContent || 'book', lang);
  try {
    let bytes;
    let replaced = 0;
    if (currentFileType === 'pdf') {
      // PDF: a new EPUB with the translated text of each chapter or page
      const doc = pdfDoc;
      const chapters = await readBookChapters(controller.signal, (n, total) => setBookTranslationMessage(ui('btReading', { n, total })));
      const translated = chapters.map(ch => ({
        title: ch.label,
        paragraphs: ch.texts.map(t => {
          const tr = lookup(t);
          if (tr !== undefined) replaced++;
          return tr !== undefined ? tr : t;
        }),
      }));
      setBookTranslationMessage(ui('btBuilding'));
      bytes = await buildEpubFromChapters(JSZip, {
        title: doc.title || bookTitle.textContent || fileName,
        author: doc.author || '',
        lang,
        chapters: translated,
      });
    } else {
      // EPUB: copy of the original with the paragraph text translated
      if (!book || !book.archive || !book.archive.zip) throw new Error('EPUB archive not available');
      setBookTranslationMessage(ui('btBuilding'));
      const source = await book.archive.zip.generateAsync({ type: 'uint8array' });
      const result = await buildTranslatedEpub(JSZip, source, {
        chapterPaths: currentSpineItems.map(item => item.url || item.href),
        extractText: (el) => extractTextWithInlineImages(el, null).text,
        lookup,
        lang,
        onProgress: (n, total) => setBookTranslationMessage(ui('btBuildingChapter', { n, total })),
      });
      bytes = result.bytes;
      replaced = result.replaced;
    }
    const saved = await saveBytesAs(bytes, fileName, 'EPUB', 'epub');
    setBookTranslationMessage(saved ? ui('btDownloaded', { name: saved, replaced: formatNumber(replaced) }) : '');
  } catch (err) {
    setBookTranslationMessage(err && err.name === 'AbortError' ? '' : ui('btFailed', { error: errMsg(err) }));
  } finally {
    if (bookTranslationJob && bookTranslationJob.controller === controller) bookTranslationJob = null;
    refreshBookTranslationModal();
  }
}

/** Deletes this book's saved translations for the current language and engine. */
async function clearBookTranslations() {
  const cache = currentTranslationCache;
  if (!cache || bookTranslationJob) return;
  const variant = translationVariant(langSelect.value);
  const { lang, engine } = parseVariant(variant);
  const ok = await askConfirm(ui('btClearConfirm', { lang: languageName(lang), engine: engine.toUpperCase() }), ui('bookTranslation'));
  if (!ok) return;
  cache.clearVariant(variant);
  scheduleTranslationCacheSave(cache);
  await flushTranslationCaches();
  setBookTranslationMessage(ui('btCleared'));
}

/** Re-translates the chapter on screen ignoring the saved translations. */
function retranslateChapterNow() {
  if (!currentChapterParagraphs.length || bookTranslationJob) return;
  const pct = currentReadingScrollPct();
  translateCurrentChapter(pct, { force: true });
  if (pct > 0) restoreScrollPct(pct);
  setBookTranslationMessage(ui('btRetranslating'));
}

if (bookTranslationBtn) bookTranslationBtn.addEventListener('click', openBookTranslationModal);
if (btEls.close) btEls.close.addEventListener('click', closeBookTranslationModal);
if (bookTranslationModal) {
  bookTranslationModal.addEventListener('click', e => { if (e.target === bookTranslationModal) closeBookTranslationModal(); });
}
if (btEls.complete) {
  btEls.complete.addEventListener('click', () => {
    if (bookTranslationJob && bookTranslationJob.kind === 'complete') cancelBookTranslationJob();
    else completeBookTranslation();
  });
}
if (btEls.download) btEls.download.addEventListener('click', downloadTranslatedBook);
if (btEls.clear) btEls.clear.addEventListener('click', clearBookTranslations);
if (btEls.retranslate) btEls.retranslate.addEventListener('click', retranslateChapterNow);
if (btEls.chapters) {
  btEls.chapters.addEventListener('click', e => {
    const row = e.target.closest('.bt-chapter');
    if (!row) return;
    closeBookTranslationModal();
    const index = Number(row.dataset.index);
    if (currentFileType === 'pdf') {
      if (pdfNav && pdfNav.goTo(index)) displayPdfUnit();
    } else {
      displayChapter(index);
    }
  });
}
// Language or engine changed: the statistics refer to another variant
langSelect.addEventListener('change', refreshBookTranslationModal);
if (translationModeSelect) translationModeSelect.addEventListener('change', refreshBookTranslationModal);
// Saving of translations still pending when the app closes
window.addEventListener('beforeunload', () => { flushTranslationCaches(); });

// Reading position of the open book when the app closes. 'beforeunload' cannot
// wait for asynchronous writes: in Tauri the window closes only after the
// saves (at most CLOSE_SAVE_TIMEOUT_MS, so closing never hangs).
const CLOSE_SAVE_TIMEOUT_MS = 2000;
window.addEventListener('beforeunload', () => { rememberReadingPosition(); flushReadingPositions(); });
if (isTauriApp()) {
  (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().onCloseRequested(async () => {
        try {
          rememberReadingPosition();
          await Promise.race([
            Promise.allSettled([flushReadingPositions(), flushTranslationCaches()]),
            new Promise(resolve => setTimeout(resolve, CLOSE_SAVE_TIMEOUT_MS)),
          ]);
        } catch (err) {
          console.warn('[close] save error:', err);
        }
      });
    } catch (err) {
      console.warn('[close] cannot listen to the close request:', err);
    }
  })();
}

/**
 * "Translation" row of a library book's card: saved variants
 * and translated percentage, read from the book's cache file.
 */
async function renderDetailTranslation(entry) {
  const el = document.getElementById('detail-translation');
  if (!el) return;
  el.textContent = '';
  try {
    const isCurrent = currentTranslationCache && currentFilePath && samePath(entry.filePath, currentFilePath);
    const cache = isCurrent ? currentTranslationCache : await loadBookTranslationCache(entry.filePath, entry.title);
    const variants = cache.variants(isCurrent ? currentBookFileSize : entry.fileSize);
    el.textContent = variants.length
      ? ui('detailTranslation', {
        list: variants.map(v => `${variantLabel(v.variant)}${v.percent != null ? ' ' + v.percent + '%' : ''}`).join(', '),
      })
      : ui('detailTranslationNone');
  } catch (e) {
    console.warn('[translation-cache] detail not available:', e);
  }
}
