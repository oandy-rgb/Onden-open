// Old frontend, new backend: every write the frontend of each kept production
// release sends (method, path, body, Idempotency-Key — as its writers build
// them and as its offline queue stores them) is replayed against THIS backend,
// in a workspace seeded with the ids the capture used.
//
// Fixtures: src/test/fixtures/client-writes/<commit>/writes.json, recorded by
//   npm run capture:client-writes -- <commit>
// (packages/frontend/scripts/client-writes). A browser tab or an installed PWA
// keeps running the code it loaded, and a queued write is replayed by whatever
// code is open when the connection returns, so a deploy must keep accepting
// what the releases still in use send.
//
// THE RULE — keep the last N production releases (N = 4 today: every release
// deployed in roughly the last week; docs/deploy-log.md lists them) plus the
// commit about to deploy (38f789cd is main as of this test's introduction). When you
// deploy a new release R: `npm run capture:client-writes -- R`, commit the new
// directory, and delete the oldest one once nobody can still be running it
// (an installed PWA is reloaded by the 「有新版」 prompt; a tab left open for
// days is the case this keeps safe). The newest capture should be of the
// commit that is about to deploy, so a payload change shows up in the same PR.
//
// What counts as passing, per scenario and release:
//   • every request answers 2xx, and the rows afterwards mean what the person
//     meant (`expect` in the fixture: read from the database, not inferred from
//     the status — a field the server ignored or renamed shows up as a wrong
//     row, not as an error); or
//   • the request is refused on purpose with a 4xx code that release's own UI
//     has a message for (DESIGNED_REFUSALS: the feature the old screen used is
//     gone, e.g. role_removed). The refusal is listed so a new one is a decision,
//     not a surprise; and
//   • never a 5xx, never a refusal with no code, a code the release has no
//     message for, or the generic bad_request.
// A real incompatibility is listed in KNOWN_INCOMPATIBLE with route, old payload
// and what to change, and runs as `it.fails`, so it turns red the moment it is
// fixed (remove the entry then).
//
// transcribed.json (in the two releases that had them) holds the few requests
// built inside components the capture does not render; they are written by hand
// from the source named in each scenario.
//
// Replay details: ids in a fixture are placeholders (00000000-0000-4000-8000-…);
// each scenario gets fresh random ids substituted consistently, in a workspace
// of its own whose first (and only owner) member is signed in through the
// mocked session — the same actor kind as the owner's real browser.
// SAFETY: only runs against a *_test database; skips otherwise.

import { holderViewsSql } from "../services/functionRefSql.js";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { Run, seedWorkspace } from "./helpers/clientSkewWorkspace.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => (await import("./helpers/clientSkewWorkspace.js")).skew.workspaceId,
}));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => { const { skew: s } = await import("./helpers/clientSkewWorkspace.js"); return s.user ? { user: s.user } : null; }) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
type Request = { via: "api" | "queue"; method: string; path: string; headers: Record<string, string>; body: unknown };
type Expectation = Record<string, unknown>;
type Scenario = {
  name: string; expect: Expectation[];
  /** transcribed.json only: the component source the request was read from. */
  source?: string;
  serverFirst?: Array<{ node: string; markdown: string }>;
  personPermission?: "view" | "edit";
  online: Request[]; queued: Request[]; skipped?: string;
};
type Capture = { commit: string; short: string; subject: string; ids: Record<string, string | number>; serverErrorCodes: string[]; scenarios: Scenario[] };

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "fixtures/client-writes");
const captures: Capture[] = existsSync(FIXTURE_DIR)
  ? readdirSync(FIXTURE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(FIXTURE_DIR, d.name, "writes.json")))
    .map((d) => {
      const writes = JSON.parse(readFileSync(join(FIXTURE_DIR, d.name, "writes.json"), "utf8")) as Omit<Capture, "commit" | "short" | "subject">;
      const release = JSON.parse(readFileSync(join(FIXTURE_DIR, d.name, "release.json"), "utf8")) as { commit: string; subject: string; committed_at: string };
      // Requests built inside components, written down by hand from the release's source.
      const byHand = existsSync(join(FIXTURE_DIR, d.name, "transcribed.json"))
        ? (JSON.parse(readFileSync(join(FIXTURE_DIR, d.name, "transcribed.json"), "utf8")) as { scenarios: Scenario[] }).scenarios
            
        : [];
      writes.scenarios = [...writes.scenarios, ...byHand];
      return { ...writes, short: d.name, commit: release.commit, subject: release.subject, committedAt: release.committed_at };
    })
    .sort((a, b) => (a as { committedAt: string }).committedAt.localeCompare((b as { committedAt: string }).committedAt))
  : [];

