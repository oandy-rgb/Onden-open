/** What a GET /api/media/:filename should send for a `Range` header. */
export type MediaRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number } // byte offsets, both inclusive
  | { kind: "unsatisfiable" };

/**
 * Single-range `bytes=` handling (RFC 9110 §14). Multiple ranges and other
 * units are ignored (`full`) — a player only ever asks for one. A single range
 * that is malformed or outside the file is `unsatisfiable` (416), so a client
 * never gets a silent full-body 200 for a seek it asked for.
 */
export function parseMediaRange(header: string | undefined, size: number): MediaRange {
  if (!header) return { kind: "full" };
  const value = header.trim();
  if (!/^bytes\s*=/i.test(value) || value.includes(",")) return { kind: "full" };
  const m = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i.exec(value);
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "unsatisfiable" };
  if (m[1] === "") {
    // bytes=-N: the last N bytes (clamped to the whole file).
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || start > end) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}
