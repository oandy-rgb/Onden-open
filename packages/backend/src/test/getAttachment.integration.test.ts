// getAttachment through callTool against the real read scope, media owner rule
// and tool allow-list (audit trail included). The stubbed logic cases are in
// getAttachment.test.ts. SAFETY: only runs against a *_test database.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { q } from "../db.js";
import { callTool, toolsForAccess } from "../services/agentTools/index.js";
import { ATTACHMENT_MAX_BYTES } from "../services/agentTools/getAttachment.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { ScopeError } from "../spine/toolScope.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

// Template expansion checks every listed tool is registered (semantic ones come from the module).
registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const WS = "00000000-0000-0000-0000-00000000a7a7";

describe("token access tool lists", () => {
  it("includes getAttachment next to the other read tools", () => {
    expect(toolsForAccess("read")).toContain("getAttachment");
    expect(toolsForAccess("write")).toContain("getAttachment");
  });
});

describe.skipIf(!isTestDb)("getAttachment via callTool (DB)", () => {
  let agent: ActorCtx = { id: "agent", name: "Bot", role: "editor", type: "agent" };
  let allowedSpace = "", otherSpace = "";
  let note = "", noteOtherSpace = "", noteNoRef = "", noteBorrowing = "";
  const shot = `${randomBytes(16).toString("hex")}.png`;
  const huge = `${randomBytes(16).toString("hex")}.png`;
  const secret = `${randomBytes(16).toString("hex")}.png`;
  const url = (f: string) => `/api/media/${f}`;
  // The agent is a member of allowedSpace only, so that is all its token reaches.
  const scoped = (allowedTools: string[] | null = null): ActorCtx => ({
    ...agent, tokenScope: { tokenId: "tk", allowedTools, access: "read", writeMode: "apply", expiresAt: null },
  });
  const ctx = (actor: ActorCtx) => ({ actor, workspaceId: WS, dryRun: false });
  const get = (actor: ActorCtx, nodeId: string, ref: string) => callTool("getAttachment", { nodeId, ref }, ctx(actor));

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'GA','ga-tools-ws') ON CONFLICT (id) DO NOTHING`, [WS]);
    await turnModuleOn(WS, "ai"); // the agent tools belong to the AI module
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
    agent = await persistActor(WS, agent);
    allowedSpace = await makeSpace(WS, `ga-allowed-${Date.now()}`, [{ id: agent.id, permission: "edit" }]);
    otherSpace = await makeSpace(WS, `ga-other-${Date.now()}`, []);
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(join(MEDIA_DIR, shot), await sharp({ create: { width: 64, height: 48, channels: 3, background: "#08f" } }).png().toBuffer());
    writeFileSync(join(MEDIA_DIR, secret), await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer());
    writeFileSync(join(MEDIA_DIR, huge), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 7)); // not decodable → too_large
    const mk = async (slug: string, body: string, space: string) => {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
         VALUES ($1,'content','manual',$2,$3,$4) RETURNING id`, [WS, slug, `${slug}-${Date.now()}`, body],
      )).rows[0]!.id;
      await putInSpace(id, space);
      return id;
    };
    // The file's oldest referencing note decides who reads it (canReadMedia),
    // so create the owners first, then the note that only borrows the URL.
    noteOtherSpace = await mk("ga-other", `private ![](${url(shot.replace(/^.{4}/, "0000"))}) ![](${url(secret)})`, otherSpace);
    note = await mk("ga-note", `bug report ![screenshot](${url(shot)}) and ![big](${url(huge)})`, allowedSpace);
    noteNoRef = await mk("ga-noref", "no files here", allowedSpace);
    noteBorrowing = await mk("ga-borrow", `copied ![](${url(secret)})`, allowedSpace);
  });

  it("a readable note's image comes back as base64 with metadata; getNode lists it", async () => {
    const r = await get(scoped(), note, url(shot)) as { mime: string; kind: string; data_base64: string };
    expect(r).toMatchObject({ mime: "image/png", kind: "image" });
    expect((await sharp(Buffer.from(r.data_base64, "base64")).metadata()).width).toBe(64);

    const node = await callTool("getNode", { id: note }, ctx(scoped())) as { attachments: Array<{ ref: string; kind: string; size: number | null }> };
    expect(node.attachments.map((a) => a.ref)).toEqual(expect.arrayContaining([url(shot), url(huge)]));
    expect(node.attachments.find((a) => a.ref === url(shot))).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("refuses a file the note's body does not reference", async () => {
    expect(await get(scoped(), noteNoRef, url(shot))).toMatchObject({ error: "not_referenced" });
    // referenced by another note, not this one
    expect(await get(scoped(), note, secret)).toMatchObject({ error: "not_referenced" });
  });

  it("note in a space the token cannot read: null, like getNode", async () => {
    const tok = scoped();
    expect(await get(tok, noteOtherSpace, url(secret))).toBeNull();
    expect(await callTool("getNode", { id: noteOtherSpace }, ctx(tok))).toBeNull();
  });

  it("pasting an unreadable note's file URL into a readable note grants nothing", async () => {
    expect(await get(scoped(), noteBorrowing, url(secret))).toMatchObject({ error: "not_referenced" });
  });

  it("over the size cap and not shrinkable: too_large with metadata", async () => {
    const r = await get(scoped(), note, url(huge)) as Record<string, unknown>;
    expect(r).toMatchObject({ error: "too_large", max_bytes: ATTACHMENT_MAX_BYTES });
    expect(r.data_base64).toBeUndefined();
  });

  it("a token whose allow-list lacks getAttachment is refused, and the attempt is audited", async () => {
    const tok = scoped(["getNode"]);
    await expect(get(tok, note, url(shot))).rejects.toBeInstanceOf(ScopeError);
    const ok = await callTool("getNode", { id: note }, ctx(tok));
    expect(ok).not.toBeNull();
    const failed = await q(`SELECT 1 FROM domain_events WHERE workspace_id=$1 AND event_type='AGENT_TOOL_FAILED' AND target_id='getAttachment'`, [WS]);
    expect(failed.rows.length).toBeGreaterThan(0);
  });

  it("a successful read is audited like the other read tools", async () => {
    await get(scoped(), note, url(shot));
    const called = await q(`SELECT 1 FROM domain_events WHERE workspace_id=$1 AND event_type='AGENT_TOOL_CALLED' AND target_id='getAttachment'`, [WS]);
    expect(called.rows.length).toBeGreaterThan(0);
  });
});
