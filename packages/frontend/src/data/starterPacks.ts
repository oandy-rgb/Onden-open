// Tag templates — class-tag packs that ship with Onden. A template only sets
// up fields (book / person / meeting / project), so a new user gets a working
// schema without designing one from scratch; it is offered in Settings ▸ Your Data. Functions such as review
// come from the module library instead: #複習 is the Review module's tag, so
// its pack is no longer offered here. The Tana data from 2026 (90% never finish
// setup, "schema design displaces work") is the cautionary tale this is
// trying to short-circuit.
//
// A template carries no child notes: a note using the tag only fills in field
// values, and the structure lives on the tag's page. (The tag schema can still
// hold template_children for a future, visible "template" feature; no pack here
// sets it.)
//
// Each pack here is a JSON file matching the `onden.tagpack/v1` format
// already accepted by POST /api/tags/import. Adding a new pack means
// dropping a new JSON file in ./packs/ and adding it to STARTER_PACKS.
//
// Schema.org / FOAF mappings on `behaviour.field_mappings` are stored but
// not yet read by any consumer — they're a forward-compat seed so future
// SPARQL / RAG features have a vocabulary to bind to. Documenting prior
// art is the point even when we don't act on it today.

import { t } from "../lib/i18n";
import bookPack from "./packs/book.tagpack.json";
import personPack from "./packs/person.tagpack.json";
import meetingPack from "./packs/meeting.tagpack.json";
import projectPack from "./packs/project.tagpack.json";

export type StarterPack = {
  /** Display name shown in the Library tab. */
  label: string;
  /** What the template sets up, in a line. */
  tagline: string;
  /** The raw JSON to POST to /api/tags/import. */
  pack: unknown;
};

export const STARTER_PACKS: StarterPack[] = [
  {
    label: "📚 Book",
    tagline: "Author, rating, reading status, start and finish dates.",
    pack: bookPack,
  },
  {
    label: "👥 Person",
    tagline: "Relationship, contact details, company and last contact.",
    pack: personPack,
  },
  {
    label: "🗓 Meeting",
    tagline: "Date, length, attendees, place and kind of meeting.",
    pack: meetingPack,
  },
  {
    label: "🚀 Project",
    tagline: "Status, owner, start date, deadline and goal.",
    pack: projectPack,
  },
];

type PackField = { label?: string; options?: string[] };

/** The pack as a new tag should be created in the current interface language:
 *  name, description, field labels and select options go through t() (the
 *  field `name` keys stay as they are). Tags that already exist are not
 *  renamed; the user edits those on the tag's page. */
export function localizeStarterPack(starter: StarterPack): Record<string, unknown> {
  const pack = starter.pack as Record<string, unknown> & { description?: string; fields?: PackField[] };
  return {
    ...pack,
    name: t(starter.label).replace(/^\S+\s+/, ""),
    ...(pack.description ? { description: t(pack.description) } : {}),
    fields: (pack.fields ?? []).map((field) => ({
      ...field,
      ...(field.label ? { label: t(field.label) } : {}),
      ...(field.options ? { options: field.options.map((option) => t(option)) } : {}),
    })),
  };
}
