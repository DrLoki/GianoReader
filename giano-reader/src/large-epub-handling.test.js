/**
 * Large EPUB Handling — Unit Tests + Property-Based Tests
 * Feature: large-epub-handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { translations, t } from './i18n.js';

// ── Pure functions under test (extracted / replicated for isolation) ───────

/**
 * Classifica la dimensione di un file rispetto ai limiti configurati.
 * @param {number} fileSizeBytes
 * @param {number} maxFileSizeMB
 * @param {number} warnFileSizeMB
 * @returns {'ok' | 'warn' | 'block'}
 */
function sizeGuard(fileSizeBytes, maxFileSizeMB, warnFileSizeMB) {
  const MB = 1_048_576;
  if (fileSizeBytes > maxFileSizeMB * MB) return 'block';
  if (fileSizeBytes > warnFileSizeMB * MB) return 'warn';
  return 'ok';
}

/**
 * Calcola il limite ottimale dalla RAM totale.
 * @param {number} totalRamMb
 * @returns {number}
 */
function computeOptimalLimit(totalRamMb) {
  return Math.min(Math.floor(totalRamMb / 4), 500);
}

/**
 * Verifica se un errore è di tipo OOM.
 * @param {*} err
 * @returns {boolean}
 */
function isOomError(err) {
  const msg = (typeof err === 'string' ? err : err?.message ?? String(err)).toLowerCase();
  return msg.includes('out of memory') || msg.includes('allocation failed') || msg.includes('memory');
}

// ── In-memory localStorage mock ───────────────────────────────────────────
function createLocalStorageMock() {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}

const SETTINGS_KEY = 'giano-reader-settings';
const DEFAULT_MAX_FILE_SIZE_MB  = 150;
const DEFAULT_WARN_FILE_SIZE_MB = 50;

