import { Bell, Blocks, Bot, CalendarDays, Clock, Home, History, Info, Keyboard, Languages, NotebookPen, PanelBottom, PenLine, Palette, Shield, UserRound, Users, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getApiBase, markdownExportUrl, setApiBase, reloadPage, pageOrigin } from "../lib/api";
import { confirmDialog } from "../components/ConfirmDialog";
import {
  getStoragePref,
  getStoredDirHandle,
  isFileSystemAccessSupported,
} from "../lib/fileSystemStorage";
import { chooseLocalBackupFolder, switchToBrowserStorage } from "../lib/localBackup";
import { getLaunchPreference } from "../lib/launchPreference";
import { PREFS, setPref } from "../lib/prefs";
import { useLocalOnlyStatus } from "../lib/localOnlyStatus";
import { writeErrors } from "../lib/data";
import { installTagPack } from "../lib/moduleLibrary";
import { BUILT_IN_SETTINGS } from "../modules";
import { getLocalePref, setLocalePref, t, useT, type LocalePref } from "../lib/i18n";
import SpacesAndMembers from "./spacesAndMembers";
import AiSettings from "./ai";
import ModulesSetting from "./ModulesSetting";
import TimeSetting, { DayStartSetting } from "./TimeSetting";
import ShortcutsSetting from "./ShortcutsSetting";
import NavigationSetting from "./NavigationSetting";
import ToolbarSetting from "./ToolbarSetting";
import { lazyWithReload } from "../lib/lazyWithReload";
import AccountSetting, { SignOutSetting } from "./AccountSetting";
import AboutVersion from "./AboutVersion";
import AppearancePreview from "./AppearancePreview";
import NotePreview from "./NotePreview";
import PushRemindersSetting from "./PushRemindersSetting";
import { FullBackupDownload, FullBackupRestore } from "./FullBackupSetting";
import { storageFailure, useDeviceCopy } from "./deviceCopy";
import { DataRow } from "./DataRow";
import SystemStatusSetting from "./SystemStatusSetting";
import WhatsNewSetting from "./WhatsNewSetting";
import type { ListSectionId, SettingContext, SettingDef, TabSpec } from "../lib/settingsTypes";
import { Button, FieldError, FileInput, Link, buttonClass } from "../components/ui";
import { APPEARANCE_SETTINGS } from "./appearance";

// ─── Tabs ────────────────────────────────────────────────────────────────────

// The settings list, the same on desktop and phone: one row per tab, in the
// blocks of LIST_SECTIONS. A row says what it holds by the value shown at its
// right (settings/listValues), not by a sentence. `deviceOnly` marks a tab whose
// settings stay in this browser. A feature's own settings are not rows: they
// sit on that feature's page, opened from the 功能 tab.
export const TABS: TabSpec[] = [
  // Who is signed in, whether saving works, which server (and signing out).
  { id: "account",    label: "Account",    icon: <UserRound size={14} />, listSection: "profile" },
  // The app itself: theme, colours, interface size, motion.
  { id: "appearance", label: "Appearance", icon: <Palette size={14} />, listSection: "look", deviceOnly: true },
  // How note text looks (font, text size, width) and the editor's toolbar. A note's
  // 「文字樣式」 changes the same preferences.
  { id: "notes",      label: "Notes",      icon: <NotebookPen size={14} />, listSection: "look", deviceOnly: true },
  // How things are put in: where a quick capture goes, and the pen. Both are always on, so they
  // are not in the feature list (功能).
  { id: "capture",    label: "Quick capture", icon: <Zap size={14} />, listSection: "look" },
  { id: "handwriting", label: "Handwriting", icon: <PenLine size={14} />, listSection: "look" },
  // What sits directly in the navigation bar (「釘到導覽列」, lib/navLayout), kept with the
  // account, and what the app opens on (this device's).
  { id: "navigation", label: "Navigation bar", icon: <PanelBottom size={14} />, listSection: "look" },
  // Reminders sent to this device; the home for every notification kind to come.
  { id: "notifications", label: "Notifications", icon: <Bell size={14} />, listSection: "look", deviceOnly: true },
  { id: "shortcuts",  label: "Keyboard shortcuts", icon: <Keyboard size={14} />, listSection: "look", desktopOnly: true },
  // Who can see which notes (docs/architecture/spaces.md).
  { id: "spaces",     label: "Spaces and members", icon: <Users size={14} />, listSection: "workspace" },
  // The owner's AI: connections (API keys, connection codes) and the AIs that use them. Visible even while the
  // AI feature is off: it is where it is turned on.
  { id: "ai",         label: "AI",         icon: <Bot size={14} />, listSection: "workspace", ownerOnly: true },
  // The feature list: what this workspace has on, and each feature's own page
  // (docs/architecture/module-library.md).
  { id: "modules",    label: "Features",   icon: <Blocks size={14} />, listSection: "workspace" },
  { id: "language",   label: "Language",   icon: <Languages size={14} />, listSection: "locale", deviceOnly: true },
  // The zone the workspace's days are cut in and the hour a day starts at: shared by
  // everyone in the workspace, changed by its owner.
  { id: "time",       label: "Date and time", icon: <Clock size={14} />, listSection: "locale" },
  // Export, import and backup: the standing home for getting data in and out
  // (Standard Notes "Backups" / Capacities "Full Export" pattern).
  { id: "data",       label: "Data and backup", icon: <Shield size={14} />, listSection: "data" },
  // Update history, the owner's failed background jobs, the version.
  { id: "about",      label: "About Onden", icon: <Info size={14} />, listSection: "data" },
];

