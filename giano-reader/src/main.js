import ePub from 'epubjs';
import { translateParagraphs } from './translator.js';
import { t, RTL_LANGS } from './i18n.js';

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

const LAZY_CHUNK = 12; // paragrafi per chunk di traduzione lazy

// ── Riferimenti DOM ────────────────────────────────────────────────────────
const openBtn              = document.getElementById('open-btn');
const prevBtn              = document.getElementById('prev-btn');
const nextBtn              = document.getElementById('next-btn');
const pageInfo             = document.getElementById('page-info');
const progressTrack        = document.getElementById('progress-track');
const progressFill         = document.getElementById('progress-fill');
const progressThumb        = document.getElementById('progress-thumb');
const progressTicks        = document.getElementById('progress-ticks');
const progressTooltip      = document.getElementById('progress-tooltip');
const langSelect           = document.getElementById('lang-select');
const originalViewer       = document.getElementById('original-viewer');
const translationViewer    = document.getElementById('translation-viewer');
const translationLangLabel = document.getElementById('translation-lang-label');
const translationStatus    = document.getElementById('translation-status');
const loadingOverlay       = document.getElementById('loading-overlay');
const loadingText          = document.getElementById('loading-text');
const noBookPlaceholder    = document.getElementById('no-book-placeholder');
const tocList              = document.getElementById('toc-list');
const tocPlaceholder       = document.getElementById('toc-placeholder');
const bookInfo             = document.getElementById('book-info');
const bookTitle            = document.getElementById('book-title');
const bookAuthor           = document.getElementById('book-author');
const coverImg             = document.getElementById('cover-img');
// Segnalibri
const addBookmarkBtn       = document.getElementById('add-bookmark-btn');
const bookmarksList        = document.getElementById('bookmarks-list');
const bookmarksPlaceholder = document.getElementById('bookmarks-placeholder');
const bookmarksModal       = document.getElementById('bookmarks-modal');
const bookmarksOpenBtn     = document.getElementById('bookmarks-open-btn');
const bmCloseBtn           = document.getElementById('bm-close-btn');
const bmImportBtn          = document.getElementById('bm-import-btn');
const bmExportBtn          = document.getElementById('bm-export-btn');
const bmImportInput        = document.getElementById('bm-import-input');
const bookmarkMissingModal = document.getElementById('bookmark-missing-modal');
const bmMissingName        = document.getElementById('bm-missing-name');
const bmRelocateBtn        = document.getElementById('bm-relocate-btn');
const bmCancelBtn          = document.getElementById('bm-cancel-btn');
// Settings
const settingsBtn          = document.getElementById('settings-btn');
const settingsModal        = document.getElementById('settings-modal');
const settingsCloseBtn     = document.getElementById('settings-close-btn');
const uiLangSelect         = document.getElementById('ui-lang-select');
const themeSelect          = document.getElementById('theme-select');
const fontFamilySelect     = document.getElementById('font-family-select');
const fontSizeRange        = document.getElementById('font-size-range');
const fontSizeValue        = document.getElementById('font-size-value');
// View toggle — commuta tra Text_Mode e Original_Mode
const viewToggleBtn        = document.getElementById('view-toggle-btn');
const syncDisabledNotice   = document.getElementById('sync-disabled-notice');
const originalNative       = document.getElementById('original-native');
// Hide translation toggle — nasconde/mostra il pannello di traduzione
const hideTranslationBtn   = document.getElementById('hide-translation-btn');
const translationPanel     = document.getElementById('translation-panel');
const divider              = document.getElementById('divider');

let translationHidden = false;

hideTranslationBtn.addEventListener('click', () => {
  translationHidden = !translationHidden;
  translationPanel.classList.toggle('hidden', translationHidden);
  divider.classList.toggle('hidden', translationHidden);
  hideTranslationBtn.setAttribute('aria-pressed', String(translationHidden));
  hideTranslationBtn.classList.toggle('active', translationHidden);
});

// ── Custom flag dropdown ───────────────────────────────────────────────────
const FLAG_MAP = {
  it: 'it', en: 'gb', fr: 'fr', de: 'de', es: 'es',
  pt: 'pt', ru: 'ru', zh: 'cn', ja: 'jp', ar: 'sa',
  fil: 'ph', sq: 'al',
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
}

function applyFont(family) {
  document.documentElement.style.setProperty('--reader-font-family', family);
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--font-size', size + 'px');
  if (fontSizeValue) fontSizeValue.textContent = size + 'px';
  if (fontSizeRange) fontSizeRange.value = size;
}

