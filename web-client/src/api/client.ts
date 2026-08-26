const AUTH_STORAGE_KEY = 'giano-server-password';

/** Flag to prevent emitting multiple 'unauthorized' events. */
let unauthorizedEmitted = false;

/**
 * Returns the stored server password (if any) from localStorage.
 */
export function getStoredPassword(): string | null {
  return localStorage.getItem(AUTH_STORAGE_KEY);
}

/**
 * Saves the server password to localStorage.
 * Resets the unauthorized flag so future 401s can be detected again.
 */
export function setStoredPassword(password: string): void {
  localStorage.setItem(AUTH_STORAGE_KEY, password);
  unauthorizedEmitted = false;
}

/**
 * Clears the stored server password from localStorage.
 */
export function clearStoredPassword(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

/**
 * Resets the unauthorized flag. Called after the user successfully authenticates
 * so that future 401s (e.g. password changed server-side) can be detected.
 */
export function resetUnauthorizedFlag(): void {
  unauthorizedEmitted = false;
}

/**
 * Thin wrapper around the global `fetch` that detects network failures
 * and notifies the rest of the app via a DOM custom event.
 *
 * - Automatically attaches `Authorization: Bearer <password>` if a password
 *   is stored in localStorage.
 * - On success (including non-2xx HTTP responses): returns the Response as-is.
 * - On first 401 response: dispatches a single 'unauthorized' CustomEvent on
 *   `document` so the app can prompt the user to enter their password.
 *   Subsequent 401s do NOT re-emit the event to prevent loops.
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
  // Inject Authorization header if password is stored
  const password = getStoredPassword();
  if (password) {
    const headers = new Headers(options?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${password}`);
    }
    options = { ...options, headers };
  }

  try {
    const response = await fetch(path, options);

    // Emit 'unauthorized' event only once to prevent re-mount loops
    if (response.status === 401 && !unauthorizedEmitted) {
      unauthorizedEmitted = true;
      document.dispatchEvent(new CustomEvent('unauthorized'));
    }

    return response;
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      document.dispatchEvent(new CustomEvent('disconnected'));
    }
    throw error;
  }
}
