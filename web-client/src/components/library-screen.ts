import { getBooks, getCoverUrl } from '../api/books';
import { getBookmarks } from '../api/bookmarks';
import { getReadingState } from '../api/state';
import { t } from '../i18n/index';
import type { BookSummary, Bookmark } from '../types';

interface BookmarkWithBook extends Bookmark {
  bookId: string;
  bookTitle: string;
}

type StatusFilter = '' | 'to-read' | 'reading' | 'read';

/**
 * Library screen component — displays a responsive grid of book cards
 * with tabs to switch between Library and Bookmarks views.
 *
 * Header: Settings gear (left) + Library/Bookmarks tabs (right).
 * Filter bar: sticky at the bottom — search input + status chip pills.
 * Dispatches 'navigate' on card tap and 'open-settings' on gear tap.
 */
class LibraryScreen extends HTMLElement {
  private books: BookSummary[] = [];
  private activeTab: 'library' | 'bookmarks' = 'library';
  private searchQuery: string = '';
  private statusFilter: StatusFilter = '';

  connectedCallback(): void {
    this.render();
    this.loadBooks();
  }

  private render(): void {
    this.innerHTML = `
      <style>${LibraryScreen.styles}</style>
      <div class="library-container">
        <header class="library-header">
          <button class="settings-btn" aria-label="${t('reading.settingsTooltip')}">
            <img class="icon" src="/icons/gear.svg" alt="" aria-hidden="true">
          </button>
          <div class="tab-group" role="tablist">
            <button class="tab-btn tab-library active" role="tab" aria-selected="true">${t('library.title')}</button>
            <button class="tab-btn tab-bookmarks" role="tab" aria-selected="false">
              <img class="icon" src="/icons/star.svg" alt="" aria-hidden="true"> ${t('bookmarks.title')}
            </button>
          </div>
        </header>
        <div class="library-content"></div>
        <div class="filter-bar" role="search" aria-label="${t('library.title')}">
          <div class="filter-search-row">
            <input
              class="filter-search-input"
              type="search"
              placeholder="${t('library.searchPlaceholder')}"
              aria-label="${t('library.searchPlaceholder')}"
              value=""
              autocomplete="off"
              spellcheck="false"
            >
          </div>
          <div class="filter-chips" role="group" aria-label="${t('library.filterAll')}">
            <button class="chip chip-active" data-status="" aria-pressed="true">${t('library.filterAll')}</button>
            <button class="chip" data-status="to-read" aria-pressed="false">${t('library.filterToRead')}</button>
            <button class="chip" data-status="reading" aria-pressed="false">${t('library.filterReading')}</button>
            <button class="chip" data-status="read" aria-pressed="false">${t('library.filterRead')}</button>
          </div>
        </div>
      </div>
    `;

    this.attachHeaderListeners();
    this.attachFilterListeners();
  }

