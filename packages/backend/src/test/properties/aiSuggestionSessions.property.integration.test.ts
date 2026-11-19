// What a person is shown of an AI's work while it goes on: one or two agent sessions send suggestEdit (different
// paragraphs, the same paragraph revised), commentOnNote and updateNode (an agent set to suggest files it as a
// suggestion) on ONE note, and the person accepts, rejects or edits the note in between.
//
// Everything goes through what the app uses: the agent tools (services/agentTools) as the session's token actor,
// services/aiSuggestions.acceptSuggestionItems / rejectSuggestionItems for the person, services/nodeUpdate.updateNode
// for the person's own edit, and suggestionsForNode (what the editor draws) to read what the person is shown.
//
// Invariants, checked after every step against a model written here (not the service's logic):
//   1. a pending place is shown until the person acted on it or the SAME session revised the SAME paragraph;
//      nothing else is shown (a replaced place is gone; a stale one stays until the person dismisses it);
//   2. a comment is never replaced (it is a place of the session like another, but it replaces nothing and is replaced by nothing);
//   3. the note's text is always the base with the accepted places made, in the order they were accepted, and a place
//      whose paragraph changed since (accepted from the other session, or edited by the person) is stale, nothing
//      written: so accepting any subset in any order gives what applying those edits to the base gives;
//   4. the number of places the tool told the agent (`places`) is the number of new places shown, and what
//      listSuggestions tells the agent is pending equals what the person is shown as pending.
//
// The defect the FINDING cases at the end pin (createSuggestions marked EVERY pending place of the session on the note as
// replaced, not only those of the revised paragraph, comments included) is fixed: the random property takes every create
// and the cases stay as plain `it`.
//
// Not covered: inserts and deletes of whole paragraphs, title places, a stale read by the agent (base older than the
// note), a resident token without a session, a person without write rights, the offline and sync layers.
//
// Run count: PROPS_RUNS (default 12: a run is dozens of writes), seed PROPS_SEED.
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { splitParagraphs } from "@onden/markdown";
import { pool, q } from "../../db.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { acceptSuggestionItems, rejectSuggestionItems, suggestionsForNode } from "../../services/aiSuggestions.js";
import { updateNode } from "../../services/nodeUpdate.js";
import { markDelivered, startSession } from "../../services/agentSessions.js";
import { suggestEdit } from "../../services/agentTools/suggestEdit.js";
import { commentOnNote } from "../../services/agentTools/commentOnNote.js";
import { updateNode as updateNodeTool } from "../../services/agentTools/updateNode.js";
import { listSuggestions } from "../../services/agentTools/listSuggestions.js";
import type { ActorCtx } from "../../types.js";
import { agentWorld, sessionActor } from "../helpers/agentSessionFixture.js";
import { checkAsync } from "../helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
afterAll(async () => { await pool.end(); });
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 12;

// ── The note: paragraphs of four shapes, each with a unique text per version ─

type Shape = "text" | "cjk" | "list" | "fence";
const shapes: readonly Shape[] = ["text", "cjk", "list", "fence"];
// A version's text is a token of CJK characters never used by another version: two writers who rewrite the same
// paragraph then replace the same characters, which the body merge reports as a conflict. (Two writers who only ADD
// characters at one point, "…1" to "…10" and "…11", are merged into "…101" by design: see the CURRENT BEHAVIOUR case.)
const token = (v: number) => [0, 1, 2].map((i) => String.fromCodePoint(0x4e00 + v * 3 + i)).join("");
const paragraphOf = (shape: Shape, k: number, v: number): string =>
  shape === "text" ? `Alpha ${k} ${token(v)}`
    : shape === "cjk" ? `第${k}段　內容${token(v)}「全形」，還有 ＡＩ 工具`
    : shape === "list" ? `- 項目 ${k} ${token(v)} 清單`
    : `\`\`\`ts\nconst k${k} = "${token(v)}"\n\n// 結束\n\`\`\``;
const noteText = (paragraphs: readonly string[]) => paragraphs.join("\n\n") + "\n";

