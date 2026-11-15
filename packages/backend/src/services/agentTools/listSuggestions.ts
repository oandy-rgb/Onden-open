import { z } from "zod";
import { ellipsize } from "@onden/markdown";
import { db } from "../../dbKysely.js";
import { readableAmong } from "../readPolicy.js";
import type { AgentTool } from "./types.js";

// What became of the edits an agent (or any agent) suggested on a note, place by place.
// Read-only: it never decides anything (accepting and rejecting stay with the person,
// services/aiSuggestions.ts). Only notes the caller may read.

const STATUSES = ["pending", "accepted", "rejected", "stale", "void", "replaced"] as const;
const MAX_TEXT = 4_000;
/** The most suggestion text (original + suggested, in characters) one call returns; the rest is paged or counted in `placesOmitted`. */
const CALL_TEXT_BUDGET = 40_000;

const Args = z.object({
  id: z.string().uuid(),
  /** Only suggestions this agent filed (the default). false: every agent's suggestions on the note, rejected text included. */
  mine: z.boolean().default(true),
  /** Only places in this state. */
  status: z.enum(STATUSES).optional(),
  /** Only this suggestion (an id from an earlier call), to read the places a call left out: pass `fromPlace` too. */
  suggestionId: z.string().uuid().optional(),
  /** With suggestionId: start at this place (1-based), the `nextPlace` an earlier call gave. */
  fromPlace: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
});

const clip = (text: string | null, max: number): string | null => (text !== null && text.length > max ? ellipsize(text, max) : text);
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

type PlaceOut = {
  /** The place's order within its suggestion (1-based). */
  place: number;
  kind: "replace" | "insert" | "delete" | "title" | "comment";
  status: (typeof STATUSES)[number];
  /** The text as it was when suggested (empty for an insert or a comment). */
  original: string;
  /** The suggested text (null for a delete). */
  suggested: string | null;
  /** When the person accepted or rejected it; null while undecided. */
  decidedAt: string | null;
};

type ListSuggestionsResult = {
  noteId: string;
  suggestions: Array<{
    id: string;
    from: { name: string; isYou: boolean };
    createdAt: string;
    places: PlaceOut[];
    /** Places left out of `places` because this call's text budget ran out (read them with suggestionId and fromPlace = nextPlace). */
    placesOmitted?: number;
    /** With `placesOmitted`: the place to continue from (call again with suggestionId and fromPlace = this). */
    nextPlace?: number;
  }>;
  /** The offset of the next page; null at the end. */
  next: number | null;
} | null;

export const listSuggestions: AgentTool<z.infer<typeof Args>, ListSuggestionsResult> = {
  name: "listSuggestions",
  access: "read",
  description:
    "List the suggestions filed on a note (by suggestEdit, or updateNode while you are set to suggest), newest first, and what happened to each place: " +
    "pending (waiting for the user), accepted, rejected, stale (the text changed under it, so it is shown for the user to see), " +
    "void (the note changed so it can no longer apply) or replaced (a newer suggestion took its place). Each place has the original and suggested text, " +
    "and when it was decided. By default only your own are listed (mine=false lists every agent's). Pass status to filter places. One call returns a bounded amount of text: `next` (more suggestions) and `placesOmitted`/`nextPlace` (more places of one suggestion: call again with suggestionId and fromPlace) say what is left. Returns null if the note is not found or you cannot read it. " +
    "It only reads: the user decides, and you cannot accept or reject.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId }) {
    if (!(await readableAmong(actor, workspaceId, [args.id])).has(args.id)) return null;
    let query = db.selectFrom("ai_edit_suggestions as s")
      // A set made for a space the note has since left is not the note's any more (as the note's own suggestion list).
      .innerJoin("content_nodes as n", (join) => join.onRef("n.id", "=", "s.node_id").onRef("n.space_id", "=", "s.space_id"))
      .leftJoin("actors as a", "a.id", "s.agent_actor_id")
      .select(["s.id", "s.agent_actor_id", "s.created_at", "a.name as agent_name"])
      .where("s.workspace_id", "=", workspaceId).where("s.node_id", "=", args.id).where("n.deleted_at", "is", null);
    if (args.mine) query = query.where("s.agent_actor_id", "=", actor.id);
    if (args.suggestionId) query = query.where("s.id", "=", args.suggestionId);
    if (args.status) {
      const wanted = args.status;
      query = query.where((eb) => eb.exists(
        eb.selectFrom("ai_edit_suggestion_items as i").select("i.id").whereRef("i.suggestion_id", "=", "s.id").where("i.status", "=", wanted),
      ));
    }
    const rows = await query.orderBy("s.created_at", "desc").orderBy("s.id").limit(args.limit + 1).offset(args.offset).execute();
    const page = rows.slice(0, args.limit);
    let itemQuery = db.selectFrom("ai_edit_suggestion_items")
      .select(["suggestion_id", "seq", "kind", "status", "base_text", "new_text", "decided_at"])
      .where("suggestion_id", "in", page.length ? page.map((r) => r.id) : [""]);
    if (args.status) itemQuery = itemQuery.where("status", "=", args.status);
    if (args.suggestionId) itemQuery = itemQuery.where("seq", ">=", args.fromPlace - 1);
    const items = page.length ? await itemQuery.orderBy("suggestion_id").orderBy("seq").execute() : [];
    // One call carries a bounded amount of text: places past the budget are counted, and a suggestion that would start
    // past it moves to the next page.
    let budget = CALL_TEXT_BUDGET;
    const suggestions: NonNullable<ListSuggestionsResult>["suggestions"] = [];
    for (const r of page) {
      if (budget <= 0 && suggestions.length > 0) break;
      const places: PlaceOut[] = [];
      let omitted = 0;
      let nextPlace: number | undefined;
      for (const i of items.filter((x) => x.suggestion_id === r.id)) {
        if (budget <= 0) { omitted++; nextPlace ??= i.seq + 1; continue; }
        const original = clip(i.base_text, Math.min(MAX_TEXT, budget)) ?? "";
        const suggested = clip(i.new_text, Math.min(MAX_TEXT, Math.max(budget - original.length, 1)));
        budget -= original.length + (suggested?.length ?? 0);
        places.push({ place: i.seq + 1, kind: i.kind as PlaceOut["kind"], status: i.status as PlaceOut["status"], original, suggested, decidedAt: iso(i.decided_at) });
      }
      suggestions.push({
        id: r.id, from: { name: r.agent_name ?? "", isYou: r.agent_actor_id === actor.id }, createdAt: iso(r.created_at)!,
        places, ...(omitted > 0 ? { placesOmitted: omitted, nextPlace } : {}),
      });
    }
    return {
      noteId: args.id,
      suggestions,
      next: suggestions.length < page.length || rows.length > args.limit ? args.offset + suggestions.length : null,
    };
  },
};
