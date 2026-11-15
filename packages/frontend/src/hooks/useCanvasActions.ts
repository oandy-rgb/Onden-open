import { randomUUID } from "../lib/uuid";
import type { Dispatch, DragEvent, SetStateAction } from "react";
import { type Bootstrap, type Canvas, type CanvasData } from "../lib/api";
import { graphPositionWriter, noteWriter, runBackgroundWrite, WriteActionError, uploadMedia, writersFor, writeErrors } from "../lib/data";
import { addToast } from "../lib/appStore";
import { nodeActions } from "../lib/data";
import { boardSpaceId } from "../lib/boardLayout";
import { computeTreeLayout } from "../lib/treeLayout";
import type { CardDisplaySettings } from "../lib/cardDisplay";
import { boundingSectionRect, type CardPosition, type CanvasBounds } from "../lib/sectionCarry";
import { t } from "../lib/i18n";
import { ensureWhiteboardTab } from "../lib/whiteboardTab";
import { writeBoardTreeSettings } from "./useBoardTreeSettings";
import { DEFAULT_CARD_H, DEFAULT_CARD_W, arrangedSlot } from "../lib/cardGeometry";

const importWriters = writersFor({ notify: () => {} });
const importNotes = importWriters.note;
const importRelations = importWriters.relation;

// Canvas geometry and graph actions. Layout writes share the canvas writer's
// acceptance/rollback contract; note creation places cards through that writer
// separately, so it can retain its original board across asynchronous creation.

const NO_DISPLAY: CardDisplaySettings = {};

type Params = {
  data: Bootstrap;
  online: boolean;
  selectedId: string | null;
  activeCanvas: Canvas | null;
  saveCanvasData: (id: string, data: CanvasData) => Promise<unknown> | void;
  placeCanvasNode: (canvasId: string, nodeId: string, position?: { x: number; y: number }) => Promise<void>;
  /** Place a note that already exists (picker, drop); reminds the person first if some of the board's people can't see it. */
  placeExistingNote: (canvasId: string, nodeId: string, position?: { x: number; y: number }) => Promise<boolean>;
  selectCanvas: (id: string | null) => Promise<unknown> | void;
  createCanvas: (title: string) => Promise<Canvas | null>;
  setCanvasNavStack: Dispatch<SetStateAction<string[]>>;
  /** How the board draws its cards: a folded card is short, so a group framed around it is too. */
  display?: CardDisplaySettings;
};

