import { ChevronDown, PanelLeft, PanelRight, PinOff, Search, Settings, SlidersHorizontal } from "lucide-react";
import { Suspense, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAccountSession } from "../lib/accountSession";
import SyncStatus, { useSyncTrouble, type SyncAction } from "./SyncStatus";
import AccountPanel from "./AccountPanel";
import ShellDialog from "./ShellDialog";
import { useT } from "../lib/i18n";
import type { AppMode as Mode } from "../hooks/useUiMode";
import "./CommandPalette.css";
import "./AppTopbar.css";
import { classNames } from "../lib/utils";
import { useShellNavigation } from "../hooks/useShellNavigation";
import { fittingModuleCount, viewLabel, type NavDestination } from "../hooks/shellNavigation";
import { usePhoneTopbarActionList } from "../lib/phoneTopbarActions";
import { openSettings } from "../lib/settingsRequest";
import { useKbdHint } from "../hooks/useKbdHint";
import { Button, SheetHeader, Menu, MenuItem, MenuSeparator, Pressable, usePopover, layerClass } from "./ui";
import { MOBILE_QUERY, useIsMobile, useMediaQuery } from "../hooks/useIsMobile";
import NavMarks from "./NavMarks";
import { observeSize } from "../lib/observeSize";
import { lazyWithReload } from "../lib/lazyWithReload";
import { onWindow } from "../lib/globalEvents";
import { requestSplitOpen, splitDrag } from "../lib/splitViewStore";

// 「接下來」 is a hint that may show a moment after the app: it and the day
// timeline it reads load on use, outside the boot JS (check-boot-bundle).
const NextUpTag = lazyWithReload(() => import("./NextUpTag"));
/** The page the 「接下來」 tag leads to (the tasks module's view id). */
const NEXT_UP_TARGET = "tasks";

type NavigationProps = {
  mode: Mode;
  setMode: (mode: Mode) => void;
  activePanel?: string | null;
  /** Open a module screen or reading section by its view id. */
  onOpenModule: (id: string) => void;
  /** Open what an imported module adds (its screen, the boards). */
  onOpenFeature: (id: string) => void;
};


/** Workspace destinations stay in the shell; views of the current note live
 * beside its content. 筆記 comes first, then the destinations in the nav
 * layout (hooks/shellNavigation, lib/navLayout; never edited: every core
 * page, then each imported module with a page of its own). Trailing module
 * entries fold into 「更多 ▾」 when the bar runs out of width (never wrapping
 * or scrolling); core pages never fold. 「更多 ▾」 also holds the destinations
 * not pinned, and 「自訂導覽列…」 (Settings › 導覽列). A right click on an
 * entry offers 「從導覽列移除」. */
export function AppNavigation(props: NavigationProps) {
  return <NavigationBar {...props} />;
}

/** The same bar for looking at, in Settings › 導覽列: nothing is lit, nothing
 *  opens, no menus. `onFoldedChange` reports the entries it folds into 「更多 ▾」
 *  at the width it is given, so the list beside it can say the same. */
export function AppNavigationPreview({ onFoldedChange }: { onFoldedChange?: (foldedIds: readonly string[]) => void }) {
  return <NavigationBar preview onFoldedChange={onFoldedChange} />;
}

