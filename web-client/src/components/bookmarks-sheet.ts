import { getBookmarks, deleteBookmark } from '../api/bookmarks';
import { showToast } from './toast';
import { t } from '../i18n/index';
import type { Bookmark } from '../types';

const SHEET_STYLES = `
bookmarks-sheet {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  pointer-events: auto;
}

.bookmarks-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  transition: opacity 0.3s ease;
  opacity: 0;
}

.bookmarks-overlay.open {
  opacity: 1;
}

.bookmarks-panel {
  position: relative;
  z-index: 1;
  background: var(--surface, #1e1e1e);
  color: var(--on-surface, #fff);
  border-radius: 16px 16px 0 0;
  max-height: 80vh;
  overflow-y: auto;
  padding: 0 1.5rem 1.5rem;
  transform: translateY(100%);
  transition: transform 0.3s ease;
  -webkit-overflow-scrolling: touch;
}

.bookmarks-panel.open {
  transform: translateY(0);
}

.bookmarks-handle {
  display: flex;
  justify-content: center;
  padding: 12px 0 8px;
  cursor: grab;
}

.bookmarks-handle-bar {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--on-surface-muted, #666);
}

.bookmarks-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 1rem;
}

.bookmarks-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.bookmarks-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border, #333);
  overflow: hidden;
}

.bookmarks-item:last-child {
  border-bottom: none;
}

.bookmarks-item-content {
  flex: 1;
  cursor: pointer;
  min-width: 0;
  padding-right: 8px;
}

.bookmarks-item-label {
  font-size: 0.95rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bookmarks-item-chapter {
  font-size: 0.8rem;
  color: var(--on-surface-muted, #aaa);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bookmarks-delete-btn {
  background: none;
  border: none;
  color: var(--on-surface-muted, #aaa);
  font-size: 1.2rem;
  cursor: pointer;
  padding: 8px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  flex-shrink: 0;
}

.bookmarks-delete-btn:hover {
  color: #e53935;
  background: rgba(229, 57, 53, 0.1);
}

.bookmarks-empty {
  text-align: center;
  padding: 2rem 1rem;
  color: var(--on-surface-muted, #aaa);
  font-size: 0.95rem;
}
`;

let styleInjected = false;

