import ePub from 'epubjs';
import { translateParagraphs } from './translator.js';
import { parseMobi } from './mobi.js';
import { t } from './i18n.js';
import { RTL_LANGS } from './i18n.js';

// ── Stato applicazione ─────────────────────────────────────────────────────
let book = null;                    // istanza epubjs corrente
let rendition = null;               // non più usato, mantenuto per compatibilità
let currentSpineItems = [];         // lista capitoli spine EPUB
let currentSpineIndex = 0;          // indice capitolo corrente
let currentMobiHtml = null;         // HTML grezzo per MOBI
let currentChapterParagraphs = [];  // paragrafi del capitolo corrente
let fontSize = 16;
let syncingScroll = false;          // lock per evitare loop nello scroll sincronizzato
let translationAbortController = null;
let lazyObserver = null;            // IntersectionObserver per traduzione lazy
let currentFilePath = null;         // path assoluto del file aperto (solo Tauri)

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
const fontDec              = document.getElementById('font-dec');
const fontInc              = document.getElementById('font-inc');
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
  bookmarksOpenBtn.textContent                           = t(lang, 'bookmarks');
  addBookmarkBtn.title                                   = t(lang, 'addBookmark');
  bookmarksOpenBtn.title                                 = t(lang, 'openBookmarks');
  // Viewer headers
  document.getElementById('original-header').textContent = t(lang, 'original');
  // Settings modal labels
  document.querySelector('label[for="ui-lang-select"]').textContent = t(lang, 'interfaceLanguage');
  document.querySelector('label[for="theme-select"]').textContent   = t(lang, 'theme');
  document.getElementById('settings-modal-title').textContent       = '⚙️ ' + t(lang, 'settings');
  settingsCloseBtn.title                                             = t(lang, 'close');
  // Bookmarks modal
  document.getElementById('bm-modal-title').textContent    = t(lang, 'bookmarks');
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
  if (!currentSpineItems.length) return;
  if (e.target.classList.contains('progress-tick')) return; // gestito dal tick
  const rect = progressTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const idx = Math.round(ratio * (currentSpineItems.length - 1));
  displayChapter(idx);
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

function showTooltip(anchor, label, pct) {
  progressTooltip.textContent = label;
  progressTooltip.style.left = `${pct}%`;
  progressTooltip.classList.add('visible');
}
function hideTooltip() {
  progressTooltip.classList.remove('visible');
}

// Evidenzia la tacca del capitolo corrente
function updateActiveTick() {
  progressTicks.querySelectorAll('.progress-tick').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.idx) === currentSpineIndex);
  });
}

