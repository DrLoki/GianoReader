/**
 * translator.js
 *
 * Translation through Google Translate's unofficial public endpoint.
 * Requires no API key; suitable for personal use only.
 * For commercial or high-volume use, use the official Google Cloud Translation API.
 */

import { FREE_BYTE_LIMIT, utf8Length, splitByByteLimit } from './text-limits.js';
import { segmentMarker, buildNumberedBatch, parseNumberedBatch, stripSegmentMarkers } from './pro-segments.js';
import { recordBasicUsage, billedChars } from './basic-usage.js';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('giano-reader-settings') || '{}');
  } catch {
    return {};
  }
}

/** Character limit per single request (~5000 is Google's maximum). */
const CHAR_LIMIT = 4500;

/**
 * Internal language codes that Google encodes differently.
 * For Google "pt" is Brazilian Portuguese: our "pt" (Portuguese
 * flag) must be sent as "pt-PT", our "pt-BR" as "pt".
 * Keep in sync with `google_lang_code` in src-tauri translator.rs.
 */
const GOOGLE_LANG_CODES = { pt: 'pt-PT', 'pt-BR': 'pt' };

/** Converts an internal language code into the code expected by Google Translate. */
export function toGoogleLangCode(lang) {
  return GOOGLE_LANG_CODES[lang] ?? lang;
}

/** Language code to pass to the LLMs (PRO): makes the European variant explicit. */
function toLlmLangCode(lang) {
  return lang === 'pt' ? 'pt-PT' : lang;
}

/**
 * Translates a single block of text through OpenRouter (PRO).
 */
async function translateChunkPro(text, targetLang, apiKey, model, signal) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  console.log(`[GianoReader PRO] Starting translation request...`);
  console.log(`[GianoReader PRO] Target Language: ${targetLang}`);
  console.log(`[GianoReader PRO] Model: ${model}`);
  console.log(`[GianoReader PRO] Text Length: ${text.length} chars`);

  const startTime = performance.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/DrLoki/GianoReader',
      'X-Title': 'GianoReader',
      'X-OpenRouter-Title': 'GianoReader'
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'system',
          content: `You are an expert literary translator. Translate the text into the language code: "${toLlmLangCode(targetLang)}".
Each paragraph starts with a numbered marker such as ${segmentMarker(1)}, ${segmentMarker(2)}, ${segmentMarker(3)}. Paragraphs are separated by double newlines (\\n\\n).
CRITICAL: Start every translated paragraph with its own marker, copied exactly, with the same number. Never merge, split, add, drop or reorder paragraphs: the answer must contain exactly the same markers as the input. Copy unchanged any other token between the same brackets (for example ⟦IMG0⟧).
Return ONLY the translated text. Do not include any introductory or concluding text, explanations, or conversational filler.`
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.3
    }),
    signal
  });

  const duration = (performance.now() - startTime) / 1000;
  console.log(`[GianoReader PRO] HTTP response received in ${duration.toFixed(2)}s with status ${res.status}`);

  if (!res.ok) {
    const errText = await res.text();
    let message = `OpenRouter API error (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error?.message) {
        message += `: ${parsed.error.message}`;
      }
    } catch {
      if (errText) message += `: ${errText.substring(0, 100)}`;
    }
    throw new Error(message);
  }

  const data = await res.json();

  // Log token usage if present
  if (data.usage) {
    console.log(`[GianoReader PRO] Token Usage - Prompt: ${data.usage.prompt_tokens}, Completion: ${data.usage.completion_tokens}, Total: ${data.usage.total_tokens}`);
  }

  const choice = data.choices?.[0];
  if (!choice || !choice.message?.content) {
    throw new Error('Invalid response format from OpenRouter');
  }

  const result = choice.message.content.trim();
  console.log(`[GianoReader PRO] Chunk translation complete! Translated text size: ${result.length} chars`);

  return result;
}

/**
 * Translates a single block of text into the target language.
 *
 * In a Tauri environment (desktop) the request is delegated to the Rust command
 * `translate_free`, which uses `reqwest` on the backend: this prevents the
 * request from being subject to the webview's CORS policies, which can make
 * a rate-limit error (HTTP 429) from Google Translate appear as
 * "blocked by CORS" — Google's error response does not include the
 * Access-Control-Allow-Origin header, so the browser/webview reports it as
 * a CORS violation even though the real problem is rate limiting.
 * In a browser/PWA (no Tauri runtime) a direct `fetch()` is used as before.
 *
 * @param {string} text       - Text to translate (already split into chunks).
 * @param {string} targetLang - BCP-47 language code (e.g. "it", "en", "fr").
 * @returns {Promise<string>} Translated text.
 */
async function translateChunk(text, targetLang) {
  console.log(`[GianoReader FREE] Starting translation request...`);
  console.log(`[GianoReader FREE] Target Language: ${targetLang}`);
  console.log(`[GianoReader FREE] Text Length: ${text.length} chars`);

  const startTime = performance.now();
  const isTauri = typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__);

  let result;
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      result = await invoke('translate_free', {
        text,
        sourceLang: 'auto',
        targetLang,
      });
    } catch (err) {
      throw new Error(`Translation error: ${err?.message || err}`);
    }
  } else {
    // A text over the limit (a single very long paragraph) is split:
    // the endpoint rejects URLs that are too long (see text-limits.js). In Tauri
    // the same splitting happens in the Rust command.
    const translatedPieces = [];
    for (const piece of splitByByteLimit(text)) {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${toGoogleLangCode(targetLang)}&dt=t&q=${encodeURIComponent(piece)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Translation error: ${res.status}`);
      const data = await res.json();
      translatedPieces.push(data[0].map(seg => seg[0]).join(''));
    }
    result = translatedPieces.map(p => p.trim()).join(' ');
  }

  const duration = (performance.now() - startTime) / 1000;
  console.log(`[GianoReader FREE] Chunk translation complete in ${duration.toFixed(2)}s! Translated text size: ${result.length} chars`);
  return result;
}

