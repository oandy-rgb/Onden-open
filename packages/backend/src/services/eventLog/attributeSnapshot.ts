import { isInkPageAttr } from "@onden/markdown";
import { putBlob } from "../blobs.js";

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

export function encodeSnapshot(key: string, row: AttributeState): Promise<AttributeSnapshot>;
export function encodeSnapshot(key: string, row: null): Promise<null>;
export function encodeSnapshot(key: string, row: AttributeState | null): Promise<AttributeSnapshot | null>;
/** Encode actual before/after state; null means the row did not exist.
 * Ink stays content-addressed in both directions of undo/redo. Must run in
 * the write transaction when the result accompanies a committed event.
 */
export async function encodeSnapshot(key: string, row: AttributeState | null): Promise<AttributeSnapshot | null> {
  if (row === null) return null;
  const metadata = { value_type: row.value_type, is_inheritable: row.is_inheritable, source: row.source };
  return isInkPageAttr(key)
    ? { ...metadata, value_ref: await putBlob(row.value), value_len: row.value.length }
    : { ...metadata, value: row.value };
}
