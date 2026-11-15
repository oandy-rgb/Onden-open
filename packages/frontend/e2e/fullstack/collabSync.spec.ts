import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { H } from "./helpers";

// Collab + sync increments: the three-way body merge (two writers, both
// changes land) and incremental re-import (upsert-by-slug).

test("concurrent body edits merge instead of clobbering", async ({ page }) => {
  const stamp = Date.now();
  const original = "line one\n\nmiddle part\n\nline three";
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Merge ${stamp}`, markdown: original },
  })).json();

  // Writer B lands first (plain PATCH, as an out-of-date client would NOT —
  // B is up to date and edits the top line).
  const bBody = original.replace("line one", `line one (edited by B ${stamp})`);
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { markdown: bBody } });

  // Writer A still holds the ORIGINAL as its base and edits the bottom line.
  const aBody = original.replace("line three", `line three (edited by A ${stamp})`);
  const aRes = await (await page.request.patch(`/api/nodes/${node.id}`, {
    ...H, data: { markdown: aBody, base_markdown: original },
  })).json();

  // Both writers' changes survive in the merged body.
  expect(aRes.markdown).toContain(`line one (edited by B ${stamp})`);
  expect(aRes.markdown).toContain(`line three (edited by A ${stamp})`);
});

test("overlapping edits fall back to last-writer-wins", async ({ page }) => {
  const stamp = Date.now();
  const original = `same target ${stamp}`;
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Clash ${stamp}`, markdown: original },
  })).json();

  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { markdown: `B version ${stamp}` } });
  const aRes = await (await page.request.patch(`/api/nodes/${node.id}`, {
    ...H, data: { markdown: `A version ${stamp}`, base_markdown: original },
  })).json();

  // The whole body changed on both sides — no clean merge exists; the
  // incoming write wins and the overridden body stays in version history.
  expect(aRes.markdown).toBe(`A version ${stamp}`);
});

test("re-importing a vault updates matching notes instead of duplicating", async ({ page }) => {
  const stamp = Date.now();
  const source = { id: randomUUID(), name: `Vault ${stamp}` };
  const file = (content: string) => ({ files: [{ path: `Vault Note ${stamp}.md`, content }], upsert: true, source });

  const firstRes = await page.request.post("/api/import/obsidian", { ...H, data: file(`# v1 ${stamp}`) });
  expect(firstRes.ok(), await firstRes.text()).toBeTruthy();
  const first = await firstRes.json();
  expect(first.imported).toBe(1);

  const secondRes = await page.request.post("/api/import/obsidian", { ...H, data: file(`# v2 ${stamp}`) });
  expect(secondRes.ok(), await secondRes.text()).toBeTruthy();
  const second = await secondRes.json();
  expect(second.updated).toBe(1);
  expect(second.imported).toBe(0);

  const thirdRes = await page.request.post("/api/import/obsidian", { ...H, data: file(`# v2 ${stamp}`) });
  expect(thirdRes.ok(), await thirdRes.text()).toBeTruthy();
  const third = await thirdRes.json();
  expect(third.unchanged).toBe(1);
  expect(third.updated).toBe(0);

  // Without upsert the old behavior (duplicate with suffixed slug) remains.
  const fourthRes = await page.request.post("/api/import/obsidian", {
    ...H, data: { files: [{ path: `Vault Note ${stamp}.md`, content: `# v3 ${stamp}` }], upsert: false, source },
  });
  expect(fourthRes.ok(), await fourthRes.text()).toBeTruthy();
  const fourth = await fourthRes.json();
  expect(fourth.imported).toBe(1);
});
