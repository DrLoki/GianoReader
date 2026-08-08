import { getLanguages } from '../api/translate';
import { getPreferences, putPreferences } from '../api/preferences';
import { showToast } from './toast';
import { applyPreferences } from '../main';
import { t, setLocale } from '../i18n/index';
import type { Preferences } from '../types';

const SHEET_STYLES = `
settings-sheet {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  pointer-events: auto;
}

.settings-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  transition: opacity 0.3s ease;
  opacity: 0;
}

.settings-overlay.open {
  opacity: 1;
}

.settings-panel {
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

.settings-panel.open {
  transform: translateY(0);
}

.settings-handle {
  display: flex;
  justify-content: center;
  padding: 12px 0 8px;
  cursor: grab;
}

.settings-handle-bar {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--on-surface-muted, #666);
}

.settings-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 1rem;
}

.settings-section {
  margin-bottom: 1.25rem;
}

.settings-label {
  display: block;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--on-surface-muted, #aaa);
  margin-bottom: 0.5rem;
}

.settings-theme-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.settings-theme-btn {
  padding: 8px 16px;
  border: 2px solid var(--border, #444);
  border-radius: 8px;
  background: transparent;
  color: var(--on-surface, #fff);
  font-size: 0.9rem;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  transition: border-color 0.15s;
}

.settings-theme-btn[aria-pressed="true"] {
  border-color: var(--accent, #c0392b);
  background: var(--accent, #c0392b);
  color: #fff;
}

.settings-select {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #444);
  background: var(--surface, #1e1e1e);
  color: var(--on-surface, #fff);
  font-size: 0.95rem;
  min-height: 44px;
  appearance: auto;
}

.settings-range-wrapper {
  display: flex;
  align-items: center;
  gap: 12px;
}

.settings-range {
  flex: 1;
  min-height: 44px;
  cursor: pointer;
}

.settings-range-value {
  font-size: 0.9rem;
  min-width: 40px;
  text-align: center;
}

.settings-connection {
  padding: 12px;
  border-radius: 8px;
  background: var(--surface-variant, #2a2a2a);
  font-size: 0.85rem;
  line-height: 1.6;
}

.settings-connection-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.settings-status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.settings-status-dot.connected {
  background: #4caf50;
}

.settings-status-dot.disconnected {
  background: #f44336;
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

/**
 * A slide-up bottom sheet containing app settings.
 *
 * Contains: theme selector (light/dark/sepia), translation language dropdown,
 * font-size slider (12–32px step 2), UI language selector (it/en),
 * and read-only connection info.
 *
 * Closes on overlay tap or downward swipe on the handle.
 * On setting change: immediately applies to :root CSS properties (optimistic),
 * then persists via PUT /api/preferences. On failure shows an error toast
 * but retains the visual change.
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 14.4
 */
class SettingsSheet extends HTMLElement {
  private languages: { code: string; name: string }[] = [];
  private currentPrefs: Preferences = {
    theme: 'dark',
    uiLanguage: 'en',
    translationLang: 'it',
    fontSize: 16,
  };

  // Swipe tracking
  private swipeStartY = 0;
  private isSwiping = false;

  connectedCallback(): void {
    injectStyles();
    this.initFromServer();
  }

  private async initFromServer(): Promise<void> {
    // Load actual preferences from the server
    try {
      const prefs = await getPreferences();
      this.currentPrefs = { ...prefs };
    } catch {
      // Fall back to reading what we can from the DOM
      this.loadCurrentPrefs();
    }

    this.render();
    this.fetchLanguages();
    this.bindEvents();

    // Trigger open animation on next frame
    requestAnimationFrame(() => {
      this.querySelector('.settings-overlay')?.classList.add('open');
      this.querySelector('.settings-panel')?.classList.add('open');
    });
  }

  private loadCurrentPrefs(): void {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme') as Preferences['theme'] || 'dark';
    const fontSizeStr = root.style.getPropertyValue('--font-size');
    const fontSize = fontSizeStr ? parseInt(fontSizeStr, 10) : 16;

    this.currentPrefs = {
      theme,
      fontSize,
      uiLanguage: (document.documentElement.lang as 'it' | 'en') || 'en',
      translationLang: this.currentPrefs.translationLang,
    };
  }

  private render(): void {
    const serverUrl = window.location.origin;
    const isConnected = !document.querySelector('disconnected-overlay');

    this.innerHTML = `
      <div class="settings-overlay" aria-hidden="true"></div>
      <div class="settings-panel" role="dialog" aria-modal="true" aria-label="${t('settings.title')}">
        <div class="settings-handle">
          <div class="settings-handle-bar"></div>
        </div>
        <h2 class="settings-title">${t('settings.title')}</h2>

        <div class="settings-section">
          <span class="settings-label">${t('settings.theme')}</span>
          <div class="settings-theme-group" role="radiogroup" aria-label="${t('settings.theme')}">
            <button class="settings-theme-btn" data-theme="light"
              role="radio" aria-pressed="${this.currentPrefs.theme === 'light'}">${t('settings.themeLight')}</button>
            <button class="settings-theme-btn" data-theme="dark"
              role="radio" aria-pressed="${this.currentPrefs.theme === 'dark'}">${t('settings.themeDark')}</button>
            <button class="settings-theme-btn" data-theme="sepia"
              role="radio" aria-pressed="${this.currentPrefs.theme === 'sepia'}">${t('settings.themeSepia')}</button>
          </div>
        </div>

        <div class="settings-section">
          <label class="settings-label" for="settings-translation-lang">${t('settings.translationLanguage')}</label>
          <select id="settings-translation-lang" class="settings-select">
            <option value="">${t('general.loading')}</option>
          </select>
        </div>

        <div class="settings-section">
          <label class="settings-label" for="settings-font-size">${t('settings.fontSize')}</label>
          <div class="settings-range-wrapper">
            <input type="range" id="settings-font-size" class="settings-range"
              min="12" max="32" step="2" value="${this.currentPrefs.fontSize}"
              aria-valuemin="12" aria-valuemax="32" aria-valuenow="${this.currentPrefs.fontSize}">
            <span class="settings-range-value">${this.currentPrefs.fontSize}px</span>
          </div>
        </div>

        <div class="settings-section">
          <label class="settings-label" for="settings-ui-lang">${t('settings.uiLanguage')}</label>
          <select id="settings-ui-lang" class="settings-select">
            <option value="it" ${this.currentPrefs.uiLanguage === 'it' ? 'selected' : ''}>Italiano</option>
            <option value="en" ${this.currentPrefs.uiLanguage === 'en' ? 'selected' : ''}>English</option>
          </select>
        </div>

        <div class="settings-section">
          <span class="settings-label">${t('settings.connectionInfo')}</span>
          <div class="settings-connection">
            <div class="settings-connection-row">
              <span>Server</span>
              <span>${serverUrl}</span>
            </div>
            <div class="settings-connection-row">
              <span>Status</span>
              <span>
                <span class="settings-status-dot ${isConnected ? 'connected' : 'disconnected'}"></span>
                ${isConnected ? t('settings.statusConnected') : t('settings.statusDisconnected')}
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private async fetchLanguages(): Promise<void> {
    try {
      this.languages = await getLanguages();
      this.populateLanguageSelect();
    } catch {
      // Keep the loading placeholder — user can still use other settings
    }
  }

  private populateLanguageSelect(): void {
    const select = this.querySelector('#settings-translation-lang') as HTMLSelectElement | null;
    if (!select) return;

    select.innerHTML = this.languages
      .map(
        (lang) =>
          `<option value="${lang.code}" ${lang.code === this.currentPrefs.translationLang ? 'selected' : ''}>${lang.name}</option>`,
      )
      .join('');
  }

  private bindEvents(): void {
    // Overlay click to close
    const overlay = this.querySelector('.settings-overlay') as HTMLElement;
    overlay?.addEventListener('click', () => this.close());

    // Theme buttons
    this.querySelectorAll('.settings-theme-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const theme = (btn as HTMLElement).dataset.theme as Preferences['theme'];
        this.currentPrefs.theme = theme;
        // Update aria-pressed
        this.querySelectorAll('.settings-theme-btn').forEach((b) =>
          b.setAttribute('aria-pressed', 'false'),
        );
        btn.setAttribute('aria-pressed', 'true');
        this.applyAndPersist({ theme });
      });
    });

    // Translation language
    const translationSelect = this.querySelector('#settings-translation-lang') as HTMLSelectElement;
    translationSelect?.addEventListener('change', () => {
      const translationLang = translationSelect.value;
      this.currentPrefs.translationLang = translationLang;
      this.applyAndPersist({ translationLang });
    });

    // Font size
    const fontRange = this.querySelector('#settings-font-size') as HTMLInputElement;
    const fontValue = this.querySelector('.settings-range-value') as HTMLElement;
    fontRange?.addEventListener('input', () => {
      const fontSize = parseInt(fontRange.value, 10);
      this.currentPrefs.fontSize = fontSize;
      fontRange.setAttribute('aria-valuenow', String(fontSize));
      if (fontValue) fontValue.textContent = `${fontSize}px`;
      this.applyAndPersist({ fontSize });
    });

    // UI language
    const uiLangSelect = this.querySelector('#settings-ui-lang') as HTMLSelectElement;
    uiLangSelect?.addEventListener('change', () => {
      const uiLanguage = uiLangSelect.value as 'it' | 'en';
      this.currentPrefs.uiLanguage = uiLanguage;
      setLocale(uiLanguage);
      this.applyAndPersist({ uiLanguage });
      // Notify app to re-render all components with new locale
      document.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: uiLanguage } }));
    });

    // Swipe down to close
    const handle = this.querySelector('.settings-handle') as HTMLElement;
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

  private applyAndPersist(partial: Partial<Preferences>): void {
    // Optimistic: immediately apply visual changes
    applyPreferences(this.currentPrefs);

    // Persist in background
    putPreferences(partial).catch(() => {
      showToast(t('toast.networkError'), 'error');
      // Retain visual change (optimistic update) — user sees what they chose
    });
  }

  private close(): void {
    const overlay = this.querySelector('.settings-overlay');
    const panel = this.querySelector('.settings-panel');

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

customElements.define('settings-sheet', SettingsSheet);

export { SettingsSheet };
