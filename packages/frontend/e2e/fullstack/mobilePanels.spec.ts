import { test, expect } from "@playwright/test";
import { ready, openMembers } from "./helpers";

// Phone (390x844): Spaces and members (the old Users & Agents panel) and the top bar.
test.use({ viewport: { width: 390, height: 844 } });

test("Spaces and members on a phone: opens from the avatar, a person is a page with a way back", async ({ page }) => {
  await ready(page, "/");
  const screen = await openMembers(page);
  await expect(screen.getByRole("heading", { name: "Spaces" })).toBeVisible();
  await screen.locator("li.sm-row[data-person-type=human] .sm-row-main").first().click();
  await expect(screen.locator(".sm-page")).toBeVisible();
  const back = screen.getByRole("button", { name: /^(Back|返回)/ });
  expect((await back.boundingBox())!.height, "Back is a 44px touch target").toBeGreaterThanOrEqual(44);
  await back.click();
  await expect(screen.locator(".sm-page")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll").toBe(true);
});

test("top bar: no layout switch, invisible avatar touch area, dot only when something is wrong", async ({ page, context }) => {
  await ready(page, "/");
  // A phone opens on a note, which has no top bar: the list does.
  await page.getByRole("button", { name: "Back to notes list" }).click();
  const bar = page.locator(".app-topbar");
  await expect(bar.locator(".topbar-pane-switch")).toHaveCount(0);

  const chip = bar.locator(".user-chip");
  await expect(chip).toBeVisible();
  const style = await chip.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopWidth, background: cs.backgroundColor, w: el.getBoundingClientRect().width,
      after: getComputedStyle(el, "::after").width };
  });
  expect(style.border, "no visible ring").toBe("0px");
  expect(style.background).toBe("rgba(0, 0, 0, 0)");
  expect(style.w, "drawn at the avatar's size").toBeLessThanOrEqual(32);
  expect(parseFloat(style.after), "touch area is 44px, invisibly").toBeGreaterThanOrEqual(44);

  // Online and synced: nothing floats beside the avatar.
  await expect(bar.locator(".status-dot")).toHaveCount(0);
  await expect(bar.locator(".user-badge")).toHaveCount(0);

  // Offline: a badge on the avatar with an accessible label.
  await context.setOffline(true);
  const badge = chip.locator(".user-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("aria-label", /offline/i);
  await context.setOffline(false);
  await expect(badge).toHaveCount(0, { timeout: 30_000 });
});
