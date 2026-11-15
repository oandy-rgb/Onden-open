// Spaces and members on a phone (390x844): a new AI role belongs to no space, so it reads
// nothing. Its page says so; once it is in a space the warning goes away.
import { test, expect } from "@playwright/test";
import { ready, openMember, H } from "./helpers";


test.use({ viewport: { width: 390, height: 844 } });

test("an agent in no space shows a warning; adding it to a space clears it (390x844)", async ({ page }) => {
  const stamp = Date.now();
  const agentName = `Spaces ${stamp}`;
  const spaceName = `Dev ${stamp}`;
  const actor = await page.request.post("/api/actors", { ...H, data: { name: agentName, type: "agent" } });
  const created = await page.request.post("/api/spaces", { ...H, data: { name: spaceName } }); // the caller manages it
  expect(created.ok()).toBe(true);

  await ready(page, "/");
  // The agent is in no space: its page says it can see no notes.
  let screen = await openMember(page, agentName);
  await expect(screen.getByText(`${agentName} is not in any space, so it can't see any notes.`)).toBeVisible();

  // Add it to the space (the owner manages it); the warning goes away.
  const spaceId = (await created.json()).id as string;
  const put = await page.request.put(`/api/spaces/${spaceId}/members/${(await actor.json()).id}`, { ...H, data: { permission: "edit" } });
  expect(put.ok()).toBe(true);
  await ready(page, "/");
  screen = await openMember(page, agentName);
  await expect(screen.getByText(/is not in any space/)).toHaveCount(0);
  await expect(screen.locator(".sm-sentence")).toContainText("in 1 space");

  // The server agrees: the agent is now a member.
  const members = await (await page.request.get(`/api/spaces/${spaceId}/members`, H)).json() as { members: Array<{ name: string }> };
  expect(members.members.map((m) => m.name)).toContain(agentName);

  // No sideways scroll on the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
