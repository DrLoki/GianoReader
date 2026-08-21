import { getToc } from '../api/books';
import { getBookmarks, deleteBookmark } from '../api/bookmarks';
import { showToast } from './toast';
import { t } from '../i18n/index';
import type { TocEntry, Bookmark } from '../types';

const SHEET_STYLES = `
toc-sheet {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  pointer-events: auto;
}

.toc-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  transition: opacity 0.3s ease;
  opacity: 0;
}

.toc-overlay.open {
  opacity: 1;
}

.toc-panel {
  position: relative;
  z-index: 1;
  background: var(--surface, #1e1e1e);
  color: var(--on-surface, #fff);
  border-radius: 16px 16px 0 0;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
  transform: translateY(100%);
  transition: transform 0.3s ease;
}

.toc-panel.open {
  transform: translateY(0);
}

.toc-handle {
  display: flex;
  justify-content: center;
  padding: 12px 0 8px;
  cursor: grab;
  flex-shrink: 0;
}

.toc-handle-bar {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--on-surface-muted, #666);
}

/* Tab bar */
.toc-tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border, #333);
  padding: 0 1rem;
  flex-shrink: 0;
}

.toc-tab {
  flex: 1;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--on-surface-muted, #aaa);
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
  min-height: 44px;
}

.toc-tab:hover {
  color: var(--on-surface, #fff);
}

.toc-tab.active {
  color: var(--on-surface, #fff);
  border-bottom-color: var(--accent, #c0392b);
  font-weight: 600;
}

/* Content area */
.toc-content {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 1rem 1.5rem;
}

.toc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-item {
  display: flex;
  align-items: center;
  padding: 12px 8px;
  border-bottom: 1px solid var(--border, #333);
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
  min-height: 44px;
}

.toc-item:hover,
.toc-item:focus-visible {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.toc-item.toc-item--active {
  background: var(--tab-active-bg, rgba(255, 255, 255, 0.12));
  border-left: 3px solid var(--accent, #c0392b);
}

.toc-item-title {
  flex: 1;
  font-size: 0.9rem;
  line-height: 1.3;
}

/* Bookmark items */
.toc-bm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 8px;
  border-bottom: 1px solid var(--border, #333);
  border-radius: 6px;
  transition: background 0.15s;
}

.toc-bm-item:last-child {
  border-bottom: none;
}

.toc-bm-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.toc-bm-content {
  flex: 1;
  cursor: pointer;
  min-width: 0;
  padding-right: 8px;
}

.toc-bm-label {
  font-size: 0.9rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toc-bm-chapter {
  font-size: 0.8rem;
  color: var(--on-surface-muted, #aaa);
  margin-top: 2px;
}

.toc-bm-delete {
  background: none;
  border: none;
  color: #e53935;
  cursor: pointer;
  padding: 8px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background 0.2s ease;
}

.toc-bm-delete:hover {
  background: rgba(229, 57, 53, 0.15);
}

.toc-bm-delete .bm-icon {
  width: 1.1em;
  height: 1.1em;
  display: block;
  filter: var(--icon-filter, brightness(0) invert(1));
}

.toc-empty {
  text-align: center;
  padding: 2rem 1rem;
  color: var(--on-surface-muted, #aaa);
  font-size: 0.95rem;
}

.toc-loading {
  text-align: center;
  padding: 2rem 1rem;
  color: var(--on-surface-muted, #aaa);
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
 * <toc-sheet> — Bottom sheet with two tabs: Table of Contents and Bookmarks.
 *
 * Set `bookId` and `currentChapter` properties before appending to DOM.
 * Dispatches:
 *  - 'navigate-chapter' with { chapterIndex }
 *  - 'navigate-bookmark' with { chapterIndex, paragraphId }
 */
class TocSheet extends HTMLElement {
  private _bookId: string = '';
  private _currentChapter: number = 0;
  private tocEntries: TocEntry[] = [];
  private bookmarks: Bookmark[] = [];
  private activeTab: 'toc' | 'bookmarks' = 'toc';

  // Swipe tracking
  private swipeStartY = 0;
  private isSwiping = false;

  get bookId(): string {
    return this._bookId;
  }
  set bookId(value: string) {
    this._bookId = value;
  }

  get currentChapter(): number {
    return this._currentChapter;
  }
  set currentChapter(value: number) {
    this._currentChapter = value;
  }

  connectedCallback(): void {
    injectStyles();
    this.render();
    this.bindBaseEvents();
    this.fetchData();

    requestAnimationFrame(() => {
      this.querySelector('.toc-overlay')?.classList.add('open');
      this.querySelector('.toc-panel')?.classList.add('open');
    });
  }

  private render(): void {
    this.innerHTML = `
      <div class="toc-overlay" aria-hidden="true"></div>
      <div class="toc-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('reading.toc'))}">
        <div class="toc-handle"><div class="toc-handle-bar"></div></div>
        <div class="toc-tab-bar" role="tablist">
          <button class="toc-tab toc-tab-toc active" role="tab" aria-selected="true">${escapeHtml(t('reading.toc'))}</button>
          <button class="toc-tab toc-tab-bm" role="tab" aria-selected="false">${escapeHtml(t('bookmarks.title'))}</button>
        </div>
        <div class="toc-content">
          <div class="toc-loading">${escapeHtml(t('general.loading'))}</div>
        </div>
      </div>
    `;
  }

  private bindBaseEvents(): void {
    // Overlay click to close
    this.querySelector('.toc-overlay')?.addEventListener('click', () => this.close());

    // Tab switching
    const tabToc = this.querySelector('.toc-tab-toc') as HTMLButtonElement;
    const tabBm = this.querySelector('.toc-tab-bm') as HTMLButtonElement;

    tabToc?.addEventListener('click', () => {
      if (this.activeTab === 'toc') return;
      this.activeTab = 'toc';
      tabToc.classList.add('active');
      tabToc.setAttribute('aria-selected', 'true');
      tabBm.classList.remove('active');
      tabBm.setAttribute('aria-selected', 'false');
      this.renderContent();
    });

    tabBm?.addEventListener('click', () => {
      if (this.activeTab === 'bookmarks') return;
      this.activeTab = 'bookmarks';
      tabBm.classList.add('active');
      tabBm.setAttribute('aria-selected', 'true');
      tabToc.classList.remove('active');
      tabToc.setAttribute('aria-selected', 'false');
      this.renderContent();
    });

    // Swipe down to close
    const handle = this.querySelector('.toc-handle') as HTMLElement;
    handle?.addEventListener('touchstart', (e: Event) => {
      this.swipeStartY = (e as TouchEvent).touches[0].clientY;
      this.isSwiping = true;
    });
    handle?.addEventListener('touchmove', (e: Event) => {
      if (!this.isSwiping) return;
      const deltaY = (e as TouchEvent).touches[0].clientY - this.swipeStartY;
      if (deltaY > 60) {
        this.isSwiping = false;
        this.close();
      }
    });
    handle?.addEventListener('touchend', () => { this.isSwiping = false; });
  }

  private async fetchData(): Promise<void> {
    const id = this.bookId;
    if (!id) return;

    try {
      const [toc, bookmarks] = await Promise.all([
        getToc(id),
        getBookmarks(id),
      ]);
      this.tocEntries = toc;
      this.bookmarks = bookmarks.sort((a, b) => a.chapterIndex - b.chapterIndex);
      this.renderContent();
    } catch {
      const content = this.querySelector('.toc-content');
      if (content) content.innerHTML = `<div class="toc-empty">${escapeHtml(t('reading.tocEmpty'))}</div>`;
    }
  }

  private renderContent(): void {
    if (this.activeTab === 'toc') {
      this.renderToc();
    } else {
      this.renderBookmarks();
    }
  }

  private renderToc(): void {
    const content = this.querySelector('.toc-content');
    if (!content) return;

    if (this.tocEntries.length === 0) {
      content.innerHTML = `<div class="toc-empty">${escapeHtml(t('reading.tocEmpty'))}</div>`;
      return;
    }

    content.innerHTML = `<ul class="toc-list">${this.tocEntries.map((entry) => {
      const isActive = entry.spineIndex === this._currentChapter;
      const indent = (entry.level ?? 0) * 16;
      const fragment = entry.href?.includes('#') ? entry.href.split('#')[1] : '';
      return `
        <li class="toc-item${isActive ? ' toc-item--active' : ''}" tabindex="0" data-chapter="${entry.spineIndex ?? entry.index}" data-fragment="${escapeHtml(fragment)}" style="padding-left: ${8 + indent}px">
          <span class="toc-item-title">${escapeHtml(entry.title || `Chapter ${entry.index + 1}`)}</span>
        </li>`;
    }).join('')}</ul>`;

    content.querySelectorAll<HTMLElement>('.toc-item').forEach((item) => {
      item.addEventListener('click', () => {
        const chapterIndex = parseInt(item.dataset.chapter || '0', 10);
        const fragment = item.dataset.fragment || '';
        this.dispatchEvent(new CustomEvent('navigate-chapter', {
          bubbles: true, composed: true,
          detail: { chapterIndex, fragment },
        }));
        this.close();
      });
    });

    // Scroll active item into view
    const activeItem = content.querySelector('.toc-item--active') as HTMLElement;
    if (activeItem) {
      requestAnimationFrame(() => activeItem.scrollIntoView({ block: 'center' }));
    }
  }

  private renderBookmarks(): void {
    const content = this.querySelector('.toc-content');
    if (!content) return;

    if (this.bookmarks.length === 0) {
      content.innerHTML = `<div class="toc-empty">${escapeHtml(t('bookmarks.empty'))}</div>`;
      return;
    }

    content.innerHTML = `<ul class="toc-list">${this.bookmarks.map((bm) => {
      const paragraphIndex = bm.paragraphIndex ?? parseInt(bm.paragraphId, 10);
      const paragraph = isNaN(paragraphIndex) ? '0' : String(paragraphIndex + 1);
      const label = bm.label || t('bookmarks.positionLabel', {
        chapter: String(bm.chapterIndex + 1),
        paragraph,
      });
      return `
        <li class="toc-bm-item" data-bookmark-id="${escapeHtml(bm.id)}" data-chapter="${bm.chapterIndex}" data-paragraph-id="${escapeHtml(bm.paragraphId)}">
          <div class="toc-bm-content">
            <div class="toc-bm-label">${escapeHtml(label)}</div>
            <div class="toc-bm-chapter">${escapeHtml(t('bookmarks.defaultLabel', { chapter: String(bm.chapterIndex + 1) }))}</div>
          </div>
          <button class="toc-bm-delete" aria-label="${escapeHtml(t('bookmarks.deleteTooltip'))}" data-bookmark-id="${escapeHtml(bm.id)}"><img class="bm-icon" src="/icons/xmark.svg" alt="" aria-hidden="true"></button>
        </li>`;
    }).join('')}</ul>`;

    // Bind events
    content.querySelectorAll<HTMLElement>('.toc-bm-content').forEach((el) => {
      el.addEventListener('click', () => {
        const item = el.closest('.toc-bm-item') as HTMLElement;
        if (!item) return;
        const chapterIndex = parseInt(item.dataset.chapter || '0', 10);
        const paragraphId = item.dataset.paragraphId || '';
        this.dispatchEvent(new CustomEvent('navigate-bookmark', {
          bubbles: true, composed: true,
          detail: { chapterIndex, paragraphId },
        }));
        this.close();
      });
    });

    content.querySelectorAll<HTMLButtonElement>('.toc-bm-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bookmarkId = btn.dataset.bookmarkId;
        if (bookmarkId) this.handleDeleteBookmark(bookmarkId);
      });
    });
  }

  private async handleDeleteBookmark(bookmarkId: string): Promise<void> {
    try {
      await deleteBookmark(this.bookId, bookmarkId);
      this.bookmarks = this.bookmarks.filter((b) => b.id !== bookmarkId);
      this.renderBookmarks();
    } catch {
      showToast(t('toast.errorGeneric'), 'error');
    }
  }

  private close(): void {
    const overlay = this.querySelector('.toc-overlay');
    const panel = this.querySelector('.toc-panel');
    overlay?.classList.remove('open');
    panel?.classList.remove('open');

    const onEnd = () => {
      panel?.removeEventListener('transitionend', onEnd);
      this.remove();
    };
    panel?.addEventListener('transitionend', onEnd);
    setTimeout(() => this.remove(), 350);
  }
}

customElements.define('toc-sheet', TocSheet);

export { TocSheet };
