import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { api } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { resetSpacesForTest } from "../lib/spaces";
import { openSpacesAndMembers, spaceFilterStore } from "../lib/settingsRequest";
import { MOBILE_QUERY } from "../hooks/useIsMobile";
import SpacesAndMembers from "../settings/spacesAndMembers";
import type { SettingContext } from "../lib/settingsTypes";
import type { SpaceOverview } from "@onden/contract";

const apiMock = vi.mocked(api);
const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() } as unknown as SettingContext;

const LAB = { id: "lab", name: "Lab", kind: "shared", is_default: false, owner_actor_id: null, capabilities: { external_ai: true }, permission: "edit", can_manage: true };
const CLUB = { id: "club", name: "Club", kind: "shared", is_default: false, owner_actor_id: null, capabilities: { external_ai: true }, permission: "edit", can_manage: true };
const MINE = { id: "mine", name: "me", kind: "personal", is_default: false, owner_actor_id: "owner", capabilities: {}, permission: "edit", can_manage: true };

const overview = (over: Partial<SpaceOverview> = {}): SpaceOverview => ({
  owner_id: "owner",
  spaces: [
    { id: "lab", name: "Lab", kind: "shared", is_default: false, capabilities: { external_ai: true }, members: [
      { actor_id: "owner", name: "Andy", type: "human", permission: "edit" },
      { actor_id: "ming", name: "Ming", type: "human", permission: "view" },
    ] },
    { id: "club", name: "Club", kind: "shared", is_default: false, capabilities: { external_ai: true }, members: [
      { actor_id: "owner", name: "Andy", type: "human", permission: "edit" },
    ] },
  ],
  unplaced: [],
  agents: [{ actor_id: "bot", live_tokens: 0, write_tokens: 0 }],
  ...over,
});
const ACTORS = [
  { id: "owner", name: "Andy", type: "human", external_id: "u1", is_owner: true },
  { id: "ming", name: "Ming", type: "human", external_id: "u2" },
  { id: "bot", name: "Claude", type: "agent", external_id: null },
];

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let keys: Array<Record<string, unknown>>;
let runners: Array<Record<string, unknown>>;
let aiRoles: Array<Record<string, unknown>>;
let apiOffered = false;
let ov: SpaceOverview;

function serve(spaces: unknown[] = [LAB, CLUB, MINE], members: Record<string, unknown[]> = {}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/spaces") return { spaces, is_owner: true };
    if (method === "GET" && path === "/api/spaces/overview") return ov;
    if (method === "GET" && path === "/api/actors") return ACTORS;
    if (method === "GET" && path === "/api/actors/bot/tokens") return keys;
    if (method === "GET" && path === "/api/actors/bot/stats") return { days: 30, last_active: null, tool_calls: 0, tool_failures: 0, tool_time_ms: 0, by_tool: [], changes: [] };
    if (method === "GET" && path === "/api/agent-sessions/runners") return { runners };
    if (method === "GET" && path === "/api/ai/roles") return { roles: aiRoles };
    if (method === "GET" && path === "/api/ai/status") return { api_runtime_offered: apiOffered };
    if (method === "GET" && path === "/api/ai/credentials") return { credentials: [{ id: "c1", label: "desk", last4: "9z9z", created_at: "2026-10-30T00:00:00Z", revoked_at: null, base_url: "https://ai.example.com" }] };
    if (method === "GET" && path === "/api/ai/credentials/c1/models") return { models: [{ id: "m-1", display_name: "M one", lifecycle: "active", web_search: false }] };
    if (method === "PATCH" && path === "/api/ai/roles/bot") {
      aiRoles = aiRoles.map((r) => ({ ...r, review_rule: body!.review_rule ?? r.review_rule }));
      return { role: aiRoles[0] };
    }
    if (method === "GET" && /^\/api\/spaces\/[^/]+\/members$/.test(path)) return { members: members[path.split("/")[3]!] ?? [] };
    if (method === "POST" && path === "/api/actors") return { id: "new1" };
    if (method === "POST" && /^\/api\/actors\/[^/]+\/tokens$/.test(path)) {
      keys = [{ id: "k1", name: body!.name, access: body!.access, last_used_at: null, expires_at: null, revoked_at: null }];
      return { id: "k1", token: "onden_PLAINTEXT_once" };
    }
    return { ok: true };
  });
}
const writes = () => calls.filter((c) => c.method !== "GET");

