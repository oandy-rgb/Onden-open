// Every agent tool against an object the token must not touch (review 2026-11-11, AI collaboration).
//
// The registry is walked (listTools()), not a hand-kept list: a tool added later
// has no case below, so the "every tool has a case" test fails until its author
// says how to aim it at a note in another space. Each case is then called with
// a token that
//   • is in no way a member of space B (the note is invisible to it),
//   • may only view space C (it can read the note but not change it),
// and the assertions are on the database, not on what the tool says:
//   1. nothing the tool returns or throws carries text only space B / C holds
//      (B), and nothing from B at all;
//   2. the notes, tags, attributes, suggestions and events of B and C are as
//      they were; no note was created anywhere.
// A second pass runs the tools an api session is offered as the suggest-only
// actor, aimed at the token's OWN space: only suggestions may appear.
//
// SAFETY: skips unless DATABASE_URL points at a *_test database. No model is called.
import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { callTool, listTools, type AgentTool } from "../services/agentTools/index.js";
import { toolsForRuntime } from "../services/agentRuntime/api/tools.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import type { ActorCtx } from "../types.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedView } from "./helpers/seedView.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
afterAll(async () => { await pool.end(); });

type Target = { noteId: string; marker: string; viewId?: string };
type Aim = { tagId: string; sessionId: string };
/** How to aim one tool at a note: the arguments it takes. `null`: the tool has no note to aim at (said why). */
type Case = ((t: Target, aim: Aim) => Record<string, unknown>) | { none: string };

// A new tool must be added here. `none` needs a reason a reviewer can check.
const CASES: Record<string, Case> = {
  searchNodes: (t) => ({ query: t.marker }),
  getNode: (t) => ({ id: t.noteId }),
  getAttachment: (t) => ({ nodeId: t.noteId, ref: "/api/media/00000000-0000-0000-0000-000000000000.png" }),
  createNode: (t) => ({ title: `sweep-created-${t.marker}`, parent_id: t.noteId }),
  updateNode: (t) => ({ id: t.noteId, markdown: `OVERWRITE ${t.marker}`, base_markdown: `body ${t.marker}\n` }),
  suggestEdit: (t) => ({ id: t.noteId, markdown: `OVERWRITE ${t.marker}`, base_markdown: `body ${t.marker}\n` }),
  commentOnNote: (t) => ({ id: t.noteId, text: "comment from outside" }),
  applyTag: (t, a) => ({ nodeId: t.noteId, tagId: a.tagId }),
  removeTag: (t, a) => ({ nodeId: t.noteId, tagId: a.tagId }),
  queryView: (t) => ({ viewId: t.viewId }),
  loadSkill: () => ({ skillId: "no-such-skill" }),
  listMySessions: (t) => ({ nodeId: t.noteId }),
  getSessionLog: (_t, a) => ({ sessionId: a.sessionId }),
  proposeTagPack: { none: "files a pack for the owner's approval; it names no note (checked: outbox row is held, nothing installs)" },
  semanticSearch: (t) => ({ query: t.marker, limit: 5 }),
  suggestLinks: (t) => ({ nodeId: t.noteId, limit: 5 }),
  reviewQueue: () => ({ due_only: false }),
  getSlides: (t) => ({ id: t.noteId }),
  setSlideLayout: (t) => ({ id: t.noteId, theme: "dark" }),
  listChildren: (t) => ({ id: t.noteId }),
  listSuggestions: (t) => ({ id: t.noteId }),
  listSpaces: () => ({}),
};

const rejection = (p: Promise<unknown>) => p.then((v) => ({ ok: true as const, value: v }), (e: unknown) => ({ ok: false as const, error: e }));

