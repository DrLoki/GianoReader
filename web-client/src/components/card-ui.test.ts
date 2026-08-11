import { describe, it, expect, beforeEach } from 'vitest';
import './card-ui';

describe('card-ui', () => {
  let el: HTMLElement & {
    switchTo(card: 'original' | 'translated'): void;
    getActiveCard(): 'original' | 'translated';
    getOriginalSlot(): HTMLElement | null;
    getTranslatedSlot(): HTMLElement | null;
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

  it('original card starts without inactive class', () => {
    const original = el.querySelector('.card-original');
    expect(original?.classList.contains('inactive')).toBe(false);
  });

  it('translated card starts without active class', () => {
    const translated = el.querySelector('.card-translated');
    expect(translated?.classList.contains('active')).toBe(false);
  });

  it('switchTo("translated") makes translated the active card', () => {
    el.switchTo('translated');
    expect(el.getActiveCard()).toBe('translated');
    const original = el.querySelector('.card-original');
    const translated = el.querySelector('.card-translated');
    expect(original?.classList.contains('inactive')).toBe(true);
    expect(translated?.classList.contains('active')).toBe(true);
  });

  it('switchTo("original") from translated reverts positions', () => {
    el.switchTo('translated');
    el.switchTo('original');
    expect(el.getActiveCard()).toBe('original');
    const original = el.querySelector('.card-original');
    const translated = el.querySelector('.card-translated');
    expect(original?.classList.contains('inactive')).toBe(false);
    expect(translated?.classList.contains('active')).toBe(false);
  });

  it('switchTo same card is a no-op', () => {
    el.switchTo('original');
    expect(el.getActiveCard()).toBe('original');
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

  it('original card has cyan border-top accent (3px solid #00bcd4)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('3px solid #00bcd4');
  });

  it('translated card has orange border-top accent (3px solid #ff9800)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('3px solid #ff9800');
  });

  it('CSS transition is ≤ 300ms (0.3s ease)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('transition: transform 0.3s ease');
  });

  it('inactive strip is at least 12px (calc uses 12px)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    // Both inactive positions use calc(... 12px)
    expect(style).toContain('100% - 12px');
  });

  it('content areas are scrollable (overflow-y: auto)', () => {
    const style = el.querySelector('style')?.textContent ?? '';
    expect(style).toContain('overflow-y: auto');
  });

  it('no re-fetch on card switch (content persists after switch)', () => {
    // Inject content into the original slot
    const originalSlot = el.getOriginalSlot()!;
    originalSlot.innerHTML = '<p>Hello world</p>';

    const translatedSlot = el.getTranslatedSlot()!;
    translatedSlot.innerHTML = '<p>Ciao mondo</p>';

    // Switch cards
    el.switchTo('translated');
    el.switchTo('original');

    // Content should still be there (no re-fetch, no DOM clearing)
    expect(originalSlot.innerHTML).toBe('<p>Hello world</p>');
    expect(translatedSlot.innerHTML).toBe('<p>Ciao mondo</p>');
  });
});
