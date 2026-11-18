// The screens that are audited. Each `go(h)` brings the app to that screen from anywhere and leaves it open
// (dialogs and menus stay open: the rules look at the topmost one). Screens a width does not have throw `Skip`.
import { IDS } from "./seed.mjs";
import { installHelpers } from "./env.mjs";

export class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

/** Open an address inside the app and wait until it has drawn something. */
async function open(h, query) {
  await h.page.goto(h.site.base + query);
  await h.page.getByRole("button", { name: /^(筆記|任務)$/ }).first().waitFor({ timeout: 60_000 });
  await h.page.waitForTimeout(1100);
  await installHelpers(h.page);
}
const note = (id, lens = "editor") => `?view=notes&node=${id}&lens=${lens}`;
const byName = (h, name, opts = {}) => h.page.getByRole(opts.role ?? "button", { name, exact: opts.exact ?? true });
async function click(loc, what) {
  const first = loc.first();
  try { await first.waitFor({ state: "visible", timeout: 12_000 }); } catch { skip(`找不到「${what}」`); }
  await first.click();
}
async function settle(h, ms = 700) { await h.page.waitForTimeout(ms); await installHelpers(h.page); }
/** On a phone the sidebar tree is a page of its own; a note is opened from it. */
/** On a phone: the notes list page, on its 「筆記」 tab. */
async function goList(h) {
  await click(h.page.getByRole("button", { name: "筆記列表" }), "筆記列表"); await settle(h);
  const tab = h.page.getByRole("button", { name: "筆記", exact: true });
  if (await tab.count()) await tab.first().click().catch(() => {});
  await settle(h, 400);
}

export const SCREENS = [
  { id: "note-long", name: "筆記：長內文、有標籤", go: (h) => open(h, note(IDS.long)) },
  { id: "split-note-note", name: "並排：兩則筆記，左邊拖到 0.3", async go(h) {
    if (h.phone) skip("手機沒有並排");
    await open(h, `${note(IDS.long)}&right=note:${IDS.parent}:content`);
    await h.page.evaluate(() => document.querySelector(".split-root")?.style.setProperty("--split-ratio", "0.3"));
    await settle(h, 500);
  } },
  { id: "note-children", name: "筆記：有子筆記", go: (h) => open(h, note(IDS.parent)) },
  { id: "note-parent-picker", name: "筆記：打開「移到…」的上層清單（標題上方）", async go(h) {
    await open(h, note(IDS.childB));
    if (h.phone) {
      await click(h.page.getByRole("button", { name: /^此筆記的位置/ }), "手機的位置列"); await settle(h, 500);
      await click(h.page.getByRole("menuitem", { name: "移動到別處…" }), "移動到別處…");
    } else {
      await h.page.locator(".note-topbar").hover();
      await click(h.page.getByRole("button", { name: "移到…", exact: true }), "移到…");
    }
    await settle(h, 700);
  } },
  { id: "note-parent-picker-top", name: "筆記：頂層筆記打開「放到筆記底下」清單", async go(h) {
    await open(h, note(IDS.long));
    if (h.phone) await click(h.page.getByRole("button", { name: "放到…" }), "放到…");
    else { await h.page.locator(".note-topbar").hover(); await click(h.page.getByRole("button", { name: "放到筆記底下", exact: true }), "放到筆記底下"); }
    await settle(h, 700);
  } },
  { id: "note-more-menu", name: "筆記：⋯ 選單／手機底部面板", async go(h) {
    await open(h, note(IDS.long));
    await click(h.page.getByRole("button", { name: "更多動作" }), "更多動作"); await settle(h);
  } },
  { id: "note-new-view-menu", name: "筆記：⋯ 選單裡的「新增檢視」", async go(h) {
    await open(h, note(IDS.parent));
    await click(h.page.getByRole("button", { name: "更多動作" }), "更多動作"); await settle(h);
  } },
  { id: "info-features", name: "資訊欄：功能分頁", async go(h) { await open(h, note(IDS.long)); await infoTab(h, "功能"); } },
  { id: "info-tags", name: "資訊欄：標籤分頁", async go(h) { await open(h, note(IDS.long)); await infoTab(h, "標籤"); } },
  { id: "info-relations", name: "資訊欄：關係分頁", async go(h) { await open(h, note(IDS.long)); await infoTab(h, "關係"); } },
  { id: "tree-expanded", name: "側欄筆記樹：展開、選取、長標題", async go(h) {
    await open(h, note(IDS.childB));
    if (h.phone) await goList(h);
    const expand = h.page.getByRole("button", { name: "展開", exact: true });
    if (await expand.count()) { await expand.first().click().catch(() => {}); await settle(h); }
  } },
  { id: "tree-selected-parent", name: "側欄筆記樹：選取有子筆記的那一列（展開箭頭）", async go(h) {
    await open(h, note(IDS.parent));
    if (h.phone) await goList(h);
  } },
  { id: "tags-list", name: "標籤頁（列表）", async go(h) { await openTag(h); } },
  { id: "tags-table", name: "標籤頁（表格檢視）", async go(h) { await openTag(h); await click(h.page.getByRole("button", { name: "新增檢視" }), "新增檢視"); await settle(h);
    await click(h.page.getByText("表格", { exact: true }), "表格"); await settle(h, 1500); } },
  // The card is hidden everywhere else (env.mjs). It shows only to an account older than the build: build with
  // ONDEN_BUILT_AT_MS far in the future (see the README), or this screen has nothing to look at and says so.
  { id: "whats-new-card", name: "「這次更新」卡片（桌面）／「有新功能」小條（手機）浮在筆記上", async go(h) {
    await open(h, note(IDS.long));
    await h.page.addStyleTag({ content: ".device-notices--whats-new { display: flex !important; }" });
    try { await h.page.locator(".device-notices--whats-new").first().waitFor({ state: "visible", timeout: 12_000 }); }
    catch { skip("這個建置不會對新帳號顯示卡片（要用 ONDEN_BUILT_AT_MS 建一個「未來」的建置）"); }
  } },
  { id: "daily", name: "日記／今天", go: (h) => open(h, "?view=daily") },
  { id: "daily-date-picker", name: "日期選擇器／月曆", async go(h) {
    await open(h, "?view=daily");
    await click(h.page.getByRole("button", { name: /\d{4}年\d{1,2}月\d{1,2}日/ }), "日記的日期按鈕"); await settle(h);
  } },
  { id: "tasks", name: "任務", go: (h) => open(h, "?view=tasks") },
  { id: "inbox", name: "收件匣", async go(h) {
    await open(h, note(IDS.long));
    if (h.phone) await goList(h);
    await click(h.page.getByRole("button", { name: "收件匣" }).or(h.page.getByRole("tab", { name: "收件匣" })), "收件匣"); await settle(h);
  } },
  { id: "search-sidebar", name: "搜尋（側欄）", async go(h) {
    await open(h, note(IDS.long));
    if (h.phone) await goList(h);
    await click(h.page.getByRole("button", { name: "搜尋筆記" }), "搜尋筆記");
    await h.page.keyboard.type("版面"); await settle(h, 1200);
  } },
  { id: "search-palette", name: "搜尋（指令面板）", async go(h) {
    await open(h, note(IDS.long));
    if (h.phone) { await click(h.page.getByRole("button", { name: "筆記列表" }), "筆記列表"); await settle(h); await click(h.page.getByRole("button", { name: "搜尋", exact: true }), "搜尋"); }
    else await h.page.keyboard.press("Control+k");
    await settle(h, 600); await h.page.keyboard.type("版面"); await settle(h, 1000);
  } },
  { id: "settings", name: "設定", async go(h) { await openSettings(h); } },
  { id: "settings-more", name: "設定（其他分頁）", async go(h) { await openSettings(h, 2); } },
  { id: "canvas", name: "白板", go: (h) => open(h, note(IDS.parent, "canvas")) },
  { id: "slides", name: "簡報檢視", async go(h) {
    await open(h, note(IDS.long));
    if (h.phone) { await click(h.page.getByRole("button", { name: "資訊" }), "資訊"); await settle(h); }
    const features = h.page.getByRole("tab", { name: "功能" }); // the info panel remembers its last tab
    if (await features.count()) { await features.first().click(); await settle(h, 400); }
    await click(h.page.getByRole("button", { name: /簡報/ }).or(h.page.getByRole("tab", { name: /簡報/ })), "簡報"); await settle(h, 1500);
  } },
  { id: "history", name: "歷史", async go(h) {
    await open(h, note(IDS.long));
    await click(h.page.getByRole("button", { name: /打開這篇筆記的歷史/ }), "歷史"); await settle(h, 1200);
  } },
  { id: "create-panel", name: "建立面板（＋）", async go(h) {
    await open(h, note(IDS.long));
    if (h.phone) { await click(h.page.getByRole("button", { name: "捕捉" }), "捕捉"); }
    else await click(h.page.getByRole("button", { name: "建立", exact: true }), "建立");
    await settle(h);
  } },
];