/** The list's blocks in order. They have no names on screen. */
export const LIST_SECTIONS: ReadonlyArray<{ id: ListSectionId }> = [
  { id: "profile" }, { id: "look" }, { id: "workspace" }, { id: "locale" }, { id: "data" },
];

/** The list both layouts draw: `tabs` grouped into LIST_SECTIONS, empty
 *  blocks left out. */
export function settingsSections(tabs: readonly TabSpec[]): Array<{ id: ListSectionId; rows: TabSpec[] }> {
  return LIST_SECTIONS
    .map(({ id }) => ({ id, rows: tabs.filter((tab) => tab.listSection === id) }))
    .filter((section) => section.rows.length > 0);
}

// ─── Custom widgets (multi-state flows that don't fit a single SettingDef) ──

function StorageLocationWidget({ ctx }: { ctx: SettingContext }) {
  const storagePref = getStoragePref();
  const [dirName, setDirName] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const tr = useT();
  // A build that keeps the notes only in this browser (the trial) has no server copy to fall back on: say so, online or not.
  const localOnly = useLocalOnlyStatus();
  const keptHere = !ctx.online || localOnly !== null;

  useEffect(() => {
    if (storagePref === "fs-access") {
      getStoredDirHandle().then((h) => setDirName(h?.name ?? null)).catch(() => setDirName(null));
    }
  }, [storagePref]);

  async function switchToFolder() {
    if (busy.current) return;
    busy.current = true;
    setSwitching(true);
    setError(null);
    try {
      if (await chooseLocalBackupFolder()) reloadPage();
    } catch (error) {
      setError(storageFailure(error, "Could not change the storage location. The previous location is still in use. Try again."));
    } finally { busy.current = false; setSwitching(false); }
  }
  async function switchToOpfs() {
    if (busy.current) return;
    busy.current = true;
    setSwitching(true);
    setError(null);
    try {
      if (!(await confirmDialog(tr("Keep the current data in this browser? The old folder copy will remain available."), { confirmLabel: tr("Switch"), cancelLabel: tr("Cancel") }))) return;
      await switchToBrowserStorage();
      reloadPage();
    } catch (error) {
      setError(storageFailure(error, "Could not change the storage location. The previous location is still in use. Try again."));
    } finally { busy.current = false; setSwitching(false); }
  }

  // Seeing *where* the data lives is the strongest ownership cue (Standard
  // Notes / Obsidian show the on-disk location); surface it plainly. Online,
  // the notes live on the server and this device holds a copy for offline use.
  const where = storagePref === "fs-access" && dirName ? `📁 ${dirName}` : tr("This browser");
  return (
    <DataRow
      title={tr("Where your notes are kept")}
      hint={keptHere ? tr("On this device: {where}", { where }) : tr("On the server. This device's copy: {where}", { where })}
      note={!keptHere
        ? tr("This device keeps a copy for working offline. Clearing site data removes only that copy; your notes stay on the server.")
        : storagePref === "fs-access"
          ? tr("A local database copy is saved to this folder. Keep a separate backup before clearing browser data.")
          : tr("Data is stored in this browser. Clearing site data erases it. Download a backup or choose a folder for a local copy.")}
      action={isFileSystemAccessSupported() && (storagePref !== "fs-access" ? (
        <Button variant="secondary" onClick={switchToFolder} disabled={switching}>
          {switching ? tr("Saving…") : tr("Keep a copy in a folder…")}
        </Button>
      ) : (
        <>
          <Button variant="secondary" onClick={switchToFolder} disabled={switching}>
            {switching ? tr("Saving…") : tr("Change folder…")}
          </Button>
          <Button variant="secondary" onClick={switchToOpfs} disabled={switching}>
            {tr("Switch to browser")}
          </Button>
        </>
      ))}
    >
      {error && <FieldError>{error}</FieldError>}
    </DataRow>
  );
}

