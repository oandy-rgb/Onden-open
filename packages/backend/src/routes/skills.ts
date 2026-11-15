import { attachmentHeaders } from "../downloadHeaders.js";
import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { ignoredSkills, skillMarkdown, skills } from "../services/harness/index.js";
import type { ActorCtx } from "../types.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// The skill catalogue: built-in skills and the caller's own skill notes
// (services/harness/noteSkills.ts decides which notes count). Onden runs no
// model; an outside AI reaches the same catalogue as MCP prompts.
router.get("/", async (c) => {
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  // Every skill with its 「給 AI 用」 switch (`aiUse`), so the person sees the
  // ones that are off too; `?for_ai=1` is what the AI is offered: switched on only.
  const all = await skills(actor, workspaceId);
  // `ignored`: your skill notes someone else edited last; they are not offered.
  return c.json({ skills: c.req.query("for_ai") === "1" ? all.filter((s) => s.aiUse) : all, ignored: await ignoredSkills(actor, workspaceId) });
});

// One skill as a standard SKILL.md, for agent hosts.
router.get("/:id/skill.md", async (c) => {
  const actor = requireActor(c.get("actor"));
  const exported = await skillMarkdown(actor, await getWorkspaceId(), c.req.param("id"));
  if (!exported) return c.json({ error: "not_found", detail: "no skill with that id" }, 404);
  for (const [name, value] of Object.entries(attachmentHeaders(exported.filename, "text/markdown; charset=utf-8"))) c.header(name, value);
  return c.body(exported.markdown);
});

export default router;
