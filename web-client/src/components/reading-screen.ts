import { t } from '../i18n/index';
import { apiFetch } from '../api/client';
import { putReadingState } from '../api/state';
import { postTranslate } from '../api/translate';
import { getPreferences } from '../api/preferences';
import { createBookmark } from '../api/bookmarks';
import { showToast } from './toast';
import * as translationCache from '../cache/translation-cache';
import type { CacheKey, ChapterResponse, Paragraph, ReadingState } from '../types';
import { isOfflineMode, isLocalId, getLocalChapter } from '../api/local-db';
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
    this.initTargetLang();
    // Use rAF to ensure nested custom elements (card-ui) have completed
    // their connectedCallback and rendered their internal DOM.
    requestAnimationFrame(() => {
      this.loadChapter(this.initialState.currentChapter);
    });
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

  /**
   * Fetches the user's preferred translation language once and caches it
   * for the lifetime of this component instance. Avoids repeated
   * /api/preferences calls on every chapter load.
   */
  private async initTargetLang(): Promise<void> {
    try {
      const prefs = await getPreferences();
      this.targetLang = prefs.translationLang;
    } catch {
      // Keep default targetLang ('it')
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

        reading-screen .icon {
          width: 1em;
          height: 1em;
          display: inline-block;
          vertical-align: middle;
          filter: brightness(0) invert(1);
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

        reading-screen .fab-library-btn {
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

        reading-screen .fab-library-btn:hover,
        reading-screen .fab-library-btn:focus-visible {
          background: var(--hover-bg, rgba(255, 255, 255, 0.1));
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
          bottom: 55px;
          overflow: hidden;
        }

        reading-screen .reading-content card-ui {
          width: 100%;
          height: 100%;
        }

        /* Hide Original/Translated tabs in wide mode (both panels visible) */
        @media (min-width: 768px) {
          reading-screen .tab-group {
            display: none;
          }
        }

        reading-screen .fab-group {
          position: fixed;
          bottom: 68px;
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

        reading-screen .chapter-nav {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          height: 52px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          background: var(--header-bg, #1a1a1a);
          border-top: 1px solid var(--border-color, #333);
          z-index: 40;
        }

        reading-screen .reading-progress {
          position: fixed;
          bottom: 52px;
          left: 0;
          right: 0;
          height: 3px;
          background: var(--border-color, #333);
          z-index: 40;
          display: flex;
          align-items: stretch;
        }

        reading-screen .reading-progress-fill {
          height: 100%;
          background: var(--accent, #c0392b);
          transition: width 0.15s ease;
        }

        reading-screen .reading-progress-label {
          position: absolute;
          right: 6px;
          top: -14px;
          font-size: 0.6rem;
          color: var(--text-muted, #999);
          pointer-events: none;
        }

        reading-screen .chapter-nav-btn {
          min-width: 44px;
          min-height: 44px;
          padding: 8px 16px;
          border: none;
          background: transparent;
          color: var(--text-color, #e0e0e0);
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          border-radius: 6px;
          transition: background 0.15s;
        }

        reading-screen .chapter-nav-btn:hover,
        reading-screen .chapter-nav-btn:focus-visible {
          background: var(--hover-bg, rgba(255, 255, 255, 0.1));
        }

        reading-screen .chapter-nav-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }

        reading-screen .chapter-nav-btn:disabled:hover {
          background: transparent;
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
        <button class="fab-library-btn" aria-label="${t('fab.library')}"><img class="icon" src="/icons/book-bookmark.svg" alt="" aria-hidden="true"></button>
        <div class="tab-group" role="tablist">
          <button class="tab-btn tab-original active" role="tab" aria-selected="true" aria-label="${t('reading.tabOriginal')}">${t('reading.tabOriginal')}</button>
          <button class="tab-btn tab-translated" role="tab" aria-selected="false" aria-label="${t('reading.tabTranslated')}">${t('reading.tabTranslated')}</button>
        </div>
      </header>
      <div class="reading-content">
        <card-ui></card-ui>
      </div>
      <div class="reading-progress">
        <div class="reading-progress-fill"></div>
        <span class="reading-progress-label">0%</span>
      </div>
      <nav class="chapter-nav">
        <button class="chapter-nav-btn nav-prev" aria-label="${t('reading.prevChapter')}">← ${t('reading.prevChapter')}</button>
        <button class="settings-btn" aria-label="${t('reading.settingsTooltip')}"><img class="icon" src="/icons/gear.svg" alt="" aria-hidden="true"></button>
        <button class="chapter-nav-btn nav-next" aria-label="${t('reading.nextChapter')}">${t('reading.nextChapter')} →</button>
      </nav>
      <div class="fab-group">
        <button class="fab fab-bookmark" aria-label="${t('fab.bookmark')}"><img class="icon" src="/icons/star.svg" alt="" aria-hidden="true"></button>
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

    // Listen to card-change from card-ui (e.g. on swipe) to sync header tabs
    cardUi?.addEventListener('card-change', ((e: CustomEvent<{ activeCard: 'original' | 'translated' }>) => {
      const card = e.detail?.activeCard;
      if (card === 'translated') {
        tabTranslated?.classList.add('active');
        tabTranslated?.setAttribute('aria-selected', 'true');
        tabOriginal?.classList.remove('active');
        tabOriginal?.setAttribute('aria-selected', 'false');
      } else if (card === 'original') {
        tabOriginal?.classList.add('active');
        tabOriginal?.setAttribute('aria-selected', 'true');
        tabTranslated?.classList.remove('active');
        tabTranslated?.setAttribute('aria-selected', 'false');
      }
    }) as EventListener);

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

    // Library button: navigate back to library screen
    const libraryBtn = this.querySelector('.fab-library-btn') as HTMLButtonElement;
    libraryBtn?.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('navigate', {
          bubbles: true,
          composed: true,
          detail: { screen: 'library' },
        })
      );
    });

    // Chapter navigation buttons
    const prevBtn = this.querySelector('.nav-prev') as HTMLButtonElement;
    const nextBtn = this.querySelector('.nav-next') as HTMLButtonElement;

    prevBtn?.addEventListener('click', () => {
      if (this.currentChapter > 0) {
        this.loadChapter(this.currentChapter - 1);
      }
    });

    nextBtn?.addEventListener('click', () => {
      this.loadChapter(this.currentChapter + 1);
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

    const paragraph = this.findTopmostVisibleParagraph(originalSlot);
    if (!paragraph?.id) return;

    try {
      await createBookmark(this.bookId, {
        chapterIndex: this.currentChapter,
        paragraphId: paragraph.id,
        paragraphIndex: isNaN(paragraph.index) ? undefined : paragraph.index,
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
   *
   * If the loaded chapter has no paragraphs (e.g. cover page, title page),
   * automatically advances to the next chapter that has content.
   */
  public async loadChapter(chapterIndex: number): Promise<void> {
    if (!this.bookId) return;

    let chapter: ChapterResponse;
    if (isOfflineMode() || isLocalId(this.bookId)) {
      try {
        chapter = await getLocalChapter(this.bookId, chapterIndex);
      } catch (e) {
        console.error('Error loading local chapter:', e);
        return;
      }
    } else {
      const response = await apiFetch(`/api/books/${this.bookId}/chapter/${chapterIndex}`);
      if (!response.ok) return;
      chapter = await response.json();
    }

    this.currentChapter = chapterIndex;
    this.paragraphData = chapter.paragraphs;

    // If chapter has no paragraphs (cover/title page), skip to next chapter
    if (chapter.paragraphs.length === 0) {
      const nextIndex = chapterIndex + 1;
      if (isOfflineMode() || isLocalId(this.bookId)) {
        try {
          await getLocalChapter(this.bookId, nextIndex);
          return this.loadChapter(nextIndex);
        } catch {
          return;
        }
      } else {
        const nextResponse = await apiFetch(`/api/books/${this.bookId}/chapter/${nextIndex}`);
        if (nextResponse.ok) {
          return this.loadChapter(nextIndex);
        }
      }
      // If no next chapter either, just stay on empty (end of book)
      return;
    }

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

    // Scroll to saved position after rendering, then set up observer
    requestAnimationFrame(() => {
      // Only restore saved position for the initial chapter load
      if (chapterIndex === this.initialState.currentChapter) {
        this.restoreScrollPosition(originalSlot);
        this.restoreScrollPosition(translatedSlot);
      } else {
        originalSlot.scrollTop = 0;
        translatedSlot.scrollTop = 0;
      }
      this.attachScrollListener(originalSlot, translatedSlot);
      this.setupTranslationObserver(originalSlot, translatedSlot);
    });

    this.updateNavButtons();
  }

  /**
   * Updates the disabled state of the prev/next chapter buttons
   * based on the current chapter index.
   */
  private updateNavButtons(): void {
    const prevBtn = this.querySelector('.nav-prev') as HTMLButtonElement | null;
    const nextBtn = this.querySelector('.nav-next') as HTMLButtonElement | null;

    if (prevBtn) {
      prevBtn.disabled = this.currentChapter <= 0;
    }
    if (nextBtn) {
      // We don't know total chapters, so always enable next.
      // loadChapter will handle the case where the chapter doesn't exist.
      nextBtn.disabled = false;
    }
  }

  /**
   * Restores scroll position from the initial reading state.
   * Prioritises paragraphId; falls back to scrollOffset.
   */
  private restoreScrollPosition(slot: HTMLElement): void {
    if (this.initialState.paragraphId) {
      const target = slot.querySelector<HTMLElement>(
        `[data-id="${this.initialState.paragraphId}"]`
      );
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
    }

    // Fall back to scrollOffset
    slot.scrollTop = this.initialState.scrollOffset;
  }

  /**
   * Attaches a debounced scroll listener on both the Original and Translated
   * card content slots. On narrow/portrait screens the two panels are
   * independent slide views (not scroll-synced by <card-ui>), so the
   * Translated panel needs its own listener to keep the progress bar and
   * persisted reading state up to date while the user reads the translation.
   * On wide screens both listeners still work fine since the panels are
   * scroll-synced by <card-ui>.
   */
  private attachScrollListener(originalSlot: HTMLElement, translatedSlot: HTMLElement): void {
    const onScroll = (slot: HTMLElement) => {
      // Update progress bar immediately (visual only, no API call)
      this.updateProgressBar(this.calculateProgress(slot));

      if (this.scrollDebounceTimer !== null) {
        clearTimeout(this.scrollDebounceTimer);
      }

      this.scrollDebounceTimer = setTimeout(() => {
        this.saveReadingState(slot);
      }, 1000);
    };

    originalSlot.addEventListener('scroll', () => onScroll(originalSlot));
    translatedSlot.addEventListener('scroll', () => onScroll(translatedSlot));
  }

  /**
   * Calculates the current reading position and persists it via the API.
   */
  private saveReadingState(originalSlot: HTMLElement): void {
    const paragraphId = this.findTopmostVisibleParagraphId(originalSlot);
    const scrollOffset = originalSlot.scrollTop;
    const progress = this.calculateProgress(originalSlot);

    this.updateProgressBar(progress);

    const state: ReadingState = {
      currentChapter: this.currentChapter,
      paragraphId,
      scrollOffset,
      progress,
    };

    putReadingState(this.bookId, state);
  }

  /** Updates the visual progress bar at the bottom of the reading screen. */
  private updateProgressBar(progress: number): void {
    const fill = this.querySelector('.reading-progress-fill') as HTMLElement | null;
    const label = this.querySelector('.reading-progress-label') as HTMLElement | null;
    if (fill) fill.style.width = `${progress}%`;
    if (label) label.textContent = `${progress}%`;
  }

  /**
   * Finds the topmost paragraph whose top edge is at or below
   * the visible area of the scroll container.
   */
  private findTopmostVisibleParagraph(originalSlot: HTMLElement): { id: string; index: number } | null {
    const paragraphs = originalSlot.querySelectorAll<HTMLElement>('[data-id]');
    const containerRect = originalSlot.getBoundingClientRect();

    for (const p of paragraphs) {
      const rect = p.getBoundingClientRect();
      if (rect.top >= containerRect.top) {
        const id = p.getAttribute('data-id');
        const indexStr = p.getAttribute('data-index');
        if (!id) continue;
        return { id, index: indexStr === null ? NaN : parseInt(indexStr, 10) };
      }
    }

    // If none found above the top, return the last paragraph
    if (paragraphs.length > 0) {
      const last = paragraphs[paragraphs.length - 1];
      const id = last.getAttribute('data-id');
      const indexStr = last.getAttribute('data-index');
      if (id) {
        return { id, index: indexStr === null ? NaN : parseInt(indexStr, 10) };
      }
    }
    return null;
  }

  private findTopmostVisibleParagraphId(originalSlot: HTMLElement): string | null {
    return this.findTopmostVisibleParagraph(originalSlot)?.id || null;
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

  private readonly LAZY_CHUNK = 12;

  /**
   * Sets up lazy translation using the sentinel pattern (like the desktop app).
   * Uses IntersectionObserver with root: translatedSlot.
   * The translated slot is always in the DOM and visible (even in narrow mode,
   * it's positioned off-screen but still has layout), so the observer works.
   *
   * Flow:
   * 1. Translate the chunk at the current scroll position immediately
   * 2. Fire-and-forget chunks above (upward)
   * 3. Set up observer on the last paragraph of current chunk → on intersect,
   *    translate next chunk and move sentinel forward
   */
  private setupTranslationObserver(_originalSlot: HTMLElement, translatedSlot: HTMLElement): void {
    if (this.translationObserver) {
      this.translationObserver.disconnect();
      this.translationObserver = null;
    }
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingBatch.clear();
    this.inFlightIndices.clear();

    const total = this.paragraphData.length;
    if (total === 0) return;

    const totalChunks = Math.ceil(total / this.LAZY_CHUNK);
    const translatedChunks = new Set<number>();

    // Determine starting chunk based on scroll position
    const startChunk = 0;

    // Translate a single chunk by index
    const translateChunk = async (chunkIdx: number): Promise<void> => {
      if (translatedChunks.has(chunkIdx) || chunkIdx < 0 || chunkIdx >= totalChunks) return;
      translatedChunks.add(chunkIdx);

      const start = chunkIdx * this.LAZY_CHUNK;
      const end = Math.min(start + this.LAZY_CHUNK, total);
      const indices = Array.from({ length: end - start }, (_, i) => start + i);

      // Check cache first, collect uncached
      const uncachedIndices: number[] = [];
      for (const idx of indices) {
        const paragraph = this.paragraphData[idx];
        if (!paragraph) continue;
        const cacheKey = {
          bookId: this.bookId,
          chapterIndex: this.currentChapter,
          paragraphId: paragraph.id,
          targetLang: this.targetLang,
        };
        const cached = await translationCache.get(cacheKey);
        if (cached !== undefined) {
          this.setTranslatedText(translatedSlot, idx, cached);
        } else {
          uncachedIndices.push(idx);
        }
      }

      if (uncachedIndices.length === 0) return;

      // Show placeholders
      for (const idx of uncachedIndices) {
        this.showPlaceholder(translatedSlot, idx);
      }

      // Batch translate
      const texts = uncachedIndices.map(idx => this.paragraphData[idx].text);
      try {
        const translations = await postTranslate(texts, 'auto', this.targetLang);
        for (let i = 0; i < uncachedIndices.length; i++) {
          const idx = uncachedIndices[i];
          const translated = translations[i];
          if (!translated || translated.trim() === '') {
            // The translation engine returned nothing for this paragraph
            // (can happen with very short/dialogue-style text). Surface it
            // as an error with tap-to-retry instead of silently leaving the
            // paragraph blank and uncached forever.
            this.showError(translatedSlot, idx);
            continue;
          }
          this.setTranslatedText(translatedSlot, idx, translated);
          // Cache it
          const paragraph = this.paragraphData[idx];
          translationCache.set({
            bookId: this.bookId,
            chapterIndex: this.currentChapter,
            paragraphId: paragraph.id,
            targetLang: this.targetLang,
          }, translated);
        }
      } catch {
        for (const idx of uncachedIndices) {
          this.showError(translatedSlot, idx);
        }
      }
    };

    // Translate first chunk immediately
    translateChunk(startChunk);

    // Set up sentinel observer for lazy loading downward
    let nextDownChunk = startChunk + 1;

    const observeNextSentinel = () => {
      if (nextDownChunk >= totalChunks) return;

      const sentinelIdx = Math.min(nextDownChunk * this.LAZY_CHUNK - 1, total - 1);
      const sentinel = translatedSlot.querySelector<HTMLElement>(`[data-index="${sentinelIdx}"]`);
      if (!sentinel) return;

      this.translationObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            this.translationObserver?.unobserve(entry.target);
            translateChunk(nextDownChunk++);
            observeNextSentinel();
          }
        },
        { root: translatedSlot, threshold: 0.1 }
      );

      this.translationObserver.observe(sentinel);
    };

    observeNextSentinel();
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
      el.onclick = async () => {
        this.showPlaceholder(translatedSlot, index);
        const paragraph = this.paragraphData[index];
        if (!paragraph) return;
        try {
          const translations = await postTranslate([paragraph.text], 'auto', this.targetLang);
          const translated = translations[0];
          if (!translated || translated.trim() === '') {
            this.showError(translatedSlot, index);
            return;
          }
          this.setTranslatedText(translatedSlot, index, translated);
          translationCache.set({
            bookId: this.bookId,
            chapterIndex: this.currentChapter,
            paragraphId: paragraph.id,
            targetLang: this.targetLang,
          }, translated);
        } catch {
          this.showError(translatedSlot, index);
        }
      };
    }
  }
}

customElements.define('reading-screen', ReadingScreen);
