// What the browser app refuses before asking the backend (src/browser/unavailable.ts).
import { describe, expect, it } from "vitest";
import { unavailableInBrowserApp } from "../browser/unavailable.js";

describe("unavailable in the browser app", () => {
  it("does not refuse uploads or reading media: files are kept in the browser", () => {
    for (const [method, path] of [["POST", "/api/media"], ["PUT", "/api/media/abc"], ["GET", "/api/media/abc"], ["DELETE", "/api/media/abc"]] as const) {
      expect(unavailableInBrowserApp(method, path), `${method} ${path}`).toBeNull();
    }
  });

  it("refuses what needs the network or a server, whatever the method", () => {
    for (const [method, path] of [["POST", "/api/push/subscribe"], ["POST", "/api/bookmark/meta"]] as const) {
      expect(unavailableInBrowserApp(method, path), `${method} ${path}`).not.toBeNull();
    }
  });

  it("matches whole path segments: a neighbouring name is a different route", () => {
    expect(unavailableInBrowserApp("POST", "/api/media-library")).toBeNull();
    expect(unavailableInBrowserApp("POST", "/api/ai/runs")).toBeNull(); // the AI module's own gate answers (switched off)
    expect(unavailableInBrowserApp("GET", "/api/backup/full.zip")).toBeNull();
    expect(unavailableInBrowserApp("POST", "/api/backup/restore/upload")).toBeNull(); // restoring works (in-memory file system)
    expect(unavailableInBrowserApp("POST", "/api/nodes")).toBeNull();
  });
});
