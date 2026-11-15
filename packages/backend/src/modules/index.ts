// The module registry — the ONE place index.ts touches modules.
//
// A module is a directory under src/modules/<id>/ that exports a
// ModuleDefinition (see types.ts + README.md). Adding a capability =
// the directory + one entry in MODULES below; removing it = delete both.
// No dynamic loading, no manifest scanning — a boring, greppable list.

import type { Hono, MiddlewareHandler } from "hono";
import type { ActorCtx } from "../types.js";
import type { ModuleDefinition } from "./types.js";
import { registerTool, gateCoreAgentTools } from "../services/agentTools/index.js";
import { registerOutboxEffect } from "../services/outbox.js";
import { functionInUse, registerFunctionId } from "../services/functionRefs.js";
import { registerRetrievalSource, type RetrievalSource } from "../services/retrievalSources.js";
import { registerNoteViewLayout, registerViewLayout } from "../services/viewLayouts.js";
import { registerPublicSite } from "../services/publicSite.js";
import { registerNodeHooks } from "../spine/nodeHooks.js";
import { registerPersonalTables, registerShippedModule } from "../services/moduleCatalog.js";
import { registerLibraryModule, workspaceHasModule, ModuleNotImportedError } from "../services/workspaceModules.js";
import type { AgentTool } from "../services/agentTools/index.js";
import type { NodeHooks } from "../spine/nodeHooks.js";
import { q, getWorkspaceId } from "../db.js";
import { log } from "../logger.js";
import { reviewModule } from "./review/index.js";
import { rssModule } from "./rss/index.js";
import { semanticModule } from "./semantic/index.js";
import { websiteModule } from "./website/index.js";
import { canvasModule } from "./canvas/index.js";
import { skillsModule } from "./skills/index.js";
import { slidesModule } from "./slides/index.js";
import { handwritingModule } from "./handwriting/index.js";
import { tableViewModule } from "./table/index.js";
import { calendarViewModule } from "./calendar/index.js";
import { kanbanViewModule } from "./kanban/index.js";
import { galleryViewModule } from "./gallery/index.js";
import { dailyModule } from "./daily/index.js";
import { tasksModule } from "./tasks/index.js";
import { importersModule } from "./importers/index.js";
import { captureModule } from "./capture/index.js";
import { aiModule } from "./ai/index.js";
import { externalCalendarsModule } from "./external_calendars/index.js";

export type { ModuleDefinition, ModuleApp } from "./types.js";

export const MODULES: ModuleDefinition[] = [
  reviewModule,
  rssModule,
  semanticModule,
  websiteModule,
  canvasModule,
  skillsModule,
  slidesModule,
  handwritingModule,
  tableViewModule,
  calendarViewModule,
  kanbanViewModule,
  galleryViewModule,
  dailyModule,
  tasksModule,
  importersModule,
  captureModule,
  aiModule,
  externalCalendarsModule,
];

/** Called once by index.ts after the core routers are mounted. Mounts every
 *  module's routes and feeds its optional agentTools
 *  into the existing registry (which keeps its own duplicate guard). */
export function mountModules(
  app: Hono<{ Variables: { actor: ActorCtx | null } }>,
  modules: ModuleDefinition[] = MODULES,
  // DB-free unit tests stub the import check; the app always uses the default.
  { moduleImported }: { moduleImported?: ModuleImportedCheck } = {},
): void {
  const seen = new Set<string>();
  for (const mod of modules) {
    if (seen.has(mod.id)) throw new Error(`[modules] duplicate module id: ${mod.id}`);
    seen.add(mod.id);
    if (mod.library) {
      const gate = moduleWriteGate(mod, moduleImported);
      for (const prefix of mod.routePrefixes ?? []) app.use(prefix, gate).use(`${prefix}/*`, gate);
    }
    mod.registerRoutes(app);
    registerModuleEffects(mod);
  }
}

