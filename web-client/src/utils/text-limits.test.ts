import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { FREE_BYTE_LIMIT, utf8Length, splitByByteLimit } from './text-limits';

describe('utf8Length', () => {
  it('counts bytes, not characters', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('жук')).toBe(6);
    expect(utf8Length('日本語')).toBe(9);
    expect(utf8Length('😀')).toBe(4);
  });
});

describe('splitByByteLimit', () => {
  it('returns the text as is when it fits', () => {
    expect(splitByByteLimit('short text', 100)).toEqual(['short text']);
  });

  it('cuts after whitespace so words stay whole', () => {
    expect(splitByByteLimit('alpha beta gamma delta', 12)).toEqual(['alpha beta ', 'gamma delta']);
  });

  it('cuts after sentence punctuation in text without spaces', () => {
    expect(splitByByteLimit('一二三。四五六。七八九。', 24)).toEqual(['一二三。四五六。', '七八九。']);
  });

  it('cuts between characters when there is no place to break', () => {
    const pieces = splitByByteLimit('日'.repeat(10), 9);
    expect(pieces).toEqual(['日日日', '日日日', '日日日', '日']);
  });

  it('cuts again when the rest after a break has no room for the next character', () => {
    const pieces = splitByByteLimit(' ¡𐀀ࠀ', 8);
    expect(pieces).toEqual([' ', '¡𐀀', 'ࠀ']);
  });

  it('never splits a surrogate pair', () => {
    const pieces = splitByByteLimit('😀'.repeat(5), 6);
    expect(pieces.join('')).toBe('😀'.repeat(5));
    for (const piece of pieces) expect(piece).toBe('😀');
  });

  it('keeps a long Cyrillic paragraph under the URL limit of the endpoint', () => {
    const paragraph = 'Это довольно длинное предложение русского текста. '.repeat(120);
    const pieces = splitByByteLimit(paragraph);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(encodeURIComponent(piece).length).toBeLessThanOrEqual(FREE_BYTE_LIMIT * 3);
    }
  });

  it('pieces fit the limit and join back to the original text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 400 }), fc.integer({ min: 8, max: 120 }), (text, limit) => {
        const pieces = splitByByteLimit(text, limit);
        expect(pieces.join('')).toBe(text);
        // An empty text is one empty piece; otherwise no piece is empty
        if (text) for (const piece of pieces) expect(piece.length).toBeGreaterThan(0);
        // A code point is at most 4 bytes, so with limit >= 8 every piece fits
        for (const piece of pieces) expect(utf8Length(piece)).toBeLessThanOrEqual(limit);
      }),
      { numRuns: 1000 },
    );
  });
});
