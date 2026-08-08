import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './library-screen';

vi.mock('../api/books', () => ({
  getBooks: vi.fn(),
  getCoverUrl: vi.fn((id: string) => `/api/books/${id}/cover`),
}));

vi.mock('../api/state', () => ({
  getReadingState: vi.fn(),
}));

vi.mock('../i18n/index', () => ({
  t: vi.fn((key: string, vars?: Record<string, string>) => {
    const map: Record<string, string> = {
      'library.title': 'Library',
      'library.loading': 'Loading books…',
      'library.empty': 'No books available on the server.',
      'library.error': 'Could not load library.',
      'library.retry': 'Retry',
      'library.progress': `${vars?.progress ?? '0'}% read`,
    };
    return map[key] ?? key;
  }),
}));

import { getBooks } from '../api/books';
import { getReadingState } from '../api/state';
const mockGetBooks = vi.mocked(getBooks);
const mockGetReadingState = vi.mocked(getReadingState);

describe('library-screen component', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows loading indicator while fetching books', () => {
    // Keep the promise pending
    mockGetBooks.mockReturnValue(new Promise(() => {}));

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    expect(el.querySelector('.library-loading')).not.toBeNull();
    expect(el.querySelector('.spinner')).not.toBeNull();
    expect(el.querySelector('.library-loading')?.textContent).toContain('Loading books');
  });

  it('renders book grid when books are returned', async () => {
    mockGetBooks.mockResolvedValueOnce([
      { id: 'b1', title: 'Book One', author: 'Author A', coverUrl: '/api/books/b1/cover', progress: 42 },
      { id: 'b2', title: 'Book Two', author: 'Author B', coverUrl: null, progress: 0 },
    ]);

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.book-grid')).not.toBeNull();
    });

    const cards = el.querySelectorAll('.book-card');
    expect(cards.length).toBe(2);

    // First card content
    expect(cards[0].querySelector('.book-title')?.textContent).toBe('Book One');
    expect(cards[0].querySelector('.book-author')?.textContent).toBe('Author A');
    expect(cards[0].querySelector('.book-progress')?.textContent).toBe('42% read');
    expect(cards[0].querySelector('.book-cover')?.getAttribute('src')).toBe('/api/books/b1/cover');
  });

  it('renders empty state when no books returned', async () => {
    mockGetBooks.mockResolvedValueOnce([]);

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.library-empty')).not.toBeNull();
    });

    expect(el.querySelector('.library-empty')?.textContent).toContain('No books available');
  });

  it('renders error state with retry button on fetch failure', async () => {
    mockGetBooks.mockRejectedValueOnce(new TypeError('Network error'));

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.library-error')).not.toBeNull();
    });

    expect(el.querySelector('.library-error p')?.textContent).toContain('Could not load library');
    expect(el.querySelector('.retry-btn')).not.toBeNull();
  });

  it('retry button re-fetches books', async () => {
    mockGetBooks.mockRejectedValueOnce(new TypeError('Network error'));

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.retry-btn')).not.toBeNull();
    });

    // Now make the next call succeed
    mockGetBooks.mockResolvedValueOnce([
      { id: 'b1', title: 'Book One', author: 'Author A', coverUrl: null, progress: 10 },
    ]);

    const btn = el.querySelector('.retry-btn') as HTMLButtonElement;
    btn.click();

    await vi.waitFor(() => {
      expect(el.querySelector('.book-grid')).not.toBeNull();
    });

    expect(mockGetBooks).toHaveBeenCalledTimes(2);
  });

  it('dispatches navigate event with reading state on card click', async () => {
    mockGetBooks.mockResolvedValueOnce([
      { id: 'b1', title: 'Book One', author: 'Author A', coverUrl: null, progress: 50 },
    ]);
    mockGetReadingState.mockResolvedValueOnce({
      currentChapter: 3,
      paragraphId: 'p5',
      scrollOffset: 120,
      progress: 50,
    });

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.book-card')).not.toBeNull();
    });

    const eventPromise = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('navigate', (e) => resolve(e as CustomEvent), { once: true });
    });

    const card = el.querySelector('.book-card') as HTMLElement;
    card.click();

    const event = await eventPromise;
    expect(event.detail.screen).toBe('reading');
    expect(event.detail.bookId).toBe('b1');
    expect(event.detail.state).toEqual({
      currentChapter: 3,
      paragraphId: 'p5',
      scrollOffset: 120,
      progress: 50,
    });
  });

  it('dispatches navigate event with default state when getReadingState fails', async () => {
    mockGetBooks.mockResolvedValueOnce([
      { id: 'b1', title: 'Book One', author: 'Author A', coverUrl: null, progress: 50 },
    ]);
    mockGetReadingState.mockRejectedValueOnce(new Error('Network error'));

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.book-card')).not.toBeNull();
    });

    const eventPromise = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('navigate', (e) => resolve(e as CustomEvent), { once: true });
    });

    const card = el.querySelector('.book-card') as HTMLElement;
    card.click();

    const event = await eventPromise;
    expect(event.detail.screen).toBe('reading');
    expect(event.detail.bookId).toBe('b1');
    expect(event.detail.state).toEqual({
      currentChapter: 0,
      paragraphId: null,
      scrollOffset: 0,
      progress: 0,
    });
  });

  it('uses CSS Grid with auto-fill minmax(140px, 1fr)', async () => {
    mockGetBooks.mockResolvedValueOnce([
      { id: 'b1', title: 'Book One', author: 'Author A', coverUrl: null, progress: 0 },
    ]);

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.book-grid')).not.toBeNull();
    });

    // Verify the style tag contains the expected grid declaration
    const style = el.querySelector('style');
    expect(style?.textContent).toContain('repeat(auto-fill, minmax(140px, 1fr))');
  });

  it('book cards have proper accessibility attributes', async () => {
    mockGetBooks.mockResolvedValueOnce([
      { id: 'b1', title: 'Book One', author: 'Author A', coverUrl: null, progress: 25 },
    ]);

    const el = document.createElement('library-screen');
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(el.querySelector('.book-card')).not.toBeNull();
    });

    const card = el.querySelector('.book-card') as HTMLElement;
    expect(card.getAttribute('role')).toBe('listitem');
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.getAttribute('aria-label')).toContain('Book One');

    const grid = el.querySelector('.book-grid') as HTMLElement;
    expect(grid.getAttribute('role')).toBe('list');
  });
});
