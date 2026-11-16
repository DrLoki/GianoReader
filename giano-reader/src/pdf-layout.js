/**
 * Traduzione dei PDF "sovrapposta" al layout originale.
 *
 * Il motore di analisi (Rust, `src-tauri/src/pdf_layout/`, portato da PDF X-Ray)
 * trasforma le pagine in paragrafi logici: unità di testo traducibili anche se
 * la tipografia le ha spezzate tra colonne, pagine, figure o riquadri, che
 * sanno dove si trovano i loro pezzi sulla pagina. Qui:
 *  - `PdfLayoutAnalyzer` estrae le pagine con pdf.js e le passa al motore;
 *  - le funzioni pure scelgono i paragrafi da tradurre e lo stile dei box;
 *  - `fillSegment` scrive la traduzione dentro il box dell'originale, riducendo
 *    il corpo finché ci sta.
 */

// pdf-extract.js è caricato solo quando serve (importa pdfjs-dist, che non gira in Node)

/** Pagine analizzate oltre il bordo dell'intervallo mostrato, per ricucire i
 *  paragrafi a cavallo di pagina e riconoscere testatine/piè di pagina. */
export const ANALYSIS_MARGIN_PAGES = 2;

/** Scala minima del corpo quando la traduzione è più lunga dell'originale. */
export const MIN_FONT_SCALE = 0.45;

/** Famiglia CSS generica ricavata dal nome del font PDF. */
export function genericFamily(fontName) {
  const n = (fontName || '').toLowerCase();
  if (/mono|courier|consol|code/.test(n)) return 'ui-monospace, "JetBrains Mono", monospace';
  if (/sans|arial|helvetica|inter|roboto|verdana|segoe|gothic|grotesk|futura|myriad|frutiger|laski/.test(n)) {
    return 'Inter, Arial, sans-serif';
  }
  return 'Georgia, "Times New Roman", serif';
}

/**
 * Paragrafi da tradurre per le pagine `first..last`: quelli traducibili, con
 * testo, che hanno almeno un segmento in quell'intervallo. (Un paragrafo che
 * continua su una pagina fuori intervallo viene tradotto per intero, ma se ne
 * disegnano solo i pezzi visibili.)
 */
export function selectParagraphs(result, first, last) {
  if (!result || !Array.isArray(result.paragraphs)) return [];
  return result.paragraphs.filter(p =>
    p.translatable && p.text && p.text.trim() &&
    p.segments.some(s => s.pageNum >= first && s.pageNum <= last));
}

/**
 * Testi dei paragrafi "di" un intervallo di pagine (vista a testo): quelli che
 * iniziano in quell'intervallo, nell'ordine di lettura. Un paragrafo a cavallo
 * di due intervalli appartiene a quello in cui comincia.
 */
export function paragraphTextsForRange(result, first, last) {
  if (!result || !Array.isArray(result.paragraphs)) return [];
  return result.paragraphs
    .filter(p => p.translatable && p.text && p.text.trim() &&
      p.segments.length && p.segments[0].pageNum >= first && p.segments[0].pageNum <= last)
    .map(p => p.text);
}

/** Interlinea (rapporto col corpo) misurata sulle righe dell'originale. */
export function leadingRatio(seg) {
  let lh = 1.18;
  const rows = seg.lines || [];
  if (rows.length >= 2 && seg.fontSize > 0) {
    const step = (rows[rows.length - 1].y - rows[0].y) / (rows.length - 1);
    if (step > 0) lh = Math.min(1.6, Math.max(1.0, step / seg.fontSize));
  }
  return lh;
}

/** Stile del box di un segmento: stessa famiglia, peso, corsivo, allineamento e interlinea. */
export function segmentStyle(seg, role) {
  return {
    fontFamily: genericFamily(seg.fontName),
    fontWeight: seg.bold || role === 'heading' ? '700' : '400',
    fontStyle: seg.italic ? 'italic' : 'normal',
    textAlign: seg.alignment === 'justify' ? 'justify' : (seg.alignment || 'left'),
    lineHeight: String(leadingRatio(seg)),
  };
}

/** Unità per `distribute_pdf_translations`: il testo tradotto e il peso (caratteri) di ogni segmento. */
export function buildDistUnits(paragraphs, translations) {
  return paragraphs.map(p => ({
    text: translations.get(p.id) ?? p.text,
    weights: p.segments.map(s => s.charCount),
  }));
}

