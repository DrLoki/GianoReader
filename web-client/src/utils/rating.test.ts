import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normalizeRating, matchesRatingFilter, nextRating } from './rating';

describe('normalizeRating', () => {
  it('accepts integers 1–5 only', () => {
    for (let n = 1; n <= 5; n++) expect(normalizeRating(n)).toBe(n);
    for (const v of [0, 6, -2, 2.5, '3', null, undefined, NaN]) {
      expect(normalizeRating(v)).toBeNull();
    }
  });
});

describe('matchesRatingFilter', () => {
  it('empty filter matches everything', () => {
    fc.assert(fc.property(fc.anything(), (v) => matchesRatingFilter(v, '')));
  });

  it('numeric filter is an exact match', () => {
    expect(matchesRatingFilter(4, '4')).toBe(true);
    expect(matchesRatingFilter(5, '4')).toBe(false);
    expect(matchesRatingFilter(null, '4')).toBe(false);
  });

  it('"none" matches unrated and invalid ratings', () => {
    expect(matchesRatingFilter(null, 'none')).toBe(true);
    expect(matchesRatingFilter(undefined, 'none')).toBe(true);
    expect(matchesRatingFilter(0, 'none')).toBe(true);
    expect(matchesRatingFilter(3, 'none')).toBe(false);
  });
});

describe('nextRating', () => {
  it('sets the tapped star, or clears when tapping the current rating', () => {
    expect(nextRating(null, 3)).toBe(3);
    expect(nextRating(2, 5)).toBe(5);
    expect(nextRating(4, 4)).toBeNull();
  });

  it('always returns a valid rating or null', () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 1, max: 5 })), fc.integer({ min: 1, max: 5 }), (cur, star) => {
        const r = nextRating(cur, star);
        return r === null || (r >= 1 && r <= 5);
      }),
    );
  });
});
