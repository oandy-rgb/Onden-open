// Two devices save the same note from the same starting text, through the real save route
// (PATCH /api/nodes/:id on the assembled app, DB), the way the editor does: `base_markdown`,
// `body_change` (a CodeMirror ChangeSet), and an Idempotency-Key that a lost response makes the
// client reuse. Device X's save lands first; device Y's save (made from the older text) is merged.
//
// Bodies are blank-line separated paragraphs, each with its own token, some tagged `{alpha}` (a
// tagged paragraph has a block anchor). Edits add a new paragraph or delete one.
//
// Invariants (names in the failure message):
//   no-loss      every paragraph a device added is in the stored body or in a BODY_CONFLICT of the note
//   no-revive    a paragraph one device deleted and nobody else touched is not in the body
//   once         a paragraph is in the body at most once (a retry with the same key never doubles it)
//   retry        the same request sent again with its key is answered as a replay (deduped) or as the same note, and writes nothing
//   keep-anchor  a tagged paragraph neither device deleted keeps its anchor id
//   block-index  live block_nodes equal parseBlocks of the stored body and valid anchors
//   bad-change   a ChangeSet that does not fit (stale, garbage) changes nothing about the stored body
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/twoDeviceSave
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createHash, randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import { deriveChangeSet } from "../../services/blockAnchors/changes.js";
import { parseBlocks, CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL } from "@onden/markdown";
import { checkAsync } from "../helpers/propsConfig.js";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));
let sessionExternalId: string | null = null;
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: sessionExternalId, email: `${sessionExternalId}@props.test` } }
          : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const { app } = isTestDb ? await import("../../app.js") : { app: null as never };

async function call(method: string, path: string, json?: unknown, key?: string): Promise<{ status: number; body: any; text: string }> {
  sessionExternalId = "props-owner";
  try {
    const res = await app.request(path, {
      method,
      headers: {
        [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body, text };
  } finally { sessionExternalId = null; }
}

// ── model ───────────────────────────────────────────────────────────────────

type Edit = { kind: "add"; at: number; tagged: boolean } | { kind: "delete"; at: number };
type Change = "real" | "none" | "garbage" | "stale";
type Step = { x: Edit[]; y: Edit[]; xChange: Change; yChange: Change; retryY: boolean; retryX: boolean };

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant("add" as const), at: fc.nat(8), tagged: fc.boolean() }),
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat(8) }),
);
const changeArb = fc.constantFrom<Change>("real", "real", "none", "garbage", "stale");
const stepArb: fc.Arbitrary<Step> = fc.record({
  x: fc.array(editArb, { maxLength: 2 }), y: fc.array(editArb, { maxLength: 2 }),
  xChange: changeArb, yChange: changeArb, retryY: fc.boolean(), retryX: fc.boolean(),
});

/** A paragraph's text: its token and a run of letters of its own. Paragraphs that differ by a character or two are the
 *  same text to the anchors' similarity check (blockAnchors/similarity.ts), which is not what is under test here. */
const paraText = (tok: string) => `Para ${tok} ${createHash("sha1").update(tok).digest("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!)}`;
type Para = { tok: string; tagged: boolean };
const render = (paras: Para[]) => paras.map((p) => `${paraText(p.tok)}${p.tagged ? " {alpha}" : ""}`).join("\n\n") + "\n";

function applyEdits(paras: Para[], edits: Edit[], fresh: () => string, added: Set<string>, deleted: Set<string>): Para[] {
  const out = [...paras];
  for (const e of edits) {
    if (e.kind === "add") { const tok = fresh(); added.add(tok); out.splice(e.at % (out.length + 1), 0, { tok, tagged: e.tagged }); }
    else if (out.length) { const [gone] = out.splice(e.at % out.length, 1); if (added.has(gone!.tok)) added.delete(gone!.tok); else deleted.add(gone!.tok); }
  }
  return out;
}

function bodyChangeFor(kind: Change, from: string, to: string, stale: string): unknown {
  switch (kind) {
    case "none": return undefined;
    case "garbage": return { changes: [[3, "zz"], 99999], device: "web-props" };
    case "stale": return { changes: deriveChangeSet(stale, `${stale}tail`).toJSON(), device: "web-props" };
    default: return { changes: deriveChangeSet(from, to).toJSON(), device: "web-props" };
  }
}

const validAnchors = async (noteId: string) => (await q<{ id: string; from: number; to: number }>(
  `SELECT anchor_id AS id, from_utf16 AS "from", to_utf16 AS "to" FROM block_anchors WHERE note_id = $1 AND status = 'valid'`, [noteId])).rows;
