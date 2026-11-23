// Wording batch (業主實測, 繁體中文): no internal field names, raw [[link]] brackets, English leftovers
// or mixed quote marks reach a person.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { setLocalePref, t } from "../lib/i18n";
import { changeSummaryText } from "../lib/history/changeSummaryText";
import { ReviewCard } from "../components/markdownSurfaces";

beforeEach(() => { act(() => setLocalePref("zh-TW")); });
afterEach(() => { cleanup(); act(() => setLocalePref("en")); });

describe("the review card's back", () => {
  it("shows the lecture's name, not [[brackets]]", () => {
    const shown = (markdown: string) => { const text = render(<ReviewCard>{markdown}</ReviewCard>).container.textContent; cleanup(); return text; };
    expect(shown("see [[Note|the alias]] and [[Page#Heading]]")).toContain("see the alias and Page › Heading");
    expect(shown("code `[[x]]` stays")).toContain("[[x]]");
    // A name with *, _ or $ is text, not formatting.
    expect(shown("— [[a*b_c $d]]")).toContain("a*b_c $d");
    expect(render(<ReviewCard>{"— [[a*b*c]] and [[x_y_z]]"}</ReviewCard>).container.textContent).toContain("a*b*c and x_y_z");
    const { container } = render(<ReviewCard>{"答案\n\n— [[作業系統 W9 虛擬記憶體]]\n"}</ReviewCard>);
    expect(container.textContent).toContain("作業系統 W9 虛擬記憶體");
    expect(container.textContent).not.toContain("[[");
  });
});

describe("a history line", () => {
  it("quotes each section the same way", () => {
    const text = changeSummaryText(t as never, { added: 1, changed: 0, removed: 0, sections: ["分頁", "換頁演算法"] } as never);
    expect(text).toBe("新增 1 段，在「分頁」、「換頁演算法」");
    expect(text).not.toMatch(/[“”]/);
  });
});

describe("a skill note's settings button", () => {
  it("names the settings for a person, not the YAML keys", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { editorFrontmatter } = await import("../lib/editorFrontmatter");
    const host = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: "---\ndescription: x\noutput: note\nmine: 1\n---\nBody\n", extensions: [editorFrontmatter] }) });
    const chip = view.dom.querySelector("button.cm-frontmatter-chip")!;
    expect(chip.textContent).toBe("⚙ 設定：說明 · 結果");
    expect(chip.getAttribute("aria-label")).not.toContain("description");
    view.destroy(); host.remove();
  });
});

// The zh-TW dictionary as a whole: what a person reads in Chinese must be Chinese, with no field names
// or two kinds of quote marks in one sentence. Covers every dictionary value (boot, late, module and AI-tab wording
// registered with the dictionary); it does not see text built in code (a note's title, an error's message) — those
// are covered by the owners listed in AGENTS.md (serverErrors, writeErrors, eventTypeLabel).
import { ZH_TW } from "../lib/i18n.zh-TW";

// English that stays English because it is a name a person types or sees outside Onden.
const STAYS_ENGLISH = new Set(["HTML", "Markdown", "DOI", "RSS", "English", "ISBN", "PDF", "Tailwind class"]);
const withoutPlaceholders = (value: string) => value.replace(/\{[^}]*\}/g, "");

describe("zh-TW dictionary wording", () => {
  const entries = Object.entries(ZH_TW as Record<string, string>);
  it("has no Chinese value that is still plain English", () => {
    const hits = entries.filter(([, v]) => !/[\u4e00-\u9fff]/.test(v) && /[A-Za-z]{3,}/.test(withoutPlaceholders(v)) && !STAYS_ENGLISH.has(v));
    expect(hits.map(([k, v]) => `${k} => ${v}`)).toEqual([]);
  });
  it("shows no snake_case field name (the [[ ]] syntax may be taught in help text)", () => {
    const hits = entries.filter(([, v]) => /\b[a-z]+_[a-z_]+\b/.test(withoutPlaceholders(v)));
    expect(hits.map(([k, v]) => `${k} => ${v}`)).toEqual([]);
  });
  it("does not mix 「」 with curly quotes in one sentence", () => {
    const hits = entries.filter(([, v]) => /[「」]/.test(v) && /[\u201c\u201d]/.test(v));
    expect(hits.map(([k, v]) => `${k} => ${v}`)).toEqual([]);
  });
});

describe("a sync conflict names the property", () => {
  it("each task property has its own plain name, never the stored key", async () => {
    const { fieldDisplayName } = await import("../components/viewLayoutKit/builtInFieldLabels");
    const { TASK_ATTR } = await import("@onden/markdown/contract");
    const names = Object.values(TASK_ATTR).map((key) => fieldDisplayName(key, t));
    expect(names.filter((name) => name.startsWith("_"))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });
});
