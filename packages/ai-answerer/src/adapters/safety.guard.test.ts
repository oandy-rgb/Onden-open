// Guard: the flags and isolation guarantees that keep every AI CLI adapter harmless cannot be removed or
// loosened without failing here. The note a question comes from is untrusted; these guarantees are what
// make its instructions harmless to this computer (owner rule 2026-11-15).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideAcpPermission, isOndenMcpPermissionRequest } from "./acp.mjs";
import { ANTIGRAVITY_SAFETY_FLAGS, antigravityArgs } from "./antigravity.mjs";
import { SAFETY_FLAGS, claudeArgs } from "./claudeCode.mjs";
import { CODEX_SAFETY_FLAGS, codexArgs, codexConfigToml } from "./codex.mjs";
import { COPILOT_DENIED_TOOLS, COPILOT_SAFETY_FLAGS, copilotArgs } from "./copilot.mjs";
import { GEMINI_EXCLUDED_BUILTIN_TOOLS, GEMINI_SAFETY_FLAGS, geminiArgs, geminiSettingsJson } from "./gemini.mjs";

const pair = (list: readonly string[], flag: string, value: string) => list.some((a, i) => a === flag && list[i + 1] === value);

describe("claude code safety flags", () => {
  const args = claudeArgs({ configFile: "/x/mcp.json", system: "S" });
  it("every guarantee is present", () => {
    expect(Object.keys(SAFETY_FLAGS).sort()).toEqual(["noBuiltInTools", "noPersonalSettings", "nothingKept", "onlyOurMcpServers", "onlyOurMcpTools"]);
    expect(pair(args, "--tools", "")).toBe(true);
    expect(pair(args, "--setting-sources", "")).toBe(true);
    expect(pair(args, "--allowedTools", "mcp__onden")).toBe(true);
    expect(pair(args, "--mcp-config", "/x/mcp.json")).toBe(true);
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
});

describe("codex safety flags", () => {
  const args = codexArgs();
  const toml = codexConfigToml({ mcpUrl: "https://n.example/api/mcp/protocol", sessionKey: "ondt_KEY", instructionsFile: "/x/system.md" });

  it("every guarantee is present", () => {
    expect(Object.keys(CODEX_SAFETY_FLAGS).sort()).toEqual(["jsonOutput", "noGitNeeded", "nonInteractive", "nothingKept", "promptFromStdin", "readOnlySandbox"]);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--ephemeral");
    expect(pair(args, "--sandbox", "read-only")).toBe(true);
    expect(args).toContain("--skip-git-repo-check");
    expect(args.at(-1)).toBe("-");
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain("shell_tool = false");
    expect(toml).toContain("[mcp_servers.onden]");
    expect(toml).toContain("required = true");
  });
  it("nothing loosens them", () => {
    for (const bad of ["--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--yolo", "--add-dir", "workspace-write", "danger-full-access", "--search"]) {
      expect(args, bad).not.toContain(bad);
      expect(toml, bad).not.toContain(bad);
    }
  });
});

describe("gemini safety flags", () => {
  const args = geminiArgs();
  const settings = JSON.parse(geminiSettingsJson("https://n.example/api/mcp/protocol", "ondt_KEY"));

  it("every guarantee is present", () => {
    expect(Object.keys(GEMINI_SAFETY_FLAGS).sort()).toEqual(["headlessFromStdin", "jsonOutput", "noExtensions", "onlyOurMcpServer"]);
    expect(pair(args, "-p", "")).toBe(true);
    expect(pair(args, "--output-format", "json")).toBe(true);
    expect(pair(args, "--allowed-mcp-server-names", "onden")).toBe(true);
    expect(pair(args, "--extensions", "none")).toBe(true);
    expect(settings.tools.core).toEqual([]);
    expect(settings.coreTools).toEqual([]);
    expect(settings.tools.exclude).toEqual([...GEMINI_EXCLUDED_BUILTIN_TOOLS]);
    expect(settings.excludeTools).toEqual([...GEMINI_EXCLUDED_BUILTIN_TOOLS]);
    expect(settings.mcp.allowed).toEqual(["onden"]);
    expect(Object.keys(settings.mcpServers)).toEqual(["onden"]);
    expect(settings.general.sessionRetention.enabled).toBe(false);
  });
  it("nothing loosens them", () => {
    for (const bad of ["--yolo", "-y", "--approval-mode", "--include-directories", "--resume", "--sandbox=false"]) {
      expect(args, bad).not.toContain(bad);
    }
  });
});

describe("copilot safety flags", () => {
  const args = copilotArgs();

  it("every guarantee is present", () => {
    expect(Object.keys(COPILOT_SAFETY_FLAGS).sort()).toEqual(["acpMode", "noAutoUpdate", "noBuiltInMcps", "noBuiltInTools", "noCustomInstructions"]);
    expect(args).toContain("--acp");
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).toContain("--no-custom-instructions");
    expect(args).toContain("--no-auto-update");
    for (const tool of COPILOT_DENIED_TOOLS) {
      expect(args).toContain(`--deny-tool=${tool}`);
    }
  });
  it("nothing loosens them", () => {
    for (const bad of ["--allow-all", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--yolo", "--add-dir"]) {
      expect(args, bad).not.toContain(bad);
    }
  });
});

describe("antigravity & ACP fail-closed safety guarantees", () => {
  it("launches in ACP mode with sandbox, no default customizations, zero client capabilities and only our MCP server", () => {
    expect(Object.keys(ANTIGRAVITY_SAFETY_FLAGS).sort()).toEqual([
      "acpSubcommand", "clientCapabilities", "noDefaultCustomizations", "noTelemetry", "onlyOurMcpServer", "sandbox", "standaloneArgs",
    ]);
    const agyArgs = antigravityArgs("/usr/local/bin/agy");
    expect(agyArgs).toEqual(["acp", "--sandbox", "--include-default-customizations=false", "--disable-telemetry"]);
    for (const bad of ["--dangerously-skip-permissions", "--add-dir"]) {
      expect(agyArgs, bad).not.toContain(bad);
    }
    expect(antigravityArgs("/opt/agy/agy_acp_server.par")).toEqual([]);
    expect(ANTIGRAVITY_SAFETY_FLAGS.clientCapabilities).toEqual({});
    expect(ANTIGRAVITY_SAFETY_FLAGS.onlyOurMcpServer).toBe("onden");
  });

  it("ACP permission gate allows ONLY Onden MCP calls and rejects every built-in or foreign tool", () => {
    const options = [
      { optionId: "allow-1", kind: "allow_once" },
      { optionId: "reject-all", kind: "reject_always" },
      { optionId: "reject-1", kind: "reject_once" },
    ];
    // Allowed: our MCP server via _meta or explicit prefix (including real agy 1.5.16 `mcp_onden_<tool>`)
    expect(decideAcpPermission({ toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "onden", tool: "getNode" } } }, options }))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow-1" } });
    expect(decideAcpPermission({ toolCall: { name: "mcp_onden_getNode", title: "Run mcp_onden_getNode" }, options }))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow-1" } });
    expect(decideAcpPermission({ toolCall: { title: "onden/searchNodes" }, options }))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow-1" } });
    expect(decideAcpPermission({ toolCall: { title: "mcp__onden__suggestEdit" }, options }))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow-1" } });

    // Denied: built-in shell/file/web tools, unknown tools, and other MCP servers
    for (const bad of [
      { toolCall: { title: "shell", kind: "execute" }, options },
      { toolCall: { title: "read_file", rawInput: { path: "/etc/passwd" } }, options },
      { toolCall: { _meta: { is_mcp_tool_call: true, mcp: { server: "github", tool: "push" } } }, options },
      { toolCall: { title: "onden_evil_prefix_without_separator" }, options },
      { toolCall: {}, options },
    ]) {
      expect(isOndenMcpPermissionRequest(bad), JSON.stringify(bad)).toBe(false);
      expect(decideAcpPermission(bad), JSON.stringify(bad)).toEqual({ outcome: { outcome: "selected", optionId: "reject-all" } });
    }
    expect(isOndenMcpPermissionRequest({})).toBe(false);
    expect(decideAcpPermission({})).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("adapter source hygiene (all adapters)", () => {
  const files = ["./claudeCode.mjs", "./codex.mjs", "./gemini.mjs", "./copilot.mjs", "./antigravity.mjs", "./acp.mjs", "./mcpProxy.mjs", "./runtime.mjs"];
  it("never uses shell: true, exec(), execSync, or spawnSync", () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/shell\s*:\s*true/);
      expect(source, file).not.toMatch(/\bexec\(|execSync|spawnSync/);
    }
  });
  it("every adapter runs from its own empty working directory and strips ONDEN_*", () => {
    for (const file of ["./claudeCode.mjs", "./codex.mjs", "./gemini.mjs", "./copilot.mjs", "./antigravity.mjs"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toMatch(/cwd:\s*work/);
    }
    const runtime = readFileSync(new URL("./runtime.mjs", import.meta.url), "utf8");
    const claude = readFileSync(new URL("./claudeCode.mjs", import.meta.url), "utf8");
    expect(runtime).toMatch(/startsWith\("ONDEN_"\)/);
    expect(claude).toMatch(/startsWith\("ONDEN_"\)/);
  });
});
