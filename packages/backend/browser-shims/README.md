> 狀態：現行（最後確認 2026-11-01）

# 瀏覽器版的 Node 替身（只在 `npm run build:browser` 用）

後端程式碼一行都沒改成「瀏覽器版」：這裡是**打包時**把 `node:*` 與原生套件換成瀏覽器可用的版本。
清單與理由見 [portable-backend.md](../../../docs/architecture/portable-backend.md) §8。
不屬於 `src/`，所以不進後端的型別檢查、不進正式映像。

第 3 批新增的替身：`vfs.mjs`／`fs.mjs`／`fsPromises.mjs`（記憶體檔案系統，只給還原備份的上傳暫存用；媒體不在這裡，見 `src/browser/mediaStorage.ts`）、`yauzl.mjs`（fflate 讀 zip）、
`streamPromises.mjs`；`stream.cjs` 補了備份上傳用到的 `Readable.fromWeb`、`Transform`、`pipeline`、`PassThrough`。
