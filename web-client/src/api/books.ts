import { apiFetch } from './client';
import type { BookSummary, TocEntry } from '../types';
import { isOfflineMode, isLocalId, getLocalBooks, getLocalBookToc } from './local-db';

/**
 * Fetches the list of all books in the library.
 * Calls GET /api/books and returns the parsed JSON array.
 */
export async function getBooks(): Promise<BookSummary[]> {
  if (isOfflineMode()) {
    return getLocalBooks();
  }
  const response = await apiFetch('/api/books');
  return response.json() as Promise<BookSummary[]>;
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

