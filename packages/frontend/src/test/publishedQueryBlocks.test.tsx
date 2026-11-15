// D113: on the published site an onden-query / onden-base block shows the
// result frozen at publish time (the page's `query_blocks`), listing
// published notes only. The published profile never mounts the live query
// components (OndenQueryBlock posts to the authenticated /api/query, so an
// anonymous visitor saw {"error":"unauthorized"}) and makes no request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrozenQueryBlock } from "@onden/markdown";

// Spies in place of the live components: the guard below checks the
// published profile never renders them, while the app profile still does.
const live = vi.hoisted(() => ({ query: 0, base: 0 }));
vi.mock("../components/OndenQueryBlock", () => ({
  default: () => { live.query += 1; return <div className="live-query" />; },
}));
vi.mock("../components/OndenBaseBlock", () => ({
  default: () => { live.base += 1; return <div className="live-base" />; },
}));

import MarkdownRenderer from "../components/MarkdownRenderer";
import { makeSiteMarkdown } from "../components/siteFrame/siteMarkdown";
import type { PublishedNode } from "../components/templates/publishedCore";

const QUERY = "tags: reading\nsort: title";
const BASE = "views:\n  - type: table\n    order: [file.name, stage]";
const md = `Intro\n\n\`\`\`onden-query\n${QUERY}\n\`\`\`\n\n\`\`\`onden-base\n${BASE}\n\`\`\`\n`;

const frozen: FrozenQueryBlock[] = [
  { lang: "onden-query", source: QUERY, columns: [], rows: [
    { id: "a", title: "Alpha", slug: "alpha" },
    { id: "b", title: "Beta", slug: "beta" },
  ], more: 3 },
  { lang: "onden-base", source: BASE, columns: ["stage"], rows: [{ id: "a", title: "Alpha", slug: "alpha", values: ["draft"] }], more: 0 },
];

const page = (id: string, extra: Partial<PublishedNode> = {}): PublishedNode =>
  ({ id, node_type: "content", title: id, slug: id, markdown: "", ...extra });

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  live.query = 0;
  live.base = 0;
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("query blocks on the published site (D113)", () => {
  it("renders the frozen list and table, linking published pages, with no request and no error text", () => {
    const navs: Array<[string, string | null]> = [];
    const { container } = render(
      <MarkdownRenderer profile="published" linkStyle="published" queryBlocks={frozen}
        nodes={[page("alpha"), { id: "a", slug: "alpha", title: "Alpha" }]}
        onNavigate={(slug, id) => navs.push([slug, id])}>
        {md}
      </MarkdownRenderer>,
    );
    const items = Array.from(container.querySelectorAll(".onden-query-frozen-list li")).map((li) => li.textContent);
    expect(items).toEqual(["Alpha", "Beta"]);
    expect(container.querySelector(".onden-query-frozen-more")?.textContent).toMatch(/3/);
    const cells = Array.from(container.querySelectorAll(".onden-query-frozen-table td")).map((td) => td.textContent);
    expect(cells).toEqual(["Alpha", "draft"]);
    // Alpha is a page of the site: a link. Beta is not (taken down): text.
    const link = container.querySelector<HTMLButtonElement>(".onden-query-frozen-list button.published-inline-link")!;
    fireEvent.click(link);
    expect(navs).toEqual([["alpha", "a"]]);
    expect(container.querySelectorAll(".onden-query-frozen-list button")).toHaveLength(1);
    // Neither the query's source nor a live block, nor any request.
    expect(container.textContent).not.toContain("tags: reading");
    expect(container.textContent).not.toContain("unauthorized");
    expect(container.querySelector("pre")).toBeNull();
    expect(live).toEqual({ query: 0, base: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a page with no frozen result (published before D113) says so and runs nothing", () => {
    const { container } = render(<MarkdownRenderer profile="published">{md}</MarkdownRenderer>);
    expect(container.querySelectorAll(".onden-query-frozen-note")).toHaveLength(2);
    expect(live).toEqual({ query: 0, base: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the site's render callback shows each page's own frozen result", () => {
    const nodes = [page("host", { query_blocks: [frozen[0]!] }), page("other", {
      query_blocks: [{ ...frozen[0]!, rows: [{ id: "x", title: "Other result", slug: "x" }] }],
    })];
    const renderBody = makeSiteMarkdown(nodes);
    const { container } = render(<>{renderBody(`\`\`\`onden-query\n${QUERY}\n\`\`\``, "host")}</>);
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).not.toContain("Other result");
    expect(live.query).toBe(0);
  });

  it("the app profile still mounts the live blocks", async () => {
    render(<MarkdownRenderer queryBlocks={frozen}>{md}</MarkdownRenderer>);
    // The live blocks are lazy chunks (the site never loads them).
    await waitFor(() => expect(live).toEqual({ query: 1, base: 1 }));
  });
});

// Guard: the only way into the live components is the app profile's branch
// of MarkdownRenderer's code override, after the published branch returned.
describe("guard: the published profile never mounts the live query components", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components/MarkdownRenderer.tsx"), "utf8");
  it("returns the frozen result before any live block", () => {
    const published = src.indexOf('profile === "published" && isQueryBlockLang(lang)');
    expect(published).toBeGreaterThan(0);
    expect(published).toBeLessThan(src.indexOf("<OndenQueryBlock"));
    expect(published).toBeLessThan(src.indexOf("<OndenBaseBlock"));
  });
  it("no published page imports the live components", () => {
    const templates = ["templates/publishedCore.tsx", "siteFrame/siteMarkdown.tsx", "siteFrame/SiteFrames.tsx"];
    for (const file of templates) {
      const text = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components", file), "utf8");
      expect(text).not.toMatch(/OndenQueryBlock|OndenBaseBlock/);
    }
  });
});
