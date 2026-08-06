import ePub from 'epubjs';
import { translateParagraphs } from './translator.js';
import { t, RTL_LANGS } from './i18n.js';
import { clampSearchDepth } from './settings-utils.js';
import { loadPdf, checkFileSize, validateTextContent, PdfNavigator, extractChapterText, extractPageText, renderPdfCanvas, renderPdfWithOverlayPlaceholders } from './pdf.js';
import { clearSegmentationCache } from './pdf-xycut-segmenter.js';
import ttsController, { isProModeAvailable, makeDownloadFilename } from './tts.js';

// ── Stato applicazione ─────────────────────────────────────────────────────
let book = null;                    // istanza epubjs corrente
let currentSpineItems = [];         // lista capitoli spine EPUB
let currentSpineIndex = 0;          // indice capitolo corrente
let currentChapterParagraphs = [];  // paragrafi del capitolo corrente
let syncingScroll = false;          // lock per evitare loop nello scroll sincronizzato
let translationAbortController = null;
let lazyObserver = null;            // IntersectionObserver per traduzione lazy
let currentFilePath = null;         // path assoluto del file aperto (solo Tauri)
let currentViewMode = 'text';       // 'text' | 'original'
let currentFileType = null;         // 'epub' | 'pdf'
let pdfDoc = null;                  // PdfDocument instance (null when EPUB)
let pdfNav = null;                  // PdfNavigator instance (null when EPUB)
let pdfBufferCopy = null;           // Copy of PDF ArrayBuffer for hash computation
let currentPdfHash = '';            // Stable hash for the current PDF (used for segmentation cache)

const LAZY_CHUNK = 12; // paragrafi per chunk di traduzione lazy
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
// Segnalibri
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
// View toggle — commuta tra Text_Mode e Original_Mode
const viewToggleBtn = document.getElementById('view-toggle-btn');
const syncDisabledNotice = document.getElementById('sync-disabled-notice');
const originalNative = document.getElementById('original-native');
// Hide translation toggle — nasconde/mostra il pannello di traduzione
const hideTranslationBtn = document.getElementById('hide-translation-btn');
const translationPanel = document.getElementById('translation-panel');
const divider = document.getElementById('divider');
const swapPanelsBtn = document.getElementById('swap-panels-btn');
const hideOriginalBtn = document.getElementById('hide-original-btn');
const originalPanel = document.getElementById('original-panel');

const readerHeader = document.getElementById('reader-header');
const readerHeaderLeft = document.getElementById('reader-header-left');
const readerHeaderCenter = document.getElementById('reader-header-center');
const readerHeaderRight = document.getElementById('reader-header-right');


const togglePairingBtn = document.getElementById('toggle-pairing-btn');
const toggleNumbersBtn = document.getElementById('toggle-numbers-btn');
const viewerWrapper = document.getElementById('viewer-wrapper');
const toggleTranslationModeBtn = document.getElementById('toggle-translation-mode-btn');
const openrouterKeyInput = document.getElementById('openrouter-key-input');
const openrouterModelSelect = document.getElementById('openrouter-model-select');

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
let panelsSwapped = false;
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
    }
  } else {
    if (translationAbortController) {
      translationAbortController.abort();
      translationAbortController = null;
    }
    setTranslationStatus('');
    translationViewer.innerHTML = '';
  }
});

