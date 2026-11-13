import { describe, it, expect } from 'vitest';
import {
  sanitizeHtml,
  sanitizeTree,
  sanitizeStyle,
  isExternalHttpUrl,
  isSafeResourceUrl,
  escapeHtmlText,
} from './html-sanitizer.js';

function parse(html) {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

describe('sanitizeHtml', () => {
  it('keeps basic formatting and text', () => {
    expect(sanitizeHtml('<em>a</em> <strong class="x">b</strong>')).toBe('<em>a</em> <strong class="x">b</strong>');
  });

  it('removes every event-handler attribute, not just a few', () => {
    const out = sanitizeHtml('<span onfocus="x()" onpointerenter="y()" tabindex="1" id="s">t</span>');
    expect(out).toBe('<span id="s">t</span>');
  });

  it('drops scriptable elements with their content', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<object data="x.swf"></object>',
      '<embed src="x">',
      '<form action="https://evil"><input name="a"></form>',
      '<svg><animate onbegin="alert(1)" attributeName="x"/></svg>',
      '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
      '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
      '<style>body{display:none}</style>',
    ]) {
      const out = sanitizeHtml(bad);
      expect(out, bad).not.toMatch(/script|onerror|onbegin|<iframe|<object|<embed|<form|<input|foreignobject|<math|<style/i);
    }
  });

  it('unwraps unknown elements but keeps their text', () => {
    expect(sanitizeHtml('<custom-tag data-x="1">hello <em>w</em></custom-tag>')).toBe('hello <em>w</em>');
  });

  it('never keeps href on links (links use data-epub-href)', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)" data-epub-href="ch2.xhtml">n</a>'))
      .toBe('<a data-epub-href="ch2.xhtml">n</a>');
  });

  it('drops unsafe image sources and keeps safe ones', () => {
    expect(sanitizeHtml('<img src="javascript:alert(1)" alt="a">')).toBe('<img alt="a">');
    expect(sanitizeHtml('<img src="blob:http://x/1" alt="a">')).toBe('<img src="blob:http://x/1" alt="a">');
    expect(sanitizeHtml('<img src="data:image/png;base64,AA" alt="">')).toContain('src="data:image/png');
    expect(sanitizeHtml('<img src="data:text/html,x">')).toBe('<img>');
  });

  it('drops inline styles that load resources', () => {
    expect(sanitizeHtml('<span style="text-align:center">a</span>')).toBe('<span style="text-align:center">a</span>');
    expect(sanitizeHtml('<span style="background:url(https://evil/x)">a</span>')).toBe('<span>a</span>');
  });

  it('keeps only formatting declarations of an inline style', () => {
    expect(sanitizeStyle('color: red; font-weight: bold')).toBe('color: red; font-weight: bold');
    expect(sanitizeStyle('color: rgb(10, 20, 30); margin: calc(1em + 2px)'))
      .toBe('color: rgb(10, 20, 30); margin: calc(1em + 2px)');
    // Mixed: the safe declarations survive, the others are removed
    expect(sanitizeStyle('color: red; background: url(https://evil/x); text-align: center'))
      .toBe('color: red; text-align: center');
    expect(sanitizeStyle('position: fixed; top: 0; left: 0; z-index: 9999; width: 100%'))
      .toBe('width: 100%');
  });

  it('is not fooled by CSS escapes, comments or unknown functions', () => {
    for (const bad of [
      'background-color: \\75rl(https://evil/x)',
      'color: r\\65 d',
      'width: expression(alert(1))',
      'color: red /* x */',
      'font-family: image-set("x.png" 1x)',
      'color: var(--x)',
      'behavior: url(x.htc)',
      '-moz-binding: url(x.xml#y)',
      'content: "x"',
      'cursor: url(x.cur), auto',
      '@import "x.css"',
      'not a declaration',
    ]) {
      expect(sanitizeStyle(bad), bad).toBe('');
    }
    expect(sanitizeHtml('<span style="background-color:\\75rl(https://evil/x)">a</span>')).toBe('<span>a</span>');
  });

  it('removes comments', () => {
    expect(sanitizeHtml('a<!-- hidden -->b')).toBe('ab');
  });
});

describe('sanitizeTree', () => {
  it('filters the root attributes only when includeRoot is set', () => {
    const root = parse('<svg onload="alert(1)" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>').firstChild;
    sanitizeTree(root);
    expect(root.getAttribute('onload')).toBe('alert(1)');
    sanitizeTree(root, { includeRoot: true });
    expect(root.getAttribute('onload')).toBeNull();
    expect(root.getAttribute('viewBox')).toBe('0 0 1 1');
  });
});

describe('isExternalHttpUrl', () => {
  it('accepts http(s) URLs with a host', () => {
    expect(isExternalHttpUrl('https://example.com/a?x=1&y=2')).toBe(true);
    expect(isExternalHttpUrl('http://example.com')).toBe(true);
  });

  it('rejects other schemes, whitespace and relative paths', () => {
    for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'chapter2.xhtml', 'https://a.com/ &calc', 'https://a.com/\n', '', null]) {
      expect(isExternalHttpUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe('isSafeResourceUrl', () => {
  it('allows relative paths and blob/data-image/http URLs', () => {
    for (const ok of ['images/a.png', '../a.jpg', 'blob:x', 'data:image/png;base64,A', 'https://x/a.png', '']) {
      expect(isSafeResourceUrl(ok), ok).toBe(true);
    }
  });

  it('blocks script schemes even with obfuscation', () => {
    for (const bad of ['javascript:x', ' JaVa\tScRiPt:x', 'vbscript:x', 'data:text/html,x']) {
      expect(isSafeResourceUrl(bad), bad).toBe(false);
    }
  });
});

describe('escapeHtmlText', () => {
  it('escapes quotes so the result is safe inside attributes', () => {
    expect(escapeHtmlText(`a"b'c<d>&`)).toBe('a&quot;b&#39;c&lt;d&gt;&amp;');
    expect(escapeHtmlText(null)).toBe('');
  });
});
