import { randomUUID } from "../lib/uuid";
import { boardSpaceId } from "../lib/boardLayout";
import { markdownExportUrl, nodeNeedsBody, type Bootstrap, type Canvas, type ContentNode } from "../lib/api";
import { canvasWriter, dayNotes, nodeActions, noteWriter, propertyWriter, resolveTagPaths, tagWriter, uploadMedia, sendWrite, writeErrors, pins } from "../lib/data";
import type { CreateNote, DayNoteSeed } from "../lib/data";
import { addToast, getAppState, getNode } from "../lib/appStore";
import { t } from "../lib/i18n";
import { requestNoteTitleFocus } from "../lib/cardTitleFocus";
import { dailyNotesEnabled } from "../lib/dayNode";
import { createKindsFor, type CreateEnv } from "../lib/createKinds";
import { moduleFilterFor, openQuickAddTask } from "../modules";
import type { AppMode } from "./useUiMode";
import { untitledTitle } from "../lib/noteLabel";

// Quick-create rail: every flow creates through the note writer, so the note is
// in the store and local mirror at once (no refresh), uses a client id that is
// also its Idempotency-Key, and is reported once by the writer on failure. A
// typed note (handwriting, PDF) is created WITH the attribute that gives it its
// kind — one request, so it can never exist as a plain note.
async function createNote(input: CreateNote): Promise<string> {
  const { node } = await noteWriter.create({ id: randomUUID(), ...input });
  return node.id;
}
const reportFailure = (error: unknown) => writeErrors.report(error, addToast);
/** Nothing written in it yet (a slim row whose body is not loaded is not blank). */
const isBlankNote = (node: ContentNode) => !nodeNeedsBody(node) && !(node.markdown ?? "").trim();

// A1 of the BuilderApp decomposition: the node-creation / quick-create / upload
// / pointer handlers, lifted out of the BuilderApp god-component verbatim. Pure
// behaviour move — no logic change. BuilderApp threads its data/dialog/selection
// state in; the hook returns the handlers it used to define inline.

type Params = {
  data: Bootstrap;
  /** The raw create from useAppData (BuilderApp's `_createNode`). */
  createNodeRaw: (title: string, kind: "markdown", count: number, parentId?: string | null, spaceId?: string | null) => Promise<ContentNode | null>;
  refresh: () => Promise<void> | void;

  // useCreateDialog state
  draftTitle: string;
  setCreateOpen: (open: boolean) => void;

  // canvas + selection (addToActiveCanvas moves to useCanvasActions in A2)
  activeCanvas: Canvas | null;
  addToActiveCanvas: (nodeId: string) => Promise<void>;
  setSelectedId: (id: string | null) => void;
  setMode: (mode: AppMode) => void;
  /** Opens a note from navigation (also leaves a board that is not it). */
  openNote: (id: string) => void;
  /** Opens a tag just created (its page, like the tag panel's ＋). */
  openNewTag: (id: string) => void;
};

/** `parentId`: file the new note (or tag) under it (absent/null: top level).
 *  `spaceId`: the space a top-level note goes in (absent: the personal space);
 *  ignored under a parent, which keeps its own space, and for a tag.
 *  `templateId`: with kind "template", which note template to stamp.
 *  `name`: with a `named` kind (tag), the name it is made with. */
export type CreateOptions = { parentId?: string | null; spaceId?: string | null; templateId?: string; name?: string };
export type CreateFn = (kind: string, options?: CreateOptions) => Promise<string | null>;

