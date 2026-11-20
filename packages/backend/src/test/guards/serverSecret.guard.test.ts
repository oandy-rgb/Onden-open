// ONDEN_SECRET_KEY is used in one place: services/serverSecret.ts seals every secret for a purpose and a row.
// A second file that encrypts with the key, reads it, or opens an API key would be a second, unbound mechanism.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".generated.ts") ? [path] : [];
  });
}
const rel = (file: string) => relative(SRC, file).split(sep).join("/");
const matching = (pattern: RegExp) => sourceFiles(SRC).filter((f) => pattern.test(readFileSync(f, "utf8"))).map(rel).sort();

describe("server secret key", () => {
  it("only services/serverSecret.ts encrypts, decrypts or reads the key", () => {
    expect(matching(/\bcreateCipheriv\b|\bcreateDecipheriv\b|aes-\d+-gcm/)).toEqual(["services/serverSecret.ts"]);
    expect(matching(/config\.\w+\(\s*["']ONDEN_SECRET_KEY|process\.env\.ONDEN_SECRET_KEY|env\[["']ONDEN_SECRET_KEY/)).toEqual(["services/serverSecret.ts"]);
  });

  it("each purpose is sealed and opened only by the store that owns its table", () => {
    expect(matching(/(?:sealSecret|openSecret|openStoredSecret)\(\s*"ai-credential"/)).toEqual(["services/aiCredentials.ts"]);
    expect(matching(/(?:sealSecret|openSecret|openStoredSecret)\(\s*"external-calendar"/)).toEqual(["modules/external_calendars/store.ts"]);
    // No call with a purpose chosen at run time.
    expect(matching(/(?:sealSecret|openSecret|openStoredSecret)\(\s*[^"\s)]/).filter((f) => f !== "services/serverSecret.ts")).toEqual([]);
  });
});
