// The slot a change bundle's finishing step calls (spine/stampedImport.ts applyChangeBundle): what a node derives from the rows another node's bundle wrote here, in the
// same transaction (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.12, batch 4a). The work itself is services/receivedDerivation.ts (it reaches links,
// paragraph rows, trash, spaces, the modules' hooks: services, which the spine does not import); it fills this slot when it is loaded, and services/stampedBundle.ts,
// the bundle's service, loads it. A bundle is never taken without it: applyChangeBundle refuses (`bundle_no_derivation`) when the slot is empty, so a node can never
// hold rows whose links, paragraph rows or website copy were left as they were.
//
// The contract of a derivation: it writes no unit (no row and no watched field of a table of UNIT_SOURCES, no stamp; the stamp triggers stand aside during a merge, so
// nothing would show such a write: test/receivedDerivation.integration.test.ts compares every unit before and after it), and what it writes is a function of the
// replicated state after the merge, the same on every node that holds that state.
import type { RowsReport } from "./stampedMerge/index.js";
import { snapshotRows, type BundleItem } from "./snapshotSql.js";
import { bundleRefused } from "./bundleRefusal.js";
import { CodedStatusError } from "../statusError.js";

/** What the bundle wrote, as the derivation reads it after the merge. */
export type ReceivedBundle = {
  workspaceId: string;
  /** Every unit the merge changed on a row this node holds (dbRows.ts RowsReport.events): its label, row key and field. */
  units: RowsReport["events"];
  /** Notes whose space changed because their tree did (dbRows.ts RowsReport.followedSpaces). */
  followedSpaces: readonly { note: string; from: string | null; to: string | null }[];
};

type ReceivedDerivation<Prepared = unknown> = {
  /** Before the bundle's rows are written: read what the derivation needs of the rows as they were (a note about to be deleted for good). */
  before(workspaceId: string, items: readonly BundleItem[]): Promise<Prepared>;
  /** After every row of the bundle is written, before the transaction commits. */
  after(prepared: Prepared, bundle: ReceivedBundle): Promise<void>;
};

/** Of the tags `tagIds`, those made in ONE write with a paragraph's mark of them (`block_node_tags`): the tag's creation stamp and the mark's are the same (origin,
 *  seq), which is what a block save that made a tag for a `{name}` it did not find leaves (services/blockNodes.ts markAutoTags). Returns each such tag with the
 *  paragraph row (the first by id). Replicated state only: the same answer on every node that holds both rows. */
export async function tagsMadeWithTheirMark(workspaceId: string, tagIds: readonly string[]): Promise<{ tagId: string; blockNodeId: string }[]> {
  if (tagIds.length === 0) return [];
  return (await snapshotRows<{ tagId: string; blockNodeId: string }>(
    `SELECT DISTINCT ON (ts.row_key) ts.row_key AS "tagId", split_part(bs.row_key, '/', 1) AS "blockNodeId"
       FROM sync_stamps ts
       JOIN sync_stamps bs ON bs.workspace_id = ts.workspace_id AND bs.table_name = 'block_node_tags' AND bs.field = '*' AND NOT bs.deleted
                          AND bs.origin = ts.origin AND bs.seq = ts.seq AND split_part(bs.row_key, '/', 2) = ts.row_key
      WHERE ts.workspace_id = $1 AND ts.table_name = 'content_nodes' AND ts.field = '*' AND NOT ts.deleted AND ts.row_key = ANY($2::text[])
      ORDER BY ts.row_key, bs.row_key`, [workspaceId, [...tagIds]])).rows;
}

let slot: ReceivedDerivation | null = null;

/** Fill the slot (services/receivedDerivation.ts on load). Returns what it held, so a test can wrap the derivation and put it back. */
export function setReceivedDerivation(derivation: ReceivedDerivation | null): ReceivedDerivation | null {
  const previous = slot;
  slot = derivation;
  return previous;
}

/** The derivation applyChangeBundle runs, or null when nothing filled the slot. */
export const receivedDerivation = (): ReceivedDerivation | null => slot;

/** SQLSTATE classes of a failure that may pass if the same bundle is offered again (a lost connection, a deadlock or serialization failure, no memory, a shutdown). */
const TRANSIENT = /^(08|40|53|57P)/;
/**
 * Run one step of the derivation for `notes`. A failure that would be the same each time the bundle is offered (a statement too slow for the bundle's size, a row
 * the step cannot read) refuses the bundle with a code that names the step and its first notes (`bundle_derivation_failed`, 422), not a 500 that the sender retries
 * for ever (review of PR #1941, round 1, point 4). A refusal with a code of its own, and a failure that may pass, go through as they are. The whole bundle rolls back. services/receivedDerivation.ts runs each of its steps in it; applyChangeBundle runs the whole finishing step in it too (a step it names nothing of).
 */
export async function deriving<T>(what: string, notes: readonly string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const sqlState = (e as { code?: unknown }).code;
    if (e instanceof CodedStatusError || (typeof sqlState === "string" && TRANSIENT.test(sqlState))) throw e;
    // the first three notes (an array, not a text: no cut of anyone's words)
    const named = notes.length > 3 ? `${notes.filter((_, i) => i < 3).join(", ")} and ${notes.length - 3} more` : notes.join(", ");
    throw bundleRefused("bundle_derivation_failed", `what follows from the received rows could not be worked out (${what}${named ? ` of ${named}` : ""}): ${e instanceof Error ? e.message : String(e)}; nothing was taken`, 422);
  }
}
