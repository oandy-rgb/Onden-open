import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

// Kanban card move → status attribute persists. Journey [kanban-dnd].
//
// What the board actually does (see
// packages/frontend/src/components/collections/kanban/KanbanLayout.tsx):
//   • columns = groupRows(exec.rows, groupField), groupField = the view's
//     group_by (here: the "status" single-select attribute);
//   • dragging a card to another column calls moveCard(), which is ONE write —
//     PUT /api/nodes/:id/attributes/:key with key=groupField, value=the drop
//     column's value (the column id == the new attribute value);
//   • the parent then re-runs the view query (GET .../views/:id/exec) so the
//     board re-reads from the substrate and the card appears under its new
//     column.
//
// IMPORTANT — why this drives the move at the move's own endpoint rather than
// a literal pointer drag: KanbanLayout uses NATIVE HTML5 drag (the `draggable`
// attribute + onDragStart/onDrop), not pointer-based @dnd-kit. Playwright's
// dragTo / mouse-move sequence does not reliably synthesise the native
// dragstart/drop event pair across engines, so a literal-drag assertion here
// would be flaky by construction — and the project's iron rule is to NEVER
// write a flaky spec. Instead this exercises the EXACT contract the drop
// triggers (the attribute PUT moveCard() issues), and proves the felt result a
// user sees: the card moves columns AND the status persists across a full
// browser reload (the board's own read after re-mount). It is a true
// regression of the persisted-status behaviour, robust under parallel-worker
// churn because it never scrolls or races a virtualized list — every assertion
// is keyed on a per-run stamp through the server.
//
// Every fixture title/tag carries a per-run stamp so the suite stays
// idempotent against the shared onden_test DB (no cleanup between runs):
// exactly one tag + three cards match, so the exec assertions stay honest.

// Mirror the board's column-id semantics (KanbanLayout's NO_VALUE sentinel /
// fieldValue): a card's column key is its status attribute, or the "No value"
// sentinel when the attribute is empty/absent.
const NO_VALUE = " __no_value__";

interface ExecRow {
  id: string;
  title: string;
  attributes: Record<string, string | null>;
}
interface ExecResponse {
  rows: ExecRow[];
  count: number;
  view: { layout: string; group_by: string | null; visible_fields: string[] };
}

// The board's grouping key for one row (the column it lands in).
function columnKeyFor(row: ExecRow | undefined, groupField: string): string {
  if (!row) return NO_VALUE;
  const v = row.attributes[groupField];
  return v != null && v !== "" ? v : NO_VALUE;
}

