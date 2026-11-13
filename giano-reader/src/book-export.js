/**
 * book-export.js
 *
 * Builds the translated copy of a book as an EPUB file.
 *
 * - EPUB books: the original file is copied and, in every chapter, the text of
 *   each paragraph is replaced with its translation. Styles, images, fonts,
 *   table of contents and file structure stay as they are. Inline formatting
 *   inside a translated paragraph (italic, bold, links) is not kept, because a
 *   translation does not map word by word onto the original markup; inline
 *   images are put back where the translation has their placeholder.
 * - PDF books: a new, simple EPUB is built from the translated text of each
 *   chapter or page.
 *
 * Paragraphs are found with the same rules used to read them for translation
 * (`text-blocks.js` and the text extractor passed in by the caller), so the
 * text of each paragraph matches the key of its cached translation.
 *
 * JSZip is passed in by the caller, which keeps this module free of imports
 * that tests would have to mock. DOM access goes through the documents given.
 */
import { TEXT_BLOCK_SELECTOR, ownTextSource } from './text-blocks.js';

/** Placeholder of an inline image in a paragraph text (same as main.js). */
const INLINE_IMG_TOKEN_RE = /⟦\s*IMG\s*(\d+)\s*⟧/g;

/** Languages written right to left. */
const RTL_LANGS = new Set(['ar', 'fa', 'he', 'ur']);

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Parses a chapter file. XHTML first (what EPUB chapters are), HTML when the
 * file is not well-formed XML.
 * @returns {{ doc: Document, xml: boolean }}
 */
export function parseChapter(source) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(source, 'application/xhtml+xml');
  if (!xmlDoc.getElementsByTagName('parsererror').length && xmlDoc.documentElement) {
    return { doc: xmlDoc, xml: true };
  }
  return { doc: parser.parseFromString(source, 'text/html'), xml: false };
}

/** Serialises a chapter parsed with `parseChapter`, keeping its XML declaration. */
export function serializeChapter(doc, xml, original = '') {
  if (!xml) return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  let out = new XMLSerializer().serializeToString(doc);
  const declaration = original.match(/^\s*<\?xml[^>]*\?>/);
  if (declaration && !out.startsWith('<?xml')) out = declaration[0].trim() + '\n' + out;
  return out;
}

/** Images that belong to `el` itself, not to a paragraph nested in it, in document order. */
function ownImages(el) {
  return Array.from(el.querySelectorAll('img')).filter((img) => {
    for (let p = img.parentElement; p && p !== el; p = p.parentElement) {
      if (p.matches(TEXT_BLOCK_SELECTOR)) return false;
    }
    return true;
  });
}

/** True when `node` is, or contains, a paragraph-level element. */
function holdsBlocks(node) {
  return node.nodeType === 1 && (node.matches(TEXT_BLOCK_SELECTOR) || !!node.querySelector(TEXT_BLOCK_SELECTOR));
}

/**
 * Replaces the text of `el` with `translation`, putting its inline images back
 * at their placeholders. Nested paragraphs of a container block are kept.
 */
function replaceParagraph(el, translation) {
  const doc = el.ownerDocument;
  const images = ownImages(el);
  const isContainer = !!el.querySelector(TEXT_BLOCK_SELECTOR);

  // Remove the content that belongs to the paragraph itself
  for (const child of Array.from(el.childNodes)) {
    if (isContainer && holdsBlocks(child)) continue;
    child.remove();
  }

  const nodes = [];
  const used = new Set();
  let last = 0;
  for (const match of translation.matchAll(INLINE_IMG_TOKEN_RE)) {
    if (match.index > last) nodes.push(doc.createTextNode(translation.slice(last, match.index)));
    const index = Number(match[1]);
    if (images[index] && !used.has(index)) {
      nodes.push(images[index]);
      used.add(index);
    }
    last = match.index + match[0].length;
  }
  if (last < translation.length) nodes.push(doc.createTextNode(translation.slice(last)));
  // Images whose placeholder the translation lost go at the end
  images.forEach((img, i) => { if (!used.has(i)) nodes.push(doc.createTextNode(' '), img); });

  const anchor = el.firstChild;
  for (const node of nodes) el.insertBefore(node, anchor);
}

/**
 * Replaces the text of every paragraph of a chapter with its translation.
 *
 * @param {Document} doc
 * @param {(el: Element) => string} extractText  text of a paragraph, exactly as
 *   it was sent for translation
 * @param {(text: string) => string|undefined} lookup  cached translation
 * @returns {{ replaced: number, missing: number }} paragraphs translated, and
 *   paragraphs left in the original language because no translation was found
 */
export function translateChapterDocument(doc, extractText, lookup) {
  const root = doc.body || doc.documentElement;
  const result = { replaced: 0, missing: 0 };
  // Collected first: replacing content must not change what is visited
  const work = [];
  for (const el of Array.from(root.querySelectorAll(TEXT_BLOCK_SELECTOR))) {
    const source = ownTextSource(el);
    if (!source) continue;
    const text = extractText(source);
    if (!text) continue;
    work.push({ el, text });
  }
  for (const { el, text } of work) {
    const translation = lookup(text);
    if (translation === undefined) {
      result.missing++;
      continue;
    }
    replaceParagraph(el, translation);
    result.replaced++;
  }
  return result;
}

/** Sets the language (and direction) of a chapter document. */
function setDocumentLanguage(doc, lang) {
  const html = doc.documentElement;
  html.setAttribute('lang', lang);
  if (html.namespaceURI === XHTML_NS || html.hasAttribute('xml:lang')) {
    html.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', lang);
  }
  if (RTL_LANGS.has(lang.split('-')[0])) html.setAttribute('dir', 'rtl');
  else html.removeAttribute('dir');
}