function injectStyles(): void {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = SHEET_STYLES;
  document.head.appendChild(style);
  styleInjected = true;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A slide-up bottom sheet listing all bookmarks for the current book.
 *
 * Bookmarks are ordered by chapterIndex ascending, then paragraphId numerically ascending.
 * Each entry shows a label (default "Chapter {chapterIndex + 1}" if absent).
 * Tapping an entry dispatches a 'navigate-bookmark' CustomEvent with chapterIndex and paragraphId.
 * Delete button calls DELETE /api/books/:id/bookmarks/:bookmarkId; on failure shows error toast
 * without modifying the list.
 *
 * Validates: Requirements 13.3, 13.4, 13.5, 13.6
 */
class BookmarksSheet extends HTMLElement {
  private bookmarks: Bookmark[] = [];
  private _bookId: string = '';

  // Swipe tracking
  private swipeStartY = 0;
  private isSwiping = false;

  get bookId(): string {
    return this._bookId || this.getAttribute('book-id') || '';
  }

  set bookId(value: string) {
    this._bookId = value;
  }

  connectedCallback(): void {
    injectStyles();
    this.render();
    this.bindBaseEvents();
    this.fetchBookmarks();

    // Trigger open animation on next frame
    requestAnimationFrame(() => {
      this.querySelector('.bookmarks-overlay')?.classList.add('open');
      this.querySelector('.bookmarks-panel')?.classList.add('open');
    });
  }

  private render(): void {
    this.innerHTML = `
      <div class="bookmarks-overlay" aria-hidden="true"></div>
      <div class="bookmarks-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('bookmarks.title'))}">
        <div class="bookmarks-handle">
          <div class="bookmarks-handle-bar"></div>
        </div>
        <h2 class="bookmarks-title">${escapeHtml(t('bookmarks.title'))}</h2>
        <ul class="bookmarks-list" aria-label="${escapeHtml(t('bookmarks.title'))}">
          <li class="bookmarks-empty">${escapeHtml(t('general.loading'))}</li>
        </ul>
      </div>
    `;
  }

  private async fetchBookmarks(): Promise<void> {
    const id = this.bookId;
    if (!id) {
      this.renderEmpty();
      return;
    }

    try {
      const bookmarks = await getBookmarks(id);
      this.bookmarks = this.sortBookmarks(bookmarks);
      this.renderList();
    } catch {
      this.renderEmpty();
    }
  }

  private sortBookmarks(bookmarks: Bookmark[]): Bookmark[] {
    return [...bookmarks].sort((a, b) => {
      if (a.chapterIndex !== b.chapterIndex) {
        return a.chapterIndex - b.chapterIndex;
      }
      const aNum = parseInt(a.paragraphId, 10);
      const bNum = parseInt(b.paragraphId, 10);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return aNum - bNum;
      }
      return a.paragraphId.localeCompare(b.paragraphId);
    });
  }

  private renderList(): void {
    const list = this.querySelector('.bookmarks-list');
    if (!list) return;

    if (this.bookmarks.length === 0) {
      this.renderEmpty();
      return;
    }

    list.innerHTML = this.bookmarks
      .map(
        (bm) => `
        <li class="bookmarks-item" data-bookmark-id="${escapeHtml(bm.id)}" data-chapter-index="${bm.chapterIndex}" data-paragraph-id="${escapeHtml(bm.paragraphId)}">
          <div class="bookmarks-item-content">
            <div class="bookmarks-item-label">${escapeHtml(bm.label || t('bookmarks.defaultLabel', { chapter: String(bm.chapterIndex + 1) }))}</div>
          </div>
          <button class="bookmarks-delete-btn" aria-label="${escapeHtml(t('bookmarks.deleteTooltip'))}" data-bookmark-id="${escapeHtml(bm.id)}">✕</button>
        </li>`,
      )
      .join('');

    this.bindListEvents();
  }

  private renderEmpty(): void {
    const list = this.querySelector('.bookmarks-list');
    if (!list) return;
    list.innerHTML = `<li class="bookmarks-empty">${escapeHtml(t('bookmarks.empty'))}</li>`;
  }

  private bindBaseEvents(): void {
    // Overlay click to close
    const overlay = this.querySelector('.bookmarks-overlay') as HTMLElement;
    overlay?.addEventListener('click', () => this.close());

    // Swipe down to close
    const handle = this.querySelector('.bookmarks-handle') as HTMLElement;
    handle?.addEventListener('touchstart', (e: Event) => {
      const te = e as TouchEvent;
      this.swipeStartY = te.touches[0].clientY;
      this.isSwiping = true;
    });

    handle?.addEventListener('touchmove', (e: Event) => {
      if (!this.isSwiping) return;
      const te = e as TouchEvent;
      const deltaY = te.touches[0].clientY - this.swipeStartY;
      if (deltaY > 60) {
        this.isSwiping = false;
        this.close();
      }
    });

    handle?.addEventListener('touchend', () => {
      this.isSwiping = false;
    });
  }

  private bindListEvents(): void {
    // Tap bookmark entry to navigate
    this.querySelectorAll('.bookmarks-item-content').forEach((el) => {
      el.addEventListener('click', () => {
        const item = el.closest('.bookmarks-item') as HTMLElement;
        if (!item) return;
        const chapterIndex = parseInt(item.dataset.chapterIndex || '0', 10);
        const paragraphId = item.dataset.paragraphId || '';

        this.dispatchEvent(
          new CustomEvent('navigate-bookmark', {
            bubbles: true,
            composed: true,
            detail: { chapterIndex, paragraphId },
          }),
        );
        this.close();
      });
    });

    // Delete button
    this.querySelectorAll('.bookmarks-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const bookmarkId = (btn as HTMLElement).dataset.bookmarkId;
        if (bookmarkId) {
          this.handleDelete(bookmarkId);
        }
      });
    });

    // Swipe-left to reveal delete (simplified: treat as additional gesture)
    this.querySelectorAll('.bookmarks-item').forEach((item) => {
      let startX = 0;
      item.addEventListener('touchstart', (e: Event) => {
        startX = (e as TouchEvent).touches[0].clientX;
      });
      item.addEventListener('touchend', (e: Event) => {
        const endX = (e as TouchEvent).changedTouches[0].clientX;
        const deltaX = startX - endX;
        if (deltaX > 80) {
          const bookmarkId = (item as HTMLElement).dataset.bookmarkId;
          if (bookmarkId) {
            this.handleDelete(bookmarkId);
          }
        }
      });
    });
  }

  private async handleDelete(bookmarkId: string): Promise<void> {
    const id = this.bookId;
    if (!id) return;

    try {
      await deleteBookmark(id, bookmarkId);
      // On success: remove from internal list and DOM
      this.bookmarks = this.bookmarks.filter((bm) => bm.id !== bookmarkId);
      const itemEl = this.querySelector(`.bookmarks-item[data-bookmark-id="${bookmarkId}"]`);
      if (itemEl) {
        itemEl.remove();
      }
      if (this.bookmarks.length === 0) {
        this.renderEmpty();
      }
    } catch {
      showToast(t('toast.errorGeneric'), 'error');
    }
  }

  private close(): void {
    const overlay = this.querySelector('.bookmarks-overlay');
    const panel = this.querySelector('.bookmarks-panel');

    overlay?.classList.remove('open');
    panel?.classList.remove('open');

    const onTransitionEnd = () => {
      panel?.removeEventListener('transitionend', onTransitionEnd);
      this.remove();
    };
    panel?.addEventListener('transitionend', onTransitionEnd);

    // Fallback: remove after transition duration even if event doesn't fire
    setTimeout(() => this.remove(), 350);
  }
}

customElements.define('bookmarks-sheet', BookmarksSheet);

export { BookmarksSheet };
