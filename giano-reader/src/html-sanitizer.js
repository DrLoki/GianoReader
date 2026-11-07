/**
 * html-sanitizer.js
 *
 * Whitelist-based sanitiser for untrusted EPUB markup that is injected into the
 * main application document (text view, translated panel, image blocks).
 *
 * The desktop window has access to Tauri APIs (filesystem, IPC), so any script
 * that runs there is a full compromise. A denylist ("remove onclick/onerror")
 * is not enough: there are dozens of event attributes and several scriptable
 * elements (<svg><animate>, <iframe>, <object>, <form>, …). Instead every
 * element and attribute must be explicitly allowed.
 *
 * Pure DOM code, no dependencies: works on any Document (including the inert
 * documents produced by DOMParser and jsdom in tests).
 */

/** Elements removed together with all their content. */
const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select',
  'option', 'template', 'noscript', 'portal', 'audio', 'video', 'source',
  'track', 'canvas', 'dialog', 'foreignobject', 'animate', 'animatemotion',
  'animatetransform', 'set', 'use', 'handler', 'listener', 'math',
]);

/** Elements kept (with filtered attributes). Anything else is unwrapped. */
const ALLOWED_TAGS = new Set([
  // inline text
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'big', 'tt', 'font',
  // blocks
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul',
  'ol', 'li', 'dl', 'dt', 'dd', 'hr', 'figure', 'figcaption', 'img', 'table',
  'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'section', 'article', 'aside', 'header', 'footer', 'center', 'picture',
  // static SVG (figures)
  'svg', 'g', 'image', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'text', 'tspan', 'title', 'desc', 'defs', 'lineargradient',
  'radialgradient', 'stop', 'clippath', 'mask', 'symbol',
]);

/** Attributes kept on any allowed element (compared lowercase). */
const ALLOWED_ATTRS = new Set([
  'id', 'class', 'title', 'lang', 'xml:lang', 'dir', 'alt', 'width', 'height',
  'colspan', 'rowspan', 'align', 'valign', 'loading', 'data-epub-href', 'style',
  'start', 'type', 'reversed', 'datetime', 'cite',
  // SVG presentation / geometry
  'viewbox', 'xmlns', 'xmlns:xlink', 'version', 'preserveaspectratio', 'd',
  'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'offset',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'clip-path', 'clip-rule', 'font-size', 'font-family', 'font-weight',
  'text-anchor', 'dx', 'dy',
]);

/** Attributes holding a URL: kept only when the URL is safe. */
const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'srcset']);

/**
 * True for an http(s) URL meant to be opened in the system browser.
 * Rejects whitespace and control characters, which some shells interpret.
 * @param {string} url
 */
export function isExternalHttpUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
}

/**
 * True when a resource URL (img src, svg image href) cannot execute code:
 * blob:, data:image/…, http(s): or a scheme-less relative path.
 * @param {string} value
 */
export function isSafeResourceUrl(value) {
  if (typeof value !== 'string') return false;
  const v = value.replace(/[\s\u0000-\u001f\u007f]/g, '').toLowerCase();
  if (!v) return true;
  if (v.startsWith('blob:') || v.startsWith('http://') || v.startsWith('https://')) return true;
  if (v.startsWith('data:image/')) return true;
  // Relative path: no scheme before the first '/', '?' or '#'
  const head = v.split(/[/?#]/)[0];
  return !head.includes(':');
}

/** Inline styles that load resources or use legacy script hooks are dropped. */
function isSafeStyle(value) {
  return !/url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding/i.test(value);
}

function sanitizeAttributes(el) {
  const tag = el.localName.toLowerCase();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    let keep;
    if (name.startsWith('on')) {
      keep = false;
    } else if (URL_ATTRS.has(name)) {
      // <a href> is never kept: links are re-routed through data-epub-href
      keep = tag !== 'a' && name !== 'srcset' && isSafeResourceUrl(attr.value);
    } else if (name === 'style') {
      keep = isSafeStyle(attr.value);
    } else {
      keep = ALLOWED_ATTRS.has(name);
    }
    if (!keep) el.removeAttribute(attr.name);
  }
}

function sanitizeChildren(parent) {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 8 || child.nodeType === 7) {
      // comments, processing instructions
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.localName.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      child.remove();
      continue;
    }
    sanitizeChildren(child);
    if (ALLOWED_TAGS.has(tag)) {
      sanitizeAttributes(child);
    } else {
      // Unknown or presentational wrapper: keep its (already sanitised) content
      while (child.firstChild) parent.insertBefore(child.firstChild, child);
      child.remove();
    }
  }
}

/**
 * Sanitises an element tree in place. When `includeRoot` is true the root
 * element's own attributes are filtered too (use it when the caller keeps
 * `outerHTML`). A root whose tag is not allowed is left as a container.
 * @param {Element} root
 * @param {{ includeRoot?: boolean }} [options]
 * @returns {Element} the same root
 */
export function sanitizeTree(root, { includeRoot = false } = {}) {
  if (!root) return root;
  sanitizeChildren(root);
  if (includeRoot && root.nodeType === 1) sanitizeAttributes(root);
  return root;
}

/**
 * Sanitises an HTML string, parsing it in an inert document so nothing loads
 * or runs during parsing.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  sanitizeTree(doc.body);
  return doc.body.innerHTML;
}

/**
 * Escapes a string for safe use in HTML text or a quoted attribute.
 * @param {unknown} value
 */
export function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
