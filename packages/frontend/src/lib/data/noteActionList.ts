// Which actions a note offers, decided in ONE place (D112). Every surface that
// lists a note's actions renders from noteActionList: the context menu
// (sidebar and board cards), the header ⋯ menu (NoteActions), the ⌘K
// palette's note commands and the sidebar rows' delete buttons. Before, each
// surface decided on its own: a viewer saw Delete in the sidebar (optimistic
// remove → 403 → rollback), ⌘K offered a board-only command on a text note
// (the server answered "No such board") and server-only commands offline.
//
// The rules follow the server: an action that writes the note is offered only
// to who may edit it (lib/capabilities canEdit — for a tag, the owner); a
// reserved tag or a system row is never deleted (409 reserved_tag); a module
// command is offered where its `available` says it applies. Duplicate stays
// for viewers: the server only needs read access to the source and a space to
// write the copy (backend noteDuplicate.ts).
//
// Pure: the surfaces build `ctx` from the store, the handlers stay theirs.
// `handler` names which one to run (the action id, or "module" for a module
// command, whose `command` rides along).

import type { ContentNode, Tag } from "../api";
import { isTagShown } from "../nodeTags";
import { isPinned } from "../noteMarks";
import { isSystemNode, tagsById } from "../systemNodes";
import { TAG_NODE_TYPE, isNote } from "@onden/markdown/contract";

/** A module's note command, as far as availability goes (modules/types
 *  NoteCommand). */
export type NoteActionCommand = {
  id: string;
  label: string;
  available?: (node: ContentNode, body: string, env: { online: boolean }) => boolean;
};

export type NoteActionContext<C extends NoteActionCommand = NoteActionCommand> = {
  /** This person may write the note (lib/capabilities canEdit). */
  canEdit: boolean;
  /** The workspace owner. */
  isOwner?: boolean;
  online: boolean;
  /** A reserved tag (#task, #page, #workspace-config): never deleted. */
  reserved?: boolean;
  /** A system row (lib/systemNodes isSystemNode): nothing destructive. */
  system?: boolean;
  /** The note carries the pin mark (lib/noteMarks isPinned). */
  pinned?: boolean;
  /** A tag hidden from lists (lib/nodeTags isTagShown is false). */
  tagHidden?: boolean;
  /** The note has saved versions to compare. */
  hasVersions?: boolean;
  /** The live body (the open draft, else the saved markdown), for the module
   *  commands' `available`. */
  body?: string;
  /** The imported modules' note commands (modules NOTE_COMMANDS). */
  commands?: readonly C[];
};

export type NoteActionId =
  | "open" | "rename" | "duplicate" | "new-inside" | "move" | "toggle-tag-hidden"
  | "toggle-pin" | "set-color" | "version-history"
  | "copy-markdown" | "export" | "display" | "text-style" | "delete";

export type NoteAction<C extends NoteActionCommand = NoteActionCommand> = {
  /** The action id, or the module command's id. */
  id: string;
  /** i18n key for menus. */
  label: string;
  /** i18n key for the ⌘K palette, when it reads longer than the menu's. */
  paletteLabel?: string;
  visible: boolean;
  enabled: boolean;
  /** Which of the surface's handlers runs it. */
  handler: NoteActionId | "module";
  /** The module command, for handler "module". */
  command?: C;
};

/** The ⌘K palette's labels (i18n keys) for the note actions it lists; the
 *  palette builds its rows before a note is chosen, so it reads them here. */
export const NOTE_ACTION_PALETTE_LABELS = {
  "toggle-pin": "Pin or unpin this note",
  "set-color": "Set this note's color…",
} as const satisfies Partial<Record<NoteActionId, string>>;

/** What the note's ⋯ menu shows, from the list below: the few things people do
 *  to the note as a whole. The rest stay in the list for the sidebar's
 *  context menu and the ⌘K palette (and the editor's own `/` menu, the info
 *  panel's 「功能」 section): a ⋯ that holds everything is a ⋯ nobody scans. */
export const NOTE_HEADER_ACTIONS: readonly NoteActionId[] = ["version-history", "duplicate", "copy-markdown", "export", "display", "text-style", "delete"];

