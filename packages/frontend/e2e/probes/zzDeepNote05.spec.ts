// Feature-audit deepening (2026-10-08): NOTE-05 — continuous Chinese IME input
// simulated with CDP Input.imeSetComposition / insertText: long sessions in
// the editor with autosave firing mid-composition, composition in the title
// field, Enter while composing in the editor and in quick capture.
import { test } from "@playwright/test";
import { ready, openQuickCaptureByHotkey, H } from "../fullstack/helpers";


test("NOTE-05: continuous IME composition", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const cdp = await page.context().newCDPSession(page);
  const compose = async (pinyinSteps: string[], commit: string, pauseMs = 120) => {
    for (const s of pinyinSteps) { await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length }); await page.waitForTimeout(pauseMs); }
    await cdp.send("Input.insertText", { text: commit });
  };
  const words: Array<[string[], string]> = [
    [["z", "zh", "zho", "zhon", "zhong"], "中"], [["w", "we", "wen"], "文"], [["s", "sh", "shu", "shu r", "shu ru"], "輸入"],
    [["c", "ce", "ces", "cesh", "ceshi"], "測試"], [["b", "bi", "bij", "biji"], "筆記"],
  ];
  const id = (await (await page.request.post("/api/nodes", { ...H, data: { title: `IME ${stamp}`, markdown: "開頭" } })).json()).id as string;
  const body = async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).markdown as string;
  try {
  await ready(page, `/?view=notes&node=${id}&lens=editor`);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+End");
  // 10 rounds of 5 words; every 3rd round pauses 2s mid-composition (autosave debounce is 1.5s).
  let expected = "開頭";
  for (let r = 0; r < 10; r++) {
    for (const [steps, w] of words) {
      if (r % 3 === 2 && w === "輸入") {
        await cdp.send("Input.imeSetComposition", { text: "shu", selectionStart: 3, selectionEnd: 3 });
        await page.waitForTimeout(2000);
        await cdp.send("Input.insertText", { text: w });
      } else await compose(steps, w, 30);
      expected += w;
    }
    await page.keyboard.type("，"); expected += "，";
  }
  await page.waitForTimeout(2500);
  const server = await body();
  const editor = (await page.locator(".cm-content").first().innerText()).replace(/\n/g, "");
  out.editorLong = { expectedLen: expected.length, serverLen: server.length, equalServer: server === expected, equalEditor: editor === expected, latinLeak: /[a-z]/.test(server) };
  // Enter while composing in the editor: commits, then new line only after commit.
  await cdp.send("Input.imeSetComposition", { text: "hao", selectionStart: 3, selectionEnd: 3 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await cdp.send("Input.insertText", { text: "好" });
  await page.waitForTimeout(2500);
  out.enterDuringComposition = JSON.stringify((await body()).slice(-6));

  // Title field.
  const title = page.locator(".obsidian-title-input, [aria-label='Note title']").first();
  await title.click(); await page.keyboard.press("End");
  await compose(["x", "xi", "xin"], "新"); await compose(["b", "bi", "bia", "biao", "biaot", "biaoti"], "標題");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  out.title = (await (await page.request.get(`/api/nodes/${id}`)).json()).title;

  // Quick capture: Ctrl+Enter during composition must not save half-composed text.
  await openQuickCaptureByHotkey(page);
  const ta = page.locator(".quick-capture-textarea");
  await ta.waitFor();
  await ta.click();
  await compose(["k", "ka", "kai"], "開"); await compose(["h", "hu", "hui"], "會");
  await cdp.send("Input.imeSetComposition", { text: "ji", selectionStart: 2, selectionEnd: 2 });
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(800);
  out.captureCtrlEnterWhileComposing = { stillOpen: await ta.isVisible().catch(() => false), value: await ta.inputValue().catch(() => null) };
  if (await ta.isVisible().catch(() => false)) {
    await cdp.send("Input.insertText", { text: "記錄" });
    await ta.press("Control+Enter");
    await page.waitForTimeout(2000);
  }
  const nodes = ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ title: string }>).filter((n) => n.title.startsWith("開會"));
  out.captureSaved = nodes.map((n) => n.title).slice(-3);
  } finally {
    console.log("NOTE05 " + JSON.stringify(out, null, 2));
  }
});
