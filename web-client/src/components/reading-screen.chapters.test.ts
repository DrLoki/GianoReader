import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Chapter loading and lazy translation behaviour of <reading-screen>:
 * stale translations, end-of-book handling, empty-chapter skipping and
 * escaping of plain text.
 */

type Chapter = {
  chapterIndex: number;
  totalChapters?: number;
  title: string;
  paragraphs: { id: string; index: number; text: string; html: string }[];
};

const chapters: Record<number, Chapter> = {};
const translateCalls: { texts: string[]; resolve: (v: string[]) => void }[] = [];

vi.mock('./toast', () => ({ showToast: vi.fn() }));
vi.mock('../api/bookmarks', () => ({ createBookmark: vi.fn() }));
vi.mock('../api/state', () => ({ putReadingState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/books', () => ({ getToc: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/preferences', () => ({
  getPreferences: vi.fn().mockResolvedValue({ translationLang: 'it' }),
}));
vi.mock('../api/local-db', () => ({
  isOfflineMode: () => false,
  isLocalId: () => false,
  getLocalChapter: vi.fn(),
}));
vi.mock('../cache/translation-cache', () => ({
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn(),
}));
vi.mock('../api/translate', () => ({
  postTranslate: vi.fn((texts: string[]) =>
    new Promise<string[]>((resolve) => translateCalls.push({ texts, resolve }))),
}));
vi.mock('../api/client', () => ({
  apiFetch: vi.fn(async (url: string) => {
    const m = /chapter\/(\d+)$/.exec(url);
    const ch = m ? chapters[Number(m[1])] : undefined;
    return ch
      ? { ok: true, json: async () => ch }
      : { ok: false, json: async () => ({ error: 'not found' }) };
  }),
}));

// jsdom has no IntersectionObserver: report every observed element as visible
class FakeIntersectionObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry], this as any);
  }
  unobserve() {}
  disconnect() {}
}

import * as translationCache from '../cache/translation-cache';
import './reading-screen';

function para(chapter: number, i: number, text: string) {
  return { id: `c${chapter}p${i}`, index: i, text, html: text };
}

function mount(state = { currentChapter: 0, paragraphId: null, scrollOffset: 0, progress: 0 }) {
  const el = document.createElement('reading-screen') as HTMLElement & {
    setBook(id: string, st: typeof state): void;
  };
  el.setBook('book-1', state);
  document.body.appendChild(el);
  return el;
}

const translatedSlot = (el: HTMLElement) =>
  (el.querySelector('card-ui') as any).getTranslatedSlot() as HTMLElement;
const originalSlot = (el: HTMLElement) =>
  (el.querySelector('card-ui') as any).getOriginalSlot() as HTMLElement;

describe('reading-screen chapter loading', () => {
  beforeEach(() => {
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
    for (const k of Object.keys(chapters)) delete chapters[Number(k)];
    translateCalls.length = 0;
    vi.mocked(translationCache.set).mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (globalThis as any).IntersectionObserver;
  });

  it('drops a translation that arrives after the user changed chapter', async () => {
    chapters[0] = { chapterIndex: 0, totalChapters: 2, title: 'One', paragraphs: [para(0, 0, 'First chapter')] };
    chapters[1] = { chapterIndex: 1, totalChapters: 2, title: 'Two', paragraphs: [para(1, 0, 'Second chapter')] };
    const el = mount();

    await vi.waitFor(() => expect(translateCalls.length).toBe(1));
    expect(translateCalls[0].texts).toEqual(['First chapter']);

    (el.querySelector('.nav-next') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(originalSlot(el).textContent).toContain('Second chapter'));
    await vi.waitFor(() => expect(translateCalls.length).toBe(2));

    // The slow chapter-0 response finally arrives
    translateCalls[0].resolve(['STALE']);
    await new Promise((r) => setTimeout(r, 20));

    expect(translatedSlot(el).textContent).not.toContain('STALE');
    expect(vi.mocked(translationCache.set)).not.toHaveBeenCalledWith(expect.anything(), 'STALE');

    translateCalls[1].resolve(['Secondo capitolo']);
    await vi.waitFor(() => expect(translatedSlot(el).textContent).toContain('Secondo capitolo'));
    expect(vi.mocked(translationCache.set)).toHaveBeenCalledWith(
      expect.objectContaining({ chapterIndex: 1, paragraphId: 'c1p0' }),
      'Secondo capitolo',
    );
  });

  it('disables "next" on the last chapter', async () => {
    chapters[0] = { chapterIndex: 0, totalChapters: 1, title: 'Only', paragraphs: [para(0, 0, 'Only chapter')] };
    const el = mount();
    await vi.waitFor(() => expect(originalSlot(el).textContent).toContain('Only chapter'));
    expect((el.querySelector('.nav-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('skips empty chapters backwards when going to the previous chapter', async () => {
    chapters[0] = { chapterIndex: 0, totalChapters: 3, title: 'A', paragraphs: [para(0, 0, 'Chapter zero')] };
    chapters[1] = { chapterIndex: 1, totalChapters: 3, title: 'Empty', paragraphs: [] };
    chapters[2] = { chapterIndex: 2, totalChapters: 3, title: 'C', paragraphs: [para(2, 0, 'Chapter two')] };
    const el = mount({ currentChapter: 2, paragraphId: null, scrollOffset: 0, progress: 0 });
    await vi.waitFor(() => expect(originalSlot(el).textContent).toContain('Chapter two'));

    (el.querySelector('.nav-prev') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(originalSlot(el).textContent).toContain('Chapter zero'));
  });

  it('renders plain text as text, not markup', async () => {
    chapters[0] = {
      chapterIndex: 0,
      totalChapters: 1,
      title: 'X',
      paragraphs: [{ id: 'x', index: 0, text: '<img src=x onerror="alert(1)">', html: '&lt;img&gt;' }],
    };
    const el = mount();
    await vi.waitFor(() => expect(translatedSlot(el).querySelector('[data-pos="0"]')).not.toBeNull());
    expect(translatedSlot(el).querySelector('img')).toBeNull();
    expect(translatedSlot(el).textContent).toContain('<img src=x');
  });
});
