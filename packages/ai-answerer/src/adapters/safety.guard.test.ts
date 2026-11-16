// Guard: the flags that keep the AI tool harmless cannot be removed or loosened without failing here.
// The note a question comes from is untrusted; these flags are what make its instructions harmless
// to this computer (owner rule 2026-11-15).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAFETY_FLAGS, claudeArgs } from "./claudeCode.mjs";

const args = claudeArgs({ configFile: "/x/mcp.json", system: "S" });
const pair = (flag: string, value: string) => args.some((a, i) => a === flag && args[i + 1] === value);

describe("claude code safety flags", () => {
  it("every guarantee is present", () => {
    expect(Object.keys(SAFETY_FLAGS).sort()).toEqual(["noBuiltInTools", "noPersonalSettings", "nothingKept", "onlyOurMcpServers", "onlyOurMcpTools"]);
    expect(pair("--tools", "")).toBe(true);
    expect(pair("--setting-sources", "")).toBe(true);
    expect(pair("--allowedTools", "mcp__onden")).toBe(true);
    expect(pair("--mcp-config", "/x/mcp.json")).toBe(true);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
  });
  it("nothing loosens them", () => {
    for (const bad of ["--dangerously-skip-permissions", "--permission-mode", "--add-dir", "--allow-dangerously-skip-permissions", "--disallowedTools", "--settings", "--plugin-dir", "--continue", "--resume"]) {
      expect(args, bad).not.toContain(bad);
    }
    expect(args.filter((a) => a === "--allowedTools")).toHaveLength(1);
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
  });
  it("the adapter source starts the tool without a shell and from its own empty directory", () => {
    const source = readFileSync(new URL("./claudeCode.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/shell\s*:\s*true/);
    expect(source).not.toMatch(/\bexec\(|execSync|spawnSync/);
    expect(source).toMatch(/cwd: work/);
    expect(source).toMatch(/startsWith\("ONDEN_"\)/);
  });
});
