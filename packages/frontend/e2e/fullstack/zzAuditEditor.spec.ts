// Feature-audit loop probes (2026-10-07): NOTE-05, PDF-01, PDF-02.
// Browser-level evidence for rows that had no execution record. Chromium only
// (CDP IME composition); not a substitute for real IME / device input.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

const server = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/nodes/${id}`, H)).json()).markdown as string;

test("NOTE-05: paste, undo/redo, [[ completion and IME composition in the editor", async ({ page }) => {
  const stamp = Date.now();
  const target = await (await page.request.post("/api/nodes", { ...H, data: { title: `Target ${stamp}`, markdown: "t" } })).json();
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `Edit ${stamp}`, markdown: "" } })).json();
  await ready(page, `/?view=notes&node=${n.id}`);
  const ed = page.locator(".cm-content");
  await ed.click();

  // Paste plain text through a real ClipboardEvent.
  await ed.evaluate((el, text) => {
    const dt = new DataTransfer(); dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `pasted line ${stamp}`);
  console.log(`AUDIT NOTE-05 after paste: ${JSON.stringify(await ed.innerText())}`);

  // Undo / redo.
  await page.keyboard.type(" typed");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+z");
  const afterUndo = await ed.innerText();
  await page.keyboard.press("Control+Shift+Z"); // a real Ctrl+Shift+Z sends "Z"; lowercase z reads as Ctrl-z (undo)
  const afterRedo = await ed.innerText();
  console.log(`AUDIT NOTE-05 undo=${JSON.stringify(afterUndo)} redo=${JSON.stringify(afterRedo)}`);

  // [[ completion.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[[Target ");
  const popup = page.locator(".cm-tooltip-autocomplete");
  const popupVisible = await popup.isVisible({ timeout: 3000 }).catch(() => false);
  const options = popupVisible ? await popup.locator("li").allInnerTexts() : [];
  console.log(`AUDIT NOTE-05 [[ popup=${popupVisible} options=${JSON.stringify(options.slice(0, 5))}`);
  if (popupVisible) await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // IME composition (CDP): compose 中文 then commit.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
  await cdp.send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "中文" });
  await page.waitForTimeout(200);
  const text = await ed.innerText();
  console.log(`AUDIT NOTE-05 after IME: ${JSON.stringify(text)}`);

  await expect.poll(() => server(page, n.id), { timeout: 10_000 }).toContain("中文");
  const saved = await server(page, n.id);
  console.log(`AUDIT NOTE-05 saved=${JSON.stringify(saved)}`);
  expect(saved).toContain(`pasted line ${stamp}`);
  expect(saved).not.toContain("zhong");
  console.log(`AUDIT NOTE-05 link inserted=${saved.includes(`[[Target ${stamp}]]`)}`);
});

test("PDF-01: import a PDF from the sidebar, it renders and survives reload", async ({ page }) => {
  // Two-page PDF with text, so page count and navigation are observable.
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 7 0 R>>>>/Contents 4 0 R>>",
    null,
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 7 0 R>>>>/Contents 6 0 R>>",
    null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const stream = (t: string) => { const c = `BT /F1 24 Tf 72 720 Td (${t}) Tj ET`; return `<</Length ${c.length}>>stream\n${c}\nendstream`; };
  objs[3] = stream("Audit page one"); objs[5] = stream("Audit page two");
  let pdf = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj${o}endobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;

  await ready(page, "/?view=notes");
  await page.getByRole("button", { name: "Create new node" }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.locator(".sidebar-sort-menu").getByText(/PDF/i).first().click();
  await (await chooser).setFiles({ name: `audit-${Date.now()}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(pdf) });
  const pages = page.locator(".pdf-page, .pdf-node-view canvas, [data-page-key]");
  await expect(pages.first()).toBeVisible({ timeout: 30_000 });
  console.log(`AUDIT PDF-01 rendered page elements=${await pages.count()}`);
  const textLayer = await page.locator(".textLayer, .pdf-text-layer").allInnerTexts().catch(() => []);
  console.log(`AUDIT PDF-01 text layer=${JSON.stringify(textLayer.join(" ").slice(0, 120))}`);
  const id = new URL(page.url()).searchParams.get("node");
  await page.reload({ waitUntil: "load" });
  await expect(pages.first()).toBeVisible({ timeout: 30_000 });
  console.log(`AUDIT PDF-01 after reload node=${id} page elements=${await pages.count()}`);
  await page.screenshot({ path: "/tmp/pw-output/audit-pdf.png" });
});

