import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './library-screen';

vi.mock('../api/books', () => ({
  getBooks: vi.fn(),
  getCoverUrl: vi.fn((id: string) => `/api/books/${id}/cover`),
  getToc: vi.fn(),
  setBookRating: vi.fn(),
}));

vi.mock('../api/state', () => ({
  getReadingState: vi.fn(),
}));

vi.mock('./toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../i18n/index', () => ({
  t: vi.fn((key: string) => key),
}));

import { getBooks, setBookRating } from '../api/books';
import { getReadingState } from '../api/state';
import { showToast } from './toast';
const mockGetBooks = vi.mocked(getBooks);
const mockSetBookRating = vi.mocked(setBookRating);
const mockGetReadingState = vi.mocked(getReadingState);

const BOOKS = [
  { id: 'b1', title: 'Five', author: 'A', coverUrl: null, progress: 0, rating: 5 },
  { id: 'b2', title: 'Three', author: 'B', coverUrl: null, progress: 0, rating: 3 },
  { id: 'b3', title: 'Unrated', author: 'C', coverUrl: null, progress: 0 },
];

async function mount(): Promise<HTMLElement> {
  mockGetBooks.mockResolvedValueOnce(BOOKS.map((b) => ({ ...b })));
  const el = document.createElement('library-screen');
  document.body.appendChild(el);
  await vi.waitFor(() => expect(el.querySelectorAll('.book-card').length).toBe(3));
  return el;
}

function starsOn(el: HTMLElement, bookId: string): number {
  return el.querySelectorAll(`.book-rating[data-book-id="${bookId}"] .rating-star--on`).length;
}

function star(el: HTMLElement, bookId: string, n: number): HTMLButtonElement {
  return el.querySelector(`.book-rating[data-book-id="${bookId}"] .rating-star[data-value="${n}"]`)!;
}

function titles(el: HTMLElement): string[] {
  return [...el.querySelectorAll('.book-title')].map((p) => p.textContent ?? '');
}

describe('library-screen rating', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows five stars per card with the current rating filled', async () => {
    const el = await mount();
    expect(el.querySelectorAll('.book-rating[data-book-id="b1"] .rating-star').length).toBe(5);
    expect(starsOn(el, 'b1')).toBe(5);
    expect(starsOn(el, 'b2')).toBe(3);
    expect(starsOn(el, 'b3')).toBe(0);
    expect(star(el, 'b2', 3).getAttribute('aria-checked')).toBe('true');
  });

  it('tapping a star saves the rating without opening the book', async () => {
    mockSetBookRating.mockResolvedValueOnce(4);
    const el = await mount();
    star(el, 'b3', 4).click();
    expect(starsOn(el, 'b3')).toBe(4);
    expect(mockSetBookRating).toHaveBeenCalledWith('b3', 4);
    expect(mockGetReadingState).not.toHaveBeenCalled();
  });

  it('tapping the current rating clears it', async () => {
    mockSetBookRating.mockResolvedValueOnce(null);
    const el = await mount();
    star(el, 'b2', 3).click();
    expect(mockSetBookRating).toHaveBeenCalledWith('b2', null);
    await vi.waitFor(() => expect(starsOn(el, 'b2')).toBe(0));
  });

  it('puts the previous rating back and warns when saving fails', async () => {
    mockSetBookRating.mockRejectedValueOnce(new Error('offline'));
    const el = await mount();
    star(el, 'b2', 1).click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('toast.errorGeneric', 'error'));
    expect(starsOn(el, 'b2')).toBe(3);
  });

  it('filters by exact rating and by "not rated"', async () => {
    const el = await mount();
    const select = el.querySelector('.filter-rating-select') as HTMLSelectElement;

    select.value = '3';
    select.dispatchEvent(new Event('change'));
    expect(titles(el)).toEqual(['Three']);

    select.value = 'none';
    select.dispatchEvent(new Event('change'));
    expect(titles(el)).toEqual(['Unrated']);

    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(titles(el)).toEqual(['Five', 'Three', 'Unrated']);
  });
});
