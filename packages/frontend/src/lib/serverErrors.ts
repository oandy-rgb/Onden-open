// What the user reads when the server refuses a request. The server answers
// { error: <code>, detail?: <English sentence> }; the code is the stable part.
// Keying translations on the English detail alone meant a reworded server
// message silently fell back to English. Now:
//   1. a detail this locale has wording for (it adds precision: which field,
//      which space) is shown translated;
//   2. otherwise a known code gets its own message;
//   3. any "<thing> not found" is the not-found message;
//   4. anything else is the generic server message: an unmapped code, a body
//      with neither code nor detail, or a non-JSON body (a proxy's HTML page)
//      is never shown as it came.
// Branch on ApiError.status / .code in code, never on this text.

import { dictionariesReady, hasTranslation, t } from "./i18n";
import { DERIVED_ARROW_HINT } from "./edgeRoles";

/** Stable server error codes → English source text (translated via t): the ones the
 *  boot JS words itself, because code names them or the shell shows them at once. The
 *  rarer codes are in serverSentences.ts (LATE_SERVER_ERROR_MESSAGES), fetched on first
 *  use; isKnownServerCode() asks both. ApiError.message reads them, and so does
 *  lib/data/writeErrors.ts (which only decides retry vs refusal). test/serverErrors.test.ts
 *  checks that every code the backend sends has an entry in one of the two. */
export const SERVER_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "Please sign in again.",
  forbidden: "You don't have permission to do that.",
  not_found: "It no longer exists, or you can't see it.",
  module_not_imported: "This feature is off in this workspace.",
  field_name_inherited: "A tag above already has a field with this name. Rename it first.",
  rate_limited: "Too many requests. Try again in a moment.",
  workspace_busy: "Other changes are being saved right now. Yours will be tried again automatically in a moment.",
  workspace_joining: "This workspace is being filled from another device right now. Try again when that has finished.",
  client_too_old: "This screen is an old version. Reload it before you edit; what you just typed is still here.",
  server_too_old: "This server needs to be updated before your changes can be sent. They are kept on this device and will be sent once it is.",
  internal: "Something went wrong on the server.",
  selection_changed: "The text changed since you selected it. Select it again.",
  selection_not_unique: "This text appears more than once in the note. Select a little more so it is clear which one you mean.",
  references_unwritable: "Some notes that link here can't be edited by you.",
  parent_kind_mismatch: "A note can't go under a tag, and a tag only goes under another tag: tags and notes are kept in separate trees.",
  reserved_tag: "System tag — it can be renamed but not merged or deleted.",
  module_tag: "This tag belongs to a built-in function. It can be renamed, but not deleted or merged while that function is on.",
  imported_history: "This version came from a backup or a workspace move and can't be undone as a change. Open the note's version list and restore that version instead.",
  pages_version: "The pages of this note were changed by a newer version of Onden. Update the app before changing them; your change was not saved.",
  history_incomplete: "The history needed to undo this is no longer available.",
  irreversible: "This kind of change can't be undone.",
  external: "This change reached outside Onden, so it can't be undone from here.",
  unsupported: "This kind of change can't be undone.",
  // The page stays bound to the account it opened with (lib/accountStorage.ts):
  // its queued writes are kept and replay only as that account, so signing
  // back in is what recovers them; a reload switches the page to the new one.
  account_changed: "You are now signed in as a different account (or to another server) than this page. Sign back in to the original account to keep working here; its unsent changes wait until then. To switch accounts, reload the page.",
  membership_removed: "You were removed from this workspace. Ask the owner to add you again.",
  preview_stale: "The site changed after the preview. Check the new preview, then publish.",
  patch_base_unknown: "This change could not be matched with the saved note. It will be sent again in full.",
  design_stale: "The site design changed in another tab or on another device. The latest design is shown; your last change was not saved.",
  derived_edge: DERIVED_ARROW_HINT,
  // The note size caps (@onden/markdown noteLimits.ts); lib/data/noteWriter.ts
  // shows the same words when it refuses a write before queueing it.
  too_large: "This note is over the 2,000,000-character limit and can't be saved. Split it or shorten it.",
  title_too_long: "A note title can't be longer than 500 characters.",
  contains_nul: "The text contains a character that can't be saved (U+0000). Remove it and try again.",
  invalid_text: "The text contains a broken character that can't be saved. Remove it and try again.",
  target_not_empty: "This space already has notes. Choose an empty space, or merge.",
  restore_failed: "The restore failed. Nothing was restored.",
  already_restored: "This backup was already restored.",
  interrupted: "The restore was interrupted by a server restart. Nothing was restored.",
  // Spaces (backend services/spaces.ts, nodeUpdate.ts, nodeTree.ts).
  parent_in_other_space: "That note is in another space. Move this note to that space first, or pick a parent in this space.",
  deleted_notes: "Choose what happens to the deleted notes in this space.",
  plan_changed: "What would be deleted changed since you looked. Check again.",
  // The note and tag trees (services/nodeTree.ts, routes/nodes.ts, tagMerge.ts).
  parent_cycle: "A note can't go under one of its own sub-notes.",
  parent_not_found: "The parent note no longer exists, or you can't see it.",
  note_exists: "This note already exists.",
  feed_too_large: "The feed is too large to read.",
  credential_rejected: "The service did not accept this key.",
  protocol_undetected: "Onden could not tell which format this service speaks. Choose one.",
  api_unreachable: "Couldn't reach the AI service. Try again later.",
  agent_disabled: "This AI helper is switched off.",
  not_agents_owner: "Only this AI helper's owner can send it requests.",
  agent_cannot_write: "This AI helper can't write in this note's space.",
  space_unavailable: "The AI helper can no longer write in this note's space.",
  cannot_read_note: "You can't read this note.",
  file_too_large: "The file is larger than the upload limit.",
  gone: "This version of the app is out of date. Reload the page.",
};

