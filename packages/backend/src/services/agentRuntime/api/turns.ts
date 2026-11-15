// Small conversions between the prompt builder's messages, the neutral turns the format
// adapters take, and the final answer text.
import { Stop } from "./prepare.js";
import type { Turn, TurnResult } from "./protocols/index.js";

export function promptTurns(messages: Array<{ role: "user" | "assistant"; content: string }>): Turn[] {
  return messages.map((m): Turn => (m.role === "user" ? { role: "user", text: m.content } : { role: "assistant", text: m.content, toolCalls: [] }));
}

/** The answer of a turn that ended: the text, or the short reason there is none. */
export function finalText(result: TurnResult): string {
  if (result.stop === "tool_use") throw new Stop("turn_limit");
  if (result.stop === "refusal") throw new Stop("refused");
  if (result.stop === "max_tokens") throw new Stop("output_too_long");
  if (!result.text) throw new Stop("empty_reply");
  return result.text;
}
