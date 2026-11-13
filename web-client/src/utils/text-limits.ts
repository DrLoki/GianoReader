/**
 * text-limits.ts
 *
 * Size limits of the free Google Translate endpoint.
 *
 * The endpoint only accepts GET requests (a POST is answered with HTTP 429),
 * with the text in the URL, and rejects URLs longer than about 16 KB with
 * HTTP 400. In the URL every UTF-8 byte of a non-ASCII character becomes three
 * characters (`%D0`), so the limit must be counted in UTF-8 bytes, not in
 * characters: 4500 Latin characters are about 6 KB of URL, 4500 Cyrillic or
 * CJK characters are 27–40 KB.
 *
 * Keep `FREE_BYTE_LIMIT` equal to `CHAR_LIMIT` in src-tauri `translator.rs`
 * and to the desktop `giano-reader/src/text-limits.js`.
 *
 * Pure functions, no DOM or network access.
 */

/** Maximum UTF-8 bytes of text per request: at most 13.5 KB once URL-encoded. */
export const FREE_BYTE_LIMIT = 4500;

const encoder = new TextEncoder();

/** Length of `text` in UTF-8 bytes. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Characters after which a long text can be cut: whitespace and sentence punctuation. */
const BREAK_AFTER = /[\s.!?;:,。！？；：，、…]/;

/**
 * Splits `text` into pieces of at most `limit` UTF-8 bytes each.
 *
 * Cuts after the last whitespace or punctuation mark that fits, so words and
 * sentences stay whole when possible; text without any such character (e.g. a
 * very long CJK run) is cut between characters. Joining the pieces gives back
 * `text` unchanged.
 *
 */
export function splitByByteLimit(text: string, limit: number = FREE_BYTE_LIMIT): string[] {
  if (utf8Length(text) <= limit) return [text];

  const pieces: string[] = [];
  let piece = '';
  let pieceBytes = 0;
  let breakAt = -1; // length of `piece` up to and including the last break character

  for (const char of text) { // iterates by code point: never splits a surrogate pair
    const charBytes = utf8Length(char);
    // A loop: what is left after cutting at a break point may still not have
    // room for this character, and is then cut again (as a whole).
    while (pieceBytes + charBytes > limit && piece) {
      const cut = breakAt > 0 ? breakAt : piece.length;
      pieces.push(piece.slice(0, cut));
      piece = piece.slice(cut);
      pieceBytes = utf8Length(piece);
      breakAt = -1;
    }
    piece += char;
    pieceBytes += charBytes;
    if (BREAK_AFTER.test(char)) breakAt = piece.length;
  }
  if (piece) pieces.push(piece);
  return pieces;
}
