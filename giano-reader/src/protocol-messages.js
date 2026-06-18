/**
 * Protocol message construction and validation for sidecar communication.
 *
 * This module provides utilities for building extraction request messages,
 * validating protocol message format, handling request timeouts, and
 * managing unexpected sidecar termination.
 *
 * Messages follow the JSON-newline protocol: each message is a single valid
 * JSON object terminated by a newline character (\n), not exceeding 1 MB.
 */

/** Maximum message size in bytes (1 MB) */
export const MAX_MESSAGE_SIZE = 1_048_576;

/** Default timeout for sidecar responses in milliseconds (30s) */
export const DEFAULT_TIMEOUT_MS = 30_000;

// --- Pending request tracking ---

/** @type {Map<string, {resolve: Function, reject: Function, timer: number|null}>} */
const pendingRequests = new Map();

/** Whether the sidecar is currently available */
let sidecarAlive = true;

// --- Public API ---

/**
 * Generates a UUID v4 string using crypto.randomUUID() when available,
 * falling back to a manual implementation.
 * @returns {string} A valid UUID v4 string
 */
export function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Builds an extraction request message object.
 * @param {object} params
 * @param {string} params.pdfPath - Absolute path to the PDF file
 * @param {number} params.page - 1-based page number to extract
 * @param {string} params.cacheDir - Absolute path to the cache directory for this PDF
 * @param {string} [params.requestId] - Optional pre-generated request ID (UUID v4)
 * @returns {object} The request message object
 */
export function buildExtractionRequest({ pdfPath, page, cacheDir, requestId }) {
  return {
    cmd: 'extract',
    request_id: requestId || generateRequestId(),
    pdf_path: pdfPath,
    page,
    cache_dir: cacheDir,
  };
}

/**
 * Serializes a request message to the wire format (JSON + newline).
 * @param {object} message - The message object to serialize
 * @returns {string} JSON string terminated by a newline character
 */
export function serializeMessage(message) {
  return JSON.stringify(message) + '\n';
}

/**
 * Validates that a serialized message conforms to the protocol requirements:
 * - Valid JSON terminated by a single newline
 * - Under 1 MB in size
 * - Contains a valid UUID v4 request_id
 * - Contains all required command fields (cmd, pdf_path, page, cache_dir)
 *
 * @param {string} serialized - The serialized message string
 * @returns {{valid: boolean, error?: string}}
 */
export function validateMessage(serialized) {
  if (typeof serialized !== 'string') {
    return { valid: false, error: 'Message must be a string' };
  }

  // Check newline termination
  if (!serialized.endsWith('\n')) {
    return { valid: false, error: 'Message must be terminated by a newline character' };
  }

  // Check size (use TextEncoder for accurate byte length)
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > MAX_MESSAGE_SIZE) {
    return { valid: false, error: `Message exceeds maximum size of 1 MB (got ${byteLength} bytes)` };
  }

  // Parse JSON (strip trailing newline)
  const jsonStr = serialized.slice(0, -1);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e.message}` };
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'Message must be a JSON object' };
  }

  // Validate required fields
  if (typeof parsed.cmd !== 'string' || parsed.cmd.length === 0) {
    return { valid: false, error: 'Missing or invalid required field: cmd' };
  }

  if (typeof parsed.request_id !== 'string' || !isValidUuidV4(parsed.request_id)) {
    return { valid: false, error: 'Missing or invalid required field: request_id (must be a valid UUID v4)' };
  }

  if (typeof parsed.pdf_path !== 'string' || parsed.pdf_path.length === 0) {
    return { valid: false, error: 'Missing or invalid required field: pdf_path' };
  }

  if (!Number.isInteger(parsed.page) || parsed.page < 1) {
    return { valid: false, error: 'Missing or invalid required field: page (must be a positive integer)' };
  }

  if (typeof parsed.cache_dir !== 'string' || parsed.cache_dir.length === 0) {
    return { valid: false, error: 'Missing or invalid required field: cache_dir' };
  }

  return { valid: true };
}

/**
 * Validates whether a string is a valid UUID v4.
 * UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where y is one of [8, 9, a, b].
 *
 * @param {string} str - The string to validate
 * @returns {boolean}
 */
export function isValidUuidV4(str) {
  if (typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Sends an extraction request and returns a promise that resolves with the
 * sidecar response or rejects on timeout/termination.
 *
 * @param {object} params
 * @param {string} params.pdfPath - Absolute path to the PDF file
 * @param {number} params.page - 1-based page number
 * @param {string} params.cacheDir - Cache directory path
 * @param {Function} params.sendFn - Function that sends the serialized message to the sidecar
 * @param {number} [params.timeoutMs=30000] - Timeout in milliseconds
 * @param {Function} [params.onTimeout] - Callback when timeout occurs (for UI notification)
 * @returns {Promise<object>} Resolves with the parsed response object
 */
export function sendExtractionRequest({ pdfPath, page, cacheDir, sendFn, timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout }) {
  if (!sidecarAlive) {
    return Promise.reject(new Error('Sidecar is not available. Please restart the extraction service.'));
  }

  const message = buildExtractionRequest({ pdfPath, page, cacheDir });
  const serialized = serializeMessage(message);

  // Validate before sending
  const validation = validateMessage(serialized);
  if (!validation.valid) {
    return Promise.reject(new Error(`Invalid message: ${validation.error}`));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(message.request_id);
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms for page ${page}`);
      timeoutError.code = 'TIMEOUT';
      timeoutError.requestId = message.request_id;
      timeoutError.page = page;

      if (typeof onTimeout === 'function') {
        onTimeout({ requestId: message.request_id, page });
      }

      reject(timeoutError);
    }, timeoutMs);

    pendingRequests.set(message.request_id, { resolve, reject, timer });

    try {
      sendFn(serialized);
    } catch (e) {
      clearTimeout(timer);
      pendingRequests.delete(message.request_id);
      reject(new Error(`Failed to send message: ${e.message}`));
    }
  });
}

