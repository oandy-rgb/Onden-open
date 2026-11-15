// Journey [offline-handwriting] — THE proof for the offline-ink fix.
//
// Before the fix, ink/annotation saves went through a raw `void fetch(...)`
// that bypassed the offline queue, so a stroke drawn offline was lost: not
// queued, not recovered on reconnect. These two compound workflows model a
// person sketching on a phone with no signal:
//
//   1. offline → create a handwriting note → DRAW strokes → TYPE a title →
//      a pending count surfaces (the strokes ARE queued) → reconnect →
//      the server has BOTH the ink_data (with strokes) and the title.
//      (proves Task A: ink saves ride the offline queue.)
//
//   2. offline → draw → RELOAD WHILE STILL OFFLINE → the strokes are still
//      visible (cold-start from the local mirror, not a network GET) →
//      reconnect → the server converges. (proves Task B: ink_data mirror +
//      offline-boot read path.)
//
// Offline is simulated exactly like syncStatus.spec.ts / offline-capture-sync:
// context.setOffline() cuts transport, and we dispatch the window
// "offline"/"online" events the app's connection state flips on. Server reads
// use page.request (honours setOffline) and only run after reconnect.
import { test, expect, type Page } from "@playwright/test";
import { H, ready, expectNoPending, expectOffline, expectOfflineReady, expectOnline, expectPending } from "./helpers";

type Attr = { key: string; value: string };
type InkDoc = {
  version: number;
  strokes: Array<{ id: string; points: number[][] }>;
  erased: Record<string, Array<[number, number]>>;
  page: { width: number };
};

async function fetchInkDoc(page: Page, nodeId: string): Promise<InkDoc | null> {
  const res = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!res.ok()) return null;
  const attrs = (await res.json()) as Attr[];
  const raw = attrs.find((a) => a.key === "ink_data")?.value;
  if (!raw) return null;
  try { return JSON.parse(raw) as InkDoc; } catch { return null; }
}

async function fetchTitle(page: Page, nodeId: string): Promise<string | null> {
  const res = await page.request.get("/api/bootstrap");
  if (!res.ok()) return null;
  const b = await res.json();
  return b.nodes.find((n: { id: string }) => n.id === nodeId)?.title ?? null;
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

async function goOffline(page: Page, context: import("@playwright/test").BrowserContext) {
  await expectOfflineReady(page);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
}

async function goOnline(page: Page, context: import("@playwright/test").BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectOnline(page);
}

// ── 1 — Draw + title OFFLINE, both survive the reconnect drain ──────────────
test("offline handwriting: strokes + title queue and converge on reconnect", { tag: "@critical" }, async ({ page, context }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes");
  await expectOnline(page);
  await expectNoPending(page); // clean queue

  // Create the handwriting note WHILE ONLINE (node-create is a separate
  // concern, already covered by inkNote.spec). We then go offline and exercise
  // the thing under test: the ink save + a title edit while offline.
  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(">handwritten");
  const action = page.locator(".palette-item", { hasText: "New handwritten note" });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).not.toBeNull();
  const nodeId = new URL(page.url()).searchParams.get("node")!;

  // ── Go offline, THEN draw + rename ────────────────────────────────────────
  await goOffline(page, context);

  const pageBox = await page.locator(".pagebook-page").boundingBox();
  expect(pageBox).not.toBeNull();
  const { x, y } = pageBox!;
  await drawStroke(page, [[x + 100, y + 80], [x + 220, y + 110], [x + 340, y + 90]]);
  await drawStroke(page, [[x + 120, y + 180], [x + 260, y + 200], [x + 380, y + 170]]);

  const title = `Offline sketch ${stamp}`;
  await page.locator(".obsidian-title-input").fill(title);
  // Click away from the title so the title autosave (debounced PATCH) commits.
  await page.locator(".ink-note").click({ position: { x: 10, y: 10 } });

  // Both the ink save (debounced ~800ms) and the title PATCH are QUEUED, not
  // sent — the sync chip surfaces a pending count > 0.
  await expectPending(page, { timeout: 10_000 });
  await page.screenshot({ path: "/tmp/pw-output/shots/offline-handwriting-queued.png" });

  // The network GET is dead while offline, so the server has nothing yet —
  // this is the bug-proving moment: pre-fix, the stroke lived only in volatile
  // engine state and would die here.
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length ?? 0, { timeout: 3_000 })
    .toBe(0);

  // ── Reconnect → the queued ink + title drain to the backend ──────────────
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });

  // Server truth: BOTH strokes persisted under ink_data…
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length ?? 0, { timeout: 15_000 })
    .toBe(2);
  const doc = (await fetchInkDoc(page, nodeId))!;
  expect(doc.version).toBe(1);
  expect(doc.strokes[0].points.length).toBeGreaterThan(1);
  // …and the title edit made offline also landed.
  await expect.poll(() => fetchTitle(page, nodeId), { timeout: 15_000 }).toBe(title);
});

