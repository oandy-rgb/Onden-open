import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAllEnhancers } from "@onden/markdown";
import { defaultDesign } from "@onden/site";
import type { PublishPreview } from "@onden/contract";
import { withDesign, siteDataOfPreview } from "./previewSite";

beforeAll(async () => { await loadAllEnhancers(); });

// A publish preview as the server answers it: what buildCandidate / freezeDesign made of the owner's
// notes. The private link already reads 「(private)」, the hidden tag is on no chip, the parent tag's page
// lists the child tag's note, and the tag page carries its saved view's kind.
const note = (id: string, title: string, markdown: string, tags: string[]) =>
  ({ id, node_type: "content", title, slug: id, markdown, tags, created_at: "2026-02-03T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" });
const row = (id: string, title: string) => ({ id, title, slug: id, date: "2026-02-03", fields: {}, image: "", excerpt: "" });
const serverPreview = {
  hash: "h", live: null, diff: {}, private_links: [],
  site: {
    title: "花園", home_node_id: "home",
    payload: {
      nodes: [
        note("home", "首頁", "# 首頁\n\n你好", []),
        note("a", "堆肥", "# 堆肥\n\n見 (private) 與 [[播種]]。", ["花園"]),
        note("b", "播種", "# 播種\n\n春天。", ["花園"]),
      ],
      edges: [],
      presentation: {
        site: { brand: "花園" },
        design: { ...defaultDesign(), resolved: {}, tag_names: { t1: "花園" }, tag_pages: { t1: { name: "花園", slug: "hua-yuan", viewKind: "table", rows: [row("a", "堆肥"), row("b", "播種")] } } },
      },
    },
  },
} as unknown as PublishPreview;

describe("the website screen draws the server's candidate", () => {
  const data = siteDataOfPreview(serverPreview);

  it("holds exactly the notes, chips and tag pages the server froze — nothing added or re-derived", () => {
    expect(data.nodes.map((n) => n.id)).toEqual(["home", "a", "b"]);
    expect(data.nodes[1]!.markdown).toBe("# 堆肥\n\n見 (private) 與 [[播種]]。");
    expect(data.nodes[1]!.tags).toEqual(["花園"]);
    expect(data.design.tag_pages).toEqual((serverPreview.site.payload.presentation as { design: { tag_pages: unknown } }).design.tag_pages);
    expect(data.design.tag_pages.t1!.viewKind).toBe("table");
    expect(data.homeNodeId).toBe("home");
  });

  it("the design being edited is laid over it without touching what the server froze", () => {
    const edited = { ...defaultDesign(), css: ".s-w{}" };
    const shown = withDesign(data, edited);
    expect(shown.design.css).toBe(".s-w{}");
    expect(shown.design.tag_pages).toBe(data.design.tag_pages);
    expect(shown.nodes).toBe(data.nodes);
  });
});

describe("the screen has one reader projection: the server's", () => {
  // What makes a reader's view — private links, which tags show, which notes a tag lists, how a tag lists them —
  // is decided by the publish snapshot. The website screen reading anything of these itself would be a second copy.
  const files = readdirSync(__dirname).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
  const FORBIDDEN = /\b(slugify|noteSummary|nodeTagIds|studioTags|inertUnpublishedWikilinks|redactPayloadNodes|tagSlugs|siteRowOf|viewKind\s*:)/;
  it.each(files)("%s builds no reader rows of its own", (file) => {
    const code = readFileSync(join(__dirname, file), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
    // useSiteSetup reads the nodes' tags only to know when to ask the server again.
    const allowed = file === "useSiteSetup.ts" ? code.replace(/nodeTagIds/g, "") : code;
    expect(FORBIDDEN.test(allowed), `${file} must not build the reader's view`).toBe(false);
  });
});
