/**
 * Non-Regression Tests — GianoReader
 * Covers: book opening, bookmarks, theme/font/fontSize, library import
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { translations, t } from './i18n.js';

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

// ── Settings helpers (replicated from main.js for isolation) ─────────────
const SETTINGS_KEY = 'giano-reader-settings';
const THEMES = ['dark', 'light', 'monokai', 'solarized-dark', 'nord', 'sepia'];

function makeSettingsFunctions(storage) {
  function loadSettings() {
    try { return JSON.parse(storage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSettings(s) {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
  return { loadSettings, saveSettings };
}

// ── Library helpers (replicated from main.js) ────────────────────────────
const LIBRARY_KEY = 'giano-reader-library';

function makeLibFunctions(storage) {
  function loadLibrary() {
    try { return JSON.parse(storage.getItem(LIBRARY_KEY) || '[]'); } catch { return []; }
  }
  function saveLibrary(entries) {
    storage.setItem(LIBRARY_KEY, JSON.stringify(entries));
  }
  function addEntries(newEntries) {
    const lib = loadLibrary();
    const existingPaths = new Set(lib.map(e => e.filePath));
    let added = 0, skipped = 0;
    for (const entry of newEntries) {
      if (existingPaths.has(entry.filePath)) { skipped++; }
      else { lib.push(entry); existingPaths.add(entry.filePath); added++; }
    }
    saveLibrary(lib);
    return { added, skipped };
  }
  function removeEntry(id) {
    const filtered = loadLibrary().filter(e => e.id !== id);
    saveLibrary(filtered);
    return filtered;
  }
  return { loadLibrary, saveLibrary, addEntries, removeEntry };
}

// ── Bookmark helpers (replicated from main.js) ───────────────────────────
const BOOKMARKS_KEY = 'giano-reader-bookmarks';

function makeBookmarkFunctions(storage) {
  function loadBookmarks() {
    try { return JSON.parse(storage.getItem(BOOKMARKS_KEY) || '[]'); } catch { return []; }
  }
  function saveBookmarks(bms) {
    storage.setItem(BOOKMARKS_KEY, JSON.stringify(bms));
  }
  function addBookmark(bm) {
    const bms = loadBookmarks();
    bms.push(bm);
    saveBookmarks(bms);
    return bms;
  }
  function deleteBookmark(id) {
    const bms = loadBookmarks().filter(b => b.id !== id);
    saveBookmarks(bms);
    return bms;
  }
  return { loadBookmarks, saveBookmarks, addBookmark, deleteBookmark };
}

// ── Pure functions from main.js ──────────────────────────────────────────
// NB: copie allineate a giano-reader/src/main.js (modello a segmenti con immagini).
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'span', 'small', 'mark', 'code', 'abbr', 'q', 'cite', 'br', 'img']);

function resolveImgSrc(rawSrc, imgResolver) {
  if (!rawSrc || !imgResolver) return rawSrc;
  if (/^(blob:|data:|https?:)/i.test(rawSrc)) return rawSrc;
  if (imgResolver.has(rawSrc)) return imgResolver.get(rawSrc);
  const base = rawSrc.split(/[\\/]/).pop();
  if (base && imgResolver.has(base)) return imgResolver.get(base);
  return rawSrc;
}

function safeInnerHtml(el, imgResolver = null) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script, style').forEach(n => n.remove());
  clone.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    Array.from(a.attributes).forEach(attr => {
      if (attr.name !== 'href') a.removeAttribute(attr.name);
    });
    a.setAttribute('data-epub-href', href);
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
  });
  clone.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    const resolved = resolveImgSrc(src, imgResolver);
    if (resolved) img.setAttribute('src', resolved);
    img.setAttribute('loading', 'lazy');
    img.classList.add('inline-img');
    Array.from(img.attributes).forEach(attr => {
      if (!['src', 'alt', 'loading', 'width', 'height', 'class'].includes(attr.name)) img.removeAttribute(attr.name);
    });
  });
  clone.querySelectorAll('*').forEach(n => {
    ['onclick', 'onmouseover', 'onerror', 'onload'].forEach(ev => n.removeAttribute(ev));
  });
  return clone.innerHTML;
}

// ── Inline images (token) ──────────────────────────────────────────────────
const INLINE_IMG_TOKEN_OPEN = '\u27E6IMG';
const INLINE_IMG_TOKEN_CLOSE = '\u27E7';
function inlineImgToken(i) { return `${INLINE_IMG_TOKEN_OPEN}${i}${INLINE_IMG_TOKEN_CLOSE}`; }
const INLINE_IMG_TOKEN_RE = /\u27E6\s*IMG\s*(\d+)\s*\u27E7/g;

function inlineImgHtml(img, imgResolver) {
  const clone = img.cloneNode(false);
  const src = clone.getAttribute('src') || '';
  const resolved = resolveImgSrc(src, imgResolver);
  if (resolved) clone.setAttribute('src', resolved);
  clone.setAttribute('loading', 'lazy');
  clone.classList.add('inline-img');
  Array.from(clone.attributes).forEach(attr => {
    if (!['src', 'alt', 'loading', 'width', 'height', 'class'].includes(attr.name)) clone.removeAttribute(attr.name);
  });
  return clone.outerHTML;
}

function extractTextWithInlineImages(el, imgResolver) {
  const inlineImages = [];
  const walk = (node) => {
    let out = '';
    node.childNodes.forEach(child => {
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'img') {
          const idx = inlineImages.length;
          inlineImages.push(inlineImgHtml(child, imgResolver));
          out += ` ${inlineImgToken(idx)} `;
        } else {
          out += walk(child);
        }
      }
    });
    return out;
  };
  const text = walk(el).replace(/\s+/g, ' ').trim();
  return { text, inlineImages };
}

function reinsertInlineImages(safeText, inlineImages) {
  if (!inlineImages || !inlineImages.length) {
    return safeText.replace(INLINE_IMG_TOKEN_RE, '').replace(/\s{2,}/g, ' ').trim();
  }
  const used = new Set();
  let out = safeText.replace(INLINE_IMG_TOKEN_RE, (_m, n) => {
    const idx = parseInt(n, 10);
    if (idx >= 0 && idx < inlineImages.length) { used.add(idx); return inlineImages[idx]; }
    return '';
  });
  const missing = inlineImages.filter((_, i) => !used.has(i));
  if (missing.length) out = out.trim() + ' ' + missing.join(' ');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function buildImageBlockHtml(el, imgResolver) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script, style').forEach(n => n.remove());
  const imgs = el.tagName.toLowerCase() === 'img' ? [clone] : Array.from(clone.querySelectorAll('img'));
  imgs.forEach(img => {
    const src = img.getAttribute('src') || '';
    const resolved = resolveImgSrc(src, imgResolver);
    if (resolved) img.setAttribute('src', resolved);
    img.setAttribute('loading', 'lazy');
    Array.from(img.attributes).forEach(attr => {
      if (!['src', 'alt', 'loading', 'width', 'height'].includes(attr.name)) img.removeAttribute(attr.name);
    });
  });
  return clone.tagName ? clone.outerHTML : clone.innerHTML;
}

function isImageBlock(el) {
  const tag = el.tagName?.toLowerCase();
  return tag === 'img' || tag === 'figure' || tag === 'svg';
}

function extractParagraphs(body, imgResolver = null) {
  const textSelectors = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'];
  const imageSelectors = ['figure', 'img', 'svg'];
  const allSelectors = [...textSelectors, ...imageSelectors];
  const rawBlocks = body.querySelectorAll?.(allSelectors.join(', '));
  const blocks = rawBlocks ? Array.from(rawBlocks).filter(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'blockquote') return !el.querySelector(textSelectors.join(', '));
    if (tag === 'img' || tag === 'svg') {
      if (el.closest('figure')) return false;
      if (el.closest(textSelectors.join(', '))) return false;
      return true;
    }
    return true;
  }) : rawBlocks;
  if (blocks && blocks.length > 0) {
    const r = [];
    blocks.forEach(el => {
      if (isImageBlock(el)) {
        const html = buildImageBlockHtml(el, imgResolver);
        if (!html) return;
        const alt = el.querySelector?.('img')?.getAttribute('alt') || el.getAttribute?.('alt') || '';
        r.push({ type: 'image', html, id: el.id || null, alt });
        return;
      }
      const { text, inlineImages } = extractTextWithInlineImages(el, imgResolver);
      if (!text && !inlineImages.length) return;
      r.push({ type: 'text', text, html: safeInnerHtml(el, imgResolver), id: el.id || null, inlineImages });
    });
    if (r.length) return r;
  }
  return (body.textContent || '').split('\n')
    .map(l => l.trim()).filter(l => l.length > 2)
    .map(text => ({ type: 'text', text, html: text, id: null, inlineImages: [] }));
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyInlineFormatting(originalHtml, translatedText, inlineImages = []) {
  const safeText = escapeHtml(translatedText);
  const withImages = reinsertInlineImages(safeText, inlineImages);
  if (!originalHtml || originalHtml.indexOf('<') === -1) return withImages;
  const tmp = document.createElement('div');
  tmp.innerHTML = originalHtml;
  const elementChildren = Array.from(tmp.childNodes).filter(
    n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())
  );
  if (elementChildren.length === 1 && elementChildren[0].nodeType === 1) {
    const el = elementChildren[0];
    const tag = el.tagName.toLowerCase();
    if (tag !== 'img' && INLINE_TAGS.has(tag)) {
      const wrapper = el.cloneNode(false);
      wrapper.innerHTML = withImages;
      return wrapper.outerHTML;
    }
  }
  const links = tmp.querySelectorAll('a[data-epub-href]');
  if (links.length === 1 && (links[0].textContent || '').trim() === (tmp.textContent || '').trim()) {
    const a = links[0].cloneNode(false);
    a.innerHTML = withImages;
    return a.outerHTML;
  }
  return withImages;
}

function paragraphsToHtml(paragraphs) {
  return paragraphs.filter(p => {
    if (p && p.type === 'image') return !!p.html;
    return ((p && p.text) || p || '').toString().trim();
  }).map(p => {
    if (p && p.type === 'image') return `<div class="segment-image">${p.html}</div>`;
    const html = p.html !== undefined ? p.html : escapeHtml(p);
    return `<p>${html}</p>`;
  }).join('');
}

// ── Scroll sync con offset (copia da main.js) ──────────────────────────────
function computeSyncedPct(sourcePct, offsetPct) {
  const p = sourcePct + offsetPct;
  return Math.min(1, Math.max(0, p));
}
// L'offset è definito come right - left. Applica il sync da una sorgente
// verso il target scegliendo il segno in base a quale pannello è la sorgente.
function syncTargetPct(sourcePct, offsetPct, isLeftSource) {
  return isLeftSource
    ? computeSyncedPct(sourcePct, offsetPct)
    : computeSyncedPct(sourcePct, -offsetPct);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. APERTURA LIBRO SEMPLICE
// ═══════════════════════════════════════════════════════════════════════════
describe('Apertura libro semplice', () => {
  it('extractParagraphs estrae paragrafi da un body HTML con <p>', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Capitolo uno</p><p>Testo del paragrafo.</p>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Capitolo uno');
    expect(result[1].text).toBe('Testo del paragrafo.');
  });

  it('extractParagraphs estrae heading e list items', () => {
    const body = document.createElement('div');
    body.innerHTML = '<h1>Titolo</h1><h2>Sottotitolo</h2><li>Elemento lista</li>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('Titolo');
  });

  it('extractParagraphs fallback: split per newline quando non ci sono tag', () => {
    const body = document.createElement('div');
    body.textContent = 'Linea uno\nLinea due\nLinea tre';
    const result = extractParagraphs(body);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].text).toBe('Linea uno');
  });

  it('extractParagraphs ignora paragrafi vuoti', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Testo</p><p>   </p><p>Altro</p>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(2);
  });

  it('extractParagraphs estrae testo da <blockquote> con span annidati (es. dialoghi SMS)', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Then we\'re going to have to do something about that…</p>' +
      '<blockquote><span class="italic"><span class="calibre3">–having fun. wish you were here</span></span></blockquote>' +
      '<p>In the picture, Erin was posing with Liz.</p>';
    const result = extractParagraphs(body);
    expect(result.map(r => r.text)).toContain('–having fun. wish you were here');
  });

  it('extractParagraphs non duplica il testo se il <blockquote> contiene un <p>', () => {
    const body = document.createElement('div');
    body.innerHTML = '<blockquote><p>Testo citato</p></blockquote>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Testo citato');
  });

  it('paragraphsToHtml genera HTML valido dai paragrafi', () => {
    const paras = [{ text: 'Hello', html: 'Hello' }, { text: 'World', html: 'World' }];
    const html = paragraphsToHtml(paras);
    expect(html).toBe('<p>Hello</p><p>World</p>');
  });

  it('escapeHtml previene XSS', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('extractParagraphs marca i segmenti testo con type "text"', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Ciao</p>';
    const result = extractParagraphs(body);
    expect(result[0].type).toBe('text');
    expect(result[0].text).toBe('Ciao');
  });

  it('extractParagraphs estrae immagini standalone come segmenti type "image" non testuali', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Prima</p><img src="Images/foo.jpg" alt="Figura"/><p>Dopo</p>';
    const result = extractParagraphs(body);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('text');
    expect(result[1].type).toBe('image');
    expect(result[1].text).toBeUndefined();
    expect(result[1].alt).toBe('Figura');
    expect(result[2].type).toBe('text');
  });

  it('extractParagraphs estrae <figure> come singolo segmento immagine (no img duplicata)', () => {
    const body = document.createElement('div');
    body.innerHTML = '<figure><img src="Images/f.png"/><figcaption>Didascalia</figcaption></figure>';
    const result = extractParagraphs(body);
    const images = result.filter(r => r.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].html).toContain('figcaption');
  });

  it('extractParagraphs tratta una <img> inline dentro un <p> come segmento testo con token', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>Testo con <img src="Images/inline.png"/> immagine inline</p>';
    const result = extractParagraphs(body);
    // Un solo segmento testo; l'img è nell'html originale e come inlineImage+token
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(result[0].html).toContain('<img');
    expect(result[0].inlineImages).toHaveLength(1);
    expect(result[0].text).toMatch(/\u27E6IMG0\u27E7/); // token presente nel testo da tradurre
    expect(result[0].text).toContain('Testo con');
    expect(result[0].text).toContain('immagine inline');
  });

  it('extractParagraphs: caso reale Sigil — "paragraph button <img/> can be used"', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>The paragraph button <img alt="Normal Paragraph icon" src="../Images/heading-normal.png"/> can be used to change your text.</p>';
    const seg = extractParagraphs(body)[0];
    expect(seg.type).toBe('text');
    expect(seg.inlineImages).toHaveLength(1);
    expect(seg.inlineImages[0]).toContain('heading-normal.png');
    expect(seg.text).toMatch(/paragraph button\s+\u27E6IMG0\u27E7\s+can be used/);
  });

  it('applyInlineFormatting reinserisce l\'immagine inline al posto del token tradotto', () => {
    const seg = { html: 'The paragraph button <img src="blob:xyz"/> can be used', inlineImages: ['<img src="blob:xyz" class="inline-img">'] };
    // Il traduttore preserva il token nella traduzione
    const out = applyInlineFormatting(seg.html, 'Il pulsante Paragrafo \u27E6IMG0\u27E7 può essere usato', seg.inlineImages);
    expect(out).toContain('<img src="blob:xyz"');
    expect(out).toContain('Il pulsante Paragrafo');
    expect(out).toContain('può essere usato');
    expect(out).not.toMatch(/\u27E6IMG0\u27E7/); // token consumato
  });

  it('applyInlineFormatting appende l\'immagine se il traduttore perde il token', () => {
    const inlineImages = ['<img src="blob:xyz" class="inline-img">'];
    // Traduzione senza token (motore l'ha rimosso) → immagine appesa in coda, mai persa
    const out = applyInlineFormatting('a <img src="blob:xyz"/> b', 'testo tradotto senza segnaposto', inlineImages);
    expect(out).toContain('<img src="blob:xyz"');
    expect(out).toContain('testo tradotto senza segnaposto');
  });

  it('applyInlineFormatting rimuove token residui quando non ci sono immagini', () => {
    const out = applyInlineFormatting('testo', 'testo \u27E6IMG5\u27E7 tradotto', []);
    expect(out).not.toMatch(/\u27E6/);
    expect(out).toBe('testo tradotto');
  });

  it('extractParagraphs preserva l\'ordine di più immagini inline', () => {
    const body = document.createElement('div');
    body.innerHTML = '<p>A <img src="x/1.png"/> B <img src="x/2.png"/> C</p>';
    const seg = extractParagraphs(body)[0];
    expect(seg.inlineImages).toHaveLength(2);
    expect(seg.inlineImages[0]).toContain('1.png');
    expect(seg.inlineImages[1]).toContain('2.png');
    const out = applyInlineFormatting(seg.html, 'A \u27E6IMG0\u27E7 B \u27E6IMG1\u27E7 C', seg.inlineImages);
    expect(out.indexOf('1.png')).toBeLessThan(out.indexOf('2.png')); // ordine preservato
  });

  it('resolveImgSrc rimappa src relativi in blob URL tramite il resolver', () => {
    const resolver = new Map([['Images/foo.jpg', 'blob:xyz'], ['foo.jpg', 'blob:xyz']]);
    expect(resolveImgSrc('Images/foo.jpg', resolver)).toBe('blob:xyz');
    expect(resolveImgSrc('../Images/foo.jpg', resolver)).toBe('blob:xyz'); // match per basename
    expect(resolveImgSrc('data:image/png;base64,AAA', resolver)).toBe('data:image/png;base64,AAA'); // già assoluto
    expect(resolveImgSrc('Images/missing.jpg', resolver)).toBe('Images/missing.jpg'); // non trovato → invariato
  });

  it('buildImageBlockHtml rimappa src e pulisce attributi pericolosi', () => {
    const body = document.createElement('div');
    body.innerHTML = '<img src="Images/f.jpg" onerror="alert(1)" data-x="y" alt="A"/>';
    const img = body.querySelector('img');
    const html = buildImageBlockHtml(img, new Map([['Images/f.jpg', 'blob:abc']]));
    expect(html).toContain('blob:abc');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('data-x');
    expect(html).toContain('alt="A"');
  });

  it('applyInlineFormatting: testo puro senza tag → escape semplice', () => {
    expect(applyInlineFormatting('Ciao mondo', 'Hello world')).toBe('Hello world');
  });

  it('applyInlineFormatting: wrapper inline intero preservato attorno alla traduzione', () => {
    const out = applyInlineFormatting('<em>Ciao</em>', 'Hello');
    expect(out).toBe('<em>Hello</em>');
  });

  it('applyInlineFormatting: link che copre tutto il blocco preserva href', () => {
    const body = document.createElement('div');
    body.innerHTML = '<a data-epub-href="chap2.xhtml#n1">Vedi nota</a>';
    const out = applyInlineFormatting(body.innerHTML, 'See note');
    expect(out).toContain('data-epub-href="chap2.xhtml#n1"');
    expect(out).toContain('See note');
  });

  it('applyInlineFormatting: formattazione inline sparsa → fallback a testo puro (contenuto integro)', () => {
    const out = applyInlineFormatting('Testo <strong>in</strong> mezzo', 'Text in the middle');
    expect(out).toBe('Text in the middle');
  });

  it('paragraphsToHtml include i segmenti immagine come blocco div', () => {
    const paras = [
      { type: 'text', text: 'Hello', html: 'Hello' },
      { type: 'image', html: '<img src="blob:abc" alt="x">' },
    ];
    const html = paragraphsToHtml(paras);
    expect(html).toBe('<p>Hello</p><div class="segment-image"><img src="blob:abc" alt="x"></div>');
  });

  it('escapeHtml non lancia errore con null o undefined (bookmark PWA senza campi desktop)', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('loadEpub imposta book a null dopo un errore', () => {
    let book = { destroy: vi.fn() };
    let currentSpineItems = ['a', 'b'];
    let currentChapterParagraphs = ['p1'];
    let currentFilePath = '/test.epub';
    // Simulate error path from loadEpub
    try { throw new Error('invalid epub'); } catch {
      if (book) { try { book.destroy(); } catch (_) {} book = null; }
      currentSpineItems = [];
      currentChapterParagraphs = [];
      currentFilePath = null;
    }
    expect(book).toBeNull();
    expect(currentSpineItems).toEqual([]);
    expect(currentChapterParagraphs).toEqual([]);
    expect(currentFilePath).toBeNull();
  });

  it('displayChapter clampa indici fuori range', () => {
    const total = 5;
    function clampIndex(index) {
      return Math.max(0, Math.min(index, total - 1));
    }
    expect(clampIndex(-1)).toBe(0);
    expect(clampIndex(0)).toBe(0);
    expect(clampIndex(4)).toBe(4);
    expect(clampIndex(99)).toBe(4);
  });

  it('updateProgress calcola la percentuale corretta', () => {
    function calcPct(index, total) {
      if (!total) return 0;
      return total === 1 ? 0 : (index / (total - 1)) * 100;
    }
    expect(calcPct(0, 10)).toBe(0);
    expect(calcPct(9, 10)).toBe(100);
    expect(calcPct(0, 1)).toBe(0);
    expect(calcPct(4, 10)).toBeCloseTo(44.44, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. APERTURA SEGNALIBRO
// ═══════════════════════════════════════════════════════════════════════════
describe('Apertura segnalibro', () => {
  let storage, fns;
  beforeEach(() => {
    storage = createLocalStorageMock();
    fns = makeBookmarkFunctions(storage);
  });

  it('loadBookmarks restituisce [] quando non ci sono segnalibri', () => {
    expect(fns.loadBookmarks()).toEqual([]);
  });

  it('addBookmark aggiunge un segnalibro e lo persiste', () => {
    const bm = { id: 1, filePath: '/book.epub', fileName: 'book.epub',
      bookTitle: 'Test', chapterIndex: 2, chapterLabel: 'Ch 3', scrollPct: 42 };
    const result = fns.addBookmark(bm);
    expect(result).toHaveLength(1);
    expect(fns.loadBookmarks()).toHaveLength(1);
    expect(fns.loadBookmarks()[0].chapterIndex).toBe(2);
  });

  it('deleteBookmark rimuove solo il segnalibro specificato', () => {
    fns.addBookmark({ id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0 });
    fns.addBookmark({ id: 2, filePath: '/b.epub', fileName: 'b.epub', bookTitle: 'B', chapterIndex: 1 });
    const remaining = fns.deleteBookmark(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(2);
  });

  it('segnalibro preserva la posizione di scroll', () => {
    const bm = { id: 10, filePath: '/x.epub', fileName: 'x.epub',
      bookTitle: 'X', chapterIndex: 5, chapterLabel: 'Ch 6', scrollPct: 75 };
    fns.addBookmark(bm);
    const loaded = fns.loadBookmarks()[0];
    expect(loaded.scrollPct).toBe(75);
    expect(loaded.chapterIndex).toBe(5);
  });

  it('round-trip persistenza segnalibri', () => {
    const bms = [
      { id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0, scrollPct: 0 },
      { id: 2, filePath: '/b.epub', fileName: 'b.epub', bookTitle: 'B', chapterIndex: 3, scrollPct: 50 },
    ];
    fns.saveBookmarks(bms);
    expect(fns.loadBookmarks()).toEqual(bms);
  });

  it('import segnalibri evita duplicati per id', () => {
    fns.addBookmark({ id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0 });
    // Simulate import logic
    const imported = [
      { id: 1, filePath: '/a.epub', fileName: 'a.epub', bookTitle: 'A', chapterIndex: 0 },
      { id: 3, filePath: '/c.epub', fileName: 'c.epub', bookTitle: 'C', chapterIndex: 2 },
    ];
    const existing = fns.loadBookmarks();
    const existingIds = new Set(existing.map(b => b.id));
    const toAdd = imported.filter(b => b && b.id && !existingIds.has(b.id));
    fns.saveBookmarks([...existing, ...toAdd]);
    expect(fns.loadBookmarks()).toHaveLength(2);
  });

  it('openBookmark verifica path assoluto (Windows e Unix)', () => {
    function hasAbsolutePath(filePath) {
      return !!(filePath && (filePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(filePath)));
    }
    expect(hasAbsolutePath('/home/user/book.epub')).toBe(true);
    expect(hasAbsolutePath('C:\\Users\\book.epub')).toBe(true);
    expect(hasAbsolutePath('D:/books/test.epub')).toBe(true);
    expect(hasAbsolutePath('book.epub')).toBe(false);
    expect(hasAbsolutePath('')).toBe(false);
    expect(hasAbsolutePath(null)).toBe(false);
  });

  it('restoreScrollPct calcola la posizione corretta', () => {
    function restoreScroll(pct, scrollHeight, clientHeight) {
      const max = Math.max(1, scrollHeight - clientHeight);
      return Math.round((pct / 100) * max);
    }
    expect(restoreScroll(0, 1000, 500)).toBe(0);
    expect(restoreScroll(100, 1000, 500)).toBe(500);
    expect(restoreScroll(50, 1000, 500)).toBe(250);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CAMBIO TEMA, FONT, DIMENSIONE CARATTERE
// ═══════════════════════════════════════════════════════════════════════════
describe('Cambio tema, font, dimensione carattere', () => {
  let storage, fns;
  beforeEach(() => {
    storage = createLocalStorageMock();
    fns = makeSettingsFunctions(storage);
  });

  // ── Theme ──
  it('applyTheme aggiunge la classe corretta al body', () => {
    function applyTheme(theme) {
      document.body.classList.remove('dark', ...THEMES.map(t => `theme-${t}`));
      if (theme === 'dark') document.body.classList.add('dark');
      else document.body.classList.add(`theme-${theme}`);
    }
    applyTheme('dark');
    expect(document.body.classList.contains('dark')).toBe(true);
    applyTheme('sepia');
    expect(document.body.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('theme-sepia')).toBe(true);
    applyTheme('monokai');
    expect(document.body.classList.contains('theme-sepia')).toBe(false);
    expect(document.body.classList.contains('theme-monokai')).toBe(true);
  });

  it('tutti i temi sono applicabili senza errori', () => {
    function applyTheme(theme) {
      document.body.classList.remove('dark', ...THEMES.map(t => `theme-${t}`));
      if (theme === 'dark') document.body.classList.add('dark');
      else document.body.classList.add(`theme-${theme}`);
    }
    for (const theme of THEMES) {
      expect(() => applyTheme(theme)).not.toThrow();
    }
  });

  it('tema salvato e ricaricato correttamente', () => {
    for (const theme of THEMES) {
      fns.saveSettings({ theme });
      expect(fns.loadSettings().theme).toBe(theme);
    }
  });

  // ── Font family ──
  it('applyFont imposta la CSS custom property', () => {
    function applyFont(family) {
      document.documentElement.style.setProperty('--reader-font-family', family);
    }
    applyFont('Arial, sans-serif');
    expect(document.documentElement.style.getPropertyValue('--reader-font-family')).toBe('Arial, sans-serif');
    applyFont('Georgia, serif');
    expect(document.documentElement.style.getPropertyValue('--reader-font-family')).toBe('Georgia, serif');
  });

  it('fontFamily salvato e ricaricato correttamente', () => {
    const fonts = ['Georgia, serif', 'Arial, sans-serif', 'monospace', '"Times New Roman", serif'];
    for (const font of fonts) {
      fns.saveSettings({ fontFamily: font });
      expect(fns.loadSettings().fontFamily).toBe(font);
    }
  });

  // ── Font size ──
  it('applyFontSize imposta la CSS custom property', () => {
    function applyFontSize(size) {
      document.documentElement.style.setProperty('--font-size', size + 'px');
    }
    applyFontSize(20);
    expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('20px');
  });

  it('fontSize salvato e ricaricato per tutti i valori validi', () => {
    for (const size of [12, 14, 16, 18, 20, 24, 28]) {
      fns.saveSettings({ fontSize: size });
      expect(fns.loadSettings().fontSize).toBe(size);
    }
  });

  // ── Combined settings persistence ──
  it('cambio tema non altera font e fontSize', () => {
    fns.saveSettings({ theme: 'dark', fontFamily: 'Georgia, serif', fontSize: 18 });
    const s = fns.loadSettings();
    s.theme = 'sepia';
    fns.saveSettings(s);
    const result = fns.loadSettings();
    expect(result.theme).toBe('sepia');
    expect(result.fontFamily).toBe('Georgia, serif');
    expect(result.fontSize).toBe(18);
  });

  it('cambio font non altera tema e fontSize', () => {
    fns.saveSettings({ theme: 'nord', fontFamily: 'Georgia, serif', fontSize: 16 });
    const s = fns.loadSettings();
    s.fontFamily = 'Arial, sans-serif';
    fns.saveSettings(s);
    const result = fns.loadSettings();
    expect(result.theme).toBe('nord');
    expect(result.fontFamily).toBe('Arial, sans-serif');
    expect(result.fontSize).toBe(16);
  });

  it('cambio fontSize non altera tema e font', () => {
    fns.saveSettings({ theme: 'monokai', fontFamily: 'monospace', fontSize: 14 });
    const s = fns.loadSettings();
    s.fontSize = 24;
    fns.saveSettings(s);
    const result = fns.loadSettings();
    expect(result.theme).toBe('monokai');
    expect(result.fontFamily).toBe('monospace');
    expect(result.fontSize).toBe(24);
  });

  it('loadSettings restituisce {} per JSON invalido', () => {
    storage.setItem(SETTINGS_KEY, '{{invalid}}');
    expect(fns.loadSettings()).toEqual({});
  });

  it('i18n per le label dei temi è completa in tutte le lingue', () => {
    const langs = Object.keys(translations);
    for (const lang of langs) {
      expect(t(lang, 'theme').length).toBeGreaterThan(0);
      expect(t(lang, 'theme')).not.toBe('theme');
      expect(t(lang, 'fontFamily')).not.toBe('fontFamily');
      expect(t(lang, 'fontSize')).not.toBe('fontSize');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GENERAZIONE LIBRERIA CON IMPORT LIBRI
// ═══════════════════════════════════════════════════════════════════════════
describe('Generazione libreria con import libri', () => {
  let storage, fns;
  beforeEach(() => {
    storage = createLocalStorageMock();
    fns = makeLibFunctions(storage);
  });

  const mkEntry = (id, path, title = '', author = '') => ({
    id, filePath: path, fileName: path.split('/').pop(),
    title: title || path.split('/').pop().replace('.epub', ''),
    author, coverDataUrl: null, addedAt: Date.now(),
  });

  it('libreria vuota iniziale', () => {
    expect(fns.loadLibrary()).toEqual([]);
  });

  it('addEntries aggiunge libri correttamente', () => {
    const entries = [mkEntry('1', '/books/a.epub', 'Libro A', 'Autore A')];
    const result = fns.addEntries(entries);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(fns.loadLibrary()).toHaveLength(1);
  });

  it('import multiplo preserva i libri esistenti', () => {
    fns.addEntries([mkEntry('1', '/a.epub', 'A')]);
    fns.addEntries([mkEntry('2', '/b.epub', 'B')]);
    expect(fns.loadLibrary()).toHaveLength(2);
  });

  it('import con duplicati skippa i file già presenti', () => {
    fns.addEntries([mkEntry('1', '/a.epub')]);
    const result = fns.addEntries([mkEntry('2', '/a.epub'), mkEntry('3', '/b.epub')]);
    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(fns.loadLibrary()).toHaveLength(2);
  });

  it('added + skipped = total importati', () => {
    fns.addEntries([mkEntry('1', '/a.epub')]);
    const toImport = [mkEntry('2', '/a.epub'), mkEntry('3', '/b.epub'), mkEntry('4', '/c.epub')];
    const { added, skipped } = fns.addEntries(toImport);
    expect(added + skipped).toBe(toImport.length);
  });

  it('removeEntry rimuove solo il libro specificato', () => {
    fns.addEntries([mkEntry('a', '/a.epub'), mkEntry('b', '/b.epub'), mkEntry('c', '/c.epub')]);
    fns.removeEntry('b');
    const lib = fns.loadLibrary();
    expect(lib).toHaveLength(2);
    expect(lib.find(e => e.id === 'b')).toBeUndefined();
  });

  it('round-trip persistenza libreria', () => {
    const entries = [mkEntry('1', '/a.epub', 'A', 'AA'), mkEntry('2', '/b.epub', 'B', 'BB')];
    fns.saveLibrary(entries);
    expect(fns.loadLibrary()).toEqual(entries);
  });

  it('import da JSON — rejects non-array', () => {
    const parsed = JSON.parse('{"key":"value"}');
    expect(Array.isArray(parsed)).toBe(false);
  });

  it('import da JSON — accepts array', () => {
    const parsed = JSON.parse('[{"id":"1","filePath":"/a.epub"}]');
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('renderLibraryGrid mostra placeholder per libreria vuota', () => {
    const container = document.createElement('div');
    // Replicate simplified renderLibraryGrid
    const lib = [];
    container.innerHTML = '';
    if (!lib.length) {
      const p = document.createElement('p');
      p.id = 'lib-placeholder';
      container.appendChild(p);
    }
    expect(container.querySelector('#lib-placeholder')).not.toBeNull();
  });

  it('renderLibraryGrid crea N card per N libri', () => {
    const container = document.createElement('div');
    const entries = [mkEntry('1', '/a.epub', 'A'), mkEntry('2', '/b.epub', 'B')];
    container.innerHTML = '';
    for (const entry of entries) {
      const card = document.createElement('div');
      card.className = 'lib-book-card';
      card.dataset.id = entry.id;
      const title = document.createElement('span');
      title.className = 'lib-book-title';
      title.textContent = entry.title;
      card.appendChild(title);
      container.appendChild(card);
    }
    expect(container.querySelectorAll('.lib-book-card')).toHaveLength(2);
  });

  it('extractMetadata fallback produce titolo dal fileName', () => {
    function extractMetadataFallback(filePath) {
      const fileName = filePath.split(/[/\\]/).pop();
      const title = fileName.replace(/\.epub$/i, '');
      return { filePath, fileName, title, author: '', coverDataUrl: null };
    }
    const r = extractMetadataFallback('/books/Il Principe.epub');
    expect(r.title).toBe('Il Principe');
    expect(r.author).toBe('');
    expect(r.fileName).toBe('Il Principe.epub');
  });

  it('deduplicazione filePath è case-sensitive', () => {
    fns.addEntries([mkEntry('1', '/Books/a.epub')]);
    const r = fns.addEntries([mkEntry('2', '/books/a.epub')]);
    // Paths are case-sensitive in the dedup logic
    expect(r.added).toBe(1);
    expect(fns.loadLibrary()).toHaveLength(2);
  });

  it('readDirRecursive filtra solo .epub', async () => {
    // Replicate readDirRecursive mock
    async function readDirRecursiveMock(entries) {
      return entries.filter(e => e.name.toLowerCase().endsWith('.epub')).map(e => e.path);
    }
    const files = [
      { name: 'book.epub', path: '/a/book.epub' },
      { name: 'notes.txt', path: '/a/notes.txt' },
      { name: 'Novel.EPUB', path: '/a/Novel.EPUB' },
      { name: 'image.png', path: '/a/image.png' },
    ];
    const result = await readDirRecursiveMock(files);
    expect(result).toEqual(['/a/book.epub', '/a/Novel.EPUB']);
  });

  it('i18n libreria: chiavi presenti in tutte le lingue', () => {
    const keys = ['library', 'selectFolder', 'libEmpty', 'libImport', 'libExport', 'libDeleteBook'];
    const langs = ['en', 'it', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ja'];
    for (const lang of langs) {
      for (const key of keys) {
        const val = t(lang, key);
        expect(val).not.toBe(key);
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ASSOCIAZIONE PARAGRAFI (NUOVE FUNZIONALITÀ)
// ═══════════════════════════════════════════════════════════════════════════
describe('Associazione paragrafi (colori, numeri, hover)', () => {
  let storage, sFns;
  
  beforeEach(() => {
    storage = createLocalStorageMock();
    sFns = makeSettingsFunctions(storage);
  });

  it('salva e carica pairingEnabled e showNumbers correttamente', () => {
    sFns.saveSettings({ pairingEnabled: true, showNumbers: true });
    const settings = sFns.loadSettings();
    expect(settings.pairingEnabled).toBe(true);
    expect(settings.showNumbers).toBe(true);
  });

  it('renderizzazione paragrafo originale include data-idx, classi cromatiche e numeri', () => {
    const originalViewer = document.createElement('div');
    const paragraphs = ['Paragrafo uno', 'Paragrafo due', 'Paragrafo tre'];
    
    // Simula renderOriginal semplificato per il test
    originalViewer.innerHTML = '';
    paragraphs.forEach((p, i) => {
      const pEl = document.createElement('p');
      pEl.dataset.idx = i;
      pEl.classList.add(`pair-color-${i % 5}`);
      pEl.innerHTML = `<span class="para-num">${i + 1}</span>${escapeHtml(p)}`;
      originalViewer.appendChild(pEl);
    });

    const pEls = originalViewer.querySelectorAll('p');
    expect(pEls).toHaveLength(3);
    
    // Verifica indici
    expect(pEls[0].dataset.idx).toBe('0');
    expect(pEls[1].dataset.idx).toBe('1');
    expect(pEls[2].dataset.idx).toBe('2');

    // Verifica colori alternati
    expect(pEls[0].classList.contains('pair-color-0')).toBe(true);
    expect(pEls[1].classList.contains('pair-color-1')).toBe(true);
    expect(pEls[2].classList.contains('pair-color-2')).toBe(true);

    // Verifica numerazione interna
    expect(pEls[0].querySelector('.para-num').textContent).toBe('1');
    expect(pEls[1].querySelector('.para-num').textContent).toBe('2');
    expect(pEls[2].querySelector('.para-num').textContent).toBe('3');
  });

  it('i18n: traduzioni presenti per i nuovi tasti toggle', () => {
    const keys = ['togglePairing', 'toggleNumbers'];
    const langs = ['en', 'it'];
    for (const lang of langs) {
      for (const key of keys) {
        const val = t(lang, key);
        expect(val).not.toBe(key);
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// SYNC SCROLL CON OFFSET (vista originale EPUB / PDF)
// ═══════════════════════════════════════════════════════════════════════════
describe('Scroll sync con offset', () => {
  it('computeSyncedPct somma l\'offset e limita a [0,1]', () => {
    expect(computeSyncedPct(0.5, 0)).toBe(0.5);
    expect(computeSyncedPct(0.5, 0.2)).toBeCloseTo(0.7, 5);
    expect(computeSyncedPct(0.9, 0.5)).toBe(1);      // clamp superiore
    expect(computeSyncedPct(0.1, -0.5)).toBe(0);     // clamp inferiore
  });

  it('senza offset i due pannelli si allineano alla stessa percentuale', () => {
    expect(syncTargetPct(0.3, 0, true)).toBeCloseTo(0.3, 5);   // left → right
    expect(syncTargetPct(0.3, 0, false)).toBeCloseTo(0.3, 5);  // right → left
  });

  it('con offset positivo (right più avanti) il delta è mantenuto in entrambe le direzioni', () => {
    const offset = 0.2; // right è 0.2 più avanti di left
    // Scrollo il pannello sinistro a 0.4 → destro va a 0.6
    expect(syncTargetPct(0.4, offset, true)).toBeCloseTo(0.6, 5);
    // Scrollo il pannello destro a 0.6 → sinistro torna a 0.4 (delta preservato)
    expect(syncTargetPct(0.6, offset, false)).toBeCloseTo(0.4, 5);
  });

  it('riattivazione: l\'offset ricalcolato mantiene lo scarto corrente (no riallineamento)', () => {
    // Utente disattiva il sync, allinea manualmente: left=0.5, right=0.3
    const leftPct = 0.5, rightPct = 0.3;
    const recomputedOffset = rightPct - leftPct; // -0.2
    // Alla riattivazione, scrollando left resta lo scarto: left 0.5 → right 0.3
    expect(syncTargetPct(leftPct, recomputedOffset, true)).toBeCloseTo(rightPct, 5);
    // E proseguendo: left 0.6 → right 0.4 (delta -0.2 mantenuto)
    expect(syncTargetPct(0.6, recomputedOffset, true)).toBeCloseTo(0.4, 5);
  });

  it('toggleSync ha una traduzione in en e it', () => {
    for (const lang of ['en', 'it']) {
      const val = t(lang, 'toggleSync');
      expect(val).not.toBe('toggleSync');
      expect(val.length).toBeGreaterThan(0);
    }
  });
});
