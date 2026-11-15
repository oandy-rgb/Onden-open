import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActorCtx } from "../types.js";
import { event } from "../db.js";
import { callTool, registerTool } from "../services/agentTools/index.js";
import { assertCurrentToolAllowed, ScopeError, withToolAuthority } from "../spine/toolScope.js";

vi.mock("../db.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../db.js")>(),
  event: vi.fn(async () => "1"),
}));

function tokenActor(allowedTools: string[] | null): ActorCtx {
  return {
    id: "actor", name: "Agent", role: "editor", type: "agent",
    tokenScope: { tokenId: "token", allowedTools, access: "write", writeMode: "apply", expiresAt: null },
  };
}

const toolName = "testCurrentToolAuthority";
let currentActor: ActorCtx;
const write = vi.fn();
registerTool({
  name: toolName,
  access: "write",
  description: "Check the refreshed authority after an asynchronous write wait",
  inputSchema: z.object({}),
  handler: async () => {
    await Promise.resolve();
    assertCurrentToolAllowed(currentActor);
    write();
    return { ok: true };
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  currentActor = tokenActor([toolName]);
});

describe("tool authority at the write boundary", () => {
  it("registry retains the tool name when its original token grant is narrowed before writing", async () => {
    const authenticated = tokenActor([toolName]);
    currentActor = tokenActor([]);
    await expect(callTool(toolName, {}, { actor: authenticated, workspaceId: "workspace" }))
      .rejects.toMatchObject({ code: "tool_not_allowed" });
    expect(write).not.toHaveBeenCalled();
    expect(vi.mocked(event).mock.calls.map((call) => call[1])).toEqual(["AGENT_TOOL_FAILED"]);
  });

  it("registry permits a still-authorized tool and records success", async () => {
    await expect(callTool(toolName, {}, { actor: tokenActor([toolName]), workspaceId: "workspace" }))
      .resolves.toEqual({ ok: true });
    expect(write).toHaveBeenCalledOnce();
    expect(vi.mocked(event).mock.calls.map((call) => call[1])).toEqual(["AGENT_TOOL_CALLED"]);
  });

  it("keeps simultaneous invocations separate across asynchronous waits", async () => {
    await Promise.all([
      withToolAuthority("alpha", async () => {
        await Promise.resolve();
        expect(() => assertCurrentToolAllowed(tokenActor(["alpha"]))).not.toThrow();
        expect(() => assertCurrentToolAllowed(tokenActor(["beta"]))).toThrow(ScopeError);
      }),
      withToolAuthority("beta", async () => {
        await Promise.resolve();
        expect(() => assertCurrentToolAllowed(tokenActor(["beta"]))).not.toThrow();
        expect(() => assertCurrentToolAllowed(tokenActor(["alpha"]))).toThrow(ScopeError);
      }),
    ]);
  });

  it("a nested invocation cannot hide a revoked outer tool grant", async () => {
    await withToolAuthority("outer", () => withToolAuthority("inner", async () => {
      expect(() => assertCurrentToolAllowed(tokenActor(["inner"]))).toThrow(/outer/);
      expect(() => assertCurrentToolAllowed(tokenActor(["outer", "inner"]))).not.toThrow();
    }));
  });

  it("cleans up rejected calls and leaves non-tool operations unrestricted", async () => {
    await expect(withToolAuthority("denied", async () => {
      assertCurrentToolAllowed(tokenActor([]));
    })).rejects.toBeInstanceOf(ScopeError);
    expect(() => assertCurrentToolAllowed(tokenActor([]))).not.toThrow();
  });

  it("preserves unlimited tokens and ordinary human operations", async () => {
    await withToolAuthority("any", async () => {
      expect(() => assertCurrentToolAllowed(tokenActor(null))).not.toThrow();
      expect(() => assertCurrentToolAllowed({ id: "human", name: "Human", role: "editor", type: "human" }))
        .not.toThrow();
    });
  });
});
