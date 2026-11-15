import { MoreHorizontal, Pin, PinOff, Plus } from "lucide-react";
import { Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import type { NavIndicatorProps } from "../modules";
import "./MobileNav.css";
import type { AppMode as Mode } from "../hooks/useUiMode";
import { useT } from "../lib/i18n";
import ShellDialog from "./ShellDialog";
import SyncStatus, { type SyncAction } from "./SyncStatus";
import { usePendingWrites, useIncomingProblem } from "../lib/data";
import { useAppSelector } from "../lib/appStore";
import { classNames } from "../lib/utils";
import { getMoreNavigationGroups, type NavDestination } from "../hooks/shellNavigation";
import { useShellNavigation } from "../hooks/useShellNavigation";
import { Button, Menu, MenuItem, usePopover, SheetHeader, Pressable, layerClass } from "./ui";
import { splitAroundCapture } from "../lib/navLayout";
import { useLongPress } from "../hooks/useLongPress";
import { useIsOwner } from "../lib/capabilities";
import { openSettings } from "../lib/settingsRequest";
import NavMarks from "./NavMarks";
import { lazyWithReload } from "../lib/lazyWithReload";
import { isEscapeKey } from "../lib/keys";
import { useDismiss } from "../hooks/useEscapeKey";

// 「換掉哪一個」 opens only when a long-pressed item is pinned to a full bar: the nav editor's code loads then.
const NavSwapDialog = lazyWithReload(() => import("./NavLayoutEditor").then((m) => ({ default: m.NavSwapDialog })));

// The bottom bar: Notes, up to three pinned destinations with the central
// Capture among them, and More (hooks/shellNavigation, lib/navLayout).
// Never edited, it is Notes · Tasks · Capture · More, as before pins.
// Pinning happens here: a long press on a More row 「釘到導覽列」, on a bar
// slot 「從導覽列移除」; a full bar asks which entry to swap out. The sheet's
// 「編輯」 opens Settings › 導覽列, the one editing screen.
// Capture opens the existing quick-capture sheet rather than switching tabs.
// More lists every destination that is on and not in the bar, the same list
// as the nav editor's 「在「更多」裡」. It is navigation only (hooks/shellNavigation.ts): account, sync
// status, Settings and sign-out sit behind the top-bar avatar (AppTopbar).
// This component owns the bottom bar, the More dialog and the pending-sync strip.

type Props = {
  mode: Mode;
  setMode: (mode: Mode) => void;
  /** The open action-panel overlay (ask / actors / …): core bar tabs show no
   *  active state while one covers the page. */
  activePanel?: string | null;
  /** Open the quick-capture sheet (the central + action). */
  onCapture: () => void;
  /** Open what an imported feature adds (More › 功能). */
  onOpenFeature: (id: string) => void;
  /** Open a module screen or reading section by its view id (a pinned
   *  reading hub opens on its last section). */
  onOpenModule?: (view: string) => void;
  onSyncNow?: SyncAction;
  onOpenNote?: (noteId: string) => void;
};

export default function MobileNav({
  mode,
  setMode,
  activePanel,
  onCapture,
  onOpenFeature,
  onOpenModule,
  onSyncNow,
  onOpenNote,
}: Props) {
  const t = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  // A More row whose pin menu is open (long press), and a pin waiting for
  // the swap answer.
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const pending = usePendingWrites();
  const incoming = useIncomingProblem();
  const online = useAppSelector(s => s.online);
  const nav = useShellNavigation({ mode, activePanel }, { setMode, onOpenFeature, onOpenModule: onOpenModule ?? onOpenFeature });
  const bar = [nav.notes, ...nav.phoneBar];
  // Capture sits in the middle of the bar (lib/navLayout splitAroundCapture).
  const { left, right } = splitAroundCapture(bar);
  // A page reached from More (關係圖, 歷史, a module's page) lights More.
  const fromMore = !activePanel && !bar.some((d) => d.current);
  const isOwner = useIsOwner();
  // 更多 holds every destination that is on and not in the bar (the nav editor's
  // 「在「更多」裡」), so one dot shows when any of them has news.
  const moreGroups = getMoreNavigationGroups({
    // Importing modules is the owner's (Settings › Modules, as on the Tags page).
    onManageModules: isOwner ? () => openSettings("modules") : undefined,
  }, nav.phoneMore);
  const featureMarks = moreGroups.flatMap((group) => group.items.flatMap((item) => item.indicators));
  const byId = new Map(nav.candidates.map((d) => [d.id, d]));

  const closeSheet = () => { setMoreOpen(false); setRowMenu(null); };
  // Each row closes the sheet, then runs its action.
  const run = (fn: () => void) => () => { closeSheet(); fn(); };
  const pin = (id: string) => {
    setRowMenu(null);
    if ("full" in nav.pin(id, "phone")) setSwapFor(id);
  };

  return (
    <div className="mobile-shell">
      {(pending > 0 || !online || incoming) && <div className={`${layerClass.narrow} mobile-sync-strip`}>
        <SyncStatus onSyncNow={onSyncNow} onOpenNote={onOpenNote} expanded />
      </div>}
      <nav className={`${layerClass.narrow} mobile-bottom-nav`} aria-label={t("Primary")}>
        {/* Notes and the pinned destinations (hooks/shellNavigation);
            every other page and imported module is in More. */}
        {left.map((d) => <BarSlot key={d.id} destination={d} onUnpin={d.id === "notes" ? undefined : () => nav.unpin(d.id, "phone")} />)}

        {/* Central action — capture. HIG: raised, prominent, NOT a tab. */}
        <Pressable
          className="mobile-nav-capture"
          onClick={onCapture}
          aria-label={t("Capture")}
          title={t("Capture")}
        >
          <Plus size={26} />
        </Pressable>

        {right.map((d) => <BarSlot key={d.id} destination={d} onUnpin={() => nav.unpin(d.id, "phone")} />)}
        <Pressable
          className={classNames("mobile-nav-btn", (moreOpen || fromMore) && "active")}
          onClick={() => setMoreOpen(true)}
          aria-label={t("More")}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
        >
          <span className="mobile-nav-icon">
            <MoreHorizontal size={20} />
            <NavMarks indicators={featureMarks} dotOnly />
          </span>
          <span>{t("More")}</span>
        </Pressable>
      </nav>

      {moreOpen && (
        <ShellDialog sheet="bottom" className="mobile-more-sheet" label={t("More")} onClose={closeSheet}>
            <SheetHeader className="mobile-more-header" title={t("More")} onClose={closeSheet}
              actions={<Button variant="ghost" onClick={run(() => openSettings("navigation"))}>{t("Edit")}</Button>} />

            <div className="mobile-more-grid">
              {moreGroups.map(group => (
                <div key={group.id} className="mobile-more-group" role="group" aria-label={t(group.label)}>
                  <h3 className="mobile-more-group-title">{t(group.label)}</h3>
                  <ul className="mobile-more-items">
                    {group.items.map(({ id, label, Icon, onSelect, indicators, destination }) => (
                      <li key={id}>
                        <MoreRow id={id} label={t(label)} Icon={Icon} indicators={indicators} onSelect={run(onSelect)}
                          onLongPress={destination && byId.has(destination) ? () => setRowMenu(id) : undefined} />
                        {rowMenu === id && destination && (
                          <RowPinMenu label={t(label)} onPin={() => pin(destination)} onClose={() => setRowMenu(null)} />
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
        </ShellDialog>
      )}

      {swapFor && byId.get(swapFor) && (
        <Suspense fallback={null}>
          <NavSwapDialog incoming={byId.get(swapFor)!} bar={nav.phoneBar}
            onSwap={(out) => { nav.swap(swapFor, out); setSwapFor(null); }} onCancel={() => setSwapFor(null)} />
        </Suspense>
      )}
    </div>
  );
}

/** A bar slot. A long press offers 「從導覽列移除」 (not on 筆記). */
function BarSlot({ destination: { id, label, Icon, open, current }, onUnpin }: { destination: NavDestination; onUnpin?: () => void }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = usePopover<HTMLButtonElement>({ open: menuOpen, onClose: () => setMenuOpen(false), placement: "bottom-start" });
  const press = useLongPress(() => { if (onUnpin) setMenuOpen(true); });
  return (
    <>
      <Pressable ref={menu.anchor} className={classNames("mobile-nav-btn", current && "active")} data-destination={id}
        onClick={open} aria-current={current ? "page" : undefined} {...(onUnpin ? press : {})}>
        <Icon size={20} />
        <span>{t(label)}</span>
      </Pressable>
      {menuOpen && onUnpin && (
        <Menu popover={menu} label={t(label)} className="mobile-nav-slot-menu">
          <MenuItem onSelect={onUnpin}><PinOff size={16} aria-hidden="true" />{t("Remove from navigation bar")}</MenuItem>
        </Menu>
      )}
    </>
  );
}

function MoreRow({ id, label, Icon, indicators, onSelect, onLongPress }: {
  id: string; label: string; Icon: NavDestination["Icon"]; indicators: ComponentType<NavIndicatorProps>[];
  onSelect: () => void; onLongPress?: () => void;
}) {
  const press = useLongPress(() => onLongPress?.());
  return (
    <Pressable type="button" className="mobile-more-item" data-entry={id} onClick={onSelect} {...(onLongPress ? press : {})}>
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
      <NavMarks indicators={indicators} />
    </Pressable>
  );
}

/** A More row's long-press menu. Inline: a ui/Menu cannot open over a modal
 *  (ui/Modal), and the sheet is one. */
function RowPinMenu({ label, onPin, onClose }: { label: string; onPin: () => void; onClose: () => void }) {
  const t = useT();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  // Back closes this menu before the More sheet under it.
  useDismiss(() => { onClose(); }, true);
  return (
    <div className="mobile-more-row-menu" role="menu" aria-label={label}
      onKeyDown={(event) => { if (isEscapeKey(event)) { event.stopPropagation(); event.preventDefault(); onClose(); } }}>
      <Pressable ref={first} type="button" role="menuitem" className="mobile-more-row-menu-item" onClick={onPin}>
        <Pin size={16} aria-hidden="true" /><span>{t("Pin to navigation bar")}</span>
      </Pressable>
      <Pressable type="button" role="menuitem" className="mobile-more-row-menu-item" onClick={onClose}>
        <span>{t("Cancel")}</span>
      </Pressable>
    </div>
  );
}
