// The licence policy's rule (scripts/licenceLib.mjs) and the real check on this repo (scripts/thirdPartyNotices.mjs --check).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allows } from "../../../../../scripts/licenceLib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const policy = {
  allowed: ["MIT", "Apache-2.0", "Zlib"],
  conditional: { "LGPL-3.0-or-later": { how: "", packages: ["@img/sharp-*"] }, "Public Domain": { how: "", packages: ["jsonify"] } },
};

describe("licence policy", () => {
  it.each([
    ["MIT", "x", true],
    ["GPL-2.0-only", "x", false],
    ["UNLICENSED", "x", false],
    ["SEE LICENSE IN LICENSE.txt", "x", false],
    // OR: one side is enough. AND: every side must hold.
    ["(MIT OR GPL-3.0-or-later)", "x", true],
    ["GPL-2.0-only OR MIT", "x", true],
    ["(MIT AND Zlib)", "x", true],
    ["MIT AND GPL-2.0-only", "x", false],
    ["Apache-2.0 AND LGPL-3.0-or-later AND MIT", "@img/sharp-wasm32", true],
    ["(MIT OR Apache-2.0) AND (GPL-2.0-only OR Zlib)", "x", true],
    ["(MIT OR Apache-2.0) AND GPL-2.0-only", "x", false],
    // A licence with conditions holds only for the packages it names.
    ["LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64", true],
    ["LGPL-3.0-or-later", "some-other-lgpl-package", false],
    ["Apache-2.0 AND LGPL-3.0-or-later", "some-other-lgpl-package", false],
    // A name that is not an SPDX id is matched whole.
    ["Public Domain", "jsonify", true],
    ["Public Domain", "x", false],
    // Broken expressions are refused.
    ["", "x", false],
    ["(MIT", "x", false],
    ["MIT OR", "x", false],
  ])("%s for %s → %s", (licence, name, expected) => {
    expect(allows(policy, licence, name)).toBe(expected);
  });

  it("this repo passes: shipped packages, files kept in the repo, our own packages, and the notices file", () => {
    expect(execFileSync("node", ["scripts/thirdPartyNotices.mjs", "--check"], { cwd: ROOT, encoding: "utf8" })).toContain("notices:check 通過");
  });
});
