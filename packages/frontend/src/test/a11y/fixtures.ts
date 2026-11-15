// A small workspace shaped like a student's: notes with tags and properties,
// a tag with a schema, a parent note with children, a canvas. Shared by the
// axe surfaces so each renders with content, not empty states.
import { type ContentNode, type Tag } from "../../lib/api";
import { ownerData } from "../ownerData";

export const fixtureTags: Tag[] = [
  { id: "t-course", name: "course", color: "", schema_id: "s-course", schema_extends: [], effective_modules: [],
    schema_fields: [{ name: "instructor", type: "text" }, { name: "credits", type: "number" }] },
  { id: "t-reading", name: "reading", color: "", schema_id: null },
];

const note = (id: string, title: string, markdown: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, slug: id, markdown, node_type: "content", source_type: "manual", ...extra }) as ContentNode;

export const fixtureNotes: ContentNode[] = [
  note("n-os", "Operating Systems", "# Operating Systems\n\nProcesses and #course notes. See [[Scheduling]].", {
    class_tag_ids: ["t-course"], attrs: { instructor: "Lin", credits: "3" },
  }),
  note("n-sched", "Scheduling", "Round robin, priority, **multilevel** queues.", { class_tag_ids: ["t-course"], parent_id: "n-os" } as Partial<ContentNode>),
  note("n-paper", "Paper notes", "- [ ] read section 3\n- [x] skim abstract", { class_tag_ids: ["t-reading"], attrs: { pages: "412" } }),
];

export const fixtureData = () => ({ ...ownerData, nodes: fixtureNotes, tags: fixtureTags });
