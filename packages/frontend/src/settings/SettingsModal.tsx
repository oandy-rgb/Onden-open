import { useDismiss } from "../hooks/useEscapeKey";
import { ChevronLeft, ChevronRight, Smartphone, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SETTINGS, settingsSections, TABS } from "./registry";
import { isAdvanced, settingMatches, TabBody } from "./SettingRenderer";
import { useAboutIsNew, useListValues } from "./listValues";
import { Avatar, useAccountName, useAccountStatus } from "./AccountSetting";
import { useT } from "../lib/i18n";
import { useIsOwner } from "../lib/capabilities";
import type { SettingContext, SettingDef, TabSpec } from "../lib/settingsTypes";
import { resolveSettingsTab, type SettingsTab } from "../lib/settingsTab";
import { MODULE_SETTINGS } from "../modules";
import ModuleSettingsPage, { featureTitleOf, useSettingsModules } from "./ModuleSettingsPage";
import "./SettingsModal.css";
import { Button, Chip, Modal, Pressable, SearchField } from "../components/ui";
import { useIsMobile } from "../hooks/useIsMobile";

interface Props {
  online: boolean;
  onClose: () => void;
  onImportDone: () => void;
  onConnect: () => void;
  /** Close settings and open a tag's page. */
  onOpenTag?: (id: string) => void;
  onOpenNote?: (id: string) => void;
  /** The tab to open on (default: the list), or a feature's page. */
  initialTab?: SettingsTab;
}

