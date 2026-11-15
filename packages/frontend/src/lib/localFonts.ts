// What fonts this device has: the one place that asks the browser. Used only by the font
// settings and the font sync, which load on use (never at boot).
//
//   • hasFont(name)       whether a family is installed (or bundled with the app) on this device
//   • installedFonts()    the installed families by name, where the browser lets us list them
//                         (Local Font Access, `queryLocalFonts`: Chromium on desktop and
//                         tablet, after a permission prompt); null where it cannot or the person declined
//
// `document.fonts.check` alone cannot tell: it answers true for a family it has never
// heard of. So a family counts as present when a line of text in it measures differently
// from the same text in the plain fallback, for two different fallbacks (a face that happens
// to be as wide as one fallback is not as wide as both).

type LocalFontData = { family: string };
type QueryLocalFonts = () => Promise<LocalFontData[]>;

const PROBE_TEXT = "mmmmmmmmmmlliWWWW一二三永";
const FALLBACKS = ["monospace", "serif"] as const;

type Measure = (font: string) => number | null;

function canvasMeasure(): Measure | null {
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!context) return null;
  return (font) => { context.font = font; return context.measureText(PROBE_TEXT).width; };
}

const quoted = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

/** Whether this device has the family. Where the browser cannot measure (no canvas) it
 *  answers true: the page then shows no warning it cannot back up. `measure` is for tests. */
export function hasFont(name: string, measure: Measure | null = canvasMeasure()): boolean {
  if (!name.trim()) return false;
  if (!measure) return true;
  return FALLBACKS.some((fallback) => {
    const withName = measure(`40px ${quoted(name)}, ${fallback}`);
    const without = measure(`40px ${fallback}`);
    return withName !== null && without !== null && withName !== without;
  });
}

/** Whether the browser can list installed fonts (it may still ask the person first). */
export function canListInstalledFonts(): boolean {
  return typeof window !== "undefined" && typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function";
}

/** The installed families, sorted, each once; null where the browser cannot list them or the
 *  person said no. Call it from a tap: the browser asks for permission then. */
export async function installedFonts(): Promise<string[] | null> {
  if (!canListInstalledFonts()) return null;
  try {
    const query = (window as unknown as { queryLocalFonts: QueryLocalFonts }).queryLocalFonts;
    const faces = await query.call(window);
    return [...new Set(faces.map((face) => face.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}
