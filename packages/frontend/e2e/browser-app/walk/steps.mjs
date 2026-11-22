// The named steps of a walk (see kit.mjs). Each is `{ name, run(walk) }`: it does one thing a person does, then checks what
// a person would see with their eyes. Steps leave what the next one needs on `walk.notes` / `walk.marks`.
// Nothing here sleeps: every wait is on an element, a rect that stopped moving, or the store's saved flag.
import { noteIdOf, pollUntil, READY_TEXT, readNote, settledRect, waitStored } from "./kit.mjs";

const step = (name, run) => ({ name, run });
const WAIT = { timeout: 15_000 }; // a bound for a wait on the app, not a pause

// ── what a typed note looks like ────────────────────────────────────────────────────────────────────────────────────
/** The keys of a student's note: a heading, a sentence ending in a tag, two checkbox lines (the list carries on by itself),
 *  an empty Enter to leave the list, and a quote. */
export const NOTE_LINES = ["## 定義", "LL(1) 文法要先算 First 集合，再算終端符號的 Follow #編譯器", "- [ ] 做歷屆 BA2_A", "讀完第 4 章"];
export const QUOTE = "> 若 A → aβ，則 a 屬於 First(A)。";
/** The saved markdown that typing NOTE_LINES, Enter, Enter, QUOTE must give (the second Enter takes the empty item away). */
export const NOTE_MARKDOWN = "## 定義\nLL(1) 文法要先算 First 集合，再算終端符號的 Follow #編譯器\n- [ ] 做歷屆 BA2_A\n- [ ] 讀完第 4 章\n> 若 A → aβ，則 a 屬於 First(A)。";
export const BODY_WORD = "終端"; // only in the body of the typed note
const SNIPPET_WORD = "終端符號";

/** Typing speeds: a person's, and as fast as the driver can send. */
export const PACE = { human: { name: "人的速度", delayMs: 70 }, fast: { name: "驅動程式能送多快就多快", delayMs: 0 } };

// ── small shared pieces ─────────────────────────────────────────────────────────────────────────────────────────────
const sidebar = (w) => w.page.locator(".obsidian-sidebar");
const topbar = (w) => w.page.locator(".app-topbar");

/** Open the create panel from the sidebar's 「建立」 and return where the button and the panel are once the panel stopped moving. */
export async function openCreatePanel(w) {
  const button = sidebar(w).getByRole("button", { name: "建立", exact: true });
  const buttonRect = await button.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
  await w.press(button);
  const panel = w.page.locator(".create-sheet-popover");
  return { panel, buttonRect, panelRect: await settledRect(panel) };
}
const cancelCreatePanel = async (w, panel) => { await w.press(panel.getByRole("button", { name: "取消", exact: true })); await panel.waitFor({ state: "detached" }); };

/** Pick a note in the sidebar list by its title and wait until it is the open one. */
export async function openNoteFromList(w, title) {
  await w.press(sidebar(w).locator(".sb-item-title", { hasText: title }).first());
  await w.page.waitForFunction((t) => document.querySelector(".obsidian-title-input")?.value === t, title, WAIT);
}

/** What a person sees on the top part of the first handwriting page: a screenshot of that part of the window, read pixel by pixel (not
 *  the app's own canvases, whose size and layers are the app's business). Ink = pixels that differ from the blank page (`blank`, an earlier
 *  result; without it nothing counts as ink, so the first call is the blank page itself). `on` = share of `path` points (fractions of the
 *  page) with ink within 5 px; `off` = far-away points with ink; `total` = ink pixels, -1 when the page is not where the blank one was.
 *  `sized` = the picture behind the page is as big as the page shows (device pixels × width). */
