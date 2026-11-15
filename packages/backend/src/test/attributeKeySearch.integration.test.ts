// D44b: a key in the one attribute key grammar (@onden/markdown
// attributeKey.ts) is a search filter (`作者:王`), against the real tables.
// The parser has unit tests (markdown/src/searchQuery.test.ts); this pins the
// SQL it feeds.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { searchNodes } from "../services/nodeSearch.js";
import { q, getWorkspaceId } from "../db.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("Unicode attribute keys in search (DB)", () => {
  let WS = "";
  let admin: ActorCtx = { id: "", name: "D44bAdmin", role: "admin", type: "human" };
  let wangId = "";
  let liId = "";
  let term = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    const stamp = Date.now();
    term = `zqdfoursearch${stamp}`;
    const seed = async (title: string, attrs: Record<string, string>) => {
      const res = await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
        [WS, `${title} ${term}`, `d44b-${title}-${stamp}`, `body ${term}`]);
      const id = res.rows[0]!.id;
      for (const [key, value] of Object.entries(attrs)) {
        await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1,$2,$3,$4)`, [WS, id, key, value]);
      }
      return id;
    };
    wangId = await seed("wang", { 作者: "王", "reading-list": "yes" });
    liId = await seed("li", { 作者: "李" });
  });

  it("作者:王 filters by the attribute", async () => {
    const ids = (await searchNodes(WS, `${term} 作者:王`, admin, 20)).map((r) => r.id);
    expect(ids).toEqual([wangId]);
    const bare = (await searchNodes(WS, "作者:李", admin, 20)).map((r) => r.id);
    expect(bare).toContain(liId);
    expect(bare).not.toContain(wangId);
  });

  it("a hyphenated key filters too", async () => {
    const ids = (await searchNodes(WS, `${term} reading-list:YES`, admin, 20)).map((r) => r.id);
    expect(ids).toEqual([wangId]);
  });
});
