// Who may mint an api session's identity and who may read a stored API key.
// Like systemActor.guard.test.ts: the list of callers is fixed here, so adding one
// is a visible, reviewed change.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".generated.ts") ? [path] : [];
  });
}
const rel = (file: string) => relative(SRC, file).split(sep).join("/");
const matching = (pattern: RegExp) => sourceFiles(SRC).filter((f) => pattern.test(readFileSync(f, "utf8"))).map(rel).sort();

describe("api runtime guards", () => {
  it("actorForRuntimeSession is used only by the api runtime that runs the session", () => {
    expect(matching(/actorForRuntimeSession/)).toEqual([
      "services/agentRuntime/api/actor.ts",
      "services/agentRuntime/api/prepare.ts",
      "services/agentRuntime/api/run.ts",
    ]);
  });

  it("the plaintext API key is read only inside the api runtime", () => {
    const readers = matching(/\bloadApiKey\b|\bloadService\b|\bopen(?:Stored)?Secret\(\s*"ai-credential"/).filter((f) => f !== "services/aiCredentials.ts");
    expect(readers.every((f) => f.startsWith("services/agentRuntime/api/"))).toBe(true);
    expect(readers.length).toBeGreaterThan(0);
  });

  it("session tokens are minted only by the pull runner's claim and the api actor", () => {
    const mints = matching(/\bcreateToken\(/).filter((f) => !f.startsWith("test/") && f !== "services/agentTokens.ts");
    expect(mints.filter((f) => /sessionId/.test(readFileSync(join(SRC, f), "utf8")))).toEqual([
      "services/agentRuntime/api/actor.ts",
      "services/agentSessions.ts",
    ]);
  });

  it("the spine, not a tool list, keeps a suggest session from writing: mutate() calls assertWriteModeAllows", () => {
    expect(readFileSync(join(SRC, "spine/mutate.ts"), "utf8")).toMatch(/assertWriteModeAllows\(actor, m\.event\.type\)/);
  });

  it("an api session never carries a key: no source logs or returns it", () => {
    // The only module that names the ciphertext column is the credential store (+ its migration).
    expect(matching(/secret_ciphertext/)).toEqual(["services/aiCredentials.ts"]);
  });
});
