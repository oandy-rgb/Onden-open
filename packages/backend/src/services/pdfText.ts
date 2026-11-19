// The text of a note's PDF pages (attribute `pdf_text`, `{ [pageKey]: text }`): hidden, never the body. The server's text search does not
// read it yet (nothing writes it before the step that adds PDF files, which brings the index and the query plan with it); what reads it in
// code — the semantic index, the short form a tool sees — goes through here.

import { PDF_TEXT_ATTR } from "@onden/markdown/contract";
import { db } from "../dbKysely.js";

function pageTexts(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.values(parsed).filter((text): text is string => typeof text === "string");
  } catch {
    return [];
  }
}

/** The page texts of a stored `pdf_text` value as one text, a page per line; "" for no text or a value that is not a page map. */
const pdfTextPlain = (value: string | null | undefined): string => pageTexts(value).join("\n");

/** How many pages a stored `pdf_text` value has text for. */
export const pdfTextPageCount = (value: string | null | undefined): number => pageTexts(value).length;

/** A note's PDF text as one text, read inside the caller's transaction when there is one ("" when it has none). */
export async function pdfTextOf(workspaceId: string, nodeId: string): Promise<string> {
  const row = await db.selectFrom("node_attributes").select("value")
    .where("workspace_id", "=", workspaceId).where("node_id", "=", nodeId).where("key", "=", PDF_TEXT_ATTR).executeTakeFirst();
  return pdfTextPlain(row?.value);
}
