// "Build your first website" (D70): the intro pages go into a space that
// publishes, are marked, and the site is published the Studio's way —
// preview, then publish that candidate — before anything says it is live.
// The user's own notes are never published, whatever their title.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const writers = vi.hoisted(() => ({
  create: vi.fn(),
  setProperty: vi.fn(),
  saveDesign: vi.fn(),
  setHome: vi.fn(),
  previewPublish: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("../../lib/data/domainWriters", async (original) => ({
  ...await original<typeof import("../../lib/data/domainWriters")>(),
  noteWriter: { create: writers.create },
  propertyWriter: { set: writers.setProperty },
  workspaceWriter: { saveDesign: writers.saveDesign, setHome: writers.setHome },
}));
vi.mock("./websiteWriter", () => ({
  makeWebsiteWriter: () => ({ previewPublish: writers.previewPublish, publish: writers.publish }),
}));
const spaces = vi.hoisted(() => ({ list: [] as import("../../lib/spaces").Space[] }));
vi.mock("../../lib/spaces", async (original) => ({
  ...await original<typeof import("../../lib/spaces")>(),
  refreshSpaces: vi.fn(async () => {}),
  loadedSpaces: () => spaces.list,
}));

import { buildIntroSite, introSiteSpace, resetIntroSiteForTest } from "./introSite";
import { INTRO_HOME_TITLE, INTRO_PAGES } from "../../data/introSite";
import { noWorkspaceData, type ContentNode } from "../../lib/api";
import { getAppState, resetAppState, setAppState } from "../../lib/appStore";
import type { Space } from "../../lib/spaces";

const space = (id: string, over: Partial<Space> = {}): Space => ({
  id, name: id, kind: "shared", is_default: false, owner_actor_id: null, capabilities: { publish: true }, permission: "edit", can_manage: false, ...over,
});
const personal = space("personal", { kind: "personal", capabilities: { publish: false }, can_manage: true });
const everyone = space("everyone", { is_default: true, can_manage: true });
const userNote = (id: string, title: string): ContentNode =>
  ({ id, title, slug: title.toLowerCase(), markdown: "mine", source_type: "manual", node_type: "content" });

// The fake server: a created page is in the store and, when its space
// publishes and it is marked, in the publish candidate.
let extraAdded: Array<{ id: string; title: string; slug: string }> = [];
let created: Array<{ id: string; title: string; space_id?: string | null; attributes?: Array<{ key: string; value: string }> }> = [];
const publishable = () => created.filter((p) =>
  spaces.list.find((s) => s.id === p.space_id)?.capabilities.publish === true
  && p.attributes?.some((a) => a.key === "_published" && a.value === "true"));

beforeEach(() => {
  extraAdded = [];
  calls.length = 0;
  created = [];
  resetIntroSiteForTest();
  resetAppState();
  setAppState({ online: true, data: { ...noWorkspaceData, nodes: [userNote("mine-home", "Home"), userNote("mine-about", "About")] } });
  spaces.list = [personal, everyone];
  Object.values(writers).forEach((fn) => fn.mockReset());
  writers.create.mockImplementation(async (input: (typeof created)[number] & { markdown: string }) => {
    calls.push(`create ${input.title} in ${input.space_id}`);
    created.push(input);
    const node = { ...userNote(input.id, input.title), markdown: input.markdown, space_id: input.space_id };
    setAppState({ data: { ...getAppState().data, nodes: [...getAppState().data.nodes, node] } });
    return { status: "synced", node };
  });
  writers.saveDesign.mockImplementation(async (input: { config: object }) => {
    calls.push("save design");
    setAppState({ data: { ...getAppState().data, site_config: { ...getAppState().data.site_config, ...input.config } } });
    return { status: "synced" };
  });
  writers.setHome.mockImplementation(async () => { calls.push("set home"); return { status: "synced" }; });
  writers.previewPublish.mockImplementation(async () => {
    calls.push("preview");
    const nodes = publishable().map((p) => ({ id: p.id, title: p.title, slug: p.title.toLowerCase().replace(/\s+/g, "-") }));
    return { hash: "h1", site: { payload: { nodes } }, diff: { added: [...nodes, ...extraAdded], changed: [], moved: [], links_changed: [], removed: [] } };
  });
  writers.publish.mockImplementation(async (body: { preview_hash: string }) => { calls.push(`publish ${body.preview_hash}`); return { url: "/site/" }; });
});

