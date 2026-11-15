// Repo-level invariant: the open-source claim must be backed by a real
// license declaration. Onden's README + product thesis state the project is
// open-source (AGPL-3.0 since 2026-11-15; MIT before), but without a LICENSE file and a
// package.json `license` field the repo legally reads as all-rights-reserved.
//
// This is a pure filesystem assertion — no DB, no network — so it runs in the
// normal `vitest run` unit pass and can never be flaky. It guards against a
// regression where the legal declaration drifts away from the stated license.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// packages/backend/src/test -> repo root is four levels up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("repo license declaration", () => {
  it("ships a LICENSE file at the repo root", () => {
    const license = readFileSync(resolve(repoRoot, "LICENSE"), "utf8");
    // Non-empty and recognizably a license body, not a placeholder.
    expect(license.trim().length).toBeGreaterThan(200);
    expect(license).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/);
    expect(license).toMatch(/Version 3, 19 November 2007/);
    expect(license).toMatch(/Remote Network Interaction/);
  });

  it("declares the license in the root package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    expect(pkg.license).toBe("AGPL-3.0-only");
  });

  it("keeps package.json, LICENSE, and the README License section in agreement", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const license = readFileSync(resolve(repoRoot, "LICENSE"), "utf8");
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

    // The README ends with a `## License` section naming the license.
    const match = readme.match(/##\s*License\s*\n+([^\n]+)/);
    expect(match, "README must have a ## License section").not.toBeNull();
    expect(match![1]).toContain("AGPL-3.0");
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");

    // Every workspace package says the same thing as the root.
    for (const name of readdirSync(resolve(repoRoot, "packages"))) {
      const sub = JSON.parse(readFileSync(resolve(repoRoot, "packages", name, "package.json"), "utf8"));
      expect(sub.license, `packages/${name}`).toBe(pkg.license);
    }
  });
});
