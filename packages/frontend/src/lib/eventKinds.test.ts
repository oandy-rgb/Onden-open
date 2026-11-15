import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { eventKind, eventKindClass, eventVerb, eventVerbSource, eventTypeLabel } from "./eventKinds";
import { setLocalePref } from "./i18n";
import { ZH_TW } from "./i18n.zh-TW";

describe("eventKind", () => {
  it("note lifecycle splits by what happened to the note", () => {
    expect(eventKind("NODE_CREATED")).toBe("create");
    expect(eventKind("NODE_RESTORED")).toBe("create");
    expect(eventKind("NODE_UNDELETED")).toBe("create");
    expect(eventKind("NODE_UPDATED")).toBe("edit");
    expect(eventKind("NODE_DELETED")).toBe("delete");
    expect(eventKind("NODE_PURGED")).toBe("delete");
  });

  it("visibility is a property, versions are versions — not note edits", () => {
    expect(eventKind("NODE_HIDDEN_CHANGED")).toBe("attr");
    expect(eventKind("NODE_VERSION_CREATED")).toBe("version");
    expect(eventKind("NODE_VERSION_APPROVED")).toBe("version");
  });

  it("families by prefix; anything else is other", () => {
    expect(eventKind("TAG_APPLIED")).toBe("tag");
    expect(eventKind("TAG_SCHEMA_UPDATED")).toBe("tag");
    expect(eventKind("ATTRIBUTE_SET")).toBe("attr");
    expect(eventKind("EDGE_CREATED")).toBe("edge");
    expect(eventKind("PUBLISH_SNAPSHOT_CREATED")).toBe("publish");
    expect(eventKind("SITE_CONFIG_UPDATED")).toBe("publish");
    expect(eventKind("TOKEN_CREATED")).toBe("other");
    expect(eventKind("SOMETHING_NEW")).toBe("other");
    expect(eventKindClass("TAG_REMOVED")).toBe("event-kind-tag");
  });

  it("tasks, spaces and paragraph nodes split by what happened, like notes", () => {
    expect(eventKind("TASK_CREATED")).toBe("create");
    expect(eventKind("TASK_UPDATED")).toBe("edit");
    expect(eventKind("TASK_OCCURRENCE_MISSED")).toBe("edit");
    expect(eventKind("TASK_DELETED")).toBe("delete");
    expect(eventKind("SPACE_CREATED")).toBe("create");
    expect(eventKind("SPACE_MEMBER_SET")).toBe("edit");
    expect(eventKind("SPACE_DELETED")).toBe("delete");
    expect(eventKind("BLOCK_NODE_CREATED")).toBe("create");
    expect(eventKind("BLOCK_NODE_RESTORED")).toBe("create");
    expect(eventKind("BLOCK_NODE_REMOVED")).toBe("delete");
    // Which space a note is in is a property of the note, like its visibility.
    expect(eventKind("NODE_SPACE_CHANGED")).toBe("attr");
    expect(eventKind("NODE_MOVED_SPACE")).toBe("attr");
  });
});

// Every event type the server can write, read from the backend source: the
// code handed to spine mutate() (`type:` / `eventType:`), to db.ts event()
// (its second argument) or to blockNodes' `record(`; a ternary gives both.
function emittedEventTypes(): Set<string> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "test") walk(p); }
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(p);
    }
  };
  walk(resolve(__dirname, "../../../backend/src"));
  const emitter = /(?:\b(?:type|eventType):\s*|\bevent\(\s*[\w.]+,\s*|\brecord\(\s*)([^,;\n]*)/g;
  const code = /["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g;
  const types = new Set<string>();
  for (const f of files) {
    for (const [, tail] of readFileSync(f, "utf8").matchAll(emitter)) {
      for (const [, c] of tail!.matchAll(code)) types.add(c!);
    }
  }
  return types;
}

// Written before tasks became #task-tagged notes (migration 062); old rows
// are still in the log.
const HISTORICAL = ["TASK_CREATED", "TASK_UPDATED", "TASK_DELETED"];

describe("every event has a name", () => {
  const types = emittedEventTypes();

  it("the scan finds each way of emitting", () => {
    // mutate() event, db.ts event(), a ternary, blockNodes' record(), eventType:
    for (const t of ["NODE_CREATED", "TASK_OCCURRENCE_MISSED", "EFFECT_REJECTED", "BOARD_UPDATED", "BLOCK_NODE_UPDATED", "NODE_RESTORED"]) {
      expect(types, t).toContain(t);
    }
  });

  it("every type the server emits, and every historical one, has a zh-TW label", () => {
    expect([...types, ...HISTORICAL].filter((t) => !ZH_TW[t])).toEqual([]);
  });
});

describe("no event shows as its code", () => {
  const types = [...emittedEventTypes(), ...HISTORICAL];

  it("in Traditional Chinese every event the server can write has a verb and a sentence that is not its code in words", () => {
    setLocalePref("zh-TW");
    try {
      expect(eventVerb("NODE_UPDATED")).toBe("編輯了"); // the Chinese dictionary is in use, so the loop below means something
      for (const type of types) {
        const words = type.toLowerCase().replace(/_/g, " ");
        expect(eventVerb(type), `verb of ${type}`).not.toBe(words);
        expect(eventTypeLabel(type), `name of ${type}`).not.toBe(words);
      }
    } finally { setLocalePref("en"); }
  });

  it("an AI's suggestion reads in plain words in both languages (the review card shows it)", () => {
    for (const type of ["AI_SUGGESTION_CREATED", "AI_SUGGESTION_ACCEPTED", "AI_SUGGESTION_REJECTED"]) {
      expect(eventVerb(type), type).toMatch(/^[A-Z][a-z]+( [A-Za-z]+)+$/);
      expect(eventVerb(type)).not.toMatch(/_|ai suggestion/);
      expect(ZH_TW[eventVerbSource(type)!], type).toBeTruthy();
    }
  });
});

describe("labels", () => {
  it("verb falls back to the code in words", () => {
    expect(eventVerb("NODE_UPDATED")).toBe("Edited");
    expect(eventVerb("NODE_PURGED")).toBe("node purged");
  });
});

describe("one vocabulary", () => {
  const css = readFileSync(join(__dirname, "../styles/event-kinds.css"), "utf8");

  it("every kind has a colour", () => {
    for (const k of ["create", "edit", "delete", "tag", "attr", "edge", "publish", "version", "other"]) {
      expect(css).toMatch(new RegExp(`^\\.event-kind-${k}\\s*\\{\\s*--event-color:`, "m"));
    }
  });

  it("in the dark theme every coloured kind reads at ≥ 4.5:1 on gray-1", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const bg = lum("#16130d");
    for (const k of ["create", "edit", "delete", "tag", "attr", "edge", "publish", "version"]) {
      const m = css.match(new RegExp(`\\[data-theme="dark"\\] \\.event-kind-${k}\\s*\\{\\s*--event-color:\\s*(#[0-9a-f]{6})`));
      expect(m, k).not.toBeNull();
      expect((lum(m![1]!) + 0.05) / (bg + 0.05), k).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no component keeps its own event colour or verb table", () => {
    const dir = join(__dirname, "../components");
    for (const f of readdirSync(dir).filter((n) => /\.(tsx?|css)$/.test(n) && !/\.test\./.test(n))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/function eventColor\b/);
      expect(src, f).not.toMatch(/--event-color:\s*#/);
      expect(src, f).not.toMatch(/\bconst (VERB|KIND)\b/);
      expect(src, f).not.toMatch(/\.inbox-kind-/);
    }
  });
});
