import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import { ApiError, type Tag, type TagMergePreview } from "../lib/api";
import { fetchTagMergePreview } from "../lib/api";
import { mergeTag } from "../lib/data/tagMerge";
import { ensureSentenceWording } from "../lib/serverErrors";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";

/** Rare tag actions (export, merge, delete) live in the title's ⋯ menu. */
function tagAction(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
  return screen.getByRole("menuitem", { name });
}


// P2 tag merge — the lens flow: pick a target, READ the plain-language
// preview, confirm. The merge endpoint must never fire before the preview's
// own confirm button is clicked.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    // Mount-time fetches the lens performs for unrelated sections.
    api: vi.fn(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/delete-preview")) {
        return { members: 0, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true };
      }
      if (path === "/api/tags") return [];
      return {};
    }),
    fetchTagMergePreview: vi.fn(),
  };
});
vi.mock("../lib/data/tagMerge", () => ({ mergeTag: vi.fn() }));

const SRC: Tag = { id: "00000000-0000-4000-8000-00000000000a", name: "src", color: "", schema_id: null };
const TGT: Tag = { id: "00000000-0000-4000-8000-00000000000b", name: "tgt", color: "", schema_id: null };

const PREVIEW: TagMergePreview = {
  source: { id: SRC.id, name: "src" },
  target: { id: TGT.id, name: "tgt" },
  members_gaining_target: 2,
  already_in_target: 1,
  fields_only_in_source: ["src_only"],
  functions_not_carried: 0,
  views_not_carried: 0,
  extenders_repointed: 0,
  reversible: true,
};

function renderLens(onSaved = vi.fn()) {
  render(<SchemaLens tag={SRC} online={true} onSaved={onSaved} allTags={[SRC, TGT]} />);
  return onSaved;
}