describe("buildIntroSite", () => {
  it("publishes nothing and sends the user to the Website screen's preview when the publish would carry other notes", async () => {
    extraAdded.push({ id: "mine-diary", title: "My diary", slug: "my-diary" });
    const home = await buildIntroSite();
    expect(home).toEqual({ needsReview: true, homeId: expect.any(String) });
    expect(writers.publish).not.toHaveBeenCalled();
  });

  it("creates the pages in the shared space, marked, then publishes the previewed candidate", async () => {
    const site = await buildIntroSite();
    const home = created.find((p) => p.title === INTRO_HOME_TITLE)!;
    expect(site).toEqual({ url: "/site/home", homeId: home.id });
    expect(calls).toEqual([
      ...INTRO_PAGES.map((p) => `create ${p.title} in everyone`),
      "save design", "set home", "preview", "publish h1",
    ]);
    // Every page marked in its own creation; the published site has Home.
    expect(publishable().map((p) => p.title)).toEqual(INTRO_PAGES.map((p) => p.title));
    expect(writers.publish.mock.calls[0]![0]).toMatchObject({ home_node_id: home.id, preview_hash: "h1" });
    // The design's nav points at the new pages, not the user's notes.
    const nav = (writers.saveDesign.mock.calls[0]![0] as { config: { nav: Array<{ nodeId: string }> } }).config.nav;
    expect(nav.map((n) => n.nodeId)).not.toContain("mine-home");
  });

  it("never publishes the user's own notes of the same title", async () => {
    await buildIntroSite();
    expect(writers.setProperty).not.toHaveBeenCalled();
    expect(created.map((p) => p.id)).not.toContain("mine-home");
    expect(created.map((p) => p.id)).not.toContain("mine-about");
    const candidate = (await writers.previewPublish.mock.results[0]!.value) as { site: { payload: { nodes: Array<{ id: string }> } } };
    expect(candidate.site.payload.nodes.map((n) => n.id)).not.toContain("mine-home");
  });

  it("says so, and creates nothing, when no space of the user publishes", async () => {
    spaces.list = [personal, space("team", { capabilities: { publish: false } })];
    await expect(buildIntroSite()).resolves.toBeNull();
    expect(writers.create).not.toHaveBeenCalled();
    expect(writers.publish).not.toHaveBeenCalled();
    expect(getAppState().toasts.at(-1)?.message).toMatch(/None of your spaces publishes/);
  });

  it("does not publish or announce a site that would not have Home", async () => {
    writers.previewPublish.mockResolvedValueOnce({ hash: "h1", site: { payload: { nodes: [] } } });
    await expect(buildIntroSite()).resolves.toBeNull();
    expect(writers.publish).not.toHaveBeenCalled();
    expect(getAppState().toasts.some((t) => /You just published/.test(t.message))).toBe(false);
  });

  it("a retry after a failed publish reuses the pages it created", async () => {
    writers.publish.mockRejectedValueOnce(new Error("offline"));
    await expect(buildIntroSite()).resolves.toBeNull();
    await expect(buildIntroSite()).resolves.not.toBeNull();
    expect(writers.create).toHaveBeenCalledTimes(INTRO_PAGES.length);
  });
});

describe("introSiteSpace", () => {
  it("prefers the default shared space, never one the caller only views or that does not publish", () => {
    const team = space("team");
    expect(introSiteSpace([personal, team, everyone])?.id).toBe("everyone");
    expect(introSiteSpace([personal, team, { ...everyone, permission: "view", can_manage: false }])?.id).toBe("team");
    expect(introSiteSpace([personal])).toBeNull();
  });
});
