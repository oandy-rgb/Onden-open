// Node commit hooks — how a module reacts to a note changing without core
// write paths naming it. Core calls the two functions below; modules register
// what runs (modules/index.ts mountModules). With no module registered, a
// write simply has no extra effect.

import type { ActorCtx } from "../types.js";
import { log } from "../logger.js";
import { inTransaction, withSavepoint } from "../db.js";

export type NodeContentCommit = {
  workspaceId: string;
  nodeId: string;
  /** Title and body as plain text, the way a reader would search them. */
  text: string;
  triggeredByEventId?: string;
  /** The body alone, when the write has one (a body edit does): what a rule about a blank note reads. */
  markdown?: string;
  /** Who made the change, when the write has one (a body edit does; the derived
   *  writes of a new note or a tag rename do not). */
  actor?: ActorCtx;
};

export type NodeAttributeCommit = {
  workspaceId: string;
  nodeId: string;
  key: string;
  /** The value the attribute now holds; null when it was removed. */
  value: string | null;
  actor: ActorCtx;
};

/** Which notes may leave the server through a space switch changed: notes
 *  moved between spaces, or a space's publish / external_ai / backup switch
 *  turned on or off. */
export type SpaceAudienceCommit = {
  workspaceId: string;
  actor: ActorCtx;
};

/** Notes moved to the trash or brought back (services/nodeTrash.ts, and the
 *  event-history undo of either). `nodeIds` includes a trashed subtree. */
export type NodeLifecycleCommit = {
  workspaceId: string;
  actor: ActorCtx;
  nodeIds: string[];
  change: "trashed" | "restored";
};

/** Notes whose public visibility a committed change may have moved (hidden,
 *  promoted): emitted by mutate() for a mutation that declares them. */
export type NodeVisibilityCommit = {
  workspaceId: string;
  actor: ActorCtx;
  nodeIds: string[];
};

/** Site settings (the workspace's Site Config) a committed change moved: the
 *  keys whose value actually changed. Emitted by updateWorkspaceConfig. */
type SiteConfigCommit = {
  workspaceId: string;
  actor: ActorCtx;
  changedKeys: string[];
};

/** An explicit attribute write about to be stored (setNodeAttribute). */
export type NodeAttributeWrite = {
  workspaceId: string;
  nodeId: string;
  key: string;
  /** The value the write would store ("" for an empty one). */
  value: string;
  actor: ActorCtx;
};

/** A stored snapshot of the workspace, already without the notes deleted for good. */
export type NodeSnapshotPurge = { workspaceId: string; payload: Record<string, unknown> };

export type NodeHooks = {
  /** A permanent delete (services/purgedContent.ts forgetNodesInSnapshots) has
   *  taken the notes out of a stored publish snapshot; edit `payload` in place
   *  to make whatever else of their text a module froze inert (the website's
   *  excerpts and table cells that quote a title). Runs INSIDE the purge's
   *  transaction; a throw rolls the purge back, since a failed scrub must not
   *  leave a deleted note's title behind. */
  snapshotPurged?: (change: NodeSnapshotPurge) => Promise<void>;
  /** Runs INSIDE the transaction of an explicit attribute write (the
   *  attribute route, a note created with values, a module's own route),
   *  under the workspace's event lock, BEFORE the value is stored. Throw to
   *  refuse the write (an AttributeWriteError answers with its status and
   *  code): the one place a module keeps a rule on one of its keys, such as
   *  a unique key. Derived writes (inline `key:: value`,
   *  frontmatter, imports, copies) do not pass through it. */
  attributeWriting?: (change: NodeAttributeWrite) => Promise<void>;
  /** Runs INSIDE the writing transaction after a node's title or body changed,
   *  so whatever it enqueues (outbox intents) commits or rolls back with the
   *  write. It must not call out of the process. */
  contentCommitted?: (change: NodeContentCommit) => Promise<void>;
  /** Runs INSIDE the transaction of an attribute set or delete, like the
   *  hooks below: record durable work only (an outbox intent); it runs in its
   *  own savepoint, so a failure is logged and the user's write stands. */
  attributeCommitted?: (change: NodeAttributeCommit) => Promise<void>;
  /** Runs inside the transaction of a site settings change, with the keys that
   *  changed (a value set to what it already was is not listed). */
  siteConfigCommitted?: (change: SiteConfigCommit) => Promise<void>;
  /** Runs inside the transaction of a space move or a space switch change. */
  spaceAudienceCommitted?: (change: SpaceAudienceCommit) => Promise<void>;
  /** Runs inside the transaction that trashed notes or brought them back. */
  lifecycleCommitted?: (change: NodeLifecycleCommit) => Promise<void>;
  /** Runs inside the transaction of a change to who may see notes (a note
   *  hidden or shown, a tag applied to or removed from a note). */
  visibilityCommitted?: (change: NodeVisibilityCommit) => Promise<void>;
};

const hooks = new Map<string, NodeHooks>();
/** The modules whose hooks also run for a change this node took from another node's change bundle (ModuleDefinition.nodeHooksOnReceive). */
const onReceived = new Set<string>();

