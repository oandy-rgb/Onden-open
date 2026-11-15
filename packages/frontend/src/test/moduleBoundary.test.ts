// The shell reaches modules only through modules/index.ts, so deleting a
// module directory and its registry line removes the feature whole. A core
// file that imports a module's own file (modules/rss/…) breaks that.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_MODULES, MODULES, MODULE_SCREENS, NOTE_COMMANDS, VIEW_MODULES, isModuleScreen, noteCommandModule } from "../modules";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendModules = join(src, "../../backend/src/modules");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "modules" || name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("module boundary", () => {
  it("no core file imports a module's own files", () => {
    const offenders = sourceFiles(src).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
      return imports.filter((spec) => /(^|\/)modules\/[^/]+/.test(spec)).map((spec) => `${relative(src, file)} → ${spec}`);
    });
    expect(offenders).toEqual([]);
  });

  // Core reads module behaviour from the registry (noteHeaderAction,
  // sitePublisher, generatedSourceTypes…), never by naming a module: a quoted
  // module id in a core file is a feature welded into the shell (W7). lib/api.ts
  // holds the wire types (source_type "rss" is data), lib/pendingWriteTargets.ts
  // decodes wire paths (/api/rss/… is one, D45) and the i18n files hold
  // translation keys.
  // The view modules' ids (calendar, kanban, gallery) are also the layout
  // names a saved view stores, so components/collections/ — which renders the
  // layouts — names them as data (docs/architecture/views-as-modules.md).
  // "graph" is the built-in graph module and also the Graph place's view id
  // (`setMode("graph")`, `?view=graph`, the palette and nav entries), which core
  // names as data; it is always on, so nothing asks whether it is.
  // "capture" is also the `?capture=1` URL parameter (BuilderApp reads it as data; the
  // module is always on, so nothing asks whether it is).
  // Four ids are also plain data elsewhere: "canvas" is a node type and a
  // lens, "table" the type of a base block and the old ?lens=table link,
  // "daily" the day template's id and a repeat label, "tasks" the bootstrap's
  // `tasks` array and the /api/tasks path (modules/tasks). Core may write those
  // strings as data, but never to ask whether the module is on: the whiteboard,
  // day notes and tasks are shell features (lib/shellFeatures) the modules declare.
  // "ai" is also the info panel's tab id, a note's `source_type`, the default role handle and the
  // AI label's hint: data. Core asks whether AI is on only through the ai shell feature (useAiEnabled).
  // "handwriting" is also an InkKind (@onden/markdown INK_KINDS: which drawing a history row is about): data.
  const DATA_IDS = new Set(["canvas", "table", "daily", "tasks", "graph", "capture", "ai", "handwriting"]);
  const ASKS_IF_ON = /\b(isImported|isModuleImported|useModuleFilter|moduleFilterFor|moduleInUse|moduleEntry|moduleId|modules[?!]?\.(?:includes|has|some))\b/;

  /** Whether a line of core code names `id` as a module id: a quoted id for
   *  most modules; for a DATA_IDS id only when the line also asks whether a
   *  module is on or names it as a module. */
  function namesModule(line: string, id: string): boolean {
    if (!new RegExp(`["'\`]${id}["'\`]`).test(line)) return false;
    return !DATA_IDS.has(id) || ASKS_IF_ON.test(line);
  }

  it("tells a data value from a module check for the ids core also uses as data", () => {
    // What the rule must catch (the old CANVAS_MODULE / DAILY_MODULE checks, spelled out)…
    expect(namesModule('const on = isImported("canvas");', "canvas")).toBe(true);
    expect(namesModule('if (!modules.includes("daily")) return;', "daily")).toBe(true);
    expect(namesModule('<ModuleNotImported moduleId="canvas" />', "canvas")).toBe(true);
    expect(namesModule('const imported = moduleInUse("table", data);', "table")).toBe(true);
    expect(namesModule('const on = isImported("rss");', "rss")).toBe(true);
    expect(namesModule('const on = isImported("tasks");', "tasks")).toBe(true);
    // …and what is data.
    expect(namesModule('n.node_type === "canvas"', "canvas")).toBe(false);
    expect(namesModule('{ type: "table", rows }', "table")).toBe(false);
    expect(namesModule('tpl.id === "daily"', "daily")).toBe(false);
    expect(namesModule('setMode("tasks")', "tasks")).toBe(false);
  });

  it("no core file names a module id", () => {
    const ids = [...MODULES, ...BUILT_IN_MODULES].map((m) => m.id);
    const allowed = new Set(["lib/api.ts", "lib/pendingWriteTargets.ts", "lib/i18n.zh-TW.ts", "lib/i18n.zh-TW.boot.ts", "lib/i18n.zh-TW.late.ts", "lib/i18n.ts"]);
    const offenders = sourceFiles(src).flatMap((file) => {
      const rel = relative(src, file);
      if (allowed.has(rel) || /\.test\.tsx?$/.test(rel)) return [];
      const named = rel.startsWith("components/collections/") ? ids.filter((id) => !VIEW_MODULES.some((mod) => mod.id === id)) : ids;
      return readFileSync(file, "utf8").split("\n").flatMap((line, index) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return [];
        return named.filter((id) => namesModule(line, id)).map((id) => `${rel}:${index + 1} names "${id}"`);
      });
    });
    expect(offenders).toEqual([]);
  });

  it("every frontend module (but a frontend-only built-in one) has a backend module of the same id", () => {
    const ids = [...MODULES, ...BUILT_IN_MODULES.filter((m) => !m.frontendOnly)].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(existsSync(join(backendModules, id, "index.ts")), id).toBe(true);
  });

  it("module screens are views and note commands know their module", () => {
    for (const id of MODULE_SCREENS.keys()) expect(isModuleScreen(id)).toBe(true);
    expect(isModuleScreen("notes")).toBe(false);
    for (const { moduleId, command } of NOTE_COMMANDS) expect(noteCommandModule(command)).toBe(moduleId);
  });
});
