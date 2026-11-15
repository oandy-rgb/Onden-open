// M1 — dispatcher cascade catch-up (crash recovery), against real Postgres.
//
// The contract under test (see services/dispatcherQueue.ts header):
//   1. trigger committed + cascade LOST (process died before the post-commit
//      queue ran) → a dispatcher_pending intent survives, and
//      runDispatcherCatchup() replays the cascade EXACTLY ONCE with the
//      original actor attribution + triggered_by chain;
//   2. cascade COMPLETED but the settle-DELETE was lost (crash in the gap) →
//      replay is a NO-OP: the syncs' attribute diff is the idempotency
//      arbiter, so no duplicate cascade events are emitted;
//   3. the normal (no-crash) path consumes the intent row by itself;
//   4. meaningless/unsafe replays are discarded with a DISPATCHER_FAILED
//      audit: trashed node, and a bearer token that has since been revoked
//      (replaying unscoped would WIDEN the agent's authority — never).
//
// Fixture: a note whose body says `status:: done`. The post-commit derivation
// records it as ATTRIBUTE_SET only when the value actually changes, which
// makes "replayed exactly once" sharply observable in domain_events.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, event, getWorkspaceId } from "../db.js";
import {
  enqueueCascadeIntent, queueDispatcher, runDispatcherCatchup,
  pendingCascadeIntents, awaitAllDispatchers,
} from "../services/dispatcherQueue.js";
import { syncAttributesAndDispatch, syncFrontmatterAttributes, syncAuthorizedNodeAttributes } from "../services/nodes.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { createToken, revokeToken } from "../services/agentTokens.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { withToolAuthority } from "../spine/toolScope.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const stamp = Date.now();