/** Whose change a hook hears of: one written here (the default), or one this node took by change bundle (services/receivedDerivation.ts). A received change
 *  reaches only the modules that registered with `onReceived`: a hook that writes a replicated row (the tasks module moves a task line, a unit) must not run
 *  again on a node that takes the write, since the writer's node already wrote it and the bundle carried it. */
export type HookOrigin = { received?: true };

/** Register a module's hooks under its id. Registering the same object again
 *  is a no-op; a different one under the same id is a startup error.
 *  `onReceived`: its hooks only record work derived from committed state (an outbox intent that reads the state when it runs), so they run for a change
 *  taken by bundle too. */
export function registerNodeHooks(moduleId: string, moduleHooks: NodeHooks, options: { onReceived?: boolean } = {}): void {
  const existing = hooks.get(moduleId);
  if (existing === moduleHooks) return;
  if (existing) throw new Error(`[nodeHooks] hooks already registered for module: ${moduleId}`);
  hooks.set(moduleId, moduleHooks);
  if (options.onReceived) onReceived.add(moduleId);
}
/** The hooks a change of this origin reaches. */
const hooksFor = (origin: HookOrigin): [string, NodeHooks][] => [...hooks].filter(([id]) => !origin.received || onReceived.has(id));

/** The modules' half of a title or body change (services/nodeCommits.ts
 *  nodeContentCommitted runs the core half first). A hook's throw rolls the
 *  write back with it. */
export async function modulesContentCommitted(change: NodeContentCommit, origin: HookOrigin = {}): Promise<void> {
  for (const [, h] of hooksFor(origin)) await h.contentCommitted?.(change);
}

/** The modules' half of a permanent delete's snapshot rewrite (see NodeHooks.snapshotPurged). */
export async function modulesSnapshotPurged(change: NodeSnapshotPurge): Promise<void> {
  for (const h of hooks.values()) await h.snapshotPurged?.(change);
}

/** Call in the transaction of an explicit attribute write, before it is
 *  stored (services/attributeWrites.ts setNodeAttribute). A module's refusal
 *  throws, and the write with it. */
export async function nodeAttributeWriting(change: NodeAttributeWrite): Promise<void> {
  for (const h of hooks.values()) await h.attributeWriting?.(change);
}

// The hooks below run INSIDE the writing transaction, so whatever a module
// does in them commits or rolls back with the change: a subscriber only
// records durable work (an outbox intent — the website's site_rebuild), which
// runs after commit and reads the committed state. A crash after the commit
// therefore cannot lose it, as an after-commit callback could. Each
// subscriber runs in its own savepoint: one that fails is logged and rolled
// back alone, never taking the user's write with it.
async function runEach<K extends "attributeCommitted" | "siteConfigCommitted" | "spaceAudienceCommitted" | "lifecycleCommitted" | "visibilityCommitted">(
  kind: K, change: Parameters<NonNullable<NodeHooks[K]>>[0], detail: Record<string, unknown> = {}, origin: HookOrigin = {},
): Promise<void> {
  for (const [moduleId, h] of hooksFor(origin)) {
    const fn = h[kind] as ((c: typeof change) => Promise<void>) | undefined;
    if (!fn) continue;
    try {
      // Its own savepoint inside the writing transaction; with none open there
      // is no write of the user's to protect.
      await (inTransaction() ? withSavepoint(() => fn(change)) : fn(change));
    } catch (error) {
      log.warn("nodeHooks", `${kind} hook failed`, { moduleId, ...detail, err: error });
    }
  }
}

/** Call in the transaction of a site settings change (services/workspaceSettings.ts). Never throws. */
export async function siteConfigCommitted(change: SiteConfigCommit): Promise<void> {
  if (change.changedKeys.length > 0) await runEach("siteConfigCommitted", change, { keys: change.changedKeys.length });
}

/** Call in the transaction that moved notes between spaces, or changed a
 *  space's switches (services/spaces.ts). Never throws. */
export async function spaceAudienceCommitted(change: SpaceAudienceCommit, origin: HookOrigin = {}): Promise<void> {
  await runEach("spaceAudienceCommitted", change, {}, origin);
}

/** The modules' half of an attribute set or delete (services/nodeCommits.ts
 *  nodeAttributeCommitted runs the core half first). Never throws. */
export async function modulesAttributeCommitted(change: NodeAttributeCommit, origin: HookOrigin = {}): Promise<void> {
  await runEach("attributeCommitted", change, { key: change.key }, origin);
}

/** Call in the transaction that trashed notes or brought them back
 *  (services/nodeTrash.ts and the event-history undo). Never throws. */
export async function nodeLifecycleCommitted(change: NodeLifecycleCommit, origin: HookOrigin = {}): Promise<void> {
  await runEach("lifecycleCommitted", change, { change: change.change }, origin);
}

/** Call in the transaction of a change to who may see notes (mutate() does,
 *  for a mutation that declares `visibilityChanged`). Never throws. */
export async function nodeVisibilityCommitted(change: NodeVisibilityCommit, origin: HookOrigin = {}): Promise<void> {
  await runEach("visibilityCommitted", change, { nodes: change.nodeIds.length }, origin);
}
