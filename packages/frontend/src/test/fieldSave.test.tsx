import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextValueField } from "../components/attributes/TextValueField";
import { CustomRow } from "../components/attributes/CustomRow";
import { WriteStorageError } from "../lib/data/writeErrors";
import { ApiError } from "../lib/api";
import FeaturedFields from "../components/FeaturedFields";

function gate() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("field save acknowledgement", () => {
  it("writes a text field directly, deduplicates Enter/blur and retains a failed draft", async () => {
    const pending = gate(); const onSave = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    render(<TextValueField field={{ type: "text" }} label="Title" value="Old" onSave={onSave} />);
    const input = screen.getByRole("textbox"); fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Enter" }); fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledOnce(); expect(input).toBeInTheDocument();
    pending.reject(new WriteStorageError(new Error("quota")));
    await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
    expect(input).toHaveValue("Draft");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith("Draft");
  });

  it("keeps a custom property's draft on a terminal rejection", async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError(422, "Invalid value"));
    render(<CustomRow attr={{ key: "rating", value: "3", value_type: "number", is_inheritable: true, source: "explicit" }} onSave={onSave} onDelete={() => {}} />);
    fireEvent.click(screen.getByText("3")); const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "bad" } }); fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
    expect(input).toHaveValue("bad"); expect(onSave).toHaveBeenCalledWith("bad", "number", true);
  });

  it("does not discard the featured-field editor when its domain rejects saving", async () => {
    const onAttrSet = vi.fn().mockRejectedValue(new ApiError(422, "Invalid value"));
    render(<FeaturedFields attrs={{ topic: "Old" }} classTags={[{ id: "tag", name: "Tag", color: "#fff", schema_id: null, schema_fields: [{ name: "topic", type: "text" }] }]} onAttrSet={onAttrSet} />);
    fireEvent.click(screen.getByTitle("Edit topic")); const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Draft" } }); fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onAttrSet).toHaveBeenCalledWith("topic", "Draft", "text"));
    expect(input).toHaveValue("Draft"); expect(input).toBeInTheDocument();
  });
});