async function probeInk(page, path, blank = null) {
  const surface = page.locator(".page-ink-surface").first();
  const info = await surface.evaluate((el) => {
    const box = el.getBoundingClientRect(), cs = [...el.querySelectorAll("canvas")];
    return { x: box.x, y: box.y, width: box.width, height: box.height, size: cs.map((c) => `${c.width}x${c.height}`), sized: cs.length > 0 && cs.every((c) => Math.abs(c.width - Math.round(box.width * devicePixelRatio)) <= 1) };
  });
  // Only the part of the page above the docked toolbar (below it the window covers the page).
  const clip = { x: info.x, y: info.y, width: info.width, height: Math.min(info.height, 430) };
  const png = await page.screenshot({ clip });
  const seen = await page.evaluate(async ({ now, before, path, page: pg, clip }) => {
    const read = async (base64) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" }));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const a = await read(now), b = before ? await read(before) : null;
    if (b && (a.width !== b.width || a.height !== b.height)) return { on: 0, off: 0, total: -1 };
    const { data, width, height } = a;
    const scale = width / clip.width;
    const inked = (i) => !!b && Math.abs(data[i] - b.data[i]) + Math.abs(data[i + 1] - b.data[i + 1]) + Math.abs(data[i + 2] - b.data[i + 2]) > 120;
    const radius = Math.round(5 * scale);
    const near = (cssX, cssY) => {
      const cx = Math.round(cssX * scale), cy = Math.round(cssY * scale);
      for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) if (inked((y * width + x) * 4)) return true;
      return false;
    };
    const away = [[30, 380], [330, 380], [620, 30], [620, 330], [30, 300], [330, 400]];
    let total = 0;
    for (let i = 0; i < data.length; i += 4) if (inked(i)) total++;
    return { on: path.filter(([fx, fy]) => near(fx * pg.width, fy * pg.height)).length / path.length, off: away.filter(([x, y]) => near(x, y)).length, total };
  }, { now: png.toString("base64"), before: blank?.png ?? null, path, page: { width: info.width, height: info.height }, clip });
  return { box: [Math.round(info.width), Math.round(info.height)], size: info.size, sized: info.sized, ...seen, png: png.toString("base64") };
}

// ── the steps ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const USABLE_WITHIN_MS = 10_000;

/** 1. A brand-new browser profile opens the site: the sample note is there, with the list beside it. */
export const opensOnSampleNote = step("1 打開網站（空的瀏覽器）", async (w) => {
  const { page, report } = w;
  const t0 = Date.now();
  await page.goto(w.site.base);
  await page.getByText(READY_TEXT).first().waitFor({ state: "visible" });
  await page.locator(".cm-content").first().waitFor({ state: "visible" });
  const ms = Date.now() - t0;
  w.marks.openedInMs = ms;
  report.check(ms <= USABLE_WITHIN_MS, `筆記列表和編輯器在 ${USABLE_WITHIN_MS / 1000} 秒內都在（從開始載入量起）`, `${ms} ms`);
  report.check(await page.locator(".obsidian-title-input").inputValue() === READY_TEXT, "開在範例筆記「歡迎來到 Onden 試用版」");
  report.check(await sidebar(w).locator(".sb-item-title").count() >= 4, "側欄列出範例筆記");
  const banner = page.locator(".welcome-banner").first();
  w.marks.bannerHeightOnSample = await banner.evaluate((el) => Math.round(el.getBoundingClientRect().height)).catch(() => 0);
  report.observe("語言橫幅「歡迎使用 Onden」在範例筆記上方的高度（px）", w.marks.bannerHeightOnSample);
});

/** 2. 「建立」 opens a panel that is whole, clear of the top bar, and under the button it came from — the first time and the second. */
export const createPanelIsAnchored = step("2 「建立」面板的位置（第一次、第二次）", async (w) => {
  const { report, page } = w;
  const topbarBottom = await topbar(w).evaluate((el) => el.getBoundingClientRect().bottom);
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  for (const [i, label] of ["第一次打開", "第二次打開"].entries()) {
    const { panel, buttonRect, panelRect: p } = await openCreatePanel(w);
    const inside = p.x >= 0 && p.y >= 0 && p.right <= view.w && p.bottom <= view.h;
    const clearOfTopbar = p.y >= topbarBottom;
    const underButton = Math.abs(p.x - buttonRect.x) <= 24 && p.y >= buttonRect.bottom - 2 && p.y <= buttonRect.bottom + 24;
    const where = `面板 (${Math.round(p.x)},${Math.round(p.y)}) ${Math.round(p.width)}×${Math.round(p.height)}，按鈕 (${Math.round(buttonRect.x)},${Math.round(buttonRect.y)})`;
    report.check(inside, `${label}：面板整個在視窗內`, where);
    if (i === 0) {
      // Seen on the first open after load (2026-11-17, local build of main): the panel sits at (8,8) over the top bar.
      report.expectFail(clearOfTopbar, `${label}：面板沒有蓋住上方列`, "第一次打開時面板停在視窗左上角 (8,8)，蓋住上方列；之後才錨在按鈕下方");
      report.expectFail(underButton, `${label}：面板錨在按下去的按鈕下方`, "同上：第一次沒有錨定");
    } else {
      report.check(clearOfTopbar, `${label}：面板沒有蓋住上方列`, where);
      report.check(underButton, `${label}：面板錨在按下去的按鈕下方`, where);
    }
    await cancelCreatePanel(w, panel);
  }
});

