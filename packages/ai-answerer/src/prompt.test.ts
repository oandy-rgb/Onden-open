import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerAddress } from "./address.mjs";
import { readConnectionCode } from "./keyFile.mjs";
import { assemblePrompt, parseToolOutput } from "./prompt.mjs";

describe("assemblePrompt", () => {
  it("passes a single message as it is and keeps the system prompt apart", () => {
    expect(assemblePrompt({ system: "S", messages: [{ role: "user", content: "<note/>\n問題" }] })).toEqual({ system: "S", prompt: "<note/>\n問題" });
  });
  it("labels several turns so the tool can tell who spoke", () => {
    const { prompt } = assemblePrompt({ system: "", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] });
    expect(prompt).toBe("[User]\na\n\n[Assistant]\nb\n\n[User]\nc");
  });
});

describe("parseToolOutput", () => {
  it("reads the answer", () => expect(parseToolOutput(JSON.stringify({ is_error: false, result: " 答案 \n" }))).toEqual({ ok: true, text: "答案" }));
  it("reads the result entry of an event array", () => {
    expect(parseToolOutput(JSON.stringify([{ type: "system" }, { type: "result", is_error: false, result: "x" }]))).toEqual({ ok: true, text: "x" });
  });
  it.each([
    ["", "empty"], ["hello", "not_json"], ["[]", "not_json"], ["3", "not_json"],
    [JSON.stringify({ is_error: true, result: "Not logged in" }), "tool_error"],
    [JSON.stringify({ is_error: false, result: "  " }), "empty"],
  ])("refuses %j", (text, reason) => expect(parseToolOutput(text as string)).toEqual({ ok: false, reason }));
});

describe("parseServerAddress", () => {
  it.each(["https://notes.example.com", "https://notes.example.com/", "http://127.0.0.1:5000", "http://localhost:3000", "http://192.168.1.5:5000", "http://100.101.102.103", "http://[::1]:5000", "http://nas.local"])("accepts %s", (a) => {
    expect(parseServerAddress(a).ok).toBe(true);
  });
  it.each(["http://notes.example.com", "http://8.8.8.8", "ftp://x", "not a url", "https://u:p@x.com"])("refuses %s", (a) => {
    expect(parseServerAddress(a).ok).toBe(false);
  });
  it("drops a trailing slash", () => expect(parseServerAddress("https://a.b/")).toEqual({ ok: true, baseUrl: "https://a.b" }));
});

describe("readConnectionCode", () => {
  it("reads a private file and refuses one other users can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "key-"));
    const file = join(dir, "code");
    await writeFile(file, "ondt_secret\n", { mode: 0o600 });
    expect(await readConnectionCode(file)).toBe("ondt_secret");
    await chmod(file, 0o640);
    await expect(readConnectionCode(file)).rejects.toThrow(/chmod 600/);
    await chmod(file, 0o600);
    await writeFile(file, "\n");
    await expect(readConnectionCode(file)).rejects.toThrow(/空的/);
    await expect(readConnectionCode(join(dir, "missing"))).rejects.toThrow(/讀不到/);
  });
});

describe("endpoint", () => {
  it("keeps a path on the server address", async () => {
    const { endpoint } = await import("./protocol.mjs");
    expect(endpoint("https://host/onden", "/api/mcp/protocol")).toBe("https://host/onden/api/mcp/protocol");
    expect(endpoint("https://host/", "/api/x")).toBe("https://host/api/x");
  });
});