function NavigationBar(props: Partial<NavigationProps> & { preview?: boolean; onFoldedChange?: (foldedIds: readonly string[]) => void }) {
  const canSplitHere = !useIsMobile();
  const t = useT();
  const preview = props.preview === true;
  const nav = useShellNavigation(
    preview ? undefined : { mode: props.mode!, activePanel: props.activePanel },
    preview ? undefined : { setMode: props.setMode!, onOpenModule: props.onOpenModule!, onOpenFeature: props.onOpenFeature! });
  const fixed = [nav.notes, ...nav.pinned.filter((d) => d.core)];
  const modules = nav.pinned.filter((d) => !d.core);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(modules.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const more = usePopover<HTMLButtonElement>({ open: moreOpen, onClose: () => setMoreOpen(false), placement: "bottom-start" });
  const [entryMenu, setEntryMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const entry = usePopover({ open: entryMenu !== null, onClose: () => setEntryMenu(null), at: entryMenu ?? undefined });
  const moreAlways = nav.unpinned.length > 0;
  const layoutKey = [...fixed, ...modules].map((d) => `${d.id}:${t(d.label)}`).join("|") + (moreAlways ? "|+more" : "");

  // The measuring copy renders once the bar has a layout (never in jsdom or a
  // hidden bar, where everything shows).
  const [measurable, setMeasurable] = useState(false);

  // Fit the bar: the budget is the left group's width less its other items
  // (logo, back); widths come from a hidden copy of every
  // button, so the visible row never has to overflow to be measured.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const group = nav?.parentElement;
    if (!nav || !group) return;
    const fit = () => {
      if (group.clientWidth === 0) { setShown(Number.MAX_SAFE_INTEGER); return; }
      const row = measureRef.current;
      if (!row) { setMeasurable(true); return; }
      const groupStyle = getComputedStyle(group);
      const navStyle = getComputedStyle(nav);
      const groupGap = parseFloat(groupStyle.columnGap) || 0;
      const siblings = [...group.children].filter((child) => child !== nav) as HTMLElement[];
      // clientWidth includes the group's own padding, which holds no items.
      const padding = (parseFloat(groupStyle.paddingLeft) || 0) + (parseFloat(groupStyle.paddingRight) || 0);
      const budget = group.clientWidth - padding - siblings.reduce((sum, child) => sum + child.offsetWidth, 0)
        - groupGap * siblings.length - (parseFloat(navStyle.marginLeft) || 0) - (parseFloat(navStyle.marginRight) || 0);
      const widths = (kind: string) => [...row.querySelectorAll<HTMLElement>(`[data-measure="${kind}"]`)].map((el) => el.offsetWidth);
      setShown(fittingModuleCount({
        budget, gap: parseFloat(navStyle.columnGap) || 0,
        core: widths("core"), modules: widths("module"), more: widths("more")[0] ?? 0, moreAlways,
      }));
    };
    fit();
    // Labels change width with the locale: the measuring row is watched too.
    const stop = observeSize([group, ...[...group.children].filter((child) => child !== nav), measureRef.current?.firstElementChild], fit);
    const stopResize = onWindow("resize", fit);
    return () => { stop(); stopResize(); };
  }, [layoutKey, measurable, moreAlways]);

  // The first `shown` module entries stay, in list order; core pages always do.
  const keptModules = new Set(modules.slice(0, shown).map((d) => d.id));
  const visible = [nav.notes, ...nav.pinned.filter((d) => d.core || keptModules.has(d.id))];
  const folded = modules.slice(shown);
  const inMore = [...folded, ...nav.unpinned];
  const foldedKey = folded.map((d) => d.id).join("|");
  const onFoldedChange = props.onFoldedChange;
  useEffect(() => { onFoldedChange?.(foldedKey ? foldedKey.split("|") : []); }, [foldedKey, onFoldedChange]);
  const foldedCurrent = !preview && inMore.some((d) => d.current);
  // A function can be dragged to the right half (lib/splitViewStore): the click still loads the left.
  const button = ({ id, label, Icon, open, current: here, indicators, view }: NavDestination) => {
    const current = here && !preview;
    return (
    <Pressable key={id} type="button" className={classNames("topbar-mode-btn", current && "active")}
      data-destination={id} aria-current={current ? "page" : undefined} onClick={preview ? undefined : open}
      draggable={!preview && id !== "notes" && !!view || undefined}
      onDragStart={!preview && id !== "notes" && view ? (event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", t(label)); splitDrag.begin({ kind: "page", mode: view }, "function"); } : undefined}
      onDragEnd={!preview && id !== "notes" && view ? () => { splitDrag.cancel(); } : undefined}
      onContextMenu={preview || id === "notes" ? undefined : (event) => { event.preventDefault(); setEntryMenu({ id, x: event.clientX, y: event.clientY }); }}>
      <Icon size={16} aria-hidden="true" /><span>{t(label)}</span>
      <NavMarks indicators={indicators} />
    </Pressable>
    );
  };
  const menuItem = ({ id, label, Icon, open, current, indicators }: NavDestination) => (
    <MenuItem key={id} onSelect={open} data-destination={id} aria-current={current ? "page" : undefined}
      className="topbar-more-item">
      <Icon size={16} aria-hidden="true" /><span>{t(label)}</span>
      <NavMarks indicators={indicators} />
    </MenuItem>
  );

  return (
    <nav ref={navRef} className={classNames("app-primary-nav", preview ? "app-primary-nav--preview" : "topbar-desktop-only")}
      aria-label={t("Primary")} aria-hidden={preview || undefined} inert={preview || undefined}>
      {visible.map(button)}
      {inMore.length > 0 && (
        <Pressable ref={more.anchor} type="button" className={classNames("topbar-mode-btn topbar-more-btn", foldedCurrent && "active")}
          aria-haspopup="menu" aria-expanded={moreOpen} aria-current={foldedCurrent ? "page" : undefined}
          onClick={preview ? undefined : () => setMoreOpen((open) => !open)}>
          <span>{t("More")}</span><ChevronDown size={14} aria-hidden="true" />
          {/* One dot when an entry folded inside has something new. */}
          <NavMarks indicators={inMore.flatMap((d) => d.indicators)} dotOnly />
        </Pressable>
      )}
      {moreOpen && inMore.length > 0 && (
        <Menu popover={more} label={t("More")}>
          {folded.map(menuItem)}
          {folded.length > 0 && nav.unpinned.length > 0 && <MenuSeparator />}
          {nav.unpinned.map(menuItem)}
          <MenuSeparator />
          <MenuItem onSelect={() => openSettings("navigation")} className="topbar-more-item">
            <SlidersHorizontal size={16} aria-hidden="true" /><span>{t("Customize navigation bar…")}</span>
          </MenuItem>
        </Menu>
      )}
      {entryMenu && (
        <Menu popover={entry} label={t(nav.candidates.find((d) => d.id === entryMenu.id)?.label ?? "")}>
          {canSplitHere && nav.candidates.find((d) => d.id === entryMenu.id)?.view && (
            <MenuItem onSelect={() => { const view = nav.candidates.find((d) => d.id === entryMenu.id)?.view; if (view) requestSplitOpen({ kind: "page", mode: view }, "right"); }}>
              <span>{t("Open on the right")}</span>
            </MenuItem>
          )}
          <MenuItem onSelect={() => nav.unpin(entryMenu.id, "desktop")}>
            <PinOff size={16} aria-hidden="true" /><span>{t("Remove from navigation bar")}</span>
          </MenuItem>
          <MenuItem onSelect={() => openSettings("navigation")}>
            <SlidersHorizontal size={16} aria-hidden="true" /><span>{t("Customize navigation bar…")}</span>
          </MenuItem>
        </Menu>
      )}
      {/* The measuring copy: every button at its rendered width. */}
      {measurable && <div ref={measureRef} className="app-primary-nav-measure" aria-hidden="true"><div className="app-primary-nav-measure-row">
        {fixed.map(({ id, label, Icon }) => (
          <span key={id} data-measure="core" className="topbar-mode-btn"><Icon size={16} /><span>{t(label)}</span></span>
        ))}
        {modules.map(({ id, label, Icon, indicators }) => (
          <span key={id} data-measure="module" className="topbar-mode-btn"><Icon size={16} /><span>{t(label)}</span><NavMarks indicators={indicators} /></span>
        ))}
        <span data-measure="more" className="topbar-mode-btn topbar-more-btn"><span>{t("More")}</span><ChevronDown size={14} /></span>
      </div></div>}
    </nav>
  );
}

// H4: online / actorRole come from the app store inside the component — no
// longer props.
// Memoized: with BuilderApp's callbacks identity-stable, the topbar skips
// renders for unrelated state (palette typing, dialogs, context menus).
type PaneToggle = { pressed: boolean; onToggle: () => void };

type Props = {
  mode: Mode;
  setMode: (mode: Mode) => void;
  activePanel?: string | null;
  /** Open a module screen or reading section by its view id. */
  onOpenModule: (id: string) => void;
  /** Open what an imported module adds. */
  onOpenFeature: (id: string) => void;
  onOpenPalette: () => void;
  /** The two-cell switch at the right end of the bar: the left cell opens and
   *  folds the notes list, the right cell the info panel. A cell with no
   *  toggle is greyed (a full page has neither column) and the whole switch
   *  is absent on a phone, where the note header holds the info button. */
  sidebarToggle?: PaneToggle;
  inspectorToggle?: PaneToggle;
  onOpenMembers: () => void;
  onOpenSettings: () => void;
  /** Manual "sync now" — flushes queued offline writes + pulls a delta. Wired
   *  to useAppData.sync. Lets the user force a drain from the account dialog
   *  instead of waiting for the reconnect handler. */
  onSyncNow?: SyncAction;
  /** Open the note a stuck change belongs to (from the sync status). */
  onOpenNote?: (noteId: string) => void;
};

/** The two-cell layout switch, [◧｜◨]: each cell shows its column open (pressed) or folded. */
function PaneSwitch({ sidebarToggle, inspectorToggle }: Pick<Props, "sidebarToggle" | "inspectorToggle">) {
  const t = useT();
  const sidebarKeys = useKbdHint("toggle-sidebar");
  const inspectorKeys = useKbdHint("toggle-inspector");
  return (
    <div className="topbar-pane-switch topbar-desktop-only" role="group" aria-label={t("Panels")}>
      <Button type="button" variant="icon" size="sm" className="notes-sidebar-toggle"
        disabled={!sidebarToggle} onClick={sidebarToggle?.onToggle}
        title={sidebarKeys ? t("Notes list ({keys})", { keys: sidebarKeys }) : t("Notes list")} aria-label={t("Notes list")}
        aria-pressed={sidebarToggle?.pressed ?? false}>
        <PanelLeft size={16} aria-hidden="true" />
      </Button>
      <Button type="button" variant="icon" size="sm" className="notes-inspector-toggle"
        disabled={!inspectorToggle} onClick={inspectorToggle?.onToggle}
        title={inspectorKeys ? t("Info ({keys})", { keys: inspectorKeys }) : t("Info")} aria-label={t("Info")}
        aria-pressed={inspectorToggle?.pressed ?? false}>
        <PanelRight size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The bar is three segments, the same on every page: the wordmark, the
 *  destinations and search, and the account with the layout switch. None
 *  follows the columns below, so dragging a column's edge never moves the bar;
 *  see AppTopbar.css. */
function AppTopbar({ mode, setMode, activePanel, onOpenModule, onOpenFeature, onOpenPalette, sidebarToggle, inspectorToggle, onOpenMembers, onOpenSettings, onSyncNow, onOpenNote }: Props) {
  const t = useT();
  const session = useAccountSession();
  const paletteKeys = useKbdHint("open-palette");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  // Settings: on a computer the gear is the bar's last item (the far right); a phone's bar has no room, so
  // there it is a row in the avatar's sheet. One entry on each besides the palette. The bar has no standing
  // sync dot: the avatar's dialog holds the sync status, and trouble (offline, waiting, refused input) shows
  // as a badge on the avatar.
  const phone = useMediaQuery(MOBILE_QUERY);
  const trouble = useSyncTrouble();
  const pageActions = usePhoneTopbarActionList();

  // The avatar is the last item on a phone (after search), and before the layout switch and the gear on a computer.
  const avatar = session?.user && (
    <div className="user-menu-wrap">
      <Pressable
        className="user-chip"
        onClick={() => setUserMenuOpen((v) => !v)}
        title={session.user.email}
        aria-haspopup="dialog" aria-expanded={userMenuOpen}
      >
        <span className="user-avatar">
          {(session.user.name || session.user.email).charAt(0).toUpperCase()}
          {trouble && <span className={`user-badge user-badge--${trouble.kind}`} role="img" aria-label={trouble.label} />}
        </span>
        <span className="user-name topbar-desktop-only">{session.user.name || session.user.email}</span>
      </Pressable>
      {userMenuOpen && (
        <ShellDialog sheet className={classNames("account-dialog", phone && "account-rows")} label={t("Account")} busy={accountBusy} onClose={() => setUserMenuOpen(false)}>
          <SheetHeader title={t("Account")} closeDisabled={accountBusy} onClose={() => setUserMenuOpen(false)} />
          <AccountPanel onBusyChange={setAccountBusy} onOpenMembers={() => { setUserMenuOpen(false); onOpenMembers(); }}>
            {/* The sync status in detail (works offline: local queue); on a phone, Settings too. */}
            <div className="account-sync"><SyncStatus onSyncNow={onSyncNow} onOpenNote={onOpenNote} expanded inlineFeedback disabled={accountBusy} /></div>
            {phone && (
              <Pressable type="button" className="account-row" disabled={accountBusy}
                onClick={() => { setUserMenuOpen(false); onOpenSettings(); }}>
                <Settings size={18} aria-hidden="true" /><span>{t("Settings")}</span>
              </Pressable>
            )}
          </AccountPanel>
        </ShellDialog>
      )}
    </div>
  );
  return (
    <header className={`${layerClass.fixed} app-topbar`}>
      <div className="app-topbar-left">
        {/* A phone names the page here (the nav's own name for it); a computer keeps the wordmark. */}
        {phone
          ? <span className="app-logo app-page-name">{t(viewLabel(mode))}</span>
          : <span className="app-logo">Onden</span>}
      </div>
      <div className="app-topbar-center topbar-desktop-only">
        <AppNavigation mode={mode} setMode={setMode} activePanel={activePanel}
          onOpenModule={onOpenModule} onOpenFeature={onOpenFeature} />
        <Pressable className="palette-trigger topbar-desktop-only" onClick={onOpenPalette} aria-label={t("Command palette")}>
          <Search size={15} aria-hidden="true" />
          <span>{t("Search")}…</span>
          {paletteKeys && <kbd>{paletteKeys}</kbd>}
        </Pressable>
      </div>
      <div className="app-topbar-right">
        {mode !== NEXT_UP_TARGET && <Suspense fallback={null}><NextUpTag onOpen={() => onOpenFeature(NEXT_UP_TARGET)} /></Suspense>}
        {/* Phone: what the page's title row used to hold, left of search. */}
        {phone && pageActions.map(({ id, label, Icon, onSelect, marked }) => (
          <Button key={id} type="button" variant="icon" size="sm" className="topbar-phone-action" data-action={id}
            onClick={(event) => onSelect(event.currentTarget)} title={label} aria-label={label}>
            <Icon size={18} aria-hidden="true" />
            {marked && <span className="topbar-action-dot" aria-hidden="true" />}
          </Button>
        ))}
        {/* Phone: search (the command palette) — the only touch entry to it; the avatar is the last item. */}
        {phone && (
          <Button type="button" variant="icon" size="sm" className="topbar-phone-search" onClick={onOpenPalette}
            title={t("Search")} aria-label={t("Search")}>
            <Search size={18} aria-hidden="true" />
          </Button>
        )}
        {!phone && avatar}
        {!phone && <PaneSwitch sidebarToggle={sidebarToggle} inspectorToggle={inspectorToggle} />}
        {!phone && (
          <Button type="button" variant="icon" size="sm" className="topbar-settings" onClick={onOpenSettings}
            title={t("Settings")} aria-label={t("Settings")}>
            <Settings size={16} aria-hidden="true" />
          </Button>
        )}
        {phone && avatar}
      </div>
    </header>
  );
}

export default memo(AppTopbar);
