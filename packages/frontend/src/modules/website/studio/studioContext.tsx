// What the studio's field pickers read: the notes and tags on this device, a
// note's text, a tag's saved views, and "open this note in the app". Supplied
// once by HomeStudio; the Puck fields (rendered deep inside Puck) read it here
// instead of through `puck.metadata`, which is the canvas' data.
import { createContext, useContext } from "react";
import type { StudioNote, StudioTag } from "./editorData";

export type SavedViewChoice = { id: string; name: string; kind: "list" | "cards" | "table" };

export type StudioData = {
  notes: readonly StudioNote[];
  tags: readonly StudioTag[];
  /** The note's Markdown, when this device has it (null: not loaded yet). */
  markdownOf: (noteId: string) => string | null;
  /** The tag's saved views; [] offline or when it has none. */
  savedViews: (tagId: string) => Promise<SavedViewChoice[]>;
  openNote: (noteId: string) => void;
  /** 「發布這篇」: mark the note for the site (readers get it with the next Publish). */
  publishNote: (noteId: string) => void;
  /** 「從網站移除」: the note stays, the site drops it. */
  unpublishNote: (noteId: string) => void;
};

export const StudioDataContext = createContext<StudioData | null>(null);

export function useStudioData(): StudioData {
  const value = useContext(StudioDataContext);
  if (!value) throw new Error("StudioDataContext is missing");
  return value;
}
