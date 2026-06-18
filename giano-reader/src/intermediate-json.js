/**
 * Intermediate_JSON schema validation, parsing, and pretty-print utilities.
 *
 * This module defines the canonical block types, validates Intermediate_JSON
 * objects against the schema, checks version compatibility, and provides
 * serialization helpers.
 */

// --- Block type constants ---

export const BLOCK_TYPES = {
  HEADING: 'heading',
  PARAGRAPH: 'paragraph',
  CALLOUT_BOX: 'callout_box',
  IMAGE: 'image',
  TABLE: 'table',
  LIST: 'list',
  PAGE_HEADER: 'page_header',
  PAGE_FOOTER: 'page_footer',
};

/** Set of all valid block type values */
const VALID_BLOCK_TYPES = new Set(Object.values(BLOCK_TYPES));

/** Valid emphasis values */
const VALID_EMPHASIS = new Set(['bold', 'italic', 'underline']);

/** Current expected MAJOR schema version */
const EXPECTED_MAJOR_VERSION = 1;

// --- Public API ---

/**
 * Pretty-prints an Intermediate_JSON object with 2-space indentation.
 * @param {object} json - Valid Intermediate_JSON object
 * @returns {string} Formatted JSON string
 */
export function prettyPrint(json) {
  return JSON.stringify(json, null, 2);
}

/**
 * Validates schema version compatibility (MAJOR version must match).
 * @param {object} json - Parsed JSON object with schema_version field
 * @returns {{valid: boolean, error?: string}}
 */
export function validateSchemaVersion(json) {
  if (json == null || typeof json !== 'object') {
    return { valid: false, error: 'Input is not an object' };
  }

  const version = json.schema_version;
  if (typeof version !== 'string') {
    return { valid: false, error: 'schema_version must be a string' };
  }

  const parts = version.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: `Invalid schema_version format: "${version}". Expected "MAJOR.MINOR"` };
  }

  const major = Number(parts[0]);
  const minor = Number(parts[1]);

  if (!Number.isInteger(major) || major < 0 || !Number.isInteger(minor) || minor < 0) {
    return { valid: false, error: `Invalid schema_version format: "${version}". MAJOR and MINOR must be non-negative integers` };
  }

  if (major !== EXPECTED_MAJOR_VERSION) {
    return { valid: false, error: `Incompatible schema version: "${version}". Expected MAJOR version ${EXPECTED_MAJOR_VERSION}` };
  }

  return { valid: true };
}

/**
 * Parses and validates a JSON string as Intermediate_JSON.
 * @param {string} jsonString - Raw JSON string
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function parseIntermediateJson(jsonString) {
  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return { ok: false, error: `Invalid JSON syntax: ${e.message}` };
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'JSON root must be an object' };
  }

  // Validate schema_version
  const versionResult = validateSchemaVersion(parsed);
  if (!versionResult.valid) {
    return { ok: false, error: versionResult.error };
  }

  // Validate page_number
  if (!Number.isInteger(parsed.page_number) || parsed.page_number < 1) {
    return { ok: false, error: 'page_number must be a positive integer' };
  }

  // Validate metadata
  const metaError = validateMetadata(parsed.metadata);
  if (metaError) {
    return { ok: false, error: metaError };
  }

  // Validate blocks array
  if (!Array.isArray(parsed.blocks)) {
    return { ok: false, error: 'blocks must be an array' };
  }

  for (let i = 0; i < parsed.blocks.length; i++) {
    const blockError = validateBlock(parsed.blocks[i], i);
    if (blockError) {
      return { ok: false, error: blockError };
    }
  }

  return { ok: true, data: parsed };
}

// --- Internal validation helpers ---

/**
 * Validates the metadata object.
 * @param {*} metadata
 * @returns {string|null} Error message or null if valid
 */
