import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './disconnected-overlay';

// Mock the preferences API
vi.mock('../api/preferences', () => ({
  getPreferences: vi.fn(),
}));

import { getPreferences } from '../api/preferences';
const mockGetPreferences = vi.mocked(getPreferences);

describe('disconnected-overlay component', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><p>Main content</p></div>';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a full-screen overlay with reconnect button', () => {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    expect(overlay.querySelector('.reconnect-btn')).not.toBeNull();
    expect(overlay.querySelector('.disconnected-content')).not.toBeNull();
    expect(overlay.querySelector('h2')?.textContent).toBe('Disconnected');
  });

  it('displays the current server URL', () => {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const urlEl = overlay.querySelector('.disconnected-url');
    expect(urlEl?.textContent).toContain(window.location.origin);
  });

  it('sets pointer-events none on #app when mounted', () => {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const app = document.getElementById('app');
    expect(app?.style.pointerEvents).toBe('none');
  });

  it('restores pointer-events on #app when removed', () => {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const app = document.getElementById('app');
    expect(app?.style.pointerEvents).toBe('none');

    overlay.remove();
    expect(app?.style.pointerEvents).toBe('');
  });

  it('removes overlay on successful reconnect', async () => {
    mockGetPreferences.mockResolvedValueOnce({
      theme: 'dark',
      uiLanguage: 'en',
      translationLang: 'it',
      fontSize: 16,
    });

    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const btn = overlay.querySelector('.reconnect-btn') as HTMLButtonElement;
    btn.click();

    // Wait for the async reconnect to resolve
    await vi.waitFor(() => {
      expect(document.querySelector('disconnected-overlay')).toBeNull();
    });
  });

  it('disables button during reconnect attempt', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    mockGetPreferences.mockReturnValueOnce(pendingPromise as never);

    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const btn = overlay.querySelector('.reconnect-btn') as HTMLButtonElement;
    btn.click();

    expect(btn.disabled).toBe(true);

    // Resolve the promise to clean up
    resolvePromise!({ theme: 'dark', uiLanguage: 'en', translationLang: 'it', fontSize: 16 });
    await vi.waitFor(() => {
      expect(document.querySelector('disconnected-overlay')).toBeNull();
    });
  });

  it('re-enables button on failed reconnect', async () => {
    mockGetPreferences.mockRejectedValueOnce(new TypeError('Network error'));

    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const btn = overlay.querySelector('.reconnect-btn') as HTMLButtonElement;
    btn.click();

    await vi.waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    // Overlay should still be visible
    expect(document.querySelector('disconnected-overlay')).not.toBeNull();
  });

  it('has correct ARIA attributes for accessibility', () => {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    expect(overlay.getAttribute('role')).toBe('alertdialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBe('Disconnected');
  });

  it('reconnect button has aria-label for accessibility', () => {
    const overlay = document.createElement('disconnected-overlay');
    document.body.appendChild(overlay);

    const btn = overlay.querySelector('.reconnect-btn');
    expect(btn?.getAttribute('aria-label')).toBe('Reconnect');
  });
});
