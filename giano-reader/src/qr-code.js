/**
 * qr-code.js
 *
 * QR code of the Web Server address, generated locally: it works without an
 * internet connection and the LAN address is not sent to an external service.
 */
import qrcode from 'qrcode-generator';

/**
 * Returns a `data:` URL of an image with the QR code of `text`.
 *
 * @param {string} text
 * @param {number} [cellSize] pixels per module
 * @param {number} [margin]   quiet zone in pixels
 */
export function qrCodeDataUrl(text, cellSize = 4, margin = 8) {
  // Type 0 = smallest version that fits; 'M' = medium error correction
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, margin);
}
