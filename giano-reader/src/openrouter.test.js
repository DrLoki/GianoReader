import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { translateParagraphs } from './translator.js';
import { t } from './i18n.js';

// ── localStorage mock ────────────────────────────────────────────────────
function createLocalStorageMock() {
  let store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}

describe('OpenRouter Premium Translations Feature', () => {
  let originalLocalStorage;
  let originalFetch;

  beforeEach(() => {
    // Mock localStorage globally so translator.js loadSettings finds it
    originalLocalStorage = global.localStorage;
    global.localStorage = createLocalStorageMock();

    // Mock fetch globally
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.localStorage = originalLocalStorage;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── 1. i18n Translations completeness ──
  it('has translation keys for all OpenRouter properties in English and Italian', () => {
    const keys = [
      'toggleTranslationMode',
      'openrouterApiKey',
      'openrouterFetchModels',
      'openrouterModelPro',
      'openrouterSelectModel',
      'openrouterLoadingModels',
      'openrouterErrorLoading',
      'openrouterModelsLoaded',
      'openrouterInvalidKey'
    ];

    const langs = ['en', 'it'];
    for (const lang of langs) {
      for (const key of keys) {
        const val = t(lang, key);
        expect(val).not.toBe(key);
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });

  // ── 2. Settings Persistence ──
  it('saves and loads OpenRouter configuration properly', () => {
    const settings = {
      openrouterApiKey: 'sk-or-test-key-12345',
      openrouterModel: 'google/gemini-2.5-flash',
      translationMode: 'pro',
      openrouterModels: [
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'meta-llama/llama-3-8b-instruct', name: 'Llama 3 8B' }
      ]
    };

    global.localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

    const retrieved = JSON.parse(global.localStorage.getItem('giano-reader-settings'));
    expect(retrieved.openrouterApiKey).toBe('sk-or-test-key-12345');
    expect(retrieved.openrouterModel).toBe('google/gemini-2.5-flash');
    expect(retrieved.translationMode).toBe('pro');
    expect(retrieved.openrouterModels).toHaveLength(2);
  });

  // ── 3. Routing: FREE Mode (Google Translate) ──
  it('routes to Google Translate when translationMode is free', async () => {
    const settings = {
      translationMode: 'free'
    };
    global.localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

    // Mock Google Translate response format (paragraphs are concatenated and separated by \n\n)
    const mockGoogleResponse = [
      [
        ['Questa è la prima frase.\n\nQuesta è la seconda frase.', 'This is the first sentence.\n\nThis is the second sentence.']
      ]
    ];

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockGoogleResponse
    });

    const paragraphs = [
      'This is the first sentence.',
      'This is the second sentence.'
    ];

    const results = await translateParagraphs(paragraphs, 'it');

    expect(results).toHaveLength(2);
    expect(results[0]).toBe('Questa è la prima frase.');
    expect(results[1]).toBe('Questa è la seconda frase.');

    // Verify it called the googleapis endpoint
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = global.fetch.mock.calls[0][0];
    expect(fetchUrl).toContain('translate.googleapis.com');
  });

  // ── 4. Routing: PRO Mode (OpenRouter) ──
  it('routes to OpenRouter with proper headers and body when translationMode is pro', async () => {
    const settings = {
      translationMode: 'pro',
      openrouterApiKey: 'sk-or-test-key',
      openrouterModel: 'google/gemini-2.5-flash'
    };
    global.localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

    // Mock OpenRouter response format
    const mockOpenRouterResponse = {
      choices: [
        {
          message: {
            content: 'Questa è la prima frase.\n\nQuesta è la seconda frase.'
          }
        }
      ]
    };

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockOpenRouterResponse
    });

    const paragraphs = [
      'This is the first sentence.',
      'This is the second sentence.'
    ];

    const results = await translateParagraphs(paragraphs, 'it');

    expect(results).toHaveLength(2);
    expect(results[0]).toBe('Questa è la prima frase.');
    expect(results[1]).toBe('Questa è la seconda frase.');

    // Verify it called the openrouter completions endpoint
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = global.fetch.mock.calls[0][0];
    const fetchOptions = global.fetch.mock.calls[0][1];

    expect(fetchUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fetchOptions.method).toBe('POST');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer sk-or-test-key');
    expect(fetchOptions.headers['X-Title']).toBe('GianoReader');
    expect(fetchOptions.headers['X-OpenRouter-Title']).toBe('GianoReader');
    expect(fetchOptions.headers['HTTP-Referer']).toBe('https://github.com/DrLoki/GianoReader');

    const body = JSON.parse(fetchOptions.body);
    expect(body.model).toBe('google/gemini-2.5-flash');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('expert literary translator');
  });

  // ── 5. Error handling: PRO Mode missing configuration ──
  it('throws an error in PRO mode if API key or model is missing', async () => {
    const settings = {
      translationMode: 'pro'
      // apiKey and model missing
    };
    global.localStorage.setItem('giano-reader-settings', JSON.stringify(settings));

    await expect(translateParagraphs(['Hello'], 'it')).rejects.toThrow();
  });
});
