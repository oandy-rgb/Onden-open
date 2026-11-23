// 設定 › AI: one card or two areas from the counts, first use, a key that is tested before it is kept, an AI that
// lost its key, and above all: no flow ever turns a space's 「AI 可以讀」 switch on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(), postRead: vi.fn() }));
vi.mock("../lib/moduleLibrary", async (original) => ({ ...await original<typeof import("../lib/moduleLibrary")>(), changeModuleImport: vi.fn(async () => ({ moduleTagId: null })) }));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { api, ApiError, postRead } from "../lib/api";
import { confirmDialog } from "../components/ConfirmDialog";
import { changeModuleImport } from "../lib/moduleLibrary";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { resetSpacesForTest } from "../lib/spaces";
import AiSettings from "../settings/ai";
import type { SettingContext } from "../lib/settingsTypes";

const apiMock = vi.mocked(api);
const postReadMock = vi.mocked(postRead);
const confirmMock = vi.mocked(confirmDialog);
const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() } as unknown as SettingContext;

const OPEN = { id: "open", name: "Lab", kind: "shared", is_default: false, owner_actor_id: null, capabilities: { external_ai: true }, permission: "edit", can_manage: true };
const CLOSED = { id: "closed", name: "Diary", kind: "shared", is_default: false, owner_actor_id: null, capabilities: { external_ai: false }, permission: "edit", can_manage: true };
const SECRET = "sk-test-0123456789abcdef";

type Call = { method: string; path: string; body: Record<string, unknown> | undefined; idem?: string };
let calls: Call[];
let keys: Array<Record<string, unknown>>;
let roles: Array<Record<string, unknown>>;
let codes: Record<string, Array<Record<string, unknown>>>;
let testResult: "ok" | "rejected" | "unreachable";
// What the server does this time: refuse the runtime change, or answer a retry as `deduped` (it already did it).
let failRuntime = false;
let dedupe: Set<string> = new Set();

const key = (id: string, label = id) => ({ id, label, last4: "1234", created_at: "2026-11-01T00:00:00Z", revoked_at: null, base_url: "https://ai.example.com" });
const role = (id: string, over: Record<string, unknown> = {}) => ({
  actor_id: id, handle: id, name: id.toUpperCase(), enabled: true, default_runtime: "api",
  runtimes: [{ kind: "api", available: true, unavailable_reason: null, last_seen_at: null }, { kind: "mcp", available: false, unavailable_reason: "no_token", last_seen_at: null }],
  review_rule: "suggest", review_rule_locked: true, spaces: { open: "view" },
  usage_this_month: { input_tokens: 0, output_tokens: 0, cost_estimate_micro_usd: null },
  api: { model: "m-1", model_retired: false, small_actions_only: false, web_search: false, credential_id: "k1", key_label: "k1", key_last4: "1234", cap: "unlimited", monthly_cap_tokens: null, used_this_month_tokens: 0 },
  ...over,
});

