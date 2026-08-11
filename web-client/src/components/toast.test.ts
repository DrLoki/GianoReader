import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast, type ToastType } from './toast';

describe('toast component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('showToast creates a toast-notification element in the DOM', () => {
    showToast('Test message', 'success');
    const toast = document.querySelector('toast-notification');
    expect(toast).not.toBeNull();
    expect(toast?.getAttribute('message')).toBe('Test message');
    expect(toast?.getAttribute('type')).toBe('success');
  });

  it('success toast displays message text', () => {
    showToast('Bookmark saved', 'success');
    const toast = document.querySelector('toast-notification');
    const msg = toast?.querySelector('.toast-message');
    expect(msg?.textContent).toBe('Bookmark saved');
  });

  it('success toast has no close button', () => {
    showToast('Settings saved', 'success');
    const toast = document.querySelector('toast-notification');
    const closeBtn = toast?.querySelector('.toast-close');
    expect(closeBtn).toBeNull();
  });

  it('success toast auto-dismisses after 2 seconds', () => {
    showToast('Auto dismiss', 'success');
    expect(document.querySelector('toast-notification')).not.toBeNull();

    vi.advanceTimersByTime(2000);
    // After dismiss timeout, transition fallback removes after 350ms
    vi.advanceTimersByTime(350);
    expect(document.querySelector('toast-notification')).toBeNull();
  });

  it('error toast displays a close button', () => {
    showToast('Something went wrong', 'error');
    const toast = document.querySelector('toast-notification');
    const closeBtn = toast?.querySelector('.toast-close');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn?.getAttribute('aria-label')).toBe('Close');
  });

  it('error toast does not auto-dismiss', () => {
    showToast('Network error', 'error');
    vi.advanceTimersByTime(5000);
    expect(document.querySelector('toast-notification')).not.toBeNull();
  });

  it('error toast is dismissed when close button is clicked', () => {
    showToast('Error occurred', 'error');
    const toast = document.querySelector('toast-notification');
    const closeBtn = toast?.querySelector('.toast-close') as HTMLButtonElement;
    closeBtn.click();
    vi.advanceTimersByTime(350);
    expect(document.querySelector('toast-notification')).toBeNull();
  });

  it('showToast defaults to success type when type is omitted', () => {
    showToast('Default type');
    const toast = document.querySelector('toast-notification');
    expect(toast?.getAttribute('type')).toBe('success');
  });

  it('toast has correct ARIA attributes for accessibility', () => {
    showToast('Accessible toast', 'success');
    const toast = document.querySelector('toast-notification');
    expect(toast?.getAttribute('role')).toBe('status');
    expect(toast?.getAttribute('aria-live')).toBe('polite');
  });

  it('toast escapes HTML in message to prevent XSS', () => {
    showToast('<script>alert("xss")</script>', 'success');
    const toast = document.querySelector('toast-notification');
    const msg = toast?.querySelector('.toast-message');
    expect(msg?.innerHTML).not.toContain('<script>');
    expect(msg?.textContent).toBe('<script>alert("xss")</script>');
  });

  it('ToastType allows success and error', () => {
    const validTypes: ToastType[] = ['success', 'error'];
    expect(validTypes).toHaveLength(2);
  });
});
