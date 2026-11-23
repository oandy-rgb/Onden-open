// Publishing: what the preview names about notes the publish leaves out or changes.
// Pure types: the app imports them with `import type`, so nothing here may run.

/** A note the site leaves out that the owner may want to know about, and why
 *  (backend publishing/publishedSet.ts leftOutNotes):
 *  - marked 「發布」 but `hidden`, or in a space that does not publish
 *    (`space_not_published`) — `space` is the space that decides it, so the
 *    owner can move the note or turn the space's publish switch on; `hidden`
 *    wins when both hold;
 *  - in a space that publishes, kept off by its own 「不發布」 (`kept_off`),
 *    because it is `blank`, or because it is an article saved from a feed
 *    (`saved_article`). `kept_off_by_parent` is a `kept_off` nobody chose on
 *    this note: it was made under a note kept off the site and took that as its
 *    default (backend services/siteDefault.ts); 「放回網站」 puts it on. An app
 *    that does not know the value shows it as any other kept-off note. */
export type LeftOutNote = {
  node_id: string;
  title: string;
  reason: "hidden" | "space_not_published" | "kept_off" | "kept_off_by_parent" | "blank" | "saved_article";
  space: { id: string; kind: "personal" | "shared"; is_default: boolean; name: string } | null;
};

export type PreviewNote = { id: string; title: string; slug: string };

/** A site in the shape it is served in (the live site, or the candidate a publish would store). */
export type ServedSite = {
  id: string | null;
  title: string;
  home_node_id: string | null;
  event_cursor: number;
  /** The site's notes, links and design; the app reads the parts it draws (lib/site). */
  payload: Record<string, unknown>;
  artifact_ref: string;
  created_at: string;
};

/** POST /api/publish/preview's answer: the candidate a publish would store, what changes against the last publish,
 *  the links that will read as private, the pictures that go out with the notes that embed them, the media readers won't get, and the hash a publish sends back so only the
 *  previewed candidate goes out. */
export type PublishPreview = {
  hash: string;
  /** The candidate in the served-site shape, rendered like the live site. */
  site: ServedSite;
  /** The last publish, which the diff compares against; null when the site was never published. */
  live: { snapshot_id: string; published_at: string } | null;
  /** What readers will see change: settings_changed is the site's name, home page or design. */
  diff: {
    added: PreviewNote[];
    /** Notes taken down since the last publish (unpublished, trashed, their space switched off) that qualify again:
     *  this publish is what brings them back, with their CURRENT text (backend publishing/takenDown.ts). Not also
     *  listed as changed. */
    returning: PreviewNote[];
    /** Title, address, text, parent or tags. */
    changed: PreviewNote[];
    /** Another place among the same parent's children (the site's nav order). */
    moved: PreviewNote[];
    /** Its published links (Related, backlinks, nav links) differ. */
    links_changed: PreviewNote[];
    /** `taken_down`: readers already don't see it; this publish makes it final. */
    removed: Array<PreviewNote & { taken_down: boolean }>;
    settings_changed: boolean;
  };
  /** Links (and embeds that are not pictures) to notes not on the site: `shown_as` is what readers see instead, in
   *  the site's language. */
  private_links: Array<{ node_id: string; node_title: string; target: string; shown_as: string }>;
  /** The pictures of the drawings the published notes embed, once each (backend publishing/drawingEmbeds.ts): what this
   *  publish puts on the site with those notes even when the drawing's own note is not published. `source_id` is the
   *  drawing (its 「不發布」 keeps the picture off), `node_ids` the published notes that show it, `picture` the image as
   *  readers get it (a data: address). `pages_not_shown`: the drawing has that many pages after the first, which the
   *  site does not draw (a whole-drawing embed shows the first page, in the app too). An older server sends none. */
  embedded_pictures?: Array<{ source_id: string; node_ids: string[]; picture: string; pages_not_shown?: number }>;
  /** not_public: a reader of the site can't open it (its note isn't public); missing: no file on the server.
   *  `node_ids`: the published notes that embed it (empty: it is in the site's design). */
  blocked_media: Array<{ filename: string; reason: "not_public" | "missing"; node_ids: string[] }>;
  /** Files that become public with this publish (not in the live site, not blocked). */
  new_media: Array<{ filename: string; used_as: "logo" | "favicon" | "other"; node_ids: string[] }>;
  /** Videos too big for the external static-host copy: readers of that copy get a link to the original site instead. */
  large_videos: Array<{ filename: string; size_mb: number; node_ids: string[] }>;
  /** Notes marked for the site that this publish leaves out, and why. */
  left_out: LeftOutNote[];
  /** Note components of the home page whose note is not published: the preview lists them and offers POST
   *  /api/publish/include (`componentId`: the home component pointing at the note). */
  unpublished_refs: Array<{ componentId: string; noteId: string; title: string }>;
  /** Flowchart and state-diagram blocks of the published notes that have no layout yet: the app lays them out and
   *  sends them with the publish. */
  diagrams_needed: string[];
};
