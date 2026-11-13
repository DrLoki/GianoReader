/**
 * retry.js
 *
 * Retry of an async operation that can fail for temporary reasons (network,
 * rate limit). Pure helper, no DOM access.
 */

/** True for errors that must not be retried: the operation was cancelled. */
function isAbort(err, signal) {
  return (signal && signal.aborted) || (err && err.name === 'AbortError');
}

/**
 * Waits `ms` milliseconds, or rejects with an `AbortError` as soon as `signal`
 * is aborted.
 */
export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `operation`, retrying after each delay in `delaysMs` when it fails.
 * With `delaysMs = [1500, 4000]` the operation runs at most three times.
 * A cancelled operation (`signal` aborted, or an `AbortError`) is not retried.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ delaysMs?: number[], signal?: AbortSignal }} [options]
 * @returns {Promise<T>} the first successful result
 * @throws the error of the last attempt
 */
export async function retryWithBackoff(operation, { delaysMs = [], signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (isAbort(err, signal) || attempt >= delaysMs.length) throw err;
      await abortableDelay(delaysMs[attempt], signal);
    }
  }
}
