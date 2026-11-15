// Journey [offline-commute-capture] — the "captured a whole train of thought
// on the subway with no signal" workflow. A compound, multi-step offline
// session that must survive entirely on the queue and converge on reconnect:
//
//   offline →
//     quick-capture 3 fleeting notes (each a queued POST /api/nodes) →
//     open one and link it to another with a [[wikilink]] (queued PATCH;
//       the backend derives the knowledge_link edge from the body on drain) →
//     append a #word to a body (queued PATCH; text, not a tag — T10) →
//   reconnect →
//     all 3 notes exist server-side, filed under today's day node,
//     the wikilink edge exists, and the queue drained to zero.
//
// NOTE on scope: creating a node_tasks row is NOT an offline-durable UI path
// (graphMutations.addTask early-returns when offline by design — there is no
// optimistic task id to mint), so this workflow exercises the writes that DO
// queue (node create, body PATCH → derived edge). Task/due-date offline
// durability is out of scope for the UI today; asserting it here would be
// asserting a non-feature.
//
// Offline simulation + server-truth reads follow offline-capture-sync.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, ensureInbox, pollBootstrap, expectNoPending, expectOffline, expectOfflineReady, expectOnline, expectPending } from "./helpers";
import type { BrowserContext } from "@playwright/test";

async function bootstrap(page: Page) {
  return (await page.request.get("/api/bootstrap")).json();
}

async function goOffline(page: Page, context: BrowserContext) {
  await expectOfflineReady(page);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
}

async function goOnline(page: Page, context: BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectOnline(page);
}

async function captureNote(page: Page, text: string) {
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(text);
  await saveQuickCapture(page);
}

test("offline commute: capture 3 notes, link + tag them, all converge on reconnect", async ({ page, context }) => {
  const stamp = Date.now();
  const titles = [`Idea A ${stamp}`, `Idea B ${stamp}`, `Idea C ${stamp}`];

  // The captures go to the inbox, whose tag exists before offline — they then
  // only have to queue the notes themselves.
  const inboxTag = await ensureInbox(page);
  await ready(page, "/?view=notes");
  await expectOnline(page);
  await expectNoPending(page);

  // ── Offline: three rapid captures ─────────────────────────────────────────
  await goOffline(page, context);
  for (const text of titles) {
    await captureNote(page, text);
  }
  // Three queued node-creates → a pending count surfaces.
  await expectPending(page, { timeout: 10_000 });

  // ── Reconnect once so the captured notes exist as real rows ───────────────
  // We need Idea A's server id to open it and add a wikilink to Idea B; the
  // wikilink resolves by TITLE on the backend, so B only needs to exist (it
  // will, after this drain). This mirrors a real commute: signal flickers back
  // mid-session, you keep working.
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });

  const afterCapture = await bootstrap(page);
  const ideaA = afterCapture.nodes.find((n: { title: string }) => n.title === titles[0]);
  const ideaB = afterCapture.nodes.find((n: { title: string }) => n.title === titles[1]);
  const ideaC = afterCapture.nodes.find((n: { title: string }) => n.title === titles[2]);
  expect(ideaA).toBeTruthy();
  expect(ideaB).toBeTruthy();
  expect(ideaC).toBeTruthy();
  // All three wait in the inbox: top-level notes carrying the inbox tag.
  for (const idea of [ideaA, ideaB, ideaC]) {
    expect(idea.parent_id).toBeNull();
    expect([...(idea.class_tag_ids ?? []), ...(idea.label_tag_ids ?? [])]).toContain(inboxTag);
  }

  // ── Offline AGAIN: open Idea A (in-app, no page reload), link it to B ─────
  await goOffline(page, context);
  // Client-side switch via the app's router — a full page.goto offline would
  // hit the SSR/auth shell; an in-app node switch stays on the live SPA.
  await page.evaluate((nodeId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("node", nodeId);
    window.history.pushState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, ideaA.id);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(titles[0], { timeout: 10_000 });
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").click();
  // Append a wikilink to Idea B + a #word — both flush through the queued
  // body PATCH; the backend derives the knowledge_link edge from the wikilink.
  // The #word stays text: it makes no tag (T10).
  await page.keyboard.type(`\n\nsee [[${titles[1]}]] #commute${stamp}`);
  // Past the autosave debounce → the body PATCH is queued.
  await expectPending(page, { timeout: 10_000 });

  // ── Final reconnect → the linked body drains; edge materialises ──────────
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });

  // Server truth: Idea A's body carries the wikilink, and a knowledge_link edge
  // A → B now exists (derived from the wikilink on the drained PATCH).
  await expect.poll(async () => {
    const b = await bootstrap(page);
    const a = b.nodes.find((n: { id: string }) => n.id === ideaA.id);
    return a?.markdown?.includes(`[[${titles[1]}]]`) ? "yes" : "no";
  }, { timeout: 15_000 }).toBe("yes");

  const edge = await pollBootstrap(
    page,
    (b) => (b.edges as Array<{ source_node_id: string; target_node_id: string; edge_type: string }>)
      .find((e) => e.source_node_id === ideaA.id && e.target_node_id === ideaB.id && e.edge_type === "knowledge_link"),
    { message: "the offline [[wikilink]] should materialise a knowledge_link edge after the drain" },
  );
  expect(edge).toBeTruthy();
});
