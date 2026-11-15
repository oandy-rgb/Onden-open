import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SchemaEditor, type FieldDef } from "../components/TagsPanel";

// These tests pin the de-jargoned HUMAN-VISIBLE labels (adversarial UX review:
// the schema/rollup UI must not leak backend jargon like "rollup"/"op"). The
// DATA keys are unchanged — so each test also asserts the underlying field
// shape still uses the real keys. (Old automation is no longer edited on the
// tag page; its plain-language notice is pinned in tagAutomationNotice.test.)

describe("Tag schema — de-jargoned labels", () => {
  it("the calculated-field option reads plainly (not 'rollup'), and picking it still writes a rollup config", () => {
    const onChange = vi.fn();
    const fields: FieldDef[] = [{ name: "hours", type: "number" }];
    render(<SchemaEditor fields={fields} onChange={onChange} />);

    // The pseudo-type option is human-friendly, never "rollup (computed)".
    const opt = screen.getByRole("option", { name: /calculated/i }) as HTMLOptionElement;
    expect(opt).toBeTruthy();
    expect(screen.queryByRole("option", { name: /rollup/i })).toBeNull();

    // Behaviour intact: selecting it seeds a real `rollup` config (op=count).
    const typeSelect = screen.getAllByRole("combobox")[0]!;
    fireEvent.change(typeSelect, { target: { value: "rollup" } });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as FieldDef[];
    expect((next[0] as { rollup?: { op?: string } }).rollup).toEqual({ op: "count" });
  });

  it("the calculated-field config shows the plain helper + 'Add up these values' (not 'attribute to aggregate'), and the op picker still drives rollup.op", () => {
    const onChange = vi.fn();
    // A field already in calculated mode with a non-count op so the value input shows.
    const fields: FieldDef[] = [{ name: "total", type: "number", rollup: { op: "sum" } } as FieldDef];
    render(<SchemaEditor fields={fields} onChange={onChange} />);

    expect(screen.getByText(/automatically totals values from items below/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/add up these values/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/only items tagged/i)).toBeTruthy();
    // No leaked jargon placeholders.
    expect(screen.queryByPlaceholderText(/attribute to aggregate/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/descendants/i)).toBeNull();

    // Behaviour intact: the "What to calculate" picker still mutates rollup.op.
    const opSelect = screen.getByTitle(/what to calculate/i) as HTMLSelectElement;
    fireEvent.change(opSelect, { target: { value: "max" } });
    const next = onChange.mock.calls.at(-1)![0] as FieldDef[];
    expect((next[0] as { rollup?: { op?: string } }).rollup?.op).toBe("max");
  });
});
