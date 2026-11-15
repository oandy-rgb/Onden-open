// Feature-audit deepening (2026-10-08): CAN-07 — semantic links: duplicate,
// self-link, missing / trashed / unreadable endpoints for a second human,
// edge kinds from the manifest, and the canvas UI (drag a connection, delete
// it from the edge menu, rejection rollback). Card moves must not touch edges.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, seedLayout, addToDefaultSpace, BASE, H, PAGE } from "../fullstack/helpers";


test("CAN-07: semantic edges — API edges, scope, canvas UI", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  // Default space: the second human below must read A/B (not ESecret).
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, space_id: shared } })).json()).id as string;
  const edge = (data: Record<string, unknown>, req = page.request) => req.post("/api/edges", { ...H, data });
  const edgesOf = async (id: string) => {
    const boot = await (await page.request.get("/api/bootstrap?slim=1")).json();
    return ((boot.edges ?? []) as Array<{ id: string; source_node_id: string; target_node_id: string; edge_type: string; status: string }>)
      .filter((e) => e.source_node_id === id || e.target_node_id === id);
  };
  const A = await mk(`EA ${stamp}`), B = await mk(`EB ${stamp}`), C = await mk(`EC ${stamp}`);
  try {
  // ── API matrix ──────────────────────────────────────────────────────────
  const e1 = await edge({ source_node_id: A, target_node_id: B, edge_type: "knowledge_link" });
  const e1j = await e1.json();
  const e2 = await edge({ source_node_id: A, target_node_id: B, edge_type: "knowledge_link", id: crypto.randomUUID() });
  const e2j = await e2.json();
  out.duplicate = JSON.stringify({ s: `${e1.status()}/${e2.status()}`, sameId: e1j.id === e2j.id, count: (await edgesOf(A)).filter((e) => e.target_node_id === B && e.edge_type === "knowledge_link").length });
  const rev = await edge({ source_node_id: B, target_node_id: A, edge_type: "knowledge_link" });
  out.reverse = `${rev.status()} total=${(await edgesOf(A)).length}`;
  const self = await edge({ source_node_id: C, target_node_id: C, edge_type: "knowledge_link" });
  out.selfLoop = `${self.status()} ${(await self.text()).slice(0, 80)}`;
  out.missingTarget = `${(await edge({ source_node_id: A, target_node_id: "00000000-0000-4000-8000-000000000000", edge_type: "knowledge_link" })).status()}`;
  out.missingSource = `${(await edge({ source_node_id: "00000000-0000-4000-8000-000000000000", target_node_id: A, edge_type: "knowledge_link" })).status()}`;
  const manifest = await (await page.request.get("/api/edges/manifest")).json();
  const kinds = ((manifest.types ?? manifest) as Array<{ kind: string; planned?: boolean }>).map((k) => `${k.kind}${k.planned ? "(planned)" : ""}`);
  out.manifest = kinds.join(",");
  const kindResults: string[] = [];
  for (const k of ((manifest.types ?? manifest) as Array<{ kind: string }>).map((x) => x.kind)) kindResults.push(`${k}=${(await edge({ source_node_id: A, target_node_id: C, edge_type: k })).status()}`);
  out.everyKind = kindResults.join(" ");
  for (const [k, v] of Object.entries({ unregistered: "made_up_kind", upper: "Bad-Kind", empty: "", long: "a".repeat(65) })) out[`kind_${k}`] = String((await edge({ source_node_id: A, target_node_id: C, edge_type: v })).status());
  out.statusSuggested = String((await edge({ source_node_id: B, target_node_id: C, edge_type: "knowledge_link", status: "suggested" })).status());
  out.statusBogus = String((await edge({ source_node_id: B, target_node_id: C, edge_type: "knowledge_link", status: "deleted" })).status());
  // Trashed endpoint.
  const T = await mk(`ETrash ${stamp}`);
  const toT = await (await edge({ source_node_id: A, target_node_id: T, edge_type: "knowledge_link" })).json();
  await page.request.delete(`/api/nodes/${T}`, { headers: PAGE });
  out.edgeToTrashedVisible = String((await edgesOf(A)).some((e) => e.id === toT.id));
  out.createToTrashed = String((await edge({ source_node_id: A, target_node_id: T, edge_type: "related" })).status());
  await page.request.post(`/api/nodes/${T}/undelete`, { ...H, data: {} });
  out.edgeAfterUndelete = String((await edgesOf(A)).some((e) => e.id === toT.id));
  out.deleteMissing = String((await page.request.delete(`/api/edges/00000000-0000-4000-8000-000000000000`, { headers: PAGE })).status());
  out.deleteBadId = String((await page.request.delete(`/api/edges/not-a-uuid`, { headers: PAGE })).status());

  // ── Second human (editor): both ends must be readable ───────────────────
  const S = await mk(`ESecret ${stamp}`);
  await hideFromOthers(page.request, S);
  const ownerSE = await (await edge({ source_node_id: S, target_node_id: A, edge_type: "knowledge_link" })).json();
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C07 ${stamp}`, email: `c07-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `C07 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  out.editorToSecret = String((await edge({ source_node_id: A, target_node_id: S, edge_type: "knowledge_link" }, human.request)).status());
  out.editorFromSecret = String((await edge({ source_node_id: S, target_node_id: B, edge_type: "knowledge_link" }, human.request)).status());
  const hb = await (await human.request.get("/api/bootstrap?slim=1")).json();
  out.editorSeesSecretEdge = String(((hb.edges ?? []) as Array<{ id: string }>).some((e) => e.id === ownerSE.id));
  out.editorDeleteSecretEdge = `${(await human.request.delete(`/api/edges/${ownerSE.id}`, { headers: PAGE })).status()} stillThere=${(await edgesOf(A)).some((e) => e.id === ownerSE.id)}`;
  out.editorDeleteOwnersEdge = String((await human.request.delete(`/api/edges/${e1j.id}`, { headers: PAGE })).status());
  await human.close();

  // ── Canvas UI ───────────────────────────────────────────────────────────
  const U1 = await mk(`UA ${stamp}`), U2 = await mk(`UB ${stamp}`);
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C07Board ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [{ nodeId: U1, x: 40, y: 60, width: 240 }, { nodeId: U2, x: 420, y: 60, width: 240 }], edges: [] } } });
  const openBoard = async (p: Page) => { await ready(p, `/?view=notes&node=${cv.id}`); await p.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await p.waitForTimeout(800); };
  await openBoard(page);
  const posts: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/edges") && r.method() === "POST") posts.push(r.postData() ?? ""); });
  const drag = async (fromTitle: string, toTitle: string) => {
    const srcCard = page.locator(".react-flow__node", { hasText: fromTitle });
    const dstCard = page.locator(".react-flow__node", { hasText: toTitle });
    await srcCard.hover();
    const sb = await srcCard.locator(".react-flow__handle-right").first().boundingBox();
    const db = await dstCard.locator(".react-flow__handle-left").first().boundingBox();
    if (!sb || !db) return "no-handle";
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move((sb.x + db.x) / 2, (sb.y + db.y) / 2, { steps: 8 });
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    return "dragged";
  };
  out.uiDrag = await drag(`UA ${stamp}`, `UB ${stamp}`);
  out.uiDragResult = JSON.stringify({ posts: posts.map((p) => JSON.parse(p).edge_type), server: (await edgesOf(U1)).map((e) => `${e.edge_type}:${e.source_node_id === U1 ? "U1→U2" : "U2→U1"}`), rendered: await page.locator(".react-flow__edge").count() });
  // Same connection again: no duplicate.
  await drag(`UA ${stamp}`, `UB ${stamp}`);
  out.uiDragAgain = JSON.stringify({ posts: posts.length, server: (await edgesOf(U1)).length, rendered: await page.locator(".react-flow__edge").count() });
  // Moving a card must not change edges.
  const before = JSON.stringify(await edgesOf(U1));
  const card = page.locator(".react-flow__node", { hasText: `UB ${stamp}` });
  const cb = await card.boundingBox();
  if (cb) { await page.mouse.move(cb.x + 30, cb.y + 12); await page.mouse.down(); await page.mouse.move(cb.x + 30, cb.y + 160, { steps: 10 }); await page.mouse.up(); }
  await page.waitForTimeout(2000);
  out.moveKeepsEdges = String(JSON.stringify(await edgesOf(U1)) === before);
  // Rejected create (403): the drawn edge must disappear.
  const U3 = await mk(`UC ${stamp}`);
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [{ nodeId: U1, x: 40, y: 60, width: 240 }, { nodeId: U2, x: 420, y: 60, width: 240 }, { nodeId: U3, x: 40, y: 380, width: 240 }], edges: [] } } });
  await openBoard(page);
  await page.route("**/api/edges", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const edgesBefore = await page.locator(".react-flow__edge").count();
  await drag(`UC ${stamp}`, `UB ${stamp}`);
  await page.waitForTimeout(1000);
  out.uiReject = JSON.stringify({ before: edgesBefore, after: await page.locator(".react-flow__edge").count(), server: (await edgesOf(U3)).length, toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 140) });
  await page.unroute("**/api/edges");
  // Delete through the edge context menu.
  if (await page.locator(".react-flow__edge").count()) {
    await page.locator(".react-flow__edge-interaction, .react-flow__edge path").first().click({ button: "right", force: true }).catch(() => {});
    await page.waitForTimeout(500);
    out.edgeMenu = (await page.locator(".context-menu, [role=menu]").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    const del = page.locator(".context-menu, [role=menu]").getByRole("menuitem", { name: /Delete|Remove/ }).first();
    if (await del.count()) { await del.click(); await page.waitForTimeout(1500); }
    out.afterMenuDelete = JSON.stringify({ server: (await edgesOf(U1)).length, rendered: await page.locator(".react-flow__edge").count() });
  }
  } finally {
    console.log("CAN07 " + JSON.stringify(out, null, 2));
  }
});
