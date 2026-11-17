// What a snapshot must never carry: credentials, sign-in rows, invitations, sealed secrets, tokens. The list is the reviewer's rule, written
// down: a table or a column that looks like one of these cannot be in spine/snapshotTables.json, and a new table is not carried unless it is
// classified and described there (spine/syncClasses.json, syncClasses.integration.test.ts). A column that is carried only with an override
// (a person's sign-in link) has to say so.
// realPostgresAlso: only reads the catalog
import { describe, expect, it } from "vitest";
import { carriedColumns } from "../spine/snapshotSql.js";
import { SNAPSHOT_SPECS, wholeWorkspace } from "../spine/snapshotTables.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

const NEVER_TABLES = ["participant_sessions", "agent_tokens", "agent_runners", "agent_sessions", "session", "account", "user", "verification", "ai_credentials", "push_subscriptions", "idempotency_keys", "outbox", "domain_events", "structure_log", "sync_node", "sync_clock", "sync_join", "browser_app_state", "publish_snapshots", "rate_limit_hits"];
const SECRET_COLUMN = /token|secret|password|passwd|cipher|credential|invite|api_?key|vapid|private_?key|session_?id/i;

describe.skipIf(!isTestDb)("what a snapshot never carries", () => {
  it("none of the never-carried tables is described in snapshotTables.json", () => {
    expect(SNAPSHOT_SPECS.map((s) => s.table).filter((t) => NEVER_TABLES.includes(t))).toEqual([]);
  });

  it("no carried column is a credential, a sign-in, an invitation or a sealed secret", async () => {
    const found: string[] = [];
    for (const spec of SNAPSHOT_SPECS) for (const column of await carriedColumns(spec)) if (SECRET_COLUMN.test(column)) found.push(`${spec.table}.${column}`);
    expect(found).toEqual([]);
  });

  it("a person's sign-in link (actors.external_id) is carried only for accounts that are not people", async () => {
    const actors = SNAPSHOT_SPECS.find((s) => s.table === "actors")!;
    expect(await carriedColumns(actors)).toContain("external_id");
    const override = actors.override!(wholeWorkspace());
    expect(override.external_id).toContain("CASE WHEN t.type = 'human' THEN NULL");
    expect(actors.exclude).toEqual(expect.arrayContaining(["invite_email", "invite_token_hash", "invite_expires_at", "invite_used_at"]));
  });
});
