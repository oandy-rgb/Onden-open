// Settings › 空間與成員: two lists that follow each other (spaces | members), and
// an AI role added one step at a time. Owner-only parts skip on a stack whose
// e2e user is not the owner (see requireAdmin).
import { test, expect } from "@playwright/test";
import { requireAdmin, openMembers } from "./helpers";

test("spaces and members are two lists that follow each other, and an AI role can be added", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("onden.locale", "en"));
  await page.reload();
  const screen = await openMembers(page);
  await expect(screen.getByRole("heading", { name: "Spaces" })).toBeVisible();
  await expect(screen.locator("li.sm-row[data-space-id]").first()).toBeVisible();

  // A person picked: a sentence says which spaces they are in, and their spaces are listed.
  // In the narrow layout (a dialog) that is a page of its own with a way back; in the wide
  // layout it is the second column, picked again to clear.
  const people = screen.locator("li.sm-row[data-person-type=human] .sm-row-main");
  await people.first().click();
  await expect(screen.locator(".sm-sentence")).toBeVisible();
  const narrow = (await screen.getAttribute("data-layout")) === "narrow";
  if (narrow) {
    await screen.getByRole("button", { name: /^(Back|返回)/ }).click();
  } else {
    await expect(screen.getByRole("heading", { name: "Members" })).toBeVisible();
    await people.first().click();
  }
  await expect(screen.getByRole("heading", { name: "Spaces" })).toBeVisible();

  const addRow = screen.getByRole("button", { name: "Invite a member or add an AI" });
  requireAdmin(await addRow.isVisible(), "the e2e user is not the owner, so it cannot add an AI role");
  await addRow.click();
  await page.getByRole("menuitem", { name: "Add an AI role" }).click();
  const wizard = screen.getByRole("form", { name: "New AI role" });
  await expect(wizard.getByRole("button", { name: "Next" })).toBeDisabled(); // a name first
  await wizard.getByLabel("What should this AI role be called?").fill("E2E helper");
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.getByRole("radio")).toHaveCount(2); // only the ways the server supports
  await page.screenshot({ path: "/tmp/pw-output/spaces-members-wizard.png" });
  await wizard.getByRole("button", { name: "Cancel" }).click();
  await expect(wizard).toHaveCount(0);
});
