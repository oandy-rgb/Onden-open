import { describe, expect, it } from "vitest";
import { captureDestinationWords, destinationOf, parseStoredDestination, storedOf, usableDestination, type CaptureDestination } from "./captureDestination";

const world = (over: Partial<Parameters<typeof usableDestination>[1]> = {}) => ({ journalOn: true, noteCanHold: () => true, ...over });

describe("the capture destination setting", () => {
  it("stores the inbox as nothing, today's journal as a word, a note as its id", () => {
    expect(destinationOf(null)).toEqual({ kind: "inbox" });
    expect(destinationOf("inbox")).toEqual({ kind: "inbox" });
    expect(destinationOf("today")).toEqual({ kind: "today" });
    expect(destinationOf("n-1")).toEqual({ kind: "note", noteId: "n-1" });
    for (const d of [{ kind: "inbox" }, { kind: "today" }, { kind: "note", noteId: "n-1" }] as CaptureDestination[]) {
      expect(destinationOf(storedOf(d))).toEqual(d);
    }
  });

  it("reads back only a short non-empty string", () => {
    expect(parseStoredDestination("today")).toBe("today");
    for (const bad of ["", "x".repeat(65), 3, null, ["a"]]) expect(parseStoredDestination(bad)).toBeNull();
  });

  it("uses the choice while it works", () => {
    expect(usableDestination({ kind: "inbox" }, world())).toEqual({ kind: "inbox" });
    expect(usableDestination({ kind: "today" }, world())).toEqual({ kind: "today" });
    expect(usableDestination({ kind: "note", noteId: "n" }, world())).toEqual({ kind: "note", noteId: "n" });
  });

  it("falls back to the inbox: journal off, note gone or not writable", () => {
    expect(usableDestination({ kind: "today" }, world({ journalOn: false }))).toEqual({ kind: "inbox" });
    expect(usableDestination({ kind: "note", noteId: "n" }, world({ noteCanHold: () => false }))).toEqual({ kind: "inbox" });
  });

  it("names a destination in words, never an id", () => {
    const nodes = [{ id: "n", title: "Reading list" }, { id: "m", title: "" }];
    expect(captureDestinationWords({ kind: "inbox" }, nodes)).toBe("Inbox");
    expect(captureDestinationWords({ kind: "today" }, nodes)).toBe("Today's journal");
    expect(captureDestinationWords({ kind: "note", noteId: "n" }, nodes)).toBe("Reading list");
    expect(captureDestinationWords({ kind: "note", noteId: "m" }, nodes)).toBe("Untitled");
    expect(captureDestinationWords({ kind: "note", noteId: "gone" }, nodes)).toBe("Untitled");
  });
});
