// Placing an EXISTING note on a board whose space has people who cannot see that note.
//
// A card is a pointer (docs/architecture/canvas-as-view.md): the server leaves out cards and links
// the reader cannot see, so the board's other members just get fewer cards. They must not be told
// "N hidden" (that would leak), so only the person placing is reminded, with the same confirmation
// as dragging the note to another space (components/MoveToSpaceConfirm). The answer comes from
// spaceApi.previewMove (who would gain sight of the note in the board's space): the server's rule,
// not a second one here. Entry: `chooseNotesToPlace`, called by the one placement owner
// (hooks/useBoardWorkspace `placeExistingNote`). Decision: docs/agents/decisions-ui.md.
import { ApiError, type ContentNode } from "./api";
import { addToast, getNode } from "./appStore";
import { publishCardAudienceReview, type AudienceChoice } from "./cardAudienceGate";
import { t } from "./i18n";
import { loadedSpaces, spaceApi, spaceLabel, type MovePreviewNumericEpoch } from "./spaces";

function mergePreviews(previews: MovePreviewNumericEpoch[]): MovePreviewNumericEpoch {
  const [first] = previews;
  if (previews.length === 1) return first!;
  const union = (pick: (p: MovePreviewNumericEpoch) => MovePreviewNumericEpoch["gain"]) => {
    const seen = new Map<string, MovePreviewNumericEpoch["gain"][number]>();
    for (const p of previews) for (const m of pick(p)) seen.set(m.id, m);
    return [...seen.values()];
  };
  return {
    ...first!,
    // The summary reads 「this note and N under it」: N counts the notes under the cards, not the cards.
    notes: 1 + previews.reduce((sum, p) => sum + p.notes - 1, 0),
    gain: union((p) => p.gain),
    lose: union((p) => p.lose),
  };
}

// One reminder at a time: a second placement waits for the first answer, so two slow previews never
// replace each other's screen (the first promise would never settle).
let queue: Promise<unknown> = Promise.resolve();

/** Of `nodeIds` about to be placed on `boardId`, those that should go on: the ones everybody who
 *  sees the board can see, plus the hidden ones when the person says 「照樣放」 or moves them into the
 *  board's space first (done by the confirmation; if only some moved, only those). Cancel: none.
 *  A look that fails because the person is offline never blocks placing; a refusal (they may not
 *  move it there) still places, with a plain notice, since no move can be offered. */
export function chooseNotesToPlace(boardId: string, nodeIds: readonly string[]): Promise<string[]> {
  const result = queue.then(() => review(boardId, nodeIds));
  queue = result.catch(() => undefined);
  return result;
}

async function review(boardId: string, nodeIds: readonly string[]): Promise<string[]> {
  const boardSpaceId = getNode(boardId)?.space_id;
  const to = boardSpaceId ? loadedSpaces().find((space) => space.id === boardSpaceId) : undefined;
  if (!to) return [...nodeIds];
  const candidates = nodeIds.map((id) => getNode(id))
    .filter((n): n is ContentNode => !!n && !!n.space_id && n.space_id !== to.id);
  let refused = false;
  const looks = await Promise.all(candidates.map((node) => spaceApi.previewMove(node.id, to.id).then(
    (preview) => ({ node, preview }),
    (error) => { if (error instanceof ApiError && error.status === 403) refused = true; return null; },
  )));
  // Someone sees the board but not this note ⇔ moving it there would show it to more people (a helper alone is no one to tell).
  const hidden = looks.filter((look): look is { node: ContentNode; preview: MovePreviewNumericEpoch } => !!look && look.preview.gain.some((m) => m.type !== "agent"));
  if (hidden.length === 0) {
    if (refused) addToast(t("Placed. Some people on the board may not be able to see this card."), "info");
    return [...nodeIds];
  }

  const { choice, moved } = await new Promise<{ choice: AudienceChoice; moved: number }>((resolve) => {
    publishCardAudienceReview({
      to,
      hidden: hidden.map(({ node, preview }) => ({ node, from: fromLabel(preview.from) })),
      preview: mergePreviews(hidden.map((look) => look.preview)),
      answer: (picked, movedCount = 0) => { publishCardAudienceReview(null); resolve({ choice: picked, moved: movedCount }); },
    });
  });
  if (choice === "cancel") return [];
  // The notes move in the order shown and stop at the first failure.
  const stayedBehind = choice === "move" ? new Set(hidden.slice(moved).map((h) => h.node.id)) : new Set<string>();
  return nodeIds.filter((id) => !stayedBehind.has(id));
}

function fromLabel(from: MovePreviewNumericEpoch["from"]): string {
  return spaceLabel(loadedSpaces().find((space) => space.id === from.id) ?? { ...from, is_default: false });
}
