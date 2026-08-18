import { describe, it, expect, beforeEach, vi } from 'vitest';
import './card-ui';

if (typeof (globalThis as any).PointerEvent === 'undefined') {
  (globalThis as any).PointerEvent = class extends MouseEvent {
    constructor(type: string, params: MouseEventInit = {}) {
      super(type, params);
    }
  };
}

describe('card-ui', () => {
  let el: HTMLElement & {
    switchTo(card: 'original' | 'translated'): void;
    getActiveCard(): 'original' | 'translated';
    getOriginalSlot(): HTMLElement | null;
    getTranslatedSlot(): HTMLElement | null;
    syncScroll(fromCard: 'original' | 'translated', toCard: 'original' | 'translated'): void;
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    el = document.createElement('card-ui') as any;
    document.body.appendChild(el);
  });

  it('renders two card panels on connect', () => {
    const panels = el.querySelectorAll('.card-panel');
    expect(panels.length).toBe(2);
  });

  it('defaults to original as the active card', () => {
    expect(el.getActiveCard()).toBe('original');
  });

  it('original card starts without slide-out class', () => {
    const original = el.querySelector('.card-original');
    expect(original?.classList.contains('slide-out')).toBe(false);
  });

  it('translated card starts without slide-in class', () => {
    const translated = el.querySelector('.card-translated');
    expect(translated?.classList.contains('slide-in')).toBe(false);
  });

  it('switchTo("translated") makes translated the active card', () => {
    el.switchTo('translated');
    expect(el.getActiveCard()).toBe('translated');
    const original = el.querySelector('.card-original');
    const translated = el.querySelector('.card-translated');
    expect(original?.classList.contains('slide-out')).toBe(true);
    expect(translated?.classList.add ? translated.classList.contains('slide-in') : true).toBe(true);
  });

  it('switchTo("original") from translated reverts positions', () => {
    el.switchTo('translated');
    el.switchTo('original');
    expect(el.getActiveCard()).toBe('original');
    const original = el.querySelector('.card-original');
    const translated = el.querySelector('.card-translated');
    expect(original?.classList.contains('slide-out')).toBe(false);
    expect(translated?.classList.contains('slide-in')).toBe(false);
  });

  it('switchTo same card is a no-op', () => {
    el.switchTo('original');
    expect(el.getActiveCard()).toBe('original');
  });

  it('dispatches card-change CustomEvent on switchTo', () => {
    const handler = vi.fn();
    el.addEventListener('card-change', handler);

    el.switchTo('translated');
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail.activeCard).toBe('translated');
  });

  it('getOriginalSlot returns the content div inside the original card', () => {
    const slot = el.getOriginalSlot();
    expect(slot).not.toBeNull();
    expect(slot?.classList.contains('card-content')).toBe(true);
    expect(slot?.parentElement?.classList.contains('card-original')).toBe(true);
  });

  it('getTranslatedSlot returns the content div inside the translated card', () => {
    const slot = el.getTranslatedSlot();
    expect(slot).not.toBeNull();
    expect(slot?.classList.contains('card-content')).toBe(true);
    expect(slot?.parentElement?.classList.contains('card-translated')).toBe(true);
  });

  it('original card has cyan border-top accent (#00bcd4)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('border-top-color: #00bcd4');
  });

  it('translated card has orange border-top accent (#ff9800)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('border-top-color: #ff9800');
  });

  it('CSS transition is ≤ 300ms (0.3s ease)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('transition: left 0.3s ease');
  });

  it('content areas are scrollable (overflow-y: auto)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('overflow-y: auto');
  });

  it('no re-fetch on card switch (content persists after switch)', () => {
    const originalSlot = el.getOriginalSlot()!;
    originalSlot.innerHTML = '<p data-id="p1">Hello world</p>';

    const translatedSlot = el.getTranslatedSlot()!;
    translatedSlot.innerHTML = '<p data-id="p1">Ciao mondo</p>';

    el.switchTo('translated');
    el.switchTo('original');

    expect(originalSlot.innerHTML).toBe('<p data-id="p1">Hello world</p>');
    expect(translatedSlot.innerHTML).toBe('<p data-id="p1">Ciao mondo</p>');
  });

  describe('Scroll synchronization in portrait mode', () => {
    it('syncScroll resets to 0 when source scrollTop is 0', () => {
      const originalSlot = el.getOriginalSlot()!;
      const translatedSlot = el.getTranslatedSlot()!;

      originalSlot.innerHTML = '<p data-id="p1">P1</p><p data-id="p2">P2</p>';
      translatedSlot.innerHTML = '<p data-id="p1">T1</p><p data-id="p2">T2</p>';

      translatedSlot.scrollTop = 200;
      originalSlot.scrollTop = 0;

      el.syncScroll('original', 'translated');
      expect(translatedSlot.scrollTop).toBe(0);
    });

    it('syncScroll scrolls to bottom when source is scrolled to bottom', () => {
      const originalSlot = el.getOriginalSlot()!;
      const translatedSlot = el.getTranslatedSlot()!;

      Object.defineProperty(originalSlot, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(originalSlot, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(translatedSlot, 'scrollHeight', { value: 1200, configurable: true });
      Object.defineProperty(translatedSlot, 'clientHeight', { value: 400, configurable: true });

      originalSlot.scrollTop = 600; // 1000 - 400 = 600 (max scroll)
      translatedSlot.scrollTop = 0;

      el.syncScroll('original', 'translated');
      expect(translatedSlot.scrollTop).toBe(800); // 1200 - 400 = 800
    });

    it('syncScroll matches paragraph with getBoundingClientRect geometry', () => {
      const originalSlot = el.getOriginalSlot()!;
      const translatedSlot = el.getTranslatedSlot()!;

      originalSlot.innerHTML = '<p data-id="p1">P1</p><p data-id="p2">P2</p><p data-id="p3">P3</p>';
      translatedSlot.innerHTML = '<p data-id="p1">T1</p><p data-id="p2">T2</p><p data-id="p3">T3</p>';

      // Mock getBoundingClientRect
      originalSlot.getBoundingClientRect = () => ({
        top: 100, bottom: 600, height: 500, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON: () => {},
      });
      translatedSlot.getBoundingClientRect = () => ({
        top: 100, bottom: 600, height: 500, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON: () => {},
      });

      const origP2 = originalSlot.querySelector('[data-id="p2"]') as HTMLElement;
      origP2.getBoundingClientRect = () => ({
        top: 80, bottom: 280, height: 200, left: 0, right: 300, width: 300, x: 0, y: 80, toJSON: () => {},
      });

      const transP2 = translatedSlot.querySelector('[data-id="p2"]') as HTMLElement;
      transP2.getBoundingClientRect = () => ({
        top: 350, bottom: 570, height: 220, left: 0, right: 300, width: 300, x: 0, y: 350, toJSON: () => {},
      });

      originalSlot.scrollTop = 150;
      translatedSlot.scrollTop = 0;

      // origP2 offsetInP = 100 - 80 = 20, height = 200 => ratio 0.1
      // transP2 delta = 350 - 100 = 250 => new scrollTop = 0 + 250 + (0.1 * 220) = 272
      el.syncScroll('original', 'translated');
      expect(translatedSlot.scrollTop).toBe(272);
    });

    it('syncScroll works in reverse (from translated to original)', () => {
      const originalSlot = el.getOriginalSlot()!;
      const translatedSlot = el.getTranslatedSlot()!;

      originalSlot.innerHTML = '<p data-id="p1">P1</p><p data-id="p2">P2</p>';
      translatedSlot.innerHTML = '<p data-id="p1">T1</p><p data-id="p2">T2</p>';

      originalSlot.getBoundingClientRect = () => ({
        top: 100, bottom: 600, height: 500, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON: () => {},
      });
      translatedSlot.getBoundingClientRect = () => ({
        top: 100, bottom: 600, height: 500, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON: () => {},
      });

      const transP2 = translatedSlot.querySelector('[data-id="p2"]') as HTMLElement;
      transP2.getBoundingClientRect = () => ({
        top: 90, bottom: 290, height: 200, left: 0, right: 300, width: 300, x: 0, y: 90, toJSON: () => {},
      });

      const origP2 = originalSlot.querySelector('[data-id="p2"]') as HTMLElement;
      origP2.getBoundingClientRect = () => ({
        top: 300, bottom: 500, height: 200, left: 0, right: 300, width: 300, x: 0, y: 300, toJSON: () => {},
      });

      translatedSlot.scrollTop = 200;
      originalSlot.scrollTop = 0;

      // transP2 offsetInP = 100 - 90 = 10, height = 200 => ratio 0.05
      // origP2 delta = 300 - 100 = 200 => new scrollTop = 0 + 200 + (0.05 * 200) = 210
      el.syncScroll('translated', 'original');
      expect(originalSlot.scrollTop).toBe(210);
    });

    it('switchTo automatically synchronizes scroll before changing active card', () => {
      const originalSlot = el.getOriginalSlot()!;
      const translatedSlot = el.getTranslatedSlot()!;

      originalSlot.innerHTML = '<p data-id="p1">P1</p><p data-id="p2">P2</p>';
      translatedSlot.innerHTML = '<p data-id="p1">T1</p><p data-id="p2">T2</p>';

      Object.defineProperty(originalSlot, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(originalSlot, 'clientHeight', { value: 500, configurable: true });
      Object.defineProperty(translatedSlot, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(translatedSlot, 'clientHeight', { value: 500, configurable: true });

      originalSlot.scrollTop = 500; // bottom
      el.switchTo('translated');

      expect(el.getActiveCard()).toBe('translated');
      expect(translatedSlot.scrollTop).toBe(500);
    });

    it('handles swipe gestures to switch cards and sync in narrow mode', () => {
      Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });

      const originalSlot = el.getOriginalSlot()!;
      const translatedSlot = el.getTranslatedSlot()!;
      originalSlot.innerHTML = '<p data-id="p1">P1</p>';
      translatedSlot.innerHTML = '<p data-id="p1">T1</p>';

      // Swipe left (swipe to translated)
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 100 }));
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100 }));

      expect(el.getActiveCard()).toBe('translated');

      // Swipe right (swipe back to original)
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 100 }));

      expect(el.getActiveCard()).toBe('original');
    });
  });
});
