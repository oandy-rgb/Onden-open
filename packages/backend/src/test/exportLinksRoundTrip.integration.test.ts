// A Markdown export opens in Obsidian with its links intact: every file is
// named by its note's title (what Obsidian resolves `[[Title]]` by), the
// folders follow the note tree, and a link whose note had to be written under
// another file name (a title with `:` or a duplicate title in one folder)
// names that file. Importing the same files back gives the same link graph.
// Goes through the shipped export and folder-import routes, as the app does.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import exportRouter from "../routes/export.js";
import { createNote } from "../services/noteCreate.js";
import { readFrontmatter, entryValue, replaceWikilinks, wikilinkTarget, attributeValues } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const actor: ActorCtx = { id: "export-links-rt", name: "Links", type: "human", role: "admin" };

function app() {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/import", importRouter);
  hono.route("/api/export", exportRouter);
  return hono;
}

const aliasesOf = (text: string) => {
  const entry = readFrontmatter(text)?.entries.find((e) => e.key === "aliases");
  return entry ? attributeValues(JSON.stringify(entryValue(entry))) : [];
};

/** How Obsidian resolves a link target in a vault: a file's name (the path
 *  from the vault root, or just its last part) or an alias in its frontmatter. */
function obsidianResolves(target: string, files: Map<string, string>): boolean {
  const key = target.toLowerCase();
  for (const [path, text] of files) {
    const noExt = path.replace(/\.md$/, "");
    if (noExt.toLowerCase() === key || noExt.split("/").pop()!.toLowerCase() === key) return true;
    if (aliasesOf(text).some((a) => a.toLowerCase() === key)) return true;
  }
  return false;
}