const realMatchMedia = window.matchMedia;
function setPhone(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({ matches: phone && query === MOBILE_QUERY, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
}
// The layout follows the width of the content area it sits in (0 = not laid out = wide).
const realRect = HTMLElement.prototype.getBoundingClientRect;
function setContentWidth(width: number) {
  HTMLElement.prototype.getBoundingClientRect = function () { return { ...realRect.call(this), width } as DOMRect; };
}
const asOwner = (owner: boolean) => setAppState((s) => ({ data: { ...s.data, actor_is_owner: owner } }));
const person = (name: string) => screen.getByText(name, { selector: ".member-name" }).closest("li.sm-row") as HTMLElement;
const space = (id: string) => {
  const found = document.querySelector<HTMLElement>(`li.sm-row[data-space-id="${id}"]`);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
};
const selectSpace = (id: string) => fireEvent.click(within(space(id)).getAllByRole("button")[0]!);
const selectPerson = (name: string) => fireEvent.click(within(person(name)).getAllByRole("button")[0]!);
/** Open a standing menu by its name and choose one entry. */
const pick = (trigger: string, item: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const entry = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) => item.test(el.textContent ?? ""));
  if (!entry) throw new Error(`no menu entry ${item}`);
  fireEvent.click(entry);
};
const botIn = (spaceId: string, permission: "view" | "edit") => {
  const lab = ov.spaces.find((s) => s.id === spaceId)!;
  lab.members = [...lab.members, { actor_id: "bot", name: "Claude", type: "agent", permission }];
};
const undo = () => {
  const toast = getAppState().toasts.at(-1)!;
  expect(toast.action?.label).toBe("Undo");
  act(() => toast.action!.onClick());
};

beforeEach(() => {
  apiMock.mockReset(); resetSpacesForTest(); resetAppState(); setPhone(false); setContentWidth(0);
  calls = []; keys = []; runners = []; aiRoles = []; ov = overview(); spaceFilterStore.clear(); asOwner(true);
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; HTMLElement.prototype.getBoundingClientRect = realRect; });

