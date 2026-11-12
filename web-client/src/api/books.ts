import { apiFetch } from './client';
import type { BookSummary, TocEntry } from '../types';
import { isOfflineMode, isLocalId, getLocalBooks, getLocalBookToc, setLocalBookRating } from './local-db';
import { normalizeRating } from '../utils/rating';

/**
 * Fetches the full book list.
 *
 * Local books (imported EPUBs + offline-cached copies) are always loaded first
 * from IndexedDB. When online, server books are fetched and appended — if the
 * network call fails, the user still sees their local library.
 */
export async function getBooks(): Promise<BookSummary[]> {
  // Local books are the stable base — always available
  let localBooks: BookSummary[] = [];
  try {
    localBooks = await getLocalBooks();
  } catch {
    // IndexedDB unavailable — proceed with an empty local set
  }

  if (isOfflineMode()) {
    return localBooks;
  }

  // Build a set of server IDs that already have a local offline copy
  // so we can avoid showing duplicates
  const offlineMirrorIds = new Set(
    localBooks
      .filter((b) => b.id.startsWith('offline-'))
      .map((b) => b.id.slice('offline-'.length)),
  );

  try {
    const response = await apiFetch('/api/books');
    const serverBooks = await response.json() as BookSummary[];
    // Exclude server books that the user already downloaded locally
    const uniqueServerBooks = serverBooks.filter((b) => !offlineMirrorIds.has(b.id));
    return [...localBooks, ...uniqueServerBooks];
  } catch {
    // Network failure — return whatever we have locally
    return localBooks;
  }
}

/**
 * Returns the URL string for a book's cover image.
 * This is synchronous — no fetch is performed.
 */
export function getCoverUrl(id: string): string {
  if (isLocalId(id)) {
    // For local books, the cover is stored as base64 in the book object itself.
    // This is handled in library-screen.ts directly.
    return '';
  }
  return `/api/books/${id}/cover`;
}

/**
 * Fetches the table of contents for a book.
 * Calls GET /api/books/:id/toc and returns the parsed JSON array.
 */
export async function getToc(id: string): Promise<TocEntry[]> {
  if (isOfflineMode() || isLocalId(id)) {
    return getLocalBookToc(id);
  }
  const response = await apiFetch(`/api/books/${id}/toc`);
  return response.json() as Promise<TocEntry[]>;
}

/**
 * Sets (1–5) or clears (null) a book's rating and returns the stored value.
 *
 * - Server books: `PUT /api/books/:id/rating`, saved in the desktop library.
 * - Local books (imported EPUBs, offline copies): saved in IndexedDB. For an
 *   offline copy of a server book the server is also updated when online
 *   (best effort: the local value is kept if the server cannot be reached).
 */
export async function setBookRating(id: string, rating: number | null): Promise<number | null> {
  const value = normalizeRating(rating);

  if (isLocalId(id)) {
    await setLocalBookRating(id, value);
    if (id.startsWith('offline-') && !isOfflineMode()) {
      try {
        await putServerRating(id.slice('offline-'.length), value);
      } catch (err) {
        console.warn('Rating saved locally only:', err);
      }
    }
    return value;
  }

  return putServerRating(id, value);
}

async function putServerRating(id: string, rating: number | null): Promise<number | null> {
  const response = await apiFetch(`/api/books/${encodeURIComponent(id)}/rating`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating }),
  });
  if (!response.ok) throw new Error(`Rating not saved: ${response.status}`);
  const data = (await response.json()) as { rating?: unknown };
  return normalizeRating(data.rating);
}