// SettingsModal is a thin shell: it owns tab state, threads context to the
// registry-driven renderer, and lets each setting live as one entry in
// `settings/registry.tsx`. Adding a new setting = +1 array element.
//
// Both layouts list the same rows (settingsSections): your account first, then
// the TABS in the blocks of LIST_SECTIONS, which have no names. Each row says
// what it holds by its current value at the right, not by a sentence. A
// feature's own settings are not rows: they are on its page, reached from the
// Features row (`module:<id>`). A search lists the matching settings from every
// page, advanced ones included. Advanced settings are otherwise folded under a
// toggle.
//
// On the phone (useIsMobile) it is a full-screen, two-level screen: level 1 is
// the list (and the search results), level 2 is one page with a back button.
// Entering level 2 pushes a history entry with the same URL, so the browser /
// Android back gesture returns to level 1. The desktop sidebar is the same list
// beside the open page.
//
// Reference: project_b_scope_substrate.md for the broader B-phase audit
// pattern this aligns with (data-driven over hand-written JSX).
export default function SettingsModal({ online, onClose, onImportDone, onConnect, onOpenTag, onOpenNote, initialTab }: Props) {
  // An old id (a link to 「寫作」) opens the page its settings moved to.
  const [requestedTab, setTab] = useState<SettingsTab>(() => (initialTab && resolveSettingsTab(initialTab)) || TABS[0].id);
  const [query, setQuery] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const t = useT();
  const isOwner = useIsOwner();
  const settingsModules = useSettingsModules();
  const phone = useIsMobile();
  // A page for the keyboard (快捷鍵) is not listed on the phone.
  // A page only the owner uses (AI) is not listed for a member, and a link to it opens the first page.
  const listedTabs = TABS.filter((spec) => (!spec.desktopOnly || !phone) && (!spec.ownerOnly || isOwner));
  const tab: SettingsTab = requestedTab.startsWith("module:") || TABS.some((s) => s.id === requestedTab && (!s.ownerOnly || isOwner)) ? requestedTab : TABS[0].id;
  const sections = settingsSections(listedTabs);
  const values = useListValues();
  const aboutIsNew = useAboutIsNew();
  const accountName = useAccountName();
  const accountStatus = useAccountStatus();
  // Phone only: the list (level 1) or one page (level 2). A deep link
  // (openSettings("modules")) opens on level 2.
  const [level, setLevel] = useState<1 | 2>(initialTab ? 2 : 1);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Phone: the page that opened this one from a row of its own (外觀's 「筆記字體」, a feature in
  // 功能). Back returns there first, then to the list.
  const [returnTab, setReturnTab] = useState<SettingsTab | null>(null);
  const backToReturnTab = (): boolean => {
    if (!returnTab) return false;
    setTab(returnTab);
    setReturnTab(null);
    return true;
  };
  // Settings is a dialog, and Back answers the newest close request first: level 2 and the page it was opened from
  // are surfaces of their own over the dialog, so one Back steps to the page before, the next to the list, the
  // third closes Settings (a history entry here would never be the one Back reaches).
  useDismiss(() => { setLevel(1); }, phone && level === 2);
  useDismiss(() => { backToReturnTab(); }, phone && level === 2 && returnTab !== null);

  const openTab = (next: SettingsTab, opts?: { advanced?: boolean }) => {
    setTab(next);
    setQuery("");
    if (opts?.advanced) setShowAdvanced(true);
  };
  /** A page's own row opening another page (ctx.openTab). */
  const openFromPage = (next: SettingsTab, opts?: { advanced?: boolean }) => {
    if (phone && level === 2 && next !== tab && !tab.startsWith("module:")) setReturnTab(tab);
    openTab(next, opts);
  };
  const openCategory = (next: SettingsTab, opts?: { advanced?: boolean; setting?: string }) => {
    setReturnTab(null);
    openTab(next, opts);
    setScrollTarget(opts?.setting ?? null);
    setLevel(2);
  };
  const backToList = () => {
    if (backToReturnTab()) return;
    setLevel(1);
  };

  // A search result opened on the phone: bring its setting into view.
  useEffect(() => {
    if (!scrollTarget || level !== 2) return;
    const wrapper = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-setting-id]") ?? [])
      .find((el) => el.dataset.settingId === scrollTarget);
    // The wrapper draws no box (display: contents); scroll to its first child.
    const target = (wrapper?.firstElementChild as HTMLElement | null) ?? wrapper;
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
    setScrollTarget(null);
  }, [scrollTarget, level, tab]);
  // Desktop: the open page's row stays in view.
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const active = sidebarRef.current?.querySelector<HTMLElement>(".settings-nav-item.active");
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }, [tab, phone]);
  const openTag = onOpenTag && ((id: string) => { onClose(); onOpenTag(id); });
  const openNote = onOpenNote && ((id: string) => { onClose(); onOpenNote(id); });
  const ctx: SettingContext = { online, onClose, onImportDone, onConnect, openTab: openFromPage, openTag, openNote };
  const listed = (s: SettingDef) => (!s.show || s.show(ctx)) && (!s.desktopOnly || !phone) && (!s.ownerOnly || isOwner);
  const visible = SETTINGS.filter((s) => listed(s) && listedTabs.some((spec) => spec.id === s.tab));
  const searching = query.trim() !== "";
  const moduleId = tab.startsWith("module:") ? tab.slice("module:".length) : null;
  const spec = TABS.find((s) => s.id === (moduleId ? "modules" : tab)) ?? TABS[0];
  const settingsForTab = visible.filter((s) => s.tab === tab);
  const hasAdvanced = settingsForTab.some((s) => isAdvanced(s, ctx));
  // Matches in list order; a feature's own settings are searchable too,
  // listed under its page (right after the Features row).
  const targets: Array<{ key: SettingsTab; icon: ReactNode; label: string }> = sections.flatMap((section) => section.rows).flatMap((row) => [
    { key: row.id, icon: row.icon, label: row.label },
    ...(row.id === "modules" ? settingsModules.map(({ id, title, Icon }) => ({ key: `module:${id}` as const, icon: <Icon size={14} aria-hidden="true" />, label: title })) : []),
  ]);
  const results = searching
    ? targets.map(({ key, icon, label }) => {
      const module = key.startsWith("module:") ? key.slice("module:".length) : null;
      const defs = module
        ? MODULE_SETTINGS.filter((s) => s.moduleId === module && listed(s) && settingMatches(s, query, label, t))
        : visible.filter((s) => s.tab === key && settingMatches(s, query, label, t));
      return { key, icon, label, defs };
    }).filter((r) => r.defs.length > 0)
    : [];

  const categoryBody = (
    searching ? (
      results.length === 0 ? (
        <p className="settings-hint">{t("No settings match “{query}”.", { query: query.trim() })}</p>
      ) : results.map(({ key, icon, label, defs }) => (
        <div key={key} className="settings-search-group">
          <Pressable className="settings-search-tab" onClick={() => openTab(key)}>
            {icon}{t(label)}
          </Pressable>
          <TabBody settings={defs} ctx={ctx} showAdvanced />
        </div>
      ))
    ) : moduleId ? (
      <ModuleSettingsPage id={moduleId} ctx={ctx} />
    ) : (
      <>
        <TabBody settings={settingsForTab} ctx={ctx} showAdvanced={showAdvanced} />
        {hasAdvanced && (
          <Button variant="ghost" size="sm" className="settings-advanced-toggle" aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? t("Hide advanced settings") : t("Show advanced settings")}
          </Button>
        )}
      </>
    )
  );

  const searchField = (
    <SearchField className="settings-search" label={t("Search settings…")} value={query} onValueChange={setQuery} />
  );

  /** One row of the list, drawn the same on both layouts: icon (the account's
   *  avatar), name, its current value, a phone mark for a device-only page, a
   *  「新」 for unread updates. */
  const listRow = (row: TabSpec, { active, onOpen, chevron }: { active: boolean; onOpen: () => void; chevron: boolean }) => {
    const isAccount = row.id === "account";
    const label = isAccount && accountName ? accountName : t(row.label);
    return (
      <Pressable key={row.id} type="button"
        className={`${phone ? "settings-list-row" : "settings-nav-item"}${isAccount ? " settings-list-row--account" : ""}${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={isAccount && accountName ? `${t(row.label)}: ${accountName}` : undefined}
        data-tab={row.id}
        onClick={onOpen}>
        <span className="settings-list-icon" aria-hidden="true">{isAccount ? <Avatar name={accountName} /> : row.icon}</span>
        <span className="settings-list-label">{label}</span>
        {isAccount && <span className={`settings-status-dot ${accountStatus.ok ? "online" : "offline"}`} role="img" aria-label={accountStatus.label} />}
        {values[row.id] && <span className="settings-list-value">{values[row.id]}</span>}
        {row.deviceOnly && <Smartphone size={14} role="img" aria-label={t("Only on this device")} className="settings-device-mark" />}
        {row.id === "about" && aboutIsNew && <Chip tone="accent" className="settings-new">{t("New")}</Chip>}
        {chevron && <ChevronRight size={18} className="settings-list-chevron" aria-hidden="true" />}
      </Pressable>
    );
  };

  if (phone) {
    const closeButton = (
      <Pressable type="button" className="settings-header-icon" aria-label={t("Close")} onClick={onClose}><X size={22} aria-hidden="true" /></Pressable>
    );
    const moduleTitle = moduleId ? featureTitleOf(moduleId) : null;
    const returnSpec = returnTab ? TABS.find((s) => s.id === returnTab) ?? null : null;
    return (
      <Modal label={t("Settings")} className="settings-overlay settings-overlay--phone" onClose={onClose}>
        <div className="settings-modal settings-modal--phone" data-level={level}>
          {level === 1 ? (
            <>
              <div className="settings-header">
                <h2 className="settings-title">{t("Settings")}</h2>
                {closeButton}
              </div>
              <div className="settings-phone-scroll">
                {searchField}
                {searching ? (
                  results.length === 0 ? (
                    <p className="settings-hint">{t("No settings match “{query}”.", { query: query.trim() })}</p>
                  ) : (
                    <ul className="settings-list" aria-label={t("Search results")}>
                      {results.flatMap(({ key, icon, label, defs }) => defs.map((def) => (
                        <li key={def.id}>
                          <Pressable type="button" className="settings-list-row" onClick={() => openCategory(key, { advanced: isAdvanced(def, ctx), setting: def.id })}>
                            <span className="settings-list-icon" aria-hidden="true">{icon}</span>
                            <span className="settings-list-text">
                              <span className="settings-list-label">{def.label ? t(def.label) : t(label)}</span>
                              {def.label && <span className="settings-list-detail">{t(label)}</span>}
                            </span>
                            <ChevronRight size={18} className="settings-list-chevron" aria-hidden="true" />
                          </Pressable>
                        </li>
                      )))}
                    </ul>
                  )
                ) : sections.map((section) => (
                  <ul key={section.id} className="settings-list" data-block={section.id}>
                    {section.rows.map((row) => (
                      <li key={row.id}>{listRow(row, { active: false, onOpen: () => openCategory(row.id), chevron: true })}</li>
                    ))}
                  </ul>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="settings-header settings-header--phone-category">
                <Pressable type="button" className="settings-back" aria-label={returnSpec ? t("Back to {title}", { title: t(returnSpec.label) }) : t("Back to Settings")} onClick={backToList}>
                  <ChevronLeft size={22} aria-hidden="true" /><span>{returnSpec ? t(returnSpec.label) : t("Settings")}</span>
                </Pressable>
                <h2 className="settings-title">{moduleTitle ? t(moduleTitle) : t(spec.label)}</h2>
                {closeButton}
              </div>
              <div className="settings-content" ref={contentRef}>
                {categoryBody}
              </div>
            </>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal label={t("Settings")} className="settings-overlay" onClose={onClose}>
      <div className="settings-modal">
        <div className="settings-header">
          <span className="settings-title">{t("Settings")}</span>
          <Button variant="icon" size="sm" aria-label={t("Close")} onClick={onClose}><X size={15} /></Button>
        </div>

        <div className="settings-body">
          <nav className="settings-sidebar" ref={sidebarRef}>
            {searchField}
            {sections.map((section) => (
              <div key={section.id} className="settings-nav-group" data-block={section.id}>
                {section.rows.map((row) => listRow(row, {
                  active: !searching && (tab === row.id || (moduleId !== null && row.id === "modules")),
                  onOpen: () => openTab(row.id),
                  chevron: false,
                }))}
              </div>
            ))}
          </nav>

          <div className="settings-content">
            {categoryBody}
          </div>
        </div>
      </div>
    </Modal>
  );
}

