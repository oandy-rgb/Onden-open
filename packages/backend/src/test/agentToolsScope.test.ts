import { describe, it, expect } from "vitest";
import { assertToolAllowed, ScopeError } from "../spine/toolScope.js";
import type { ActorCtx, TokenScope } from "../types.js";

function mkActor(scope?: Partial<TokenScope> | null): ActorCtx {
  const base: ActorCtx = { id: "a-1", name: "Bot", role: "editor", type: "agent" };
  if (scope === null) return base;
  if (scope) {
    return {
      ...base,
      tokenScope: {
        tokenId: "tok-1",
        allowedTools: null, access: "write",
        writeMode: "apply", expiresAt: null,
        ...scope,
      },
    };
  }
  return base;
}

describe("assertToolAllowed", () => {
  it("no-op when tokenScope is undefined (session / native actor)", () => {
    expect(() => assertToolAllowed(mkActor(null), "searchNodes")).not.toThrow();
  });

  it("no-op when allowedTools is null (unrestricted)", () => {
    expect(() => assertToolAllowed(mkActor({ allowedTools: null }), "searchNodes")).not.toThrow();
  });

  it("passes when tool is in the allowlist", () => {
    expect(() =>
      assertToolAllowed(mkActor({ allowedTools: ["searchNodes", "getNode"] }), "searchNodes"),
    ).not.toThrow();
  });

  it("throws tool_not_allowed when tool is missing from allowlist", () => {
    expect(() =>
      assertToolAllowed(mkActor({ allowedTools: ["searchNodes"] }), "updateNode"),
    ).toThrowError(ScopeError);
    try {
      assertToolAllowed(mkActor({ allowedTools: ["searchNodes"] }), "updateNode");
    } catch (e) {
      expect((e as ScopeError).code).toBe("tool_not_allowed");
    }
  });

  it("throws tool_not_allowed when allowedTools is empty (lockdown)", () => {
    expect(() => assertToolAllowed(mkActor({ allowedTools: [] }), "searchNodes"))
      .toThrowError(ScopeError);
  });
});

// assertTagAllowed / assertTagInScope were removed with token tag scope: what a
// token may read or write is decided by spaces (spine/spaceScope.ts).
