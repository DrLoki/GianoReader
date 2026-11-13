import { describe, it, expect } from 'vitest';
import { TEXT_BLOCK_SELECTOR, ownTextSource } from './text-blocks.js';

/** Texts of the blocks of `html`, the way a chapter is read. */
function blockTexts(html) {
  const body = document.createElement('div');
  body.innerHTML = html;
  return Array.from(body.querySelectorAll(TEXT_BLOCK_SELECTOR))
    .map((el) => ownTextSource(el))
    .map((source) => (source ? (source.textContent || '').trim() : ''))
    .filter((text) => text.length > 0);
}

describe('ownTextSource', () => {
  it('returns the element itself when it has no nested block', () => {
    const p = document.createElement('p');
    p.innerHTML = 'plain <em>text</em>';
    expect(ownTextSource(p)).toBe(p);
  });

  it('does not repeat a paragraph inside a list item', () => {
    expect(blockTexts('<ul><li><p>one</p></li><li><p>two</p></li></ul>')).toEqual(['one', 'two']);
  });

  it('does not repeat the items of a nested list', () => {
    expect(blockTexts('<ul><li>parent<ul><li>child a</li><li>child b</li></ul></li></ul>'))
      .toEqual(['parent', 'child a', 'child b']);
  });

  it('does not repeat the paragraphs of a blockquote', () => {
    expect(blockTexts('<blockquote><p>first</p><p>second</p></blockquote>')).toEqual(['first', 'second']);
  });

  it('keeps a blockquote that only holds inline text', () => {
    expect(blockTexts('<blockquote><span>message</span></blockquote>')).toEqual(['message']);
  });

  it('keeps an image that sits beside nested blocks', () => {
    const li = document.createElement('li');
    li.innerHTML = '<img src="a.png"><p>caption</p>';
    const source = ownTextSource(li);
    expect(source).not.toBeNull();
    expect(source.querySelector('img')).not.toBeNull();
    expect(source.querySelector('p')).toBeNull();
  });

  it('leaves the original element untouched', () => {
    const li = document.createElement('li');
    li.innerHTML = 'parent<ul><li>child</li></ul>';
    ownTextSource(li);
    expect(li.querySelectorAll('li').length).toBe(1);
  });
});
