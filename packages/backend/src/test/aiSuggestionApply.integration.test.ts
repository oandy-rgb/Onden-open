// What a person gets when they accept an AI's suggestion, end to end (create → accept/reject → note,
// inbox): the text lands exactly as the AI sent it, a tight list stays tight, a change that only
// differs in tight/loose is still a suggestion, and the suggestion leaves the inbox once every place
// is decided. Pure cutting rules: properties/aiSuggestionApply.property.test.ts.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import type { ActorCtx } from "../types.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { updateNode } from "../services/nodeUpdate.js";
import { acceptSuggestionItems, rejectSuggestionItems, suggestionsForNode } from "../services/aiSuggestions.js";
import { inboxQueue } from "../services/inboxQueue.js";
import { suggestEdit } from "../services/agentTools/suggestEdit.js";
import { updateNode as updateNodeTool } from "../services/agentTools/updateNode.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
// Accepting a suggestion queues the note's dispatchers; let them finish before the pool goes, or one still running
// fails on the closed pool and its DISPATCHER_FAILED event becomes an unhandled rejection of the whole run.
afterAll(async () => { await awaitAllDispatchers(); await pool.end(); });

const LOOSE = "作者質疑兩點：\n\n- 「幻覺」這個詞，各家的定義都不一樣。\n\n- 這些工具從來沒公開過任何評測結果。\n\n### 背景\n1. 一\n\n2. 二\n\n3. 三\n\n4. 四\n";
const TIGHT = "作者質疑兩點：\n\n- 「幻覺」這個詞，各家的定義都不一樣。\n- 這些工具從來沒公開過任何評測結果。\n\n### 背景\n\n1. 一\n2. 二\n3. 三\n4. 四\n";

async function world(label: string) {
  const w = await agentWorld(label);
  await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
  const agent: ActorCtx = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
  return { ...w, agent };
}
type World = Awaited<ReturnType<typeof world>>;

const body = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const waiting = async (w: World, nodeId: string) =>
  (await inboxQueue(w.owner, w.ws, { limit: 200, actorId: null, eventType: null, since: null })).events
    .filter((e) => e.target_id === nodeId && e.event_type === "AI_SUGGESTION_CREATED");

async function suggest(w: World, nodeId: string, markdown: string) {
  const base = await body(nodeId);
  const r = await suggestEdit.handler({ id: nodeId, markdown, base_markdown: base }, { actor: w.agent, workspaceId: w.ws });
  const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
  return { r, suggestion: listed.suggestions[0]! };
}

describe.skipIf(!isTestDb)("accepting a suggestion", () => {
  it("stores the AI's text exactly: tight lists stay tight, numbered lists too, the blank line after a heading comes along", async () => {
    const w = await world("exact");
    const nodeId = await w.note(LOOSE);
    const { r, suggestion } = await suggest(w, nodeId, TIGHT);
    expect(r.status).toBe("suggested");
    const result = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(result.stale).toEqual([]);
    expect(await body(nodeId)).toBe(TIGHT);
  });

  it("a tight list the AI sends over a note without it lands as sent, not one blank line per item", async () => {
    const w = await world("plain");
    const before = "作者質疑兩點：\n";
    const after = "作者質疑兩點：\n\n- 「幻覺」這個詞，各家的定義都不一樣。\n- 這些工具從來沒公開過任何評測結果。\n";
    const nodeId = await w.note(before);
    const { suggestion } = await suggest(w, nodeId, after);
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(await body(nodeId)).toBe(after);
  });

  it("an updateNode that only makes a loose list tight is a suggestion, not 'nothing to suggest'", async () => {
    const w = await world("tight-only");
    const nodeId = await w.note(LOOSE);
    const r = await updateNodeTool.handler({ id: nodeId, markdown: TIGHT, base_markdown: LOOSE }, { actor: w.agent, workspaceId: w.ws });
    expect(r).toMatchObject({ status: "suggested" });
    expect(r).not.toMatchObject({ status: "no_change" });
    // …and the same text again changes nothing the person has not already been asked
    const again = await suggestEdit.handler({ id: nodeId, markdown: TIGHT, base_markdown: LOOSE }, { actor: w.agent, workspaceId: w.ws });
    expect(again.places).toBeGreaterThan(0);
  });

  it("a note already split into loose items becomes tight when the AI sends the tight version once more", async () => {
    const w = await world("repair");
    const nodeId = await w.note(LOOSE);
    const { suggestion } = await suggest(w, nodeId, TIGHT);
    expect(suggestion.items.length).toBeGreaterThan(0);
    // the person sees the text of each place, not the separators stored with it
    for (const item of suggestion.items) expect(item.new_text).toBe(item.new_text!.trimEnd());
  });

  it("rejecting everything leaves the note as it was", async () => {
    const w = await world("reject");
    const nodeId = await w.note(LOOSE);
    const { suggestion } = await suggest(w, nodeId, TIGHT);
    await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(await body(nodeId)).toBe(LOOSE);
  });
});

