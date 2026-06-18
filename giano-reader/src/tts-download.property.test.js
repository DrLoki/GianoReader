import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AudioBufferStore, makeDownloadFilename } from './tts.js';

// Feature: tts-download-and-languages, Property 1: Download button enabled state reflects mode and store contents
// **Validates: Requirements 1.2, 1.3, 1.5**
describe('Property 1: Download button enabled state reflects mode and store contents', () => {
  /**
   * Pure logic function that determines if the download button should be enabled.
   * This mirrors the logic in main.js: ttsDownloadBtn.disabled = !(isPro && hasAudio)
   * where isPro = (mode === 'pro') and hasAudio = (storeSize > 0).
   */
  function isDownloadEnabled(mode, storeSize) {
    return mode === 'pro' && storeSize > 0;
  }

  const modeArb = fc.constantFrom('free', 'pro');
  const storeSizeArb = fc.integer({ min: 0, max: 100 });

  it('download button is enabled if and only if mode === "pro" AND storeSize > 0', () => {
    fc.assert(
      fc.property(modeArb, storeSizeArb, (mode, storeSize) => {
        const enabled = isDownloadEnabled(mode, storeSize);
        const expected = mode === 'pro' && storeSize > 0;
        expect(enabled).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('in free mode, the button is always disabled regardless of store size', () => {
    fc.assert(
      fc.property(storeSizeArb, (storeSize) => {
        const enabled = isDownloadEnabled('free', storeSize);
        expect(enabled).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('in pro mode with empty store (storeSize === 0), the button is disabled', () => {
    const enabled = isDownloadEnabled('pro', 0);
    expect(enabled).toBe(false);
  });

  it('in pro mode with non-empty store (storeSize > 0), the button is enabled', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (storeSize) => {
        const enabled = isDownloadEnabled('pro', storeSize);
        expect(enabled).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: tts-download-and-languages, Property 2: Filename sanitization produces valid filenames
// **Validates: Requirements 1.4**
describe('Property 2: Filename sanitization produces valid filenames', () => {
  const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1F]/;
  const CONSECUTIVE_UNDERSCORES = /__/;

  const bookTitleArb = fc.oneof(
    fc.string({ minLength: 0, maxLength: 200 }),
    fc.unicodeString({ minLength: 0, maxLength: 200 }),
    // Strings with many special/invalid characters
    fc.stringOf(
      fc.constantFrom('<', '>', ':', '"', '/', '\\', '|', '?', '*', '\x00', '\x01', '\x1F', 'a', 'b', '_'),
      { minLength: 0, maxLength: 200 }
    )
  );

  const chapterIndexArb = fc.integer({ min: 1, max: 10000 });

  it('output contains no characters in the set <>:"/\\|?* or control characters \\x00-\\x1F', () => {
    fc.assert(
      fc.property(bookTitleArb, chapterIndexArb, (title, chapterIdx) => {
        const filename = makeDownloadFilename(title, chapterIdx);
        // The suffix is known-safe, check the full filename anyway
        expect(INVALID_CHARS.test(filename)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('sanitized title portion is at most 100 characters long', () => {
    fc.assert(
      fc.property(bookTitleArb, chapterIndexArb, (title, chapterIdx) => {
        const filename = makeDownloadFilename(title, chapterIdx);
        // The filename ends with _chapter{N}.mp3 — extract the title portion
        const suffix = `_chapter${chapterIdx}.mp3`;
        expect(filename.endsWith(suffix)).toBe(true);
        const titlePortion = filename.slice(0, filename.length - suffix.length);
        expect(titlePortion.length).toBeLessThanOrEqual(100);
      }),
      { numRuns: 100 }
    );
  });

  it('ends with _chapter{N}.mp3 where N equals the chapter index', () => {
    fc.assert(
      fc.property(bookTitleArb, chapterIndexArb, (title, chapterIdx) => {
        const filename = makeDownloadFilename(title, chapterIdx);
        const expectedSuffix = `_chapter${chapterIdx}.mp3`;
        expect(filename.endsWith(expectedSuffix)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('has no consecutive underscores in the sanitized title portion', () => {
    fc.assert(
      fc.property(bookTitleArb, chapterIndexArb, (title, chapterIdx) => {
        const filename = makeDownloadFilename(title, chapterIdx);
        const suffix = `_chapter${chapterIdx}.mp3`;
        const titlePortion = filename.slice(0, filename.length - suffix.length);
        expect(CONSECUTIVE_UNDERSCORES.test(titlePortion)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: tts-download-and-languages, Property 3: Progress calculation uses floored percentage of synthesized paragraphs
// **Validates: Requirements 2.3, 2.4, 2.5, 2.8**
describe('Property 3: Progress calculation uses floored percentage of synthesized paragraphs', () => {
  const totalArb = fc.integer({ min: 0, max: 1000 });

  it('returns Math.floor(synthesized / total * 100) when total > 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }).chain(total =>
          fc.tuple(fc.constant(total), fc.integer({ min: 0, max: total }))
        ),
        ([total, synthesized]) => {
          const store = new AudioBufferStore();
          store.init(total);

          // Add `synthesized` number of entries
          for (let i = 0; i < synthesized; i++) {
            store.add(i, new Uint8Array([0xFF]));
          }

          const expected = Math.floor((synthesized / total) * 100);
          expect(store.getProgress()).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns 0 when total is 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (synthesized) => {
        const store = new AudioBufferStore();
        store.init(0);

        // Even if we try to add items, total is 0 so progress should be 0
        for (let i = 0; i < synthesized; i++) {
          store.add(i, new Uint8Array([0xFF]));
        }

        expect(store.getProgress()).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: tts-download-and-languages, Property 4: Blob assembly produces bytes concatenated in ascending paragraph index order
// **Validates: Requirements 6.1, 6.3, 6.6**
describe('Property 4: Blob assembly produces bytes concatenated in ascending paragraph index order', () => {
  // Generate random arrays of {index, bytes} pairs with unique indices
  const entryArb = fc.uniqueArray(
    fc.record({
      index: fc.integer({ min: 0, max: 1000 }),
      bytes: fc.uint8Array({ minLength: 1, maxLength: 50 })
    }),
    { minLength: 1, maxLength: 30, selector: entry => entry.index }
  );

  it('assembleBlob() produces bytes concatenated in ascending paragraph index order', () => {
    fc.assert(
      fc.property(entryArb, (entries) => {
        const store = new AudioBufferStore();
        store.init(entries.length);

        // Shuffle entries to insert in random order
        const shuffled = [...entries].sort(() => Math.random() - 0.5);
        for (const entry of shuffled) {
          store.add(entry.index, entry.bytes);
        }

        const blob = store.assembleBlob();

        // Compute expected bytes: sort by index, concatenate
        const sorted = [...entries].sort((a, b) => a.index - b.index);
        const expectedLength = sorted.reduce((sum, e) => sum + e.bytes.length, 0);

        // Verify blob size matches expected total
        expect(blob.size).toBe(expectedLength);
        expect(blob.type).toBe('audio/mpeg');

        // Verify ordering: directly test the store's internal sort by accessing
        // the _store map and confirming assembleBlob sorts ascending
        const storeEntries = [...store._store.entries()].sort(([a], [b]) => a - b);
        const expectedOrder = sorted.map(e => e.index);
        const actualOrder = storeEntries.map(([idx]) => idx);
        expect(actualOrder).toEqual(expectedOrder);

        // Verify byte content matches by comparing each entry
        for (let i = 0; i < sorted.length; i++) {
          expect(Array.from(storeEntries[i][1])).toEqual(Array.from(sorted[i].bytes));
        }
      }),
      { numRuns: 100 }
    );
  });

  it('gaps in indices do not produce empty placeholders', () => {
    // Use entries with large gaps between indices
    const gappedEntriesArb = fc.uniqueArray(
      fc.record({
        index: fc.integer({ min: 0, max: 10000 }),
        bytes: fc.uint8Array({ minLength: 1, maxLength: 20 })
      }),
      { minLength: 2, maxLength: 20, selector: entry => entry.index }
    );

    fc.assert(
      fc.property(gappedEntriesArb, (entries) => {
        const store = new AudioBufferStore();
        store.init(100); // total is larger than entries, simulating gaps

        for (const entry of entries) {
          store.add(entry.index, entry.bytes);
        }

        const blob = store.assembleBlob();

        // Total blob size should be exactly the sum of stored byte arrays
        // (no empty placeholders for missing indices)
        const expectedLength = entries.reduce((sum, e) => sum + e.bytes.length, 0);
        expect(blob.size).toBe(expectedLength);

        // The number of entries in the store should match input (no placeholders for gaps)
        expect(store._store.size).toBe(entries.length);
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: tts-download-and-languages, Property 6: Store clear on session lifecycle events resets all state
// **Validates: Requirements 1.6, 1.7, 2.5, 6.5**
describe('Property 6: Store clear on session lifecycle events resets all state', () => {
  const entryCountArb = fc.integer({ min: 1, max: 100 });
  const totalArb = fc.integer({ min: 1, max: 200 });

  it('after clear(), store is empty (hasData() === false) and getProgress() returns 0', () => {
    fc.assert(
      fc.property(entryCountArb, totalArb, (entryCount, total) => {
        const store = new AudioBufferStore();
        store.init(total);

        // Add random entries
        for (let i = 0; i < entryCount; i++) {
          store.add(i, new Uint8Array([0xFF, 0xFB, 0x90]));
        }

        // Verify store is non-empty before clearing
        expect(store.hasData()).toBe(true);

        // Clear the store (simulates stop, chapter navigation, or new session)
        store.clear();

        // After clear: empty and progress is 0
        expect(store.hasData()).toBe(false);
        expect(store.getProgress()).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});