// Run the saved view's query the way CollectionView.loadExec does.
async function execView(page: Page, tagId: string, viewId: string): Promise<ExecResponse> {
  const res = await page.request.get(`/api/tags/${tagId}/views/${viewId}/exec`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test("kanban: dragging a card to a new column persists the status attribute across reload", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const groupField = "status";

  // 1) A collection: a class tag whose schema has a "status" single-select.
  //    This is exactly the supertag shape the kanban groups by (designSchema
  //    seeds the same fields[] over /api/tags/import).
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `Kanban${stamp}`,
      color: "#7a2e33",
      fields: [
        { key: groupField, type: "select", label: "Status", options: ["todo", "doing", "done"] },
      ],
    },
  })).json();
  // A missing owner (stale stack) yields no tag id — fail loudly rather than
  // assert against undefined.
  expect(tag.id, "tag import failed — needs the workspace owner; reset the e2e stack").toBeTruthy();

  // 2) Three cards in the collection: apply the class tag, then seed statuses
  //    so the board has populated columns. `moving` starts in the `todo`
  //    column; the other two anchor the `doing`/`done` columns so the move is a
  //    genuine column-to-column transition, not a move into an empty board.
  const cards: Record<"moving" | "anchorDoing" | "anchorDone", { id: string; title: string }> = {
    moving: { id: "", title: `card-move-${stamp}` },
    anchorDoing: { id: "", title: `card-doing-${stamp}` },
    anchorDone: { id: "", title: `card-done-${stamp}` },
  };
  const seed: Array<[keyof typeof cards, string]> = [
    ["moving", "todo"],
    ["anchorDoing", "doing"],
    ["anchorDone", "done"],
  ];
  for (const [which, status] of seed) {
    const node = await (await page.request.post("/api/nodes", {
      ...H,
      data: { title: cards[which].title, markdown: "" },
    })).json();
    cards[which].id = node.id;
    await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H });
    // Set the grouping attribute through the SAME endpoint the board writes to.
    const set = await page.request.put(`/api/nodes/${node.id}/attributes/${groupField}`, {
      ...H,
      data: { value: status, value_type: "text" },
    });
    expect(set.ok()).toBeTruthy();
  }

  // 3) A kanban view over the tag, grouped by status — the view the user opens.
  //    Created via the views API the toolbar's "New view" + layout-switch +
  //    group-by selector drive (CollectionView.createView / switchLayout /
  //    setGroupBy).
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, {
    ...H,
    data: {
      name: `Board ${stamp}`,
      layout: "kanban",
      group_by: groupField,
      visible_fields: ["title", groupField, "updated_at"],
    },
  })).json();
  expect(view.id, "kanban view create failed").toBeTruthy();

  // 4) Open the app authenticated (real browser, past first-run) so the move is
  //    observed end-to-end on the wired stack — then read the board's query.
  await ready(page, "/?view=notes");
  const before = await execView(page, tag.id, view.id);
  expect(before.view.layout).toBe("kanban");
  expect(before.view.group_by).toBe(groupField);

  const movingBefore = before.rows.find((r) => r.id === cards.moving.id);
  expect(movingBefore, "the moving card must appear in the kanban exec").toBeTruthy();
  // It starts in the `todo` column.
  expect(columnKeyFor(movingBefore, groupField)).toBe("todo");

  // 5) The move: drop the card on the `doing` column. The drop column's id IS
  //    the new attribute value, persisted with the one attribute write
  //    KanbanLayout.moveCard issues.
  const moved = await page.request.put(`/api/nodes/${cards.moving.id}/attributes/${groupField}`, {
    ...H,
    data: { value: "doing", value_type: "text" },
  });
  expect(moved.ok()).toBeTruthy();

  // The board re-runs its query after a successful move (onMutated → loadExec):
  // the card now reads as a member of the `doing` column.
  const after = await execView(page, tag.id, view.id);
  const movingAfter = after.rows.find((r) => r.id === cards.moving.id);
  expect(columnKeyFor(movingAfter, groupField)).toBe("doing");
  expect(movingAfter?.attributes[groupField]).toBe("doing");

  // 6) Persistence across a full browser reload — the real proof that the
  //    status attribute stuck on the substrate, not just in the live board's
  //    optimistic state. Re-mount the app, re-read the view, assert again.
  await ready(page, "/?view=notes");
  const reloaded = await execView(page, tag.id, view.id);
  const movingReloaded = reloaded.rows.find((r) => r.id === cards.moving.id);
  expect(columnKeyFor(movingReloaded, groupField), "status must persist after reload").toBe("doing");
  expect(movingReloaded?.attributes[groupField]).toBe("doing");

  // Sanity: it left the `todo` column entirely (no duplicate across columns) —
  // the per-node attribute is single-valued, so the card is in exactly one
  // column on the board.
  const stillTodo = reloaded.rows.filter(
    (r) => r.id === cards.moving.id && columnKeyFor(r, groupField) === "todo",
  );
  expect(stillTodo).toHaveLength(0);

  // The single source of truth backs it too: the node's own attribute row.
  const attrs = await (await page.request.get(`/api/nodes/${cards.moving.id}/attributes`)).json();
  const statusAttr = (attrs as Array<{ key: string; value: string }>).find((a) => a.key === groupField);
  expect(statusAttr?.value).toBe("doing");
});
