// The model's tools ARE the MCP registry's tools: each one is described to the service
// as JSON Schema, and a call runs the same callTool() that MCP calls — same grant
// check, same rate budget, same audit event, same handler. No second tool
// implementation exists here.
import { z } from "zod";
import type { ActorCtx } from "../../../types.js";
import { callTool, listTools, mcpSafeError, toolsOfferedIn, type AgentTool } from "../../agentTools/index.js";
import type { ToolCall, ToolResult, ToolSpec } from "./protocols/index.js";

/** The tools an api session is offered: reading tools and writing tools. A writing
 *  tool cannot write: the session's write mode is 'suggest', so updateNode files a
 *  suggestion and the spine refuses every other domain event (toolScope.ts
 *  assertWriteModeAllows). `publish` tools are never offered. This list only saves
 *  the model wasted turns; the safety does not rest on it. */
export function toolsForRuntime(): AgentTool[] {
  return listTools().filter((tool) => tool.access === "read" || (tool.access === "write" && !NOT_FOR_API.has(tool.name)));
}

/** Write tools whose effect is not a mutate() event, so the spine's suggest-only rule
 *  cannot cover them. proposeTagPack files an owner-approval request through the outbox. */
const NOT_FOR_API: ReadonlySet<string> = new Set(["proposeTagPack"]);

function resultText(tool: AgentTool, result: unknown): string {
  if (tool.mcpContent) {
    // Images are not sent back here; the text parts are.
    return tool.mcpContent(result).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") || "(no text result)";
  }
  return JSON.stringify(result, null, 2) ?? "null";
}

/** The registry's tools this workspace offers (a switched-off module's tools are left out), as the neutral
 *  tool description every format adapter converts. */
export async function toolSpecs(workspaceId: string): Promise<ToolSpec[]> {
  return (await toolsOfferedIn(workspaceId, toolsForRuntime())).map((tool) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

/** Run one call the model asked for as this session's actor. A failure is the result the model sees, never a crash. */
export async function runToolCall(call: ToolCall, actor: ActorCtx, workspaceId: string): Promise<ToolResult> {
  const tool = toolsForRuntime().find((t) => t.name === call.name);
  if (!tool) return { callId: call.id, text: `unknown tool: ${call.name}`, isError: true };
  if (call.badArguments) return { callId: call.id, text: "the arguments were not valid JSON", isError: true };
  try {
    return { callId: call.id, text: resultText(tool, await callTool(tool.name, call.input, { actor, workspaceId })), isError: false };
  } catch (error) {
    return { callId: call.id, text: mcpSafeError(error).message, isError: true };
  }
}
