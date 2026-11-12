import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { translations } from './i18n.js';

// Feature: tts-download-and-languages, Property 5: New locale completeness — every key in `en` exists in each new locale
// **Validates: Requirements 3.3, 4.3, 5.3**
describe('Property 5: New locale completeness — every key in `en` exists in each new locale', () => {
  const enKeys = Object.keys(translations.en);

  it('translations.sv contains every key from translations.en with a non-empty string value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...enKeys), (key) => {
        expect(translations.sv).toHaveProperty(key);
        expect(typeof translations.sv[key]).toBe('string');
        expect(translations.sv[key].length).toBeGreaterThan(0);
      }),
      { numRuns: Math.max(100, enKeys.length) }
    );
  });

  it('translations.uk contains every key from translations.en with a non-empty string value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...enKeys), (key) => {
        expect(translations.uk).toHaveProperty(key);
        expect(typeof translations.uk[key]).toBe('string');
        expect(translations.uk[key].length).toBeGreaterThan(0);
      }),
      { numRuns: Math.max(100, enKeys.length) }
    );
  });

  it('translations.sl contains every key from translations.en with a non-empty string value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...enKeys), (key) => {
        expect(translations.sl).toHaveProperty(key);
        expect(typeof translations.sl[key]).toBe('string');
        expect(translations.sl[key].length).toBeGreaterThan(0);
      }),
      { numRuns: Math.max(100, enKeys.length) }
    );
  });

  it('all locales contain the new TTS download keys with non-empty string values', () => {
    const ttsDownloadKeys = ['tts_download', 'tts_download_pro_only', 'tts_progress'];
    const allLocales = Object.keys(translations);

    fc.assert(
      fc.property(
        fc.constantFrom(...allLocales),
        fc.constantFrom(...ttsDownloadKeys),
        (locale, key) => {
          expect(translations[locale]).toHaveProperty(key);
          expect(typeof translations[locale][key]).toBe('string');
          expect(translations[locale][key].length).toBeGreaterThan(0);
        }
      ),
      { numRuns: Math.max(100, allLocales.length * ttsDownloadKeys.length) }
    );
  });
});

describe('every locale matches `en`', () => {
  const enKeys = Object.keys(translations.en);
  const locales = Object.keys(translations).filter((l) => l !== 'en');
  const placeholders = (s) => (s.match(/\{[^{}]*\}/g) || []).sort();

  it.each(locales)('%s has exactly the keys of en', (locale) => {
    const keys = Object.keys(translations[locale]);
    expect(enKeys.filter((k) => !keys.includes(k))).toEqual([]);
    expect(keys.filter((k) => !enKeys.includes(k))).toEqual([]);
  });

  // The translation script can translate a placeholder name ("{added}" → "{已添加}"),
  // which then is not replaced at runtime.
  it.each(locales)('%s keeps the {placeholders} of en', (locale) => {
    const wrong = enKeys.filter((k) => {
      const value = translations[locale][k];
      return typeof value === 'string'
        && placeholders(value).join() !== placeholders(translations.en[k]).join();
    });
    expect(wrong).toEqual([]);
  });
});
