// A stand-in for pdf.js core (lib/pdf/pdfjs.ts), for tests that mount a PDF note without a real
// PDF: pages of chosen sizes, a record of what was drawn, no canvas and no worker.
//
//   vi.mock("../lib/pdf/pdfjs", async () => (await import("./helpers/fakePdf")).fakePdfjsModule());
//   fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800, rotation: 90 }];
//   await settlePdf();   // after render(): the document opens and page 1 is read

import { act } from "@testing-library/react";

export interface FakePage { width: number; height: number; rotation?: number }

export const fakePdf = {
  /** The document's pages (points, before rotation). */
  pages: [{ width: 600, height: 800 }] as FakePage[],
  /** Every page.render call: page number and the scale it was drawn at. */
  renders: [] as Array<{ page: number; scale: number; cancelled: boolean }>,
  /** Page numbers whose text layer was built. */
  textLayers: [] as number[],
  cleaned: [] as number[],
  annotations: {} as Record<number, unknown[]>,
  destinations: {} as Record<string, unknown>,
  /** Page numbers getPage was asked for. */
  pageRequests: [] as number[],
  /** While true, page.render does not finish until releaseRenders(). */
  holdRenders: false,
  /** While true, the document fails to open. */
  failOpen: false,
  pendingRenders: [] as Array<() => void>,
  reset() {
    this.holdRenders = false;
    this.failOpen = false;
    this.pendingRenders = [];
    this.pages = [{ width: 600, height: 800 }];
    this.renders = [];
    this.textLayers = [];
    this.cleaned = [];
    this.annotations = {};
    this.destinations = {};
    this.pageRequests = [];
  },
};

function viewportOf(spec: FakePage, scale: number) {
  const turned = (spec.rotation ?? 0) % 180 !== 0;
  const width = (turned ? spec.height : spec.width) * scale;
  const height = (turned ? spec.width : spec.height) * scale;
  return {
    width, height, scale, rotation: spec.rotation ?? 0,
    // Unrotated pages only: y flips (PDF space is bottom-up).
    convertToViewportPoint: (x: number, y: number): [number, number] => [x * scale, height - y * scale],
  };
}

function makePage(n: number) {
  const spec = fakePdf.pages[n - 1]!;
  return {
    getViewport: ({ scale }: { scale: number }) => viewportOf(spec, scale),
    render: ({ viewport }: { viewport: { scale: number } }) => {
      const record = { page: n, scale: viewport.scale, cancelled: false };
      fakePdf.renders.push(record);
      const promise = fakePdf.holdRenders ? new Promise<void>((resolve) => { fakePdf.pendingRenders.push(resolve); }) : Promise.resolve();
      return { promise, cancel: () => { record.cancelled = true; } };
    },
    streamTextContent: () => ({ page: n }),
    getAnnotations: async () => fakePdf.annotations[n] ?? [],
    cleanup: () => { fakePdf.cleaned.push(n); return true; },
  };
}

export function fakePdfjsModule() {
  class TextLayer {
    constructor(opts: { textContentSource: { page: number } }) { fakePdf.textLayers.push(opts.textContentSource.page); }
    render() { return Promise.resolve(); }
    update() {}
    cancel() {}
  }
  const doc = {
    get numPages() { return fakePdf.pages.length; },
    getPage: async (n: number) => { fakePdf.pageRequests.push(n); return makePage(n); },
    getDestination: async (name: string) => fakePdf.destinations[name] ?? null,
    getPageIndex: async (ref: { num: number }) => ref.num - 1,
  };
  const core = {
    getDocument: () => ({ promise: fakePdf.failOpen ? Promise.reject(new Error("Invalid PDF structure.")) : Promise.resolve(doc), destroy: async () => {} }),
    TextLayer,
    createValidAbsoluteUrl: (url: string) => { try { const u = new URL(url); return /^(https?|mailto):$/.test(u.protocol) ? u : null; } catch { return null; } },
    GlobalWorkerOptions: {},
  };
  return { loadPdfCore: async () => core, PDF_WORKER_SRC: "/pdf.worker.min.mjs" };
}

/** Let the document open and the pages be read (promise hops only: no timers). */
export async function settlePdf(): Promise<void> {
  await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
}

/** Finish the renders held by `holdRenders`. */
export async function releaseRenders(): Promise<void> {
  await act(async () => {
    const pending = fakePdf.pendingRenders.splice(0);
    for (const finish of pending) finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
