// Note / entity templates — a "stamp this scaffold" primitive.
//
// The *only* templates the app had before this were the website Puck builder
// (components/templates/*, an unrelated concern) and token-role presets. This
// registry is the missing piece the student / notion-migrant / ttrpg /
// meeting-notes personas asked for: a small set of {title pattern, body
// scaffold, default tags} that mint a node pre-filled.
//
// Design notes
// ────────────
// • Pure data + a couple of pure helpers — no React, no fetch. Minting lives in
//   useNodeCreation.createFromTemplate so it routes through the same
//   /api/nodes + /api/tags/resolve-path + attribute-set rails every other
//   quick-create uses (no third mechanism). Keeping the registry pure makes it
//   trivially testable and lets the slash menu, command palette and (future)
//   sidebar "+" all read the same source.
// • `title` is a *pattern* evaluated at mint time: `{date}` → today's ISO date,
//   `{datetime}` → ISO date + local HH:MM. A matching title alone dedupes
//   nothing (the server only makes the slug unique): the daily template is a
//   `day` template, which opens today's note through lib/data/dayNotes.ts and
//   stamps its scaffold only onto an empty one (D68).
// • `tags` are tag *paths* resolved via /api/tags/resolve-path (find-or-create,
//   idempotent chain create) — the same call extractReviewCards uses for
//   #review. We deliberately store paths, not ids: ids don't exist until the
//   workspace creates them, and resolve-path makes first-use create them.
// • One scaffold per note (D69): a tag can carry its own scaffold
//   (tag_schema.template_children, stamped as child notes by the server when
//   the tag is applied). The starter packs no longer do — a note only fills in
//   field values — but when a template's tag does (one a user or a future
//   "template" feature set up), the template defers to it and writes no body
//   (fitTemplateToTags), so the same headings are not stamped twice.
//
// Pattern borrowed (cited): the registry-of-scaffolds shape mirrors how the
// command-palette static actions are declared (a frozen array of typed records
// the UI maps over) and how /tmp/featlibs kanban/calendar studies recommend a
// single typed source the view layer reads — keeping one source of truth.

import { applyTemplateVars, type TemplateVars } from "@onden/markdown";
import type { Tag } from "./api";
import { dateTimeId, todayId } from "./localDate";
import { tagFields } from "./tagFields";
/** A single template the user can stamp into a new node. */
export type NoteTemplate = {
  /** Stable id (used as the slash / palette item id and React key). */
  id: string;
  /** Short label shown in menus. */
  label: string;
  /** Lucide icon name resolved by the consuming component (kept as a string so
   *  this module stays React-free). */
  icon: string;
  /** One-line description for the menu subtitle. */
  description: string;
  /** Title *pattern*. Supports `{date}` and `{datetime}` placeholders. */
  title: string;
  /** Markdown body scaffold stamped verbatim (after title-placeholder
   *  substitution). */
  body: string;
  /** Tag *paths* to find-or-create and apply (e.g. "meeting", "ttrpg/character"). */
  tags?: string[];
  /** Plain attributes to set on the minted node. `value_type` defaults to
   *  "text" at the call site. Values support the same placeholders as titles. */
  attributes?: Array<{ key: string; value: string }>;
  /** Values for fields the template's tags may declare (the Meeting pack's
   *  required `meeting_date`). Unlike `attributes`, one is written only when
   *  an applied tag declares that field, so a plain label tag gets no stray
   *  attribute. Values support the same placeholders. */
  fields?: Array<{ key: string; value: string }>;
  /** A scaffold for today's note rather than a new note: using it opens
   *  today's note (one per person and date) and applies body, tags and
   *  attributes only when that note is still empty. Its title is `{date}`. */
  day?: true;
};

/** Today's local date as `YYYY-MM-DD` (matches the day-note keying, lib/dayNode.ts). */
export function isoDate(now: Date = new Date()): string {
  return todayId(now);
}

/** `YYYY-MM-DD HH:MM` in the workspace's zone. */
export function isoDateTime(now: Date = new Date()): string {
  return dateTimeId(now);
}

/** The placeholder values at `now`: the workspace's day and minute. */
export function templateVars(now: Date = new Date()): TemplateVars {
  return { date: isoDate(now), datetime: isoDateTime(now) };
}

/** A template resolved at one moment: placeholders filled ({date}/{datetime},
 *  @onden/markdown applyTemplateVars — the same expander the server runs over
 *  a tag's template children); tags stay paths, the caller find-or-creates
 *  them. Pure. */