/** Finds a file in the archive, tolerating a leading slash, percent-encoding and case. */
function findZipFile(zip, path) {
  const candidates = [path, path.replace(/^\/+/, '')];
  try { candidates.push(decodeURIComponent(path.replace(/^\/+/, ''))); } catch { /* malformed */ }
  for (const candidate of candidates) {
    const file = zip.file(candidate);
    if (file) return file;
  }
  const wanted = candidates[candidates.length - 1].toLowerCase();
  const match = Object.keys(zip.files).find((name) => name.toLowerCase() === wanted);
  return match ? zip.file(match) : null;
}

/** Updates `dc:language` in the package document. */
async function setPackageLanguage(zip, lang) {
  const container = zip.file('META-INF/container.xml');
  if (!container) return;
  const opfPath = (await container.async('string')).match(/full-path\s*=\s*"([^"]+)"/)?.[1];
  const opfFile = opfPath && zip.file(opfPath);
  if (!opfFile) return;
  const opf = await opfFile.async('string');
  const updated = /<dc:language[^>]*>[^<]*<\/dc:language>/.test(opf)
    ? opf.replace(/(<dc:language[^>]*>)[^<]*(<\/dc:language>)/, `$1${lang}$2`)
    : opf.replace(/(<\/dc:title>)/, `$1\n    <dc:language>${lang}</dc:language>`);
  zip.file(opfPath, updated);
}

/** Writes the archive as an EPUB: `mimetype` first and uncompressed. */
function generateEpub(zip) {
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

/**
 * Translated copy of an EPUB.
 *
 * @param {any} JSZip  the JSZip constructor
 * @param {ArrayBuffer|Uint8Array} sourceBytes  the original EPUB file
 * @param {{
 *   chapterPaths: string[],              // archive paths of the spine documents
 *   extractText: (el: Element) => string,
 *   lookup: (text: string) => string|undefined,
 *   lang: string,
 *   onProgress?: (done: number, total: number) => void,
 * }} options
 * @returns {Promise<{ bytes: Uint8Array, replaced: number, missing: number }>}
 */
export async function buildTranslatedEpub(JSZip, sourceBytes, { chapterPaths, extractText, lookup, lang, onProgress }) {
  const zip = await JSZip.loadAsync(sourceBytes);
  const totals = { replaced: 0, missing: 0 };
  const seen = new Set();
  for (let i = 0; i < chapterPaths.length; i++) {
    const file = findZipFile(zip, chapterPaths[i]);
    if (file && !seen.has(file.name)) {
      seen.add(file.name);
      const original = await file.async('string');
      const { doc, xml } = parseChapter(original);
      const result = translateChapterDocument(doc, extractText, lookup);
      totals.replaced += result.replaced;
      totals.missing += result.missing;
      if (result.replaced) {
        setDocumentLanguage(doc, lang);
        zip.file(file.name, serializeChapter(doc, xml, original));
      }
    }
    if (onProgress) onProgress(i + 1, chapterPaths.length);
  }
  await setPackageLanguage(zip, lang);
  return { bytes: await generateEpub(zip), ...totals };
}

/** Escapes text for XML content and attributes. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A new EPUB 3 made of plain paragraphs (used for translated PDFs).
 *
 * @param {any} JSZip
 * @param {{
 *   title: string, author?: string, lang: string, identifier?: string,
 *   chapters: Array<{ title: string, paragraphs: string[] }>,
 * }} book
 * @returns {Promise<Uint8Array>}
 */
export async function buildEpubFromChapters(JSZip, { title, author = '', lang, identifier, chapters }) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    + '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
    + '</container>\n');

  const dir = RTL_LANGS.has(lang.split('-')[0]) ? ' dir="rtl"' : '';
  const page = (heading, body) => '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'
    + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}"${dir}>\n`
    + `<head><meta charset="utf-8"/><title>${escapeXml(heading)}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

  const items = chapters.map((ch, i) => ({ id: `ch${i + 1}`, href: `chapter-${i + 1}.xhtml`, ...ch }));
  for (const item of items) {
    const body = [`<h2>${escapeXml(item.title)}</h2>`, ...item.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`)].join('\n');
    zip.file(`OEBPS/${item.href}`, page(item.title, body));
  }
  const navList = items.map((item) => `<li><a href="${item.href}">${escapeXml(item.title)}</a></li>`).join('\n');
  zip.file('OEBPS/nav.xhtml', page(title, `<nav epub:type="toc" id="toc"><h1>${escapeXml(title)}</h1>\n<ol>\n${navList}\n</ol></nav>`));

  const id = identifier || `urn:giano-reader:${Date.now().toString(36)}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">\n'
    + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    + `    <dc:identifier id="book-id">${escapeXml(id)}</dc:identifier>\n`
    + `    <dc:title>${escapeXml(title)}</dc:title>\n`
    + (author ? `    <dc:creator>${escapeXml(author)}</dc:creator>\n` : '')
    + `    <dc:language>${escapeXml(lang)}</dc:language>\n`
    + `    <meta property="dcterms:modified">${modified}</meta>\n`
    + '  </metadata>\n  <manifest>\n'
    + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
    + items.map((item) => `    <item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`).join('\n')
    + '\n  </manifest>\n  <spine>\n'
    + items.map((item) => `    <itemref idref="${item.id}"/>`).join('\n')
    + '\n  </spine>\n</package>\n');

  return generateEpub(zip);
}

/** File name of the translated copy, e.g. "Il nome della rosa (en).epub". */
export function translatedFileName(originalName, lang) {
  const base = String(originalName || 'book').split(/[\\/]/).pop().replace(/\.(epub|pdf)$/i, '') || 'book';
  return `${base} (${lang}).epub`;
}
