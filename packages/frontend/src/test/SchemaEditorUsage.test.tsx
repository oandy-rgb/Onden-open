import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SchemaEditor, fieldKeyFrom, type FieldDef } from "../components/TagsPanel";
import { isAttributeKey } from "@onden/markdown";

const FIELDS: FieldDef[] = [
  { name: "status", type: "select", options: ["a", "b"] },
  { name: "notes", type: "text" },
];

// The remove pause now runs through the shared ConfirmDialog (audit 3b) —
// it mounts its own root on document.body, so we drive it via screen.
async function expectDialog(matcher: RegExp): Promise<HTMLElement> {
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toMatch(matcher);
  return dialog;
}

async function dialogGone(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

describe("SchemaEditor field-usage (P2 migration preview)", () => {
  afterEach(async () => {
    await dialogGone();
    vi.restoreAllMocks();
  });

  it("shows the in-use badge only for populated fields", () => {
    render(<SchemaEditor fields={FIELDS} onChange={() => {}} fieldUsage={{ status: 7 }} />);
    expect(screen.getByText("7 in use")).toBeTruthy();
    expect(screen.queryByText("0 in use")).toBeNull();
    expect(screen.queryByText("usage unknown")).toBeNull();
  });

  it("removing a USED field asks first, quoting the count; cancel keeps it", async () => {
    const onChange = vi.fn();
    render(<SchemaEditor fields={FIELDS} onChange={onChange} fieldUsage={{ status: 7 }} />);
    const removeButtons = screen.getAllByTitle(/remove/i);

    fireEvent.click(removeButtons[0]!);
    await expectDialog(/7 note\(s\)/);
    fireEvent.click(screen.getByText("Cancel"));
    await dialogGone();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(removeButtons[0]!);
    await expectDialog(/7 note\(s\)/);
    fireEvent.click(screen.getByText("Remove field"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([FIELDS[1]]));
  });

  it("removing an UNUSED field never prompts", async () => {
    const onChange = vi.fn();
    render(<SchemaEditor fields={FIELDS} onChange={onChange} fieldUsage={{ status: 7 }} />);
    fireEvent.click(screen.getAllByTitle(/remove/i)[1]!);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([FIELDS[0]]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  // Audit fix 1: a failed usage fetch must read as UNKNOWN, never as zero —
  // the badge is the safety signal before destructive schema edits.
  it("fieldUsage === null shows an explicit 'usage unknown' badge on every field", () => {
    render(<SchemaEditor fields={FIELDS} onChange={() => {}} fieldUsage={null} />);
    expect(screen.getAllByText("usage unknown")).toHaveLength(FIELDS.length);
  });

  it("removing a field with UNKNOWN usage is treated as not safe — asks first", async () => {
    const onChange = vi.fn();
    render(<SchemaEditor fields={FIELDS} onChange={onChange} fieldUsage={null} />);

    fireEvent.click(screen.getAllByTitle(/remove/i)[1]!);
    await expectDialog(/Could not check whether "notes" is in use/);
    fireEvent.click(screen.getByText("Cancel"));
    await dialogGone();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTitle(/remove/i)[1]!);
    await expectDialog(/Could not check/);
    fireEvent.click(screen.getByText("Remove field"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([FIELDS[0]]));
  });

  it("omitted fieldUsage (host doesn't track usage) shows no badge and no gate", async () => {
    const onChange = vi.fn();
    render(<SchemaEditor fields={FIELDS} onChange={onChange} />);
    expect(screen.queryByText("usage unknown")).toBeNull();
    fireEvent.click(screen.getAllByTitle(/remove/i)[0]!);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([FIELDS[1]]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// D44: a field's key is an attribute key every grammar reads back.
describe("fieldKeyFrom", () => {
  it("keeps any script, joins words with _, and never starts with a digit", () => {
    expect(fieldKeyFrom("作者")).toBe("作者");
    expect(fieldKeyFrom("Due Date")).toBe("due_date");
    expect(fieldKeyFrom("2024 目標")).toBe("f_2024_目標");
    expect(fieldKeyFrom("  ?! ")).toBe("field");
    for (const label of ["作者", "Due Date", "2024 目標", "a:b", "x".repeat(60), "𠀀".repeat(50)]) {
      expect(isAttributeKey(fieldKeyFrom(label)), label).toBe(true);
    }
  });

  // D58: a script's vowel signs are part of the word, and the key is NFC.
  it("keeps combining marks and composes a decomposed label", () => {
    expect(fieldKeyFrom("कीमत")).toBe("कीमत");
    expect(fieldKeyFrom("Cafe\u0301 Menu")).toBe("café_menu");
  });
});
