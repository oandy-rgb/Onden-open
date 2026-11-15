// Random but reproducible activity on the real services of several nodes. Every action is what a person does: it goes through the
// same service a route calls, as an actor with the permission the node's own tables give them right now. A refusal (the gate says no)
// is part of life and is ignored; what is accepted is captured and synced. Nothing here reads the engine.
import { createHash } from "node:crypto";
import { q } from "../../../db.js";
import { createNote } from "../../../services/noteCreate.js";
import { updateNode } from "../../../services/nodeUpdate.js";
import { applyTagToNode, removeTagFromNode } from "../../../services/tagMembershipWrites.js";
import { trashNode, undeleteNode } from "../../../services/nodeTrash.js";
import { setMember } from "../../../services/spaces.js";
import type { ActorCtx } from "../../../types.js";
import type { RealCluster } from "./realCluster.js";
import type { Rng } from "./rng.js";

export type Cast = { workspaceId: string; people: ActorCtx[]; owner: ActorCtx; space: string; tags: string[] };

/** A uuid made from a seed string, so two runs of one plan mint the same note ids. */
export const uuidFrom = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

export type Action = "create" | "body" | "title" | "tag" | "untag" | "move" | "trash" | "restore" | "member";
export const CONTENT_ACTIONS: Action[] = ["create", "create", "body", "body", "body", "title", "tag", "untag", "move", "trash", "restore"];

/** One random action on node `nodeId`. Returns what it did (or "refused"/"nothing") for the run's report. */
export async function act(cluster: RealCluster, cast: Cast, nodeId: string, rng: Rng, serial: number, actions: Action[] = CONTENT_ACTIONS): Promise<string> {
  const who = rng.pick(cast.people);
  const kind = rng.pick(actions);
  return cluster.on(nodeId, async () => {
    const live = (await q<{ id: string; markdown: string; parent_id: string | null; title: string }>(
      "SELECT id, markdown, parent_id, title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND space_id = $2 AND deleted_at IS NULL ORDER BY id", [cast.workspaceId, cast.space])).rows;
    const trashed = (await q<{ id: string }>(
      "SELECT id FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND space_id = $2 AND deleted_at IS NOT NULL ORDER BY id", [cast.workspaceId, cast.space])).rows;
    const note = live.length ? rng.pick(live) : undefined;
    try {
      switch (kind) {
        case "create": {
          const parent = note && rng.chance(0.3) ? note.id : null;
          await createNote({ actor: who, workspaceId: cast.workspaceId, id: uuidFrom(`note-${serial}`), title: `${rng.pick(WORDS)} ${serial}`, markdown: `${rng.pick(WORDS)}\n${rng.pick(WORDS)}\n${rng.pick(WORDS)}`,
            parentId: parent, spaceId: parent ? undefined : cast.space, event: { uiContext: "workload" } });
          return "create";
        }
        case "body": {
          if (!note) return "nothing";
          const lines = note.markdown.split("\n");
          const at = rng.int(lines.length + 1);
          const how = rng.int(3);
          if (how === 0 || !lines.length) lines.splice(at, 0, `${rng.pick(WORDS)} ${serial}`);
          else if (how === 1) lines[Math.min(at, lines.length - 1)] = `${rng.pick(WORDS)} ${serial}`;
          else lines.splice(Math.min(at, lines.length - 1), 1);
          await updateNode(cast.workspaceId, note.id, { markdown: lines.join("\n") }, { actor: who });
          return "body";
        }
        case "title":
          if (!note) return "nothing";
          await updateNode(cast.workspaceId, note.id, { title: `${rng.pick(WORDS)} ${serial}` }, { actor: who });
          return "title";
        case "tag": case "untag":
          if (!note || !cast.tags.length) return "nothing";
          await (kind === "tag" ? applyTagToNode : removeTagFromNode)({ workspaceId: cast.workspaceId, actor: who, nodeId: note.id, tagId: rng.pick(cast.tags) });
          return kind;
        case "move": {
          if (!note) return "nothing";
          const target = rng.chance(0.2) ? null : rng.pick(live).id;
          await updateNode(cast.workspaceId, note.id, { parent_id: target }, { actor: who });
          return "move";
        }
        case "trash":
          if (!note) return "nothing";
          await trashNode(who, cast.workspaceId, note.id);
          return "trash";
        case "restore":
          if (!trashed.length) return "nothing";
          await undeleteNode(who, cast.workspaceId, rng.pick(trashed).id);
          return "restore";
        case "member": {
          const target = rng.pick(cast.people.filter((p) => p.id !== cast.owner.id));
          await setMember(cast.owner, cast.workspaceId, cast.space, target.id, rng.pick(["edit", "view", null, "edit"] as const));
          return "member";
        }
      }
    } catch {
      return "refused";
    }
  });
}
