// Scenario 11 — a save is on its way when the page is reloaded, and the server refuses it
// (fix/save-in-flight-across-reload; saveTiming "type, reload, type, request #0 refused (422): #S4" and "seed 7").
//
// The person types, the page reloads before the save's answer arrives, and the server refuses that save with a 422 —
// the old page's request and the new page's resend alike (one Idempotency-Key, one decision). After the reload the
// person types again (11a) or renames the note (11c). What must hold:
//   - every word typed is on the server or in the recovery panel (nothing is only "in the editor");
//   - no save after the reload carries the refused text as its merge base: the server did not keep that text, so a
//     base made of it makes the server merge "with another writer" although nobody else wrote;
//   - the editor ends equal to the server, and the last typing is on the server.
// 11b is the same reload with the save accepted: the text is on the server once.
// No waits on time: every step waits on a request, a response or the server's copy.
import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import {
  FAULTS_TAG, PHONE, editor, openNote, seedNote, serverMarkdown, skipUnlessRequested, typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

type Sent = { key: string | null; markdown?: string; base?: string; title?: string };

const bodyOf = (request: Request): Sent => {
  const body = JSON.parse(request.postData() ?? "{}") as { markdown?: string; base_markdown?: string; title?: string };
  return { key: request.headers()["idempotency-key"] ?? null, markdown: body.markdown, base: body.base_markdown, title: body.title };
};

/** Every PATCH of the note, and (when `refuse` is set) the server's 422 for the first save that carries `refuse`,
 *  and for every later request under that save's key. Everything else reaches the real backend. */
async function routeSaves(page: Page, id: string, refuse: string | null): Promise<{ sent: Sent[]; refusedKey: () => string | null }> {
  const sent: Sent[] = [];
  let refusedKey: string | null = null;
  await page.context().route(`**/api/nodes/${id}`, async (route: Route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.continue();
    const save = bodyOf(request);
    sent.push(save);
    if (refuse !== null && refusedKey === null && save.markdown?.includes(refuse)) refusedKey = save.key;
    if (refusedKey !== null && save.key === refusedKey) {
      // The page that sent it may be gone already: its answer reaches nobody, as on a real reload.
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "invalid_request" }) }).catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
  return { sent, refusedKey: () => refusedKey };
}

async function recoveryText(page: Page): Promise<string> {
  return page.locator(".failed-write-recovery").innerText().catch(() => "");
}

/** Type, reload before the save is answered (the exit save of the reload carries the text), and come back. */
async function typeThenReload(page: Page, id: string, text: string): Promise<void> {
  await typeInNote(page, "end", ` ${text}`);
  // No wait for the autosave: the reload's own exit save (pagehide, keepalive) is the one on its way, or, should the
  // page die before it is sent, the recovery copy the next page sends under the same key.
  await page.reload();
  await openNote(page, id);
}

async function expectKept(page: Page, id: string, words: string[]): Promise<void> {
  await expect.poll(async () => {
    const server = await serverMarkdown(page, id);
    const recovery = await recoveryText(page);
    return words.filter((word) => !server.includes(word) && !recovery.includes(word));
  }, { timeout: 45_000, message: `every typed word (${words.join(", ")}) must be on the server or in recovery` }).toEqual([]);
}

async function expectEditorIsServer(page: Page, id: string): Promise<void> {
  await expect.poll(async () => {
    const server = await serverMarkdown(page, id);
    const shown = await editor(page).innerText();
    // The editor renders lines; compare the words, not the whitespace.
    return shown.replace(/\s+/g, " ").trim() === server.replace(/\s+/g, " ").trim();
  }, { timeout: 45_000, message: "the editor must end equal to the server" }).toBe(true);
}

for (const variant of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, prefix: "11" },
  { name: "phone", use: PHONE, prefix: "11p" },
]) {
  test.describe(`a save refused across a reload (${variant.name})`, () => {
    test.use(variant.use);

    test(`${variant.prefix}a: refused across a reload, then typing again: nothing lost, nothing merged`, { tag: FAULTS_TAG }, async ({ page }) => {
      test.setTimeout(150_000);
      const first = uniqueToken("before");
      const second = uniqueToken("after");
      const id = await seedNote(page);
      await openNote(page, id);
      const { sent, refusedKey } = await routeSaves(page, id, first);

      await typeThenReload(page, id, first);
      await expect.poll(refusedKey, { timeout: 45_000, message: "the save of the text typed before the reload must be sent (and refused)" }).not.toBeNull();

      const later = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${id}`) && r.ok()
        && (bodyOf(r.request()).markdown ?? "").includes(second), { timeout: 45_000 });
      await typeInNote(page, "end", ` ${second}`);
      await later;

      await expectKept(page, id, [first, second]);
      expect(await serverMarkdown(page, id), "the typing after the reload is on the server").toContain(second);
      const refused = sent.find((s) => s.key === refusedKey())!.markdown!;
      const builtOnRefused = sent.filter((s) => s.key !== refusedKey() && s.base === refused);
      expect(builtOnRefused, "no save after the reload uses the refused text as its merge base").toEqual([]);
      await expectEditorIsServer(page, id);
    });

    test(`${variant.prefix}c: refused across a reload, then a rename: the typed text is not counted as saved`, { tag: FAULTS_TAG }, async ({ page }) => {
      test.setTimeout(150_000);
      const first = uniqueToken("before");
      const id = await seedNote(page);
      await openNote(page, id);
      const { sent, refusedKey } = await routeSaves(page, id, first);

      await typeThenReload(page, id, first);
      await expect.poll(refusedKey, { timeout: 45_000 }).not.toBeNull();

      const title = uniqueToken("Renamed ");
      const renamed = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${id}`) && r.ok()
        && bodyOf(r.request()).title === title, { timeout: 45_000 });
      const titleInput = page.locator(".obsidian-title-input").first();
      await titleInput.fill(title);
      await renamed;

      await expectKept(page, id, [first]);
      const refused = sent.find((s) => s.key === refusedKey())!.markdown!;
      expect(sent.filter((s) => s.key !== refusedKey() && s.base === refused), "the rename does not use the refused text as its base").toEqual([]);
      await expectEditorIsServer(page, id);
    });

    if (variant.name === "desktop") {
      test("11b: accepted across a reload: the text is on the server once", { tag: FAULTS_TAG }, async ({ page }) => {
        test.setTimeout(120_000);
        const first = uniqueToken("before");
        const second = uniqueToken("after");
        const id = await seedNote(page);
        await openNote(page, id);
        await typeThenReload(page, id, first);
        await expect.poll(() => serverMarkdown(page, id), { timeout: 45_000 }).toContain(first);
        const later = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/nodes/${id}`) && r.ok()
          && (bodyOf(r.request()).markdown ?? "").includes(second), { timeout: 45_000 });
        await typeInNote(page, "end", ` ${second}`);
        await later;
        const server = await serverMarkdown(page, id);
        expect(server.split(first).length - 1, "the text typed before the reload is on the server once").toBe(1);
        expect(server).toContain(second);
        await expectEditorIsServer(page, id);
      });
    }
  });
}
