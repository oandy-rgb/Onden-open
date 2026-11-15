# Persona boot kit — full Onden stack in a cloud sandbox

Goal: `http://localhost:5099` serves UI **and** `/api` from one origin (like `docker/nginx/nginx.conf`), so a headless
Playwright agent can drive Onden as a user persona.

```bash
scripts/persona/boot.sh          # fresh sandbox -> READY (idempotent, detached services, log /tmp/onden-boot.log)
scripts/persona/reset.sh         # wipe DB to fresh (next signup = owner) + restart backend, ~5s
cd scripts/persona && node smoke.mjs   # owner signup -> new note -> type -> reload -> persisted (desktop + phone)
# your own script, in scripts/persona/:  import { chromium } from "playwright"; import { newOwner, newMember, importAllModules, phone } from "./pw.mjs";
```

## Which path: native, not docker
* `dockerd` is installed but **not running**; `dockerd &` starts it and pulling images works, but `docker compose build`
  fails: build containers have no DNS/route for `deb.debian.org` (apt over plain HTTP is not proxied). So no compose.
* Native stack instead (Ubuntu 24.04, root, apt works against archive.ubuntu.com):
  PostgreSQL **16** (apt) + pgvector 0.8.2 + PGroonga **3.1.0**
  (all built from source from GitHub; `packages.groonga.org` and `apt.postgresql.org` are blocked, so no PG18/pgdg/groonga apt;
  PGroonga 3.1.0 is the newest that builds against Ubuntu's libgroonga 13.1) + pgcrypto + pg_stat_statements
  (`shared_preload_libraries='pg_stat_statements'`).
* `schema.sql` is a PG18 dump; the only PG16 incompatibility is `SET transaction_timeout` — boot/reset strip that one line.
  **All 4 extensions are real; nothing is stripped or degraded in the DB.**
* Backend (`node dist/server.js`, :8787), Astro SSR (`dist/server/entry.mjs`, :4321, `SSR_API_URL=http://localhost:8787`,
  built with `PUBLIC_API_BASE_URL=` empty), nginx (`nginx.conf` here, :5099; `/api/events/stream` unbuffered). Env = compose.e2e.yaml.
  PIDs/logs in `/tmp/onden-run/` (`backend.log`, `frontend.log`, `nginx-error.log`).
* Playwright: `cdn.playwright.dev` is blocked, so boot.sh installs the npm `playwright` matching the sandbox's preinstalled
  Chromium in `/opt/pw-browsers` (reads `playwright --version`, currently 1.63.0) into `scripts/persona/node_modules` (git-ignored).

## Environment facts (observed)
4 vCPU, 16 GB RAM, 250 GB disk (≈30 GB free), Node 22.22, root user, Ubuntu 24.04. Outbound: HTTPS via proxy allowlist
(npm, github.com, archive.ubuntu.com OK; cdn.playwright.dev, packages.groonga.org, apt.postgresql.org blocked).

## Timings
See bottom of this file (measured cold boot). Warm re-run of boot.sh (everything built, services up): ~10 s.
`reset.sh` ~5 s. smoke.mjs ~30 s.

## Not covered / degraded
* Everything uses real components. Embeddings are the deterministic stub (`EMBEDDING_MODE=stub`, as e2e): semantic
  search/suggestLinks match exact text, not meaning. No outbound-feed testing beyond what the allowlist permits (RSS to
  arbitrary hosts will likely be blocked by the sandbox proxy, not by the app).
* Only one stack per sandbox (ports 5099/8787/4321/5432 are fixed).

## Gotchas
* **UI language follows the browser locale.** Default en-US gives English labels; `pw.mjs` sets `locale: "zh-TW"` (button
  `新筆記`). `ONDEN_LOCALE=en-US` flips it.
* **First user on a fresh DB = owner**; later signups = editors (403 on owner-only endpoints such as module import). Use
  `reset.sh` to get a new owner. `smoke.mjs` uses unique emails, so run it anywhere — but it will make an owner if the DB is empty.
* Sign-up POST needs `origin` + `content-type` headers (pw.mjs does). Never `waitUntil:'networkidle'` (SSE never idles).
* First-run storage picker ("Use browser storage") must be dismissed; pw.mjs does it and sets `onden.welcomeDismissed=1`.
* **Phone layout:** shell is `.mobile-bottom-nav` (not `.app-topbar nav`). `新筆記` only adds an `未命名` row to the list;
  tap the row to open the editor. A reload restores the open note.
* Don't `pkill -f dist/server.js` in your own shell — it matches your own command line. Kill by port: `fuser -k 8787/tcp`.
* Tools: boot.sh builds with `npm ci` + builds if `dist/` or `node_modules/` are missing; delete `packages/*/dist` to force a rebuild
  after code changes (the checkout is the app; this kit never edits it).

## Measured timings (this sandbox: 4 vCPU)
* Cold boot, services killed + DB dropped + `node_modules`/`dist` wiped, apt packages and extensions already installed:
  **80 s** (npm ci 19 s, builds 53 s, rest <10 s), then `smoke.mjs` PASS desktop + PASS phone.
* Truly fresh sandbox adds apt install + building pgvector/PGroonga from source: roughly 2–4 min more
  (not re-timed end to end; the build steps ran once by hand earlier and boot.sh's same commands ran on the first boot).
* Warm re-run: ~10 s. reset.sh: ~5 s.