function serve() {
  // A POST that writes nothing (the test of a key) goes through postRead; the same handler answers it.
  postReadMock.mockImplementation((async (path: string, body: unknown) => apiMock(path, { method: "POST", body: JSON.stringify(body) })) as never);
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, idem: (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] });
    if (method !== "GET" && dedupe.has(`${method} ${path}`)) return { deduped: true };
    if (method === "GET" && path === "/api/spaces") return { spaces: [OPEN, CLOSED], is_owner: true };
    if (method === "GET" && path === "/api/ai/status") return { api_runtime_offered: true };
    if (method === "GET" && path === "/api/ai/credentials") return { credentials: keys };
    if (method === "GET" && path === "/api/ai/roles") return { roles };
    if (method === "GET" && /^\/api\/ai\/credentials\/[^/]+\/models$/.test(path)) return { models: [{ id: "m-1", display_name: "M one", lifecycle: "active", web_search: false }] };
    if (method === "GET" && /^\/api\/actors\/[^/]+\/tokens$/.test(path)) return codes[path.split("/")[3]!] ?? [];
    if (method === "GET" && /^\/api\/actors\/[^/]+\/stats$/.test(path)) return { days: 30, last_active: null, tool_calls: 0, tool_failures: 0, tool_time_ms: 0, by_tool: [], changes: [] };
    if (method === "GET" && path === "/api/agent-sessions/runners") return { runners: roles.map((r) => ({ actor_id: r.actor_id, handle: r.handle, enabled: true })) };
    if (method === "POST" && path.endsWith("/test")) {
      if (testResult === "rejected") throw new ApiError(422, JSON.stringify({ error: "credential_rejected" }));
      if (testResult === "unreachable") throw new ApiError(422, JSON.stringify({ error: "service_unreachable" }));
      return { ok: true, protocol: "v1_messages", models: [{ id: "m-1", display_name: "M one", lifecycle: "active", web_search: false }] };
    }
    if (method === "POST" && path === "/api/ai/roles") {
      const conn = body!.connection as { kind: string };
      const id = "ai";
      if (conn.kind === "api_new") keys = [...keys, key("k-new", "ai.example.com")];
      roles = [...roles, role(id, { name: body!.name, handle: id, api: conn.kind === "mcp" ? null : { ...(role(id).api as object), credential_id: conn.kind === "api_new" ? "k-new" : (conn as { credential_id?: string }).credential_id }, default_runtime: conn.kind === "mcp" ? "mcp" : "api" })];
      if (conn.kind === "mcp") codes[id] = [{ id: "t1", name: String(body!.name), access: "write", last_used_at: null, revoked_at: null }];
      return { actor_id: id, handle: id, credential_id: conn.kind === "api_new" ? "k-new" : null, token: conn.kind === "mcp" ? "onden_CODE_once" : null, joined_space_ids: ["open"] };
    }
    if (method === "POST" && path === "/api/ai/credentials") { keys = [...keys, key("k-saved", String(body!.label))]; return { credential: { id: "k-saved" } }; }
    if (method === "PUT" && /^\/api\/ai\/roles\/[^/]+\/runtime$/.test(path)) {
      if (failRuntime) throw new ApiError(409, JSON.stringify({ error: "model_unavailable" }));
      const id = path.split("/")[4]!;
      roles = roles.map((r) => r.actor_id === id ? { ...r, default_runtime: "api", api: { ...(r.api as object ?? role(id).api), credential_id: (body!.api as { credential_id: string }).credential_id } } : r);
      return { default_runtime: "api" };
    }
    if (method === "DELETE" && path.startsWith("/api/ai/credentials/")) {
      const id = path.split("/")[4]!;
      keys = keys.filter((k) => k.id !== id);
      roles = roles.map((r) => (r.api as { credential_id?: string } | null)?.credential_id === id ? { ...r, api: keys.length === 0 ? null : { ...(r.api as object), credential_id: null, key_label: null, key_last4: null } } : r);
      return { credential: { id } };
    }
    return { ok: true };
  });
}
// A POST that only asks (the test of a key) writes nothing.
const writes = () => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/test"));
const spaceWrites = () => writes().filter((c) => c.path.startsWith("/api/spaces"));

async function openPage() {
  const user = userEvent.setup();
  render(<AiSettings ctx={ctx} />);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return user;
}

beforeEach(() => {
  calls = []; keys = []; roles = []; codes = {}; testResult = "ok"; failRuntime = false; dedupe = new Set();
  confirmMock.mockClear(); confirmMock.mockResolvedValue(true);
  resetAppState(); resetSpacesForTest();
  setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules: ["ai"] } } }));
  serve();
});
afterEach(cleanup);

async function fillKeyForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Service address"), "https://ai.example.com");
  await user.type(screen.getByLabelText("API key"), SECRET);
}

