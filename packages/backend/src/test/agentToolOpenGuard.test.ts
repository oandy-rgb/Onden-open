// Source-level guard for the registerTool / open-authority hole (blind-audit #2).
//
// An agent's capability is meant to be exactly its enumerable tool list — never a
// privilege. `open` is the spine's authority escape hatch, legitimate ONLY for
// INTERNAL cascade machinery (fieldDefaults / templateExpander / tagHierarchy),
// which is safe because it runs downstream of an already-authorized mutation. An
// agent tool that declared authority:{kind:"open"} for its OWN write would bypass
// the authority layer entirely and defeat the capability gate.
//
// A pure RUNTIME gate can't cleanly separate a tool's own `open` from the `open`
// of the cascade machinery a LEGITIMATE tool triggers — tools call dispatchTagApply
// / applyFieldDefaults directly, in the same async context — so any context flag
// that blocks the former also breaks the latter (verified: it broke applyTag /
// removeTag). This is therefore a source-level guard, in the same spirit as
// spineEventGate / readGuard ("no eslint — this test IS the gate"): agent-tool
// implementations must not reference kind:"open". registry.ts already flags
// registering a tool as a security decision; module-contributed agent tools must
// be reviewed against this same rule.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, "../services/agentTools");

describe("agent tools never use 'open' authority (capability gate, blind-audit #2)", () => {
  const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));

  it("has agent-tool files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no agent-tool source declares kind:\"open\" authority", () => {
    const offenders = files.filter((f) =>
      /kind\s*:\s*["']open["']/.test(readFileSync(join(toolsDir, f), "utf-8")),
    );
    expect(
      offenders,
      `agent tools must declare a real authority (node/role/principal_admin), never 'open': ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
