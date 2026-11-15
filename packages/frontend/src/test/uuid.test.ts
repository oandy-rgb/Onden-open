import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, installUuidPolyfill } from "../lib/uuid";

// Regression: crypto.randomUUID is secure-context-only and absent on a LAN-IP
// HTTP self-host (the phone-dogfood case), where it broke every mutation. The
// fallback must produce a spec-shaped v4 UUID from getRandomValues (which IS
// available in insecure contexts) and the polyfill must fill the missing global.

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID — insecure-context-safe v4", () => {
  const native = crypto.randomUUID;
  afterEach(() => {
    // restore whatever the realm started with
    Object.defineProperty(crypto, "randomUUID", { value: native, configurable: true, writable: true });
  });

  it("returns a valid v4 UUID when the native API exists", () => {
    expect(randomUUID()).toMatch(V4);
  });

  it("falls back to getRandomValues when crypto.randomUUID is absent", () => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    const id = randomUUID();
    expect(id).toMatch(V4);
  });

  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomUUID()));
    expect(ids.size).toBe(200);
  });

  it("installUuidPolyfill fills a missing global so crypto.randomUUID() works", () => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    installUuidPolyfill();
    expect(typeof crypto.randomUUID).toBe("function");
    expect(crypto.randomUUID()).toMatch(V4);
  });

  it("installUuidPolyfill is a no-op when the native API is present", () => {
    const before = crypto.randomUUID;
    installUuidPolyfill();
    expect(crypto.randomUUID).toBe(before);
  });
});
