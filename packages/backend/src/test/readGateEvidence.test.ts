// The read gate must see a primitive being USED, not just named (eslint-rules/gateEvidence.js).
import { describe, expect, it } from "vitest";
import { READ_GATE } from "../../eslint-rules/require-read-gate.js";

const { usesGate } = READ_GATE;
const gate = /canReadNode/;

describe("usesGate", () => {
  it("accepts a call, a member call, an argument and a shorthand property", () => {
    expect(usesGate("async function f() { return await canReadNode(actor, id); }", gate)).toBe(true);
    expect(usesGate("const ok = policy.canReadNode(actor, id);", gate)).toBe(true);
    expect(usesGate("rows.filter(canReadNode);", gate)).toBe(true);
    expect(usesGate("const q = `SELECT 1 WHERE ${canReadNode(a)}`;", gate)).toBe(true);
    expect(usesGate("const policy = { canReadNode };", gate)).toBe(true);
  });

  it("does not accept an import, a re-export, a comment, a string, a type or an unused declaration", () => {
    expect(usesGate('import { canReadNode } from "./readPolicy.js";\nexport const x = 1;', gate)).toBe(false);
    expect(usesGate('export { canReadNode } from "./readPolicy.js";', gate)).toBe(false);
    expect(usesGate("// we call canReadNode later\n/* canReadNode */\nexport const x = 1;", gate)).toBe(false);
    expect(usesGate('const note = "canReadNode is checked upstream";', gate)).toBe(false);
    expect(usesGate("type Gate = typeof canReadNode;\nlet canReadNode2: string;", gate)).toBe(false);
    expect(usesGate("function canReadNode() { return true; }", gate)).toBe(false);
    expect(usesGate("export function load(canReadNode: boolean) { return 1; }", gate)).toBe(false);
  });

  it("matches a call-shaped claim only against a call, and an ordered claim in order", () => {
    expect(usesGate("const a = listSources;", /listSources\(/)).toBe(false);
    expect(usesGate("const a = listSources(x);", /listSources\(/)).toBe(true);
    expect(usesGate("canReadNode(a); readableScopeSql(b);", /canReadNode[\s\S]*readableScopeSql/)).toBe(true);
    expect(usesGate("readableScopeSql(b); canReadNode(a);", /canReadNode[\s\S]*readableScopeSql/)).toBe(false);
  });
});