async function openPreview() {
  fireEvent.click(tagAction(/Merge into…/));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: TGT.id } });
  await waitFor(() => expect(screen.getByText(/Merging #src into #tgt/)).toBeInTheDocument());
  // getByText sees the text while the <dialog> is still closed; Modal opens it
  // with showModal() in an effect, and only then do role queries reach it.
  await screen.findByRole("button", { name: /Merge into #tgt/ });
}

beforeEach(() => {
  resetAppState();
  vi.clearAllMocks();
  vi.mocked(fetchTagMergePreview).mockResolvedValue(PREVIEW);
  vi.mocked(mergeTag).mockResolvedValue({ merged: true, members_gained_target: 2, source_deleted: true });
});

describe("SchemaLens tag merge (P2)", () => {
  it("picking a target shows the plain-language preview WITHOUT firing the merge", async () => {
    renderLens();
    await openPreview();

    expect(fetchTagMergePreview).toHaveBeenCalledWith(SRC.id, TGT.id);
    // The blast radius, in words a non-programmer reads.
    expect(screen.getByText(/2 notes will also get #tgt/)).toBeInTheDocument();
    expect(screen.getByText(/1 note already has #tgt/)).toBeInTheDocument();
    expect(screen.getByText(/"src_only" stay on the notes as plain properties/)).toBeInTheDocument();
    expect(screen.getByText(/#src is deleted — restore it from History/)).toBeInTheDocument();
    expect(mergeTag).not.toHaveBeenCalled();
  });

  it("Cancel closes the preview and nothing is merged", async () => {
    const onSaved = renderLens();
    await openPreview();

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText(/Merging #src into #tgt/)).toBeNull());
    expect(mergeTag).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("confirm fires the merge, toasts the result, and refreshes app data", async () => {
    const onSaved = renderLens();
    await openPreview();

    fireEvent.click(screen.getByRole("button", { name: /Merge into #tgt/ }));
    await waitFor(() => expect(mergeTag).toHaveBeenCalledWith(SRC.id, TGT.id));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const toasts = getAppState().toasts;
    expect(toasts.some((t) => t.kind === "success" && /Merged #src into #tgt — 2 note\(s\) updated/.test(t.message))).toBe(true);
    // Panel closed after a successful merge — the source tag is gone.
    expect(screen.queryByText(/Merging #src into #tgt/)).toBeNull();
  });

  it("a failed merge surfaces a readable error toast and keeps the preview open", async () => {
    const onSaved = renderLens();
    const body = JSON.stringify({ error: "owner_only" });
    await ensureSentenceWording(body); // the rarer codes' wording loads on use, as readErrorBody does
    vi.mocked(mergeTag).mockRejectedValue(new ApiError(403, body));
    await openPreview();

    fireEvent.click(screen.getByRole("button", { name: /Merge into #tgt/ }));
    await waitFor(() => {
      const toasts = getAppState().toasts;
      expect(toasts.some((t) => t.kind === "error" && t.message === "Only the workspace owner can do that.")).toBe(true);
    });
    expect(screen.getByText(/Merging #src into #tgt/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a failed preview fetch toasts and never shows a confirm button", async () => {
    renderLens();
    vi.mocked(fetchTagMergePreview).mockRejectedValue(new ApiError(404, JSON.stringify({ error: "not_found" })));

    fireEvent.click(tagAction(/Merge into…/));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: TGT.id } });

    await waitFor(() => {
      expect(getAppState().toasts.some((t) => t.kind === "error" && t.message === "It no longer exists, or you can't see it.")).toBe(true);
    });
    expect(screen.queryByRole("button", { name: /Merge into #tgt/ })).toBeNull();
    expect(mergeTag).not.toHaveBeenCalled();
  });

  it("never offers a reserved tag as a merge target", () => {
    const task: Tag = { id: "00000000-0000-4000-8000-00000000000c", name: "Tasks", reserved_key: "task", color: "", schema_id: null };
    render(<SchemaLens tag={SRC} online={true} onSaved={vi.fn()} allTags={[SRC, TGT, task]} />);
    fireEvent.click(tagAction(/Merge into…/));
    const options = Array.from(screen.getByRole("combobox").querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(options).toContain(TGT.id);
    expect(options).not.toContain(task.id);
  });

  it("a reserved tag's page offers neither Merge nor Delete", () => {
    const config: Tag = { id: "00000000-0000-4000-8000-00000000000d", name: "workspace-config", reserved_key: "workspace-config", color: "", schema_id: null };
    render(<SchemaLens tag={config} online={true} onSaved={vi.fn()} allTags={[config, TGT]} />);
    fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
    expect(screen.queryByRole("menuitem", { name: /Merge into…/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Delete tag/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Export tag/ })).toBeInTheDocument();
    expect(screen.getByText(/System tag/)).toBeInTheDocument();
  });

  it("a module's own tag offers neither Merge nor Delete while the module is on; when it is off, both come back", () => {
    const inbox: Tag = { id: "00000000-0000-4000-8000-00000000000e", name: "收件匣", schema_module: "capture", color: "", schema_id: null };
    const skills: Tag = { id: "00000000-0000-4000-8000-00000000000f", name: "skill", schema_module: "skills", color: "", schema_id: null };
    // Capture is built-in: always on.
    const first = render(<SchemaLens tag={inbox} online={true} onSaved={vi.fn()} allTags={[inbox, TGT]} />);
    fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
    expect(screen.queryByRole("menuitem", { name: /Merge into…/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Delete tag/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Export tag/ })).toBeInTheDocument();
    first.unmount();
    // A library module: on (the workspace lists it) or off.
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: ["skills"] } } }));
    const on = render(<SchemaLens tag={skills} online={true} onSaved={vi.fn()} allTags={[skills, TGT]} />);
    fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
    expect(screen.queryByRole("menuitem", { name: /Delete tag/ })).toBeNull();
    on.unmount();
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: [] } } }));
    render(<SchemaLens tag={skills} online={true} onSaved={vi.fn()} allTags={[skills, TGT]} />);
    expect(tagAction(/Delete tag/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Merge into…/ })).toBeInTheDocument();
  });

  // merge-preview-functions-views (scan 06 M3): the preview says, in words, that the merged-away tag's functions and views stay behind.
  it("says the source's functions and views are not carried over, with how many, and says nothing when it has none", async () => {
    vi.mocked(fetchTagMergePreview).mockResolvedValueOnce({ ...PREVIEW, functions_not_carried: 1, views_not_carried: 2 });
    renderLens();
    await openPreview();
    expect(screen.getByText("#src's 1 function is not carried over to #tgt")).toBeInTheDocument();
    expect(screen.getByText("#src's 2 views are not carried over to #tgt")).toBeInTheDocument();
  });
  it("leaves the not-carried lines out when the source has no functions or views", async () => {
    vi.mocked(fetchTagMergePreview).mockResolvedValueOnce(PREVIEW);
    renderLens();
    await openPreview();
    expect(screen.queryByText(/not carried over/)).toBeNull();
  });
  it("offers neither the tag's own sub-tags nor a module tag to merge into", () => {
    const sub: Tag = { id: "00000000-0000-4000-8000-00000000000c", name: "sub", color: "", schema_id: null, parent_id: SRC.id };
    const grandSub: Tag = { id: "00000000-0000-4000-8000-00000000000d", name: "grandsub", color: "", schema_id: null, parent_id: sub.id };
    const mod: Tag = { id: "00000000-0000-4000-8000-00000000000e", name: "review", color: "", schema_id: null, schema_module: "review" };
    render(<SchemaLens tag={SRC} online={true} onSaved={vi.fn()} allTags={[SRC, TGT, sub, grandSub, mod]} />);
    fireEvent.click(tagAction(/Merge into…/));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["choose a tag…", "#tgt"]);
  });
});