/**
 * Real incompatibilities found by this replay. Key: `<short commit> <scenario>`.
 * Each is an `it.fails`: the day the API accepts the old payload (or the entry
 * is deleted with the release), the test goes red and the entry must be removed.
 */
const KNOWN_INCOMPATIBLE: Record<string, string> = {
  "9dae1521 space.set member permission (edit)": "PUT /api/spaces/:id/members/:actorId {role} → 400 bad_request (unrecognized key) — the generic text, not a designed refusal",
  "9dae1521 space.set member permission (view)": "PUT /api/spaces/:id/members/:actorId {role} → 400 bad_request (unrecognized key) — the generic text, not a designed refusal",
};

/**
 * Refusals that are the design, not a bug: the feature the old screen used is
 * gone and the server says so with a code that release's UI has a message for.
 * Key: `<short commit> <scenario>` → the code. Anything else that is refused is
 * a problem, and a code that changes shows here.
 */
const DESIGNED_REFUSALS: Record<string, string> = {
  "9dae1521 actor.invite a person with a role and email": "role_removed",
  "9dae1521 actor.add an AI helper with a role": "role_removed",
  "9dae1521 actor.change a member's role": "role_removed",
  "9dae1521 token.mint with a template and space scope": "token_scope_removed",
  "9dae1521 token.re-scope a live token": "token_scope_removed",
  "c93b93d4 token.re-scope a live token": "token_scope_removed",
};

/** Codes whose text tells the person nothing about why: a refusal with one is not "clear". */
const GENERIC_CODES = new Set(["bad_request"]);

