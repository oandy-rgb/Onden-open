// The Citations module is gone (migration 193), and notes that still hold `[@key]` keep working:
// they open, save, export through the published-site renderer and sync as plain text; nothing derives
// edges from them; the old routes answer 404; the module is not in the registry or the module list.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { MODULES } from "../modules/index.js";
import { Hono } from "hono";
import { mountModules } from "../modules/index.js";
import type { ModuleApp } from "../modules/types.js";
import { libraryModuleIds } from "../services/workspaceModules.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { md2html } from "../modules/website/publishing/index.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";

const TEXT = "As shown [@lee2020] and [see @kim2019, p. 3], mail ann@example.com.";

describe("the Citations module is not registered", () => {
  it("is in neither the module registry nor the library list", () => {
    expect(MODULES.map((m) => m.id)).not.toContain("citations");
    expect(libraryModuleIds()).not.toContain("citations");
  });

  it("every former route answers 404", async () => {
    const app = new Hono() as unknown as ModuleApp;
    mountModules(app, MODULES);
    for (const [method, path] of [["GET", "/api/citations/papers"], ["GET", "/api/citations/bibtex"], ["POST", "/api/citations/doi"], ["POST", "/api/citations/bibtex"], ["PUT", `/api/citations/papers/${randomUUID()}/citekey`]] as const) {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("[@key] is plain text to the published-site renderer", () => {
    const html = md2html(TEXT);
    expect(html).toContain("[@lee2020]");
    expect(html).toContain("[see @kim2019, p. 3]");
    expect(html).not.toMatch(/<a [^>]*kim2019/);
  });
});

describe.skipIf(!isTestDatabase())("notes with an existing [@key] (DB)", () => {
  let ws = "";
  let actor: ActorCtx = { id: "c-removed-owner", name: "Owner", role: "admin", type: "human" };

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Citations removed', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(ws, actor);
  });

  it("is created, saved again and read back with the text exactly as written, and makes no edge", async () => {
    const created = (await createNote({ actor, workspaceId: ws, title: "Old paper note", markdown: TEXT, event: { uiContext: "test.citations-removed" } })).node.id as string;
    const read = async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [created])).rows[0]!.markdown;
    expect(await read()).toBe(TEXT);
    await updateNode(ws, created, { markdown: `${TEXT}\n\nAnd more, [@park2021].` }, { actor });
    expect(await read()).toBe(`${TEXT}\n\nAnd more, [@park2021].`);
    expect((await q(`SELECT 1 FROM node_edges WHERE source_node_id = $1`, [created])).rowCount).toBe(0);
  });
});
