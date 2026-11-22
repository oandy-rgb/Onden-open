// The PDF worker's address: the root for the web and Android builds, next to the page for the browser version
// (it can be served from a sub-folder, and "/pdf.worker.min.mjs" would then be the host's root, not ours).
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs"); document.head.querySelectorAll("base").forEach((b) => b.remove()); });

/** The address loadPdfCore hands pdf.js as its worker, for a page whose base is `href`. */
async function workerSrcFor(href: string): Promise<string> {
  const GlobalWorkerOptions: { workerSrc?: string } = {};
  vi.resetModules();
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions }));
  document.head.querySelectorAll("base").forEach((b) => b.remove());
  const base = document.createElement("base");
  base.href = href;
  document.head.append(base);
  await (await import("../lib/pdf/pdfjs")).loadPdfCore();
  return GlobalWorkerOptions.workerSrc ?? "";
}

describe("the worker pdf.js is pointed at", () => {
  it("is the site root in the web and Android builds, wherever the page is", async () => {
    expect(await workerSrcFor("https://example.test/some/folder/")).toBe("/pdf.worker.min.mjs");
  });

  it("is next to the page in the browser version, at the root and in a sub-folder", async () => {
    vi.stubEnv("VITE_BROWSER_APP", "true");
    expect(await workerSrcFor("https://example.test/")).toBe("https://example.test/pdf.worker.min.mjs");
    expect(await workerSrcFor("https://example.test/onden/pr-1830/")).toBe("https://example.test/onden/pr-1830/pdf.worker.min.mjs");
  });
});