export function noteActionList<C extends NoteActionCommand>(
  node: Pick<ContentNode, "id" | "node_type" | "parent_id"> & Partial<ContentNode>,
  ctx: NoteActionContext<C>,
): NoteAction<C>[] {
  const isTag = node.node_type === TAG_NODE_TYPE;
  const edit = ctx.canEdit;
  const action = (handler: NoteActionId, label: string, visible: boolean, paletteLabel?: string): NoteAction<C> =>
    ({ id: handler, label, visible, enabled: visible, handler, ...(paletteLabel ? { paletteLabel } : {}) });
  const body = ctx.body ?? node.markdown ?? "";
  return [
    action("open", "Open note", true),
    action("rename", "Rename", edit),
    action("duplicate", "Duplicate", isNote(node)),
    // The note tree only: a tag is never moved under a note, nor a note made inside a tag.
    action("new-inside", "New inside", edit && !isTag),
    // Moving to a place — another parent, the top level (what "remove from
    // parent" was), another space — is one picker (components/MoveToDialog).
    action("move", "Move to…", edit && !isTag),
    // Only a tag can be hidden — never a reserved tag — by who may edit tags (D104).
    action("toggle-tag-hidden", ctx.tagHidden ? "Unhide tag" : "Hide tag", edit && isTag && !ctx.reserved),
    action("toggle-pin", ctx.pinned ? "Unpin" : "Pin", edit),
    action("set-color", "Set color", edit),
    ...(ctx.commands ?? []).map((command): NoteAction<C> => {
      const visible = command.available?.(node as ContentNode, body, { online: ctx.online }) ?? true;
      return { id: command.id, label: command.label, visible, enabled: visible, handler: "module", command };
    }),
    action("version-history", "History of this note", !!ctx.hasVersions),
    action("copy-markdown", "Copy this note as Markdown", true),
    action("export", "Export as", true),
    // How the open note is shown (width, side-by-side, writing mode, its views): only
    // the note's own ⋯ menu has the editor to ask, so no other surface renders it.
    action("display", "Display…", isNote(node)),
    // The font, text size and width of notes (a sheet over the note; Settings › Notes has the same).
    action("text-style", "Text style…", isNote(node)),
    action("delete", "Delete", edit && !ctx.reserved && !ctx.system),
  ];
}

/** What a surface knows from the store; noteActionsFor derives the rest of
 *  the context from it, so every surface reads the facts the same way. */
export type NoteActionFacts<C extends NoteActionCommand = NoteActionCommand> = {
  canEdit: boolean;
  isOwner?: boolean;
  online: boolean;
  /** The tag catalog: reserved and hidden tags, system rows. */
  tags?: readonly Tag[];
  /** The live body (else the saved markdown). */
  body?: string;
  commands?: readonly C[];
  hasVersions?: boolean;
};

/** A note's actions for this person, from store facts (lib/capabilities,
 *  the tag catalog, the note list). The common entry for surfaces. */
export function noteActionsFor<C extends NoteActionCommand>(node: ContentNode, facts: NoteActionFacts<C>): NoteActionView<C> {
  const tag = node.node_type === TAG_NODE_TYPE ? facts.tags?.find((row) => row.id === node.id) : undefined;
  const body = facts.body ?? node.markdown ?? "";
  return noteActionView(noteActionList(node, {
    canEdit: facts.canEdit,
    isOwner: facts.isOwner,
    online: facts.online,
    reserved: !!tag?.reserved_key,
    system: isSystemNode(node, tagsById(facts.tags)),
    pinned: isPinned(node),
    tagHidden: node.node_type === TAG_NODE_TYPE && !isTagShown(tag ?? node),
    hasVersions: facts.hasVersions,
    body,
    commands: facts.commands,
  }));
}

/** Lookup over a note's action list: what a surface renders from. */
export type NoteActionView<C extends NoteActionCommand = NoteActionCommand> = {
  list: NoteAction<C>[];
  /** The action (or a module command, by its id) is offered for this note. */
  has: (id: NoteActionId | (string & {})) => boolean;
  /** Its menu label (an i18n key). */
  label: (id: NoteActionId) => string;
  /** The offered module commands, in order. */
  commands: NoteAction<C>[];
};

export function noteActionView<C extends NoteActionCommand>(list: NoteAction<C>[]): NoteActionView<C> {
  const byId = new Map(list.map((a) => [a.id, a]));
  return {
    list,
    has: (id) => byId.get(id)?.visible === true,
    label: (id) => byId.get(id)?.label ?? id,
    commands: list.filter((a) => a.handler === "module" && a.visible),
  };
}
