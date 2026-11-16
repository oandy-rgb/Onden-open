// Same-level order keys: a short string that can always be placed between two others, so moving or inserting one
// item writes one row and two devices that reorder offline never produce the same number for different notes.
//
// Fractional indexing. The algorithm is the public-domain (CC0) one David Greenspan published with
// "Implementing Fractional Indexing" (the `fractional-indexing` package is a port of it); it is written out here, not
// added as a dependency, because it is ~150 lines of pure code, it has to be identical in the browser build, the
// backend (which also runs in the browser) and a SQL migration, and a copy we own can have the validity check and the
// length rule below. Digits are base 62 in ASCII order (0-9, A-Z, a-z), so comparing two keys as plain strings by UTF-16
// code unit (`<`) equals comparing their bytes — the database side must use COLLATE "C", never a locale collation.
//
// A key is an integer part (its first letter says how long it is: `a` + 1 digit … `z` + 26 digits, `Z` + 1 digit …
// `A` + 26 digits for the negative side) followed by an optional fractional part that never ends in `0`.
//
// Equal keys: two devices can insert at the same place and produce the same key. The order between rows with the same
// key is not decided here but by `compareOrdered`: key, then the order stamp (the hybrid logical clock of the write
// that set the key, as a fixed-width string), then the row id. Every node computes that the same way.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SMALLEST_INTEGER = `A${"0".repeat(26)}`;

/** A key longer than this is respaced with its whole sibling group in one explicit operation (never during a read).
 *  Appending or prepending grows a key by one character per 62 items; dropping again and again into the same gap grows
 *  it by one per ~6, which this bounds. A key this long is still valid and still compares correctly. */
