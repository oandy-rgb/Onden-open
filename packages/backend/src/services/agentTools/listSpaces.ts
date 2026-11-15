import { z } from "zod";
import { db } from "../../dbKysely.js";
import { spaceAccess } from "../../spine/spaceAccess.js";
import type { AgentTool } from "./types.js";

// The spaces the caller can read, and what it may do in each. A token reaches only the spaces
// that let external AI in (spine/spaceAccess.ts), so this lists what the agent can actually use.

const Args = z.object({});

type SpaceEntry = {
  id: string;
  name: string;
  kind: string;
  /** "view": read only; "suggest": your edits are filed as suggestions for a person to accept; "edit": direct changes. */
  permission: "view" | "suggest" | "edit";
};

export const listSpaces: AgentTool<z.infer<typeof Args>, { spaces: SpaceEntry[] }> = {
  name: "listSpaces",
  access: "read",
  description:
    "List the spaces you can read, each with id, name, kind (personal or shared) and your permission there: " +
    "view (read only), suggest (your edits are saved as suggestions the user accepts) or edit (direct changes). " +
    "Use a space's id with listChildren to browse its top-level notes, or as space_id when creating a note.",
  inputSchema: Args,
  async handler(_args, { actor, workspaceId }) {
    const spaces = await db.selectFrom("spaces").select(["id", "name", "kind"])
      .where("workspace_id", "=", workspaceId).where("deleted_at", "is", null)
      .orderBy(({ eb }) => eb("kind", "=", "personal"), "desc").orderBy("name").orderBy("id").execute();
    // A member stored as "suggest" reads, and files its edits for review.
    const stored = new Map((await db.selectFrom("space_members").select(["space_id", "permission"]).where("actor_id", "=", actor.id).execute()).map((m) => [m.space_id, m.permission]));
    const out: SpaceEntry[] = [];
    for (const space of spaces) {
      const access = await spaceAccess(actor, space.id);
      if (!access?.read) continue;
      const suggestOnly = actor.type === "agent" && actor.tokenScope?.writeMode === "suggest";
      out.push({ id: space.id, name: space.name, kind: space.kind, permission: access.write ? (suggestOnly ? "suggest" : "edit") : stored.get(space.id) === "suggest" ? "suggest" : "view" });
    }
    return { spaces: out };
  },
};