/** What a module contributes besides routes: agent tools, outbox effects, its
 *  tag function and its node hooks. mountModules calls it; test harnesses
 *  that mount routers directly call it for the shipped modules. Repeat calls
 *  with the same module are no-ops. */
/** The tag-function ids a module gives tags: its own id when it is a
 *  `tagFunction`, then its `tagFunctions`. The frontend lists the same ids
 *  (test/moduleDefinitionsAlign.test.ts). */
export function moduleTagFunctionIds(mod: ModuleDefinition): string[] {
  return [...(mod.tagFunction ? [mod.id] : []), ...(mod.tagFunctions ?? [])];
}

export function registerModuleEffects(mod: ModuleDefinition): void {
  registerShippedModule(mod.id);
  registerPersonalTables(mod.personalTables ?? []);
  for (const tool of mod.agentTools ?? []) registerTool(onlyWhenImported(mod, tool));
  for (const effect of mod.outboxEffects ?? []) registerOutboxEffect(effect);
  if (mod.viewLayout) registerViewLayout(mod.id, mod.viewLayout);
  if (mod.noteViewLayout) registerNoteViewLayout(mod.id);
  if (mod.retrievalSource) registerRetrievalSource(retrievalWhenImported(mod));
  if (mod.publicSite) registerPublicSite(mod.publicSite);
  for (const id of moduleTagFunctionIds(mod)) registerFunctionId(id);
  if (mod.nodeHooks) registerNodeHooks(mod.id, hooksWhenImported(mod));
  if (mod.gatesCoreAgentTools) gateCoreAgentTools((workspaceId) => imported(mod, workspaceId));
  if (mod.library) registerLibraryModule(mod.id, mod.library.moduleTag, { confirmOnce: mod.library.confirmOnce, alwaysOn: Boolean(mod.viewLayout) || mod.library.alwaysOn === true, requires: mod.library.requires, whenTurnedOn: mod.library.whenTurnedOn });
}

// ── A library module only acts where it is on ─────────────────────────────
// Turning a module off used to hide only its entry points: its
// agent tools still ran (an agent could publish the site with 網站 removed)
// and its node hooks still fired (an `_published` change still redeployed).
// The gate lives here, once, instead of in each module. Modules without
// `library` would be infrastructure that always acts (none ships today;
// semantic search became a library module on 2026-10-18). Its routes
// under `routePrefixes` refuse writes but keep serving reads, since removing a
// module keeps its data (docs/architecture/module-library.md).

