// The account-preference keys the app uses and the ones this server accepts are
// two hand-kept lists (frontend createAccountPref `serverKey`, services/actorPrefs
// PREF_SCHEMAS). A key typed wrong on the app side would only fail at run time with
// a 404 unknown_pref, and a key added here without the app using it is dead weight.
// Reading the frontend source keeps the two from drifting without a shared package.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PREF_KEYS } from "../services/actorPrefs.js";

const FRONTEND_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../frontend/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** The `serverKey: "…"` of every createAccountPref call in the app (frontend test/guards/accountPrefs.guard.test.ts checks the same from its side). */
function frontendPrefKeys(): string[] {
  return sourceFiles(FRONTEND_SRC)
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/serverKey:\s*"([^"]+)"(,\s*follows:\s*"deviceKind")?/g)]
      // A `follows: "deviceKind"` pref is kept once per kind of screen (`<key>.phone`, `<key>.desktop`);
      // the bare key stays accepted as the value each kind starts from.
      .flatMap((m) => (m[2] ? [m[1]!, `${m[1]}.phone`, `${m[1]}.desktop`] : [m[1]!])))
    .sort();
}

describe("account preference keys", () => {
  it("the app finds some (the scan reads real files)", () => {
    expect(frontendPrefKeys().length).toBeGreaterThan(5);
  });

  it("every key the app writes is one the server accepts", () => {
    const unknown = frontendPrefKeys().filter((key) => !(PREF_KEYS as string[]).includes(key));
    expect(unknown, "add the key to PREF_SCHEMAS (services/actorPrefs.ts) or fix the typo").toEqual([]);
  });

  it("every key the server accepts is used by the app, once", () => {
    const used = frontendPrefKeys();
    expect(used.filter((key, i) => used.indexOf(key) !== i), "two prefs share one server key").toEqual([]);
    expect([...PREF_KEYS].filter((key) => !used.includes(key)), "a key no createAccountPref uses: remove it or use it").toEqual([]);
  });
});
