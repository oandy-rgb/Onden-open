import { test, expect, type Page } from "@playwright/test";
import { createAgent, acceptAgentSuggestions, ready, defaultSpaceId, moveToSpace, H } from "./helpers";

// Ink on the knowledge canvas — the full journey:
// named canvas → pen mode (P) → draw → board_ink persists on the CANVAS NODE
// (spine ATTRIBUTE_SET; mig 172 moved the board's pen layer off ink_data,
// which is the note's handwriting page — docs/architecture/ink-attributes.md) → zoom/pan → second stroke lands in DIFFERENT model
// coords (proves the React Flow viewport is injected as the engine's
// transform) → reload → both persist → eraser → erasedIntervals non-empty.
//
// The committed layer is the tiled Canvas 2D renderer; the test reads which
// one is live from the layer's data-ink-renderer attribute.
//
// Rerun-safe: a fresh stamped canvas per run on the shared onden_test DB.


type Attr = { key: string; value: string };
type InkDoc = {
  version: number;
  strokes: Array<{ id: string; points: number[][] }>;
  erased: Record<string, Array<[number, number]>>;
  page: { width: number };
};

/** The board's pen layer lives in `board_ink`; `ink_data` is the note's
 *  handwriting page ("Content" tab) and must stay untouched by board strokes. */
async function fetchInkDoc(page: Page, nodeId: string, key: "board_ink" | "ink_data" = "board_ink"): Promise<InkDoc | null> {
  const res = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!res.ok()) return null;
  const attrs = (await res.json()) as Attr[];
  const raw = attrs.find((a) => a.key === key)?.value;
  if (!raw) return null;
  try { return JSON.parse(raw) as InkDoc; } catch { return null; }
}

/** Board strokes never leak into the handwriting page (the pre-172 bug turned
 *  the Content tab into a handwriting page after drawing on the board). */
async function expectNoHandwritingInk(page: Page, nodeId: string) {
  expect(await fetchInkDoc(page, nodeId, "ink_data")).toBeNull();
}

/** P → pen mode. The board's key handler only arms once the board id and the
 *  handwriting module are known (useCanvasTools: no board → P does nothing),
 *  so a press right after navigation can land before that; P only ever turns
 *  the pen ON, so pressing again until the toolbar shows is safe. */
async function pressPen(page: Page) {
  const toolbar = page.locator(".canvas-ink-toolbar");
  await expect(async () => {
    if (!(await toolbar.isVisible().catch(() => false))) await page.keyboard.press("p");
    await expect(toolbar).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Drag a polyline with the mouse (pointerType "mouse" → simulated pressure). */
async function drawStroke(page: Page, points: Array<[number, number]>) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y, { steps: 8 });
  }
  await page.mouse.up();
}

