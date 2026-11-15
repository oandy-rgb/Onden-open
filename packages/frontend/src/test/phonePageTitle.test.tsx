// The phone has no big page title: the top bar names the page, with the same
// name the bottom bar and 更多 use (hooks/shellNavigation), and the
// buttons the title row held sit in the bar beside search
// (lib/phoneTopbarActions). A computer keeps the wordmark and the title rows.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { lazy } from "react";
import { BookOpen } from "lucide-react";
import AppTopbar from "../components/AppTopbar";
import ReadingScreen from "../components/ReadingScreen";
import TimelineLens from "../components/TimelineLens";
import TasksMode from "../modules/tasks/TasksMode";
import { reminderAction } from "../modules/tasks/ReminderToggle";
import { viewLabel, getNavDestinations } from "../hooks/shellNavigation";
import { importedFeatures } from "../hooks/useImportedFeatures";
import { moduleFilterFor, type ModuleScreenProps } from "../modules";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

const { openQuickAddTask } = vi.hoisted(() => ({ openQuickAddTask: vi.fn() }));
vi.mock("../modules/tasks/openQuickAddTask", () => ({ openQuickAddTask }));
vi.mock("../lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1", name: "Andy", email: "a@example.com" } } }), signOut: vi.fn() },
}));
vi.mock("../lib/accountStorage", async (original) => ({ ...await original<typeof import("../lib/accountStorage")>(), boundAccountId: () => "u1" }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
vi.mock("../components/history", () => ({ WorkspaceHistory: () => <p>changes</p> }));

const topbar = (mode: string) => (
  <AppTopbar mode={mode} setMode={vi.fn()} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} onOpenPalette={vi.fn()}
    onOpenMembers={vi.fn()} onOpenSettings={vi.fn()} />
);
const tasksPage = (permission: "default" | "denied" | "granted" | "unsupported" = "unsupported", onEnable = vi.fn()) => (
  <TasksMode online onSelectNode={vi.fn()} onRefresh={vi.fn()} onError={vi.fn()} reminderPermission={permission} onEnableReminders={onEnable} />
);
const screenProps = { online: true, target: null, onOpenNode: vi.fn(), onRefresh: vi.fn(), onImmersiveChange: vi.fn() };

beforeEach(() => { resetAppState({ data: { ...noWorkspaceData }, online: true }); openQuickAddTask.mockReset(); });
afterEach(() => { cleanup(); clearPhoneLayout(); });

describe("the phone top bar names the page", () => {
  it("uses the name the navigation already has for each destination", () => {
    setPhoneLayout(true);
    const nav = getNavDestinations({ mode: "notes" }, { setMode() {}, onOpenModule() {}, onOpenFeature() {} },
      importedFeatures(moduleFilterFor(["daily", "tasks", "rss", "review", "website"]), []));
    const entries = [...nav.core, ...nav.modules];
    expect(entries.length).toBeGreaterThan(4);
    for (const entry of entries) {
      // The reading hub's entry id is not a view id; its sections are (viewLabel maps them to 「Reading」).
      const view = entry.view ?? entry.id;
      expect(viewLabel(view)).toBe(entry.label);
    }
  });

  it("shows that name in place of the wordmark", () => {
    setPhoneLayout(true);
    const { container, rerender } = render(topbar("tasks"));
    expect(container.querySelector(".app-logo")).toHaveTextContent("Tasks");
    rerender(topbar("notes"));
    expect(container.querySelector(".app-logo")).toHaveTextContent("Notes");
    rerender(topbar("capture"));
    expect(container.querySelector(".app-logo")).toHaveTextContent("Inbox");
    expect(container).not.toHaveTextContent("Onden");
  });

  it("a computer keeps the wordmark", () => {
    const { container } = render(topbar("tasks"));
    expect(container.querySelector(".app-logo")).toHaveTextContent("Onden");
    expect(container.querySelector(".app-page-name")).toBeNull();
  });
});

describe("Tasks page", () => {
  it("phone: no title row; the ＋ is in the top bar and opens the quick add", () => {
    setPhoneLayout(true);
    setAppState({ data: { ...noWorkspaceData } });
    const { container } = render(<>{topbar("tasks")}{tasksPage()}</>);
    expect(container.querySelector(".tasks-mode-header")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
    const add = screen.getByRole("button", { name: "Add task" });
    expect(container.querySelector(".app-topbar")).toContainElement(add);
    fireEvent.click(add);
    expect(openQuickAddTask).toHaveBeenCalledTimes(1);
  });

  it("phone: the ＋ leaves the bar when the page closes", () => {
    setPhoneLayout(true);
    const { container, rerender } = render(<>{topbar("tasks")}{tasksPage()}</>);
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeNull();
    rerender(<>{topbar("notes")}</>);
    expect(container.querySelector(".topbar-phone-action")).toBeNull();
  });

  it("phone: blocked notifications are a quiet bell that says why when tapped; allowed ones show nothing", () => {
    setPhoneLayout(true);
    const { container, rerender } = render(<>{topbar("tasks")}{tasksPage("denied")}</>);
    const bell = screen.getByRole("button", { name: "Reminders blocked" });
    expect(container.querySelector(".app-topbar")).toContainElement(bell);
    expect(container).not.toHaveTextContent("Reminders blocked ");
    rerender(<>{topbar("tasks")}{tasksPage("granted")}</>);
    expect(screen.queryByRole("button", { name: /Reminders|Remind me/ })).toBeNull();
  });

  it("phone: while notifications can still be asked, the bell asks", () => {
    setPhoneLayout(true);
    const enable = vi.fn();
    render(<>{topbar("tasks")}{tasksPage("default", enable)}</>);
    fireEvent.click(screen.getByRole("button", { name: "Remind me when due" }));
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("the bell exists only while reminders are off", () => {
    const t = (key: string) => key;
    expect(reminderAction("granted", vi.fn(), t)).toBeNull();
    expect(reminderAction("unsupported", vi.fn(), t)).toBeNull();
    expect(reminderAction("denied", vi.fn(), t)?.id).toBe("reminders");
  });

  it("desktop: the title row keeps the title, the reminder state and the ＋", () => {
    const { container } = render(tasksPage("denied"));
    expect(container.querySelector(".tasks-mode-header")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("Reminders blocked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    expect(openQuickAddTask).toHaveBeenCalledTimes(1);
  });
});

describe("Reading and History", () => {
  const section = (id: string) => ({ id, label: id, Icon: BookOpen, order: 0, Component: lazy(async () => ({ default: (_: ModuleScreenProps) => <p>body</p> })) });

  it("phone: no 「Reading」 title; the section row stays when there are several sections", () => {
    setPhoneLayout(true);
    const one = render(<ReadingScreen activeId="a" onSelect={vi.fn()} {...screenProps} sections={[section("a")]} />);
    expect(screen.queryByRole("heading", { name: "Reading" })).toBeNull();
    expect(one.container.querySelector(".reading-hub-head")).toBeNull();
    one.unmount();
    const two = render(<ReadingScreen activeId="a" onSelect={vi.fn()} {...screenProps} sections={[section("a"), section("b")]} />);
    expect(screen.queryByRole("heading", { name: "Reading" })).toBeNull();
    expect(two.container.querySelector(".reading-hub-sections")).not.toBeNull();
  });

  it("desktop: the 「Reading」 title stays", () => {
    render(<ReadingScreen activeId="a" onSelect={vi.fn()} {...screenProps} sections={[section("a")]} />);
    expect(screen.getByRole("heading", { name: "Reading" })).toBeTruthy();
  });

  it("History: no title row on a phone, kept on a computer", () => {
    setPhoneLayout(true);
    const phone = render(<TimelineLens />);
    expect(screen.queryByRole("heading", { name: "History" })).toBeNull();
    phone.unmount();
    clearPhoneLayout();
    render(<TimelineLens />);
    expect(screen.getByRole("heading", { name: "History" })).toBeTruthy();
  });
});
