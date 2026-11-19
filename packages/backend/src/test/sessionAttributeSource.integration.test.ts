// A value a temporary session sets by hand is a person's value (source 'ui'), as the person's own is: it outranks a value the note's body derives
// (spine/attributeSource.ts SOURCE_PRIORITY: ui > frontmatter > markdown > dispatcher) and counts as a person's (isPersonAuthored: an export's
// frontmatter, a duplicate's copied values). Before PR #1856 round 2 it was stored as 'dispatcher' (services/attributeWrites.ts took any actor that
// is not of type 'human' for automation), the lowest rank: the next save of a body holding `#key=value` overwrote what the session typed.
// node_attributes.source travels with the row (a carried column), so the other nodes read it the same way.
//
// Deterministic: a body's inline values are derived after the save commits, in the background; each check waits for that work (awaitAllDispatchers).
// SAFETY: only runs against a *_test database; skips otherwise. Each test makes its own workspace (shared database; tests run shuffled).
import { afterAll, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { resolveTemporarySessionActor } from "../services/participantSessions.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { updateNode } from "../services/nodeUpdate.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import type { ActorCtx } from "../types.js";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

afterAll(async () => { await pool.end(); });

const attribute = async (ws: string, note: string, key: string) =>
  (await q<{ value: string; source: string }>(`SELECT value, source FROM node_attributes WHERE workspace_id = $1 AND node_id = $2 AND key = $3`, [ws, note, key])).rows[0] ?? null;

/** A note in space A whose body derives `status` (an inline `#status=draft`), and a writer who sets `status` by hand to "final". */
async function world(label: string, writer: "session" | "person") {
  const w = await standardWorld(label);
  ownWorkspace = w.ws;
  const note = await newNote(w.ws, `${label} note`, w.spaceA, "plans");
  await updateNode(w.ws, note, { markdown: "plans #status=draft" }, { actor: w.owner.ctx }); // a save derives the inline value,
  await awaitAllDispatchers(); // after it commits, in the background: wait for that work to finish, so the check below does not race it
  let actor: ActorCtx = w.owner.ctx;
  if (writer === "session") {
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
    actor = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
  }
  expect(await attribute(w.ws, note, "status"), "control: the body derived the value").toEqual({ value: "draft", source: "markdown" });
  await setNodeAttribute({ workspaceId: w.ws, actor, nodeId: note, attribute: { key: "status", value: "final" } });
  return { ...w, note, actor };
}

describe.skipIf(!isTestDatabase())("a value a temporary session sets by hand", () => {
  it.each(["session", "person"] as const)("set by the %s, is stored as a person's value (source 'ui')", async (writer) => {
    const w = await world(`attrSource${writer}`, writer);
    expect(await attribute(w.ws, w.note, "status")).toEqual({ value: "final", source: "ui" });
  });

  it.each(["session", "person"] as const)("set by the %s, is kept when the body that derives the key is saved again (by anyone)", async (writer) => {
    const w = await world(`attrKept${writer}`, writer);
    // the next save of the body re-derives every inline value under the precedence rule
    await updateNode(w.ws, w.note, { markdown: "plans #status=draft\n\nand one more line" }, { actor: w.owner.ctx });
    await awaitAllDispatchers();
    expect(await attribute(w.ws, w.note, "status")).toEqual({ value: "final", source: "ui" });
  });
});
