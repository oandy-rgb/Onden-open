# 提案：功能引用第三批還沒做完的部分

> 狀態：提案
> 完成後：docs/architecture/proposals/function-refs-b3-2026-11-12.md
> 2026-11-17 從原提案拆出：原文在 [function-refs-b3-2026-11-12-history.md](function-refs-b3-2026-11-12-history.md)（第 4 節第 1、6 項，第 5 節）。這裡只列程式裡**還查得到沒做**的項目；做不做、順序由擁有者決定。

查證（2026-11-17）：

1. **收件匣改個人引用、`function_refs` 加 `owner_actor_id`**：沒做。`db/migrations` 裡 `function_refs` 沒有 `owner_actor_id` 欄位；收件匣還是靠 `tag_schema.module = 'capture'` 的標籤找筆記（`packages/backend/src/modules/capture/index.ts`、`inboxTag.ts`），migration 196 明寫保留它「until the inbox is a personal reference, part 2」。
2. **技能改成筆記引用**：沒做。`packages/backend/src/modules/skills/index.ts` 的 `library.moduleTag` 仍是 `skill` 標籤，「當成技能」仍是標籤成員（migration 196 同樣保留）。
3. **`actor_module_settings` 以功能 id 為鍵**：沒做。表仍以 `tag_id` 為鍵（`packages/backend/src/modules/review/service.ts` 的 `loadPersonalOverrides`）；複習設定來源仍是 `review` 模組標籤，所以被改過的複習、任務標籤保留模組記號（migration 196 註解）。`workspace_function_settings` 這個表名在 repo 裡找不到，原提案的名稱可能從未建立，要擁有者確認該表是否仍是目標。
4. **成員移除時刪他的個人引用**：沒做（沒有個人引用）。
5. **來源標記要求的固定 id**：引用列 id 改由（引用者、功能、實例）算出，屬 [來源標記設計](causal-stamps-2026-11-12.md) 那條線（migration 201），這裡不查，標 `note-cf`。

要擁有者決定的：1 與 2 是否仍要做（收件匣與技能是否保留標籤做法，或依 [標籤當範圍](tag-as-scope-2026-11-13.md) 的方向改成筆記自己的引用）；3 的表名。
