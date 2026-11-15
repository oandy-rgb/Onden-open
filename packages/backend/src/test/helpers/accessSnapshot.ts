import { q } from "../../db.js";
import { assertAuthority } from "../../spine/authority.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { readableSpaceIdsSql } from "../../spine/spaceAccess.js";
import { spaceWritable } from "../../spine/spaceScope.js";
import type { ActorCtx } from "../../types.js";

// What an actor can reach in each space, computed two independent ways, so a
// change of the access rule shows up as a difference instead of being checked
// against itself (docs/architecture/proposals/roles-owner-member-2026-10-22.md
// §8.1, §8.3):
//
//   legacyAccessSnapshot   a FROZEN reimplementation in plain SQL of the access
//                          rule as of 2026-10-22 (viewer/editor/manager member
//                          roles, token read/write space lists, the issuer
//                          clamp, the external_ai switch). It reads the legacy
//                          columns directly and calls no application code, so
//                          it runs on a database BEFORE migration 127 (the
//                          scratch database of ownerMemberMigration.integration
//                          .test.ts) and keeps its meaning after the app code
//                          changed. It takes the connection to ask.
//   currentAccessSnapshot  the same question put to the application code
//                          (resolveCurrentActor, readableSpaceIdsSql,
//                          spaceWritable, assertAuthority), on whatever
//                          database the process is bound to.
//
// Do NOT "update" the legacy half to follow a later rule change: it is the
// before-picture.

/** Anything with pg's `query` (a Client or Pool). */
export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Space ids, sorted, per kind of access. `manage` is the right to change a
 *  space's members and switches (spine authority `space`, min manager). */
export type AccessSnapshot = { read: string[]; write: string[]; manage: string[] };

/** A person (no tokenId) or one agent token. */
export type AccessSubject = { actorId: string; tokenId?: string };

const sorted = (ids: string[]) => [...ids].sort();

/** Is the token usable at all: not revoked, not expired, its actor is in the
 *  workspace and not the System account (currentActor.ts). */