/**
 * Handles a response received from the sidecar. Resolves the corresponding
 * pending request if the request_id matches.
 *
 * @param {string} rawResponse - Raw JSON string from sidecar stdout
 * @returns {{handled: boolean, error?: string}}
 */
export function handleSidecarResponse(rawResponse) {
  let parsed;
  try {
    // Strip trailing newline if present
    const trimmed = rawResponse.endsWith('\n') ? rawResponse.slice(0, -1) : rawResponse;
    parsed = JSON.parse(trimmed);
  } catch (e) {
    console.warn('[protocol-messages] Invalid JSON from sidecar:', rawResponse);
    return { handled: false, error: `Invalid JSON: ${e.message}` };
  }

  if (!parsed || typeof parsed.request_id !== 'string') {
    console.warn('[protocol-messages] Missing request_id in sidecar response:', rawResponse);
    return { handled: false, error: 'Missing request_id in response' };
  }

  const pending = pendingRequests.get(parsed.request_id);
  if (!pending) {
    // Response for an unknown or already-timed-out request
    return { handled: false, error: `No pending request for request_id: ${parsed.request_id}` };
  }

  // Clear timeout and remove from pending
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
  }
  pendingRequests.delete(parsed.request_id);

  if (parsed.status === 'error') {
    pending.reject(new Error(parsed.error || 'Unknown sidecar error'));
  } else {
    pending.resolve(parsed);
  }

  return { handled: true };
}

/**
 * Handles unexpected sidecar termination. Cancels all pending requests
 * and marks the sidecar as unavailable.
 *
 * @param {object} [options]
 * @param {Function} [options.onError] - Callback for UI error notification
 * @returns {{cancelledCount: number}}
 */
export function handleSidecarTermination({ onError } = {}) {
  sidecarAlive = false;
  const cancelledCount = pendingRequests.size;

  for (const [requestId, { resolve, reject, timer }] of pendingRequests) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    reject(new Error('Sidecar terminated unexpectedly'));
  }
  pendingRequests.clear();

  if (typeof onError === 'function') {
    onError({
      message: 'Extraction service terminated unexpectedly',
      cancelledCount,
    });
  }

  return { cancelledCount };
}

/**
 * Resets the sidecar availability state (call after successful restart).
 */
export function resetSidecarState() {
  sidecarAlive = true;
}

/**
 * Returns whether the sidecar is currently marked as alive.
 * @returns {boolean}
 */
export function isSidecarAlive() {
  return sidecarAlive;
}

/**
 * Returns the number of currently pending requests.
 * @returns {number}
 */
export function getPendingRequestCount() {
  return pendingRequests.size;
}

/**
 * Clears all pending requests without rejecting them (for testing/cleanup).
 * Clears associated timers.
 */
export function clearPendingRequests() {
  for (const [, { timer }] of pendingRequests) {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
  pendingRequests.clear();
}