function SqliteBackupWidget(_: { ctx: SettingContext }) {
  const { operation, exportError: error, notice, handleExport } = useDeviceCopy();
  const tr = useT();
  return (
    <DataRow
      title={tr("Download this device's copy")}
      hint={tr("The notes and waiting changes this device keeps, as one file you can restore here.")}
      note={tr("Cached notes and waiting changes only; no media or server history.")}
      action={<Button variant="secondary" onClick={handleExport} disabled={operation !== null}>
        {operation === "export" ? tr("Preparing…") : tr("Download")}
      </Button>}
    >
      {error && <FieldError>{error}</FieldError>}
      {notice && <p className="settings-hint settings-storage-notice" role="status">{notice}</p>}
    </DataRow>
  );
}

/** Replaces this device's copy: the page's last row, in red (see `danger`). */
function SqliteRestoreWidget(_: { ctx: SettingContext }) {
  const { operation, importError: error, handleImport } = useDeviceCopy();
  const fileRef = useRef<HTMLInputElement>(null);
  const tr = useT();
  return (
    <>
      <DataRow
        title={tr("Restore this device's copy")}
        hint={tr("Replaces this device's copy and its waiting changes. The server is not rolled back.")}
        action={<Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={operation !== null}>
          {operation === "import" ? tr("Importing…") : tr("Choose file…")}
        </Button>}
      >
        {error && <FieldError>{error}</FieldError>}
      </DataRow>
      <FileInput ref={fileRef} accept=".sqlite3,.sqlite,.db" className="settings-file-input--hidden" onChange={handleImport} aria-label={tr("This device's copy file")} />
    </>
  );
}

// A zip of human-readable Markdown + media + YAML frontmatter (the portable,
// leave-any-time format), from the existing /api/export/markdown.zip endpoint.
function MarkdownExportWidget(_: { ctx: SettingContext }) {
  const tr = useT();
  return (
    <DataRow
      title={tr("Export as Markdown")}
      hint={tr("For Obsidian, Logseq or any text editor.")}
      action={<Link className={buttonClass("secondary")} href={markdownExportUrl()} download="onden-export.zip">{tr("Export")}</Link>}
    />
  );
}

// The TagPack import escape hatch (per-tag EXPORT lives on the tag node's schema
// lens; the starter templates are picked when creating a tag). installTagPack is the one install operation (also the welcome card and
// 「＋ 新增標籤」): POST /api/tags/import enforces the install-time policy gate
// server-side, and the modules a pack declares are imported with it.
type TagPackResult = { label: string; ok: boolean; message: string };

