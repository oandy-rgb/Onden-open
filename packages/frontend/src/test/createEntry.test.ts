// @vitest-environment jsdom
// The one create entry (useNodeCreation.create over lib/createKinds): a typed
// note is created WITH the attribute that gives it its kind in one request, so
// a refusal leaves nothing behind (no compensating delete) and is reported
// once; a `parentId` files the new note under it; a cancelled picker makes
// nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(async (request: object, rejection: string) => ({ ...request, id: 1, attempts: 0, rejection })),
}));
import { acceptFor } from "@onden/markdown";
import { canvasWriter, nodeActions } from "../lib/data";
import { createKindsFor, BUILTIN_CREATE_KINDS } from "../lib/createKinds";
import { ALL_MODULES, moduleFilterFor } from "../modules";
import { useNodeCreation } from "../hooks/useNodeCreation";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState } from "../lib/appStore";
import { type Bootstrap } from "../lib/api";
import { claimNoteTitleFocus } from "../lib/cardTitleFocus";
import { ownerData } from "./ownerData";

function params() {
  return {
    data: { nodes: [] } as unknown as Bootstrap,
    createNodeRaw: vi.fn(async () => null), refresh: vi.fn(),
    draftTitle: "",
    setCreateOpen: vi.fn(),
    activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId: vi.fn(), setMode: vi.fn(), openNote: vi.fn(), openModuleScreen: vi.fn(), openNewTag: vi.fn(),
  };
}
type Req = { url: string; method: string; body: Record<string, unknown> };
let requests: Req[] = [];
function respond(rule: (req: Req) => Response | undefined) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const req = { url: String(url), method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : {} };
    requests.push(req);
    return rule(req) ?? new Response(JSON.stringify(req.body), { status: 200 });
  }));
}
const errors = () => getAppState().toasts.filter((toast) => toast.kind === "error");

