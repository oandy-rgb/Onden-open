import type { NodeAttribute } from "../api";
import { isInkPageAttr } from "@onden/markdown/contract";
import { getNodeAttributeRecord, upsertAttribute, removeAttribute } from "../localDb";
import { setNodeAttr, dropNodeAttr } from "./storeOps";
import { optimisticFields } from "./optimisticFields";
import { makeWriteLifecycle } from "./writeLifecycle";
import { makeOnlineOperation } from "./onlineWrite";
import { t } from "../i18n";
import type { DataCtx } from "./types";
import { nodeOf } from "../nodeIndex";

/** `keepalive`: the page is going away, so the request must outlive it. */
export type PropertyOptions = { value_type?: string; is_inheritable?: boolean; keepalive?: boolean };

/** Owns attribute metadata as well as the visible value. Deleting a required
 * field and being rejected must not recreate it as an unrelated text field. */
export function makePropertyWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);
  const onlineOperation = makeOnlineOperation(ctx);

  function change(nodeId: string, key: string, value: string | undefined, opts: PropertyOptions = {}) {
    const nodeWasLoaded = !!nodeOf(ctx.data, nodeId);
    const previous = nodeOf(ctx.data, nodeId)?.attrs?.[key];
    const settle = optimisticFields(`attribute:${nodeId}`, { [key]: previous }, { [key]: value });
    // A flag or type the caller does not name is left out of the request: the server keeps the row's own.
    const metadata = { value_type: opts.value_type ?? "text", is_inheritable: opts.is_inheritable ?? false, source: "ui" };
    let previousRecord: NodeAttribute | null = null;
    let readPrevious = false;
    let desired = value;
    ctx.setData((state) => value === undefined ? dropNodeAttr(state, nodeId, key) : setNodeAttr(state, nodeId, key, value));
    return commit<NodeAttribute>(`node:${nodeId}`, {
      method: value === undefined ? "DELETE" : "PUT",
      ...(opts.keepalive ? { init: { keepalive: true } } : {}),
      path: `/api/nodes/${nodeId}/attributes/${encodeURIComponent(key)}`,
      body: value === undefined ? null : JSON.stringify({ value, ...(opts.value_type === undefined ? {} : { value_type: opts.value_type }), ...(opts.is_inheritable === undefined ? {} : { is_inheritable: opts.is_inheritable }), client_updated_at: new Date().toISOString() }),
    }, {
      mirror: async () => {
        if (!readPrevious) {
          previousRecord = await getNodeAttributeRecord(nodeId, key);
          readPrevious = true;
          if (opts.value_type === undefined && previousRecord) metadata.value_type = previousRecord.value_type;
          if (opts.is_inheritable === undefined && previousRecord) metadata.is_inheritable = previousRecord.is_inheritable;
        }
        const node = nodeOf(ctx.data, nodeId);
        const current = node ? node.attrs?.[key] : desired;
        if (current === undefined) await removeAttribute(nodeId, key);
        else {
          const meta = current === value ? metadata : previousRecord ?? metadata;
          await upsertAttribute(nodeId, key, current, meta.value_type, meta.is_inheritable, meta.source);
        }
      },
      accepted: (result) => {
        // The server stores the type its rule decides (a schema field's own),
        // not necessarily the hint sent: the local copy takes the stored one.
        const stored = result.status === "synced" ? result.value?.value_type : undefined;
        if (typeof stored === "string") metadata.value_type = stored;
        const storedFlag = result.status === "synced" ? result.value?.is_inheritable : undefined;
        if (typeof storedFlag === "boolean") metadata.is_inheritable = storedFlag;
        settle(true);
      },
      unconfirmed: () => { settle(true); },
      rejected: () => {
        const { expected, replacement } = settle(false);
        if (!Object.hasOwn(replacement, key)) return;
        desired = replacement[key] ?? (!nodeWasLoaded ? previousRecord?.value : undefined);
        ctx.setData((state) => {
          if (state.nodes.find((node) => node.id === nodeId)?.attrs?.[key] !== expected[key]) return state;
          return desired === undefined ? dropNodeAttr(state, nodeId, key) : setNodeAttr(state, nodeId, key, desired);
        });
      },
    });
  }

  /** The inbox's Revert on an attribute conflict (ATTRIBUTE_CONFLICT event
   *  `eventId` on `nodeId`'s `key`). The server decides the value — a
   *  drawing's conflicting items merged into the drawing as it is now, any
   *  other key its overridden value with its own type — so this needs a
   *  connection and is never queued. True once the server accepted it (the
   *  local copy then holds what it stored); false when it was refused or
   *  could not be sent, which is already reported (an attribute edited since
   *  the conflict is refused and keeps that edit). */
  async function revertConflict(eventId: number, nodeId: string, key: string): Promise<boolean> {
    try {
      await onlineOperation(`node:${nodeId}`, t("Reverting a conflict needs a connection."), async (submit) => {
        const saved = await submit<NodeAttribute>(`/api/events/${eventId}/revert-conflict`);
        if ("deduped" in saved) return; // applied by an earlier attempt; sync brings the value
        try {
          // A drawing is not kept in the note list's attributes (lib/data/inkWriter).
          if (!isInkPageAttr(key)) ctx.setData((state) => setNodeAttr(state, nodeId, key, saved.value));
          await upsertAttribute(nodeId, key, saved.value, saved.value_type, saved.is_inheritable, saved.source);
        } catch { ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error"); }
      });
      return true;
    } catch { return false; }
  }

  return {
    set: (nodeId: string, key: string, value: string, opts?: PropertyOptions) => change(nodeId, key, value, opts),
    remove: (nodeId: string, key: string) => change(nodeId, key, undefined),
    revertConflict,
  };
}