async function snapshot(noteIds: string[], tagId: string) {
  const notes = (await q(
    `SELECT id::text, title, markdown, space_id::text, parent_id::text, deleted_at FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [noteIds])).rows;
  const tags = (await q(`SELECT node_id::text, tag_id::text FROM node_tags WHERE node_id = ANY($1::uuid[]) ORDER BY node_id, tag_id`, [noteIds])).rows;
  const attrs = (await q(`SELECT node_id::text, key, value FROM node_attributes WHERE node_id = ANY($1::uuid[]) ORDER BY node_id, key`, [noteIds])).rows;
  const suggestions = (await q(`SELECT node_id::text FROM ai_edit_suggestions WHERE node_id = ANY($1::uuid[])`, [noteIds])).rows;
  const events = (await q<{ event_type: string; target_id: string | null }>(
    `SELECT event_type, target_id::text FROM domain_events WHERE target_id = ANY($1::text[]) AND event_type NOT LIKE 'AGENT_TOOL_%' ORDER BY id`, [[...noteIds, tagId]])).rows;
  const nodeCount = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes`)).rows[0]!.n;
  return { notes, tags, attrs, suggestions, events, nodeCount };
}

async function world(label: string) {
  const w = await agentWorld(label);
  const spaceB = await makeSpace(w.ws, `B ${w.stamp}`, [{ id: w.owner.id, permission: "edit" }]);
  const spaceC = await makeSpace(w.ws, `C ${w.stamp}`, [{ id: w.owner.id, permission: "edit" }, { id: w.agent.id, permission: "view" }]);
  const mk = async (space: string, marker: string): Promise<Target> => ({ noteId: await w.note(`body ${marker}\n`, space), marker });
  const b = await mk(spaceB, `BSECRET${w.stamp}`);
  const c = await mk(spaceC, `CVISIBLE${w.stamp}`);
  const own = await mk(w.space, `OWNNOTE${w.stamp}`);
  const { tagId } = await seedClassTag(w.ws, { name: `sweep tag ${w.stamp}`, slug: `sweep-${w.stamp}` });
  for (const t of [b, c, own]) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [t.noteId, tagId]);
  const viewId = await seedView(tagId, { name: "all", visible_fields: [] });
  for (const t of [b, c, own]) t.viewId = viewId;
  // An earlier session of this agent on B's note, so getSessionLog has a real id to aim at.
  const sessionId = (await q<{ id: string }>(
    `INSERT INTO agent_sessions (workspace_id, agent_actor_id, initiator_id, node_id, space_id, anchor_block_id, prompt, deadline_at, status)
     VALUES ($1,$2,$3,$4,$5,'blk','SESSIONPROMPT${w.stamp}', now() + interval '1 hour', 'completed') RETURNING id::text`,
    [w.ws, w.agent.id, w.owner.id, b.noteId, spaceB])).rows[0]!.id;
  const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
  return { ...w, agent, spaceB, spaceC, b, c, own, aim: { tagId, sessionId } satisfies Aim };
}

const text = (r: { ok: true; value: unknown } | { ok: false; error: unknown }) =>
  JSON.stringify(r.ok ? r.value : { message: (r.error as Error).message });

