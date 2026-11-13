import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  BookTranslationCache, textKey, variantKey, parseVariant, normalizeCacheData, CACHE_VERSION,
} from './translation-cache.js';

const IT_FREE = variantKey('it', 'free');
const IT_PRO = variantKey('it', 'pro');

describe('textKey', () => {
  it('is stable and 14 hex digits long', () => {
    expect(textKey('Hello')).toBe(textKey('Hello'));
    expect(textKey('Hello')).toMatch(/^[0-9a-f]{14}$/);
  });

  it('tells different paragraphs apart', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      if (a !== b) expect(textKey(a)).not.toBe(textKey(b));
    }), { numRuns: 500 });
  });
});

describe('variants', () => {
  it('round-trips language and engine, including languages with a dash', () => {
    expect(parseVariant(variantKey('pt-BR', 'pro'))).toEqual({ lang: 'pt-BR', engine: 'pro' });
    expect(variantKey('it')).toBe('it|free');
  });
});

describe('BookTranslationCache', () => {
  it('stores and returns translations per variant', () => {
    const cache = new BookTranslationCache();
    cache.set(IT_FREE, 'Hello', 'Ciao');
    expect(cache.get(IT_FREE, 'Hello')).toBe('Ciao');
    expect(cache.get(IT_PRO, 'Hello')).toBeUndefined();
    expect(cache.dirty).toBe(true);
  });

  it('never caches an empty translation', () => {
    const cache = new BookTranslationCache();
    cache.set(IT_FREE, 'Hello', '   ');
    cache.set(IT_FREE, '', 'x');
    expect(cache.has(IT_FREE, 'Hello')).toBe(false);
    expect(cache.dirty).toBe(false);
  });

  it('forgets selected translations and whole variants', () => {
    const cache = new BookTranslationCache();
    cache.set(IT_FREE, 'a', 'A');
    cache.set(IT_FREE, 'b', 'B');
    cache.forget(IT_FREE, ['a']);
    expect(cache.has(IT_FREE, 'a')).toBe(false);
    expect(cache.has(IT_FREE, 'b')).toBe(true);
    cache.clearVariant(IT_FREE);
    expect(cache.has(IT_FREE, 'b')).toBe(false);
  });

  it('survives a save and load', () => {
    const cache = new BookTranslationCache(null, { filePath: '/b.epub', title: 'B' });
    cache.set(IT_FREE, 'Hello', 'Ciao');
    cache.setStructure([{ label: 'One', texts: ['Hello'] }], 500);
    const loaded = new BookTranslationCache(JSON.parse(JSON.stringify(cache.toJSON())));
    expect(loaded.get(IT_FREE, 'Hello')).toBe('Ciao');
    expect(loaded.getStructure(500)).not.toBeNull();
    expect(loaded.data.book).toEqual({ filePath: '/b.epub', title: 'B' });
    expect(loaded.dirty).toBe(false);
  });

  describe('stats', () => {
    function bookCache() {
      const cache = new BookTranslationCache();
      cache.setStructure([
        { label: 'Chapter 1', texts: ['aaaa', 'bb'] },   // 6 chars
        { label: 'Chapter 2', texts: ['cccccc', 'dd'] }, // 8 chars
      ], 1000);
      return cache;
    }

    it('is unknown until the structure is known', () => {
      expect(new BookTranslationCache().stats(IT_FREE)).toBeNull();
    });

    it('counts paragraphs, characters and complete chapters', () => {
      const cache = bookCache();
      cache.set(IT_FREE, 'aaaa', 'AAAA');
      cache.set(IT_FREE, 'bb', 'BB');
      cache.set(IT_FREE, 'dd', 'DD');
      const stats = cache.stats(IT_FREE, 1000);
      expect(stats).toMatchObject({
        paragraphs: 4, translatedParagraphs: 3, chars: 14, translatedChars: 8,
        missingChars: 6, percent: 57, completeChapters: 1,
      });
      expect(stats.chapters).toEqual([
        { label: 'Chapter 1', paragraphs: 2, translated: 2, percent: 100 },
        { label: 'Chapter 2', paragraphs: 2, translated: 1, percent: 50 },
      ]);
    });

    it('drops a structure read from a book file of another size', () => {
      const cache = bookCache();
      expect(cache.stats(IT_FREE, 1000)).not.toBeNull();
      expect(cache.stats(IT_FREE, 1234)).toBeNull();
    });

    it('lists the cached variants, most complete first', () => {
      const cache = bookCache();
      cache.set(IT_FREE, 'aaaa', 'A');
      cache.set(IT_PRO, 'aaaa', 'A');
      cache.set(IT_PRO, 'cccccc', 'C');
      expect(cache.variants(1000).map((v) => [v.variant, v.cached, v.percent])).toEqual([
        [IT_PRO, 2, 71],
        [IT_FREE, 1, 28],
      ]);
    });
  });
});

describe('normalizeCacheData', () => {
  it('rejects data of another version or shape', () => {
    expect(normalizeCacheData(null).translations).toEqual({});
    expect(normalizeCacheData({ version: CACHE_VERSION + 1, translations: { x: { a: 'b' } } }).translations).toEqual({});
  });

  it('drops invalid entries and structures', () => {
    const data = normalizeCacheData({
      version: CACHE_VERSION,
      translations: { 'it|free': { k1: 'ok', k2: '', k3: 7 }, broken: 'x' },
      structure: { fileSize: 5, chapters: [{ keys: ['a'], lengths: [] }] },
    });
    expect(data.translations).toEqual({ 'it|free': { k1: 'ok' } });
    expect(data.structure).toBeNull();
  });
});
