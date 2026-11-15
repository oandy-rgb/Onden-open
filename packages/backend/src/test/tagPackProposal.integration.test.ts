// ⑥ #review AI-pack groundwork: proposeTagPack — an agent drafts a tag pack
// (fields + ECA behaviour), it lands as a HELD approval (outbox tag_pack,
// pending_approval), and only a principal admin's approve installs it. The
// reject path discards without side effects. Registry boundary: tokens
// without the tool are refused at the gate.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

async function mintToken(access: "read" | "write"): Promise<string> {
  const actor = await (await req("/api/actors", { method: "POST", json: { name: `pack bot ${access} ${Date.now()}`, type: "agent" } })).json() as { id: string };
  const tok = await (await req(`/api/actors/${actor.id}/tokens`, { method: "POST", json: { access } })).json() as { token: string };
  return tok.token;
}

const PACK_ARGS = (name: string) => ({
  name,
  description: "spaced-repetition cards",
  fields: [
    { name: "due", type: "date" },
    { name: "interval", type: "number", default: "1" },
  ],
  behaviour: { review: { algorithm: "fsrs", new_per_day: 20 } },
  publish_collection: false,
});

describe.skipIf(!isTestDb)("proposeTagPack (⑥ approve-before-apply)", () => {
  let writeToken = "";
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    await getWorkspaceId();
    await turnModuleOn(await getWorkspaceId(), "ai"); // the agent tools belong to the AI module
    writeToken = await mintToken("write");
  });

  // Every test proposes a pack under its own name, so none needs another
  // test's proposal or install.
  let seq = 0;
  const packName = (prefix: string) => `${prefix}${stamp}-${++seq}`;
  const propose = async (name: string) => {
    const res = await req("/api/mcp/tools/proposeTagPack", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}` },
      json: { args: PACK_ARGS(name) },
    });
    expect(res.status).toBeLessThan(300);
    return res;
  };
  const approve = async (name: string) => {
    const approvals = (await (await req("/api/inbox/approvals")).json()) as { approvals: Array<{ id: string; effect_kind: string; payload: { pack?: { name?: string } } }> };
    const held = approvals.approvals.find((a) => a.effect_kind === "tag_pack" && a.payload.pack?.name === name)!;
    expect((await req(`/api/inbox/approvals/${held.id}/approve`, { method: "POST", json: {} })).status).toBeLessThan(300);
  };
  /** Wait for the approved pack's tag (the approve route drains async). */
  const installed = async (name: string) => {
    let schema: { fields: Array<{ name: string }>; behaviour: Record<string, unknown> } | null = null;
    for (let i = 0; i < 40 && !schema; i++) {
      const r = await q<{ fields: Array<{ name: string }>; behaviour: Record<string, unknown> }>(
        `SELECT t.tag_schema->'fields' AS fields, t.tag_schema->'behaviour' AS behaviour
           FROM content_nodes t
          WHERE t.title = $1 AND t.node_type = 'class_tag' AND t.deleted_at IS NULL`, [name]);
      schema = r.rows[0] ?? null;
      if (!schema) await new Promise((res) => setTimeout(res, 100));
    }
    return schema;
  };

  it("the proposal files a held effect — nothing installs before approval", async () => {
    const name = packName("revpack");
    const res = await propose(name);
    expect(((await res.json()) as { result: { status: string } }).result.status).toBe("pending_approval");

    // no tag yet
    const tag = await q(`SELECT 1 FROM content_nodes WHERE title = $1 AND node_type = 'class_tag' AND deleted_at IS NULL`, [name]);
    expect(tag.rowCount).toBe(0);
    // held effect visible in the approvals queue
    const approvals = (await (await req("/api/inbox/approvals")).json()) as { approvals: Array<{ id: string; effect_kind: string; payload: { pack?: { name?: string; publish_collection?: boolean } } }> };
    expect(approvals.approvals.some((a) => a.effect_kind === "tag_pack" && a.payload.pack?.name === name)).toBe(true);
    expect(approvals.approvals.find(a => a.payload.pack?.name === name)?.payload.pack?.publish_collection).toBe(false);
  });

  it("approve installs the pack: schema fields + ECA behaviour land, attributed to the agent", async () => {
    const name = packName("revpack");
    await propose(name);
    await approve(name);

    // the drain is fired async by the approve route — poll for the install
    const schema = await installed(name);
    expect(schema, "pack installed after approve").toBeTruthy();
    expect(schema!.fields.map((f) => f.name)).toEqual(["due", "interval"]);
    expect((schema!.behaviour as { review?: { algorithm?: string } }).review?.algorithm).toBe("fsrs");
    const publication = await q<{ publish_collection: boolean }>(
      "SELECT tag_schema->'publish_collection' AS publish_collection FROM content_nodes WHERE title=$1 AND node_type='class_tag' AND deleted_at IS NULL", [name]);
    expect(publication.rows[0]?.publish_collection).toBe(false);

    // provenance: TAG_IMPORTED attributed to the proposing agent, via approval
    const ev = await q<{ actor_type: string; payload: { via_approval?: boolean } }>(
      `SELECT actor_type, payload FROM domain_events WHERE event_type = 'TAG_IMPORTED' AND payload->>'name' = $1 ORDER BY id DESC LIMIT 1`,
      [name]);
    expect(ev.rows[0]!.actor_type).toBe("ai_agent");
    expect(ev.rows[0]!.payload.via_approval).toBe(true);
  });

  it("reject discards the proposal — no tag, effect dead", async () => {
    const name = packName("rejpack");
    await req("/api/mcp/tools/proposeTagPack", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}` },
      json: { args: PACK_ARGS(name) },
    });
    const approvals = (await (await req("/api/inbox/approvals")).json()) as { approvals: Array<{ id: string; effect_kind: string; payload: { pack?: { name?: string } } }> };
    const held = approvals.approvals.find((a) => a.effect_kind === "tag_pack" && a.payload.pack?.name === name)!;
    expect((await req(`/api/inbox/approvals/${held.id}/reject`, { method: "POST", json: {} })).status).toBeLessThan(300);

    const tag = await q(`SELECT 1 FROM content_nodes WHERE title = $1 AND node_type = 'class_tag' AND deleted_at IS NULL`, [name]);
    expect(tag.rowCount).toBe(0);
    const row = await q<{ status: string }>(`SELECT status FROM outbox WHERE id = $1::bigint`, [held.id]);
    expect(row.rows[0]!.status).toBe("dead");
  });

  it("duplicate names and unauthorized tokens are refused at the tool boundary", async () => {
    const name = packName("revpack");
    await propose(name);
    await approve(name);
    expect(await installed(name), "pack installed after approve").toBeTruthy();
    // the name is installed now: proposing it again is refused
    const dup = await req("/api/mcp/tools/proposeTagPack", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}` },
      json: { args: PACK_ARGS(name) },
    });
    expect(dup.status).toBeGreaterThanOrEqual(400);

    // a read token does not carry the tool — the registry refuses
    const roToken = await mintToken("read");
    const denied = await req("/api/mcp/tools/proposeTagPack", {
      method: "POST",
      headers: { authorization: `Bearer ${roToken}` },
      json: { args: PACK_ARGS(`nope${stamp}`) },
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });
});
