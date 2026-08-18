import { getPreferences } from '../api/preferences';
import { t } from '../i18n/index';

/**
 * Full-screen overlay shown when the Web Server is unreachable.
 *
 * Displays the last known server URL and a "Reconnect" button.
 * While visible, sets `pointer-events: none` on the `#app` element
 * to block all other interactions.
 *
 * On successful reconnection (GET /api/preferences returns 2xx),
 * the overlay removes itself and restores pointer-events.
 *
 * Validates: Requirements 15.3, 15.4, 15.5
 */
class DisconnectedOverlay extends HTMLElement {
  connectedCallback(): void {
    // Block all interactions on the main app while overlay is visible
    const app = document.getElementById('app');
    if (app) app.style.pointerEvents = 'none';

    this.render();
  }

  disconnectedCallback(): void {
    // Restore pointer-events on #app when overlay is removed
    const app = document.getElementById('app');
    if (app) app.style.pointerEvents = '';
  }

  private render(): void {
    const serverUrl = window.location.origin;

    this.setAttribute('role', 'alertdialog');
    this.setAttribute('aria-modal', 'true');
    this.setAttribute('aria-label', t('disconnected.title'));

    this.innerHTML = `
      <style>
        disconnected-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.85);
          padding: 1.5rem;
        }

        .disconnected-content {
          text-align: center;
          color: #fff;
          max-width: 360px;
          width: 100%;
        }

        .disconnected-content h2 {
          font-size: 1.5rem;
          margin: 0 0 1rem;
        }

        .disconnected-content p {
          font-size: 0.95rem;
          line-height: 1.5;
          margin: 0 0 0.75rem;
          color: #ccc;
        }

        .disconnected-url {
          font-size: 0.85rem;
          color: #aaa;
          word-break: break-all;
          margin-bottom: 1.5rem;
        }

        .reconnect-btn {
          display: inline-block;
          padding: 0.75rem 2rem;
          min-width: 44px;
          min-height: 44px;
          font-size: 1rem;
          font-weight: 600;
          color: #fff;
          background: var(--accent, #c0392b);
          border: none;
          border-radius: 8px;
          cursor: pointer;
          transition: opacity 0.2s;
        }

        .reconnect-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .reconnect-btn:hover:not(:disabled) {
          opacity: 0.85;
        }
      </style>
      <div class="disconnected-content">
        <h2>${t('disconnected.title')}</h2>
        <p>${t('disconnected.message', { url: serverUrl })}</p>
        <p class="disconnected-url"><strong>${t('disconnected.serverUrl')}:</strong> ${serverUrl}</p>
        <button class="reconnect-btn" aria-label="${t('disconnected.reconnect')}">${t('disconnected.reconnect')}</button>
        <div style="margin-top: 1.25rem;">
          <button class="offline-btn" style="background: transparent; border: 1px solid var(--border-color, #444); border-radius: 8px; color: #fff; padding: 0.5rem 1.25rem; font-size: 0.9rem; font-weight: 500; cursor: pointer; min-height: 44px; width: 100%; transition: background 0.2s;" aria-label="Usa in modalità locale (Offline)">
            Usa in modalità locale (Offline)
          </button>
        </div>
      </div>
    `;

    const btn = this.querySelector('.reconnect-btn') as HTMLButtonElement;
    btn?.addEventListener('click', () => this.reconnect());

    const offlineBtn = this.querySelector('.offline-btn') as HTMLButtonElement;
    offlineBtn?.addEventListener('click', () => {
      localStorage.setItem('giano-offline-mode', 'true');
      this.remove();
      window.location.reload();
    });
  }

  private async reconnect(): Promise<void> {
    const btn = this.querySelector('.reconnect-btn') as HTMLButtonElement;
    if (btn) btn.disabled = true;

    try {
      await getPreferences();
      // Server is reachable again — dismiss overlay
      this.remove();
    } catch {
      // Still disconnected — re-enable button for retry
      if (btn) btn.disabled = false;
    }
  }
}

customElements.define('disconnected-overlay', DisconnectedOverlay);
