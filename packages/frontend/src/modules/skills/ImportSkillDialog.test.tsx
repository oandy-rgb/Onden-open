import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportSkillDialog from "./ImportSkillDialog";
import { useCreateSkillNote } from "../../lib/createSkillNote";

// 匯入 SKILL.md: paste or choose a file, see what is (not) imported, then create.
const create = vi.fn();
vi.mock("../../lib/createSkillNote", () => ({ useCreateSkillNote: vi.fn() }));

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: "n-1" });
  vi.mocked(useCreateSkillNote).mockReturnValue({ create });
});
afterEach(cleanup);

const paste = (text: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

describe("Import SKILL.md", () => {
  it("shows the unknown keys and the script notice, then creates the skill from the text only", async () => {
    const onClose = vi.fn();
    render(<ImportSkillDialog onClose={onClose} />);
    paste("---\r\nname: pdf-helper\r\ndescription: Fill PDFs\r\nlicense: MIT\r\n---\r\nRun `python scripts/fill.py` then summarize.\r\n");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("pdf helper")).toBeInTheDocument();
    expect(screen.getByText(/Not imported .*: license/)).toBeInTheDocument();
    expect(screen.getByText(/scripts or other files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      title: "pdf helper", description: "Fill PDFs", instructions: "Run `python scripts/fill.py` then summarize.",
    });
  });

  it("stays open when nothing was created", async () => {
    create.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<ImportSkillDialog onClose={onClose} />);
    paste("# Tidy\n\nFix headings.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says a .zip is not supported and an empty SKILL.md has no instructions", async () => {
    render(<ImportSkillDialog onClose={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "skill.zip", { type: "application/zip" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(".zip can't be read");
    paste("---\nname: x\n---\n");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("no instructions");
  });
});