export function useNodeCreation({
  data,
  createNodeRaw,
  refresh,
  draftTitle,
  setCreateOpen,
  activeCanvas,
  addToActiveCanvas,
  setSelectedId,
  setMode,
  openNote,
  openNewTag,
}: Params) {
  async function createNode() {
    await createNodeRaw(draftTitle, "markdown", data.nodes.length);
    setCreateOpen(false);
  }

  // The one create entry (lib/createKinds lists the kinds): every "new …" in
  // the sidebar, a note's 「在裡面新增」 menu, the palette and the welcome page
  // comes here. Resolves the new note's id, or null when nothing was made
  // (cancelled picker/prompt, a refusal — already reported — or a module
  // dialog that opens its note itself). The new note is selected; a plain
  // note also takes its title. A top-level note joins the open board.
  async function create(kind: string, { parentId = null, spaceId: requestedSpaceId = null, templateId, name }: CreateOptions = {}): Promise<string | null> {
    // A top-level note made while a board is open is made in the board's space, so everybody who sees
    // the board sees its card (a note placed on it from elsewhere is lib/boardCardAudience's reminder).
    const spaceId = parentId || kind === "tag" ? null : requestedSpaceId ?? boardSpaceId(data.nodes, activeCanvas?.id);
    const env: CreateEnv = {
      parentId,
      createPlainNote: () => createNodeRaw(untitledTitle(), "markdown", data.nodes.length, parentId, spaceId),
      createNote: (input) => createNote(parentId ? { ...input, parent_id: parentId } : spaceId ? { ...input, space_id: spaceId } : input),
      pickAndUpload,
      placeUnderParent: async (id) => {
        if (!parentId) return;
        await refresh();
        await nodeActions.assignToGroup(id, parentId);
      },
      askBookmarkUrl: () => (typeof window === "undefined" ? null : window.prompt(t("Bookmark URL:"))?.trim() || null),
      postBookmark: async (url) => (await sendWrite<{ id: string }>("POST", "/api/bookmark", spaceId ? { url, space_id: spaceId } : { url })).id,
      createTag: async () => {
        const tagName = name?.trim();
        if (!tagName) return null;
        const { id, queued } = await tagWriter.create(tagName, { parentId });
        if (queued) addToast(writeErrors.queuedMessage(), "info");
        return id;
      },
      createCanvas: async () => (await canvasWriter.create(t("Untitled canvas"), spaceId ? { spaceId } : {})).id,
      openNote,
      openQuickAddTask: () => {
        const open = getNode(getAppState().selectedId);
        openQuickAddTask(open ? { id: open.id, title: open.title, spaceId: open.space_id } : undefined);
      },
    };
    try {
      let id: string | null;
      if (kind === "template") {
        id = templateId ? await createTemplateNote(templateId, parentId, spaceId) : null;
      } else {
        const entry = createKindsFor(moduleFilterFor(getAppState().data.workspace?.modules)).find((k) => k.id === kind);
        id = entry ? await entry.run(env) : null;
      }
      if (!id) return null;
      if (kind === "tag") { openNewTag(id); return id; }
      if (!parentId && activeCanvas) await addToActiveCanvas(id);
      if (kind === "note") requestNoteTitleFocus(id);
      // openNote also moves a phone or narrow tablet from the list into the
      // note; a top-level note made while a board is open stays on the board.
      if (parentId || !activeCanvas) openNote(id);
      else { setSelectedId(id); setMode("notes"); }
      return id;
    } catch (error) {
      reportFailure(error);
      return null;
    }
  }

  // Opens (or starts) today's day note (lib/data/dayNotes.ts — one note per
  // person and date, offline too) and focuses it. Returns the node id so
  // callers (e.g. the home mood picker) can act on today's note without a
  // second lookup; returns null only when starting it failed (already reported).
  // With daily notes off (日記 not imported) it does nothing: ⌘⇧D, the
  // palette and the landing all come through here.
  // `announce: false` is for the app opening on its own (useLandingNote): the person did nothing,
  // so a 「已建立」 note would be noise. Anything they pressed announces.
  async function openDailyNote(options?: { announce?: boolean }): Promise<string | null> {
    if (!dailyNotesEnabled()) return null;
    const opened = await dayNotes.openToday().catch(() => null);
    if (!opened) return null;
    if (opened.created && options?.announce !== false) {
      const title = opened.node.title;
      addToast(t(opened.status === "synced" ? '"{title}" created' : '"{title}" saved locally', { title }));
    }
    setSelectedId(opened.node.id);
    setMode("notes");
    return opened.node.id;
  }

  // Markdown export — backend streams every non-hidden node into a single
  // zip. We trigger the download via a hidden anchor so the browser's
  // native progress UI handles large workspaces.
  function exportMarkdown() {
    const url = markdownExportUrl();
    const a = document.createElement("a");
    a.href = url;
    a.download = "onden-export.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Opens a file picker for the given MIME group, uploads the chosen file to
  // /api/media, then runs `afterUpload` (which creates the note). A cancelled
  // picker (the `cancel` event, or a change with no file) creates nothing.
  // Resolves the id `afterUpload` made, or null.
  function pickAndUpload(
    accept: string,
    afterUpload: (file: File, url: string) => Promise<string>,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.style.display = "none";
      document.body.appendChild(input);
      const done = (id: string | null) => { input.remove(); resolve(id); };
      input.addEventListener("cancel", () => done(null));
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { done(null); return; }
        try {
          done(await afterUpload(file, await uploadMedia(file)));
        } catch (error) {
          reportFailure(error);
          done(null);
        }
      };
      input.click();
    });
  }
  // Symlink-style pointer clone — adds a /api/pointers row that makes
  // the target note appear under another parent in the sidebar tree. The
  // parent comes from the pin picker (ContextMenu → ParentCombobox "pin",
  // lib/data placementCandidates): always a note, never the top level.
  async function createPointer(targetId: string, parentId: string) {
    try {
      await pins.pin(targetId, parentId);
      await refresh();
    } catch {
      // pins.pin reported it.
    }
  }

  async function deletePointer(pointerId: string) {
    try {
      await pins.unpin(pointerId);
      await refresh();
    } catch {
      // pins.unpin reported it.
    }
  }

  // The day template's scaffold on today's note: started with it when there is
  // none, or stamped onto it when it is still empty (one write per part, each
  // through its writer; a refusal stops and is reported, nothing is retried).
  async function stampToday(seed: DayNoteSeed): Promise<string> {
    const opened = await dayNotes.openToday({ create: seed });
    const { node } = opened!;
    if (!opened!.created && isBlankNote(node)) {
      // Based on the blank body just checked: a line someone wrote meanwhile
      // (another device) merges in instead of being stamped over (D87).
      await noteWriter.patch(node.id, { markdown: seed.markdown }, { baseMarkdown: node.markdown ?? "" });
      for (const tagId of seed.tagIds ?? []) await tagWriter.apply(node.id, tagId);
      for (const a of seed.attributes ?? []) await propertyWriter.set(node.id, a.key, a.value);
    }
    return node.id;
  }

  // Palette / slash → "New from template": stamp a scaffold into a fresh node.
  // Default tags are resolved first (/api/tags/resolve-path is find-or-create,
  // so the first use of e.g. #meeting mints the tag; offline, an existing tag is
  // found in the local catalog — lib/data/tagPaths.ts); the note is then
  // created WITH its tags and default attributes in one request (queued
  // offline), so a refusal leaves no half-stamped note. A tag that cannot be
  // resolved (offline and not yet created, or refused) is never dropped: it is
  // kept in the body as #text and named.
  // Title/body/attribute placeholders ({date}/{datetime}) are resolved by
  // instantiateTemplate; fitTemplateToTags then leaves the scaffold to a tag
  // that stamps its own (template children) and fills the tags' fields.
  // A day template (the "Daily note") does not mint a note: it opens today's
  // note (lib/data/dayNotes.ts) and stamps its scaffold only onto an empty
  // one — today's note may already hold a capture or an agenda task, and a
  // second note titled with today's date is never made.
  async function createTemplateNote(templateId: string, parentId: string | null, spaceId: string | null): Promise<string | null> {
    // The template catalog loads on the first template note (the palette and the editor use it too).
    const { fitTemplateToTags, getNoteTemplate, instantiateTemplate } = await import("../lib/noteTemplates");
    const tpl = getNoteTemplate(templateId);
    if (!tpl) return null;
    const inst = instantiateTemplate(tpl);
    const { title, tags } = inst;
    // The day template is not offered while daily notes are off; a stale
    // palette entry does nothing.
    if (tpl.day && !dailyNotesEnabled()) return null;
    if (tpl.day) {
      // Today's note already has content: open it as it is (no scaffold, and
      // no tag minted for a scaffold that is not applied).
      const today = await dayNotes.openToday({ create: false });
      if (today && !isBlankNote(today.node)) {
        setSelectedId(today.node.id);
        setMode("notes");
        return null;
      }
    }
    const { resolved, unresolved } = await resolveTagPaths(tags, { tags: data.tags, online: getAppState().online });
    // A tag that stamps its own scaffold (template children) gets the body's
    // place; its declared fields take the template's values (D69).
    // The live catalog: resolving may have refetched it.
    const catalog = getAppState().data.tags ?? [];
    const { body, attributes } = fitTemplateToTags(inst, catalog.filter((tag) => resolved.some((r) => r.id === tag.id)));
    const kept = unresolved.map((path) => `#${path}`).join(" ");
    const markdown = kept ? `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${kept}\n` : body;
    const seed = { markdown, tagIds: resolved.map((r) => r.id), attributes: attributes.map((a) => ({ key: a.key, value: a.value })) };
    // Today's note is the day template's one note: it is never filed elsewhere.
    const id = tpl.day ? await stampToday(seed) : await createNote({ title, ...seed, ...(parentId ? { parent_id: parentId } : spaceId ? { space_id: spaceId } : {}) });
    if (kept) {
      addToast(t("Created from the template. These tags could not be applied yet and were kept in the note as text: {items}", { items: kept }), "error");
    }
    return id;
  }

  return {
    createNode,
    create,
    openDailyNote,
    exportMarkdown,
    createPointer,
    deletePointer,
  };
}
