// Moving a whole workspace (services/backupRestore.ts, mode "workspace"): the
// backup of one workspace restored into another that is new, so the target ends
// up holding what the source held and nothing else.
//
// Who and where. Only the workspace owner, and only into a NEW workspace — see
// inspectTargetWorkspace for the exact meaning of "new".
//
// What happens, in the order the restore does it (backupRestore.ts calls these):
//   1. the target's own sample notes and sample tags go to the trash (they are
//      the target's, not the person's: the browser app's first-open samples);
//   2. the spaces of the backup are made again — name and kind. Its personal
//      space is the target's personal space. Members are NOT rebuilt: a shared
//      space has only its owner afterwards, and the result lists the spaces that
//      had other people so the owner can invite them again;
//   3. notes go back into their own spaces (the restore's job);
//   4. the extras (backupExtras.ts importExtras): review progress, focus records,
//      subscriptions, personal and module settings, module switches, the site.
//
// Not moved, said in the result: version history and the operation log, AI keys,
// push subscriptions, feed reading progress, block-level review progress.

import { sql } from "kysely";
import { SPACE_NAME_MAX, cutToUnits } from "@onden/markdown";
import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import type { ActorCtx } from "../types.js";
import { isWorkspaceOwner } from "../spine/authority.js";
import { createSharedSpace, isCapabilityKey, updateSpace, type CapabilityKey } from "./spaces.js";
import type { BackupReader } from "./backupFile.js";
import { BackupRestoreRefusal } from "./backupFile.js";
import type { BackupExtras } from "./backupExtras.js";
import type { BackupHistoryInfo, RestoreMovePreview } from "@onden/contract";
import { isTag } from "@onden/markdown/contract";

/** Tags every database starts with (browser/sampleNotes.ts UNUSED_SEED_TAG_NAMES): not the person's own. */
const SEED_TAG_NAMES = new Set(["admin-only", "archive", "book", "meeting", "person", "project"]);

export type TargetFacts = {
  /** Sample notes / tags of the target that the move clears. */
  builtinNoteIds: string[];
  builtinTagIds: string[];
  /** Empty shared spaces already there, by name (a move reuses them). */
  emptySharedSpaces: Map<string, string>;
  /** The empty default shared space, which the backup's default space becomes. */
  defaultSpaceId: string | null;
};

/** The sample notes and tags the browser app made on its first open. A server has no such record. */
async function sampleRegistry(): Promise<{ notes: Set<string>; tags: Set<string> }> {
  const exists = (await sql<{ found: string | null }>`SELECT to_regclass('browser_app_state')::text AS found`.execute(db)).rows[0]?.found;
  if (!exists) return { notes: new Set(), tags: new Set() };
  const row = (await sql<{ value: { notes?: string[]; tags?: string[] } }>`SELECT value FROM browser_app_state WHERE key = 'sample-notes'`.execute(db)).rows[0];
  return { notes: new Set(row?.value.notes ?? []), tags: new Set(row?.value.tags ?? []) };
}

/** Whether `workspaceId` is a new workspace the owner `actor` may move into.
 *
 *  New means all of:
 *    * `actor` is the workspace owner (a delegated token never is);
 *    * no other human is in the workspace (an invited, not yet joined, person counts);
 *    * the only live space with anything in it is `personalSpaceId`, the owner's
 *      personal space; other live spaces are shared, hold only the owner and no notes;
 *    * no note, live or in the trash, except system rows (the Site Config note)
 *      and the browser app's sample notes;
 *    * no live tag of the owner's own: tags are the system's (a reserved tag or a
 *      module's), the six seed tags, or the samples'.
 *  Returns what the move clears and reuses, or says which of the two refusals. */
export async function inspectTargetWorkspace(
  actor: ActorCtx, workspaceId: string, personalSpaceId: string,
): Promise<{ refusal: null; facts: TargetFacts } | { refusal: "not_workspace_owner" | "workspace_not_new"; facts: null }> {
  if (!await isWorkspaceOwner(actor)) return { refusal: "not_workspace_owner", facts: null };
  const others = await db.selectFrom("actors").select("id").where("workspace_id", "=", workspaceId).where("type", "=", "human").where("id", "<>", actor.id).limit(1).execute();
  const notNew = (why: string) => { log.info("backup", "a workspace move was refused: the workspace is not new", { why }); return { refusal: "workspace_not_new" as const, facts: null }; };
  if (others.length) return notNew("another person is in the workspace");

  const samples = await sampleRegistry();
  const registered = new Set(samples.notes);
  const notes = await db.selectFrom("content_nodes").select(["id", "parent_id", "node_type", "title", "reserved_key", "tag_schema", "deleted_at", "source_type", "space_id"])
    .where("workspace_id", "=", workspaceId).execute();
  // What a sample note made of itself (the tasks its checkbox lines became) is a sample too.
  for (let grew = true; grew;) {
    grew = false;
    for (const n of notes) if (n.parent_id && samples.notes.has(n.parent_id) && !samples.notes.has(n.id)) { samples.notes.add(n.id); grew = true; }
  }
  const ownNote = (n: (typeof notes)[number]) => !isTag(n) && n.source_type !== "system" && !samples.notes.has(n.id);
  const ownNoteFound = notes.find(ownNote);
  if (ownNoteFound) return notNew(`a note of its own: ${ownNoteFound.title} (${ownNoteFound.source_type}, ${ownNoteFound.deleted_at ? "deleted" : "live"})`);
  const ownTag = (n: (typeof notes)[number]) => isTag(n) && !n.deleted_at && !n.reserved_key
    && !(n.tag_schema as { module?: unknown } | null)?.module && !SEED_TAG_NAMES.has(n.title) && !samples.tags.has(n.id);
  const ownTagFound = notes.find(ownTag);
  if (ownTagFound) return notNew(`a tag of its own: ${ownTagFound.title}`);

  const spaces = await db.selectFrom("spaces").select(["id", "name", "kind", "is_default"]).where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).execute();
  const emptySharedSpaces = new Map<string, string>();
  let defaultSpaceId: string | null = null;
  for (const space of spaces) {
    if (space.id === personalSpaceId) continue;
    // The workspace's own System actor is in the default space from the start; it is nobody's person.
    const members = await db.selectFrom("space_members as m").innerJoin("actors as a", "a.id", "m.actor_id").select("m.actor_id")
      .where("m.space_id", "=", space.id).where("m.actor_id", "<>", actor.id).where((eb) => eb.or([eb("a.external_id", "is", null), eb("a.external_id", "<>", "system")])).limit(1).execute();
    if (members.length || space.kind === "personal") return notNew(`a space with other people: ${space.name}`);
    if (space.kind === "shared") { emptySharedSpaces.set(space.name, space.id); if (space.is_default) defaultSpaceId = space.id; }
  }
  return {
    refusal: null,
    facts: {
      builtinNoteIds: notes.filter((n) => !isTag(n) && !n.deleted_at && registered.has(n.id)).map((n) => n.id),
      builtinTagIds: notes.filter((n) => isTag(n) && !n.deleted_at && samples.tags.has(n.id)).map((n) => n.id),
      emptySharedSpaces, defaultSpaceId,
    },
  };
}

