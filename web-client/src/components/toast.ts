export type ToastType = 'success' | 'error' | 'info';

const TOAST_STYLES = `
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(100%);
  opacity: 0;
  z-index: 10000;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 48px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.toast.toast-visible {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}

.toast-success {
  background: #1b5e20;
  color: #fff;
}

.toast-error {
  background: #b71c1c;
  color: #fff;
}

.toast-info {
  background: #0288d1;
  color: #fff;
}

.toast-message {
  flex: 1;
}

.toast-close {
  background: none;
  border: none;
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.toast-close:hover {
  background: rgba(255, 255, 255, 0.15);
}
`;

let styleInjected = false;

function injectStyles(): void {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = TOAST_STYLES;
  document.head.appendChild(style);
  styleInjected = true;
}

class ToastNotification extends HTMLElement {
  private timeout: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    injectStyles();

    const message = this.getAttribute('message') || '';
    const type = (this.getAttribute('type') || 'success') as ToastType;

    this.className = `toast toast-${type}`;
    this.setAttribute('role', 'status');
    this.setAttribute('aria-live', 'polite');
    this.innerHTML = `
      <span class="toast-message">${escapeHtml(message)}</span>
      ${type === 'error' ? '<button class="toast-close" aria-label="Close">✕</button>' : ''}
    `;

    // Trigger slide-up transition on next frame
    requestAnimationFrame(() => {
      this.classList.add('toast-visible');
    });

    if (type === 'success') {
      this.timeout = setTimeout(() => this.dismiss(), 2000);
    }

    this.querySelector('.toast-close')?.addEventListener('click', () => this.dismiss());
  }

  disconnectedCallback(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private dismiss(): void {
    this.classList.remove('toast-visible');
    // Wait for transition to finish before removing from DOM
    const onEnd = () => {
      this.removeEventListener('transitionend', onEnd);
      this.remove();
    };
    this.addEventListener('transitionend', onEnd);
    // Fallback in case transitionend doesn't fire
    setTimeout(() => this.remove(), 350);
  }
}

customElements.define('toast-notification', ToastNotification);

/**
 * Shows an ephemeral toast notification.
 * - 'success' type auto-dismisses after 2 seconds.
 * - 'error' type requires manual dismissal (tap close button).
 */
export function showToast(message: string, type: ToastType = 'success'): void {
  const toast = document.createElement('toast-notification') as ToastNotification;
  toast.setAttribute('message', message);
  toast.setAttribute('type', type);
  document.body.appendChild(toast);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
