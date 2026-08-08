import { t } from '../i18n/index';

/**
 * <card-ui> — Dual overlapping card layout for reading Original and Translated text.
 *
 * The active card is in the foreground (higher z-index); the inactive card shows
 * a visible strip of at least 12px on the opposite edge as a swipe affordance.
 * Switching cards is purely visual (CSS transform transition ≤ 300ms) — no content
 * is re-fetched on card switch.
 *
 * Validates: Requirements 10.1, 10.2, 10.5
 */
class CardUI extends HTMLElement {
  private activeCard: 'original' | 'translated' = 'original';
  private startX = 0;
  private startY = 0;
  private tracking = false;

  connectedCallback(): void {
    this.render();
    this.addEventListener('pointerdown', this.onPointerDown);
    this.addEventListener('pointermove', this.onPointerMove);
    this.addEventListener('pointerup', this.onPointerUp);
  }

  disconnectedCallback(): void {
    this.removeEventListener('pointerdown', this.onPointerDown);
    this.removeEventListener('pointermove', this.onPointerMove);
    this.removeEventListener('pointerup', this.onPointerUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.tracking = true;
  };

  private onPointerMove = (_e: PointerEvent): void => {
    // Reserved for optional visual drag feedback
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.tracking) return;
    this.tracking = false;

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Must have ≥ 40px horizontal displacement and horizontal:vertical ratio ≥ 2:1
    if (absDx >= 40 && (absDy === 0 || absDx / absDy >= 2)) {
      if (dx < 0) {
        // Swipe left → show translated
        this.switchTo('translated');
      } else {
        // Swipe right → show original
        this.switchTo('original');
      }
    }
  };

  /** Switch the visible card. No-op if already active. No re-fetch. */
  public switchTo(card: 'original' | 'translated'): void {
    if (card === this.activeCard) return;

    // Sync scroll position before switching
    this.syncScroll(this.activeCard, card);

    this.activeCard = card;
    this.updatePositions();
  }

  /**
   * Synchronise scroll position between cards: find the first paragraph whose
   * top edge is ≥ 1px inside the source viewport, then scroll the destination
   * card to align that paragraph at the top.
   *
   * Validates: Requirements 10.4
   */
  private syncScroll(fromCard: 'original' | 'translated', toCard: 'original' | 'translated'): void {
    const fromSlot = fromCard === 'original' ? this.getOriginalSlot() : this.getTranslatedSlot();
    const toSlot = toCard === 'original' ? this.getOriginalSlot() : this.getTranslatedSlot();

    if (!fromSlot || !toSlot) return;

    // Find the first paragraph whose top edge is ≥ 1px inside the source viewport
    const paragraphs = fromSlot.querySelectorAll<HTMLElement>('[data-index]');
    const containerRect = fromSlot.getBoundingClientRect();

    let targetIndex: string | null = null;
    for (const p of paragraphs) {
      const rect = p.getBoundingClientRect();
      // Top edge is at least 1px inside the container's visible area
      if (rect.top >= containerRect.top + 1) {
        targetIndex = p.getAttribute('data-index');
        break;
      }
    }

    if (targetIndex === null) return;

    // Scroll the destination card to align that paragraph at the top
    const targetParagraph = toSlot.querySelector<HTMLElement>(`[data-index="${targetIndex}"]`);
    if (targetParagraph) {
      targetParagraph.scrollIntoView({ block: 'start' });
    }
  }

  /** Returns the currently active card identifier. */
  public getActiveCard(): 'original' | 'translated' {
    return this.activeCard;
  }

  /** Returns the content container for the Original card so the parent can inject paragraphs. */
  public getOriginalSlot(): HTMLElement | null {
    return this.querySelector('.card-original .card-content');
  }

  /** Returns the content container for the Translated card so the parent can inject paragraphs. */
  public getTranslatedSlot(): HTMLElement | null {
    return this.querySelector('.card-translated .card-content');
  }

  private render(): void {
    this.innerHTML = `
      <style>
        card-ui {
          display: block;
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }

        card-ui .card-panel {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          border-radius: 8px;
          background: var(--card-bg, #1e1e1e);
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          transition: transform 0.3s ease;
          will-change: transform;
        }

        card-ui .card-original {
          border-top: 3px solid #00bcd4;
          z-index: 2;
          transform: translateX(0);
        }

        card-ui .card-translated {
          border-top: 3px solid #ff9800;
          z-index: 1;
          transform: translateX(calc(100% - 12px));
        }

        card-ui .card-original.inactive {
          z-index: 1;
          transform: translateX(calc(-100% + 12px));
        }

        card-ui .card-translated.active {
          z-index: 2;
          transform: translateX(0);
        }

        card-ui .card-label {
          padding: 6px 12px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--card-label-color, #aaa);
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
          padding: 0 12px 12px;
          font-size: var(--font-size, 16px);
          line-height: 1.7;
          color: var(--text-color, #e0e0e0);
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
    const original = this.querySelector('.card-original') as HTMLElement | null;
    const translated = this.querySelector('.card-translated') as HTMLElement | null;

    if (!original || !translated) return;

    if (this.activeCard === 'original') {
      original.classList.remove('inactive');
      translated.classList.remove('active');
    } else {
      original.classList.add('inactive');
      translated.classList.add('active');
    }
  }
}

customElements.define('card-ui', CardUI);
