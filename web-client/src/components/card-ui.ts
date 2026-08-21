import { t } from '../i18n/index';

/**
 * <card-ui> — Dual-panel reading layout.
 *
 * - On wide screens (≥768px): side-by-side panels with synchronized scroll.
 * - On narrow screens (<768px): single panel visible at a time, slide to switch.
 *
 * Both panels are always rendered and in the DOM. On narrow screens, the inactive
 * panel is positioned off-screen but remains part of the layout for
 * IntersectionObserver to work with root: translatedSlot.
 */
class CardUI extends HTMLElement {
  private activeCard: 'original' | 'translated' = 'original';
  private startX = 0;
  private startY = 0;
  private tracking = false;
  private syncingScroll = false;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    this.render();
    this.setupScrollSync();
    this.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    this.addEventListener('pointerup', this.onPointerUp, { passive: true });
  }

  disconnectedCallback(): void {
    this.removeEventListener('pointerdown', this.onPointerDown);
    this.removeEventListener('pointerup', this.onPointerUp);
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.tracking = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.tracking) return;
    this.tracking = false;

    // Only handle swipe in narrow mode
    if (window.innerWidth >= 768) return;

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx >= 40 && (absDy === 0 || absDx / absDy >= 2)) {
      if (dx < 0) {
        this.switchTo('translated');
      } else {
        this.switchTo('original');
      }
    }
  };

  /** Switch the visible card (narrow mode). In wide mode this is a no-op visually. */
  public switchTo(card: 'original' | 'translated'): void {
    if (card === this.activeCard) return;
    const previousCard = this.activeCard;
    this.syncScroll(previousCard, card);
    this.activeCard = card;
    this.updatePositions();
    this.dispatchEvent(
      new CustomEvent('card-change', {
        bubbles: true,
        composed: true,
        detail: { activeCard: card, previousCard },
      })
    );
  }

  /**
   * Synchronises scroll position between cards.
   * Finds the topmost visible paragraph in the source panel and scrolls
   * the destination panel to align the corresponding paragraph at the same relative position.
   */
  public syncScroll(fromCard: 'original' | 'translated', toCard: 'original' | 'translated'): void {
    if (fromCard === toCard) return;

    const fromSlot = fromCard === 'original' ? this.getOriginalSlot() : this.getTranslatedSlot();
    const toSlot = toCard === 'original' ? this.getOriginalSlot() : this.getTranslatedSlot();

    if (!fromSlot || !toSlot) return;

    // Fast path: if at very top
    if (fromSlot.scrollTop <= 2) {
      toSlot.scrollTop = 0;
      return;
    }

    // Fast path: if at very bottom
    const maxSource = fromSlot.scrollHeight - fromSlot.clientHeight;
    if (maxSource > 0 && fromSlot.scrollTop >= maxSource - 2) {
      const maxTarget = toSlot.scrollHeight - toSlot.clientHeight;
      if (maxTarget > 0) {
        toSlot.scrollTop = maxTarget;
        return;
      }
    }

    // Paragraph-based synchronization
    const paragraphs = fromSlot.querySelectorAll<HTMLElement>('[data-id], [data-index]');
    const containerRect = fromSlot.getBoundingClientRect();

    let targetParagraphInfo: { id: string | null; index: string | null; ratioInP: number } | null = null;

    if (paragraphs.length > 0 && containerRect.height > 0) {
      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const rect = p.getBoundingClientRect();

        // A paragraph is visible if its bottom is past the top edge of the scroll container
        if (rect.bottom > containerRect.top + 1) {
          const id = p.getAttribute('data-id');
          const index = p.getAttribute('data-index');
          const offsetInP = Math.max(0, containerRect.top - rect.top);
          const ratioInP = rect.height > 0 ? Math.min(1, Math.max(0, offsetInP / rect.height)) : 0;
          targetParagraphInfo = { id, index, ratioInP };
          break;
        }
      }

      // If scrolled past all paragraphs, use the last paragraph
      if (!targetParagraphInfo && paragraphs.length > 0) {
        const lastP = paragraphs[paragraphs.length - 1];
        targetParagraphInfo = {
          id: lastP.getAttribute('data-id'),
          index: lastP.getAttribute('data-index'),
          ratioInP: 1,
        };
      }
    }

    if (targetParagraphInfo) {
      let targetP: HTMLElement | null = null;
      if (targetParagraphInfo.id) {
        targetP = toSlot.querySelector<HTMLElement>(`[data-id="${targetParagraphInfo.id}"]`);
      }
      if (!targetP && targetParagraphInfo.index !== null) {
        targetP = toSlot.querySelector<HTMLElement>(`[data-index="${targetParagraphInfo.index}"]`);
      }

      if (targetP) {
        const toContainerRect = toSlot.getBoundingClientRect();
        const targetPRect = targetP.getBoundingClientRect();

        if (toContainerRect.height > 0 && targetPRect.height > 0) {
          const delta = targetPRect.top - toContainerRect.top;
          toSlot.scrollTop = Math.max(0, toSlot.scrollTop + delta + (targetParagraphInfo.ratioInP * targetPRect.height));
          return;
        } else {
          targetP.scrollIntoView({ block: 'start' });
          return;
        }
      }
    }

    // Proportional scroll fallback
    if (maxSource > 0) {
      const ratio = fromSlot.scrollTop / maxSource;
      const maxTarget = Math.max(0, toSlot.scrollHeight - toSlot.clientHeight);
      toSlot.scrollTop = ratio * maxTarget;
    }
  }

  /** Returns the currently active card identifier. */
  public getActiveCard(): 'original' | 'translated' {
    return this.activeCard;
  }

  /** Returns the content container for the Original card. */
  public getOriginalSlot(): HTMLElement | null {
    return this.querySelector('.card-original .card-content');
  }

  /** Returns the content container for the Translated card. */
  public getTranslatedSlot(): HTMLElement | null {
    return this.querySelector('.card-translated .card-content');
  }

  private setupScrollSync(): void {
    const originalSlot = this.getOriginalSlot();
    const translatedSlot = this.getTranslatedSlot();
    if (!originalSlot || !translatedSlot) return;

    const sync = (source: HTMLElement, target: HTMLElement) => {
      if (this.syncingScroll) return;
      // Only sync in wide mode (both panels visible)
      if (window.innerWidth < 768) return;

      this.syncingScroll = true;
      const maxSource = Math.max(1, source.scrollHeight - source.clientHeight);
      const ratio = source.scrollTop / maxSource;
      target.scrollTop = ratio * Math.max(1, target.scrollHeight - target.clientHeight);

      if (this.syncTimeout) clearTimeout(this.syncTimeout);
      this.syncTimeout = setTimeout(() => {
        this.syncingScroll = false;
      }, 50);
    };

    originalSlot.addEventListener('scroll', () => sync(originalSlot, translatedSlot), { passive: true });
    translatedSlot.addEventListener('scroll', () => sync(translatedSlot, originalSlot), { passive: true });
  }

  private render(): void {
    this.innerHTML = `
      <style>
        card-ui {
          display: flex;
          width: 100%;
          height: 100%;
          overflow: hidden;
          touch-action: pan-y;
          position: relative;
        }

        /* ─── Wide layout: side by side ─── */
        @media (min-width: 768px) {
          card-ui .card-panel {
            flex: 1;
            height: 100%;
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            background: var(--card-bg, #1e1e1e);
          }

          card-ui .card-original {
            border-right: 1px solid var(--border-color, #333);
          }
        }

        /* ─── Narrow layout: one panel at a time ─── */
        @media (max-width: 767px) {
          card-ui {
            display: block;
          }

          card-ui .card-panel {
            position: absolute;
            top: 0;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
            background: var(--card-bg, #1e1e1e);
            transition: left 0.3s ease;
          }

          card-ui .card-original {
            left: 0;
          }

          card-ui .card-translated {
            left: 100%;
          }

          card-ui .card-original.slide-out {
            left: -100%;
          }

          card-ui .card-translated.slide-in {
            left: 0;
          }
        }

        card-ui .card-panel {
          border-top: 3px solid transparent;
        }

        card-ui .card-original {
          border-top-color: #00bcd4;
        }

        card-ui .card-translated {
          border-top-color: #ff9800;
        }

        card-ui .card-label {
          padding: 6px 12px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          flex-shrink: 0;
        }

        card-ui .card-original .card-label {
          color: #00bcd4;
        }

        card-ui .card-translated .card-label {
          color: #ff9800;
        }

        card-ui .card-content {
          flex: 1;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 0 12px 12px;
          font-size: var(--font-size, 16px);
          line-height: 1.7;
          color: var(--text-color, #e0e0e0);
        }

        card-ui .card-content p {
          margin: 0 0 1.3em 0;
        }

        card-ui .card-content p:last-child {
          margin-bottom: 0;
        }
      </style>
      <div class="card-panel card-original" aria-label="${t('card.originalLabel')}">
        <div class="card-label">${t('card.originalLabel')}</div>
        <div class="card-content"></div>
      </div>
      <div class="card-panel card-translated" aria-label="${t('card.translatedLabel')}">
        <div class="card-label">${t('card.translatedLabel')}</div>
        <div class="card-content"></div>
      </div>
    `;

    this.updatePositions();
  }

  private updatePositions(): void {
    // Only relevant in narrow mode
    const original = this.querySelector('.card-original') as HTMLElement | null;
    const translated = this.querySelector('.card-translated') as HTMLElement | null;
    if (!original || !translated) return;

    if (this.activeCard === 'translated') {
      original.classList.add('slide-out');
      translated.classList.add('slide-in');
    } else {
      original.classList.remove('slide-out');
      translated.classList.remove('slide-in');
    }
  }
}

customElements.define('card-ui', CardUI);
