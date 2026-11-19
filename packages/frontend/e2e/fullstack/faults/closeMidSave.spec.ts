// Scenario 5 — the page goes away in the middle of a save. The save request is
// held in flight (never answered), then the page is closed with its unload
// handlers (`runBeforeUnload`) or the whole context is killed without them.
// The same persistent profile is opened again: the last typed text must reach
// the server, or be shown in the recovery panel. "Still in the editor" does not
// count: a local copy showing text that nothing will send is the failure itself
// (it looks saved, and the server's version replaces it later).
//
// The graceful close is covered by the pagehide path (unconfirmed-write
// recovery). The hard close gives the page no event at all: the save was
// recorded in the queue before it was sent (writeQueue.recordWrite), so the
// reopened page sends it. Every kill point of a save is covered at unit level
// (src/test/saveSurvivesKill.test.ts).
import { chromium, test, expect, type BrowserContext, type Route } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE, FAULTS_TAG, PHONE, editor, openNote, seedNote, serverMarkdown, signInPersistent,
  skipUnlessRequested, typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

type Profile = { phone: boolean };

async function launch(dir: string, { phone }: Profile): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
    baseURL: BASE,
    ...(phone ? PHONE : { viewport: { width: 1280, height: 800 } }),
  });
  await signInPersistent(context);
  return context;
}

/** Type into a note whose save never gets an answer, then end the session. */
async function typeThenDie(profile: Profile, dir: string, end: "page" | "context"): Promise<{ id: string; text: string }> {
  const text = uniqueToken("midsave");
  const context = await launch(dir, profile);
  try {
    const page = await context.newPage();
    const id = await seedNote(page);
    await openNote(page, id);
    const held: Route[] = [];
    await page.route(`**/api/nodes/${id}`, (route) => {
      if (route.request().method() === "PATCH") held.push(route);
      else void route.continue();
    });
    const inFlight = page.waitForRequest((req) => req.method() === "PATCH" && req.url().includes(id));
    await typeInNote(page, "end", ` ${text}`);
    await inFlight; // the save is on the wire and unanswered
    if (end === "page") await page.close({ runBeforeUnload: true });
    return { id, text };
  } finally {
    await context.close(); // for "context" this is the hard kill; for "page" it ends the session
  }
}

async function reopenAndFind(profile: Profile, dir: string, id: string, text: string): Promise<void> {
  const context = await launch(dir, profile);
  try {
    const page = await context.newPage();
    await openNote(page, id);
    // Kept means on the server, or where it will be sent or offered back (the queue drains to the server on reopen;
    // recovery). The editor alone does not count: the text can be in this device's copy with no queue row, which
    // looks saved and is never sent (localDbJournal.test.ts "a save the page died during").
    await expect
      .poll(async () => {
        if ((await serverMarkdown(page, id)).includes(text)) return "server";
        const recovery = await page.locator(".failed-write-recovery").innerText().catch(() => "");
        if (recovery.includes(text)) return "recovery";
        return (await editor(page).innerText()).includes(text) ? "only in this device's copy" : "missing";
      }, { timeout: 45_000, message: `the last typed text (${text}) must reach the server or be shown in recovery` })
      .toMatch(/^(server|recovery)$/);
  } finally {
    await context.close();
  }
}

for (const variant of [
  { name: "desktop", profile: { phone: false }, prefix: "5a" },
  { name: "phone", profile: { phone: true }, prefix: "9c" },
]) {
  test.describe(`close mid-save (${variant.name})`, () => {
    let dir: string;
    test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "onden-fault-profile-")); });
    test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test(`${variant.prefix}: page.close({ runBeforeUnload }) mid-save keeps the last text`, { tag: FAULTS_TAG }, async () => {
      test.setTimeout(120_000);
      const { id, text } = await typeThenDie(variant.profile, dir, "page");
      await reopenAndFind(variant.profile, dir, id, text);
    });

    // The phone variant only repeats the graceful close (scenario 9 asks for 1, 3 and 5).
    if (variant.name === "desktop") {
      test("5b: a hard context close mid-save keeps the last text", { tag: FAULTS_TAG }, async () => {
        test.setTimeout(120_000);
        const { id, text } = await typeThenDie(variant.profile, dir, "context");
        await reopenAndFind(variant.profile, dir, id, text);
      });
    }
  });
}