// ── Judging: rows, not status codes ───────────────────────────────────────────
async function judge(run: Run, scenario: Scenario): Promise<string[]> {
  const WS = run.workspace;
  const failures: string[] = [];
  const same = (what: string, actual: unknown, wanted: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${what}: is ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  };
  const node = async (nodeId: string) => {
    const row = (await q<Record<string, unknown>>(`SELECT * FROM content_nodes WHERE id = $1 AND workspace_id = $2`, [nodeId, WS])).rows[0];
    // Saved views are function references since migration 188; the column of that name is frozen. Read them as a client does.
    if (row) row.collection_views = (await q<{ v: unknown }>(`SELECT ${holderViewsSql("n")} AS v FROM content_nodes n WHERE n.id = $1`, [nodeId])).rows[0]?.v ?? null;
    return row;
  };
  const bootstrap = async () => (await run.call("GET", "/api/bootstrap")).json as { tasks: any[]; workspace: { home_node_id: string | null } };

  for (const wanted of run.mapped(scenario.expect) as Array<Record<string, any>>) {
    if ("node" in wanted && "fields" in wanted) {
      const row = await node(wanted.node);
      if (!row) { failures.push(`note ${wanted.node} does not exist`); continue; }
      for (const [key, value] of Object.entries(wanted.fields)) {
        // A release from before migration 138 means "a board" by node_type 'canvas'.
        // Since then a board is a plain note with a whiteboard tab (kept as a canvas
        // view of the note): that is what the person asked for.
        if (key === "node_type" && value === "canvas") {
          const tab = Array.isArray(row.collection_views) && (row.collection_views as Array<{ layout?: string }>).some((v) => v.layout === "canvas");
          same("note is a board (node_type canvas, or a note with a whiteboard tab)", row.node_type === "canvas" || (row.node_type === "content" && tab), true);
        } else same(`note.${key}`, row[key] ?? null, value);
      }
    } else if ("node" in wanted && "contains" in wanted) {
      const row = await node(wanted.node);
      for (const text of wanted.contains as string[]) if (!String(row?.markdown ?? "").includes(text)) failures.push(`note body lost ${JSON.stringify(text)}; body is ${JSON.stringify(row?.markdown)}`);
    } else if ("node" in wanted && "deleted" in wanted) {
      const row = await node(wanted.node);
      same("note in trash", row ? row.deleted_at !== null : "missing", wanted.deleted);
    } else if ("attribute" in wanted) {
      const row = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [wanted.attribute.node, wanted.attribute.key])).rows[0];
      same(`attribute ${wanted.attribute.key}`, row?.value ?? null, wanted.value);
    } else if ("tagged" in wanted) {
      const row = (await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [wanted.tagged.node, wanted.tagged.tag])).rows[0];
      same("tag applied", !!row, wanted.present);
    } else if ("edge" in wanted) {
      const row = (await q<Record<string, unknown>>(`SELECT * FROM node_edges WHERE id = $1`, [wanted.edge])).rows[0];
      if (wanted.fields === null) same("edge exists", !!row, false);
      else if (!row) failures.push(`edge ${wanted.edge} does not exist`);
      else for (const [key, value] of Object.entries(wanted.fields)) same(`edge.${key}`, row[key], value);
    } else if ("task" in wanted) {
      const task = (await bootstrap()).tasks.find((t) => t.id === wanted.task);
      if (wanted.fields === null) same("task exists", !!task, false);
      else if (!task) failures.push(`task ${wanted.task} is not in the bootstrap`);
      else for (const [key, value] of Object.entries(wanted.fields)) same(`task.${key}`, task[key] ?? null, value);
    } else if ("space" in wanted) {
      const row = (await q<Record<string, unknown>>(`SELECT * FROM spaces WHERE id = $1`, [wanted.space])).rows[0];
      for (const [key, value] of Object.entries(wanted.fields)) same(`space.${key}`, row?.[key] ?? null, value);
    } else if ("member" in wanted) {
      const row = (await q<{ permission: string }>(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [wanted.member.space, wanted.member.actor])).rows[0];
      same("member permission", row?.permission ?? null, wanted.permission);
    } else if ("workspaceHome" in wanted) {
      same("workspace home", (await q<{ home_node_id: string | null }>(`SELECT home_node_id::text FROM workspaces WHERE id = $1`, [WS])).rows[0]!.home_node_id, wanted.workspaceHome);
    } else if ("position" in wanted) {
      const row = (await q<{ x: number; y: number }>(`SELECT x, y FROM node_positions WHERE node_id = $1 AND surface = 'graph'`, [wanted.position.node])).rows[0];
      same("graph position", row && [row.x, row.y], [wanted.position.x, wanted.position.y]);
    } else if ("board" in wanted) {
      const board = (await run.call("GET", `/api/boards/${wanted.board}`)).json as { cards?: Array<{ nodeId: string; x: number; y: number }> };
      for (const card of wanted.cards as Array<{ nodeId: string; x: number; y: number }>) {
        const found = board.cards?.find((c) => c.nodeId === card.nodeId);
        same(`board card ${card.nodeId}`, found && [found.x, found.y], [card.x, card.y]);
      }
    } else if ("tagSchemaFields" in wanted) {
      const row = await node(wanted.tagSchemaFields.tag);
      const names = ((row?.tag_schema as { fields?: Array<{ name: string }> } | null)?.fields ?? []).map((f) => f.name);
      same("tag schema fields", names, wanted.tagSchemaFields.names);
    } else if ("extendsTags" in wanted) {
      const tag = (await run.call("GET", `/api/tags/${wanted.extendsTags.tag}`)).json as { extends?: string[] };
      same("tag extends", tag.extends ?? [], wanted.extendsTags.targets);
    } else if ("tagPath" in wanted) {
      const [parent, leaf] = wanted.tagPath as string[];
      const row = (await q(`SELECT 1 FROM content_nodes c JOIN content_nodes p ON p.id = c.parent_id
                             WHERE c.workspace_id = $1 AND c.node_type = 'class_tag' AND c.title = $2 AND p.title = $3 AND c.deleted_at IS NULL`, [WS, leaf, parent])).rows[0];
      same(`tag path ${wanted.tagPath.join("/")}`, !!row, true);
    } else if ("spaceByName" in wanted) {
      same(`space ${wanted.spaceByName}`, (await q(`SELECT 1 FROM spaces WHERE workspace_id = $1 AND name = $2`, [WS, wanted.spaceByName])).rows.length > 0, true);
    } else if ("view" in wanted) {
      const views = ((await node(wanted.view.owner))?.collection_views ?? []) as Array<Record<string, unknown>>;
      const view = views.find((v) => v.id === wanted.view.id);
      if (wanted.view.fields === null) same("view exists", !!view, false);
      else if (!view) failures.push(`view ${wanted.view.id} does not exist`);
      else for (const [key, value] of Object.entries(wanted.view.fields)) same(`view.${key}`, view[key], value);
    } else if ("viewNamed" in wanted) {
      const views = ((await node(wanted.viewNamed.owner))?.collection_views ?? []) as Array<{ name: string }>;
      same(`view ${wanted.viewNamed.name}`, views.some((v) => v.name === wanted.viewNamed.name), true);
    } else if ("actorNamed" in wanted) {
      same(`actor ${wanted.actorNamed.name}`, (await q(`SELECT 1 FROM actors WHERE workspace_id = $1 AND name = $2 AND type = $3`, [WS, wanted.actorNamed.name, wanted.actorNamed.type])).rows.length > 0, true);
    } else if ("actorGone" in wanted) {
      same("actor removed", (await q(`SELECT 1 FROM actors WHERE id = $1`, [wanted.actorGone])).rows.length > 0, false);
    } else if ("tokenFor" in wanted) {
      same(`key ${wanted.tokenFor.name}`, (await q(`SELECT 1 FROM agent_tokens WHERE actor_id = $1 AND name = $2 AND revoked_at IS NULL`, [wanted.tokenFor.actor, wanted.tokenFor.name])).rows.length > 0, true);
    } else if ("tokenScopeAccepted" in wanted) {
      same("key still valid", (await q(`SELECT 1 FROM agent_tokens WHERE id = $1 AND revoked_at IS NULL`, [wanted.tokenScopeAccepted.token])).rows.length > 0, true);
    } else if ("tokenRevoked" in wanted) {
      same("key revoked", (await q<{ revoked_at: string | null }>(`SELECT revoked_at FROM agent_tokens WHERE id = $1`, [wanted.tokenRevoked.token])).rows[0]?.revoked_at != null, true);
    } else {
      failures.push(`the replay test does not know the expectation ${JSON.stringify(wanted)}`);
    }
  }
  return failures;
}