beforeEach(() => { bindAccountStorage("unit-test-account", ""); requests = []; resetAppState({ data: { ...ownerData, nodes: [] }, online: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

const posts = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/api/nodes"));

describe("create: handwriting", () => {
  it("a refused handwritten note leaves no note, needs no cleanup, and is reported once", async () => {
    respond((req) => req.method === "POST" ? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) : undefined);
    const p = params();
    expect(await useNodeCreation(p).create("ink")).toBeNull();
    expect(posts()).toHaveLength(1);
    expect((posts()[0]!.body.attributes as Array<{ key: string }>).map((a) => a.key)).toEqual(["ink_data"]);
    expect(requests.some((r) => r.method === "DELETE" || r.method === "PUT")).toBe(false);
    expect(getAppState().data.nodes).toHaveLength(0);
    expect(p.setSelectedId).not.toHaveBeenCalled();
    expect(errors()).toHaveLength(0); // the recovery entry is the one notification
  });

  it("a successful handwritten note is one request carrying its kind, in the store and selected", async () => {
    respond(() => undefined);
    const p = params();
    const id = await useNodeCreation(p).create("ink");
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(1);
    expect(p.openNote).toHaveBeenCalledWith(id);
    expect(getAppState().data.nodes.find((n) => n.id === id)?.attrs).toHaveProperty("ink_data");
    expect(errors()).toHaveLength(0);
  });
});

// A file kind opens the picker; this stands in for the person.
function pickerAnswers(answer: (input: HTMLInputElement) => void) {
  return vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { answer(this); });
}
const chooseFile = (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
};

describe("create under a parent", () => {
  const upload = () => respond((req) => req.url.endsWith("/api/media") ? new Response(JSON.stringify({ url: "/api/media/x" }), { status: 200 }) : undefined);

  it("a plain note passes the parent to the raw create", async () => {
    const p = params();
    await useNodeCreation(p).create("note", { parentId: "parent-1" });
    expect(p.createNodeRaw).toHaveBeenCalledWith("Untitled", "markdown", 0, "parent-1", null);
  });

  it("a plain note takes its title, and a note under a parent is opened through navigation", async () => {
    const p = params();
    p.createNodeRaw.mockResolvedValue({ id: "n1" } as never);
    await useNodeCreation(p).create("note", { parentId: "parent-1" });
    expect(p.openNote).toHaveBeenCalledWith("n1");
    expect(claimNoteTitleFocus("n1")).toBe(true);
  });

  it("a top-level note is selected and joins the open board", async () => {
    const p = { ...params(), activeCanvas: { id: "board" } as never };
    p.createNodeRaw.mockResolvedValue({ id: "n2" } as never);
    await useNodeCreation(p).create("note");
    expect(p.createNodeRaw).toHaveBeenCalledWith("Untitled", "markdown", 0, null, null);
    expect(p.addToActiveCanvas).toHaveBeenCalledWith("n2");
    expect(p.setSelectedId).toHaveBeenCalledWith("n2");
  });

  it("handwriting is created with parent_id", async () => {
    respond(() => undefined);
    const id = await useNodeCreation(params()).create("ink", { parentId: "parent-1" });
    expect(posts()[0]!.body).toMatchObject({ id, parent_id: "parent-1" });
    expect(getAppState().data.nodes.find((n) => n.id === id)?.parent_id).toBe("parent-1");
  });

  it.each([["a.pdf", true], ["a.png", false], ["a.mp3", false], ["a.mp4", false]])("an uploaded %s is created with parent_id; a PDF carries pdf_url, media is the body", async (name, isPdf) => {
    upload();
    const click = pickerAnswers((input) => chooseFile(input, new File(["x"], name)));
    try {
      const id = await useNodeCreation(params()).create("upload", { parentId: "parent-1" });
      expect(id).not.toBeNull();
      expect(posts()).toHaveLength(1);
      const body = posts()[0]!.body;
      expect(body).toMatchObject({ parent_id: "parent-1", title: "a" });
      if (isPdf) expect(body.attributes).toEqual([{ key: "pdf_url", value: "/api/media/x" }]);
      else expect(body).toMatchObject({ markdown: "![a](/api/media/x)\n" });
    } finally { click.mockRestore(); }
  });

  it("a bookmark is filed under the parent after the server makes it", async () => {
    respond((req) => req.url.endsWith("/api/bookmark") ? new Response(JSON.stringify({ id: "bm" }), { status: 200 }) : undefined);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(" https://example.com ");
    const assign = vi.spyOn(nodeActions, "assignToGroup").mockResolvedValue();
    try {
      expect(await useNodeCreation(params()).create("bookmark", { parentId: "parent-1" })).toBe("bm");
      expect(assign).toHaveBeenCalledExactlyOnceWith("bm", "parent-1");
    } finally { prompt.mockRestore(); assign.mockRestore(); }
  });

  it("a bookmark prompt that is cancelled creates nothing", async () => {
    respond(() => undefined);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    try {
      expect(await useNodeCreation(params()).create("bookmark", { parentId: "parent-1" })).toBeNull();
      expect(requests).toHaveLength(0);
    } finally { prompt.mockRestore(); }
  });

  it("every placeable built-in kind is covered above", () => {
    expect(BUILTIN_CREATE_KINDS.filter((k) => k.placeable).map((k) => k.id)).toEqual(["note", "ink", "upload", "bookmark", "canvas"]);
  });

  it("a board is made by the canvas writer, filed under the parent and opened", async () => {
    const create = vi.spyOn(canvasWriter, "create").mockResolvedValue({ id: "cv", title: "Untitled canvas", created_at: "", updated_at: "", data: { nodes: [] } });
    const assign = vi.spyOn(nodeActions, "assignToGroup").mockResolvedValue();
    try {
      const p = params();
      expect(await useNodeCreation(p).create("canvas", { parentId: "parent-1" })).toBe("cv");
      expect(create).toHaveBeenCalledExactlyOnceWith("Untitled canvas", {});
      expect(assign).toHaveBeenCalledExactlyOnceWith("cv", "parent-1");
      expect(p.openNote).toHaveBeenCalledWith("cv");
    } finally { create.mockRestore(); assign.mockRestore(); }
  });

  it("a top-level note, handwriting, bookmark and board go to the chosen space", async () => {
    const p = params();
    await useNodeCreation(p).create("note", { spaceId: "sp-web" });
    expect(p.createNodeRaw).toHaveBeenCalledWith("Untitled", "markdown", 0, null, "sp-web");
    respond(() => undefined);
    const id = await useNodeCreation(params()).create("ink", { spaceId: "sp-web" });
    expect(posts()[0]!.body).toMatchObject({ id, space_id: "sp-web" });
    expect(posts()[0]!.body).not.toHaveProperty("parent_id");
    const create = vi.spyOn(canvasWriter, "create").mockResolvedValue({ id: "cv", title: "Untitled canvas", created_at: "", updated_at: "", data: { nodes: [] } });
    try {
      await useNodeCreation(params()).create("canvas", { spaceId: "sp-web" });
      expect(create).toHaveBeenCalledExactlyOnceWith("Untitled canvas", { spaceId: "sp-web" });
    } finally { create.mockRestore(); }
  });

  it("under a parent the space is ignored: the note keeps its parent's space", async () => {
    const p = params();
    await useNodeCreation(p).create("note", { parentId: "parent-1", spaceId: "sp-web" });
    expect(p.createNodeRaw).toHaveBeenCalledWith("Untitled", "markdown", 0, "parent-1", null);
    respond(() => undefined);
    await useNodeCreation(params()).create("ink", { parentId: "parent-1", spaceId: "sp-web" });
    expect(posts().at(-1)!.body).not.toHaveProperty("space_id");
  });

  it("a top-level board is not filed anywhere", async () => {
    const create = vi.spyOn(canvasWriter, "create").mockResolvedValue({ id: "cv", title: "Untitled canvas", created_at: "", updated_at: "", data: { nodes: [] } });
    const assign = vi.spyOn(nodeActions, "assignToGroup").mockResolvedValue();
    try {
      expect(await useNodeCreation(params()).create("canvas")).toBe("cv");
      expect(assign).not.toHaveBeenCalled();
    } finally { create.mockRestore(); assign.mockRestore(); }
  });

  it("the board kind is listed whatever the stored module list says, and works offline", () => {
    expect(createKindsFor(moduleFilterFor(["rss", "canvas"])).find((k) => k.id === "canvas"))
      .toMatchObject({ label: "Canvas", placeable: true, needsServer: false });
    expect(createKindsFor(moduleFilterFor(["rss"])).some((k) => k.id === "canvas")).toBe(true);
  });

  it("only built-in kinds are listed: no module adds one, and the file kinds are one upload", () => {
    expect(createKindsFor(ALL_MODULES).map((k) => k.id)).toEqual(["note", "tag", "task", "ink", "upload", "bookmark", "canvas"]);
    expect(createKindsFor(ALL_MODULES).find((k) => k.id === "note")).toMatchObject({ needsServer: false });
    expect(createKindsFor(ALL_MODULES).find((k) => k.id === "upload")).toMatchObject({ needsServer: true, placeable: true });
  });

});

// A cancelled picker (the input's `cancel` event, or a change with no file)
// uploads and creates nothing.
describe("create: cancelled file picker", () => {
  it("upload: cancel makes nothing", async () => {
    respond(() => undefined);
    const p = params();
    const click = pickerAnswers((input) => input.dispatchEvent(new Event("cancel")));
    try {
      expect(await useNodeCreation(p).create("upload", { parentId: "parent-1" })).toBeNull();
    } finally { click.mockRestore(); }
    expect(requests).toHaveLength(0);
    expect(p.setSelectedId).not.toHaveBeenCalled();
    expect(errors()).toHaveLength(0);
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("a change with no file makes nothing", async () => {
    respond(() => undefined);
    const click = pickerAnswers((input) => input.dispatchEvent(new Event("change")));
    try {
      expect(await useNodeCreation(params()).create("upload")).toBeNull();
    } finally { click.mockRestore(); }
    expect(requests).toHaveLength(0);
  });
});

describe("create file pickers", () => {
  it("the upload picker offers what lib/fileIntake takes: every kind /api/media takes (PDF, image, audio, video, documents)", () => {
    const offered: string[] = [];
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { offered.push(this.accept); });
    try {
      void useNodeCreation(params()).create("upload");
      expect(offered).toEqual([acceptFor("pdf", "image", "audio", "video", "document")]);
      expect(offered[0]!.split(",")).toEqual(expect.arrayContaining(["application/pdf", "video/mp4", ".mp4", ".webm", "audio/mpeg", "image/jpeg", ".ico", ".docx", ".txt"]));
      expect(offered[0]).not.toMatch(/\/\*/);
    } finally {
      click.mockRestore();
      document.querySelectorAll("input[type=file]").forEach((input) => input.remove());
    }
  });
});
