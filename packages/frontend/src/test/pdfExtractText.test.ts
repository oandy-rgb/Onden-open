import { describe, expect, it } from "vitest";
import {
  PDF_TEXT_CHAR_LIMIT,
  clampForEmbedding,
  extractTextFromDocument,
  joinPages,
  pageItemsToText,
  type PdfTextItemLike,
} from "../lib/pdf/extractText";

describe("pageItemsToText", () => {
  it("joins runs on a line and breaks on hasEOL", () => {
    const items: PdfTextItemLike[] = [
      { str: "Attention" },
      { str: " is all you" },
      { str: " need", hasEOL: true },
      { str: "Ashish Vaswani", hasEOL: true },
    ];
    expect(pageItemsToText(items)).toBe("Attention is all you need\nAshish Vaswani");
  });

  it("skips marked-content markers (no str)", () => {
    const items: PdfTextItemLike[] = [
      { str: "Hello" },
      {}, // TextMarkedContent
      { str: " world", hasEOL: true },
    ];
    expect(pageItemsToText(items)).toBe("Hello world");
  });

  it("squashes excess whitespace and blank lines", () => {
    const items: PdfTextItemLike[] = [
      { str: "a   b", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "c" },
    ];
    expect(pageItemsToText(items)).toBe("a b\n\nc");
  });
});

describe("joinPages", () => {
  it("joins non-empty pages with a blank line, dropping empty ones", () => {
    expect(joinPages(["page one", "", "  ", "page two"])).toBe("page one\n\npage two");
  });
});

describe("clampForEmbedding", () => {
  it("returns text unchanged under the limit", () => {
    expect(clampForEmbedding("short", 100)).toBe("short");
  });

  it("clamps long text on a paragraph boundary", () => {
    const para = "x".repeat(70);
    const text = `${para}\n\n${"y".repeat(70)}`;
    const out = clampForEmbedding(text, 100);
    expect(out).toBe(para);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("hard-cuts when no paragraph break is near the limit", () => {
    const text = "z".repeat(200);
    expect(clampForEmbedding(text, 100)).toHaveLength(100);
  });

  it("has a sane default limit", () => {
    expect(PDF_TEXT_CHAR_LIMIT).toBeGreaterThan(10_000);
  });
});

describe("extractTextFromDocument", () => {
  it("walks every page through an injected getDocument", async () => {
    const pages = [
      [{ str: "Title", hasEOL: true }],
      [{ str: "Body of the paper.", hasEOL: true }],
    ];
    let destroyed = false;
    const getDocument = () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: (n: number) =>
          Promise.resolve({
            getTextContent: () => Promise.resolve({ items: pages[n - 1] }),
          }),
        destroy: () => {
          destroyed = true;
          return Promise.resolve();
        },
      }),
    });
    const text = await extractTextFromDocument(new ArrayBuffer(8), getDocument);
    expect(text).toBe("Title\n\nBody of the paper.");
    expect(destroyed).toBe(true);
  });
});