type Outcome = { responses: Array<{ request: Request; status: number; json: any }>; problems: string[]; steps: string[]; refusedBy?: string };

async function replay(capture: Capture, scenario: Scenario): Promise<Outcome> {
  const run = await seedWorkspace(capture.ids, scenario);
  const WS = run.workspace;
  const outcome: Outcome = { responses: [], problems: [], steps: [] };
  // The queue's entries are what an offline client replays later; they are the
  // same writes, and only differing ones need their own replay.
  const key = (r: Request) => JSON.stringify([r.method, r.path, r.body]);
  const online = scenario.online.map((r) => key(r));
  const requests = [...scenario.online, ...scenario.queued.filter((r) => !online.includes(key(r)))];
  if (!requests.length) { outcome.problems.push(`the capture holds no request for this scenario (${scenario.skipped ?? "unknown reason"})`); return outcome; }

  for (const request of requests) {
    let body = run.mapped(request.body) as any;
    // A preview's epoch is read just before the move; use the current one.
    if (body && typeof body === "object" && "membership_epoch" in body) {
      body = { ...body, membership_epoch: (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).rows[0]!.e };
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) headers[name] = run.mapped(value as string);
    const path = run.mapped(request.path);
    const response = await run.call(request.method, path, body, headers);
    outcome.responses.push({ request, ...response });
    outcome.steps.push(`${request.method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (m) => m.slice(0, 8))} → ${response.status}`);
    if (response.status >= 500) outcome.problems.push(`${request.method} ${request.path} answered ${response.status}: ${JSON.stringify(response.json)}`);
    else if (response.status >= 400) {
      const code = typeof response.json?.error === "string" ? response.json.error : null;
      const designed = DESIGNED_REFUSALS[`${capture.short} ${scenario.name}`];
      if (code !== null && code === designed && capture.serverErrorCodes.includes(code)) outcome.refusedBy = code;
      else {
        const why = code === null ? "with no error code"
          : GENERIC_CODES.has(code) ? `with the generic code ${code}, whose text does not say why`
          : !capture.serverErrorCodes.includes(code) ? `with ${code}, which release ${capture.short} has no message for`
          : `with ${code}, which is not a listed designed refusal`;
        outcome.problems.push(`${request.method} ${request.path} was refused ${response.status} ${why}: ${JSON.stringify(response.json)}; old payload ${JSON.stringify(request.body)}`);
      }
    }
  }
  // A designed refusal means the old action was not carried out; the rows are
  // judged only when everything was accepted.
  if (!outcome.refusedBy) outcome.problems.push(...await judge(run, scenario));
  return outcome;
}