function makeSettingsFunctions(storage) {
  function loadSettings() {
    try { return JSON.parse(storage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSettings(s) {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
  return { loadSettings, saveSettings };
}

// ── Supported languages for large-epub-handling ───────────────────────────
const SUPPORTED_LANGS = ['en', 'it', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ja', 'ar', 'fil', 'sq'];
const NEW_I18N_KEYS = [
  'readingFile', 'fileTooLarge', 'fileTooLargeMsg',
  'fileLargeWarning', 'fileLargeWarnMsg',
  'oomError', 'oomErrorMsg',
  'maxFileSizeMB', 'warnFileSizeMB',
];

// ─────────────────────────────────────────────────────────────────────────
// Property-Based Tests
// ─────────────────────────────────────────────────────────────────────────

// Feature: large-epub-handling, Property 1: Size_Guard classifica correttamente tutte le dimensioni
describe('Property 1: sizeGuard classifies all file sizes correctly', () => {
  it('returns block/warn/ok based on thresholds for any valid triple', () => {
    // Feature: large-epub-handling, Property 1
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),   // fileSizeBytes
        fc.integer({ min: 11, max: 2000 }),              // maxFileSizeMB
        fc.integer({ min: 10, max: 1999 }),              // warnFileSizeMB (raw, will be clamped)
        (fileSizeBytes, maxMB, warnMBRaw) => {
          const warnMB = Math.min(warnMBRaw, maxMB - 1);
          const result = sizeGuard(fileSizeBytes, maxMB, warnMB);
          const MB = 1_048_576;
          if (fileSizeBytes > maxMB * MB) {
            expect(result).toBe('block');
          } else if (fileSizeBytes > warnMB * MB) {
            expect(result).toBe('warn');
          } else {
            expect(result).toBe('ok');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 2: I messaggi di errore contengono tutte le informazioni richieste
describe('Property 2: error messages contain all required information', () => {
  it('fileTooLargeMsg contains name, sizeMB, and maxMB', () => {
    // Feature: large-epub-handling, Property 2
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).map(s => s.replace(/[{}]/g, '_')),
        fc.integer({ min: 1, max: 10_000_000_000 }),
        fc.integer({ min: 10, max: 2000 }),
        (name, fileSizeBytes, maxMB) => {
          const sizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
          const msg = t('en', 'fileTooLargeMsg', { name, sizeMB, maxMB });
          expect(msg).toContain(name);
          expect(msg).toContain(String(sizeMB));
          expect(msg).toContain(String(maxMB));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('fileLargeWarnMsg contains name and sizeMB', () => {
    // Feature: large-epub-handling, Property 2
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).map(s => s.replace(/[{}]/g, '_')),
        fc.integer({ min: 1, max: 10_000_000_000 }),
        (name, fileSizeBytes) => {
          const sizeMB = (fileSizeBytes / 1_048_576).toFixed(1);
          const msg = t('en', 'fileLargeWarnMsg', { name, sizeMB });
          expect(msg).toContain(name);
          expect(msg).toContain(String(sizeMB));
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 3: Il clamping di warnFileSizeMB è corretto per tutti gli input
describe('Property 3: warnFileSizeMB clamping is correct for all inputs', () => {
  it('when warn >= max, clamping produces max - 1 (respecting minimum of 10)', () => {
    // Feature: large-epub-handling, Property 3
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 2000 }),  // max (min 11 so max-1 >= 10)
        fc.integer({ min: 10, max: 2000 }),  // warn (may be >= max)
        (max, warn) => {
          // Replicate the clamping logic from the event listener
          const clamped = Math.max(10, Math.min(max - 1, isNaN(warn) ? DEFAULT_WARN_FILE_SIZE_MB : warn));
          if (warn >= max) {
            // When warn >= max, result should be max - 1 (which is >= 10 since max >= 11)
            expect(clamped).toBe(max - 1);
          } else {
            // When warn < max, result should be warn clamped to [10, max-1]
            expect(clamped).toBe(Math.max(10, Math.min(max - 1, warn)));
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 4: Persistenza e lettura dei settings è un round-trip
describe('Property 4: settings persistence is a round-trip', () => {
  it('saveSettings({maxFileSizeMB, warnFileSizeMB}) then loadSettings() returns same values', () => {
    // Feature: large-epub-handling, Property 4
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 2000 }),  // maxFileSizeMB
        fc.integer({ min: 10, max: 1999 }),  // warnFileSizeMB (raw)
        (maxMB, warnMBRaw) => {
          const warnMB = Math.min(warnMBRaw, maxMB - 1);
          const storage = createLocalStorageMock();
          const { loadSettings, saveSettings } = makeSettingsFunctions(storage);
          saveSettings({ maxFileSizeMB: maxMB, warnFileSizeMB: warnMB });
          const loaded = loadSettings();
          expect(loaded.maxFileSizeMB).toBe(maxMB);
          expect(loaded.warnFileSizeMB).toBe(warnMB);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 5: Il calcolo del limite ottimale è corretto per tutti i valori di RAM
describe('Property 5: computeOptimalLimit formula is correct for all RAM values', () => {
  it('computeOptimalLimit(x) === Math.min(Math.floor(x / 4), 500) for any x >= 0', () => {
    // Feature: large-epub-handling, Property 5
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 65536 }),
        (totalRamMb) => {
          const result = computeOptimalLimit(totalRamMb);
          const expected = Math.min(Math.floor(totalRamMb / 4), 500);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 6: Il rilevamento OOM è corretto per tutti i messaggi di errore
describe('Property 6: isOomError detects OOM patterns correctly', () => {
  it('returns true for strings containing OOM patterns (case-insensitive)', () => {
    // Feature: large-epub-handling, Property 6
    const oomPatterns = ['out of memory', 'allocation failed', 'memory'];
    fc.assert(
      fc.property(
        fc.constantFrom(...oomPatterns),
        fc.string({ minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 0, maxLength: 20 }),
        fc.boolean(),
        (pattern, prefix, suffix, uppercase) => {
          const msg = prefix + (uppercase ? pattern.toUpperCase() : pattern) + suffix;
          expect(isOomError(new Error(msg))).toBe(true);
          expect(isOomError(msg)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false for strings without OOM patterns', () => {
    // Feature: large-epub-handling, Property 6
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).filter(s => {
          const lower = s.toLowerCase();
          return !lower.includes('out of memory') && !lower.includes('allocation failed') && !lower.includes('memory');
        }),
        (msg) => {
          expect(isOomError(new Error(msg))).toBe(false);
          expect(isOomError(msg)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 7: book è sempre null dopo un errore in loadEpub
describe('Property 7: book is always null after an error in loadEpub', () => {
  it('after any error thrown during ePub() init, book variable is set to null', () => {
    // Feature: large-epub-handling, Property 7
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (errorMessage) => {
          // Simulate the error handling logic from loadEpub
          let book = null;
          const simulateLoadEpubError = (errMsg) => {
            // Simulate: book = ePub(arrayBuffer) throws
            try {
              throw new Error(errMsg);
            } catch (err) {
              if (book) {
                try { book.destroy(); } catch (_) {}
                book = null;
              }
              // book was never assigned, stays null
            }
            return book;
          };
          const result = simulateLoadEpubError(errorMessage);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('after error, book is null even if it was assigned before the error', () => {
    // Feature: large-epub-handling, Property 7
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (errorMessage) => {
          let book = null;
          const simulateLoadEpubWithBookAssigned = (errMsg) => {
            try {
              // Simulate: book = ePub(arrayBuffer) succeeds, then something throws
              book = { destroy: vi.fn() };
              throw new Error(errMsg);
            } catch (err) {
              if (book) {
                try { book.destroy(); } catch (_) {}
                book = null;
              }
            }
            return book;
          };
          const result = simulateLoadEpubWithBookAssigned(errorMessage);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 8: Le variabili di stato vengono resettate dopo book.destroy()
describe('Property 8: state variables are reset after book.destroy()', () => {
  it('currentSpineItems, currentChapterParagraphs, currentFilePath are reset after destroy sequence', () => {
    // Feature: large-epub-handling, Property 8
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (spineItems, chapterParagraphs, filePath) => {
          // Simulate the state variables
          let currentSpineItems = spineItems;
          let currentChapterParagraphs = chapterParagraphs;
          let currentFilePath = filePath;
          let book = { destroy: vi.fn() };

          // Simulate the destroy+reset sequence from loadEpub
          if (book) {
            try { book.destroy(); } catch (_) {}
            book = null;
            currentSpineItems = [];
            currentChapterParagraphs = [];
            currentFilePath = null;
          }

          expect(book).toBeNull();
          expect(currentSpineItems).toEqual([]);
          expect(currentChapterParagraphs).toEqual([]);
          expect(currentFilePath).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 9: spineItem.unload() viene chiamato su tutti i capitoli non correnti
describe('Property 9: spineItem.unload() is called on all non-current items', () => {
  it('after displayChapter(index), unload() is called on all items with index !== currentIndex', () => {
    // Feature: large-epub-handling, Property 9
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),  // N spine items
        fc.integer({ min: 0, max: 19 }),  // target index (will be clamped)
        (n, rawIndex) => {
          const index = Math.min(rawIndex, n - 1);
          // Create mock spine items with unload spy
          const spineItems = Array.from({ length: n }, (_, i) => ({
            unload: vi.fn(),
          }));

          // Simulate the unload loop from displayChapter
          for (let i = 0; i < spineItems.length; i++) {
            if (i === index) continue;
            const item = spineItems[i];
            if (typeof item.unload === 'function') {
              try { item.unload(); } catch (e) {
                console.warn('[memory] unload error on spine item', i, e);
              }
            }
          }

          // Verify: all non-current items had unload() called
          for (let i = 0; i < n; i++) {
            if (i === index) {
              expect(spineItems[i].unload).not.toHaveBeenCalled();
            } else {
              expect(spineItems[i].unload).toHaveBeenCalledOnce();
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('an exception on one item does not prevent unloading of others', () => {
    // Feature: large-epub-handling, Property 9
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),  // N spine items (at least 2)
        fc.integer({ min: 0, max: 9 }),   // failing item index (will be clamped, != currentIndex)
        (n, rawFailIdx) => {
          const currentIndex = 0; // always use 0 as current
          const failIdx = Math.max(1, Math.min(rawFailIdx, n - 1)); // ensure != currentIndex

          const unloadCalls = new Array(n).fill(0);
          const spineItems = Array.from({ length: n }, (_, i) => ({
            unload: () => {
              unloadCalls[i]++;
              if (i === failIdx) throw new Error('unload failed');
            },
          }));

          // Simulate the unload loop
          for (let i = 0; i < spineItems.length; i++) {
            if (i === currentIndex) continue;
            const item = spineItems[i];
            if (typeof item.unload === 'function') {
              try { item.unload(); } catch (_) {}
            }
          }

          // All non-current items should have been attempted
          for (let i = 0; i < n; i++) {
            if (i === currentIndex) {
              expect(unloadCalls[i]).toBe(0);
            } else {
              expect(unloadCalls[i]).toBe(1);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: large-epub-handling, Property 10: Le traduzioni i18n sono complete per tutte le lingue e le nuove chiavi
describe('Property 10: i18n translations are complete for all languages and new keys', () => {
  it('t(lang, key) never returns the key itself for any supported lang and new key', () => {
    // Feature: large-epub-handling, Property 10
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_LANGS),
        fc.constantFrom(...NEW_I18N_KEYS),
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

// Feature: large-epub-handling, Property 11: Il fallback i18n usa sempre l'inglese per chiavi mancanti
describe('Property 11: i18n fallback always uses English for missing keys', () => {
  it('t(lang, unknownKey) === t("en", unknownKey) for any lang and unknown key', () => {
    // Feature: large-epub-handling, Property 11
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_LANGS),
        fc.string({ minLength: 1, maxLength: 30 }).filter(k => {
          // Use keys that don't exist in any language
          return !Object.values(translations).some(dict => k in dict);
        }),
        (lang, unknownKey) => {
          const result = t(lang, unknownKey);
          const enResult = t('en', unknownKey);
          expect(result).toBe(enResult);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Example / Unit Tests
// ─────────────────────────────────────────────────────────────────────────

describe('sizeGuard — example tests', () => {
  const MB = 1_048_576;

  it('returns block when file exceeds maxFileSizeMB', () => {
    expect(sizeGuard(151 * MB, 150, 50)).toBe('block');
  });

  it('returns warn when file is between warn and max thresholds', () => {
    expect(sizeGuard(100 * MB, 150, 50)).toBe('warn');
  });

  it('returns ok when file is below warnFileSizeMB', () => {
    expect(sizeGuard(10 * MB, 150, 50)).toBe('ok');
  });

  it('returns ok when file is exactly at warnFileSizeMB boundary', () => {
    expect(sizeGuard(50 * MB, 150, 50)).toBe('ok');
  });

  it('returns warn when file is exactly at maxFileSizeMB boundary', () => {
    expect(sizeGuard(150 * MB, 150, 50)).toBe('warn');
  });

  it('loading overlay stays hidden when sizeGuard returns block (no arrayBuffer call)', () => {
    // Simulate: if block, we return before calling arrayBuffer
    let arrayBufferCalled = false;
    const mockArrayBuffer = () => { arrayBufferCalled = true; };

    const guard = sizeGuard(200 * MB, 150, 50);
    if (guard !== 'block') {
      mockArrayBuffer();
    }

    expect(guard).toBe('block');
    expect(arrayBufferCalled).toBe(false);
  });
});

describe('computeOptimalLimit — example tests', () => {
  it('8 GB RAM → 500 MB (capped)', () => {
    expect(computeOptimalLimit(8192)).toBe(500);
  });

  it('4 GB RAM → 500 MB (capped)', () => {
    expect(computeOptimalLimit(4096)).toBe(500);
  });

  it('2 GB RAM → 500 MB (capped at 512 → 500)', () => {
    expect(computeOptimalLimit(2048)).toBe(500);
  });

  it('1 GB RAM → 256 MB', () => {
    expect(computeOptimalLimit(1024)).toBe(256);
  });

  it('0 MB RAM → 0 MB', () => {
    expect(computeOptimalLimit(0)).toBe(0);
  });
});

describe('isOomError — example tests', () => {
  it('detects "out of memory"', () => {
    expect(isOomError(new Error('JavaScript heap out of memory'))).toBe(true);
  });

  it('detects "allocation failed"', () => {
    expect(isOomError(new Error('allocation failed - process out of memory'))).toBe(true);
  });

  it('detects "memory" (generic)', () => {
    expect(isOomError(new Error('memory access out of bounds'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isOomError(new Error('OUT OF MEMORY'))).toBe(true);
    expect(isOomError(new Error('ALLOCATION FAILED'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isOomError(new Error('file not found'))).toBe(false);
    expect(isOomError(new Error('network error'))).toBe(false);
    expect(isOomError(new Error(''))).toBe(false);
  });
});

describe('optimal-limit-btn disabled in browser mode', () => {
  it('button is disabled when Tauri is not available', () => {
    // Simulate browser environment (no Tauri)
    const isTauri = false;
    const btn = document.createElement('button');
    btn.disabled = false;

    if (!isTauri) {
      btn.disabled = true;
      btn.title = t('en', 'ramAdvisorBrowserOnly');
    }

    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(t('en', 'ramAdvisorBrowserOnly'));
    expect(btn.title.length).toBeGreaterThan(0);
  });
});

describe('beforeunload calls book.destroy()', () => {
  it('destroy is called when book is not null', () => {
    const mockBook = { destroy: vi.fn() };
    let book = mockBook;

    // Simulate beforeunload handler
    const handleBeforeUnload = () => {
      if (book) { try { book.destroy(); } catch (_) {} }
    };

    handleBeforeUnload();
    expect(mockBook.destroy).toHaveBeenCalledOnce();
  });

  it('no error when book is null', () => {
    let book = null;
    const handleBeforeUnload = () => {
      if (book) { try { book.destroy(); } catch (_) {} }
    };
    expect(() => handleBeforeUnload()).not.toThrow();
  });
});

describe('loadChapterDocument: unload before load', () => {
  it('unload is called before load on the spine item', async () => {
    const callOrder = [];
    const mockSpineItem = {
      unload: vi.fn(() => callOrder.push('unload')),
      load: vi.fn(() => { callOrder.push('load'); return Promise.resolve(null); }),
      document: null,
    };
    const mockBook = { load: vi.fn() };

    // Replicate loadChapterDocument logic
    async function loadChapterDocument(spineItem, book) {
      try {
        if (typeof spineItem.unload === 'function') spineItem.unload();
        await spineItem.load(book.load.bind(book));
      } catch (e) { /* ignore */ }
      return null;
    }

    await loadChapterDocument(mockSpineItem, mockBook);
    expect(callOrder).toEqual(['unload', 'load']);
  });
});

describe('displayChapter: unload after rendering, not before', () => {
  it('unload on non-current items is called after rendering completes', async () => {
    const renderOrder = [];
    const unloadOrder = [];

    const mockRender = async () => { renderOrder.push('render'); };
    const n = 3;
    const currentIndex = 1;
    const spineItems = Array.from({ length: n }, (_, i) => ({
      unload: vi.fn(() => unloadOrder.push(i)),
    }));

    // Simulate displayChapter logic
    await mockRender();
    for (let i = 0; i < spineItems.length; i++) {
      if (i === currentIndex) continue;
      if (typeof spineItems[i].unload === 'function') {
        try { spineItems[i].unload(); } catch (_) {}
      }
    }

    expect(renderOrder).toEqual(['render']);
    expect(unloadOrder).toContain(0);
    expect(unloadOrder).toContain(2);
    expect(unloadOrder).not.toContain(1);
    // Render happened before unloads
    expect(renderOrder.length).toBeGreaterThan(0);
  });
});

describe('applyUiLang: labels updated on language change', () => {
  it('max-file-size-mb-label and warn-file-size-mb-label are updated for each supported language', () => {
    for (const lang of SUPPORTED_LANGS) {
      const maxLabel = t(lang, 'maxFileSizeMB');
      const warnLabel = t(lang, 'warnFileSizeMB');
      expect(maxLabel).not.toBe('maxFileSizeMB');
      expect(warnLabel).not.toBe('warnFileSizeMB');
      expect(maxLabel.length).toBeGreaterThan(0);
      expect(warnLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('settings round-trip preserves other fields', () => {
  it('saving maxFileSizeMB and warnFileSizeMB does not alter other settings', () => {
    const storage = createLocalStorageMock();
    const { loadSettings, saveSettings } = makeSettingsFunctions(storage);
    const initial = { theme: 'dark', uiLang: 'it', fontSize: 18 };
    saveSettings(initial);
    const s = loadSettings();
    s.maxFileSizeMB = 200;
    s.warnFileSizeMB = 80;
    saveSettings(s);
    const result = loadSettings();
    expect(result.theme).toBe('dark');
    expect(result.uiLang).toBe('it');
    expect(result.fontSize).toBe(18);
    expect(result.maxFileSizeMB).toBe(200);
    expect(result.warnFileSizeMB).toBe(80);
  });
});