describe.skipIf(!isTestDb)("agent tools × a token's reach", () => {
  it("every registered tool has a case here (a new tool is scanned or the test fails)", () => {
    const names = listTools().map((tool) => tool.name).sort();
    expect(names.filter((n) => !(n in CASES)), "tools without a scope case").toEqual([]);
    expect(Object.keys(CASES).filter((n) => !names.includes(n)), "cases for tools that no longer exist").toEqual([]);
  });

  for (const mode of ["apply", "suggest"] as const) {
    it(`write mode ${mode}: no tool reads, changes or learns anything about a note in a space the token is not in, or only views`, async () => {
      const w = await world(`sweep-${mode}`);
      if (mode === "suggest") await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
      const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
      const ctx = { actor: agent as ActorCtx, workspaceId: w.ws };
      const watched = [w.b.noteId, w.c.noteId];
      const before = await snapshot(watched, w.aim.tagId);

      const leaks: string[] = [];
      for (const tool of listTools() as AgentTool[]) {
        const c = CASES[tool.name];
        if (!c || "none" in c) continue;
        for (const [label, target] of [["B", w.b], ["C", w.c]] as const) {
          const result = await rejection(callTool(tool.name, c(target, w.aim), ctx));
          const out = text(result);
          // B is invisible: none of its text or its space may come back. (A session record keeps the
          // id of the note it ran on by design, so the id alone is not a leak; the prompt text is: see below.)
          if (out.includes(w.b.marker) || out.includes(w.spaceB)) leaks.push(`${tool.name} → ${label}: B's text came back: ${out.slice(0, 200)}`);
          // C may be read, but a write must not have happened (asserted on the rows below).
        }
      }
      expect(leaks).toEqual([]);

      const after = await snapshot(watched, w.aim.tagId);
      // the only thing a suggest-mode or apply-mode agent may add on a view-only note is nothing
      expect(after.notes).toEqual(before.notes);
      expect(after.tags).toEqual(before.tags);
      expect(after.attrs).toEqual(before.attrs);
      expect(after.suggestions).toEqual(before.suggestions);
      expect(after.events).toEqual(before.events);
      expect(after.nodeCount).toBe(before.nodeCount);
    });
  }

  // AI-1 (review 2026-11-11): listMySessions / getSessionLog say "never note text", but `prompt` is the words
  // of the @mention block, copied out of a note. When the agent has since lost the space (or the note moved
  // away), the title is hidden and the words are still returned.
  // Fix direction: in agentSessionMemory.ownSessions / ownSession, return the prompt only where the note is readable
  // (the LEFT JOIN already knows: n.title IS NULL means unreadable), and the same for renderPreviousRuns.
  it("a session on a note the agent can no longer read does not hand back the words copied from that note", async () => {
    const w = await world("sweep-prompt");
    const ctx = { actor: w.agent as ActorCtx, workspaceId: w.ws };
    const listed = (await callTool("listMySessions", { nodeId: w.b.noteId }, ctx)) as Array<{ prompt: string }>;
    const log = (await callTool("getSessionLog", { sessionId: w.aim.sessionId }, ctx)) as { prompt: string };
    expect(JSON.stringify([listed, log])).not.toContain(`SESSIONPROMPT${w.stamp}`);
  });

  it("an api session's tools, aimed at the token's own space, add suggestions and nothing else", async () => {
    const w = await world("sweep-api");
    await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
    const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
    const ctx = { actor: agent as ActorCtx, workspaceId: w.ws };
    const outboxBefore = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1`, [w.ws])).rows[0]!.n;
    const eventsBefore = (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1`, [w.ws])).rows[0]!.id ?? "0";
    const before = await snapshot([w.own.noteId], w.aim.tagId);

    for (const tool of toolsForRuntime()) {
      const c = CASES[tool.name];
      if (!c) throw new Error(`no scope case for ${tool.name}`);
      if ("none" in c) continue;
      await rejection(callTool(tool.name, c(w.own, w.aim), ctx));
    }
    const after = await snapshot([w.own.noteId], w.aim.tagId);
    expect(after.notes).toEqual(before.notes);
    expect(after.tags).toEqual(before.tags);
    expect(after.attrs).toEqual(before.attrs);
    expect(after.nodeCount).toBe(before.nodeCount);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1`, [w.ws])).rows[0]!.n).toBe(outboxBefore);
    const written = (await q<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM domain_events WHERE workspace_id = $1 AND id > $2::bigint AND actor_id = $3`,
      [w.ws, eventsBefore, w.agent.id])).rows.map((r) => r.event_type).sort();
    expect(written.filter((t) => !t.startsWith("AGENT_TOOL_") && t !== "AI_SUGGESTION_CREATED")).toEqual([]);
    expect(written).toContain("AI_SUGGESTION_CREATED");
  });
});