describe.skipIf(!isTestDb)("the inbox card of a suggestion", () => {
  it("waits while a place is undecided and is gone once every place is decided, whichever way", async () => {
    const w = await world("inbox");
    const nodeId = await w.note("alpha\n\nbeta\n\ngamma\n");
    const { suggestion } = await suggest(w, nodeId, "ALPHA\n\nbeta\n\nGAMMA\n");
    expect(suggestion.items).toHaveLength(2);
    expect(await waiting(w, nodeId)).toHaveLength(1);

    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [suggestion.items[0]!.id] });
    expect(await waiting(w, nodeId)).toHaveLength(1); // one place still waits

    await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [suggestion.items[1]!.id] });
    expect(await waiting(w, nodeId)).toEqual([]);
    expect(await body(nodeId)).toBe("ALPHA\n\nbeta\n\ngamma\n");
  });

  it("accepting all clears it, and a revised suggestion replaces the one before", async () => {
    const w = await world("inbox-all");
    const nodeId = await w.note("one\n\ntwo\n");
    const first = await suggest(w, nodeId, "ONE\n\ntwo\n");
    const second = await suggest(w, nodeId, "one\n\nTWO\n");
    expect(first.suggestion.id).not.toBe(second.suggestion.id);
    // same session or not, an event whose places are all decided is not listed
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: second.suggestion.id, itemIds: "all" });
    await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: first.suggestion.id, itemIds: "all" });
    expect(await waiting(w, nodeId)).toEqual([]);
  });

  it("a place that went stale stays until the person dismisses it, and dismissing ends it everywhere", async () => {
    const w = await world("stale");
    const nodeId = await w.note("alpha\n\nbeta\n");
    const { suggestion } = await suggest(w, nodeId, "ALPHA\n\nBETA\n");
    // the person rewrites the second paragraph meanwhile, so that place cannot be applied
    await updateNode(w.ws, nodeId, { markdown: "alpha\n\nbeta, as I wrote it\n" }, { actor: w.owner });
    const result = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(result.stale).toHaveLength(1);
    expect(await body(nodeId)).toBe("ALPHA\n\nbeta, as I wrote it\n");
    expect(await waiting(w, nodeId)).toHaveLength(1); // the person is still told one place could not be applied
    const stale = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!.items[0]!;
    expect(stale.status).toBe("stale");

    const dismissed = await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [stale.id] });
    expect(dismissed.rejected).toEqual([stale.id]);
    expect(dismissed.alreadyDecided).toEqual([]);
    expect(await waiting(w, nodeId)).toEqual([]);
    expect((await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions).toEqual([]);
    expect(await body(nodeId)).toBe("ALPHA\n\nbeta, as I wrote it\n");
  });

  // Accepting a suggestion place by place must end where accepting it at once does (the owner's production case).
  const DECK_BEFORE = "# 簡報\n";
  const DECK_AFTER = "# 簡報\n\n## 第一頁\n\n- 重點一\n- 重點二\n- 重點三\n\n講者備註：先講背景。\n\n## 第二頁\n\n1. 步驟一\n2. 步驟二\n";
  const orders: Array<[string, (n: number) => number[]]> = [
    ["top to bottom", (n) => [...Array(n).keys()]],
    ["bottom to top", (n) => [...Array(n).keys()].reverse()],
    ["shuffled", (n) => [...Array(n).keys()].map((i) => (i * 7 + 3) % n).filter((v, i, a) => a.indexOf(v) === i).concat([...Array(n).keys()]).filter((v, i, a) => a.indexOf(v) === i)],
  ];
  for (const [label, order] of orders) {
    it(`the deck is the same accepted one place at a time, ${label}, as accepted at once`, async () => {
      const w = await world(`deck-${label.replace(/\W/g, "")}`);
      const nodeId = await w.note(DECK_BEFORE);
      const { suggestion } = await suggest(w, nodeId, DECK_AFTER);
      for (const i of order(suggestion.items.length)) {
        const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [suggestion.items[i]!.id] });
        expect(r.stale, `item ${i}`).toEqual([]);
      }
      expect(await body(nodeId)).toBe(DECK_AFTER);
    });
  }

  it("text, a list and the text that follows it, accepted from the top, keep their order and spacing", async () => {
    const w = await world("list-order");
    const before = "text\n\n- a\n";
    const after = "text\n\n- a\n- b\n- c\n\nend\n";
    const nodeId = await w.note(before);
    const { suggestion } = await suggest(w, nodeId, after);
    for (const item of suggestion.items) await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [item.id] });
    expect(await body(nodeId)).toBe(after);
  });

  it("after a place that rewrote a paragraph is accepted, the places anchored on it are still found, now under its new text", async () => {
    const w = await world("place");
    const nodeId = await w.note("alpha\n\nbeta\n");
    const { suggestion } = await suggest(w, nodeId, "ALPHA\n\nnew after alpha\n\nbeta\n");
    const replace = suggestion.items.find((i) => i.kind === "replace")!;
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [replace.id] });
    const left = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!.items;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ kind: "insert", base_text: "alpha", place: { text: "ALPHA", occurrence: 0 }, change: null });
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [left[0]!.id] });
    expect(r.stale).toEqual([]);
    expect(await body(nodeId)).toBe("ALPHA\n\nnew after alpha\n\nbeta\n");
  });

  it("a place that only changes spacing or indentation says which", async () => {
    const w = await world("change");
    const nodeId = await w.note("- a\n\n- b\n\n```py\nif x:\n    y()\n```\n");
    const { suggestion } = await suggest(w, nodeId, "- a\n- b\n\n```py\nif x:\n  y()\n```\n");
    expect(suggestion.items.map((i) => i.change).sort()).toEqual(["indent", "spacing"]);
  });

  it("suggestEdit answers 'suggested' for a proposal that only moves paragraphs", async () => {
    const w = await world("move-only");
    const base = "first ^aa11aa\n\nsecond\n\nthird\n";
    const nodeId = await w.note(base);
    const { r, suggestion } = await suggest(w, nodeId, "second\n\nthird\n\nfirst ^aa11aa\n");
    expect(r).toMatchObject({ status: "suggested" });
    expect(suggestion.items.length).toBeGreaterThan(0);
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(await body(nodeId)).toBe("second\n\nthird\n\nfirst ^aa11aa\n");
  });

  it("the person rewrote a paragraph the AI also changed: accept all lands the others in the proposed order and spacing, only that one is stale", async () => {
    const w = await world("edited-then-all");
    const nodeId = await w.note("intro\n\nmiddle\n\nlast\n");
    const { suggestion } = await suggest(w, nodeId, "intro\n\nnew one\n\nnew two\n\nmiddle\n\nfinal words entirely different\n");
    await updateNode(w.ws, nodeId, { markdown: "intro\n\nmiddle\n\nmy own ending\n" }, { actor: w.owner });
    const result = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(result.stale).toHaveLength(1);
    expect(await body(nodeId)).toBe("intro\n\nnew one\n\nnew two\n\nmiddle\n\nmy own ending\n");
  });
});
