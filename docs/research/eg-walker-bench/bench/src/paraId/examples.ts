// 手寫的小例子（看得懂的）：npx tsx src/paraId/examples.ts
import { threeWayMergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { paraMergeBody } from "./paraMerge.js";
import { show } from "./evaluate.js";

export const EXAMPLES: Array<{ id: string; title: string; base: string; incoming: string; current: string }> = [
  { id: "X1", title: "一邊把段落搬到最後，另一邊改它",
    base: "第一段：本週目標。\n\n第二段：同步功能要在週五前做完，測試都通過。\n\n第三段：下週開始寫研究報告。\n",
    incoming: "第一段：本週目標。\n\n第三段：下週開始寫研究報告。\n\n第二段：同步功能要在週五前做完，測試都通過。\n",
    current: "第一段：本週目標。\n\n第二段：同步功能要在週四前做完，測試都通過。\n\n第三段：下週開始寫研究報告。\n" },
  { id: "X2", title: "清單裡把一項移到最上面，另一邊改這一項",
    base: "- 買牛奶\n- 繳電費\n- 寄包裹到郵局\n- 整理房間\n",
    incoming: "- 寄包裹到郵局\n- 買牛奶\n- 繳電費\n- 整理房間\n",
    current: "- 買牛奶\n- 繳電費\n- 寄包裹到郵局（要帶身分證）\n- 整理房間\n" },
  { id: "X3", title: "一邊把段落往上搬，另一邊在原位置下面加一段",
    base: "甲：開會紀錄。\n\n乙：待辦事項清單。\n\n丙：下次會議時間。\n\n丁：其他備註事項。\n",
    incoming: "甲：開會紀錄。\n\n丁：其他備註事項。\n\n乙：待辦事項清單。\n\n丙：下次會議時間。\n",
    current: "甲：開會紀錄。\n\n乙：待辦事項清單。\n\n丙：下次會議時間。\n\n新增：會後要寄出紀錄。\n\n丁：其他備註事項。\n" },
  { id: "X7", title: "把一段搬到最前面，另一邊刪掉這段裡的一個詞",
    base: "標題：週報。\n\n進度：同步功能已完成約八成，剩下離線佇列。\n\n風險：人手不足，可能延期。\n",
    incoming: "進度：同步功能已完成約八成，剩下離線佇列。\n\n標題：週報。\n\n風險：人手不足，可能延期。\n",
    current: "標題：週報。\n\n進度：同步功能已完成，剩下離線佇列。\n\n風險：人手不足，可能延期。\n" },
  { id: "X8", title: "一邊把某段搬到下面，另一邊在它旁邊新增一段",
    base: "一、背景說明文字寫在這裡。\n\n二、需求說明文字寫在這裡。\n\n三、時程說明文字寫在這裡。\n",
    incoming: "二、需求說明文字寫在這裡。\n\n一、背景說明文字寫在這裡。\n\n三、時程說明文字寫在這裡。\n",
    current: "一、背景說明文字寫在這裡。\n\n二、需求說明文字寫在這裡。\n\n補充：這裡新增一段說明。\n\n三、時程說明文字寫在這裡。\n" },
  { id: "X4", title: "兩邊把同一段搬到不同的地方（現行合併默默留下兩份）",
    base: "A：第一段內容在這裡。\n\nB：第二段內容在這裡。\n\nC：第三段內容在這裡。\n\nD：第四段內容在這裡。\n",
    incoming: "B：第二段內容在這裡。\n\nA：第一段內容在這裡。\n\nC：第三段內容在這裡。\n\nD：第四段內容在這裡。\n",
    current: "A：第一段內容在這裡。\n\nC：第三段內容在這裡。\n\nD：第四段內容在這裡。\n\nB：第二段內容在這裡。\n" },
  { id: "X5", title: "同一段的不同句子各改各的（認段落解不了）",
    base: "今天完成同步功能的第一版，測試都通過了。接下來處理離線佇列的重試。最後整理文件。\n",
    incoming: "今天完成同步功能的第二版，測試都通過了。接下來處理離線佇列的重試。最後整理文件。\n",
    current: "今天完成同步功能的第一版，測試都通過了。接下來處理離線佇列的重送。最後整理文件。\n" },
  { id: "X6", title: "一邊把一段拆成兩段，另一邊改其中一句（兩者都衝突；若對方改的是純加字，現行會合、原型不會）",
    base: "開會決定下週一上線。大家同意先在內部試用。\n",
    incoming: "開會決定下週一上線。\n\n大家同意先在內部試用。\n",
    current: "開會決定下週二上線。大家同意先在內部試用。\n" },
];

if (process.argv[1]?.endsWith("examples.ts")) for (const e of EXAMPLES) {
  const cur = threeWayMergeBody(e.base, e.incoming, e.current), pro = paraMergeBody(e.base, e.incoming, e.current);
  console.log(`\n${e.id} ${e.title}\n  現行：${cur.clean ? "乾淨 " + show(cur.merged, 400) : "衝突 " + cur.conflicts.length + " 處（留 incoming：" + show(cur.merged, 400) + "）"}\n  原型：${pro.clean ? "乾淨 " + show(pro.merged, 400) : "衝突 " + pro.kinds.join("、") + "（留 incoming：" + show(pro.merged, 400) + "）"}`);
}
