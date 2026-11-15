import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent } from "react";
import { classNames } from "../../lib/utils";

// The app's tab pattern (WAI-ARIA): one TabList, a Tab per view, a TabPanel for the body.
//   <TabList label="Info">
//     <Tab id="x-tab-a" selected={tab === "a"} controls="x-panel" onClick={() => setTab("a")}>A</Tab>
//   </TabList>
//   <TabPanel id="x-panel" labelledBy="x-tab-a">…</TabPanel>
// Arrows (and Home/End) move between the tabs and select them, so a Tab only needs onClick.
// Only the selected Tab is in the tab order; pass tabIndex when no tab is selected.
// Styling stays with the caller's className. A Tab gets .tap-target for the phone hit area;
// tapTarget={false} is for a tab that already draws its own ::after.

const TAB_SELECTOR = '[role="tab"]:not(:disabled)';

type ListProps = Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-label"> & { label: string };

export function TabList({ label, onKeyDown, ...rest }: ListProps) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(TAB_SELECTOR));
    const at = tabs.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const to = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length]!;
    next.focus();
    next.click();
  };
  return <div role="tablist" aria-label={label} onKeyDown={move} {...rest} />;
}

type TabProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "aria-selected" | "aria-controls"> & {
  selected: boolean;
  /** The id of the TabPanel this tab shows. */
  controls?: string;
  tapTarget?: boolean;
};

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { selected, controls, tapTarget = true, className, type = "button", tabIndex, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={tabIndex ?? (selected ? 0 : -1)}
      className={classNames(tapTarget && "tap-target", className)}
      {...rest}
    />
  );
});

type PanelProps = Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-labelledby"> & {
  /** The id of the Tab that labels this panel. */
  labelledBy?: string;
};

export function TabPanel({ labelledBy, ...rest }: PanelProps) {
  return <div role="tabpanel" aria-labelledby={labelledBy} {...rest} />;
}