describe("設定 › AI: first use", () => {
  it("offers the two ways, and a key can be saved only after a passed test; the AI made is called AI and no space is touched", async () => {
    const user = await openPage();
    expect(screen.getByRole("button", { name: /With an API key/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Let your own AI connect in/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /With an API key/ }));
    await fillKeyForm(user);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("It works. 1 model is available.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Model"), "m-1");
    await user.selectOptions(screen.getByLabelText("Monthly limit"), "unlimited");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/ai/roles")).toBe(true));
    const made = writes().find((c) => c.path === "/api/ai/roles")!;
    expect(made.body).toMatchObject({ name: "AI", connection: { kind: "api_new", base_url: "https://ai.example.com", model: "m-1", cap: { kind: "unlimited" } } });
    expect(spaceWrites()).toEqual([]);            // no space's 「AI 可以讀」 is opened by this flow
    // One key and one AI: now one card.
    expect(await screen.findByText("@ai")).toBeInTheDocument();
    expect(document.querySelector(".ai-settings")).toHaveAttribute("data-layout", "merged");
  });

  it("a key the service refuses says so in plain words, cannot be saved, and creates nothing", async () => {
    testResult = "rejected";
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: /With an API key/ }));
    await fillKeyForm(user);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("The service did not accept this key.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(writes()).toEqual([]);
    testResult = "unreachable";
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/could not be reached/)).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it("a connection code makes the AI and shows the code once with the steps to connect", async () => {
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: /Let your own AI connect in/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("onden_CODE_once")).toBeInTheDocument();
    expect(screen.getByText("Shown only this once. Copy it now.")).toBeInTheDocument();
    expect(writes().find((c) => c.path === "/api/ai/roles")!.body).toMatchObject({ name: "AI", connection: { kind: "mcp" } });
    expect(spaceWrites()).toEqual([]);
  });

  it("turns the AI feature on when it was off", async () => {
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: [] } } }));
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: /Let your own AI connect in/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/ai/roles")).toBe(true));
    await waitFor(() => expect(changeModuleImport).toHaveBeenCalledWith("ai", true, true));
  });
});

describe("設定 › AI: one card or two areas", () => {
  it("one key and one AI is one merged card; a second AI or key makes two areas; removing it goes back to one card", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    const user = await openPage();
    expect(document.querySelector(".ai-settings")).toHaveAttribute("data-layout", "merged");
    expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("ai-card"))).toHaveLength(1);
    // The card itself carries Test, Change connection and Edit, and two visible add buttons sit under it.
    const card = document.querySelector<HTMLElement>(".ai-card--ai")!;
    for (const name of ["Test", "Change connection", "Edit AI"]) expect(within(card).getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New AI" })).toBeInTheDocument();
    cleanup();

    keys = [key("k1"), key("k2")];
    await openPage();
    expect(document.querySelector(".ai-settings")).toHaveAttribute("data-layout", "split");
    expect(screen.getByRole("region", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your AIs" })).toBeInTheDocument();
    expect(screen.getByText("Used by AI")).toBeInTheDocument();
    expect(screen.getByText("No AI is using it yet.")).toBeInTheDocument();

    // Delete the key nobody uses: back to one connection and one AI.
    await user.click(screen.getByRole("button", { name: "Delete the key “k2”" }));
    await waitFor(() => expect(document.querySelector(".ai-settings")).toHaveAttribute("data-layout", "merged"));
  });

  it("two AIs on one key is two areas, each connection saying who uses it", async () => {
    keys = [key("k1")]; roles = [role("ai"), role("reader")];
    await openPage();
    expect(document.querySelector(".ai-settings")).toHaveAttribute("data-layout", "split");
    expect(screen.getByText("Used by AI, READER")).toBeInTheDocument();
  });
});

describe("設定 › AI: an AI that lost its connection", () => {
  it("shows it stopped with the reason and Change connection; choosing another key brings it back, and no space switch is touched", async () => {
    keys = [key("k1"), key("k2")]; roles = [role("ai"), role("reader", { api: { ...(role("x").api as object), credential_id: "k2", key_label: "k2" } })];
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: "Delete the key “k1”" }));
    await waitFor(() => expect(screen.getByText("The key it used was deleted.")).toBeInTheDocument());
    const stopped = document.querySelector<HTMLElement>('[data-ai-state="off"]')!;
    expect(within(stopped).getByText("Stopped")).toBeInTheDocument();
    await user.click(within(stopped).getByRole("button", { name: "Change connection" }));
    const dialog = await screen.findByRole("dialog", { name: "Change connection of AI" });
    await user.selectOptions(within(dialog).getByLabelText("API key"), "k2");
    await user.selectOptions(within(dialog).getByLabelText("Model"), "m-1");
    await user.selectOptions(within(dialog).getByLabelText("Monthly limit"), "unlimited");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("The key it used was deleted.")).toBeNull());
    expect(writes().find((c) => c.method === "PUT")!.body).toMatchObject({ default_runtime: "api", api: { credential_id: "k2", model: "m-1" } });
    expect(spaceWrites()).toEqual([]);
  });
});

