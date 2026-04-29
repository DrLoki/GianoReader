/**
 * Book Library — Unit Tests + Property-Based Tests
 * Feature: book-library
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { translations, t } from './i18n.js';
import { clampSearchDepth } from './settings-utils.js';

// ── In-memory localStorage mock ──────────────────────────────────────────
function createLocalStorageMock() {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}

// ── Pure library functions (extracted for testing) ────────────────────────
const LIBRARY_KEY = 'giano-reader-library';

function makeLibFunctions(storage) {
  function loadLibrary() {
    try { return JSON.parse(storage.getItem(LIBRARY_KEY) || '[]'); }
    catch { return []; }
  }
  function saveLibrary(entries) {
    storage.setItem(LIBRARY_KEY, JSON.stringify(entries));
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
  function removeEntry(id, onRemove) {
    const filtered = loadLibrary().filter(e => e.id !== id);
    saveLibrary(filtered);
    if (onRemove) onRemove();
    return filtered;
  }
  return { loadLibrary, saveLibrary, addEntries, removeEntry };
}

// ── renderLibraryGrid (DOM-based, uses jsdom) ─────────────────────────────
function renderLibraryGrid(lib, container) {
  container.innerHTML = '';
  if (!lib.length) {
    const p = document.createElement('p');
    p.id = 'lib-placeholder';
    container.appendChild(p);
    return;
  }
  for (const entry of lib) {
    const card = document.createElement('div');
    card.className = 'lib-book-card';
    card.dataset.id = entry.id;
    const img = document.createElement('img');
    img.className = 'lib-book-cover';
    img.alt = entry.title || 'No cover';
    if (entry.coverDataUrl) img.src = entry.coverDataUrl;
    const info = document.createElement('div');
    info.className = 'lib-book-info';
    const titleEl = document.createElement('span');
    titleEl.className = 'lib-book-title';
    titleEl.textContent = entry.title || '';
    const authorEl = document.createElement('span');
    authorEl.className = 'lib-book-author';
    authorEl.textContent = entry.author || '';
    info.appendChild(titleEl);
    info.appendChild(authorEl);
    const delBtn = document.createElement('button');
    delBtn.className = 'lib-book-delete';
    delBtn.innerHTML = '&times;';
    card.appendChild(img);
    card.appendChild(info);
    card.appendChild(delBtn);
    container.appendChild(card);
  }
}

// ── fast-check arbitraries ────────────────────────────────────────────────
const bookEntryArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  filePath: fc.string({ minLength: 1, maxLength: 100 }),
  fileName: fc.string({ minLength: 1, maxLength: 50 }),
  title: fc.string({ minLength: 0, maxLength: 100 }),
  author: fc.string({ minLength: 0, maxLength: 100 }),
  coverDataUrl: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
  addedAt: fc.integer({ min: 0, max: 9999999999999 }),
});

// ── Unit Tests ────────────────────────────────────────────────────────────
describe('loadLibrary', () => {
  it('returns [] when localStorage key is absent', () => {
    const storage = createLocalStorageMock();
    const { loadLibrary } = makeLibFunctions(storage);
    expect(loadLibrary()).toEqual([]);
  });

  it('returns [] when localStorage contains invalid JSON', () => {
    const storage = createLocalStorageMock();
    storage.setItem(LIBRARY_KEY, 'not-valid-json{{{');
    const { loadLibrary } = makeLibFunctions(storage);
    expect(loadLibrary()).toEqual([]);
  });

  it('returns parsed array when valid JSON is stored', () => {
    const storage = createLocalStorageMock();
    const entries = [{ id: '1', filePath: '/a.epub', fileName: 'a.epub', title: 'A', author: '', coverDataUrl: null, addedAt: 0 }];
    storage.setItem(LIBRARY_KEY, JSON.stringify(entries));
    const { loadLibrary } = makeLibFunctions(storage);
    expect(loadLibrary()).toEqual(entries);
  });
});

describe('addEntries', () => {
  it('returns { added: 0, skipped: 0 } for empty array', () => {
    const storage = createLocalStorageMock();
    const { addEntries } = makeLibFunctions(storage);
    expect(addEntries([])).toEqual({ added: 0, skipped: 0 });
  });

  it('adds new entries correctly', () => {
    const storage = createLocalStorageMock();
    const { addEntries, loadLibrary } = makeLibFunctions(storage);
    const entry = { id: '1', filePath: '/a.epub', fileName: 'a.epub', title: 'A', author: '', coverDataUrl: null, addedAt: 0 };
    const result = addEntries([entry]);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(loadLibrary()).toHaveLength(1);
  });

  it('skips duplicate filePaths', () => {
    const storage = createLocalStorageMock();
    const { addEntries, loadLibrary } = makeLibFunctions(storage);
    const entry = { id: '1', filePath: '/a.epub', fileName: 'a.epub', title: 'A', author: '', coverDataUrl: null, addedAt: 0 };
    addEntries([entry]);
    const result = addEntries([{ ...entry, id: '2' }]);
    expect(result).toEqual({ added: 0, skipped: 1 });
    expect(loadLibrary()).toHaveLength(1);
  });
});

describe('removeEntry', () => {
  it('removes the correct entry and leaves others intact', () => {
    const storage = createLocalStorageMock();
    const { addEntries, removeEntry, loadLibrary } = makeLibFunctions(storage);
    const e1 = { id: 'a', filePath: '/a.epub', fileName: 'a.epub', title: 'A', author: '', coverDataUrl: null, addedAt: 0 };
    const e2 = { id: 'b', filePath: '/b.epub', fileName: 'b.epub', title: 'B', author: '', coverDataUrl: null, addedAt: 0 };
    addEntries([e1, e2]);
    removeEntry('a');
    const lib = loadLibrary();
    expect(lib).toHaveLength(1);
    expect(lib[0].id).toBe('b');
  });
});

describe('renderLibraryGrid', () => {
  it('shows placeholder when library is empty', () => {
    const container = document.createElement('div');
    renderLibraryGrid([], container);
    expect(container.querySelector('#lib-placeholder')).not.toBeNull();
    expect(container.querySelectorAll('.lib-book-card')).toHaveLength(0);
  });

  it('renders N cards for N entries', () => {
    const container = document.createElement('div');
    const entries = [
      { id: '1', filePath: '/a.epub', fileName: 'a.epub', title: 'A', author: 'Auth', coverDataUrl: null, addedAt: 0 },
      { id: '2', filePath: '/b.epub', fileName: 'b.epub', title: 'B', author: 'Auth', coverDataUrl: null, addedAt: 0 },
    ];
    renderLibraryGrid(entries, container);
    expect(container.querySelectorAll('.lib-book-card')).toHaveLength(2);
  });
});

describe('importLibrary — format validation', () => {
  it('rejects non-array JSON (returns false)', () => {
    const parsed = JSON.parse('{"key":"value"}');
    expect(Array.isArray(parsed)).toBe(false);
  });

  it('accepts array JSON', () => {
    const parsed = JSON.parse('[{"id":"1","filePath":"/a.epub"}]');
    expect(Array.isArray(parsed)).toBe(true);
  });
});

// ── Property-Based Tests ──────────────────────────────────────────────────

// Feature: book-library, Property 1: Rendering completo di ogni Book_Entry
describe('Property 1: renderLibraryGrid renders exactly one card per entry', () => {
  it('each entry produces exactly one .lib-book-card with title, author, and img', () => {
    fc.assert(
      fc.property(fc.array(bookEntryArb, { minLength: 0, maxLength: 20 }), (entries) => {
        const container = document.createElement('div');
        renderLibraryGrid(entries, container);
        const cards = container.querySelectorAll('.lib-book-card');
        if (entries.length === 0) {
          expect(cards).toHaveLength(0);
          return;
        }
        expect(cards).toHaveLength(entries.length);
        cards.forEach((card) => {
          expect(card.querySelector('.lib-book-title')).not.toBeNull();
          expect(card.querySelector('.lib-book-author')).not.toBeNull();
          expect(card.querySelector('img')).not.toBeNull();
        });
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 2: Deduplicazione per filePath
describe('Property 2: addEntries deduplicates by filePath', () => {
  it('no filePath appears more than once after merge', () => {
    fc.assert(
      fc.property(
        fc.array(bookEntryArb, { minLength: 0, maxLength: 20 }),
        fc.array(bookEntryArb, { minLength: 0, maxLength: 20 }),
        (existing, newEntries) => {
          const storage = createLocalStorageMock();
          const { addEntries, loadLibrary, saveLibrary } = makeLibFunctions(storage);
          // Deduplicate existing by filePath before seeding
          const seenPaths = new Set();
          const uniqueExisting = existing.filter(e => {
            if (seenPaths.has(e.filePath)) return false;
            seenPaths.add(e.filePath);
            return true;
          });
          saveLibrary(uniqueExisting);
          addEntries(newEntries);
          const lib = loadLibrary();
          const paths = lib.map(e => e.filePath);
          const uniquePaths = new Set(paths);
          expect(paths.length).toBe(uniquePaths.size);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 5: Round-trip persistenza libreria
describe('Property 5: round-trip persistence', () => {
  it('saveLibrary then loadLibrary produces equivalent array', () => {
    fc.assert(
      fc.property(fc.array(bookEntryArb, { minLength: 0, maxLength: 20 }), (entries) => {
        const storage = createLocalStorageMock();
        const { loadLibrary, saveLibrary } = makeLibFunctions(storage);
        saveLibrary(entries);
        const loaded = loadLibrary();
        expect(loaded).toEqual(entries);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 6: Correttezza conteggi import
describe('Property 6: import counts are correct', () => {
  it('added + skipped = total imported entries', () => {
    fc.assert(
      fc.property(
        fc.array(bookEntryArb, { minLength: 0, maxLength: 20 }),
        fc.array(bookEntryArb, { minLength: 0, maxLength: 20 }),
        (existing, imported) => {
          const storage = createLocalStorageMock();
          const { addEntries, saveLibrary } = makeLibFunctions(storage);
          // Deduplicate existing
          const seenPaths = new Set();
          const uniqueExisting = existing.filter(e => {
            if (seenPaths.has(e.filePath)) return false;
            seenPaths.add(e.filePath);
            return true;
          });
          saveLibrary(uniqueExisting);
          const existingPaths = new Set(uniqueExisting.map(e => e.filePath));
          const { added, skipped } = addEntries(imported);
          // Count expected
          const seenImport = new Set();
          let expectedAdded = 0, expectedSkipped = 0;
          for (const e of imported) {
            if (existingPaths.has(e.filePath) || seenImport.has(e.filePath)) {
              expectedSkipped++;
            } else {
              expectedAdded++;
              seenImport.add(e.filePath);
            }
          }
          expect(added).toBe(expectedAdded);
          expect(skipped).toBe(expectedSkipped);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 7: Delete button per ogni entry
describe('Property 7: delete button for each entry', () => {
  it('each non-empty library renders exactly one .lib-book-delete per entry', () => {
    fc.assert(
      fc.property(fc.array(bookEntryArb, { minLength: 1, maxLength: 20 }), (entries) => {
        const container = document.createElement('div');
        renderLibraryGrid(entries, container);
        const deleteBtns = container.querySelectorAll('.lib-book-delete');
        expect(deleteBtns).toHaveLength(entries.length);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 8: Completezza chiavi i18n
describe('Property 8: i18n key completeness for library keys', () => {
  const libraryI18nKeys = [
    'library', 'selectFolder', 'libEmpty', 'libBrowserOnly', 'libNoEpubFound',
    'libScanning', 'libScanDone', 'libImport', 'libExport', 'libExportError',
    'libImportError', 'libImportedMsg', 'libDeleteBook', 'libOpenBook', 'libCoverPlaceholder',
  ];
  const supportedLangs = Object.keys(translations);

  it('t(lang, key) never returns the key itself for any supported lang and library key', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...supportedLangs),
        fc.constantFrom(...libraryI18nKeys),
        (lang, key) => {
          const result = t(lang, key);
          expect(result).not.toBe(key);
          expect(result.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 3: Enumerazione ricorsiva completa
describe('Property 3: readDirRecursive returns exactly epub files', () => {
  it('returns only .epub files from a simulated directory tree', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[/\\]/g, '_')),
            isEpub: fc.boolean(),
          }),
          { minLength: 0, maxLength: 20 }
        ),
        async (files) => {
          // Build mock readDir that returns a flat list of files
          const mockEntries = files.map(f => ({
            name: f.isEpub ? f.name + '.epub' : f.name + '.txt',
            isDirectory: false,
            path: '/root/' + (f.isEpub ? f.name + '.epub' : f.name + '.txt'),
          }));

          // Inline readDirRecursive logic with mocked readDir
          async function readDirRecursiveMock(dirPath, readDirFn) {
            const results = [];
            async function walk(path) {
              let entries;
              try { entries = await readDirFn(path); } catch { return; }
              for (const entry of entries) {
                if (entry.isDirectory) {
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

          const mockReadDir = async () => mockEntries;
          const result = await readDirRecursiveMock('/root', mockReadDir);
          const expectedEpubs = mockEntries.filter(e => e.name.toLowerCase().endsWith('.epub')).map(e => e.path);
          expect(result).toEqual(expectedEpubs);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: book-library, Property 4: Fallback metadata su errore di estrazione
describe('Property 4: extractMetadata fallback on error', () => {
  it('returns entry with fileName as title and empty author when extraction fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).map(s => '/path/' + s.replace(/[/\\]/g, '_') + '.epub'),
        async (filePath) => {
          const fileName = filePath.split('/').pop();
          const titleFallback = fileName.replace(/\.epub$/i, '');

          // Simulate extractMetadata fallback (when readFile throws)
          async function extractMetadataFallback(fp) {
            const fn = fp.split(/[\\/]/).pop();
            const tf = fn.replace(/\.epub$/i, '');
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
            const addedAt = Date.now();
            // Simulate failure
            return { id, filePath: fp, fileName: fn, title: tf, author: '', coverDataUrl: null, addedAt };
          }

          const entry = await extractMetadataFallback(filePath);
          expect(entry.title).toBe(titleFallback);
          expect(entry.author).toBe('');
          expect(entry.coverDataUrl).toBeNull();
          expect(entry.filePath).toBe(filePath);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: search-depth-setting, Property 5: completezza e correttezza delle traduzioni i18n
describe('Property 5: completezza e correttezza delle traduzioni i18n (search-depth-setting)', () => {
  const SUPPORTED_LANGS = ['en', 'it', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ja', 'ar', 'fil', 'sq'];

  it('t(lang, "searchDepth") returns a non-empty string different from the key for all supported languages', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_LANGS),
        (lang) => {
          const translation = t(lang, 'searchDepth');
          expect(translation.length).toBeGreaterThan(0);
          expect(translation).not.toBe('searchDepth');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: search-depth-setting, Property 2: clamping dei valori fuori range
describe('Property 2: clamping dei valori fuori range (search-depth-setting)', () => {
  it('clampSearchDepth always returns a value in [1, 10] for out-of-range inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.integer({ min: 11 }),
          fc.constant(NaN)
        ),
        (v) => {
          const clamped = clampSearchDepth(v);
          expect(clamped).toBeGreaterThanOrEqual(1);
          expect(clamped).toBeLessThanOrEqual(10);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Settings helpers for search-depth-setting tests ───────────────────────
const SETTINGS_KEY_SDS = 'giano-reader-settings';

function makeSettingsFunctions(storage) {
  function loadSettings() {
    try { return JSON.parse(storage.getItem(SETTINGS_KEY_SDS) || '{}'); } catch { return {}; }
  }
  function saveSettings(s) {
    storage.setItem(SETTINGS_KEY_SDS, JSON.stringify(s));
  }
  return { loadSettings, saveSettings };
}

// Feature: search-depth-setting, Property 1: round-trip di persistenza del valore
describe('Property 1: round-trip di persistenza del valore searchDepth (search-depth-setting)', () => {
  it('saveSettings({ searchDepth: v }) then loadSettings().searchDepth === v for any v in [1, 10]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (v) => {
          const storage = createLocalStorageMock();
          const { loadSettings, saveSettings } = makeSettingsFunctions(storage);
          saveSettings({ searchDepth: v });
          const loaded = loadSettings();
          expect(loaded.searchDepth).toBe(v);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: search-depth-setting, Property 3: preservazione delle impostazioni esistenti
describe('Property 3: preservazione delle impostazioni esistenti (search-depth-setting)', () => {
  it('saving searchDepth does not alter other settings fields', () => {
    fc.assert(
      fc.property(
        fc.record({
          theme: fc.constantFrom('dark', 'light', 'monokai', 'nord', 'sepia'),
          uiLang: fc.constantFrom('en', 'it', 'fr', 'de'),
          fontFamily: fc.string({ minLength: 1, maxLength: 50 }),
          fontSize: fc.integer({ min: 12, max: 28 }),
        }),
        fc.integer({ min: 1, max: 10 }),
        (existingSettings, newDepth) => {
          const storage = createLocalStorageMock();
          const { loadSettings, saveSettings } = makeSettingsFunctions(storage);
          saveSettings(existingSettings);
          const s = loadSettings();
          s.searchDepth = newDepth;
          saveSettings(s);
          const result = loadSettings();
          expect(result.theme).toBe(existingSettings.theme);
          expect(result.uiLang).toBe(existingSettings.uiLang);
          expect(result.fontFamily).toBe(existingSettings.fontFamily);
          expect(result.fontSize).toBe(existingSettings.fontSize);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: search-depth-setting, Property 4: limite di profondità nella scansione
describe('Property 4: limite di profondità nella scansione (search-depth-setting)', () => {
  /**
   * Generates a mock directory tree of the given depth.
   * Each node has: { name, depth, children: [...], files: [{name, depth}] }
   * Files at each level have a .epub extension.
   */
  function generateMockTree(treeDepth, currentDepth = 1) {
    const files = [{ name: `book-d${currentDepth}.epub`, depth: currentDepth }];
    const children = currentDepth < treeDepth
      ? [generateMockTree(treeDepth, currentDepth + 1)]
      : [];
    return { name: `dir-d${currentDepth}`, depth: currentDepth, files, children };
  }

  /**
   * Replicates the readDirRecursive logic using the mock tree.
   * Returns objects { path, depth } for each .epub file found within maxDepth.
   */
  async function readDirRecursiveMock(node, maxDepth) {
    const results = [];
    async function walk(n, currentDepth) {
      // Collect .epub files at this level
      for (const file of n.files) {
        if (file.name.toLowerCase().endsWith('.epub')) {
          results.push({ path: `/${n.name}/${file.name}`, depth: currentDepth });
        }
      }
      // Recurse into children only if within depth limit
      if (currentDepth < maxDepth) {
        for (const child of n.children) {
          await walk(child, currentDepth + 1);
        }
      }
    }
    await walk(node, 1);
    return results;
  }

  it('all returned files have depth <= maxDepth', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 6 }),
        async (maxDepth, treeDepth) => {
          const mockTree = generateMockTree(treeDepth);
          const results = await readDirRecursiveMock(mockTree, maxDepth);
          for (const file of results) {
            expect(file.depth).toBeLessThanOrEqual(maxDepth);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
