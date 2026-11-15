import { test, expect } from "@playwright/test";
import { ready, requireAdmin, openSettingsFromAvatar, H } from "./helpers";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import/export contracts: every export endpoint returns a real artifact, and
// a TagPack survives an export → import round-trip. (The full-workspace
// /api/export zip is already covered in publishing.spec.ts.)

test("static-site export returns a non-empty zip", async ({ page }) => {
  const res = await page.request.get("/api/export-static");
  requireAdmin(res.status() !== 403, "needs an admin-capable user; reset the stack");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("zip");
  expect((await res.body()).length).toBeGreaterThan(0);
});

test("markdown export returns a non-empty zip", async ({ page }) => {
  const res = await page.request.get("/api/export/markdown.zip");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("zip");
  expect((await res.body()).length).toBeGreaterThan(0);
});

test("tag pack round-trips through export and import", async ({ page }) => {
  const stamp = Date.now();
  const created = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `RoundTrip${stamp}`,
      fields: [{ key: "status", type: "select", label: "Status", options: ["a", "b"], default: "a" }],
    },
  })).json();
  expect(created.id).toBeTruthy();

  const packRes = await page.request.get(`/api/tags/${created.id}/export`);
  expect(packRes.ok()).toBeTruthy();
  const pack = await packRes.json();
  expect(pack.name).toBe(`RoundTrip${stamp}`);
  expect(Array.isArray(pack.fields)).toBeTruthy();
  expect(pack.fields.some((f: { key?: string; name?: string }) => (f.key ?? f.name) === "status")).toBeTruthy();

  // Re-import under a new name — the escape-hatch path (Library file import).
  const reRes = await page.request.post("/api/tags/import", {
    ...H,
    data: { ...pack, name: `RoundTrip${stamp}B` },
  });
  expect(reRes.ok(), await reRes.text()).toBeTruthy();
  const re = await reRes.json();
  expect(re.id).toBeTruthy();

  const tags = await (await page.request.get("/api/tags")).json();
  const list = tags.tags ?? tags;
  const copy = list.find((t: { name: string }) => t.name === `RoundTrip${stamp}B`);
  expect(copy).toBeTruthy();
});

// The Obsidian/Notion folder-import widget end-to-end through the real UI:
// Settings → Data and backup → Import → the hidden webkitdirectory input → source
// confirmation. Drives the actual <input>, the client file-read,
// POST /api/import/obsidian, and the result strip — then cross-checks the
// server created the notes + frontmatter tag. (Backend parsing is unit-tested;
// this pins the UI wiring.)
test("import a markdown folder through Settings › Data and backup", async ({ page }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes");

  // Open Settings → Data and backup (Settings sits in the avatar's account sheet).
  await openSettingsFromAvatar(page, "Data and backup");

  // The folder picker is a hidden webkitdirectory input — Playwright requires a
  // real directory path for it, so stage a tiny vault on disk (frontmatter title
  // makes the resulting node titles deterministic).
  const vault = mkdtempSync(join(tmpdir(), `vault-${stamp}-`));
  writeFileSync(join(vault, "alpha.md"), `---\ntitle: Alpha ${stamp}\ntags: [imported${stamp}]\n---\n\nSee [[Beta ${stamp}]] for more.`);
  writeFileSync(join(vault, "beta.md"), `---\ntitle: Beta ${stamp}\n---\n\nPlain second note.`);
  const input = page.locator('input[type="file"][webkitdirectory]').first();
  await input.setInputFiles(vault);
  await page.getByLabel("Source name").fill(`E2E folder ${stamp}`);
  await page.getByRole("button", { name: "Start import" }).click();

  // The result strip reports both notes imported.
  const result = page.locator(".settings-import-result-list");
  await expect(result).toBeVisible();
  await expect(result).toContainText("2 notes imported");

  // Server-side: both notes exist (read-policy-scoped search) and the
  // frontmatter `tags:` became a real tag node.
  await expect.poll(async () => {
    const hits = await (await page.request.get(`/api/nodes/search?q=Alpha ${stamp}`)).json();
    return Array.isArray(hits) && hits.some((n: { title: string }) => n.title === `Alpha ${stamp}`);
  }).toBe(true);
  const beta = await (await page.request.get(`/api/nodes/search?q=Beta ${stamp}`)).json();
  expect(beta.some((n: { title: string }) => n.title === `Beta ${stamp}`)).toBe(true);
  const tags = await (await page.request.get("/api/tags")).json();
  const list = tags.tags ?? tags;
  expect(list.some((t: { name: string }) => t.name === `imported${stamp}`)).toBe(true);
});
