import { t } from '../i18n/index';
import { apiFetch } from '../api/client';
import { putReadingState } from '../api/state';
import { postTranslate } from '../api/translate';
import { getPreferences } from '../api/preferences';
import { createBookmark } from '../api/bookmarks';
import { showToast } from './toast';
import * as translationCache from '../cache/translation-cache';
import type { CacheKey, ChapterResponse, Paragraph, ReadingState } from '../types';
import './card-ui';

/**
 * <reading-screen> — Main reading view with header, card area, and FAB group.
 *
 * Layout:
 * - Fixed 56px header: Settings button (⚙) left, Original/Translated tabs right
 * - Scrollable content area filling remaining viewport height
 * - FAB group fixed bottom-right (Bookmark 🔖, Library 📚, TTS placeholder)
 *
 * All touch targets ≥ 44×44px. All interactive elements have aria-label.
 * DOM tab order follows visual top-to-bottom, left-to-right order.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
 */
class ReadingScreen extends HTMLElement {
  private bookId: string = '';
  private initialState: ReadingState = {
    currentChapter: 0,
    paragraphId: null,
    scrollOffset: 0,
    progress: 0,
  };
  private currentChapter: number = 0;
  private scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Lazy translation state
  private translationObserver: IntersectionObserver | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBatch: Set<number> = new Set();
  private inFlightIndices: Set<number> = new Set();
  private targetLang: string = 'it';
  private paragraphData: Paragraph[] = [];

  /** Set book context via property from navigation. */
  public setBook(
    bookId: string,
    state: ReadingState
  ): void {
    this.bookId = bookId;
    this.initialState = state;
    this.currentChapter = state.currentChapter;
  }

  /** Returns the current book ID. */
  public getBookId(): string {
    return this.bookId;
  }

  /** Returns the initial reading state passed via setBook. */
  public getInitialState() {
    return this.initialState;
  }

  connectedCallback(): void {
    this.render();
    this.attachEventListeners();
    this.loadChapter(this.initialState.currentChapter);
  }