/** The refusal a move into a workspace that does not fit throws. */
export async function assertNewWorkspace(actor: ActorCtx, workspaceId: string, personalSpaceId: string): Promise<TargetFacts> {
  const found = await inspectTargetWorkspace(actor, workspaceId, personalSpaceId);
  if (found.refusal === "not_workspace_owner") throw new BackupRestoreRefusal("not_workspace_owner", 403);
  if (found.refusal === "workspace_not_new") throw new BackupRestoreRefusal("workspace_not_new", 409);
  return found.facts!;
}

export type MovedSpaces = {
  /** Backup space id → space here. */
  map: Map<string, string>;
  created: number;
  /** Names of shared spaces that had other people: they must be invited again. */
  needReinvite: string[];
};

/** Make the spaces of the backup here. Inside the restore's first transaction. */
export async function rebuildSpaces(
  authenticated: ActorCtx, workspaceId: string, reader: BackupReader, personalSpaceId: string, facts: TargetFacts,
): Promise<MovedSpaces> {
  const map = new Map<string, string>();
  const needReinvite: string[] = [];
  let created = 0;
  const used = new Set<string>();
  for (const space of reader.spaces) {
    if (space.kind !== "shared") { map.set(space.id, personalSpaceId); continue; }
    const name = cutToUnits(space.name || "未命名", SPACE_NAME_MAX);
    const reuse = (space.is_default ? facts.defaultSpaceId : null) ?? facts.emptySharedSpaces.get(name);
    let id: string;
    if (reuse && !used.has(reuse)) id = reuse;
    else { id = (await createSharedSpace(authenticated, workspaceId, name)).id; created++; }
    used.add(id);
    const capabilities = Object.fromEntries(Object.entries(space.capabilities ?? {}).filter(([key, on]) => isCapabilityKey(key) && typeof on === "boolean")) as Partial<Record<CapabilityKey, boolean>>;
    if (Object.keys(capabilities).length) await updateSpace(authenticated, workspaceId, id, { capabilities });
    map.set(space.id, id);
    if ((space.members ?? []).some((m) => m.id !== reader.manifest.created_by.id)) needReinvite.push(name);
  }
  return { map, created, needReinvite };
}

export const NOT_MOVED = ["history", "ai_keys", "push", "feed_progress", "block_review"] as const;

/** What a move leaves behind: the same list, except that version history is not on it when the backup carries it (the
 *  operation log is never carried: its events are not all rebuildable, and undoing them would reach old content). */
export const notMovedFor = (carriesHistory: boolean): string[] =>
  carriesHistory ? ["operation_log", ...NOT_MOVED.filter((item) => item !== "history")] : [...NOT_MOVED];

/** `history`: what the backup's history files hold, counted from the files (reader.countHistory), not the manifest's claim. */
export function movePreview(reader: BackupReader, noteSpaces: Map<string, number>, facts: TargetFacts | null, history: BackupHistoryInfo | null): RestoreMovePreview {
  const extras: BackupExtras | null = reader.extras;
  const owner = reader.manifest.created_by.id;
  return {
    spaces: reader.spaces.map((s) => ({
      name: s.name, kind: s.kind === "shared" ? "shared" as const : "personal" as const,
      notes: noteSpaces.get(s.id) ?? 0, had_others: (s.members ?? []).some((m) => m.id !== owner),
    })),
    carries: ([
      { kind: "progress", count: extras?.review.length ?? 0 },
      { kind: "focus_records", count: extras?.focus.length ?? 0 },
      { kind: "feeds", count: extras?.rss.length ?? 0 },
      { kind: "settings", count: (extras?.prefs.length ?? 0) + (extras?.moduleSettings.length ?? 0) },
      { kind: "features", count: extras?.modules ? 1 : 0 },
      { kind: "site", count: extras?.site ? 1 : 0 },
    ] as const).filter((item) => item.count > 0).map((item) => ({ ...item })),
    clears: { notes: facts?.builtinNoteIds.length ?? 0, tags: facts?.builtinTagIds.length ?? 0 },
    history,
    not_moved: notMovedFor(history !== null),
  };
}