swapPanelsBtn.addEventListener('click', () => {
  panelsSwapped = !panelsSwapped;
  
  swapPanelsBtn.setAttribute('aria-pressed', String(panelsSwapped));
  swapPanelsBtn.classList.toggle('active', panelsSwapped);

  // Rearrange the original & translation panels with the divider in the middle
  // Also reassign the textContent of the language labels to match
  if (panelsSwapped) {    
    viewerWrapper.appendChild(translationPanel);
    viewerWrapper.appendChild(divider);
    viewerWrapper.appendChild(originalPanel);
    
    document.getElementById('original-header-label').textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();
    translationLangLabel.textContent = t(lang, 'original');
  
  } else {
    viewerWrapper.appendChild(originalPanel);
    viewerWrapper.appendChild(divider);
    viewerWrapper.appendChild(translationPanel);

    document.getElementById('original-header-label').textContent = t(lang, 'original');
    translationLangLabel.textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();
  }

  // These two panels always come last
  viewerWrapper.appendChild(loadingOverlay);
  viewerWrapper.appendChild(noBookPlaceholder);
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

// Hover sincronizzato bidirezionale tra i pannelli
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
  pt: 'pt', ru: 'ru', zh: 'cn', ja: 'jp', ar: 'sa',
  fil: 'ph', sq: 'al', hi: 'in', ko: 'kr', th: 'th',
  bn: 'in', id: 'id', sv: 'se', uk: 'ua', sl: 'si',
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

  // Sync esterno: quando selectEl.value cambia programmaticamente
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
const SETTINGS_KEY = 'giano-reader-settings';
const THEMES = ['dark', 'light', 'monokai', 'solarized-dark', 'nord', 'sepia'];

// ── IndexedDB Fallback per Browser ──────────────────────────────────────────
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

// Helper per storage persistente (Filesystem in Tauri, IndexedDB/localStorage in Browser)
const PersistentStorage = {
  async get(key, defaultValue = []) {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
      try {
        const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
        const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
        const dir = await appLocalDataDir();
        const path = await join(dir, `${key}.json`);
        if (await exists(path)) {
          const content = await readTextFile(path);
          return JSON.parse(content);
        }
      } catch (e) { console.warn(`[Storage] error loading ${key} from FS:`, e); }
    }
    // Fallback a IndexedDB con migrazione da localStorage se presente
    try {
      const dbVal = await IndexedDBStorage.get(key, null);
      if (dbVal !== null) return dbVal;

      const lsVal = localStorage.getItem(key);
      if (lsVal) {
        const parsed = JSON.parse(lsVal);
        await IndexedDBStorage.set(key, parsed);
        localStorage.removeItem(key); // pulisce localStorage
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
        const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
        const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
        const dir = await appLocalDataDir();
        if (!(await exists(dir))) await mkdir(dir, { recursive: true });
        const path = await join(dir, `${key}.json`);
        await writeTextFile(path, JSON.stringify(value, null, 2));
        // Pulisce anche IndexedDB e localStorage se salvato con successo su file
        try {
          localStorage.removeItem(key);
          const db = await IndexedDBStorage.getDB();
          const transaction = db.transaction(IndexedDBStorage.storeName, 'readwrite');
          transaction.objectStore(IndexedDBStorage.storeName).delete(key);
        } catch { }
        return;
      } catch (e) { console.error(`[Storage] error saving ${key} to FS:`, e); }
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
    renderNativeView();
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
  if (panelsSwapped) {
    translationLangLabel.textContent = t(lang, 'original');
  } else {
    document.getElementById('original-header-label').textContent = t(lang, 'original');
  }
  
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
  if (toggleTranslationModeBtn) {
    toggleTranslationModeBtn.title = t(lang, 'toggleTranslationMode');
    toggleTranslationModeBtn.setAttribute('aria-label', t(lang, 'toggleTranslationMode'));
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
  if (swapPanelsBtn) {
    swapPanelsBtn.title = t(lang, 'swapPanels');
    swapPanelsBtn.setAttribute('aria-label', t(lang, 'swapPanels'));
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
  document.getElementById('settings-version').textContent = t(lang, 'version', { version: '0.8.4' });
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
}

function updateTranslationModeVisibility() {
  if (!toggleTranslationModeBtn) return;
  const s = loadSettings();
  const apiKey = (s.openrouterApiKey || '').trim();
  const isValid = apiKey.startsWith('sk-or-') && apiKey.length > 6;

  toggleTranslationModeBtn.classList.toggle('hidden', !isValid);

  // Se la chiave è invalida e siamo in modalità PRO, torna a FREE!
  if (!isValid && s.translationMode === 'pro') {
    s.translationMode = 'free';
    saveSettings(s);

    const isPro = false;
    toggleTranslationModeBtn.setAttribute('aria-pressed', String(isPro));
    toggleTranslationModeBtn.classList.remove('active');
    toggleTranslationModeBtn.textContent = 'FREE';

    // Riavvia la traduzione in modalità FREE
    if (currentChapterParagraphs && currentChapterParagraphs.length) {
      const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
      const scrollPct = scrollMax > 1 ? Math.round((originalViewer.scrollTop / scrollMax) * 100) : 0;
      translateCurrentChapter(scrollPct);
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
  const map = {
    it: 'it-IT', en: 'en-US', fr: 'fr-FR', de: 'de-DE',
    es: 'es-ES', pt: 'pt-PT', ru: 'ru-RU', zh: 'zh-CN',
    ja: 'ja-JP', ar: 'ar-SA', fil: 'fil-PH', sq: 'sq-AL',
    hi: 'hi-IN', ko: 'ko-KR', th: 'th-TH', bn: 'bn-BD',
    id: 'id-ID'
  };
  return map[langCode] || null;
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
    ttsPlayBtn.title = 'Pause';
    ttsPlayBtn.setAttribute('aria-label', 'Pause');
  } else {
    // Show play icon (idle or paused)
    ttsPlayBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>';
    ttsPlayBtn.title = 'Play';
    ttsPlayBtn.setAttribute('aria-label', 'Play');
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
            const guideUrl = 'https://github.com/DrLoki/GianoReader/blob/main/INSTALL_TTS_VOICES.md';
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

  const translationMode = s.translationMode || 'free';
  if (toggleTranslationModeBtn) {
    const isPro = translationMode === 'pro';
    toggleTranslationModeBtn.setAttribute('aria-pressed', String(isPro));
    toggleTranslationModeBtn.classList.toggle('active', isPro);
    toggleTranslationModeBtn.textContent = isPro ? 'PRO' : 'FREE';
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

  updateTranslationModeVisibility();

  // Sostituisce i select lingua con dropdown custom (bandiere emoji)
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
    updateTranslationModeVisibility();
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
  });
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
      updateTranslationModeVisibility();

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

if (toggleTranslationModeBtn) {
  toggleTranslationModeBtn.addEventListener('click', () => {
    const s = loadSettings();
    const currentMode = s.translationMode || 'free';
    const nextMode = currentMode === 'free' ? 'pro' : 'free';
    const lang = s.uiLang || 'en';

    if (nextMode === 'pro') {
      if (!s.openrouterApiKey || !s.openrouterModel) {
        showAlert(t(lang, 'openrouterInvalidKey') + ' & ' + t(lang, 'openrouterSelectModel').toLowerCase());
        settingsModal.classList.remove('hidden');
        return;
      }
    }

    s.translationMode = nextMode;
    saveSettings(s);

    const isPro = nextMode === 'pro';
    toggleTranslationModeBtn.setAttribute('aria-pressed', String(isPro));
    toggleTranslationModeBtn.classList.toggle('active', isPro);
    toggleTranslationModeBtn.textContent = isPro ? 'PRO' : 'FREE';

    // Trigger re-translation
    if (currentChapterParagraphs && currentChapterParagraphs.length) {
      const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
      const scrollPct = scrollMax > 1 ? Math.round((originalViewer.scrollTop / scrollMax) * 100) : 0;
      translateCurrentChapter(scrollPct);
    }
  });
}

settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
settingsCloseBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// ── RAM Advisor ────────────────────────────────────────────────────────────
/**
 * Calcola il limite ottimale dalla RAM totale.
 * @param {number} totalRamMb - RAM totale in MB
 * @returns {number} - valore in MB, max 500
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

// ── Utilità UI ─────────────────────────────────────────────────────────────
function showLoading(msg) {
  loadingText.textContent = msg || ui('loading');
  loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}
function hideNoBookPlaceholder() {
  noBookPlaceholder.classList.add('hidden');
}
function setTranslationStatus(msg) {
  translationStatus.textContent = msg;
}

// Mostra un alert compatibile con Tauri (usa dialog nativo) e browser (alert)
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

// Estrae un messaggio leggibile da qualsiasi tipo di errore (string, Error, oggetto Tauri)
function errMsg(err) {
  if (!err) return ui('unknownError');
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ── Progress bar ───────────────────────────────────────────────────────────
function updateProgress() {
  // PDF navigation
  if (currentFileType === 'pdf' && pdfNav) {
    const total = pdfNav.totalUnits;
    const pct = total <= 1 ? 0 : (pdfNav.currentIndex / (total - 1)) * 100;
    progressFill.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
    pageInfo.textContent = pdfNav.currentLabel;
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
  // pct: 0% al primo capitolo, 100% all'ultimo
  const pct = total === 1 ? 0 : (currentSpineIndex / (total - 1)) * 100;
  progressFill.style.width = `${pct}%`;
  progressThumb.style.left = `${pct}%`;
  pageInfo.textContent = `Ch. ${currentSpineIndex + 1} / ${total}`;
  prevBtn.disabled = currentSpineIndex <= 0;
  nextBtn.disabled = currentSpineIndex >= total - 1;
}

// Click sulla barra → naviga al capitolo corrispondente
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
  displayChapter(Math.round(ratio * (currentSpineItems.length - 1)));
});

// Costruisce le tacche sulla progress bar dopo il caricamento del libro
function buildProgressTicks(spineItems, tocItems) {
  progressTicks.innerHTML = '';
  const total = spineItems.length;
  if (total < 2) return;

  // Mappa href → label dal TOC per mostrare il titolo del capitolo nel tooltip
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
    const pct = total === 1 ? 0 : (i / (total - 1)) * 100;
    const tick = document.createElement('div');
    tick.className = 'progress-tick';
    tick.style.left = `${pct}%`;
    tick.dataset.idx = i;

    const href = item.href?.split('#')[0] || '';
    const label = labelMap[href]
      || labelMap[item.href]
      || href.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      || `Ch. ${i + 1}`;
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

// Evidenzia la tacca del capitolo corrente
function updateActiveTick() {
  progressTicks.querySelectorAll('.progress-tick').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.idx) === currentSpineIndex);
  });
}

// Tooltip sull'hover generico sulla barra
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
  const idx = Math.round(ratio * (currentSpineItems.length - 1));
  const tick = progressTicks.querySelector(`[data-idx="${idx}"]`);
  if (tick) showTooltip(tick, tick.dataset.label, parseFloat(tick.style.left));
});
progressTrack.addEventListener('mouseleave', hideTooltip);

// ── Utilità testo ──────────────────────────────────────────────────────────
function paragraphsToHtml(paragraphs) {
  return paragraphs.filter(p => (p.text || p).trim()).map(p => {
    const html = p.html !== undefined ? p.html : escapeHtml(p);
    return `<p>${html}</p>`;
  }).join('');
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Serializza il contenuto inline di un elemento preservando link e formattazione base,
// ma rimuovendo attributi pericolosi. Usato per il pannello originale in modalità testo.
function safeInnerHtml(el) {
  const clone = el.cloneNode(true);
  // Rimuovi script e stili inline
  clone.querySelectorAll('script, style').forEach(n => n.remove());
  // Normalizza i link: mantieni solo href, gestisci il click via JS
  clone.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    // Rimuovi tutti gli attributi tranne href
    Array.from(a.attributes).forEach(attr => {
      if (attr.name !== 'href') a.removeAttribute(attr.name);
    });
    a.setAttribute('data-epub-href', href);
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
  });
  // Rimuovi attributi di stile/evento da tutti gli altri elementi
  clone.querySelectorAll('*').forEach(n => {
    ['onclick', 'onmouseover', 'onerror', 'onload'].forEach(ev => n.removeAttribute(ev));
  });
  return clone.innerHTML;
}

// Estrae paragrafi da un nodo DOM (body di un capitolo EPUB)
// Restituisce oggetti { text, html, id } — text per la traduzione, html per il rendering, id per la navigazione
function extractParagraphs(body) {
  const selectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'];
  const blocks = body.querySelectorAll?.(selectors.join(', '));
  if (blocks && blocks.length > 0) {
    const r = [];
    const seenIds = new Set();
    blocks.forEach(el => {
      const text = (el.textContent || '').trim();
      if (!text) return;
      // Prefer the element's own ID; fall back to the nearest ancestor with an ID
      let id = el.id || null;
      if (!id) {
        let parent = el.parentElement;
        while (parent && parent !== body) {
          if (parent.id) { id = parent.id; break; }
          parent = parent.parentElement;
        }
      }
      // Avoid assigning the same ancestor ID to multiple paragraphs
      if (id && seenIds.has(id)) id = null;
      if (id) seenIds.add(id);
      r.push({ text, html: safeInnerHtml(el), id });
    });
    if (r.length) return r;
  }
  // Fallback: split per newline (funziona anche su XMLDocument)
  return (body.textContent || '').split('\n')
    .map(l => l.trim()).filter(l => l.length > 2)
    .map(text => ({ text, html: escapeHtml(text), id: null }));
}

// ── Scroll sincronizzato tra i due pannelli ────────────────────────────────
let activeScrollSource = null;
let syncTimeout = null;

function bindSyncScroll() {
  const handleScroll = (source, target) => {
    if (syncingScroll) return;
    if (activeScrollSource && activeScrollSource !== source) return;

    if (!activeScrollSource) {
      activeScrollSource = source;
    }

    syncingScroll = true;

    const r = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
    target.scrollTop = r * (target.scrollHeight - target.clientHeight);

    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      syncingScroll = false;
      activeScrollSource = null;
    }, 50); // 50ms per smaltire l'inerzia e gli eventi asincroni del browser
  };

  // In PDF Original View mode, sync between originalNative (canvas panel) and translationViewer
  if (currentViewMode === 'original' && currentFileType === 'pdf') {
    originalViewer.onscroll = null;
    originalNative.onscroll = () => handleScroll(originalNative, translationViewer);
    translationViewer.onscroll = () => handleScroll(translationViewer, originalNative);
  } else {
    originalNative.onscroll = null;
    originalViewer.onscroll = () => handleScroll(originalViewer, translationViewer);
    translationViewer.onscroll = () => handleScroll(translationViewer, originalViewer);
  }
}

// ── View mode ──────────────────────────────────────────────────────────────
function setViewMode(mode, { skipRender = false } = {}) {
  currentViewMode = mode;
  const isOriginal = mode === 'original';

  // Mostra/nasconde i contenitori
  originalViewer.classList.toggle('hidden', isOriginal);
  originalNative.classList.toggle('hidden', !isOriginal);

  // Stato visivo del toggle
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
      disableFontControls(false);
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

  // Avviso nel pannello di traduzione (hide for PDF since translation works in both modes)
  syncDisabledNotice.classList.toggle('hidden', !isOriginal || currentFileType === 'pdf');
}

// ── Font controls disable/enable (PDF canvas mode) ────────────────────────
function disableFontControls(disabled) {
  const fontRow = fontFamilySelect ? fontFamilySelect.closest('.settings-row') : null;
  const sizeRow = fontSizeRange ? fontSizeRange.closest('.settings-row-inline') : null;
  const ctxFontSelect = document.getElementById('ctx-font-select');
  const ctxSizeRange = document.getElementById('ctx-size-range');
  const ctxFontGroup = ctxFontSelect ? ctxFontSelect.closest('.context-menu-group') : null;
  const ctxSizeGroup = ctxSizeRange ? ctxSizeRange.closest('.context-menu-group') : null;

  const elements = [fontRow, sizeRow, ctxFontGroup, ctxSizeGroup].filter(Boolean);

  if (disabled) {
    const tooltip = ui('pdf_canvas_tooltip');
    elements.forEach(el => {
      el.classList.add('controls-disabled');
      el.title = tooltip;
    });
    if (fontFamilySelect) fontFamilySelect.disabled = true;
    if (fontSizeRange) fontSizeRange.disabled = true;
    if (ctxFontSelect) ctxFontSelect.disabled = true;
    if (ctxSizeRange) ctxSizeRange.disabled = true;
  } else {
    elements.forEach(el => {
      el.classList.remove('controls-disabled');
      el.title = '';
    });
    if (fontFamilySelect) fontFamilySelect.disabled = false;
    if (fontSizeRange) fontSizeRange.disabled = false;
    if (ctxFontSelect) ctxFontSelect.disabled = false;
    if (ctxSizeRange) ctxSizeRange.disabled = false;
  }
}

// ── Native view rendering ──────────────────────────────────────────────────
async function renderNativeView() {
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

      await renderPdfCanvas(pdfDoc.proxy, pageNumbers, originalNative);
      disableFontControls(true);
    } catch (err) {
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
      const frame = document.createElement('iframe');
      frame.id = 'epub-native-frame';
      frame.className = 'native-frame';
      const bg = getComputedStyle(document.body).backgroundColor || '#1a1a1a';
      const fg = getComputedStyle(document.body).color || '#e0e0e0';
      const font = getComputedStyle(document.documentElement).getPropertyValue('--reader-font-family') || 'Georgia, serif';
      const size = getComputedStyle(document.documentElement).getPropertyValue('--font-size') || '16px';
      const themeStyle = `<style>html,body{background:${bg}!important;color:${fg}!important;font-family:${font}!important;font-size:${size}!important;line-height:1.8;padding:1rem;margin:0;max-width:100%;overflow-x:hidden;}img,table,svg{max-width:100%!important;height:auto;}pre{white-space:pre-wrap;overflow-wrap:break-word;}a{color:inherit;}</style>`;
      // Script iniettato nell'iframe: intercetta tutti i click sui link e li
      // comunica al parent tramite postMessage invece di navigare l'iframe.
      const interceptScript = `<script>
        document.addEventListener('click', function(e) {
          var a = e.target.closest('a');
          if (!a) return;
          e.preventDefault();
          var href = a.getAttribute('href') || '';
          window.parent.postMessage({ type: 'epub-link', href: href }, '*');
        });
      <\/script>`;
      frame.srcdoc = themeStyle + interceptScript + html;
      originalNative.appendChild(frame);
    } catch (err) {
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

// ── Gestione link cliccati nell'iframe (modalità originale) ───────────────
window.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'epub-link') return;
  const href = e.data.href || '';
  if (!href || href.startsWith('http://') || href.startsWith('https://')) return;

  // Separa file e ancora: "chapter02.xhtml#note-1" → file="chapter02.xhtml", anchor="note-1"
  const [filePart, anchor] = href.split('#');

  if (filePart) {
    // Link a un altro capitolo (con o senza ancora)
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
    // Link a un'ancora nello stesso capitolo
    scrollToAnchor(anchor);
  }
});

// Scrolla all'elemento con id/name corrispondente all'ancora nell'iframe corrente
function scrollToAnchor(anchor) {
  const frame = document.getElementById('epub-native-frame');
  if (!frame || !frame.contentDocument) return;
  const target = frame.contentDocument.getElementById(anchor)
    || frame.contentDocument.querySelector(`[name="${anchor}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Scrolla all'elemento con id corrispondente nel pannello testo originale
function scrollToTocAnchor(anchor) {
  if (!anchor) return;
  // Look for the element in the text panel first
  const target = originalViewer.querySelector(`[id="${anchor}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // If in native/original view mode, try the iframe
  if (currentViewMode === 'original') {
    scrollToAnchor(anchor);
  }
}

// ── Render pannelli testo ──────────────────────────────────────────────────
function renderOriginal(paragraphs) {
  originalViewer.innerHTML = '';
  if (paragraphs.length) {
    paragraphs.forEach((p, i) => {
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

  // Gestione click sui link interni EPUB nel pannello testo
  originalViewer.querySelectorAll('a[data-epub-href]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const href = a.getAttribute('data-epub-href') || '';
      if (!href || href.startsWith('http://') || href.startsWith('https://')) return;
      const [filePart, anchor] = href.split('#');
      if (filePart) {
        const idx = currentSpineItems.findIndex(i =>
          i.href === filePart || i.href?.endsWith(filePart) || filePart?.endsWith(i.href)
        );
        if (idx >= 0) {
          displayChapter(idx).then(() => {
            if (anchor) {
              const target = originalViewer.querySelector(`[id="${anchor}"], [name="${anchor}"]`);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
        }
      } else if (anchor) {
        const target = originalViewer.querySelector(`[id="${anchor}"], [name="${anchor}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}
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
async function translatePdfOverlay(startPct = 0) {
  translationAbortController = new AbortController();
  const signal = translationAbortController.signal;

  const lang = langSelect.value;
  const rawLabel = langSelect.options[langSelect.selectedIndex].text;

  if (panelsSwapped) {
    document.getElementById('original-header-label').textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();
  } else {
    translationLangLabel.textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();  
  }

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
      pdfDoc.proxy, pageNumbers, translationViewer, currentPdfHash
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
        const translated = await translateParagraphs(slice, lang, signal);
        if (signal.aborted) return;
        for (let i = 0; i < translated.length; i++) {
          const block = allBlocks[start + i];
          block.el.textContent = translated[i] || slice[i];
          block.el.classList.remove('pending');
          block.el.classList.add('translated');
          // Auto-shrink font if text overflows the box
          shrinkFontToFit(block.el);
        }
        if (translatedChunks.size >= totalChunks) setTranslationStatus('');
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

    // Lazy translate chunks below
    let nextDownChunk = startChunk + 1;
    function observeNextOverlaySentinel() {
      if (nextDownChunk >= totalChunks) return;
      const sentinelIdx = Math.min(nextDownChunk * LAZY_CHUNK - 1, total - 1);
      const sentinel = allBlocks[sentinelIdx]?.el;
      if (!sentinel) return;

      lazyObserver = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          lazyObserver.unobserve(entry.target);
          await translateOverlayChunk(nextDownChunk++);
          if (signal.aborted) return;
          observeNextOverlaySentinel();
        }
      }, { root: translationViewer, threshold: 0.1 });
      lazyObserver.observe(sentinel);
    }
    observeNextOverlaySentinel();

  } catch (err) {
    if (signal.aborted) return;
    console.error('[translate-overlay] rendering error:', err);
    renderTranslationPlaceholder(ui('errorChapter') + errMsg(err));
  }
}

  const lang = langSelect.value;
  const rawLabel = langSelect.options[langSelect.selectedIndex].text;
  
  if (panelsSwapped) {
    document.getElementById('original-header-label').textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();
  } else {
    translationLangLabel.textContent = rawLabel.replace(/^[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*/, '').trim();  
  }
  
// ── Traduzione lazy ────────────────────────────────────────────────────────
// startPct: percentuale di scroll da cui partire (0-100). Traduce prima il chunk
// visibile a quella posizione, poi espande lazy verso il basso e verso l'alto.
async function translateCurrentChapter(startPct = 0) {
  ttsTranslateChunk = null; // Reset on re-entry / chapter change
  translatedChunksRef = null;
  if (translationAbortController) translationAbortController.abort();
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }

  if (translationHidden) {
    setTranslationStatus('');
    translationViewer.innerHTML = '';
    return;
  }

  // PDF overlay mode: render canvas + translated text overlay (only in original view mode)
  if (currentFileType === 'pdf' && pdfDoc && pdfNav && currentViewMode === 'original') {
    await translatePdfOverlay(startPct);
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

  // Crea subito tutti i <p> con il testo originale come placeholder visivo
  const pEls = paragraphs.map((para, i) => {
    const text = para.text !== undefined ? para.text : para;
    const p = document.createElement('p');
    p.dataset.idx = i;
    p.classList.add('pending', `pair-color-${i % 5}`);
    p.innerHTML = `<span class="para-num">${i + 1}</span>${escapeHtml(text)}`;
    translationViewer.appendChild(p);
    return p;
  });

  setTranslationStatus('');
  bindSyncScroll();

  // Chunk di partenza basato sulla percentuale di scroll
  const startChunk = Math.min(
    Math.floor((startPct / 100) * totalChunks),
    totalChunks - 1
  );

  // Traduce un chunk specifico per indice
  const translatedChunks = new Set();
  translatedChunksRef = translatedChunks;
  async function translateChunk(chunkIdx) {
    if (signal.aborted || translatedChunks.has(chunkIdx) || chunkIdx < 0 || chunkIdx >= totalChunks) return;
    translatedChunks.add(chunkIdx);
    const start = chunkIdx * LAZY_CHUNK;
    const end = Math.min(start + LAZY_CHUNK, total);
    const slice = paragraphs.slice(start, end).map(p => p.text !== undefined ? p.text : p);
    setTranslationStatus(`${Math.round((translatedChunks.size / totalChunks) * 100)}%`);
    try {
      const translated = await translateParagraphs(slice, lang, signal);
      if (signal.aborted) return;
      for (let i = 0; i < translated.length; i++) {
        pEls[start + i].innerHTML = `<span class="para-num">${start + i + 1}</span>${escapeHtml(translated[i] || slice[i])}`;
        pEls[start + i].setAttribute('data-translated', 'true');
        pEls[start + i].classList.remove('pending');
      }
      if (translatedChunks.size >= totalChunks) setTranslationStatus('');
    } catch (err) {
      if (signal.aborted) return;
      console.error('[translate] chunk error', chunkIdx, err);
      // Fallback: mostra il testo originale per i paragrafi del chunk fallito
      for (let i = start; i < end; i++) {
        const fallback = paragraphs[i].text !== undefined ? paragraphs[i].text : paragraphs[i];
        pEls[i].innerHTML = `<span class="para-num">${i + 1}</span>${escapeHtml(fallback)}`;
        pEls[i].classList.remove('pending');
      }
    }
  }

  // Expose translateChunk for TTS on-demand translation
  ttsTranslateChunk = translateChunk;

  // Traduce il chunk visibile per primo, poi quelli precedenti (verso l'alto), poi lazy verso il basso
  await translateChunk(startChunk);
  if (signal.aborted) return;

  // Traduce i chunk precedenti in background (verso l'alto), senza bloccare
  for (let i = startChunk - 1; i >= 0; i--) {
    translateChunk(i); // fire-and-forget
  }

  // Lazy verso il basso: osserva l'ultimo paragrafo del chunk corrente
  let nextDownChunk = startChunk + 1;

  function observeNextSentinel() {
    if (nextDownChunk >= totalChunks) return;
    const lastParagraphOfCurrent = pEls[Math.min(nextDownChunk * LAZY_CHUNK - 1, total - 1)];
    if (!lastParagraphOfCurrent) return;
    lazyObserver = new IntersectionObserver(async (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazyObserver.unobserve(entry.target);
        await translateChunk(nextDownChunk++);
        if (signal.aborted) return;
        observeNextSentinel();
      }
    }, { root: translationViewer, threshold: 0.1 });
    lazyObserver.observe(lastParagraphOfCurrent);
  }

  observeNextSentinel();
}

// ── Size Guard ─────────────────────────────────────────────────────────────
/**
 * Classifica la dimensione di un file rispetto ai limiti configurati.
 * @param {number} fileSizeBytes  - dimensione del file in byte
 * @param {number} maxFileSizeMB  - limite bloccante in MB
 * @param {number} warnFileSizeMB - soglia di avviso in MB
 * @returns {'ok' | 'warn' | 'block'}
 */
function sizeGuard(fileSizeBytes, maxFileSizeMB, warnFileSizeMB) {
  const MB = 1_048_576;
  if (fileSizeBytes > maxFileSizeMB * MB) return 'block';
  if (fileSizeBytes > warnFileSizeMB * MB) return 'warn';
  return 'ok';
}

// ── Apertura file ──────────────────────────────────────────────────────────
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

// Fallback per browser: input file nascosto
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

// ── Carica EPUB ────────────────────────────────────────────────────────────
/**
 * Verifica se un errore è di tipo OOM (Out Of Memory).
 * @param {*} err
 * @returns {boolean}
 */
function isOomError(err) {
  const msg = errMsg(err).toLowerCase();
  return msg.includes('out of memory') || msg.includes('allocation failed') || msg.includes('memory');
}

async function loadEpub(arrayBuffer, filePath = '') {
  // Stop TTS and disable controls before loading new book
  ttsController.stop();
  enableTTSControls(false);

  // Distruggi il libro precedente
  if (book) {
    try { book.destroy(); } catch (_) { }
    book = null;
    currentSpineItems = [];
    currentChapterParagraphs = [];
    currentFilePath = null;
  }
  // Clear PDF state when loading EPUB
  currentFileType = 'epub';
  pdfDoc = null;
  pdfNav = null;

  showLoading(ui('loadingEpub'));
  hideNoBookPlaceholder();
  currentFilePath = filePath || null;
  try {

    // Nota: evitiamo intenzionalmente `book.ready` — può bloccarsi indefinitamente
    // su certi EPUB (es. generati da Calibre) per un problema interno di JSZip.
    // `book.loaded.metadata` si risolve non appena il manifest è parsato, che è
    // tutto ciò di cui abbiamo bisogno prima di procedere.
    book = ePub(arrayBuffer);

    const meta = await Promise.race([
      book.loaded.metadata,
      new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout after 20s')), 20000)),
    ]);
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

    try { const url = await book.coverUrl(); if (url) coverImg.src = url; } catch (_) { }

    // Auto-aggiunta alla libreria quando si apre un libro (solo in Tauri con path assoluto)
    if (filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath))) {
      autoAddToLibrary(arrayBuffer, filePath, meta);
    }

    await Promise.race([
      book.loaded.spine,
      new Promise((_, rej) => setTimeout(() => rej(new Error('spine timeout after 10s')), 10000)),
    ]);
    currentSpineItems = [];
    book.spine.each(item => currentSpineItems.push(item));
    currentSpineIndex = 0;

    const nav = await Promise.race([
      book.loaded.navigation,
      new Promise((_, rej) => setTimeout(() => rej(new Error('navigation timeout after 10s')), 10000)),
    ]);
    renderToc(nav.toc);

    updateProgress();
    buildProgressTicks(currentSpineItems, nav.toc);
    addBookmarkBtn.disabled = false;
    enableTTSControls(true);
    populateTTSVoices();

    // Trova il primo capitolo con contenuto reale (salta copertina/frontmatter).
    // Prima passa: cerca "chapter/capitolo" nel nome file.
    let bestIndex = -1;
    for (let i = 0; i < currentSpineItems.length; i++) {
      if (/chapter|capitolo|chap/i.test(currentSpineItems[i].href)) {
        bestIndex = i; break;
      }
    }
    // Seconda passa: primo spine item con più di 500 caratteri di testo.
    if (bestIndex < 0) {
      for (let i = 0; i < currentSpineItems.length; i++) {
        const body = await loadChapterDocument(currentSpineItems[i]);
        if ((body?.textContent?.trim() || '').length > 500) { bestIndex = i; break; }
      }
    }
    setViewMode('text');
    viewToggleBtn.disabled = false;
    await displayChapter(bestIndex >= 0 ? bestIndex : 0);
  } catch (err) {
    if (book) {
      try { book.destroy(); } catch (_) { }
      book = null;
      currentSpineItems = [];
      currentChapterParagraphs = [];
      currentFilePath = null;
    }
    await showAlert(isOomError(err) ? ui('oomErrorMsg', { name: filePath }) : ui('errorOpening') + errMsg(err));
  } finally {
    hideLoading();
  }
}

// ── Carica PDF ─────────────────────────────────────────────────────────────

// ── PDF Navigation UI ──────────────────────────────────────────────────────

/**
 * Updates the UI after navigating to a new PDF unit (chapter or page).
 * Updates progress bar, page indicator, active tick, and renders content.
 */
function displayPdfUnit() {
  if (!pdfNav) return;
  updateProgress();
  updatePdfActiveTick();
  updatePdfTocActive();
  // Render content for the new unit (handles both text and original modes)
  displayChapter(pdfNav.currentIndex);
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
      label = `Pag. ${unitIndex + 1}`;
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
async function loadPdfFile(arrayBuffer, filePath = '') {
  // Stop TTS and disable controls before loading new book
  ttsController.stop();
  enableTTSControls(false);

  // Destroy previous book if any
  if (book) {
    try { book.destroy(); } catch (_) { }
    book = null;
    currentSpineItems = [];
    currentChapterParagraphs = [];
  }
  // Clear previous PDF state
  pdfDoc = null;
  pdfNav = null;
  // Clear segmentation cache for new document
  clearSegmentationCache();
  currentPdfHash = '';
  currentFilePath = filePath || null;

  showLoading(ui('readingFile'));
  hideNoBookPlaceholder();

  try {
    const s = loadSettings();
    const maxMB = typeof s.maxFileSizeMB === 'number' ? s.maxFileSizeMB : DEFAULT_MAX_FILE_SIZE_MB;

    // File size check
    if (!checkFileSize(arrayBuffer.byteLength, maxMB)) {
      hideLoading();
      await showAlert(ui('pdf_error_too_large', { size: (arrayBuffer.byteLength / 1024 / 1024).toFixed(1), max: maxMB }));
      return;
    }

    // Copy the buffer before loadPdf consumes it (pdf.js transfers the ArrayBuffer to its worker)
    pdfBufferCopy = arrayBuffer.slice(0);

    // Load PDF
    let doc;
    try {
      const filename = (filePath || '').split(/[\\/]/).pop() || '';
      doc = await loadPdf(arrayBuffer, filename);
    } catch (err) {
      hideLoading();
      const msg = (err && err.message && err.message.includes('magic bytes'))
        ? ui('pdf_error_invalid')
        : ui('pdf_error_open');
      await showAlert(msg);
      return;
    }

    // Validate text content
    const validation = await validateTextContent(doc.proxy);
    if (validation === 'blocked') {
      hideLoading();
      await showAlert(ui('pdf_blocked_dialog'));
      return;
    }

    // Create navigator
    const nav = await PdfNavigator.create(doc.proxy, doc.outline);

    // Success — set state
    pdfDoc = doc;
    pdfNav = nav;
    currentFileType = 'pdf';
    currentFilePath = filePath || null;

    // Compute pdfHash from filename + file size (stable, cheap)
    const pdfFilename = (filePath || '').split(/[\\/]/).pop() || '';
    currentPdfHash = `${pdfFilename}:${pdfBufferCopy.byteLength}`;

    // Display title in sidebar
    bookTitle.textContent = doc.title || ui('unknownTitle');
    bookAuthor.textContent = doc.author || '';
    bookInfo.classList.remove('hidden');
    tocPlaceholder.style.display = 'none';
    coverImg.src = '';

    // Auto-add to library (Tauri with absolute path)
    if (filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath))) {
      autoAddToLibrary(arrayBuffer, filePath, { title: doc.title, creator: doc.author });
    }

    addBookmarkBtn.disabled = false;
    enableTTSControls(true);
    populateTTSVoices();
    setViewMode('text'); // Normal view mode — old pipeline handles rendering
    viewToggleBtn.disabled = false;

    // Initialize PDF progress bar and navigation UI
    renderPdfTicks();
    renderPdfToc();
    displayPdfUnit();

    hideLoading();
  } catch (err) {
    pdfDoc = null;
    pdfNav = null;
    currentFileType = null;
    hideLoading();
    await showAlert(ui('pdf_error_open') + ' ' + errMsg(err));
  }
}

// ── Naviga a un capitolo (parsing diretto, senza iframe) ───────────────────
async function displayChapter(index, scrollPct = 0) {
  // Stop TTS on chapter navigation
  ttsController.stop();

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
      const paragraphs = await extractChapterText(pdfDoc.proxy, pageRange, lang);

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
    if (currentSpineIndex !== myIndex) return;
    if (!body) throw new Error('documento capitolo null');

    currentChapterParagraphs = extractParagraphs(body);
    if (currentSpineIndex !== myIndex) return;
    updateProgress();
    updateActiveTick();
    if (currentViewMode === 'original') {
      await renderNativeView();
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

// Carica il documento HTML di un capitolo spine tramite le API di epubjs
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
      return result; // fallback: usa il nodo radice
    }
  } catch (e) {
    console.error('[nav] loadChapterDocument error:', e);
  }
  return null;
}

