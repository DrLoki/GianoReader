import { describe, it, expect, beforeEach, vi } from 'vitest';
import './bookmarks-sheet';
import { getBookmarks, deleteBookmark } from '../api/bookmarks';

vi.mock('../api/bookmarks', () => ({
  getBookmarks: vi.fn(),
  deleteBookmark: vi.fn(),
}));

vi.mock('./toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../i18n/index', () => ({
  t: (key: string, vars?: Record<string, string>) => {
    if (key === 'bookmarks.title') return 'Bookmarks';
    if (key === 'bookmarks.positionLabel') {
      return `Chapter ${vars?.chapter ?? ''} · Par. ${vars?.paragraph ?? ''}`;
    }
    if (key === 'bookmarks.deleteTooltip') return 'Delete bookmark';
    if (key === 'bookmarks.empty') return 'No bookmarks saved';
    if (key === 'general.loading') return 'Loading…';
    return key;
  },
  setLocale: vi.fn(),
  getLocale: vi.fn().mockReturnValue('en'),
}));

const mockedGetBookmarks = vi.mocked(getBookmarks);
const mockedDeleteBookmark = vi.mocked(deleteBookmark);

describe('bookmarks-sheet', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockedGetBookmarks.mockReset();
    mockedDeleteBookmark.mockReset();
  });

  function createSheet(bookId: string = 'book-123'): HTMLElement {
    const sheet = document.createElement('bookmarks-sheet') as HTMLElement & { bookId: string };
    sheet.bookId = bookId;
    document.body.appendChild(sheet);
    return sheet;
  }

  it('renders each bookmark with a precise position label (chapter and paragraph)', async () => {
    mockedGetBookmarks.mockResolvedValueOnce([
      {
        id: 'bm-1',
        chapterIndex: 2,
        paragraphId: 'p5',
        paragraphIndex: 5,
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]);

    const sheet = createSheet();
    await vi.waitFor(() => sheet.querySelector('.bookmarks-item-label') !== null);

    const label = sheet.querySelector('.bookmarks-item-label');
    expect(label!.textContent).toBe('Chapter 3 · Par. 6');
  });

  it('deletes a bookmark via the delete button and removes it from the list', async () => {
    mockedGetBookmarks.mockResolvedValueOnce([
      {
        id: 'bm-delete',
        chapterIndex: 0,
        paragraphId: 'p0',
        paragraphIndex: 0,
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]);
    mockedDeleteBookmark.mockResolvedValueOnce(undefined);

    const sheet = createSheet();
    await vi.waitFor(() => sheet.querySelector('.bookmarks-delete-btn') !== null);

    const deleteBtn = sheet.querySelector('.bookmarks-delete-btn') as HTMLButtonElement;
    deleteBtn.click();

    await vi.waitFor(() => mockedDeleteBookmark.mock.calls.length > 0);
    expect(mockedDeleteBookmark).toHaveBeenCalledWith('book-123', 'bm-delete');
    expect(sheet.querySelector('.bookmarks-item')).toBeNull();
  });

  it('dispatches navigate-bookmark when tapping a bookmark entry', async () => {
    mockedGetBookmarks.mockResolvedValueOnce([
      {
        id: 'bm-nav',
        chapterIndex: 1,
        paragraphId: 'p3',
        paragraphIndex: 3,
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]);

    const sheet = createSheet();
    const handler = vi.fn();
    sheet.addEventListener('navigate-bookmark', handler);

    await vi.waitFor(() => sheet.querySelector('.bookmarks-item-content') !== null);
    const content = sheet.querySelector('.bookmarks-item-content') as HTMLElement;
    content.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ chapterIndex: 1, paragraphId: 'p3' });
  });

  it('renders the empty state when no bookmarks exist', async () => {
    mockedGetBookmarks.mockResolvedValueOnce([]);

    const sheet = createSheet();
    await vi.waitFor(() => sheet.querySelector('.bookmarks-empty') !== null);

    expect(sheet.querySelector('.bookmarks-empty')!.textContent).toBe('No bookmarks saved');
  });
});