describe("空間與成員 (owner, two columns)", () => {
  it("opens on a space, says who sees it, and lists the people in it with a menu each", async () => {
    botIn("lab", "view");
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(space("lab")).toContainElement(screen.getByText("You and 2 others"));
    expect(within(space("club")).getByText("Only you")).toBeInTheDocument();
    expect(within(space("lab")).getByRole("button", { name: /Lab/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("You and Ming, Claude can see the notes here.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Who is in Lab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ming in Lab: View only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude in Lab: View only" })).toBeInTheDocument();
    expect(screen.queryByText("Not here")).toBeNull(); // everybody is in
    expect(screen.queryByText(/By space|Can read|git|GitHub/)).toBeNull();
  });

  it("a space with only the owner says so, and people not in it sit under 「不在這裡」 with 「加入」", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectSpace("club");
    expect(screen.getByText("Only you for now. Once you add someone, they can see these notes.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Who is in Club" });
    expect(within(list).getByText("Not here")).toBeInTheDocument();
    expect(within(person("Ming")).getByRole("button", { name: "Add Ming to Club" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Ming in Club: Can edit" })).toBeNull();
    fireEvent.click(within(person("Ming")).getByRole("button", { name: "Add Ming to Club" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "PUT", path: "/api/spaces/club/members/ming", body: { permission: "edit" } }));
    fireEvent.click(within(person("Claude")).getByRole("button", { name: "Add Claude to Club" })); // an AI starts read-only
    await waitFor(() => expect(writes()).toContainEqual({ method: "PUT", path: "/api/spaces/club/members/bot", body: { permission: "view" } }));
  });

  it("a permission change applies at once and can be undone", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    pick("Ming in Lab: View only", /^Can edit/);
    await waitFor(() => expect(writes()).toEqual([{ method: "PUT", path: "/api/spaces/lab/members/ming", body: { permission: "edit" } }]));
    await waitFor(() => expect(getAppState().toasts.at(-1)?.message).toBe("Ming is now “Can edit” in Lab"));
    undo();
    await waitFor(() => expect(writes().at(-1)).toEqual({ method: "PUT", path: "/api/spaces/lab/members/ming", body: { permission: "view" } }));
    expect(writes()).toHaveLength(2);
    expect(getAppState().toasts.filter((x) => x.action)).toHaveLength(1); // undoing is not offered an undo
  });

  it("moving someone out says what they lose, removes them from that space, and can be undone", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    fireEvent.click(screen.getByRole("button", { name: "Ming in Lab: View only" }));
    expect(screen.getByRole("menuitem", { name: /^Move out of this space/ })).toHaveTextContent("Ming won't see the notes here");
    fireEvent.click(screen.getByRole("menuitem", { name: /^Move out of this space/ }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "DELETE", path: "/api/spaces/lab/members/ming", body: undefined }));
    await waitFor(() => expect(getAppState().toasts.at(-1)?.message).toBe("Ming was moved out of Lab"));
    undo();
    await waitFor(() => expect(writes().at(-1)).toEqual({ method: "PUT", path: "/api/spaces/lab/members/ming", body: { permission: "view" } }));
  });

  it("the owner is fixed as 「擁有者」 and has nothing to change in a space", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(within(person("Andy")).getByText("Owner")).toBeInTheDocument();
    expect(within(person("Andy")).queryByRole("button", { name: /Andy in/ })).toBeNull();
  });

  it("selecting a person turns the spaces list into where they are, and selecting them again goes back", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Ming");
    expect(screen.getByText("Ming: in 1 space")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ming in Lab: View only" })).toBeInTheDocument();
    expect(within(space("club")).getByText("Can't see")).toBeInTheDocument();
    expect(space("club")).toHaveClass("is-away");
    expect(within(space("mine")).queryByRole("button", { name: /Add Ming/ })).toBeNull(); // nobody joins your own space
    expect(within(space("lab")).getAllByRole("button")[0]).not.toHaveAttribute("aria-current");
    fireEvent.click(within(space("club")).getByRole("button", { name: "Add Ming to Club" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "PUT", path: "/api/spaces/club/members/ming", body: { permission: "edit" } }));
    pick("Ming in Lab: View only", /^Move out of this space/);
    await waitFor(() => expect(writes()).toContainEqual({ method: "DELETE", path: "/api/spaces/lab/members/ming", body: undefined }));
    selectPerson("Ming");
    expect(screen.getByRole("heading", { name: "Who is in Lab" })).toBeInTheDocument();
    expect(screen.getByText("You and Ming can see the notes here.")).toBeInTheDocument();
  });

  it("a person's own things (leaving the workspace) sit under them, with a confirmation", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(screen.queryByRole("button", { name: "Remove Ming" })).toBeNull();
    selectPerson("Ming");
    fireEvent.click(within(person("Ming")).getByRole("button", { name: "Remove Ming" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "DELETE", path: "/api/actors/ming", body: undefined }));
  });

  it("the owner's own detail holds the ownership transfer, and nobody can remove the owner", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Andy");
    expect(within(person("Andy")).queryByRole("button", { name: /Remove/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Transfer ownership…" }));
    expect(await screen.findByLabelText("New owner")).toBeInTheDocument();
  });

  it("your own space says only you see it, and cannot take anyone", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectSpace("mine");
    expect(screen.getByText("Only you can see this. People you invite can't either.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Who is in Only me" });
    expect(within(list).getByText("This is your own space. You can't add people.")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /^Add / })).toBeNull();
    expect(screen.queryByLabelText("External AI")).toBeNull();
    expect(screen.queryByRole("switch", { name: /AI can read/ })).toBeNull(); // a switch that does not apply is hidden
  });

  it("the three switches write the space's switches, and rename and delete are under them", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(screen.getByRole("switch", { name: /AI can read/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Publish to the website/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: /Publish to the website/ }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "PATCH", path: "/api/spaces/lab", body: { capabilities: { publish: true } } }));
    fireEvent.click(screen.getByRole("switch", { name: /AI can read/ }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "PATCH", path: "/api/spaces/lab", body: { capabilities: { external_ai: false } } }));
    expect(screen.getByRole("switch", { name: /Include in backups/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Space name"), { target: { value: "Lab 2" } });
    fireEvent.click(within(screen.getByLabelText("Space name").closest("form")!).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "PATCH", path: "/api/spaces/lab", body: { name: "Lab 2" } }));
    expect(screen.getByRole("button", { name: "Delete space…" })).toBeInTheDocument();
  });

  it("the spaces list shows a small mark on a space that publishes", async () => {
    serve([{ ...LAB, capabilities: { publish: true } }, CLUB, MINE]);
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(within(space("lab")).getByText("Publishing")).toBeInTheDocument();
    expect(within(space("club")).queryByText("Publishing")).toBeNull();
  });

  it("a new space is made from the last row and becomes the selected one", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    fireEvent.change(screen.getByLabelText("New shared space name"), { target: { value: "Reading" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "POST", path: "/api/spaces", body: { name: "Reading" } }));
  });

  it("an AI role's own things (how it runs, pause, its key) sit under it, and nothing is lost", async () => {
    botIn("lab", "view");
    runners = [{ actor_id: "bot", handle: "ai", enabled: true }];
    keys = [{ id: "k1", name: "laptop", access: "read", last_used_at: null, expires_at: null, revoked_at: null }];
    ov.agents = [{ actor_id: "bot", live_tokens: 1, write_tokens: 0 }];
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(person("Claude").querySelector(".sm-avatar--ai")).not.toBeNull(); // dashed avatar
    selectPerson("Claude");
    const bot = person("Claude");
    expect(await within(bot).findByText(/Called with @ai in Onden/)).toBeInTheDocument();
    expect(within(bot).getByText(/Connects from your own AI \(MCP key\)/)).toBeInTheDocument();
    fireEvent.click(within(bot).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "POST", path: "/api/agent-sessions/runners/bot/enabled", body: { enabled: false } }));
    expect(writes().some((c) => c.method === "DELETE")).toBe(false);
    expect(bot.textContent).not.toMatch(/\bbot\b|k1/); // no ids on screen
  });

  const aiRole = (over: Record<string, unknown> = {}) => ({
    actor_id: "bot", enabled: true, default_runtime: "mcp", review_rule: "suggest", review_rule_locked: false,
    runtimes: [
      { kind: "api", available: false, unavailable_reason: "no_model", last_seen_at: null },
      { kind: "mcp", available: true, unavailable_reason: null, last_seen_at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
    ],
    usage_this_month: { input_tokens: 12345, output_tokens: 678, cost_estimate_micro_usd: null },
    api: null, ...over,
  });

  it("an AI role shows its review rule, why a way of running is down, and this month's use — no ids, no codes", async () => {
    botIn("lab", "edit");
    aiRoles = [aiRole()];
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Claude");
    const bot = person("Claude");
    expect(await within(bot).findByRole("button", { name: "Review rule of Claude: Show me first (suggest)" })).toBeInTheDocument();
    expect(within(bot).getByText("Choose a model.")).toBeInTheDocument();
    // One "mcp" way: a client that polls for work and one opened by hand both show as when it last came.
    expect(within(bot).getByText(/Ready\. Your AI last called it/)).toBeInTheDocument();
    expect(within(bot).getByText("Input 12,345, output 678 (the model's unit of text).")).toBeInTheDocument();
    expect(bot.textContent).not.toMatch(/About \$/); // no price known: no money is shown
    expect(bot.textContent).not.toMatch(/runner_|no_model|\bbot\b|suggest\b(?!\))/);
  });

  it("switching to 'edit directly' asks first; declining writes nothing, accepting saves the rule", async () => {
    const { confirmDialog } = await import("../components/ConfirmDialog");
    botIn("lab", "edit");
    aiRoles = [aiRole()];
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Claude");
    await within(person("Claude")).findByRole("button", { name: /Review rule of Claude/ });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    pick("Review rule of Claude: Show me first (suggest)", /^Edit directly/);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.stringMatching(/undo each one from the history/), expect.anything()));
    expect(writes().some((c) => c.path === "/api/ai/roles/bot")).toBe(false);
    pick("Review rule of Claude: Show me first (suggest)", /^Edit directly/);
    await waitFor(() => expect(writes()).toContainEqual({ method: "PATCH", path: "/api/ai/roles/bot", body: { review_rule: "apply" } }));
    expect(await screen.findByRole("button", { name: "Review rule of Claude: Edit directly (undo later)" })).toBeInTheDocument();
    // Back to "show me first" needs no confirmation.
    vi.mocked(confirmDialog).mockClear();
    pick("Review rule of Claude: Edit directly (undo later)", /^Show me first/);
    await waitFor(() => expect(writes()).toContainEqual({ method: "PATCH", path: "/api/ai/roles/bot", body: { review_rule: "suggest" } }));
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("a role that runs through the API cannot change the rule, and says why", async () => {
    botIn("lab", "edit");
    aiRoles = [aiRole({ default_runtime: "api", review_rule_locked: true, review_rule: "apply" })];
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Claude");
    const trigger = await within(person("Claude")).findByRole("button", { name: "Review rule of Claude: Show me first (suggest)" });
    expect(trigger).toBeDisabled();
    expect(within(person("Claude")).getByText(/can only suggest/)).toBeInTheDocument();
  });

  it("an AI role in no space says so", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Claude");
    expect(within(person("Claude")).getByRole("alert")).toHaveTextContent("Claude is not in any space");
  });

  it("a key is issued read-only or read-and-write, and its plaintext is shown once", async () => {
    botIn("lab", "edit");
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Claude");
    const bot = person("Claude");
    fireEvent.click(within(bot).getByRole("button", { name: "Settings of the role Claude" }));
    fireEvent.change(within(bot).getByLabelText("Key name (optional)"), { target: { value: "laptop" } });
    fireEvent.click(within(bot).getByLabelText(/^Read and write: /));
    fireEvent.click(within(bot).getByRole("button", { name: "Issue key" }));
    const fresh = await within(bot).findByText("onden_PLAINTEXT_once");
    expect(writes()).toContainEqual({ method: "POST", path: "/api/actors/bot/tokens", body: { name: "laptop", access: "write" } });
    expect(fresh.closest("[role=status]")).toHaveTextContent("It will never be shown again");
    fireEvent.click(within(bot).getByRole("button", { name: "Done" }));
    expect(within(bot).queryByText("onden_PLAINTEXT_once")).toBeNull();
  });

  it("a new AI role is made from the last row, step by step, and shows its key once", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    fireEvent.click(screen.getByRole("button", { name: "Invite a member or add an AI" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add an AI role" }));
    const next = () => screen.getByRole("button", { name: "Next" });
    expect(next()).toBeDisabled(); // a name first
    fireEvent.change(screen.getByLabelText("What should this AI role be called?"), { target: { value: "Gemma" } });
    fireEvent.click(next());
    // Two ways, each with one plain sentence: the API (here the server offers no key, so it says why) and MCP.
    const ways = within(screen.getByRole("form", { name: "New AI role" })).getAllByRole("radio");
    expect(ways.map((r) => r.closest("label")?.textContent)).toEqual([
      expect.stringMatching(/^API.*suggest changes.*This server can't keep API keys yet\.$/), expect.stringMatching(/^MCP.*kept on a machine/)]);
    expect(ways[0]).toBeDisabled();
    fireEvent.click(ways[1]!);
    fireEvent.click(next());
    fireEvent.change(screen.getByLabelText("Its own @name (for when you have several AIs)"), { target: { value: "gemma" } });
    fireEvent.change(screen.getByLabelText("Key name (optional)"), { target: { value: "desk" } });
    fireEvent.click(next());
    // The space the page is on starts as 只能看; the role can be kept out of it.
    pick("Gemma in Lab: View only", /^Not in this space/);
    expect(next()).toBeDisabled(); // at least one space
    pick("Gemma in Lab: Not in", /^Can edit/);
    pick("Gemma in Lab: Can edit", /^View only/);
    fireEvent.click(next());
    fireEvent.click(screen.getByRole("button", { name: "Add AI role" }));
    expect(await screen.findByText("onden_PLAINTEXT_once")).toBeInTheDocument();
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/actors", "PUT /api/spaces/lab/members/new1", "PUT /api/agent-sessions/runners/new1",
      "POST /api/agent-sessions/runners/new1/enabled", "POST /api/actors/new1/tokens",
    ]);
    expect(writes()[1]!.body).toEqual({ permission: "view" });
  });

  it("has no API key block of its own: keys are set up in Settings › AI", async () => {
    apiOffered = true;
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: ["ai"] } } }));
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await screen.findByText("The space a note is in decides who can see it.");
    expect(screen.queryByRole("region", { name: "API keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save key" })).toBeNull();
  });

  it("an API role is added with a key, a model from that service's own list and a token limit, then runs on the API", async () => {
    apiOffered = true;
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    fireEvent.click(screen.getByRole("button", { name: "Invite a member or add an AI" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add an AI role" }));
    fireEvent.change(screen.getByLabelText("What should this AI role be called?"), { target: { value: "Helper" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const api = await waitFor(() => {
      const radio = within(screen.getByRole("form", { name: "New AI role" })).getAllByRole("radio")[0]!;
      expect(radio).toBeEnabled();
      return radio;
    });
    fireEvent.click(api);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled(); // a key, a model and a limit first
    const form = within(screen.getByRole("form", { name: "New AI role" }));
    fireEvent.change(form.getByLabelText("API key"), { target: { value: "c1" } });
    await form.findByRole("option", { name: "M one" });
    fireEvent.change(form.getByLabelText("Model"), { target: { value: "m-1" } });
    fireEvent.change(form.getByLabelText("Monthly limit"), { target: { value: "capped" } });
    fireEvent.change(form.getByLabelText(/Tokens per month/), { target: { value: "500000" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    pick("Helper in Lab: View only", /^Can edit/);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Add AI role" }));
    await waitFor(() => expect(writes().map((c) => `${c.method} ${c.path}`)).toContain("PUT /api/ai/roles/new1/runtime"));
    expect(writes().find((c) => c.path === "/api/ai/roles/new1/runtime")!.body).toEqual({
      default_runtime: "api", api: { credential_id: "c1", model: "m-1", cap: { kind: "capped", tokens: 500000 } },
    });
    expect(writes().some((c) => c.path === "/api/actors/new1/tokens")).toBe(false); // the API way mints no key to paste
    apiOffered = false;
  });

  it("inviting a person starts from the selected space", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectSpace("club");
    fireEvent.click(screen.getByRole("button", { name: "Invite a member or add an AI" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Invite a person" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lin" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "lin@example.com" } });
    expect(screen.getByRole("button", { name: "Lin in Club: View only" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/actors", "PUT /api/spaces/club/members/new1"]));
    expect(writes()[0]!.body).toEqual({ name: "Lin", type: "human", email: "lin@example.com" });
  });

  it("a shortcut from a note selects that space", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    act(() => openSpacesAndMembers("club"));
    await waitFor(() => expect(within(space("club")).getByRole("button", { name: /Club/ })).toHaveAttribute("aria-current", "true"));
    expect(screen.getByRole("heading", { name: "Who is in Club" })).toBeInTheDocument();
    expect(spaceFilterStore.get()).toBeNull();
  });
});

describe("空間與成員 (owner, narrow: two layers)", () => {
  beforeEach(() => setContentWidth(390));

  it("the first layer is both lists; a space opens its own page and Back returns", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    expect(screen.getByRole("list", { name: "Members" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ming in Lab: View only" })).toBeNull(); // no menus on the first layer
    expect(screen.queryByRole("switch")).toBeNull();
    expect(document.querySelector('[aria-current="true"]')).toBeNull(); // nothing is selected until one is opened
    selectSpace("lab");
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByText("You and Ming can see the notes here.")).toBeInTheDocument();
    pick("Ming in Lab: View only", /^Can edit/);
    await waitFor(() => expect(writes()).toContainEqual({ method: "PUT", path: "/api/spaces/lab/members/ming", body: { permission: "edit" } }));
    expect(screen.getByRole("switch", { name: /Publish to the website/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite a member or add an AI" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("list", { name: "Members" })).toBeInTheDocument();
  });

  it("an AI role's page on a phone has the review rule too", async () => {
    botIn("lab", "edit");
    aiRoles = [{
      actor_id: "bot", enabled: true, default_runtime: "mcp", review_rule: "apply", review_rule_locked: false,
      runtimes: [{ kind: "mcp", available: true, unavailable_reason: null, last_seen_at: null }],
      usage_this_month: { input_tokens: 0, output_tokens: 0, cost_estimate_micro_usd: null }, api: null,
    }];
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Claude");
    expect(await screen.findByRole("button", { name: "Review rule of Claude: Edit directly (undo later)" })).toBeInTheDocument();
    expect(screen.getByText("No use this month yet.")).toBeInTheDocument();
  });

  it("a person opens a page with where they are, and what is theirs alone", async () => {
    serve();
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("lab"));
    selectPerson("Ming");
    expect(screen.getByText("Ming: in 1 space")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ming in Lab: View only" })).toBeInTheDocument();
    fireEvent.click(within(space("club")).getByRole("button", { name: "Add Ming to Club" }));
    await waitFor(() => expect(writes()).toContainEqual({ method: "PUT", path: "/api/spaces/club/members/ming", body: { permission: "edit" } }));
    expect(screen.getByRole("button", { name: "Remove Ming" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Ming: in 1 space")).toBeNull();
  });
});

describe("空間與成員 (a member)", () => {
  it("has no 「發布到網站」 switch for their own space: the website is the workspace owner's", async () => {
    asOwner(false);
    serve([{ ...LAB, permission: "view", can_manage: false }, { ...MINE, owner_actor_id: "ming" }]);
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => space("mine"));
    selectSpace("mine");
    expect(await screen.findByRole("switch", { name: /Include in backups/ })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Publish to the website/ })).toBeNull();
  });

  it("sees the same lists read-only, with nothing to change", async () => {
    asOwner(false);
    const member = { ...LAB, permission: "view", can_manage: false };
    serve([member, { ...MINE, owner_actor_id: "ming" }], { lab: [
      { id: "owner", name: "Andy", type: "human", permission: "edit" },
      { id: "ming", name: "Ming", type: "human", permission: "view" },
      { id: "bot", name: "Claude", type: "agent", permission: "view" },
    ] });
    render(<SpacesAndMembers ctx={ctx} />);
    await waitFor(() => person("Ming"));
    expect(screen.getByText("The space a note is in decides who can see it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ming in Lab: View only")).toBeInTheDocument();
    expect(within(space("lab")).getByText("You and 2 others")).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Ming in Lab/ })).toBeNull(); // text, not a menu
    expect(screen.queryByRole("button", { name: /Invite|New space|Transfer|Remove|Pause|Add /})).toBeNull();
    expect(within(person("Claude")).getByText("AI role")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/spaces/overview" || c.path === "/api/actors")).toBe(false); // owner-only reads
  });
});
