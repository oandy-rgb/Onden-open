// A published page's [[link]] to another published note BY ONE OF ITS
// ALIASES is a link, not "(private)": the snapshot's redaction follows the
// app's one link rule (title, slug or alias), as the wikilink edges do.
// The snapshot names that note by its served slug instead (option 3, user
// decision 2026-10-19), keeping the text the reader sees, and lists no
// aliases: an alias no published link uses never leaves the server.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import { publishedAliases } from "../modules/website/publishing/redaction.js";
import { md2html } from "../modules/website/publishing/htmlUtils.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// The file's own workspace: the site candidate is built from every published
// note of the workspace, and the shared default one may hold other tests'
// published "Guide" or "Roadmap" notes.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
const stamp = Date.now();

async function note(title: string, markdown: string, published: boolean, aliases?: string): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/\s+/g, "-")}-${stamp}`, markdown],
  )).rows[0]!.id;
  // The default space publishes; an unpublished note is one kept off (「不發布」).
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($2, $1, '_published', $3, 'bool')`,
    [id, WS, published ? "true" : "false"]);
  if (aliases !== undefined) {
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($2, $1, 'aliases', $3, 'text')`, [id, WS, aliases]);
  }
  return id;
}

describe.skipIf(!isTestDb)("publish redaction resolves aliases (DB)", () => {
  let home = "", guide = "", faq = "", code = "";
  // An alias of a published note that no link uses: it must not be published.
  const nickname = `Pocketbook${stamp}`;
  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Alias links', $1) RETURNING id::text`, [`alias-${randomUUID()}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    guide = await note("User guide", "how to", true, JSON.stringify(["Guide", "手冊", nickname]));
    faq = await note("Questions", "answers", true, "FAQ");
    await note("Secret plans", "private", false, JSON.stringify(["Roadmap"]));
    home = await note("Home", "Read the [[guide]], the [[手冊#安裝]], the [[FAQ]] and the [[Roadmap]].", true);
    code = await note("Links", [
      "[[Guide|the manual]], [[guide#Setup|setup]], [[FAQ#^b1]] and [[Questions]].",
      "Inline `[[Guide]]` stays code.",
      "```",
      "[[FAQ]] in a fence",
      "```",
    ].join("\n"), true);
  });

  it("reads both alias forms (JSON array and a bare value)", async () => {
    const map = await publishedAliases([guide, faq, home]);
    expect(map.get(guide)).toEqual(["Guide", "手冊", nickname]);
    expect(map.get(faq)).toEqual(["FAQ"]);
    expect(map.has(home)).toBe(false);
  });

  it("keeps links to published notes by alias, by the served slug; an unpublished note's alias is still redacted", async () => {
    const c = await buildCandidate(WS, { title: "Site" });
    const nodes = c.payload.nodes as Array<{ id: string; title: string; slug: string; markdown: string; aliases?: unknown }>;
    const slug = (id: string) => nodes.find((n) => n.id === id)!.slug;
    expect(nodes.find((n) => n.id === home)!.markdown).toBe(
      `Read the [[${slug(guide)}|guide]], the [[${slug(guide)}#安裝|手冊#安裝]], the [[${slug(faq)}|FAQ]] and the (private).`);
    expect(c.privateLinks).toEqual([{ nodeId: home, nodeTitle: "Home", target: "Roadmap", shownAs: "(private)" }]);
    // Aliases decide the redaction and the rewrite; they are not added to the payload.
    expect(nodes.every((n) => !("aliases" in n))).toBe(true);
  });

  it("keeps a label and a fragment, leaves a link by title and an alias in code as written", async () => {
    const c = await buildCandidate(WS, { title: "Site" });
    const nodes = c.payload.nodes as Array<{ id: string; title: string; slug: string; markdown: string }>;
    const slug = (id: string) => nodes.find((n) => n.id === id)!.slug;
    expect(nodes.find((n) => n.id === code)!.markdown).toBe([
      `[[${slug(guide)}|the manual]], [[${slug(guide)}#Setup|setup]], [[${slug(faq)}#^b1|FAQ]] and [[Questions]].`,
      "Inline `[[Guide]]` stays code.",
      "```",
      "[[FAQ]] in a fence",
      "```",
    ].join("\n"));
    // The rewritten links open the right served pages with no alias list.
    const html = md2html(nodes.find((n) => n.id === home)!.markdown, { pages: nodes, from: home });
    expect(html).toContain(`href="/site/${slug(guide)}">guide</a>`);
    expect(html).toContain(`href="/site/${slug(faq)}">FAQ</a>`);
  });

  it("an alias nothing links to appears nowhere in the payload", async () => {
    const c = await buildCandidate(WS, { title: "Site" });
    const json = JSON.stringify(c.payload);
    expect(json).not.toContain(nickname);
    // Nor do the aliases the links used, other than as the text readers see.
    expect(json).not.toContain('"aliases"');
    expect(json).not.toContain("Roadmap");
  });
});
