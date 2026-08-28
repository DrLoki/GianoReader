import { apiFetch } from './client';
import type { BookSummary, TocEntry } from '../types';
import { isOfflineMode, isLocalId, getLocalBooks, getLocalBookToc } from './local-db';

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