test("PDF-02: text selection → card and Alt+drag area capture keep page + source", async ({ page }) => {
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    null,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const c = "BT /F1 28 Tf 72 720 Td (Mitochondria make energy) Tj ET";
  objs[3] = `<</Length ${c.length}>>stream\n${c}\nendstream`;
  let pdf = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj${o}endobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;

  await ready(page, "/?view=notes");
  const before = new Set(((await (await page.request.get("/api/bootstrap")).json()).nodes as Array<{ id: string }>).map((n) => n.id));
  await page.getByRole("button", { name: "Create new node" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".sidebar-sort-menu").getByText(/PDF/i).first().click();
  await (await chooser).setFiles({ name: `cite-${Date.now()}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(pdf) });
  const span = page.locator(".pdf-text-layer span", { hasText: "Mitochondria" }).first();
  await expect(span).toBeVisible({ timeout: 30_000 });
  const pdfId = new URL(page.url()).searchParams.get("node");
  const b = (await span.boundingBox())!;
  await page.mouse.move(b.x + 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  const tip = page.locator(".pdf-node-selection-tip");
  const tipShown = await tip.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  console.log(`AUDIT PDF-02 selection text=${JSON.stringify(await page.evaluate(() => String(window.getSelection())))} tips in DOM=${await tip.count()}`);
  console.log(`AUDIT PDF-02 selection tip shown=${tipShown}`);
  if (tipShown) await tip.click();
  await page.waitForTimeout(1500);
  const nodes = ((await (await page.request.get("/api/bootstrap")).json()).nodes as Array<{ id: string; title: string; parent_id?: string }>)
    .filter((n) => !before.has(n.id) && n.id !== pdfId);
  console.log(`AUDIT PDF-02 new nodes after card: ${JSON.stringify(nodes.map((n) => [n.title, n.parent_id === pdfId]))}`);
  for (const n of nodes) {
    const full = await (await page.request.get(`/api/nodes/${n.id}`, H)).json();
    const attrs = await (await page.request.get(`/api/nodes/${n.id}/attributes`, H)).json();
    console.log(`AUDIT PDF-02 card body=${JSON.stringify(String(full.markdown).slice(0, 160))} attrs=${JSON.stringify(attrs.map((a: { key: string; value: string }) => [a.key, String(a.value).slice(0, 60)]))}`);
  }
  // Highlight records ride the ink_data envelope's `annotations` (W20).
  const annotationsOf = async () => {
    const ink = ((await (await page.request.get(`/api/nodes/${pdfId}/attributes`, H)).json()) as Array<{ key: string; value: string }>).find((a) => a.key === "ink_data");
    try { return (JSON.parse(String(ink?.value ?? "{}")) as { annotations?: Array<{ type: string; content?: { text?: string; image?: string } }> }).annotations ?? []; }
    catch { return []; }
  };
  console.log(`AUDIT PDF-02 pdf annotations: ${JSON.stringify(await annotationsOf()).slice(0, 200)}`);

  // Area capture: Alt+drag on the page.
  const pageBox = (await page.locator(".pdf-node-content [data-page-key], .pdf-node-content canvas").first().boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(pageBox.x + 40, pageBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + 240, pageBox.y + 160, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(1500);
  const list = await annotationsOf();
  console.log(`AUDIT PDF-02 annotations by type: ${JSON.stringify(list.map((a) => [a.type, a.content?.text?.slice(0, 40) ?? (a.content?.image ? "image" : "")]))}`);
});