/** 3. Make a note from the panel and type into it: `pace` is how fast the keys come. */
export const createNoteAndType = ({ pace, title }) => step(`3 建立筆記並打字（${pace.name}）`, async (w) => {
  const { page, report } = w;
  const { panel } = await openCreatePanel(w);
  await w.press(panel.getByRole("radio", { name: "筆記", exact: true }));
  const openBefore = noteIdOf(page);
  await w.press(panel.getByRole("button", { name: "建立", exact: true }));
  await page.waitForFunction((before) => { const id = new URL(location.href).searchParams.get("node"); return id && id !== before; }, openBefore, WAIT);
  const id = noteIdOf(page);
  await page.waitForFunction(() => document.activeElement?.classList.contains("obsidian-title-input"), null, { timeout: 3000 }).then(() => report.check(true, "建立後游標在標題")).catch(() => report.check(false, "建立後游標在標題", "標題沒有拿到焦點"));
  const key = { delay: pace.delayMs };
  await page.keyboard.type(title, key);
  await page.keyboard.press("Enter", key);
  report.check(await page.evaluate(() => !!document.activeElement?.closest(".cm-content")), "標題打完按 Enter，游標到內文");
  for (const line of NOTE_LINES) { await page.keyboard.type(line, key); await page.keyboard.press("Enter", key); }
  await page.keyboard.press("Enter", key);
  await page.keyboard.type(QUOTE, key);

  report.check(await page.locator(".obsidian-title-input").inputValue() === title, "標題是打的那一行", await page.locator(".obsidian-title-input").inputValue());
  // What the document holds, in order: read back from the app's own store once the save landed (a lost or reordered key shows here).
  const saved = await pollUntil(page, () => readNote(page, id), (n) => n?.markdown === NOTE_MARKDOWN, { timeout: 10_000 });
  report.check(saved?.markdown === NOTE_MARKDOWN, "每一行都在文件裡，順序沒亂，沒有掉字", saved?.markdown === NOTE_MARKDOWN ? "" : JSON.stringify(saved?.markdown));
  report.check(saved?.markdown?.split("\n").filter((l) => /^- \[ \] /.test(l)).length === 2, "第二個勾選項目是清單自己接下去的（沒有打 「- [ ] 」）");
  report.check(await page.locator(".cm-content .cm-line").count() === NOTE_MARKDOWN.split("\n").length, "畫面上的行數和文件一致");
  const listed = await sidebar(w).locator(".sb-item-title", { hasText: title }).first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
  report.check(listed, "側欄列表出現這則新筆記");
  w.notes[pace === PACE.human ? "human" : "fast"] = { id, title };
  if (pace === PACE.human) {
    const banner = page.locator(".welcome-banner").first();
    report.observe("語言橫幅在這則新筆記上方的高度（px，0 = 沒有）", await banner.evaluate((el) => Math.round(el.getBoundingClientRect().height)).catch(() => 0));
  }
});

/** 4. Upload a PDF from 「建立」 → 「上傳檔案」: the file chooser, then the note with its first page drawn. */
export const uploadsPdf = ({ makePdf, fileName }) => step("4 上傳 PDF", async (w) => {
  const { page, report } = w;
  const { panel } = await openCreatePanel(w);
  let chooserBeforeCreate = false;
  const onChooser = () => { chooserBeforeCreate = true; };
  page.once("filechooser", onChooser);
  await w.press(panel.getByRole("radio", { name: "上傳檔案", exact: true }));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  report.observe("選了「上傳檔案」類型後，檔案選擇器有沒有立刻打開", chooserBeforeCreate ? "有" : "沒有（要再按一次「建立」）");
  page.off("filechooser", onChooser);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), w.press(panel.getByRole("button", { name: "建立", exact: true }))]);
  await chooser.setFiles({ name: fileName, mimeType: "application/pdf", buffer: makePdf() });
  const stem = fileName.replace(/\.pdf$/, "");
  await page.waitForFunction((t) => document.querySelector(".obsidian-title-input")?.value === t, stem, WAIT);
  report.check(true, `開了以檔名命名的筆記「${stem}」`);
  // The page is drawn, or the viewer says it could not load: either ends the wait; then what a person sees is checked.
  const failed = page.getByText("無法載入這份 PDF");
  const drawn = page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((c) => !c.closest(".page-ink-surface") && c.width > 200 && c.height > 200 && (() => { const px = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data; if (!px) return false; for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && px[i] < 100) return true; return false; })()), null, { timeout: 20_000 });
  await Promise.race([failed.waitFor({ state: "visible", timeout: 20_000 }), drawn]).catch(() => {});
  report.check(!(await failed.isVisible()), "沒有「無法載入這份 PDF」");
  const dark = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((c) => !c.closest(".page-ink-surface") && c.width > 200 && c.height > 200);
    if (!c) return -1;
    const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && px[i] < 100) n++;
    return n;
  });
  report.check(dark > 200, "第一頁畫成圖：畫布上有深色的字（不是空白）", dark < 0 ? "沒有畫布" : `${dark} 個深色像素`);
});