function applyUiLang(lang) {
  document.documentElement.lang = lang;
  // RTL support
  const isRtl = RTL_LANGS.has(lang);
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.documentElement.classList.toggle('rtl', isRtl);
  // Sidebar
  openBtn.textContent                                    = t(lang, 'openBook');
  document.querySelector('label[for="lang-select"]').textContent = t(lang, 'translationLanguage');
  tocPlaceholder.textContent                             = t(lang, 'noBookOpen');
  bookmarksOpenBtn.innerHTML                             = '<img src="/icons/book-bookmark.svg" class="icon" alt="" /> ' + t(lang, 'bookmarks');
  addBookmarkBtn.title                                   = t(lang, 'addBookmark');
  bookmarksOpenBtn.title                                 = t(lang, 'openBookmarks');
  // Viewer headers
  document.getElementById('original-header-label').textContent = t(lang, 'original');
  // Settings modal labels
  document.querySelector('label[for="ui-lang-select"]').textContent = t(lang, 'interfaceLanguage');
  document.querySelector('label[for="theme-select"]').textContent   = t(lang, 'theme');
  document.querySelector('label[for="font-family-select"]').textContent = t(lang, 'fontFamily');
  document.querySelector('label[for="font-size-range"]').textContent    = t(lang, 'fontSize');
  document.getElementById('settings-modal-title').innerHTML         = '<img src="/icons/gear.svg" class="icon" alt="" /> ' + t(lang, 'settings');
  settingsCloseBtn.title                                             = t(lang, 'close');
  // Bookmarks modal
  document.getElementById('bm-modal-title').innerHTML      = '<img src="/icons/book-bookmark.svg" class="icon" alt="" /> ' + t(lang, 'bookmarks');
  bmCloseBtn.title                                          = t(lang, 'close');
  bmImportBtn.title                                         = t(lang, 'importBookmarks');
  bmExportBtn.title                                         = t(lang, 'exportBookmarks');
  bookmarksPlaceholder.textContent                          = t(lang, 'noBookmarksSaved');
  // Missing file modal
  document.getElementById('bm-missing-modal-title').textContent = t(lang, 'fileNotFound');
  bmRelocateBtn.textContent                                      = t(lang, 'browse');
  bmCancelBtn.textContent                                        = t(lang, 'cancel');
  // Progress bar buttons
  prevBtn.title = 'Previous chapter';
  nextBtn.title = 'Next chapter';
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
  if (syncDisabledNotice) {
    syncDisabledNotice.textContent = t(lang, 'syncDisabled');
  }
  // Settings about footer
  document.getElementById('settings-developed-by').textContent = t(lang, 'developedBy', { author: 'Giampaolo Bolzonella' });
  document.getElementById('settings-version').textContent      = t(lang, 'version', { version: '0.7.1' });
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
}

// Init from saved settings
(function initSettings() {
  const s = loadSettings();
  const theme = s.theme || 'dark';
  const uiLang = s.uiLang || 'en';
  applyTheme(theme);
  themeSelect.value = theme;
  uiLangSelect.value = uiLang;
  applyUiLang(uiLang);
  // Font family
  const fontFamily = s.fontFamily || 'Georgia, serif';
  applyFont(fontFamily);
  if (fontFamilySelect) fontFamilySelect.value = fontFamily;
  // Font size
  const fontSize = s.fontSize || 16;
  applyFontSize(fontSize);
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

settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
settingsCloseBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

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
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ── Progress bar ───────────────────────────────────────────────────────────
function updateProgress() {
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
  if (!currentSpineItems.length) return;
  const rect  = progressTrack.getBoundingClientRect();
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
  if (!currentSpineItems.length) return;
  const rect  = progressTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const idx   = Math.round(ratio * (currentSpineItems.length - 1));
  const tick  = progressTicks.querySelector(`[data-idx="${idx}"]`);
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
    ['onclick','onmouseover','onerror','onload'].forEach(ev => n.removeAttribute(ev));
  });
  return clone.innerHTML;
}

// Estrae paragrafi da un nodo DOM (body di un capitolo EPUB)
// Restituisce oggetti { text, html } — text per la traduzione, html per il rendering
function extractParagraphs(body) {
  const selectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'];
  const blocks = body.querySelectorAll?.(selectors.join(', '));
  if (blocks && blocks.length > 0) {
    const r = [];
    blocks.forEach(el => {
      const text = (el.textContent || '').trim();
      if (text) r.push({ text, html: safeInnerHtml(el) });
    });
    if (r.length) return r;
  }
  // Fallback: split per newline (funziona anche su XMLDocument)
  return (body.textContent || '').split('\n')
    .map(l => l.trim()).filter(l => l.length > 2)
    .map(text => ({ text, html: escapeHtml(text) }));
}

