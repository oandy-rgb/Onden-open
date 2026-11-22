// Governance: issue and revoke an AI role's key entirely through the UI — avatar ›
// Spaces and members › the role › Settings of this role › Keys — and assert the
// stored scope. A key is read-only or read-and-write and reaches exactly the
// spaces its role is in (the old template picker and per-key re-scope were
// removed with the actors drawer; the scope now follows the role's spaces).
import { test, expect } from "@playwright/test";
import { ready, openMember, addToDefaultSpace, requireAdmin, H } from "./helpers";

async function newRole(page: import("@playwright/test").Page, name: string) {
  const res = await page.request.post("/api/actors", { ...H, data: { name, type: "agent" } });
  requireAdmin(res.ok(), "creating an AI role needs the owner");
  return (await res.json()) as { id: string };
}

async function openKeys(page: import("@playwright/test").Page, name: string) {
  await ready(page, "/?view=notes");
  const screen = await openMember(page, name);
  await screen.getByRole("button", { name: `Settings of the role ${name}` }).click();
  return screen.getByRole("region", { name: `Keys of ${name}` });
}

test("issue and revoke a key through Spaces and members", async ({ page }) => {
  const stamp = Date.now();
  const name = `Mint bot ${stamp}`;
  const agent = await newRole(page, name);
  await addToDefaultSpace(page.request, agent.id, "edit");

  const keys = await openKeys(page, name);
  await expect(keys.getByText("No keys yet.")).toBeVisible();

  await keys.getByLabel("Key name (optional)").fill(`ci ${stamp}`);
  await keys.getByRole("radio", { name: /Read and write/ }).check();
  await keys.getByRole("button", { name: "Issue key" }).click();
  // The plaintext is shown once, until it is dismissed.
  await expect(keys.getByText("Copy it now. It will never be shown again.")).toBeVisible();
  await keys.getByRole("button", { name: "Done" }).click();
  await expect(keys.getByText("Copy it now. It will never be shown again.")).toHaveCount(0);
  await expect(keys.getByText(`ci ${stamp}`)).toBeVisible();

  // Server side: a write key, owned by this role.
  const tokens = await (await page.request.get(`/api/actors/${agent.id}/tokens`)).json() as Array<{ name: string; access: string; revoked_at: string | null }>;
  const minted = tokens.find((t) => t.name === `ci ${stamp}`);
  expect(minted?.access).toBe("write");

  // Revoke through the UI; the list no longer offers it.
  await keys.getByRole("button", { name: `Revoke the key “ci ${stamp}”` }).click();
  // A key is stopped after asking (settings/ai/actions revokeCode): the dialog's button is 「Revoke code」.
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke code", exact: true }).click();
  await expect(keys.getByText(`ci ${stamp}`)).toHaveCount(0);
  const after = await (await page.request.get(`/api/actors/${agent.id}/tokens`)).json() as Array<{ name: string; revoked_at: string | null }>;
  expect(after.find((t) => t.name === `ci ${stamp}`)?.revoked_at).toBeTruthy();
});

test("a role in no space cannot be given a key until it is added to one", async ({ page }) => {
  const stamp = Date.now();
  const name = `Scope bot ${stamp}`;
  const agent = await newRole(page, name);

  let keys = await openKeys(page, name);
  await expect(keys.getByText(new RegExp(`Put ${name} in at least one space`))).toBeVisible();
  await expect(keys.getByRole("button", { name: "Issue key" })).toHaveCount(0);

  await addToDefaultSpace(page.request, agent.id, "view");
  keys = await openKeys(page, name);
  await expect(keys.getByRole("button", { name: "Issue key" })).toBeVisible();
  // Read-only in every space: a write key would change nothing, and the form says so.
  await keys.getByRole("radio", { name: /Read and write/ }).check();
  await expect(keys.getByRole("status")).toContainText("can only read in every space");
});
