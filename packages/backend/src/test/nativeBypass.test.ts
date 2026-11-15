// The native-origin admin bypass is a known footgun: Origin is forgeable, so
// honouring it on a routable production backend grants admin to anyone. This
// test pins the security property — it is FORCE-DISABLED in production
// regardless of the flag — so a future "convenience" tweak can't silently
// reopen the hole.

import { describe, it, expect } from "vitest";
import { nativeBypassEnabled, nativeBypassState } from "../nativeBypass.js";

describe("nativeBypassEnabled — native-origin admin bypass gate", () => {
  it("is force-disabled in production EVEN with ALLOW_NATIVE_BYPASS=1 (the footgun)", () => {
    expect(nativeBypassEnabled({ NODE_ENV: "production", ALLOW_NATIVE_BYPASS: "1" })).toBe(false);
  });

  it("is disabled in production with no flag", () => {
    expect(nativeBypassEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("is enabled in development when the flag is set explicitly", () => {
    expect(nativeBypassEnabled({ NODE_ENV: "development", ALLOW_NATIVE_BYPASS: "1" })).toBe(true);
  });

  it("is disabled in development without the flag (must opt in)", () => {
    expect(nativeBypassEnabled({ NODE_ENV: "development" })).toBe(false);
  });

  it("is enabled under test so the in-process Hono harness can drive admin routes", () => {
    expect(nativeBypassEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("treats unset NODE_ENV as non-production: the flag governs", () => {
    expect(nativeBypassEnabled({})).toBe(false);
    expect(nativeBypassEnabled({ ALLOW_NATIVE_BYPASS: "1" })).toBe(true);
  });
});

describe("nativeBypassState — what the owner's roster says about it", () => {
  it("is off_production in production, even with the flag", () => {
    expect(nativeBypassState({ NODE_ENV: "production", ALLOW_NATIVE_BYPASS: "1" })).toBe("off_production");
  });
  it("is on under test or with the flag outside production, off otherwise", () => {
    expect(nativeBypassState({ NODE_ENV: "test" })).toBe("on");
    expect(nativeBypassState({ NODE_ENV: "development", ALLOW_NATIVE_BYPASS: "1" })).toBe("on");
    expect(nativeBypassState({ NODE_ENV: "development" })).toBe("off");
  });
});
