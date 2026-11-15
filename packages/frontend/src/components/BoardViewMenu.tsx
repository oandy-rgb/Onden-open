import { useState } from "react";
import { Maximize2, Minimize2, SlidersHorizontal } from "lucide-react";
import { TREE_DEPTHS, type TreeDepth } from "../lib/boardTree";
import type { TreeMode } from "../lib/boardTreeSettings";
import { effectiveDefault, titleOnlyFarOn, withEveryCardSet, type CardDefault, type CardDisplaySettings } from "../lib/cardDisplay";
import { t } from "../lib/i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { Button, Popover, Switch, usePopover } from "./ui";
import { ViewStripEnd, useInViewStrip } from "./viewTabs";
import "./BoardViewMenu.css";

export type BoardViewMenuProps = {
  /** A note's board that can follow its sub-notes; absent on a tag's board. */
  tree?: { mode: TreeMode; depth: TreeDepth; setMode: (mode: TreeMode) => void; setDepth: (depth: TreeDepth) => void };
  /** How cards are drawn; `onDisplay` stores the whole next settings. */
  display: CardDisplaySettings;
  onDisplay: (display: CardDisplaySettings) => void;
  minimap: boolean;
  onMinimap: (shown: boolean) => void;
  fullscreen: boolean;
  /** Absent on a phone, where the board is always full screen. */
  onFullscreen?: () => void;
};

/** The board's top-right corner: 「顯示」 (what the board shows — settings only;
 *  arranging, export and import are actions and live in the tool bar's ⋯) and the
 *  full-screen button beside it. On a phone 「顯示」 is a bottom sheet. */
export default function BoardViewMenu(props: BoardViewMenuProps) {
  const { tree, display, onDisplay, minimap, onMinimap, fullscreen, onFullscreen } = props;
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-end" });
  const inStrip = useInViewStrip();
  return (
    <ViewStripEnd slot="tools">
    <div className={inStrip ? "board-view-controls board-view-controls--strip" : "board-view-controls"}>
      <Button variant="secondary" size="sm" ref={pop.anchor} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <SlidersHorizontal size={15} /> {t("Display")}
      </Button>
      {onFullscreen && <Button variant="icon" size="sm" aria-pressed={fullscreen} aria-label={fullscreen ? t("Exit full screen") : t("Full screen")}
        title={fullscreen ? t("Exit full screen (Esc)") : t("Full screen")} onClick={onFullscreen}>
        {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </Button>}
      {open && (
        <Popover popover={pop} label={t("Display")} className="board-view-panel" sheet={phone}>
          {tree && (
            <label className="board-view-row">
              <span title={t("Lay out this note's sub-notes as a tree, and follow them as they change")}>{t("Follow sub-notes")}</span>
              <Switch on={tree.mode === "auto"} label={t("Follow sub-notes")} onChange={(on) => tree.setMode(on ? "auto" : "manual")} />
            </label>
          )}
          {tree?.mode === "auto" && (
            <div className="board-view-row" role="group" aria-label={t("Levels")}>
              <span>{t("Levels")}</span>
              <span className="board-view-levels">
                {TREE_DEPTHS.map((depth) => (
                  <Button key={depth} size="sm" variant="secondary" aria-pressed={tree.depth === depth} onClick={() => tree.setDepth(depth)}>
                    {depth === "all" ? t("All") : depth}
                  </Button>
                ))}
              </span>
            </div>
          )}
          {/* One choice for every card: it becomes the board's default and drops each card's own choice
              (withEveryCardSet); a card can still be folded or expanded on its own afterwards. */}
          <div className="board-view-row" role="group" aria-label={t("Cards")}>
            <span>{t("Cards")}</span>
            <span className="board-view-levels">
              {(["folded", "expanded"] as const satisfies readonly CardDefault[]).map((choice) => (
                <Button key={choice} size="sm" variant="secondary" aria-pressed={effectiveDefault(display) === choice}
                  onClick={() => onDisplay(withEveryCardSet(display, choice))}>
                  {choice === "folded" ? t("Fold card") : t("Expand card")}
                </Button>
              ))}
            </span>
          </div>
          <label className="board-view-row">
            <span>{t("Titles only when zoomed out")}</span>
            <Switch on={titleOnlyFarOn(display)} label={t("Titles only when zoomed out")} onChange={(on) => onDisplay({ ...display, titleOnlyFar: on })} />
          </label>
          <p className="board-view-hint">{t("Zoomed out below 30%, cards keep only the title, in larger text, to see the whole board. Click a title to zoom to that card.")}</p>
          {!phone && (
            <label className="board-view-row">
              <span>{t("Minimap")}</span>
              <Switch on={minimap} label={t("Minimap")} onChange={onMinimap} />
            </label>
          )}
        </Popover>
      )}
    </div>
    </ViewStripEnd>
  );
}
