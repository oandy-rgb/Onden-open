/** Whose saved views: a tag's (rows = its members) or a note's (rows = its
 *  children) — docs/architecture/views-as-modules.md 「檢視的來源」. */
export type ViewOwner = { kind: "tag" | "node"; id: string };

/** The base path of an owner's views: `/api/tags/:id` or `/api/nodes/:id`. */
export const viewOwnerPath = (owner: ViewOwner) =>
  `/api/${owner.kind === "tag" ? "tags" : "nodes"}/${encodeURIComponent(owner.id)}`;
