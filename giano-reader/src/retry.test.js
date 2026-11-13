import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff, abortableDelay } from './retry.js';

describe('retryWithBackoff', () => {
  it('returns the result of a successful first attempt without waiting', async () => {
    const operation = vi.fn(async () => 'ok');
    expect(await retryWithBackoff(operation, { delaysMs: [1000] })).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and returns the later success', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue('translated');
    expect(await retryWithBackoff(operation, { delaysMs: [1, 1] })).toBe('translated');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once the delays are used up', async () => {
    const operation = vi.fn(async () => { throw new Error('still failing'); });
    await expect(retryWithBackoff(operation, { delaysMs: [1, 1] })).rejects.toThrow('still failing');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry when no delay is given', async () => {
    const operation = vi.fn(async () => { throw new Error('once'); });
    await expect(retryWithBackoff(operation)).rejects.toThrow('once');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry a cancelled operation', async () => {
    const operation = vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(retryWithBackoff(operation, { delaysMs: [1, 1] })).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops waiting as soon as the signal is aborted', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => { throw new Error('fail'); });
    const pending = retryWithBackoff(operation, { delaysMs: [60000], signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('abortableDelay', () => {
  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelay(60000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves after the delay', async () => {
    await expect(abortableDelay(1)).resolves.toBeUndefined();
  });
});
