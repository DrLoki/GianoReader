import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  parseChapter, serializeChapter, translateChapterDocument, buildTranslatedEpub,
  buildEpubFromChapters, translatedFileName, escapeXml,
} from './book-export.js';

// Same rule as extractTextWithInlineImages in main.js: text with ⟦IMGn⟧ placeholders
function extractText(el) {
  let n = 0;
  const walk = (node) => {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1) {
        if (child.tagName.toLowerCase() === 'img') out += ` \u27E6IMG${n++}\u27E7 `;
        else out += walk(child);
      }
    });
    return out;
  };
  return walk(el).replace(/\s+/g, ' ').trim();
}

const chapter = (body) => '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title>'
  + '<link rel="stylesheet" href="style.css"/></head>'
  + `<body>${body}</body></html>`;

function translate(body, dictionary) {
  const { doc, xml } = parseChapter(chapter(body));
  const result = translateChapterDocument(doc, extractText, (text) => dictionary[text]);
  return { doc, xml, result };
}

describe('translateChapterDocument', () => {
  it('replaces the text of each paragraph and keeps the rest of the page', () => {
    const { doc, result } = translate(
      '<h1 class="t">Title</h1><p class="x">Hello <em>world</em></p><p>Untranslated</p>',
      { Title: 'Titolo', 'Hello world': 'Ciao mondo' },
    );
    expect(result).toEqual({ replaced: 2, missing: 1 });
    expect(doc.querySelector('h1').textContent).toBe('Titolo');
    expect(doc.querySelector('h1').getAttribute('class')).toBe('t');
    expect(doc.querySelector('p.x').textContent).toBe('Ciao mondo');
    expect(doc.querySelectorAll('p')[1].textContent).toBe('Untranslated');
    expect(doc.querySelector('link').getAttribute('href')).toBe('style.css');
  });

  it('puts inline images back at their placeholders', () => {
    const { doc } = translate(
      '<p>Before <img src="a.png"/> after</p>',
      { 'Before \u27E6IMG0\u27E7 after': 'Prima \u27E6IMG0\u27E7 dopo' },
    );
    const p = doc.querySelector('p');
    expect(p.textContent.replace(/\s+/g, ' ').trim()).toBe('Prima dopo');
    expect(p.querySelector('img').getAttribute('src')).toBe('a.png');
    expect(p.childNodes[1].nodeName.toLowerCase()).toBe('img');
  });

  it('keeps an image whose placeholder the translation lost', () => {
    const { doc } = translate(
      '<p>Text <img src="a.png"/></p>',
      { 'Text \u27E6IMG0\u27E7': 'Testo' },
    );
    expect(doc.querySelector('p img')).not.toBeNull();
  });

  it('translates nested paragraphs once, keeping the list structure', () => {
    const { doc, result } = translate(
      '<ul><li>parent<ul><li>child</li></ul></li></ul>',
      { parent: 'genitore', child: 'figlio' },
    );
    expect(result.replaced).toBe(2);
    const outer = doc.querySelector('li');
    expect(outer.firstChild.nodeValue).toBe('genitore');
    expect(outer.querySelector('li').textContent).toBe('figlio');
    expect(doc.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('parseChapter / serializeChapter', () => {
  it('keeps the XML declaration of an XHTML chapter', () => {
    const source = chapter('<p>x</p>');
    const { doc, xml } = parseChapter(source);
    expect(xml).toBe(true);
    expect(serializeChapter(doc, xml, source).startsWith('<?xml')).toBe(true);
  });

  it('falls back to HTML for a chapter that is not well-formed XML', () => {
    const { doc, xml } = parseChapter('<html><body><p>a<br></p></body></html>');
    expect(xml).toBe(false);
    expect(doc.querySelector('p').textContent).toBe('a');
  });
});

async function sampleEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<package><metadata><dc:title>T</dc:title><dc:language>en</dc:language></metadata></package>');
  zip.file('OEBPS/Text/ch 1.xhtml', chapter('<p>Hello</p><p>Bye</p>'));
  zip.file('OEBPS/images/a.png', new Uint8Array([1, 2, 3]));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('buildTranslatedEpub', () => {
  it('translates the chapters and keeps every other file', async () => {
    const progress = [];
    const { bytes, replaced, missing } = await buildTranslatedEpub(JSZip, await sampleEpub(), {
      chapterPaths: ['/OEBPS/Text/ch%201.xhtml'],
      extractText,
      lookup: (text) => ({ Hello: 'Ciao' })[text],
      lang: 'it',
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect({ replaced, missing }).toEqual({ replaced: 1, missing: 1 });
    expect(progress).toEqual([[1, 1]]);

    const out = await JSZip.loadAsync(bytes);
    expect(Object.keys(out.files)[0]).toBe('mimetype');
    const xhtml = await out.file('OEBPS/Text/ch 1.xhtml').async('string');
    expect(xhtml).toContain('<p>Ciao</p>');
    expect(xhtml).toContain('<p>Bye</p>');
    expect(xhtml).toContain('lang="it"');
    expect(await out.file('OEBPS/content.opf').async('string')).toContain('<dc:language>it</dc:language>');
    expect(Array.from(await out.file('OEBPS/images/a.png').async('uint8array'))).toEqual([1, 2, 3]);
  });
});

describe('buildEpubFromChapters', () => {
  it('builds a valid EPUB with one document per chapter', async () => {
    const bytes = await buildEpubFromChapters(JSZip, {
      title: 'Libro & <co>', author: 'A', lang: 'ar',
      chapters: [{ title: 'Uno', paragraphs: ['a < b', 'c'] }, { title: 'Due', paragraphs: [] }],
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(await zip.file('mimetype').async('string')).toBe('application/epub+zip');
    const opf = await zip.file('OEBPS/content.opf').async('string');
    expect(opf).toContain('<dc:title>Libro &amp; &lt;co&gt;</dc:title>');
    expect(opf).toContain('<itemref idref="ch2"/>');
    const ch1 = await zip.file('OEBPS/chapter-1.xhtml').async('string');
    expect(ch1).toContain('<p>a &lt; b</p>');
    expect(ch1).toContain('dir="rtl"');
    // Each chapter is well-formed XHTML
    expect(parseChapter(ch1).xml).toBe(true);
  });
});

describe('helpers', () => {
  it('names the translated file after the original', () => {
    expect(translatedFileName('C:\\Books\\Il nome.epub', 'en')).toBe('Il nome (en).epub');
    expect(translatedFileName('/x/report.pdf', 'it')).toBe('report (it).epub');
  });

  it('escapes XML special characters', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  });
});
