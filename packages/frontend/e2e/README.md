# Real-browser e2e

Verifies the parts of the app that jsdom unit tests can't reach, by driving
**real browser engines**. To avoid depending on the host's browser system libs, the
browser runs **inside the official playwright docker image**; only the
platform-independent playwright *lib* is installed locally (pinned in
`package.json`). The standalone component harness (`run.sh`, `harness/`) was removed
on 2026-11-14: it clicked a lens-strip control that no longer exists.

## Full stack — `fullstack/run.sh`

```sh
packages/frontend/e2e/fullstack/run.sh
```

Spins up an **isolated, ephemeral** stack (`compose.e2e.yaml`, project
`onden-e2e`) — its own Postgres whose `POSTGRES_DB` is **onden_test**, plus
backend + frontend rebuilt from the current source, nginx on **:5099**. It
**never touches the real onden**. Then runs a `@playwright/test` suite
(`fullstack/*.spec.ts`) in real Chromium (`--network host`), and tears the stack
down on exit. First run builds images (~minutes); cached after.

Auth/onboarding is handled once in `global-setup.ts`: `emailAndPassword` signup
is open, so it self-provisions a throwaway user and dismisses the first-run
storage picker (browser OPFS — the folder option opens a native dialog), then
saves storageState so every spec starts authenticated and inside the workspace.

The Chromium project runs the full suite except the fault-injection group;
that group has its own `faults` project (Chromium, serial, 240 s timeout; see
[faults/README.md](fullstack/faults/README.md)) and **is part of a plain
`run.sh`**. Firefox, WebKit, mobile Chrome and mobile Safari projects also run
`crossbrowser.spec.ts`. Mobile projects are
viewport/device emulation, not physical-device acceptance. Enumerate the current
suite after installing this directory's lockfile dependencies:

```sh
npm ci --no-audit --no-fund
npx playwright test --list
```

At source `43da480` on 2026-09-21, collection found **298 tests in 132 files**.
Collection is not execution. Run results and remaining limits are kept in the
[acceptance record](../../../docs/archive/browser-acceptance-2026-09-21.md).

**Specs import nothing from `packages/*`.** The runner container mounts only `e2e/` at `/work`, and
Playwright loads every spec to list tests, so one unresolvable import fails the whole run (it did from
2026-11-09 to 2026-11-14). The few workspace values specs need (client protocol, default site design) come from
`fullstack/hostContract.ts`, which reads `fullstack/generated/hostContract.json`; `run.sh` and `e2e:cloud-stack`
write it on the host from source (`packages/frontend/e2e/scripts/writeHostContract.ts`). Check the layout without Docker or a stack:

```sh
cd packages/frontend && npm run check:specs   # copies e2e/ to a temp dir, runs `playwright test --list` over every project
```

CI runs it in the `e2e-critical` job before the stack is built.

Examples of the covered flows:
- `smoke.spec.ts` — authed app renders the lens strip; node create through the
  wired stack has an `events->hash->blobs` version; S2 `?node=` deep link.
- `interactions.spec.ts` — user behaviour: lens switching drives the URL +
  active state; command palette; Today opens a daily note; sidebar click opens a
  node (selection → URL + editor); editing the body in the editor persists.
- `perf.spec.ts` — latencies under generous budgets: cold load, bootstrap +
  node-create, lens-switch, and bootstrap responsiveness after +50 nodes
  (created with bounded concurrency — a 50-way *simultaneous* write burst
  saturates the pg pool and wedges the backend, a separate robustness finding).
- `usecases.spec.ts` — real note-taking jobs-to-be-done (from the note-use-cases
  research): meeting note (wikilink to a project + action items), wikilink
  bidirectionality + edit re-sync, version-history restore, daily-note catch-all
  via Today. Exercises the sticky capture→task→daily-note→link loop.

### Without docker — `fullstack/cloud-stack.mjs`

`npm run e2e:cloud-stack -- --run <command>` (from `packages/frontend`) starts the same stack
without docker: the backend on PGlite, the Astro node server, and a same-origin forwarder on
`:5099` in place of nginx; runs `<command>` with `E2E_BASE` set, then removes every process and
the temp data. Specs that need a real Postgres or `docker exec` cannot pass there — see
[testing.md](../../../docs/agents/testing.md) (驗收分層) for what runs where and the A/B/C failure classes.

### What a given command runs

| Command | Runs |
| --- | --- |
| `run.sh` (no args) | every project, **including `faults`** (adds several minutes) |
| `E2E_SKIP_FAULTS=1 run.sh` | the same without `faults` (the project is not registered) |
| `run.sh --grep @critical` | the `@critical` tests only (CI PR subset); faults are not selected unless a fault test also carries `@critical` |
| `run.sh --grep @faults` | only the fault group |
| `run.sh fullstack/foo.spec.ts` | that spec; a path under `fullstack/faults/` selects it in the `faults` project |
| `run.sh --project chromium` | the main suite without faults |

With `E2E_SKIP_FAULTS=1`, `--grep @faults` or a faults path finds no tests.
Check what a selection covers without Docker: `npx playwright test --list [args]`
from this directory.

CI (`workflow_dispatch` with `fullstack`) splits the full suite into parallel jobs, each with its own stack: the
`chromium` project in 4 shards (`--shard=N/4`, split by spec file), the `faults` project, and the cross-engine projects.
Together they select what a plain `run.sh` selects; a spec must not rely on another spec's data.

