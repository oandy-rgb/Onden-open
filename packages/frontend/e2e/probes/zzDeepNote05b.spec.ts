// NOTE-05 follow-up (2026-10-08): the Enter that confirms an IME candidate
// (keydown key=Enter, isComposing=true) in inputs that commit on Enter —
// sidebar rename, the Tasks quick-add, and the command palette (guarded, for
// comparison). Does the half-composed text get committed?
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


async function findRow(page: Page, text: string) {
  const loc = page.locator(".obsidian-page-button", { hasText: text }).first();
  await page.locator(".obsidian-page-button").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.locator(".obsidian-page-button").first().evaluate((el) => { let p: HTMLElement | null = el.parentElement; while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; if (p) p.scrollTop = 0; });
  for (let i = 0; i < 200 && !(await loc.isVisible().catch(() => false)); i++) {
    await page.locator(".obsidian-page-button").first().evaluate((el) => { let p: HTMLElement | null = el.parentElement; while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; if (p) p.scrollTop += 300; });
    await page.waitForTimeout(60);
  }
  return loc;
}
const composingEnter = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
});

test("NOTE-05b: composing Enter in rename / quick-add / palette", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const id = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Ren ${stamp}`, markdown: "x" } })).json()).id as string;
  await ready(page, `/?view=notes&node=${id}`);
  const row = await findRow(page, `Ren ${stamp}`);
  await row.click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Rename", exact: true }).click();
  const inp = page.locator(".sb-rename-input");
  await inp.fill(`改名 zhong`);
  await composingEnter(page, ".sb-rename-input");
  await page.waitForTimeout(1500);
  out.sidebarRename = { server: (await (await page.request.get(`/api/nodes/${id}`)).json()).title, inputStillOpen: await inp.isVisible().catch(() => false) };
  if (await inp.isVisible().catch(() => false)) await inp.press("Escape");

  await ready(page, "/?view=tasks");
  const add = page.getByRole("textbox", { name: "Add a task" });
  await add.fill(`任務 ren ${stamp}`);
  await add.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(2000);
  const a = await (await page.request.get("/api/tasks/agenda")).json();
  out.taskQuickAdd = { created: [...Object.values(a.buckets ?? {}).flat()].some((r: any) => r.title.includes(`任務 ren ${stamp}`)), draft: await add.inputValue() };

  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(`面板 xin ${stamp}`);
  await page.waitForTimeout(600);
  await composingEnter(page, ".palette-input-wrap input");
  await page.waitForTimeout(1500);
  out.paletteGuarded = { stillOpen: await page.locator(".palette-input-wrap input").isVisible().catch(() => false), created: ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ title: string }>).some((n) => n.title === `面板 xin ${stamp}`) };
  console.log("NOTE05B " + JSON.stringify(out, null, 2));
});
