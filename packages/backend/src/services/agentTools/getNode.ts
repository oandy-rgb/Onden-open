import { z } from "zod";
import { q } from "../../db.js";
import { readableNote } from "./readableNote.js";
import { bodyMediaIds, describeAttachment, type NoteAttachment } from "./attachmentRefs.js";
import { isInkPageAttr } from "@onden/markdown";
import { NOTE_PAGES_ATTR, PDF_TEXT_ATTR } from "@onden/markdown/contract";
import { notePagesOf, summarizeNotePages } from "@onden/markdown/note-pages";
import { pdfTextPageCount } from "../pdfText.js";
import type { AgentTool } from "./types.js";
import { pdfNoteSummary } from "./pdfNoteSummary.js";
import { liveTagNodeSql } from "../../spine/nodeSql.js";

// Read-only fetch by id OR slug. Includes attributes + tags so an agent can
// reason about a node without a follow-up call. A caller only resolves nodes
// it may read (its spaces; a token: its read scope) — otherwise null,
// indistinguishable from not-found, so it can't probe other spaces.

const Args = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1).max(200).optional(),
}).refine(
  (v) => v.id !== undefined || v.slug !== undefined,
  { message: "must provide id or slug" },
);

type GetNodeResult = {
  id: string;
  slug: string;
  title: string;
  node_type: string;
  markdown: string;
  created_at: string;
  updated_at: string;
  tags: Array<{ id: string; title: string }>;
  attributes: Array<{ key: string; value: string; value_type: string }>;
  /** Files the body references; fetch one with getAttachment({ nodeId, ref }). */
  attachments: NoteAttachment[];
  /** Set only for a PDF note: whether its body holds the file's text (see pdfNoteSummary). */
  pdf_note?: string;
} | null;

export const getNodeTool: AgentTool<z.infer<typeof Args>, GetNodeResult> = {
  name: "getNode",
  access: "read",
  description:
    "Fetch a single node by id or slug, including its tags, attributes and attachments (files the body references; getAttachment fetches them). " +
    "Drawing data (handwriting strokes, a whiteboard's pen layer, a PDF's marks) is not in the attributes: it is megabytes of stroke JSON that no tool reads or edits. " +
    "Returns null if not found or soft-deleted. To edit the body later, keep " +
    "the returned markdown and pass it unchanged as updateNode's base_markdown.",
  inputSchema: Args,
  async handler(args, { workspaceId, actor }) {
    // Read authorization (space membership; a token: its read scope) decides which row is picked, before any
    // other choice: out-of-scope rows are simply absent — same as not-found, no oracle.
    const node = await readableNote(actor, workspaceId, args);
    if (!node) return null;

    const [tagsRes, attrsRes] = await Promise.all([
      q<{ id: string; title: string }>(
        `SELECT t.id, t.title
         FROM node_tags nt
         JOIN content_nodes t ON t.id = nt.tag_id
           AND ${liveTagNodeSql("t")}
         WHERE nt.node_id = $1`,
        [node.id],
      ),
      q<{ key: string; value: string; value_type: string }>(
        `SELECT key, value, value_type
         FROM node_attributes
         WHERE node_id = $1
         ORDER BY key ASC`,
        [node.id],
      ),
    ]);

    const pdfNote = pdfNoteSummary(attrsRes.rows, node.markdown);
    return {
      ...node,
      ...(pdfNote ? { pdf_note: pdfNote } : {}),
      tags: tagsRes.rows,
      // Drawing data (handwriting, the board's pen layer, a note's 手寫 tab, a PDF's older marks) is megabytes of stroke JSON an agent can
      // neither read nor edit through this tool; any note may carry it now, so it never goes into the tool output.
      attributes: agentVisibleAttributes(attrsRes.rows),
      attachments: await Promise.all(bodyMediaIds(node.markdown ?? "").map(describeAttachment)),
    };
  },
};

/** The attributes a tool is shown. Drawing data and the PDF's text are left out; the list of pages is told as a sentence
 *  ("5 pages: blank, PDF 1-3, blank") — also for a note made before it, whose `pdf_url` is one run of every page. */
function agentVisibleAttributes(rows: Array<{ key: string; value: string; value_type: string }>): Array<{ key: string; value: string; value_type: string }> {
  const byKey = new Map(rows.map((a) => [a.key, a.value]));
  const pages = notePagesOf({ note_pages: byKey.get(NOTE_PAGES_ATTR), pdf_url: byKey.get("pdf_url") });
  const out = rows.filter((a) => !isInkPageAttr(a.key) && a.key !== "pdf_annotations" && a.key !== NOTE_PAGES_ATTR && a.key !== PDF_TEXT_ATTR);
  if (pages) out.push({ key: NOTE_PAGES_ATTR, value: summarizeNotePages(pages), value_type: "text" });
  const texts = pdfTextPageCount(byKey.get(PDF_TEXT_ATTR));
  if (texts > 0) out.push({ key: PDF_TEXT_ATTR, value: `text of ${texts} page${texts === 1 ? "" : "s"}`, value_type: "text" });
  return out;
}
