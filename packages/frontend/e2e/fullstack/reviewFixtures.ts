import { expect, type APIRequestContext } from "@playwright/test";
import { H } from "./helpers";

/** Make a note a review card: the note's own review reference (a tag makes no card). The server says "changed: false" when it already is one. */
export async function makeReviewCard(request: APIRequestContext, noteId: string): Promise<void> {
  const response = await request.put(`/api/review/cards/${noteId}`, { ...H, data: {} });
  expect(response.ok(), `PUT /api/review/cards → ${response.status()}`).toBe(true);
}

/** A plain tag that only picks cards to study (the queue's tag scope); found by name or created. It gives nothing to its notes. */
export async function ensureScopeTag(request: APIRequestContext, name = "review-scope"): Promise<string> {
  const response = await request.get("/api/tags");
  expect(response.ok()).toBe(true);
  const existing = (await response.json() as Array<{ id: string; name: string }>).find((tag) => tag.name === name);
  if (existing) return existing.id;
  const imported = await request.post("/api/tags/import", { ...H, data: { name, fields: [] } });
  expect(imported.ok(), `import tag → ${imported.status()}`).toBe(true);
  return (await imported.json()).id as string;
}
