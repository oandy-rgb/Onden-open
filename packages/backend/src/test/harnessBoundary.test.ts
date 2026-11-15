// Onden's only model call is the `api` AI runtime: the server calls the model with the
// owner's own API key, and only there (decision 2026-10-30, docs/agents/decisions-ai-collaboration.md).
// It speaks plain HTTP through services/agentRuntime/api/protocols/; no model SDK is imported anywhere,
// so a second, ungoverned path (global key, default model, direct writes) cannot creep back in.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..");
const API_RUNTIME_DIR = "services/agentRuntime/api/";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

const importers = (pattern: RegExp) => sourceFiles(SRC)
  .filter((file) => pattern.test(readFileSync(file, "utf8")))
  .map((file) => relative(SRC, file).split(sep).join("/"));

describe("harness boundary", () => {
  it("no model SDK is imported by the backend", () => {
    expect(importers(/from ["'](?:@anthropic-ai\/|openai["'/]|@google\/|@google-ai\/|@mistralai\/|ollama["'])/)).toEqual([]);
  });

  it("the server reaches a model service only from the api runtime directory", () => {
    const callers = importers(/\b(?:fetch\(|detectProtocol\(|protocolClient\()/)
      .filter((file) => file.startsWith("services/agentRuntime/") && !file.startsWith(API_RUNTIME_DIR));
    expect(callers).toEqual([]);
  });

  it("the protocol folder is the api runtime's own (the guard is not vacuous)", () => {
    expect(importers(/\bprotocolClient\(/).some((file) => file.startsWith(`${API_RUNTIME_DIR}protocols/`))).toBe(true);
  });
});
