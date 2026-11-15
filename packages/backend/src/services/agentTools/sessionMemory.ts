import { z } from "zod";
import { AgentSessionError } from "../agentSessionError.js";
import {
  ownSession, ownSessions, PROMPT_SNIPPET_MAX, sessionSteps, UNREADABLE_NOTE_TITLE,
  type OwnSession, type SessionStep, type SuggestionCounts,
} from "../agentSessionMemory.js";
import { cutToUnits } from "@onden/markdown";
import type { AgentTool } from "./types.js";

// The agent's memory of its own earlier sessions (proposal ai-collaboration §AI 記得之前做過什麼).
// Read-only metadata: tool, target, time, result code. Never a note body or the model's
// reply. Only the agent actor's own sessions; a person's token has none (empty list), and
// someone else's session and a missing id both answer not_found.

const ListArgs = z.object({
  nodeId: z.string().uuid().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
const LogArgs = z.object({ sessionId: z.string().uuid() });

type SessionSummary = {
  id: string; node_id: string; node_title: string; status: string; fail_code: string | null;
  created_at: string; finished_at: string | null; prompt: string; suggestions: SuggestionCounts;
};
const summary = (s: OwnSession): SessionSummary => ({
  id: s.id, node_id: s.node_id, node_title: s.node_title ?? UNREADABLE_NOTE_TITLE, status: s.status, fail_code: s.fail_code,
  created_at: s.created_at, finished_at: s.finished_at, prompt: cutToUnits(s.prompt, PROMPT_SNIPPET_MAX), suggestions: s.suggestions,
});

export const listMySessions: AgentTool<z.infer<typeof ListArgs>, SessionSummary[]> = {
  name: "listMySessions",
  access: "read",
  description:
    "List your own earlier sessions, newest first (at most 50): id, node_id, node_title, status, fail_code, times, the " +
    "request (shortened) and how many of your suggestions were accepted/rejected/pending. Use it to continue earlier work " +
    "(\"pick up where you left off\") and BEFORE undoing something you did, to find out what you changed. Filter with nodeId " +
    "and/or since (ISO time). A note you can no longer read shows as \"" + UNREADABLE_NOTE_TITLE + "\". Only your own " +
    "sessions; it never returns note text and changes nothing. Read the steps of one with getSessionLog.",
  inputSchema: ListArgs,
  async handler(args, { actor, workspaceId }) {
    return (await ownSessions(actor, workspaceId, { nodeId: args.nodeId, since: args.since, limit: args.limit })).map(summary);
  },
};

type SessionLog = SessionSummary & { steps: Array<Pick<SessionStep, "seq" | "at" | "kind" | "tool" | "target_id" | "target_title" | "query_length">> };

export const getSessionLog: AgentTool<z.infer<typeof LogArgs>, SessionLog> = {
  name: "getSessionLog",
  access: "read",
  description:
    "The steps one of your own earlier sessions took (from listMySessions): in order, the tool called, the id and title of " +
    "the note it acted on (\"" + UNREADABLE_NOTE_TITLE + "\" if you cannot read it now), reads, and the length of searches. " +
    "Metadata only: no note text and not what you said. Use it before undoing or continuing earlier work. " +
    "Another agent's session and an unknown id both answer not_found.",
  inputSchema: LogArgs,
  async handler(args, { actor, workspaceId }) {
    const session = await ownSession(actor, workspaceId, args.sessionId);
    if (!session) throw new AgentSessionError("not_found", "not_found", 404);
    const steps = (await sessionSteps(actor, workspaceId, [session.id])).get(session.id) ?? [];
    return { ...summary(session), steps };
  },
};
