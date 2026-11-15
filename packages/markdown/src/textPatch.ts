// A text change as a few hunks against the text it was made from, so a writer
// can send what changed instead of the whole value (docs/architecture/patch-writes.md).
//
// Both sides use this one module: the client makes the patch from the value it
// last had confirmed (`makePatch`), the server gives it back to the text it was
// made from (`applyPatch`, over the stored value or a blob found by `base_hash`)
// and then runs the merge it always ran. Positions count UTF-16 code units, the
// same as JavaScript string indexes, so no byte/character conversion happens.

/** Replace `del` units of the base at `at` with `ins`. */
export type TextHunk = { at: number; del: number; ins: string };
/** `base_hash`: hashText of the text the hunks apply to (the writer's merge base). */
export type TextPatch = { base_hash: string; hunks: TextHunk[] };

/** Why a patch could not be applied: the text it names is not the one given,
 *  or a hunk reaches outside it. */
export class TextPatchError extends Error {
  constructor(readonly reason: "base_mismatch" | "out_of_range" | "malformed") {
    super(reason);
    this.name = "TextPatchError";
  }
}

// ── SHA-256 (UTF-8) ─────────────────────────────────────────────────────────
// Synchronous and dependency-free so a page served over plain HTTP (no
// crypto.subtle) hashes the same as the server (services/blobs.ts: sha256 hex
// of the UTF-8 bytes). The server hashes with Node's crypto where it can; this
// is the same function.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  let hex = "";
  for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, "0");
  return hex;
}

/** SHA-256 of the UTF-8 bytes of `text`, lower-case hex: the `blobs` hash. */
export function hashText(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

// ── Making a patch ──────────────────────────────────────────────────────────

/** A middle part shorter than this stays one hunk: splitting it costs more
 *  than it saves. */
const SPLIT_MIN_UNITS = 2048;
const MAX_SPLIT_DEPTH = 6;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Hunks turning base[baseFrom, baseTo) into next[nextFrom, nextTo), positions
 *  in the whole base. */
function diffRange(base: string, next: string, baseFrom: number, baseTo: number, nextFrom: number, nextTo: number, depth: number, out: TextHunk[]): void {
  let prefix = 0;
  const limit = Math.min(baseTo - baseFrom, nextTo - nextFrom);
  while (prefix < limit && base.charCodeAt(baseFrom + prefix) === next.charCodeAt(nextFrom + prefix)) prefix++;
  // Never cut inside a surrogate pair: a hunk holds whole characters.
  if (prefix > 0 && isHigh(base.charCodeAt(baseFrom + prefix - 1))) prefix--;
  let suffix = 0;
  const suffixLimit = limit - prefix;
  while (suffix < suffixLimit && base.charCodeAt(baseTo - 1 - suffix) === next.charCodeAt(nextTo - 1 - suffix)) suffix++;
  if (suffix > 0 && isLow(base.charCodeAt(baseTo - suffix))) suffix--;
  const from = baseFrom + prefix, to = baseTo - suffix;
  const nFrom = nextFrom + prefix, nTo = nextTo - suffix;
  if (from === to && nFrom === nTo) return;
  if (depth < MAX_SPLIT_DEPTH && to - from >= SPLIT_MIN_UNITS && nTo - nFrom >= SPLIT_MIN_UNITS) {
    const anchors = lineAnchors(base, next, from, to, nFrom, nTo);
    if (anchors.length > 0) {
      let b = from, n = nFrom;
      for (const anchor of anchors) {
        diffRange(base, next, b, anchor.base, n, anchor.next, depth + 1, out);
        b = anchor.base + anchor.length; n = anchor.next + anchor.length;
      }
      diffRange(base, next, b, to, n, nTo, depth + 1, out);
      return;
    }
  }
  out.push({ at: from, del: to - from, ins: next.slice(nFrom, nTo) });
}

type Line = { start: number; text: string };
const splitLines = (text: string, from: number, to: number): Line[] => {
  const lines: Line[] = [];
  let start = from;
  while (start < to) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 || end >= to ? to : end + 1;
    lines.push({ start, text: text.slice(start, stop) });
    start = stop;
  }
  return lines;
};

/** Lines present exactly once on each side, in the order both sides keep them
 *  (the longest increasing run, as patience diff does): the places a change
 *  can be split without guessing. */
function lineAnchors(base: string, next: string, from: number, to: number, nFrom: number, nTo: number): { base: number; next: number; length: number }[] {
  const a = splitLines(base, from, to), b = splitLines(next, nFrom, nTo);
  const countIn = (lines: Line[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
    return counts;
  };
  const inA = countIn(a), inB = countIn(b);
  const indexInB = new Map<string, number>();
  b.forEach((line, i) => { if (inB.get(line.text) === 1) indexInB.set(line.text, i); });
  const pairs: { ai: number; bi: number }[] = [];
  a.forEach((line, ai) => {
    const bi = indexInB.get(line.text);
    if (bi !== undefined && inA.get(line.text) === 1) pairs.push({ ai, bi });
  });
  if (pairs.length === 0) return [];
  // Longest increasing subsequence of bi (pairs are already ordered by ai).
  const tails: number[] = [];
  const previous: number[] = new Array(pairs.length).fill(-1);
  pairs.forEach((pair, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]].bi < pair.bi) lo = mid + 1; else hi = mid; }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const chosen: number[] = [];
  for (let i = tails[tails.length - 1]; i !== undefined && i !== -1; i = previous[i]) chosen.push(i);
  chosen.reverse();
  return chosen.map((i) => ({ base: a[pairs[i].ai].start, next: b[pairs[i].bi].start, length: a[pairs[i].ai].text.length }));
}

/** The change from `base` to `next` as hunks, ordered by position. Equal
 *  texts give no hunks. The common start and end are left out; a big change in
 *  the middle is split at the lines both texts keep, so two far-apart edits
 *  do not carry the text between them. */
export function makePatch(base: string, next: string): TextPatch {
  const hunks: TextHunk[] = [];
  diffRange(base, next, 0, base.length, 0, next.length, 0, hunks);
  return { base_hash: hashText(base), hunks };
}

// ── Applying a patch ────────────────────────────────────────────────────────

/** Shape check for a patch that arrived from outside (a request body). */
export function isTextPatch(value: unknown): value is TextPatch {
  if (!value || typeof value !== "object") return false;
  const { base_hash, hunks } = value as Partial<TextPatch>;
  return typeof base_hash === "string" && /^[0-9a-f]{64}$/.test(base_hash) && Array.isArray(hunks) &&
    hunks.every((h) => !!h && Number.isSafeInteger(h.at) && h.at >= 0 && Number.isSafeInteger(h.del) && h.del >= 0 && typeof h.ins === "string");
}

/** The text `patch` was made against, turned into the text it describes.
 *  Strict: a patch made from other text, or reaching outside this one, throws
 *  (nothing is applied "close enough"). `hash` lets the server pass its native
 *  SHA-256 instead of hashText. */
export function applyPatch(base: string, patch: TextPatch, hash: (text: string) => string = hashText): string {
  if (!isTextPatch(patch)) throw new TextPatchError("malformed");
  if (hash(base) !== patch.base_hash) throw new TextPatchError("base_mismatch");
  const parts: string[] = [];
  let cursor = 0;
  for (const { at, del, ins } of patch.hunks) {
    if (at < cursor || at + del > base.length) throw new TextPatchError("out_of_range");
    parts.push(base.slice(cursor, at), ins);
    cursor = at + del;
  }
  parts.push(base.slice(cursor));
  return parts.join("");
}
