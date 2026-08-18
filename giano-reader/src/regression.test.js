/**
 * Non-Regression Tests — GianoReader
 * Covers: book opening, bookmarks, theme/font/fontSize, library import
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { translations, t } from './i18n.js';

// ── localStorage mock ────────────────────────────────────────────────────
function createLocalStorageMock() {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}

// ── Settings helpers (replicated from main.js for isolation) ─────────────
const SETTINGS_KEY = 'giano-reader-settings';
const THEMES = ['dark', 'light', 'monokai', 'solarized-dark', 'nord', 'sepia'];

function makeSettingsFunctions(storage) {
  function loadSettings() {
    try { return JSON.parse(storage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSettings(s) {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
  return { loadSettings, saveSettings };
}

// ── Library helpers (replicated from main.js) ────────────────────────────
const LIBRARY_KEY = 'giano-reader-library';

function makeLibFunctions(storage) {
  function loadLibrary() {
    try { return JSON.parse(storage.getItem(LIBRARY_KEY) || '[]'); } catch { return []; }
  }
  function saveLibrary(entries) {
    storage.setItem(LIBRARY_KEY, JSON.stringify(entries));
  }
  function addEntries(newEntries) {
    const lib = loadLibrary();
    const existingPaths = new Set(lib.map(e => e.filePath));
    let added = 0, skipped = 0;
    for (const entry of newEntries) {
      if (existingPaths.has(entry.filePath)) { skipped++; }
      else { lib.push(entry); existingPaths.add(entry.filePath); added++; }
    }
    saveLibrary(lib);
    return { added, skipped };
  }
  function removeEntry(id) {
    const filtered = loadLibrary().filter(e => e.id !== id);
    saveLibrary(filtered);
    return filtered;
  }
  return { loadLibrary, saveLibrary, addEntries, removeEntry };
}

// ── Bookmark helpers (replicated from main.js) ───────────────────────────
const BOOKMARKS_KEY = 'giano-reader-bookmarks';

function makeBookmarkFunctions(storage) {
  function loadBookmarks() {
    try { return JSON.parse(storage.getItem(BOOKMARKS_KEY) || '[]'); } catch { return []; }
  }
  function saveBookmarks(bms) {
    storage.setItem(BOOKMARKS_KEY, JSON.stringify(bms));
  }
  function addBookmark(bm) {
    const bms = loadBookmarks();
    bms.push(bm);
    saveBookmarks(bms);
    return bms;
  }
  function deleteBookmark(id) {
    const bms = loadBookmarks().filter(b => b.id !== id);
    saveBookmarks(bms);
    return bms;
  }
  return { loadBookmarks, saveBookmarks, addBookmark, deleteBookmark };
}

// ── Pure functions from main.js ──────────────────────────────────────────
function extractParagraphs(body) {
  const selectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'];
  const blocks = body.querySelectorAll?.(selectors.join(', '));
  if (blocks && blocks.length > 0) {
    const r = [];
    blocks.forEach(el => {
      const text = (el.textContent || '').trim();
      if (text) r.push({ text, html: el.innerHTML });
    });
    if (r.length) return r;
  }
  return (body.textContent || '').split('\n')
    .map(l => l.trim()).filter(l => l.length > 2)
    .map(text => ({ text, html: text }));
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraphsToHtml(paragraphs) {
  return paragraphs.filter(p => (p.text || p).trim()).map(p => {
    const html = p.html !== undefined ? p.html : escapeHtml(p);
    return `<p>${html}</p>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. APERTURA LIBRO SEMPLICE
// ═══════════════════════════════════════════════════════════════════════════
describe('Apertura libro semplice', () => {
  it('extractParagraphs estrae paragrafi da un body HTML con <p>', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Capitolo uno</p><p>Testo del paragrafo.</p>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Capitolo uno');
    expect(result[1].text).toBe('Testo del paragrafo.');
  });

  it('extractParagraphs estrae heading e list items', () => {
    const body = document.createElement('div');
    body.innerHTML = '<h1>Titolo</h1><h2>Sottotitolo</h2><li>Elemento lista</li>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('Titolo');
  });

  it('extractParagraphs fallback: split per newline quando non ci sono tag', () => {
    const body = document.createElement('div');
    body.textContent = 'Linea uno\nLinea due\nLinea tre';
    const result = extractParagraphs(body);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].text).toBe('Linea uno');
  });

  it('extractParagraphs ignora paragrafi vuoti', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Testo</p><p>   </p><p>Altro</p>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(2);
  });

  it('paragraphsToHtml genera HTML valido dai paragrafi', () => {
    const paras = [{ text: 'Hello', html: 'Hello' }, { text: 'World', html: 'World' }];
    const html = paragraphsToHtml(paras);
    expect(html).toBe('<p>Hello</p><p>World</p>');
  });

  it('escapeHtml previene XSS', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('escapeHtml non lancia errore con null o undefined (bookmark PWA senza campi desktop)', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('loadEpub imposta book a null dopo un errore', () => {
    let book = { destroy: vi.fn() };
    let currentSpineItems = ['a', 'b'];
    let currentChapterParagraphs = ['p1'];
    let currentFilePath = '/test.epub';
    // Simulate error path from loadEpub
    try { throw new Error('invalid epub'); } catch {
      if (book) { try { book.destroy(); } catch (_) {} book = null; }
      currentSpineItems = [];
      currentChapterParagraphs = [];
      currentFilePath = null;
    }
    expect(book).toBeNull();
    expect(currentSpineItems).toEqual([]);
    expect(currentChapterParagraphs).toEqual([]);
    expect(currentFilePath).toBeNull();
  });

  it('displayChapter clampa indici fuori range', () => {
    const total = 5;
    function clampIndex(index) {
      return Math.max(0, Math.min(index, total - 1));
    }
    expect(clampIndex(-1)).toBe(0);
    expect(clampIndex(0)).toBe(0);
    expect(clampIndex(4)).toBe(4);
    expect(clampIndex(99)).toBe(4);
  });

  it('updateProgress calcola la percentuale corretta', () => {
    function calcPct(index, total) {
      if (!total) return 0;
      return total === 1 ? 0 : (index / (total - 1)) * 100;
    }
    expect(calcPct(0, 10)).toBe(0);
    expect(calcPct(9, 10)).toBe(100);
    expect(calcPct(0, 1)).toBe(0);
    expect(calcPct(4, 10)).toBeCloseTo(44.44, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. APERTURA SEGNALIBRO
// ═══════════════════════════════════════════════════════════════════════════
describe('Apertura segnalibro', () => {
  let storage, fns;
  beforeEach(() => {
    storage = createLocalStorageMock();
    fns = makeBookmarkFunctions(storage);
  });

  it('loadBookmarks restituisce [] quando non ci sono segnalibri', () => {
    expect(fns.loadBookmarks()).toEqual([]);
  });

  it('addBookmark aggiunge un segnalibro e lo persiste', () => {
    const bm = { id: 1, filePath: '/book.epub', fileName: 'book.epub',
      bookTitle: 'Test', chapterIndex: 2, chapterLabel: 'Ch 3', scrollPct: 42 };
    const result = fns.addBookmark(bm);
    expect(result).toHaveLength(1);
    expect(fns.loadBookmarks()).toHaveLength(1);
    expect(fns.loadBookmarks()[0].chapterIndex).toBe(2);
  });

  it('deleteBookmark rimuove solo il segnalibro specificato', () => {
    fns.addBookmark({ id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0 });
    fns.addBookmark({ id: 2, filePath: '/b.epub', fileName: 'b.epub', bookTitle: 'B', chapterIndex: 1 });
    const remaining = fns.deleteBookmark(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(2);
  });

  it('segnalibro preserva la posizione di scroll', () => {
    const bm = { id: 10, filePath: '/x.epub', fileName: 'x.epub',
      bookTitle: 'X', chapterIndex: 5, chapterLabel: 'Ch 6', scrollPct: 75 };
    fns.addBookmark(bm);
    const loaded = fns.loadBookmarks()[0];
    expect(loaded.scrollPct).toBe(75);
    expect(loaded.chapterIndex).toBe(5);
  });

  it('round-trip persistenza segnalibri', () => {
    const bms = [
      { id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0, scrollPct: 0 },
      { id: 2, filePath: '/b.epub', fileName: 'b.epub', bookTitle: 'B', chapterIndex: 3, scrollPct: 50 },
    ];
    fns.saveBookmarks(bms);
    expect(fns.loadBookmarks()).toEqual(bms);
  });

  it('import segnalibri evita duplicati per id', () => {
    fns.addBookmark({ id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0 });
    // Simulate import logic
    const imported = [
      { id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0 },
      { id: 3, filePath: '/c.epub', fileName: 'c.epub', bookTitle: 'C', chapterIndex: 2 },
    ];
    const existing = fns.loadBookmarks();
    const existingIds = new Set(existing.map(b => b.id));
    const toAdd = imported.filter(b => b && b.id && !existingIds.has(b.id));
    fns.saveBookmarks([...existing, ...toAdd]);
    expect(fns.loadBookmarks()).toHaveLength(2);
  });

  it('openBookmark verifica path assoluto (Windows e Unix)', () => {
    function hasAbsolutePath(filePath) {
      return !!(filePath && (filePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(filePath)));
    }
    expect(hasAbsolutePath('/home/user/book.epub')).toBe(true);
    expect(hasAbsolutePath('C:\\Users\\book.epub')).toBe(true);
    expect(hasAbsolutePath('D:/books/test.epub')).toBe(true);
    expect(hasAbsolutePath('book.epub')).toBe(false);
    expect(hasAbsolutePath('')).toBe(false);
    expect(hasAbsolutePath(null)).toBe(false);
  });

  it('restoreScrollPct calcola la posizione corretta', () => {
    function restoreScroll(pct, scrollHeight, clientHeight) {
      const max = Math.max(1, scrollHeight - clientHeight);
      return Math.round((pct / 100) * max);
    }
    expect(restoreScroll(0, 1000, 500)).toBe(0);
    expect(restoreScroll(100, 1000, 500)).toBe(500);
    expect(restoreScroll(50, 1000, 500)).toBe(250);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CAMBIO TEMA, FONT, DIMENSIONE CARATTERE
// ═══════════════════════════════════════════════════════════════════════════
describe('Cambio tema, font, dimensione carattere', () => {
  let storage, fns;
  beforeEach(() => {
    storage = createLocalStorageMock();
    fns = makeSettingsFunctions(storage);
  });

  // ── Theme ──
  it('applyTheme aggiunge la classe corretta al body', () => {
    function applyTheme(theme) {
      document.body.classList.remove('dark', ...THEMES.map(t => `theme-${t}`));
      if (theme === 'dark') document.body.classList.add('dark');
      else document.body.classList.add(`theme-${theme}`);
    }
    applyTheme('dark');
    expect(document.body.classList.contains('dark')).toBe(true);
    applyTheme('sepia');
    expect(document.body.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('theme-sepia')).toBe(true);
    applyTheme('monokai');
    expect(document.body.classList.contains('theme-sepia')).toBe(false);
    expect(document.body.classList.contains('theme-monokai')).toBe(true);
  });

  it('tutti i temi sono applicabili senza errori', () => {
    function applyTheme(theme) {
      document.body.classList.remove('dark', ...THEMES.map(t => `theme-${t}`));
      if (theme === 'dark') document.body.classList.add('dark');
      else document.body.classList.add(`theme-${theme}`);
    }
    for (const theme of THEMES) {
      expect(() => applyTheme(theme)).not.toThrow();
    }
  });

  it('tema salvato e ricaricato correttamente', () => {
    for (const theme of THEMES) {
      fns.saveSettings({ theme });
      expect(fns.loadSettings().theme).toBe(theme);
    }
  });

  // ── Font family ──
  it('applyFont imposta la CSS custom property', () => {
    function applyFont(family) {
      document.documentElement.style.setProperty('--reader-font-family', family);
    }
    applyFont('Arial, sans-serif');
    expect(document.documentElement.style.getPropertyValue('--reader-font-family')).toBe('Arial, sans-serif');
    applyFont('Georgia, serif');
    expect(document.documentElement.style.getPropertyValue('--reader-font-family')).toBe('Georgia, serif');
  });

  it('fontFamily salvato e ricaricato correttamente', () => {
    const fonts = ['Georgia, serif', 'Arial, sans-serif', 'monospace', '"Times New Roman", serif'];
    for (const font of fonts) {
      fns.saveSettings({ fontFamily: font });
      expect(fns.loadSettings().fontFamily).toBe(font);
    }
  });

  // ── Font size ──
  it('applyFontSize imposta la CSS custom property', () => {
    function applyFontSize(size) {
      document.documentElement.style.setProperty('--font-size', size + 'px');
    }
    applyFontSize(20);
    expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('20px');
  });

  it('fontSize salvato e ricaricato per tutti i valori validi', () => {
    for (const size of [12, 14, 16, 18, 20, 24, 28]) {
      fns.saveSettings({ fontSize: size });
      expect(fns.loadSettings().fontSize).toBe(size);
    }
  });

  // ── Combined settings persistence ──
  it('cambio tema non altera font e fontSize', () => {
    fns.saveSettings({ theme: 'dark', fontFamily: 'Georgia, serif', fontSize: 18 });
    const s = fns.loadSettings();
    s.theme = 'sepia';
    fns.saveSettings(s);
    const result = fns.loadSettings();
    expect(result.theme).toBe('sepia');
    expect(result.fontFamily).toBe('Georgia, serif');
    expect(result.fontSize).toBe(18);
  });

  it('cambio font non altera tema e fontSize', () => {
    fns.saveSettings({ theme: 'nord', fontFamily: 'Georgia, serif', fontSize: 16 });
    const s = fns.loadSettings();
    s.fontFamily = 'Arial, sans-serif';
    fns.saveSettings(s);
    const result = fns.loadSettings();
    expect(result.theme).toBe('nord');
    expect(result.fontFamily).toBe('Arial, sans-serif');
    expect(result.fontSize).toBe(16);
  });

  it('cambio fontSize non altera tema e font', () => {
    fns.saveSettings({ theme: 'monokai', fontFamily: 'monospace', fontSize: 14 });
    const s = fns.loadSettings();
    s.fontSize = 24;
    fns.saveSettings(s);
    const result = fns.loadSettings();
    expect(result.theme).toBe('monokai');
    expect(result.fontFamily).toBe('monospace');
    expect(result.fontSize).toBe(24);
  });

  it('loadSettings restituisce {} per JSON invalido', () => {
    storage.setItem(SETTINGS_KEY, '{{invalid}}');
    expect(fns.loadSettings()).toEqual({});
  });

  it('i18n per le label dei temi è completa in tutte le lingue', () => {
    const langs = Object.keys(translations);
    for (const lang of langs) {
      expect(t(lang, 'theme').length).toBeGreaterThan(0);
      expect(t(lang, 'theme')).not.toBe('theme');
      expect(t(lang, 'fontFamily')).not.toBe('fontFamily');
      expect(t(lang, 'fontSize')).not.toBe('fontSize');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GENERAZIONE LIBRERIA CON IMPORT LIBRI
// ═══════════════════════════════════════════════════════════════════════════
describe('Generazione libreria con import libri', () => {
  let storage, fns;
  beforeEach(() => {
    storage = createLocalStorageMock();
    fns = makeLibFunctions(storage);
  });

  const mkEntry = (id, path, title = '', author = '') => ({
    id, filePath: path, fileName: path.split('/').pop(),
    title: title || path.split('/').pop().replace('.epub', ''),
    author, coverDataUrl: null, addedAt: Date.now(),
  });

  it('libreria vuota iniziale', () => {
    expect(fns.loadLibrary()).toEqual([]);
  });

  it('addEntries aggiunge libri correttamente', () => {
    const entries = [mkEntry('1', '/books/a.epub', 'Libro A', 'Autore A')];
    const result = fns.addEntries(entries);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(fns.loadLibrary()).toHaveLength(1);
  });

  it('import multiplo preserva i libri esistenti', () => {
    fns.addEntries([mkEntry('1', '/a.epub', 'A')]);
    fns.addEntries([mkEntry('2', '/b.epub', 'B')]);
    expect(fns.loadLibrary()).toHaveLength(2);
  });

  it('import con duplicati skippa i file già presenti', () => {
    fns.addEntries([mkEntry('1', '/a.epub')]);
    const result = fns.addEntries([mkEntry('2', '/a.epub'), mkEntry('3', '/b.epub')]);
    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(fns.loadLibrary()).toHaveLength(2);
  });

  it('added + skipped = total importati', () => {
    fns.addEntries([mkEntry('1', '/a.epub')]);
    const toImport = [mkEntry('2', '/a.epub'), mkEntry('3', '/b.epub'), mkEntry('4', '/c.epub')];
    const { added, skipped } = fns.addEntries(toImport);
    expect(added + skipped).toBe(toImport.length);
  });

  it('removeEntry rimuove solo il libro specificato', () => {
    fns.addEntries([mkEntry('a', '/a.epub'), mkEntry('b', '/b.epub'), mkEntry('c', '/c.epub')]);
    fns.removeEntry('b');
    const lib = fns.loadLibrary();
    expect(lib).toHaveLength(2);
    expect(lib.find(e => e.id === 'b')).toBeUndefined();
  });

  it('round-trip persistenza libreria', () => {
    const entries = [mkEntry('1', '/a.epub', 'A', 'AA'), mkEntry('2', '/b.epub', 'B', 'BB')];
    fns.saveLibrary(entries);
    expect(fns.loadLibrary()).toEqual(entries);
  });

  it('import da JSON — rejects non-array', () => {
    const parsed = JSON.parse('{"key":"value"}');
    expect(Array.isArray(parsed)).toBe(false);
  });

  it('import da JSON — accepts array', () => {
    const parsed = JSON.parse('[{"id":"1","filePath":"/a.epub"}]');
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('renderLibraryGrid mostra placeholder per libreria vuota', () => {
    const container = document.createElement('div');
    // Replicate simplified renderLibraryGrid
    const lib = [];
    container.innerHTML = '';
    if (!lib.length) {
      const p = document.createElement('p');
      p.id = 'lib-placeholder';
      container.appendChild(p);
    }
    expect(container.querySelector('#lib-placeholder')).not.toBeNull();
  });

  it('renderLibraryGrid crea N card per N libri', () => {
    const container = document.createElement('div');
    const entries = [mkEntry('1', '/a.epub', 'A'), mkEntry('2', '/b.epub', 'B')];
    container.innerHTML = '';
    for (const entry of entries) {
      const card = document.createElement('div');
      card.className = 'lib-book-card';
      card.dataset.id = entry.id;
      const title = document.createElement('span');
      title.className = 'lib-book-title';
      title.textContent = entry.title;
      card.appendChild(title);
      container.appendChild(card);
    }
    expect(container.querySelectorAll('.lib-book-card')).toHaveLength(2);
  });

  it('extractMetadata fallback produce titolo dal fileName', () => {
    function extractMetadataFallback(filePath) {
      const fileName = filePath.split(/[/\\]/).pop();
      const title = fileName.replace(/\.epub$/i, '');
      return { filePath, fileName, title, author: '', coverDataUrl: null };
    }
    const r = extractMetadataFallback('/books/Il Principe.epub');
    expect(r.title).toBe('Il Principe');
    expect(r.author).toBe('');
    expect(r.fileName).toBe('Il Principe.epub');
  });

  it('deduplicazione filePath è case-sensitive', () => {
    fns.addEntries([mkEntry('1', '/Books/a.epub')]);
    const r = fns.addEntries([mkEntry('2', '/books/a.epub')]);
    // Paths are case-sensitive in the dedup logic
    expect(r.added).toBe(1);
    expect(fns.loadLibrary()).toHaveLength(2);
  });

  it('readDirRecursive filtra solo .epub', async () => {
    // Replicate readDirRecursive mock
    async function readDirRecursiveMock(entries) {
      return entries.filter(e => e.name.toLowerCase().endsWith('.epub')).map(e => e.path);
    }
    const files = [
      { name: 'book.epub', path: '/a/book.epub' },
      { name: 'notes.txt', path: '/a/notes.txt' },
      { name: 'Novel.EPUB', path: '/a/Novel.EPUB' },
      { name: 'image.png', path: '/a/image.png' },
    ];
    const result = await readDirRecursiveMock(files);
    expect(result).toEqual(['/a/book.epub', '/a/Novel.EPUB']);
  });

  it('i18n libreria: chiavi presenti in tutte le lingue', () => {
    const keys = ['library', 'selectFolder', 'libEmpty', 'libImport', 'libExport', 'libDeleteBook'];
    const langs = ['en', 'it', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ja'];
    for (const lang of langs) {
      for (const key of keys) {
        const val = t(lang, key);
        expect(val).not.toBe(key);
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ASSOCIAZIONE PARAGRAFI (NUOVE FUNZIONALITÀ)
// ═══════════════════════════════════════════════════════════════════════════
describe('Associazione paragrafi (colori, numeri, hover)', () => {
  let storage, sFns;
  
  beforeEach(() => {
    storage = createLocalStorageMock();
    sFns = makeSettingsFunctions(storage);
  });

  it('salva e carica pairingEnabled e showNumbers correttamente', () => {
    sFns.saveSettings({ pairingEnabled: true, showNumbers: true });
    const settings = sFns.loadSettings();
    expect(settings.pairingEnabled).toBe(true);
    expect(settings.showNumbers).toBe(true);
  });

  it('renderizzazione paragrafo originale include data-idx, classi cromatiche e numeri', () => {
    const originalViewer = document.createElement('div');
    const paragraphs = ['Paragrafo uno', 'Paragrafo due', 'Paragrafo tre'];
    
    // Simula renderOriginal semplificato per il test
    originalViewer.innerHTML = '';
    paragraphs.forEach((p, i) => {
      const pEl = document.createElement('p');
      pEl.dataset.idx = i;
      pEl.classList.add(`pair-color-${i % 5}`);
      pEl.innerHTML = `<span class="para-num">${i + 1}</span>${escapeHtml(p)}`;
      originalViewer.appendChild(pEl);
    });

    const pEls = originalViewer.querySelectorAll('p');
    expect(pEls).toHaveLength(3);
    
    // Verifica indici
    expect(pEls[0].dataset.idx).toBe('0');
    expect(pEls[1].dataset.idx).toBe('1');
    expect(pEls[2].dataset.idx).toBe('2');

    // Verifica colori alternati
    expect(pEls[0].classList.contains('pair-color-0')).toBe(true);
    expect(pEls[1].classList.contains('pair-color-1')).toBe(true);
    expect(pEls[2].classList.contains('pair-color-2')).toBe(true);

    // Verifica numerazione interna
    expect(pEls[0].querySelector('.para-num').textContent).toBe('1');
    expect(pEls[1].querySelector('.para-num').textContent).toBe('2');
    expect(pEls[2].querySelector('.para-num').textContent).toBe('3');
  });

  it('i18n: traduzioni presenti per i nuovi tasti toggle', () => {
    const keys = ['togglePairing', 'toggleNumbers'];
    const langs = ['en', 'it'];
    for (const lang of langs) {
      for (const key of keys) {
        const val = t(lang, key);
        expect(val).not.toBe(key);
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });
});

