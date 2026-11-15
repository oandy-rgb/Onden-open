import type { ModuleDefinition } from "../types.js";
import skillsRouter from "../../routes/skills.js";
import { functionInUse } from "../../services/functionRefs.js";

// Skills: a note with 「當成技能」 on (the module's inside tag; no list shows it) is
// a skill — its title is the name, its body the instructions, its frontmatter
// description / output / applies_to / ai say what it is for, where the result
// goes, which tags' notes offer it and whether the AI may pick it itself. Onden
// runs no model: the owner's own AI uses a skill through MCP prompts/list +
// prompts/get, or picks one itself from the list in an @mention's prompt
// (loadSkill; services/harness, docs/architecture/harness.md). The module owns
// only the tag and the catalogue route (GET /api/skills); removing it leaves the
// notes as they are and they stop being skills. A tag can also be given the
// 「技能」 function (it extends the skill tag, like review): its notes are then
// skills. A tag page lists the skills used on it (applies_to).
export const skillsModule: ModuleDefinition = {
  id: "skills",
  tagFunction: true,
  routePrefixes: ["/api/skills"],
  registerRoutes: (app) => {
    app.route("/api/skills", skillsRouter);
  },
  library: {
    // Skills are for an AI to use: off with the ai module (data kept).
    requires: ["ai"],
    moduleTag: { name: "skill" },
    inUse: (workspaceId) => functionInUse(workspaceId, "skills"),
  },
};