// ── Scroll sincronizzato tra i due pannelli ────────────────────────────────
function bindSyncScroll() {
  originalViewer.onscroll = () => {
    if (syncingScroll) return;
    syncingScroll = true;
    const r = originalViewer.scrollTop / Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
    translationViewer.scrollTop = r * (translationViewer.scrollHeight - translationViewer.clientHeight);
    syncingScroll = false;
  };
  translationViewer.onscroll = () => {
    if (syncingScroll) return;
    syncingScroll = true;
    const r = translationViewer.scrollTop / Math.max(1, translationViewer.scrollHeight - translationViewer.clientHeight);
    originalViewer.scrollTop = r * (originalViewer.scrollHeight - originalViewer.clientHeight);
    syncingScroll = false;
  };
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
    if (!skipRender && book && currentSpineItems.length) {
      renderNativeView();
    }
  } else {
    bindSyncScroll();
    if (!skipRender && book && currentSpineItems.length) {
      displayChapter(currentSpineIndex);
    }
  }

  // Avviso nel pannello di traduzione
  syncDisabledNotice.classList.toggle('hidden', !isOriginal);
}

// ── Native view rendering ──────────────────────────────────────────────────
async function renderNativeView() {
  originalNative.innerHTML = '';
  if (book) {
    try {
      const spineItem = currentSpineItems[currentSpineIndex];
      const html = await spineItem.render(book.load.bind(book));
      const frame = document.createElement('iframe');
      frame.id = 'epub-native-frame';
      frame.className = 'native-frame';
      const bg  = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()   || '#1a1a1a';
      const fg  = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()  || '#e0e0e0';
      const themeStyle = `<style>html,body{background:${bg}!important;color:${fg}!important;font-family:Georgia,serif;line-height:1.8;padding:1rem;margin:0;max-width:100%;overflow-x:hidden;}img,table,svg{max-width:100%!important;height:auto;}pre{white-space:pre-wrap;overflow-wrap:break-word;}a{color:inherit;}</style>`;
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
      console.error('[native] errore rendering EPUB:', err);
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
    const idx = currentSpineItems.findIndex(i =>
      i.href === filePart || i.href?.endsWith(filePart) || filePart?.endsWith(i.href)
    );
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

// ── Render pannelli testo ──────────────────────────────────────────────────
function renderOriginal(paragraphs) {
  originalViewer.innerHTML = paragraphs.length
    ? paragraphsToHtml(paragraphs)
    : `<p class="placeholder">${ui('noContent')}</p>`;
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

// ── Traduzione lazy ────────────────────────────────────────────────────────
// startPct: percentuale di scroll da cui partire (0-100). Traduce prima il chunk
// visibile a quella posizione, poi espande lazy verso il basso e verso l'alto.
async function translateCurrentChapter(startPct = 0) {
  if (translationAbortController) translationAbortController.abort();
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }

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
    p.className = 'pending';
    p.textContent = text;
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
        pEls[start + i].textContent = translated[i] || slice[i];
        pEls[start + i].classList.remove('pending');
      }
      if (translatedChunks.size >= totalChunks) setTranslationStatus('');
    } catch (err) {
      if (signal.aborted) return;
      console.error('[translate] errore chunk', chunkIdx, err);
      for (let i = start; i < end; i++) {
        const fallback = paragraphs[i].text !== undefined ? paragraphs[i].text : paragraphs[i];
        pEls[i].textContent = fallback;
        pEls[i].classList.remove('pending');
      }
    }
  }

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

// ── Apertura file ──────────────────────────────────────────────────────────
openBtn.addEventListener('click', async () => {
  try {
    let fileData = null, fileName = '';
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
      const { open }     = await import('@tauri-apps/plugin-dialog');
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const selected = await open({ filters: [{ name: 'eBook', extensions: ['epub'] }] });
      if (!selected) return;
      fileName = selected;
      const raw = await readFile(selected);
      fileData = raw.buffer ?? raw;
    } else {
      const picked = await pickFileViaInput();
      if (!picked) return;
      fileName = picked.name;
      fileData = picked.buffer;
    }
    const ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'epub') await loadEpub(fileData, fileName);
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
    input.accept = '.epub';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, buffer: await file.arrayBuffer() });
    };
    input.click();
  });
}

