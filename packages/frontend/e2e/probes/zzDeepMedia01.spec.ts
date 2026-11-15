// Feature-audit deepening (2026-10-08): MEDIA-01 — image into a note via the
// toolbar file picker, paste and drop; cancel; oversize (51 MB); a corrupt
// "PNG"; an unsupported type; offline; reload keeps the image; phone entry.
import { test, type Page } from "@playwright/test";
import { ready, switchNoteView, BASE, H, PNG_1X1_B64 } from "../fullstack/helpers";

const PNG_B64 = PNG_1X1_B64; // a real image: the server decodes uploads

test("MEDIA-01: image entries, failures, offline, phone", async ({ page, context, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const id = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Img ${stamp}`, markdown: "start" } })).json()).id as string;
  const editorMd = () => page.locator(".cm-content").first().innerText();
  const imgCount = async () => ((await editorMd()).match(/!\[[^\]]*\]\([^)]*api\/media/g) ?? []).length;
  const errText = async () => (await page.locator(".upload-error, [class*=upload-error], [role=alert], .toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(-140);
  // With a mouse the "Insert image" button is hidden (paste / drag instead);
  // the hidden file input behind it is the same upload path.
  const picker = async (files: Parameters<Page["setInputFiles"]>[1]) => {
    await page.locator(".tiptap-insert-image-input").first().setInputFiles(files as never); return "ok";
  };
  const png = Buffer.from(PNG_B64, "base64");
  try {
  await ready(page, `/?view=notes&node=${id}&lens=editor`);
  await page.locator(".cm-content").first().click(); await page.keyboard.press("Control+End");
  let n0 = await imgCount();
  out.picker = { chooser: await picker({ name: "pick.png", mimeType: "image/png", buffer: png }) };
  await page.waitForTimeout(2500);
  (out.picker as Record<string, unknown>).inserted = (await imgCount()) - n0;
  // Cancel: chooser with no files.
  n0 = await imgCount();
  out.cancel = { chooser: await picker([]) };
  await page.waitForTimeout(1200);
  (out.cancel as Record<string, unknown>).inserted = (await imgCount()) - n0;
  // Paste.
  n0 = await imgCount();
  await page.locator(".cm-content").first().evaluate((el, b64) => { const bin = atob(b64); const f = new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], "paste.png", { type: "image/png" }); const dt = new DataTransfer(); dt.items.add(f); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, PNG_B64);
  await page.waitForTimeout(2500);
  out.paste = (await imgCount()) - n0;
  // Drop.
  n0 = await imgCount();
  const dt = await page.evaluateHandle((b64) => { const bin = atob(b64); const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], "drop.png", { type: "image/png" })); return dt; }, PNG_B64);
  await page.locator(".cm-content").first().dispatchEvent("drop", { dataTransfer: dt });
  await page.waitForTimeout(2500);
  out.drop = (await imgCount()) - n0;
  // Oversize.
  n0 = await imgCount();
  await picker("/tmp/claude-1000/-var-home-oandy----git-note/81663b59-39f8-43d7-9d02-e1afac0ad3bb/scratchpad/huge.png" as never);
  await page.waitForTimeout(800); const errBig = await errText(); await page.waitForTimeout(5000);
  out.oversize = { inserted: (await imgCount()) - n0, errorShown: errBig, errorAfter5s: await errText() };
  // Corrupt PNG and unsupported type.
  n0 = await imgCount();
  await picker({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("this is not a png") });
  await page.waitForTimeout(1500);
  out.corrupt = { inserted: (await imgCount()) - n0, error: await errText(), api: (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: "c.png", mimeType: "image/png", buffer: Buffer.from("nope") } } })).status() };
  out.unsupportedApi = (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: "x.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") } } })).status();
  // Offline.
  await page.waitForTimeout(4500);
  await context.setOffline(true); await page.waitForTimeout(600);
  n0 = await imgCount();
  await picker({ name: "off.png", mimeType: "image/png", buffer: png });
  await page.waitForTimeout(1200);
  out.offline = { inserted: (await imgCount()) - n0, error: await errText() };
  await context.setOffline(false);
  // Reload keeps the images and they load.
  await page.waitForTimeout(3000);
  await page.reload(); await page.waitForTimeout(3000);
  await switchNoteView(page, "preview").catch(() => {});
  await page.waitForTimeout(2000);
  out.afterReload = await page.locator(".obsidian-preview img").evaluateAll((imgs) => imgs.map((i) => ({ ok: (i as HTMLImageElement).naturalWidth > 0 })));
  // Phone.
  const ph = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  await ready(pp, `/?view=notes&node=${id}&lens=editor`);
  const ib = pp.getByRole("button", { name: "Insert image" }).filter({ visible: true }).first();
  const bb = await ib.boundingBox().catch(() => null);
  out.phoneButton = bb ? `${Math.round(bb.width)}x${Math.round(bb.height)}` : "none";
  await ph.close();
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("MEDIA01 " + JSON.stringify(out, null, 2));
  }
});
