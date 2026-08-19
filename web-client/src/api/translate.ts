import { apiFetch } from './client';
import { isOfflineMode, getLocalPreferences } from './local-db';

const STATIC_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'it', name: 'Italiano' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'th', name: 'ไทย' },
  { code: 'fil', name: 'Filipino' },
  { code: 'sq', name: 'Shqip' },
  { code: 'sv', name: 'Svenska' },
  { code: 'uk', name: 'Українська' },
  { code: 'sl', name: 'Slovenščina' }
];

const CHAR_LIMIT = 4500;

function getWorkerUrl(): string {
  try {
    const localPrefs = getLocalPreferences();
    let subdomain = (localPrefs?.cloudflareWorkerSubdomain || '').trim();
    if (!subdomain) {
      const desktop = JSON.parse(localStorage.getItem('giano-reader-settings') || '{}');
      subdomain = (desktop.cloudflareWorkerSubdomain || '').trim();
    }
    subdomain = subdomain
      .replace(/^https?:\/\//, '')
      .replace(/^giano-translate-proxy\./, '')
      .replace(/\.workers\.dev.*$/, '')
      .trim();

    if (subdomain) {
      return `https://giano-translate-proxy.${subdomain}.workers.dev`;
    }
  } catch {
    // Ignore errors
  }
  return 'https://translate.googleapis.com/translate_a/single';
}

async function translateChunkOffline(text: string, targetLang: string): Promise<string> {
  const baseUrl = getWorkerUrl();
  // If we're falling back to translate.googleapis.com while truly offline,
  // navigator.onLine === false gives us a quick hint to fail fast with a
  // meaningful message instead of waiting for a network timeout.
  if (!navigator.onLine && baseUrl.includes('translate.googleapis.com')) {
    throw new Error('OFFLINE_NO_INTERNET');
  }
  const url = `${baseUrl}?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Translation proxy error: ${res.status}`);
  const data = await res.json();
  return data[0].map((seg: any) => seg[0]).join('');
}

async function postTranslateOffline(
  paragraphs: string[],
  targetLang: string
): Promise<string[]> {
  const results = new Array(paragraphs.length).fill('');
  const batches: { start: number; end: number; text: string }[] = [];
  let batchStart = 0;
  let batchText = '';

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const separator = batchText ? '\n\n' : '';
    if (batchText && (batchText + separator + para).length > CHAR_LIMIT) {
      batches.push({ start: batchStart, end: i, text: batchText });
      batchStart = i;
      batchText = para;
    } else {
      batchText = batchText + separator + para;
    }
  }
  if (batchText) {
    batches.push({ start: batchStart, end: paragraphs.length, text: batchText });
  }

  for (const batch of batches) {
    const translated = await translateChunkOffline(batch.text, targetLang);
    const parts = translated.split(/\n\n+/);
    const count = batch.end - batch.start;

    if (parts.length === count) {
      for (let j = 0; j < count; j++) {
        results[batch.start + j] = (parts[j] || '').trim();
      }
    } else {
      // The translation engine did not preserve the \n\n separators exactly
      // (common with short dialogue-style lines, e.g. "-i miss you"), so the
      // split can't be trusted: fall back to translating each paragraph in
      // this batch individually to avoid losing/misaligning text.
      for (let j = 0; j < count; j++) {
        const idx = batch.start + j;
        const single = await translateChunkOffline(paragraphs[idx], targetLang);
        results[idx] = single.trim();
      }
    }
  }

  return results;
}

/**
 * Sends texts to the translation endpoint.
 *
 * @param texts - Array of strings to translate
 * @param sourceLang - BCP-47 source language code
 * @param targetLang - BCP-47 target language code
 * @returns Array of translated strings in the same order as the input
 */
export async function postTranslate(
  texts: string[],
  sourceLang: string,
  targetLang: string,
): Promise<string[]> {
  if (isOfflineMode()) {
    return postTranslateOffline(texts, targetLang);
  }

  const response = await apiFetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, sourceLang, targetLang }),
  });

  const data = await response.json();
  return data.translations;
}

/**
 * Fetches the list of supported translation languages.
 *
 * @returns Array of language objects with code and display name
 */
export async function getLanguages(): Promise<{ code: string; name: string }[]> {
  if (isOfflineMode()) {
    return STATIC_LANGUAGES;
  }
  const response = await apiFetch('/api/translate/languages');
  return response.json();
}