// ── Carica EPUB ────────────────────────────────────────────────────────────
async function loadEpub(arrayBuffer, filePath = '') {
  showLoading(ui('loadingEpub'));
  hideNoBookPlaceholder();
  currentFilePath = filePath || null;
  try {
    if (book) { book.destroy(); book = null; }
    currentChapterParagraphs = [];

    book = ePub(arrayBuffer);
    await book.ready;

    const meta = await book.loaded.metadata;
    bookTitle.textContent  = meta.title   || ui('unknownTitle');
    bookAuthor.textContent = meta.creator || '';
    bookInfo.classList.remove('hidden');
    tocPlaceholder.style.display = 'none';
    try { const url = await book.coverUrl(); if (url) coverImg.src = url; } catch (_) {}

    // Log all available metadata fields for discovery
    console.log('[meta] available fields:', JSON.stringify({
      title: meta.title, creator: meta.creator, publisher: meta.publisher,
      language: meta.language, pubdate: meta.pubdate, description: meta.description,
      rights: meta.rights, identifier: meta.identifier, modified_date: meta.modified_date,
      layout: meta.layout, orientation: meta.orientation, flow: meta.flow,
      viewport: meta.viewport, spread: meta.spread,
    }, null, 2));

    // Auto-add to library when a book is opened (only in Tauri where filePath is absolute)
    if (filePath && (filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath))) {
      autoAddToLibrary(arrayBuffer, filePath, meta);
    }

    await book.loaded.spine;
    currentSpineItems = [];
    book.spine.each(item => currentSpineItems.push(item));
    currentSpineIndex = 0;

    const nav = await book.loaded.navigation;
    renderToc(nav.toc);

    updateProgress();
    buildProgressTicks(currentSpineItems, nav.toc);
    addBookmarkBtn.disabled = false;

    // Trova il primo capitolo con contenuto reale (salta copertina/frontmatter)
    let bestIndex = -1;
    // Prima passa: cerca "chapter/capitolo" nel nome file
    for (let i = 0; i < currentSpineItems.length; i++) {
      if (/chapter|capitolo|chap/i.test(currentSpineItems[i].href)) {
        bestIndex = i; break;
      }
    }
    // Seconda passa: primo capitolo con più di 500 caratteri
    if (bestIndex < 0) {
      for (let i = 0; i < currentSpineItems.length; i++) {
        const body = await loadChapterDocument(currentSpineItems[i]);
        if ((body?.textContent?.trim() || '').length > 500) { bestIndex = i; break; }
      }
    }
    setViewMode('text');
    viewToggleBtn.disabled = false;
    await displayChapter(bestIndex >= 0 ? bestIndex : 0);
  } finally {
    hideLoading();
  }
}

// ── Naviga a un capitolo (parsing diretto, senza iframe) ───────────────────
async function displayChapter(index, scrollPct = 0) {
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
  } catch (err) {
    if (currentSpineIndex !== myIndex) return;
    console.error('[nav] errore:', err);
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
    console.error('[nav] loadChapterDocument errore:', e);
  }
  return null;
}

// ── Indice (TOC) ───────────────────────────────────────────────────────────
function renderToc(items, parent = tocList) {
  parent.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    const a  = document.createElement('a');
    a.href = '#';
    a.textContent = item.label.trim();
    a.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('#toc-list a').forEach(el => el.classList.remove('active'));
      a.classList.add('active');
      if (!book) return;
      const href = item.href.split('#')[0];
      const idx = currentSpineItems.findIndex(i =>
        i.href === href || i.href?.endsWith(href) || href?.endsWith(i.href)
      );
      if (idx >= 0) displayChapter(idx);
    });
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
  if (!book || currentSpineIndex <= 0) return;
  displayChapter(currentSpineIndex - 1);
});
nextBtn.addEventListener('click', () => {
  if (!book || currentSpineIndex >= currentSpineItems.length - 1) return;
  displayChapter(currentSpineIndex + 1);
});

// Cambio lingua → ritraduce il capitolo corrente
langSelect.addEventListener('change', () => {
  if (currentChapterParagraphs.length) translateCurrentChapter();
});

// ── Navigazione da tastiera ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const lineH = 16 * 1.8;
  const pageH = originalViewer.clientHeight * 0.9;
  let delta = 0;
  if (e.key === 'ArrowDown') { delta =  lineH * 3; e.preventDefault(); }
  if (e.key === 'ArrowUp')   { delta = -lineH * 3; e.preventDefault(); }
  if (e.key === ' ')         { delta = e.shiftKey ? -pageH : pageH; e.preventDefault(); }
  if (delta === 0) return;

  const origMax  = Math.max(1, originalViewer.scrollHeight    - originalViewer.clientHeight);
  const transMax = Math.max(1, translationViewer.scrollHeight - translationViewer.clientHeight);
  syncingScroll = true;
  originalViewer.scrollTop    = Math.max(0, Math.min(originalViewer.scrollTop + delta, origMax));
  translationViewer.scrollTop = Math.max(0, Math.min((originalViewer.scrollTop / origMax) * transMax, transMax));
  syncingScroll = false;
});

