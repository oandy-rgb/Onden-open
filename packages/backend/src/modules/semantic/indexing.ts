// Getting a workspace's notes ready for search by meaning, and keeping their
// related-note suggestions current, all through the outbox:
//
//   • `embed_backfill` embeds the notes that are not embedded yet (a few at a
//     time, then files itself again), then refreshes each note's suggestions.
//     It starts when the owner turns the module on, and at every server start for
//     a workspace that has it on with notes still to do (`resumeIndexing`: the
//     ones that turned it on before this existed, and a chain that ran out of
//     retries). The notes still to do are read from node_embeddings, so a restart
//     or a failed batch resumes where it stopped; the module being off ends the
//     chain at its next batch.
//   • `refreshOwnerSuggestions` runs after a single note is embedded (the `embed`
//     effect), so a note edited later gets fresh suggestions with no client call.
//
// Suggestions are stored as shared edges but read only where the reader can read
// both ends (sync/bootstrap.ts), and are computed here as the workspace owner:
// only notes the owner can read are suggested, and a note the owner cannot read
// gets none (readableNodeIdSet, services/readPolicy.ts).

import { sql } from "kysely";
import { liveNodeSql } from "../../spine/nodeSql.js";
import { db } from "../../dbKysely.js";
import { enqueueEffect, requireString, type OutboxEffect } from "../../services/outbox.js";
import { embedNode, refreshSuggestedLinks } from "../../services/embeddings.js";
import { getEmbedder } from "../../services/embedder.js";
import { readableNodeIdSet } from "../../services/readPolicy.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import { notATaskNodeSql } from "../../services/tasksStore.js";
import { NOT_SYSTEM_NODE_SQL } from "../../spine/reservedNodes.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import type { ActorCtx } from "../../types.js";

export const SEMANTIC_MODULE = "semantic";

/** Notes embedded, or given suggestions, per outbox attempt. */
const BACKFILL_BATCH = 20;

/** What counts as a note to embed: the same notes a body write files an embed intent for,
 *  less the blank ones (nothing to read) and tags, tasks and system notes. */
const embeddable = () => sql<boolean>`${sql.raw(liveNodeSql("n"))} AND n.node_type = 'content'
  AND ${sql.raw(NOT_SYSTEM_NODE_SQL("n"))} AND ${sql.raw(notATaskNodeSql("n"))}
  AND (n.title <> '' OR n.markdown <> '')`;

const key = (workspaceId: string) => `embed_backfill:${workspaceId}`;

type BackfillPayload = { workspaceId: string; phase: "embed" | "link"; after: string | null };

/** File (or fold into the pending one) the start of indexing a workspace's notes. Inside the caller's transaction or alone. */
export async function requestBackfill(workspaceId: string): Promise<void> {
  const payload: BackfillPayload = { workspaceId, phase: "embed", after: null };
  await enqueueEffect({ workspaceId, kind: "embed_backfill", dedupKey: key(workspaceId), payload });
}

/** The notes with no embedding from the current model yet, by id. */
function unembedded(workspaceId: string) {
  const model = getEmbedder().name;
  return db.selectFrom("content_nodes as n")
    .leftJoin("node_embeddings as e", "e.node_id", "n.id")
    .select(["n.id", "n.title", "n.markdown"])
    .where("n.workspace_id", "=", workspaceId)
    .where(embeddable())
    .where(sql<boolean>`(e.node_id IS NULL OR e.model <> ${model})`)
    .orderBy("n.id");
}

const nextToEmbed = (workspaceId: string) => unembedded(workspaceId).limit(BACKFILL_BATCH).execute();

/** Server start: file the indexing for every workspace that has the module on and notes still to prepare.
 *  Folds into a chain already pending (one dedup key), so a restart never doubles the work. */
export async function resumeIndexing(): Promise<void> {
  const workspaces = await db.selectFrom("workspaces").select("id").execute();
  for (const { id } of workspaces) {
    if (!(await workspaceHasModule(id, SEMANTIC_MODULE))) continue;
    if ((await unembedded(id).limit(1).execute()).length > 0) await requestBackfill(id);
  }
}

