// Feature-audit deepening (2026-10-07): COL-10 — onden-query / onden-base
// embeds: real rendering in the editor's Preview, malformed specs, collection
// (space) permissions for a second human, and paging a long result list.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, switchNoteView, BASE, H } from "./helpers";

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

test("COL-10: query/base embeds render, malformed specs, permissions, paging", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tagName = `c10q${stamp}`;
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: tagName, fields: [{ name: "stage", type: "text" }] } })).json();
  // Default space so the second human reads them (except QSecret, hidden below).
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, markdown = `${title} body`) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, space_id: shared } })).json()).id as string;
  const member = async (title: string, stage?: string) => {
    const id = await mk(title);
    await page.request.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} });
    if (stage) await page.request.put(`/api/nodes/${id}/attributes/stage`, { ...H, data: { value: stage, value_type: "text" } });
    return id;
  };
  await member(`QA ${stamp}`, "doing");
  await member(`QB ${stamp}`, "done");
  await member(`QC ${stamp}`, "doing");
  // A member only the owner may read: it sits in a space of its own.
  const secret = await member(`QSecret ${stamp}`, "doing");
  await hideFromOthers(page.request, secret);

  // ── API surface ──────────────────────────────────────────────────────────
  const q = async (body: unknown) => {
    const r = await page.request.post("/api/query", { ...H, data: body });
    const text = await r.text();
    return { status: r.status(), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const titles = (j: { rows?: Array<{ title: string }> } | null) => (j?.rows ?? []).map((r) => r.title).filter((t) => t.includes(String(stamp)));
  let r = await q({ tags: [tagName] });
  out.apiTagsArray = `${r.status} ${JSON.stringify(titles(r.json))}`;
  r = await q({ tags: tagName });
  out.apiTagsString = `${r.status} ${r.text.slice(0, 160)}`;
  r = await q({ tags: [tagName], where: { stage: "doing" }, sort: "-title" });
  out.apiWhereSort = `${r.status} ${JSON.stringify(titles(r.json))}`;
  r = await q({ tags: [tagName], where: { stage: { op: "ne", value: "doing" } } });
  out.apiWhereNe = `${r.status} ${JSON.stringify(titles(r.json))}`;
  for (const [k, body] of Object.entries({
    limit0: { limit: 0 }, limit500: { limit: 500 }, badOp: { where: { stage: { op: "like", value: "x" } } },
    sortInjection: { sort: "title; DROP TABLE content_nodes" }, offsetNeg: { offset: -1 }, notJson: "not json",
    whereNumber: { where: { stage: 3 } }, reservedKey: { tags: [tagName], where: { _status: "draft" } },
  })) {
    const res = typeof body === "string"
      ? await page.request.post("/api/query", { headers: H.headers, data: body })
      : await page.request.post("/api/query", { ...H, data: body });
    out[`api_${k}`] = `${res.status()} ${(await res.text()).slice(0, 120)}`;
  }

  // ── Real rendering in the editor Preview ────────────────────────────────
  const hostMd = [
    "# Embeds",
    fence("onden-query", `tags: ${tagName}`),
    fence("onden-query", `tags: ${tagName}, nothing${stamp}\nwhere:\n  stage: doing\nsort: -title`),
    fence("onden-base", `filters:\n  and:\n    - file.hasTag("${tagName}")\nviews:\n  - type: table\n    name: T${stamp}`),
    fence("onden-base", "views: [this is: not: yaml"),
    fence("onden-query", "this is not a spec at all"),
  ].join("\n\n");
  const host = await mk(`EmbedHost ${stamp}`, hostMd);
  const openPreview = async (p: Page) => {
    await ready(p, `/?view=notes&node=${host}`);
    await switchNoteView(p, "preview");
    await expect(p.locator(".obsidian-preview")).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(2500);
  };
  const describe = async (p: Page) => p.locator(".obsidian-preview").evaluate((root) => ({
    queryBlocks: root.querySelectorAll(".onden-query-block").length,
    baseTables: root.querySelectorAll(".base-renderer-error, .base-renderer-empty, table").length,
    rawCode: Array.from(root.querySelectorAll("pre code")).map((c) => `${c.className}|${(c.textContent ?? "").slice(0, 40)}`),
    queryTexts: Array.from(root.querySelectorAll(".onden-query-block")).map((b) => (b as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)),
    baseTexts: Array.from(root.querySelectorAll(".base-renderer-error, .base-renderer-empty, table")).map((b) => (b as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)),
    copyButtons: root.querySelectorAll("pre button").length,
  }));
  await openPreview(page);
  out.ownerPreview = JSON.stringify(await describe(page));
  await page.screenshot({ path: test.info().outputPath("col10-owner-preview.png"), fullPage: true });

  // Clicking a query result navigates (only meaningful if blocks render).
  const firstLink = page.locator(".onden-query-result-link").first();
  if (await firstLink.count()) {
    const target = await firstLink.innerText();
    await firstLink.click();
    await page.waitForTimeout(1200);
    out.queryClick = `${target} → url has node=${/node=/.test(page.url())} title=${await page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => "?")}`;
  } else out.queryClick = "no result link rendered";

  // ── Second human (editor): restricted member hidden in API and in embeds ─
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C10 ${stamp}`, email: `c10-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `C10 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const theirQ = await (await human.request.post("/api/query", { ...H, data: { tags: [tagName] } })).json();
  out.editorApi = JSON.stringify(titles(theirQ));
  out.ownerApiHasSecret = String(titles((await q({ tags: [tagName] })).json).some((t) => t.includes("QSecret")));
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await openPreview(hp);
  out.editorPreview = JSON.stringify(await describe(hp));
  out.editorSeesSecret = String((await hp.locator(".obsidian-preview").innerText()).includes(`QSecret ${stamp}`));
  await human.close();

  // ── Long list: 60 more members, default page = 50, paging via offset ────
  for (let i = 0; i < 60; i++) await member(`QLong${String(i).padStart(2, "0")} ${stamp}`);
  const p1 = await q({ tags: [tagName], sort: "title" });
  const p2 = await q({ tags: [tagName], sort: "title", offset: p1.json?.next ?? 50 });
  const all = [...titles(p1.json), ...titles(p2.json)];
  out.paging = `p1 rows=${p1.json?.rows?.length} total=${p1.json?.total} next=${p1.json?.next} p2 rows=${p2.json?.rows?.length} next=${p2.json?.next} union=${new Set(all).size} dup=${all.length - new Set(all).size}`;
  await openPreview(page);
  out.ownerPreviewLong = JSON.stringify(await describe(page));
  out.loadMoreControl = String(await page.locator(".onden-query-block").getByRole("button", { name: /more|next/i }).count());

  // ── Phone viewport ───────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await openPreview(page).catch((e) => { out.phoneOpen = String(e).slice(0, 160); });
  out.phonePreview = JSON.stringify(await describe(page).catch(() => "n/a"));
  out.phoneOverflow = String(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));

  console.log("COL10 " + JSON.stringify(out, null, 2));
  await test.info().attach("col10.json", { body: JSON.stringify(out, null, 2), contentType: "application/json" });
});