function TagPacksWidget({ ctx }: { ctx: SettingContext }) {
  const [results, setResults] = useState<TagPackResult[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function installPack(body: string, label: string): Promise<boolean> {
    try {
      const res = await installTagPack(body, ctx.online);
      // Contract #10: a pack declaring modules this build doesn't ship still
      // imports fine (the tag is an ordinary schema tag) — note it quietly.
      const moduleNote = res.missing_modules?.length
        ? " " + t("(this pack's functions need the {modules} module(s), not installed in this build — imported as a plain schema tag)", { modules: res.missing_modules.join(", ") })
        : "";
      setResults((prev) => [
        { label, ok: true, message: (res.name ? t("installed as #{name}", { name: res.name }) : t("installed")) + moduleNote },
        ...prev,
      ]);
      return true;
    } catch (e) {
      setResults((prev) => [
        { label, ok: false, message: writeErrors.message(e) },
        ...prev,
      ]);
      return false;
    }
  }

  async function importFiles(files: FileList) {
    const arr = Array.from(files).filter(
      (f) => f.name.endsWith(".tagpack.json") || f.name.endsWith(".json"),
    );
    if (arr.length === 0) {
      setResults((prev) => [{ label: t("(none)"), ok: false, message: t("No tag pack files selected") }, ...prev]);
      return;
    }
    setBusy(true);
    let anyOk = false;
    for (const file of arr) {
      if (await installPack(await file.text(), file.name)) anyOk = true;
    }
    setBusy(false);
    if (anyOk) ctx.onImportDone();
  }

  return (
    <DataRow
      className="settings-tagpacks"
      title={t("Import a tag pack")}
      hint={t("Tag packs other people shared")}
      action={<Button variant="secondary" className="settings-tagpack-import" onClick={() => fileRef.current?.click()} disabled={busy || !ctx.online}>
        {busy ? t("Installing…") : t("Choose file…")}
      </Button>}
    >
      <FileInput
        ref={fileRef}
        accept=".json,.tagpack.json,application/json"
        multiple
        aria-label={t("Tag pack file")}
        className="settings-file-input--hidden"
        onChange={(e) => { if (e.target.files) void importFiles(e.target.files); e.target.value = ""; }}
      />
      {results.length > 0 && (
        <div className="settings-import-result-list settings-tagpack-results">
          {results.map((r, i) => (
            <span key={i} className={r.ok ? "" : "settings-import-warning"}>
              {r.ok ? "✅" : "⚠"} {t(r.label)} — {r.message}
            </span>
          ))}
        </div>
      )}
    </DataRow>
  );
}

// Re-exported so existing importers keep one door (settings/appearance.ts owns them).
export { applyPersistedSettings, applyThemeMode } from "./appearance";

// ─── The registry ───────────────────────────────────────────────────────────

// A feature's own settings (e.g. RSS's save destination) sit on its page
// under the 功能 tab (settings/ModuleSettingsPage), not here.
export const SETTINGS: SettingDef[] = [
  // ── Account ──
  {
    id: "account.identity",
    tab: "account",
    label: "",
    keywords: ["account", "email", "name", "sync", "saved", "connection", "online", "offline", "backend status", "帳號", "名字", "同步", "連線", "離線"],
    type: "custom",
    component: AccountSetting,
  },
  {
    id: "server.url",
    tab: "account",
    section: "Connection",
    label: "Server address",
    description: "Leave empty to use this site's own server.",
    keywords: ["server", "URL", "backend", "self-hosted", "伺服器", "網址", "自架", "連線"],
    // Only for self-hosting while connected; when the app can't reach its
    // server, this is how to point it at the right one, so it shows.
    advanced: (ctx) => ctx.online,
    type: "text",
    default: "",
    // Empty means this site's own server, so that is what the empty field shows.
    placeholder: pageOrigin(),
    get: () => getApiBase(),
    set: (v) => { /* committed on action — see below */ void v; },
    action: {
      label: "Save",
      // The same checked setApiBase as ServerSetup: a server that is not
      // Onden is refused (the message shows under the field) and nothing is
      // saved; a changed server reloads onto its own local store and queue.
      run: async (v, ctx) => {
        const result = await setApiBase(v);
        if (!result.ok) return result.error;
        ctx.onConnect();
        ctx.onClose();
      },
    },
  },
  {
    id: "account.sign_out",
    tab: "account",
    label: "",
    keywords: ["sign out", "log out", "logout", "登出"],
    danger: true,
    type: "custom",
    component: SignOutSetting,
  },

  // ── Appearance, Notes ──
  // The page's one preview comes first; the controls follow (settings/appearance.ts).
  { id: "appearance.preview", tab: "appearance", label: "", keywords: ["preview", "預覽"], type: "custom", component: AppearancePreview },
  { id: "notes.preview", tab: "notes", label: "", keywords: ["preview", "預覽"], type: "custom", component: NotePreview },
  ...APPEARANCE_SETTINGS,
  {
    // 外觀's last row: the note font and a way to the 筆記 page, which holds it.
    id: "appearance.note_font",
    tab: "appearance",
    label: "",
    keywords: ["note font", "font", "typeface", "筆記字體", "字體", "字型"],
    type: "custom",
    component: lazyWithReload(() => import("./NoteFontLink")),
  },
  {
    // Which buttons the editor's toolbars show, and in what order. The paragraph toolbar's
    // 「編輯工具列…」 opens this row.
    id: "toolbar.layout",
    tab: "notes",
    section: "Toolbar",
    label: "",
    keywords: ["toolbar", "format bar", "selection", "button", "more", "工具列", "格式列", "選取", "按鈕", "更多", "排序", "變成子筆記", "加標籤", "這段"],
    type: "custom",
    component: ToolbarSetting,
  },
  {
    // A font installed on this computer: once chosen it is a card of 字體.
    id: "note.local_font",
    tab: "notes",
    section: "More",
    label: "",
    keywords: ["font", "installed", "local", "computer", "字型", "字體", "電腦", "本機字型", "已安裝"],
    advanced: true,
    type: "custom",
    component: lazyWithReload(() => import("./LocalFontSetting")),
  },

  // ── Navigation bar ──
  {
    id: "navigation.layout",
    tab: "navigation",
    label: "",
    keywords: ["navigation", "nav", "pin", "tab bar", "sidebar", "導覽列", "釘選", "釘到導覽列", "底部", "排序"],
    type: "custom",
    component: NavigationSetting,
  },

  // ── Keyboard shortcuts ──
  {
    id: "shortcuts.keys",
    tab: "shortcuts",
    label: "",
    keywords: ["hotkey", "keymap", "keyboard", "shortcut", "快捷鍵", "按鍵", "鍵盤"],
    desktopOnly: true,
    type: "custom",
    component: ShortcutsSetting,
  },

  // ── Spaces ──
  {
    id: "spaces.manage",
    tab: "spaces",
    label: "",
    keywords: ["members", "people", "share", "AI helper", "key", "token", "invite", "owner", "publish", "backup", "delete space", "remove", "revoke", "成員", "分享", "AI 助手", "金鑰", "邀請", "擁有者", "發布", "備份", "權限", "空間", "刪除", "移除"],
    type: "custom",
    component: SpacesAndMembers,
  },

  // ── AI ──
  {
    id: "ai.manage",
    tab: "ai",
    label: "",
    keywords: ["AI", "key", "api", "connection", "token", "model", "assistant", "mcp", "金鑰", "連線", "連線碼", "模型", "助手", "每月上限"],
    ownerOnly: true,
    type: "custom",
    component: AiSettings,
  },

  // ── Features ──
  {
    id: "modules.library",
    tab: "modules",
    label: "",
    // Generic words only: core names no module (test/moduleBoundary.test.ts).
    keywords: ["module", "feature", "import", "turn off", "模組", "功能", "匯入", "引入", "關掉"],
    type: "custom",
    component: ModulesSetting,
  },

  // ── Language ──
  {
    id: "language.app",
    tab: "language",
    label: "Language",
    type: "enum",
    default: "system",
    options: [
      { value: "system", label: "System" },
      { value: "en",     label: "English" },
      { value: "zh-TW",  label: "Traditional Chinese" },
    ],
    get: () => getLocalePref(),
    set: (v) => setLocalePref(v as LocalePref),
  },

  // ── Date and time ──
  {
    id: "time.clock",
    tab: "time",
    label: "",
    keywords: ["time zone", "timezone", "travel", "today", "date", "時區", "旅行", "今天", "日期", "時間"],
    type: "custom",
    component: TimeSetting,
  },
  {
    // The hour a day starts at (what is written before it still counts as the day before).
    id: "daily.day_start",
    tab: "time",
    label: "",
    keywords: ["day start", "midnight", "late", "stay up", "換日", "一天從幾點開始", "熬夜", "凌晨"],
    type: "custom",
    component: DayStartSetting,
  },

  // ── Notifications ──
  {
    id: "notifications.push",
    tab: "notifications",
    label: "",
    keywords: ["reminder", "notification", "lock screen", "push", "提醒", "通知", "鎖屏", "推播"],
    type: "custom",
    component: PushRemindersSetting,
  },

  // ── Navigation bar › when the app opens ──
  {
    // D5 — where the app lands on launch. The landing is ADDITIVE and
    // non-clobbering: a ?node= deep link always wins (BuilderApp's launch
    // effect checks the URL before applying this).
    id: "home.landing",
    tab: "navigation",
    section: "When the app opens",
    label: "On launch, open",
    description: "On this device only.",
    keywords: ["launch", "start", "open", "landing", "home", "resume", "打開時", "啟動", "開啟", "首頁", "上次"],
    control: { cards: { today: CalendarDays, home: Home, resume: History } },
    type: "enum",
    default: "today",
    options: [
      { value: "today",  label: "Today's note" },
      { value: "home",   label: "Home page" },
      { value: "resume", label: "Where I left off" },
    ],
    // Plain persistence uses useOption's default storage. No DOM side effect
    // needs replaying at boot (which would also rewrite an unreadable choice).
    get: getLaunchPreference,
    set: (v) => { setPref(PREFS.launchLanding, v); },
  },

  // ── Data and backup ──
  // One line per thing (settings/DataRow.tsx), each widget titles itself, so
  // the labels here are empty and the section heading is the only group name.
  // Search finds a row by its keywords, which carry its title in both languages.
  {
    id: "data.full_backup",
    tab: "data",
    section: "Backup and export",
    label: "",
    keywords: ["full backup", "backup", "restore", "zip", "download", "完整備份", "備份", "還原", "下載"],
    type: "custom",
    component: FullBackupDownload,
  },
  {
    id: "data.full_backup_restore",
    tab: "data",
    section: "Backup and export",
    label: "",
    keywords: ["restore from a backup", "backup", "restore", "zip", "merge", "從備份還原", "備份", "還原", "合併"],
    type: "custom",
    component: FullBackupRestore,
  },
  {
    id: "data.export",
    tab: "data",
    section: "Backup and export",
    label: "",
    keywords: ["export as Markdown", "export", "Markdown", "Obsidian", "Logseq", "zip", "匯出", "下載"],
    type: "custom",
    component: MarkdownExportWidget,
  },

  // Import — all data movement (out AND in) lives here.
  // The folder import belongs to the importers module (built in, always on).
  ...BUILT_IN_SETTINGS,
  {
    id: "data.import_tag_packs",
    tab: "data",
    section: "Import",
    label: "",
    keywords: ["import a tag pack", "tag pack", "TagPack", "JSON", "tagpack.json", "匯入", "標籤包"],
    // A file format for sharing tags; picking a template when creating a tag
    // is the everyday way.
    advanced: true,
    type: "custom",
    component: TagPacksWidget,
  },

  // This device — its own copy, deliberately distinct from the full backup
  // above so "the whole workspace" vs "what this device holds" never blur.
  {
    id: "data.location",
    tab: "data",
    section: "On this device",
    label: "",
    keywords: ["where your notes are kept", "storage", "folder", "browser", "local", "儲存", "資料夾", "瀏覽器", "本機", "存在"],
    type: "custom",
    component: StorageLocationWidget,
  },
  {
    id: "data.backup",
    tab: "data",
    section: "On this device",
    label: "",
    keywords: ["device copy", "sqlite", "database", "download", "backup", "這台裝置的副本", "副本", "備份", "資料庫"],
    advanced: true,
    type: "custom",
    component: SqliteBackupWidget,
  },
  {
    id: "data.backup_restore",
    tab: "data",
    label: "",
    keywords: ["device copy", "sqlite", "database", "restore", "replace", "reset", "overwrite", "這台裝置的副本", "副本", "還原", "資料庫", "重設", "覆蓋"],
    advanced: true,
    danger: true,
    type: "custom",
    component: SqliteRestoreWidget,
  },

  // ── About ──
  {
    id: "about.version",
    tab: "about",
    label: "",
    keywords: ["version", "build", "about", "版本", "關於"],
    type: "custom",
    component: AboutVersion,
  },
  {
    id: "whatsnew.list",
    tab: "about",
    section: "Update history",
    label: "",
    keywords: ["changelog", "release", "update", "new", "更新", "更新紀錄", "新功能"],
    type: "custom",
    component: WhatsNewSetting,
  },
  // Background jobs that stopped retrying (outbox deliveries): the owner's
  // alone, since the jobs carry notes from every space.
  {
    id: "system.failed_jobs",
    tab: "about",
    section: "Failed background jobs",
    label: "Failed background jobs",
    keywords: ["failed", "error", "retry", "outbox", "backup", "index", "失敗", "錯誤", "重試", "背景工作", "系統狀態"],
    ownerOnly: true,
    type: "custom",
    component: SystemStatusSetting,
  },
];
