import type { ContentNode } from "../../lib/api";
import { t } from "../../lib/i18n";
import { getAppState, addToast } from "../../lib/appStore";
import { reads, taskWriter, canvasWriter, drafts, noteStructure } from "../../lib/data";
import { extractReviewCards, cardBody, planCardPlacements } from "./reviewExtract";
import { makeReviewCards } from "./reviewCard";
import { todayId } from "../../lib/localDate";
import { shellFeatureOnIn } from "../../lib/shellFeatures";

import { cutToUnits } from "@onden/markdown";
// 抓題 (⑥ composite learning flow): extract the focused 講義's Q:/A: blocks
// into CHILD notes that are review cards — they enter the FSRS queue and live
// under the lecture in the tree (立體化: cards grow in the structure, not a
// separate deck). The lecture body is untouched; re-running skips questions
// that already exist as children (idempotent by title). All through the
// normal create/tag APIs — evented, inbox-reviewable, agent-parity (an
// agent writes Q: lines into the note; extraction is mechanical).
export async function extractCardsFromNote(node: ContentNode): Promise<number> {
  // Read this note's own text: its saved draft when the editor shows it.
  const rewrite = await drafts.beginRewrite(node);
  if (!rewrite) return 0;
  const { body } = rewrite;
  const all = extractReviewCards(body);
  if (all.length === 0) {
    addToast(t("No Q:/A: blocks found — write questions as `Q:` lines with `A:` answers"), "info");
    return 0;
  }
  const existingChildren = getAppState().data.nodes.filter((n) => n.parent_id === node.id);
  const existing = new Set(existingChildren.map((n) => (n.title ?? "").trim()));
  const fresh = all.filter((c2) => !existing.has(c2.question));
  // A card from an earlier run is matched by title and would be skipped forever; every card of this lecture, new or old, is made a
  // card on the server (a note that already is one answers "unchanged"), so a run that failed half-way is finished by running it again.
  const questions = new Set(all.map((c2) => c2.question));
  const earlier = existingChildren.filter((n) => questions.has((n.title ?? "").trim()));
  const createdIds = await noteStructure.run(async (submit) => noteStructure.createChildren(submit, node.id, fresh.map((card) => ({
    title: cutToUnits(card.question, 300), markdown: cardBody(card, node.title ?? "")
  }))));
  if (!createdIds) return 0;
  const { changed, failed } = await makeReviewCards([...createdIds, ...earlier.map((n) => n.id)]);
  if (failed > 0) addToast(t("{n} cards could not be made review cards yet. Run it again when you are online.", { n: failed }), "error");
  if (fresh.length === 0) {
    if (failed === 0) addToast(changed > 0 ? t("Made {n} existing notes review cards", { n: changed }) : t("All {n} cards already extracted", { n: all.length }), changed > 0 ? "success" : "info");
    return changed;
  }
  // 講義 task+due (⑥ front of the flow): the freshly-made deck is something
  // to DO — drop a study task on the lecture due today (new cards are due
  // immediately, so "today" is honest, not arbitrary), surfaced on the
  // agenda. Idempotent: skip if the lecture already carries an open study
  // task. Best-effort — a task failure must not undo the extraction.
  const studyTitle = t("Study: {title}", { title: node.title ?? "" });
  const state = getAppState();
  const hasOpenStudyTask = (state.data.tasks ?? []).some(
    (tk) => tk.node_id === node.id && tk.title === studyTitle
      && tk.status !== "done" && tk.status !== "cancelled",
  );
  if (!hasOpenStudyTask) {
    // Through the task writer (in the store at once, queued offline); a
    // failure is reported once and does not undo the extraction.
    await taskWriter.create(node.id, studyTitle, { when: todayId() }).catch(() => null);
  }
  // 立體化: if the lecture sits on a board, land the new cards next to it
  // (two-column grid right of the anchor). Best-effort — a placement
  // failure must not undo the extraction; the cards still live in the tree.
  // Only while the whiteboard is imported (module library): its boards are
  // hidden otherwise, and a board nobody can see is no place to point to.
  const boardsShown = shellFeatureOnIn(state.data.workspace?.modules, "whiteboard");
  const membership = boardsShown ? (state.data.canvas_memberships ?? []).find((m) => m.node_id === node.id) : undefined;
  if (membership) {
    try {
      const canvas = await reads.modules.review.canvas<{ data?: { nodes?: Array<{ nodeId: string; x: number; y: number; width?: number }> } }>(
        membership.canvas_id,
      );
      const entries = canvas.data?.nodes ?? [];
      const additions = planCardPlacements(entries, node.id, createdIds);
      // Each card joins the board's latest layout through the canvas writer
      // (ordered per board, queued offline, rolled back on refusal), so a card
      // added or moved meanwhile on this device is kept.
      for (const { nodeId, ...at } of additions) {
        await canvasWriter.place(membership.canvas_id, nodeId, at);
      }
      addToast(t("Extracted {n} review cards — placed on “{board}”", { n: fresh.length, board: membership.canvas_title }), "success");
      return fresh.length;
    } catch {
      // fall through to the plain toast
    }
  }
  addToast(t("Extracted {n} review cards", { n: fresh.length }), "success");
  return fresh.length;
}
