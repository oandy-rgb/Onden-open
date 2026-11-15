// BETTER_AUTH_SECRET resolution. Two jobs, both pinned here:
//   1. SECURITY guard — the dev fallback secret lives in the source, so any
//      deployment still explicitly running on it accepts forged session
//      cookies. Production REFUSES that well-known value (same shape as
//      nativeBypass.test.ts: a future "convenience" tweak can't reopen it).
//   2. ONBOARDING — zero-config self-host (`docker compose up`, no .env) must
//      NOT throw on first boot. When unset in production we auto-generate a
//      strong random secret once and persist it to the content volume, so
//      newcomers get past first boot and sessions survive restarts.

import { describe, it, expect } from "vitest";
import { resolveAuthSecret, type AuthSecretStore } from "../auth.js";

// In-memory store so the test never touches the real filesystem.
function memStore(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const store: AuthSecretStore = {
    read: (p) => files.get(p) ?? null,
    write: (p, v) => {
      files.set(p, v);
      writes.push(v);
    },
  };
  return { store, files, writes };
}

const FILE = "/app/packages/backend/content/.auth-secret";

describe("resolveAuthSecret — security guard", () => {
  it("throws in production when the secret IS the well-known dev fallback", () => {
    const { store } = memStore();
    expect(() =>
      resolveAuthSecret(
        { NODE_ENV: "production", BETTER_AUTH_SECRET: "dev-secret-change-in-production" },
        store,
        FILE,
      ),
    ).toThrow(/forgeable/);
  });

  it("returns an explicitly-configured secret in production", () => {
    const { store } = memStore();
    expect(
      resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "a-real-secret" }, store, FILE),
    ).toBe("a-real-secret");
  });

  it("falls back to the dev secret outside production (zero-config local boot)", () => {
    const { store } = memStore();
    expect(resolveAuthSecret({ NODE_ENV: "development" }, store, FILE)).toBe(
      "dev-secret-change-in-production",
    );
    expect(resolveAuthSecret({}, store, FILE)).toBe("dev-secret-change-in-production");
  });
});

describe("resolveAuthSecret — zero-config production onboarding", () => {
  it("does NOT throw when BETTER_AUTH_SECRET is unset in production", () => {
    const { store } = memStore();
    expect(() => resolveAuthSecret({ NODE_ENV: "production" }, store, FILE)).not.toThrow();
  });

  it("auto-generates a strong random secret and persists it on first boot", () => {
    const { store, writes, files } = memStore();
    const secret = resolveAuthSecret({ NODE_ENV: "production" }, store, FILE);
    // 32 random bytes -> 64 hex chars; clearly not the dev fallback.
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe("dev-secret-change-in-production");
    expect(writes).toEqual([secret]);
    expect(files.get(FILE)).toBe(secret);
  });

  it("reads back the persisted secret on later boots (sessions survive restart)", () => {
    const existing = "f".repeat(64);
    const { store, writes } = memStore({ [FILE]: existing });
    const secret = resolveAuthSecret({ NODE_ENV: "production" }, store, FILE);
    expect(secret).toBe(existing);
    expect(writes).toEqual([]); // no re-generation when one is already persisted
  });

  it("treats an empty-string secret as unset and auto-generates", () => {
    const { store } = memStore();
    const secret = resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "" }, store, FILE);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });
});
