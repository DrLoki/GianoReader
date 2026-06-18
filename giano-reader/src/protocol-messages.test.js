import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildExtractionRequest,
  serializeMessage,
  validateMessage,
  isValidUuidV4,
  generateRequestId,
  sendExtractionRequest,
  handleSidecarResponse,
  handleSidecarTermination,
  resetSidecarState,
  isSidecarAlive,
  getPendingRequestCount,
  clearPendingRequests,
  MAX_MESSAGE_SIZE,
  DEFAULT_TIMEOUT_MS,
} from './protocol-messages.js';

describe('protocol-messages', () => {
  beforeEach(() => {
    resetSidecarState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearPendingRequests();
    resetSidecarState();
    vi.useRealTimers();
  });

  describe('generateRequestId', () => {
    it('returns a valid UUID v4 string', () => {
      const id = generateRequestId();
      expect(isValidUuidV4(id)).toBe(true);
    });

    it('generates unique IDs on successive calls', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('isValidUuidV4', () => {
    it('accepts valid UUID v4 strings', () => {
      expect(isValidUuidV4('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUuidV4('6ba7b810-9dad-41d0-80b4-00c04fd430c8')).toBe(true);
    });

    it('rejects non-v4 UUIDs', () => {
      // Version 1 UUID (has 1 in version position)
      expect(isValidUuidV4('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
    });

    it('rejects invalid strings', () => {
      expect(isValidUuidV4('')).toBe(false);
      expect(isValidUuidV4('not-a-uuid')).toBe(false);
      expect(isValidUuidV4(null)).toBe(false);
      expect(isValidUuidV4(123)).toBe(false);
    });

    it('rejects UUIDs with invalid variant bits', () => {
      // Variant must be 8, 9, a, or b in position 19
      expect(isValidUuidV4('550e8400-e29b-41d4-0716-446655440000')).toBe(false);
      expect(isValidUuidV4('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
    });
  });

  describe('buildExtractionRequest', () => {
    it('builds a message with all required fields', () => {
      const msg = buildExtractionRequest({
        pdfPath: '/path/to/file.pdf',
        page: 3,
        cacheDir: '/cache/abc123',
      });

      expect(msg.cmd).toBe('extract');
      expect(msg.pdf_path).toBe('/path/to/file.pdf');
      expect(msg.page).toBe(3);
      expect(msg.cache_dir).toBe('/cache/abc123');
      expect(isValidUuidV4(msg.request_id)).toBe(true);
    });

    it('uses provided requestId when given', () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const msg = buildExtractionRequest({
        pdfPath: '/file.pdf',
        page: 1,
        cacheDir: '/cache',
        requestId: id,
      });

      expect(msg.request_id).toBe(id);
    });
  });

  describe('serializeMessage', () => {
    it('produces JSON terminated by newline', () => {
      const msg = { cmd: 'extract', request_id: 'test', pdf_path: '/f.pdf', page: 1, cache_dir: '/c' };
      const serialized = serializeMessage(msg);

      expect(serialized.endsWith('\n')).toBe(true);
      expect(JSON.parse(serialized.slice(0, -1))).toEqual(msg);
    });

    it('produces valid JSON', () => {
      const msg = buildExtractionRequest({ pdfPath: '/test.pdf', page: 1, cacheDir: '/cache' });
      const serialized = serializeMessage(msg);
      expect(() => JSON.parse(serialized.slice(0, -1))).not.toThrow();
    });
  });

  describe('validateMessage', () => {
    it('accepts a valid extraction request message', () => {
      const msg = buildExtractionRequest({ pdfPath: '/test.pdf', page: 1, cacheDir: '/cache/hash' });
      const serialized = serializeMessage(msg);
      expect(validateMessage(serialized)).toEqual({ valid: true });
    });

    it('rejects non-string input', () => {
      expect(validateMessage(null).valid).toBe(false);
      expect(validateMessage(123).valid).toBe(false);
    });

    it('rejects messages without newline termination', () => {
      const result = validateMessage('{"cmd":"extract"}');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('newline');
    });

    it('rejects messages exceeding 1 MB', () => {
      const bigPath = 'x'.repeat(MAX_MESSAGE_SIZE);
      const msg = buildExtractionRequest({ pdfPath: bigPath, page: 1, cacheDir: '/c' });
      const serialized = serializeMessage(msg);
      const result = validateMessage(serialized);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('1 MB');
    });

    it('rejects invalid JSON', () => {
      const result = validateMessage('{invalid json\n');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('rejects messages missing cmd', () => {
      const serialized = JSON.stringify({
        request_id: '550e8400-e29b-41d4-a716-446655440000',
        pdf_path: '/f.pdf',
        page: 1,
        cache_dir: '/c',
      }) + '\n';
      const result = validateMessage(serialized);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cmd');
    });

    it('rejects messages with invalid request_id', () => {
      const serialized = JSON.stringify({
        cmd: 'extract',
        request_id: 'not-a-uuid',
        pdf_path: '/f.pdf',
        page: 1,
        cache_dir: '/c',
      }) + '\n';
      const result = validateMessage(serialized);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('request_id');
    });

    it('rejects messages missing pdf_path', () => {
      const serialized = JSON.stringify({
        cmd: 'extract',
        request_id: '550e8400-e29b-41d4-a716-446655440000',
        page: 1,
        cache_dir: '/c',
      }) + '\n';
      const result = validateMessage(serialized);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('pdf_path');
    });

    it('rejects messages with invalid page number', () => {
      const serialized = JSON.stringify({
        cmd: 'extract',
        request_id: '550e8400-e29b-41d4-a716-446655440000',
        pdf_path: '/f.pdf',
        page: 0,
        cache_dir: '/c',
      }) + '\n';
      const result = validateMessage(serialized);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('page');
    });

    it('rejects messages missing cache_dir', () => {
      const serialized = JSON.stringify({
        cmd: 'extract',
        request_id: '550e8400-e29b-41d4-a716-446655440000',
        pdf_path: '/f.pdf',
        page: 1,
      }) + '\n';
      const result = validateMessage(serialized);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cache_dir');
    });
  });

  describe('sendExtractionRequest', () => {
    it('sends a valid serialized message via sendFn', () => {
      const sendFn = vi.fn();
      sendExtractionRequest({
        pdfPath: '/test.pdf',
        page: 1,
        cacheDir: '/cache/abc',
        sendFn,
      });

      expect(sendFn).toHaveBeenCalledTimes(1);
      const sent = sendFn.mock.calls[0][0];
      expect(sent.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(sent.slice(0, -1));
      expect(parsed.cmd).toBe('extract');
      expect(parsed.page).toBe(1);
    });

    it('rejects immediately if sidecar is not alive', async () => {
      handleSidecarTermination();
      const sendFn = vi.fn();

      await expect(
        sendExtractionRequest({ pdfPath: '/f.pdf', page: 1, cacheDir: '/c', sendFn })
      ).rejects.toThrow('Sidecar is not available');

      expect(sendFn).not.toHaveBeenCalled();
    });

    it('rejects on timeout and calls onTimeout callback', async () => {
      const sendFn = vi.fn();
      const onTimeout = vi.fn();

      const promise = sendExtractionRequest({
        pdfPath: '/test.pdf',
        page: 5,
        cacheDir: '/cache',
        sendFn,
        timeoutMs: 5000,
        onTimeout,
      });

      vi.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow('timed out');
      expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ page: 5 }));
    });

    it('rejects if sendFn throws', async () => {
      const sendFn = vi.fn(() => { throw new Error('write failed'); });

      await expect(
        sendExtractionRequest({ pdfPath: '/f.pdf', page: 1, cacheDir: '/c', sendFn })
      ).rejects.toThrow('Failed to send message');
    });
  });

  describe('handleSidecarResponse', () => {
    it('resolves a pending request on success response', async () => {
      const sendFn = vi.fn();
      const promise = sendExtractionRequest({
        pdfPath: '/test.pdf',
        page: 1,
        cacheDir: '/cache',
        sendFn,
      });

      const sent = JSON.parse(sendFn.mock.calls[0][0].slice(0, -1));
      const response = JSON.stringify({
        request_id: sent.request_id,
        status: 'success',
        data: { page_number: 1 },
      }) + '\n';

      const result = handleSidecarResponse(response);
      expect(result.handled).toBe(true);

      const resolved = await promise;
      expect(resolved.status).toBe('success');
      expect(resolved.data.page_number).toBe(1);
    });

    it('rejects a pending request on error response', async () => {
      const sendFn = vi.fn();
      const promise = sendExtractionRequest({
        pdfPath: '/test.pdf',
        page: 1,
        cacheDir: '/cache',
        sendFn,
      });

      const sent = JSON.parse(sendFn.mock.calls[0][0].slice(0, -1));
      const response = JSON.stringify({
        request_id: sent.request_id,
        status: 'error',
        error: 'Page corrupted',
      }) + '\n';

      handleSidecarResponse(response);
      await expect(promise).rejects.toThrow('Page corrupted');
    });

    it('returns handled: false for invalid JSON', () => {
      const result = handleSidecarResponse('not json\n');
      expect(result.handled).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('returns handled: false for missing request_id', () => {
      const result = handleSidecarResponse(JSON.stringify({ status: 'success' }) + '\n');
      expect(result.handled).toBe(false);
      expect(result.error).toContain('Missing request_id');
    });

    it('returns handled: false for unknown request_id', () => {
      const result = handleSidecarResponse(
        JSON.stringify({ request_id: '550e8400-e29b-41d4-a716-446655440000', status: 'success' }) + '\n'
      );
      expect(result.handled).toBe(false);
      expect(result.error).toContain('No pending request');
    });
  });

  describe('handleSidecarTermination', () => {
    it('cancels all pending requests', async () => {
      const sendFn = vi.fn();
      const p1 = sendExtractionRequest({ pdfPath: '/a.pdf', page: 1, cacheDir: '/c', sendFn })
        .catch((e) => e);
      const p2 = sendExtractionRequest({ pdfPath: '/b.pdf', page: 2, cacheDir: '/c', sendFn })
        .catch((e) => e);

      expect(getPendingRequestCount()).toBe(2);

      const result = handleSidecarTermination();
      expect(result.cancelledCount).toBe(2);
      expect(getPendingRequestCount()).toBe(0);

      const err1 = await p1;
      const err2 = await p2;
      expect(err1.message).toContain('terminated unexpectedly');
      expect(err2.message).toContain('terminated unexpectedly');
    });

    it('marks sidecar as not alive', () => {
      expect(isSidecarAlive()).toBe(true);
      handleSidecarTermination();
      expect(isSidecarAlive()).toBe(false);
    });

    it('calls onError callback with details', async () => {
      const sendFn = vi.fn();
      const promise = sendExtractionRequest({ pdfPath: '/a.pdf', page: 1, cacheDir: '/c', sendFn })
        .catch((e) => e);

      const onError = vi.fn();
      handleSidecarTermination({ onError });

      expect(onError).toHaveBeenCalledWith({
        message: 'Extraction service terminated unexpectedly',
        cancelledCount: 1,
      });

      const err = await promise;
      expect(err.message).toContain('terminated unexpectedly');
    });
  });

  describe('resetSidecarState', () => {
    it('restores sidecar availability after termination', () => {
      handleSidecarTermination();
      expect(isSidecarAlive()).toBe(false);
      resetSidecarState();
      expect(isSidecarAlive()).toBe(true);
    });
  });
});