type Session = { id: string; actor: ActorCtx };
async function suggestWorld(label: string) {
  const w = await agentWorld(label);
  await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
  const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
  const open = async (name: string): Promise<Session> => {
    const text = `@${w.handle} ${name}`;
    const trigger = await w.note(text);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId: trigger, target: { blockText: text } });
    const delivered = (await markDelivered(session.id, agent.tokenScope!.tokenId))!;
    return { id: session.id, actor: await sessionActor(delivered, agent) };
  };
  return { ...w, agent, sessions: [await open("one"), await open("two")] as const };
}
type World = Awaited<ReturnType<typeof suggestWorld>>;

// ── What the person is shown ─────────────────────────────────────────────────

type Shown = { id: string; suggestionId: string; sessionId: string | null; kind: string; status: string; base: string; text: string };
async function shown(w: World, nodeId: string): Promise<Shown[]> {
  const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
  return listed.suggestions.flatMap((s) => s.items.map((i) => ({
    id: i.id, suggestionId: s.id, sessionId: s.session_id, kind: i.kind, status: i.status, base: i.base_text, text: (i.new_text ?? "").trim(),
  })));
}
const key = (kind: string, base: string, text: string) => `${kind}|${base}|${text.trim()}`;

// ── The model ────────────────────────────────────────────────────────────────

type Entry = { id: string; kind: "replace" | "comment"; session: number; para: number | null; base: string; text: string; state: "pending" | "stale"; call: number };
type Call = { tool: "suggestEdit" | "updateNode"; session: number; args: { id: string; markdown: string; base_markdown: string }; entries: Entry[] };

type Op =
  | { t: "edit"; session: number; paras: number[]; tool: "suggestEdit" | "updateNode" }
  | { t: "comment"; session: number; quote: boolean; para: number }
  | { t: "retry" }
  | { t: "accept"; pick: number; all: boolean; mask: boolean[] }
  | { t: "reject"; pick: number; all: boolean; mask: boolean[] }
  | { t: "person"; para: number };

const ops: fc.Arbitrary<Op[]> = fc.array(fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("edit" as const), session: fc.nat(1), paras: fc.array(fc.nat(9), { minLength: 1, maxLength: 2 }), tool: fc.constantFrom("suggestEdit" as const, "updateNode" as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("comment" as const), session: fc.nat(1), quote: fc.boolean(), para: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.constant({ t: "retry" as const }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("accept" as const), pick: fc.nat(20), all: fc.boolean(), mask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("reject" as const), pick: fc.nat(20), all: fc.boolean(), mask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("person" as const), para: fc.nat(9) }) },
), { minLength: 2, maxLength: 9 });

const scenario = fc.record({
  shapes: fc.array(fc.constantFrom(...shapes), { minLength: 3, maxLength: 6 }),
  ops,
  /** The order the last phase accepts what is left, one place at a time. */
  order: fc.array(fc.nat(1000), { minLength: 40, maxLength: 40 }),
  /** Whether the person edits the note at all: false isolates "accepting any subset in any order". */
  personEdits: fc.boolean(),
});
type Scenario = { shapes: Shape[]; ops: Op[]; order: number[]; personEdits: boolean };

type RunStats = { creates: number };

