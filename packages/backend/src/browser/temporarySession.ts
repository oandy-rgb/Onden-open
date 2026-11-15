// What a temporary session (`?temp=1`, docs/architecture/browser-app.md §17) starts with: an empty workspace and one blank
// note to write in. No sample notes. The built-in tags nobody asked for are retired as on a first open of the ordinary
// session, so the tag list is the person's own.

import { retireUnusedSeedTags } from "./sampleNotes.js";

type Fetch = (request: Request) => Promise<Response>;

/** The placeholder title the app gives a note nobody named yet, in the person's language (the app stores it that way and
 *  shows it as an empty title field: lib/noteLabel.ts isPlaceholderTitle). */
const blankTitle = (language: string): string => (/^zh/i.test(language) ? "未命名" : "Untitled");

/** Make the blank note; resolves with its id (the page opens on it). `language`: the page's, from its address to the worker. */
export async function startTemporarySession(fetchLocal: Fetch, origin: string, language: string): Promise<string> {
  await retireUnusedSeedTags(fetchLocal, origin);
  const id = crypto.randomUUID();
  const response = await fetchLocal(new Request(new URL("/api/nodes", origin).href, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: blankTitle(language), markdown: "" }),
  }));
  if (!response.ok) throw new Error(`the first note could not be made (${response.status})`);
  return id;
}