async function infoTab(h, name) {
  const toggle = h.page.getByRole("button", { name: "資訊", exact: true }).first();
  if (h.phone) { await click(toggle, "資訊"); await settle(h); }
  else if ((await toggle.getAttribute("aria-pressed").catch(() => null)) === "false") { await toggle.click(); await settle(h); }
  await click(h.page.getByRole("tab", { name }).or(h.page.getByRole("button", { name, exact: true })), `資訊欄的「${name}」`);
  await settle(h);
}
async function openTag(h) {
  await open(h, note(IDS.long));
  if (h.phone) { await click(h.page.getByRole("button", { name: "筆記列表" }), "筆記列表"); await settle(h); await click(h.page.getByRole("button", { name: "標籤", exact: true }), "標籤"); await settle(h); }
  // The sidebar's 標籤 section stays folded once something folded it (the 「展開」 button of the tree does).
  if (!(await h.page.getByRole("button", { name: /打開 #專案/ }).count())) { await h.page.getByRole("button", { name: "標籤", exact: true }).first().click().catch(() => {}); await settle(h, 500); }
  await click(h.page.getByRole("button", { name: /打開 #專案/ }).or(h.page.getByRole("link", { name: /打開 #專案/ })), "標籤 #專案"); await settle(h, 1200);
}
async function openSettings(h, which = 1) {
  await open(h, note(IDS.long));
  if (h.phone) await goList(h);
  // A computer has the gear at the end of the top bar; a phone has the row in the avatar's sheet.
  if (!h.phone) { await click(h.page.locator(".app-topbar .topbar-settings"), "設定"); await settle(h, 1000); }
  else {
    await click(h.page.getByRole("button", { name: /^我/ }).or(h.page.getByRole("button", { name: "帳號" })), "帳號選單"); await settle(h);
    await click(h.page.getByRole("button", { name: "設定", exact: true }), "設定"); await settle(h, 1000);
  }
  if (which === 2) {
    await click(h.page.getByRole("dialog").getByRole("button", { name: "外觀" }), "設定的「外觀」"); await settle(h, 800);
  }
}
