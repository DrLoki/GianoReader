import { apiFetch } from './client';
import type { Bookmark } from '../types';
import { isOfflineMode, isLocalId, getLocalBookmarks, createLocalBookmark, deleteLocalBookmark } from './local-db';

/**
 * Fetch all bookmarks for a given book, ordered by chapterIndex ascending
 * then paragraphId numerically ascending.
 * @param bookId - The book identifier
 * @returns Array of bookmarks for the book
 */
export async function getBookmarks(bookId: string): Promise<Bookmark[]> {
  if (isOfflineMode() || isLocalId(bookId)) {
    return getLocalBookmarks(bookId);
  }
  const response = await apiFetch(`/api/books/${bookId}/bookmarks`);
  return response.json() as Promise<Bookmark[]>;
}

/**
 * Create a new bookmark for a given book.
 * @param bookId - The book identifier
 * @param payload - Bookmark data: chapterIndex, paragraphId, optional paragraphIndex and label
 * @returns The created bookmark with server-generated id and createdAt
 */
export async function createBookmark(
  bookId: string,
  payload: { chapterIndex: number; paragraphId: string; paragraphIndex?: number; label?: string },
): Promise<Bookmark> {
  if (isOfflineMode() || isLocalId(bookId)) {
    return createLocalBookmark(bookId, payload);
  }
  const response = await apiFetch(`/api/books/${bookId}/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json() as Promise<Bookmark>;
}

/**
 * Delete a bookmark by its id.
 * @param bookId - The book identifier
 * @param bookmarkId - The bookmark identifier to delete
 */
export async function deleteBookmark(bookId: string, bookmarkId: string): Promise<void> {
  if (isOfflineMode() || isLocalId(bookId)) {
    return deleteLocalBookmark(bookmarkId);
  }
  await apiFetch(`/api/books/${bookId}/bookmarks/${bookmarkId}`, {
    method: 'DELETE',
  });
}

