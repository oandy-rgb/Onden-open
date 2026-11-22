// Spaces on the client (docs/architecture/spaces.md).
//
// Every note lives in one space; the space's members decide who can read and
// write it. This module fetches the caller's spaces once (and again after a
// change), and wraps the space and move endpoints.
//
// The list is also kept in this account's local copy (lib/data localCopy.spaces,
// the same database as the notes' offline copy): every server answer is written
// there, and a start reads it back first (restoreSpaces, from the boot), so the
// personal space is known offline and before the server answers. "Not known"
// is left only for a device that has never heard the server (new device,
// cleared data, a copy whose schema version changed). Callers that would
// write somewhere on the strength of the personal space — today's note, the
// 任務 note, quick-add — refuse then instead of guessing (lib/data/dayNotes.ts).

import { useEffect, useSyncExternalStore } from "react";

import { t } from "./i18n";
import { localCopy, reads, spaceWriter } from "./data";
import type { MovePreview, SpaceCapability, SpaceDeletePreview, SpaceKind, SpaceOverview, SpacePermission } from "@onden/contract";

/** 可看 / 可編輯 (backend spine/spaceAccess.ts SPACE_PERMISSIONS). No row = not in the space. */
export type Space = {
  id: string;
  name: string;
  kind: SpaceKind;
  is_default: boolean;
  owner_actor_id: string | null;
  capabilities: Partial<Record<SpaceCapability, boolean>>;
  /** My permission here; null for a shared space the owner manages without being in it. */
  permission: SpacePermission | null;
  /** I may change this space's members and switches (the owner; a person in their own personal space). */
  can_manage: boolean;
};
export type SpaceMember = { id: string; name: string; type: "human" | "agent"; permission: SpacePermission };
/** MovePreview as the app holds it: the wire sends the epoch as a digit string
 *  (a Postgres bigint); spaceApi.previewMove turns it into a number, like the sync delta's. */
export type MovePreviewNumericEpoch = Omit<MovePreview, "membership_epoch"> & { membership_epoch: number };

// The owner flag is not kept here: lib/capabilities.ts reads it from the
// bootstrap (actor_is_owner), the one source.
/** `loaded`: the list is known — the server's answer, or the copy of it this
 *  device kept (restoreSpaces). False only before either is in. */
type State = { spaces: Space[]; loaded: boolean };
let state: State = { spaces: [], loaded: false };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
/** The server answered the spaces request on this page (not only the kept copy). */
let heardServer = false;

function publish(next: State): void {
  state = next;
  for (const l of listeners) l();
}

/** (Re)load the caller's spaces and keep the answer in the local copy.
 *  Failures keep the last list. */
export function refreshSpaces(): Promise<void> {
  inFlight ??= reads.people.spaces<Space>()
    .then((r) => {
      if (!Array.isArray(r?.spaces)) return;
      heardServer = true;
      publish({ spaces: r.spaces, loaded: true });
      // No local copy (memory-only device) or a failed save: the next start asks the server again.
      void localCopy.keepSpaces(r.spaces).catch(() => {});
    })
    .catch(() => { /* offline or older server: keep what we have */ })
    .finally(() => { inFlight = null; });
  return inFlight;
}

const isSpaceRow = (row: unknown): row is Space => typeof row === "object" && row !== null
  && typeof (row as Space).id === "string" && typeof (row as Space).kind === "string";

/** Take the list this device kept with its local copy, unless the server has
 *  already answered on this page. The boot awaits it before the first paint
 *  (lib/data/syncEngine runBoot). Nothing kept, or no local copy: stays unknown. */
export async function restoreSpaces(): Promise<void> {
  if (state.loaded) return;
  let kept: unknown[] | null = null;
  try { kept = await localCopy.spaces(); } catch { /* no copy, or it cannot be read: unknown, as on a new device */ }
  if (state.loaded || !Array.isArray(kept) || !kept.every(isSpaceRow)) return;
  publish({ spaces: kept, loaded: true });
}

/** Whether the server has answered the spaces request on this page (the list
 *  may still be known from the kept copy without it). */
export function spacesHeardFromServer(): boolean {
  return heardServer;
}

let seenEpoch: number | undefined;
/** The membership epoch from a sync: when it moves (someone was added to or
 *  removed from a space, a space changed its switches), reload the spaces so
 *  the chips, read-only state and Settings follow without a page reload. */
export function noteMembershipEpoch(epoch: number | undefined): void {
  if (epoch === undefined || epoch === seenEpoch) return;
  const first = seenEpoch === undefined;
  seenEpoch = epoch;
  if (!first && state.loaded) void refreshSpaces();
}

/** The caller's personal space id, once the spaces are known — from the server
 *  or this device's kept copy (else null: a device that never heard the server). */
export function personalSpaceId(): string | null {
  return state.spaces.find((space) => space.kind === "personal")?.id ?? null;
}

/** The caller's spaces as last known (empty until restoreSpaces or refreshSpaces fills them). */
export function loadedSpaces(): readonly Space[] {
  return state.spaces;
}

/** For tests: forget the cached list. */
export function resetSpacesForTest(): void {
  state = { spaces: [], loaded: false };
  inFlight = null;
  seenEpoch = undefined;
  heardServer = false;
}

/** The caller's spaces; loads them the first time, and when `online` turns on. */
export function useSpaces(online: boolean): State {
  const snapshot = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
  );
  useEffect(() => { if (online) void refreshSpaces(); }, [online]);
  return snapshot;
}

/** How a space is named to people: a personal space is "Only me", the
 *  default shared space is "Everyone"; others by their own name. */
export function spaceLabel(space: Pick<Space, "kind" | "is_default" | "name">): string {
  if (space.kind === "personal") return t("Only me");
  if (space.is_default) return t("Everyone");
  return space.name;
}

export const spaceApi = {
  create: (...args: Parameters<typeof spaceWriter.create>) => spaceWriter.create(...args),
  update: (...args: Parameters<typeof spaceWriter.update>) => spaceWriter.update(...args),
  deletePreview: (id: string) => reads.people.spaceDeletePreview<SpaceDeletePreview>(id),
  /** `expectedDeletedIds`: SpaceDeletePreview.deleted_ids, required for
   *  "purge" — the server refuses (409 plan_changed) if they changed since. */
  remove: (...args: Parameters<typeof spaceWriter.remove>) => spaceWriter.remove(...args),
  members: (id: string) => reads.people.spaceMembers<SpaceMember>(id).then((r) => r.members),
  /** `null` takes the person out of the space. */
  setMember: (...args: Parameters<typeof spaceWriter.setMember>) => spaceWriter.setMember(...args),
  overview: () => reads.people.spaceOverview<SpaceOverview>(),
  previewMove: (nodeId: string, toSpaceId: string) =>
    reads.people.moveToSpacePreview<MovePreview>(nodeId, toSpaceId)
      .then((preview): MovePreviewNumericEpoch => ({ ...preview, membership_epoch: Number(preview.membership_epoch) })),
  move: (...args: Parameters<typeof spaceWriter.moveNote>) => spaceWriter.moveNote(...args),
};
