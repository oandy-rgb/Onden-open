// Pure unit tests for opaqueMediaName — the unguessable media-key minter.
//
// Why this matters: GET /api/media/* is DELIBERATELY public (anonymous
// visitors render images embedded in published pages — see index.ts
// isPublicRead), so authentication does not gate reads. The on-disk key is
// therefore the ONLY barrier against cross-user enumeration. The previous
// scheme, `${Date.now()}-${originalName}`, was guessable: a known upload time
// plus filename reconstructs another user's URL. These tests pin the security
// properties of the replacement (opaque, high-entropy, no leaked metadata).
//
// No DB — runs in the plain (non-integration) suite.

import { describe, it, expect } from "vitest";
import { opaqueMediaName } from "../services/mediaStore.js";

describe("opaqueMediaName", () => {
  it("preserves the extension verbatim (GET route maps ext → Content-Type)", () => {
    expect(opaqueMediaName(".webp").endsWith(".webp")).toBe(true);
    expect(opaqueMediaName(".pdf").endsWith(".pdf")).toBe(true);
    expect(opaqueMediaName(".svg").endsWith(".svg")).toBe(true);
  });

  it("does not embed a timestamp or the original filename (no guessable metadata)", () => {
    // The old scheme was `${Date.now()}-${name}`. A fresh key must contain
    // neither a recent epoch-ms run nor any caller-supplied basename.
    const name = opaqueMediaName(".webp");
    const stem = name.replace(/\.[^.]+$/, "");
    // No 13-digit epoch-ms prefix (the leaky part of the old format).
    expect(stem).not.toMatch(/^\d{13}-/);
    // Stem is pure lowercase hex from randomBytes — never an original name.
    expect(stem).toMatch(/^[0-9a-f]+$/);
  });

  it("carries at least 128 bits of entropy in the stem", () => {
    // randomBytes(16) → 32 hex chars. Anything materially shorter would be
    // brute-forceable given the public GET surface.
    const stem = opaqueMediaName(".png").replace(/\.[^.]+$/, "");
    expect(stem.length).toBeGreaterThanOrEqual(32);
  });

  it("is collision-free across many mints (random, not sequential)", () => {
    const N = 5000;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) seen.add(opaqueMediaName(".webp"));
    expect(seen.size).toBe(N);
  });

  it("two calls with identical inputs yield different keys (unpredictable)", () => {
    expect(opaqueMediaName(".webp")).not.toBe(opaqueMediaName(".webp"));
  });
});