export type InstantiatedTemplate = {
  title: string;
  body: string;
  tags: string[];
  attributes: Array<{ key: string; value: string }>;
  fields: Array<{ key: string; value: string }>;
};

export function instantiateTemplate(tpl: NoteTemplate, now: Date = new Date()): InstantiatedTemplate {
  const vars = templateVars(now);
  const fill = (rows: Array<{ key: string; value: string }> | undefined) =>
    (rows ?? []).map((a) => ({ key: a.key, value: applyTemplateVars(a.value, vars) }));
  return {
    title: applyTemplateVars(tpl.title, vars),
    body: applyTemplateVars(tpl.body, vars),
    tags: tpl.tags ?? [],
    attributes: fill(tpl.attributes),
    fields: fill(tpl.fields),
  };
}

/** What a template writes once its tags are known (`applied`: the tags it
 *  resolved to, from the catalog). A tag with template children already
 *  stamps its scaffold as child notes when applied (the server's
 *  templateExpander; the starter packs set none, so "Meeting notes" with the
 *  Meeting tag writes its own body), so the template leaves the scaffold to it and writes no body of
 *  its own: one scaffold, not the same headings twice. A `fields` value is
 *  kept only for a field an applied tag declares. Pure. */
export function fitTemplateToTags(
  inst: InstantiatedTemplate,
  applied: readonly Pick<Tag, "schema_fields" | "effective_fields" | "schema_template_children">[],
): { body: string; attributes: Array<{ key: string; value: string }> } {
  const tagStampsScaffold = applied.some((tag) => (tag.schema_template_children ?? []).length > 0);
  const declared = new Set(applied.flatMap((tag) => tagFields(tag).map((field) => field.name)));
  const taken = new Set(inst.attributes.map((a) => a.key));
  return {
    body: tagStampsScaffold ? "" : inst.body,
    attributes: [...inst.attributes, ...inst.fields.filter((f) => declared.has(f.key) && !taken.has(f.key))],
  };
}

// ── Seed templates ───────────────────────────────────────────────────────────
// Kept small and ordinary (memory: surface-no-programmer-ui — these read as
// plain notes, not schemas). Personas: student (reading), meeting-notes
// (meeting), everyone (daily), ttrpg (character).

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: "daily",
    label: "Daily note",
    icon: "CalendarDays",
    description: "Today's journal with agenda + log",
    title: "{date}",
    body: [
      "# {date}",
      "",
      "## Agenda",
      "- ",
      "",
      "## Notes",
      "",
      "## Log",
      "- ",
      "",
    ].join("\n"),
    tags: ["daily"],
    day: true,
  },
  {
    id: "meeting",
    label: "Meeting notes",
    icon: "Users",
    description: "Attendees, agenda, decisions, action items",
    title: "Meeting — {datetime}",
    body: [
      "# Meeting — {datetime}",
      "",
      "**Attendees:** ",
      "",
      "## Agenda",
      "- ",
      "",
      "## Discussion",
      "",
      "## Decisions",
      "- ",
      "",
      "## Action items",
      "- [ ] ",
      "",
    ].join("\n"),
    tags: ["meeting"],
    // The Meeting tag pack requires its date.
    fields: [{ key: "meeting_date", value: "{date}" }],
  },
  {
    id: "reading",
    label: "Reading notes",
    icon: "BookOpen",
    description: "Source, key ideas, quotes, takeaways",
    title: "Reading — ",
    body: [
      "# Reading notes",
      "",
      "**Source:** ",
      "**Author:** ",
      "**Date:** {date}",
      "",
      "## Key ideas",
      "- ",
      "",
      "## Quotes",
      "> ",
      "",
      "## My takeaways",
      "- ",
      "",
    ].join("\n"),
    tags: ["reading"],
  },
  {
    id: "character",
    label: "Character sheet",
    icon: "Swords",
    description: "TTRPG character: stats, traits, inventory",
    title: "Character — ",
    body: [
      "# Character",
      "",
      "**Class / Role:** ",
      "**Level:** 1",
      "",
      "## Stats",
      "| STR | DEX | CON | INT | WIS | CHA |",
      "| --- | --- | --- | --- | --- | --- |",
      "|     |     |     |     |     |     |",
      "",
      "## Traits & Background",
      "- ",
      "",
      "## Inventory",
      "- ",
      "",
      "## Notes",
      "",
    ].join("\n"),
    tags: ["ttrpg/character"],
  },
];

/** Lookup by id (used by the slash menu / palette run handlers). */
export function getNoteTemplate(id: string): NoteTemplate | undefined {
  return NOTE_TEMPLATES.find((t) => t.id === id);
}