/** One scenario on a fresh note; throws on the first invariant that fails. */
async function run(w: World, sc: Scenario, stats: RunStats = { creates: 0 }): Promise<void> {
  const kinds: Shape[] = [...sc.shapes];
  let version = 0;
  const paragraphs = kinds.map((s, k) => paragraphOf(s, k, version++));
  const nodeId = await w.note(noteText(paragraphs));
  expect(splitParagraphs(noteText(paragraphs)).length, "generator: one paragraph per block").toBe(paragraphs.length);
  const model = new Map<string, Entry>(); // real item id → what the person should be shown
  const calls: Call[] = [];
  const owner = w.owner;
  const log: string[] = [];
  const at = (i: number) => i % paragraphs.length;

  const assertNote = async (step: string) => {
    expect(await w.body(nodeId), `${step}: the note's text`).toBe(noteText(paragraphs));
  };
  // Invariants 1 and 2 (and the comment part of 3): the person is shown exactly the model's places.
  const assertShown = async (step: string) => {
    const now = await shown(w, nodeId);
    const byId = new Map(now.map((s) => [s.id, s]));
    const describe = (e: Entry) => `${e.kind} of session ${e.session} on ${JSON.stringify(e.base || e.text)}`;
    expect([...model.values()].filter((e) => !byId.has(e.id)).map(describe), `${step}: places that disappeared (log: ${log.join(" | ")})`).toEqual([]);
    expect(now.filter((s) => !model.has(s.id)).map((s) => `${s.kind} ${JSON.stringify(s.base || s.text)}`), `${step}: places shown that should be gone`).toEqual([]);
    for (const e of model.values()) {
      const s = byId.get(e.id)!;
      expect(s.status, `${step}: status of ${describe(e)}`).toBe(e.state);
      expect(key(s.kind, s.base, s.text), `${step}: what ${describe(e)} says`).toBe(key(e.kind, e.base, e.text));
    }
    // Invariant 4b: what the agent is told is pending is what the person is shown as pending.
    const told = await listSuggestions.handler({ id: nodeId, mine: true, fromPlace: 1, limit: 50, offset: 0 }, { actor: w.sessions[0].actor, workspaceId: w.ws });
    const toldPending = told!.suggestions.flatMap((s) => s.places).filter((p) => p.status === "pending").length;
    expect(toldPending, `${step}: places listSuggestions says are pending`).toBe(now.filter((s) => s.status === "pending").length);
    expect(told!.suggestions.flatMap((s) => s.places).filter((p) => p.status === "replaced" && p.kind === "comment"), `${step}: a comment was replaced`).toEqual([]);
  };

  const create = async (op: Extract<Op, { t: "edit" | "comment" }>) => {
    const session = w.sessions[op.session]!;
    const placed = op.t === "edit" ? [...new Set(op.paras.map(at))] : [];
    // The same paragraph revised after the person rewrote it: whether that is "the same place" is not settled; not generated.
    if ([...model.values()].some((e) => e.session === op.session && e.state === "pending" && e.kind === "replace" && placed.includes(e.para!) && e.base !== paragraphs[e.para!])) return;
    stats.creates++;
    const before = new Set((await shown(w, nodeId)).map((s) => s.id));
    const exp: Entry[] = [];
    const call = calls.length;
    let told: unknown;
    const ctx = { actor: session.actor, workspaceId: w.ws };
    if (op.t === "edit") {
      const next = [...paragraphs];
      for (const i of placed) next[i] = paragraphOf(kinds[i]!, i, version++);
      for (const i of placed) exp.push({ id: "", kind: "replace", session: op.session, para: i, base: paragraphs[i]!, text: next[i]!, state: "pending", call });
      const args = { id: nodeId, markdown: noteText(next), base_markdown: noteText(paragraphs) };
      told = await (op.tool === "suggestEdit" ? suggestEdit : updateNodeTool).handler(args, ctx);
      calls.push({ tool: op.tool, session: op.session, args, entries: exp });
      log.push(`${op.tool}[s${op.session}] ${placed.join(",")}`);
    } else {
      const quote = op.quote ? paragraphs[at(op.para)]! : undefined;
      const text = `留言 ${token(version++)}：這裡對嗎？ ✓`;
      exp.push({ id: "", kind: "comment", session: op.session, para: null, base: quote ?? "", text, state: "pending", call });
      told = await commentOnNote.handler({ id: nodeId, text, ...(quote !== undefined ? { quote } : {}) }, ctx);
      calls.push({ tool: "suggestEdit", session: op.session, args: null as never, entries: exp });
      log.push(`comment[s${op.session}]${quote ? " quoted" : ""}`);
    }
    // The revised places go; everything else of the session stays.
    for (const [id, e] of model) if (e.session === op.session && e.state === "pending" && e.kind === "replace" && placed.includes(e.para!)) model.delete(id);
    const fresh = (await shown(w, nodeId)).filter((s) => !before.has(s.id));
    for (const e of exp) {
      const hit = fresh.find((s) => !model.has(s.id) && key(s.kind, s.base, s.text) === key(e.kind, e.base, e.text));
      expect(hit, `new ${e.kind} place is shown (log: ${log.join(" | ")})`).toBeDefined();
      e.id = hit!.id;
      model.set(e.id, e);
    }
    expect(fresh.length, "places shown from the new call").toBe(exp.length);
    // Invariant 4a: what the tool told the agent.
    if (op.t === "edit") expect(told, "the tool's answer").toMatchObject({ status: "suggested", places: exp.length });
    await assertShown(`after ${log.at(-1)}`);
  };

  const groups = async () => {
    const now = await shown(w, nodeId);
    const by = new Map<string, Shown[]>();
    for (const s of now) (by.get(s.suggestionId) ?? by.set(s.suggestionId, []).get(s.suggestionId)!).push(s);
    return [...by.values()];
  };

  const accept = async (items: Shown[], all: boolean) => {
    const suggestionId = items[0]!.suggestionId;
    const named = all ? (await shown(w, nodeId)).filter((s) => s.suggestionId === suggestionId) : items;
    const r = await acceptSuggestionItems(w.ws, { actor: owner, suggestionId, itemIds: all ? "all" : items.map((i) => i.id) });
    const accepted: string[] = [], stale: string[] = [], decided: string[] = [];
    for (const s of named) {
      const e = model.get(s.id)!;
      if (e.state === "stale") { decided.push(s.id); continue; }
      if (e.kind === "comment") { accepted.push(s.id); continue; }
      if (paragraphs[e.para!] === e.base) accepted.push(s.id); else stale.push(s.id);
    }
    // The accepted ones are made on the paragraphs (all of a batch are judged against the note before it).
    for (const id of accepted) { const e = model.get(id)!; if (e.kind === "replace") paragraphs[e.para!] = e.text; model.delete(id); }
    for (const id of stale) model.get(id)!.state = "stale";
    expect([...r.accepted].sort(), "accepted").toEqual([...accepted].sort());
    expect([...r.stale].sort(), "stale").toEqual([...stale].sort());
    // "all" also names the items decided earlier (accepted, rejected, replaced), which are no longer shown: only the stale ones are checked.
    if (all) expect(r.alreadyDecided, "already decided").toEqual(expect.arrayContaining(decided));
    else expect([...r.alreadyDecided].sort(), "already decided").toEqual([...decided].sort());
    expect(r.void).toEqual([]);
    log.push(`accept ${accepted.length}/${stale.length} stale`);
  };

  const reject = async (items: Shown[], all: boolean) => {
    const suggestionId = items[0]!.suggestionId;
    const named = all ? (await shown(w, nodeId)).filter((s) => s.suggestionId === suggestionId) : items;
    const r = await rejectSuggestionItems(w.ws, { actor: owner, suggestionId, itemIds: all ? "all" : items.map((i) => i.id) });
    expect([...r.rejected].sort(), "rejected").toEqual(named.map((s) => s.id).sort());
    for (const s of named) model.delete(s.id);
    log.push(`reject ${named.length}`);
  };

  for (const [n, op] of sc.ops.entries()) {
    if (op.t === "edit" || op.t === "comment") await create(op);
    else if (op.t === "retry") {
      const last = calls.filter((c) => c.args && c.entries.every((e) => model.get(e.id)?.state === "pending")).at(-1);
      if (!last) continue;
      const stillSame = last.args.base_markdown === noteText(paragraphs);
      if (!stillSame) continue; // a retry is the same call with the same note
      const told = await (last.tool === "suggestEdit" ? suggestEdit : updateNodeTool).handler(last.args, { actor: w.sessions[last.session]!.actor, workspaceId: w.ws });
      expect(told, "a retried call").toMatchObject({ status: "suggested", places: last.entries.length });
      log.push("retry");
      await assertShown("after a retried call (nothing new)");
    } else if (op.t === "person") {
      if (!sc.personEdits) continue;
      const i = at(op.para);
      paragraphs[i] = `我自己改的 ${i}：${token(version++)}`;
      kinds[i] = "text";
      await updateNode(w.ws, nodeId, { markdown: noteText(paragraphs) }, { actor: owner });
      log.push(`person edits ${i}`);
    } else {
      const gs = await groups();
      if (gs.length === 0) continue;
      const g = gs[op.pick % gs.length]!;
      const chosen = op.all ? g : g.filter((_, j) => op.mask[j % op.mask.length]);
      const items = chosen.length > 0 ? chosen : [g[0]!];
      if (op.t === "accept") await accept(items, op.all); else await reject(items, op.all);
    }
    await assertNote(`step ${n} (${log.at(-1)})`);
    await assertShown(`step ${n} (${log.at(-1)})`);
  }

  // Last phase: whatever is left is accepted one place at a time, in any order.
  const left = (await shown(w, nodeId)).filter((s) => s.status === "pending");
  const order = left.map((_, i) => i).sort((a, b) => sc.order[a % sc.order.length]! - sc.order[b % sc.order.length]! || a - b);
  for (const i of order) {
    await accept([left[i]!], false);
    await assertNote(`final accept of place ${i}`);
    await assertShown(`final accept of place ${i}`);
  }
  expect((await shown(w, nodeId)).filter((s) => s.status === "pending"), "nothing is left pending").toEqual([]);
}