function range(points: number[][]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

test("canvas ink: pen mode, viewport-synced strokes, persistence, eraser", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium-scoped: WebGL/SwiftShader (fallback path still asserted)");
  const stamp = Date.now();

  // ── Named canvas via API (canvas = node since mig 057), then open it ──────
  const canvasRes = await page.request.post("/api/canvases", { ...H, data: { title: `Ink ${stamp}` } });
  expect(canvasRes.ok()).toBeTruthy();
  const canvas = (await canvasRes.json()) as { id: string };

  await ready(page, `/?view=notes&node=${canvas.id}`);

  // ── P → pen mode: toolbar appears, ink layer boots (tiled Canvas 2D) ─────
  await pressPen(page);
  const layer = page.locator(".canvas-ink-layer");
  await expect(layer).toBeVisible();
  await expect.poll(() => layer.getAttribute("data-ink-renderer"), { timeout: 15_000 })
    .toMatch(/^canvas2d$/);
  const rendererKind = await layer.getAttribute("data-ink-renderer");
  console.log(`[inkCanvas] active committed renderer: ${rendererKind}`);

  // ── Stroke 1 across the pane ──────────────────────────────────────────────
  const box = (await layer.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await drawStroke(page, [[cx - 120, cy - 40], [cx, cy - 10], [cx + 120, cy - 30]]);

  await expect.poll(async () => (await fetchInkDoc(page, canvas.id))?.strokes.length ?? 0, {
    timeout: 10_000,
  }).toBe(1);
  const afterOne = (await fetchInkDoc(page, canvas.id))!;
  expect(afterOne.version).toBe(1);
  const r1 = range(afterOne.strokes[0].points);
  // Plausible model coords: a fresh empty canvas sits near the default
  // viewport, so the stroke must land within a sane band, with real extent.
  expect(Number.isFinite(r1.minX) && Number.isFinite(r1.minY)).toBeTruthy();
  expect(r1.maxX - r1.minX).toBeGreaterThan(50);
  expect(Math.abs(r1.cx)).toBeLessThan(10_000);
  expect(Math.abs(r1.cy)).toBeLessThan(10_000);

  // ── Zoom (ctrl+wheel over the pen layer) + pan (space-drag), stroke 2 ─────
  // Zoom OUT: an empty canvas opens AT maxZoom (fitView over empty bounds
  // clamps to the limit), so zooming in from here is a no-op — only outward
  // headroom exists.
  await page.mouse.move(cx, cy);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 400); // zoom out around the cursor
  await page.keyboard.up("Control");
  await page.keyboard.down(" "); // spacebar-pan: layer releases the pointer
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy + 110, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up(" ");

  // Same SCREEN gesture as stroke 1 → must land in DIFFERENT model coords.
  await drawStroke(page, [[cx - 120, cy - 40], [cx, cy - 10], [cx + 120, cy - 30]]);
  await expect.poll(async () => (await fetchInkDoc(page, canvas.id))?.strokes.length ?? 0, {
    timeout: 10_000,
  }).toBe(2);
  const afterTwo = (await fetchInkDoc(page, canvas.id))!;
  const r2 = range(afterTwo.strokes[1].points);
  // Zoomed out → the same 240px screen span covers a larger model span…
  expect(r2.maxX - r2.minX).toBeGreaterThan((r1.maxX - r1.minX) + 5);
  // …and the pan/zoom moved the model-space center (transform injection).
  expect(Math.abs(r2.cx - r1.cx) + Math.abs(r2.cy - r1.cy)).toBeGreaterThan(10);

  // ── Reload → both strokes persist; layer re-boots from board_ink ─────────
  // NOT networkidle: the app holds a persistent SSE connection (see helpers.ts
  // ready()), so networkidle never fires on app pages — only on /site/* pages.
  await page.reload({ waitUntil: "load" });
  await ready(page, `/?view=notes&node=${canvas.id}`);
  const reloaded = await fetchInkDoc(page, canvas.id);
  expect(reloaded?.strokes.length).toBe(2);
  await expectNoHandwritingInk(page, canvas.id);
  // Canvas carries ink → the committed renderer boots WITHOUT pen mode.
  await expect.poll(() => page.locator(".canvas-ink-layer").getAttribute("data-ink-renderer"), {
    timeout: 15_000,
  }).toMatch(/^canvas2d$/);

  // ── P → eraser (toolbar) → drag across stroke 1's path ───────────────────
  // Fresh default viewport after reload (empty board → fitView no-op), so
  // stroke 1's model coords ≈ its original pane coords: cross it vertically.
  await pressPen(page);
  await page.locator(".canvas-ink-toolbar .ink-tool-btn[title='Eraser']").click();
  const box2 = (await page.locator(".canvas-ink-layer").boundingBox())!;
  const ex = box2.x + box2.width / 2;
  const ey = box2.y + box2.height / 2;
  // Retry the erase gesture until it lands: the workspace re-runs an ANIMATED
  // fitView ~60ms after mount (KnowledgeWorkspace), so a drag inside that
  // window maps to moving model coords and can miss the stroke. Erasing is
  // additive-only (dead ranges, never new strokes), so repeating is safe.
  await expect(async () => {
    await drawStroke(page, [[ex, ey - 90], [ex, ey + 50]]);
    const doc = await fetchInkDoc(page, canvas.id);
    expect(doc ? Object.keys(doc.erased).length : 0).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  // Interval erase never deletes strokes — both survive with dead ranges.
  const final = await fetchInkDoc(page, canvas.id);
  expect(final?.strokes.length).toBe(2);
});

// ── Composite helpers (shared by the journey tests below) ───────────────────

/** Single-board era: a board opens by focusing its node. */
async function openCanvasNode(page: Page, canvasId: string) {
  await ready(page, `/?view=notes&node=${canvasId}`);
}

/** Wait until the ink layer is live FOR THE GIVEN CANVAS. After a tab click
 *  the previous canvas's layer (with its stale data-ink-renderer) lingers
 *  until activeCanvasId flips and the keyed remount boots a fresh engine —
 *  drawing in that window is silently dropped, so gate on data-ink-canvas
 *  BEFORE trusting data-ink-renderer. */
async function inkReady(page: Page, canvasId: string) {
  const layer = page.locator(`.canvas-ink-layer[data-ink-canvas="${canvasId}"]`);
  await expect.poll(() => layer.getAttribute("data-ink-renderer"), {
    timeout: 15_000,
  }).toMatch(/^canvas2d$/);
}

/** Enter pen mode if it isn't already on (pen state is workspace-level, so it
 *  survives a canvas-tab switch). */
async function enterPen(page: Page, canvasId: string) {
  await pressPen(page);
  await inkReady(page, canvasId);
}

async function expectStrokes(page: Page, nodeId: string, n: number) {
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length ?? 0, {
    timeout: 10_000,
  }).toBe(n);
}

/** Agent actor + bearer token (inboxGovernance pattern). Null when the e2e
 *  user isn't admin — callers skip. */
async function agentHeaders(page: Page, name: string) {
  const agent = await createAgent(page.request, name);
  return { actorId: agent.id, headers: agent.headers };
}

/** versions[0] carries the POST-edit body (NODE_UPDATED payload.body_hash). */
async function latestVersionBody(page: Page, nodeId: string): Promise<string> {
  const versions = (await (await page.request.get(`/api/nodes/${nodeId}/versions`)).json()) as Array<{ markdown: string }>;
  return versions[0]?.markdown ?? "";
}

// ── Composite 2: the ink workday — undo/redo, switch-flush, isolation ───────
// One sitting, two canvases: draw → undo → redo on A (each state PERSISTS, not
// just renders), hop to B (unmount must flush the debounced save), draw there,
// and prove the two ink docs never bleed into each other. Returning to A boots
// the committed renderer from board_ink without entering pen mode.
test("ink journey: undo/redo persist, canvas-switch flush, per-canvas isolation", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium-scoped: WebGL/SwiftShader (fallback path still asserted)");
  const stamp = Date.now();
  const a = (await (await page.request.post("/api/canvases", { ...H, data: { title: `InkA ${stamp}` } })).json()) as { id: string };
  const b = (await (await page.request.post("/api/canvases", { ...H, data: { title: `InkB ${stamp}` } })).json()) as { id: string };

  await openCanvasNode(page, a.id);
  await enterPen(page, a.id);
  const box = (await page.locator(".canvas-ink-layer").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await drawStroke(page, [[cx - 100, cy - 60], [cx + 100, cy - 60]]);
  await drawStroke(page, [[cx - 100, cy + 60], [cx + 100, cy + 60]]);
  await expectStrokes(page, a.id, 2);

  // Undo removes the LAST stroke — and the undone doc persists to the node.
  await page.keyboard.press("Control+z");
  await expectStrokes(page, a.id, 1);
  // Redo brings it back, and that persists too.
  await page.keyboard.press("Control+Shift+z");
  await expectStrokes(page, a.id, 2);

  // Hop to B. A's unmount flushes any pending save; B starts blank (no bleed).
  await openCanvasNode(page, b.id);
  await enterPen(page, b.id);
  await drawStroke(page, [[cx - 80, cy], [cx + 80, cy + 20]]);
  await expectStrokes(page, b.id, 1);
  await expectStrokes(page, a.id, 2); // A untouched by B's session

  // Back to A: ink boots WITHOUT pen interaction (the canvas carries ink).
  await openCanvasNode(page, a.id);
  await expect.poll(() => page.locator(".canvas-ink-layer").getAttribute("data-ink-renderer"), {
    timeout: 15_000,
  }).toMatch(/^canvas2d$/);
  expect((await fetchInkDoc(page, a.id))!.strokes.length).toBe(2);
  await expectNoHandwritingInk(page, a.id);
  await expectNoHandwritingInk(page, b.id);
});

// ── Composite 3: canvas = node — body and ink are independent channels ──────
// Since mig 057 a canvas IS a content node, so its markdown body and its
// board_ink attribute live on the SAME row. A body edit must never clobber the
// drawing (the PATCH side-effect chain syncs frontmatter attributes — board_ink
// must survive it), whether the editor is the human (PATCH) or an agent (MCP
// updateNode, same spine). And the reverse: an ink save must never roll the
// body back.
test("canvas=node: body edits (human + agent) never clobber ink, ink saves never clobber the body", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium-scoped: WebGL/SwiftShader (fallback path still asserted)");
  const stamp = Date.now();
  const canvas = (await (await page.request.post("/api/canvases", { ...H, data: { title: `InkBody ${stamp}` } })).json()) as { id: string };
  // The agent below edits the body: move the board out of the personal space.
  await moveToSpace(page.request, canvas.id, await defaultSpaceId(page.request));
  // Make the agent before the page opens: adding it to 共用 changes that
  // space's members, and the open app answers a membership change with its
  // fail-closed check (.membership-gate over the page for a moment), which
  // swallows a stroke drawn meanwhile.
  const agentH = await agentHeaders(page, `ink-agent-${stamp}`);

  await openCanvasNode(page, canvas.id);
  await enterPen(page, canvas.id);
  const box = (await page.locator(".canvas-ink-layer").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await drawStroke(page, [[cx - 90, cy - 30], [cx + 90, cy + 10]]);
  await expectStrokes(page, canvas.id, 1);
  const inkBefore = (await fetchInkDoc(page, canvas.id))!;
  const strokeIds = inkBefore.strokes.map((s) => s.id);

  // Human edits the canvas node's body through the ordinary PATCH route.
  const patched = await page.request.patch(`/api/nodes/${canvas.id}`, { ...H, data: { markdown: `human notes ${stamp}` } });
  expect(patched.ok()).toBeTruthy();
  expect((await fetchInkDoc(page, canvas.id))!.strokes.map((s) => s.id)).toEqual(strokeIds);

  // Agent rewrites the body via MCP updateNode. A new agent's edit is a
  // suggestion until the person accepts it (2026-10-30); accepting writes the
  // agent's text through the same spine mutate() path.
  const upd = await page.request.post("/api/mcp/tools/updateNode", {
    headers: agentH.headers,
    data: { args: { id: canvas.id, markdown: `AGENT body ${stamp}`, base_markdown: `human notes ${stamp}` } },
  });
  expect(upd.ok()).toBeTruthy();
  expect(await acceptAgentSuggestions(page.request, canvas.id)).toBe(1);
  await expect.poll(() => latestVersionBody(page, canvas.id)).toContain(`AGENT body ${stamp}`);
  expect((await fetchInkDoc(page, canvas.id))!.strokes.map((s) => s.id)).toEqual(strokeIds);

  // Reverse direction: a NEW stroke (board_ink ATTRIBUTE_SET) must not touch
  // the body — the agent's text stays the latest version.
  await enterPen(page, canvas.id);
  await drawStroke(page, [[cx - 60, cy + 70], [cx + 60, cy + 90]]);
  await expectStrokes(page, canvas.id, 2);
  expect(await latestVersionBody(page, canvas.id)).toContain(`AGENT body ${stamp}`);
  await expectNoHandwritingInk(page, canvas.id);
});
