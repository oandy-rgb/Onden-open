import { bindAccountStorage } from "../lib/accountStorage";
import { setAppState } from "../lib/appStore";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null), upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}) }));
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Spy on the shared api() helper — the inline-edit cell writes through it
// (PUT /api/nodes/:id/attributes/:key → spine mutate). We assert the URL,
// method and body shape rather than touching a real backend.
const apiMock = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({}));
// Spread the real module (noWorkspaceData et al.) so the offline write-through the
// cell now routes through (sendOrQueue → appStore/localDb) still resolves; only
// override api with the spy.
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: (path: string, init?: RequestInit) => apiMock(path, init) };
});

import TableLayout from "../modules/table/TableLayout";
import type { ExecResponse } from "../lib/viewExec";

function makeExec(visible: string[]): ExecResponse {
  return {
    rows: [
      {
        id: "node-1",
        title: "Widget",
        slug: "widget",
        created_at: "2025-12-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        attributes: { price: "100", note: "" },
      },
    ],
    total: 1, next: null,
    view: {
      layout: "table",
      group_by: null,
      visible_fields: visible,
      layout_config: {},
    },
  };
}

describe("TableLayout inline cell edit", () => {
  beforeEach(() => {
    setAppState({ online: true });
    apiMock.mockClear();
    apiMock.mockResolvedValue({});
  });

  it("does not edit the title column or built-in fields", () => {
    render(<TableLayout exec={makeExec(["title", "price", "updated_at"])} />);
    // Title renders as an open-note button, not an editable cell.
    expect(screen.getByTitle("Open this note")).toBeInTheDocument();
    // updated_at is built-in → plain span, no edit affordance.
    const editButtons = screen.queryAllByTitle("Click to edit");
    expect(editButtons.length).toBe(1); // only the `price` attribute cell
  });

  it("commits an edited text cell through the attribute PUT and refreshes", async () => {
    const onMutated = vi.fn();
    render(
      <TableLayout exec={makeExec(["title", "note"])} onMutated={onMutated} />,
    );

    // The empty `note` cell shows the em-dash placeholder; click to edit.
    fireEvent.click(screen.getByTitle("Click to edit"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const path = apiMock.mock.calls[0][0];
    const init = apiMock.mock.calls[0][1]!;
    expect(path).toBe("/api/nodes/node-1/attributes/note");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ value: "hello", value_type: "text" });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
  });

  it("infers number value_type for numeric input", async () => {
    render(<TableLayout exec={makeExec(["title", "price"])} />);
    fireEvent.click(screen.getByTitle("Click to edit"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const init = apiMock.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toMatchObject({ value: "250", value_type: "number" });
  });

  it("cancels on Escape without writing", () => {
    render(<TableLayout exec={makeExec(["title", "price"])} />);
    fireEvent.click(screen.getByTitle("Click to edit"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(apiMock).not.toHaveBeenCalled();
    // Edit closed → the cell button is back.
    expect(screen.getByTitle("Click to edit")).toBeInTheDocument();
  });

  it("does not write when the value is unchanged", () => {
    render(<TableLayout exec={makeExec(["title", "price"])} />);
    fireEvent.click(screen.getByTitle("Click to edit"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apiMock).not.toHaveBeenCalled();
  });

  describe("number column", () => {
    const numberExec = () => ({ ...makeExec(["title", "price"]), view: { ...makeExec(["title", "price"]).view, field_meta: { price: { type: "number" } } } }) as ExecResponse;
    const openCell = () => {
      fireEvent.click(screen.getByTitle("Click to edit"));
      return screen.getByRole("textbox") as HTMLInputElement;
    };

    it("asks the phone for a number pad", () => {
      render(<TableLayout exec={numberExec()} />);
      expect(openCell()).toHaveAttribute("inputmode", "decimal");
    });

    it("stores 1,200 as 1200", async () => {
      render(<TableLayout exec={numberExec()} />);
      const input = openCell();
      fireEvent.change(input, { target: { value: "1,200" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
      expect(JSON.parse(apiMock.mock.calls[0][1]!.body as string)).toMatchObject({ value: "1200", value_type: "number" });
    });

    it("says so beside the table, and sends nothing, for text in a number cell", () => {
      render(<TableLayout exec={numberExec()} />);
      const input = openCell();
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
      expect(apiMock).not.toHaveBeenCalled();
      expect(screen.getByText("Enter a number, like 1200 or 12.5.")).toBeInTheDocument();
    });

    it("sends one write when Enter is followed by the blur", async () => {
      render(<TableLayout exec={numberExec()} />);
      const input = openCell();
      fireEvent.change(input, { target: { value: "250" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
      await waitFor(() => expect(apiMock).toHaveBeenCalled());
      expect(apiMock).toHaveBeenCalledTimes(1);
    });
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
