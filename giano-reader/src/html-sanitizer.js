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

/**
 * CSS properties kept in inline styles: text and box formatting only. Anything
 * that can load a resource (`background`, `content`, `cursor`, …) or take the
 * element out of the text flow to cover the app's own UI (`position`,
 * `z-index`, …) is left out.
 */
const ALLOWED_STYLE_PROPS = new Set([
  'color', 'background-color', 'opacity',
  'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight',
  'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-decoration', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-color', 'text-transform',
  'text-shadow', 'vertical-align', 'white-space', 'word-break', 'overflow-wrap',
  'word-wrap', 'hyphens', 'direction', 'unicode-bidi', 'writing-mode',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-radius',
  'border-collapse', 'border-spacing',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'display', 'float', 'clear', 'visibility',
  'list-style', 'list-style-type', 'list-style-position',
  'page-break-before', 'page-break-after', 'page-break-inside',
  'break-before', 'break-after', 'break-inside',
  // SVG presentation
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stop-color',
  'stop-opacity', 'text-anchor',
]);

/** Functions allowed in a style value; any other `name(` drops the declaration. */
const ALLOWED_STYLE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc']);

function isSafeStyleValue(value) {
  // Backslash: CSS escapes can spell a forbidden word (`\75rl(`). The other
  // characters never appear in the plain formatting values allowed here.
  if (/[\\<>@{}]/.test(value) || /\/\*/.test(value)) return false;
  for (const match of value.matchAll(/([a-z-]*)\s*\(/gi)) {
    if (!ALLOWED_STYLE_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  return true;
}

/**
 * Filters an inline style: keeps only the declarations whose property is in
 * `ALLOWED_STYLE_PROPS` and whose value is plain formatting. A whitelist
 * instead of a list of forbidden patterns, which CSS escapes can get around.
 * @param {string} value content of a `style` attribute
 * @returns {string} the filtered style, empty when nothing is left
 */
export function sanitizeStyle(value) {
  if (typeof value !== 'string') return '';
  const kept = [];
  let dropped = false;
  for (const declaration of value.split(';')) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(':');
    const prop = colon < 0 ? '' : declaration.slice(0, colon).trim().toLowerCase();
    const val = colon < 0 ? '' : declaration.slice(colon + 1).trim();
    if (!val || !ALLOWED_STYLE_PROPS.has(prop) || !isSafeStyleValue(val)) {
      dropped = true;
      continue;
    }
    kept.push(`${prop}: ${val}`);
  }
  // Nothing removed: the style is returned as written in the book
  return dropped ? kept.join('; ') : value.trim();
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
      const style = sanitizeStyle(attr.value);
      keep = style !== '';
      if (keep && style !== attr.value) el.setAttribute(attr.name, style);
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
