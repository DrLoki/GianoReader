/**
 * translation-cache.js
 *
 * Persistent cache of the translations of one book, and the statistics shown
 * in the "Book translation" dialog.
 *
 * One cache per book, saved as a JSON file in the app data folder (see
 * `TranslationCacheStore` in main.js). Inside, translations are grouped by
 * variant (target language + engine) and keyed by a hash of the source
 * paragraph text, so:
 * - a translation made with one engine never replaces one made with another
 *   (a paid PRO translation is not overwritten by FREE);
 * - when the book file is edited, unchanged paragraphs keep their translation
 *   and only new or changed text is translated again.
 *
 * The cache also stores the book "structure": for every chapter the hashes and
 * lengths of its paragraphs. It is needed to know how much of the whole book is
 * translated without reading every chapter again, and is rebuilt when the
 * book file changes size.
 *
 * Pure module: no DOM, filesystem or network access.
 */

export const CACHE_VERSION = 1;

/** Translation engines, in the order they are listed. */
export const ENGINES = ['free', 'basic', 'pro'];

/**
 * 53-bit hash of a string (cyrb53), as 14 hex digits. Not cryptographic: it
 * only has to tell apart the paragraphs of one book.
 * @param {string} text
 */
export function textKey(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

/** Name of a translation variant: target language and engine. */
export function variantKey(lang, engine) {
  return `${lang}|${engine || 'free'}`;
}

/** Splits a variant name back into its language and engine. */
export function parseVariant(variant) {
  const sep = variant.lastIndexOf('|');
  return sep < 0 ? { lang: variant, engine: 'free' } : { lang: variant.slice(0, sep), engine: variant.slice(sep + 1) };
}

/** Empty cache data for a book. */
export function emptyCacheData(book = {}) {
  return {
    version: CACHE_VERSION,
    book: { filePath: book.filePath || '', title: book.title || '' },
    updatedAt: 0,
    translations: {},
    structure: null,
  };
}

/**
 * Validates data read from disk. Anything unexpected gives an empty cache:
 * losing a cache only means translating again.
 */
export function normalizeCacheData(data, book = {}) {
  if (!data || typeof data !== 'object' || data.version !== CACHE_VERSION) return emptyCacheData(book);
  const out = emptyCacheData({ ...data.book, ...book });
  out.updatedAt = Number(data.updatedAt) || 0;
  if (data.translations && typeof data.translations === 'object') {
    for (const [variant, entries] of Object.entries(data.translations)) {
      if (!entries || typeof entries !== 'object') continue;
      const clean = {};
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string' && value.trim()) clean[key] = value;
      }
      out.translations[variant] = clean;
    }
  }
  const s = data.structure;
  if (s && Array.isArray(s.chapters) && s.chapters.every(isValidChapter)) {
    out.structure = { fileSize: Number(s.fileSize) || 0, chapters: s.chapters };
  }
  return out;
}

function isValidChapter(ch) {
  return ch && Array.isArray(ch.keys) && Array.isArray(ch.lengths) && ch.keys.length === ch.lengths.length;
}

/**
 * Translations of one book: lookup, update and statistics.
 */
export class BookTranslationCache {
  /**
   * @param {object} [data] content of the cache file (validated)
   * @param {{ filePath?: string, title?: string }} [book]
   */
  constructor(data, book = {}) {
    this.data = normalizeCacheData(data, book);
    this.dirty = false;
  }

  /** Cached translation of `text` for `variant`, or undefined. */
  get(variant, text) {
    const entries = this.data.translations[variant];
    return entries ? entries[textKey(text)] : undefined;
  }

  /** True when `text` has a cached translation for `variant`. */
  has(variant, text) {
    return this.get(variant, text) !== undefined;
  }

  /**
   * Stores a translation. Empty results (a failed translation) are ignored, so
   * a failure is never cached as if it were the answer.
   */
  set(variant, text, translation) {
    if (typeof translation !== 'string' || !translation.trim() || !text) return;
    const key = textKey(text);
    const entries = this.data.translations[variant] || (this.data.translations[variant] = {});
    if (entries[key] === translation) return;
    entries[key] = translation;
    this.data.updatedAt = Date.now();
    this.dirty = true;
  }

  /** Removes the translations of some texts (forced retranslation). */
  forget(variant, texts) {
    const entries = this.data.translations[variant];
    if (!entries) return;
    for (const text of texts) {
      const key = textKey(text);
      if (key in entries) {
        delete entries[key];
        this.dirty = true;
      }
    }
  }

  /** Removes every translation of one variant. */
  clearVariant(variant) {
    if (this.data.translations[variant]) {
      delete this.data.translations[variant];
      this.dirty = true;
    }
  }

  /**
   * Book structure, when it is known and still matches the book file.
   * @param {number} [fileSize] current size of the book file
   */
  getStructure(fileSize) {
    const s = this.data.structure;
    if (!s) return null;
    if (fileSize && s.fileSize && s.fileSize !== fileSize) return null;
    return s;
  }

  /**
   * Records the book structure.
   * @param {Array<{ label: string, texts: string[] }>} chapters paragraph texts per chapter
   * @param {number} fileSize size of the book file it was read from
   */
  setStructure(chapters, fileSize) {
    this.data.structure = {
      fileSize: fileSize || 0,
      chapters: chapters.map((ch) => ({
        label: ch.label || '',
        keys: ch.texts.map(textKey),
        lengths: ch.texts.map((t) => t.length),
      })),
    };
    this.dirty = true;
  }

  /**
   * How much of the book is translated in `variant`.
   * Returns null when the structure is not known yet.
   *
   * @returns {null | {
   *   paragraphs: number, translatedParagraphs: number,
   *   chars: number, translatedChars: number, missingChars: number,
   *   percent: number, completeChapters: number,
   *   chapters: Array<{ label: string, paragraphs: number, translated: number, percent: number }>,
   * }}
   */
  stats(variant, fileSize) {
    const structure = this.getStructure(fileSize);
    if (!structure) return null;
    const entries = this.data.translations[variant] || {};
    const result = {
      paragraphs: 0, translatedParagraphs: 0, chars: 0, translatedChars: 0,
      missingChars: 0, percent: 0, completeChapters: 0, chapters: [],
    };
    for (const ch of structure.chapters) {
      let translated = 0;
      for (let i = 0; i < ch.keys.length; i++) {
        result.chars += ch.lengths[i];
        if (entries[ch.keys[i]] !== undefined) {
          translated++;
          result.translatedChars += ch.lengths[i];
        }
      }
      result.paragraphs += ch.keys.length;
      result.translatedParagraphs += translated;
      if (translated === ch.keys.length) result.completeChapters++;
      result.chapters.push({
        label: ch.label,
        paragraphs: ch.keys.length,
        translated,
        percent: ch.keys.length ? Math.floor((translated / ch.keys.length) * 100) : 100,
      });
    }
    result.missingChars = result.chars - result.translatedChars;
    result.percent = result.chars ? Math.floor((result.translatedChars / result.chars) * 100) : 0;
    return result;
  }

  /**
   * Every variant with cached translations, with its counts (and its share of
   * the book when the structure is known), most complete first.
   */
  variants(fileSize) {
    const list = [];
    for (const [variant, entries] of Object.entries(this.data.translations)) {
      const count = Object.keys(entries).length;
      if (!count) continue;
      const stats = this.stats(variant, fileSize);
      list.push({ variant, ...parseVariant(variant), cached: count, percent: stats ? stats.percent : null });
    }
    return list.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || b.cached - a.cached);
  }

  /** Data to write to the cache file. */
  toJSON() {
    return this.data;
  }
}
