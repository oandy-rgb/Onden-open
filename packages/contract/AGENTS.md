# 契約套件（packages/contract，`@onden/contract`）

規則見[根目錄 AGENTS.md](../../AGENTS.md)與 [README](README.md)。

| 要做的事 | 一律用 | 守門 |
| --- | --- | --- |
| 筆記欄位新增、移除、改型別 | 只改 `src/node.ts`，再讓 `nodeContract.integration.test.ts` 通過 | `packages/backend/src/test/nodeContract.integration.test.ts` |
| 前端使用節點型別 | `import type { ServerNode } from "@onden/contract"`；不得 import 值（zod 不進開機包） | `scripts/check-boot-bundle.mjs` |
| 驗證建立／修改筆記的請求 | `DraftNode` | `packages/backend/src/test/utils.test.ts` |
| API 回應的形狀（前後端都用） | 只在 `src/<主題>.ts` 寫一份純型別，兩邊 `import type`；後端不 re-export。欄位有出入就放上線的形狀，前端另外衍生（例：`BackupManifestAsRead`、`SyncDelta`、`Tag`）。核對過是兩個不同模型的同名型別，才寫進 `typesAllow`（名稱、兩個檔案、理由） | `scripts/dup-names-baseline.json` 的 `types`（要 0）與 `typesAllow`（只准減，`dup:names`） |
