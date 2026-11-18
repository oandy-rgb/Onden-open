// The sidebar ＋ opens the create sheet (2026-10-24, 「＋ 開建立面板」): pick what to make, then 「建立」.
// A kind that takes a file (a PDF, an image, audio) is 「上傳檔案」, which opens the file chooser on 「建立」.
import { expect, type Page } from "@playwright/test";

const CREATE = /^(Create|建立)$/;
const UPLOAD_KIND = /^(Upload a file|上傳檔案)$/;

/** Make a note from a file through the sidebar ＋, the way a person does; returns once the file is handed over. */
export async function createNoteFromFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator(".obsidian-sidebar").getByRole("button", { name: CREATE }).filter({ visible: true }).first().click();
  const sheet = page.locator(".create-sheet-popover, .create-sheet-layer").filter({ visible: true });
  await sheet.getByRole("radio", { name: UPLOAD_KIND }).click();
  await expect(sheet.getByRole("radio", { name: UPLOAD_KIND })).toHaveAttribute("aria-checked", "true");
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await sheet.getByRole("button", { name: CREATE }).click();
  await (await chooser).setFiles(file);
}
