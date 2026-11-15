import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestFailureMessage, writeFailureMessage } from "../lib/data/writeErrors";
import { setLocalePref } from "../lib/i18n";
import { SERVER_ERROR_MESSAGES, ensureSentenceWording, serverErrorMessage } from "../lib/serverErrors";
import { lateCodeMessage } from "../lib/serverSentences";
import { ApiError } from "../lib/api";
import { ZH_TW as zh } from "../lib/i18n.zh-TW";

// The late table's own entries, read from its source (it is not exported: only lateCodeMessage is).
const LATE_SERVER_ERROR_MESSAGES: Record<string, string> = (() => {
  const text = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../lib/serverSentences.ts"), "utf8");
  const body = text.split("const LATE_SERVER_ERROR_MESSAGES")[1]!.split("\n};")[0]!;
  return Object.fromEntries([...body.matchAll(/^ {2}([a-z0-9_]+): ("(?:[^"\\]|\\.)*"),$/gm)].map((m) => [m[1]!, JSON.parse(m[2]!) as string]));
})();

afterEach(() => setLocalePref("en"));
// The rarer codes' wording loads on use (readErrorBody does this before an ApiError is built).
beforeAll(() => ensureSentenceWording(JSON.stringify({ error: "owner_only" })));

describe("server error messages", () => {
  it("every error code the backend sends has a message (D115)", () => {
    // The codes are the literals in `error: "<code>"` response bodies and the
    // snake_case arguments of the backend's error classes (new XxxError(…) /
    // new XxxRefusal(…)), which apiOnError (httpError.ts) answers as `error`.
    const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/src");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "test" || name === "vendor" ? [] : files(path);
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
    });
    const sent = new Map<string, string>();
    for (const file of files(backend)) {
      const text = readFileSync(file, "utf8");
      const where = relative(backend, file);
      for (const m of text.matchAll(/\berror:\s*"([a-z][a-z0-9_]*)"/g)) sent.set(m[1]!, where);
      for (const m of text.matchAll(/new [A-Z]\w*(?:Error|Refusal)\(([^;]{0,400})/g)) {
        for (const c of m[1]!.matchAll(/"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g)) sent.set(c[1]!, where);
      }
    }
    expect(sent.size).toBeGreaterThan(50); // the scan still finds the codes
    const missing = [...sent].filter(([code]) => !SERVER_ERROR_MESSAGES[code] && !LATE_SERVER_ERROR_MESSAGES[code]).map(([code, where]) => `${code} (${where})`);
    expect(missing).toEqual([]);
  });

  it("the late table is found, and lateCodeMessage words each of its codes", () => {
    expect(Object.keys(LATE_SERVER_ERROR_MESSAGES).length).toBeGreaterThan(150);
    for (const [code, text] of Object.entries(LATE_SERVER_ERROR_MESSAGES)) expect(lateCodeMessage(code)).toBe(text);
  });

  it("a code is worded in one table only", () => {
    expect(Object.keys(LATE_SERVER_ERROR_MESSAGES).filter((code) => code in SERVER_ERROR_MESSAGES)).toEqual([]);
  });

  it("a read and a write show the same words for a code (D115)", () => {
    const bodies = [
      [401, { error: "account_changed" }], [403, { error: "owner_only" }],
      [409, { error: "tag_name_conflict" }], [409, { error: "system_space" }],
      [409, { error: "parent_in_other_space" }], [409, { error: "live_descendant" }],
    ] as const;
    for (const locale of ["en", "zh-TW"] as const) {
      setLocalePref(locale);
      for (const [status, body] of bodies) {
        const error = new ApiError(status, JSON.stringify(body));
        expect(error.message).toBe(serverErrorMessage(body.error, undefined));
        expect(writeFailureMessage(error)).toBe(error.message);
      }
    }
    setLocalePref("zh-TW");
    expect(new ApiError(409, JSON.stringify({ error: "system_space", detail: "the system space has no members to manage" })).message)
      .toBe("系統空間沒有成員可以管理。");
    // A changed account recovers by signing back in (its queued writes replay
    // only as that account); a reload switches the page to the new one.
    expect(writeFailureMessage(new ApiError(401, JSON.stringify({ error: "account_changed" })))).toContain("請登回原本的帳號");
    // A plain expired session and a spine 403 sentence keep the generic words.
    expect(writeFailureMessage(new ApiError(401, JSON.stringify({ error: "unauthorized" })))).toBe("請重新登入，再重試同步或儲存。");
    expect(writeFailureMessage(new ApiError(403, JSON.stringify({ error: "space role denied 'update' on node n1" })))).toBe("你沒有權限這樣做。");
  });

  it("a spine 403 reads as no permission through every reader, not the generic server error", () => {
    setLocalePref("zh-TW");
    const denied = new ApiError(403, JSON.stringify({ error: "space role denied 'merge' on node n1" }));
    expect(denied.message).toBe("你沒有權限這樣做。");
    expect(requestFailureMessage(denied, "合併失敗")).toBe("你沒有權限這樣做。");
    expect(requestFailureMessage(new ApiError(403, "<html>proxy</html>"), "合併失敗")).toBe("你沒有權限這樣做。");
    // Allowed side: a 500 still says the server went wrong.
    expect(requestFailureMessage(new ApiError(500, JSON.stringify({ error: "boom" })), "合併失敗")).toBe("伺服器發生錯誤。");
  });

  it("every known code has zh-TW wording", () => {
    const missing = [...Object.values(SERVER_ERROR_MESSAGES), ...Object.values(LATE_SERVER_ERROR_MESSAGES)].filter((text) => !(text in zh));
    expect(missing).toEqual([]);
  });

  it("reads a reworded server sentence in the user's language through its code", () => {
    setLocalePref("zh-TW");
    expect(serverErrorMessage("owner_only", "a brand-new English sentence the dictionary never saw")).toBe("只有工作區擁有者可以這樣做。");
    expect(new ApiError(403, JSON.stringify({ error: "module_not_imported", module: "rss" })).message).toBe("這個工作區關閉了這項功能。");
  });

  it("prefers a detail the locale knows, and treats any '<thing> not found' as not found", () => {
    setLocalePref("zh-TW");
    expect(serverErrorMessage("node not found", undefined)).toBe("找不到這篇筆記");
    expect(serverErrorMessage("widget not found", undefined)).toBe("它已經不存在，或你沒有權限看到。");
    expect(serverErrorMessage("forbidden", "editor role or higher is required")).toBe("需要編輯者以上的權限");
  });

  it("a reserved-tag refusal reads in zh-TW through its code (T1)", () => {
    setLocalePref("zh-TW");
    const body = JSON.stringify({ error: "reserved_tag", detail: "#task is a system tag and cannot be deleted" });
    expect(new ApiError(409, body).message).toBe("系統標籤：可以改名，但不能合併或刪除。");
  });

  it("each focus refusal shows its own sentence in both languages", () => {
    const words = {
      focus_running: ["A focus session is already running. End it first.", "已經有一段專注在進行，請先結束它。"],
      focus_too_long: ["A focus session can't be longer than 24 hours.", "一段專注不能超過 24 小時。"],
      focus_in_future: ["A focus session can't be in the future.", "專注的時間不能在未來。"],
      focus_ends_before_it_starts: ["A focus session can't end before it starts.", "專注的結束時間不能早於開始時間。"],
    } as const;
    for (const [locale, i] of [["en", 0], ["zh-TW", 1]] as const) {
      setLocalePref(locale);
      for (const [code, text] of Object.entries(words)) {
        expect(new ApiError(code === "focus_running" ? 409 : 400, JSON.stringify({ error: code })).message).toBe(text[i]);
      }
    }
  });

  it("never shows a raw body, an unmapped code or a proxy page", () => {
    setLocalePref("zh-TW");
    const generic = "伺服器發生錯誤。";
    expect(new ApiError(500, JSON.stringify({ message: "upstream timeout" })).message).toBe(generic);
    expect(new ApiError(502, "<html>Bad Gateway</html>").message).toBe(generic);
    expect(new ApiError(400, JSON.stringify({ error: "some_new_internal_code" })).message).toBe(generic);
  });

  it("English keeps the server's own detail", () => {
    expect(serverErrorMessage("owner_only", "permission administration is reserved to the workspace owner"))
      .toBe("permission administration is reserved to the workspace owner");
  });

  it("M8: every refusal code of an undo has its own words, not the generic server error", () => {
    const codes = ["patch_conflict", "state_conflict", "already_in_state", "target_gone", "irreversible", "external", "unsupported", "history_incomplete", "imported_history", "reserved_tag"];
    const generic = serverErrorMessage("internal", undefined);
    for (const locale of ["en", "zh-TW"] as const) {
      setLocalePref(locale);
      for (const code of codes) expect(serverErrorMessage(code, undefined), `${locale} ${code}`).not.toBe(generic);
    }
  });
});
