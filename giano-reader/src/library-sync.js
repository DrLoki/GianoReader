/**
 * library-sync.js
 *
 * Book rating (1–5 stars) helpers and merge of the library file.
 *
 * The library file (`giano-reader-library.json`) has two writers: the desktop
 * UI and the embedded web server, which sets `rating` / `ratingUpdatedAt` when
 * a book is rated from the phone PWA (see `library_rating.rs`). The desktop
 * keeps the library in memory, so before every save it takes the newer rating
 * from disk; otherwise a rating set from the phone would be overwritten.
 *
 * Pure functions, no DOM or storage access.
 */

export const MAX_RATING = 5;

/** Returns the rating as an integer 1–5, or null for anything else. */
export function normalizeRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_RATING ? value : null;
}

/**
 * Sets the rating of a library entry and stamps `ratingUpdatedAt`.
 * Returns false (and leaves the entry untouched) when the rating does not change.
 */
export function setEntryRating(entry, rating, now = Date.now()) {
  const next = normalizeRating(rating);
  if (normalizeRating(entry.rating) === next) return false;
  entry.rating = next;
  entry.ratingUpdatedAt = now;
  return true;
}

/**
 * Rating filter of the library list.
 * `''` = all, `'none'` = not rated, `'1'`…`'5'` = exactly that many stars.
 */
export function matchesRatingFilter(entry, filter) {
  if (!filter) return true;
  const rating = normalizeRating(entry && entry.rating);
  if (filter === 'none') return rating === null;
  return rating === Number(filter);
}

/** Text form of a rating, e.g. 3 → "★★★☆☆". Empty string when not rated. */
export function ratingStars(value) {
  const rating = normalizeRating(value);
  return rating ? '★'.repeat(rating) + '☆'.repeat(MAX_RATING - rating) : '';
}

/**
 * Copies into `local` every rating that is newer on disk (by `ratingUpdatedAt`).
 * Entries are matched by `id`. `local` is updated in place and returned, so
 * callers holding references to its entries see the merged values.
 *
 * @param {object[]} local   list the desktop wants to save
 * @param {object[]} onDisk  list currently stored on disk
 */
export function mergeLibraryRatings(local, onDisk) {
  if (!Array.isArray(local) || !Array.isArray(onDisk)) return local;
  const diskById = new Map();
  for (const entry of onDisk) {
    if (entry && entry.id != null) diskById.set(String(entry.id), entry);
  }
  for (const entry of local) {
    if (!entry || entry.id == null) continue;
    const disk = diskById.get(String(entry.id));
    if (!disk) continue;
    const diskAt = Number(disk.ratingUpdatedAt) || 0;
    const localAt = Number(entry.ratingUpdatedAt) || 0;
    if (diskAt > localAt) {
      entry.rating = normalizeRating(disk.rating);
      entry.ratingUpdatedAt = diskAt;
    }
  }
  return local;
}