// ── Indice (TOC) ───────────────────────────────────────────────────────────
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

    const handleTranslateTooltip = async () => {
      const currentLang = langSelect.value;
      const originalText = a.textContent.trim();

      if (a.dataset.translatedLang === currentLang && a.dataset.translatedTitle) {
        a.title = a.dataset.translatedTitle;
        return;
      }

      if (a.dataset.translating === 'true') return;
      a.dataset.translating = 'true';
      a.title = t(currentLang, 'loading') || '...';

      try {
        const translated = await translateParagraphs([originalText], currentLang);
        if (translated && translated[0]) {
          a.dataset.translatedTitle = translated[0];
          a.dataset.translatedLang = currentLang;
          a.title = translated[0];
        }
      } catch (err) {
        console.error('Error translating chapter title:', err);
        a.title = originalText;
      } finally {
        a.dataset.translating = 'false';
      }
    };
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

// ── Navigazione capitoli ───────────────────────────────────────────────────
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

// Cambio lingua → salva la scelta e ritraduce il capitolo corrente
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
  if (currentChapterParagraphs.length) translateCurrentChapter();
});

// ── Navigazione da tastiera ────────────────────────────────────────────────
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

// ── Segnalibri ─────────────────────────────────────────────────────────────
const BOOKMARKS_KEY = 'giano-reader-bookmarks';
let _cachedBookmarks = null;

