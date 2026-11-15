import type { LayoutConfigPatch } from "@onden/contract";
import { t } from "../i18n";
import { makeOnlineOperation } from "./onlineWrite";
import { makeWriteLifecycle } from "./writeLifecycle";
import type { WriteResult } from "./writeQueue";
import type { DataCtx } from "./types";
import { viewOwnerPath, type ViewOwner } from "./viewOwner";

/** The keys of a saved view that can change. The server merges only the keys
 *  sent, so a change replays safely and two changes to different keys of the
 *  same view never undo each other. */
export type ViewChanges = Partial<{
  name: string;
  layout: string;
  filters: unknown[];
  sorts: unknown[];
  group_by: string | null;
  visible_fields: string[];
  /** The whole `layout_config`, for a view being rebuilt (a layout choice). A change to one setting of a
   *  whiteboard goes as `layout_config_patch`, so another device's other settings are kept. */
  layout_config: Record<string, unknown>;
  /** Only the named `layout_config` keys change; `null` removes one (@onden/contract LayoutConfigPatch). */
  layout_config_patch: LayoutConfigPatch;
  /** The view's place among the owner's tabs (lowest first). */
  pin_order: number;
}>;

export type ViewInput = { name: string; layout: string; visible_fields?: string[] } & ViewChanges;

/** Saved views of a tag (its members) or a note (its children). Views live
 *  on the owner's row on the server; screens keep their own copy and re-read
 *  after a change.
 *  - `update` is an ordinary write: accepted by the server or durably queued
 *    (offline / transient failure) and replayed in order per view; a refusal
 *    is reported once and rethrown.
 *  - `create` needs the server, which mints the view id: refused offline (with
 *    a message), retried under the same Idempotency-Key. Resolves to the new
 *    id, or null when a retry was answered as a replay (re-read the views).
 *  - `remove` needs the server too: a queued delete replayed after someone
 *    else removed the view would come back as a refusal. Refused offline. */
export function makeViewWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);
  const online = makeOnlineOperation(ctx);

  function update(owner: ViewOwner, viewId: string, changes: ViewChanges): Promise<WriteResult<unknown>> {
    return commit(`view:${owner.id}:${viewId}`, {
      method: "PATCH", path: `${viewOwnerPath(owner)}/views/${viewId}`, body: JSON.stringify(changes),
    });
  }

  async function create(owner: ViewOwner, input: ViewInput): Promise<string | null> {
    const result = await online(`views:${owner.id}`, t("Creating a view needs a connection."), (submit) =>
      submit<{ id: string }>(`${viewOwnerPath(owner)}/views`, JSON.stringify(input)));
    return "id" in result ? result.id : null;
  }

  async function remove(owner: ViewOwner, viewId: string): Promise<void> {
    await online(`views:${owner.id}`, t("Deleting a view needs a connection."), (submit) =>
      submit(`${viewOwnerPath(owner)}/views/${viewId}`, undefined, "DELETE"));
  }

  return { create, update, remove };
}