// ── Segnalibri ─────────────────────────────────────────────────────────────
const BOOKMARKS_KEY = 'giano-reader-bookmarks';

function loadBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]'); }
  catch { return []; }
}
function saveBookmarks(bms) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bms));
}

// Restituisce la label del capitolo corrente dalla progress bar
function getChapterLabel(index) {
  const tick = progressTicks.querySelector(`[data-idx="${index}"]`);
  return tick?.dataset.label || `Chapter ${index + 1}`;
}

// Aggiunge un segnalibro per il capitolo corrente
addBookmarkBtn.addEventListener('click', async () => {
  if (!currentFilePath) return;
  const bms = loadBookmarks();
  const scrollMax = Math.max(1, originalViewer.scrollHeight - originalViewer.clientHeight);
  const scrollPct = scrollMax > 1 ? Math.round((originalViewer.scrollTop / scrollMax) * 100) : 0;
  const bm = {
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
  bms.push(bm);
  saveBookmarks(bms);
  renderBookmarks();
});

// Renderizza la lista segnalibri nella modale
function renderBookmarks() {
  const bms = loadBookmarks();
  bookmarksList.innerHTML = '';
  if (!bms.length) {
    bookmarksList.appendChild(bookmarksPlaceholder);
    bookmarksPlaceholder.style.display = '';
    return;
  }
  for (const bm of bms) {
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
    li.querySelector('.bm-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteBookmark(bm.id);
    });
    bookmarksList.appendChild(li);
  }
}

// Apri/chiudi modale segnalibri
function openBookmarksModal() {
  renderBookmarks();
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
  const bms = loadBookmarks();
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
    const existing = loadBookmarks();
    const existingIds = new Set(existing.map(b => b.id));
    const toAdd = imported.filter(b => b && b.id && !existingIds.has(b.id));
    saveBookmarks([...existing, ...toAdd]);
    renderBookmarks();
    await showAlert(ui('importedMsg', { added: toAdd.length, skipped: imported.length - toAdd.length }));
  } catch (err) {
    await showAlert(ui('importError') + errMsg(err));
  }
});

function deleteBookmark(id) {
  saveBookmarks(loadBookmarks().filter(b => b.id !== id));
  renderBookmarks();
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
        const selected = await open({ filters: [{ name: 'eBook', extensions: ['epub'] }] });
        resolve(selected || null);
      } catch (err) {
        console.error('[bookmark] errore dialog rilocazione:', err);
        resolve(null);
      }
    };
  });
}

// Aggiorna il path di un segnalibro e ricarica la lista
function updateBookmarkPath(bm, newPath) {
  const bms = loadBookmarks();
  const idx = bms.findIndex(b => b.id === bm.id);
  if (idx >= 0) {
    bms[idx].filePath = newPath;
    bms[idx].fileName = newPath.split(/[\\/]/).pop();
    saveBookmarks(bms);
    renderBookmarks();
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
      updateBookmarkPath(bm, newPath);
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
    updateBookmarkPath(bm, newPath);
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
    } else {
      await showAlert(ui('unsupportedFormat'));
    }
  } catch (err) {
    console.error('[bookmark] open error:', err);
    const msg = errMsg(err);
    if (msg.includes('forbidden') || msg.includes('not allowed') || msg.includes('No such file') || msg.includes('os error')) {
      const newPath = await askRelocate(bm);
      if (!newPath) return;
      updateBookmarkPath(bm, newPath);
      await loadBookmarkFile(bm);
    } else {
      await showAlert(ui('errorOpening') + msg);
    }
  }
}

// Inizializza la lista segnalibri all'avvio
renderBookmarks();

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
    const { getCurrentWindow, PhysicalSize, PhysicalPosition, LogicalSize, LogicalPosition } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (state.maximized) {
      await win.maximize();
    } else if (state.physical) {
      // Restore using physical pixels — no scale factor conversion needed
      if (state.width && state.height) await win.setSize(new PhysicalSize(state.width, state.height));
      if (state.x != null && state.y != null) await win.setPosition(new PhysicalPosition(state.x, state.y));
    } else {
      // Legacy entries saved as logical pixels
      if (state.width && state.height) await win.setSize(new LogicalSize(state.width, state.height));
      if (state.x != null && state.y != null) await win.setPosition(new LogicalPosition(state.x, state.y));
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

// ── Library ────────────────────────────────────────────────────────────────
const LIBRARY_KEY = 'giano-reader-library';

function loadLibrary() {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]'); }
  catch { return []; }
}
function saveLibrary(entries) {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
}

