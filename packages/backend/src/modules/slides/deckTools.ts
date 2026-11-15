import { z } from "zod";
import {
  LAYOUT_IDS, chosenLayout, cutToUnits, layoutsByPageKey, SLIDES_DATA_ATTR, SLIDES_THEMES, SLIDE_LAYOUTS, alternativeLayout, isLayoutId, layoutOfPage, pagesOf,
  parseSlidesData, serializeSlidesData, withPageLayout, withSlidesTheme,
  type LayoutId, type SlidePage, type SlidesData, type SlidesTheme,
} from "@onden/markdown";
import { db } from "../../dbKysely.js";
import { assertAuthority } from "../../spine/authority.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { assertWriteModeAllows } from "../../spine/toolScope.js";
import { StatusError } from "../../statusError.js";
import { setNodeAttribute } from "../../services/attributeWrites.js";
import { recordAttributeChange } from "../../services/attributeChange.js";
import { noteAnchorRanges } from "../../services/blockAnchors/index.js";
import { readableNote, type AgentTool, type ReadableNote } from "../../services/agentTools/index.js";

// A note's 「簡報」 view for an agent: the pages the app cuts from the note (the same
// pagesOf the editor uses, @onden/markdown), and the two choices the view stores in
// `slides_data` (a page's layout, the deck's theme). Nothing about pages is stored:
// getSlides cuts them from the body when it is called.

const MAX_PAGES_PER_CALL = 100;
/** A page's text is not cut for size here (the note's own size limit bounds it), but one call never carries more than this. */
const MAX_FIELD_CHARS = 20_000;

const clip = (text: string): { text: string; truncated: boolean } =>
  text.length > MAX_FIELD_CHARS ? { text: cutToUnits(text, MAX_FIELD_CHARS), truncated: true } : { text, truncated: false };

const GetSlidesArgs = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1).max(200).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_PAGES_PER_CALL).default(40),
}).refine((v) => v.id !== undefined || v.slug !== undefined, { message: "must provide id or slug" });

async function slidesDataOf(nodeId: string): Promise<SlidesData> {
  const row = await db.selectFrom("node_attributes").select("value").where("node_id", "=", nodeId).where("key", "=", SLIDES_DATA_ATTR).executeTakeFirst();
  return parseSlidesData(row?.value);
}

/** The note's pages as the app cuts them: paragraph anchors keep a heading's page key steady across title edits. */
async function pagesOfNote(workspaceId: string, note: ReadableNote): Promise<SlidePage[]> {
  return pagesOf(note.markdown, await noteAnchorRanges(workspaceId, note.id));
}

const noteNotFound = () => new StatusError(404, "note not found");

type SlidePageOut = {
  /** 1-based place in the deck. */
  position: number;
  /** Names this page in setSlideLayout; it follows the page's heading, not its place. */
  key: string;
  title: string | null;
  layout: LayoutId;
  /** The layout the page's content asks for by itself. */
  autoLayout: LayoutId;
  /** True when a person (or setSlideLayout) chose `layout`; false: it is the automatic one. */
  layoutChosen: boolean;
  /** Another layout the content fits better than `layout`, when `layout` is a poor fit (a long text in a picture layout…); null otherwise. */
  betterLayout: LayoutId | null;
  /** What the slide shows, as Markdown. */
  screen: string;
  /** What is for the speaker only, as Markdown. */
  speakerNotes: string;
  /** Where this page's text sits in the note's markdown as getNode returns it (`\r\n` read as `\n`); null if it could not be located. */
  range: { from: number; to: number } | null;
  truncated?: true;
};

type GetSlidesResult = {
  note: { id: string; slug: string; title: string };
  theme: SlidesTheme;
  pageCount: number;
  pages: SlidePageOut[];
  /** The offset of the next page of results; null at the end. */
  next: number | null;
  /** Every layout setSlideLayout takes. */
  layouts: Array<{ id: LayoutId; label: string; about: string }>;
  themes: readonly SlidesTheme[];
} | null;

export const getSlides: AgentTool<z.infer<typeof GetSlidesArgs>, GetSlidesResult> = {
  name: "getSlides",
  access: "read",
  description:
    "Read a note as slides, by id or slug: the pages the note is cut into (at lines that are only `---`, else at `##` headings), " +
    "each with its key, title, current layout, the layout its content asks for by itself, whether the layout was chosen by a person, " +
    "what the slide shows and the speaker notes (Markdown), and where the page's text sits in the note's markdown (range) so you can " +
    "edit the right lines with updateNode/suggestEdit. Also the deck's theme and every layout setSlideLayout accepts. " +
    "Returns null if the note is not found or you cannot read it. Long decks come in pages: pass the returned `next` as offset.",
  inputSchema: GetSlidesArgs,
  async handler(args, { actor, workspaceId }) {
    const note = await readableNote(actor, workspaceId, args);
    if (!note) return null;
    const [pages, data] = await Promise.all([pagesOfNote(workspaceId, note), slidesDataOf(note.id)]);
    const end = Math.min(pages.length, args.offset + args.limit);
    const out: SlidePageOut[] = [];
    for (let i = args.offset; i < end; i++) {
      const page = pages[i]!;
      const { parts } = page;
      const shown = [page.headingLine, parts.statement, parts.subtitle, ...parts.body.map((b) => b.markdown)].filter((s): s is string => !!s);
      const screen = clip(shown.join("\n\n"));
      const notes = clip(page.notes);
      const layout = layoutOfPage(page, data.layouts);
      const chosen = chosenLayout(page, data.layouts); // a choice stored under the page's old key still counts
      out.push({
        position: i + 1, key: page.key, title: parts.heading, layout, autoLayout: page.autoLayout,
        layoutChosen: chosen !== undefined && isLayoutId(chosen),
        betterLayout: alternativeLayout(layout, parts),
        screen: screen.text, speakerNotes: notes.text, range: page.range ?? null,
        ...(screen.truncated || notes.truncated ? { truncated: true as const } : {}),
      });
    }
    return {
      note: { id: note.id, slug: note.slug, title: note.title },
      theme: data.theme, pageCount: pages.length, pages: out, next: end < pages.length ? end : null,
      layouts: SLIDE_LAYOUTS.map((l) => ({ id: l.id, label: l.label, about: l.blurb })),
      themes: SLIDES_THEMES,
    };
  },
};