describe.skipIf(!isTestDb)("dispatcher cascade catch-up (M1)", () => {
  let WS = "";
  let admin: ActorCtx;
  let tagId = "";

  /** An editor: joins the default space (where mkNode's notes land) as editor. */
  async function mkActor(label: string): Promise<ActorCtx> {
    const result = await q<{ id: string; name: string; type: "human" }>(
      `INSERT INTO actors (workspace_id, name, type)
       VALUES ($1, $2, 'human') RETURNING id, name, type`,
      [WS, `dc ${label} ${stamp}`],
    );
    await joinDefaultSpace(WS, result.rows[0]!.id, "editor");
    return result.rows[0]! as ActorCtx;
  }
  const setDefaultSpacePermission = (actorId: string, permission: "view" | "edit" | null) => permission === null
    ? q(`DELETE FROM space_members WHERE actor_id = $1 AND space_id = (SELECT id FROM spaces WHERE workspace_id = $2 AND is_default)`, [actorId, WS])
    : q(`UPDATE space_members SET permission = $3 WHERE actor_id = $1 AND space_id = (SELECT id FROM spaces WHERE workspace_id = $2 AND is_default)`, [actorId, WS, permission]);

  /** Node fixture carrying the behaviour tag, body NOT yet cascaded. */
  async function mkNode(label: string, markdown: string): Promise<string> {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
       VALUES ($1, 'manual', 'content', $2, $3, $4, false) RETURNING id`,
      [WS, `dc ${label} ${stamp}`, `dc-${label}-${stamp}`, markdown],
    );
    const id = r.rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    return id;
  }

  /** The committed trigger + durable intent, with NO cascade run after it —
   *  exactly the on-disk state a crash leaves behind. */
  async function mkOrphanedTrigger(
    nodeId: string, actor: ActorCtx, label = "node.patch.cascade",
    toolMeta: Record<string, unknown> = actor.tokenScope
      ? { tool_name: "updateNode", token_id: actor.tokenScope.tokenId } : {},
  ): Promise<string> {
    const eventId = await event(
      WS, "NODE_UPDATED", "node", nodeId, { title: "dc trigger" },
      "user", actor.id, { txMeta: { ui_context: "test.simulated_crash", ...toolMeta } },
    );
    await enqueueCascadeIntent({ workspaceId: WS, nodeId, actor, label, eventId });
    return eventId;
  }

  async function eventCount(nodeId: string, type: string): Promise<number> {
    const r = await q<{ n: string }>(
      `SELECT count(*) AS n FROM domain_events WHERE target_id = $1 AND event_type = $2`,
      [nodeId, type],
    );
    return Number(r.rows[0]!.n);
  }

  /** Whether the derivation ran on the note: it recorded status=done. */
  async function ruleFired(nodeId: string): Promise<boolean> {
    const r = await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = 'status' AND value = 'done'`, [nodeId]);
    return r.rows.length > 0;
  }

  /** The derivation's events on the note: ATTRIBUTE_SET of status. */
  async function ruleEvents(nodeId: string): Promise<number> {
    const r = await q<{ n: string }>(
      `SELECT count(*) AS n FROM domain_events
        WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'status'`,
      [nodeId],
    );
    return Number(r.rows[0]!.n);
  }

  async function intentRows(nodeId: string): Promise<number> {
    const r = await q<{ n: string }>(
      `SELECT count(*) AS n FROM dispatcher_pending WHERE node_id = $1`, [nodeId],
    );
    return Number(r.rows[0]!.n);
  }

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // Earlier suites' cascades have all settled (files run serially). Intents
    // other tests left behind stay: catch-up replays every orphan, as it does
    // in production, and every assertion here is about this file's own nodes.
    await awaitAllDispatchers();

    const a = await q<{ id: string; name: string; type: "human" | "agent" }>(
      `INSERT INTO actors (workspace_id, name, type)
       VALUES ($1, $2, 'human') RETURNING id, name, type`,
      [WS, `dc admin ${stamp}`],
    );
    admin = a.rows[0]!;
    await joinDefaultSpace(WS, admin.id, "admin");

    tagId = (await seedClassTag(WS, {
      name: `dc-behaviour-${stamp}`,
      slug: `dc-behaviour-${stamp}`,
      title: `dc-tag-${stamp}`,
      nodeSlug: `dc-tag-${stamp}`,
    })).tagId;
  });

  it("crash recovery: committed trigger + lost cascade → catch-up completes it exactly once, attributed to the original actor", async () => {
    const nodeId = await mkNode("lost", "work to do\n\nstatus:: done");
    const triggerEventId = await mkOrphanedTrigger(nodeId, admin);

    // The crash left: trigger event + intent row, NO cascade effects.
    expect(await ruleFired(nodeId)).toBe(false);
    expect(await intentRows(nodeId)).toBe(1);

    const res = await runDispatcherCatchup();
    expect(res.replayed).toBeGreaterThanOrEqual(1);

    // Cascade completed: the `status:: done` inline-markdown field was parsed
    // out of the body and recorded once, intent consumed. Provenance source
    // is 'markdown' (step-1) — the value came from the markdown body, not from a
    // computed/rollup 'derived' write. (This expectation predated the provenance
    // contract; an inline md field is sourced 'markdown', never 'derived'.)
    const attr = await q<{ value: string; source: string }>(
      `SELECT value, source FROM node_attributes WHERE node_id = $1 AND key = 'status'`, [nodeId],
    );
    expect(attr.rows[0]).toMatchObject({ value: "done", source: "markdown" });
    expect(await ruleFired(nodeId)).toBe(true);
    expect(await ruleEvents(nodeId)).toBe(1);
    expect(await intentRows(nodeId)).toBe(0);

    // Attribution + provenance: the replayed cascade speaks AS the original
    // root actor (spine cascade rule) and chains to the original trigger —
    // through the ATTRIBUTE_SET that recorded the parsed value (W28).
    const set = await q<{ id: string; actor_id: string; triggered_by_event_id: string }>(
      `SELECT id::text, actor_id, triggered_by_event_id::text
         FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'status'`,
      [nodeId],
    );
    expect(set.rows[0]).toMatchObject({ actor_id: admin.id, triggered_by_event_id: triggerEventId });
  });

  it("already-completed cascade (crash between settle and DELETE) → replay is a no-op", async () => {
    const nodeId = await mkNode("done", "finished\n\nstatus:: done");
    const triggerEventId = await event(
      WS, "NODE_UPDATED", "node", nodeId, { title: "dc trigger" },
      "user", admin.id, { txMeta: { ui_context: "test.simulated_crash" } },
    );
    // Run the cascade to COMPLETION the normal way…
    await queueDispatcher(
      { workspaceId: WS, nodeId, actorId: admin.id, label: "node.patch.cascade", triggerEventId },
      async () => {
        await syncAttributesAndDispatch(WS, nodeId, "finished\n\nstatus:: done", admin, triggerEventId);
        await syncFrontmatterAttributes(WS, nodeId, "finished\n\nstatus:: done", admin, triggerEventId);
      },
    );
    expect(await ruleFired(nodeId)).toBe(true);
    expect(await ruleEvents(nodeId)).toBe(1);
    expect(await intentRows(nodeId), "normal path consumed its own intent").toBe(0);

    // …then re-create the intent row, as if the process died AFTER the
    // cascade finished but BEFORE the settle-DELETE committed.
    await enqueueCascadeIntent({ workspaceId: WS, nodeId, actor: admin, label: "node.patch.cascade", eventId: triggerEventId });

    const eventsBefore = await q<{ n: string }>(
      `SELECT count(*) AS n FROM domain_events WHERE target_id = $1`, [nodeId],
    );
    await runDispatcherCatchup();

    // No new events of ANY type: the attribute diff saw every key unchanged,
    // so no dispatch fired — the no-op the design relies on.
    const eventsAfter = await q<{ n: string }>(
      `SELECT count(*) AS n FROM domain_events WHERE target_id = $1`, [nodeId],
    );
    expect(eventsAfter.rows[0]!.n).toBe(eventsBefore.rows[0]!.n);
    expect(await ruleFired(nodeId)).toBe(true);
    expect(await intentRows(nodeId), "intent consumed by the replay's settle").toBe(0);
  });

  it("trashed node → intent discarded with a DISPATCHER_FAILED audit, nothing replayed", async () => {
    const nodeId = await mkNode("trash", "gone\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, admin);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [nodeId]);

    await runDispatcherCatchup();

    expect(await intentRows(nodeId)).toBe(0);
    expect(await ruleEvents(nodeId)).toBe(0);
    const fail = await q<{ payload: { error?: string } }>(
      `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'DISPATCHER_FAILED'`, [nodeId],
    );
    expect(fail.rows[0]?.payload.error).toMatch(/missing or trashed/);
  });

  it("revoked bearer token → intent discarded (a crash must not widen an agent's authority)", async () => {
    const a = await q<{ id: string; name: string; type: "human" | "agent" }>(
      `INSERT INTO actors (workspace_id, name, type)
       VALUES ($1, $2, 'agent') RETURNING id, name, type`,
      [WS, `dc agent ${stamp}`],
    );
    const agentActor = a.rows[0]!;
    await joinDefaultSpace(WS, agentActor.id, "editor");
    const tok = await createToken(agentActor.id, { name: "dc", access: "write" });
    const scoped: ActorCtx = {
      ...agentActor,
      tokenScope: { tokenId: tok.id, allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    };

    const nodeId = await mkNode("revoked", "agent work\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, scoped, "mcp.updateNode.cascade");
    // token_id persisted with the intent — the scope survives the crash.
    const row = await q<{ token_id: string | null }>(
      `SELECT token_id FROM dispatcher_pending WHERE node_id = $1`, [nodeId],
    );
    expect(row.rows[0]!.token_id).toBe(tok.id);

    await revokeToken(agentActor.id, tok.id);
    await runDispatcherCatchup();

    expect(await intentRows(nodeId)).toBe(0);
    expect(await ruleEvents(nodeId), "no cascade ran without its scope").toBe(0);
    const fail = await q<{ payload: { error?: string } }>(
      `SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'DISPATCHER_FAILED'`, [nodeId],
    );
    expect(fail.rows[0]?.payload.error).toMatch(/token revoked/);
  });

  it.each(["removed", "view"] as const)("catch-up rechecks a narrowed human space permission (%s) before any derived write", async (scope) => {
    const actor = await mkActor(`narrowed-${scope}`);
    const nodeId = await mkNode(`narrowed-${scope}`, "pending human work\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, actor);

    // The trigger was allowed, but the current actor may no longer write this
    // note: removed from its space, or demoted to view-only there.
    await setDefaultSpacePermission(actor.id, scope === "removed" ? null : "view");
    await runDispatcherCatchup();

    const attributes = await q(`SELECT key FROM node_attributes WHERE node_id = $1`, [nodeId]);
    expect(attributes.rows, "refused catch-up must not save parsed attributes before its permission check").toEqual([]);
    expect(await ruleFired(nodeId)).toBe(false);
    expect(await ruleEvents(nodeId)).toBe(0);
    expect(await eventCount(nodeId, "ATTRIBUTE_SET")).toBe(0);
    expect(await eventCount(nodeId, "DISPATCHER_FAILED")).toBe(1);
    expect(await intentRows(nodeId)).toBe(0);
  });

  it.each(["edit"] as const)("catch-up preserves the allowed human %s space permission", async (scope) => {
    const actor = await mkActor(`allowed-${scope}`);
    await setDefaultSpacePermission(actor.id, scope);
    const nodeId = await mkNode(`allowed-${scope}`, "allowed human work\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, actor);
    await runDispatcherCatchup();

    expect(await ruleFired(nodeId)).toBe(true);
    expect(await ruleEvents(nodeId)).toBe(1);
    expect(await eventCount(nodeId, "DISPATCHER_FAILED")).toBe(0);
    expect(await intentRows(nodeId)).toBe(0);
  });

  it("catch-up refuses a token owned by a different actor before any derived write", async () => {
    const actor = await mkActor("token-original");
    const other = await mkActor("token-other");
    const token = await createToken(actor.id, { name: "dc-owner", access: "write" });
    const scoped: ActorCtx = {
      ...actor,
      tokenScope: { tokenId: token.id, allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    };
    const nodeId = await mkNode("token-other-owner", "pending token work\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, scoped, "mcp.updateNode.cascade");
    // Simulate an inconsistent retained intent/token association. The token
    // still exists and is live, but cannot authorize work attributed to actor.
    await q(`UPDATE agent_tokens SET actor_id = $2 WHERE id = $1`, [token.id, other.id]);
    await runDispatcherCatchup();

    expect((await q(`SELECT key FROM node_attributes WHERE node_id = $1`, [nodeId])).rows).toEqual([]);
    expect(await ruleFired(nodeId)).toBe(false);
    expect(await ruleEvents(nodeId)).toBe(0);
    expect(await eventCount(nodeId, "ATTRIBUTE_SET")).toBe(0);
    expect(await eventCount(nodeId, "DISPATCHER_FAILED")).toBe(1);
    expect(await intentRows(nodeId)).toBe(0);
  });

  it.each(["live", "catch-up"] as const)("%s derivation refuses a tool grant narrowed after its trigger committed", async mode => {
    const actor = await mkActor(`tool-narrowed-${mode}`);
    const token = await createToken(actor.id, { allowedTools: ["updateNode"], access: "write" });
    const scoped: ActorCtx = { ...actor, tokenScope: {
      tokenId: token.id, allowedTools: ["updateNode"], access: "write", writeMode: "apply", expiresAt: null,
    } };
    const markdown = "pending token work\n\nstatus:: done";
    const nodeId = await mkNode(`tool-narrowed-${mode}`, markdown);
    const triggerEventId = await mkOrphanedTrigger(nodeId, scoped, "mcp.updateNode.cascade");
    await q("UPDATE agent_tokens SET allowed_tools='{}'::text[] WHERE id=$1", [token.id]);

    if (mode === "live") {
      await withToolAuthority("updateNode", () => queueDispatcher(
        { workspaceId: WS, nodeId, actorId: actor.id, label: "mcp.updateNode.cascade", triggerEventId },
        () => syncAuthorizedNodeAttributes(WS, nodeId, markdown, scoped, triggerEventId),
      ));
    } else await runDispatcherCatchup();

    expect((await q("SELECT key FROM node_attributes WHERE node_id=$1", [nodeId])).rows).toEqual([]);
    expect(await ruleFired(nodeId)).toBe(false);
    expect(await ruleEvents(nodeId)).toBe(0);
    expect(await eventCount(nodeId, "DISPATCHER_FAILED")).toBe(1);
    expect(await intentRows(nodeId)).toBe(0);
  });

  it.each(["explicit", "unlimited"] as const)("catch-up retains an allowed %s token tool grant", async grant => {
    const actor = await mkActor(`tool-allowed-${grant}`);
    const allowedTools = grant === "explicit" ? ["updateNode"] : null;
    const token = await createToken(actor.id, { allowedTools, access: "write" });
    const scoped: ActorCtx = { ...actor, tokenScope: {
      tokenId: token.id, allowedTools, access: "write", writeMode: "apply", expiresAt: null,
    } };
    const nodeId = await mkNode(`tool-allowed-${grant}`, "allowed token work\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, scoped, "mcp.updateNode.cascade");
    await runDispatcherCatchup();
    expect(await ruleFired(nodeId)).toBe(true);
    expect(await ruleEvents(nodeId)).toBe(1);
    expect(await eventCount(nodeId, "DISPATCHER_FAILED")).toBe(0);
    expect(await intentRows(nodeId)).toBe(0);
  });

  it.each(["missing-tool", "wrong-token"] as const)("catch-up refuses unverifiable token invocation metadata: %s", async invalid => {
    const actor = await mkActor(`tool-unverifiable-${invalid}`);
    const token = await createToken(actor.id, { allowedTools: null, access: "write" });
    const scoped: ActorCtx = { ...actor, tokenScope: {
      tokenId: token.id, allowedTools: null, access: "write", writeMode: "apply", expiresAt: null,
    } };
    const nodeId = await mkNode(`tool-unverifiable-${invalid}`, "pending token work\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, scoped, "mcp.updateNode.cascade", invalid === "missing-tool"
      ? { token_id: token.id } : { tool_name: "updateNode", token_id: "different-token" });
    await runDispatcherCatchup();
    expect((await q("SELECT key FROM node_attributes WHERE node_id=$1", [nodeId])).rows).toEqual([]);
    expect(await ruleFired(nodeId)).toBe(false);
    expect(await ruleEvents(nodeId)).toBe(0);
    expect(await eventCount(nodeId, "DISPATCHER_FAILED")).toBe(1);
    expect(await intentRows(nodeId)).toBe(0);
  });

  it("needs-replay derivation: grace window + in-flight chains are excluded", async () => {
    const nodeId = await mkNode("grace", "later\n\nstatus:: done");
    await mkOrphanedTrigger(nodeId, admin);

    // Fresh row + grace window → not yet considered a crash victim.
    const graced = await pendingCascadeIntents({ graceMs: 60_000 });
    expect(graced.some((i) => i.node_id === nodeId)).toBe(false);

    // No grace → eligible…
    const due = await pendingCascadeIntents();
    expect(due.some((i) => i.node_id === nodeId)).toBe(true);

    // …unless the node has a LIVE chain (its own settle will consume the row).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inflight = queueDispatcher(
      { workspaceId: WS, nodeId, actorId: admin.id, label: "test.inflight" },
      () => gate,
    );
    const whileInflight = await pendingCascadeIntents();
    expect(whileInflight.some((i) => i.node_id === nodeId)).toBe(false);
    release();
    await inflight;

    await runDispatcherCatchup(); // leave no orphans for later suites
    expect(await intentRows(nodeId)).toBe(0);
  });
});
