import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import './reading-screen';

vi.mock('../api/bookmarks', () => ({
  createBookmark: vi.fn().mockResolvedValue({ id: 'bm-1', chapterIndex: 2, paragraphId: 'p1', label: null, createdAt: '2024-01-01T00:00:00Z' }),
}));

vi.mock('./toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      bookId: 'book-123',
      chapterIndex: 0,
      title: 'Chapter 1',
      paragraphs: [
        { id: 'p1', index: 0, text: 'Hello', html: 'Hello' },
        { id: 'p2', index: 1, text: 'World', html: 'World' },
      ],
    }),
  }),
}));

describe('reading-screen', () => {
  let el: HTMLElement & {
    setBook(bookId: string, state: { currentChapter: number; paragraphId: string | null; scrollOffset: number; progress: number }): void;
    getBookId(): string;
    getInitialState(): { currentChapter: number; paragraphId: string | null; scrollOffset: number; progress: number };
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    el = document.createElement('reading-screen') as any;
    document.body.appendChild(el);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('Layout structure', () => {
    it('renders a fixed 56px header', () => {
      const header = el.querySelector('.reading-header') as HTMLElement;
      expect(header).not.toBeNull();
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toContain('height: 56px');
    });

    it('renders a library button in the header', () => {
      const libBtn = el.querySelector('.fab-library-btn') as HTMLButtonElement;
      expect(libBtn).not.toBeNull();
      expect(libBtn.getAttribute('aria-label')).toBe('Back to library');
    });

    it('renders a settings button in chapter nav', () => {
      const settingsBtn = el.querySelector('.settings-btn') as HTMLButtonElement;
      expect(settingsBtn).not.toBeNull();
      expect(settingsBtn.getAttribute('aria-label')).toBe('Settings');
    });

    it('renders Original and Translated tab buttons', () => {
      const tabOriginal = el.querySelector('.tab-original') as HTMLButtonElement;
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;
      expect(tabOriginal).not.toBeNull();
      expect(tabTranslated).not.toBeNull();
      expect(tabOriginal.textContent?.trim()).toBe('Original');
      expect(tabTranslated.textContent?.trim()).toBe('Translated');
    });

    it('renders a scrollable content area with card-ui', () => {
      const content = el.querySelector('.reading-content') as HTMLElement;
      expect(content).not.toBeNull();
      const cardUi = content.querySelector('card-ui');
      expect(cardUi).not.toBeNull();
    });

    it('content area fills remaining viewport height', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toContain('top: 56px');
      expect(style).toContain('bottom: 55px');
    });

    it('renders FAB group with Bookmark button', () => {
      const bookmarkFab = el.querySelector('.fab-bookmark');
      expect(bookmarkFab).not.toBeNull();
    });

    it('FAB group is fixed bottom-right', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toContain('bottom: 68px');
      expect(style).toContain('right: 16px');
      expect(style).toContain('position: fixed');
    });
  });

  describe('Touch targets', () => {
    it('settings button has min-width and min-height of 44px', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toMatch(/\.settings-btn[^}]*min-width:\s*44px/s);
      expect(style).toMatch(/\.settings-btn[^}]*min-height:\s*44px/s);
    });

    it('tab buttons have min-width and min-height of 44px', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toMatch(/\.tab-btn[^}]*min-width:\s*44px/s);
      expect(style).toMatch(/\.tab-btn[^}]*min-height:\s*44px/s);
    });

    it('FAB buttons have min-width and min-height of 44px', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toMatch(/\.fab[^}]*min-width:\s*44px/s);
      expect(style).toMatch(/\.fab[^}]*min-height:\s*44px/s);
    });
  });

  describe('Accessibility', () => {
    it('settings button has aria-label', () => {
      const btn = el.querySelector('.settings-btn') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Settings');
    });

    it('Original tab has aria-label', () => {
      const btn = el.querySelector('.tab-original') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Original');
    });

    it('Translated tab has aria-label', () => {
      const btn = el.querySelector('.tab-translated') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Translated');
    });

    it('Bookmark FAB has aria-label', () => {
      const btn = el.querySelector('.fab-bookmark') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Add bookmark');
    });

    it('Library button has aria-label', () => {
      const btn = el.querySelector('.fab-library-btn') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Back to library');
    });

    it('tab group has role="tablist"', () => {
      const group = el.querySelector('.tab-group');
      expect(group?.getAttribute('role')).toBe('tablist');
    });

    it('tabs have role="tab" and correct aria-selected', () => {
      const tabOriginal = el.querySelector('.tab-original') as HTMLButtonElement;
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;
      expect(tabOriginal.getAttribute('role')).toBe('tab');
      expect(tabTranslated.getAttribute('role')).toBe('tab');
      expect(tabOriginal.getAttribute('aria-selected')).toBe('true');
      expect(tabTranslated.getAttribute('aria-selected')).toBe('false');
    });
  });

  describe('Tab switching & Synchronization', () => {
    it('clicking Original tab activates it and adds active class', () => {
      const tabOriginal = el.querySelector('.tab-original') as HTMLButtonElement;
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;

      // Switch to translated first
      tabTranslated.click();
      expect(tabTranslated.classList.contains('active')).toBe(true);
      expect(tabOriginal.classList.contains('active')).toBe(false);

      // Switch back to original
      tabOriginal.click();
      expect(tabOriginal.classList.contains('active')).toBe(true);
      expect(tabTranslated.classList.contains('active')).toBe(false);
    });

    it('clicking Translated tab calls card-ui switchTo("translated")', () => {
      const cardUi = el.querySelector('card-ui') as HTMLElement & {
        switchTo: (card: 'original' | 'translated') => void;
        getActiveCard: () => 'original' | 'translated';
      };
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;

      tabTranslated.click();
      expect(cardUi.getActiveCard()).toBe('translated');
    });

    it('clicking Original tab calls card-ui switchTo("original")', () => {
      const cardUi = el.querySelector('card-ui') as HTMLElement & {
        switchTo: (card: 'original' | 'translated') => void;
        getActiveCard: () => 'original' | 'translated';
      };
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;
      const tabOriginal = el.querySelector('.tab-original') as HTMLButtonElement;

      tabTranslated.click();
      tabOriginal.click();
      expect(cardUi.getActiveCard()).toBe('original');
    });

    it('tab aria-selected updates on switch', () => {
      const tabOriginal = el.querySelector('.tab-original') as HTMLButtonElement;
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;

      tabTranslated.click();
      expect(tabTranslated.getAttribute('aria-selected')).toBe('true');
      expect(tabOriginal.getAttribute('aria-selected')).toBe('false');
    });

    it('updates active tab when card-ui dispatches card-change event', () => {
      const tabOriginal = el.querySelector('.tab-original') as HTMLButtonElement;
      const tabTranslated = el.querySelector('.tab-translated') as HTMLButtonElement;
      const cardUi = el.querySelector('card-ui') as HTMLElement;

      // Simulate swipe / programmatic switch to translated
      cardUi.dispatchEvent(
        new CustomEvent('card-change', {
          bubbles: true,
          composed: true,
          detail: { activeCard: 'translated' },
        })
      );

      expect(tabTranslated.classList.contains('active')).toBe(true);
      expect(tabTranslated.getAttribute('aria-selected')).toBe('true');
      expect(tabOriginal.classList.contains('active')).toBe(false);
      expect(tabOriginal.getAttribute('aria-selected')).toBe('false');

      // Simulate swipe back to original
      cardUi.dispatchEvent(
        new CustomEvent('card-change', {
          bubbles: true,
          composed: true,
          detail: { activeCard: 'original' },
        })
      );

      expect(tabOriginal.classList.contains('active')).toBe(true);
      expect(tabOriginal.getAttribute('aria-selected')).toBe('true');
      expect(tabTranslated.classList.contains('active')).toBe(false);
      expect(tabTranslated.getAttribute('aria-selected')).toBe('false');
    });
  });

  describe('Event dispatching', () => {
    it('settings button dispatches open-settings event', () => {
      const handler = vi.fn();
      el.addEventListener('open-settings', handler);

      const btn = el.querySelector('.settings-btn') as HTMLButtonElement;
      btn.click();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('bookmark FAB calls createBookmark and shows success toast', async () => {
      const { createBookmark } = await import('../api/bookmarks');
      const { showToast } = await import('./toast');

      el.setBook('book-123', { currentChapter: 2, paragraphId: 'p5', scrollOffset: 100, progress: 40 });

      const cardUi = el.querySelector('card-ui') as HTMLElement & {
        getOriginalSlot: () => HTMLElement | null;
      };
      const slot = cardUi.getOriginalSlot();
      if (slot) {
        slot.innerHTML = '<p data-id="p1" data-index="0">Hello</p><p data-id="p2" data-index="1">World</p>';
      }

      const btn = el.querySelector('.fab-bookmark') as HTMLButtonElement;
      btn.click();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(createBookmark).toHaveBeenCalledWith('book-123', {
        chapterIndex: 2,
        paragraphId: expect.any(String),
        paragraphIndex: expect.any(Number),
      });
      expect(showToast).toHaveBeenCalledWith('Bookmark saved', 'success');
    });

    it('bookmark FAB shows error toast on failure', async () => {
      const { createBookmark } = await import('../api/bookmarks');
      const { showToast } = await import('./toast');

      vi.mocked(createBookmark).mockRejectedValueOnce(new Error('Network error'));

      el.setBook('book-123', { currentChapter: 2, paragraphId: 'p5', scrollOffset: 100, progress: 40 });

      const cardUi = el.querySelector('card-ui') as HTMLElement & {
        getOriginalSlot: () => HTMLElement | null;
      };
      const slot = cardUi.getOriginalSlot();
      if (slot) {
        slot.innerHTML = '<p data-id="p1" data-index="0">Hello</p>';
      }

      const btn = el.querySelector('.fab-bookmark') as HTMLButtonElement;
      btn.click();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
    });

    it('library button in header dispatches navigate event with screen: library', () => {
      const handler = vi.fn();
      el.addEventListener('navigate', handler);

      const btn = el.querySelector('.fab-library-btn') as HTMLButtonElement;
      btn.click();

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0][0] as CustomEvent).detail.screen).toBe('library');
    });
  });

  describe('setBook and state', () => {
    it('stores bookId and initial state', () => {
      const state = { currentChapter: 3, paragraphId: 'p10', scrollOffset: 250, progress: 60 };
      el.setBook('my-book', state);

      expect(el.getBookId()).toBe('my-book');
      expect(el.getInitialState()).toEqual(state);
    });

    it('defaults to empty bookId and zero state', () => {
      expect(el.getBookId()).toBe('');
      expect(el.getInitialState()).toEqual({
        currentChapter: 0,
        paragraphId: null,
        scrollOffset: 0,
        progress: 0,
      });
    });
  });
});
