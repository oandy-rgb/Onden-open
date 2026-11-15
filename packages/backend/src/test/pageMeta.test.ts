// A page's title for a bookmark and for quick capture's shared link
// (services/pageMeta.ts): og:title first, then <title>, then the fallback.
import { describe, expect, it } from "vitest";
import { pageMetaFromHtml } from "../services/pageMeta.js";

describe("pageMetaFromHtml", () => {
  it("prefers og:title, in either attribute order, and decodes entities", () => {
    expect(pageMetaFromHtml(`<meta property="og:title" content="Tom &amp; Jerry"><title>x</title>`, "host").title).toBe("Tom & Jerry");
    expect(pageMetaFromHtml(`<meta content='Reversed' property='og:title'>`, "host").title).toBe("Reversed");
  });

  it("falls back to <title>, then to the fallback", () => {
    expect(pageMetaFromHtml("<html><title> 標題 </title></html>", "host").title).toBe("標題");
    expect(pageMetaFromHtml("<html></html>", "example.com").title).toBe("example.com");
    expect(pageMetaFromHtml("<html></html>", "").title).toBe("");
  });

  it("reads the description and og:image", () => {
    const meta = pageMetaFromHtml(`<meta name="description" content="About"><meta property="og:image" content="https://x/i.png">`, "h");
    expect(meta).toEqual({ title: "h", description: "About", imageUrl: "https://x/i.png" });
  });
});
