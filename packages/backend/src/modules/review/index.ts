import type { ModuleDefinition } from "../types.js";
import type { AgentTool } from "../../services/agentTools/index.js";
import reviewRouter from "./routes.js";
import { reviewQueueTool } from "./reviewQueueTool.js";
// Installs the card-progress copy core asks for when a block moves (block-nodes.md).
import "./seam.js";

export { ReviewError } from "./service.js";

// The review module — FSRS spaced repetition as onden's first
// plugin-shaped capability. See modules/README.md for the convention and
// service.ts for the design (card = a note or paragraph with its own reference,
// progress = review_states per person, migration 092).
//
// agentTools: ONE read-only tool (reviewQueue), the actuator seam for ⑥
// "agent 解題" — an agent pulls the study queue, then works solutions with
// the existing write tools (updateNode/createNode). NO grade tool: an agent
// grading its own cards is meaningless (the schedule models human memory),
// so the human always grades, the agent only assists.
export const reviewModule: ModuleDefinition = {
  id: "review",
  personalTables: ["review_states"],
  routePrefixes: ["/api/review"],
  registerRoutes: (app) => {
    app.route("/api/review", reviewRouter);
  },
  agentTools: [reviewQueueTool as AgentTool],
  // No tag: a card is a note or a paragraph with its own function reference (migration 195, cards.ts).
  library: {},
};
