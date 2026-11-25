import { describe, expect, it } from "vitest";
import { MEMORY_MAX, unitText } from "./service.mjs";

describe("systemd unit", () => {
  it("names the key file's path, caps memory, restarts, and quotes odd paths", () => {
    const text = unitText({ nodePath: "/usr/bin/node", cliPath: "/home/a b/cli.mjs", server: "https://n.example.com", keyFile: "/home/a b/100%/key", tool: "codex", toolCommand: "/usr/local/bin/codex" });
    expect(text).toContain(`MemoryMax=${MEMORY_MAX}`);
    expect(text).toContain("Restart=always");
    expect(text).toContain('ExecStart="/usr/bin/node" "/home/a b/cli.mjs" "run" "--server" "https://n.example.com" "--key-file" "/home/a b/100%%/key" "--tool" "codex" "--tool-command" "/usr/local/bin/codex"');
    expect(text).not.toMatch(/ondt_/);
  });
});