async function ownerActor(workspaceId: string): Promise<ActorCtx | null> {
  const row = await db.selectFrom("workspaces").select("owner_actor_id").where("id", "=", workspaceId).executeTakeFirst();
  return row?.owner_actor_id ? resolveCurrentActor({ id: row.owner_actor_id }, workspaceId) : null;
}

/** Replace a note's suggestions with its nearest notes the owner can read; none for a note the owner cannot read. */
export async function refreshOwnerSuggestions(workspaceId: string, nodeId: string): Promise<void> {
  const owner = await ownerActor(workspaceId);
  if (!owner) return;
  if (!(await readableNodeIdSet(owner, workspaceId)).has(nodeId)) return;
  await refreshSuggestedLinks(workspaceId, nodeId, { actor: owner });
}

async function nextToLink(workspaceId: string, after: string | null): Promise<string[]> {
  const rows = await db.selectFrom("content_nodes as n")
    .innerJoin("node_embeddings as e", "e.node_id", "n.id")
    .select("n.id")
    .where("n.workspace_id", "=", workspaceId)
    .where(embeddable())
    .$if(after !== null, (qb) => qb.where("n.id", ">", after!))
    .orderBy("n.id")
    .limit(BACKFILL_BATCH)
    .execute();
  return rows.map((r) => r.id);
}

export const embedBackfillEffect: OutboxEffect<BackfillPayload> = {
  kind: "embed_backfill",
  timeoutMs: 5 * 60_000, // a batch of model calls
  parse: (p) => ({
    workspaceId: requireString(p, "workspaceId"),
    phase: p.phase === "link" ? "link" : "embed",
    after: typeof p.after === "string" ? p.after : null,
  }),
  perform: async (p) => {
    // Turned off since the batch was filed: the chain ends here, nothing is lost.
    if (!(await workspaceHasModule(p.workspaceId, SEMANTIC_MODULE))) return;
    const next = (phase: BackfillPayload["phase"], after: string | null) =>
      enqueueEffect({ workspaceId: p.workspaceId, kind: "embed_backfill", dedupKey: key(p.workspaceId), payload: { workspaceId: p.workspaceId, phase, after } });
    if (p.phase === "embed") {
      const batch = await nextToEmbed(p.workspaceId);
      for (const note of batch) await embedNode(p.workspaceId, note.id, `${note.title}\n\n${note.markdown}`);
      // A full batch may leave more; a short one means every note has its embedding, so the suggestions come next
      // (each note's nearest notes are only complete once all of them are embedded).
      await next(batch.length === BACKFILL_BATCH ? "embed" : "link", null);
      return;
    }
    const ids = await nextToLink(p.workspaceId, p.after);
    for (const id of ids) await refreshOwnerSuggestions(p.workspaceId, id);
    if (ids.length === BACKFILL_BATCH) await next("link", ids[ids.length - 1]!);
  },
};

export type IndexProgress = {
  /** Notes this reader can read that are ready for search by meaning. */
  ready: number;
  /** Notes this reader can read that can be indexed. */
  total: number;
  /** Indexing is queued or running. */
  working: boolean;
};

/** How far indexing has got, among the notes `actor` can read (never a count of notes they cannot). */
export async function indexProgress(workspaceId: string, actor: ActorCtx): Promise<IndexProgress> {
  const readable = [...await readableNodeIdSet(actor, workspaceId)];
  const model = getEmbedder().name;
  const counts = readable.length === 0 ? { total: 0, ready: 0 } : await db.selectFrom("content_nodes as n")
    .leftJoin("node_embeddings as e", (join) => join.onRef("e.node_id", "=", "n.id").on("e.model", "=", model))
    .select([sql<number>`count(*)::int`.as("total"), sql<number>`count(e.node_id)::int`.as("ready")])
    .where("n.workspace_id", "=", workspaceId)
    .where(sql<boolean>`n.id = ANY(${readable}::uuid[])`)
    .where(embeddable())
    .executeTakeFirstOrThrow();
  const queued = await db.selectFrom("outbox").select("id")
    .where("workspace_id", "=", workspaceId)
    .where("effect_kind", "in", ["embed_backfill", "embed"])
    .where("status", "=", "pending") // an attempt in flight is still the pending row (outbox.ts settles it by xmin)
    .limit(1).executeTakeFirst();
  return { ready: counts.ready, total: counts.total, working: queued !== undefined };
}