/** 5. Tasks page: write down what shows for the two checkbox lines; what the tag list shows for #編譯器. Asserts nothing (a product decision is open). */
export const looksAtTasksPage = step("5 任務頁（只記錄，不判斷）", async (w) => {
  const { page, report } = w;
  report.observe("側欄的標籤列有沒有 #編譯器", (await sidebar(w).getByRole("button", { name: "打開 #編譯器" }).count()) > 0);
  await w.press(topbar(w).getByRole("button", { name: "任務", exact: true }));
  await page.getByText("把試用版逛一圈").first().waitFor({ state: "visible" });
  const text = await page.locator("main, .workspace-grid").first().innerText();
  report.observe("任務頁有「做歷屆 BA2_A」", text.includes("做歷屆 BA2_A"));
  report.observe("任務頁有「讀完第 4 章」", text.includes("讀完第 4 章"));
  report.observe("任務頁的分頁標籤", text.match(/(今天|接下來|隨時|某天)\d+/g) ?? []);
  const plus = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0 && /^[+＋]$|新增|建立|加上/.test((b.getAttribute("aria-label") || b.innerText).trim())).map((b) => `${(b.getAttribute("aria-label") || b.innerText).trim()}@${Math.round(b.getBoundingClientRect().x)},${Math.round(b.getBoundingClientRect().y)}`));
  report.observe("任務頁看得見的「＋／新增／建立」按鈕", plus);
  await w.press(topbar(w).getByRole("button", { name: "筆記", exact: true }));
  await sidebar(w).locator(".sb-item-title").first().waitFor({ state: "visible" });
});

/** 6. The search box finds a note by a word only its body has: `query` typed like a person; `expectFailReason` marks a known-red case. */
export const searchFindsByBodyWord = ({ query, expectFailReason = null }) => step(`6 搜尋「${query}」`, async (w) => {
  const { page, report } = w;
  const title = w.notes.human.title;
  await w.press(topbar(w).getByText("搜尋…").first());
  await page.waitForFunction(() => document.activeElement?.classList.contains("ui-search__input"), null, WAIT);
  await page.keyboard.type(query, { delay: 40 });
  // Either the note comes back with the body's sentence under it, or the palette keeps showing its recent list: both end the wait.
  const hit = page.locator("dialog[open] .palette-item", { hasText: SNIPPET_WORD }).filter({ hasText: title });
  await Promise.race([hit.first().waitFor({ state: "visible", timeout: 10_000 }), page.getByText("最近筆記").first().waitFor({ state: "visible", timeout: 10_000 })]).catch(() => {});
  const found = (await hit.count()) > 0;
  const marked = found ? await hit.first().locator("mark.palette-hl").allInnerTexts() : [];
  const what = `「${query}」（${[...query].length} 個字）找到筆記「${title}」，並標出搜尋的字`;
  const ok = found && marked.join("").includes(query);
  if (expectFailReason) report.expectFail(ok, what, expectFailReason); else report.check(ok, what, ok ? "" : `找到 ${found}，標出 ${JSON.stringify(marked)}`);
  // Esc clears the box first and closes the palette on the next press.
  for (let i = 0; i < 3 && (await page.locator("dialog[open]").count()) > 0; i++) await page.keyboard.press("Escape");
  report.check((await page.locator("dialog[open]").count()) === 0, "按 Esc 關掉搜尋面板");
});

