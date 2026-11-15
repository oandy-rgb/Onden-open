import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetAppState } from "../lib/appStore";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: vi.fn(async () => ({})), fetchTagMergePreview: vi.fn(), mergeTag: vi.fn() };
});
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(async () => null), upsertAttribute: vi.fn(async () => null),
}));

import SchemaLens from "../components/tagPage";
import type { Tag } from "../lib/api";

const tag = (name: string, module: string | null): Tag => ({ id: "00000000-0000-4000-8000-00000000000a", name, color: "", schema_id: null, schema_module: module });

beforeEach(() => { resetAppState(); });

describe("a module's tag page carries the module's add dialog", () => {
  it("the skill tag offers the SKILL.md import", async () => {
    const t = tag("skill", "skills");
    render(<SchemaLens tag={t} online onSaved={vi.fn()} allTags={[t]} canManage />);
    await userEvent.click(await screen.findByRole("button", { name: "Import SKILL.md…" }));
    expect(await screen.findByRole("heading", { name: "Import SKILL.md" })).toBeInTheDocument();
  });

  it("an ordinary tag has no add dialog, and offline the button waits", async () => {
    const plain = tag("book", null);
    const { unmount } = render(<SchemaLens tag={plain} online onSaved={vi.fn()} allTags={[plain]} canManage />);
    expect(screen.queryByRole("button", { name: /SKILL\.md/ })).toBeNull();
    unmount();
    const skill = tag("skill", "skills");
    render(<SchemaLens tag={skill} online={false} onSaved={vi.fn()} allTags={[skill]} canManage />);
    expect(await screen.findByRole("button", { name: "Import SKILL.md…" })).toBeDisabled();
  });
});
