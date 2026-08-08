import { getBooks, getCoverUrl } from '../api/books';
import { getReadingState } from '../api/state';
import { t } from '../i18n/index';
import type { BookSummary } from '../types';

/**
 * Library screen component — displays a responsive grid of book cards.
 *
 * Fetches GET /api/books on mount, shows loading/empty/error states,
 * and dispatches 'navigate' on card tap (after fetching reading state).
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */
class LibraryScreen extends HTMLElement {
  connectedCallback(): void {
    this.loadBooks();
  }

  private async loadBooks(): Promise<void> {
    this.renderLoading();
    try {
      const books = await getBooks();
      if (books.length === 0) {
        this.renderEmpty();
      } else {
        this.renderGrid(books);
      }
    } catch {
      this.renderError();
    }
  }

  private renderLoading(): void {
    this.innerHTML = `
      <style>${LibraryScreen.styles}</style>
      <div class="library-container">
        <h1 class="library-title">${t('library.title')}</h1>
        <div class="library-loading" role="status" aria-live="polite">
          <div class="spinner" aria-hidden="true"></div>
          <p>${t('library.loading')}</p>
        </div>
      </div>
    `;
  }

  private renderEmpty(): void {
    this.innerHTML = `
      <style>${LibraryScreen.styles}</style>
      <div class="library-container">
        <h1 class="library-title">${t('library.title')}</h1>
        <div class="library-empty" role="status" aria-live="polite">
          <p>${t('library.empty')}</p>
        </div>
      </div>
    `;
  }

  private renderError(): void {
    this.innerHTML = `
      <style>${LibraryScreen.styles}</style>
      <div class="library-container">
        <h1 class="library-title">${t('library.title')}</h1>
        <div class="library-error" role="alert" aria-live="assertive">
          <p>${t('library.error')}</p>
          <button class="retry-btn" aria-label="${t('library.retry')}">${t('library.retry')}</button>
        </div>
      </div>
    `;

    const btn = this.querySelector('.retry-btn') as HTMLButtonElement;
    btn?.addEventListener('click', () => this.loadBooks());
  }

  private renderGrid(books: BookSummary[]): void {
    const cards = books.map((book) => this.renderCard(book)).join('');

    this.innerHTML = `
      <style>${LibraryScreen.styles}</style>
      <div class="library-container">
        <h1 class="library-title">${t('library.title')}</h1>
        <div class="book-grid" role="list">
          ${cards}
        </div>
      </div>
    `;

    // Attach click listeners to each card
    this.querySelectorAll<HTMLElement>('.book-card').forEach((card) => {
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

    // Attach fallback handlers for cover images
    this.querySelectorAll<HTMLImageElement>('.book-cover').forEach((img) => {
      img.addEventListener('error', () => {
        img.src = LibraryScreen.placeholderSvg;
      });
    });
  }

  private renderCard(book: BookSummary): string {
    const coverSrc = getCoverUrl(book.id);
    const progressText = t('library.progress', { progress: String(book.progress) });

    return `
      <div class="book-card" role="listitem" tabindex="0" data-book-id="${book.id}" aria-label="${escapeAttr(book.title)} — ${escapeAttr(book.author)}">
        <div class="book-cover-wrapper">
          <img class="book-cover" src="${coverSrc}" alt="${escapeAttr(book.title)}" loading="lazy">
        </div>
        <div class="book-info">
          <p class="book-title">${escapeHtml(book.title)}</p>
          <p class="book-author">${escapeHtml(book.author)}</p>
          <p class="book-progress">${escapeHtml(progressText)}</p>
        </div>
      </div>
    `;
  }

  /** Inline SVG data URI used as a placeholder when cover fails to load. */
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
      padding: 1rem;
      box-sizing: border-box;
    }

    .library-container {
      max-width: 960px;
      margin: 0 auto;
    }

    .library-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 0 0 1.25rem;
      color: var(--text-primary, #fff);
    }

    /* Loading state */
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

    /* Empty state */
    .library-empty {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-secondary, #aaa);
      font-size: 0.95rem;
      line-height: 1.5;
    }

    /* Error state */
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

    /* Book grid */
    .book-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 16px;
    }

    /* Book card */
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
