// How a big drawing value is cut into chunks (services/inkChunks.ts): at object boundaries chosen from the text itself, so
// the chunks around a change are the only ones that differ. Pure; the chunks join back to the text exactly.

/** The average chunk: a stroke changes about 4 places of a PDF's value, so about 4 chunks are written per save, against
 *  a manifest that grows with value/target (32 bytes per chunk). */
const TARGET_CHUNK = 8 * 1024;
/** No chunk is longer than this, whatever the text looks like. */
const MAX_CHUNK = 64 * 1024;

/** FNV-1a over `text[from, to)`: cheap, and only used to pick boundaries (the chunk's identity is its sha256). */
function fnv1a(text: string, from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** `text` cut into chunks that join back to it exactly. A piece ends after each `},` (the gap between two objects of a
 *  JSON array: a stroke, a record, a page); a chunk ends after a piece whose own content says so (probability piece length /
 *  TARGET_CHUNK, so the average chunk is TARGET_CHUNK however long the pieces are) or when it reaches MAX_CHUNK. A piece
 *  longer than MAX_CHUNK is cut at MAX_CHUNK (never between the halves of a surrogate pair). */
export function chunkInk(text: string): string[] {
  const chunks: string[] = [];
  let start = 0, pieceStart = 0;
  const cut = (end: number) => { if (end > start) chunks.push(text.slice(start, end)); start = end; };
  while (pieceStart < text.length) {
    const found = text.indexOf("},", pieceStart);
    const pieceEnd = found === -1 ? text.length : found + 2;
    // A piece that would overflow the chunk closes the chunk before it, so MAX_CHUNK is a real limit.
    if (pieceEnd - start > MAX_CHUNK && pieceStart > start) cut(pieceStart);
    while (pieceEnd - start > MAX_CHUNK) {
      let end = start + MAX_CHUNK;
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      cut(end);
    }
    const length = pieceEnd - pieceStart;
    if (pieceEnd === text.length || length >= TARGET_CHUNK || fnv1a(text, pieceStart, pieceEnd) % TARGET_CHUNK < length) cut(pieceEnd);
    pieceStart = pieceEnd;
  }
  cut(text.length);
  return chunks;
}

