import { isInkPageAttr } from "@onden/markdown";
import { putBlob } from "../blobs.js";
import { INK_CHUNK_THRESHOLD, putInkChunks } from "../inkChunks.js";

/** The semantic state of one logical attribute (identified by node + key).
 * Row UUIDs and timestamps describe storage/history, not the value to restore.
 * Preserve legacy source literals too: their priority still affects writes.
 */
export type AttributeState = {
  value: string;
  value_type: string;
  is_inheritable: boolean;
  source: string;
};

export type AttributeSnapshot = Record<string, unknown> & {
  value_type: string;
  is_inheritable: boolean;
  source: string;
} & ({ value: string } | { value_ref: string; value_len: number });

/** The note a snapshot is of: a big drawing is stored as that note's chunks (services/inkChunks.ts). */
export type SnapshotScope = { workspaceId: string; nodeId: string };

export function encodeSnapshot(key: string, row: AttributeState, scope?: SnapshotScope): Promise<AttributeSnapshot>;
export function encodeSnapshot(key: string, row: null, scope?: SnapshotScope): Promise<null>;
export function encodeSnapshot(key: string, row: AttributeState | null, scope?: SnapshotScope): Promise<AttributeSnapshot | null>;
/** Encode actual before/after state; null means the row did not exist.
 * Ink stays content-addressed in both directions of undo/redo. Must run in
 * the write transaction when the result accompanies a committed event.
 * A drawing over INK_CHUNK_THRESHOLD is stored as chunks of `scope`'s note (a save adds only what it changed); without a
 * scope, or under the threshold, it is one `blobs` row. Either way `value_ref` is the sha256 of the whole value.
 */
export async function encodeSnapshot(key: string, row: AttributeState | null, scope?: SnapshotScope): Promise<AttributeSnapshot | null> {
  if (row === null) return null;
  const metadata = { value_type: row.value_type, is_inheritable: row.is_inheritable, source: row.source };
  if (!isInkPageAttr(key)) return { ...metadata, value: row.value };
  const ref = scope && row.value.length >= INK_CHUNK_THRESHOLD
    ? await putInkChunks(scope.workspaceId, scope.nodeId, row.value)
    : await putBlob(row.value);
  return { ...metadata, value_ref: ref, value_len: row.value.length };
}
