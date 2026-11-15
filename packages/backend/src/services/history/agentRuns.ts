// An agent "run": the notes one agent changed in one go, for History's
// "undo this run". Two ways to tell runs apart:
//
//   * session writes carry payload.agent_run_id = the agent session's id
//     (spine/mutate.ts stamps it from the session token), so the run is the
//     session — however long it took;
//   * a place of an AI suggestion that a person accepted is the person's write
//     (updateNode as them) but belongs to the run that proposed it:
//     tx_meta.suggested_by = { actor_id, session_id } (services/aiSuggestions.ts),
//     so the run is that session and the agent is the proposer. One proposed
//     without a session (a resident token) forms no run: undo it as an ordinary edit;
//   * older events (and writes through a resident token) have none: the same
//     agent actor's body-changing events, each within RUN_GAP of the one
//     before, are one run, named `legacy:<actor id>:<first event id>`.
//
// Only body-changing events (NODE_CREATED / NODE_UPDATED / NODE_RESTORED with
// body_hash) count, the same events the version list is built from.

import { isUuid } from "@onden/markdown";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { bodyEventSql, lastBodyHashBeforeSql } from "./bodyEvents.js";
import { readableNotesSql } from "./readableNotes.js";

export const RUN_GAP = "10 minutes";

type RunNote = {
  nodeId: string;
  firstEventId: string;
  lastEventId: string;
  /** The note was born in this run: nothing to go back to. */
  created: boolean;
  /** Body hash before the run's first write (null: no earlier body). */
  preHash: string | null;
  /** Body hash after the run's last write. */
  endHash: string;
  title: string;
  spaceId: string | null;
};

export type AgentRun = {
  runId: string;
  agentActorId: string;
  agentName: string;
  /** agent_sessions.id when the run is a session, else null. */
  sessionId: string | null;
  startedAt: Date;
  endedAt: Date;
  /** Notes `actor` can read, in order of first write. */
  notes: RunNote[];
};

type EventRow = {
  id: string; run_id: string; actor_id: string; target_id: string; event_type: string;
  created_at: Date; body_hash: string; title: string | null; session_id: string | null;
};

/** The run an event belongs to and the agent behind it: the session token's
 *  own stamp, else the suggestion an accepting person carried out. */
const RUN_SESSION_SQL = `COALESCE(e.payload->>'agent_run_id', e.tx_meta->'suggested_by'->>'session_id')`;
const RUN_ACTOR_SQL = `COALESCE(e.tx_meta->'suggested_by'->>'actor_id', e.actor_id)`;

/** Every body-changing agent event with its run id. `only` narrows to one
 *  session or one agent before grouping, which gives the same run ids as the
 *  full scan (runs never mix actors). */
async function runEvents(workspaceId: string, only?: { sessionId: string } | { actorId: string }): Promise<EventRow[]> {
  const params: unknown[] = [workspaceId];
  let narrow = "";
  if (only && "sessionId" in only) narrow = `AND ${RUN_SESSION_SQL} = $${params.push(only.sessionId)}`;
  else if (only) narrow = `AND ${RUN_ACTOR_SQL} = $${params.push(only.actorId)}`;
  const r = await q<EventRow>(
    `WITH ev AS (
       SELECT e.id, ${RUN_ACTOR_SQL} AS actor_id, e.target_id, e.event_type, e.created_at,
              ${RUN_SESSION_SQL} AS session_id,
              e.payload->>'body_hash' AS body_hash, e.payload->>'title' AS title
         FROM domain_events e
        WHERE e.workspace_id = $1 AND (e.actor_type = 'ai_agent' OR e.tx_meta->'suggested_by'->>'session_id' IS NOT NULL)
          AND ${bodyEventSql("e")} ${narrow}
     ),
     gapped AS (
       SELECT *, (session_id IS NULL) AS legacy,
              CASE WHEN session_id IS NOT NULL THEN 0
                   WHEN lag(created_at) OVER w IS NULL OR created_at - lag(created_at) OVER w > interval '${RUN_GAP}' THEN 1
                   ELSE 0 END AS boundary
         FROM ev
       WINDOW w AS (PARTITION BY actor_id, (session_id IS NULL) ORDER BY created_at, id)
     ),
     grouped AS (
       SELECT *, sum(boundary) OVER (PARTITION BY actor_id, legacy ORDER BY created_at, id) AS grp FROM gapped
     )
     SELECT id::text, actor_id, target_id, event_type, created_at, body_hash, title, session_id,
            COALESCE(session_id, 'legacy:' || actor_id || ':' || first_value(id) OVER (PARTITION BY actor_id, legacy, grp ORDER BY created_at, id)) AS run_id
       FROM grouped
      ORDER BY created_at, id`,
    params,
  );
  return r.rows;
}

/** Group events into runs and keep the notes `actor` can read (only those in
 *  `spaceId` when given: a run with none there is dropped). `keep` picks
 *  which runs are wanted (by run id and start time). */
