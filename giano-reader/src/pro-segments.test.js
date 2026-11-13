import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { segmentMarker, buildNumberedBatch, parseNumberedBatch, stripSegmentMarkers } from './pro-segments.js';

describe('buildNumberedBatch', () => {
  it('puts a numbered marker in front of each paragraph', () => {
    expect(buildNumberedBatch(['Hello.', 'World.'])).toBe('⟦1⟧ Hello.\n\n⟦2⟧ World.');
  });
});

describe('parseNumberedBatch', () => {
  it('realigns a well-formed answer', () => {
    expect(parseNumberedBatch('⟦1⟧ Ciao.\n\n⟦2⟧ Mondo.', 2)).toEqual(['Ciao.', 'Mondo.']);
  });

  it('realigns even when the model merges the paragraphs on one line', () => {
    expect(parseNumberedBatch('⟦1⟧ - Mi manchi. ⟦2⟧ - Anche tu. ⟦3⟧ - Lo so.', 3))
      .toEqual(['- Mi manchi.', '- Anche tu.', '- Lo so.']);
  });

  it('realigns when a paragraph was re-wrapped with blank lines inside', () => {
    expect(parseNumberedBatch('⟦1⟧ Prima parte.\n\nSeconda parte.\n\n⟦2⟧ Fine.', 2))
      .toEqual(['Prima parte.\n\nSeconda parte.', 'Fine.']);
  });

  it('accepts markers with spaces and out of order', () => {
    expect(parseNumberedBatch('⟦ 2 ⟧ due\n⟦ 1 ⟧ uno', 2)).toEqual(['uno', 'due']);
  });

  it('ignores an introduction before the first marker', () => {
    expect(parseNumberedBatch('Here is the translation:\n⟦1⟧ uno\n⟦2⟧ due', 2)).toEqual(['uno', 'due']);
  });

  it('leaves inline image tokens alone', () => {
    expect(parseNumberedBatch('⟦1⟧ Testo ⟦IMG0⟧ con immagine\n\n⟦2⟧ Altro', 2))
      .toEqual(['Testo ⟦IMG0⟧ con immagine', 'Altro']);
  });

  it('returns null when a marker is missing, repeated, out of range or empty', () => {
    expect(parseNumberedBatch('⟦1⟧ uno due', 2)).toBeNull();
    expect(parseNumberedBatch('⟦1⟧ uno ⟦1⟧ due', 2)).toBeNull();
    expect(parseNumberedBatch('⟦1⟧ uno ⟦3⟧ tre', 2)).toBeNull();
    expect(parseNumberedBatch('⟦1⟧ uno ⟦2⟧ due ⟦3⟧ tre', 2)).toBeNull();
    expect(parseNumberedBatch('⟦1⟧ ⟦2⟧ due', 2)).toBeNull();
    expect(parseNumberedBatch('nessun marcatore', 1)).toBeNull();
    expect(parseNumberedBatch(undefined, 1)).toBeNull();
  });

  it('round-trips any batch of paragraphs', () => {
    const paragraph = fc.string({ minLength: 1, maxLength: 80 })
      .map((s) => s.replace(/[⟦⟧]/g, '').trim())
      .filter((s) => s.length > 0);
    fc.assert(
      fc.property(fc.array(paragraph, { minLength: 1, maxLength: 12 }), (paragraphs) => {
        expect(parseNumberedBatch(buildNumberedBatch(paragraphs), paragraphs.length)).toEqual(paragraphs);
      }),
    );
  });
});

describe('stripSegmentMarkers', () => {
  it('removes paragraph markers but not image tokens', () => {
    expect(stripSegmentMarkers(`${segmentMarker(1)} Testo ⟦IMG0⟧ fine`)).toBe('Testo ⟦IMG0⟧ fine');
  });
});
