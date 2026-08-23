/**
 * translator.js
 *
 * Traduzione tramite l'endpoint pubblico non ufficiale di Google Translate.
 * Non richiede chiave API; adatto solo a uso personale.
 * Per uso commerciale o ad alto volume usare l'API ufficiale Google Cloud Translation.
 */

/** Limite di caratteri per singola richiesta (~5000 è il massimo di Google). */
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('giano-reader-settings') || '{}');
  } catch {
    return {};
  }
}

/** Limite di caratteri per singola richiesta (~5000 è il massimo di Google). */
const CHAR_LIMIT = 4500;

/**
 * Traduce un singolo blocco di testo tramite OpenRouter (PRO).
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
          content: `You are an expert literary translator. Translate the text into the language code: "${targetLang}".
Maintain the exact original paragraph structure and do not merge paragraphs. Paragraphs are separated by double newlines (\\n\\n).
CRITICAL: Return ONLY the translated text, preserving the exact paragraph count and double newlines. Do not include any introductory or concluding text, explanations, or conversational filler.`
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
 * Traduce un singolo blocco di testo verso la lingua target.
 * Chiama direttamente Google Translate (nessun proxy Worker necessario in Tauri/desktop).
 * @param {string} text       - Testo da tradurre (già suddiviso in chunk).
 * @param {string} targetLang - Codice lingua BCP-47 (es. "it", "en", "fr").
 * @returns {Promise<string>} Testo tradotto.
 */
async function translateChunk(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;

  console.log(`[GianoReader FREE] Starting translation request...`);
  console.log(`[GianoReader FREE] Target Language: ${targetLang}`);
  console.log(`[GianoReader FREE] Text Length: ${text.length} chars`);

  const startTime = performance.now();
  const res = await fetch(url);
  const duration = (performance.now() - startTime) / 1000;

  console.log(`[GianoReader FREE] HTTP response received in ${duration.toFixed(2)}s with status ${res.status}`);

  if (!res.ok) throw new Error(`Translation error: ${res.status}`);
  const data = await res.json();
  const result = data[0].map(seg => seg[0]).join('');

  console.log(`[GianoReader FREE] Chunk translation complete! Translated text size: ${result.length} chars`);
  return result;
}

/**
 * Traduce un array di paragrafi raggruppandoli in batch da ~CHAR_LIMIT caratteri.
 * I paragrafi vengono separati da `\n\n` all'interno di ogni batch e il risultato
 * viene risplittato per riallineare le traduzioni ai paragrafi originali.
 *
 * @param {string[]} paragraphs - Array di testi da tradurre.
 * @param {string}   targetLang - Codice lingua target.
 * @param {AbortSignal} [signal] - Segnale di abort per interrompere la traduzione.
 * @returns {Promise<string[]>} Array di testi tradotti (stessa lunghezza dell'input).
 */
export async function translateParagraphs(paragraphs, targetLang, signal) {
  const results = new Array(paragraphs.length).fill('');
  const settings = loadSettings();
  const isPro = settings.translationMode === 'pro';
  const apiKey = settings.openrouterApiKey;
  const model = settings.openrouterModel;

  if (isPro) {
    if (!apiKey) throw new Error('OpenRouter API Key not configured');
    if (!model) throw new Error('OpenRouter Model not selected');
  }

  // Costruisce i batch rispettando il limite di caratteri per richiesta
  const batches = [];
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
  if (batchText) batches.push({ start: batchStart, end: paragraphs.length, text: batchText });

  for (const batch of batches) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const translated = isPro
      ? await translateChunkPro(batch.text, targetLang, apiKey, model, signal)
      : await translateChunk(batch.text, targetLang);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Risplittiamo per doppio newline per riallineare ai paragrafi originali
    const parts = translated.split(/\n\n+/);
    const count = batch.end - batch.start;

    if (parts.length === count) {
      for (let j = 0; j < count; j++) {
        results[batch.start + j] = (parts[j] || '').trim();
      }
    } else {
      // Il motore di traduzione non ha preservato esattamente i separatori
      // \n\n (capita spesso con frasi brevi/dialoghi, es. "-i miss you"),
      // quindi non possiamo fidarci dello split: ritraduciamo ogni paragrafo
      // del batch singolarmente per non perdere/disallineare il testo.
      for (let j = 0; j < count; j++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const idx = batch.start + j;
        const single = isPro
          ? await translateChunkPro(paragraphs[idx], targetLang, apiKey, model, signal)
          : await translateChunk(paragraphs[idx], targetLang);
        results[idx] = single.trim();
      }
    }
  }

  return results;
}