const SetSlideLayoutArgs = z.object({
  id: z.string().uuid(),
  /** A page's key, from getSlides. */
  key: z.string().min(1).max(120).optional(),
  /** A layout id, or null to hand the page back to the automatic layout. Needs `key`. */
  layout: z.enum(LAYOUT_IDS).nullable().optional(),
  theme: z.enum(SLIDES_THEMES).optional(),
}).refine((v) => (v.key === undefined) === (v.layout === undefined), { message: "key and layout go together: send both, or neither" })
  .refine((v) => v.key !== undefined || v.theme !== undefined, { message: "send key and layout, theme, or both" });

type SetSlideLayoutResult = {
  id: string;
  page: { key: string; layout: LayoutId; autoLayout: LayoutId; layoutChosen: boolean } | null;
  theme: SlidesTheme;
  /** False when the note already held these choices (nothing was written). */
  changed: boolean;
};

/** The note's next `slides_data` after the requested change, or why it cannot be made. */
function nextChoices(data: SlidesData, pages: readonly SlidePage[], args: z.infer<typeof SetSlideLayoutArgs>): SlidesData {
  let next = data;
  if (args.key !== undefined) {
    const page = pages.find((p) => p.key === args.key);
    if (!page) throw new StatusError(422, `no page with key '${args.key}' in this note; call getSlides for the current keys`);
    if (args.layout != null && !isLayoutId(args.layout)) throw new StatusError(422, `unknown layout '${args.layout}'`);
    // Start from the choices keyed by page (a choice stored under a page's old key moves to its key), as the app's writer does.
    next = withPageLayout({ ...next, layouts: layoutsByPageKey(pages, next.layouts) }, args.key, args.layout ?? null);
  }
  return args.theme !== undefined ? withSlidesTheme(next, args.theme) : next;
}

export const setSlideLayout: AgentTool<z.infer<typeof SetSlideLayoutArgs>, SetSlideLayoutResult> = {
  name: "setSlideLayout",
  access: "write",
  description:
    "Choose a slide's layout in a note's slides view (key from getSlides; layout one of its `layouts`, or null for the automatic layout), " +
    "and/or set the deck's theme (site, dark, paper). This changes only the view's choices, never the note's text. " +
    "You need edit rights in the note's space. An agent set to suggest edits cannot use it: a layout change is a direct change, " +
    "not a suggestion, so it is refused — say what you would choose with commentOnNote instead.",
  inputSchema: SetSlideLayoutArgs,
  async handler(args, { actor, workspaceId, dryRun }) {
    return withEventTransaction(workspaceId, async () => {
      // The role and token may have changed while this call waited for the lock: decide on the current ones.
      const now = await resolveCurrentActor(actor, workspaceId);
      // The same rule every direct write meets in mutate(), applied here too so a dry run answers as the real call would.
      assertWriteModeAllows(now, "ATTRIBUTE_SET");
      const note = await readableNote(now, workspaceId, { id: args.id });
      if (!note) throw noteNotFound();
      await assertAuthority(now, { kind: "node", nodeId: note.id, op: "set_attribute" });
      const [pages, data] = await Promise.all([pagesOfNote(workspaceId, note), slidesDataOf(note.id)]);
      const next = nextChoices(data, pages, args);
      const text = serializeSlidesData(next);
      const changed = text !== serializeSlidesData(data);
      if (changed && !dryRun) {
        // A choice taken back to the defaults removes the attribute, as the app's own writer does.
        if (text === null) {
          await recordAttributeChange({
            workspaceId, nodeId: note.id, key: SLIDES_DATA_ATTR, actor: now, next: null, rule: "always",
            authority: { kind: "node", nodeId: note.id, op: "delete_attribute" }, uiContext: "node.attribute.delete",
          });
        } else {
          await setNodeAttribute({ workspaceId, actor: now, nodeId: note.id, attribute: { key: SLIDES_DATA_ATTR, value: text, value_type: "text" } });
        }
      }
      const page = args.key === undefined ? null : pages.find((p) => p.key === args.key)!;
      const layout = page ? layoutOfPage(page, next.layouts) : null;
      const chosenAfter = page ? chosenLayout(page, next.layouts) : undefined;
      return {
        id: note.id,
        page: page && layout ? { key: page.key, layout, autoLayout: page.autoLayout, layoutChosen: chosenAfter !== undefined && isLayoutId(chosenAfter) } : null,
        theme: next.theme, changed,
      };
    });
  },
};
