import { describe, it, expect } from "vitest";
import { summarizeChange } from "@onden/markdown";
import {
  absorbSameText,
  actorKindOf,
  describeChange,
  describeVersions,
  type VersionRow,
} from "../services/history/noteVersions.js";

describe("summarizeChange", () => {
  it("沒有改動 → 全 0；只差空白或換行風格也算沒改", () => {
    expect(summarizeChange("# A\n\n內容  一\n", "# A\r\n\r\n內容 一")).toEqual({ added: 0, changed: 0, removed: 0, sections: [] });
  });

  it("新增 1 段、改了 1 段，並回報所在標題", () => {
    const older = "# 待辦\n\n- 買牛奶\n\n# 想法\n\n今天天氣很好，適合出門散步。";
    const newer = "# 待辦\n\n- 買牛奶\n- 繳電費\n\n# 想法\n\n今天天氣很好，適合出門散步和運動。";
    expect(summarizeChange(older, newer)).toEqual({ added: 1, changed: 1, removed: 0, sections: ["待辦", "想法"] });
  });

  it("刪除段落算 removed，section 用它原本所在的標題", () => {
    expect(summarizeChange("# A\n\n- x\n- y\n\n# B\n\nz", "# A\n\n- x\n\n# B\n\nz")).toEqual({
      added: 0, changed: 0, removed: 1, sections: ["A"],
    });
  });

  it("標題改名算改了 1 段，section 是新標題", () => {
    expect(summarizeChange("# Todo\n\n- a", "# Tasks\n\n- a")).toEqual({
      added: 0, changed: 1, removed: 0, sections: ["Tasks"],
    });
    // 字面相近的改名也一樣
    expect(summarizeChange("## 待辦\n\n- a", "## 今天待辦\n\n- a")).toMatchObject({ added: 0, changed: 1, removed: 0 });
  });

  it("有 ^id 的段落用 id 對齊：內容整句改寫仍是「改了」", () => {
    const r = summarizeChange("# H\n\n完全不同的舊句子 ^k1", "# H\n\n這是徹底重寫過的新內容 ^k1");
    expect(r).toMatchObject({ added: 0, changed: 1, removed: 0 });
  });

  it("沒有 id 時用內容相似度對齊；搬位置不算改動", () => {
    const a = "第一段的內容比較長一點點。\n\n第二段的內容也要夠長才行。";
    const b = "第二段的內容也要夠長才行。\n\n第一段的內容比較長一點點。";
    expect(summarizeChange(a, b)).toEqual({ added: 0, changed: 0, removed: 0, sections: [] });
    const c = "第二段的內容也要夠長才行。\n\n第一段的內容比較長一點點，還補了幾個字。";
    expect(summarizeChange(a, c)).toMatchObject({ added: 0, changed: 1, removed: 0 });
  });

  it("同一空隙裡同類段落整句重寫，算改了而不是一刪一增", () => {
    expect(summarizeChange("前\n\naaaaaa\n\n後", "前\n\nzzzzzz\n\n後")).toMatchObject({ added: 0, changed: 1, removed: 0 });
  });

  it("勾選任務算改了 1 段", () => {
    expect(summarizeChange("# T\n\n- [ ] 寫報告", "# T\n\n- [x] 寫報告")).toEqual({ added: 0, changed: 1, removed: 0, sections: ["T"] });
  });

  it("sections 去重、保持順序、最多 3 個", () => {
    const older = "# A\n\na1\n\n# B\n\nb1\n\n# C\n\nc1\n\n# D\n\nd1";
    const newer = "# A\n\na1 改\n\na2\n\n# B\n\nb1 改\n\n# C\n\nc1 改\n\n# D\n\nd1 改";
    expect(summarizeChange(older, newer).sections).toEqual(["A", "B", "C"]);
  });

  it("沒有標題時 sections 為空", () => {
    expect(summarizeChange("a", "a\n\nb")).toEqual({ added: 1, changed: 0, removed: 0, sections: [] });
  });
});