describe("設定 › AI: a space that does not let AI read", () => {
  it("a new AI on a saved key leaves it closed, and the AI is not in it", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    const user = await openPage();
    // New AI on the saved key.
    await user.click(screen.getByRole("button", { name: "New AI" }));
    const dialog = await screen.findByRole("dialog", { name: "New AI" });
    await user.type(within(dialog).getByLabelText("What should this AI be called?"), "Reader");
    await user.selectOptions(within(dialog).getByLabelText("API key"), "k1");
    await waitFor(() => expect(within(dialog).getByLabelText("Model")).not.toBeDisabled());
    await user.selectOptions(within(dialog).getByLabelText("Model"), "m-1");
    await user.selectOptions(within(dialog).getByLabelText("Monthly limit"), "unlimited");
    await user.click(within(dialog).getByRole("button", { name: "Add AI" }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/ai/roles")).toBe(true));
    expect(spaceWrites()).toEqual([]);
    expect(writes().find((c) => c.path === "/api/ai/roles")!.body).toMatchObject({ name: "Reader", connection: { kind: "api", credential_id: "k1" } });
  });

  it("in the editor the closed space's row is turned off, says so, and the button asks before it opens the switch", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: "Edit AI" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit AI" });
    const rows = within(dialog).getAllByRole("listitem").filter((li) => li.classList.contains("standing-cell"));
    const closed = rows.find((li) => li.dataset.aiRead === "off")!;
    const open = rows.find((li) => li.dataset.aiRead === "on")!;
    expect(within(closed).getByText("This space doesn't let AI read.")).toBeInTheDocument();
    expect(within(closed).getByRole("button", { name: /AI in Diary/ })).toBeDisabled();
    expect(within(open).getByRole("button", { name: /AI in Lab: View only/ })).not.toBeDisabled();
    // Said no: nothing is written.
    confirmMock.mockResolvedValueOnce(false);
    await user.click(within(closed).getByRole("button", { name: "Let AI read here" }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(spaceWrites()).toEqual([]);
    // Said yes: only that one space's switch.
    await user.click(within(closed).getByRole("button", { name: "Let AI read here" }));
    await waitFor(() => expect(spaceWrites()).toHaveLength(1));
    expect(spaceWrites()[0]).toMatchObject({ method: "PATCH", path: "/api/spaces/closed", body: { capabilities: { external_ai: true } } });
  });

  it("a connection saved without an AI changes no space either", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: "New connection" }));
    const dialog = await screen.findByRole("dialog", { name: "New connection" });
    await user.click(within(dialog).getByRole("button", { name: /With an API key/ }));
    await user.type(within(dialog).getByLabelText("Service address"), "https://two.example.com");
    await user.type(within(dialog).getByLabelText("API key"), SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Test" }));
    await within(dialog).findByText("It works. 1 model is available.");
    await user.click(within(dialog).getByLabelText("Nobody yet. Only keep the key."));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/ai/credentials")).toBe(true));
    expect(spaceWrites()).toEqual([]);
  });
});

