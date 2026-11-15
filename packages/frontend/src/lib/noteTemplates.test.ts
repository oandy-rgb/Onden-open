import { describe, it, expect } from "vitest";
import {
  NOTE_TEMPLATES,
  getNoteTemplate,
  isoDate,
  isoDateTime,
  templateVars,
  instantiateTemplate,
  fitTemplateToTags,
} from "./noteTemplates";
import { STARTER_PACKS, localizeStarterPack } from "../data/starterPacks";
import { registerDictionary, setLocalePref } from "./i18n";
import { ZH_TW } from "./i18n.zh-TW";

// Fixed, deterministic clock for placeholder assertions.
const FIXED = new Date(2026, 5, 13, 9, 5); // 2026-06-13 09:05 local

describe("noteTemplates date helpers", () => {
  it("isoDate zero-pads month/day", () => {
    expect(isoDate(new Date(2026, 0, 7))).toBe("2026-01-07");
    expect(isoDate(FIXED)).toBe("2026-06-13");
  });

  it("isoDateTime appends zero-padded HH:MM", () => {
    expect(isoDateTime(FIXED)).toBe("2026-06-13 09:05");
  });
});

describe("templateVars", () => {
  it("gives {date} and {datetime} the workspace's day and minute", () => {
    expect(templateVars(FIXED)).toEqual({ date: "2026-06-13", datetime: "2026-06-13 09:05" });
  });
});

describe("NOTE_TEMPLATES registry", () => {
  it("seeds the four requested personas' templates", () => {
    const ids = NOTE_TEMPLATES.map((t) => t.id).sort();
    expect(ids).toEqual(["character", "daily", "meeting", "reading"]);
  });

  it("every template has a non-empty label, icon and body scaffold", () => {
    for (const t of NOTE_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });

  it("getNoteTemplate looks up by id and returns undefined for unknowns", () => {
    expect(getNoteTemplate("meeting")?.label).toBe("Meeting notes");
    expect(getNoteTemplate("nope")).toBeUndefined();
  });
});

describe("instantiateTemplate", () => {
  it("resolves the daily template to today's ISO title + dated body, with #daily tag", () => {
    const out = instantiateTemplate(getNoteTemplate("daily")!, FIXED);
    expect(out.title).toBe("2026-06-13");
    expect(out.body).toContain("# 2026-06-13");
    expect(out.tags).toEqual(["daily"]);
    expect(out.attributes).toEqual([]);
  });

  it("resolves the meeting template title to a datetime-stamped heading + #meeting tag", () => {
    const out = instantiateTemplate(getNoteTemplate("meeting")!, FIXED);
    expect(out.title).toBe("Meeting — 2026-06-13 09:05");
    expect(out.body).toContain("## Action items");
    expect(out.tags).toEqual(["meeting"]);
  });

  it("carries nested tag paths through (character → ttrpg/character)", () => {
    const out = instantiateTemplate(getNoteTemplate("character")!, FIXED);
    expect(out.tags).toEqual(["ttrpg/character"]);
    // Body scaffold is stamped verbatim (no placeholders in the character sheet).
    expect(out.body).toContain("## Stats");
  });
});

describe("starter packs (a note only fills in fields)", () => {
  it("no pack stamps child notes, so the Meeting template still writes its own body", () => {
    for (const starter of STARTER_PACKS) expect(starter.pack).not.toHaveProperty("template_children");
    const meetingPack = STARTER_PACKS.find((p) => p.label.includes("Meeting"))!.pack as { fields: Array<{ name: string; label: string; type: "date" }> };
    const out = fitTemplateToTags(instantiateTemplate(getNoteTemplate("meeting")!, FIXED), [{ schema_fields: meetingPack.fields, schema_template_children: null }]);
    expect(out.body).toContain("# Meeting — ");
    expect(out.body).toContain("## Agenda");
    expect(out.attributes).toEqual([{ key: "meeting_date", value: "2026-06-13" }]);
  });

  it("localizeStarterPack names the tag and its fields in the interface language", () => {
    const book = localizeStarterPack(STARTER_PACKS[0]!) as { name: string; fields: Array<{ name: string; label: string; options?: string[] }> };
    expect(book.name).toBe("Book");
    registerDictionary("zh-TW", ZH_TW);
    setLocalePref("zh-TW");
    try {
      const zh = localizeStarterPack(STARTER_PACKS[0]!) as typeof book;
      expect(zh.name).toBe("書籍");
      expect(zh.fields.find((f) => f.name === "author")?.label).toBe("作者");
      expect(zh.fields.find((f) => f.name === "status")?.options).toEqual(["想讀", "閱讀中", "已讀完", "放棄"]);
    } finally { setLocalePref("en"); }
  });
});

describe("fitTemplateToTags (D69: one scaffold per note)", () => {
  const meeting = instantiateTemplate(getNoteTemplate("meeting")!, FIXED);
  const packTag = {
    schema_fields: [{ name: "meeting_date", label: "Date", type: "date" as const, required: true }],
    schema_template_children: [{ title: "Agenda" }, { title: "Decisions" }, { title: "Action items" }],
  };

  it("leaves the scaffold to a tag that stamps its own children, and fills its date", () => {
    const out = fitTemplateToTags(meeting, [packTag]);
    expect(out.body).toBe("");
    expect(out.attributes).toEqual([{ key: "meeting_date", value: "2026-06-13" }]);
  });

  it("keeps the body, and writes no field, for a plain label tag", () => {
    const out = fitTemplateToTags(meeting, [{ schema_fields: null, schema_template_children: null }]);
    expect(out.body).toContain("## Agenda");
    expect(out.attributes).toEqual([]);
  });

  it("a declared field without children keeps the body and fills the field", () => {
    const out = fitTemplateToTags(meeting, [{ ...packTag, schema_template_children: [] }]);
    expect(out.body).toContain("## Decisions");
    expect(out.attributes).toEqual([{ key: "meeting_date", value: "2026-06-13" }]);
  });
});
