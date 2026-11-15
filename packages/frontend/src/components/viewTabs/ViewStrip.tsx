import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { classNames } from "../../lib/utils";

// The title strip of a page (docs/agents/decisions-ui.md, 筆記與標籤頁的視角分頁): one full-width row at the
// top of the centre pane. The page's view tabs sit at its left; its right end has two slots that the open tab's
// own content fills with a portal, so the tab's buttons stay in the tab's component (state and handlers with
// the editor or the board) while the strip stays in one place whichever tab is open:
//   · "tools" — what only this tab has (the whiteboard's 「顯示」 and full screen);
//   · "more"  — the note's ⋯ (always after the tools).
// Where no strip is drawn (a phone, a page with no tabs) `ViewStripEnd` draws its children where they are. A phone's
// tabs are not a strip: NotesWorkspace draws the same `ViewTabs` as a row in the page above its title (⊟ ⋯ stay in the
// note's top bar), and only a full-screen board has the title sheet (BoardPhoneNav).

type Slots = { present: boolean; tools: HTMLElement | null; more: HTMLElement | null };
const NO_STRIP: Slots = { present: false, tools: null, more: null };
const ViewStripContext = createContext<Slots>(NO_STRIP);

/** The strip's host: `present` says whether the page draws one; `bar` is what to render in it. */
export function useViewStripHost(present: boolean) {
  const [tools, setTools] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState<HTMLElement | null>(null);
  const slots = useMemo<Slots>(() => ({ present, tools, more }), [present, tools, more]);
  return { slots, toolsRef: setTools, moreRef: setMore };
}

export const ViewStripProvider = ViewStripContext.Provider;

/** True when a strip is drawn above the page (its slots take portals). */
export function useInViewStrip(): boolean { return useContext(ViewStripContext).present; }

/** The strip: the tabs at the left, the two slots at the right. */
export function ViewStripBar({ children, toolsRef, moreRef }: {
  children: ReactNode; toolsRef: (el: HTMLElement | null) => void; moreRef: (el: HTMLElement | null) => void;
}) {
  return (
    <div className="center-lens-bar">
      {children}
      <div className="view-strip-end">
        <div className="view-strip-slot" ref={toolsRef} data-slot="tools" />
        <div className="view-strip-slot" ref={moreRef} data-slot="more" />
      </div>
    </div>
  );
}

/** Draws `children` in the strip's slot; with no strip, where it is written. Until the slot exists it draws nothing. */
export function ViewStripEnd({ slot, children, className }: { slot: "tools" | "more"; children: ReactNode; className?: string }) {
  const slots = useContext(ViewStripContext);
  if (!slots.present) return <>{children}</>;
  const target = slots[slot];
  return target ? createPortal(<div className={classNames("view-strip-group", className)}>{children}</div>, target) : null;
}
