// @vitest-environment node
// Guard: import boundaries as an allowlist. eslint.boundaries.config.js lists, per kind of file
// (ui, platform, lib, lib/data, hooks, components, settings, modules/<id>…), the kinds it may import;
// every other import is a violation (eslint-plugin-boundaries, default: "disallow"). Violations that
// exist today are counted per file in scripts/allowlist-baseline.json (rule fe-import-boundaries) and may
// only shrink — an eslint-disable comment is not a way around it (noInlineConfig). See the messages:
//   npm run lint:boundaries
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { checkRule, countByFile } from "../../../../../scripts/allowlistLib.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const RULE_IDS = new Set(["boundaries/element-types", "boundaries/no-unknown-files"]);
const eslint = () => new ESLint({ cwd: ROOT, overrideConfigFile: "eslint.boundaries.config.js" });

function boundaryMessages(results: ESLint.LintResult[]) {
  return results.flatMap((r) => r.messages
    .filter((m) => m.fatal || (m.ruleId && RULE_IDS.has(m.ruleId)))
    .map((m) => ({ file: r.filePath.slice(ROOT.length), message: m.message })));
}

describe("frontend import boundaries", () => {
  it("no file imports a kind of file its kind may not (fe-import-boundaries)", async () => {
    const results = await eslint().lintFiles(["src"]);
    const messages = boundaryMessages(results);
    expect(messages.filter((m) => !m.message.startsWith("No rule allowing")).map((m) => `${m.file}: ${m.message}`)).toEqual([]);
    const result = checkRule("fe-import-boundaries", countByFile(messages.map((m) => m.file)), {
      what: "an import across the layers (see eslint.boundaries.config.js for what this kind of file may import)",
    });
    for (const note of result.notes) console.info(note);
    expect(result.errors.join("\n")).toBe("");
  }, 180_000);
});

// Self-test: virtual files placed in real folders import real files.
describe("the boundary rule catches what it should", () => {
  const lint = async (filePath: string, code: string) => boundaryMessages(await eslint().lintText(code, { filePath: `${ROOT}${filePath}` }));

  it("lib importing a component is a violation", async () => {
    expect(await lint("src/lib/__probe.ts", `import "../components/ModuleLibrary";`)).toHaveLength(1);
  });
  it("lib importing lib and a component importing lib are fine", async () => {
    expect(await lint("src/lib/__probe.ts", `import "./uuid";`)).toEqual([]);
    expect(await lint("src/components/__probe.tsx", `import "../lib/uuid";`)).toEqual([]);
  });
  it("one module importing another module's files is a violation, its own files are fine", async () => {
    expect(await lint("src/modules/tasks/__probe.ts", `import "../daily/index";`)).toHaveLength(1);
    expect(await lint("src/modules/tasks/__probe.ts", `import "./index";`)).toEqual([]);
  });
  // The page book (src/pagebook) is written to leave as a package: it may import itself, components/ui, lib/ink and
  // lib/pdf (React and @onden/markdown are packages). The probes sit in a folder that holds no real file yet.
  it("the page book may import itself, components/ui, lib/ink, lib/pdf and the packages", async () => {
    expect(await lint("src/pagebook/__probe.tsx", `import "react";\nimport "@onden/markdown/ink";\nimport "../components/ui/Button";\nimport "../lib/ink/engine";\nimport "../lib/pdf/pdfjs";\nimport "./__other";`)).toEqual([]);
  });
  it("the page book importing the app's lib, data layer, hooks, components or modules is a violation", async () => {
    expect(await lint("src/pagebook/__probe.tsx", `import "../lib/uuid";`)).toHaveLength(1);
    expect(await lint("src/pagebook/__probe.tsx", `import "../lib/data";`)).toHaveLength(1);
    expect(await lint("src/pagebook/__probe.tsx", `import "../lib/prefs";`)).toHaveLength(1);
    expect(await lint("src/pagebook/__probe.tsx", `import "../hooks/useStableCallback";`)).toHaveLength(1);
    expect(await lint("src/pagebook/__probe.tsx", `import "../components/ModuleLibrary";`)).toHaveLength(1);
  });
  it("components and tests may import the page book; lib/ink and lib/pdf stay ordinary lib for everyone else", async () => {
    expect(await lint("src/components/__probe.tsx", `import "../pagebook/__other";`)).toHaveLength(0);
    expect(await lint("src/lib/__probe.ts", `import "./ink/engine";`)).toEqual([]);
    expect(await lint("src/lib/ink/__probe.ts", `import "../uuid";`)).toEqual([]);
    expect(await lint("src/hooks/__probe.ts", `import "../lib/pdf/pdfjs";`)).toEqual([]);
  });
  it("a file in a folder no kind covers is a violation", async () => {
    expect(await lint("src/__newfolder/probe.ts", `export {};`)).toHaveLength(1);
  });
  it("an eslint-disable comment does not silence it", async () => {
    const msgs = await lint("src/lib/__probe.ts", `// eslint-disable-next-line boundaries/element-types\nimport "../components/ModuleLibrary";`);
    expect(msgs).toHaveLength(1);
  });
});