### Environment variables of `fullstack/run.sh`

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_SKIP_FAULTS` | unset | `1` leaves the fault-injection project out |
| `E2E_PROJECT` | `onden-e2e` | compose project name (containers, network and volume are named after it) |
| `E2E_PORT` | `5099` | host port of the stack's nginx; also the CORS / auth origin |
| `E2E_HOST_OUT` | `/tmp/pw-host-out` (`…-<project>` for a non-default project) | where failure screenshots land on the host |
| `E2E_STALE_HOURS` | `6` | age after which a still-running runner left by an interrupted run is removed |
| `E2E_REQUIRE_ADMIN`, `TOUR`, `USERTOUR`, `PROBE`, `PROBE_SCALE`, `SCALE_TIERS` | unset | passed to the runner as before |

### Two runs on one host

Several sessions can share a machine. Two stacks must not share a compose
project (the second run's `down -v` would delete the first one's database) or a
port:

```sh
# session A (defaults)
packages/frontend/e2e/fullstack/run.sh
# session B
E2E_PROJECT=onden-e2e-b E2E_PORT=5100 packages/frontend/e2e/fullstack/run.sh
```

`5100` is the second port the port guards in the specs accept. A few specs build
URLs with a literal `localhost:5099` (`canvasJsonCanvas`, `zzAuditProbes`,
`zzDeepRss07`) and will fail on another port; run those on the default port.
Specs that use `psql` need `E2E_COMPOSE_PROJECT=<project>` as described below.
`run.sh` stops with a message when something else already answers on the port.

**Runner containers.** `run.sh` labels every runner container it starts
(`onden-e2e-owner=run.sh`, `onden-e2e-run=<pid>-<epoch>`) and only removes (a)
its own, on exit, and (b) labelled leftovers that are stopped or older than
`E2E_STALE_HOURS`. It does not touch other Playwright containers. Runners left
by versions of the script before labelling are unlabelled and must be removed by
hand (`docker ps --filter ancestor=mcr.microsoft.com/playwright:v1.60.0-noble`).

## Probes (not tests)

The `zz*` specs that only log values (no `expect`) live in [`probes/`](probes/README.md), not in `fullstack/`, so a green
fullstack run is never read as protection from them. Run them with `npm run e2e:probes` (see that README).
A spec in `fullstack/` must be able to fail: `src/test/guards/e2eSelectors.guard.test.ts` rejects class names and
`data-testid`s that src/ no longer renders.

## Requirements / notes

- `docker` + `node`/`npm`.
- The backend's normal `migrate()` startup reconciles the default workspace
  seed. The runner waits for `/api/bootstrap` to return 200 or 401; it does not
  create that workspace through a separate test-only startup path.
- Specs that read or stage the database directly (`zzDeepAcc06b`, `zzDeepData01`,
  `zzDeepData01Notion`, `zzDeepPerf01`, `zzDeepUx04`) run `psql` inside the
  stack's Postgres container, resolved by `e2ePostgresContainer()` in
  `fullstack/helpers.ts`:
  - `E2E_PG_CONTAINER` — the exact container name (wins when set);
  - `E2E_COMPOSE_PROJECT` — the compose project the stack was started with
    (e.g. `onden-e2e`); the container is `<project>-postgres-1`;
  - neither set — those tests are **skipped** with a message, never pointed at
    a guessed container. Check the name with `docker ps --format '{{.Names}}'`.
- A second human created with `POST /api/actors` joins **no** shared space by
  itself (migration 097). A spec that expects them to read or write notes in
  the default 「共用」 space calls `addToDefaultSpace(request, actor.id)` right
  after creating the actor; one that tests a non-member leaves it out.
- Set `E2E_REQUIRE_ADMIN=1` for acceptance/CI so an incorrectly provisioned
  admin fixture fails instead of silently skipping protected flows.
- Gitignored artifacts: `node_modules/`, `harness/dist/`, `*.png`.

## 3. 白板的觸控手感 — `browser-app/boardMotion.mjs`

不需要 Docker／Postgres：用 `npm run build:browser`（根目錄）的瀏覽器版，在手機視窗（Pixel 5，觸控）用真的觸控事件量白板——
卡片跟手（縮放 0.5／1／2 倍，每步量「手指 − 卡片左上角」）、拿起與放下、點卡片不會新增卡片、拖畫面時整頁不捲動與底部導覽不動、
放開後滑行與被打斷、「減少動態」、小地圖不被工具列蓋住。有檢查失敗時結束碼為 1；`--shots <資料夾>` 另存截圖。

```sh
cd packages/frontend && node e2e/browser-app/boardMotion.mjs --shots /tmp/board-shots
```

## 4. 按住後拖的觸控 — `browser-app/touchHold.mjs`

同樣用瀏覽器版（桌面尺寸、觸控）：用 CDP 的 `Input.dispatchTouchEvent` 送真的觸控序列。側欄筆記列按住 400ms 再往下 150px 放開——清單不捲、沒有
`pointercancel`、筆記真的被搬走；不按住直接滑——清單會捲、不會拖；標籤列與檢視分頁各一個簡單版。另外直接檢查這三個容器靜止時就有非 passive 的
`touchstart` 監聽（`lib/touchHold` 的 `holdSurface`）。無頭桌面 Chromium 不管有沒有這個監聽都把觸控當成可取消，單看行為重現不了平板上的失敗，
所以「監聽存在」那幾項才是修前會失敗的守門。`npm run e2e:touch-hold`。