describe.skipIf(!isTestDb)("an AI's sessions on one note, with the person deciding in between", () => {
  it("the person is shown every pending place, comments included, and accepting gives the base with those edits made", async () => {
    const w = await suggestWorld("sess-prop");
    const stats: RunStats = { creates: 0 };
    await checkAsync(fc.asyncProperty(scenario, async (sc) => { await run(w, sc, stats); }), RUN_CAP);
    if (process.env.AI_SESS_STATS) console.log(`[aiSuggestionSessions] creates run=${stats.creates}`);
  }, 1_800_000);
});

// ── Regressions: the pinned defect, reduced ──────────────────────────────────
// Each is a minimal NAMED case. They stay as plain `it` now that the fix is in.

const doc = (...paragraphs: string[]) => paragraphs.join("\n\n") + "\n";

describe.skipIf(!isTestDb)("regressions and pinned behaviour (createSuggestions marks the whole session's pending places replaced)", () => {
  // services/aiSuggestions.ts, createSuggestions: `UPDATE ai_edit_suggestion_items SET status = 'replaced' WHERE status = 'pending'
  // AND suggestion_id IN (… node_id = $1 AND session_id = $2 AND agent_actor_id = $3)` has no condition on the place.

  it("FINDING different-paragraphs: a second suggestEdit of the same session on ANOTHER paragraph removes the first one from view", async () => {
    // Scenario: session one suggests a change to paragraph 0, then (base = the note, unchanged) a change to paragraph 1.
    // Expected: the person is shown both places (paragraph 1 is not a revision of paragraph 0).
    // Actual: the first place becomes `replaced` and is no longer listed; only paragraph 1 is shown.
    // Found with PROPS_SEED=3 PROPS_RUNS=60 shrinks to this (suggestEdit para 0, suggestEdit para 1, same session).
    // File: services/aiSuggestions.ts:163-168 (the UPDATE … SET status = 'replaced', in createSuggestions).
    const w = await suggestWorld("sess-diff");
    const base = doc("alpha", "beta", "gamma");
    const nodeId = await w.note(base);
    const ctx = { actor: w.sessions[0].actor, workspaceId: w.ws };
    await suggestEdit.handler({ id: nodeId, markdown: doc("ALPHA", "beta", "gamma"), base_markdown: base }, ctx);
    await suggestEdit.handler({ id: nodeId, markdown: doc("alpha", "BETA", "gamma"), base_markdown: base }, ctx);
    expect((await shown(w, nodeId)).map((s) => s.text).sort()).toEqual(["ALPHA", "BETA"]);
  });

  it("FINDING comment-replaced: an agent's later suggestEdit replaces its own comment on the note", async () => {
    // Scenario: session one comments on a paragraph, then suggests an edit of another paragraph.
    // Expected: the comment is still shown (a comment is never replaced, and the edit is not a revision of it).
    // Actual: the comment becomes `replaced` and disappears from the person's view.
    // Found with PROPS_SEED=1 PROPS_RUNS=60 shrinks to this. File: services/aiSuggestions.ts:163-168.
    const w = await suggestWorld("sess-comment");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const ctx = { actor: w.sessions[0].actor, workspaceId: w.ws };
    await commentOnNote.handler({ id: nodeId, text: "is alpha right?", quote: "alpha" }, ctx);
    await suggestEdit.handler({ id: nodeId, markdown: doc("alpha", "BETA"), base_markdown: base }, ctx);
    expect((await shown(w, nodeId)).map((s) => s.kind).sort()).toEqual(["comment", "replace"]);
  });

  it("FINDING comment-replaces-edit: a later commentOnNote removes the session's pending edit from view", async () => {
    // Scenario: session one suggests an edit, then leaves a comment (which changes no text).
    // Expected: the edit place is still shown next to the comment.
    // Actual: the comment filing marks the edit `replaced`; only the comment is shown.
    // Found with PROPS_SEED=2 PROPS_RUNS=60 shrinks to this. File: services/aiSuggestions.ts:163-168.
    const w = await suggestWorld("sess-comment2");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const ctx = { actor: w.sessions[0].actor, workspaceId: w.ws };
    await suggestEdit.handler({ id: nodeId, markdown: doc("ALPHA", "beta"), base_markdown: base }, ctx);
    await commentOnNote.handler({ id: nodeId, text: "see above" }, ctx);
    expect((await shown(w, nodeId)).map((s) => s.kind).sort()).toEqual(["comment", "replace"]);
  });

  // Behaviour that must stay (green): the designed replacement and the other session's untouched places.
  it("the same session revising the SAME paragraph replaces it; the other session's place on it stays", async () => {
    const w = await suggestWorld("sess-same");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const [one, two] = [{ actor: w.sessions[0].actor, workspaceId: w.ws }, { actor: w.sessions[1].actor, workspaceId: w.ws }];
    await suggestEdit.handler({ id: nodeId, markdown: doc("ALPHA", "beta"), base_markdown: base }, one);
    await suggestEdit.handler({ id: nodeId, markdown: doc("Alpha!", "beta"), base_markdown: base }, two);
    await suggestEdit.handler({ id: nodeId, markdown: doc("alpha 2", "beta"), base_markdown: base }, one);
    expect((await shown(w, nodeId)).map((s) => s.text).sort()).toEqual(["Alpha!", "alpha 2"]);
  });
  // CURRENT BEHAVIOUR (the owner has not decided; it turns red when the merge changes). services/eventLog/bodyMerge.ts
  // (mergeChars, "typing inside one line is merged character by character") through acceptSuggestionItems' updateNode
  // with onConflict "refuse" (services/nodeUpdate.ts:329).
  // Scenario: the note holds "…version 1"; the agent suggests "…version 10"; the person types "…version 11" on the line;
  // the person accepts the agent's place.
  // Seen: the place is accepted (not stale) and the line reads "…version 101": a text neither side wrote, nothing refused.
  // Found by: PROPS_SEED=3 PROPS_RUNS=500 with the version numbers as plain digits (two sessions, accepting both in turn).
  it("CURRENT BEHAVIOUR same-line appends: the agent's \"10\" and the person's \"11\" after one \"1\" merge into \"101\"", async () => {
    const w = await suggestWorld("sess-append");
    const base = doc("Alpha 0", "Alpha 1 version 1");
    const nodeId = await w.note(base);
    await suggestEdit.handler({ id: nodeId, markdown: doc("Alpha 0", "Alpha 1 version 10"), base_markdown: base }, { actor: w.sessions[0].actor, workspaceId: w.ws });
    await updateNode(w.ws, nodeId, { markdown: doc("Alpha 0", "Alpha 1 version 11") }, { actor: w.owner });
    const item = (await shown(w, nodeId))[0]!;
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: item.suggestionId, itemIds: [item.id] });
    expect(r).toMatchObject({ accepted: [item.id], stale: [] });
    expect(await w.body(nodeId)).toBe(doc("Alpha 0", "Alpha 1 version 101"));
  });
});
