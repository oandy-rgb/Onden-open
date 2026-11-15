// @vitest-environment node
// Guard: the catalog of single entry points (scripts/entrypoints.catalog.json) is consistent with the code.
// The same data is the allowlist guards' failure text and docs/agents/entrypoints-catalog.md, so it must not rot:
//  - every allowlist rule in scripts/allowlist-baseline.json has an entry, and every rule an entry names exists;
//  - every entry's file and exports exist; every component exported from components/ui has an entry;
//  - every FrontendModule field has a `module-slot:<field>` entry;
//  - every `use` line compiles (TypeScript) or names tokens that exist (CSS);
//  - the generated markdown is current (npm run catalog).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { CATALOG_DOC, CATALOG_DOC_FILE, loadCatalog, renderCatalogMarkdown } from "../../../../../scripts/entrypointsCatalog.mjs";
import { exportsOf } from "../../../../../scripts/lib/tsExports.mjs";
import { repoRoot } from "../../../../../scripts/lib/paths.mjs";
import { readBaseline } from "../../../../../scripts/allowlistLib.mjs";

interface Entry {
  id: string; need: string; area: string; entry: { file: string; exports?: string[] }[];
  use: string; useLang?: "ts" | "css" | "none"; replaces: string; rules: string[]; why: string;
}
const catalog = loadCatalog() as { areas: string[]; entries: Entry[] };
const abs = (rel: string) => join(repoRoot, rel);

describe("catalog data", () => {
  it("every entry is complete and ids are unique", () => {
    const ids = new Set<string>();
    for (const e of catalog.entries) {
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(catalog.areas, `${e.id}: unknown area`).toContain(e.area);
      expect(e.need.length, `${e.id}: need`).toBeGreaterThan(0);
      expect(e.entry.length, `${e.id}: entry`).toBeGreaterThan(0);
      expect(typeof e.why, `${e.id}: why must be a string (empty until a person writes it)`).toBe("string");
      expect(Array.isArray(e.rules), `${e.id}: rules`).toBe(true);
      if (e.useLang === "none") expect(e.use, `${e.id}: useLang none has no use`).toBe("");
      else expect(e.use.length, `${e.id}: use is required (useLang "none" only for folders and config files)`).toBeGreaterThan(0);
    }
  });
});

describe("rules", () => {
  const guardFiles = new Set(["frontend", "backend", "markdown"].flatMap((pkg) => {
    const dir = abs(`packages/${pkg}/src/test/guards`);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".guard.test.ts")).map((f) => f.replace(".guard.test.ts", "")) : [];
  }));
  const named = new Set(catalog.entries.flatMap((e) => e.rules));

  it("every allowlist rule has a catalog entry (so its failure text says what to use)", () => {
    const missing = Object.keys(readBaseline()).filter((rule) => !named.has(rule));
    expect(missing, "add the rule id to the `rules` of the entry that owns the job in scripts/entrypoints.catalog.json").toEqual([]);
  });
  it("every rule an entry names exists", () => {
    const baseline = new Set(Object.keys(readBaseline()));
    const unknown = [...named].filter((r) => (r.startsWith("guard:") ? !guardFiles.has(r.slice(6)) : !baseline.has(r)));
    expect(unknown).toEqual([]);
  });
});

