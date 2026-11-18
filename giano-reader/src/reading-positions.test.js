import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  MAX_READING_POSITIONS,
  normalizePosition,
  getReadingPosition,
  setReadingPosition,
  samePosition,
  resolveRestoreTarget,
} from './reading-positions.js';

describe('normalizePosition', () => {
  it('rejects missing or invalid chapter indexes', () => {
    expect(normalizePosition(null)).toBeNull();
    expect(normalizePosition({})).toBeNull();
    expect(normalizePosition({ chapterIndex: -1 })).toBeNull();
    expect(normalizePosition({ chapterIndex: 1.5 })).toBeNull();
    expect(normalizePosition({ chapterIndex: 'x' })).toBeNull();
  });

  it('clamps and rounds the scroll percentage', () => {
    expect(normalizePosition({ chapterIndex: 2, scrollPct: 140 }).scrollPct).toBe(100);
    expect(normalizePosition({ chapterIndex: 2, scrollPct: -3 }).scrollPct).toBe(0);
    expect(normalizePosition({ chapterIndex: 2, scrollPct: NaN }).scrollPct).toBe(0);
    expect(normalizePosition({ chapterIndex: 2, scrollPct: 12.3456 }).scrollPct).toBe(12.35);
  });

  it('keeps pdfMode only for PDFs', () => {
    expect(normalizePosition({ chapterIndex: 0, fileType: 'pdf', pdfMode: 'page' }).pdfMode).toBe('page');
    expect(normalizePosition({ chapterIndex: 0, fileType: 'epub', pdfMode: 'page' }).pdfMode).toBeUndefined();
  });
});

describe('getReadingPosition / setReadingPosition', () => {
  it('stores and reads a position by file path', () => {
    const map = setReadingPosition({}, 'C:\\b.epub', { chapterIndex: 3, scrollPct: 40, updatedAt: 1 });
    expect(getReadingPosition(map, 'C:\\b.epub')).toEqual({ chapterIndex: 3, scrollPct: 40, fileType: 'epub', updatedAt: 1 });
    expect(getReadingPosition(map, 'other')).toBeNull();
    expect(getReadingPosition(map, '')).toBeNull();
  });

  it('tolerates a corrupted stored map', () => {
    expect(getReadingPosition([], 'a')).toBeNull();
    expect(getReadingPosition('x', 'a')).toBeNull();
    expect(getReadingPosition({ a: 'junk' }, 'a')).toBeNull();
    expect(setReadingPosition({ a: 'junk', b: { chapterIndex: 1 } }, 'c', { chapterIndex: 0 }))
      .toEqual({ b: { chapterIndex: 1, scrollPct: 0, fileType: 'epub', updatedAt: 0 }, c: { chapterIndex: 0, scrollPct: 0, fileType: 'epub', updatedAt: 0 } });
  });

  it('does not mutate the input map', () => {
    const map = { a: { chapterIndex: 1, scrollPct: 0, fileType: 'epub', updatedAt: 1 } };
    const copy = JSON.parse(JSON.stringify(map));
    setReadingPosition(map, 'a', { chapterIndex: 5, updatedAt: 2 });
    expect(map).toEqual(copy);
  });

  it('drops the least recently updated books beyond the limit, never the one just written', () => {
    let map = {};
    for (let i = 0; i < 5; i++) map = setReadingPosition(map, `b${i}`, { chapterIndex: 0, updatedAt: 100 + i }, 3);
    expect(Object.keys(map).sort()).toEqual(['b2', 'b3', 'b4']);
    // A position written with an old timestamp is still kept
    map = setReadingPosition(map, 'old', { chapterIndex: 0, updatedAt: 1 }, 3);
    expect(Object.keys(map).sort()).toEqual(['b3', 'b4', 'old']);
  });

  it('never exceeds the limit (property)', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.nat(50), fc.nat(1000)), { maxLength: 60 }),
      fc.integer({ min: 1, max: 10 }),
      (writes, max) => {
        let map = {};
        for (const [key, chapterIndex, updatedAt] of writes) {
          map = setReadingPosition(map, key, { chapterIndex, updatedAt }, max);
          expect(Object.keys(map).length).toBeLessThanOrEqual(max);
          expect(getReadingPosition(map, key).chapterIndex).toBe(chapterIndex);
        }
      },
    ));
  });

  it('has a sensible default limit', () => {
    expect(MAX_READING_POSITIONS).toBeGreaterThanOrEqual(100);
  });
});

describe('samePosition', () => {
  it('ignores the timestamp', () => {
    expect(samePosition({ chapterIndex: 1, scrollPct: 10, updatedAt: 1 }, { chapterIndex: 1, scrollPct: 10, updatedAt: 9 })).toBe(true);
    expect(samePosition({ chapterIndex: 1, scrollPct: 10 }, { chapterIndex: 1, scrollPct: 11 })).toBe(false);
    expect(samePosition(null, null)).toBe(true);
    expect(samePosition(null, { chapterIndex: 0 })).toBe(false);
  });
});

describe('resolveRestoreTarget', () => {
  it('restores a valid EPUB position', () => {
    expect(resolveRestoreTarget({ chapterIndex: 4, scrollPct: 55 }, { fileType: 'epub', unitCount: 10 }))
      .toEqual({ chapterIndex: 4, scrollPct: 55 });
  });

  it('ignores a chapter that no longer exists (file changed)', () => {
    expect(resolveRestoreTarget({ chapterIndex: 10, scrollPct: 5 }, { fileType: 'epub', unitCount: 10 })).toBeNull();
  });

  it('ignores a position of another file type', () => {
    expect(resolveRestoreTarget({ chapterIndex: 1, fileType: 'pdf' }, { fileType: 'epub', unitCount: 10 })).toBeNull();
  });

  it('ignores a PDF position saved in another navigation mode', () => {
    const pos = { chapterIndex: 3, fileType: 'pdf', pdfMode: 'page', scrollPct: 20 };
    expect(resolveRestoreTarget(pos, { fileType: 'pdf', unitCount: 50, pdfMode: 'chapter' })).toBeNull();
    expect(resolveRestoreTarget(pos, { fileType: 'pdf', unitCount: 50, pdfMode: 'page' })).toEqual({ chapterIndex: 3, scrollPct: 20 });
  });

  it('returns null without a saved position', () => {
    expect(resolveRestoreTarget(null, { fileType: 'epub', unitCount: 3 })).toBeNull();
  });
});