// Tooltip sull'hover generico sulla barra
progressTrack.addEventListener('mousemove', e => {
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
  return paragraphs.filter(p => p.trim()).map(p => `<p>${escapeHtml(p)}</p>`).join('');
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Estrae paragrafi da un nodo DOM (body di un capitolo EPUB o div MOBI)
function extractParagraphs(body) {
  const selectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'];
  const blocks = body.querySelectorAll?.(selectors.join(', '));
  if (blocks && blocks.length > 0) {
    const r = [];
    blocks.forEach(el => {
      const t = (el.textContent || '').trim();
      if (t) r.push(t);
    });
    if (r.length) return r;
  }
  // Fallback: split per newline (funziona anche su XMLDocument)
  return (body.textContent || '').split('\n').map(l => l.trim()).filter(l => l.length > 2);
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

// ── Render pannelli testo ──────────────────────────────────────────────────
function renderOriginal(paragraphs) {
  originalViewer.innerHTML = paragraphs.length
    ? paragraphsToHtml(paragraphs)
    : `<p class="placeholder">${ui('noContent')}</p>`;
  originalViewer.scrollTop = 0;
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
  translationLangLabel.textContent = langSelect.options[langSelect.selectedIndex].text;

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
  const pEls = paragraphs.map((text, i) => {
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
    const slice = paragraphs.slice(start, end);
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
        pEls[i].textContent = paragraphs[i];
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
      const selected = await open({ filters: [{ name: 'eBook', extensions: ['epub','mobi','azw','azw3'] }] });
      if (!selected) return;
      fileName = selected; // in Tauri è il path assoluto completo
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
    else if (['mobi','azw','azw3'].includes(ext)) await loadMobi(fileData, fileName);
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
    input.accept = '.epub,.mobi,.azw,.azw3';
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
    if (book) { book.destroy(); book = null; rendition = null; }
    currentMobiHtml = null;
    currentChapterParagraphs = [];

    book = ePub(arrayBuffer);
    await book.ready;

    const meta = await book.loaded.metadata;
    bookTitle.textContent  = meta.title   || ui('unknownTitle');
    bookAuthor.textContent = meta.creator || '';
    bookInfo.classList.remove('hidden');
    tocPlaceholder.style.display = 'none';
    try { const url = await book.coverUrl(); if (url) coverImg.src = url; } catch (_) {}

    await book.loaded.spine;
    currentSpineItems = [];
    book.spine.each(item => currentSpineItems.push(item));
    currentSpineIndex = 0;

    const nav = await book.loaded.navigation;
    renderToc(nav.toc);
    rendition = null;

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
    renderOriginal(currentChapterParagraphs);
    updateProgress();
    updateActiveTick();
    await translateCurrentChapter(scrollPct);
    if (scrollPct > 0) restoreScrollPct(scrollPct);
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

// ── Carica MOBI ────────────────────────────────────────────────────────────
async function loadMobi(arrayBuffer, filePath = '') {
  showLoading(ui('loadingMobi'));
  hideNoBookPlaceholder();
  currentFilePath = filePath || null;
  try {
    if (book) { book.destroy(); book = null; rendition = null; }
    currentSpineItems = [];
    const { title, htmlContent } = await parseMobi(arrayBuffer);
    bookTitle.textContent  = title || ui('unknownTitle');
    bookAuthor.textContent = '';
    bookInfo.classList.remove('hidden');
    tocPlaceholder.style.display = 'none';
    tocList.innerHTML = '';
    currentMobiHtml = htmlContent;
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlContent;
    currentChapterParagraphs = extractParagraphs(tmp);
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    pageInfo.textContent = 'MOBI';
    progressFill.style.width = '100%';
    progressThumb.style.left = '100%';
    addBookmarkBtn.disabled = false;
    renderOriginal(currentChapterParagraphs);
    await translateCurrentChapter();
  } finally {
    hideLoading();
  }
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

  const lineH = fontSize * 1.8;
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

// ── Font size ──────────────────────────────────────────────────────────────
fontDec.addEventListener('click', () => { fontSize = Math.max(10, fontSize - 2); applyFontSize(); });
fontInc.addEventListener('click', () => { fontSize = Math.min(36, fontSize + 2); applyFontSize(); });
function applyFontSize() {
  originalViewer.style.fontSize    = `${fontSize}px`;
  translationViewer.style.fontSize = `${fontSize}px`;
}

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
  if (!currentFilePath && !currentMobiHtml) return;
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
    isMobi: !!currentMobiHtml && !book,
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
      <span class="bm-icon">🔖</span>
      <span class="bm-info">
        <span class="bm-title" title="${escapeHtml(bm.bookTitle || bm.fileName)}">${escapeHtml(bm.bookTitle || bm.fileName)}</span>
        <span class="bm-chapter">${escapeHtml(bm.chapterLabel)}${bm.scrollPct != null ? ` · ${bm.scrollPct}%` : ''}</span>
      </span>
      <button class="bm-delete" title="Delete bookmark" data-id="${bm.id}">✕</button>
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
        const selected = await open({ filters: [{ name: 'eBook', extensions: ['epub','mobi','azw','azw3'] }] });
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
      await loadEpub(fileData, bm.filePath);
      if (bm.chapterIndex > 0 && bm.chapterIndex < currentSpineItems.length) {
        await displayChapter(bm.chapterIndex, bm.scrollPct ?? 0);
      } else if (bm.scrollPct > 0) {
        restoreScrollPct(bm.scrollPct);
      }
    } else if (['mobi','azw','azw3'].includes(ext)) {
      await loadMobi(fileData, bm.filePath);
      restoreScrollPct(bm.scrollPct);
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
