// @vitest-environment node
// Onden's AI is vendor-neutral (owner decision 2026-11-01): the app's code and its zh-TW and English strings, the markdown
// and site packages never name an AI company, product or model family. The protocol adapter folder (backend, found
// through the catalog entry "ai-protocol-client") is the only exception, so nothing here is exempt.
// The backend half (server messages, .env.example, docs/self-host, changes) is backend/src/test/guards/aiVendorNames.guard.test.ts.
import { describe, expect, it } from "vitest";
import { productFiles, protocolFolder, vendorHits } from "../../../../../scripts/lib/vendorNames.mjs";
import { ZH_TW } from "../../lib/i18n.zh-TW";

const files = ["packages/frontend/src", "packages/markdown/src", "packages/site/src"].flatMap((path) => productFiles(path));

describe("no vendor names in what people read", () => {
  it("no source file of the app, markdown or site names a provider, a product or a model family", () => {
    expect(vendorHits(files, protocolFolder()), "say \"AI\" / \"API key\" / \"MCP client\"").toEqual([]);
  });

  it("no zh-TW value (nor its English key) names one", () => {
    const named = Object.entries(ZH_TW).filter(([key, value]) => /claude|anthropic|openai|chatgpt|gemini|copilot|mistral|llama|ollama|deepseek|qwen|\bgpt|google ai/i.test(`${key} ${value}`));
    expect(named).toEqual([]);
  });

  it("scans real files (the guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(300);
  });
});
