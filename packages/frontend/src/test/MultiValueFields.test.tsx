// D117: a stored list (a JSON array) is shown and edited as a list by the
// attribute panel's rows, whatever the field's cardinality, and the
// collection views group it by element.
import { vi } from "vitest";
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async () => ({}), getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}),
}));
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SchemaRow } from "../components/attributes/SchemaRow";
import type { ContentNode, SchemaField } from "../lib/api";

const allNodes = [["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"]].map(([id, title]) => ({ id, title, hidden: false })) as unknown as ContentNode[];

/** The row with the stored value kept in state, as the panel keeps it. */
function Row({ field, initial, saved }: { field: SchemaField; initial: string; saved: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <SchemaRow field={field} value={value} allNodes={allNodes} onSave={(next) => { saved.push(next); setValue(next); }} />
    </div>
  );
}

describe("a relation list (export → import: related: [[Alpha]], [[Beta]])", () => {
  const related: SchemaField = { name: "related", type: "relation" }; // not cardinality many

  it("shows every target, not an empty picker", () => {
    render(<Row field={related} initial={'["a","b"]'} saved={[]} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("a pick adds to the list instead of replacing it", async () => {
    const saved: string[] = [];
    render(<Row field={related} initial={'["a","b"]'} saved={saved} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    // the new, empty slot is the one still showing "Pick a note…"
    await userEvent.click(await screen.findByText("Pick a note…"));
    await userEvent.click(await screen.findByRole("button", { name: "Gamma" }));
    await waitFor(() => expect(saved.at(-1)).toBe('["a","b","c"]'));
  });

  it("a single id under a relation field is still the one-target picker", () => {
    render(<Row field={related} initial="a" saved={[]} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});

describe("a many select field (topics: select [ml, db], many)", () => {
  const topics: SchemaField = { name: "topics", type: "select", options: ["ml", "db"], cardinality: "many" };

  it("adding 'ml' writes the list ['ml'] (the server now accepts it)", async () => {
    const saved: string[] = [];
    render(<Row field={topics} initial="" saved={saved} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(await screen.findByRole("button", { name: "ml" }));
    await waitFor(() => expect(saved.at(-1)).toBe('["ml"]'));
  });

  it("shows each stored element in its own slot", () => {
    render(<Row field={topics} initial={'["ml","db"]'} saved={[]} />);
    expect(screen.getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual(["ml", "db"]);
  });
});

describe("an Obsidian list under a text field (authors: [Alice, Bob])", () => {
  const authors: SchemaField = { name: "authors", type: "text" };

  it("shows the names, not the JSON", () => {
    render(<Row field={authors} initial={'["Alice","Bob"]'} saved={[]} />);
    expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bob")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/\[/)).toBeNull();
  });

  it("a text value that merely starts with [ stays one value", () => {
    render(<Row field={authors} initial="[draft" saved={[]} />);
    expect(screen.getByDisplayValue("[draft")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});

describe("a read-only note shows a list as its elements", () => {
  it("joins them, relation targets by title", () => {
    render(<SchemaRow field={{ name: "related", type: "relation" }} value={'["a","b"]'} allNodes={allNodes} onSave={() => {}} readOnly />);
    expect(screen.getByText("Alpha, Beta")).toBeInTheDocument();
  });
});

describe("Logseq 2.0.2 cross-check: pickers keep what is stored", () => {
  it("a select whose stored option was removed from the tag still shows that value", () => {
    const status: SchemaField = { name: "status", type: "select", options: ["open", "done"] };
    render(<Row field={status} initial="archived" saved={[]} />);
    // A few short options are chips (OptionChips): the stored one is among them, chosen.
    expect(screen.getByRole("button", { name: "archived" })).toHaveAttribute("aria-pressed", "true");
  });
});
