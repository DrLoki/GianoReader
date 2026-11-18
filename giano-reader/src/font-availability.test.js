import { describe, it, expect } from 'vitest';
import { primaryFamily, isFontAvailable, hideMissingFontOptions } from './font-availability.js';

// Fake measure: generic families have fixed widths; an installed font has its
// own width, a missing one falls back to the generic family after it.
const INSTALLED = { 'Arial Narrow': 700 };
const GENERIC = { monospace: 1200, serif: 1000, 'sans-serif': 1050 };
function fakeMeasure(font) {
  const list = font.replace(/^72px /, '').split(',').map(primaryFamily);
  for (const f of list) {
    if (INSTALLED[f]) return INSTALLED[f];
    if (GENERIC[f]) return GENERIC[f];
  }
  return 0;
}

describe('font-availability', () => {
  it('primaryFamily takes the first family without quotes', () => {
    expect(primaryFamily("'Arial Narrow', 'Bahnschrift SemiCondensed', sans-serif")).toBe('Arial Narrow');
    expect(primaryFamily('"Segoe UI", Tahoma')).toBe('Segoe UI');
    expect(primaryFamily('Georgia, serif')).toBe('Georgia');
  });

  it('detects installed and missing fonts', () => {
    expect(isFontAvailable('Arial Narrow', fakeMeasure)).toBe(true);
    expect(isFontAvailable('Avenir Next Condensed', fakeMeasure)).toBe(false);
    expect(isFontAvailable('sans-serif', fakeMeasure)).toBe(true);
  });

  it('hides missing fonts but keeps bundled and selected ones', () => {
    const select = document.createElement('select');
    select.innerHTML = `
      <option value="'Arial Narrow', sans-serif">Arial Narrow</option>
      <option value="'Avenir Next Condensed', sans-serif">Avenir Next Condensed</option>
      <option value="'DejaVu Sans Condensed', sans-serif">DejaVu Sans Condensed</option>
      <option value="'Roboto Condensed Variable', sans-serif" data-bundled>Roboto Condensed</option>`;
    select.value = "'DejaVu Sans Condensed', sans-serif";
    const missing = hideMissingFontOptions([select], fakeMeasure);
    expect(missing.sort()).toEqual(['Avenir Next Condensed', 'DejaVu Sans Condensed']);
    expect([...select.options].map(o => o.hidden)).toEqual([false, true, false, false]);
  });

  it('hides nothing when fonts cannot be measured', () => {
    const select = document.createElement('select');
    select.innerHTML = '<option value="Nope, serif">Nope</option>';
    expect(hideMissingFontOptions([select], null)).toEqual([]);
    expect(select.options[0].hidden).toBe(false);
  });
});
