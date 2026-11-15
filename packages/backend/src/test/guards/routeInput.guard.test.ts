// onden/route-input: routes read request input through routes/params.ts.
// The rule sees the syntax tree, so aliases and destructuring are caught too;
// the per-file baseline (route-input-exceptions.json) only shrinks and must be exact.
import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import typescriptParser from "@typescript-eslint/parser";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import routeInput, { isCoveredRouteFile } from "../../../eslint-rules/route-input.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baseline = JSON.parse(readFileSync(join(srcDir, "..", "eslint-rules", "route-input-exceptions.json"), "utf8")).counts as Record<string, number>;

function lint(rel: string, code: string) {
  const linter = new Linter({ cwd: "/repo/packages/backend" });
  return linter.verify(code, [{
    files: ["**/*.ts"],
    languageOptions: { parser: typescriptParser as never },
    plugins: { onden: { rules: { "route-input": routeInput as never } } },
    rules: { "onden/route-input": "error" },
  }], { filename: join("/repo/packages/backend/src", rel) });
}

// An unlisted file allows none, so any use is reported.
const FRESH = "routes/zzFresh.ts";

describe("route-input rule", () => {
  it.each([
    ["body", `router.post("/", async (c) => { await c.req.json(); });`],
    ["body swallowed into {}", `router.post("/", async (c) => { await c.req.json().catch(() => ({})); });`],
    ["path parameter", `router.get("/:id", (c) => c.req.param("id"));`],
    ["all path parameters", `router.get("/:id", (c) => c.req.param());`],
    ["query", `router.get("/", (c) => c.req.query("q"));`],
    ["alias of c.req", `router.get("/", (c) => { const req = c.req; return req.query("q"); });`],
    ["destructured method", `router.get("/", (c) => { const { json } = c.req; return json(); });`],
    ["computed name", `router.get("/", (c) => c.req["param"]("id"));`],
    ["method passed on, not called", `router.get("/", (c) => run(c.req.json));`],
    ["request taken out of the context", `router.get("/", (c) => { const { req } = c; return req.query("q"); });`],
    ["request taken out in the parameter", `router.get("/", ({ req }) => req.param("id"));`],
    ["request renamed in the parameter", `router.get("/", ({ req: r }) => r.json());`],
    ["alias assigned later", `router.get("/", (c) => { let r; r = c.req; return r.json(); });`],
    ["alias of an alias", `router.get("/", (c) => { const a = c.req; const b = a; return b.param("id"); });`],
    ["request handed to a helper", `router.get("/", (c) => helper(c.req));`],
    ["alias handed to a helper", `router.get("/", (c) => { const r = c.req; return helper(r); });`],
    ["queries", `router.get("/", (c) => c.req.queries("tag"));`],
    ["parseBody", `router.post("/", (c) => c.req.parseBody());`],
    ["formData", `router.post("/", (c) => c.req.formData());`],
    ["text", `router.post("/", (c) => c.req.text());`],
  ])("reports %s", (_name, code) => {
    expect(lint(FRESH, code).map((m) => m.ruleId)).toContain("onden/route-input");
  });

  it.each([
    ["the shared readers", `import { readJsonBody, uuidParam } from "./params.js"; router.get("/:id", async (c) => [uuidParam(c, "id"), await readJsonBody(c)]);`],
    ["headers", `router.get("/", (c) => c.req.header("x"));`],
    ["a plain object with json()", `const r = { json() {} }; r.json();`],
    ["an unrelated req elsewhere in the file", `async function other(req: Request) { return req.json(); } router.get("/", (c) => other(new Request("http://x")));`],
    ["a different variable named req in another scope", `const f = () => { const req = makeRequest(); return req.json(); }; router.get("/", (c) => uuidParam(c, "id"));`],
    ["the context itself handed to a helper", `router.get("/", (c) => helper(c));`],
  ])("allows %s", (_name, code) => {
    expect(lint(FRESH, code)).toEqual([]);
  });

  it("covers routes/** and modules/*/routes.ts, not params.ts, services or tests", () => {
    expect(isCoveredRouteFile("routes/nodes.ts")).toBe(true);
    expect(isCoveredRouteFile("modules/rss/routes.ts")).toBe(true);
    expect(isCoveredRouteFile("routes/params.ts")).toBe(false);
    expect(isCoveredRouteFile("services/nodeUpdate.ts")).toBe(false);
    expect(lint("routes/zzFresh.test.ts", `c.req.json();`)).toEqual([]);
  });

  it("the baseline is exactly today's count per file (shrink it when a file migrates)", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []);
    const actual: Record<string, number> = {};
    for (const path of files(srcDir)) {
      const rel = relative(srcDir, path).split(sep).join("/");
      if (!isCoveredRouteFile(rel)) continue;
      // Count under a name the baseline does not list, so every use is reported.
      const n = lint(rel.startsWith("modules/") ? "modules/zzUnlisted/routes.ts" : "routes/zzUnlisted.ts", readFileSync(path, "utf8")).filter((m) => m.ruleId === "onden/route-input").length;
      if (n > 0) actual[rel] = n;
    }
    expect(actual).toEqual(baseline);
  });
});
