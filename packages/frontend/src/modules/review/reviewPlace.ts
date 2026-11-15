// Where inside the review page the person is: all cards, the status page, or the cards of one group.
// Kept in the page's address (lib/moduleAddress, `?view=review&m=…`) so a reload and Back keep it.
// A group is not an object: it is a note (its subtree) or a tag that already exists, or the cards under no tag.

import { UUID_SOURCE } from "@onden/markdown";

export type ReviewPlace =
  | { kind: "status" }
  | { kind: "root"; id: string }
  | { kind: "tag"; id: string }
  | { kind: "untagged" };

/** The group a 「練這組」 button opens: a row of GET /api/review/groups (id null = no tag). */
export const placeOfGroup = (by: "tag" | "note", id: string | null): ReviewPlace =>
  by === "note" ? { kind: "root", id: id! } : id === null ? { kind: "untagged" } : { kind: "tag", id };

export function formatPlace(place: ReviewPlace | null): string | null {
  if (!place) return null;
  return place.kind === "status" || place.kind === "untagged" ? place.kind : `${place.kind}.${place.id}`;
}

export function parsePlace(address: string | null): ReviewPlace | null {
  if (address === "status" || address === "untagged") return { kind: address };
  const match = new RegExp(`^(root|tag)\\.(${UUID_SOURCE})$`, "i").exec(address ?? "");
  return match ? { kind: match[1] as "root" | "tag", id: match[2]! } : null;
}
