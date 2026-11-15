// Feature-audit deepening (2026-10-09, tick 36): ACC-02 — first sign-up on an
// EMPTY workspace (throwaway stack on :5299, run with E2E_BASE=http://localhost:5299).
// First user's role and the example seed (count, author), reload (no re-seed),
// a second browser on the now non-empty workspace, then: delete every example
// and open a NEW browser (does it re-seed?), and two fresh browsers opening the
// empty workspace at the same moment (duplicate seed?).
import { test, type Browser, type Page } from "@playwright/test";
import { BASE, H } from "../fullstack/helpers";


async function openApp(browser: Browser, creds: { email: string; password: string }, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport });
  const p = await ctx.newPage();
  await p.request.post("/api/auth/sign-in/email", { ...H, data: creds });
  await p.goto(`${BASE}/?view=notes`);
  const choose = p.getByRole("button", { name: /Use browser storage/ });
  await choose.or(p.locator(".obsidian-title-input, .app-topbar")).first().waitFor({ timeout: 90_000 }).catch(() => {});
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await p.waitForTimeout(12_000);
  return { ctx, p };
}
const nodes = async (p: Page) => ((await (await p.request.get("/api/bootstrap?bodies=none")).json()).nodes ?? []) as Array<{ id: string; title: string; node_type: string }>;

test("ACC-02: first run seed on an empty workspace", async ({ browser }) => {
  test.setTimeout(600_000);
  const out: Record<string, unknown> = {}; const s = Date.now();
  // The first human on this stack is the Playwright global-setup owner (admin).
  const u1 = { email: "e2e-owner@example.com", password: "e2e-pass-12345" };
  const boot = await browser.newContext({ baseURL: BASE });
  out.signin = (await boot.request.post("/api/auth/sign-in/email", { ...H, data: u1 })).status();
  void s;
  const pre = await (await boot.request.get("/api/bootstrap?bodies=none")).json();
  out.firstBootstrap = { role: pre.actor_role, eligible: pre.example_seed_eligible, nodes: (pre.nodes ?? []).length };
  await boot.close();

  // 1. First open → seed.
  const A = await openApp(browser, u1);
  const n1 = await nodes(A.p);
  out.afterFirstOpen = { count: n1.length, titles: n1.map((n) => n.title).slice(0, 12) };
  out.seedAuthors = await A.p.evaluate(async () => { const r = await fetch("/api/events?event_type=NODE_CREATED&limit=50"); const j = await r.json(); const ev = (j.events ?? j) as Array<{ actor_type: string; actor_id: string }>; return [...new Set(ev.map((e) => `${e.actor_type}:${e.actor_id.slice(0, 8)}`))]; });
  // 2. Reload → no re-seed.
  await A.p.reload(); await A.p.waitForTimeout(10_000);
  out.afterReload = (await nodes(A.p)).length;
  // 3. Second browser, same account, workspace not empty.
  const B = await openApp(browser, u1);
  out.secondBrowser = (await nodes(B.p)).length;
  await B.ctx.close();
  // 4. Delete every node, then a NEW browser.
  for (const n of await nodes(A.p)) await A.p.request.delete(`/api/nodes/${n.id}`, H);
  out.afterDeleteAll = (await nodes(A.p)).length;
  await A.p.reload(); await A.p.waitForTimeout(10_000);
  out.originalBrowserAfterDelete = (await nodes(A.p)).length;
  const C = await openApp(browser, u1);
  out.newBrowserAfterDelete = { count: (await nodes(C.p)).length, titles: (await nodes(C.p)).map((n) => n.title).slice(0, 12) };
  await C.ctx.close();
  // 5. Empty again, two fresh browsers at once.
  for (const n of await nodes(A.p)) await A.p.request.delete(`/api/nodes/${n.id}`, H);
  out.emptyAgain = (await nodes(A.p)).length;
  const [D, E] = await Promise.all([openApp(browser, u1), openApp(browser, u1)]);
  const after = await nodes(D.p);
  const byTitle: Record<string, number> = {};
  for (const n of after) byTitle[n.title] = (byTitle[n.title] ?? 0) + 1;
  out.concurrentFresh = { count: after.length, duplicates: Object.entries(byTitle).filter(([, c]) => c > 1) };
  await D.ctx.close(); await E.ctx.close(); await A.ctx.close();
  console.log("ACC02 " + JSON.stringify(out, null, 2));
});
