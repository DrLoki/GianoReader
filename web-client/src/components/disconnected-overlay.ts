import { getPreferences } from '../api/preferences';
import { t } from '../i18n/index';

/**
 * Escape HTML special characters to prevent XSS when interpolating
 * values into innerHTML templates.
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
  private abortController: AbortController | null = null;

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

    // Clean up event listeners
    this.abortController?.abort();
    this.abortController = null;
  }

  private render(): void {
    // Abort any previous listeners if render is called again
    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const serverUrl = escapeHtml(window.location.origin);

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

        .offline-btn {
          background: transparent;
          border: 1px solid var(--border-color, #444);
          border-radius: 8px;
          color: #fff;
          padding: 0.5rem 1.25rem;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          min-height: 44px;
          width: 100%;
          margin-top: 1.25rem;
          transition: background 0.2s;
        }

        .offline-btn:hover {
          background: rgba(255, 255, 255, 0.08);
        }

        .offline-btn:focus-visible {
          outline: 2px solid var(--accent, #c0392b);
          outline-offset: 2px;
        }
      </style>
      <div class="disconnected-content">
        <h2>${escapeHtml(t('disconnected.title'))}</h2>
        <p>${escapeHtml(t('disconnected.message', { url: serverUrl }))}</p>
        <p class="disconnected-url"><strong>${escapeHtml(t('disconnected.serverUrl'))}:</strong> ${serverUrl}</p>
        <button class="reconnect-btn" aria-label="${escapeHtml(t('disconnected.reconnect'))}">${escapeHtml(t('disconnected.reconnect'))}</button>
        <button class="offline-btn" aria-label="${escapeHtml(t('offline.switchToOffline'))}">${escapeHtml(t('offline.switchToOffline'))}</button>
      </div>
    `;

    const btn = this.querySelector('.reconnect-btn') as HTMLButtonElement;
    btn?.addEventListener('click', () => this.reconnect(), { signal });

    const offlineBtn = this.querySelector('.offline-btn') as HTMLButtonElement;
    offlineBtn?.addEventListener('click', () => {
      localStorage.setItem('giano-offline-mode', 'true');
      this.remove();
      window.location.reload();
    }, { signal });
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
