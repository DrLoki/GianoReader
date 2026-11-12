import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  normalizeRating,
  setEntryRating,
  matchesRatingFilter,
  ratingStars,
  mergeLibraryRatings,
} from './library-sync.js';

describe('normalizeRating', () => {
  it('accepts integers 1–5 only', () => {
    for (let n = 1; n <= 5; n++) expect(normalizeRating(n)).toBe(n);
    for (const v of [0, 6, -1, 3.5, '4', null, undefined, NaN, {}]) {
      expect(normalizeRating(v)).toBeNull();
    }
  });
});

describe('setEntryRating', () => {
  it('sets rating and timestamp when the value changes', () => {
    const entry = { id: 1 };
    expect(setEntryRating(entry, 4, 1000)).toBe(true);
    expect(entry).toEqual({ id: 1, rating: 4, ratingUpdatedAt: 1000 });
  });

  it('does nothing when the value is unchanged', () => {
    const entry = { id: 1, rating: 4, ratingUpdatedAt: 1000 };
    expect(setEntryRating(entry, 4, 2000)).toBe(false);
    expect(entry.ratingUpdatedAt).toBe(1000);
  });

  it('clears with null and treats invalid values as null', () => {
    const entry = { id: 1, rating: 2, ratingUpdatedAt: 1 };
    expect(setEntryRating(entry, null, 5)).toBe(true);
    expect(entry.rating).toBeNull();
    expect(setEntryRating(entry, 9, 6)).toBe(false);
  });
});

describe('matchesRatingFilter', () => {
  const books = [{ rating: 5 }, { rating: 3 }, {}, { rating: null }, { rating: 0 }];

  it('empty filter keeps everything', () => {
    expect(books.filter(b => matchesRatingFilter(b, ''))).toHaveLength(5);
  });

  it('numeric filter is an exact match', () => {
    expect(books.filter(b => matchesRatingFilter(b, '3'))).toEqual([{ rating: 3 }]);
    expect(books.filter(b => matchesRatingFilter(b, '4'))).toEqual([]);
  });

  it('"none" matches unrated and invalid ratings', () => {
    expect(books.filter(b => matchesRatingFilter(b, 'none'))).toHaveLength(3);
  });
});

describe('ratingStars', () => {
  it('renders filled and empty stars', () => {
    expect(ratingStars(3)).toBe('★★★☆☆');
    expect(ratingStars(5)).toBe('★★★★★');
    expect(ratingStars(null)).toBe('');
  });
});

describe('mergeLibraryRatings', () => {
  it('takes a rating set from the phone (newer on disk)', () => {
    const local = [{ id: 'a', title: 'Local title', rating: 2, ratingUpdatedAt: 100 }];
    const disk = [{ id: 'a', title: 'Old title', rating: 5, ratingUpdatedAt: 200 }];
    mergeLibraryRatings(local, disk);
    expect(local[0]).toEqual({ id: 'a', title: 'Local title', rating: 5, ratingUpdatedAt: 200 });
  });

  it('keeps a newer local rating', () => {
    const local = [{ id: 'a', rating: 1, ratingUpdatedAt: 300 }];
    mergeLibraryRatings(local, [{ id: 'a', rating: 5, ratingUpdatedAt: 200 }]);
    expect(local[0].rating).toBe(1);
  });

  it('takes a rating cleared from the phone', () => {
    const local = [{ id: 'a', rating: 4 }];
    mergeLibraryRatings(local, [{ id: 'a', rating: null, ratingUpdatedAt: 50 }]);
    expect(local[0].rating).toBeNull();
  });

  it('does not add or remove entries and updates in place', () => {
    const entry = { id: 1, rating: null };
    const local = [entry];
    const result = mergeLibraryRatings(local, [{ id: '1', rating: 3, ratingUpdatedAt: 9 }, { id: 2, rating: 1, ratingUpdatedAt: 9 }]);
    expect(result).toBe(local);
    expect(local).toHaveLength(1);
    expect(entry.rating).toBe(3);
  });

  it('tolerates missing or malformed disk data', () => {
    const local = [{ id: 'a', rating: 2 }];
    expect(mergeLibraryRatings(local, null)).toBe(local);
    expect(mergeLibraryRatings(local, [null, { title: 'no id' }])[0].rating).toBe(2);
  });

  it('property: the result always holds the most recent rating of each entry', () => {
    const side = fc.record({
      rating: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
      ratingUpdatedAt: fc.nat(1000),
    });
    fc.assert(
      fc.property(side, side, (l, d) => {
        const local = [{ id: 'x', ...l }];
        mergeLibraryRatings(local, [{ id: 'x', ...d }]);
        const expected = d.ratingUpdatedAt > l.ratingUpdatedAt ? d.rating : l.rating;
        expect(local[0].rating).toBe(expected);
      }),
    );
  });
});