export function useCanvasActions({
  data,
  online,
  selectedId,
  activeCanvas,
  saveCanvasData,
  placeCanvasNode,
  placeExistingNote,
  selectCanvas,
  createCanvas,
  setCanvasNavStack,
  display = NO_DISPLAY,
}: Params) {
  async function saveNodePosition(nodeId: string, x: number, y: number) {
    const rx = Math.round(x); const ry = Math.round(y);
    if (activeCanvas) {
      const newNodes = activeCanvas.data.nodes.map((cn) =>
        cn.nodeId === nodeId ? { ...cn, x: rx, y: ry } : cn,
      );
      await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes });
      return;
    }
    // Global graph mode (no canvas) — persist placement to node_positions on
    // the 'graph' surface (migration 050). This replaces the old `_graph_x` /
    // `_graph_y` reserved-attribute writes, which the attributes route now
    // rejects (400) so re-arranged graph layouts were silently lost. The
    // writer shows the position at once so the drag does not snap back.
    await graphPositionWriter.place(nodeId, rx, ry);
  }

  async function handleNodeResized(nodeId: string, { x, y, width, height }: CanvasBounds) {
    if (!activeCanvas) return;
    const newNodes = activeCanvas.data.nodes.map((cn) =>
      cn.nodeId === nodeId ? { ...cn, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : cn,
    );
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes });
  }

  /** 重設大小: the cards go back to the default size (their position stays). */
  async function handleCardSizeReset(nodeIds: readonly string[]) {
    if (!activeCanvas) return;
    const reset = new Set(nodeIds);
    const newNodes = activeCanvas.data.nodes.map(({ width: _w, height: _h, ...card }) => reset.has(card.nodeId) ? card : { ...card, ...(_w != null ? { width: _w } : {}), ...(_h != null ? { height: _h } : {}) });
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes });
  }

  async function handleOpenSubCanvas(nodeId: string) {
    if (!activeCanvas) return;
    if (!online) {
      // Adding the note's whiteboard tab is a write that needs the server; say so instead of doing nothing.
      addToast(t("Opening a nested board needs a connection."), "info");
      return;
    }
    const entry = activeCanvas.data.nodes.find((item) => item.nodeId === nodeId);
    // Push the current canvas onto the nav stack BEFORE switching so the
    // breadcrumb / back button has somewhere to return to. Avoids accidental
    // re-push when navigating between the same two canvases.
    setCanvasNavStack((prev) => prev[prev.length - 1] === activeCanvas.id ? prev : [...prev, activeCanvas.id]);
    if (entry?.subCanvasId) {
      await selectCanvas(entry.subCanvasId);
      return;
    }

    // The card's note is the sub-board: its own whiteboard tab, added when it has none.
    // No second note is made for it, and the card keeps no link of its own to follow.
    await ensureWhiteboardTab(nodeId);
    await selectCanvas(nodeId);
  }

  async function goBackToParentCanvas() {
    setCanvasNavStack((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice(0, -1);
      runBackgroundWrite(selectCanvas(prev[prev.length - 1] ?? null));
      return next;
    });
  }

  async function handleSectionResized(sectionId: string, { x, y, width, height }: CanvasBounds) {
    if (!activeCanvas) return;
    const newSections = (activeCanvas.data.sections ?? []).map((s) =>
      s.id === sectionId ? { ...s, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : s,
    );
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, sections: newSections });
  }

  async function handleSectionTitleChange(sectionId: string, title: string) {
    if (!activeCanvas) return;
    const newSections = (activeCanvas.data.sections ?? []).map((s) =>
      s.id === sectionId ? { ...s, title } : s,
    );
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, sections: newSections });
  }

  async function handleCreateSection(x: number, y: number) {
    if (!activeCanvas) return;
    const newSection = { id: randomUUID(), x: Math.round(x), y: Math.round(y), width: 400, height: 280, title: t("New group") };
    const newSections = [...(activeCanvas.data.sections ?? []), newSection];
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, sections: newSections });
  }

  // 群組框: frame the given cards with a new section (group-the-selection).
  async function groupCardsIntoSection(cardIds: string[]) {
    if (!activeCanvas || cardIds.length === 0) return;
    const members = activeCanvas.data.nodes.filter((cn) => cardIds.includes(cn.nodeId));
    if (members.length === 0) return;
    const rect = boundingSectionRect(members, display);
    const newSection = { id: randomUUID(), ...rect, title: t("New group") };
    await saveCanvasData(activeCanvas.id, {
      ...activeCanvas.data,
      sections: [...(activeCanvas.data.sections ?? []), newSection],
    });
  }

  async function handleRemoveFromCanvas(nodeId: string) {
    if (!activeCanvas) return;
    const newNodes = activeCanvas.data.nodes.filter((cn) => cn.nodeId !== nodeId);
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes });
  }

  async function handleSetNodeColor(nodeId: string, color: string | null) {
    if (!activeCanvas) return;
    const newNodes = activeCanvas.data.nodes.map((cn) =>
      cn.nodeId === nodeId ? { ...cn, color: color ?? undefined } : cn,
    );
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes });
  }

  // Colour every selected card in ONE save (the align bar's batch swatch) —
  // looping handleSetNodeColor would reload the board per card and race.
  async function handleSetNodesColor(nodeIds: string[], color: string | null) {
    if (!activeCanvas || nodeIds.length === 0) return;
    const ids = new Set(nodeIds);
    const newNodes = activeCanvas.data.nodes.map((cn) =>
      ids.has(cn.nodeId) ? { ...cn, color: color ?? undefined } : cn,
    );
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes });
  }

  // Same rename rail as the sidebar: optimistic, mirrored locally, queued offline.
  async function handleNodeTitleChange(nodeId: string, title: string) {
    await nodeActions.rename(nodeId, title);
  }

  // Auto-arrange the active canvas as a horizontal tree (mindmap layout).
  // Heptabase / Miro / Mindvas convention: one-shot, user-triggered. After
  // running, the user can drag freely and the result sticks; tapping the
  // action again wipes manual positions and recomputes. Root is the
  // currently selected node, falling back to the canvas's first card.
  // Cards not part of the rooted subtree are left where they are so the
  // user doesn't lose loose annotations / notes that happen to sit on the
  // same board.
  async function autoArrangeCanvasAsTree() {
    if (!activeCanvas || activeCanvas.data.nodes.length === 0) return;
    const rootId = selectedId && activeCanvas.data.nodes.some((cn) => cn.nodeId === selectedId)
      ? selectedId
      : activeCanvas.data.nodes[0].nodeId;
    const positions = computeTreeLayout(rootId, data.nodes);
    const repositioned = activeCanvas.data.nodes.map((cn) => {
      const pos = positions.get(cn.nodeId);
      return pos ? { ...cn, x: Math.round(pos.x + 80), y: Math.round(pos.y + 80) } : cn;
    });
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: repositioned });
  }

  // Re-layout every card on the active canvas into a generous-gap grid.
  // Preserves the visual reading order (top-down, left-right) so cards
  // don't teleport across the board, but enforces consistent breathing
  // room so a previously-cramped layout becomes browsable.
  //
  // Heptabase's "Tidy Up" inspired the affordance; ours is dumber (no
  // section / cluster awareness, just a 3-column grid) which is fine for
  // dogfood and trivial to upgrade later when section semantics matter.
  async function tidyActiveCanvas() {
    if (!activeCanvas) return;
    const sorted = [...activeCanvas.data.nodes].sort((a, b) => {
      // Same row tolerance — within half a card height, treat as "same
      // row" and sort left-to-right; otherwise top-down.
      const dy = (a.y ?? 0) - (b.y ?? 0);
      if (Math.abs(dy) > DEFAULT_CARD_H / 2) return dy;
      return (a.x ?? 0) - (b.x ?? 0);
    });
    const repositioned = sorted.map((cn, i) => ({ ...cn, ...arrangedSlot(i) }));
    await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: repositioned });
  }

  // Where should a freshly added card land on the active canvas? When the
  // caller has a real drop point (mouse position), use it. Otherwise find
  // a non-overlapping spot to the right of the existing cards so multiple
  // quick-creates in a row don't stack on (0, 0).
  function nextCanvasSpawnPos(flowPos?: { x: number; y: number }): { x: number; y: number } {
    if (flowPos && (flowPos.x !== 0 || flowPos.y !== 0)) {
      return { x: Math.round(flowPos.x), y: Math.round(flowPos.y) };
    }
    const cards = activeCanvas?.data.nodes ?? [];
    if (cards.length === 0) return { x: 100, y: 100 };
    // Land at the rightmost edge of existing cards + a gap. Vertically
    // align to the topmost card so new spawns trail across the top
    // rather than march off-screen down.
    const rightmost = cards.reduce((acc, cn) => {
      const r = (cn.x ?? 0) + (cn.width ?? DEFAULT_CARD_W);
      return r > acc ? r : acc;
    }, 0);
    const topmost = cards.reduce((acc, cn) => Math.min(acc, cn.y ?? 0), Infinity);
    return { x: Math.round(rightmost + 60), y: Math.round(Number.isFinite(topmost) ? topmost : 100) };
  }

  // Add an existing node to the active canvas (if any) at a smart spawn
  // position. Used by quickCreate flows so a new + Note / handwriting page / PDF
  // immediately becomes visible on the canvas the user is looking at,
  // rather than vanishing into the sidebar.
  async function addToActiveCanvas(nodeId: string): Promise<boolean> {
    if (!activeCanvas) return false;
    return placeExistingNote(activeCanvas.id, nodeId);
  }

  // A drag, alignment or inverse owns a fixed position set. Save it once,
  // keeping current dimensions/decoration and ignoring removed cards. Missing
  // groups refuse the entire write; a partial inverse must not look complete.
  async function applyCanvasPositions(updates: Array<{ nodeId: string; x: number; y: number }>, sections: CardPosition[] = []) {
    if (updates.length === 0 && sections.length === 0) return;
    if (sections.some(position => !activeCanvas?.data.sections?.some(section => section.id === position.id))) {
      throw new WriteActionError(t("This section is no longer on the canvas."));
    }
    if (activeCanvas) {
      const map = new Map(updates.map((u) => [u.nodeId, u]));
      const newNodes = activeCanvas.data.nodes.map((cn) => {
        const u = map.get(cn.nodeId);
        return u ? { ...cn, x: Math.round(u.x), y: Math.round(u.y) } : cn;
      });
      const sectionMap = new Map(sections.map(s => [s.id, s]));
      const newSections = activeCanvas.data.sections?.map(section => {
        const position = sectionMap.get(section.id);
        return position ? { ...section, x: Math.round(position.x), y: Math.round(position.y) } : section;
      });
      await saveCanvasData(activeCanvas.id, { ...activeCanvas.data, nodes: newNodes, ...(newSections ? { sections: newSections } : {}) });
      return;
    }
    for (const u of updates) await saveNodePosition(u.nodeId, u.x, u.y);
  }

  // ⑦ JSON Canvas import: parse a .canvas file (jsoncanvas.org), create a
  // note per text/link/file node through the normal API (spine-evented,
  // inbox-reviewable like any create), then one canvas with all placements +
  // sections, then the knowledge edges. Returns the new canvas id.
  // Validate everything before the first write. These requests are still not
  // one transaction: later failures propagate and must not mean "nothing was
  // created" or trigger an automatic full retry.
  // Cards and links go through the note and relation writers (client ids,
  // Idempotency-Keys, store + mirror at once) on a quiet context: the import
  // dialog reports a failure once, as "import stopped, some content may exist".
  async function importJsonCanvas(title: string, raw: unknown): Promise<string | null> {
    // Loaded on use: only importing an Obsidian canvas file needs the parser (offline-warmed in lib/offlineWarmup).
    const { fromJsonCanvas } = await import("../lib/jsonCanvas");
    const parsed = fromJsonCanvas(raw);
    const canvas = await createCanvas(title);
    if (!canvas) return null;
    const idMap = new Map<string, string>();
    for (const card of parsed.cards) {
      const { node } = await importNotes.create({ id: randomUUID(), title: card.title, markdown: card.markdown });
      idMap.set(card.key, node.id);
    }
    await saveCanvasData(canvas.id, {
      nodes: parsed.cards.map((c) => ({
        nodeId: idMap.get(c.key)!,
        x: Math.round(c.x), y: Math.round(c.y),
        ...(c.width ? { width: Math.round(c.width) } : {}),
        ...(c.height ? { height: Math.round(c.height) } : {}),
        ...(c.color ? { color: c.color } : {}),
      })),
      sections: parsed.sections.map((s2, i) => ({
        id: `imported-${i}-${Math.random().toString(36).slice(2, 8)}`,
        x: Math.round(s2.x), y: Math.round(s2.y),
        width: Math.round(s2.width), height: Math.round(s2.height),
        title: s2.title,
        ...(s2.color ? { color: s2.color } : {}),
      })),
    });
    for (const l of parsed.links) {
      const src = idMap.get(l.fromKey); const tgt = idMap.get(l.toKey);
      if (!src || !tgt) continue;
      await importRelations.connect(src, tgt, "knowledge_link");
    }
    // The file's cards are the board: it shows only them, never its own note's
    // sub-note tree. Said outright, because the board was empty when it opened
    // and an empty board starts following its sub-notes (useBoardTree).
    await writeBoardTreeSettings(canvas.id, { mode: "manual" });
    if (parsed.skippedGroupLinks) {
      addToast(t("{n} connections to groups were not imported.", { n: parsed.skippedGroupLinks }), "info");
    }
    // Navigation is the CALLER's job (canvas-as-node: BuilderApp opens the
    // board via setSelectedId) — selectCanvas here raced the caller's view
    // switch and the selection fell back to the day note.
    return canvas.id;
  }

  // Upload each dropped image to /api/media, mint a note whose body is the
  // image (so it renders as a filled image card — see lib/cardBody), and place
  // it on the active board. Multiple images cascade so they don't stack. A
  // failed upload is reported (it used to be skipped silently, GAP-176); the
  // other images still land.
  async function dropImagesAsCards(files: File[], flowPos?: { x: number; y: number }) {
    if (!activeCanvas) return;
    // The board dropped on, even if another opens while the uploads run.
    const boardId = activeCanvas.id;
    let pos = nextCanvasSpawnPos(flowPos);
    const placed: Array<{ nodeId: string; x: number; y: number }> = [];
    for (const file of files) {
      try {
        const url = await uploadMedia(file);
        const title = file.name.replace(/\.[^.]+$/, "") || "Image";
        const { node } = await noteWriter.create({ id: randomUUID(), title, markdown: `![${title}](${url})`, space_id: boardSpaceId(data.nodes, boardId) });
        placed.push({ nodeId: node.id, ...pos });
        pos = { x: pos.x + 28, y: pos.y + 28 };
      } catch (error) {
        writeErrors.report(error, addToast);
      }
    }
    // Each card joins the board's latest layout (placeCanvasNode), so moves and
    // additions made while the uploads ran are kept.
    for (const { nodeId, x, y } of placed) await placeCanvasNode(boardId, nodeId, { x, y });
  }

  /** Files dropped on the board: pictures become image cards. Notes are not dragged from the sidebar with
   *  the browser's drag and drop (the sidebar drags by pointer), so only files arrive here. */
  async function handleGraphDrop(e: DragEvent, flowPos?: { x: number; y: number }) {
    e.preventDefault();
    // Read files synchronously — the event's dataTransfer is invalid after an await. Offline, the upload
    // fails and is reported like paste and Insert do.
    const droppedImages = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (droppedImages.length > 0) await dropImagesAsCards(droppedImages, flowPos);
  }

  return {
    saveNodePosition,
    handleNodeResized,
    handleCardSizeReset,
    handleOpenSubCanvas,
    goBackToParentCanvas,
    handleSectionResized,
    handleSectionTitleChange,
    handleCreateSection,
    groupCardsIntoSection,
    handleRemoveFromCanvas,
    handleSetNodeColor,
    handleSetNodesColor,
    handleNodeTitleChange,
    autoArrangeCanvasAsTree,
    tidyActiveCanvas,
    addToActiveCanvas,
    applyCanvasPositions,
    importJsonCanvas,
    handleGraphDrop,
    dropImagesAsCards,
  };
}
