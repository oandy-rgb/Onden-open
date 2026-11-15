/** Longest name kept, in characters: CJK expands to 9 bytes each in the
 *  encoded form, and nginx refuses response headers beyond 4–8 KB (502). */
const FILENAME_MAX_CHARS = 120;

function shortenKeepingExtension(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= FILENAME_MAX_CHARS) return name;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? "";
  return chars.slice(0, FILENAME_MAX_CHARS - Array.from(ext).length).join("").trimEnd() + ext;
}

/** The one place a download response names its file (docs/research/dup-patterns-2026-10-30-be.md R3).
 *  `filename` may be any text — Chinese titles stay readable through the
 *  RFC 5987 `filename*=UTF-8''` form; the plain `filename=` is an ASCII fallback
 *  for old clients. Quotes, slashes and control characters never reach the header;
 *  names longer than FILENAME_MAX_CHARS are cut (extension kept). */
export function attachmentHeaders(filename: string, contentType?: string): Record<string, string> {
  // eslint-disable-next-line no-control-regex
  const clean = shortenKeepingExtension(filename.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "-").trim()) || "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/%/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
}
