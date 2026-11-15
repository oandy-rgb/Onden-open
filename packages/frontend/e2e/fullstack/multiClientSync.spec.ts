// Cross-tab / multi-client SYNC consistency — the system-level convergence
// contract that no other spec covers end to end. Onden is local-first with a
// server source of truth; two clients (separate browser contexts = separate
// OPFS/worker, same authenticated workspace) MUST converge.
//
// HOW B LEARNS OF A's CHANGE (the mechanism this suite exercises):
//   server commits a domain_event
//     → realtime.ts coalesces (COALESCE_MS=250) and flushes the SSE stream
//       `GET /api/events/stream` as `data: {"kind":"changed","latest":<id>}`
//       (backend: routes/events.ts:120, services/realtime.ts:26-32)
//     → the client's EventSource (lib/liveEvents.ts:78,
//       `${apiBase}/api/events/stream`, withCredentials) fires onChanged
//     → BuilderApp wires onChanged → `void sync()` (BuilderApp.tsx:383-386)
//     → useAppData.sync() flushes pending writes then pulls the delta
//       `GET /api/sync?since=<lastEventId>` (useAppData.ts:207-239,
//       backend routes/sync.ts:9) and merges it into the store via
//       applySyncDelta — no reload, no navigation.
// There is no fixed poll while SSE is open (60s fallback only); convergence is
// SSE-driven, so the test waits on the SSE→sync→store path, never sleeps.
//
// COMMUTATIVE MERGE (memory: attrs per-key LWW / tags grow-set): the substrate
// is event-sourced, so two clients touching DIFFERENT facets of one node both
// land — A sets an attribute (PUT /api/nodes/:id/attributes/:key), B applies a
// tag (PUT /api/nodes/:id/tags/:tagId); neither clobbers the other.
//
// ASSERTION STRATEGY: server truth is read back through each client's OWN
// `page.request` (so we prove THAT client's session converged, and — because
// page.request honours context.setOffline — every read happens only while that
// client is online). The forward-propagation case ALSO asserts B's live UI
// (.sb-item-title from B's in-memory store) the way liveUpdates.spec.ts does,
// proving the SSE→store path, not just the database.
//
// Rerun-safe against the shared onden_test DB: every fixture title/tag carries
// a per-test stamp so exactly one row ever matches under parallel workers.
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, ensureInbox, openSidebarSearch, BASE, H, expectNoPending, expectOffline, expectOfflineReady, expectOnline, expectPending } from "./helpers";

const STATE = process.env.E2E_STORAGE || "/tmp/pw-auth.json";

// Two INDEPENDENT contexts on the same owner account (same storageState =
// same cookies = same workspace; separate OPFS/worker = genuinely separate
// clients). Mirrors liveUpdates.spec.ts's twoSessions.
async function twoClients(browser: Browser): Promise<{
  ctxA: BrowserContext; pageA: Page; ctxB: BrowserContext; pageB: Page;
}> {
  const ctxA = await browser.newContext({ baseURL: BASE, storageState: STATE });
  const ctxB = await browser.newContext({ baseURL: BASE, storageState: STATE });
  return { ctxA, pageA: await ctxA.newPage(), ctxB, pageB: await ctxB.newPage() };
}

// Poll a client's OWN bootstrap until `pick` is satisfied. Local copy of the
// helper rather than helpers.pollBootstrap so a per-message timeout fits each
// scenario; same contract (no fixed sleep on the sync round-trip).
async function pollClientBootstrap<T>(
  page: Page,
  pick: (b: { nodes: ContentNodeRow[] }) => T | undefined,
  message: string,
  timeout = 20_000,
): Promise<T> {
  let found: T | undefined;
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/bootstrap");
      if (!res.ok()) return undefined;
      found = pick(await res.json());
      return found;
    }, { timeout, message })
    .toBeTruthy();
  return found as T;
}

type ContentNodeRow = {
  id: string;
  title: string;
  markdown?: string;
  parent_id?: string | null;
  label_tag_ids?: string[];
  class_tag_ids?: string[];
  attrs?: Record<string, string>;
};

