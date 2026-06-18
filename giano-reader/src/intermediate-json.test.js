import { describe, it, expect } from 'vitest';
import {
  parseIntermediateJson,
  prettyPrint,
  validateSchemaVersion,
  BLOCK_TYPES,
} from './intermediate-json.js';

// --- Helper: minimal valid Intermediate_JSON ---
function validJson(overrides = {}) {
  return {
    schema_version: '1.0',
    page_number: 1,
    metadata: { title: 'Test', total_pages: 10, language: 'en' },
    blocks: [
      {
        type: 'paragraph',
        text: 'Hello world',
        segment_id: 'p1_b0',
        style: { heading_level: null, emphasis: [] },
      },
    ],
    ...overrides,
  };
}

describe('BLOCK_TYPES', () => {
  it('exports all 8 block type constants', () => {
    expect(BLOCK_TYPES.HEADING).toBe('heading');
    expect(BLOCK_TYPES.PARAGRAPH).toBe('paragraph');
    expect(BLOCK_TYPES.CALLOUT_BOX).toBe('callout_box');
    expect(BLOCK_TYPES.IMAGE).toBe('image');
    expect(BLOCK_TYPES.TABLE).toBe('table');
    expect(BLOCK_TYPES.LIST).toBe('list');
    expect(BLOCK_TYPES.PAGE_HEADER).toBe('page_header');
    expect(BLOCK_TYPES.PAGE_FOOTER).toBe('page_footer');
    expect(Object.keys(BLOCK_TYPES)).toHaveLength(8);
  });
});

describe('prettyPrint', () => {
  it('serializes with 2-space indentation', () => {
    const obj = { a: 1, b: [2, 3] };
    const result = prettyPrint(obj);
    expect(result).toBe(JSON.stringify(obj, null, 2));
  });

  it('round-trips a valid Intermediate_JSON', () => {
    const obj = validJson();
    const serialized = prettyPrint(obj);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(obj);
  });
});

describe('validateSchemaVersion', () => {
  it('accepts matching MAJOR version (1.0)', () => {
    expect(validateSchemaVersion({ schema_version: '1.0' })).toEqual({ valid: true });
  });

  it('accepts matching MAJOR with higher MINOR (1.5)', () => {
    expect(validateSchemaVersion({ schema_version: '1.5' })).toEqual({ valid: true });
  });

  it('rejects different MAJOR version (2.0)', () => {
    const result = validateSchemaVersion({ schema_version: '2.0' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Incompatible schema version');
  });

  it('rejects MAJOR version 0', () => {
    const result = validateSchemaVersion({ schema_version: '0.1' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Incompatible schema version');
  });

  it('rejects missing schema_version', () => {
    const result = validateSchemaVersion({});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('schema_version must be a string');
  });

  it('rejects invalid format (no dot)', () => {
    const result = validateSchemaVersion({ schema_version: '1' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid schema_version format');
  });

  it('rejects non-object input', () => {
    const result = validateSchemaVersion(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Input is not an object');
  });
});

describe('parseIntermediateJson', () => {
  it('accepts a valid Intermediate_JSON string', () => {
    const result = parseIntermediateJson(JSON.stringify(validJson()));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(validJson());
  });

  it('rejects invalid JSON syntax', () => {
    const result = parseIntermediateJson('{not valid json');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid JSON syntax');
  });

  it('rejects non-object root (array)', () => {
    const result = parseIntermediateJson('[]');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON root must be an object');
  });

  it('rejects incompatible schema_version', () => {
    const json = validJson({ schema_version: '2.0' });
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Incompatible schema version');
  });

  it('rejects missing page_number', () => {
    const json = validJson();
    delete json.page_number;
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('page_number must be a positive integer');
  });

  it('rejects page_number of 0', () => {
    const json = validJson({ page_number: 0 });
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('page_number must be a positive integer');
  });

  it('rejects missing metadata', () => {
    const json = validJson();
    delete json.metadata;
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('metadata must be an object');
  });

  it('rejects metadata.title exceeding 512 chars', () => {
    const json = validJson();
    json.metadata.title = 'x'.repeat(513);
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exceeds maximum length');
  });

  it('rejects metadata.total_pages of 0', () => {
    const json = validJson();
    json.metadata.total_pages = 0;
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('total_pages must be a positive integer');
  });

  it('rejects invalid metadata.language', () => {
    const json = validJson();
    json.metadata.language = 'eng'; // 3 letters, not ISO 639-1
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('two-letter ISO 639-1 code');
  });

  it('accepts metadata.language "und"', () => {
    const json = validJson();
    json.metadata.language = 'und';
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(true);
  });

  it('rejects blocks that is not an array', () => {
    const json = validJson({ blocks: 'not an array' });
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('blocks must be an array');
  });

  it('accepts empty blocks array', () => {
    const json = validJson({ blocks: [] });
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(true);
  });

  it('rejects block with invalid type', () => {
    const json = validJson();
    json.blocks[0].type = 'unknown_type';
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a valid block type');
  });

  it('rejects block with missing text', () => {
    const json = validJson();
    delete json.blocks[0].text;
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('text must be a string');
  });

  it('rejects block with invalid segment_id format', () => {
    const json = validJson();
    json.blocks[0].segment_id = 'invalid';
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not match format');
  });

  it('rejects block with missing style', () => {
    const json = validJson();
    delete json.blocks[0].style;
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('style must be an object');
  });

  it('rejects style.heading_level out of range', () => {
    const json = validJson();
    json.blocks[0].style.heading_level = 7;
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('heading_level must be an integer 1-6 or null');
  });

  it('rejects invalid emphasis value', () => {
    const json = validJson();
    json.blocks[0].style.emphasis = ['bold', 'strikethrough'];
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a valid emphasis value');
  });

  it('validates image blocks require image_path and dimensions', () => {
    const json = validJson();
    json.blocks[0] = {
      type: 'image',
      text: '',
      segment_id: 'p1_b0',
      style: { heading_level: null, emphasis: [] },
    };
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('image_path is required');
  });

  it('accepts valid image block with image_path and dimensions', () => {
    const json = validJson();
    json.blocks[0] = {
      type: 'image',
      text: '',
      segment_id: 'p1_b0',
      image_path: 'images/p1_img0.png',
      dimensions: { width: 640, height: 480 },
      style: { heading_level: null, emphasis: [] },
    };
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(true);
  });

  it('rejects image block with invalid dimensions', () => {
    const json = validJson();
    json.blocks[0] = {
      type: 'image',
      text: '',
      segment_id: 'p1_b0',
      image_path: 'images/p1_img0.png',
      dimensions: { width: 0, height: 480 },
      style: { heading_level: null, emphasis: [] },
    };
    const result = parseIntermediateJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('dimensions.width must be a positive integer');
  });

  it('validates all block types are accepted', () => {
    const types = Object.values(BLOCK_TYPES);
    for (const type of types) {
      const block = {
        type,
        text: type === 'image' ? '' : 'Some text',
        segment_id: 'p1_b0',
        style: { heading_level: type === 'heading' ? 1 : null, emphasis: [] },
      };
      if (type === 'image') {
        block.image_path = 'images/p1_img0.png';
        block.dimensions = { width: 100, height: 100 };
      }
      const json = validJson({ blocks: [block] });
      const result = parseIntermediateJson(JSON.stringify(json));
      expect(result.ok, `block type "${type}" should be accepted`).toBe(true);
    }
  });
});
