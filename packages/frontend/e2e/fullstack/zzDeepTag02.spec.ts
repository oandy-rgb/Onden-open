// Feature-audit deepening (2026-10-07): TAG-02 — apply / remove / count / click
// agree across projections (sidebar count + click, search #tag, tag page
// members, note chips) for label and class tags; same name under two
// parents; online vs offline entries (note tag picker, quick capture); and the
// tasks, which are not tags (a task makes no `task` tag). Since T10 (2026-10-16)
// a #word written in a note's body or title is text, not a tag: inline-only
// notes are never members, and quick capture leaves its #word as text.
import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, titleTags, titleTagAdd, applyTagFromTitle, H } from "./helpers";


test("TAG-02: projections agree, duplicate names, offline entries, renamed task tag", async ({ page, context }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const mk = async (title: string, markdown = "x") => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()).id as string;
  const rp = async (path: string) => (await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path } })).json()).leaf_id as string;
  const tagOn = (n: string, t: string) => page.request.put(`/api/nodes/${n}/tags/${t}`, { ...H, data: {} });
  const memberIds = async (id: string) => {
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const row = (boot.nodes as { id: string; class_tag_ids?: string[]; label_tag_ids?: string[] }[]).find((n) => n.id === id);
    return [...(row?.class_tag_ids ?? []), ...(row?.label_tag_ids ?? [])];
  };
  const searchIds = async (q: string) => ((await (await page.request.get(`/api/nodes/search?q=${encodeURIComponent(q)}`)).json()) as { id: string }[]).map((r) => r.id);
  const sidebarChip = (p: Page, name: string) => p.locator(".sidebar-tag-chip").filter({ hasText: new RegExp(`^#${name}\\s*\\d*$`) });
  const sidebarCountAndClick = async (p: Page, name: string, ids: Record<string, string>) => {
    const chip = sidebarChip(p, name);
    const n = await chip.count();
    if (!n) return `no chip; chips containing name=${JSON.stringify((await p.locator(".sidebar-tag-chip").allInnerTexts()).filter((c) => c.toLowerCase().includes(name.toLowerCase())))}`;
    const count = (await chip.first().locator(".sidebar-tag-count").innerText()).trim();
    await chip.first().click();
    await p.waitForTimeout(1200);
    const nodeParam = new URL(p.url()).searchParams.get("node");
    let landed = "", items: string[] = [];
    if (await p.locator(".tag-members-section").isVisible().catch(() => false)) {
      landed = `tagPage(${nodeParam?.slice(0, 8)}) members=${(await p.locator(".tag-members-section .tag-member-count").innerText()).trim()}`;
      items = await p.locator(".tag-members-section li, .tag-members-section tbody tr").allInnerTexts();
    } else {
      landed = "no tag page";
    }
    const label = Object.entries(ids).filter(([, title]) => items.some((i) => i.includes(title))).map(([k]) => k);
    return `chips=${n} count=${count} click=${landed} items=${JSON.stringify(label)}`;
  };

  // A) Label tag L: n1 stored membership, n2 inline #L only, n3 both, n4 inline #l (case).
  //    Expected (T10): members are n1 and n3 only — n2/n4 are text.
  const L = `lab${stamp}`;
  const tL = await rp(L);
  const n1 = await mk(`T02 member ${stamp}`), n2 = await mk(`T02 inline ${stamp}`, `text #${L} here`), n3 = await mk(`T02 both ${stamp}`, `#${L}`), n4 = await mk(`T02 lower ${stamp}`, `#${L.toUpperCase()}`);
  await tagOn(n1, tL); await tagOn(n3, tL);
  const titles: Record<string, string> = { n1: `T02 member ${stamp}`, n2: `T02 inline ${stamp}`, n3: `T02 both ${stamp}`, n4: `T02 lower ${stamp}` };
  await ready(page, "/?view=notes");
  out.labelSidebar = await sidebarCountAndClick(page, L, titles);
  await ready(page, "/?view=notes");
  out.labelSidebarUpper = await sidebarCountAndClick(page, L.toUpperCase(), titles);
  const sL = await searchIds(`#${L}`);
  out.labelSearch = JSON.stringify(Object.entries({ n1, n2, n3, n4 }).filter(([, id]) => sL.includes(id)).map(([k]) => k));
  // Tag page: the tag node view, its "notes with this tag" list.
  await ready(page, `/?view=notes&node=${tL}`);
  await page.waitForTimeout(1500);
  const tagPageText = (await page.locator(".tag-members-section").innerText().catch(() => ""));
  out.labelTagPage = JSON.stringify(Object.entries(titles).filter(([, t]) => tagPageText.includes(t)).map(([k]) => k));

  // B) Same leaf name under two parents.
  const dup = `dup${stamp}`;
  const tA = await rp(`pa${stamp}/${dup}`), tB = await rp(`pb${stamp}/${dup}`);
  const d1 = await mk(`T02 dupA ${stamp}`), d2 = await mk(`T02 dupB ${stamp}`);
  await tagOn(d1, tA); await tagOn(d2, tB);
  await ready(page, "/?view=notes");
  out.dupSidebar = await sidebarCountAndClick(page, dup, { d1: `T02 dupA ${stamp}`, d2: `T02 dupB ${stamp}` });
  out.dupCatalog = JSON.stringify(((await (await page.request.get("/api/tags")).json()) as { id: string; name: string; parent_id?: string | null }[]).filter((t) => t.id === tA || t.id === tB).map((t) => `${t.name}|parent=${t.parent_id ?? "-"}`));
  const sD = await searchIds(`#${dup}`);
  out.dupSearch = `d1=${sD.includes(d1)} d2=${sD.includes(d2)}`;
  // Picker on a fresh note: how are the two options told apart?
  const pick = await mk(`T02 picker ${stamp}`);
  await ready(page, `/?view=notes&node=${pick}`);
  const sources = titleTags(page);
  await (await titleTagAdd(page)).click();
  await sources.getByRole("combobox", { name: "Add a tag" }).fill(String(stamp));
  await expect.poll(async () => (await sources.getByRole("option").allTextContents()).join("|").includes(L), { timeout: 15_000 }).toBe(true).catch(() => {});
  const opts = await sources.getByRole("option").allTextContents();
  out.dupPickerOptions = `total=${opts.length} mine=${JSON.stringify(opts.filter((o) => o.includes(String(stamp))))}`;
  await sources.getByRole("combobox", { name: "Add a tag" }).press("Escape");

  // C) Picker online → offline → reconnect.
  const tOff = await rp(`off${stamp}`);
  await ready(page, `/?view=notes&node=${pick}`);
  await context.setOffline(true);
  await applyTagFromTitle(page, `off${stamp}`);
  await page.waitForTimeout(1200);
  out.offlineApply = `chip=${await sources.getByRole("button", { name: `#off${stamp}`, exact: true }).count()} toasts=${JSON.stringify(await page.locator(".toast-message").allInnerTexts())} sidebarChip=${await sidebarChip(page, `off${stamp}`).locator(".sidebar-tag-count").innerText().catch(() => "-")}`;
  await context.setOffline(false);
  await expect.poll(async () => (await memberIds(pick)).includes(tOff), { timeout: 30_000 }).toBe(true);
  out.offlineApplyDrained = "server has membership";
  // A membership tick that lands just before the connection drops: is the workspace usable offline?
  const gate = page.locator(".membership-gate");
  await page.waitForTimeout(150);
  const gateBefore = await gate.isVisible().catch(() => false);
  await context.setOffline(true);
  await page.waitForTimeout(4000);
  out.gateWhenOfflineRightAfterTick = `gateBeforeOffline=${gateBefore} gateAfter4sOffline=${await gate.isVisible().catch(() => false)} text=${JSON.stringify((await gate.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120))}`;
  await page.waitForTimeout(8000);
  out.gateAfter12sOffline = String(await gate.isVisible().catch(() => false));
  await context.setOffline(false);
  const t0 = Date.now();
  await expect(gate).toBeHidden({ timeout: 30_000 }).catch(() => {});
  out.gateClearsOnReconnect = `${await gate.isVisible().catch(() => false) ? "still locked" : `cleared in ${Date.now() - t0}ms`} withoutClick=true`;
  if (await gate.isVisible().catch(() => false)) { await page.getByRole("button", { name: "Check again" }).click(); await expect(gate).toBeHidden({ timeout: 20_000 }); }
  await page.waitForTimeout(1500);
  // Remove offline, reconnect.
  await context.setOffline(true);
  await sources.getByRole("button", { name: `Remove #off${stamp} from this note`, exact: true }).click();
  await page.waitForTimeout(1200);
  out.offlineRemove = `chip=${await sources.getByRole("button", { name: `#off${stamp}`, exact: true }).count()}`;
  await context.setOffline(false);
  await expect.poll(async () => (await memberIds(pick)).includes(tOff), { timeout: 30_000 }).toBe(false);
  out.offlineRemoveDrained = "server membership gone";
  // 503 on apply.
  await page.route(`**/api/nodes/${pick}/tags/${tOff}`, (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
  await applyTagFromTitle(page, `off${stamp}`);
  await page.waitForTimeout(2000);
  out.apply503 = `chip=${await sources.getByRole("button", { name: `#off${stamp}`, exact: true }).count()} toasts=${JSON.stringify(await page.locator(".toast-message").allInnerTexts())} sync=${JSON.stringify((await page.locator(".sync-indicator, [class*=sync-status]").first().innerText().catch(() => "-")).slice(0, 60))}`;
  await page.unroute(`**/api/nodes/${pick}/tags/${tOff}`);
  await expect.poll(async () => (await memberIds(pick)).includes(tOff), { timeout: 90_000 }).toBe(true).catch(() => {});
  out.apply503Eventually = `serverHas=${(await memberIds(pick)).includes(tOff)}`;

  // D) Quick capture with a #word online vs offline. Expected (T10): the #word
  //    stays in the title/body, member=0, no tag is created.
  const qcOn = `qcon${stamp}`, qcOff = `qcoff${stamp}`;
  const capture = async (text: string) => {
    await openQuickCapture(page);
    await page.locator(".quick-capture-textarea").fill(text);
    await page.locator(".quick-capture-save").click();
    await page.waitForTimeout(2000);
  };
  try {
    await ready(page, "/?view=notes");
    await capture(`QC online ${stamp} #${qcOn}`);
    const findByTitle = async (prefix: string) => {
      const boot = await (await page.request.get("/api/bootstrap?slim=1")).json().catch(() => null) ?? await (await page.request.get("/api/bootstrap")).json();
      return (boot.nodes as { id: string; title: string; markdown: string }[]).find((n) => n.title.startsWith(prefix));
    };
    const on = await findByTitle(`QC online ${stamp}`);
    out.qcOnline = on ? `title=${JSON.stringify(on.title)} body=${JSON.stringify(on.markdown)} member=${(await memberIds(on.id)).length}` : "not created";
    await context.setOffline(true);
    await capture(`QC offline ${stamp} #${qcOff}`);
    await context.setOffline(false);
    await page.waitForTimeout(6000);
    const off = await findByTitle(`QC offline ${stamp}`);
    out.qcOffline = off ? `title=${JSON.stringify(off.title)} body=${JSON.stringify(off.markdown)} member=${(await memberIds(off.id)).length} tagExists=${(await (await page.request.get("/api/tags/tree")).json()).tags.some((t: { name: string }) => t.name === qcOff)} search#=${(await searchIds(`#${qcOff}`)).includes(off.id)}` : "not created";
  } catch (e) {
    out.qc = `capture UI not reached: ${String(e).slice(0, 120)}`;
    await context.setOffline(false);
  }

  // E) Tasks are not tags: a task is a node that references the tasks function (migration 191), so making one
  // creates no `task` tag, and a plain nested tag named "task" does not make a note a task.
  const host = await mk(`T02 task host ${stamp}`);
  const tasksTags = async () => ((await (await page.request.get("/api/tags/tree")).json()).tags as { id: string; name: string }[]).filter((t) => t.name === "task").length;
  const before = await tasksTags();
  const mkTask = await page.request.post(`/api/nodes/${host}/tasks`, { ...H, data: { title: `T02 task ${stamp}` } });
  const agendaHas = async (title: string) => JSON.stringify((await (await page.request.get("/api/tasks/agenda")).json())).includes(title);
  const bootTitles = async () => JSON.stringify((await (await page.request.get("/api/bootstrap")).json()).nodes.map((n: { title: string }) => n.title));
  out.task = `create=${mkTask.status()} agenda=${await agendaHas(`T02 task ${stamp}`)} asNote=${(await bootTitles()).includes(`T02 task ${stamp}`)} newTaskTags=${(await tasksTags()) - before}`;
  const nestedTask = await rp(`proj${stamp}/task`);
  const plain = await mk(`T02 plain ${stamp}`);
  await tagOn(plain, nestedTask);
  out.nestedTaskPlainNote = `inBootstrap=${(await bootTitles()).includes(`T02 plain ${stamp}`)} inAgenda=${await agendaHas(`T02 plain ${stamp}`)} directGet=${(await page.request.get(`/api/nodes/${plain}`)).status()}`;
  await page.request.delete(`/api/nodes/${nestedTask}`, H);

  console.log(`AUDIT TAG-02 ${JSON.stringify(out)}`);
});
