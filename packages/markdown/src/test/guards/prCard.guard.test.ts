// Guard: 驗收卡的讀法與缺漏判斷（scripts/prCardLib.mjs；public-push.sh 推公開庫前用它擋缺卡的 PR）。
import { describe, expect, it } from "vitest";
import { cardProblems, cardRequired, readCard } from "../../../../../scripts/prCardLib.mjs";

const full = [
  "## 驗收卡",
  "**改了什麼**：空行按清單鍵後打字，字落在符號後面。",
  "**怎麼試**：1. 空行按項目清單 2. 打一個字",
  "**證據**：新測試修前失敗、修後通過（輸出附在下面）",
  "**測了什麼**：editorFormat 測試 9/9",
  "**沒測到什麼**：無",
  "",
  "## 做了什麼",
  "**改了什麼**：這一段不算卡",
].join("\n");

describe("the PR card", () => {
  it("reads each field up to the next field or heading, not past the card", () => {
    const card = readCard(full)!;
    expect(card["改了什麼"]).toBe("空行按清單鍵後打字，字落在符號後面。");
    expect(card["沒測到什麼"]).toBe("無");
  });

  it("names what is missing: no card, an empty field, a template comment left as the only content", () => {
    expect(cardProblems("## 做了什麼\n…")).toEqual(["PR 說明沒有「## 驗收卡」"]);
    expect(cardProblems(full.replace("**測了什麼**：editorFormat 測試 9/9", "**測了什麼**：<!-- 一行 -->"))).toEqual(["驗收卡的「測了什麼」是空的"]);
    expect(cardProblems(full)).toEqual([]);
  });

  it("asks for a word about the real device when touch, keyboard or ink code changed", () => {
    const touched = ["packages/frontend/src/lib/editorKeyboard.ts"];
    expect(cardProblems(full, touched)).toHaveLength(1);
    expect(cardProblems(full.replace("**沒測到什麼**：無", "**沒測到什麼**：沒有實機（平板）"), touched)).toEqual([]);
    expect(cardProblems(full, ["packages/frontend/src/components/OverviewEditor.tsx"])).toEqual([]);
  });

  it("is required only for PRs opened from 2026-11-21 on", () => {
    expect(cardRequired("2026-11-20T23:59:00Z")).toBe(false);
    expect(cardRequired("2026-11-21T00:00:00Z")).toBe(true);
    expect(cardRequired(undefined)).toBe(false);
  });
});
