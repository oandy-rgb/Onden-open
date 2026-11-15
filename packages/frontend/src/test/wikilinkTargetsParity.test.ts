import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWikilink, wikilinkReaches, type WikilinkNode } from "../lib/wikilinks";

// The app's side of the link-target fixture (packages/markdown/src/fixtures/
// wikilinkTargets.json): the same answers the SQL edge rule (backend
// wikilinkTargets.integration.test.ts) and the site's servedLinkTarget
// (markdown wikilinkTargetsFixture.test.ts) are held to.

type FixtureNote = { id: string; title: string; slug: string; space: string; aliases?: string[]; deleted?: boolean; type?: string };
const fixture = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../markdown/src/fixtures/wikilinkTargets.json"), "utf8",
)) as { notes: FixtureNote[]; cases: Array<{ name: string; from: string; link: string; reaches: string[]; opens: string | null }> };

const nodes: WikilinkNode[] = fixture.notes.map((n) => ({
  id: n.id, title: n.title, slug: n.slug, space_id: n.space,
  attrs: n.aliases ? { aliases: JSON.stringify(n.aliases) } : undefined,
  deleted_at: n.deleted ? "2026-01-01T00:00:00Z" : undefined,
  node_type: n.type ?? "content",
}));

describe("wikilink targets in the app (shared fixture)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const from = nodes.find((n) => n.id === c.from)!;
      const reaches = nodes.filter((n) => n.id !== from.id && wikilinkReaches(c.link, from, n)).map((n) => n.id);
      expect(reaches).toEqual(c.reaches);
      expect(resolveWikilink(c.link, from, nodes)?.id ?? null).toBe(c.opens);
    });
  }
});