// ── 1. Forward propagation: A creates+edits+tags, B sees it (UI + server) ────
test("a node created, retitled and tagged in client A propagates to client B", async ({ browser }) => {
  const { ctxA, pageA, ctxB, pageB } = await twoClients(browser);
  try {
    const stamp = Date.now();
    const finalTitle = `MultiSync A→B ${stamp}`;
    const tagName = `synced-${stamp}`;

    // B is just sitting in the app, watching — it must not already know the row.
    await ready(pageB);
    const search = await openSidebarSearch(pageB);
    await search.click();
    await search.pressSequentially(String(stamp));
    await expect(search).toHaveValue(String(stamp));
    await expect(pageB.locator(".sb-item-title", { hasText: String(stamp) })).toHaveCount(0);

    // A creates a node, then edits its title (PATCH) and applies a #tag.
    // Done through A's authenticated request session (its EditorSelection /
    // SSE machinery is irrelevant to what B receives — B converges off the
    // committed events regardless of how A authored them).
    const created = await (await pageA.request.post("/api/nodes", {
      ...H, data: { title: `tmp ${stamp}`, markdown: `body ${stamp}` },
    })).json();
    await pageA.request.patch(`/api/nodes/${created.id}`, { ...H, data: { title: finalTitle } });
    // Resolve-or-create the tag (POST /api/tags/resolve-path → leaf_id), then
    // apply it (PUT /api/nodes/:id/tags/:tagId) — the same two calls the tag UI
    // makes; tags are class_tag nodes, the applied edge is a node_tags row.
    const resolved = await (await pageA.request.post("/api/tags/resolve-path", {
      ...H, data: { path: tagName },
    })).json();
    const tagId: string = resolved.leaf_id;
    const applied = await pageA.request.put(`/api/nodes/${created.id}/tags/${tagId}`, { ...H, data: {} });
    expect(applied.ok()).toBeTruthy();

    // B's LIVE UI reflects it with no reload: the SSE "changed" tick drove
    // B's sync() which pulled the delta into B's store, which feeds the
    // sidebar search results (.sb-item-title). Generous timeout = coalesce
    // (~250ms) + round-trip + slack. Re-fill keeps the query live across the
    // debounce in case the first fill landed before the row existed in-store.
    await search.fill("");
    await search.click();
    await search.pressSequentially(finalTitle);
    await expect(search).toHaveValue(finalTitle);
    await expect(pageB.locator(".sb-item-title", { hasText: String(stamp) }))
      .toBeVisible({ timeout: 20_000 });

    // ...and B's OWN session truly holds the merged row: the retitle AND the
    // applied tag (label_tag_ids carries the class_tag id — sync.ts ships the
    // same node shape as bootstrap, so a synced node arrives fully tagged).
    const row = await pollClientBootstrap(
      pageB,
      (b) => b.nodes.find((n) => n.id === created.id),
      "client B should receive the node created in client A",
    );
    expect(row.title).toBe(finalTitle);
    expect(row.label_tag_ids ?? []).toContain(tagId);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── 2. Concurrent edits to DIFFERENT facets converge (no lost update) ────────
test("concurrent edits from A (attribute) and B (tag) both survive the merge", async ({ browser }) => {
  const { ctxA, pageA, ctxB, pageB } = await twoClients(browser);
  try {
    const stamp = Date.now();
    const tagName = `converge-${stamp}`;

    // A shared node both clients will touch — created up front so both sessions
    // start from the same base. Land both UIs so each runs a live sync loop.
    const node = await (await pageA.request.post("/api/nodes", {
      ...H, data: { title: `Converge ${stamp}`, markdown: `base ${stamp}` },
    })).json();
    await ready(pageA);
    await ready(pageB);

    // Resolve the tag id first (creating the tag is itself a node A will also
    // converge on — fine), then fire the two facet edits "concurrently":
    //   A → sets attribute `priority` (PUT /api/nodes/:id/attributes/priority,
    //       per-key LWW — nodes.ts:815)
    //   B → applies the tag (PUT /api/nodes/:id/tags/:tagId, grow-set —
    //       nodes.ts:1058)
    // Different facets ⇒ commutative ⇒ neither write is lost.
    const resolved = await (await pageA.request.post("/api/tags/resolve-path", {
      ...H, data: { path: tagName },
    })).json();
    const tagId: string = resolved.leaf_id;

    const [attrRes, tagRes] = await Promise.all([
      pageA.request.put(`/api/nodes/${node.id}/attributes/priority`, {
        ...H, data: { value: `high-${stamp}`, value_type: "text" },
      }),
      pageB.request.put(`/api/nodes/${node.id}/tags/${tagId}`, { ...H, data: {} }),
    ]);
    expect(attrRes.ok()).toBeTruthy();
    expect(tagRes.ok()).toBeTruthy();

    // The merged truth, as seen by EACH client's own session after it syncs:
    // both the attribute AND the tag are present on the one node. (If either
    // write clobbered the other, one of these would be missing.)
    for (const [label, page] of [["A", pageA], ["B", pageB]] as const) {
      const row = await pollClientBootstrap(
        page,
        (b) => {
          const n = b.nodes.find((x) => x.id === node.id);
          if (!n) return undefined;
          const hasAttr = n.attrs?.priority === `high-${stamp}`;
          const hasTag = (n.label_tag_ids ?? []).includes(tagId);
          return hasAttr && hasTag ? n : undefined;
        },
        `client ${label} should converge with BOTH the attribute and the tag (no lost update)`,
      );
      expect(row.attrs?.priority).toBe(`high-${stamp}`);
      expect(row.label_tag_ids ?? []).toContain(tagId);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── 3. Offline A → queue → reconnect → drain → B sees it ─────────────────────
test("a change made while client A is offline reaches client B after A reconnects", async ({ browser }) => {
  const { ctxA, pageA, ctxB, pageB } = await twoClients(browser);
  try {
    const stamp = Date.now();
    // Edit the BODY, not the title: the title lives in a separate
    // `.obsidian-title-input`, while `.cm-content` is the markdown body. The
    // body autosave (OverviewEditorHost.onSave → saveOverviewDraft →
    // saveNoteBody → PATCH /api/nodes/:id {markdown, base_markdown}, 1.5s debounce
    // in draftActions.ts:49) is the queued write we assert propagated.
    const marker = `offline-body-${stamp}`;

    // Seed a node ONLINE first (so its row already exists everywhere), then
    // bring up A's editor on it so the offline edit goes through the real
    // autosave→queue path, exactly like syncStatus/offline-capture specs.
    const node = await (await pageA.request.post("/api/nodes", {
      ...H, data: { title: `Pre-offline ${stamp}`, markdown: `# pre\n\nbody ${stamp}` },
    })).json();
    await pageA.goto(`/?view=notes&node=${node.id}`, { waitUntil: "load" });
    await pageA.locator(".cm-content").waitFor({ state: "visible" });
    await expectOnline(pageA);
    await ready(pageB);

    const bodyHas = (b: { nodes: ContentNodeRow[] }) =>
      b.nodes.find((n) => n.id === node.id)?.markdown?.includes(marker) ?? false;

    // B confirms it does NOT yet hold the offline marker.
    await expect.poll(
      async () => bodyHas(await (await pageB.request.get("/api/bootstrap")).json()),
      { message: "B must not see the offline body edit before A reconnects" },
    ).toBe(false);

    // A goes offline (setOffline cuts transport; dispatch the window event the
    // app keys its own online-state off of). page.request also honours
    // setOffline, so any server read on A is deferred until back online.
    await ctxA.setOffline(true);
    await pageA.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expectOffline(pageA);
    // Append a unique marker line to the body the way a user types — autosave
    // can't reach the server, so the PATCH is queued instead of sent.
    await pageA.locator(".cm-content").click();
    await pageA.keyboard.press("Control+End");
    await pageA.keyboard.type(`\n\n${marker}`);
    // Past the 1.5s autosave debounce the write hits the queue → pending chip.
    await expectPending(pageA, { timeout: 10_000 });

    // B still hasn't seen it (the write is stuck in A's offline queue).
    expect(bodyHas(await (await pageB.request.get("/api/bootstrap")).json())).toBe(false);

    // A reconnects → handleOnline drains the queue (flushPendingWrites) then
    // syncs; the drain commits the queued edit server-side. Chip empties.
    await ctxA.setOffline(false);
    await pageA.evaluate(() => window.dispatchEvent(new Event("online")));
    await expectNoPending(pageA, { timeout: 20_000 });

    // B now converges on the offline-authored body via its SSE→sync path —
    // proven through B's own bootstrap (B's session received it).
    const row = await pollClientBootstrap(
      pageB,
      (b) => (b.nodes.find((n) => n.id === node.id)?.markdown?.includes(marker) ? b.nodes.find((n) => n.id === node.id) : undefined),
      "B should see A's offline body edit after A reconnects and drains",
    );
    expect(row.markdown).toContain(marker);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── 4. Cross-tab drain lock: two tabs of ONE context don't double-apply ──────
test("two tabs sharing one context drain a queued write exactly once", async ({ browser }) => {
  // SAME context ⇒ SAME OPFS pending_writes queue shared across both tabs, and
  // the drain is serialised by `withCrossTabLock("onden-pending-drain", …)`
  // (useAppData.ts:159-171) backed by navigator.locks; the client-minted
  // Idempotency-Key (flushPendingWrites, useAppData.ts:180) shields any replay
  // that does slip through. The contract: a single queued CREATE produces
  // exactly ONE node, never one-per-tab.
  const ctx = await browser.newContext({ baseURL: BASE, storageState: STATE });
  const tab1 = await ctx.newPage();
  const tab2 = await ctx.newPage();
  try {
    const stamp = Date.now();
    const title = `CrossTabDrain ${stamp}`;

    // Both tabs land on the app (each mounts useAppData → both wire window
    // online/offline handlers and both share the OPFS queue). The capture goes
    // to the inbox, so its tag exists first.
    await ensureInbox(tab1);
    await ready(tab1, "/?view=notes");
    await ready(tab2, "/?view=notes");
    await expectOnline(tab1);
    await expectOnline(tab2);

    // Go offline on the whole context (affects both tabs), tell both tabs, and
    // queue ONE create from tab1 via the quick-capture path so it enters the
    // SHARED pending_writes queue once.
    await expectOfflineReady(tab1);
    await ctx.setOffline(true);
    await tab1.evaluate(() => window.dispatchEvent(new Event("offline")));
    await tab2.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expectOffline(tab1);
    await expectOffline(tab2);

    // Queue the single offline create from tab1's quick capture (the helper
    // polls until the capture listener is attached, avoiding the mount race).
    await openQuickCapture(tab1);
    await tab1.locator(".quick-capture-textarea").fill(title);
    await saveQuickCapture(tab1);
    // tab1's chip surfaces the queued write (its own usePendingWrites bumped on
    // queue). tab2 shares the SAME OPFS pending_writes row, but its counter only
    // refreshes on its own queue/online events — so we don't assert tab2's chip
    // here; the single-node count after the racing drain is the real contract.
    await expectPending(tab1, { timeout: 10_000 });

    // Reconnect: fire the online event in BOTH tabs at once so they RACE to
    // drain the same queued write — the cross-tab lock + idempotency key must
    // make that converge to a single committed node.
    await ctx.setOffline(false);
    await Promise.all([
      tab1.evaluate(() => window.dispatchEvent(new Event("online"))),
      tab2.evaluate(() => window.dispatchEvent(new Event("online"))),
    ]);
    // Both tabs' chips drain back to bare (the queue emptied once).
    await expectNoPending(tab1, { timeout: 20_000 });
    await expectNoPending(tab2, { timeout: 20_000 });

    // EXACTLY ONE node with this unique title exists server-side — no
    // double-apply from the two racing drains. Poll until the drained node
    // appears, then assert the count is precisely 1.
    await expect.poll(
      async () => {
        const b = await (await tab1.request.get("/api/bootstrap")).json();
        return (b.nodes as ContentNodeRow[]).filter((n) => n.title === title).length;
      },
      { timeout: 20_000, message: "the queued create should drain to exactly one node" },
    ).toBe(1);
  } finally {
    await ctx.close();
  }
});
