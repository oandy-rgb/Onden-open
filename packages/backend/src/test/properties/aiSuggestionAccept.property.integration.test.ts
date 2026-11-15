// An AI's suggestion accepted place by place, in any order, ends where accepting it at once does: the AI's text,
// verbatim (services/aiSuggestions.acceptSuggestionItems). The texts are the generators of
// helpers/markdownDocPairs (lists tight and loose, nested lists, tables, code, quotes, `^id`, moved paragraphs).
// A place is accepted alone each time, so each acceptance is a merge into a note that already holds the others.
//
// Run count: PROPS_RUNS (default 12: a run is a few dozen writes), seed PROPS_SEED.
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { pool, q } from "../../db.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { acceptSuggestionItems, createSuggestions, suggestionsForNode } from "../../services/aiSuggestions.js";
import { agentWorld } from "../helpers/agentSessionFixture.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { pair } from "../helpers/markdownDocPairs.js";
import { splitParagraphs } from "@onden/markdown";
import { updateNode } from "../../services/nodeUpdate.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
afterAll(async () => { await pool.end(); });
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 12;

describe.skipIf(!isTestDb)("accepting a suggestion one place at a time", () => {
  it("in any order gives the AI's text, with no place found stale", async () => {
    const w = await agentWorld("accept-prop");
    await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
    const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
    await checkAsync(fc.asyncProperty(pair, fc.array(fc.nat(1000), { minLength: 200, maxLength: 200 }), async ({ base, proposed }, keys) => {
      const nodeId = await w.note(base);
      const saved = await createSuggestions(w.ws, { actor: agent, proposer: { agentActorId: agent.id, sessionId: null }, nodeId, baseMarkdown: base, proposedMarkdown: proposed });
      if (!saved.suggestionId) { expect(proposed).toBe(base); return; }
      const items = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!.items;
      const order = items.map((_, i) => i).sort((a, b) => keys[a]! - keys[b]! || a - b);
      for (const i of order) {
        const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: saved.suggestionId, itemIds: [items[i]!.id] });
        expect(r.stale, `item ${i} of ${JSON.stringify(order)} was stale`).toEqual([]);
      }
      const now = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.markdown;
      expect(now).toBe(proposed);
    }), RUN_CAP);
  }, 600_000);

  it("when the person rewrote a paragraph first, accept all and one place at a time (in order) end the same", async () => {
    const w = await agentWorld("accept-prop-edited");
    await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
    const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
    await checkAsync(fc.asyncProperty(pair, fc.nat(50), async ({ base, proposed }, which) => {
      const paragraphs = splitParagraphs(base);
      const mine = paragraphs.length === 0 ? base : `${base.slice(0, paragraphs[which % paragraphs.length]!.start)}my own words${base.slice(paragraphs[which % paragraphs.length]!.end)}`;
      const ends: string[] = [];
      for (const atOnce of [true, false]) {
        const nodeId = await w.note(base);
        const saved = await createSuggestions(w.ws, { actor: agent, proposer: { agentActorId: agent.id, sessionId: null }, nodeId, baseMarkdown: base, proposedMarkdown: proposed });
        await updateNode(w.ws, nodeId, { markdown: mine }, { actor: w.owner });
        if (saved.suggestionId) {
          const items = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!.items;
          if (atOnce) await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: saved.suggestionId, itemIds: "all" });
          else for (const item of items) await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: saved.suggestionId, itemIds: [item.id] });
        }
        ends.push((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.markdown);
      }
      expect(ends[0]).toBe(ends[1]);
    }), RUN_CAP);
  }, 600_000);
});
