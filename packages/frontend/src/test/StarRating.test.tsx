import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StarRating, parseRating } from "../components/attributes/StarRating";

// Rating field type: stars are a renderer over a plain number. These pin the
// number<->stars round-trip (parseRating), the read-only display (table /
// gallery cells), and the interactive editor's click/clear behaviour.

describe("parseRating", () => {
  it("coerces strings, null and junk into a non-negative number", () => {
    expect(parseRating("3")).toBe(3);
    expect(parseRating("4.5")).toBe(4.5);
    expect(parseRating("")).toBe(0);
    expect(parseRating(null)).toBe(0);
    expect(parseRating(undefined)).toBe(0);
    expect(parseRating("not a number")).toBe(0);
    expect(parseRating("-2")).toBe(0); // negatives clamp to 0
  });
});

describe("StarRating read-only", () => {
  it("renders max stars with `value` of them filled", () => {
    const { container } = render(<StarRating value="3" max={5} />);
    // no interactive buttons in read-only mode
    expect(container.querySelectorAll("button").length).toBe(0);
    const stars = container.querySelectorAll(".star");
    expect(stars.length).toBe(5);
    expect(container.querySelectorAll(".star--on").length).toBe(3);
  });

  it("caps the filled count at max even when the stored value overshoots", () => {
    const { container } = render(<StarRating value="99" max={5} />);
    expect(container.querySelectorAll(".star--on").length).toBe(5);
  });
});

describe("StarRating interactive", () => {
  it("saves the clicked star value", () => {
    const onSave = vi.fn();
    render(<StarRating value="" max={5} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("4 stars"));
    expect(onSave).toHaveBeenCalledWith("4");
  });

  it("clicking the current value clears it back to empty", () => {
    const onSave = vi.fn();
    render(<StarRating value="3" max={5} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("3 stars"));
    expect(onSave).toHaveBeenCalledWith("");
  });

  it("honours a custom max (e.g. 10-star scale)", () => {
    const { container } = render(<StarRating value="7" max={10} onSave={() => {}} />);
    expect(container.querySelectorAll("button.star").length).toBe(10);
  });
});
