// The one list of what a person can create from the UI, and how each kind is
// made. The sidebar "+" menu, a note's 「在裡面新增」 submenu and the command
// palette read it; `create` in hooks/useNodeCreation runs it:
//
//   create("upload", { parentId })   // a note from a chosen file under `parentId` (null/absent: top level)
//
// A built-in kind that belongs to a module (the board) names it in `module`
// and is listed only while that module is imported. A `named` kind (a tag) needs
// its name before it exists, goes under a tag, and is the owner's; only the
// create sheet (components/CreateSheet) lists it.
import { acceptFor, mediaTypeOf } from "@onden/markdown";
import { Bookmark, FileText, LayoutDashboard, Hash, ListChecks, Pencil, Upload, type LucideIcon } from "lucide-react";
import type { ContentNode } from "./api";
import type { CreateNote } from "./data";
import { t } from "./i18n";
import type { ModuleFilter } from "../modules";
// Loading the registry is what supplies the shell features read below
// (shellFeatureModule); a type-only import is erased by the build.
import "../modules";
import { shellFeatureModule } from "./shellFeatures";

/** What a kind's `run` may use; `parentId` is already applied by `createNote`. */
export type CreateEnv = {
  parentId: string | null;
  /** A plain note named 「未命名」; null when the writer refused (reported). */
  createPlainNote: () => Promise<ContentNode | null>;
  createNote: (input: CreateNote) => Promise<string>;
  /** Null when the person cancels the picker: nothing is uploaded or created. */
  pickAndUpload: (accept: string, afterUpload: (file: File, url: string) => Promise<string>) => Promise<string | null>;
  /** For a note the server made on its own: file it under `parentId`. */
  placeUnderParent: (id: string) => Promise<void>;
  /** Bookmark URL prompt; null when cancelled. */
  askBookmarkUrl: () => string | null;
  postBookmark: (url: string) => Promise<string>;
  /** A tag named by the caller, under `parentId` (a tag); null when refused (reported). */
  createTag: () => Promise<string | null>;
  /** A new untitled board (a note of its own), made on this device first; its id. */
  createCanvas: () => Promise<string>;
  openNote: (id: string) => void;
  /** Opens the quick-add task sheet (the open note and its space are where it starts); nothing is made here. */
  openQuickAddTask: () => void;
};

export type CreateKind = {
  id: string;
  /** An i18n key. */
  label: string;
  Icon: LucideIcon;
  /** Everything but a plain note uploads or fetches; offline it is disabled. */
  needsServer: boolean;
  /** Listed only while this module is imported. */
  module?: string;
  /** Can be made under another note (false: a tag). */
  placeable: boolean;
  /** Named before it is made, and made under a tag: the sheet asks for the
   *  name, the owner only (a tag is workspace-wide). */
  named?: boolean;
  /** Where the result is: the new note's id, or null (cancelled, refused, or
   *  a dialog that opens the note itself). */
  run: (env: CreateEnv) => Promise<string | null>;
};

const EMPTY_INK_DOC = { version: 1, strokes: [], erased: {}, page: { width: 1000 } };

export const BUILTIN_CREATE_KINDS: readonly CreateKind[] = [
  {
    id: "note", label: "Note", Icon: FileText, needsServer: false, placeable: true,
    run: async (env) => (await env.createPlainNote())?.id ?? null,
  },
  {
    // Named first: tag names are unique under a parent, so there is no 未命名 tag.
    id: "tag", label: "Tag", Icon: Hash, needsServer: false, placeable: false, named: true,
    run: (env) => env.createTag(),
  },
  {
    // A task is made in the quick-add sheet (one line, read as it is typed), not in a form here.
    id: "task", label: "Task", Icon: ListChecks, needsServer: false, placeable: false, module: shellFeatureModule("tasks"),
    run: async (env) => { env.openQuickAddTask(); return null; },
  },
  {
    // The ink_data presence (a parsable empty doc, not "") is what makes the
    // editor branch to the handwriting view.
    id: "ink", label: "Handwriting", Icon: Pencil, needsServer: true, placeable: true,
    run: (env) => env.createNote({
      title: t("Handwritten note"), markdown: "", attributes: [{ key: "ink_data", value: JSON.stringify(EMPTY_INK_DOC) }],
    }),
  },
  {
    // One picker for what the server takes as a file; what is made follows the
    // chosen file's kind. A PDF's pdf_url makes the editor branch to the PDF
    // view. An image, audio or video page is titled by the file name and its
    // body is the media address (the renderers draw it inline, as a player for
    // audio/video), to annotate below.
    id: "upload", label: "Upload a file", Icon: Upload, needsServer: true, placeable: true,
    run: (env) => env.pickAndUpload(acceptFor("pdf", "image", "audio", "video"), (file, url) => {
      if (mediaTypeOf(file.name)?.kind === "pdf") {
        return env.createNote({ title: file.name.replace(/\.pdf$/i, ""), markdown: "", attributes: [{ key: "pdf_url", value: url }] });
      }
      const title = file.name.replace(/\.[^.]+$/, "");
      return env.createNote({ title, markdown: mediaTypeOf(file.name)?.kind === "document" ? `[${title}](${url})\n` : `![${title}](${url})\n` });
    }),
  },
  {
    // The server fetches the page for its title / description / image.
    id: "bookmark", label: "Bookmark", Icon: Bookmark, needsServer: true, placeable: true,
    run: async (env) => {
      const url = env.askBookmarkUrl();
      if (!url) return null;
      const id = await env.postBookmark(url);
      await env.placeUnderParent(id);
      return id;
    },
  },
  {
    // A board is a note; the writer queues it offline like a plain note.
    id: "canvas", label: "Canvas", Icon: LayoutDashboard, needsServer: false, placeable: true, module: shellFeatureModule("whiteboard"),
    run: async (env) => {
      const id = await env.createCanvas();
      await env.placeUnderParent(id);
      return id;
    },
  },
];

/** Every kind the person can create now: the built-in ones whose module (if
 *  any) is imported. A module's own add dialogs are not here: they open from
 *  its tag page and the palette (modules `dialogEntry`). */
export function createKindsFor(isImported: ModuleFilter): CreateKind[] {
  return BUILTIN_CREATE_KINDS.filter((kind) => !kind.module || isImported(kind.module));
}
