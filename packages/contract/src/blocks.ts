// Paragraphs of notes (block anchors), their citations and the whiteboards a note appears on.
// Pure types: the app imports them with `import type`, so nothing here may run.

export type AnchorStatus = "valid" | "maybe" | "lost";

/** One note that cites paragraph `block_ref` of the asked note, `uses` times. */
export type BlockCitationRow = { block_ref: string; source_id: string; source_title: string; uses: number };

export type BlockHome = { id: string; title: string; slug: string; space_id: string | null };

export type NoteParagraph = {
  id: string;
  parentId: string | null;
  label: string;
  topics: string[];
  where: "here" | "standing" | "lost";
  noteId: string | null;
  anchorStatus: "valid" | "maybe" | "lost" | null;
  blockRef: string;
};

export type CanvasMembership = { canvas_id: string; canvas_title: string; node_id: string };

/** Where one paragraph of a note sits (bootstrap `note_anchors`, the sync delta; backend services/blockAnchors). */
export type NoteAnchor = {
  anchor_id: string; note_id: string; from: number; to: number;
  status: AnchorStatus; candidate_from: number | null; candidate_to: number | null;
  /** What the paragraph said when last confirmed (cut): the words a link shows when the paragraph is gone or not here. */
  quote: string;
};
/** Which anchor the link `link_text` (as written) in note `note_id` means. */
export type LinkBinding = { note_id: string; link_text: string; anchor_id: string };