async function imported(mod: ModuleDefinition, workspaceId: string): Promise<boolean> {
  return !mod.library || workspaceHasModule(workspaceId, mod.id);
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether this request's workspace has imported `mod`. */
export type ModuleImportedCheck = (mod: ModuleDefinition) => Promise<boolean>;

const importedHere: ModuleImportedCheck = async (mod) => imported(mod, await getWorkspaceId());

/** Middleware for a library module's route prefixes: a write answers 409
 *  `module_not_imported` while the workspace hasn't imported the module.
 *  Reads never consult the check. */
export function moduleWriteGate(mod: ModuleDefinition, isImported: ModuleImportedCheck = importedHere): MiddlewareHandler {
  return async (c, next) => {
    if (WRITE_METHODS.has(c.req.method) && !mod.readOnlyPosts?.test(c.req.path) && !(await isImported(mod))) {
      return c.json({ error: "module_not_imported", module: mod.id }, 409);
    }
    await next();
  };
}

// One wrapper per tool and per module, so registering again stays a no-op.
const gatedTools = new WeakMap<AgentTool, AgentTool>();

/** The tool, refusing with ModuleNotImportedError where the module is not imported. */
function onlyWhenImported(mod: ModuleDefinition, tool: AgentTool): AgentTool {
  if (!mod.library) return tool;
  const cached = gatedTools.get(tool);
  if (cached) return cached;
  const gated: AgentTool = {
    ...tool,
    available: async (workspaceId) => (await tool.available?.(workspaceId) ?? true) && imported(mod, workspaceId),
    handler: async (args, ctx) => {
      if (!(await imported(mod, ctx.workspaceId))) throw new ModuleNotImportedError(mod.id);
      return tool.handler(args, ctx);
    },
  };
  gatedTools.set(tool, gated);
  return gated;
}

const gatedSources = new WeakMap<ModuleDefinition, RetrievalSource>();

/** The module's retrieval source, empty in workspaces that have not imported it. */
function retrievalWhenImported(mod: ModuleDefinition): RetrievalSource {
  const source = mod.retrievalSource!;
  const cached = gatedSources.get(mod);
  if (cached) return cached;
  const gated: RetrievalSource = async (workspaceId, text, opts) =>
    (await imported(mod, workspaceId)) ? source(workspaceId, text, opts) : [];
  gatedSources.set(mod, gated);
  return gated;
}

const gatedHooks = new WeakMap<ModuleDefinition, NodeHooks>();

/** The module's node hooks, skipped in workspaces that have not imported it. */
function hooksWhenImported(mod: ModuleDefinition): NodeHooks {
  const hooks = mod.nodeHooks!;
  if (!mod.library || mod.nodeHooksWhenOff) return hooks;
  const cached = gatedHooks.get(mod);
  if (cached) return cached;
  // Every key, so a hook kind added later is gated too, never dropped.
  const gated: NodeHooks = {};
  for (const [kind, fn] of Object.entries(hooks) as [keyof NodeHooks, NodeHooks[keyof NodeHooks]][]) {
    if (!fn) continue;
    const run = fn as (change: { workspaceId: string }) => Promise<void>;
    (gated as Record<string, unknown>)[kind] = async (change: { workspaceId: string }) => {
      if (await imported(mod, change.workspaceId)) await run(change);
    };
  }
  gatedHooks.set(mod, gated);
  return gated;
}

/** First library run (boot, after migrate): a workspace that predates the
 *  agreement record (modules_confirmed IS NULL, migration 133) counts a
 *  confirm-once module it already uses as agreed, so the upgrade never turns
 *  off an RSS feed, a published site or semantic search that was working.
 *  Everything else needs no record: built-in functions are on unless turned
 *  off. A new workspace starts with an empty record. Idempotent: only NULL
 *  rows are touched. */
export async function backfillModuleImports(
  { modules = MODULES, workspaceId }: { modules?: ModuleDefinition[]; workspaceId?: string } = {},
): Promise<void> {
  // `workspaceId` limits the run to one workspace (tests share one database).
  const workspaces = (await q<{ id: string }>(
    `SELECT id FROM workspaces WHERE modules_confirmed IS NULL AND ($1::uuid IS NULL OR id = $1)`, [workspaceId ?? null],
  )).rows;
  for (const { id } of workspaces) {
    const agreed: string[] = [];
    for (const mod of modules) {
      if (mod.library?.confirmOnce && await libraryInUse(mod, id)) agreed.push(mod.id);
    }
    await q(`UPDATE workspaces SET modules_confirmed = $2::jsonb WHERE id = $1 AND modules_confirmed IS NULL`, [id, JSON.stringify(agreed)]);
    log.info("modules", `workspace ${id}: ${agreed.length ? `already using ${agreed.join(", ")}` : "no confirm-once module in use"} (first library run)`);
  }
}

/** Boot every module's background loop. Called once from index.ts's
 *  NODE_ENV !== "test" bootstrap, alongside startOutboxReconciler — module
 *  timers never run under vitest. */
export function startModuleBackground(modules: ModuleDefinition[] = MODULES): void {
  for (const mod of modules) mod.startBackground?.();
}

/** A module's own `library.inUse`, else — for a module that gives tags an
 *  ability — whether a tag provides it. */
export function libraryInUse(mod: ModuleDefinition, workspaceId: string): Promise<boolean> {
  if (mod.library?.inUse) return mod.library.inUse(workspaceId);
  return mod.tagFunction ? functionInUse(workspaceId, mod.id) : Promise.resolve(false);
}
