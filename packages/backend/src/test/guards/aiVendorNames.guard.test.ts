// Onden's AI is vendor-neutral (owner decision 2026-11-01): product code, the server's messages, .env.example,
// compose.yaml, docs/self-host/, changes/ and the README never name an AI company, product or model family
// (nor start a model id with one: `claude-`, `gpt-`, `gemini-`). Strict allowlist: the only place that may is the
// protocol adapter folder, and it is whatever folder the catalog entry "ai-protocol-client" points at.
import { describe, expect, it } from "vitest";
import { productFiles, protocolFolder, vendorHits } from "../../../../../scripts/lib/vendorNames.mjs";

const SCOPE = ["packages/backend/src", ".env.example", "compose.yaml", "docs/self-host", "changes", "README.md"];
const files = SCOPE.flatMap((path) => productFiles(path));

describe("no vendor names in what people read", () => {
  it("nothing outside the protocol folder names a provider, a product or a model family", () => {
    expect(vendorHits(files, protocolFolder()), "say \"AI\" / \"API key\" / \"MCP client\"; a wire format by its path (/v1/messages)").toEqual([]);
  });

  it("the protocol folder is the catalog's entry and does hold the names (the guard is not vacuous)", () => {
    expect(protocolFolder()).toBe("packages/backend/src/services/agentRuntime/api/protocols/");
    expect(vendorHits(files).some((hit) => hit.startsWith(protocolFolder()))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });
});
