// What a change bundle may say of the people and AI operators of a workspace (`actors`, migration 237; review of PR #1992, round 1, point 2). They are written on the
// main server only, and the trigger that refuses a write elsewhere (actors_written_on_the_centre) stands aside while a bundle is merged, so the receiver checks the
// bundle itself, before anything of it is written (the trust line, docs/decisions/sync-trust-line.md: what is received is checked):
//   - the main server (a node whose workspace never joined from another) takes back only what it wrote itself (a full resend), never another node's write of them;
//     "itself" is its id now and every id it had before it was restored from a backup and renewed (sync_origins vouched 'self-restore', migration 213): a device's
//     full resend after the restore carries the renames it wrote under the old id, and refusing them would refuse every resend for ever (review of PR #1992, round 2, point 1);
//     a device takes them from the nodes it takes bundles from, which got them from the main server (it refuses the rest, so that is where the line is held);
//   - a row it does not hold may be made only as an AI operator, with no sign-in link (a person arrives by joining, never by bundle);
//   - a row it holds keeps its kind and its sign-in link: a carried creation never changes either.
// Refused whole, nothing written: `bundle_actors_not_from_centre`, `bundle_actor_not_allowed` (409). Called by applyChangeBundle (spine/stampedImport.ts).
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { bundleRefused } from "./bundleRefusal.js";
import type { ChangeBundle } from "./snapshotSql.js";
import { GENESIS_STAMP_ORIGIN } from "./stampedMerge/index.js";
import { localNodeId } from "./stamps.js";
import { formerIdsOf } from "./stampedBundle.js";

export async function assertActorsFromTheCentre(workspaceId: string, bundle: ChangeBundle): Promise<void> {
  const items = bundle.items.filter((i) => i.table === "actors");
  if (!items.length) return;
  const joined = (await sql<{ source: string }>`SELECT source_node AS source FROM sync_join WHERE workspace_id = ${workspaceId}::uuid AND state = 'done'`.execute(db)).rows[0];
  // the main server takes back only what it wrote itself. A device takes what a node it takes bundles from carries (the bundle's origins are checked to be such
  // nodes, stampedImport.ts): every such write passed through the main server, which refuses any other node's (a device never writes them: actors_written_on_the_centre)
  const centre = new Set(joined
    ? [joined.source, ...(await sql<{ origin: string }>`SELECT origin FROM sync_origins WHERE workspace_id = ${workspaceId}::uuid`.execute(db)).rows.map((r) => r.origin)]
    : [await localNodeId(), ...Object.keys(await formerIdsOf(workspaceId))]);
  const stamps = items.flatMap((i) => (i.kind === "row" ? i.stamps : [i.stamp]));
  if (stamps.some((s) => [s.origin, ...s.heads.map((h) => h.origin)].some((o) => !centre.has(o) && o !== GENESIS_STAMP_ORIGIN))) {
    throw bundleRefused("bundle_actors_not_from_centre", "a write of a person or an AI operator that the main server did not make: they are written there only");
  }
  for (const i of items) {
    if (i.kind !== "row") continue;
    const id = i.stamps[0]?.rowKey;
    const held = (await sql<{ type: string; external_id: string | null }>`SELECT type, external_id FROM actors WHERE workspace_id = ${workspaceId}::uuid AND id::text = ${id}`.execute(db)).rows[0];
    const type = i.values.type, link = i.values.external_id ?? null;
    if (!held) {
      if (type !== "agent" || link !== null) throw bundleRefused("bundle_actor_not_allowed", "only an AI operator, with no sign-in link, is made by a bundle: a person arrives by joining");
    } else if ((type !== undefined && type !== held.type) || (link !== null && link !== held.external_id)) {
      throw bundleRefused("bundle_actor_not_allowed", "a bundle never changes what kind an actor is, or its sign-in link");
    }
  }
}