/** Character limit per batch in Basic mode (Cloud Translation v2). */
const CHAR_LIMIT_BASIC = 25000;

/** Maximum number of strings per single v2 request. */
const MAX_SEGMENTS_BASIC = 128;

/**
 * Translates an array of paragraphs through the Google Cloud Translation API v2 (BASIC).
 * Uses the API's native `q[]` array — no join with \n\n needed.
 * Max 128 strings per request.
 *
 * @param {string[]} paragraphs  - Array of texts to translate (one element per paragraph, max 128).
 * @param {string}   targetLang  - Target BCP-47 language code.
 * @param {string}   apiKey      - Google Cloud API Key.
 * @param {AbortSignal} [signal] - Abort signal.
 * @returns {Promise<string[]>}  Array of translated texts (same length as the input).
 */
async function translateChunkBasic(paragraphs, targetLang, apiKey, signal) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

  console.log(`[GianoReader BASIC] Starting translation request...`);
  console.log(`[GianoReader BASIC] Target Language: ${targetLang}`);
  console.log(`[GianoReader BASIC] Paragraphs: ${paragraphs.length}, Total chars: ${paragraphs.reduce((a, p) => a + p.length, 0)}`);

  const body = {
    q: paragraphs,
    target: toGoogleLangCode(targetLang),
    format: 'text'
  };

  const startTime = performance.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  const duration = (performance.now() - startTime) / 1000;
  console.log(`[GianoReader BASIC] HTTP response received in ${duration.toFixed(2)}s with status ${res.status}`);

  if (!res.ok) {
    const errText = await res.text();
    let message = `Google Cloud Translation error (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error?.message) {
        message += `: ${parsed.error.message}`;
      }
    } catch {
      if (errText) message += `: ${errText.substring(0, 200)}`;
    }
    if (res.status === 403) message = `Invalid Google Cloud API Key: ${message}`;
    if (res.status === 429) message = `Google Cloud Translation quota exceeded: ${message}`;
    throw new Error(message);
  }

  // Google bills the request once accepted: count it toward the monthly usage
  recordBasicUsage(billedChars(paragraphs)).catch(() => {});

  const data = await res.json();
  const translations = (data.data && data.data.translations) || [];

  if (translations.length !== paragraphs.length) {
    console.warn(`[GianoReader BASIC] Response count mismatch: expected ${paragraphs.length}, got ${translations.length}`);
  }

  const result = translations.map(t => (t.translatedText || '').trim());
  console.log(`[GianoReader BASIC] Chunk translation complete! ${result.length} paragraphs translated`);
  return result;
}

/**
 * Translates an array of paragraphs grouping them into batches of ~CHAR_LIMIT characters.
 * The paragraphs are separated by `\n\n` inside each batch and the result
 * is re-split to realign the translations with the original paragraphs.
 *
 * @param {string[]} paragraphs - Array of texts to translate.
 * @param {string}   targetLang - Target language code.
 * @param {AbortSignal} [signal] - Abort signal to interrupt the translation.
 * @returns {Promise<string[]>} Array of translated texts (same length as the input).
 */
export async function translateParagraphs(paragraphs, targetLang, signal) {
  const results = new Array(paragraphs.length).fill('');
  const settings = loadSettings();
  const isPro = settings.translationMode === 'pro';
  const isBasic = settings.translationMode === 'basic';
  const apiKey = settings.openrouterApiKey;
  const model = settings.openrouterModel;

  if (isPro) {
    if (!apiKey) throw new Error('OpenRouter API Key not configured');
    if (!model) throw new Error('OpenRouter Model not selected');
  }

  if (isBasic) {
    const gcloudApiKey = (settings.gcloudApiKey || '').trim();
    if (!gcloudApiKey) throw new Error('Google Cloud API Key not configured');

    // Basic mode: batch by total char length (~25000) AND max 128 segments per request
    const batches = [];
    let batchStart = 0;
    let batchLen = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paraLen = paragraphs[i].length;
      const batchCount = i - batchStart;
      if (batchLen > 0 && ((batchLen + paraLen) > CHAR_LIMIT_BASIC || batchCount >= MAX_SEGMENTS_BASIC)) {
        batches.push({ start: batchStart, end: i });
        batchStart = i;
        batchLen = paraLen;
      } else {
        batchLen += paraLen;
      }
    }
    if (batchStart < paragraphs.length) {
      batches.push({ start: batchStart, end: paragraphs.length });
    }

    for (const batch of batches) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const slice = paragraphs.slice(batch.start, batch.end);
      const translated = await translateChunkBasic(slice, targetLang, gcloudApiKey, signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      for (let j = 0; j < translated.length; j++) {
        results[batch.start + j] = translated[j];
      }
    }

    return results;
  }

  // FREE / PRO mode: batch by joined text length (separated by \n\n).
  // PRO counts characters; FREE counts UTF-8 bytes, because the text travels
  // in the URL and with non-Latin alphabets 4500 characters exceed the limit
  // of the endpoint (see text-limits.js).
  const batches = [];
  let batchStart = 0;
  let batchText = '';
  const fits = isPro
    ? (text) => text.length <= CHAR_LIMIT
    : (text) => utf8Length(text) <= FREE_BYTE_LIMIT;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const separator = batchText ? '\n\n' : '';
    if (batchText && !fits(batchText + separator + para)) {
      batches.push({ start: batchStart, end: i, text: batchText });
      batchStart = i;
      batchText = para;
    } else {
      batchText = batchText + separator + para;
    }
  }
  if (batchText) batches.push({ start: batchStart, end: paragraphs.length, text: batchText });

  // PRO: each paragraph travels with a numbered marker (see pro-segments.js),
  // so the response is realigned by number even if the model merges or
  // splits lines, without having to re-translate the paragraphs one by one.
  const translateOnePro = async (text) => {
    const raw = await translateChunkPro(buildNumberedBatch([text]), targetLang, apiKey, model, signal);
    const parsed = parseNumberedBatch(raw, 1);
    return parsed ? parsed[0] : stripSegmentMarkers(raw);
  };

  for (const batch of batches) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (isPro) {
      const count = batch.end - batch.start;
      const slice = paragraphs.slice(batch.start, batch.end);
      const raw = await translateChunkPro(buildNumberedBatch(slice), targetLang, apiKey, model, signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      let parts = parseNumberedBatch(raw, count);
      if (!parts) {
        // Markers not respected: try with blank lines, as in the past
        const byBlankLine = stripSegmentMarkers(raw).split(/\n\n+/).map(p => p.trim()).filter(Boolean);
        if (byBlankLine.length === count) parts = byBlankLine;
      }
      if (parts) {
        for (let j = 0; j < count; j++) results[batch.start + j] = parts[j];
      } else {
        // Last resort: one paragraph per request
        for (let j = 0; j < count; j++) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          results[batch.start + j] = (await translateOnePro(slice[j])).trim();
        }
      }
      continue;
    }

    const translated = await translateChunk(batch.text, targetLang);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Re-split by double newline to realign with the original paragraphs
    const parts = translated.split(/\n\n+/);
    const count = batch.end - batch.start;

    if (parts.length === count) {
      for (let j = 0; j < count; j++) {
        results[batch.start + j] = (parts[j] || '').trim();
      }
    } else {
      // The translation engine did not preserve the \n\n separators exactly
      // (it often happens with short sentences/dialogues, e.g. "-i miss you"),
      // so we cannot trust the split: we re-translate each paragraph
      // of the batch individually so as not to lose/misalign the text.
      for (let j = 0; j < count; j++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const idx = batch.start + j;
        const single = await translateChunk(paragraphs[idx], targetLang);
        results[idx] = single.trim();
      }
    }
  }

  return results;
}
