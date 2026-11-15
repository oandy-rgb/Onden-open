// An AI role runs one of two ways: api or mcp. Migration 156 folds the old "subscription" runner into mcp:
// the role's key, its queued sessions and the runner's last poll all stay, and the long-poll claim path
// (/api/mcp/sessions/pending → claim) keeps working for a client that was already running.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { claimSession, loadRunner, loadSession, pendingSessions, startSession } from "../services/agentSessions.js";
import { isRuntimeKind, RUNTIME_KINDS, runtimeAvailability } from "../services/agentRuntime/index.js";
import { touchRunnerSeen } from "../services/aiRoles.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const MIGRATION = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/157_ai_runtime_api_or_mcp.sql"), "utf8");

afterAll(async () => { await pool.end(); });

describe("the kinds", () => {
  it("are api and mcp, and nothing else is accepted", () => {
    expect([...RUNTIME_KINDS]).toEqual(["api", "mcp"]);
    expect(isRuntimeKind("subscription")).toBe(false);
  });
});

describe.skipIf(!isTestDatabase())("migration 157 — subscription folds into mcp (DB)", () => {
  it("turns a subscription role and its queued session into mcp, keeps the key and the last poll, and the queue still hands it over", async () => {
    const w = await agentWorld("kinds");
    const nodeId = await w.note(`@${w.handle} hi`);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} hi` } });
    const token = await createToken(w.agent.id, { access: "write" });
    await touchRunnerSeen(w.agent.id);
    const seenBefore = (await loadRunner(w.ws, { actorId: w.agent.id }))!.runner_seen_at;
    expect(seenBefore).not.toBeNull();

    // Put the rows back the way they were before the migration, then run it. All inside one transaction, rolled back after.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE agent_runners DROP CONSTRAINT agent_runners_default_runtime_check");
      await client.query("ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_runtime_check");
      await client.query("UPDATE agent_runners SET default_runtime = 'subscription' WHERE actor_id = $1", [w.agent.id]);
      await client.query("UPDATE agent_sessions SET runtime = 'subscription' WHERE id = $1", [session.id]);
      await client.query(MIGRATION);
      const runner = (await client.query("SELECT default_runtime, runner_seen_at FROM agent_runners WHERE actor_id = $1", [w.agent.id])).rows[0];
      expect(runner.default_runtime).toBe("mcp");
      expect(new Date(runner.runner_seen_at).getTime()).toBe(new Date(seenBefore!).getTime());
      const queued = (await client.query("SELECT runtime, status FROM agent_sessions WHERE id = $1", [session.id])).rows[0];
      expect(queued).toMatchObject({ runtime: "mcp", status: "queued" });
      // The role's key is untouched.
      expect((await client.query("SELECT 1 FROM agent_tokens WHERE id = $1 AND revoked_at IS NULL", [token.id])).rows).toHaveLength(1);
      // 'subscription' is no longer a value the database accepts.
      await client.query("SAVEPOINT s");
      await expect(client.query("UPDATE agent_runners SET default_runtime = 'subscription' WHERE actor_id = $1", [w.agent.id])).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT s");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    // Committed state (already migrated): the poll-and-claim path a running client uses.
    const runnerActor = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: token.id } }, w.ws);
    expect((await pendingSessions(runnerActor)).map((s) => s.id)).toContain(session.id);
    const claimed = await claimSession(session.id, { actor: runnerActor });
    expect(claimed).toBeTruthy();
    expect((await loadSession(session.id))!.status).toBe("delivered");
  });

  it("a new role starts as mcp, and the role's ways to run are api (when a key exists) and mcp", async () => {
    const w = await agentWorld("kinds2");
    const role = (await loadRunner(w.ws, { actorId: w.agent.id }))!;
    expect(role.default_runtime).toBe("mcp");
    expect((await runtimeAvailability(role)).map((r) => r.kind)).not.toContain("subscription");
    expect((await q("SELECT 1 FROM agent_sessions WHERE runtime = 'subscription' LIMIT 1")).rows).toHaveLength(0);
  });
});