/** 7. Back in the note: add the 「手寫」 tab and draw one stroke with the pen; the page shows ink where the pen went. */
export const drawsOneStroke = step("7 回到筆記，加「手寫」分頁並畫一筆", async (w) => {
  const { page, report } = w;
  await openNoteFromList(w, w.notes.human.title);
  await w.press(page.getByRole("button", { name: "新增檢視" }).first());
  await w.press(page.locator("dialog[open], [role=dialog]").getByText("手寫", { exact: true }).first());
  const surface = page.locator(".page-ink-surface").first();
  await surface.waitFor({ state: "visible" });
  report.check(await page.getByRole("tab", { name: "手寫" }).count() === 1, "分頁列多了「手寫」");
  const banner = page.locator(".welcome-banner").first();
  report.observe("語言橫幅在手寫頁上方的高度（px，0 = 沒有）", await banner.evaluate((el) => Math.round(el.getBoundingClientRect().height)).catch(() => 0));
  const box = await settledRect(surface);
  const path = Array.from({ length: 13 }, (_, i) => [0.2 + (i * 14) / box.width, 0.2 + (Math.sin(i / 2) * 30) / box.height]);
  // The picture behind the page must be as big as the page shows (device pixels × width); when it is not (see canvasFollowsPageWidth,
  // the same defect), a stroke lands at the wrong place, so the position checks below are made only when it is.
  const settledSize = await pollUntil(page, () => probeInk(page, path), (r) => r.sized, { timeout: 3_000 });
  const blankPage = { png: settledSize.png };
  w.marks.inkSized = settledSize.sized;
  report.observe("畫之前，手寫頁的畫布大小和頁面一致", settledSize.sized ? "是" : `不是（畫布 ${settledSize.size?.join("、")}，頁面寬 ${settledSize.box?.[0]} px）`);
  
  const at = ([fx, fy]) => [box.x + fx * box.width, box.y + fy * box.height];
  await page.mouse.move(...at(path[0]));
  await page.mouse.down();
  for (const point of path.slice(1)) await page.mouse.move(...at(point), { steps: 2 });
  await page.mouse.up();
  // The ink is painted a few frames after the pointer is released (the stroke is drawn in pieces): read again each frame until it shows.
  const ink = await pollUntil(page, () => probeInk(page, path, blankPage), (r) => (w.marks.inkSized ? r.on >= 0.9 : r.total > 0), { timeout: 10_000 });
  w.marks.ink = { path, total: ink.total, blank: blankPage };
  report.check(ink.total > 0, "畫面上多了墨", `${ink.total} 個像素`);
  if (w.marks.inkSized) {
    report.check(ink.on >= 0.9, "筆走過的地方都有墨", `${Math.round(ink.on * 100)}% 的路徑點有墨`);
    report.check(ink.off === 0, "筆沒走過的地方沒有墨", `${ink.off} 個遠處的點有墨`);
  } else report.observe("略過「墨在筆走過的地方」的檢查", "畫布大小不對（見步驟 10），位置沒有意義");
});

/** 8. 「放大」: the handwriting page covers the window; Esc gives the earlier layout back. */
export const enlargesAndRestores = step("8 放大手寫頁，再按 Esc", async (w) => {
  const { page, report } = w;
  const surface = page.locator(".page-ink-surface").first();
  const before = await settledRect(surface);
  const barBefore = await topbar(w).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const barHit = () => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".app-topbar"), barBefore);
  report.check(await barHit(), "放大前，上方列點得到");
  await w.press(page.getByRole("button", { name: "放大畫面" }).first());
  const pane = page.locator(".pane--expanded");
  const rect = await settledRect(pane);
  report.check(rect.x === 0 && rect.y === 0 && rect.width === view.w && rect.height === view.h, "放大後，手寫頁等於整個視窗", `${rect.x},${rect.y} ${rect.width}×${rect.height}，視窗 ${view.w}×${view.h}`);
  report.check(!(await barHit()), "放大後，上方列被蓋住、點不到");
  await page.keyboard.press("Escape");
  await pane.waitFor({ state: "detached" });
  const after = await settledRect(surface);
  report.check(["x", "y", "width", "height"].every((k) => Math.abs(after[k] - before[k]) < 1), "按 Esc 後，回到放大前的位置和大小", `前 ${Math.round(before.x)},${Math.round(before.y)} ${Math.round(before.width)}×${Math.round(before.height)}，後 ${Math.round(after.x)},${Math.round(after.y)} ${Math.round(after.width)}×${Math.round(after.height)}`);
  report.check(await barHit(), "按 Esc 後，上方列又點得到");
});

