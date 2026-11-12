/**
 * Book rating (1–5 stars). Mirrors `library-sync.js` in the desktop app.
 */

export const MAX_RATING = 5;

/** Rating filter: '' = all, 'none' = not rated, '1'…'5' = exactly that many stars. */
export type RatingFilter = '' | 'none' | '1' | '2' | '3' | '4' | '5';

/** Returns the rating as an integer 1–5, or null for anything else. */
export function normalizeRating(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_RATING
    ? value
    : null;
}

export function matchesRatingFilter(rating: unknown, filter: RatingFilter): boolean {
  if (!filter) return true;
  const r = normalizeRating(rating);
  if (filter === 'none') return r === null;
  return r === Number(filter);
}

/**
 * Rating after tapping star `star`: tapping the current rating clears it,
 * any other star sets that rating.
 */
export function nextRating(current: unknown, star: number): number | null {
  const tapped = normalizeRating(star);
  return normalizeRating(current) === tapped ? null : tapped;
}