  private attachHeaderListeners(): void {
    const settingsBtn = this.querySelector('.settings-btn') as HTMLButtonElement;
    settingsBtn?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('open-settings', { bubbles: true, composed: true }));
    });

    const tabLibrary = this.querySelector('.tab-library') as HTMLButtonElement;
    const tabBookmarks = this.querySelector('.tab-bookmarks') as HTMLButtonElement;

    tabLibrary?.addEventListener('click', () => {
      if (this.activeTab === 'library') return;
      this.activeTab = 'library';
      tabLibrary.classList.add('active');
      tabLibrary.setAttribute('aria-selected', 'true');
      tabBookmarks.classList.remove('active');
      tabBookmarks.setAttribute('aria-selected', 'false');
      this.showFilterBar(true);
      this.applyFilters();
    });

    tabBookmarks?.addEventListener('click', () => {
      if (this.activeTab === 'bookmarks') return;
      this.activeTab = 'bookmarks';
      tabBookmarks.classList.add('active');
      tabBookmarks.setAttribute('aria-selected', 'true');
      tabLibrary.classList.remove('active');
      tabLibrary.setAttribute('aria-selected', 'false');
      this.showFilterBar(false);
      this.showBookmarks();
    });
  }

  private attachFilterListeners(): void {
    const searchInput = this.querySelector('.filter-search-input') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.activeTab === 'library') this.applyFilters();
    });

    this.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.statusFilter = (chip.dataset.status ?? '') as StatusFilter;
        // Update chip visual state
        this.querySelectorAll('.chip').forEach((c) => {
          const active = c === chip;
          c.classList.toggle('chip-active', active);
          c.setAttribute('aria-pressed', String(active));
        });
        if (this.activeTab === 'library') this.applyFilters();
      });
    });
  }

  /** Show or hide the filter bar (only relevant for library tab). */
  private showFilterBar(visible: boolean): void {
    const bar = this.querySelector('.filter-bar') as HTMLElement;
    const content = this.querySelector('.library-content') as HTMLElement;
    if (bar) bar.style.display = visible ? '' : 'none';
    if (content) content.style.paddingBottom = visible ? '' : '1rem';
  }

  private async loadBooks(): Promise<void> {
    const content = this.querySelector('.library-content') as HTMLElement;
    if (!content) return;

    content.innerHTML = `
      <div class="library-loading" role="status" aria-live="polite">
        <div class="spinner" aria-hidden="true"></div>
        <p>${t('library.loading')}</p>
      </div>
    `;

    try {
      this.books = await getBooks();
      this.applyFilters();
    } catch {
      content.innerHTML = `
        <div class="library-error" role="alert" aria-live="assertive">
          <p>${t('library.error')}</p>
          <button class="retry-btn" aria-label="${t('library.retry')}">${t('library.retry')}</button>
        </div>
      `;
      const btn = content.querySelector('.retry-btn') as HTMLButtonElement;
      btn?.addEventListener('click', () => this.loadBooks());
    }
  }

  /**
   * Filters `this.books` by current search query and status chip,
   * then renders the result.
   */
  private applyFilters(): void {
    const q = this.searchQuery.trim().toLowerCase();
    let filtered = q
      ? this.books.filter(
          (b) =>
            b.title.toLowerCase().includes(q) ||
            b.author.toLowerCase().includes(q),
        )
      : this.books.slice();

    if (this.statusFilter) {
      filtered = filtered.filter((b) => b.status === this.statusFilter);
    }

    this.showLibrary(filtered, q);
  }

  private showLibrary(books: BookSummary[], query: string = ''): void {
    const content = this.querySelector('.library-content') as HTMLElement;
    if (!content) return;

    if (this.books.length === 0) {
      content.innerHTML = `
        <div class="library-empty" role="status" aria-live="polite">
          <p>${t('library.empty')}</p>
        </div>
      `;
      return;
    }

    if (books.length === 0) {
      const msg = query
        ? t('library.noResults', { query: escapeHtml(query) })
        : t('library.empty');
      content.innerHTML = `
        <div class="library-empty" role="status" aria-live="polite">
          <p>${msg}</p>
        </div>
      `;
      return;
    }

    const cards = books.map((book) => this.renderCard(book)).join('');
    content.innerHTML = `<div class="book-grid" role="list">${cards}</div>`;

    content.querySelectorAll<HTMLElement>('.book-card').forEach((card) => {
      card.addEventListener('click', async () => {
        const bookId = card.dataset.bookId;
        if (!bookId) return;

        let state;
        try {
          state = await getReadingState(bookId);
        } catch {
          state = { currentChapter: 0, paragraphId: null, scrollOffset: 0, progress: 0 };
        }

        this.dispatchEvent(
          new CustomEvent('navigate', {
            detail: { screen: 'reading', bookId, state },
            bubbles: true,
            composed: true,
          }),
        );
      });
    });

    content.querySelectorAll<HTMLImageElement>('.book-cover').forEach((img) => {
      img.addEventListener('error', () => {
        img.src = LibraryScreen.placeholderSvg;
      });
    });
  }

  private async showBookmarks(): Promise<void> {
    const content = this.querySelector('.library-content') as HTMLElement;
    if (!content) return;

    content.innerHTML = `
      <div class="library-loading" role="status" aria-live="polite">
        <div class="spinner" aria-hidden="true"></div>
        <p>${t('general.loading')}</p>
      </div>
    `;

    if (this.books.length === 0) {
      try {
        this.books = await getBooks();
      } catch {
        content.innerHTML = `
          <div class="library-error" role="alert">
            <p>${t('library.error')}</p>
          </div>
        `;
        return;
      }
    }

    const allBookmarks: BookmarkWithBook[] = [];
    await Promise.all(
      this.books.map(async (book) => {
        try {
          const bookmarks = await getBookmarks(book.id);
          for (const bm of bookmarks) {
            allBookmarks.push({ ...bm, bookId: book.id, bookTitle: book.title });
          }
        } catch {
          // Skip books with failed bookmark fetches
        }
      }),
    );

    allBookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (allBookmarks.length === 0) {
      content.innerHTML = `
        <div class="library-empty" role="status" aria-live="polite">
          <p>${t('bookmarks.empty')}</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="bookmarks-list" role="list">
        ${allBookmarks.map((bm) => this.renderBookmarkItem(bm)).join('')}
      </div>
    `;

    content.querySelectorAll<HTMLElement>('.bookmark-item').forEach((item) => {
      item.addEventListener('click', () => {
        const bookId = item.dataset.bookId;
        const chapter = parseInt(item.dataset.chapter || '0', 10);
        const paragraphId = item.dataset.paragraphId || null;
        if (!bookId) return;
        this.dispatchEvent(
          new CustomEvent('navigate', {
            detail: {
              screen: 'reading',
              bookId,
              state: { currentChapter: chapter, paragraphId, scrollOffset: 0, progress: 0 },
            },
            bubbles: true,
            composed: true,
          }),
        );
      });
    });
  }

  private renderBookmarkItem(bm: BookmarkWithBook): string {
    const label = bm.label || t('bookmarks.defaultLabel', { chapter: String(bm.chapterIndex + 1) });
    const date = new Date(bm.createdAt).toLocaleDateString();
    return `
      <div class="bookmark-item" role="listitem" tabindex="0"
           data-book-id="${bm.bookId}" data-chapter="${bm.chapterIndex}" data-paragraph-id="${bm.paragraphId}">
        <div class="bookmark-book-title">${escapeHtml(bm.bookTitle)}</div>
        <div class="bookmark-label">${escapeHtml(label)}</div>
        <div class="bookmark-date">${date}</div>
      </div>
    `;
  }

  private renderCard(book: BookSummary): string {
    const coverSrc = getCoverUrl(book.id);
    const progressText = t('library.progress', { progress: String(book.progress) });
    const status = book.status;
    const statusBadge = status
      ? `<span class="status-badge status-badge--${escapeAttr(status)}">${escapeHtml(LibraryScreen.statusLabel(status))}</span>`
      : '';

    return `
      <div class="book-card" role="listitem" tabindex="0" data-book-id="${book.id}"
           aria-label="${escapeAttr(book.title)} — ${escapeAttr(book.author)}">
        <div class="book-cover-wrapper">
          <img class="book-cover" src="${coverSrc}" alt="${escapeAttr(book.title)}" loading="lazy">
          ${statusBadge ? `<div class="book-status-overlay">${statusBadge}</div>` : ''}
        </div>
        <div class="book-info">
          <p class="book-title">${escapeHtml(book.title)}</p>
          <p class="book-author">${escapeHtml(book.author)}</p>
          <p class="book-progress">${escapeHtml(progressText)}</p>
        </div>
      </div>
    `;
  }

  private static statusLabel(status: string): string {
    switch (status) {
      case 'to-read':  return t('library.filterToRead');
      case 'reading':  return t('library.filterReading');
      case 'read':     return t('library.filterRead');
      default:         return status;
    }
  }

  private static readonly placeholderSvg = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 187" fill="none">' +
      '<rect width="140" height="187" rx="4" fill="#2a2a2a"/>' +
      '<path d="M50 80h40M70 60v40" stroke="#555" stroke-width="4" stroke-linecap="round"/>' +
      '</svg>',
  )}`;

  private static readonly styles = `
    library-screen {
      display: block;
      width: 100%;
      min-height: 100vh;
      padding: 0;
      box-sizing: border-box;
    }

    .icon {
      width: 1em;
      height: 1em;
      display: inline-block;
      vertical-align: middle;
      filter: brightness(0) invert(1);
    }

    .library-container {
      max-width: 960px;
      margin: 0 auto;
      /* Space for sticky filter bar */
      padding-bottom: 110px;
    }

    /* ── Header ─────────────────────────────────── */
    .library-header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--header-bg, #1a1a1a);
      border-bottom: 1px solid var(--border-color, #333);
    }

    .library-header .settings-btn {
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

    .library-header .settings-btn:hover,
    .library-header .settings-btn:focus-visible {
      background: var(--hover-bg, rgba(255, 255, 255, 0.1));
    }

    .library-header .tab-group {
      display: flex;
      gap: 4px;
    }

    .library-header .tab-btn {
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

    .library-header .tab-btn:hover,
    .library-header .tab-btn:focus-visible {
      background: var(--hover-bg, rgba(255, 255, 255, 0.1));
    }

    .library-header .tab-btn.active {
      color: var(--text-color, #e0e0e0);
      background: var(--tab-active-bg, rgba(255, 255, 255, 0.15));
      font-weight: 600;
    }

    /* ── Content area ───────────────────────────── */
    .library-content {
      padding: 1rem;
    }

    /* ── Filter bar ─────────────────────────────── */
    .filter-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 20;
      background: var(--header-bg, #1a1a1a);
      border-top: 1px solid var(--border-color, #333);
      padding: 8px 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      /* Respect safe-area on notched phones */
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }

    .filter-search-row {
      display: flex;
      align-items: center;
    }

    .filter-search-input {
      flex: 1;
      height: 40px;
      padding: 0 12px;
      border: 1px solid var(--border-color, #444);
      border-radius: 20px;
      background: var(--surface, #2a2a2a);
      color: var(--text-color, #e0e0e0);
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.15s;
      -webkit-appearance: none;
    }

    .filter-search-input::placeholder {
      color: var(--text-muted, #666);
    }

    .filter-search-input:focus {
      border-color: var(--accent, #c0392b);
    }

    /* Clear button that browsers render inside search inputs */
    .filter-search-input::-webkit-search-cancel-button {
      -webkit-appearance: auto;
      cursor: pointer;
    }

    /* ── Status chips ────────────────────────────── */
    .filter-chips {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      padding-bottom: 2px;
    }

    .filter-chips::-webkit-scrollbar {
      display: none;
    }

    .chip {
      flex-shrink: 0;
      height: 32px;
      padding: 0 14px;
      border: 1px solid var(--border-color, #444);
      border-radius: 16px;
      background: transparent;
      color: var(--text-muted, #999);
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }

    .chip:hover,
    .chip:focus-visible {
      border-color: var(--accent, #c0392b);
      color: var(--text-color, #e0e0e0);
    }

    .chip.chip-active {
      background: var(--accent, #c0392b);
      border-color: var(--accent, #c0392b);
      color: #fff;
    }

    /* ── Loading / empty / error ────────────────── */
    .library-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem 1rem;
      color: var(--text-secondary, #aaa);
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--text-secondary, #555);
      border-top-color: var(--accent, #c0392b);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 1rem;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .library-empty {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-secondary, #aaa);
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .library-error {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-secondary, #aaa);
    }

    .library-error p {
      margin: 0 0 1rem;
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .retry-btn {
      display: inline-block;
      padding: 0.625rem 1.5rem;
      min-width: 44px;
      min-height: 44px;
      font-size: 0.95rem;
      font-weight: 600;
      color: #fff;
      background: var(--accent, #c0392b);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .retry-btn:hover {
      opacity: 0.85;
    }

    /* ── Book grid ──────────────────────────────── */
    .book-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 16px;
    }

    .book-card {
      display: flex;
      flex-direction: column;
      cursor: pointer;
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface, #1e1e1e);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }

    .book-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .book-card:focus-visible {
      outline: 2px solid var(--accent, #c0392b);
      outline-offset: 2px;
    }

    .book-cover-wrapper {
      position: relative;
      width: 100%;
      aspect-ratio: 3 / 4;
      background: #2a2a2a;
      overflow: hidden;
    }

    .book-cover {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .book-status-overlay {
      position: absolute;
      bottom: 4px;
      left: 4px;
    }

    .status-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #fff;
      background: rgba(0,0,0,0.6);
    }

    .status-badge--to-read  { background: #1565c0; }
    .status-badge--reading  { background: #e65100; }
    .status-badge--read     { background: #2e7d32; }

    .book-info {
      padding: 0.5rem 0.625rem;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .book-title {
      margin: 0;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-primary, #fff);
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .book-author {
      margin: 0;
      font-size: 0.7rem;
      color: var(--text-secondary, #aaa);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .book-progress {
      margin: 0;
      font-size: 0.7rem;
      color: var(--accent, #c0392b);
      font-weight: 500;
    }

    /* ── Bookmarks list ─────────────────────────── */
    .bookmarks-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .bookmark-item {
      padding: 12px 16px;
      background: var(--surface, #1e1e1e);
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .bookmark-item:hover,
    .bookmark-item:focus-visible {
      background: var(--hover-bg, rgba(255, 255, 255, 0.1));
    }

    .bookmark-item:focus-visible {
      outline: 2px solid var(--accent, #c0392b);
      outline-offset: 2px;
    }

    .bookmark-book-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-primary, #fff);
      margin-bottom: 2px;
    }

    .bookmark-label {
      font-size: 0.8rem;
      color: var(--text-secondary, #aaa);
    }

    .bookmark-date {
      font-size: 0.7rem;
      color: var(--text-muted, #666);
      margin-top: 4px;
    }
  `;
}

customElements.define('library-screen', LibraryScreen);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