/** 9. Reload: the same note, the same tab, the ink where it was. */
export const reloadKeepsNoteTabAndInk = step("9 重新整理", async (w) => {
  const { page, report } = w;
  const url = page.url();
  const idBefore = noteIdOf(page);
  await page.reload();
  // The 手寫 tab has no title box: the page is there when its surface is.
  await page.locator(".page-ink-surface").first().waitFor({ state: "visible" });
  report.check(noteIdOf(page) === idBefore && page.url() === url, "還是同一則筆記", page.url() === url ? "" : "網址變了");
  const stillOnTab = await page.getByRole("tab", { name: "手寫", selected: true }).waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  report.check(stillOnTab, "還是在「手寫」分頁");
  const { path, total, blank } = w.marks.ink;
  // The page repaints its ink after it (re)sizes the picture: ready = right size and ink painted.
  const paintFrom = Date.now();
  const ink = await pollUntil(page, () => probeInk(page, path, blank), (r) => (r.sized && w.marks.inkSized ? r.on >= 0.9 : r.total !== 0), { timeout: 10_000 });
  report.observe("重新整理後，墨出現花的時間（ms）", ink.total > 0 ? Date.now() - paintFrom : "沒有出現（等了 10 秒）");
  const stored = await page.evaluate(async (id) => { const a = await (await fetch(`/api/nodes/${id}/attributes?keys=note_ink`)).json(); return ((Array.isArray(a) ? a : []).find((x) => x.key === "note_ink")?.value ?? "").split('"points"').length - 1; }, idBefore);
  report.check(stored >= 1, "重新整理後，筆記裡存著這一筆", `${stored} 筆`);
  // About two reloads in ten on the tablet profile, the note holds the stroke (the check above) but the page comes back blank and stays so;
  // a person would think the stroke was lost. No cause found yet: this check is red when it happens, and says so.
  const drawnBack = (w.marks.inkSized && ink.sized) ? ink.on >= 0.9 && ink.off === 0 : ink.total > 0;
  report.check(drawnBack, "重新整理後，筆記裡存著的那一筆畫回頁面上", `筆跡存著（${stored} 筆），等了 10 秒：${Math.round(ink.on * 100)}% 的路徑點有墨，${ink.total} 個像素`);
  if (drawnBack && w.marks.inkSized && ink.sized) report.observe("墨的量（和空白頁不同的像素）：重新整理前、後", `${total}、${ink.total}（一輪量到 1866 對 2141，原因沒查；多數輪相同，所以不當斷言）`);
  await waitStored(page);
});

/** 10. The info panel opens and closes beside the handwriting page: the page's picture follows the page's width.
 *  Today it stays one step behind (PageInkSurface sizes its canvases from the host's width at the moment the page box changes, and
 *  the host has not changed yet), so a stroke drawn after the panel moved lands in the wrong place; the same lag is why the picture is
 *  sometimes the wrong size the first time the tab opens. */
export const canvasFollowsPageWidth = step("10 開關資訊面板，手寫頁的畫布跟著頁面寬度", async (w) => {
  const { page, report } = w;
  const surface = page.locator(".page-ink-surface").first();
  const bad = [];
  for (const label of ["關上", "再打開"]) {
    await w.press(page.getByRole("button", { name: "資訊" }).first());
    const rect = await settledRect(surface);
    const now = await pollUntil(page, () => probeInk(page, [[0.5, 0.5]]), (r) => r.sized, { timeout: 3_000 });
    if (!now.sized) bad.push(`${label}資訊面板後，頁面寬 ${Math.round(rect.width)} px，畫布 ${now.size.join("、")}`);
  }
  report.expectFail(bad.length === 0, "資訊面板開關後，手寫頁的畫布大小 = 頁面寬 × 裝置像素", bad.join("；") || "畫布大小跟著頁面");
});

/** Last: what the page reported during the whole walk. */
export const nothingWentWrong = step("全程：沒有錯誤、沒有失敗的請求", async (w) => {
  const { report, problems } = w;
  const allowed = problems.filter((p) => p.allowed);
  const unexpected = problems.filter((p) => !p.allowed);
  for (const [reason, items] of Object.entries(Object.groupBy(allowed, (p) => p.allowed))) report.observe(`允許的（${items.length} 筆）`, `${reason} — ${[...new Set(items.map((i) => i.kind))].join("、")}`);
  report.check(unexpected.length === 0, "沒有主控台錯誤、沒有失敗的請求、沒有頁面例外", unexpected.map((p) => `${p.kind}: ${p.text}`).join(" | "));
});
