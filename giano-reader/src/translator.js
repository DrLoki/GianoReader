/**
 * Traduce testo usando l'API gratuita di Google Translate (endpoint non ufficiale).
 * Per produzione si consiglia l'API ufficiale con chiave.
 */

const CHAR_LIMIT = 4500; // Google limita ~5000 caratteri per richiesta

async function translateChunk(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Errore traduzione: ${res.status}`);
  const data = await res.json();
  return data[0].map(seg => seg[0]).join('');
}

/**
 * Traduce un array di paragrafi, raggruppandoli in batch da ~CHAR_LIMIT caratteri.
 * Restituisce un array di paragrafi tradotti (stessa lunghezza dell'input).
 */
export async function translateParagraphs(paragraphs, targetLang, signal) {
  const results = new Array(paragraphs.length).fill('');

  // Raggruppa paragrafi in batch rispettando il limite di caratteri
  const batches = []; // [{start, end, text}]
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
    const translated = await translateChunk(batch.text, targetLang);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Risplittiamo il risultato per doppio newline per riallineare ai paragrafi originali
    const parts = translated.split(/\n\n+/);
    const count = batch.end - batch.start;
    for (let j = 0; j < count; j++) {
      results[batch.start + j] = (parts[j] || '').trim();
    }
  }

  return results;
}

// Mantieni compatibilità con il vecchio translateText
export async function translateText(text, targetLang, onProgress) {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const total = paragraphs.length;
  let done = 0;

  const results = new Array(total).fill('');
  const CHAR_LIMIT_LOCAL = CHAR_LIMIT;
  const batches = [];
  let batchStart = 0, batchText = '';

  for (let i = 0; i < total; i++) {
    const para = paragraphs[i];
    const sep = batchText ? '\n\n' : '';
    if (batchText && (batchText + sep + para).length > CHAR_LIMIT_LOCAL) {
      batches.push({ start: batchStart, end: i, text: batchText });
      batchStart = i; batchText = para;
    } else {
      batchText = batchText + sep + para;
    }
  }
  if (batchText) batches.push({ start: batchStart, end: total, text: batchText });

  for (const batch of batches) {
    const translated = await translateChunk(batch.text, targetLang);
    const parts = translated.split(/\n\n+/);
    const count = batch.end - batch.start;
    for (let j = 0; j < count; j++) results[batch.start + j] = (parts[j] || '').trim();
    done += count;
    if (onProgress) onProgress(Math.round((done / total) * 100));
  }

  return results.filter(Boolean).join('\n\n');
}
