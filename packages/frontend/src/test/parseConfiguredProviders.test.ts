import { describe, it, expect } from "vitest";
import { parseConfiguredProviders } from "../lib/auth-client";

describe("parseConfiguredProviders", () => {
  it("returns the configured known providers in canonical order", () => {
    expect(parseConfiguredProviders({ providers: ["google", "github"] })).toEqual(["github", "google"]);
  });

  it("returns [] for an empty / missing list", () => {
    expect(parseConfiguredProviders({ providers: [] })).toEqual([]);
    expect(parseConfiguredProviders({})).toEqual([]);
  });

  it("drops unknown provider ids", () => {
    expect(parseConfiguredProviders({ providers: ["github", "facebook", "twitter"] })).toEqual(["github"]);
  });

  it("dedupes repeated ids", () => {
    expect(parseConfiguredProviders({ providers: ["github", "github"] })).toEqual(["github"]);
  });

  it("tolerates garbage payloads without throwing", () => {
    expect(parseConfiguredProviders(null)).toEqual([]);
    expect(parseConfiguredProviders(undefined)).toEqual([]);
    expect(parseConfiguredProviders("nope")).toEqual([]);
    expect(parseConfiguredProviders({ providers: "github" })).toEqual([]);
    expect(parseConfiguredProviders({ providers: [1, true, null, "google"] })).toEqual(["google"]);
  });
});
