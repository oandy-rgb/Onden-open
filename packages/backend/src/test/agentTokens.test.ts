import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db layer so we can test the token service without a live Postgres.
type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };
const poolQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(
  async () => ({ rows: [], rowCount: 0 }),
);

vi.mock("../db.js", () => ({
  pool: { query: poolQuery },
  q: poolQuery,
  event: vi.fn(async () => {}),
  getWorkspaceId: vi.fn(async () => "ws-1"),
}));

const { generateRawToken, parseBearer, createToken, resolveBearerActor, revokeToken } =
  await import("../services/agentTokens.js");

beforeEach(() => poolQuery.mockClear());

describe("generateRawToken", () => {
  it("starts with ondt_ prefix", () => {
    expect(generateRawToken().startsWith("ondt_")).toBe(true);
  });

  it("produces high-entropy unique strings", () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generateRawToken());
    expect(set.size).toBe(200);
  });

  it("has stable length per token (32 bytes base64url + prefix)", () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe("parseBearer", () => {
  it("extracts token from Bearer header", () => {
    expect(parseBearer("Bearer ondt_abc")).toBe("ondt_abc");
  });

  it("is case-insensitive on the scheme", () => {
    expect(parseBearer("bearer ondt_abc")).toBe("ondt_abc");
    expect(parseBearer("BEARER ondt_abc")).toBe("ondt_abc");
  });

  it("returns null for missing / malformed headers", () => {
    expect(parseBearer(null)).toBe(null);
    expect(parseBearer(undefined)).toBe(null);
    expect(parseBearer("")).toBe(null);
    expect(parseBearer("Basic abc")).toBe(null);
    expect(parseBearer("Bearer")).toBe(null);
  });
});

describe("createToken", () => {
  it("inserts a row and returns plaintext (no opts = read access, no tool list, no expiry)", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: "tok-1" }], rowCount: 1 });
    const r = await createToken("actor-1", { name: "my-key" });
    expect(r.id).toBe("tok-1");
    expect(r.plaintext.startsWith("ondt_")).toBe(true);
    const call = poolQuery.mock.calls[0];
    expect(call[0]).toContain("INSERT INTO agent_tokens");
    const params = call[1] as unknown[];
    expect(params[0]).toBe("actor-1");
    expect(typeof params[1]).toBe("string"); // hash
    expect(params[1]).not.toBe(r.plaintext); // never store plaintext
    expect((params[1] as string).length).toBe(64); // sha256 hex
    expect(params[2]).toBe("my-key");
    expect(params[3]).toBe("read"); // access: a token never writes unless asked to
    expect(params[4]).toBe(null); // allowed_tools
    expect(params[5]).toBe(null); // expires_at
    expect(params[6]).toBe(null); // issued_by
  });

  it("persists access, tools, expiry and issuer when provided", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: "tok-2" }], rowCount: 1 });
    const expires = new Date("2026-12-31T00:00:00Z");
    await createToken("actor-2", {
      name: "scoped",
      access: "write",
      allowedTools: ["searchNodes", "getNode"],
      expiresAt: expires,
      issuedBy: "owner-1",
    });
    const params = poolQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe("write");
    expect(params[4]).toEqual(["searchNodes", "getNode"]);
    expect(params[5]).toBe(expires);
    expect(params[6]).toBe("owner-1");
  });
});

describe("revokeToken", () => {
  it("returns true when a row was transitioned to revoked", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const changed = await revokeToken("actor-1", "tok-1");
    expect(changed).toBe(true);
    const call = poolQuery.mock.calls[0];
    expect(call[0]).toContain("UPDATE agent_tokens");
    expect(call[0]).toContain("SET revoked_at = now()");
    expect(call[0]).toContain("revoked_at IS NULL");
    // params order is [tokenId, actorId]
    expect(call[1]).toEqual(["tok-1", "actor-1"]);
  });

  it("returns false when the row was already revoked or not found", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const changed = await revokeToken("actor-1", "tok-1");
    expect(changed).toBe(false);
  });
});

describe("resolveBearerActor", () => {
  it("returns null for non-prefixed token", async () => {
    const r = await resolveBearerActor("Basic abc");
    expect(r).toBe(null);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("returns null when the token is unknown", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await resolveBearerActor("ondt_unknown")).toBe(null);
    expect(poolQuery.mock.calls[0][0]).toContain("token_hash");
  });

  it("returns null when the actor query refuses it (revoked / expired / other workspace)", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: "tok-1", actor_id: "actor-1" }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await resolveBearerActor("ondt_revoked")).toBe(null);
    // One query decides, the one every write re-checks (resolveCurrentActor).
    const sql = poolQuery.mock.calls[1][0];
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("statement_timestamp()");
    expect(sql).toContain("a.workspace_id=$2");
    expect(poolQuery.mock.calls[1][1]).toEqual(["actor-1", "ws-1", "tok-1"]);
  });

  it("returns an ActorCtx with tokenScope on hit + updates last_used_at", async () => {
    const expires = new Date("2027-01-01T00:00:00Z");
    poolQuery.mockResolvedValueOnce({ rows: [{ id: "tok-9", actor_id: "actor-9" }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({
      rows: [{
        id: "actor-9", name: "Bot", type: "agent",
        token_id: "tok-9",
        allowed_tools: ["searchNodes"],
        access: "write",
        expires_at: expires,
        issued_by: "owner-1",
      }],
      rowCount: 1,
    });
    const r = await resolveBearerActor("ondt_validtoken");
    expect(r).toEqual({
      id: "actor-9", name: "Bot", type: "agent",
      tokenScope: {
        tokenId: "tok-9",
        allowedTools: ["searchNodes"],
        access: "write",
        expiresAt: expires,
        issuedBy: "owner-1",
      },
    });
    await new Promise((res) => setImmediate(res));
    expect(poolQuery.mock.calls[2][0]).toContain("UPDATE agent_tokens");
  });

  it("populates tokenScope with a null tool list and read access when the row has neither", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: "tok-10", actor_id: "actor-10" }], rowCount: 1 });
    poolQuery.mockResolvedValueOnce({
      rows: [{
        id: "actor-10", name: "OldBot", type: "agent",
        token_id: "tok-10",
        allowed_tools: null,
        access: null,
        expires_at: null,
        issued_by: null,
      }],
      rowCount: 1,
    });
    const r = await resolveBearerActor("ondt_validtoken2");
    expect(r?.tokenScope).toEqual({
      tokenId: "tok-10",
      allowedTools: null,
      access: "read",
      expiresAt: null,
      issuedBy: null,
    });
  });
});
