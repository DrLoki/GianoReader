/**
 * Traduzione lazy per chunk guidata dalla visibilità.
 *
 * Osserva TUTTI gli elementi dei chunk non ancora tradotti (non una sola
 * "sentinella" alla volta): con uno scroll veloce la sentinella può essere
 * saltata in un solo frame, l'IntersectionObserver non scatta mai e i chunk
 * successivi restano come placeholder anche se sono già in cache.
 *
 * I chunk visibili vengono messi in coda e tradotti uno alla volta (niente
 * raffiche di richieste, HTTP 429); il chunk visto per ultimo ha la precedenza,
 * così la parte che l'utente sta leggendo arriva per prima.
 */

/**
 * Coda di chunk da tradurre in sequenza, ultimo arrivato per primo.
 * Pura (senza DOM), testabile.
 * @param {(chunkIdx: number) => Promise<void>} translateChunk
 * @param {{ aborted: boolean }} [signal]
 */
export function createChunkQueue(translateChunk, signal) {
  const pending = [];          // chunk in attesa (l'ultimo è il prossimo)
  const queued = new Set();    // chunk in coda o già avviati
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length && !(signal && signal.aborted)) {
        const chunkIdx = pending.pop();
        try { await translateChunk(chunkIdx); } catch (_) { /* gestito da translateChunk */ }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** Accoda un chunk (ignorato se già accodato o avviato). */
    push(chunkIdx) {
      if (queued.has(chunkIdx)) return;
      queued.add(chunkIdx);
      pending.push(chunkIdx);
      drain();
    },
    /** Segna un chunk come già gestito (es. tradotto altrove). */
    markDone(chunkIdx) { queued.add(chunkIdx); },
    has(chunkIdx) { return queued.has(chunkIdx); },
  };
}

/**
 * Avvia l'osservazione lazy dei chunk.
 * @param {object} opts
 * @param {Element} opts.root            contenitore scorrevole
 * @param {Array<Element|null|undefined>} opts.elements  elementi indicizzati per paragrafo
 * @param {number} opts.chunkSize        paragrafi per chunk
 * @param {(chunkIdx: number) => Promise<void>} opts.translateChunk
 * @param {(chunkIdx: number) => boolean} [opts.isDone]  chunk già tradotti da non osservare
 * @param {{ aborted: boolean }} [opts.signal]
 * @returns {IntersectionObserver|null}
 */
export function observeChunksLazily({ root, elements, chunkSize, translateChunk, isDone = () => false, signal }) {
  if (typeof IntersectionObserver === 'undefined') return null;
  const queue = createChunkQueue(translateChunk, signal);
  const byChunk = new Map(); // chunkIdx -> elementi osservati

  const observer = new IntersectionObserver((entries) => {
    if (signal && signal.aborted) { observer.disconnect(); return; }
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const chunkIdx = Number(entry.target.dataset.lazyChunk);
      const els = byChunk.get(chunkIdx);
      if (els) { els.forEach(el => observer.unobserve(el)); byChunk.delete(chunkIdx); }
      queue.push(chunkIdx);
    }
  }, { root, rootMargin: '50% 0px 50% 0px', threshold: 0 });

  elements.forEach((el, i) => {
    if (!el) return;
    const chunkIdx = Math.floor(i / chunkSize);
    if (isDone(chunkIdx)) return;
    el.dataset.lazyChunk = String(chunkIdx);
    if (!byChunk.has(chunkIdx)) byChunk.set(chunkIdx, []);
    byChunk.get(chunkIdx).push(el);
    observer.observe(el);
  });
  return observer;
}
