# Fault-injection e2e (`@faults`)

Real-browser specs for bugs the Node-level simulators cannot see: two tabs
sharing one IndexedDB, a stalled request, a killed local-DB worker, a page
closed mid-save, quota pressure, and a deploy while the app is open.

The group is **on by default**. It is its own Playwright project, `faults`
(`playwright.config.ts`: Chromium only, serial, 240 s default timeout; the
scenarios set their own, up to 180 s), and the ordinary `chromium` project
ignores this directory. Any `*.spec.ts` added here is picked up by directory;
tagging it `@faults` additionally makes `--grep @faults` select it.

| Command | Faults run? |
| --- | --- |
| `run.sh` (no args) | yes |
| `run.sh --grep @faults` | only these |
| `run.sh fullstack/faults/<spec>` | that spec |
| `run.sh --grep @critical` (CI PR subset) | no, unless a fault test is also tagged `@critical` |
| `E2E_SKIP_FAULTS=1 run.sh` | no (the project is not registered) |

The suite gets several minutes longer with the group; set `E2E_SKIP_FAULTS=1`
for a quick pass. Without Docker, `npx playwright test --list` (in
`packages/frontend/e2e`) shows which tests each project collects.

| Spec | Scenario | Expected on current `main` |
| --- | --- | --- |
| `twoTabQueue.spec.ts` | 1 stale tab's snapshot vs. other tab's queue; 2 same after A compacted; 9a phone variant of 1 | pass — fixed by #616; B's snapshot comes from a server change over live sync, and B may not send the note's writes (removing the generation check turns them red: PR #1877) |
| `stalledSave.spec.ts` | 3 request that never answers; 9b phone variant | pass — fixed by #616 (25 s attempt deadline); the held route stays installed |
| `stuckWrite.spec.ts` | 4 one write answered 500 forever | fails (`test.fail`) — known open: the stuck notice comes after 8 tries (~4.4 min) |
| `closeMidSave.spec.ts` | 5a graceful close mid-save; 5b hard context close; 9c phone variant of 5a | 5a, 9c pass; 5b fails (`test.fail`) — known open: a save on the wire is not queued; "only in the editor" does not count as kept |
| `storageQuota.spec.ts` | 6 snapshot saves fail on quota | expected to pass — `fix/storage-quota-notice` (not yet run on a real browser) |
| `workerDeath.spec.ts` | 7 local-DB worker dies | fails (`test.fail`) at 30 s — known open: noticed only by the 60 s call timeout (#617) |
| `staleDeploy.spec.ts` | 8a stale chunk → one reload keeps draft; 8b guard spent → error screen + Reload | pass (behavior already exists) |

A test marked `test.fail()` is reported as *passed* while the bug exists and as
**failed ("expected to fail, but passed")** once the fix lands. That is the
signal to delete the `test.fail(...)` line. The open ones are listed in
[e2e-first-full-run-2026-11-17.md](../../../../../docs/research/e2e-first-full-run-2026-11-17.md)
(「預期失敗（已知但沒人在修）」). Those expectations were first written from
reading the source, not from running the stack: if one flips unexpectedly, check
whether the assertion or the app is wrong before blaming either.

## Run on the local stack

```sh
# whole group (builds the isolated stack on :5099, runs Chromium, tears down)
packages/frontend/e2e/fullstack/run.sh --grep @faults

# one spec
packages/frontend/e2e/fullstack/run.sh fullstack/faults/twoTabQueue.spec.ts
```

Against a stack that is already up (`E2E_BASE`, `E2E_STORAGE` as in the main
README) run `npx playwright test --project faults` from `packages/frontend/e2e`.
`E2E_FAULTS=1` is no longer needed (nothing reads it). Scenario 2 waits for the journal's 15 s idle
compaction, so a few tests take
1–3 minutes by design; they wait on state (IndexedDB contents, server copy), not
on sleeps.

How the faults are injected (no application code is touched):

- one tab offline: CDP `Network.emulateNetworkConditions` on that page only
  (`context.setOffline` would cut the second tab too);
- never-answered request: `page.route` that stores the route and never fulfils;
- worker death: `Worker.evaluate(() => self.close())` on the dedicated worker.
  Playwright has no terminate call and cannot crash the process (an OOM kill is
  not reproducible); `self.close()` is the closest faithful approximation;
- quota: CDP `Storage.overrideQuotaForOrigin` on a browser-level session;
- closed mid-save: a persistent profile (`launchPersistentContext`, signed in by
  replaying the suite's storage state), closed with `page.close({ runBeforeUnload:
  true })` or `context.close()`, then reopened on the same directory;
- deploy: a route answering not-yet-loaded `/_astro/*.js` with a 404 HTML page
  until the next document navigation. A different build id is not served — that
  needs a second build.

## Scenarios 1, 3 and 5 on an Android phone (Brave over adb)

Not run by the author; Playwright only supports part of this, as noted.

1. Phone: enable Developer options → USB debugging; plug in and accept the key.
   Open Brave and the Onden site, signed in. Keep the screen on.
2. Host: `adb devices` must list the phone. Find Brave's DevTools socket and
   forward it:
   ```sh
   adb shell cat /proc/net/unix | grep -i devtools_remote
   adb forward tcp:9222 localabstract:chrome_devtools_remote   # use the socket name printed above
   curl -s http://localhost:9222/json/version                  # should answer
   ```
   (`chrome://inspect` in desktop Chrome lists the same pages.)
3. Attach from Playwright (from `packages/frontend/e2e`):
   ```ts
   import { chromium } from "@playwright/test";
   const browser = await chromium.connectOverCDP("http://localhost:9222");
   const context = browser.contexts()[0];          // the phone's real profile
   const page = context.pages()[0] ?? (await context.newPage());
   ```
   What works over this connection: `page.goto`, typing/tapping, `page.route`
   (scenario 3), `context.newPage()` for a second tab in the same profile
   (scenario 1), per-page CDP offline emulation, IndexedDB reads through
   `page.evaluate`. What does not: `browser.newContext()` / persistent profiles
   (the phone has one profile, so there is no fresh storage state — sign in by
   hand first), `page.close({ runBeforeUnload })` is the only close you can
   script for scenario 5, and a hard kill must be done by hand
   (`adb shell am force-stop com.brave.browser`). Playwright's own `_android`
   API drives Chrome only, not Brave.
4. Reuse the helpers in `faultKit.ts` (`seedNote`, `openNote`, `typeInNote`,
   `setPageOffline`, `journalEntryCount`, `serverMarkdown`). Seed the note with
   the API from the host (`E2E_BASE` must be reachable from the phone — use the
   host's LAN address or `adb reverse tcp:5099 tcp:5099` and keep `localhost`).
   Then follow `twoTabQueue.spec.ts` (1), `stalledSave.spec.ts` (3) and the
   `5a` flow in `closeMidSave.spec.ts` by hand-assembling them in a small script
   against the attached `context`; for the 5b-style kill use `force-stop` between
   typing and reopening.

## Random sync (`randomSync.spec.ts`)

Random operations on the real app: device A (one context, two tabs on one
IndexedDB) and device B (a second context). Invariants, replay and the known
open issues it annotates instead of failing are described at the top of the
spec. Needs the full stack (about 8–10 minutes for the default 12 rounds × 25
operations; `E2E_RANDOM_RUNS=3` for a quick pass):

```sh
packages/frontend/e2e/fullstack/run.sh fullstack/faults/randomSync.spec.ts --grep @faults
E2E_RANDOM_SEED=<seed> ...            # replay a failed run
E2E_RANDOM_REPLAY='[{"kind":"type","slot":"A1","r":1}]' ...   # one round, exact list
```
