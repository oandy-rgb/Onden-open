// The kit a "walk" is made of (e2e/browser-app/dayWalk.mjs): one browser session that a list of named steps goes through
// in order, the way a person would use the app. A step is `async (walk) => {…}`; it checks what a person would see
// and may leave state on `walk` for the next step. A new walk (another day, another kind of user) is a new list of
// steps in a new file; it does not copy a step.
//
//   check(ok, what, detail)                       — a plain assertion
//   expectFail(ok, what, reason)                  — an assertion known to be red today: prints XFAIL while it is red (the walk still
//                                                    passes), and FAILS when it turns green so the line is deleted (like vitest's it.fails)
//   observe(what, value)                          — something written down, never asserted (a product decision is open)
//   waits are on the app's own signals (an element, a rect that stopped moving, the store's saved flag); there is no sleep.
import { contextOptions, startSite, launch, READY_TEXT } from "../../layout-audit/env.mjs";

export { READY_TEXT };

/** Everything the page reports about itself during the whole walk; asserted empty at the end except `allowed`. */
export function collectProblems(page, allowed) {
  const problems = [];
  const note = (kind, text) => { const hit = allowed.find((a) => a.kinds.includes(kind) && a.match.test(text)); problems.push({ kind, text: text.slice(0, 220), allowed: hit?.reason ?? null }); };
  page.on("pageerror", (e) => note("pageerror", String(e)));
  page.on("console", (m) => { if (m.type() === "error") note("console", `${m.text()} ${m.location().url ?? ""}`); });
  page.on("requestfailed", (r) => note("requestfailed", `${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => { if (r.status() >= 400) note("http", `${r.status()} ${r.url()}`); });
  return problems;
}

export function makeReport(log = console.log) {
  const failures = [];
  const expected = [];
  const unexpectedPass = [];
  let current = "";
  const detail = (d) => (d ? ` — ${d}` : "");
  return {
    failures, expected,
    step(name) { current = name; log(`\n== ${name}`); },
    check(ok, what, d = "") { log(`${ok ? "ok   " : "FAIL "} ${what}${detail(d)}`); if (!ok) failures.push(`${current}: ${what}`); },
    expectFail(ok, what, reason) {
      if (ok) { log(`FAIL  ${what} — now passes; delete its expectFail (${reason})`); failures.push(`${current}: ${what} (expected failure is gone)`); unexpectedPass.push(what); }
      else { log(`XFAIL ${what} — ${reason}`); expected.push(`${current}: ${what}`); }
    },
    observe(what, value) { log(`SEE   ${what}: ${typeof value === "string" ? value : JSON.stringify(value)}`); },
    log,
  };
}

/** Open a fresh browser profile (empty storage) for `profile` and return the pieces a step needs. */
export async function startWalk({ profile, dir = "dist-browser", prefix = "/", allowedProblems = [], log }) {
  const browser = await launch();
  const site = await startSite(dir, { prefix });
  const context = await browser.newContext(contextOptions(profile));
  const page = await context.newPage();
  const problems = collectProblems(page, allowedProblems);
  const report = makeReport(log);
  const cdp = await context.newCDPSession(page);
  return {
    browser, site, context, page, profile, problems, report, cdp, notes: {}, marks: {},
    touch: !!profile.touch,
    /** A person's press: a finger on a touch profile, a click otherwise. */
    press: (locator) => (profile.touch ? locator.tap() : locator.click()),
    async close() { await context.close(); await browser.close(); site.close(); },
  };
}

/** Resolves when `locator`'s box has not moved for `frames` animation frames (a popover that is still being placed has not settled). */
export async function settledRect(locator, frames = 4) {
  await locator.waitFor({ state: "visible" });
  return locator.evaluate((el, frames) => new Promise((resolve) => {
    const read = () => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    let last = read(), still = 0;
    const tick = () => {
      const now = read();
      still = now.every((v, i) => v === last[i]) ? still + 1 : 0;
      last = now;
      if (still >= frames) resolve({ x: now[0], y: now[1], width: now[2], height: now[3], right: now[0] + now[2], bottom: now[1] + now[3] });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

/** Read the app's own state again, once per animation frame, until `done(value)` or `timeout`; returns the last value either way.
 *  (Not page.waitForFunction with an async predicate: Playwright does not wait for its promise here.) */
export async function pollUntil(page, read, done, { timeout = 15_000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > end) return value;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
}

/** The browser app's own "saved to this browser's storage" flag (the worker says when the latest writes are on disk). Returns the state. */
export const waitStored = (page, timeout = 30_000) => pollUntil(page, () => page.evaluate(async () => (await fetch("/api/browser-app/state")).json()), (s) => !s.unsaved && s.lastSavedAt !== null, { timeout });

/** One note as the app's own backend holds it (what a save really stored), or null. */
export const readNote = (page, id) => page.evaluate(async (id) => { const r = await fetch(`/api/nodes/${id}`); return r.ok ? r.json() : null; }, id);

export const noteIdOf = (page) => new URL(page.url()).searchParams.get("node");