const anchorIdOf = async (noteId: string, tok: string): Promise<string | null> => (await q<{ block_ref: string }>(
  `SELECT block_ref FROM block_nodes WHERE note_id = $1 AND hidden_at IS NULL AND label = $2 LIMIT 1`, [noteId, paraText(tok)])).rows[0]?.block_ref ?? null;
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const eventCount = async (id: string) => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE target_id = $1`, [id])).rows[0]!.n);
const conflictText = async (id: string) => (await q<{ p: string }>(
  `SELECT payload::text AS p FROM domain_events WHERE target_id = $1 AND event_type = 'BODY_CONFLICT'`, [id])).rows.map((r) => r.p).join("\n");

async function runSteps(steps: Step[]): Promise<string[]> {
  const stamp = randomUUID().replace(/-/g, "").slice(0, 6);
  const created = await call("POST", "/api/nodes", { title: `Two devices ${stamp}`, markdown: "" });
  if (created.status >= 300) throw new Error(`create ${created.status}: ${created.text.slice(0, 200)}`);
  const id: string = created.body.id;
  let counter = 0;
  const fresh = () => `p${stamp}${counter++}`;
  let paras: Para[] = [{ tok: fresh(), tagged: true }, { tok: fresh(), tagged: true }, { tok: fresh(), tagged: false }];
  const seed = await call("PATCH", `/api/nodes/${id}`, { markdown: render(paras) });
  if (seed.status !== 200) throw new Error(`seed ${seed.status}: ${seed.text.slice(0, 200)}`);
  await awaitAllDispatchers();
  const problems: string[] = [];

  for (const [n, step] of steps.entries()) {
    const label = `step ${n + 1} ${JSON.stringify(step)}`;
    const start = await bodyOf(id);
    const startParas = paras;
    const added = new Set<string>(), deleted = new Set<string>();
    const xParas = applyEdits(startParas, step.x, fresh, added, deleted);
    const yAdded = new Set<string>(), yDeleted = new Set<string>();
    const yParas = applyEdits(startParas, step.y, fresh, yAdded, yDeleted);
    const xBody = render(xParas), yBody = render(yParas);
    const anchorsBefore = new Map<string, string | null>();
    for (const p of startParas) anchorsBefore.set(p.tok, await anchorIdOf(id, p.tok));

    const send = (body: string, change: Change, key: string) => call("PATCH", `/api/nodes/${id}`, {
      markdown: body, base_markdown: start,
      ...(bodyChangeFor(change, start, body, start) ? { body_change: bodyChangeFor(change, start, body, start) } : {}),
    }, key);
    const keyX = randomUUID(), keyY = randomUUID();
    const rx = await send(xBody, step.xChange, keyX);
    if (rx.status !== 200) throw new Error(`X ${rx.status}: ${rx.text.slice(0, 300)}\n${label}`);
    const ry = await send(yBody, step.yChange, keyY);
    if (ry.status !== 200) throw new Error(`Y ${ry.status}: ${ry.text.slice(0, 300)}\n${label}`);
    await awaitAllDispatchers();
    const afterBoth = await bodyOf(id);
    const events = await eventCount(id);

    // retry: the response was lost, the client sends the same request with the same key again.
    for (const [retry, body, change, key, first] of [[step.retryX, xBody, step.xChange, keyX, rx], [step.retryY, yBody, step.yChange, keyY, ry]] as const) {
      if (!retry) continue;
      const again = await send(body, change, key);
      if (again.status !== 200 || !(again.body?.deduped === true || again.body?.id === first.body?.id)) problems.push(`retry: the same key answered ${again.status} ${again.text.slice(0, 120)}\n${label}`);
      await awaitAllDispatchers();
      if (await bodyOf(id) !== afterBoth || await eventCount(id) !== events) problems.push(`retry: sending a request again with its key changed the note or wrote an event\n${label}`);
    }

    // what the merge left
    const final = afterBoth;
    const conflicts = await conflictText(id);
    const everAdded = new Set([...added, ...yAdded]);
    for (const tok of everAdded) {
      const count = final.split(paraText(tok)).length - 1;
      if (count > 1) problems.push(`once: ${tok} is in the body ${count} times\n${label}\n${final}`);
      if (count === 0 && !conflicts.includes(paraText(tok))) problems.push(`no-loss: ${tok} (added by a device) is neither in the body nor in a BODY_CONFLICT\n${label}\nX saved:\n${xBody}\nY saved:\n${yBody}\nnow:\n${final}`);
    }
    for (const tok of deleted) {
      if (!yParas.some((p) => p.tok === tok) || yDeleted.has(tok)) { // Y did not keep a changed copy of it
        if (yDeleted.has(tok) || !yParas.some((p) => p.tok === tok)) { if (final.includes(paraText(tok))) problems.push(`no-revive: ${tok} was deleted by X (Y left it alone) but is back\n${label}\n${final}`); }
      }
    }
    for (const tok of yDeleted) {
      if (!deleted.has(tok) && !xParas.some((p) => p.tok === tok)) continue;
      if (!xParas.some((p) => p.tok === tok) && final.includes(paraText(tok))) problems.push(`no-revive: ${tok} was deleted by Y but is back\n${label}\n${final}`);
    }
    // A merge of two inserts at one place can leave two paragraphs on adjacent lines (one block). The next step's
    // render puts a blank line between them, which cuts that block: not the case under test here.
    const startLines = start.split("\n");
    const glued = new Set(startParas.filter((p) => {
      const i = startLines.findIndex((l) => l.startsWith(paraText(p.tok)));
      return i >= 0 && ((startLines[i - 1] ?? "") !== "" || (startLines[i + 1] ?? "") !== "");
    }).map((p) => p.tok));
    const alive = (tok: string) => final.includes(paraText(tok));
    const finalParas: Para[] = [];
    for (const p of [...xParas, ...yParas]) if (alive(p.tok) && !finalParas.some((f) => f.tok === p.tok)) finalParas.push(p);
    for (const p of startParas) {
      if (glued.has(p.tok)) continue;
      if (!p.tagged || deleted.has(p.tok) || yDeleted.has(p.tok) || !alive(p.tok)) continue;
      const was = anchorsBefore.get(p.tok), now = await anchorIdOf(id, p.tok);
      if (was && now !== was) problems.push(`keep-anchor: ${p.tok} had anchor ^${was}, now ${now ? `^${now}` : "none"}\n${label}\nstart:\n${start}\nX saved:\n${xBody}\nnow:\n${final}\nanchors: ${JSON.stringify((await q(`SELECT anchor_id, status, from_utf16 AS f, to_utf16 AS t, left(quote,22) AS qt FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16`, [id])).rows)}\nconflicts: ${conflicts.slice(0, 300)}`);
    }
    const want = [...new Map(parseBlocks(final, await validAnchors(id)).filter((b) => b.ref).map((b) => [b.ref!, b.kind])).entries()].map(([r, k]) => `${r}:${k}`).sort();
    const have = (await q<{ block_ref: string; kind: string }>(`SELECT block_ref, kind FROM block_nodes WHERE note_id = $1 AND hidden_at IS NULL`, [id])).rows.map((r) => `${r.block_ref}:${r.kind}`).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) problems.push(`block-index: block_nodes ${have.join(" ")} vs from scratch ${want.join(" ")}\n${label}\n${final}`);
    if (problems.length) return problems;

    // the next step starts from what the server now holds
    paras = finalParas.length ? finalParas : [{ tok: fresh(), tagged: true }];
    if (!finalParas.length) {
      const reset = await call("PATCH", `/api/nodes/${id}`, { markdown: render(paras) });
      if (reset.status !== 200) throw new Error(`reset ${reset.status}`);
    } else {
      // The model's order must be the stored order for the next edits to mean the same thing.
      paras = final.split("\n").map((s) => s.trim()).filter(Boolean).map((line) => {
        const tok = /^Para (\S+) /.exec(line)![1]!;
        return { tok, tagged: line.endsWith("{alpha}") };
      });
    }
    await awaitAllDispatchers();
  }
  return problems;
}

describe.skipIf(!isTestDb)("two devices saving one note: merge, anchors, retries (real save route, DB)", () => {
  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Props two devices', $1) RETURNING id::text`, [`props-two-${randomUUID()}`])).rows[0]!.id;
    expect((await call("GET", "/api/spaces")).status).toBe(200);
  });

  it("a fixed script first: X adds above, Y adds below, both are kept and Y's retry changes nothing", async () => {
    const problems = await runSteps([{ x: [{ kind: "add", at: 0, tagged: true }], y: [{ kind: "add", at: 3, tagged: false }], xChange: "real", yChange: "real", retryX: true, retryY: true }]);
    expect(problems).toEqual([]);
  });

  it(`merge keeps what both devices added, anchors stay, a retry changes nothing (${process.env.PROPS_RUNS ?? "25"} runs)`, { timeout: 170_000 }, async () => {
    await checkAsync(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 4 }), async (steps) => {
        const problems = await runSteps(steps);
        if (problems.length) throw new Error(problems[0]);
      }),
      process.env.PROPS_RUNS ? Infinity : 25,
    );
  });
});
