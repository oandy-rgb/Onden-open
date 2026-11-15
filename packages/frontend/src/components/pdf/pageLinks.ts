// The links of one PDF page, as boxes in percent of the page (so they follow any zoom without being
// laid out again). Pure: pdf.js's annotation objects and a rect converter come in. Only link
// annotations are read; the page's other annotations are painted into its canvas by pdf.js itself.

/** The slice of a pdf.js annotation this reads. */
export interface PdfAnnotationLike {
  subtype?: string;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  /** A named destination or an explicit one ([pageRef, "XYZ", …]). */
  dest?: unknown;
}

export interface PdfLinkBox {
  /** Percent of the page's width / height. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** An address to open in a new tab (already checked), or null for a link inside the document. */
  href: string | null;
  dest: unknown;
}

/** `toViewport` maps a PDF-space rect to [x1, y1, x2, y2] in the page's scale-1 viewport (pdf.js
 *  viewport.convertToViewportPoint on both corners); `safeUrl` returns a usable absolute address or null. */
export function pageLinkBoxes(
  annotations: readonly PdfAnnotationLike[],
  size: { width: number; height: number },
  toViewport: (rect: number[]) => number[],
  safeUrl: (url: string) => string | null,
): PdfLinkBox[] {
  const boxes: PdfLinkBox[] = [];
  for (const a of annotations) {
    if (a.subtype !== "Link" || !a.rect || a.rect.length < 4) continue;
    const address = a.url ?? a.unsafeUrl;
    const href = address ? safeUrl(address) : null;
    // A link with an address we will not open, or with nothing to go to, is not offered.
    if ((address && !href) || (!address && a.dest == null)) continue;
    const [x1, y1, x2, y2] = toViewport(a.rect) as [number, number, number, number];
    const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
    if (!(width > 0) || !(height > 0)) continue;
    boxes.push({
      left: (Math.min(x1, x2) / size.width) * 100,
      top: (Math.min(y1, y2) / size.height) * 100,
      width: (width / size.width) * 100,
      height: (height / size.height) * 100,
      href,
      dest: href ? null : a.dest,
    });
  }
  return boxes;
}
