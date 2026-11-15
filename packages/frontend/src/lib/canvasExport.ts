import { ApiError, nodeNeedsBody, type Canvas, type ContentNode, type NodeEdge } from "./api";
import { toJsonCanvas, type ExportCard } from "./jsonCanvas";
import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "./cardGeometry";
import { reads, WriteActionError } from "./data";
import { t } from "./i18n";
import { drawsInGraph } from "./edgeKinds";
import { decodeInk } from "./ink";
import { BOARD_INK_ATTR, inkToSvgFrame } from "@onden/markdown/ink";

/** Prepare the whole board, independent of focus, search and display density.
 * Capture current layout/loaded text; fetch missing bodies without replacing
 * local notes. Any unavailable member rejects the entire export, never a
 * partial file. Handwriting on the board goes along as one SVG picture
 * (`ink`), not as editable strokes. This is not an atomic server snapshot or a
 * media/ink backup; editor input not yet handed to the note writer is outside this snapshot. */
export async function prepareCanvasExport(canvas: Canvas, nodes: readonly ContentNode[], edges: readonly NodeEdge[]) {
  const title = canvas.title;
  const entries = canvas.data.nodes.map(entry => ({ ...entry }));
  const sections = (canvas.data.sections ?? []).map(section => ({ ...section }));
  const byId = new Map(nodes.map(node => [node.id, { ...node }]));
  // Derived tag/parent connections are not stored edges. The file holds the
  // board's relations ([[link]] arrows and drawn ones), not pending machine
  // suggestions or site navigation (lib/edgeRoles drawsInGraph).
  const links = edges.filter(drawsInGraph)
    .map(edge => ({ id: edge.id, source: edge.source_node_id, target: edge.target_node_id }));
  const cards: ExportCard[] = [];
  for (const entry of entries) {
    let node = byId.get(entry.nodeId);
    if (!node || nodeNeedsBody(node)) {
      try {
        const full = await reads.notes.full(entry.nodeId);
        if (full.id !== entry.nodeId || typeof full.markdown !== "string" || nodeNeedsBody(full) || full.deleted_at) {
          throw new WriteActionError(t("Some cards are unavailable. Refresh the board before exporting."));
        }
        // A loaded local title may include a queued rename. Reading a missing
        // body must not replace that title with an older server value.
        node = node ? { ...node, markdown: full.markdown } : full;
      } catch (error) {
        if (error instanceof ApiError && [403, 404].includes(error.status)) {
          throw new WriteActionError(t("Some cards are unavailable. Refresh the board before exporting."), { cause: error });
        }
        throw error;
      }
    }
    if (node.deleted_at || typeof node.markdown !== "string") {
      throw new WriteActionError(t("Some cards are unavailable. Refresh the board before exporting."));
    }
    cards.push({
      id: entry.nodeId, x: entry.x, y: entry.y,
      width: entry.width ?? DEFAULT_CARD_W, height: entry.height ?? DEFAULT_CARD_H,
      title: node.title, markdown: node.markdown, color: entry.color,
    });
  }
  const base = title.replace(/[^\p{L}\p{N}_-]+/gu, "-") || "board";
  // The strokes sit in board coordinates; the picture is cropped to them and
  // placed at that frame, so on any canvas viewer they land over the same cards.
  const { [BOARD_INK_ATTR]: boardInk } = await reads.notes.attributeValues(canvas.id, [BOARD_INK_ATTR]);
  const decoded = decodeInk(boardInk);
  const frame = decoded.kind === "page" ? inkToSvgFrame(decoded.doc) : null;
  const inkFile = `${base}-ink.svg`;
  return {
    filename: `${base}.canvas`,
    canvas: toJsonCanvas(cards, sections, links, frame ? { file: inkFile, x: frame.x, y: frame.y, width: frame.width, height: frame.height } : undefined),
    /** Set when the board has handwriting: the picture the .canvas names, so
     *  the download is a zip (lib/canvasArchive.ts) instead of one file. */
    ink: frame ? { file: inkFile, svg: frame.svg } : null,
    archiveName: `${base}.zip`,
  };
}