function addEntries(newEntries) {
  const lib = loadLibrary();
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
  saveLibrary(lib);
  return { added, skipped };
}

function removeEntry(id) {
  saveLibrary(loadLibrary().filter(e => e.id !== id));
  renderLibraryGrid();
}

async function readDirRecursive(dirPath) {
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const results = [];
  async function walk(path) {
    let entries;
    try { entries = await readDir(path); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory || entry.children !== undefined) {
        await walk(entry.path || (path + '/' + entry.name));
      } else {
        const name = entry.name || '';
        if (name.toLowerCase().endsWith('.epub')) {
          results.push(entry.path || (path + '/' + name));
        }
      }
    }
  }
  await walk(dirPath);
  return results;
}

async function extractMetadata(filePath) {
  const fileName = filePath.split(/[\\/]/).pop();
  const titleFallback = fileName.replace(/\.epub$/i, '');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const addedAt = Date.now();
  const t0 = performance.now();
  const log = (msg) => console.log(`[lib] ${fileName} +${Math.round(performance.now()-t0)}ms — ${msg}`);

  try {
    log('readFile start');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const raw = await readFile(filePath);
    const buffer = raw.buffer ?? raw;
    const fileSize = buffer.byteLength; // bytes, stored for display
    log(`readFile done (${Math.round(fileSize/1024)}KB)`);

    // Pass ArrayBuffer directly — same as loadEpub(). Using a blob URL causes
    // epubjs to fetch it internally via XHR which hangs in Tauri's WebView.
    let epubBook;
    try {
      log('ePub() init');
      epubBook = ePub(buffer);
      await Promise.race([
        epubBook.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('epub ready timeout')), 8000)),
      ]);
      log('ready');

      const meta = await Promise.race([
        epubBook.loaded.metadata,
        new Promise((_, rej) => setTimeout(() => rej(new Error('metadata timeout')), 5000)),
      ]);
      const title = meta.title || titleFallback;
      const author = meta.creator || '';
      const publisher = meta.publisher || '';
      const language = meta.language || '';
      const pubdate = meta.pubdate ? meta.pubdate.slice(0, 4) : ''; // just the year
      const description = meta.description || '';
      log(`metadata: "${title}" by ${author}`);

      // Estimate page count from total character count across all spine items
      // Standard publishing estimate: ~1800 chars per page
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
          } catch { /* skip this item */ }
        }
        pageCount = totalChars > 0 ? Math.max(1, Math.round(totalChars / 1800)) : 0;
        log(`page estimate: ~${pageCount} pages (${totalChars} chars)`);
      } catch (e) { log(`page count error: ${e.message}`); }

      // Get cover blob URL (same as loadEpub does)
      let coverDataUrl = null;
      try {
        log('coverUrl() start');
        const coverBlobUrl = await Promise.race([
          epubBook.coverUrl(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cover timeout')), 5000)),
        ]);
        log(`coverUrl() → ${coverBlobUrl ? coverBlobUrl.slice(0, 60) : 'null'}`);

        if (coverBlobUrl) {
          // Convert to data URL via canvas BEFORE destroying the book
          coverDataUrl = await new Promise(resolve => {
            const img = new Image();
            const timer = setTimeout(() => { log('img load timeout'); resolve(null); }, 5000);
            img.onload = () => {
              clearTimeout(timer);
              try {
                // Scale down to max 200px wide to keep localStorage size reasonable
                const maxW = 200;
                const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
                const w = Math.round(img.naturalWidth * scale);
                const h = Math.round(img.naturalHeight * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.80);
                log(`cover converted (${Math.round(dataUrl.length/1024)}KB data URL)`);
                resolve(dataUrl);
              } catch (e) {
                log(`canvas error: ${e.message}`);
                resolve(null);
              }
            };
            img.onerror = (e) => { clearTimeout(timer); log(`img onerror: ${e}`); resolve(null); };
            img.src = coverBlobUrl;
          });
        }
      } catch (e) { log(`cover error: ${e.message}`); coverDataUrl = null; }

      // Destroy AFTER cover conversion is complete
      epubBook.destroy();
      log(`done — cover=${coverDataUrl ? 'yes' : 'no'}`);
      return { id, filePath, fileName, title, author, publisher, language, pubdate, description, fileSize, pageCount, coverDataUrl, status: 'to-read', notes: '', addedAt };
    } catch (e) {
      log(`inner error: ${e.message}`);
      try { epubBook?.destroy(); } catch {}
      return { id, filePath, fileName, title: titleFallback, author: '', fileSize: fileSize ?? 0, pageCount: 0, coverDataUrl: null, addedAt };
    }
  } catch (e) {
    log(`outer error: ${e.message}`);
    return { id, filePath, fileName, title: titleFallback, author: '', fileSize: 0, pageCount: 0, coverDataUrl: null, addedAt };
  }
}

