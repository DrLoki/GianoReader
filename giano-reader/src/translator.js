/**
 * translator.js
 *
 * Traduzione tramite l'endpoint pubblico non ufficiale di Google Translate.
 * Non richiede chiave API; adatto solo a uso personale.
 * Per uso commerciale o ad alto volume usare l'API ufficiale Google Cloud Translation.
 */

/** Limite di caratteri per singola richiesta (~5000 è il massimo di Google). */
const CHAR_LIMIT = 4500;

/**
 * Traduce un singolo blocco di testo verso la lingua target.
 * @param {string} text       - Testo da tradurre (già suddiviso in chunk).
 * @param {string} targetLang - Codice lingua BCP-47 (es. "it", "en", "fr").
 * @returns {Promise<string>} Testo tradotto.
 */
async function translateChunk(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Translation error: ${res.status}`);
  const data = await res.json();
  // data[0] è un array di segmenti [tradotto, originale, ...]; li concateniamo.
  return data[0].map(seg => seg[0]).join('');
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
    const translated = await translateChunk(batch.text, targetLang);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Risplittiamo per doppio newline per riallineare ai paragrafi originali
    const parts = translated.split(/\n\n+/);
    const count = batch.end - batch.start;
    for (let j = 0; j < count; j++) {
      results[batch.start + j] = (parts[j] || '').trim();
    }
  }

  return results;
}
