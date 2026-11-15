// D112: which actions a note offers is decided once, in noteActionList, and
// every surface renders from it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentNode, Tag } from "../api";
import { NOTE_COMMANDS } from "../../modules";
import { noteActionList, noteActionsFor, noteActionView, type NoteActionContext } from "./noteActionList";

const note = (over: Partial<ContentNode> = {}) =>
  ({ id: "n1", title: "Note", node_type: "content", parent_id: "p1", markdown: "# A\n\n- [ ] todo", ...over }) as ContentNode;
const view = (node: ContentNode, ctx: Partial<NoteActionContext> = {}) =>
  noteActionView(noteActionList(node, { canEdit: true, online: true, ...ctx }));
const command = (id: string) => NOTE_COMMANDS.find((entry) => entry.command.id === id)!.command;

describe("noteActionList", () => {
  it("an editor gets the writing actions; a viewer only those the server allows (no 403 → rollback)", () => {
    const editor = view(note());
    for (const id of ["rename", "duplicate", "new-inside", "move", "toggle-pin", "set-color", "delete"] as const) {
      expect(editor.has(id)).toBe(true);
    }
    const viewer = view(note(), { canEdit: false });
    for (const id of ["rename", "new-inside", "move", "toggle-pin", "set-color", "delete"] as const) {
      expect(viewer.has(id)).toBe(false);
    }
    // 「從上層移出」 is the move picker's top-level row: no action of its own.
    expect(editor.list.map((a) => a.id)).not.toContain("unparent");
    expect(editor.label("move")).toBe("Move to…");
    // Reading and copying stay; Duplicate writes a copy the viewer owns.
    for (const id of ["open", "duplicate", "copy-markdown", "export"] as const) expect(viewer.has(id)).toBe(true);
  });

  it("offers \"Present as slides\" on a note with text only", () => {
    const present = command("a-present");
    expect(view(note({ markdown: "" }), { commands: [present] }).has("a-present")).toBe(false);
    expect(view(note(), { commands: [present] }).has("a-present")).toBe(true);
    expect(view(note({ node_type: "canvas" }), { commands: [present] }).has("a-present")).toBe(false);
  });

  it("hides a command whose `available` needs the server when offline", () => {
    const needsServer = { id: "needs-server", label: "Needs server", available: (_n: ContentNode, _b: string, env: { online: boolean }) => env.online, run: () => {} };
    expect(view(note(), { commands: [needsServer], online: true }).commands.map((a) => a.id)).toEqual(["needs-server"]);
    expect(view(note(), { commands: [needsServer], online: false }).commands).toEqual([]);
  });

  it("never deletes a reserved tag or a system row; hides only tags", () => {
    const tag = note({ node_type: "class_tag", parent_id: null });
    expect(view(tag, { reserved: true }).has("delete")).toBe(false);
    expect(view(tag, { reserved: true }).has("toggle-tag-hidden")).toBe(false);
    expect(view(tag).has("toggle-tag-hidden")).toBe(true);
    expect(view(tag).has("move")).toBe(false);
    expect(view(note()).has("toggle-tag-hidden")).toBe(false);
    expect(view(note({ source_type: "system" } as Partial<ContentNode>), { system: true }).has("delete")).toBe(false);
  });

  it("noteActionsFor reads the facts from the store rows", () => {
    const tags = [{ id: "t1", reserved_key: "task" }] as unknown as Tag[];
    const reserved = noteActionsFor(note({ id: "t1", node_type: "class_tag" }), { canEdit: true, online: true, tags });
    expect(reserved.has("delete")).toBe(false);
  });
});

// The guard: a surface that lists a note's actions renders from the list and
// does not decide on its own again (each one used to: D112).
describe("note action surfaces", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");
  const SURFACES = [
    "components/ContextMenu.tsx",
    "components/WiredNoteActions.tsx",
    "components/OverviewSidebar.tsx",
    "hooks/useCommandPalette.ts",
  ];

  it.each(SURFACES)("%s renders from noteActionsFor", (path) => {
    expect(read(path)).toMatch(/\bnoteActionsFor\(/);
  });

  it.each(SURFACES)("%s does not hand-roll delete or edit gates", (path) => {
    const text = read(path);
    expect(text).not.toMatch(/reservedTagIds|undeletable/);
    // A note action gated on canEdit inline (the old `caps.canEdit(node) && <MenuItem`).
    expect(text).not.toMatch(/canEdit\([^)]*\)\s*&&\s*[(<]/);
  });

  it("NoteActions shows what the list offers, not its own flags", () => {
    const text = read("components/NoteActions.tsx");
    // It shows the header ones of the list (NOTE_HEADER_ACTIONS), each only if the list has it.
    expect(text).toMatch(/NOTE_HEADER_ACTIONS\.includes\(id\) && actions\.has\(id\)/);
    expect(text).toMatch(/offered\("delete"\)/);
    expect(text).not.toMatch(/readOnly|canMerge|canSendChecklist|canDuplicate/);
  });

  it("the palette's note commands are filtered by the selected note's list", () => {
    const text = read("hooks/useCommandPalette.ts");
    expect(text).toMatch(/selectedActions\.has\(/);
  });
});
