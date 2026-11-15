// A workspace seeded the way the frontend captures in fixtures/client-writes
// saw theirs, for tests that run an OLD client's requests or decoders against
// THIS backend (clientWritesReplay, clientReadsDecode).
//
// The capture uses placeholder ids (00000000-0000-4000-8000-…); a Run maps each
// to a fresh random uuid, consistently, so scenarios never collide in the shared
// test database. The seed goes through the current API wherever one exists, so
// a seed that stops working says which route changed.
//
// The importing test must route the app's workspace and session here:
//   vi.mock("../db.js", async (o) => ({ ...await o<typeof import("../db.js")>(),
//     getWorkspaceId: async () => (await import("./helpers/clientSkewWorkspace.js")).skew.workspaceId }));
//   vi.mock("../auth.js", () => ({ auth: { handler: vi.fn(async () => new Response("noop")),
//     api: { getSession: vi.fn(async () => { const { skew } = await import("./helpers/clientSkewWorkspace.js");
//       return skew.user ? { user: skew.user } : null; }) },
//     $context: Promise.resolve({ runMigrations: async () => {} }) } }));

import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { app } from "../../app.js";
import { seedClassTag } from "./seedClassTag.js";
import { seedQ } from "./seedQ.js";
import { seedViewElements } from "./seedView.js";

export const skew: { workspaceId: string; user: { id: string; email: string; name: string } | null } = { workspaceId: "", user: null };

export const PLACEHOLDER = /00000000-0000-4000-8000-[0-9a-f]{12}/g;

export type SeedOptions = {
  /** The space member's level before the write (default: edit). */
  personPermission?: "view" | "edit";
  /** Server-side body changes made after the client's last read. */
  serverFirst?: Array<{ node: string; markdown: string }>;
};

export class Run {
  readonly map = new Map<string, string>();
  workspace = "";
  owner = "";
  constructor(readonly captured: Record<string, string | number>) {}

  id(placeholder: string): string {
    if (!this.map.has(placeholder)) this.map.set(placeholder, randomUUID());
    return this.map.get(placeholder)!;
  }
  /** Placeholders → this run's ids, in any string or JSON value. */
  mapped<T>(value: T): T {
    return JSON.parse(JSON.stringify(value ?? null).replace(PLACEHOLDER, (m) => this.id(m))) as T;
  }
  /** The named ids of the capture (ID in captureWrites.harness.ts), as this run's. */
  ids(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.captured).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, this.id(v as string)]));
  }

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await app.request(path, {
      method,
      headers: {
        ...(body !== undefined && body !== null ? { "content-type": "application/json" } : {}),
        "x-onden-expected-user": skew.user!.id,
        "x-onden-client-protocol": "3", // a current page (clientGate.ts)
        ...headers,
      },
      ...(body !== undefined && body !== null ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  }

  /** Seeding goes through the current API (a seed that fails says so by name). */
  async seed(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.call(method, path, body, { "idempotency-key": randomUUID() });
    if (res.status >= 300) throw new Error(`seed ${method} ${path} → ${res.status} ${JSON.stringify(res.json)}`);
    return res.json;
  }
}

export async function seedWorkspace(captured: Record<string, string | number>, options: SeedOptions = {}): Promise<Run> {
  const run = new Run(captured);
  const id = run.ids() as Record<string, string>;
  skew.workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('client replay', $1) RETURNING id::text`, [`replay-${randomUUID()}`])).rows[0]!.id;
  run.workspace = skew.workspaceId;
  const WS = skew.workspaceId;
  skew.user = { id: `user-${randomUUID()}`, email: `owner-${randomUUID()}@example.test`, name: "Owner" };
  // The first human of an empty workspace is its owner (services/actors.ts).
  await run.call("GET", "/api/me");  // the first request creates the actor
  run.owner = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND type = 'human'`, [WS])).rows[0]!.id;

  // The notes the capture's store held.
  const note = (n: string, title: string, extra: Record<string, unknown> = {}) => run.seed("POST", "/api/nodes", { id: id[n], title, markdown: "", ...extra });
  await note("parent", "Parent");
  await note("alpha", "Alpha", { markdown: "line one\nline two\nline three\n" });
  await note("beta", "Beta");
  await note("child", "Child", { parent_id: id.parent });
  await note("gone", "Hidden");
  // Only tags are hidden through the API now; a hidden note is an old row.
  await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [id.gone]);
  await note("trashed", "Trashed");
  await run.seed("DELETE", `/api/nodes/${id.trashed}`);

  // `tag` is a collection (a class tag with a schema), `tag2` a plain label tag.
  const { tagId } = await seedClassTag(WS, { name: "reading", slug: "reading", fields: [{ name: "author", type: "text" }] });
  await seedQ(`UPDATE content_nodes SET id = $2 WHERE id = $1`, [tagId, id.tag]);
  await run.seed("POST", "/api/tags", { id: id.tag2, name: "later" });
  // A module's tag: the only kind another tag may extend.
  await run.seed("POST", "/api/tags", { id: id.moduleTag, name: "review" });
  await seedQ(`UPDATE content_nodes SET tag_schema = '{"module": "review", "name": "review", "slug": "review"}'::jsonb WHERE id = $1`, [id.moduleTag]);
  await run.seed("PUT", `/api/nodes/${id.child}/tags/${id.tag}`, {});
  await run.seed("PUT", `/api/nodes/${id.beta}/tags/${id.tag2}`, {});
  await seedViewElements(id.tag, [{
    id: id.view, tag_id: id.tag, name: "List", layout: "list", filters: [], sorts: [], group_by: null,
    visible_fields: [], layout_config: {}, pin_order: 0, created_at: "2026-10-23T00:00:00.000Z", updated_at: "2026-10-23T00:00:00.000Z",
  }]);

  for (const n of ["alpha", "beta"]) await run.seed("PUT", `/api/nodes/${id[n]}/attributes/status`, { value: "draft", value_type: "text" });
  await run.seed("POST", `/api/nodes/${id.alpha}/tasks`, { id: id.task, title: "Task" });
  await run.seed("POST", "/api/edges", { id: id.edge, source_node_id: id.alpha, target_node_id: id.beta, edge_type: "related", status: "active" });
  await run.seed("POST", "/api/canvases", { id: id.board, title: "Board" });

  // A shared space with a second member.
  await q(`INSERT INTO spaces (id, workspace_id, name, kind, capabilities) VALUES ($1, $2, 'Study group', 'shared', '{"publish": false, "external_ai": true, "backup": true}'::jsonb)`, [id.space, WS]);
  await q(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Friend', 'human')`, [id.person, WS]);
  await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit'), ($1, $3, $4)`, [id.space, run.owner, id.person, options.personPermission ?? "edit"]);

  // An AI helper in the space, with a key.
  await q(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Helper bot', 'agent')`, [id.agent, WS]);
  await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [id.space, id.agent]);
  const key = await run.seed("POST", `/api/actors/${id.agent}/tokens`, { name: "seed key", access: "write" });
  run.map.set(String(captured.token), key.id);  // the key's id is the server's; requests that name it follow

  // The server changed after the client's last read.
  for (const change of run.mapped(options.serverFirst ?? [])) {
    await run.seed("PATCH", `/api/nodes/${change.node}`, { markdown: change.markdown });
  }
  return run;
}