function validateMetadata(metadata) {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'metadata must be an object';
  }

  // title
  if (typeof metadata.title !== 'string') {
    return 'metadata.title must be a string';
  }
  if (metadata.title.length > 512) {
    return `metadata.title exceeds maximum length of 512 characters (got ${metadata.title.length})`;
  }

  // total_pages
  if (!Number.isInteger(metadata.total_pages) || metadata.total_pages < 1) {
    return 'metadata.total_pages must be a positive integer';
  }

  // language (ISO 639-1 two-letter code or "und")
  if (typeof metadata.language !== 'string') {
    return 'metadata.language must be a string';
  }
  if (metadata.language !== 'und' && !/^[a-z]{2}$/.test(metadata.language)) {
    return `metadata.language must be a two-letter ISO 639-1 code or "und" (got "${metadata.language}")`;
  }

  return null;
}

/**
 * Validates a single block object.
 * @param {*} block
 * @param {number} index - Block index for error messages
 * @returns {string|null} Error message or null if valid
 */
function validateBlock(block, index) {
  if (block == null || typeof block !== 'object' || Array.isArray(block)) {
    return `blocks[${index}] must be an object`;
  }

  // type
  if (typeof block.type !== 'string') {
    return `blocks[${index}].type must be a string`;
  }
  if (!VALID_BLOCK_TYPES.has(block.type)) {
    return `blocks[${index}].type "${block.type}" is not a valid block type`;
  }

  // text
  if (typeof block.text !== 'string') {
    return `blocks[${index}].text must be a string`;
  }

  // segment_id
  if (typeof block.segment_id !== 'string') {
    return `blocks[${index}].segment_id must be a string`;
  }
  if (!/^p\d+_b\d+$/.test(block.segment_id)) {
    return `blocks[${index}].segment_id "${block.segment_id}" does not match format p{pageNum}_b{blockIndex}`;
  }

  // style
  const styleError = validateStyle(block.style, index);
  if (styleError) {
    return styleError;
  }

  // image-specific fields
  if (block.type === BLOCK_TYPES.IMAGE) {
    if (typeof block.image_path !== 'string' || block.image_path.length === 0) {
      return `blocks[${index}].image_path is required for image blocks and must be a non-empty string`;
    }
    const dimError = validateDimensions(block.dimensions, index);
    if (dimError) {
      return dimError;
    }
  }

  return null;
}

/**
 * Validates the style object of a block.
 * @param {*} style
 * @param {number} blockIndex
 * @returns {string|null}
 */
function validateStyle(style, blockIndex) {
  if (style == null || typeof style !== 'object' || Array.isArray(style)) {
    return `blocks[${blockIndex}].style must be an object`;
  }

  // heading_level: integer 1-6 or null
  if (style.heading_level !== null) {
    if (!Number.isInteger(style.heading_level) || style.heading_level < 1 || style.heading_level > 6) {
      return `blocks[${blockIndex}].style.heading_level must be an integer 1-6 or null`;
    }
  }

  // emphasis: array of valid values
  if (!Array.isArray(style.emphasis)) {
    return `blocks[${blockIndex}].style.emphasis must be an array`;
  }
  for (let i = 0; i < style.emphasis.length; i++) {
    if (!VALID_EMPHASIS.has(style.emphasis[i])) {
      return `blocks[${blockIndex}].style.emphasis[${i}] "${style.emphasis[i]}" is not a valid emphasis value (expected "bold", "italic", or "underline")`;
    }
  }

  return null;
}

/**
 * Validates the dimensions object for image blocks.
 * @param {*} dimensions
 * @param {number} blockIndex
 * @returns {string|null}
 */
function validateDimensions(dimensions, blockIndex) {
  if (dimensions == null || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    return `blocks[${blockIndex}].dimensions is required for image blocks and must be an object`;
  }
  if (!Number.isInteger(dimensions.width) || dimensions.width < 1) {
    return `blocks[${blockIndex}].dimensions.width must be a positive integer`;
  }
  if (!Number.isInteger(dimensions.height) || dimensions.height < 1) {
    return `blocks[${blockIndex}].dimensions.height must be a positive integer`;
  }
  return null;
}
