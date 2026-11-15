// Same-name fields are refused (2026-10-18): a field the host keeps back
// because another tag has its name is marked with that tag, and a new field's
// key never takes a name around it. The 409 the server answers otherwise
// reads as a sentence.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SchemaEditor, type FieldDef } from "../components/TagsPanel";
import { ApiError } from "../lib/api";

describe("SchemaEditor and same-name fields", () => {
  it("marks a held-back field, naming the tag above that gives it", () => {
    render(<SchemaEditor fields={[{ name: "pages", label: "Pages", type: "text" }]} onChange={() => {}}
      clashes={new Map([["pages", { tag: "Book", field: "Pages", below: false }]])} />);
    expect(screen.getByRole("alert").textContent).toMatch(/#Book already gives the field "Pages"/);
  });

  it("marks a held-back field, naming the tag below that declares it", () => {
    render(<SchemaEditor fields={[{ name: "pages", type: "text" }]} onChange={() => {}}
      clashes={new Map([["pages", { tag: "Novel", field: "pages", below: true }]])} />);
    expect(screen.getByRole("alert").textContent).toMatch(/#Novel below already has the field "pages"/);
  });

  it("no mark for a field not held back, whatever its label", () => {
    render(<SchemaEditor fields={[{ name: "writer", label: "Pages", type: "text" }]} onChange={() => {}}
      clashes={new Map([["pages", { tag: "Book", field: "Pages", below: false }]])} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a new field's derived key skips the taken names", () => {
    const onChange = vi.fn();
    const fields: FieldDef[] = [{ name: "field_1", label: "pages", type: "text" }];
    render(<SchemaEditor fields={fields} onChange={onChange} takenNames={["pages"]} />);
    fireEvent.blur(screen.getByDisplayValue("pages"));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ name: "pages_2" })]);
  });
});

describe("the field_name_inherited refusal", () => {
  it("names the tags and the field", () => {
    const err = new ApiError(409, JSON.stringify({
      error: "field_name_inherited", detail: "x",
      clashes: [{ tag: "a", field: "pages", from: "b", tag_title: "Novel", from_title: "Book" }],
    }));
    expect(err.message).toBe('#Book already has the field "pages", which #Novel declares too — rename one of them first');
    expect(new ApiError(409, JSON.stringify({ error: "field_name_inherited" })).message).toMatch(/already has a field with this name/);
  });
});
