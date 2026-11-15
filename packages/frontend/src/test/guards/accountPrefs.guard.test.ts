// Guard for the account-pref scope rule (2026-11-08: a split opened on a desktop reopened on the
// owner's phone). Every createAccountPref spec must say how its value follows the person
// (`follows: "account"` — same on every device; `follows: "deviceKind"` — kept per phone/desktop),
// and the keys the app uses must be the keys the backend's PREF_SCHEMAS accepts (a deviceKind pref
// also needs `<key>.phone` and `<key>.desktop`; the bare key stays accepted as the starting value).
// Failure: add the declaration with a one-line reason, or add the key to services/actorPrefs.ts.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACTOR_PREFS = resolve(SRC, "../../backend/src/services/actorPrefs.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(path, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

type Spec = { file: string; text: string };

/** The `{ … }` argument of every `createAccountPref<…>(` call (comments blanked). */
function specs(): Spec[] {
  const found: Spec[] = [];
  for (const path of walk(SRC)) {
    if (path.endsWith("lib/accountPrefStore.ts")) continue;
    const text = readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "");
    for (const m of text.matchAll(/createAccountPref<[^(]*>\(\s*\{/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      for (; i < text.length && depth > 0; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
      found.push({ file: path.slice(SRC.length + 1), text: text.slice(start, i - 1) });
    }
  }
  return found;
}

const follows = (spec: Spec): string | null => /\bfollows:\s*"(\w+)"/.exec(spec.text)?.[1] ?? null;
const serverKey = (spec: Spec): string => /\bserverKey:\s*"([^"]+)"/.exec(spec.text)![1]!;

/** Top-level keys of PREF_SCHEMAS (two-space indent, as the file is written). */
function backendKeys(): string[] {
  const text = readFileSync(ACTOR_PREFS, "utf8");
  const body = text.slice(text.indexOf("const PREF_SCHEMAS = {"), text.indexOf("} as const;"));
  return [...body.matchAll(/^ {2}"?([\w.]+)"?:/gm)].map((m) => m[1]!).sort();
}

describe("account pref scope (lib/accountPrefStore)", () => {
  it("the scan finds the specs (it reads real files)", () => {
    expect(specs().length).toBeGreaterThan(15);
    expect(backendKeys().length).toBeGreaterThan(15);
  });

  it("every spec declares follows: \"account\" or \"deviceKind\"", () => {
    const bad = specs().filter((s) => !["account", "deviceKind"].includes(follows(s) ?? "")).map((s) => s.file);
    expect(bad, "add `follows: \"account\" | \"deviceKind\"` and a one-line reason (see accountPrefStore header)").toEqual([]);
  });

  it("the app's keys and the backend's PREF_SCHEMAS are the same list", () => {
    const expected = specs().flatMap((s) => (follows(s) === "deviceKind"
      ? [serverKey(s), `${serverKey(s)}.phone`, `${serverKey(s)}.desktop`]
      : [serverKey(s)])).sort();
    expect(backendKeys()).toEqual(expected);
  });
});