export const ORDER_KEY_RESPACE_LENGTH = 32;
/** Longest key the server accepts at all (a key from another device that was never respaced is longer than the respace length). */
export const ORDER_KEY_MAX_LENGTH = 256;

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith("0") || (b !== null && b.endsWith("0"))) throw new Error("order key part ends with 0");
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.substring(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  if (b !== null && b.length > 1) return b[0]!;
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 96 + 1;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]!);
  if (length > key.length) throw new Error(`invalid order key ${key}`);
  return key.substring(0, length);
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid order key ${key}`);
  const integer = integerPart(key);
  const fraction = key.slice(integer.length);
  if (fraction.endsWith("0")) throw new Error(`invalid order key ${key}`);
  for (const ch of key) if (DIGITS.indexOf(ch) < 0) throw new Error(`invalid order key ${key}`);
}

/** Is this string a key `keyBetween` accepts (and so one the database may store)? */
export function isValidOrderKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > ORDER_KEY_MAX_LENGTH) return false;
  try { validate(key); return true; } catch { return false; }
}

/** Past the length at which the sibling group should be respaced (see ORDER_KEY_RESPACE_LENGTH). */
export function orderKeyNeedsRespace(key: string): boolean {
  return key.length > ORDER_KEY_RESPACE_LENGTH;
}

function increment(integer: string): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) + 1;
    if (d === DIGITS.length) digits[i] = "0";
    else { digits[i] = DIGITS[d]!; carry = false; }
  }
  if (carry) {
    if (head === "Z") return "a0";
    if (head === "z") return null;
    const h = head.charCodeAt(0) + 1;
    if (h > 97) digits.push("0"); else digits.pop();
    return String.fromCharCode(h) + digits.join("");
  }
  return head + digits.join("");
}

function decrement(integer: string): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) - 1;
    if (d === -1) digits[i] = DIGITS[DIGITS.length - 1]!;
    else { digits[i] = DIGITS[d]!; borrow = false; }
  }
  if (borrow) {
    if (head === "a") return `Z${DIGITS[DIGITS.length - 1]}`;
    if (head === "A") return null;
    const h = head.charCodeAt(0) - 1;
    if (h < 90) digits.push(DIGITS[DIGITS.length - 1]!); else digits.pop();
    return String.fromCharCode(h) + digits.join("");
  }
  return head + digits.join("");
}

/** A key strictly between `before` and `after` (`null` = no neighbour on that side). Throws if `before >= after` or a
 *  key is not valid: a caller that may hold equal keys (a tie) must renumber the tied rows instead (planSiblingOrder). */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null) validate(before);
  if (after !== null) validate(after);
  if (before !== null && after !== null && before >= after) throw new Error(`${before} >= ${after}`);
  if (before === null) {
    if (after === null) return "a0";
    const integer = integerPart(after);
    const fraction = after.slice(integer.length);
    if (integer === SMALLEST_INTEGER) return integer + midpoint("", fraction);
    if (integer < after) return integer;
    const lower = decrement(integer);
    if (lower === null) throw new Error("cannot decrement any more");
    return lower;
  }
  if (after === null) {
    const integer = integerPart(before);
    const fraction = before.slice(integer.length);
    const next = increment(integer);
    return next === null ? integer + midpoint(fraction, null) : next;
  }
  const integerBefore = integerPart(before);
  const fractionBefore = before.slice(integerBefore.length);
  const integerAfter = integerPart(after);
  const fractionAfter = after.slice(integerAfter.length);
  if (integerBefore === integerAfter) return integerBefore + midpoint(fractionBefore, fractionAfter);
  const next = increment(integerBefore);
  if (next === null) throw new Error("cannot increment any more");
  if (next < after) return next;
  return integerBefore + midpoint(fractionBefore, null);
}

/** `count` keys in increasing order, all strictly between `before` and `after`. */
export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [keyBetween(before, after)];
  if (after === null) {
    let key = keyBetween(before, after);
    const keys = [key];
    for (let i = 0; i < count - 1; i++) { key = keyBetween(key, after); keys.push(key); }
    return keys;
  }
  if (before === null) {
    let key = keyBetween(before, after);
    const keys = [key];
    for (let i = 0; i < count - 1; i++) { key = keyBetween(before, key); keys.push(key); }
    return keys.reverse();
  }
  const half = Math.floor(count / 2);
  const middle = keyBetween(before, after);
  return [...keysBetween(before, middle, half), middle, ...keysBetween(middle, after, count - half - 1)];
}

/** Keys for a freshly spaced group of `count` rows: what a respace and the backfill in migration 200 write. Rank r
 *  (0-based) is `a` + one digit for r < 62, `b` + two digits next, then `c` + three — no fraction, so a later
 *  insertion between any two neighbours is a single extra character. The SQL in migration 200 computes the same. */
export function evenOrderKeys(count: number): string[] {
  const keys: string[] = [];
  for (let rank = 0; rank < count; rank++) keys.push(evenOrderKey(rank));
  return keys;
}

export function evenOrderKey(rank: number): string {
  const digit = (n: number) => DIGITS[n % 62]!;
  if (rank < 62) return `a${digit(rank)}`;
  rank -= 62;
  if (rank < 62 * 62) return `b${digit(Math.floor(rank / 62))}${digit(rank)}`;
  rank -= 62 * 62;
  if (rank < 62 ** 3) return `c${digit(Math.floor(rank / 3844))}${digit(Math.floor(rank / 62))}${digit(rank)}`;
  throw new Error("too many siblings for an even order key");
}

export type Ordered = { id?: string; order_key?: string | null; order_stamp?: string | null };

/** The order of two siblings: key (plain `<`, by code unit), then the stamp of the write that set the key (a
 *  fixed-width string, '' when the row has none), then the row id. Backend SQL says the same:
 *  ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id. */
export function compareOrdered(a: Ordered, b: Ordered): number {
  const keyA = a.order_key ?? "", keyB = b.order_key ?? "";
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  const stampA = a.order_stamp ?? "", stampB = b.order_stamp ?? "";
  if (stampA !== stampB) return stampA < stampB ? -1 : 1;
  const idA = a.id ?? "", idB = b.id ?? "";
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
