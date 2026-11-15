// TEST FIXTURES ONLY. Production actors have no workspace role (docs/architecture/
// proposals/roles-owner-member-2026-10-22.md): the owner is workspaces.owner_actor_id
// and a member's reach is its space permissions. The ~250 test fixtures that
// still write `role: "admin" | "editor" | "viewer"` on the actors they hand to
// persistActor read it as shorthand — admin human = the workspace owner, viewer
// = view-only in the default space, anything else = edit — and persistActor
// (helpers/persistActor.ts) is the only reader. Nothing else may look at it.
// TODO(roles PR 7): replace the shorthand with explicit fixtures and delete this file.
import "../types.js";

declare module "../types.js" {
  interface ActorCtx {
    role?: string;
  }
}
