// Feature-audit deepening (2026-10-08): NAV-01 — top-level destinations:
// every primary entry and More-menu place opens with the selection/body in
// agreement; switching away with an unsaved draft; each destination's empty
// state for a brand-new account; and a destination whose data request fails.
import { test, type Page } from "@playwright/test";
import { openFeature, openNavDestination, ready, BASE, H } from "../fullstack/helpers";

// The core pages, then the imported modules' pages (folded into 更多 ▾ when
// the bar is narrow).
const PRIMARY = ["Notes", "Tasks", "Tags", "Graph", "Workspace changes", "Review", "Reading"];
// Opened from their card under Tags › feature tags.
const FEATURES = ["Canvas", "Website"];

async function go(p: Page, name: string) {
  if (PRIMARY.includes(name)) { await openNavDestination(p, name); }
  else if (FEATURES.includes(name)) { await openFeature(p, name); }
  await p.waitForTimeout(1200);
}
const snap = async (p: Page) => ({
  url: p.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 60),
  main: (await p.locator("main, .app-main, .app-shell").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 110),
  errors: await p.locator(".toast, [role=alert]").allInnerTexts().then((a) => a.join(" | ").replace(/\s+/g, " ").slice(-120)).catch(() => ""),
});

test("NAV-01: destinations, unsaved draft, empty states, load failure", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 100)));
  try {
  const note = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Nav ${stamp}`, markdown: "nav body" } })).json()).id as string;
  await ready(page, `/?view=notes&node=${note}&lens=editor`);
  await page.waitForTimeout(1200);
  // Unsaved draft then switch to Tasks immediately.
  await page.locator(".cm-content").first().click(); await page.keyboard.press("Control+End"); await page.keyboard.type(" switch-draft");
  await go(page, "Tasks");
  await page.waitForTimeout(1500);
  out.draftOnSwitch = ((await (await page.request.get(`/api/nodes/${note}`)).json()).markdown as string).includes("switch-draft");
  await go(page, "Notes");
  out.backToNotes = { title: await page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null), bodyHas: (await page.locator(".cm-content").first().innerText().catch(() => "")).includes("switch-draft") };
  const all: Record<string, unknown> = {};
  for (const d of [...PRIMARY, ...FEATURES]) { await go(page, d).catch((e) => { all[d] = `nav failed ${String(e).slice(0, 60)}`; }); if (!all[d]) all[d] = await snap(page); }
  out.destinations = all;
  out.pageErrors = pageErrors;

  // Load failures for data-backed destinations.
  const fails: Record<string, unknown> = {};
  for (const [d, pattern] of [["Tasks", "**/api/tasks/agenda"], ["Review", "**/api/review/**"], ["Tags", "**/api/tags**"], ["Website", "**/api/site**"]] as const) {
    await page.route(pattern, (r) => r.request().method() === "GET" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
    await ready(page, "/?view=notes"); await page.waitForTimeout(800);
    await go(page, d).catch(() => {});
    await page.waitForTimeout(1500);
    fails[d] = await snap(page);
    await page.unroute(pattern);
  }
  out.loadFailures = fails;

  // Empty states for a brand-new account (its own workspace? second human shares the workspace, so use a fresh signup as editor of nothing).
  const fresh = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const fp = await fresh.newPage();
  const su = await fp.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Fresh ${stamp}`, email: `fresh-${stamp}@example.com`, password: `pw-${stamp}-x` } });
  out.freshSignup = su.status();
  await fp.goto(`${BASE}/?view=notes`); await fp.waitForTimeout(4000);
  out.freshLanding = await snap(fp);
  await fresh.close();
  } finally {
    console.log("NAV01 " + JSON.stringify(out, null, 2));
  }
});
