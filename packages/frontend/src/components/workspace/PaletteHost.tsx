// The ⌘K palette with its engine (actions, search, ranking). Loaded the first
// time the palette opens, so none of that is in the boot JS; the open / query /
// row state stays in the shell (hooks/usePaletteState) because shortcuts set it.
import CommandPalette from "../CommandPalette";
import { useCommandPalette, type UseCommandPaletteOptions } from "../../hooks/useCommandPalette";
import type { PaletteState } from "../../hooks/usePaletteState";

export type PaletteWiring = { state: PaletteState; options: UseCommandPaletteOptions };

export default function PaletteHost({ state, options }: PaletteWiring) {
  const palette = useCommandPalette(options, state);
  return (
    <CommandPalette
      open={palette.paletteOpen}
      onClose={() => { if (!palette.actionBusy) palette.setPaletteOpen(false); }}
      query={palette.paletteQuery}
      onQueryChange={palette.setPaletteQuery}
      index={palette.paletteIndex}
      onIndexChange={palette.setPaletteIndex}
      items={palette.paletteItems}
      inputRef={palette.paletteInputRef}
      busy={palette.actionBusy}
      actionFailed={palette.actionFailed}
      searching={palette.searchLoading}
      searchError={palette.searchError}
      searchOutcome={palette.searchOutcome}
      onRetrySearch={palette.retrySearch}
      onSelect={palette.runPaletteItem}
    />
  );
}