/** Riduce il corpo finché il testo sta nel box (minimo `MIN_FONT_SCALE` dell'originale). */
export function fitText(el, startPx) {
  let fs = startPx;
  const min = startPx * MIN_FONT_SCALE;
  el.style.fontSize = fs + 'px';
  let guard = 0;
  while ((el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) && fs > min && guard++ < 40) {
    fs *= 0.93;
    el.style.fontSize = fs + 'px';
  }
  el.dataset.scale = (fs / startPx).toFixed(2);
  el.classList.toggle('overflow', el.scrollHeight > el.clientHeight + 1);
  return fs;
}

/**
 * Crea il box (vuoto, "pending") di un segmento dentro il wrapper della sua
 * pagina. Le coordinate sono in punti PDF, `scale` è il rapporto px/punto.
 */
export function createSegmentBox(wrapper, par, seg, scale) {
  const el = document.createElement('div');
  el.className = 'pdf-tr-seg pending';
  el.dataset.paraId = par.id;
  const pad = 1;
  const b = seg.bounds;
  el.style.left = (b.x - pad) * scale + 'px';
  el.style.top = (b.y - pad) * scale + 'px';
  el.style.width = (b.w + 2 * pad) * scale + 'px';
  el.style.height = (b.h + 2 * pad) * scale + 'px';
  Object.assign(el.style, segmentStyle(seg, par.role));
  el.style.fontSize = seg.fontSize * scale + 'px';
  wrapper.appendChild(el);
  return el;
}

/** Scrive la traduzione nel box e adatta il corpo. */
export function fillSegment(el, text, seg, scale) {
  el.textContent = text;
  el.classList.remove('pending');
  el.classList.add('translated');
  return fitText(el, seg.fontSize * scale);
}

/**
 * Estrae le pagine con pdf.js (con cache) e le analizza col motore Rust.
 * Il risultato dell'ultima analisi è tenuto in memoria per l'intervallo richiesto.
 */
export class PdfLayoutAnalyzer {
  /**
   * @param {PDFDocumentProxy} doc
   * @param {{ extract?: Function, invoke?: Function }} [deps] sostituibili nei test
   */
  constructor(doc, deps = {}) {
    this.doc = doc;
    this._extract = deps.extract || (async (doc, n) => (await import('./pdf-extract.js')).extractPage(doc, n));
    this._invoke = deps.invoke || null;
    this._pages = new Map();   // pageNum → PageInput (estrazione, costosa)
    this._last = null;         // { key, result }
  }

  async _call(cmd, args) {
    if (!this._invoke) {
      const { invoke } = await import('@tauri-apps/api/core');
      this._invoke = invoke;
    }
    return this._invoke(cmd, args);
  }

  /** Intervallo effettivamente analizzato per le pagine `first..last`. */
  windowFor(first, last) {
    return {
      lo: Math.max(1, first - ANALYSIS_MARGIN_PAGES),
      hi: Math.min(this.doc.numPages, last + ANALYSIS_MARGIN_PAGES),
    };
  }

  /**
   * @param {number} first prima pagina mostrata (1-based)
   * @param {number} last ultima pagina mostrata
   * @param {{ signal?: AbortSignal, onProgress?: (done:number,total:number)=>void }} [opts]
   * @returns {Promise<object|null>} DocumentResult, o null se annullato
   */
  async analyze(first, last, { signal, onProgress } = {}) {
    const { lo, hi } = this.windowFor(first, last);
    const key = `${lo}-${hi}`;
    if (this._last && this._last.key === key) return this._last.result;

    const inputs = [];
    const total = hi - lo + 1;
    for (let n = lo; n <= hi; n++) {
      if (signal && signal.aborted) return null;
      let data = this._pages.get(n);
      if (!data) {
        data = (await this._extract(this.doc, n)).data;
        this._pages.set(n, data);
      }
      inputs.push(data);
      if (onProgress) onProgress(n - lo + 1, total);
    }
    if (signal && signal.aborted) return null;

    const result = await this._call('analyze_pdf_layout', { pages: inputs, options: null });
    if (signal && signal.aborted) return null;
    this._last = { key, result };
    return result;
  }

  /** Distribuisce le traduzioni sui segmenti: array (per paragrafo) di testi (per segmento). */
  async distribute(paragraphs, translations) {
    return this._call('distribute_pdf_translations', { units: buildDistUnits(paragraphs, translations) });
  }
}