async function tokenIsLive(db: Queryable, workspaceId: string, s: Required<AccessSubject>): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM agent_tokens t JOIN actors a ON a.id = t.actor_id
      WHERE t.id = $1 AND a.id = $2 AND a.workspace_id = $3 AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > statement_timestamp())
        AND a.external_id IS DISTINCT FROM 'system'`,
    [s.tokenId, s.actorId, workspaceId]);
  return r.rows.length > 0;
}

/** The access rule as it stood before the owner/member change, in SQL alone. */
export async function legacyAccessSnapshot(db: Queryable, workspaceId: string, subject: AccessSubject): Promise<AccessSnapshot> {
  const empty: AccessSnapshot = { read: [], write: [], manage: [] };
  if (subject.tokenId) {
    if (!(await tokenIsLive(db, workspaceId, subject as Required<AccessSubject>))) return empty;
    // The token's effective lists: NULL = no limit from the grant; a token with
    // an issuer (or whose issuer was removed) is bounded by that issuer's own
    // spaces, and for writing by the issuer being editor or manager there.
    const rows = (access: "read" | "write") => db.query(
      `WITH t AS (SELECT * FROM agent_tokens WHERE id = $2),
            grant_ids AS (SELECT CASE WHEN $4::text = 'read' THEN read_space_ids ELSE write_space_ids END AS ids, issued_by, issuer_removed_at FROM t),
            lim AS (
              SELECT CASE WHEN g.issued_by IS NULL AND g.issuer_removed_at IS NULL THEN g.ids ELSE ARRAY(
                SELECT im.space_id FROM space_members im JOIN spaces isp ON isp.id = im.space_id AND isp.deleted_at IS NULL
                 WHERE im.actor_id = g.issued_by
                   AND ($4::text = 'read' OR im.role IN ('editor', 'manager'))
                   AND (g.ids IS NULL OR im.space_id = ANY(g.ids))) END AS ids
                FROM grant_ids g)
       SELECT m.space_id::text AS id
         FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL, lim
        WHERE m.actor_id = $1 AND s.workspace_id = $3
          AND s.capabilities->>'external_ai' = 'true'
          AND ($4::text = 'read' OR m.role IN ('editor', 'manager'))
          AND (lim.ids IS NULL OR m.space_id = ANY(lim.ids))`,
      [subject.actorId, subject.tokenId, workspaceId, access]);
    return { read: sorted((await rows("read")).rows.map((r: { id: string }) => r.id)), write: sorted((await rows("write")).rows.map((r: { id: string }) => r.id)), manage: [] };
  }
  const member = (roles: string) => db.query(
    `SELECT m.space_id::text AS id FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
      WHERE m.actor_id = $1 AND s.workspace_id = $2 AND m.role IN ${roles}`, [subject.actorId, workspaceId]);
  // The owner may step into any SHARED space as manager; a personal space never.
  const manage = await db.query(
    `SELECT s.id::text AS id FROM spaces s
       LEFT JOIN space_members m ON m.space_id = s.id AND m.actor_id = $1
      WHERE s.workspace_id = $2 AND s.deleted_at IS NULL
        AND (m.role = 'manager'
             OR (s.kind = 'shared' AND EXISTS (
                  SELECT 1 FROM actors a JOIN workspaces w ON w.id = a.workspace_id
                   WHERE a.id = $1 AND (w.owner_actor_id = a.id
                      OR (a.role = 'admin' AND (a.external_id = 'system' OR w.owner_actor_id IS NULL))))))`,
    [subject.actorId, workspaceId]);
  return {
    read: sorted((await member("('viewer', 'editor', 'manager')")).rows.map((r: { id: string }) => r.id)),
    write: sorted((await member("('editor', 'manager')")).rows.map((r: { id: string }) => r.id)),
    manage: sorted(manage.rows.map((r: { id: string }) => r.id)),
  };
}

/** The same question put to the application code. `among` limits the answer to those spaces: it asks the
 *  application about each space one by one, and a test sharing the default workspace with the rest of the
 *  suite would otherwise ask about every space every other file left there (hundreds, seconds per call). */
export async function currentAccessSnapshot(workspaceId: string, subject: AccessSubject, among?: readonly string[]): Promise<AccessSnapshot> {
  const base = (await q<{ id: string; name: string; type: ActorCtx["type"] }>(
    `SELECT id::text, name, type FROM actors WHERE id = $1 AND workspace_id = $2`,
    [subject.actorId, workspaceId])).rows[0];
  if (!base) return { read: [], write: [], manage: [] };
  let actor: ActorCtx;
  if (subject.tokenId) {
    try { actor = await resolveCurrentActor({ id: subject.actorId, tokenScope: { tokenId: subject.tokenId } }, workspaceId); }
    catch { return { read: [], write: [], manage: [] }; } // a dead token reaches nothing
  } else {
    actor = base;
  }
  const params: unknown[] = [];
  const readable = await q<{ space_id: string }>(readableSpaceIdsSql(actor, params), params);
  const all = among
    ? (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`, [workspaceId, [...among]])).rows
    : (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND deleted_at IS NULL`, [workspaceId])).rows;
  const inScope = (id: string) => !among || among.includes(id);
  const write: string[] = [];
  const manage: string[] = [];
  for (const { id } of all) {
    if (await spaceWritable(actor, id)) write.push(id);
    try { await assertAuthority(actor, { kind: "space", spaceId: id, need: "manage" }); manage.push(id); } catch { /* not a manager */ }
  }
  return { read: sorted(readable.rows.map((r) => r.space_id).filter(inScope)), write: sorted(write), manage: sorted(manage) };
}

/** Every person in the workspace and every token, before/after picture. Keys:
 *  `person:<actorId>` and `token:<tokenId>`. `db` is asked for the roster and,
 *  for "legacy", for the access itself. */
export async function snapshotAll(
  db: Queryable, workspaceId: string, which: "legacy" | "current",
): Promise<Record<string, AccessSnapshot>> {
  const people = (await db.query(`SELECT id::text FROM actors WHERE workspace_id = $1 ORDER BY id`, [workspaceId])).rows as Array<{ id: string }>;
  const tokens = (await db.query(
    `SELECT t.id::text, t.actor_id::text FROM agent_tokens t JOIN actors a ON a.id = t.actor_id WHERE a.workspace_id = $1 ORDER BY t.id`,
    [workspaceId])).rows as Array<{ id: string; actor_id: string }>;
  const take = (subject: AccessSubject) => which === "legacy" ? legacyAccessSnapshot(db, workspaceId, subject) : currentAccessSnapshot(workspaceId, subject);
  const out: Record<string, AccessSnapshot> = {};
  for (const p of people) out[`person:${p.id}`] = await take({ actorId: p.id });
  for (const t of tokens) out[`token:${t.id}`] = await take({ actorId: t.actor_id, tokenId: t.id });
  return out;
}

/** What `after` reaches that `before` did not (the §8.1 "never widen" check):
 *  every space readable/writable/manageable afterwards must have been so before. */
export function wideningsOf(before: AccessSnapshot, after: AccessSnapshot): string[] {
  const out: string[] = [];
  for (const k of ["read", "write", "manage"] as const) {
    for (const id of after[k]) if (!before[k].includes(id)) out.push(`${k}:${id}`);
  }
  return out;
}
