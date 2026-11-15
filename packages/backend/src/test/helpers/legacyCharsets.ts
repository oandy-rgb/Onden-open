// Text → bytes in the legacy East Asian charsets (Big5, GBK, Shift_JIS) for tests.
//
// Node has TextDecoder for these but no encoder, and iconv-lite is not a dependency of
// this package. The decoder is the reference: every two-byte code is decoded once and the
// character it yields is mapped back to those bytes. A character with no code is not in the
// table, so `encode` refuses it instead of writing a replacement byte.

export type LegacyCharset = "big5" | "gbk" | "shift_jis";
export const LEGACY_CHARSETS: readonly LegacyCharset[] = ["big5", "gbk", "shift_jis"];

/** Other names the same charset goes by in a prolog or a Content-Type header. */
export const CHARSET_LABELS: Record<LegacyCharset | "utf-8", readonly string[]> = {
  "utf-8": ["utf-8", "UTF-8", "utf8"],
  big5: ["big5", "Big5", "BIG5"],
  gbk: ["gbk", "GBK", "gb2312", "GB2312"],
  shift_jis: ["shift_jis", "Shift_JIS", "SHIFT-JIS", "x-sjis"],
};

const tables = new Map<LegacyCharset, Map<string, readonly number[]>>();

function table(charset: LegacyCharset): Map<string, readonly number[]> {
  const cached = tables.get(charset);
  if (cached) return cached;
  const decoder = new TextDecoder(charset, { fatal: true });
  const map = new Map<string, readonly number[]>();
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      let text: string;
      try { text = decoder.decode(Uint8Array.of(lead, trail)); } catch { continue; }
      // One real character; a code that decodes to a control or private-use point is not text.
      if ([...text].length !== 1 || /[\p{C}\p{Z}]/u.test(text)) continue;
      if (!map.has(text)) map.set(text, [lead, trail]);
    }
  }
  tables.set(charset, map);
  return map;
}

/** Every non-ASCII character `charset` can write, in code order. */
export function charsetRepertoire(charset: LegacyCharset): string[] {
  return [...table(charset).keys()];
}

/** `text` as bytes of `charset`: ASCII is one byte, anything else its two-byte code. */
export function encodeLegacy(text: string, charset: LegacyCharset): Buffer {
  const map = table(charset);
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) { bytes.push(code); continue; }
    const pair = map.get(ch);
    if (!pair) throw new Error(`${charset} has no code for U+${code.toString(16).toUpperCase()}`);
    bytes.push(...pair);
  }
  return Buffer.from(bytes);
}