async function loadBookmarks() {
  if (_cachedBookmarks) return _cachedBookmarks;
  _cachedBookmarks = await PersistentStorage.get(BOOKMARKS_KEY, []);
  return _cachedBookmarks;
}
async function saveBookmarks(bms) {
  _cachedBookmarks = bms;
  await PersistentStorage.set(BOOKMARKS_KEY, bms);
}

// Restituisce la label del capitolo corrente dalla progress bar
function getChapterLabel(index) {
  const tick = progressTicks.querySelector(`[data-idx="${index}"]`);
  return tick?.dataset.label || `Chapter ${index + 1}`;
}

// Aggiunge un segnalibro per il capitolo corrente
addBookmarkBtn.addEventListener('click', async () => {
  if (!currentFilePath) return;
  const bms = await loadBookmarks();
  const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
  const scrollPct = scrollMax > 1 ? Math.round((originalViewer.scrollTop / scrollMax) * 100) : 0;

  let bm;
  if (currentFileType === 'pdf') {
    bm = {
      id: Date.now(),
      filePath: currentFilePath || '',
      fileName: (currentFilePath || '').split(/[\\/]/).pop() || '',
      bookTitle: (pdfDoc && pdfDoc.title) || bookTitle.textContent || '',
      chapterIndex: pdfNav ? pdfNav.currentIndex : 0,
      chapterLabel: pdfNav ? pdfNav.currentLabel : '',
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
  showAlert(ui('bookmarkAdded'));
});

// Renderizza la lista segnalibri nella modale
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
    li.innerHTML = `
      <span class="bm-icon"><img src="/icons/book-bookmark.svg" class="icon" alt="" /></span>
      <span class="bm-info">
        <span class="bm-title" title="${escapeHtml(bm.bookTitle || bm.fileName)}">${escapeHtml(bm.bookTitle || bm.fileName)}</span>
        <span class="bm-chapter">${escapeHtml(bm.chapterLabel)}${bm.scrollPct != null ? ` · ${bm.scrollPct}%` : ''}</span>
      </span>
      <button class="bm-delete" title="Delete bookmark" data-id="${bm.id}"><img src="/icons/xmark.svg" class="icon" alt="" /></button>
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

// Apri/chiudi modale segnalibri
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

// Esporta segnalibri come JSON
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

// Importa segnalibri da JSON (aggiunge a quelli esistenti, evita duplicati per id)
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

// Mostra la modal di rilocazione e restituisce il nuovo path scelto, o null se annullato
async function askRelocate(bm) {
  bmMissingName.textContent = bm.fileName;
  document.getElementById('bm-modal-msg').innerHTML =
    t(loadSettings().uiLang || 'en', 'fileNotFoundMsg', { name: `<strong>${escapeHtml(bm.fileName)}</strong>` });
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

// Aggiorna il path di un segnalibro e ricarica la lista
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

// Apre un segnalibro: verifica il file, gestisce rilocazione se necessario
async function openBookmark(bm) {
  const isTauri = !!(window.__TAURI__ || window.__TAURI_INTERNALS__);

  // Segnalibri senza path assoluto (es. creati in modalità browser o versioni precedenti)
  // non possono essere aperti automaticamente: chiedi rilocazione se siamo in Tauri
  const hasAbsolutePath = bm.filePath && (
    bm.filePath.startsWith('/') ||          // Unix
    /^[A-Za-z]:[\\\/]/.test(bm.filePath)   // Windows
  );

  if (!hasAbsolutePath) {
    if (isTauri) {
      // Path not absolute: ask user to locate the file
      const newPath = await askRelocate(bm);
      if (!newPath) return;
      await updateBookmarkPath(bm, newPath);
    } else {
      await showAlert(`Please open the file "${bm.fileName}" manually and navigate to: ${bm.chapterLabel}`);
      return;
    }
  }

  if (!isTauri) {
    await showAlert(`Please open the file "${bm.fileName}" manually and navigate to: ${bm.chapterLabel}`);
    return;
  }

  // Verifica esistenza file prima di tentare la lettura
  let fileExists = false;
  try {
    const { exists } = await import('@tauri-apps/plugin-fs');
    fileExists = await exists(bm.filePath);
  } catch {
    // exists() non disponibile: tenta apertura diretta e gestisci l'errore lì
    fileExists = true;
  }

  if (!fileExists) {
    const newPath = await askRelocate(bm);
    if (!newPath) return;
    await updateBookmarkPath(bm, newPath);
  }

  await loadBookmarkFile(bm);
}

// Ripristina la posizione di scroll salvata nel segnalibro
function restoreScrollPct(pct) {
  if (pct == null) return;
  // Doppio rAF: assicura che il layout sia calcolato dopo il rendering dei paragrafi
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const max = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
    originalViewer.scrollTop = Math.round((pct / 100) * max);
    const transMax = Math.max(1, translationViewer.scrollHeight - translationViewer.clientHeight);
    translationViewer.scrollTop = Math.round((pct / 100) * transMax);
  }));
}

// Legge il file dal disco e lo carica nel reader, poi naviga al capitolo salvato
async function loadBookmarkFile(bm) {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const raw = await readFile(bm.filePath);
    const fileData = raw.buffer ?? raw;
    const ext = bm.filePath.split('.').pop().toLowerCase();

    if (ext === 'epub') {
      const previousViewMode = currentViewMode;
      await loadEpub(fileData, bm.filePath);
      if (previousViewMode === 'original') {
        setViewMode('original', { skipRender: true });
      }
      if (bm.chapterIndex > 0 && bm.chapterIndex < currentSpineItems.length) {
        await displayChapter(bm.chapterIndex, bm.scrollPct ?? 0);
      } else if (bm.scrollPct > 0) {
        restoreScrollPct(bm.scrollPct);
      }
    } else if (ext === 'pdf' || bm.fileType === 'pdf') {
      await loadPdfFile(fileData, bm.filePath);
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

// Inizializza la lista segnalibri all'avvio
(async function initBookmarks() {
  await renderBookmarks();
})();

// ── Persistenza geometria finestra (solo Tauri) ────────────────────────────
const WINDOW_STATE_KEY = 'giano-reader-window-state';

async function saveWindowState() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const isMaximized = await win.isMaximized();
    const state = { maximized: isMaximized };
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

    // Verifica se le coordinate sono valide (non negative o eccessive) per evitare finestre "perse"
    const isValidPos = state.x !== undefined && state.y !== undefined && state.x >= -10000 && state.y >= -10000;

    if (state.maximized) {
      await win.maximize();
    } else if (state.physical) {
      if (state.width && state.height) await win.setSize(new PhysicalSize(state.width, state.height));
      if (isValidPos) await win.setPosition(new PhysicalPosition(state.x, state.y));
    } else {
      if (state.width && state.height) await win.setSize(new LogicalSize(state.width, state.height));
      if (isValidPos) await win.setPosition(new LogicalPosition(state.x, state.y));
    }
  } catch (err) {
    console.warn('[window-state] restore error:', err);
  }
}

if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
  // Ripristina geometria appena possibile
  restoreWindowState();

  // Salva geometria prima della chiusura
  window.addEventListener('beforeunload', saveWindowState);

  // Salva anche periodicamente (ogni 5s) per catturare ridimensionamenti/spostamenti
  setInterval(saveWindowState, 5000);
}

// Distruggi il libro alla chiusura della finestra per liberare memoria
window.addEventListener('beforeunload', () => {
  if (book) { try { book.destroy(); } catch (_) { } }
});

// ── Library ────────────────────────────────────────────────────────────────
const LIBRARY_KEY = 'giano-reader-library';
let _cachedLibrary = null;

async function loadLibrary() {
  if (_cachedLibrary) return _cachedLibrary;
  _cachedLibrary = await PersistentStorage.get(LIBRARY_KEY, []);
  return _cachedLibrary;
}
async function saveLibrary(entries) {
  _cachedLibrary = entries;
  await PersistentStorage.set(LIBRARY_KEY, entries);
}

async function addEntries(newEntries) {
  const lib = await loadLibrary();
  const existingPaths = new Set(lib.map(e => e.filePath));
  let added = 0, skipped = 0;
  for (const entry of newEntries) {
    if (existingPaths.has(entry.filePath)) {
      skipped++;
    } else {
      lib.push(entry);
      existingPaths.add(entry.filePath);
      added++;
    }
  }
  await saveLibrary(lib);
  return { added, skipped };
}

async function removeEntry(id) {
  const lib = await loadLibrary();
  await saveLibrary(lib.filter(e => e.id !== id));
  await renderLibraryGrid();
}

async function readDirRecursive(dirPath, maxDepth = 3) {
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const results = [];
  async function walk(path, currentDepth) {
    let entries;
    try { entries = await readDir(path); } catch { return; }
    for (const entry of entries) {
      const entryPath = entry.path || (path + '/' + entry.name);
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
  await walk(dirPath, 1); // la cartella radice è il livello 1
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
        return { id, filePath, fileName, title: doc.title || titleFallback, author: doc.author || '', publisher: '', language: '', pubdate: '', description: '', fileSize, pageCount: doc.pageCount || 0, coverDataUrl: null, fileType: 'pdf', status: 'to-read', notes: '', addedAt };
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

    // Passiamo l'ArrayBuffer direttamente — come fa loadEpub().
    // Usare un blob URL causa fetch interni via XHR che si bloccano in Tauri WebView.
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

      // Stima il numero di pagine dal totale dei caratteri nello spine.
      // Stima editoriale standard: ~1800 caratteri per pagina.
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
      } catch { /* stima pagine non disponibile */ }

      // Ottieni la copertina come data URL (scalata a max 200px) per localStorage
      let coverDataUrl = null;
      try {
        const coverBlobUrl = await Promise.race([
          epubBook.coverUrl(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cover timeout')), 5000)),
        ]);

        if (coverBlobUrl) {
          // Converti in data URL via canvas PRIMA di distruggere il libro
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

      // Distruggi DOPO la conversione della copertina
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
async function autoAddToLibrary(arrayBuffer, filePath, meta) {
  try {
    const lib = await loadLibrary();
    if (lib.some(e => e.filePath === filePath)) return; // already in library
    const fileName = filePath.split(/[\\/]/).pop();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const addedAt = Date.now();
    const fileSize = arrayBuffer.byteLength || 0;

    // ── PDF branch ──────────────────────────────────────────────────────
    if (currentFileType === 'pdf') {
      const title = meta.title || fileName.replace(/\.pdf$/i, '');
      const author = meta.creator || '';
      await addEntries([{ id, filePath, fileName, title, author, publisher: '', language: '', pubdate: '', description: '', fileSize, pageCount: 0, coverDataUrl: null, fileType: 'pdf', status: 'to-read', notes: '', addedAt }]);
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
    // Extract cover in background and update the entry
    try {
      const tmpBook = ePub(arrayBuffer);
      await Promise.race([tmpBook.ready, new Promise((_, r) => setTimeout(() => r(new Error('t')), 8000))]);
      const coverBlobUrl = await Promise.race([tmpBook.coverUrl(), new Promise((_, r) => setTimeout(() => r(new Error('t')), 5000))]);
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
          const idx = current.findIndex(e => e.filePath === filePath);
          if (idx >= 0) { current[idx].coverDataUrl = coverDataUrl; await saveLibrary(current); }
        }
      }
      tmpBook.destroy();
    } catch { /* cover extraction failed, entry already saved without cover */ }
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
    const newEntries = [];
    for (const filePath of epubPaths) {
      libStatus.textContent = ui('libScanning') + ' ' + (newEntries.length + 1) + '/' + epubPaths.length;
      const entry = await extractMetadata(filePath);
      newEntries.push(entry);
    }
    const { added, skipped } = await addEntries(newEntries);
    libStatus.textContent = ui('libScanDone', { added, skipped });
    await renderLibraryGrid();
  } catch (err) {
    libStatus.textContent = ui('libImportError') + errMsg(err);
  } finally {
    scanInProgress = false;
    if (scanBtn) scanBtn.disabled = false;
  }
}

const ITEMS_PER_PAGE = 60;
let _renderedCount = ITEMS_PER_PAGE;

async function renderLibraryGrid(query = '', statusFilter = '', appendMore = false) {
  const lib = await loadLibrary();
  const q = query.trim().toLowerCase();
  let filtered = q
    ? lib.filter(e => (e.title || '').toLowerCase().includes(q) || (e.author || '').toLowerCase().includes(q))
    : lib;
  if (statusFilter) {
    filtered = filtered.filter(e => e.status === statusFilter);
  }
  const grid = document.getElementById('lib-grid');
  const placeholder = document.getElementById('lib-placeholder');
  if (!grid || !placeholder) return;
  // Aggiorna il titolo del modale con il conteggio
  const titleEl = document.getElementById('library-modal-title');
  if (titleEl) titleEl.textContent = ui('libraryTitle', { count: lib.length });

  if (!appendMore) {
    grid.innerHTML = '';
    _renderedCount = ITEMS_PER_PAGE;
  }

  // Remove existing Load More button if any
  const existingLoadMore = document.getElementById('lib-load-more-btn');
  if (existingLoadMore) existingLoadMore.remove();

  if (!filtered.length && !appendMore) {
    placeholder.classList.remove('hidden');
    placeholder.textContent = q ? ui('libNoResults', { query }) : ui('libEmpty');
    grid.classList.add('hidden');
    return;
  }
  placeholder.classList.add('hidden');
  grid.classList.remove('hidden');

  const startIdx = appendMore ? _renderedCount : 0;
  const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, filtered.length);
  const chunk = filtered.slice(startIdx, endIdx);

  for (const entry of chunk) {
    const card = document.createElement('div');
    card.className = 'lib-book-card';
    card.dataset.id = entry.id;
    const img = document.createElement('img');
    img.className = 'lib-book-cover';
    img.alt = entry.title || ui('libCoverPlaceholder');
    img.loading = 'lazy'; // Native lazy loading
    if (entry.coverDataUrl) {
      img.src = entry.coverDataUrl;
    } else {
      img.src = '';
      img.style.background = '#2a2a2a';
      if (entry.fileType === 'pdf') {
        img.style.display = 'none';
        const placeholder = document.createElement('div');
        placeholder.className = 'lib-book-cover lib-pdf-placeholder';
        placeholder.textContent = 'PDF';
        card.appendChild(placeholder);
      }
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
    card.appendChild(img);
    card.appendChild(info);
    card.addEventListener('click', () => openBookFromLibrary(entry));
    grid.appendChild(card);
  }

  _renderedCount = endIdx;

  if (endIdx < filtered.length) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'lib-load-more-btn';
    loadMoreBtn.className = 'lib-load-more-btn';
    loadMoreBtn.textContent = ui('loadMore');
    loadMoreBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await renderLibraryGrid(query, statusFilter, true);
    });
    grid.after(loadMoreBtn);
  }
}

// Open book detail modal for editing metadata
async function openBookDetail(entryId) {
  const lib = await loadLibrary();
  const entry = lib.find(e => e.id === entryId);
  if (!entry) return;
  const modal = document.getElementById('book-detail-modal');
  // Localize all labels
  document.getElementById('book-detail-title').textContent = entry.title || ui('bookDetail');
  document.querySelector('label[for="detail-title"]').textContent = ui('detailTitle');
  document.querySelector('label[for="detail-author"]').textContent = ui('detailAuthor');
  document.querySelector('label[for="detail-publisher"]').textContent = ui('detailPublisher');
  document.querySelector('label[for="detail-pubdate"]').textContent = ui('detailYear');
  document.querySelector('label[for="detail-language"]').textContent = ui('detailLanguage');
  document.querySelector('label[for="detail-status"]').textContent = ui('detailStatus');
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
  document.getElementById('detail-description').value = entry.description ? entry.description.replace(/<[^>]+>/g, '') : '';
  document.getElementById('detail-notes').value = entry.notes || '';
  const mb = entry.fileSize ? (entry.fileSize / (1024 * 1024)).toFixed(2) : '?';
  const pages = entry.pageCount > 0 ? `~${entry.pageCount} pages` : '';
  document.getElementById('detail-file-info').textContent = [entry.fileName, `${mb} MB`, pages].filter(Boolean).join(' · ');
  modal.classList.remove('hidden');
  // Wire save button
  const saveBtn = document.getElementById('book-detail-save-btn');
  saveBtn.onclick = async () => {
    entry.title = document.getElementById('detail-title').value.trim() || entry.title;
    entry.author = document.getElementById('detail-author').value.trim();
    entry.publisher = document.getElementById('detail-publisher').value.trim();
    entry.pubdate = document.getElementById('detail-pubdate').value.trim();
    entry.language = document.getElementById('detail-language').value.trim();
    entry.status = document.getElementById('detail-status').value;
    entry.notes = document.getElementById('detail-notes').value.trim();
    const idx = lib.findIndex(e => e.id === entryId);
    if (idx >= 0) { lib[idx] = entry; await saveLibrary(lib); }
    modal.classList.add('hidden');
    const { query, status } = getLibFilters();
    await renderLibraryGrid(query, status);
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

function getLibFilters() {
  return {
    query: libSearchInput.value,
    status: libStatusFilter ? libStatusFilter.value : '',
  };
}

libraryBtn.addEventListener('click', async () => {
  libraryModal.classList.remove('hidden');
  libSearchInput.value = '';
  if (libStatusFilter) libStatusFilter.value = '';
  await renderLibraryGrid();
});

function closeLibraryModal() {
  libraryModal.classList.add('hidden');
  // Pulisce il messaggio di stato (esito scansione/import) alla chiusura
  libStatus.textContent = '';
  libStatus.classList.add('hidden');
}

libCloseBtn.addEventListener('click', closeLibraryModal);
libraryModal.addEventListener('click', e => {
  if (e.target === libraryModal) closeLibraryModal();
});

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
libSearchInput.addEventListener('input', async () => {
  const { query, status } = getLibFilters();
  await renderLibraryGrid(query, status);
});
if (libStatusFilter) {
  libStatusFilter.addEventListener('change', async () => {
    const { query, status } = getLibFilters();
    await renderLibraryGrid(query, status);
  });
}

// Book detail modal close
const bookDetailModal = document.getElementById('book-detail-modal');
document.getElementById('book-detail-close-btn').addEventListener('click', () => bookDetailModal.classList.add('hidden'));
bookDetailModal.addEventListener('click', e => { if (e.target === bookDetailModal) bookDetailModal.classList.add('hidden'); });

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
  await renderLibraryGrid();
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
    `<li><span class="lib-check-title">${e.title || '?'}</span><span class="lib-check-path">${e.filePath}</span></li>`
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

// Aggiunge shorcuts CTRL + wheel up/down per ingrandire/ridurre font size
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