describe("describeChange", () => {
  it("新建（舊內文為空）：新增段落數，sample 是第一段的字", () => {
    expect(describeChange("", "# 計畫\n\n第一步\n")).toEqual({
      added: 2, changed: 0, removed: 0, sections: ["計畫"], sample: "計畫", sample_kind: "added",
    });
  });

  it("改一段：sample 用新內容、kind 是 changed", () => {
    const r = describeChange("# 待辦\n\n買牛奶\n\n遛狗\n", "# 待辦\n\n買燕麥奶\n\n遛狗\n");
    expect(r).toMatchObject({ added: 0, changed: 1, removed: 0, sections: ["待辦"], sample: "買燕麥奶", sample_kind: "changed" });
  });

  it("刪一段：sample 用舊內容、kind 是 removed", () => {
    const r = describeChange("# 待辦\n\n買牛奶\n\n遛狗\n", "# 待辦\n\n買牛奶\n");
    expect(r).toMatchObject({ added: 0, changed: 0, removed: 1, sections: ["待辦"], sample: "遛狗", sample_kind: "removed" });
  });

  it("內文沒變：全 0、沒有 sample", () => {
    expect(describeChange("甲\n", "甲\n")).toEqual({ added: 0, changed: 0, removed: 0, sections: [], sample: null, sample_kind: null });
  });

  it("第一處改動沒有字可顯示時，取下一處", () => {
    const r = describeChange("甲\n", "##\n\n甲\n\n乙\n");
    expect(r).toMatchObject({ sample: "乙", sample_kind: "added" });
  });

  it("摘要與 summarizeChange 用同一套對齊（不含 sample 欄位）", () => {
    const [a, b] = ["# A\n\n一\n\n二 ^x\n", "# A\n\n一改\n\n二 ^x\n\n三\n"];
    const { sample: _s, sample_kind: _k, ...summary } = describeChange(a, b);
    expect(summary).toEqual(summarizeChange(a, b));
    expect(Object.keys(summarizeChange(a, b)).sort()).toEqual(["added", "changed", "removed", "sections"]);
  });
});

describe("actorKindOf", () => {
  it("user / ai_agent / system", () => {
    expect(actorKindOf("user")).toBe("human");
    expect(actorKindOf("ai_agent")).toBe("agent");
    expect(actorKindOf("system")).toBe("system");
  });
});

