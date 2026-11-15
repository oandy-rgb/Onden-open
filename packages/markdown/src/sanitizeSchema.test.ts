// The one sanitize schema (W38c) decides what HTML survives in a rendered note
// on every surface — the app, the published site and the exports. It used to
// exist twice, held equal by a drift test; now a change to it shows up here as
// a snapshot diff to review deliberately (`npx vitest run -u` after checking
// the change is meant), plus the security properties stated outright.

import { describe, expect, it } from "vitest";
import { sanitizeSchema } from "./sanitizeSchema.js";

describe("the sanitize schema", () => {
  it("matches the reviewed snapshot", () => {
    expect(sanitizeSchema).toMatchSnapshot();
  });

  it("allows no script, style or event-handler attribute anywhere", () => {
    expect(sanitizeSchema.tagNames).not.toContain("script");
    expect(sanitizeSchema.tagNames).not.toContain("style");
    for (const [tag, attrs] of Object.entries(sanitizeSchema.attributes ?? {})) {
      for (const attr of attrs ?? []) {
        const name = Array.isArray(attr) ? String(attr[0]) : String(attr);
        expect(name, `${tag}[${name}]`).not.toMatch(/^on|^style$/i);
      }
    }
  });

  it("holds <video poster> to the same protocol allowlist as src", () => {
    expect(sanitizeSchema.protocols?.poster).toEqual(sanitizeSchema.protocols?.src);
    expect(sanitizeSchema.protocols?.poster).not.toContain("javascript");
  });

  it("lets data: through on src only (inline media), never on href", () => {
    expect(sanitizeSchema.protocols?.src).toContain("data");
    expect(sanitizeSchema.protocols?.href ?? []).not.toContain("data");
    expect(sanitizeSchema.protocols?.href ?? []).not.toContain("javascript");
  });
});
