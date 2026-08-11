/**
 * Thin wrapper around the global `fetch` that detects network failures
 * and notifies the rest of the app via a DOM custom event.
 *
 * - On success (including non-2xx HTTP responses): returns the Response as-is.
 * - On TypeError (network failure / server unreachable): dispatches a
 *   'disconnected' CustomEvent on `document`, then re-throws.
 * - Retries are NOT automatic — callers decide whether and when to retry.
 *
 * @param path - Relative API path, e.g. `/api/books`
 * @param options - Standard fetch RequestInit options
 */
export async function apiFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(path, options);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      document.dispatchEvent(new CustomEvent('disconnected'));
    }
    throw error;
  }
}