let scanInProgress = false;

// Auto-add a book to the library when opened, extracting cover in background
async function autoAddToLibrary(arrayBuffer, filePath, meta) {
  try {
    const lib = loadLibrary();
    if (lib.some(e => e.filePath === filePath)) return; // already in library
    const fileName = filePath.split(/[\\/]/).pop();
    const title = meta.title || fileName.replace(/\.epub$/i, '');
    const author = meta.creator || '';
    const publisher = meta.publisher || '';
    const language = meta.language || '';
    const pubdate = meta.pubdate ? meta.pubdate.slice(0, 4) : '';
    const description = meta.description || '';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const addedAt = Date.now();
    const fileSize = arrayBuffer.byteLength || 0;
    // Add immediately without cover so the entry appears right away
    addEntries([{ id, filePath, fileName, title, author, publisher, language, pubdate, description, fileSize, pageCount: 0, coverDataUrl: null, status: 'to-read', notes: '', addedAt }]);
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
          const current = loadLibrary();
          const idx = current.findIndex(e => e.filePath === filePath);
          if (idx >= 0) { current[idx].coverDataUrl = coverDataUrl; saveLibrary(current); }
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
    const epubPaths = await readDirRecursive(rootPath);
    if (!epubPaths.length) {
      libStatus.textContent = ui('libNoEpubFound');
      return;
    }
    const newEntries = [];
    for (const filePath of epubPaths) {
      libStatus.textContent = ui('libScanning') + ' ' + (newEntries.length + 1) + '/' + epubPaths.length;
      const entry = await extractMetadata(filePath);
      newEntries.push(entry);
    }
    const { added, skipped } = addEntries(newEntries);
    libStatus.textContent = ui('libScanDone', { added, skipped });
    renderLibraryGrid();
  } catch (err) {
    libStatus.textContent = ui('libImportError') + errMsg(err);
  } finally {
    scanInProgress = false;
    if (scanBtn) scanBtn.disabled = false;
  }
}

function renderLibraryGrid(query = '', statusFilter = '') {
  const lib = loadLibrary();
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
  grid.innerHTML = '';
  if (!filtered.length) {
    placeholder.classList.remove('hidden');
    placeholder.textContent = q ? ui('libNoResults', { query }) : ui('libEmpty');
    grid.classList.add('hidden');
    return;
  }
  placeholder.classList.add('hidden');
  grid.classList.remove('hidden');
  for (const entry of filtered) {
    const card = document.createElement('div');
    card.className = 'lib-book-card';
    card.dataset.id = entry.id;
    const img = document.createElement('img');
    img.className = 'lib-book-cover';
    img.alt = entry.title || ui('libCoverPlaceholder');
    if (entry.coverDataUrl) {
      img.src = entry.coverDataUrl;
    } else {
      img.src = '';
      img.style.background = '#2a2a2a';
    }
    const info = document.createElement('div');
    info.className = 'lib-book-info';
    // Title row: title text + action buttons right-aligned
    const titleRow = document.createElement('div');
    titleRow.className = 'lib-book-title-row';
    const titleEl = document.createElement('span');
    titleEl.className = 'lib-book-title';
    titleEl.textContent = entry.title || ui('libCoverPlaceholder');
    titleEl.title = entry.title || '';
    const infoBtn = document.createElement('button');
    infoBtn.className = 'lib-book-action-btn';
    infoBtn.title = ui('detailInfoBtn');
    infoBtn.innerHTML = 'ⓘ';
    infoBtn.addEventListener('click', e => { e.stopPropagation(); openBookDetail(entry.id); });
    const delBtn = document.createElement('button');
    delBtn.className = 'lib-book-action-btn lib-book-action-btn--danger';
    delBtn.title = ui('libDeleteBook');
    delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    delBtn.addEventListener('click', e => { e.stopPropagation(); removeEntry(entry.id); });
    titleRow.appendChild(titleEl);
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
        'reading':  ui('statusReading'),
        'read':     ui('statusRead'),
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
}

// Open book detail modal for editing metadata
function openBookDetail(entryId) {
  const lib = loadLibrary();
  const entry = lib.find(e => e.id === entryId);
  if (!entry) return;
  const modal = document.getElementById('book-detail-modal');
  // Localize all labels
  document.getElementById('book-detail-title').textContent = entry.title || ui('bookDetail');
  document.querySelector('label[for="detail-title"]').textContent    = ui('detailTitle');
  document.querySelector('label[for="detail-author"]').textContent   = ui('detailAuthor');
  document.querySelector('label[for="detail-publisher"]').textContent = ui('detailPublisher');
  document.querySelector('label[for="detail-pubdate"]').textContent  = ui('detailYear');
  document.querySelector('label[for="detail-language"]').textContent = ui('detailLanguage');
  document.querySelector('label[for="detail-status"]').textContent   = ui('detailStatus');
  document.querySelector('label[for="detail-description"]').textContent = ui('detailDescription');
  document.querySelector('label[for="detail-notes"]').textContent    = ui('detailNotes');
  document.getElementById('book-detail-save-label').textContent   = ui('detailSave');
  document.getElementById('book-detail-delete-label').textContent = ui('detailDelete');
  document.getElementById('detail-notes').placeholder = ui('personalNotes');
  // Localize status options
  document.getElementById('detail-status-none').textContent    = ui('statusNone');
  document.getElementById('detail-status-to-read').textContent = ui('statusToRead');
  document.getElementById('detail-status-reading').textContent = ui('statusReading');
  document.getElementById('detail-status-read').textContent    = ui('statusRead');
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
  saveBtn.onclick = () => {
    entry.title = document.getElementById('detail-title').value.trim() || entry.title;
    entry.author = document.getElementById('detail-author').value.trim();
    entry.publisher = document.getElementById('detail-publisher').value.trim();
    entry.pubdate = document.getElementById('detail-pubdate').value.trim();
    entry.language = document.getElementById('detail-language').value.trim();
    entry.status = document.getElementById('detail-status').value;
    entry.notes = document.getElementById('detail-notes').value.trim();
    const idx = lib.findIndex(e => e.id === entryId);
    if (idx >= 0) { lib[idx] = entry; saveLibrary(lib); }
    modal.classList.add('hidden');
    const { query, status } = getLibFilters();
    renderLibraryGrid(query, status);
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
    removeEntry(entryId);
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
        const lib = loadLibrary();
        const idx = lib.findIndex(e => e.id === entry.id);
        if (idx >= 0) { lib[idx].status = 'reading'; saveLibrary(lib); }
      }
      await loadEpub(fileData, entry.filePath);
    } catch (err) {
      await showAlert(ui('errorOpening') + errMsg(err));
    }
  } else {
    await showAlert(ui('libBrowserOnly'));
  }
}

