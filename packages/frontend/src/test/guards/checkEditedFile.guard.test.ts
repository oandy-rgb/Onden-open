// @vitest-environment node
// scripts/checkEditedFile.mjs is the PostToolUse hook that checks the one file an agent just wrote against the
// same allowlist rules as allowlist.guard.test.ts. Source text is passed in, so no sample file is written to src/.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../../../../../scripts/allowlistLib.mjs";
import { checkEditedFile, editedFileFromHookInput, locate, run } from "../../../../../scripts/checkEditedFile.mjs";

const fe = (rel: string) => join(root, "packages/frontend/src", rel);
const be = (rel: string) => join(root, "packages/backend/src", rel);
const hook = (file: string) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content: "x" } });

const VIOLATING_TSX = "export const A = () => <button onClick={() => window.scrollTo(0, 0)}>x</button>;\n";
const CLEAN_TSX = "export const A = () => <p>hi</p>;\n";

describe("checkEditedFile", () => {
  it("names the rule, the line and the owner for a window use in components/", async () => {
    const messages = await checkEditedFile(fe("components/Fake.tsx"), { source: VIOLATING_TSX, baseline: {} });
    const text = messages.join("\n");
    expect(text).toContain("fe-platform-global:window");
    expect(text).toContain("第 1 行");
    expect(text).toContain("frontend/src/hooks/"); // from the catalog entry platform-window-document
    expect(text).toContain("fe-native-element:button");
    expect(text).toContain("Button");
  });

  it("catches a literal z-index in a stylesheet and passes a token one", async () => {
    const bad = await checkEditedFile(fe("components/fake.css"), { source: ".a {\n  z-index: 9999;\n}\n", baseline: {} });
    expect(bad.join("\n")).toContain("fe-css-z-index");
    expect(bad.join("\n")).toContain("第 2 行");
    expect(bad.join("\n")).toContain("var(--z-dropdown)"); // from the catalog entry css-z-index-token
    expect(await checkEditedFile(fe("components/fake.css"), { source: ".a { z-index: var(--z-modal); }\n", baseline: {} })).toEqual([]);
  });

  it("passes a clean file, a file inside its baseline, and a file inside an owner", async () => {
    expect(await checkEditedFile(fe("components/Fake.tsx"), { source: CLEAN_TSX, baseline: {} })).toEqual([]);
    const baseline = { "fe-platform-global:window": { "components/Fake.tsx": 1 }, "fe-native-element:button": { "components/Fake.tsx": 1 } };
    expect(await checkEditedFile(fe("components/Fake.tsx"), { source: VIOLATING_TSX, baseline })).toEqual([]);
    expect(await checkEditedFile(fe("lib/fake.ts"), { source: "export const w = () => window.innerWidth;\n", baseline: {} })).toEqual([]);
    expect(await checkEditedFile(fe("components/ui/Fake.tsx"), { source: VIOLATING_TSX, baseline: {} })).toEqual([]);
  });

  it("fails only when the count goes above the baseline", async () => {
    const baseline = { "fe-platform-global:window": { "components/Fake.tsx": 1 } };
    const twice = "export const f = () => [window.a, window.b];\n";
    const messages = await checkEditedFile(fe("components/Fake.tsx"), { source: twice, baseline });
    expect(messages.join("\n")).toContain("2 處，基準 1");
  });

  it("applies the backend rules to a route", async () => {
    const source = 'import { pool } from "../db.js";\nexport const r = () => { console.log(1); return pool.query("select 1"); };\n';
    const text = (await checkEditedFile(be("routes/fake.ts"), { source, baseline: {} })).join("\n");
    expect(text).toContain("be-route-imports");
    expect(text).toContain("be-console");
    expect(text).toContain("be-route-pool-query");
    expect(text).toContain("第 2 行");
  });

  it("skips tests, test helpers, token stylesheets and files outside the two src trees", async () => {
    expect(await checkEditedFile(fe("components/Fake.test.tsx"), { source: VIOLATING_TSX, baseline: {} })).toEqual([]);
    expect(await checkEditedFile(fe("test/guards/helper.ts"), { source: VIOLATING_TSX, baseline: {} })).toEqual([]);
    expect(await checkEditedFile(fe("styles/tokens.css"), { source: ":root { --c: #fff; }\n", baseline: {} })).toEqual([]);
    expect(await checkEditedFile(join(root, "packages/frontend/e2e/x.ts"), { source: VIOLATING_TSX, baseline: {} })).toEqual([]);
    expect(await checkEditedFile(join(root, "docs/x.md"), { source: VIOLATING_TSX, baseline: {} })).toEqual([]);
    expect(locate(join(root, "packages/markdown/src/a.ts"))).toBeNull();
    expect(locate(fe("components/Fake.tsx"))).toEqual({ side: "frontend", rel: "components/Fake.tsx" });
  });

  it("treats a file that no longer exists as clean", async () => {
    expect(await checkEditedFile(fe("components/DoesNotExist.tsx"), { baseline: {} })).toEqual([]);
  });
});

describe("hook input", () => {
  it("reads tool_input.file_path and ignores anything else", () => {
    expect(editedFileFromHookInput(hook("/a/b.ts"))).toBe("/a/b.ts");
    expect(editedFileFromHookInput("not json")).toBeNull();
    expect(editedFileFromHookInput("{}")).toBeNull();
  });

  it("exits 2 with the message on stderr for a violation, 0 and silence otherwise", async () => {
    const bad = await run(hook(fe("components/Fake.tsx")), { source: VIOLATING_TSX, baseline: {} });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("fe-platform-global:window");
    expect(bad.stderr).toContain("不要改 scripts/allowlist-baseline.json");
    expect(await run(hook(fe("components/Fake.tsx")), { source: CLEAN_TSX, baseline: {} })).toEqual({ code: 0, stderr: "" });
    expect(await run("garbage")).toEqual({ code: 0, stderr: "" });
  });

  it("works as the real command: node --import tsx scripts/checkEditedFile.mjs < hook JSON", () => {
    const result = spawnSync("node", ["--import", "tsx", join(root, "scripts/checkEditedFile.mjs")], {
      input: hook(fe("lib/hex.ts")), encoding: "utf8", cwd: root,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
