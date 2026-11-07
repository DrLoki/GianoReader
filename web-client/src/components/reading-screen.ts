import { t } from '../i18n/index';
import { apiFetch } from '../api/client';
import { putReadingState } from '../api/state';
import { postTranslate } from '../api/translate';
import { getPreferences } from '../api/preferences';
import { createBookmark } from '../api/bookmarks';
import { showToast } from './toast';
import * as translationCache from '../cache/translation-cache';
import type { ChapterResponse, Paragraph, ReadingState, TocEntry } from '../types';
import { getToc } from '../api/books';
import { escapeHtml, bookProgress, chunkOf, resolveEpubLink } from '../utils/reading';
import { isOfflineMode, isLocalId, getLocalChapter } from '../api/local-db';
import { iconList, iconStar, iconHouse, iconGear, iconChevronLeft, iconChevronRight } from '../icons';
import './card-ui';
import './toc-sheet';

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
/** Upper bound of consecutive empty chapters (covers, title pages) skipped automatically. */
const MAX_EMPTY_CHAPTER_SKIP = 50;

class ReadingScreen extends HTMLElement {
  private bookId: string = '';
  private initialState: ReadingState = {
    currentChapter: 0,
    paragraphId: null,
    scrollOffset: 0,
    progress: 0,
  };
  private currentChapter: number = 0;
  /** Total spine items, once a chapter response told us (null = unknown). */
  private totalChapters: number | null = null;
  private scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollListenersAttached = false;
  /** Slot the user scrolled last (original or translated), used to save state. */
  private lastScrolledSlot: HTMLElement | null = null;
  /** Removes document-level listeners (pagehide / visibilitychange) on disconnect. */
  private lifecycleAbort: AbortController | null = null;
  /** Cached TOC used to resolve links between EPUB files. */
  private tocPromise: Promise<TocEntry[]> | null = null;

  /**
   * Incremented on every chapter load. Async work (fetches, translations)
   * captures the value it started with and drops its result when it no longer
   * matches, so a slow response can never land in a different chapter.
   */
  private loadGeneration = 0;

  // Lazy translation state
  private translationObserver: IntersectionObserver | null = null;
  private targetLang: string = 'it';
  private targetLangReady: Promise<void> = Promise.resolve();
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

  /**
   * Returns the current reading position, e.g. to re-mount the screen after a
   * UI language change without losing the place.
   */
  public getCurrentState(): ReadingState {
    const slot = this.lastScrolledSlot ?? this.getOriginalSlot();
    if (!slot || !slot.isConnected) {
      return { ...this.initialState, currentChapter: this.currentChapter };
    }
    return this.buildState(slot);
  }

  /** Persists a pending (debounced) reading-state save immediately. */
  public flushState(): void {
    if (this.scrollDebounceTimer === null) return;
    clearTimeout(this.scrollDebounceTimer);
    this.scrollDebounceTimer = null;
    const slot = this.lastScrolledSlot;
    if (slot && slot.isConnected) {
      this.saveReadingState(slot);
    }
  }

  connectedCallback(): void {
    this.render();
    this.attachEventListeners();
    this.targetLangReady = this.initTargetLang();

    // Phones kill backgrounded PWAs without warning: save the position as
    // soon as the app is hidden instead of waiting for the debounce timer.
    this.lifecycleAbort = new AbortController();
    const { signal } = this.lifecycleAbort;
    window.addEventListener('pagehide', () => this.flushState(), { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushState();
    }, { signal });

    // Use rAF to ensure nested custom elements (card-ui) have completed
    // their connectedCallback and rendered their internal DOM.
    requestAnimationFrame(() => {
      this.loadChapter(this.initialState.currentChapter);
    });
  }

  disconnectedCallback(): void {
    // Invalidate in-flight loads/translations
    this.loadGeneration++;
    if (this.scrollDebounceTimer !== null) {
      clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = null;
    }
    if (this.translationObserver) {
      this.translationObserver.disconnect();
      this.translationObserver = null;
    }
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
  }

