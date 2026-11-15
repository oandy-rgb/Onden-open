import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { act, type ComponentType } from "react";
import { setAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import type { Tag, SchemaField } from "../lib/api";
import FeaturedFields from "../components/FeaturedFields";
import { SchemaRow } from "../components/attributes";

// The code-split control arrives when the test says so, not after a number of milliseconds: each lazy component
// stays "still loading" (suspended) until `release()`, however early or late the module itself was first imported.
const loading = vi.hoisted(() => {
  const state = { open: true, promise: Promise.resolve(), release: () => {} };
  return {
    /** From now on lazy components do not show until `release()`. */
    hold() {
      state.open = false;
      state.promise = new Promise<void>((resolve) => { state.release = () => { state.open = true; resolve(); }; });
    },
    release: () => state.release(),
    state,
  };
});

vi.mock("../lib/lazyWithReload", async (importOriginal) => {
  const React = await import("react");
  return {
    ...(await importOriginal<typeof import("../lib/lazyWithReload")>()),
    lazyWithReload: (factory: () => Promise<{ default: ComponentType<never> }>) => {
      let loaded: ComponentType<never> | null = null;
      const real = factory().then((m) => { loaded = m.default; });
      return function Held(props: object) {
        if (!loading.state.open) throw loading.state.promise;
        if (!loaded) throw real;
        return React.createElement(loaded as ComponentType<object>, props);
      };
    },
  };
});

const tag = (fields: SchemaField[]): Tag => ({ id: "t", name: "t", color: "#888", schema_id: "s", schema_fields: fields });

describe("featured fields: the caret follows a slow-loading control", () => {
  it("pressing a cell focuses the control once it mounts, however late", async () => {
    setAppState({ data: { ...noWorkspaceData, nodes: [] } });
    render(<FeaturedFields classTags={[tag([{ name: "city", label: "城市", type: "text" }])]} attrs={{}} onAttrSet={() => {}} />);
    loading.hold();
    fireEvent.click(screen.getByTitle("Edit 城市"));
    expect(screen.queryByRole("textbox", { name: "城市" })).toBeNull(); // still loading: the test holds it
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); }); // far past the old ~1 s of polling
    expect(screen.queryByRole("textbox", { name: "城市" })).toBeNull();
    await act(async () => { loading.release(); });
    expect(await screen.findByRole("textbox", { name: "城市" })).toHaveFocus();
  });

  it("does not take the focus back when the person already moved to another field", async () => {
    setAppState({ data: { ...noWorkspaceData, nodes: [] } });
    render(<>
      <input aria-label="elsewhere" />
      <FeaturedFields classTags={[tag([{ name: "town", label: "鎮", type: "text" }])]} attrs={{}} onAttrSet={() => {}} />
    </>);
    loading.hold();
    fireEvent.click(screen.getByTitle("Edit 鎮"));
    const other = screen.getByLabelText("elsewhere");
    other.focus();
    expect(screen.queryByRole("textbox", { name: "鎮" })).toBeNull();
    await act(async () => { loading.release(); });
    const input = await screen.findByRole("textbox", { name: "鎮" });
    expect(input).not.toHaveFocus();
    expect(other).toHaveFocus();
  });

  it("the tag card's SchemaRow shows its control without taking the focus", () => {
    render(<SchemaRow field={{ name: "city", label: "城市", type: "text" }} value="" allNodes={[]} onSave={() => {}} />);
    expect(screen.getByRole("textbox", { name: "城市" })).not.toHaveFocus();
  });
});
