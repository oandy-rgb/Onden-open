import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewSkillDialog, { parseTagNames } from "./NewSkillDialog";
import { skillsModule } from "./index";
import { useCreateSkillNote } from "../../lib/createSkillNote";

const create = vi.fn();
vi.mock("../../lib/createSkillNote", () => ({ useCreateSkillNote: vi.fn() }));

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: "n-1" });
  vi.mocked(useCreateSkillNote).mockReturnValue({ create });
});
afterEach(cleanup);

const fill = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

describe("New skill dialog", () => {
  it("needs a name and instructions before creating anything", () => {
    render(<NewSkillDialog onClose={() => {}} />);
    submit();
    expect(create).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("creates through createSkillNote with new note as the default output, then closes", async () => {
    const onClose = vi.fn();
    render(<NewSkillDialog onClose={onClose} />);
    fill("Skill name", "  Tidy  ");
    fill("Instructions for the AI", "Fix headings.");
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({ title: "Tidy", instructions: "Fix headings.", output: "note" });
  });

  it("passes the chosen output, description and applies_to tags", async () => {
    render(<NewSkillDialog onClose={() => {}} />);
    fill("Skill name", "Slides");
    fill("Instructions for the AI", "Make slides.");
    fireEvent.click(screen.getByRole("radio", { name: "Slides" }));
    fill(/Show on notes/, "#book, 食譜,book");
    fill(/One-line description/, "Deck maker");
    submit();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      title: "Slides", instructions: "Make slides.", output: "slide", description: "Deck maker", appliesTo: ["book", "食譜"],
    });
  });

  it("stays open and keeps the input when nothing was created", async () => {
    create.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<NewSkillDialog onClose={onClose} />);
    fill("Skill name", "Tidy");
    fill("Instructions for the AI", "Fix.");
    submit();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Skill name")).toHaveValue("Tidy");
  });

  it("parseTagNames drops # and duplicates", () => {
    expect(parseTagNames("#a, b、a\n c")).toEqual(["a", "b", "c"]);
  });

  it("is registered as the palette command 'New skill', available on any content note", () => {
    const cmd = skillsModule.noteCommands?.find((c) => c.label === "New skill");
    expect(cmd).toBeTruthy();
    expect(cmd?.available?.({ node_type: "content" } as never, "", { online: false })).toBe(true);
    expect(cmd?.available?.({ node_type: "canvas" } as never, "", { online: true })).toBe(false);
  });
});