describe("設定 › AI: owner only", () => {
  it("a member sees a sentence, not the page, and nothing is read", async () => {
    setAppState((s) => ({ data: { ...s.data, actor_role: "editor", actor_is_owner: false } }));
    render(<AiSettings ctx={ctx} />);
    expect(screen.getByText("Only the owner can set up AI.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith("/api/ai"))).toEqual([]);
  });
});

describe("設定 › AI: a retry never pretends", () => {
  async function toSaveWithExistingAi(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "New connection" }));
    const dialog = await screen.findByRole("dialog", { name: "New connection" });
    await user.click(within(dialog).getByRole("button", { name: /With an API key/ }));
    await user.type(within(dialog).getByLabelText("Service address"), "https://two.example.com");
    await user.type(within(dialog).getByLabelText("API key", { exact: true }), SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Test" }));
    await within(dialog).findByText("It works. 1 model is available.");
    await user.selectOptions(within(dialog).getByLabelText("Model"), "m-1");
    await user.selectOptions(within(dialog).getByLabelText("Monthly limit"), "unlimited");
    return dialog;
  }

  it("the key is saved, the AI could not take it: another try saves no second key, and a new AI uses the key that was saved, with a key of its own", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    const user = await openPage();
    const dialog = await toSaveWithExistingAi(user);
    failRuntime = true;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().filter((c) => c.method === "PUT")).toHaveLength(1));
    // Retry: still the same key, the change is asked again, nothing is saved twice.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(writes().filter((c) => c.path === "/api/ai/credentials")).toHaveLength(1);
    // Now a new AI instead: it runs on the key that was saved (no second key), under its own idempotency key.
    await user.click(within(dialog).getByLabelText("A new AI"));
    await user.type(within(dialog).getByLabelText("What should this AI be called?"), "Reader");
    failRuntime = false;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/ai/roles")).toBe(true));
    const created = writes().find((c) => c.path === "/api/ai/roles")!;
    expect(created.body).toMatchObject({ name: "Reader", connection: { kind: "api", credential_id: "k-saved" } });
    expect(created.idem).toBeTruthy();
    expect(created.idem).not.toBe(writes().find((c) => c.path === "/api/ai/credentials")!.idem);
    expect(writes().filter((c) => c.path === "/api/ai/credentials")).toHaveLength(1);
  });

  it("a replayed key save (answered deduped, no key id) finds the key that was kept instead of failing", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    dedupe = new Set(["POST /api/ai/credentials"]);
    const user = await openPage();
    const dialog = await toSaveWithExistingAi(user);
    // The replay saved it earlier: it is in the list under its name.
    keys = [...keys, key("k-earlier", "two.example.com")];
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().some((c) => c.method === "PUT")).toBe(true));
    expect(writes().find((c) => c.method === "PUT")!.body).toMatchObject({ api: { credential_id: "k-earlier" } });
  });

  it("a connection code whose reply was lost is not shown as made: it says so", async () => {
    dedupe = new Set(["POST /api/ai/roles"]);
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: /Let your own AI connect in/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/ai/roles")).toBe(true));
    await waitFor(() => expect(getAppState().toasts.map((x) => x.message).join(" ")).toMatch(/reply was lost/));
    expect(screen.queryByText(/onden_CODE/)).toBeNull();
  });
});

describe("設定 › AI: one card only when the connection is the AI's own", () => {
  it("a key kept for nobody next to an AI without a connection is two areas, so the key is visible", async () => {
    keys = [key("k-unused")]; roles = [role("ai", { default_runtime: "mcp", api: null })];
    await openPage();
    expect(document.querySelector(".ai-settings")).toHaveAttribute("data-layout", "split");
    expect(screen.getByText("No AI is using it yet.")).toBeInTheDocument();
  });

  it("the merged card itself can delete its key (the old page goes in step 2)", async () => {
    keys = [key("k1")]; roles = [role("ai")];
    const user = await openPage();
    const card = document.querySelector<HTMLElement>(".ai-card--ai")!;
    await user.click(within(card).getByRole("button", { name: "Delete the key “k1”" }));
    await waitFor(() => expect(writes().some((c) => c.method === "DELETE")).toBe(true));
  });

  it("a merged card on a connection code has How to connect and Revoke", async () => {
    keys = []; roles = [role("ai", { default_runtime: "mcp", api: null })];
    codes = { ai: [{ id: "t1", name: "AI", access: "write", last_used_at: null, revoked_at: null }] };
    const user = await openPage();
    const card = document.querySelector<HTMLElement>(".ai-card--ai")!;
    await user.click(within(card).getByRole("button", { name: "How to connect" }));
    expect(within(card).getByText(/Use the connection code you copied/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: /Revoke the connection code/ }));
    await waitFor(() => expect(writes().some((c) => c.path === "/api/actors/ai/tokens/t1/revoke")).toBe(true));
  });
});

describe("設定 › AI: a standing that is stored in a closed space", () => {
  it("is shown as stored, said to have no effect now, and opening the switch asks first", async () => {
    keys = [key("k1")]; roles = [role("ai", { spaces: { open: "view", closed: "edit" } })];
    const user = await openPage();
    await user.click(screen.getByRole("button", { name: "Edit AI" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit AI" });
    const closed = within(dialog).getAllByRole("listitem").find((li) => li.dataset.aiRead === "off")!;
    expect(within(closed).getByRole("button", { name: /AI in Diary: Can edit/ })).toBeDisabled();
    expect(within(closed).getByText(/has no effect now/)).toBeInTheDocument();
    confirmMock.mockResolvedValueOnce(false);
    await user.click(within(closed).getByRole("button", { name: "Let AI read here" }));
    expect(spaceWrites()).toEqual([]);
  });
});
