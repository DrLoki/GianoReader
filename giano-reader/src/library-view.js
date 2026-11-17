/**
 * library-view.js
 *
 * Which library entries the library dialog shows, and in which order: free-text
 * search, status and rating filters, and sorting.
 *
 * Pure functions, no DOM or storage access.
 */

import { matchesRatingFilter } from './library-sync.js';

/** Sort orders of the library list. `added` is the order the books were added in. */
export const LIBRARY_SORTS = ['added', 'title', 'author'];
export const DEFAULT_LIBRARY_SORT = 'added';

/** A known sort order, or the default one. */
export function normalizeLibrarySort(sort) {
  return LIBRARY_SORTS.includes(sort) ? sort : DEFAULT_LIBRARY_SORT;
}

/**
 * Entries matching the search text (title, author or publisher), the reading
 * status and the rating filter. The library order is kept.
 *
 * @param {object[]} library
 * @param {{ query?: string, status?: string, rating?: string }} [filters]
 */
export function filterLibrary(library, { query = '', status = '', rating = '' } = {}) {
  const q = (query || '').trim().toLowerCase();
  return (Array.isArray(library) ? library : []).filter(e =>
    e &&
    (!q || [e.title, e.author, e.publisher].some(v => String(v || '').toLowerCase().includes(q))) &&
    (!status || e.status === status) &&
    matchesRatingFilter(e, rating)
  );
}

/**
 * A sorted copy of `entries`.
 *
 * Text is compared ignoring case and accents, with numbers in numeric order
 * ("Volume 5" before "Volume 12"). Books without a title or author go last.
 * Sorting by author falls back to the title for books of the same author.
 *
 * @param {object[]} entries
 * @param {string} sort  one of LIBRARY_SORTS
 * @param {string} [locale]  UI language
 */
export function sortLibrary(entries, sort, locale) {
  const list = entries.slice();
  sort = normalizeLibrarySort(sort);
  if (sort === 'added') return list;

  let collator;
  try {
    collator = new Intl.Collator(locale || undefined, { sensitivity: 'base', numeric: true });
  } catch {
    collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  }
  const text = v => String(v || '').trim();
  const byText = (a, b) => {
    if (!a !== !b) return a ? -1 : 1; // empty values last
    return collator.compare(a, b);
  };
  const byTitle = (a, b) => byText(text(a.title), text(b.title));
  const compare = sort === 'author'
    ? (a, b) => byText(text(a.author), text(b.author)) || byTitle(a, b)
    : byTitle;
  // Array.prototype.sort is stable: equal books keep the library order
  return list.sort(compare);
}
