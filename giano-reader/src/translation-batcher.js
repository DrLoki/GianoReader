/**
 * translation-batcher.js
 *
 * Batches text segments for translation, respecting constraints:
 * - Max 12 segments per batch
 * - Max 4500 total characters per batch
 * - Preserves original ordering across batches
 * - Every input segment appears in exactly one batch
 */

/** Maximum number of segments allowed in a single batch. */
const MAX_SEGMENTS_PER_BATCH = 12;

/** Maximum total character count allowed in a single batch. */
const MAX_CHARS_PER_BATCH = 4500;

/**
 * Partitions an array of text segments into batches for translation.
 *
 * Each batch contains at most 12 segments and at most 4500 total characters.
 * Original ordering is preserved — segments are never reordered across batches.
 * Every input segment appears in exactly one batch.
 *
 * A segment whose length exceeds MAX_CHARS_PER_BATCH is placed alone in its own batch.
 *
 * @param {string[]} segments - Array of text segments to batch.
 * @returns {string[][]} Array of batches, where each batch is an array of segments.
 */
export function batchSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const segment of segments) {
    const segLen = segment.length;

    // If adding this segment would exceed either limit, finalize current batch first
    if (currentBatch.length > 0 &&
        (currentBatch.length >= MAX_SEGMENTS_PER_BATCH || currentChars + segLen > MAX_CHARS_PER_BATCH)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(segment);
    currentChars += segLen;
  }

  // Push the last batch if non-empty
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