  /**
   * Fetches the user's preferred translation language once and caches it
   * for the lifetime of this component instance. Avoids repeated
   * /api/preferences calls on every chapter load.
   */
  private async initTargetLang(): Promise<void> {
    try {
      const prefs = await getPreferences();
      if (prefs?.translationLang) this.targetLang = prefs.translationLang;
    } catch {
      // Keep default targetLang ('it')
    }
  }

  private getOriginalSlot(): HTMLElement | null {
    const cardUi = this.querySelector('card-ui') as (HTMLElement & {
      getOriginalSlot?: () => HTMLElement | null;
    }) | null;
    return cardUi?.getOriginalSlot?.() ?? null;
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
          filter: var(--icon-filter, brightness(0) invert(1));
        }

        reading-screen .reading-header {
          position: fixed;
          bottom: calc(48px + env(safe-area-inset-bottom, 0px));
          left: 0;
          width: 100%;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 8px;
          box-sizing: border-box;
          background: color-mix(in srgb, var(--header-bg, #1a1a1a) 85%, transparent);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-top: 1px solid var(--border-color, #333);
          z-index: 50;
        }

        reading-screen .toc-btn,
        reading-screen .fab-library-btn,
        reading-screen .fab-bookmark,
        reading-screen .nav-icon-btn {
          min-width: 44px;
          min-height: 44px;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          background: transparent;
          font-size: 1.25rem;
          cursor: pointer;
          border-radius: 8px;
          color: var(--text-color, #e0e0e0);
          transition: background 0.15s;
        }

        reading-screen .toc-btn:hover,
        reading-screen .toc-btn:focus-visible,
        reading-screen .fab-library-btn:hover,
        reading-screen .fab-library-btn:focus-visible,
        reading-screen .fab-bookmark:hover,
        reading-screen .fab-bookmark:focus-visible,
        reading-screen .nav-icon-btn:hover,
        reading-screen .nav-icon-btn:focus-visible {
          background: var(--hover-bg, rgba(255, 255, 255, 0.1));
        }

        reading-screen .nav-icon-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }

        reading-screen .nav-icon-btn:disabled:hover {
          background: transparent;
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
          box-shadow: inset 0 -2px 0 var(--accent, #c0392b);
        }

        reading-screen .reading-content a[href],
        reading-screen .reading-content a[data-epub-href] {
          cursor: pointer;
          color: var(--accent-color, #4a9eff);
        }

        reading-screen .reading-content {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: calc(99px + env(safe-area-inset-bottom, 0px));
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

        reading-screen .chapter-nav {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          height: calc(48px + env(safe-area-inset-bottom, 0px));
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 4px;
          padding-bottom: env(safe-area-inset-bottom, 0px);
          background: color-mix(in srgb, var(--header-bg, #1a1a1a) 85%, transparent);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-top: 1px solid var(--border-color, #333);
          z-index: 40;
        }

        reading-screen .chapter-nav-left,
        reading-screen .chapter-nav-right {
          display: flex;
          align-items: center;
          gap: 0;
        }

        reading-screen .reading-progress {
          position: fixed;
          bottom: calc(96px + env(safe-area-inset-bottom, 0px));
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

        reading-screen .translation-pending {
          color: var(--text-muted, #999);
          opacity: 0.5;
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
      <div class="reading-content">
        <card-ui></card-ui>
      </div>
      <div class="reading-progress">
        <div class="reading-progress-fill"></div>
        <span class="reading-progress-label">0%</span>
      </div>
      <header class="reading-header">
        <button class="toc-btn" aria-label="${t('reading.toc')}">${iconList}</button>
        <div class="tab-group" role="tablist">
          <button class="tab-btn tab-original active" role="tab" aria-selected="true" aria-label="${t('reading.tabOriginal')}">${t('reading.tabOriginal')}</button>
          <button class="tab-btn tab-translated" role="tab" aria-selected="false" aria-label="${t('reading.tabTranslated')}">${t('reading.tabTranslated')}</button>
        </div>
        <button class="fab-bookmark" aria-label="${t('fab.bookmark')}">${iconStar}</button>
      </header>
      <nav class="chapter-nav">
        <div class="chapter-nav-left">
          <button class="nav-icon-btn fab-library-btn" aria-label="${t('fab.library')}">${iconHouse}</button>
          <button class="nav-icon-btn settings-btn" aria-label="${t('reading.settingsTooltip')}">${iconGear}</button>
        </div>
        <div class="chapter-nav-right">
          <button class="nav-icon-btn nav-prev" aria-label="${t('reading.prevChapter')}">${iconChevronLeft}</button>
          <button class="nav-icon-btn nav-next" aria-label="${t('reading.nextChapter')}">${iconChevronRight}</button>
        </div>
      </nav>
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
        this.flushState();
        this.loadChapter(this.currentChapter - 1, -1);
      }
    });

    nextBtn?.addEventListener('click', () => {
      if (this.totalChapters !== null && this.currentChapter >= this.totalChapters - 1) return;
      this.flushState();
      this.loadChapter(this.currentChapter + 1, 1);
    });

    // Links inside the chapter (footnotes, cross references, web links).
    // Server books carry `href`, locally imported ones `data-epub-href`.
    this.addEventListener('click', (e) => {
      const target = e.target as Element | null;
      const link = target?.closest?.('a[href], a[data-epub-href]') as HTMLAnchorElement | null;
      if (!link || !this.contains(link)) return;
      e.preventDefault();
      const href = link.getAttribute('data-epub-href') ?? link.getAttribute('href') ?? '';
      this.followLink(href);
    });

    // TOC button: open the TOC/Bookmarks sheet
    const tocBtn = this.querySelector('.toc-btn') as HTMLButtonElement;
    tocBtn?.addEventListener('click', () => {
      this.openTocSheet();
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
   * Opens the TOC/Bookmarks bottom sheet.
   */
  private openTocSheet(): void {
    // Avoid opening multiple sheets
    if (document.querySelector('toc-sheet')) return;

    const sheet = document.createElement('toc-sheet') as HTMLElement & {
      bookId: string;
      currentChapter: number;
    };
    sheet.bookId = this.bookId;
    sheet.currentChapter = this.currentChapter;
    document.body.appendChild(sheet);

    // Listen for chapter navigation from the TOC sheet
    sheet.addEventListener('navigate-chapter', ((e: CustomEvent<{ chapterIndex: number; fragment?: string }>) => {
      // Se c'è un anchor fragment (es. #c5), impostalo come target di scroll
      this.initialState = {
        ...this.initialState,
        currentChapter: e.detail.chapterIndex,
        paragraphId: e.detail.fragment || null,
      };
      this.loadChapter(e.detail.chapterIndex);
    }) as EventListener);

    // Listen for bookmark navigation from the TOC sheet
    sheet.addEventListener('navigate-bookmark', ((e: CustomEvent<{ chapterIndex: number; paragraphId: string }>) => {
      this.initialState = {
        ...this.initialState,
        currentChapter: e.detail.chapterIndex,
        paragraphId: e.detail.paragraphId,
      };
      this.loadChapter(e.detail.chapterIndex);
    }) as EventListener);
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

  // ─── Chapter loading ───────────────────────────────────────────────────────

  /** Fetches one chapter from the local DB or the server; null if unavailable. */
  private async fetchChapter(index: number): Promise<ChapterResponse | null> {
    if (index < 0) return null;
    if (isOfflineMode() || isLocalId(this.bookId)) {
      try {
        return await getLocalChapter(this.bookId, index);
      } catch {
        return null;
      }
    }
    try {
      const response = await apiFetch(`/api/books/${this.bookId}/chapter/${index}`);
      if (!response.ok) return null;
      return (await response.json()) as ChapterResponse;
    } catch {
      return null;
    }
  }

  /**
   * Fetches chapter content and renders paragraphs into both the Original and
   * Translated card slots, then restores the saved position (initial load or
   * TOC/bookmark jump) and sets up lazy translation.
   *
   * Chapters without paragraphs (cover, title page) are skipped in the
   * direction of travel, so "previous" from chapter 2 over an empty chapter 1
   * lands on chapter 0 instead of bouncing forward again.
   */
  public async loadChapter(chapterIndex: number, direction: 1 | -1 = 1): Promise<void> {
    if (!this.bookId) return;
    const generation = ++this.loadGeneration;

    // The target language must be known before the first translation request
    await this.targetLangReady;
    if (generation !== this.loadGeneration) return;

    let index = chapterIndex;
    let chapter: ChapterResponse | null = null;
    for (let hops = 0; hops <= MAX_EMPTY_CHAPTER_SKIP; hops++) {
      const candidate = await this.fetchChapter(index);
      if (generation !== this.loadGeneration) return;
      if (!candidate) {
        if (hops === 0 && (isOfflineMode() || isLocalId(this.bookId))) {
          showToast(t('toast.errorGeneric'), 'error');
        }
        break;
      }
      if (typeof candidate.totalChapters === 'number') {
        this.totalChapters = candidate.totalChapters;
      }
      chapter = candidate;
      if (candidate.paragraphs.length > 0) break;
      const next = index + direction;
      if (next < 0 || (this.totalChapters !== null && next >= this.totalChapters)) break;
      index = next;
    }

    if (!chapter) return;
    // Only empty chapters until the start/end of the book: stay where we are,
    // unless the requested chapter itself is the only thing we could load.
    if (chapter.paragraphs.length === 0 && index !== chapterIndex) return;

    const cardUi = this.querySelector('card-ui') as HTMLElement & {
      getOriginalSlot: () => HTMLElement | null;
      getTranslatedSlot: () => HTMLElement | null;
    };
    if (!cardUi) return;
    const originalSlot = cardUi.getOriginalSlot();
    const translatedSlot = cardUi.getTranslatedSlot();
    if (!originalSlot || !translatedSlot) return;

    this.currentChapter = index;
    this.paragraphData = chapter.paragraphs;

    // data-pos = position in paragraphData (used for all lookups);
    // data-index = paragraph index from the parser (used for bookmarks).
    // `html` is sanitised by the parser; `text` is plain text and is escaped.
    originalSlot.innerHTML = chapter.paragraphs.map((p, pos) =>
      `<p data-pos="${pos}" data-index="${p.index}" data-id="${escapeHtml(p.id)}"${p.nativeId ? ` id="${escapeHtml(p.nativeId)}"` : ''}>${p.html}</p>`
    ).join('');
    translatedSlot.innerHTML = chapter.paragraphs.map((p, pos) =>
      `<p data-pos="${pos}" data-index="${p.index}" data-id="${escapeHtml(p.id)}" class="translation-pending">${escapeHtml(p.text)}</p>`
    ).join('');

    this.updateNavButtons();

    // Scroll to saved position after rendering, then set up observer
    requestAnimationFrame(() => {
      if (generation !== this.loadGeneration) return;
      // The saved position applies once, to the chapter it belongs to
      if (index === this.initialState.currentChapter) {
        this.restoreScrollPosition(originalSlot);
        this.restoreScrollPosition(translatedSlot);
        this.initialState = { ...this.initialState, currentChapter: -1 };
      } else {
        originalSlot.scrollTop = 0;
        translatedSlot.scrollTop = 0;
      }
      this.attachScrollListener(originalSlot, translatedSlot);
      this.updateProgressBar(this.computeBookProgress(originalSlot));
      this.setupTranslationObserver(translatedSlot, generation, index);
    });
  }

  /**
   * Updates the disabled state of the prev/next chapter buttons
   * based on the current chapter index and, when known, the book length.
   */
  private updateNavButtons(): void {
    const prevBtn = this.querySelector('.nav-prev') as HTMLButtonElement | null;
    const nextBtn = this.querySelector('.nav-next') as HTMLButtonElement | null;
    if (prevBtn) {
      prevBtn.disabled = this.currentChapter <= 0;
    }
    if (nextBtn) {
      nextBtn.disabled =
        this.totalChapters !== null && this.currentChapter >= this.totalChapters - 1;
    }
  }

  /** Finds an element by exact attribute value without building a CSS selector from untrusted input. */
  private findByAttr(slot: HTMLElement, attr: 'id' | 'data-id', value: string): HTMLElement | null {
    const candidates = slot.querySelectorAll<HTMLElement>(`[${attr}]`);
    for (const el of candidates) {
      if (el.getAttribute(attr) === value) return el;
    }
    return null;
  }

  /**
   * Restores scroll position from the initial reading state.
   * Prioritises paragraphId; falls back to scrollOffset.
   * Also handles EPUB native anchors ([id=...]) for TOC fragment navigation.
   */
  private restoreScrollPosition(slot: HTMLElement): void {
    const target = this.initialState.paragraphId;
    if (target) {
      // 1. Paragraph id (bookmark / saved position)
      // 2. Native EPUB anchor (TOC fragment like #c5, also on inline elements)
      const el = this.findByAttr(slot, 'data-id', target) ?? this.findByAttr(slot, 'id', target);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return;
      }
    }
    // Fall back to scrollOffset
    slot.scrollTop = this.initialState.scrollOffset;
  }

  /**
   * Attaches a debounced scroll listener on both the Original and Translated
   * card content slots (once: the slots live as long as <card-ui>). On narrow
   * screens the two panels are independent slide views, so the Translated
   * panel needs its own listener to keep the progress bar and persisted
   * reading state up to date while the user reads the translation.
   */
  private attachScrollListener(originalSlot: HTMLElement, translatedSlot: HTMLElement): void {
    if (this.scrollListenersAttached) return;
    this.scrollListenersAttached = true;

    const onScroll = (slot: HTMLElement) => {
      this.lastScrolledSlot = slot;
      // Update progress bar immediately (visual only, no API call)
      this.updateProgressBar(this.computeBookProgress(slot));

      if (this.scrollDebounceTimer !== null) {
        clearTimeout(this.scrollDebounceTimer);
      }
      this.scrollDebounceTimer = setTimeout(() => {
        this.scrollDebounceTimer = null;
        this.saveReadingState(slot);
      }, 1000);
    };

    originalSlot.addEventListener('scroll', () => onScroll(originalSlot));
    translatedSlot.addEventListener('scroll', () => onScroll(translatedSlot));
  }

  private buildState(slot: HTMLElement): ReadingState {
    return {
      currentChapter: this.currentChapter,
      paragraphId: this.findTopmostVisibleParagraphId(slot),
      scrollOffset: slot.scrollTop,
      progress: this.computeBookProgress(slot),
    };
  }

  /**
   * Calculates the current reading position and persists it via the API.
   */
  private saveReadingState(slot: HTMLElement): void {
    if (!this.bookId) return;
    const state = this.buildState(slot);
    this.updateProgressBar(state.progress);
    putReadingState(this.bookId, state).catch(() => {
      // Saving is best-effort; the next scroll retries
    });
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
  private findTopmostVisibleParagraph(slot: HTMLElement): { id: string; index: number } | null {
    const paragraphs = slot.querySelectorAll<HTMLElement>('[data-id]');
    const containerRect = slot.getBoundingClientRect();

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

  private findTopmostVisibleParagraphId(slot: HTMLElement): string | null {
    return this.findTopmostVisibleParagraph(slot)?.id || null;
  }

  /** Scroll ratio (0–1) inside the current chapter. */
  private chapterRatio(slot: HTMLElement): number {
    const scrollHeight = slot.scrollHeight - slot.clientHeight;
    if (scrollHeight <= 0) return 1;
    return slot.scrollTop / scrollHeight;
  }

  /** Whole-book progress (0–100), shown in the bar and in the library. */
  private computeBookProgress(slot: HTMLElement): number {
    return bookProgress(this.currentChapter, this.chapterRatio(slot), this.totalChapters);
  }

  // ─── Links inside chapter content ─────────────────────────────────────────

  private getTocCached(): Promise<TocEntry[]> {
    if (!this.tocPromise) {
      this.tocPromise = getToc(this.bookId).catch(() => {
        this.tocPromise = null;
        return [];
      });
    }
    return this.tocPromise;
  }

  /** Scrolls both panels to the paragraph containing the anchor `fragment`. */
  private scrollToAnchor(fragment: string): boolean {
    const originalSlot = this.getOriginalSlot();
    const cardUi = this.querySelector('card-ui') as (HTMLElement & {
      getTranslatedSlot?: () => HTMLElement | null;
    }) | null;
    const translatedSlot = cardUi?.getTranslatedSlot?.() ?? null;
    if (!originalSlot) return false;
    const anchor = this.findByAttr(originalSlot, 'id', fragment);
    if (!anchor) return false;
    const block = anchor.closest<HTMLElement>('[data-pos]') ?? anchor;
    block.scrollIntoView({ block: 'start' });
    const pos = block.getAttribute('data-pos');
    if (pos !== null && translatedSlot) {
      translatedSlot.querySelector<HTMLElement>(`[data-pos="${pos}"]`)?.scrollIntoView({ block: 'start' });
    }
    return true;
  }

  /** Handles a tap on a link inside the chapter (footnotes, cross references, web links). */
  private async followLink(href: string): Promise<void> {
    if (/^(https?:|mailto:)/i.test(href.trim())) {
      window.open(href.trim(), '_blank', 'noopener,noreferrer');
      return;
    }
    if (href.trim().startsWith('#')) {
      this.scrollToAnchor(href.trim().slice(1));
      return;
    }
    const target = resolveEpubLink(href, await this.getTocCached());
    if (target.kind === 'external') {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    } else if (target.kind === 'fragment') {
      this.scrollToAnchor(target.fragment);
    } else if (target.kind === 'chapter') {
      if (target.chapterIndex === this.currentChapter && target.fragment) {
        this.scrollToAnchor(target.fragment);
        return;
      }
      this.flushState();
      this.initialState = {
        currentChapter: target.chapterIndex,
        paragraphId: target.fragment,
        scrollOffset: 0,
        progress: 0,
      };
      this.loadChapter(target.chapterIndex);
    }
  }

  // ─── Lazy Translation ──────────────────────────────────────────────────────

  private readonly LAZY_CHUNK = 12;

  /**
   * Lazy translation: every paragraph of the Translated panel is observed;
   * when one comes near the viewport, the chunk of LAZY_CHUNK paragraphs that
   * contains it is translated. This works wherever the reader starts (saved
   * position, bookmark, TOC anchor) and in both scroll directions.
   *
   * All results are tagged with the load generation and chapter they belong
   * to: when the user changes chapter mid-request, late results are dropped
   * instead of being written (and cached) under the wrong chapter.
   */
  private setupTranslationObserver(translatedSlot: HTMLElement, generation: number, chapterIndex: number): void {
    if (this.translationObserver) {
      this.translationObserver.disconnect();
      this.translationObserver = null;
    }

    const paragraphs = this.paragraphData;
    const total = paragraphs.length;
    if (total === 0) return;

    const bookId = this.bookId;
    const targetLang = this.targetLang;
    const isStale = () => generation !== this.loadGeneration;
    const requestedChunks = new Set<number>();
    const totalChunks = Math.ceil(total / this.LAZY_CHUNK);

    const translateChunk = async (chunkIdx: number): Promise<void> => {
      if (requestedChunks.has(chunkIdx) || chunkIdx < 0 || chunkIdx >= totalChunks) return;
      requestedChunks.add(chunkIdx);

      const start = chunkIdx * this.LAZY_CHUNK;
      const end = Math.min(start + this.LAZY_CHUNK, total);

      // Check cache first, collect uncached
      const uncached: number[] = [];
      for (let pos = start; pos < end; pos++) {
        const paragraph = paragraphs[pos];
        if (!paragraph) continue;
        const cached = await translationCache.get({ bookId, chapterIndex, paragraphId: paragraph.id, targetLang });
        if (isStale()) return;
        if (cached !== undefined) {
          this.setTranslatedText(translatedSlot, pos, cached);
        } else {
          uncached.push(pos);
        }
      }
      if (uncached.length === 0) return;

      for (const pos of uncached) {
        this.showPlaceholder(translatedSlot, pos);
      }

      try {
        const translations = await postTranslate(uncached.map(pos => paragraphs[pos].text), 'auto', targetLang);
        if (isStale()) return;
        uncached.forEach((pos, i) => {
          const translated = translations[i];
          if (!translated || translated.trim() === '') {
            // The engine returned nothing (can happen with very short or
            // dialogue-style text): surface it with tap-to-retry instead of
            // leaving the paragraph blank and uncached forever.
            this.showError(translatedSlot, pos, generation, chapterIndex);
            return;
          }
          this.setTranslatedText(translatedSlot, pos, translated);
          translationCache.set({ bookId, chapterIndex, paragraphId: paragraphs[pos].id, targetLang }, translated);
        });
      } catch (err: any) {
        if (isStale()) return;
        if (err?.message === 'OFFLINE_NO_INTERNET') {
          showToast(t('offline.translationRequiresInternet'), 'error');
        }
        for (const pos of uncached) {
          this.showError(translatedSlot, pos, generation, chapterIndex);
        }
      }
    };

    if (typeof IntersectionObserver === 'undefined') {
      // Very old browsers: translate the first chunk only
      translateChunk(0);
      return;
    }

    this.translationObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pos = Number((entry.target as HTMLElement).getAttribute('data-pos'));
          if (!Number.isFinite(pos)) continue;
          const chunk = chunkOf(pos, this.LAZY_CHUNK);
          translateChunk(chunk);
          // Prefetch the next chunk so the text is ready when the reader gets there
          translateChunk(chunk + 1);
        }
      },
      // Start a little before paragraphs enter the viewport
      { root: translatedSlot, rootMargin: '0px 0px 50% 0px', threshold: 0 }
    );
    translatedSlot.querySelectorAll<HTMLElement>('[data-pos]').forEach((el) => {
      this.translationObserver?.observe(el);
    });
  }

  private paragraphAt(translatedSlot: HTMLElement, pos: number): HTMLElement | null {
    return translatedSlot.querySelector<HTMLElement>(`[data-pos="${pos}"]`);
  }

  /**
   * Shows a pulsing placeholder in the Translated card for a given paragraph.
   */
  private showPlaceholder(translatedSlot: HTMLElement, pos: number): void {
    const el = this.paragraphAt(translatedSlot, pos);
    if (el) {
      el.className = 'translation-pending';
      el.onclick = null;
      el.textContent = this.paragraphData[pos]?.text || '';
    }
  }

  /**
   * Sets the translated text content for a given paragraph in the Translated card.
   */
  private setTranslatedText(translatedSlot: HTMLElement, pos: number, text: string): void {
    const el = this.paragraphAt(translatedSlot, pos);
    if (el) {
      el.className = '';
      el.onclick = null;
      el.textContent = text;
    }
  }

  /**
   * Shows an inline error indicator with tap-to-retry for a given paragraph.
   * Validates: Requirement 11.6
   */
  private showError(translatedSlot: HTMLElement, pos: number, generation: number, chapterIndex: number): void {
    const el = this.paragraphAt(translatedSlot, pos);
    if (!el) return;
    el.className = 'translation-error';
    el.textContent = t('reading.translationError');
    el.onclick = async () => {
      if (generation !== this.loadGeneration) return;
      const paragraph = this.paragraphData[pos];
      if (!paragraph) return;
      const targetLang = this.targetLang;
      this.showPlaceholder(translatedSlot, pos);
      try {
        const translations = await postTranslate([paragraph.text], 'auto', targetLang);
        if (generation !== this.loadGeneration) return;
        const translated = translations[0];
        if (!translated || translated.trim() === '') {
          this.showError(translatedSlot, pos, generation, chapterIndex);
          return;
        }
        this.setTranslatedText(translatedSlot, pos, translated);
        translationCache.set({ bookId: this.bookId, chapterIndex, paragraphId: paragraph.id, targetLang }, translated);
      } catch {
        if (generation !== this.loadGeneration) return;
        this.showError(translatedSlot, pos, generation, chapterIndex);
      }
    };
  }
}

customElements.define('reading-screen', ReadingScreen);
