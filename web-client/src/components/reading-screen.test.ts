import { describe, it, expect, beforeEach, vi } from 'vitest';
import './reading-screen';

vi.mock('../api/bookmarks', () => ({
  createBookmark: vi.fn().mockResolvedValue({ id: 'bm-1', chapterIndex: 2, paragraphId: 'p1', label: null, createdAt: '2024-01-01T00:00:00Z' }),
}));

vi.mock('./toast', () => ({
  showToast: vi.fn(),
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

  describe('Layout structure', () => {
    it('renders a fixed 56px header', () => {
      const header = el.querySelector('.reading-header') as HTMLElement;
      expect(header).not.toBeNull();
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toContain('height: 56px');
    });

    it('renders a settings button with ⚙ icon in the header', () => {
      const settingsBtn = el.querySelector('.settings-btn') as HTMLButtonElement;
      expect(settingsBtn).not.toBeNull();
      expect(settingsBtn.textContent?.trim()).toBe('⚙');
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

    it('content area fills remaining viewport height (top: 56px, bottom: 0)', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toContain('top: 56px');
      expect(style).toContain('bottom: 0');
    });

    it('renders FAB group with Bookmark, Library, and TTS buttons', () => {
      const fabs = el.querySelectorAll('.fab');
      expect(fabs.length).toBe(3);
      expect(fabs[0].classList.contains('fab-bookmark')).toBe(true);
      expect(fabs[1].classList.contains('fab-library')).toBe(true);
      expect(fabs[2].classList.contains('fab-tts')).toBe(true);
    });

    it('FAB group is fixed bottom-right', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      expect(style).toContain('bottom: 16px');
      expect(style).toContain('right: 16px');
      expect(style).toContain('position: fixed');
    });

    it('TTS FAB is disabled (placeholder)', () => {
      const ttsFab = el.querySelector('.fab-tts') as HTMLButtonElement;
      expect(ttsFab.disabled).toBe(true);
    });
  });

  describe('Touch targets', () => {
    it('settings button has min-width and min-height of 44px', () => {
      const style = el.querySelector('style')?.textContent ?? '';
      // Settings btn style
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

    it('Library FAB has aria-label', () => {
      const btn = el.querySelector('.fab-library') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Back to library');
    });

    it('TTS FAB has aria-label', () => {
      const btn = el.querySelector('.fab-tts') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Text to speech');
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

    it('DOM tab order follows visual order (header → content → FABs)', () => {
      // All focusable elements in DOM order
      const focusable = el.querySelectorAll('button, [tabindex]');
      const classes = Array.from(focusable).map((el) =>
        Array.from(el.classList).join(' ')
      );
      // Header buttons first, then FABs at the end
      const settingsIdx = classes.findIndex((c) => c.includes('settings-btn'));
      const tabOrigIdx = classes.findIndex((c) => c.includes('tab-original'));
      const tabTransIdx = classes.findIndex((c) => c.includes('tab-translated'));
      const fabBookmarkIdx = classes.findIndex((c) => c.includes('fab-bookmark'));
      const fabLibraryIdx = classes.findIndex((c) => c.includes('fab-library'));
      const fabTtsIdx = classes.findIndex((c) => c.includes('fab-tts'));

      // Verify order: settings < tabs < fabs
      expect(settingsIdx).toBeLessThan(tabOrigIdx);
      expect(tabOrigIdx).toBeLessThan(tabTransIdx);
      expect(tabTransIdx).toBeLessThan(fabBookmarkIdx);
      expect(fabBookmarkIdx).toBeLessThan(fabLibraryIdx);
      expect(fabLibraryIdx).toBeLessThan(fabTtsIdx);
    });
  });

  describe('Tab switching', () => {
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

      // Switch to translated first
      tabTranslated.click();
      // Then back
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

      // Set up a card-ui with an original slot containing paragraphs
      const cardUi = el.querySelector('card-ui') as HTMLElement & {
        getOriginalSlot: () => HTMLElement | null;
      };
      const slot = cardUi.getOriginalSlot();
      if (slot) {
        slot.innerHTML = '<p data-id="p1" data-index="0">Hello</p><p data-id="p2" data-index="1">World</p>';
      }

      const btn = el.querySelector('.fab-bookmark') as HTMLButtonElement;
      btn.click();

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(createBookmark).toHaveBeenCalledWith('book-123', {
        chapterIndex: 2,
        paragraphId: expect.any(String),
      });
      expect(showToast).toHaveBeenCalledWith('Bookmark saved', 'success');
    });

    it('bookmark FAB shows error toast on failure', async () => {
      const { createBookmark } = await import('../api/bookmarks');
      const { showToast } = await import('./toast');

      // Make createBookmark reject
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

    it('library FAB dispatches navigate event with screen: library', () => {
      const handler = vi.fn();
      el.addEventListener('navigate', handler);

      const btn = el.querySelector('.fab-library') as HTMLButtonElement;
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
