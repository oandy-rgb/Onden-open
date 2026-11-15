// scripts/check-boot-bundle.mjs fails the build when the JS loaded after sign-in
// grows past its budget, or one module brings more than its cap into it.
import { describe, expect, it } from "vitest";
import { bootDeltaLine, checkBootReport, BOOT_BUDGET_GZIP, DEFAULT_MODULE_CAP_GZIP } from "../../scripts/check-boot-bundle.mjs";
import { lateKeysInBoot, ownerOf as pluginOwnerOf, packageOf as pluginPackageOf, staticClosure as pluginClosure } from "../../scripts/bootReportPlugin.mjs";

const report = (modules: Record<string, number>, gzipTotal = BOOT_BUDGET_GZIP - 5_000) => ({
  chunks: ["a.js"],
  rawTotal: gzipTotal * 3,
  gzipTotal,
  modules: Object.fromEntries(Object.entries(modules).map(([id, gzip]) => [id, { raw: gzip * 3, gzip }])),
});

describe("check-boot-bundle", () => {
  it("passes a small boot set", () => {
    expect(checkBootReport(report({ core: BOOT_BUDGET_GZIP - 10_000, tasks: 400, rss: 2_000 }))).toEqual([]);
  });

  it("names the module that is over its cap and says to load it on use", () => {
    const problems = checkBootReport(report({ core: 380_000, kanban: DEFAULT_MODULE_CAP_GZIP + 1_000 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('module "kanban"');
    expect(problems[0]).toContain("lazyWithReload");
    expect(problems[0]).toContain("src/modules/kanban/index");
  });

  it("gives a module that is not listed the default cap, and a listed one its own", () => {
    expect(checkBootReport(report({ brand_new: DEFAULT_MODULE_CAP_GZIP + 1 }))).toHaveLength(1);
    expect(checkBootReport(report({ review: 2_800 }))).toEqual([]);
    expect(checkBootReport(report({ review: 2_800 }), { caps: {}, fallbackCap: 2_000 })).toHaveLength(1);
  });

  it("fails over the total budget and names the largest module shares", () => {
    const problems = checkBootReport(report({ core: 500_000, review: 2_500, rss: 2_000 }, BOOT_BUDGET_GZIP + 1));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("over its budget");
    expect(problems[0]).toContain("review");
  });

  it("does not hold the shell's own code (core) to a module cap", () => {
    expect(checkBootReport(report({ core: 450_000 }))).toEqual([]);
  });

  it("refuses the Markdown parser in the boot JS (a pure helper in a module that imports it brings it along)", () => {
    const problems = checkBootReport({ ...report({ core: 300_000 }), packages: ["react-dom", "unified", "micromark", "remark-wiki-link"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unified, micromark");
  });

  it("refuses the board library and d3 in the boot JS, whatever the size", () => {
    const problems = checkBootReport({ ...report({ core: 300_000 }), packages: ["react-dom", "@xyflow/system", "d3-zoom"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@xyflow/system, d3-zoom");
    expect(problems[0]).toContain("import type");
    expect(checkBootReport({ ...report({ core: 300_000 }), packages: ["react-dom", "fuse.js"] })).toEqual([]);
  });
});

describe("bootReportPlugin", () => {
  it("counts a file for the module directory it is in, else for core", () => {
    expect(pluginOwnerOf("/repo/packages/frontend/src/modules/rss/RssScreen.tsx")).toBe("rss");
    expect(pluginOwnerOf("/repo/packages/frontend/src/modules/index.ts")).toBe("core");
    expect(pluginOwnerOf("/repo/packages/frontend/src/components/App.tsx")).toBe("core");
  });

  it("names the npm package a file comes from, scoped or not", () => {
    expect(pluginPackageOf("/repo/node_modules/@xyflow/system/dist/esm/index.js")).toBe("@xyflow/system");
    expect(pluginPackageOf("/repo/node_modules/d3-zoom/src/zoom.js")).toBe("d3-zoom");
    expect(pluginPackageOf("/repo/packages/frontend/src/hooks/useGraphLayout.ts")).toBeNull();
  });

  it("follows static imports only", () => {
    const chunk = (imports: string[], dynamicImports: string[] = []) => ({ type: "chunk", imports, dynamicImports });
    const bundle = { "entry.js": chunk(["shared.js"], ["lazy.js"]), "shared.js": chunk([]), "lazy.js": chunk([]) };
    expect([...pluginClosure(bundle, ["entry.js"])].sort()).toEqual(["entry.js", "shared.js"]);
  });
});

describe("late zh-TW dictionary", () => {
  const late = '  "Only in a screen": "只在畫面裡",\n  "Used at boot": "開機就用",\n  "It\'s quoted": "有引號",\n';
  it("names the late keys a boot chunk holds as a string literal", () => {
    const bundle = { "a.js": { code: 'x(t("Used at boot"));y("It\'s quoted")' } };
    expect(lateKeysInBoot(bundle, ["a.js"], late)).toEqual(["Used at boot", "It's quoted"]);
  });
  it("passes when the boot chunks only hold the boot half", () => {
    expect(lateKeysInBoot({ "a.js": { code: 't("Something else")' } }, ["a.js"], late)).toEqual([]);
  });
});

describe("bootDeltaLine", () => {
  it("says how far a build is from main and from the budget", () => {
    expect(bootDeltaLine(100_000, { measured: 100_000, budget: 105_120 })).toBe("boot JS vs main (97.7 KiB): ±0.0 KiB; room left 5.0 KiB");
    expect(bootDeltaLine(99_000, { measured: 100_000, budget: 105_120 })).toMatch(/: -1\.0 KiB; room left 6\.0 KiB$/);
  });
  it("asks for a reason over +1 KiB and for a slimming round under 1.5 KiB of room", () => {
    const line = bootDeltaLine(104_000, { measured: 100_000, budget: 105_120 });
    expect(line).toContain("+3.9 KiB");
    expect(line).toContain("say why in the PR description");
    expect(line).toContain("the next slimming round is due");
  });
});
