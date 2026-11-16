// What to tell the AI tool and how to read what it printed. Pure functions.

const ROLE_LABEL = { user: "User", assistant: "Assistant" };

/**
 * `rendered` is what claim returns. One message goes in as it is; several turns are labelled
 * so the tool can tell who said what.
 * @param {{ system: string, messages: Array<{ role: string, content: string }> }} rendered
 */
export function assemblePrompt(rendered) {
  const messages = rendered.messages ?? [];
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map((m) => `[${ROLE_LABEL[/** @type {keyof typeof ROLE_LABEL} */ (m.role)] ?? m.role}]\n${m.content}`).join("\n\n");
  return { system: rendered.system ?? "", prompt };
}

/**
 * The Claude Code CLI prints one JSON object with `is_error` and `result`.
 * @param {string} stdout
 * @returns {{ ok: true, text: string } | { ok: false, reason: "empty" | "not_json" | "tool_error" }}
 */
export function parseToolOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  /** @type {any} */
  let value;
  try { value = JSON.parse(trimmed); } catch { return { ok: false, reason: "not_json" }; }
  // Some versions print an array of events; the last `result` entry is the answer.
  if (Array.isArray(value)) value = [...value].reverse().find((v) => v?.type === "result") ?? null;
  if (!value || typeof value !== "object") return { ok: false, reason: "not_json" };
  if (value.is_error) return { ok: false, reason: "tool_error" };
  const text = typeof value.result === "string" ? value.result.trim() : "";
  return text ? { ok: true, text } : { ok: false, reason: "empty" };
}
