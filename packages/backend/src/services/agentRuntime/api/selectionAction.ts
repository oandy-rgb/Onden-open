// A small action on selected text (rewrite, shorten, translate…): ONE streaming
// call, no tools, no loop. The suggestion is created only when the stream has
// finished (run.ts → deliverApiResult), so a connection lost halfway leaves no
// half suggestion. While it streams, the text so far goes to the preview card
// (liveRun) — a preview only, never saved. The session still exists, so cost and
// log are the same as for a tool session.
//
// What the model sees is built by renderSessionPrompt (the one builder for every
// runtime) from the selected text the person sent.
import type { AgentSession } from "../../agentSessionStore.js";
import { renderSessionPrompt } from "../../agentSessionPrompt.js";
import { MAX_OUTPUT_TOKENS } from "./limits.js";
import { beginLive, pushPreview } from "./liveRun.js";
import { prepareApiRun, Stop } from "./prepare.js";
import { finalText, promptTurns } from "./turns.js";
import { recordUsage } from "./usage.js";

export async function runSelectionAction(session: AgentSession): Promise<string> {
  const { model, actor, client, prices } = await prepareApiRun(session);
  const rendered = await renderSessionPrompt(session, actor).catch(() => { throw new Stop("cannot_read_note"); });

  const abort = beginLive(session.id);
  const result = await client.turn({
    model, system: rendered.system, maxOutputTokens: MAX_OUTPUT_TOKENS, tools: [], webSearch: false,
    turns: promptTurns(rendered.messages),
  }, { signal: abort.signal, onText: (delta) => pushPreview(session.id, delta) });
  await recordUsage(session, prices, result.usage);
  return finalText(result);
}