async function exportLibrary() {
  const lib = loadLibrary();
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
    const { added, skipped } = addEntries(parsed);
    libStatus.textContent = ui('libImportedMsg', { added, skipped });
    libStatus.classList.remove('hidden');
    renderLibraryGrid();
  } catch (err) {
    await showAlert(ui('libImportError') + errMsg(err));
  }
}

// ── Library DOM refs and listeners ────────────────────────────────────────
const libraryBtn     = document.getElementById('library-btn');
const libraryModal   = document.getElementById('library-modal');
const libCloseBtn    = document.getElementById('lib-close-btn');
const libScanBtn     = document.getElementById('lib-scan-btn');
const libImportBtn   = document.getElementById('lib-import-btn');
const libExportBtn   = document.getElementById('lib-export-btn');
const libStatus      = document.getElementById('lib-status');
const libGrid        = document.getElementById('lib-grid');
const libPlaceholder = document.getElementById('lib-placeholder');
const libSearchInput = document.getElementById('lib-search-input');
const libStatusFilter = document.getElementById('lib-status-filter');

function getLibFilters() {
  return {
    query: libSearchInput.value,
    status: libStatusFilter ? libStatusFilter.value : '',
  };
}

libraryBtn.addEventListener('click', () => {
  libraryModal.classList.remove('hidden');
  libSearchInput.value = '';
  if (libStatusFilter) libStatusFilter.value = '';
  renderLibraryGrid();
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
libSearchInput.addEventListener('input', () => {
  const { query, status } = getLibFilters();
  renderLibraryGrid(query, status);
});
if (libStatusFilter) {
  libStatusFilter.addEventListener('change', () => {
    const { query, status } = getLibFilters();
    renderLibraryGrid(query, status);
  });
}

// Book detail modal close
const bookDetailModal = document.getElementById('book-detail-modal');
document.getElementById('book-detail-close-btn').addEventListener('click', () => bookDetailModal.classList.add('hidden'));
bookDetailModal.addEventListener('click', e => { if (e.target === bookDetailModal) bookDetailModal.classList.add('hidden'); });

document.getElementById('lib-clear-btn').addEventListener('click', async () => {
  const lib = loadLibrary();
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
  saveLibrary([]);
  renderLibraryGrid();
});