const outcomes = new Map<string, Promise<Outcome>>();
/** Identical requests from different releases are replayed once. */
function outcomeOf(capture: Capture, scenario: Scenario): Promise<Outcome> {
  const fingerprint = JSON.stringify([scenario.name, scenario.expect, scenario.serverFirst, scenario.personPermission, scenario.online, scenario.queued]);
  if (!outcomes.has(fingerprint)) outcomes.set(fingerprint, replay(capture, scenario));
  return outcomes.get(fingerprint)!;
}

describe.skipIf(!isTestDb)("old frontend writes against the current backend", () => {
  beforeAll(() => {
    expect(captures.length, "no capture under src/test/fixtures/client-writes").toBeGreaterThan(0);
  });

  it("keeps a bounded set of releases", () => {
    // The rule in the header: bump this together with the deploy that adds one.
    expect(captures.length).toBeLessThanOrEqual(6);
  });

  for (const capture of captures) {
    describe(`release ${capture.short} — ${capture.subject}`, () => {
      for (const scenario of capture.scenarios) {
        const known = KNOWN_INCOMPATIBLE[`${capture.short} ${scenario.name}`];
        const run = known ? it.fails : it;
        const shown = `${scenario.name}${scenario.source ? ` (transcribed from ${scenario.source})` : ""}`;
        const designed = DESIGNED_REFUSALS[`${capture.short} ${scenario.name}`];
        run(`${shown}${designed ? ` [refused by design: ${designed}]` : ""}${known ? ` [known incompatible: ${known}]` : ""}`, async () => {
          const outcome = await outcomeOf(capture, scenario);
          expect(outcome.problems, outcome.steps.join("\n")).toEqual([]);
          if (designed) expect(outcome.refusedBy, "the designed refusal no longer happens: remove it from DESIGNED_REFUSALS").toBe(designed);
        }, 30_000);
      }
    });
  }

  it("never answers a replayed old write with a 5xx", async () => {
    const statuses: string[] = [];
    for (const capture of captures) for (const scenario of capture.scenarios) {
      for (const response of (await outcomeOf(capture, scenario)).responses) {
        if (response.status >= 500) statuses.push(`${capture.short} ${scenario.name}: ${response.request.method} ${response.request.path} → ${response.status}`);
      }
    }
    expect(statuses).toEqual([]);
  }, 120_000);

  it("only refuses with a code the client knows (an `error` string), never an empty or HTML body", async () => {
    const odd: string[] = [];
    for (const capture of captures) for (const scenario of capture.scenarios) {
      for (const response of (await outcomeOf(capture, scenario)).responses) {
        if (response.status >= 400 && response.status < 500 && typeof response.json?.error !== "string") {
          odd.push(`${capture.short} ${scenario.name}: ${response.request.method} ${response.request.path} → ${response.status} ${JSON.stringify(response.json)}`);
        }
      }
    }
    expect(odd).toEqual([]);
  }, 120_000);
});
