// A title longer than one index row may be (btree and GIN refuse a row over about 2,700 bytes): 700 characters of four bytes (CJK Extension B), 2,800
// bytes, none repeated in a run, so the database's compression of a value does not bring it under the limit (one character repeated 700 times compresses to
// a few bytes and fits any index).
export const LONG_TITLE = Array.from({ length: 700 }, (_, i) => String.fromCodePoint(0x20000 + ((i * 7919) % 0xa6d0))).join("");
