// A tag's saved views as the home studio's pickers offer them (desktop field
// and phone sheet read the same list, so both map a layout to a view kind the
// same way).
import { reads } from "../../../lib/data";
import type { SavedViewChoice } from "./studioContext";

export async function loadSavedViews(tagId: string): Promise<SavedViewChoice[]> {
  const reply = await reads.views.list<{ id: string; name: string; layout: string }>({ kind: "tag", id: tagId });
  return (Array.isArray(reply?.views) ? reply.views : []).map((v): SavedViewChoice => ({
    id: v.id, name: v.name, kind: v.layout === "gallery" ? "cards" : v.layout === "table" || v.layout === "list" ? "table" : "list",
  }));
}