describe("describeVersions", () => {
  const row = (id: string, at: string, markdown: string, over: Partial<VersionRow> = {}): VersionRow => ({
    id, title: "T", markdown, changed_at: new Date(at), actor_name: "me", actor_type: "user", saves: 1,
    is_restore: false, restored_from: null, ...over,
  });
  // 新 → 舊
  const rows = [
    row("4", "2026-10-24T04:00:00Z", "# A\n\nv1", { is_restore: true, restored_from: "2026-10-24T01:00:00.000Z" }),
    row("3", "2026-10-24T03:00:00Z", "# A\n\nv3 agent", { actor_type: "ai_agent", actor_name: "bot" }),
    row("2", "2026-10-24T02:00:00Z", "# A\n\nv2"),
    row("1", "2026-10-24T01:00:00Z", "# A\n\nv1"),
  ];

  it("最舊一列是建立：added = 段落數；其他列與較舊的一列比較", () => {
    const out = describeVersions(rows, null, []);
    expect(out[3]!.summary).toEqual({ added: 2, changed: 0, removed: 0, sections: [] });
    expect(out[2]!.summary).toEqual({ added: 0, changed: 1, removed: 0, sections: ["A"] });
  });

  it("清單被截斷時，最後一列與再更舊的一版比較", () => {
    const out = describeVersions(rows.slice(2), "# A", []);
    expect(out[1]!.summary).toEqual({ added: 1, changed: 0, removed: 0, sections: ["A"] });
  });

  it("before_agent：下一列（較新）是 AI agent 的那列", () => {
    const out = describeVersions(rows, null, []);
    expect(out.map((v) => v.markers.includes("before_agent"))).toEqual([false, false, true, false]);
  });

  it("restored 與 restored_from（ISO）；非還原為 null", () => {
    const out = describeVersions(rows, null, []);
    expect(out[0]!.markers).toContain("restored");
    expect(out[0]!.restored_from).toBe("2026-10-24T01:00:00.000Z");
    expect(out[1]!.restored_from).toBeNull();
  });

  it("restored 但找不到被還原的那一版 → restored_from 為 null", () => {
    const out = describeVersions([row("9", "2026-10-24T05:00:00Z", "x", { is_restore: true })], null, []);
    expect(out[0]!.markers).toContain("restored");
    expect(out[0]!.restored_from).toBeNull();
  });

  it("published:n 標在快照當時的那一版（不晚於快照的最新一列），且同一版可有多個", () => {
    const out = describeVersions(rows, null, [
      { n: 6, at: new Date("2026-10-24T02:30:00Z") },
      { n: 7, at: new Date("2026-10-24T02:45:00Z") },
      { n: 2, at: new Date("2026-10-23T00:00:00Z") }, // 早於所有版本：不標
    ]);
    expect(out[2]!.markers.filter((m) => m.startsWith("published"))).toEqual(["published:6", "published:7"]);
    expect(out.flatMap((v) => v.markers).filter((m) => m.startsWith("published"))).toHaveLength(2);
  });

  it("actor_kind，保留既有欄位", () => {
    const out = describeVersions(rows, null, []);
    expect(out.map((v) => v.actor_kind)).toEqual(["human", "agent", "human", "human"]);
    expect(out[1]).toMatchObject({ id: "3", title: "T", markdown: "# A\n\nv3 agent", actor_name: "bot", actor_type: "ai_agent", saves: 1 });
    expect(out[0]).not.toHaveProperty("is_restore");
  });
});

describe("absorbSameText", () => {
  const row = (id: string, markdown: string, over: Partial<VersionRow> = {}): VersionRow => ({
    id, title: "T", markdown, changed_at: new Date(`2026-10-24T0${id}:00:00Z`), actor_name: "me", actor_type: "user", saves: 1,
    is_restore: false, restored_from: null, ...over,
  });

  it("只差空白：較舊的併進較新的一列，saves 相加", () => {
    const out = absorbSameText([row("4", "# A\n\nv3"), row("3", "# A\n\nv2  \n"), row("2", "# A\n\nv2"), row("1", "# A")]);
    expect(out.map((r) => [r.id, r.saves])).toEqual([["4", 1], ["3", 2], ["1", 1]]);
  });

  it("標題不同、作者不同、還原列都不併", () => {
    const base = [row("3", "# A\n\nv2  "), row("2", "# A\n\nv2"), row("1", "# A")];
    expect(absorbSameText([{ ...base[0]!, title: "Other" }, base[1]!, base[2]!])).toHaveLength(3);
    expect(absorbSameText([{ ...base[0]!, actor_name: "you" }, base[1]!, base[2]!])).toHaveLength(3);
    expect(absorbSameText([{ ...base[0]!, is_restore: true }, base[1]!, base[2]!])).toHaveLength(3);
    expect(absorbSameText([base[0]!, { ...base[1]!, is_restore: true }, base[2]!])).toHaveLength(3);
  });

  it("清單裡最舊的一列（建立的基準）不被併掉", () => {
    expect(absorbSameText([row("2", "# A  "), row("1", "# A")]).map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("文字真的有變就不併", () => {
    expect(absorbSameText([row("3", "# A\n\nb"), row("2", "# A\n\na"), row("1", "# A")])).toHaveLength(3);
  });
});