describe("entry points exist", () => {
  it("each file exists and exports each listed name", () => {
    const problems: string[] = [];
    for (const e of catalog.entries) {
      for (const { file, exports } of e.entry) {
        if (!existsSync(abs(file))) { problems.push(`${e.id}: ${file} does not exist`); continue; }
        if (!exports?.length) continue;
        const found = exportsOf(abs(file));
        const have = new Set([...found.values, ...found.types]);
        for (const name of exports) if (!have.has(name)) problems.push(`${e.id}: ${file} does not export ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every component exported from components/ui has an entry", () => {
    const indexFile = "packages/frontend/src/components/ui/index.ts";
    const listed = new Set(catalog.entries.flatMap((e) => e.entry.filter((f) => f.file === indexFile).flatMap((f) => f.exports ?? [])));
    const missing = exportsOf(abs(indexFile)).values.filter((name) => !listed.has(name));
    expect(missing, "add the export to an entry (or a new entry) whose file is components/ui/index.ts").toEqual([]);
  });

  it("every FrontendModule field has a module-slot entry, and no entry names a field that is gone", () => {
    const file = abs("packages/frontend/src/modules/types.ts");
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const fields: string[] = [];
    src.forEachChild((n) => {
      if (ts.isTypeAliasDeclaration(n) && n.name.text === "FrontendModule" && ts.isTypeLiteralNode(n.type)) {
        for (const m of n.type.members) if (m.name && ts.isIdentifier(m.name)) fields.push(m.name.text);
      }
    });
    expect(fields.length).toBeGreaterThan(10);
    const slots = catalog.entries.filter((e) => e.id.startsWith("module-slot:")).map((e) => e.id.slice("module-slot:".length));
    expect(slots.sort()).toEqual([...fields].sort());
  });
});

describe("use examples", () => {
  it("css examples reference tokens that exist", () => {
    const tokens = ["tokens.css", "theme-tokens.css"].map((f) => readFileSync(abs(`packages/frontend/src/styles/${f}`), "utf8")).join("\n");
    for (const e of catalog.entries.filter((x) => x.useLang === "css")) {
      for (const [, name] of e.use.matchAll(/var\((--[\w-]+)\)/g)) expect(tokens, `${e.id}: ${name}`).toContain(`${name}:`);
    }
  });

  // Each ts example is placed as a file in src/ of the package that owns the entry and type-checked there,
  // so the import path, the name and the call shape are the real ones.
  it("ts examples compile", () => {
    const probes = catalog.entries.filter((e) => e.useLang !== "css" && e.useLang !== "none").map((e) => {
      const first = e.entry[0]!.file.match(/^packages\/(frontend|backend|markdown|contract)\//)![1]!;
      return { id: e.id, pkg: first === "markdown" ? "frontend" : first === "contract" ? "backend" : first, text: e.use };
    });
    const problems: string[] = [];
    for (const pkg of ["frontend", "backend"]) {
      const mine = probes.filter((p) => p.pkg === pkg);
      const dir = abs(`packages/${pkg}`);
      const configPath = join(dir, "tsconfig.json");
      const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
      const virtual = new Map(mine.map((p, i) => [join(dir, `src/__catalog_probe_${i}.ts`), p]));
      const options = { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false, composite: false, tsBuildInfoFile: undefined };
      const host = ts.createCompilerHost(options);
      const { fileExists, readFile, getSourceFile } = host;
      host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
      host.readFile = (f) => virtual.get(f)?.text ?? readFile.call(host, f);
      host.getSourceFile = (f, lang, ...rest) => {
        const p = virtual.get(f);
        return p ? ts.createSourceFile(f, p.text, lang) : getSourceFile.call(host, f, lang, ...rest);
      };
      const program = ts.createProgram([...virtual.keys()], options, host);
      for (const [file, p] of virtual) {
        for (const d of program.getSemanticDiagnostics(program.getSourceFile(file)).concat(program.getSyntacticDiagnostics(program.getSourceFile(file)))) {
          problems.push(`${p.id}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
        }
      }
      expect(dirname(configPath)).toBe(dir);
    }
    expect(problems).toEqual([]);
  }, 300_000);
});

describe("generated document", () => {
  it(`${CATALOG_DOC} is what the catalog renders (run npm run catalog)`, () => {
    const current = existsSync(CATALOG_DOC_FILE) ? readFileSync(CATALOG_DOC_FILE, "utf8") : "";
    expect(current === renderCatalogMarkdown(), `${CATALOG_DOC} is out of date: run \`npm run catalog\` at the repo root and commit it`).toBe(true);
  });
});
