// An attachment archiver cannot read (it vanished after the existence check) is skipped with a warning and must not stall the entries
// after it: pacedArchive counted it as queued but archiver never emits `entry`
// for it, so after MAX_PENDING of them addText waited forever.
import { describe, expect, it } from "vitest";
import { pacedArchive } from "../services/archiveStream.js";

describe("pacedArchive with unreadable files", () => {
  it("keeps accepting entries after more than MAX_PENDING skipped files", async () => {
    const zip = pacedArchive();
    zip.archive.on("warning", () => {});
    zip.archive.resume(); // a reader that keeps up
    const gone = "00000000000000000000000000000000.png";
    const adding = (async () => {
      for (let i = 0; i < 20; i++) await zip.addMedia(`${gone}-${i}`, `attachments/${i}`);
      await zip.addText("note.md", "still here");
    })();
    const outcome = await Promise.race([
      adding.then(() => "done"),
      new Promise((r) => setTimeout(() => r("stalled"), 3000)),
    ]);
    expect(outcome).toBe("done");
  });
});