// ── 2 — Draw OFFLINE, REMOUNT the ink host STILL OFFLINE → strokes survive ──
// Proves Task B: the ink host's primary read is a network GET of /attributes;
// offline that GET fails, so the host must fall back to the local ink_data
// MIRROR. We trigger a true cold remount of the ink view WITHOUT a full page
// reload — a full reload offline hits the SSR/auth shell (the app can't boot
// the SPA offline through the playwright SW), whereas an in-app node switch is
// exactly the remount a user causes by tapping another note and back. The
// switch is client-side (history pushState + popstate, the app's own router),
// so it stays on the live, authenticated SPA while offline.
test("offline handwriting: a stroke drawn offline survives an offline host remount (mirror cold-start)", async ({ page, context }) => {
  const stamp = Date.now();
  // A second note to bounce to (created online, so it has a real id) — the
  // vehicle for forcing the ink host to UNMOUNT and re-mount. Made before the
  // app boots so its first load has it: one made after reaches the app only by
  // a live update, which can lose the race with going offline.
  const other = await (await page.request.post("/api/nodes", {
    ...H,
    data: { title: `Decoy ${stamp}`, markdown: "# decoy\n\nx" },
  })).json();
  await ready(page, "/?view=notes");
  await expectNoPending(page);

  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(">handwritten");
  const action = page.locator(".palette-item", { hasText: "New handwritten note" });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  const nodeId = new URL(page.url()).searchParams.get("node")!;
  await page.locator(".obsidian-title-input").fill(`Offline cold-start ${stamp}`);

  // ── Go offline, draw, let the debounced save settle into the mirror+queue ─
  await goOffline(page, context);
  const box = (await page.locator(".pagebook-page").boundingBox())!;
  await drawStroke(page, [[box.x + 90, box.y + 90], [box.x + 250, box.y + 130], [box.x + 360, box.y + 100]]);
  await expectPending(page, { timeout: 10_000 });

  // ── Client-side switch AWAY (still offline) → ink host unmounts ───────────
  const navTo = async (id: string) => {
    await page.evaluate((nodeId) => {
      const url = new URL(window.location.href);
      url.searchParams.set("node", nodeId);
      window.history.pushState(null, "", url.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id);
  };
  await navTo(other.id);
  await expect(page.locator(".ink-note")).toHaveCount(0, { timeout: 10_000 });
  await page.locator(".cm-content").waitFor({ state: "visible", timeout: 10_000 });

  // ── …and BACK to the ink note (still offline) → ink host COLD-mounts ─────
  // Its /attributes GET fails offline; the cold-start fallback must read the
  // stroke from the local mirror so the engine re-hydrates the drawing.
  await navTo(nodeId);
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "/tmp/pw-output/shots/offline-handwriting-coldstart.png" });

  // Behavioural proof of the cold-start mirror read: draw a SECOND stroke,
  // still offline. The engine re-serialises its FULL document — if the cold
  // mount had NOT loaded the first stroke from the mirror, the engine booted
  // empty and this save would carry only 1 stroke. After reconnect the server
  // must hold BOTH strokes (the loaded one + the new one).
  const box2 = (await page.locator(".pagebook-page").boundingBox())!;
  await drawStroke(page, [[box2.x + 110, box2.y + 220], [box2.x + 260, box2.y + 250], [box2.x + 380, box2.y + 230]]);

  // ── Reconnect → the queued strokes drain; server converges on TWO ────────
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length ?? 0, { timeout: 15_000 })
    .toBe(2);
});