describe.skipIf(!isTestDatabase())("Markdown export keeps [[links]] resolvable in a vault", () => {
  const stamp = randomUUID().slice(0, 8);
  const t = (name: string) => `${name} ${stamp}`;
  const ids = new Map<string, string>();
  let ws = "";
  let files: Map<string, string>;
  let edgesBefore: string[];

  const edges = async () => (await q<{ pair: string }>(
    `SELECT s.title || ' -> ' || t.title AS pair FROM node_edges e
       JOIN content_nodes s ON s.id = e.source_node_id JOIN content_nodes t ON t.id = e.target_node_id
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink' AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.title LIKE $2
      ORDER BY 1`, [ws, `%${stamp}`])).rows.map((r) => r.pair);

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Links', $1) RETURNING id::text`, [`links-rt-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
    await q(`DELETE FROM space_members m USING spaces s WHERE s.id = m.space_id AND s.workspace_id = $1 AND s.is_default AND m.actor_id = $2`, [ws, actor.id]);
    // Ten notes that link to each other, one tree: 課程 > 第一章 > 排序.
    const spec: Array<[string, string | null, string]> = [
      ["課程", null, `[[${t("第一章")}]] and [[${t("Chapter 1: Intro")}|the intro]]`],
      ["第一章", "課程", `back to [[${t("課程")}]]; [[${t("排序")}]]`],
      ["排序", "第一章", `[[${t("Chapter 1: Intro")}#Heading]] and [[${t("Notes")}]]`],
      ["Chapter 1: Intro", null, `![[${t("Paper")}]] [[${t("What? <now>")}]]`],
      ["What? <now>", null, `[[${t("Chapter 1: Intro")}]]`],
      ["Notes", null, `first, links to [[${t("Paper")}]]`],
      ["Paper", null, `[[${t("Notes")}]] and \`[[${t("code")}]]\``],
      ["Orphan", null, "no links"],
      ["Hub", null, ["課程", "第一章", "排序", "Chapter 1: Intro", "Paper"].map((n) => `[[${t(n)}]]`).join(" ")],
      ["Hub2", null, `[[${t("Hub")}]]`],
    ];
    for (const [name, parent, markdown] of spec) {
      const created = await createNote({ actor, workspaceId: ws, title: t(name), markdown, parentId: parent ? ids.get(parent)! : null, event: { uiContext: "test.links" } });
      ids.set(name, String(created.node.id));
    }
    // A second note of the same title in the same folder gets "… 2.md".
    const dup = await createNote({ actor, workspaceId: ws, title: t("Notes"), markdown: `the other, [[${t("Paper")}]]`, parentId: null, event: { uiContext: "test.links" } });
    ids.set("Notes#2", String(dup.node.id));
    // Two "Meeting" at the root and a "Meeting 2" in folder P: the second
    // Meeting's file must not become `Meeting 2`, a name that is already a title.
    ids.set("Meeting", String((await createNote({ actor, workspaceId: ws, title: t("Meeting"), markdown: "a", parentId: null, event: { uiContext: "test.links" } })).node.id));
    ids.set("Meeting#2", String((await createNote({ actor, workspaceId: ws, title: t("Meeting"), markdown: "b", parentId: null, event: { uiContext: "test.links" } })).node.id));
    ids.set("P", String((await createNote({ actor, workspaceId: ws, title: t("P"), markdown: "folder", parentId: null, event: { uiContext: "test.links" } })).node.id));
    ids.set("Meeting 2", String((await createNote({ actor, workspaceId: ws, title: `${t("Meeting")} 2`, markdown: "c", parentId: ids.get("P")!, event: { uiContext: "test.links" } })).node.id));
    edgesBefore = await edges();
    const res = await app().request("/api/export/markdown.zip");
    expect(res.status).toBe(200);
    files = new Map([...zipEntries(Buffer.from(await res.arrayBuffer()))].filter(([n]) => n.endsWith(".md")).map(([n, d]) => [n, d.toString("utf8")]));
  });

  it("names files by title and folders by the note tree", () => {
    const paths = [...files.keys()];
    expect(paths).toContain(`${t("課程")}.md`);
    expect(paths).toContain(`${t("課程")}/${t("第一章")}.md`);
    expect(paths).toContain(`${t("課程")}/${t("第一章")}/${t("排序")}.md`);
    // `:` is not allowed in a file name; a duplicate title gets " 2".
    expect(paths).toContain(`${t("Chapter 1 Intro")}.md`);
    expect(paths).toContain(`${t("Notes")}.md`);
    expect(paths).toContain(`${t("Notes")} 2.md`);
    expect(paths.filter((p) => p.includes(stamp) && /-[0-9a-f]{6}\.md$/.test(p))).toEqual([]);
  });

  it("a generated file name never equals another note's title or alias, in any folder", () => {
    const paths = [...files.keys()].filter((p) => p.includes(stamp));
    expect(paths).toContain(`${t("P")}/${t("Meeting")} 2.md`);
    const titleKeys = new Map<string, number>();
    const aliasKeys = new Map<string, number>();
    for (const [path, text] of files) {
      if (!text.includes(stamp)) continue;
      const title = readFrontmatter(text)?.entries.find((e) => e.key === "title");
      const name = title ? String(entryValue(title)).toLowerCase() : "";
      titleKeys.set(name, (titleKeys.get(name) ?? 0) + 1);
      for (const a of aliasesOf(text)) aliasKeys.set(a.toLowerCase(), (aliasKeys.get(a.toLowerCase()) ?? 0) + 1);
      void path;
    }
    for (const [alias, count] of aliasKeys) {
      expect(count, `alias ${alias} on several notes`).toBe(1);
      expect(titleKeys.has(alias), `alias ${alias} is also a title`).toBe(false);
    }
  });

  it("every [[link]] in every file reaches a file or an alias in the vault", () => {
    let checked = 0;
    for (const [path, text] of files) {
      if (!text.includes(stamp)) continue;
      const body = text.slice(text.indexOf("\n---", 3) + 4).replace(/```[\s\S]*?```|`[^`\n]*`/g, "");
      replaceWikilinks(body, (b, full) => {
        const target = wikilinkTarget(b);
        if (target) { expect(obsidianResolves(target, files), `${path}: ${full}`).toBe(true); checked++; }
        return full;
      });
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it("a link to a note written under another file name names that file and keeps what the reader saw", () => {
    expect(files.get(`${t("Chapter 1 Intro")}.md`)).toContain(`aliases:`);
    const course = files.get(`${t("課程")}.md`)!;
    expect(course).toContain(`[[${t("Chapter 1 Intro")}|the intro]]`);
    expect(files.get(`${t("課程")}/${t("第一章")}/${t("排序")}.md`)).toContain(`[[${t("Chapter 1 Intro")}#Heading|${t("Chapter 1: Intro")}]]`);
    // A link inside code is quoted as written.
    expect(files.get(`${t("Paper")}.md`)).toContain(`\`[[${t("code")}]]\``);
  });

  it("importing the files gives the same notes, tree and link graph", async () => {
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [[...ids.values()]]);
    const body = { source: { id: randomUUID(), name: `links ${stamp}` }, upsert: true,
      files: [...files].filter(([, text]) => text.includes(stamp)).map(([path, content]) => ({ path, content })) };
    const res = await app().request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const result = await res.json() as { imported: number; skipped: number };
    expect(result).toMatchObject({ imported: 15, skipped: 0 });
    // The tree: 排序 is under 第一章, under 課程.
    const parentTitle = async (name: string) => (await q<{ p: string | null }>(
      `SELECT p.title AS p FROM content_nodes c LEFT JOIN content_nodes p ON p.id = c.parent_id WHERE c.workspace_id = $1 AND c.title = $2 AND c.deleted_at IS NULL`, [ws, t(name)])).rows[0]?.p;
    expect(await parentTitle("排序")).toBe(t("第一章"));
    expect(await parentTitle("第一章")).toBe(t("課程"));
    // Titles come back as written (not as file names).
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, t("Chapter 1: Intro")])).rows).toHaveLength(1);
    // The link graph is the same (the duplicate title links to the same targets).
    expect([...new Set(await edges())]).toEqual([...new Set(edgesBefore)]);
  });
});
