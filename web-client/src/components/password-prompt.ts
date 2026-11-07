import { setStoredPassword } from '../api/client';
import { t } from '../i18n/index';
import { saveLocalPreferences } from '../api/local-db';
import type { Preferences } from '../types';

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Full-screen overlay shown when the server requires a password.
 *
 * Prompts the user to enter the server password. On successful validation
 * (a protected endpoint returns 200), the overlay removes itself and
 * dispatches 'password-accepted' so the app can load the library.
 *
 * If the password is incorrect, the app silently dismisses the prompt and
 * enters "guest mode" — the user can load local EPUBs and use FREE translation
 * (directly or via their Cloudflare Worker) but cannot access the server
 * library, bookmarks or the server's BASIC translation, which uses the owner's
 * paid Google Cloud key and therefore requires the password.
 */
class PasswordPrompt extends HTMLElement {
  private abortController: AbortController | null = null;

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    // Clean up event listeners
    this.abortController?.abort();
    this.abortController = null;
  }

  private render(): void {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-modal', 'true');
    this.setAttribute('aria-label', t('password.title'));

    this.innerHTML = `
      <style>
        password-prompt {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.85);
          padding: 1.5rem;
        }

        .password-content {
          text-align: center;
          color: #fff;
          max-width: 360px;
          width: 100%;
        }

        .password-content h2 {
          font-size: 1.5rem;
          margin: 0 0 1rem;
        }

        .password-content p {
          font-size: 0.95rem;
          line-height: 1.5;
          margin: 0 0 1.5rem;
          color: #ccc;
        }

        .password-input {
          width: 100%;
          padding: 0.75rem 1rem;
          font-size: 1rem;
          border: 1px solid #555;
          border-radius: 8px;
          background: #2a2a2a;
          color: #fff;
          outline: none;
          margin-bottom: 1rem;
          box-sizing: border-box;
        }

        .password-input:focus {
          border-color: var(--accent, #c0392b);
        }

        .password-submit-btn {
          width: 100%;
          padding: 0.75rem;
          font-size: 1rem;
          font-weight: 600;
          color: #fff;
          background: var(--accent, #c0392b);
          border: none;
          border-radius: 8px;
          cursor: pointer;
          min-height: 44px;
        }

        .password-submit-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      </style>
      <div class="password-content">
        <h2>${escapeHtml(t('password.title'))}</h2>
        <p>${escapeHtml(t('password.message'))}</p>
        <input
          type="password"
          class="password-input"
          placeholder="${escapeHtml(t('password.placeholder'))}"
          autocomplete="current-password"
          aria-label="${escapeHtml(t('password.placeholder'))}"
        >
        <button class="password-submit-btn">${escapeHtml(t('password.submit'))}</button>
      </div>
    `;

    const input = this.querySelector('.password-input') as HTMLInputElement;
    const submitBtn = this.querySelector('.password-submit-btn') as HTMLButtonElement;

    // Focus the input
    setTimeout(() => input?.focus(), 100);

    // Submit on Enter key
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleSubmit(input, submitBtn);
      }
    }, { signal });

    // Submit on button click
    submitBtn?.addEventListener('click', () => {
      this.handleSubmit(input, submitBtn);
    }, { signal });
  }

  private async handleSubmit(
    input: HTMLInputElement,
    submitBtn: HTMLButtonElement,
  ): Promise<void> {
    const password = input.value;

    // If no password entered, go directly to guest mode
    if (!password) {
      await this.enterGuestMode();
      return;
    }

    submitBtn.disabled = true;

    // Store the password temporarily and verify against a protected endpoint
    setStoredPassword(password);

    try {
      const response = await fetch('/api/books', {
        headers: { 'Authorization': `Bearer ${password}` },
      });

      if (response.ok) {
        // Password accepted — dismiss and load library
        this.remove();
        document.dispatchEvent(new CustomEvent('password-accepted'));
      } else {
        // Wrong password — enter guest mode (local epub + translation only)
        localStorage.removeItem('giano-server-password');
        await this.enterGuestMode();
      }
    } catch {
      // Network error — enter guest mode
      await this.enterGuestMode();
    }
  }

  /**
   * Enter guest mode: dismiss the prompt and switch to offline mode.
   * The user can still load local EPUBs and use FREE translation. Server
   * preferences (theme, languages…) are merged into the local ones; BASIC
   * translation is not available to guests because /api/translate requires
   * the password.
   */
  private async enterGuestMode(): Promise<void> {
    try {
      const response = await fetch('/api/preferences');
      if (response.ok) {
        const serverPrefs: Preferences = await response.json();
        // Keep existing local settings (like translationMode) over server values
        const existing = JSON.parse(localStorage.getItem('giano-local-preferences') || '{}');
        const merged: Preferences = { ...serverPrefs, ...existing };
        // Guests cannot reach the server's BASIC engine: fall back to FREE
        if (merged.translationMode === 'basic') merged.translationMode = 'free';
        // Drop any key cached by older versions of the app
        delete (merged as Preferences & { gcloudApiKey?: string }).gcloudApiKey;
        saveLocalPreferences(merged);
      }
    } catch {
      // Ignore — local defaults will be used
    }

    localStorage.setItem('giano-offline-mode', 'true');
    this.remove();
    window.location.reload();
  }
}

customElements.define('password-prompt', PasswordPrompt);
