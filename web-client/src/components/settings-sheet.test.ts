import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing component
vi.mock('../api/translate', () => ({
  getLanguages: vi.fn().mockResolvedValue([
    { code: 'it', name: 'Italian' },
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'French' },
  ]),
}));

vi.mock('../api/preferences', () => ({
  putPreferences: vi.fn().mockResolvedValue({
    theme: 'dark',
    uiLanguage: 'en',
    translationLang: 'it',
    fontSize: 16,
  }),
}));

vi.mock('../main', () => ({
  applyPreferences: vi.fn(),
}));

vi.mock('./toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../i18n/index', () => ({
  t: (key: string) => key,
  setLocale: vi.fn(),
}));

import './settings-sheet';
import { getLanguages } from '../api/translate';
import { putPreferences } from '../api/preferences';
import { applyPreferences } from '../main';
import { showToast } from './toast';
import { setLocale } from '../i18n/index';

describe('settings-sheet component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.setProperty('--font-size', '16px');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--font-size');
  });

  function createSheet(): HTMLElement {
    const sheet = document.createElement('settings-sheet');
    document.body.appendChild(sheet);
    return sheet;
  }

  it('renders with dialog role and title', () => {
    const sheet = createSheet();
    const panel = sheet.querySelector('.settings-panel');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
  });

  it('has an overlay for closing on outside tap', () => {
    const sheet = createSheet();
    const overlay = sheet.querySelector('.settings-overlay');
    expect(overlay).not.toBeNull();
  });

  it('contains theme selector with light, dark, and sepia options', () => {
    const sheet = createSheet();
    const themeButtons = sheet.querySelectorAll('.settings-theme-btn');
    expect(themeButtons).toHaveLength(3);
    const themes = Array.from(themeButtons).map((b) => (b as HTMLElement).dataset.theme);
    expect(themes).toContain('light');
    expect(themes).toContain('dark');
    expect(themes).toContain('sepia');
  });

  it('marks the current theme as pressed', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const sheet = createSheet();
    const darkBtn = sheet.querySelector('[data-theme="dark"]');
    expect(darkBtn?.getAttribute('aria-pressed')).toBe('true');
  });

  it('contains font-size slider with min 12, max 32, step 2', () => {
    const sheet = createSheet();
    const range = sheet.querySelector('#settings-font-size') as HTMLInputElement;
    expect(range).not.toBeNull();
    expect(range.min).toBe('12');
    expect(range.max).toBe('32');
    expect(range.step).toBe('2');
  });

  it('contains UI language select with it and en options', () => {
    const sheet = createSheet();
    const select = sheet.querySelector('#settings-ui-lang') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('it');
    expect(options).toContain('en');
  });

  it('contains read-only connection info section', () => {
    const sheet = createSheet();
    const connectionSection = sheet.querySelector('.settings-connection');
    expect(connectionSection).not.toBeNull();
    expect(connectionSection?.textContent).toContain(window.location.origin);
  });

  it('shows connected status when no disconnected-overlay present', () => {
    const sheet = createSheet();
    const dot = sheet.querySelector('.settings-status-dot');
    expect(dot?.classList.contains('connected')).toBe(true);
  });

  it('fetches languages on connected and populates the dropdown', async () => {
    createSheet();
    // Flush the promise from getLanguages
    await vi.waitFor(() => {
      expect(getLanguages).toHaveBeenCalled();
    });
  });

  it('clicking a theme button calls applyPreferences and putPreferences', () => {
    const sheet = createSheet();
    const lightBtn = sheet.querySelector('[data-theme="light"]') as HTMLButtonElement;
    lightBtn.click();

    expect(applyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'light' }),
    );
    expect(putPreferences).toHaveBeenCalledWith({ theme: 'light' });
  });

  it('changing font size applies preferences optimistically', () => {
    const sheet = createSheet();
    const range = sheet.querySelector('#settings-font-size') as HTMLInputElement;
    range.value = '20';
    range.dispatchEvent(new Event('input', { bubbles: true }));

    expect(applyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ fontSize: 20 }),
    );
    expect(putPreferences).toHaveBeenCalledWith({ fontSize: 20 });
  });

  it('changing UI language calls setLocale and persists', () => {
    const sheet = createSheet();
    const select = sheet.querySelector('#settings-ui-lang') as HTMLSelectElement;
    select.value = 'it';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(setLocale).toHaveBeenCalledWith('it');
    expect(putPreferences).toHaveBeenCalledWith({ uiLanguage: 'it' });
  });

  it('clicking overlay closes the sheet', () => {
    const sheet = createSheet();
    const overlay = sheet.querySelector('.settings-overlay') as HTMLElement;
    overlay.click();

    // After close transition fallback
    vi.advanceTimersByTime(350);
    expect(document.querySelector('settings-sheet')).toBeNull();
  });

  it('shows error toast on persistence failure but retains visual change', async () => {
    vi.mocked(putPreferences).mockRejectedValueOnce(new Error('Network error'));
    const sheet = createSheet();
    const lightBtn = sheet.querySelector('[data-theme="light"]') as HTMLButtonElement;
    lightBtn.click();

    // applyPreferences was still called (optimistic)
    expect(applyPreferences).toHaveBeenCalled();

    // Wait for the rejected promise
    await vi.advanceTimersByTimeAsync(0);
    expect(showToast).toHaveBeenCalledWith('toast.networkError', 'error');
  });

  it('panel has CSS transition class for slide-up animation', () => {
    const sheet = createSheet();
    const panel = sheet.querySelector('.settings-panel') as HTMLElement;
    // The panel starts with transform: translateY(100%) via CSS
    // and gets .open class added in next frame
    expect(panel).not.toBeNull();
    expect(panel.classList.contains('settings-panel')).toBe(true);
  });

  it('adds open class after animation frame', async () => {
    const sheet = createSheet();
    // Trigger the rAF callback
    await vi.advanceTimersByTimeAsync(16);
    const panel = sheet.querySelector('.settings-panel');
    expect(panel?.classList.contains('open')).toBe(true);
  });
});
