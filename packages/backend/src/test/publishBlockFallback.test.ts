// `[[Note#^id]]` on the published site when Note no longer holds the block:
// the link opens the published page that does (@onden/markdown
// servedBlockTarget). Only served pages are looked in, so a private note —
// never in the page list — can be neither the target nor a rival. Pure.
// 段落身分不在文字裡：served page 以 `block_ids`（它有效錨點的 id）表示「這頁有這個段落」。

import { describe, expect, it } from "vitest";
import { md2html } from "../modules/website/publishing/htmlUtils.js";

const page = (id: string, title: string, markdown: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, slug: title.toLowerCase(), markdown, ...extra });
const hrefOf = (html: string) => /href="([^"]+)"/.exec(html)?.[1] ?? null;

describe("published [[Note#^id]] fallback", () => {
  const home = page("h", "Home", "See [[Alpha#^p1]].");
  const alpha = page("a", "Alpha", "Moved away.", { block_ids: [] });
  const beta = page("b", "Beta", "The paragraph", { block_ids: ["p1"] });

  it("opens the served page that holds the block when the named one lost it", () => {
    const html = md2html(home.markdown, { pages: [home, alpha, beta], from: "h" });
    expect(hrefOf(html)).toBe("/site/beta");
    expect(html).toContain(">Alpha</a>"); // shown as written
  });

  it("keeps the named page when it still holds the block", () => {
    const keeps = page("a", "Alpha", "Still here", { block_ids: ["p1"] });
    expect(hrefOf(md2html(home.markdown, { pages: [home, keeps, beta], from: "h" }))).toBe("/site/alpha");
  });

  it("is the old link when nobody served holds the id, or several do", () => {
    expect(hrefOf(md2html("[[Alpha#^zz]]", { pages: [home, alpha, beta], from: "h" }))).toBe("/site/alpha");
    const gamma = page("c", "Gamma", "Pasted", { block_ids: ["p1"] });
    expect(hrefOf(md2html(home.markdown, { pages: [home, alpha, beta, gamma], from: "h" }))).toBe("/site/alpha");
  });

  it("prefers a page under the named one", () => {
    const gamma = page("c", "Gamma", "Pasted", { block_ids: ["p1"] });
    const child = page("b", "Beta", "The paragraph", { parent_id: "a", block_ids: ["p1"] });
    expect(hrefOf(md2html(home.markdown, { pages: [home, alpha, gamma, child], from: "h" }))).toBe("/site/beta");
  });

  it("a private note is not in the page list, so it is not found and does not make the link ambiguous", () => {
    // The unpublished note holds the id too; the site never sees it.
    const html = md2html(home.markdown, { pages: [home, alpha, beta], from: "h" });
    expect(html).not.toContain("Private");
    expect(hrefOf(html)).toBe("/site/beta");
    const onlyPrivate = md2html(home.markdown, { pages: [home, alpha], from: "h" });
    expect(hrefOf(onlyPrivate)).toBe("/site/alpha");
  });

  it("works in the zip export's relative addresses", () => {
    expect(hrefOf(md2html(home.markdown, { pages: [home, alpha, beta], from: "h", relative: true }))).toBe("../beta/");
  });
});
