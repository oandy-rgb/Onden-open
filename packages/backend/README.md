# Onden Backend

Hono + PostgreSQL API server for the Onden knowledge management substrate.

## Local

```bash
npm install
npm run dev
```

The API expects PostgreSQL at `DATABASE_URL`. The `compose.yaml` at the
repo root brings up the full stack (Postgres + backend + frontend + nginx).

## Routes (current, by domain)

Auth & bootstrap — `auth.ts`, bootstrap handler in `index.ts`
- `GET /health` — liveness probe
- `GET /api/bootstrap` — workspace + actor state in one payload

Nodes — `routes/nodes.ts`
- `GET /api/nodes`, `POST /api/nodes`, `PATCH /api/nodes/:id`, `DELETE /api/nodes/:id`
- `GET /api/nodes/search?q=…` — pgroonga text + tag + attribute filters

Versions / sandbox CoW — `routes/versions.ts`
- `POST /api/versions/:id/merge` — reviewer accepts a pending submission
- `POST /api/versions/:id/reject` — reviewer rejects
- `GET /api/versions/preview/:id` — diff against current node markdown
- `GET /api/versions/inbox` — list pending submissions

Tags, attributes, dispatcher — `routes/tags.ts`
- `GET /api/tags`, `POST /api/tags`, `PATCH /api/tags/:id`
- `POST /api/nodes/:id/tags`, `DELETE /api/nodes/:id/tags/:tagId`
- `PATCH /api/nodes/:id/attributes`

Query layer — `routes/query.ts`
- `POST /api/query` — structured search over tags + attributes

Publish & backup — `routes/publish.ts`, `modules/website/publishing/*`
- `POST /api/publish` — build static site, optionally push to GitHub Pages
- `GET /api/publish/site` — latest published manifest
- `GET /api/publish/snapshots` — past publish snapshots
- Per-note backup push runs inside `routes/nodes.ts` /
  `routes/import.ts` save handlers; no separate endpoint.

Other — `routes/{actors, ai, bookmark, canvases, demo, events, export,
import, media, pointers, rss, sync}.ts`

## Storage substrate

- `content_nodes` — primary node table
- `content_node_versions` — version chain (`parent_version_id` DAG,
  `is_pending` flag for sandbox CoW, `blob_hash` references the blob layer)
- `blobs` — content-addressable per-note storage (SHA-256 hex, migration 030)
- `node_attributes(key, value, source)` — derived + explicit attributes
- `domain_events` — append-only audit log (PG trigger blocks UPDATE/DELETE,
  carries `actor_type IN ('user', 'ai_agent', 'system')`)
- `tags`, `collection_schemas` — supertag substrate (per `tags.schema_id`)
- `publish_snapshots` — published-site artifact log

The `migrations/*.sql` directory carries 30+ incremental migrations; the
`schema.sql` baseline is what `docker-entrypoint-initdb.d` runs on a fresh
volume. After bootstrap, `migrate()` in `db.ts` applies anything past the
baseline.

## Backup (two-track)

Each save fire-and-forgets to two places:

1. **`writeAndCommit`** in `git.ts` writes the markdown to
   `/app/packages/backend/content/<slug>.md` and commits to a
   container-local git repo (`content_data` named volume).

2. **`pushNoteToBackup`** in `modules/website/publishing/githubBackup.ts`
   pushes the same content to a configured remote GitHub repo via
   Octokit. When `GITHUB_BACKUP_REPO` is unset, this is a no-op.

Both failures are swallowed — DB writes are never rolled back by backup
failures.

## Tests

```bash
npm run test:pglite   # DB-gated tests run, on PGlite (no server needed); the cloud lane
npm test              # DB-gated tests run on the real Postgres DATABASE_URL names (…_test)
npm run test:no-db    # an explicit no-database run: DB-gated tests skip, and the run says how many
```

Every way of running the suite ends with `[tests] mode: …, ran N, skipped M`. A run that skipped DB-gated tests
without being started as `test:no-db` **fails** (`scripts/lib/skipGateReporter.mjs`); on PGlite or real Postgres only the
tests named in `src/test/helpers/pgliteSkipList.ts` may skip. Tests include pure functions, mocked adapters, assembled Hono requests and real
PostgreSQL integration suites. Some unit tests start local HTTP servers, so the
runner must permit loopback sockets.

Without a test `DATABASE_URL`, the integration suites skip, and the run fails unless it was started as
`npm run test:no-db`: a no-database run does **not** prove that database policy, transactions, migrations or
triggers passed. Point `DATABASE_URL` at a disposable database whose name ends in
`_test` (for example `onden_test`) on a Postgres with the extensions from
`docker/postgres/Dockerfile`, then run:

```bash
# Set DATABASE_URL to the isolated onden_test instance first. The whole suite: every DB-gated file
# (integration, properties, backup round trips), not only *.integration.test.ts.
npm test
```

**The shared test database.** All integration files run against that one
database. At the start of every run `src/test/globalSetup.ts` drops and
rebuilds it from `db/schema.sql` (plus any newer migration);
`ONDEN_TEST_DB_KEEP=1` keeps it and whatever earlier runs left in it.
Nothing resets it between files, so a test must be right whatever other data
is there, as in production: it makes its own actors, spaces and notes with
unique names, scopes its queries and assertions to its own ids, and never
counts global rows, takes "the only" or "the first" row, or relies on
something another test left behind. A test that gets slower as the database
grows is a bug in the query or in the test, not a reason to raise its timeout.

**Random order.** Test files and the tests inside each file run in a random
order on every run (`sequence.shuffle` in `vitest.config.ts`). The run prints
its seed at the top (`Running tests with seed "1234"`); replay that exact
order with

```bash
npx vitest run --sequence.seed=1234
# or a single file: npx vitest run src/test/foo.integration.test.ts --sequence.seed=1234
```

A test that passes alone and fails in some order depends on another test:
give it its own setup instead of pinning the order.

Never point this command at the production database. CI setup is documented in
the repository's `.github/workflows/ci.yml`. Actual test counts, executed/skipped
results and source revisions belong in the
[acceptance execution record](../../docs/archive/browser-acceptance-2026-09-21.md),
not an undated count in this README. Browser tests use a separate
[full-stack environment](../frontend/e2e/README.md).

## Environment

See repo root `README.md` for the full env-var table. Backend-specific:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- `GITHUB_TOKEN`, `GITHUB_PAGES_REPO`, `GITHUB_PAGES_BRANCH`
- `GITHUB_BACKUP_REPO`, `GITHUB_BACKUP_BRANCH`, `GITHUB_BACKUP_PATH_PREFIX`
- `ALLOW_NATIVE_BYPASS` (dev only)
