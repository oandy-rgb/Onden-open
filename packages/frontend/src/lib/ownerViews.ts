import { useCallback, useEffect, useSyncExternalStore } from "react";
import { reads, type ViewOwner } from "./data";
import { useLiveRefetch } from "./liveInvalidation";

// The saved views of one owner (a tag's, or a note's), read once and shared by
// everything that shows them: the tab row above the page and the pane that
// shows the open tab are different components, and both must see the same
// list after a rename, a reorder or a delete. A change is written through
// lib/data's viewWriter and then re-read here (reloadOwnerViews).

/** A view module's id (modules/index VIEW_MODULES) or "canvas", the whiteboard tab. */
export type StoredViewLayout = string;

export interface SavedView {
  id: string;
  tag_id: string;
  name: string;
  layout: StoredViewLayout;
  filters: unknown[];
  sorts: unknown[];
  group_by: string | null;
  visible_fields: string[];
  layout_config: Record<string, unknown>;
  /** The place among the tabs (lowest first); the server breaks ties by name. */
  pin_order: number;
  /** A view this tag inherits from a parent tag (rule 5): the id and name of
   *  the tag it belongs to. It shows this tag's notes, read only; 「複製成自己的」
   *  makes an editable copy. */
  inherited_from?: string;
  inherited_name?: string;
}

export type OwnerViewsStatus = "loading" | "ready" | "failed";
/** `contentRemovable` is the server's answer to "may this note's 「內容」 tab be removed" (another tab shows); the page only reads it. */
export type OwnerViewsState = { views: SavedView[]; status: OwnerViewsStatus; contentRemovable: boolean };

const LOADING: OwnerViewsState = { views: [], status: "loading", contentRemovable: false };
const states = new Map<string, OwnerViewsState>();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();

const keyOf = (owner: ViewOwner) => `${owner.kind}:${owner.id}`;
const emit = () => listeners.forEach((listener) => listener());

function put(key: string, next: OwnerViewsState) {
  states.set(key, next);
  emit();
}

/** Read the owner's views again. One read at a time per owner; a request made
 *  while one is running waits for that one (its answer is at least as new as
 *  the request). A failed read keeps the views already shown. */
export function reloadOwnerViews(owner: ViewOwner): Promise<void> {
  const key = keyOf(owner);
  const running = inFlight.get(key);
  if (running) return running;
  const read = (async () => {
    try {
      // A reply without a list must not take the page down.
      const reply = await reads.views.list<SavedView>(owner);
      // The list layout was removed (migration 111 made stored ones tables);
      // one restored from an older event still shows as a table.
      const views = (Array.isArray(reply?.views) ? reply.views : [])
        .map((view) => (view.layout as string) === "list" ? { ...view, layout: "table" as const } : view);
      put(key, { views, status: "ready", contentRemovable: reply?.content_tab_removable === true });
    } catch {
      put(key, { ...(states.get(key) ?? LOADING), status: "failed" });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, read);
  return read;
}

/** The views last read for the owner, without subscribing: for a decision made
 *  outside rendering (which board a page opens). Empty until first read. */
export function peekOwnerViews(owner: ViewOwner): readonly SavedView[] {
  return states.get(keyOf(owner))?.views ?? [];
}

/** Forget everything read (tests, and a switch of account). */
export function resetOwnerViews(): void {
  states.clear();
  inFlight.clear();
  emit();
}

/** The owner's views, loaded when first asked for and again when someone
 *  else changes them. `owner` null (nothing to show views of) reads nothing. */
export function useOwnerViews(owner: ViewOwner | null): OwnerViewsState & { reload: () => Promise<void> } {
  const ownerKind = owner?.kind;
  const ownerId = owner?.id;
  const key = owner ? keyOf(owner) : null;
  const state = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (key ? states.get(key) ?? LOADING : LOADING),
  );
  const reload = useCallback(
    () => (ownerKind && ownerId ? reloadOwnerViews({ kind: ownerKind, id: ownerId }) : Promise.resolve()),
    [ownerKind, ownerId],
  );
  useEffect(() => { if (key) void reload(); }, [key, reload]);
  // Someone else's change (another device, a teammate, an agent) re-reads the list.
  useLiveRefetch("changed", () => (key ? reload() : undefined), { collapseEcho: true, onVisible: true });
  return { ...state, reload };
}
