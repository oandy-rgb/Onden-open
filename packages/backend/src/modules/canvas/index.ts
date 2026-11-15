import type { ModuleDefinition } from "../types.js";
import canvasRouter from "../../routes/canvases.js";
import boardsRouter from "../../routes/boards.js";

// The whiteboard (白板): canvases — canvas nodes with their card layout — and
// the board of a tag (its members laid out as cards). It was part of Onden
// before the module library. Like the view modules it is always on (2026-10-30:
// a way of seeing notes is chosen with 「＋」, never switched in Settings), so a
// workspace that turned it off earlier has it again and its boards untouched.
// The routes keep their paths and stay in routes/
// (docs/architecture/module-library.md, 「白板」).
export const canvasModule: ModuleDefinition = {
  id: "canvas",
  routePrefixes: ["/api/canvases", "/api/boards"],
  registerRoutes: (app) => {
    app.route("/api/canvases", canvasRouter);
    // Card layout of a canvas or of a tag's board, saved as changes (routes/boards.ts).
    app.route("/api/boards", boardsRouter);
  },
  library: { alwaysOn: true },
};
