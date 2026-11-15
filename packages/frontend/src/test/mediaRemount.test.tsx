// A playing <audio>/<video> must survive the note re-rendering (autosave, sync
// replacing the `nodes` list, a typed character elsewhere in the note): the
// same src keeps the same DOM element, otherwise playback resets to 0:00.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";

const sources = {
  "markdown image syntax audio": "![](/api/media/a.mp3)",
  "markdown image syntax video": "![](/api/media/v.mp4)",
  "raw html audio": '<audio src="/api/media/a.mp3" controls></audio>',
  "raw html video": '<video src="/api/media/v.mp4" controls></video>',
};

describe("media elements are not remounted by a re-render", () => {
  for (const [label, md] of Object.entries(sources)) {
    it(label, () => {
      const tag = md.includes("mp3") || md.includes("<audio") ? "audio" : "video";
      const { container, rerender } = render(<MarkdownRenderer nodes={[]}>{`intro\n\n${md}`}</MarkdownRenderer>);
      const before = container.querySelector(tag);
      expect(before).not.toBeNull();
      // New `nodes` array and an edited paragraph above, the way sync + autosave arrive.
      rerender(<MarkdownRenderer nodes={[]}>{`intro edited\n\n${md}`}</MarkdownRenderer>);
      expect(container.querySelector(tag)).toBe(before);
      rerender(<MarkdownRenderer nodes={[]} onNavigate={() => {}} resolveImage={(s) => s}>{`intro edited\n\n${md}`}</MarkdownRenderer>);
      expect(container.querySelector(tag)).toBe(before);
    });
  }
});
