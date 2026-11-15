import type { ZodType } from "zod";
import type { ActorCtx } from "../../types.js";

export type ToolCtx = {
  actor: ActorCtx;
  workspaceId: string;
  // Dry-run preview mode. Mutating tools run scope/existence/permission checks
  // but skip the write + dispatcher queue, returning what WOULD have happened.
  // Read tools ignore this flag. callTool also skips AGENT_TOOL_CALLED audit
  // when dryRun=true (the call didn't actually happen).
  dryRun?: boolean;
};

type ToolHandler<TArgs, TResult> = (
  args: TArgs,
  ctx: ToolCtx,
) => Promise<TResult>;

export type ToolAccess = "read" | "write";

export type AgentTool<TArgs = unknown, TResult = unknown> = {
  name: string;
  /** What the tool does to the workspace, which decides the tokens that may
   *  carry it (templates.ts): `read` changes nothing; `write` edits notes and
   *  tags or files proposals the owner reviews. Every tool declares one. */
  access: ToolAccess;
  description: string;
  // Zod schema for input validation. The MCP JSON-schema surface (Day 4-5)
  // derives from this.
  inputSchema: ZodType<TArgs>;
  handler: ToolHandler<TArgs, TResult>;
  /** Whether this workspace offers the tool at all (a module's tool: only where
   *  the module is on). Tool listings (MCP tools/list, the api runtime) leave an
   *  unavailable tool out; callTool still refuses it. Absent = always offered. */
  available?: (workspaceId: string) => Promise<boolean>;
  // Optional MCP rendering of the result. Default: the result as JSON text.
  // A tool returning a file (getAttachment) maps it to image blocks here; the
  // REST surface and the audit trail still see the plain result.
  mcpContent?: (result: TResult) => McpContentBlock[];
};

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
