// Diagrams laid out in the publisher's browser: kept only when they check out
// against the block, reused while the block is unchanged, gone with the page,
// and only for someone who may publish (docs/architecture/precompiled-diagrams.md).
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import type { PublishPreview } from "@onden/contract";
import { md2html } from "../modules/website/publishing/htmlUtils.js";
import { diagramsBySource, type DiagramLayout } from "@onden/markdown";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

const SOURCE = "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Go]";
const GOOD: DiagramLayout = {
  version: 1, kind: "flowchart", width: 300, height: 300, groups: [],
  nodes: [
    { id: "A", shape: "rect", x: 50, y: 20, w: 80, h: 30, label: "Start" },
    { id: "B", shape: "diamond", x: 50, y: 100, w: 90, h: 60, label: "Ready?" },
    { id: "C", shape: "round", x: 50, y: 200, w: 80, h: 30, label: "Go" },
  ],
  edges: [
    { id: "A_B", from: "A", to: "B", path: "M50,35L50,70", line: "solid", arrow_start: "none", arrow_end: "arrow", label: "", label_x: 0, label_y: 0 },
    { id: "B_C", from: "B", to: "C", path: "M50,130C50,150 50,170 50,185", line: "dashed", arrow_start: "none", arrow_end: "arrow", label: "yes", label_x: 60, label_y: 160 },
  ],
};


let WS = "";
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  getWorkspaceId: async () => WS,
}));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const servedDiagrams = async () => ((await (await app.request("/api/site")).json()) as { payload: { diagrams?: Array<{ source: string }> } }).payload.diagrams ?? [];

describe.skipIf(!isTestDb)("publish: precompiled diagrams", () => {
  let owner: ActorCtx;
  let noteId = "";
  beforeEach(async () => {
    const stamp = randomUUID().replace(/-/g, "").slice(0, 12);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Diagrams', $1) RETURNING id::text`, [`diagrams-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    owner = await persistActor(WS, { id: "owner-diagrams", name: "Owner", role: "admin", type: "human" });
    currentActor = owner;
    noteId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Flow',$2,$3) RETURNING id::text`,
      [WS, randomUUID().slice(0, 8), `Intro\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n`])).rows[0]!.id;
    await setNodeAttribute({ workspaceId: WS, actor: owner, nodeId: noteId,
      attribute: { key: "_published", value: "true", value_type: "bool", is_inheritable: false } });
  });

  it("the preview asks for the layout of a block that has none, and stops asking once it has one", async () => {
    const asked = (await (await post("/api/publish/preview", { title: "S" })).json()) as PublishPreview;
    expect(asked.diagrams_needed).toEqual([SOURCE]);
    const answered = (await (await post("/api/publish/preview", { title: "S", diagrams: [{ source: SOURCE, layout: GOOD }] })).json()) as PublishPreview;
    expect(answered.diagrams_needed).toEqual([]);
    expect(answered.site.payload.diagrams).toEqual([{ source: SOURCE, layout: GOOD }]);
  });

  it("a publish with a checked layout stores it, and the served site carries it", async () => {
    const res = await publishWithPreview(post, { title: "S", diagrams: [{ source: SOURCE, layout: GOOD }] });
    expect(res.status).toBe(201);
    expect((await servedDiagrams()).map((d) => d.source)).toEqual([SOURCE]);
  });

  it("forged layouts are left out and the publish still succeeds", async () => {
    const forged = [
      { source: SOURCE, layout: { ...GOOD, nodes: [{ ...GOOD.nodes[0], label: "<script>alert(1)</script>" }, ...GOOD.nodes.slice(1)] } },
      { source: "flowchart TD\n  X[Never written] --> Y", layout: GOOD }, // a block no published note has
    ];
    const res = await publishWithPreview(post, { title: "S", diagrams: forged });
    expect(res.status).toBe(201);
    expect(await servedDiagrams()).toEqual([]);
    const stored = (await q<{ payload: Record<string, unknown> }>(`SELECT payload FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows[0]!.payload;
    expect(JSON.stringify(stored)).not.toContain("<script>alert");
    expect(stored.diagrams).toBeUndefined();
  });

  it("a malformed envelope is refused as a whole", async () => {
    expect((await publishWithPreview(post, { title: "S", diagrams: "nope" })).status).toBe(400);
    expect((await publishWithPreview(post, { title: "S", diagrams: Array.from({ length: 51 }, () => ({ source: SOURCE, layout: GOOD })) })).status).toBe(400);
    expect((await q(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows).toHaveLength(0);
  });

  it("a later publish reuses the layout while the block text is unchanged, and drops it when the block changes", async () => {
    await publishWithPreview(post, { title: "S", diagrams: [{ source: SOURCE, layout: GOOD }] });
    const again = (await (await post("/api/publish/preview", { title: "S" })).json()) as PublishPreview;
    expect(again.diagrams_needed).toEqual([]);
    expect((await publishWithPreview(post, { title: "S" })).status).toBe(201);
    expect((await servedDiagrams()).map((d) => d.source)).toEqual([SOURCE]);

    await seedQ(`UPDATE content_nodes SET markdown = replace(markdown, 'Go', 'Stop') WHERE id = $1`, [noteId]);
    const changed = (await (await post("/api/publish/preview", { title: "S" })).json()) as PublishPreview;
    expect(changed.diagrams_needed).toEqual([SOURCE.replace("Go", "Stop")]);
    await publishWithPreview(post, { title: "S" });
    expect(await servedDiagrams()).toEqual([]); // the old layout does not outlive the old text
  });

  it("a diagram goes with its page when the page is taken down", async () => {
    await publishWithPreview(post, { title: "S", diagrams: [{ source: SOURCE, layout: GOOD }] });
    await setNodeAttribute({ workspaceId: WS, actor: owner, nodeId: noteId,
      attribute: { key: "_published", value: "false", value_type: "bool", is_inheritable: false } });
    expect(await servedDiagrams()).toEqual([]);
  });

  it("someone who may not publish cannot upload", async () => {
    currentActor = await persistActor(WS, { id: "member-diagrams", name: "Member", role: "member", type: "human" });
    const res = await publishWithPreview(post, { title: "S", diagrams: [{ source: SOURCE, layout: GOOD }] });
    expect(res.status).toBe(403);
    expect((await q(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows).toHaveLength(0);
  });

  it("the export draws a layout the site holds, and keeps any other block as source", () => {
    const md = `\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\n\`\`\`mermaid\nflowchart TD\n  P --> Q\n\`\`\``;
    const drawn = md2html(md, { pages: [], diagrams: diagramsBySource([{ source: SOURCE, layout: GOOD }]) });
    expect(drawn).toContain('<div class="md-mermaid"><svg class="dg"');
    expect(drawn).toMatch(/<pre class="mermaid">flowchart TD\n  P -->/);
    expect(drawn).not.toMatch(/<script|<foreignObject|\son\w+=|javascript:|url\(/i);
  });
});
