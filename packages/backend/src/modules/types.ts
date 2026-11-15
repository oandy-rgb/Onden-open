import type { ModuleTagSpec } from "../services/workspaceModules.js";
import type { Hono } from "hono";
import type { ActorCtx } from "../types.js";
import type { AgentTool } from "../services/agentTools/index.js";
import type { OutboxEffect } from "../services/outbox.js";
import type { NodeHooks } from "../spine/nodeHooks.js";
import type { RetrievalSource } from "../services/retrievalSources.js";
import type { ViewLayoutSpec } from "../services/viewLayouts.js";
import type { PublicSite } from "../services/publicSite.js";

/** The app shape modules mount onto — same Variables as index.ts's `app`,
 *  so module routes read the resolved actor via c.get("actor") exactly like
 *  the routes/ files do. */
export type ModuleApp = Hono<{ Variables: { actor: ActorCtx | null } }>;

/** A module = one directory under src/modules/<id>/ + one entry in
 *  modules/index.ts. Deliberately boring: no dynamic loading, no sandboxing,
 *  no lifecycle hooks — those stay deferred (see modules/README.md). The win
 *  is cohesion: everything a capability owns lives in its directory and the
 *  whole thing is deletable in one commit.
 */
export type ModuleDefinition = {
  /** Stable id; also the conventional /api/<id> route prefix. */
  id: string;
  /** Mount the module's HTTP routes. Called once at startup by
   *  mountModules(app). Routes obey the same rules as routes/ files:
   *  requireActor() at the boundary, every mutation through spine mutate(),
   *  every list read bounded by readableNodeIdSet. */
  registerRoutes: (app: ModuleApp) => void;
  /** MCP tools this module contributes to the agent capability surface.
   *  Registered into services/agentTools/registry — which IS the agent
   *  permission boundary, so adding a tool here is a security decision. */
  agentTools?: AgentTool[];
  /** External effects this module enqueues on the outbox (services/outbox).
   *  Each `perform` must be idempotent — delivery is at-least-once. Intents of a
   *  removed module stay pending until it is registered again. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outboxEffects?: OutboxEffect<any>[];
  /** Tables of per-person progress this module keeps, keyed by `actor_id`
   *  (review states, seen articles). Removing a member deletes their rows
   *  (routes/actors.ts), for every shipped module whether imported or not. */
  personalTables?: string[];
  /** What runs when a note's content or attributes change
   *  (spine/nodeHooks): content hooks inside the write transaction,
   *  attribute hooks after commit. */
  nodeHooks?: NodeHooks;
  /** True when the module can be switched on per tag through
   *  `tag_schema.behaviour.modules.<id>.enabled` (PATCH /api/tags/:id/modules).
   *  The module itself decides membership with isTagModuleEnabled. */
  tagFunction?: boolean;
  /** The built-in agent tools (searchNodes, getNode, updateNode…, registered by
   *  services/agentTools/registry itself) are offered and callable only where this
   *  module is on. One module sets it: ai. */
  gatesCoreAgentTools?: boolean;
  /** Tag functions beyond the module itself, by their own ids. Each is a switch in
   *  `behaviour.modules.<id>` like `tagFunction`, and acts only while this
   *  module is on. */
  tagFunctions?: readonly string[];
  /** This module is a saved-view layout (table, kanban…): its id is the layout
   *  name a tag's views store. Registered into services/viewLayouts, which
   *  validates a view's layout and finds the view module tags. */
  viewLayout?: ViewLayoutSpec;
  /** This module adds a view to a note's tab row (its id is the layout name a
   *  note's stored view takes), drawn from the note itself — the slides'
   *  「簡報」. Not a tag layout; the module must be on to add one. */
  noteViewLayout?: true;
  /** Notes this module adds to the AI harness's retrieval after the keyword
   *  matches (semantic search). Skipped in workspaces that have not imported it. */
  retrievalSource?: RetrievalSource;
  /** The published site as the core reads it (media the site shows, a note
   *  rendered as the site would). One module provides it: the website. */
  publicSite?: PublicSite;
  /** The node hooks run even where the module is off. Only for hooks that can
   *  never add anything: the website's re-push after a takedown must still happen
   *  (a note marked 「不發布」 or trashed leaves the static copy) when the owner has
   *  turned the module off; it only removes, and never publishes on its own. */
  nodeHooksWhenOff?: true;
  /** Optional background loop bootstrap (timers/schedulers). Called once by
   *  startModuleBackground() from the server bootstrap — NEVER under
   *  NODE_ENV=test, mirroring startOutboxReconciler/startTaskScheduler. A
   *  module's periodic work must still ride the outbox (file intents here,
   *  let the reconciler perform them) — no third rails. */
  startBackground?: () => void;
  /** The path prefixes this module's routes live under (e.g. "/api/rss").
   *  For a library module, writes there (POST/PUT/PATCH/DELETE) answer 409
   *  `module_not_imported` while the workspace hasn't imported it; reads stay
   *  open, because removing a module keeps its data. Leave it out when the
   *  routes share a prefix with core or public pages (the website at /api). */
  routePrefixes?: string[];
  /** POSTs under those prefixes that write nothing (asking a service whether a key works) and so stay open while the
   *  module is off: the page that turns the module on needs them first. Full request paths. */
  readOnlyPosts?: RegExp;
  /** Listed in the module library: a built-in function that is on in every
   *  workspace unless the owner turned it off (docs/architecture/module-library.md).
   *  `inUse` answers whether a workspace already relies on the module; for a
   *  `confirmOnce` module the first library run counts that as the owner's
   *  agreement, so an upgrade never takes away something in use. Left
   *  out, a module with `tagFunction` is in use once a tag provides it
   *  (moduleTagExists). Modules without `library` (infrastructure) are always on. */
  library?: {
    /** Modules this one needs: it is on only while they are all on (skills need
     *  ai). Turning one of them off takes this module's features away without
     *  touching its data; turning this one on while a requirement is off is refused. */
    requires?: readonly string[];
    inUse?: (workspaceId: string) => Promise<boolean>;
    /** Runs inside the transaction of the owner turning the module on (not when it
     *  is already on): durable work only, an outbox intent, so it commits or rolls
     *  back with the switch (semantic search starts indexing the notes already there). */
    whenTurnedOn?: (workspaceId: string) => Promise<void>;
    /** The module spends money, reaches outside websites or publishes to the
     *  web, so it is on only after the owner agrees once (semantic search,
     *  RSS, the website). The agreement is stored per workspace and never
     *  asked again, even if the module is turned off and on. */
    confirmOnce?: boolean;
    /** Always on, with no switch: a way of looking at notes that holds no
     *  data of its own to hide (the whiteboard). A module with `viewLayout` is
     *  one already; this is for one that is not a tag layout. */
    alwaysOn?: boolean;
    /** A module with a tag of its own has a module tag (tag_schema.module =
     *  the module id): #複習 for review, whose ability other tags get by
     *  extending it. Importing
     *  the module creates it from `template` or adopts a tag named like it
     *  (or like a legacy name). `name` is the default when the client sends
     *  none; the client sends it in the interface language. */
    moduleTag?: ModuleTagSpec;
  };
};
