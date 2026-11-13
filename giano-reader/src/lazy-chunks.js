/**
 * Lazy per-chunk translation driven by visibility.
 *
 * Observes ALL the elements of the chunks not yet translated (not just one
 * "sentinel" at a time): with fast scrolling the sentinel can be
 * skipped in a single frame, the IntersectionObserver never fires and the
 * following chunks stay as placeholders even if they are already in the cache.
 *
 * Visible chunks are queued and translated one at a time (no
 * bursts of requests, HTTP 429); the chunk seen last has priority,
 * so the part the user is reading arrives first.
 */

/**
 * Queue of chunks to translate in sequence, last in first out.
 * Pure (no DOM), testable.
 * @param {(chunkIdx: number) => Promise<void>} translateChunk
 * @param {{ aborted: boolean }} [signal]
 */
export function createChunkQueue(translateChunk, signal) {
  const pending = [];          // chunks waiting (the last one is the next)
  const queued = new Set();    // chunks queued or already started
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length && !(signal && signal.aborted)) {
        const chunkIdx = pending.pop();
        try { await translateChunk(chunkIdx); } catch (_) { /* handled by translateChunk */ }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** Queues a chunk (ignored if already queued or started). */
    push(chunkIdx) {
      if (queued.has(chunkIdx)) return;
      queued.add(chunkIdx);
      pending.push(chunkIdx);
      drain();
    },
    /** Marks a chunk as already handled (e.g. translated elsewhere). */
    markDone(chunkIdx) { queued.add(chunkIdx); },
    has(chunkIdx) { return queued.has(chunkIdx); },
  };
}

/**
 * Starts the lazy observation of the chunks.
 * @param {object} opts
 * @param {Element} opts.root            contenitore scorrevole
 * @param {Array<Element|null|undefined>} opts.elements  elements indexed by paragraph
 * @param {number} opts.chunkSize        paragraphs per chunk
 * @param {(chunkIdx: number) => Promise<void>} opts.translateChunk
 * @param {(chunkIdx: number) => boolean} [opts.isDone]  already translated chunks not to observe
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
