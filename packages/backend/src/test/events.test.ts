import { describe, it, expect } from "vitest";
import { buildEventQuery } from "../services/eventQuery.js";
import { READ_ONLY_TOOL_NAMES } from "../services/agentTools/index.js";
import { listTools } from "../services/agentTools/index.js";

const WS = "00000000-0000-0000-0000-000000000001";

describe("buildEventQuery — defaults", () => {
  it("no filters: only workspace + default limit 100", () => {
    const r = buildEventQuery(WS, {});
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.params).toEqual([WS, 100]);
    expect(r.sql).toContain("workspace_id = $1");
    expect(r.sql).toContain("ORDER BY id DESC");
    expect(r.sql).toContain("LIMIT $2");
  });

  it("empty-string and whitespace filters treated as missing", () => {
    const r = buildEventQuery(WS, { event_type: "", target_id: "   ", actor_id: undefined });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.params).toEqual([WS, 100]);
  });
});

describe("buildEventQuery — filters compose", () => {
  it("event_type + target_id add two params", () => {
    const r = buildEventQuery(WS, { event_type: "NODE_CREATED", target_id: "node-abc" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.params).toEqual([WS, "NODE_CREATED", "node-abc", 100]);
    expect(r.sql).toMatch(/event_type = \$2/);
    expect(r.sql).toMatch(/target_id = \$3/);
  });

  it("since produces id > $n::bigint clause", () => {
    const r = buildEventQuery(WS, { since: "42" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.sql).toMatch(/id > \$2::bigint/);
    expect(r.params).toEqual([WS, "42", 100]);
  });

  it("forward read (since set) orders ASC so the cursor can drain the whole gap", () => {
    // Finding 1: DESC + a lower-bound cursor skips events below the newest page.
    const r = buildEventQuery(WS, { since: "42" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.sql).toContain("ORDER BY id ASC");
    expect(r.sql).not.toContain("ORDER BY id DESC");
  });

  it("initial load (no since) stays DESC — newest page first", () => {
    const r = buildEventQuery(WS, {});
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.sql).toContain("ORDER BY id DESC");
  });

  it("all filters compose in stable order", () => {
    const r = buildEventQuery(WS, {
      since: "10", event_type: "X", target_type: "node",
      target_id: "n1", actor_type: "user", actor_id: "u1",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    // workspace, since, event_type, target_type, target_id, actor_type, actor_id, limit
    expect(r.params).toEqual([WS, "10", "X", "node", "n1", "user", "u1", 100]);
  });
});

describe("buildEventQuery — limit handling", () => {
  it("custom limit", () => {
    const r = buildEventQuery(WS, { limit: "25" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.limit).toBe(25);
    expect(r.params).toEqual([WS, 25]);
  });

  it("limit > 500 clamps to 500", () => {
    const r = buildEventQuery(WS, { limit: "10000" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.limit).toBe(500);
  });

  it("limit=0 is rejected", () => {
    const r = buildEventQuery(WS, { limit: "0" });
    expect(r.kind).toBe("error");
  });

  it("limit=-5 is rejected", () => {
    const r = buildEventQuery(WS, { limit: "-5" });
    expect(r.kind).toBe("error");
  });

  it("limit=abc is rejected", () => {
    const r = buildEventQuery(WS, { limit: "abc" });
    expect(r.kind).toBe("error");
  });
});

describe("buildEventQuery — read policy folded into SQL (finding 4)", () => {
  it("binds the readable-note clause BEFORE the limit param; the owner sees every other event", () => {
    const r = buildEventQuery(WS, {}, { readable: new Set(["n1", "n2"]), others: "all" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    // ws($1), readable ids($2), limit($3) — read policy is a WHERE param, limit last.
    expect(r.params).toEqual([WS, ["n1", "n2"], 100]);
    expect(r.sql).toContain("domain_events.target_type IN ('node','task','canvas') AND domain_events.target_id = ANY($2::text[])");
    expect(r.sql).toContain("OR domain_events.target_type NOT IN ('node','task','canvas')");
    expect(r.sql).toContain("LIMIT $3");
  });

  it("a member sees tag-definition events, their spaces' events and their own events, not everyone's", () => {
    const r = buildEventQuery(WS, {}, { readable: new Set(["n1"]), others: { actorId: "a1", spaceIds: ["s1"], unreadableNoteIds: new Set(["n9"]) } });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.params).toEqual([WS, ["n1"], ["s1"], "a1", ["n9"], 100]);
    expect(r.sql).toContain("domain_events.target_type IN ('tag','collection_view')");
    expect(r.sql).toContain("domain_events.target_type = 'space' AND domain_events.target_id = ANY($3::text[])");
    expect(r.sql).toContain("domain_events.actor_id::text = $4");
    expect(r.sql).not.toMatch(/OR domain_events\.target_type NOT IN \('node','task','canvas'\)\)/);
  });

  it("delegated tokens see ONLY note events (no non-note OR arm)", () => {
    const r = buildEventQuery(WS, {}, { readable: new Set(["n1"]), others: "none" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.sql).toContain("domain_events.target_id = ANY($2::text[])");
    expect(r.sql).not.toContain("NOT IN");
  });

  it("omitting read policy adds no clause (pure builder stays back-compatible)", () => {
    const r = buildEventQuery(WS, {});
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.sql).not.toContain("ANY($");
    expect(r.params).toEqual([WS, 100]);
  });
});

describe("buildEventQuery — validation", () => {
  it("non-numeric since rejected", () => {
    const r = buildEventQuery(WS, { since: "not-a-number" });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error).toMatch(/since/);
  });

  it("negative since rejected (regex only accepts \\d+)", () => {
    const r = buildEventQuery(WS, { since: "-1" });
    expect(r.kind).toBe("error");
  });

  it("invalid actor_type rejected", () => {
    const r = buildEventQuery(WS, { actor_type: "robot" });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error).toMatch(/actor_type/);
  });

  it("valid actor_types accepted", () => {
    for (const t of ["user", "ai_agent", "system"]) {
      const r = buildEventQuery(WS, { actor_type: t });
      expect(r.kind).toBe("ok");
    }
  });
});

describe("buildEventQuery — agent tool calls", () => {
  it("leaves successful read-only tool calls out of the list, params unchanged", () => {
    const r = buildEventQuery(WS, {});
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.sql).toContain("NOT (event_type = 'AGENT_TOOL_CALLED' AND target_id IN ('searchNodes', 'getNode'");
    expect(r.params).toEqual([WS, 100]);
  });

  it("names only registered built-in tools that are not writes", () => {
    const registered = new Set(listTools().map((t) => t.name));
    const writes = ["createNode", "updateNode", "applyTag", "removeTag", "proposeTagPack", "suggestEdit", "commentOnNote"];
    for (const w of writes) expect(READ_ONLY_TOOL_NAMES).not.toContain(w);
    for (const name of registered) {
      if (!writes.includes(name)) expect(READ_ONLY_TOOL_NAMES).toContain(name);
    }
  });
});