async function buildRuns(
  actor: ActorCtx, workspaceId: string, events: EventRow[], keep: (runId: string, startedAt: Date) => boolean,
  spaceId?: string,
): Promise<AgentRun[]> {
  const byRun = new Map<string, EventRow[]>();
  for (const e of events) (byRun.get(e.run_id) ?? byRun.set(e.run_id, []).get(e.run_id)!).push(e);
  const wanted = [...byRun.entries()].filter(([id, rows]) => keep(id, rows[0]!.created_at));
  if (wanted.length === 0) return [];

  const nodeIds = [...new Set(wanted.flatMap(([, rows]) => rows.map((e) => e.target_id)))];
  const params: unknown[] = [workspaceId, nodeIds];
  const readableSql = await readableNotesSql(actor, workspaceId, "n", params, { spaceId });
  const readable = await q<{ id: string; title: string; space_id: string | null }>(
    `SELECT n.id::text AS id, n.title, n.space_id::text AS space_id FROM content_nodes n
      WHERE n.workspace_id = $1 AND n.id::text = ANY($2::text[]) AND ${readableSql}`,
    params,
  );
  const titles = new Map(readable.rows.map((r) => [r.id, r.title]));
  const spaces = new Map(readable.rows.map((r) => [r.id, r.space_id]));

  // Only events about notes the actor can read take part: a run's times and
  // notes never reveal a write to a note they cannot see.
  type Draft = { runId: string; rows: EventRow[]; first: Map<string, EventRow>; last: Map<string, EventRow> };
  const drafts: Draft[] = [];
  for (const [runId, all] of wanted) {
    const rows = all.filter((e) => titles.has(e.target_id));
    const first = new Map<string, EventRow>();
    const last = new Map<string, EventRow>();
    for (const e of rows) {
      if (!first.has(e.target_id)) first.set(e.target_id, e);
      last.set(e.target_id, e);
    }
    if (first.size > 0) drafts.push({ runId, rows, first, last });
  }
  if (drafts.length === 0) return [];

  // The body each note had before the run's first write to it.
  const pairs = drafts.flatMap((d) => [...d.first.values()].map((e) => ({ node: e.target_id, before: e.id })));
  const pre = await q<{ node_id: string; before_id: string; hash: string | null }>(
    `SELECT x.node_id, x.before_id::text AS before_id,
            ${lastBodyHashBeforeSql("$1", "x.node_id", { eventId: "x.before_id" })} AS hash
       FROM unnest($2::text[], $3::bigint[]) AS x(node_id, before_id)`,
    [workspaceId, pairs.map((p) => p.node), pairs.map((p) => p.before)],
  );
  const preHash = new Map(pre.rows.map((r) => [`${r.node_id}:${r.before_id}`, r.hash]));

  const names = await q<{ id: string; name: string }>(
    `SELECT id::text, name FROM actors WHERE workspace_id = $1 AND id::text = ANY($2::text[])`,
    [workspaceId, [...new Set(drafts.map((d) => d.rows[0]!.actor_id))]],
  );
  const actorName = new Map(names.rows.map((r) => [r.id, r.name]));

  return drafts.map((d) => ({
    runId: d.runId,
    agentActorId: d.rows[0]!.actor_id,
    agentName: actorName.get(d.rows[0]!.actor_id) ?? "",
    sessionId: d.rows[0]!.session_id,
    startedAt: d.rows[0]!.created_at,
    endedAt: d.rows[d.rows.length - 1]!.created_at,
    notes: [...d.first.values()].map((first) => {
      const last = d.last.get(first.target_id)!;
      return {
        nodeId: first.target_id,
        firstEventId: first.id,
        lastEventId: last.id,
        created: first.event_type === "NODE_CREATED",
        preHash: preHash.get(`${first.target_id}:${first.id}`) ?? null,
        endHash: last.body_hash,
        title: titles.get(first.target_id)!,
        spaceId: spaces.get(first.target_id) ?? null,
      };
    }),
  }));
}

/** The runs that started in [from, to), with the notes `actor` can read
 *  (inside `spaceId` when given). */
export async function agentRunsStartedBetween(actor: ActorCtx, workspaceId: string, from: Date, to: Date, spaceId?: string): Promise<AgentRun[]> {
  const events = await runEvents(workspaceId);
  return buildRuns(actor, workspaceId, events, (_id, startedAt) => startedAt >= from && startedAt < to, spaceId);
}

const LEGACY = /^legacy:([^:]+):(\d{1,18})$/;

/** One run by its id, or null when it does not exist or has no note `actor`
 *  can read. */
export async function findAgentRun(actor: ActorCtx, workspaceId: string, runId: string): Promise<AgentRun | null> {
  const legacy = LEGACY.exec(runId);
  const events = isUuid(runId)
    ? await runEvents(workspaceId, { sessionId: runId })
    : legacy ? await runEvents(workspaceId, { actorId: legacy[1]! }) : [];
  return (await buildRuns(actor, workspaceId, events, (id) => id === runId))[0] ?? null;
}
