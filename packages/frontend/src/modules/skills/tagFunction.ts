import { Sparkles } from "lucide-react";
import type { TagFunctionSpec } from "../../lib/tagModules";

/** The skill function on a tag: a tag that extends the skill tag makes its
 *  notes skills; the backend module declares `tagFunction`. */
export const skillsTagFunction: TagFunctionSpec = {
  id: "skills",
  title: "Skills",
  description: "Lets your AI use these notes as ways of getting things done.",
  Icon: Sparkles,
};
