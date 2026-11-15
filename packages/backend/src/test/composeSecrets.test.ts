// compose.yaml secret guard. Same spirit as authSecret.test.ts: a built-in
// literal default for a secret is a footgun — a careless `docker compose up`
// with no .env would silently boot a Postgres superuser on a well-known
// password ("onden"), trivially DB-accessible. This pins that the production
// compose REQUIRES the password to be set (`${POSTGRES_PASSWORD:?...}`,
// fail-fast) rather than falling back to any literal, so a future
// "convenience" tweak can't silently reopen the hole.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// src/test -> repo root is four levels up (test, src, backend, packages).
const repoRoot = resolve(here, "../../../..");
const compose = readFileSync(resolve(repoRoot, "compose.yaml"), "utf8");

describe("compose.yaml — no insecure default DB password", () => {
  it("does NOT give POSTGRES_PASSWORD a built-in literal fallback", () => {
    // The vulnerable shape was `${POSTGRES_PASSWORD:-onden}` (or any :-default):
    // an unset var silently resolves to a shipped literal.
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:-/);
  });

  it("requires POSTGRES_PASSWORD via fail-fast substitution", () => {
    // `:?` makes compose abort with an error if the var is unset/empty.
    expect(compose).toMatch(/\$\{POSTGRES_PASSWORD:\?[^}]+\}/);
  });

  it("does not embed the well-known 'onden' password literal anywhere", () => {
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s*onden\b/);
    expect(compose).not.toMatch(/postgres:\/\/onden:onden@/);
  });

  it("threads the required password into DATABASE_URL with no fallback", () => {
    expect(compose).toMatch(
      /DATABASE_URL:\s*postgres:\/\/onden:\$\{POSTGRES_PASSWORD:\?[^}]+\}@/,
    );
  });
});

describe("compose.yaml — the backend gets ONDEN_SECRET_KEY", () => {
  it("passes it through from .env, with no literal fallback", () => {
    // Without this line the key set in .env never reached the backend, so the
    // API way of running AI stayed hidden on a server that had set it.
    expect(compose).toMatch(/^\s+ONDEN_SECRET_KEY:\s*\$\{ONDEN_SECRET_KEY:-\}\s*$/m);
  });
});

describe("compose.yaml — the backend gets the VAPID keys for Web Push", () => {
  it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"])("passes %s through from .env, with no literal fallback", (name) => {
    // Without these lines the keys set in .env never reached the backend, so
    // lock-screen reminders stayed hidden on a server that had set them.
    expect(compose).toMatch(new RegExp(`^\\s+${name}:\\s*\\$\\{${name}:-\\}\\s*$`, "m"));
  });

  it("the example env file lists them, commented out", () => {
    const example = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
    for (const name of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) expect(example).toMatch(new RegExp(`^#${name}=$`, "m"));
  });
});
