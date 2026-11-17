import { sendWrite } from "./onlineWrite";

// Things brought into the workspace from outside: a link, the capture inbox, a folder of Obsidian notes. Online only.
export const captureWriter = {
  /** Make a note of a web page; answers the new note's id. */
  bookmark: async (url: string, spaceId?: string | null): Promise<string> =>
    (await sendWrite<{ id: string }>("POST", "/api/bookmark", spaceId ? { url, space_id: spaceId } : { url })).id,
  /** Ask the server to make the inbox tag if nobody has yet; answers its id. */
  ensureInboxTag: async (): Promise<string> => (await sendWrite<{ tag_id: string }>("POST", "/api/capture/inbox", {})).tag_id,
  importObsidian: <T>(body: unknown) => sendWrite<T>("POST", "/api/import/obsidian", body),
};
