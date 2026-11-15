import { Hono } from "hono";
import { z } from "zod";
import { TAG_NAME_MAX } from "@onden/markdown";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/mutate.js";
import { setModuleImported } from "../services/workspaceModules.js";
import { setHomeNode, readWorkspaceConfig, updateWorkspaceConfig } from "../services/workspaceSettings.js";
import { setWorkspaceTime, WorkspaceTimeInputError } from "../services/workspaceTime.js";
import { transferOwnership } from "../services/ownerTransfer.js";
import { ActorAdminError } from "../services/actors.js";
import { parseBody } from "./params.js";

// /api/workspace (moved from index.ts, depth audit D10): parse, call the
// service, answer. The owner-only rules live in services/workspaceSettings.ts
// and services/workspaceModules.ts.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.patch("/", async (c) => {
  // default_agent_threshold was dropped with the sandbox (migration 047) —
  // the route kept UPDATE/RETURNING references to the dead column, so EVERY
  // workspace PATCH (incl. "set as home") 500'd since then. home_node_id is
  // the surviving field.
  const input = await parseBody(c, z.object({
    home_node_id: z.string().uuid().nullable().optional(),
  }));
  return c.json(await setHomeNode(c.get("actor"), await getWorkspaceId(), input.home_node_id));
});

// The workspace's calendar clock (services/workspaceTime.ts): the zone its days
// are cut in and the hour a day starts at. Owner only. `time_zone: null` goes
// back to the server default; an unknown zone name is a 400.
router.patch("/time", async (c) => {
  const input = await parseBody(c, z.object({
    time_zone: z.string().min(1).max(64).nullable().optional(),
    day_start_hour: z.number().int().min(0).max(6).optional(),
  }).strict());
  try {
    return c.json(await setWorkspaceTime(c.get("actor"), await getWorkspaceId(), { timeZone: input.time_zone, dayStartHour: input.day_start_hour }));
  } catch (e) {
    if (e instanceof WorkspaceTimeInputError) return c.json({ error: "invalid_time_setting", message: e.message }, 400);
    throw e;
  }
});

// Module library: import or remove one module for this workspace
// (services/workspaceModules.ts; docs/architecture/module-library.md).
router.patch("/modules", async (c) => {
  const input = await parseBody(c, z.object({
    module: z.string().min(1).max(64),
    imported: z.boolean(),
    // The module tag's name in the interface language (e.g. 複習).
    tag_name: z.string().max(TAG_NAME_MAX).optional(),
  }));
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  return c.json(await setModuleImported({ actor, workspaceId, module: input.module, imported: input.imported, tagName: input.tag_name }));
});

// ── Site config (workspace-level settings via #workspace-config node) ────────

router.get("/config", async (c) => c.json(await readWorkspaceConfig(await getWorkspaceId())));

router.patch("/config", async (c) => {
  const input = await parseBody(c, z.object({
    config: z.record(z.string(), z.unknown()).optional(),
    chrome: z.unknown().optional(),
    // The chrome revision the change started from (null: none yet); omitted,
    // the chrome is replaced unchecked (older clients).
    chrome_base: z.string().min(1).max(100).nullable().optional(),
  }));
  const { chrome_base: chromeBase, ...change } = input;
  return c.json(await updateWorkspaceConfig(c.get("actor"), await getWorkspaceId(), { ...change, chromeBase }));
});

// Hand the workspace to someone else (services/ownerTransfer.ts): the owner's own
// session only, the new owner typed back by name. Retrying with the same
// Idempotency-Key replays the first answer.
router.post("/owner-transfer", async (c) => {
  const input = await parseBody(c, z.object({ to_actor_id: z.string().uuid(), confirm_name: z.string().min(1).max(200) }).strict());
  try {
    return c.json(await transferOwnership(c.get("actor"), await getWorkspaceId(), { toActorId: input.to_actor_id, confirmName: input.confirm_name }));
  } catch (e) {
    if (e instanceof ActorAdminError) return c.json(e.body, e.status);
    throw e;
  }
});

export default router;
