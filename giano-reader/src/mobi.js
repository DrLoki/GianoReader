/**
 * Parser minimale per file MOBI/AZW.
 * Estrae il testo HTML dal record PalmDOC/MOBI.
 */

export async function parseMobi(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // PalmDB header: nome (32 byte), poi vari campi
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // Numero di record (offset 76)
  const numRecords = view.getUint16(76);

  // Lista record: offset 78, ogni record = 8 byte (4 offset + 4 attributi)
  const recordOffsets = [];
  for (let i = 0; i < numRecords; i++) {
    recordOffsets.push(view.getUint32(78 + i * 8));
  }

  // Record 0 = header MOBI
  const rec0Start = recordOffsets[0];
  const rec0End = recordOffsets[1] || arrayBuffer.byteLength;

  // PalmDOC header (32 byte dal record 0)
  const compression = view.getUint16(rec0Start);
  const textLength = view.getUint32(rec0Start + 4);
  const recordCount = view.getUint16(rec0Start + 8);

  // MOBI header inizia a offset 32 dal record 0
  const mobiOffset = rec0Start + 32;
  const mobiMagic = decoder.decode(bytes.slice(mobiOffset, mobiOffset + 4));
  if (mobiMagic !== 'MOBI') throw new Error('File MOBI non valido o formato non supportato');

  const firstContentRecord = view.getUint16(mobiOffset + 16);
  const firstNonBookRecord = view.getUint16(mobiOffset + 20);
  const fullNameOffset = view.getUint32(mobiOffset + 36);
  const fullNameLength = view.getUint32(mobiOffset + 40);

  const title = decoder.decode(bytes.slice(rec0Start + fullNameOffset, rec0Start + fullNameOffset + fullNameLength));

  // Decomprime i record testo (PalmDOC compression = 2, nessuna = 1)
  let htmlContent = '';
  const endRecord = firstNonBookRecord > 0 ? Math.min(firstNonBookRecord, firstContentRecord + recordCount) : firstContentRecord + recordCount;

  for (let i = firstContentRecord; i < endRecord && i < recordOffsets.length; i++) {
    const start = recordOffsets[i];
    const end = recordOffsets[i + 1] || arrayBuffer.byteLength;
    const recData = bytes.slice(start, end);

    let text;
    if (compression === 2) {
      text = decompressPalmDoc(recData);
    } else {
      text = recData;
    }
    htmlContent += decoder.decode(text);
  }

  return { title, htmlContent };
}

function decompressPalmDoc(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const byte = data[i++];
    if (byte === 0x00) {
      out.push(0x00);
    } else if (byte <= 0x08) {
      // Copia i prossimi `byte` byte letteralmente
      for (let j = 0; j < byte && i < data.length; j++) out.push(data[i++]);
    } else if (byte <= 0x7F) {
      out.push(byte);
    } else if (byte <= 0xBF) {
      const next = data[i++];
      const dist = ((byte & 0x3F) << 8) | next;
      const len = ((dist & 0x7) + 3);
      const offset = dist >> 3;
      const pos = out.length - offset;
      for (let j = 0; j < len; j++) out.push(out[pos + j] || 0x20);
    } else {
      // 0xC0-0xFF: spazio + carattere ASCII
      out.push(0x20);
      out.push(byte ^ 0x80);
    }
  }
  return new Uint8Array(out);
}
