import { apiFetch } from './client';
import type { ReadingState } from '../types';

/**
 * Fetches the persisted reading state for a book.
 * Returns default state (chapter 0, no scroll) if none has been saved.
 *
 * @param bookId - The book identifier
 * @returns The current reading state for the book
 */
export async function getReadingState(bookId: string): Promise<ReadingState> {
  const response = await apiFetch(`/api/books/${bookId}/state`);
  if (!response.ok) {
    throw new Error(`Failed to fetch reading state: ${response.status}`);
  }
  return response.json();
}

/**
 * Persists the reading state for a book.
 *
 * @param bookId - The book identifier
 * @param state - The reading state to save
 */
export async function putReadingState(bookId: string, state: ReadingState): Promise<void> {
  await apiFetch(`/api/books/${bookId}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
}