  disconnectedCallback(): void {
    if (this.scrollDebounceTimer !== null) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.translationObserver) {
      this.translationObserver.disconnect();
      this.translationObserver = null;
    }
  }

  private render(): void {
    this.innerHTML = `
      <style>
        reading-screen {
          display: block;
          width: 100%;
          height: 100vh;
          overflow: hidden;
          position: relative;
        }

        reading-screen .reading-header {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 56px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 8px;
          box-sizing: border-box;
          background: var(--header-bg, #1a1a1a);
          border-bottom: 1px solid var(--border-color, #333);
          z-index: 50;
        }

        reading-screen .settings-btn {
          min-width: 44px;
          min-height: 44px;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          background: transparent;
          font-size: 1.4rem;
          cursor: pointer;
          border-radius: 8px;
          color: var(--text-color, #e0e0e0);
        }

        reading-screen .settings-btn:hover,
        reading-screen .settings-btn:focus-visible {
          background: var(--hover-bg, rgba(255, 255, 255, 0.1));
        }

        reading-screen .tab-group {
          display: flex;
          gap: 4px;
        }

        reading-screen .tab-btn {
          min-width: 44px;
          min-height: 44px;
          padding: 8px 16px;
          border: none;
          background: transparent;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          border-radius: 6px;
          color: var(--text-muted, #999);
          transition: background 0.15s, color 0.15s;
        }

        reading-screen .tab-btn:hover,
        reading-screen .tab-btn:focus-visible {
          background: var(--hover-bg, rgba(255, 255, 255, 0.1));
        }

        reading-screen .tab-btn.active {
          color: var(--text-color, #e0e0e0);
          background: var(--tab-active-bg, rgba(255, 255, 255, 0.15));
          font-weight: 600;
        }

        reading-screen .reading-content {
          position: absolute;
          top: 56px;
          left: 0;
          right: 0;
          bottom: 0;
          overflow: hidden;
        }

        reading-screen .reading-content card-ui {
          display: block;
          width: 100%;
          height: 100%;
        }

        reading-screen .fab-group {
          position: fixed;
          bottom: 16px;
          right: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          z-index: 40;
        }

        reading-screen .fab {
          min-width: 44px;
          min-height: 44px;
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          border-radius: 50%;
          background: var(--fab-bg, #2a2a2a);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          font-size: 1.3rem;
          cursor: pointer;
          transition: transform 0.15s, box-shadow 0.15s;
          color: var(--text-color, #e0e0e0);
        }

        reading-screen .fab:hover,
        reading-screen .fab:focus-visible {
          transform: scale(1.08);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }

        reading-screen .fab:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          transform: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        reading-screen .translation-placeholder {
          background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%);
          background-size: 200% 100%;
          animation: translation-pulse 1.5s ease-in-out infinite;
          border-radius: 4px;
          min-height: 1.2em;
          margin: 0.4em 0;
        }

        @keyframes translation-pulse {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        reading-screen .translation-error {
          color: #e57373;
          font-style: italic;
          cursor: pointer;
          padding: 2px 0;
        }

        reading-screen .translation-error::before {
          content: '⚠ ';
        }
      </style>
      <header class="reading-header">
        <button class="settings-btn" aria-label="${t('reading.settingsTooltip')}">⚙</button>
        <div class="tab-group" role="tablist">
          <button class="tab-btn tab-original active" role="tab" aria-selected="true" aria-label="${t('reading.tabOriginal')}">${t('reading.tabOriginal')}</button>
          <button class="tab-btn tab-translated" role="tab" aria-selected="false" aria-label="${t('reading.tabTranslated')}">${t('reading.tabTranslated')}</button>
        </div>
      </header>
      <div class="reading-content">
        <card-ui></card-ui>
      </div>
      <div class="fab-group">
        <button class="fab fab-bookmark" aria-label="${t('fab.bookmark')}">🔖</button>
        <button class="fab fab-library" aria-label="${t('fab.library')}">📚</button>
        <button class="fab fab-tts" aria-label="${t('fab.tts')}" disabled>🔊</button>
      </div>
    `;
  }

  private attachEventListeners(): void {
    const tabOriginal = this.querySelector('.tab-original') as HTMLButtonElement;
    const tabTranslated = this.querySelector('.tab-translated') as HTMLButtonElement;
    const cardUi = this.querySelector('card-ui') as HTMLElement & {
      switchTo: (card: 'original' | 'translated') => void;
    };

    // Tab switching: wire to card-ui.switchTo() and toggle active class
    tabOriginal?.addEventListener('click', () => {
      this.activateTab('original', tabOriginal, tabTranslated, cardUi);
    });

    tabTranslated?.addEventListener('click', () => {
      this.activateTab('translated', tabTranslated, tabOriginal, cardUi);
    });

    // Settings button dispatches event for parent to open settings-sheet
    const settingsBtn = this.querySelector('.settings-btn') as HTMLButtonElement;
    settingsBtn?.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('open-settings', { bubbles: true, composed: true })
      );
    });

    // Bookmark FAB: create bookmark at current reading position
    const bookmarkFab = this.querySelector('.fab-bookmark') as HTMLButtonElement;
    bookmarkFab?.addEventListener('click', () => {
      this.handleAddBookmark();
    });

    // Library FAB: navigate back to library screen
    const libraryFab = this.querySelector('.fab-library') as HTMLButtonElement;
    libraryFab?.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('navigate', {
          bubbles: true,
          composed: true,
          detail: { screen: 'library' },
        })
      );
    });
  }

  private activateTab(
    card: 'original' | 'translated',
    activeBtn: HTMLButtonElement,
    inactiveBtn: HTMLButtonElement,
    cardUi: HTMLElement & { switchTo: (card: 'original' | 'translated') => void }
  ): void {
    activeBtn.classList.add('active');
    activeBtn.setAttribute('aria-selected', 'true');
    inactiveBtn.classList.remove('active');
    inactiveBtn.setAttribute('aria-selected', 'false');
    cardUi?.switchTo(card);
  }

  /**
   * Handles the Bookmark FAB tap: finds the topmost visible paragraph,
   * creates a bookmark via the API, and shows a confirmation or error toast.
   *
   * Validates: Requirements 13.1
   */
  private async handleAddBookmark(): Promise<void> {
    const cardUi = this.querySelector('card-ui') as HTMLElement & {
      getOriginalSlot: () => HTMLElement | null;
    };
    const originalSlot = cardUi?.getOriginalSlot();
    if (!originalSlot || !this.bookId) return;

    const paragraphId = this.findTopmostVisibleParagraphId(originalSlot);
    if (!paragraphId) return;

    try {
      await createBookmark(this.bookId, {
        chapterIndex: this.currentChapter,
        paragraphId,
      });
      showToast(t('toast.bookmarkSaved'), 'success');
    } catch {
      showToast(t('toast.errorGeneric'), 'error');
    }
  }

  /**
   * Fetches chapter content from the REST API and renders paragraphs
   * into both the Original and Translated card slots.
   * After rendering, scrolls to the saved position from initialState
   * and sets up lazy translation via IntersectionObserver.
   */
  public async loadChapter(chapterIndex: number): Promise<void> {
    if (!this.bookId) return;

    const response = await apiFetch(`/api/books/${this.bookId}/chapter/${chapterIndex}`);
    if (!response.ok) return;

    const chapter: ChapterResponse = await response.json();
    this.currentChapter = chapterIndex;
    this.paragraphData = chapter.paragraphs;

    const cardUi = this.querySelector('card-ui') as HTMLElement & {
      getOriginalSlot: () => HTMLElement | null;
      getTranslatedSlot: () => HTMLElement | null;
    };
    if (!cardUi) return;

    const originalSlot = cardUi.getOriginalSlot();
    const translatedSlot = cardUi.getTranslatedSlot();
    if (!originalSlot || !translatedSlot) return;

    // Render paragraphs into both slots
    originalSlot.innerHTML = chapter.paragraphs.map(p =>
      `<p data-index="${p.index}" data-id="${p.id}">${p.html}</p>`
    ).join('');

    translatedSlot.innerHTML = chapter.paragraphs.map(p =>
      `<p data-index="${p.index}" data-id="${p.id}" class="translation-placeholder"></p>`
    ).join('');

    // Fetch current targetLang from preferences
    try {
      const prefs = await getPreferences();
      this.targetLang = prefs.translationLang;
    } catch {
      // Keep default targetLang
    }

    // Scroll to saved position after rendering, then set up observer
    requestAnimationFrame(() => {
      this.restoreScrollPosition(originalSlot);
      this.attachScrollListener(originalSlot);
      this.setupTranslationObserver(originalSlot, translatedSlot);
    });
  }

  /**
   * Restores scroll position from the initial reading state.
   * Prioritises paragraphId; falls back to scrollOffset.
   */
  private restoreScrollPosition(originalSlot: HTMLElement): void {
    if (this.initialState.paragraphId) {
      const target = originalSlot.querySelector<HTMLElement>(
        `[data-id="${this.initialState.paragraphId}"]`
      );
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
    }

    // Fall back to scrollOffset
    originalSlot.scrollTop = this.initialState.scrollOffset;
  }

  /**
   * Attaches a debounced scroll listener on the original card's content slot.
   * On scroll, calculates the current reading position and persists it.
   */
  private attachScrollListener(originalSlot: HTMLElement): void {
    originalSlot.addEventListener('scroll', () => {
      if (this.scrollDebounceTimer !== null) {
        clearTimeout(this.scrollDebounceTimer);
      }

      this.scrollDebounceTimer = setTimeout(() => {
        this.saveReadingState(originalSlot);
      }, 1000);
    });
  }

  /**
   * Calculates the current reading position and persists it via the API.
   */
  private saveReadingState(originalSlot: HTMLElement): void {
    const paragraphId = this.findTopmostVisibleParagraphId(originalSlot);
    const scrollOffset = originalSlot.scrollTop;
    const progress = this.calculateProgress(originalSlot);

    const state: ReadingState = {
      currentChapter: this.currentChapter,
      paragraphId,
      scrollOffset,
      progress,
    };

    putReadingState(this.bookId, state);
  }

  /**
   * Finds the topmost paragraph whose top edge is at or below
   * the visible area of the scroll container.
   */
  private findTopmostVisibleParagraphId(originalSlot: HTMLElement): string | null {
    const paragraphs = originalSlot.querySelectorAll<HTMLElement>('[data-id]');
    const containerRect = originalSlot.getBoundingClientRect();

    for (const p of paragraphs) {
      const rect = p.getBoundingClientRect();
      if (rect.top >= containerRect.top) {
        return p.getAttribute('data-id');
      }
    }

    // If none found above the top, return the last paragraph
    if (paragraphs.length > 0) {
      return paragraphs[paragraphs.length - 1].getAttribute('data-id');
    }
    return null;
  }

  /**
   * Calculates approximate progress (0–100) based on scroll position.
   */
  private calculateProgress(originalSlot: HTMLElement): number {
    const scrollHeight = originalSlot.scrollHeight - originalSlot.clientHeight;
    if (scrollHeight <= 0) return 100;
    const ratio = originalSlot.scrollTop / scrollHeight;
    return Math.min(100, Math.max(0, Math.round(ratio * 100)));
  }

  // ─── Lazy Translation ──────────────────────────────────────────────────────

  /**
   * Sets up an IntersectionObserver on paragraphs in the Original card.
   * When paragraphs become visible, they are queued for batched translation.
   *
   * Validates: Requirements 11.1, 11.7
   */
  private setupTranslationObserver(originalSlot: HTMLElement, translatedSlot: HTMLElement): void {
    // Clean up previous observer
    if (this.translationObserver) {
      this.translationObserver.disconnect();
    }
    this.pendingBatch.clear();
    this.inFlightIndices.clear();

    this.translationObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = parseInt(
              (entry.target as HTMLElement).getAttribute('data-index') || '-1',
              10
            );
            if (index >= 0 && !this.inFlightIndices.has(index)) {
              this.pendingBatch.add(index);
            }
          }
        }

        if (this.pendingBatch.size > 0) {
          this.scheduleBatch(translatedSlot);
        }
      },
      {
        root: originalSlot,
        threshold: 0,
      }
    );

    // Observe all paragraph elements in the original slot
    const paragraphs = originalSlot.querySelectorAll<HTMLElement>('[data-index]');
    for (const p of paragraphs) {
      this.translationObserver.observe(p);
    }
  }

  /**
   * Debounces batch requests: waits 100ms to collect visible paragraphs
   * before firing a single batched translation request.
   */
  private scheduleBatch(translatedSlot: HTMLElement): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.processBatch(translatedSlot);
    }, 100);
  }

  /**
   * Processes the pending batch: checks cache for each paragraph,
   * sends uncached paragraphs in a single POST /api/translate call,
   * and updates the Translated card.
   *
   * Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
   */
  private async processBatch(translatedSlot: HTMLElement): Promise<void> {
    const indices = Array.from(this.pendingBatch).sort((a, b) => a - b);
    this.pendingBatch.clear();

    if (indices.length === 0) return;

    // Check cache for each paragraph
    const uncachedIndices: number[] = [];
    for (const idx of indices) {
      const paragraph = this.paragraphData[idx];
      if (!paragraph) continue;

      const cacheKey: CacheKey = {
        bookId: this.bookId,
        chapterIndex: this.currentChapter,
        paragraphId: paragraph.id,
        targetLang: this.targetLang,
      };

      const cached = await translationCache.get(cacheKey);
      if (cached !== undefined) {
        // Populate from cache immediately
        this.setTranslatedText(translatedSlot, idx, cached);
      } else {
        uncachedIndices.push(idx);
      }
    }

    if (uncachedIndices.length === 0) return;

    // Mark all uncached paragraphs as in-flight and show placeholder
    for (const idx of uncachedIndices) {
      this.inFlightIndices.add(idx);
      this.showPlaceholder(translatedSlot, idx);
    }

    // Batch all uncached texts into a single POST /api/translate
    const texts = uncachedIndices.map(idx => this.paragraphData[idx].text);
    const batchStartTime = Date.now();

    try {
      const translations = await postTranslate(texts, 'auto', this.targetLang);

      // Enforce minimum 150ms hold before showing results (Req 11.4)
      const elapsed = Date.now() - batchStartTime;
      if (elapsed < 150) {
        await new Promise(resolve => setTimeout(resolve, 150 - elapsed));
      }

      // Populate translations and cache them
      for (let i = 0; i < uncachedIndices.length; i++) {
        const idx = uncachedIndices[i];
        const translated = translations[i];
        const paragraph = this.paragraphData[idx];

        this.setTranslatedText(translatedSlot, idx, translated);
        this.inFlightIndices.delete(idx);

        // Store in cache
        const cacheKey: CacheKey = {
          bookId: this.bookId,
          chapterIndex: this.currentChapter,
          paragraphId: paragraph.id,
          targetLang: this.targetLang,
        };
        translationCache.set(cacheKey, translated);
      }
    } catch {
      // On failure: show inline error indicators with tap-to-retry (Req 11.6)
      for (const idx of uncachedIndices) {
        this.inFlightIndices.delete(idx);
        this.showError(translatedSlot, idx);
      }
    }
  }

  /**
   * Shows a pulsing placeholder in the Translated card for a given paragraph index.
   */
  private showPlaceholder(translatedSlot: HTMLElement, index: number): void {
    const el = translatedSlot.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (el) {
      el.className = 'translation-placeholder';
      el.textContent = '';
    }
  }

  /**
   * Sets the translated text content for a given paragraph index in the Translated card.
   */
  private setTranslatedText(translatedSlot: HTMLElement, index: number, text: string): void {
    const el = translatedSlot.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (el) {
      el.className = '';
      el.textContent = text;
    }
  }

  /**
   * Shows an inline error indicator with tap-to-retry for a given paragraph index.
   * Validates: Requirement 11.6
   */
  private showError(translatedSlot: HTMLElement, index: number): void {
    const el = translatedSlot.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (el) {
      el.className = 'translation-error';
      el.textContent = t('reading.translationError');
      el.onclick = () => {
        // Re-queue this paragraph for translation
        this.pendingBatch.add(index);
        this.showPlaceholder(translatedSlot, index);
        this.scheduleBatch(translatedSlot);
      };
    }
  }
}

customElements.define('reading-screen', ReadingScreen);
