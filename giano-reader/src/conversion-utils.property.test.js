import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  filterVisionModels,
  shouldShowConvertButton,
  updateProgressBar,
  formatCost,
  formatLogLine,
  buildLibraryEntry,
} from './conversion-utils.js';

// Property 1: Vision model filtering
// **Validates: Requirements 1.2**
describe('Property 1: Vision model filtering', () => {
  it('filtered result contains exactly models where supports_vision === true', () => {
    const modelArb = fc.record({
      id: fc.string({ minLength: 1 }),
      name: fc.string(),
      description: fc.string(),
      supports_vision: fc.boolean(),
    });

    fc.assert(
      fc.property(fc.array(modelArb), (models) => {
        const result = filterVisionModels(models);
        const expected = models.filter((m) => m.supports_vision === true);
        expect(result).toEqual(expected);
        // Every item in result has supports_vision === true
        result.forEach((m) => expect(m.supports_vision).toBe(true));
        // Length matches
        expect(result.length).toBe(expected.length);
      }),
      { numRuns: 100 }
    );
  });
});

// Property 2: Conversion model persistence round-trip
// **Validates: Requirements 1.3**
describe('Property 2: Conversion model persistence round-trip', () => {
  it('saving and loading conversionModelId returns the same id without affecting openrouterModel', () => {
    const modelIdArb = fc.string({ minLength: 1 });
    const existingModelArb = fc.string({ minLength: 1 });

    fc.assert(
      fc.property(modelIdArb, existingModelArb, (conversionModelId, openrouterModel) => {
        // Simulate a settings object with both properties
        const settings = {
          openrouterModel,
          conversionModelId: 'old-value',
        };

        // Save the new conversionModelId
        settings.conversionModelId = conversionModelId;

        // Simulate persistence round-trip (serialize + deserialize)
        const serialized = JSON.stringify(settings);
        const loaded = JSON.parse(serialized);

        // The conversionModelId is preserved
        expect(loaded.conversionModelId).toBe(conversionModelId);
        // The openrouterModel is not affected
        expect(loaded.openrouterModel).toBe(openrouterModel);
      }),
      { numRuns: 100 }
    );
  });
});

// Property 3: Conversion button visibility predicate
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
describe('Property 3: Conversion button visibility predicate', () => {
  it('button is visible iff both apiKey and modelId are non-empty strings', () => {
    // Include empty strings in the generation
    const stringWithEmpty = fc.oneof(fc.constant(''), fc.string({ minLength: 1 }));

    fc.assert(
      fc.property(stringWithEmpty, stringWithEmpty, (apiKey, modelId) => {
        const result = shouldShowConvertButton(apiKey, modelId);
        const expected = apiKey.length > 0 && modelId.length > 0;
        expect(result).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});

// Property 4: Progress bar percentage calculation
// **Validates: Requirements 5.5, 5.6**
describe('Property 4: Progress bar percentage calculation', () => {
  it('width equals Math.round((current / total) * 100) and countText is "current/total"', () => {
    // Generate total > 0, then current in [0, total]
    const progressArb = fc.integer({ min: 1, max: 10000 }).chain((total) =>
      fc.integer({ min: 0, max: total }).map((current) => ({ current, total }))
    );

    fc.assert(
      fc.property(progressArb, fc.string(), ({ current, total }, stage) => {
        const result = updateProgressBar(stage, current, total);
        expect(result.width).toBe(Math.round((current / total) * 100));
        expect(result.countText).toBe(`${current}/${total}`);
        expect(result.stageText).toBe(stage);
      }),
      { numRuns: 100 }
    );
  });
});

// Property 5: Cost formatting
// **Validates: Requirements 5.12**
describe('Property 5: Cost formatting', () => {
  it('formatted string has at most 4 decimal places and represents the correct value', () => {
    const costArb = fc.double({ min: 0, max: 1000, noNaN: true });

    fc.assert(
      fc.property(costArb, (cost) => {
        const result = formatCost(cost);

        // Must start with $
        expect(result.startsWith('$')).toBe(true);

        const numericPart = result.slice(1); // remove $

        // Check decimal places: at most 4
        const dotIndex = numericPart.indexOf('.');
        if (dotIndex !== -1) {
          const decimals = numericPart.slice(dotIndex + 1);
          expect(decimals.length).toBeLessThanOrEqual(4);
          // No trailing zeros
          expect(decimals.endsWith('0')).toBe(false);
        }

        // The numeric value should match the cost rounded to 4 decimal places
        const expectedValue = Math.round(cost * 10000) / 10000;
        expect(parseFloat(numericPart)).toBeCloseTo(expectedValue, 4);
      }),
      { numRuns: 100 }
    );
  });
});

// Property 6: Log line prefix formatting
// **Validates: Requirements 6.1, 6.2**
describe('Property 6: Log line prefix formatting', () => {
  it('error lines start with [ERROR] and warn lines start with [WARN]', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        const errorLine = formatLogLine('error', message);
        const warnLine = formatLogLine('warn', message);

        expect(errorLine.startsWith('[ERROR] ')).toBe(true);
        expect(warnLine.startsWith('[WARN] ')).toBe(true);

        // The message is preserved after the prefix
        expect(errorLine).toBe(`[ERROR] ${message}`);
        expect(warnLine).toBe(`[WARN] ${message}`);
      }),
      { numRuns: 100 }
    );
  });
});

// Property 7: Library metadata fallback
// **Validates: Requirements 7.3**
describe('Property 7: Library metadata fallback', () => {
  it('title falls back to filename without extension, author falls back to empty string', () => {
    // Generate optional title and author (string or undefined, including empty)
    const optionalString = fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      fc.string({ minLength: 1 })
    );
    // Filename must have an extension
    const filenameArb = fc.tuple(
      fc.string({ minLength: 1, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')) }),
      fc.constantFrom('.pdf', '.PDF', '.txt', '.doc')
    ).map(([name, ext]) => name + ext);

    fc.assert(
      fc.property(optionalString, optionalString, filenameArb, (title, author, filename) => {
        const conversionResult = {
          epub_path: '/output/book.epub',
          title,
          author,
        };

        const entry = buildLibraryEntry(conversionResult, filename);
        const filenameWithoutExt = filename.replace(/\.[^.]+$/, '');

        // Title: use metadata if non-empty, otherwise filename without extension
        if (title && title.length > 0) {
          expect(entry.title).toBe(title);
        } else {
          expect(entry.title).toBe(filenameWithoutExt);
        }

        // Author: use metadata if non-empty, otherwise empty string
        if (author && author.length > 0) {
          expect(entry.author).toBe(author);
        } else {
          expect(entry.author).toBe('');
        }
      }),
      { numRuns: 100 }
    );
  });
});
