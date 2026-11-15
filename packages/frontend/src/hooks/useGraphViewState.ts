// Canvas / graph display state for BuilderApp.
//
// Extracted from BuilderApp.tsx during Day 4 hook refactor. The 4 booleans
// + canvasSearch + toggle callback all coordinate what the graph/canvas
// shows when notesView === "canvas".

import { useState, useCallback } from "react";

export function useGraphViewState() {
  const [graphLocalMode, setGraphLocalMode] = useState(false);
  const [showTagEdges, setShowTagEdges] = useState(false);
  const [parentMode, setParentMode] = useState(false);
  const [canvasSearch, setCanvasSearch] = useState("");

  const toggleTagEdges = useCallback(() => {
    setShowTagEdges(v => !v);
  }, []);

  const toggleLocalMode = useCallback(() => {
    setGraphLocalMode(v => !v);
  }, []);

  const toggleParentMode = useCallback(() => {
    setParentMode(v => !v);
  }, []);

  return {
    graphLocalMode,
    setGraphLocalMode,
    showTagEdges,
    setShowTagEdges,
    parentMode,
    setParentMode,
    canvasSearch,
    setCanvasSearch,
    toggleTagEdges,
    toggleLocalMode,
    toggleParentMode,
  };
}
