// Create-dialog state for BuilderApp's top-bar "+" panel.
//
// Extracted from BuilderApp.tsx during Day 4 hook refactor. Pure-state
// grouping — no side effects, no callbacks; just bundles related
// useState calls so BuilderApp doesn't need to track them in line.
//
// Reference: trilium-main/apps/client/src/widgets/react/hooks.tsx pattern
// (cohesive named hooks grouping related state).

import { useState } from "react";
import { t } from "../lib/i18n";

export function useCreateDialog() {
  const [createOpen, setCreateOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(() => t("New Markdown Node"));
  const [taskTitle, setTaskTitle] = useState("");

  return {
    createOpen,
    setCreateOpen,
    eventsOpen,
    setEventsOpen,
    draftTitle,
    setDraftTitle,
    taskTitle,
    setTaskTitle,
  };
}