const NOT_FOUND = /^[a-z][a-z ]* not found$/;

// The sentence-keyed wording (lib/serverSentences.ts) is fetched the first time
// a refusal arrives that no code names; until then, or if it can't be fetched,
// such a refusal reads as the generic server message.
type Sentences = typeof import("./serverSentences");
let sentences: Sentences | null = null;

/** Load the on-demand wording when `rawBody` is a refusal only it can word.
 *  Await it before building the ApiError, so the message is right at once. Never rejects. */
export async function ensureSentenceWording(rawBody: string): Promise<void> {
  if (sentences) return;
  let code: unknown;
  try { code = (JSON.parse(rawBody) as { error?: unknown }).error; } catch { return; }
  return ensureWordingFor(code);
}

/** The same for a code that did not come in an HTTP refusal (a restore job's `error`):
 *  await it before `serverErrorMessage(code)`. Never rejects. */
export async function ensureWordingFor(code: unknown): Promise<void> {
  if (sentences) return;
  if (typeof code !== "string" || Object.hasOwn(SERVER_ERROR_MESSAGES, code) || NOT_FOUND.test(code)) return;
  try {
    const [mod] = await Promise.all([import("./serverSentences"), dictionariesReady()]);
    sentences = mod;
  } catch { /* offline: the generic message stays; the next refusal tries again */ }
}

/** Whether the server's `code` has wording of its own (once the late table is loaded:
 *  an ApiError from readErrorBody always has it by then). */
export function isKnownServerCode(code: string | undefined): boolean {
  return !!code && (!!SERVER_ERROR_MESSAGES[code] || !!sentences?.lateCodeMessage(code));
}

export function serverErrorMessage(code: string | undefined, detail: string | undefined): string {
  if (detail && hasTranslation(detail)) return t(detail);
  if (code && SERVER_ERROR_MESSAGES[code]) return t(SERVER_ERROR_MESSAGES[code]);
  if (code && NOT_FOUND.test(code)) return hasTranslation(code) ? t(code) : t(SERVER_ERROR_MESSAGES.not_found);
  const sentence = code ? sentences?.lateCodeMessage(code) ?? sentences?.sentenceRefusalMessage(code) : null;
  if (sentence) return t(sentence);
  return t(SERVER_ERROR_MESSAGES.internal!);
}

/** A same-name field refusal (409 field_name_inherited): which tag already
 *  gives which field, and which tag declares it too. */
export function fieldClashMessage(clashes: unknown): string | null {
  if (!Array.isArray(clashes) || !clashes.length) return null;
  return clashes.slice(0, 3).map((c: { field?: string; tag_title?: string; from_title?: string }) =>
    t("#{from} already has the field \"{field}\", which #{tag} declares too — rename one of them first", {
      from: c.from_title ?? "", field: c.field ?? "", tag: c.tag_title ?? "",
    })).join("\n");
}
