# Onden

給日常學習與知識整理使用的個人工作區，也是持續練習軟體設計的專案。
以 Markdown 筆記為核心，結合標籤與集合、任務、閱讀、複習、歷史復原和網站發布。

專案仍在開發與功能驗收中。已實作的入口不代表所有裝置、失敗與權限邊界都已完成測試；
目前狀態與證據記在 [全功能盤點清單](docs/research/full-feature-audit.md)。

## 程式與開發入口

- [前端](packages/frontend/README.md)：Astro、React、TypeScript；程式位於 `packages/frontend`。
- [後端](packages/backend/README.md)：Hono、PostgreSQL；程式位於 `packages/backend`。
- [功能地圖](docs/architecture/feature-map.md)：找出功能入口及責任範圍。
- [AGENTS.md](AGENTS.md)：局部重構、資料可靠性、權限與驗證規則。

在 repository 根目錄執行 `npm install` 安裝 workspace 依賴。
環境設定與啟動方式見各套件 README；資料庫整合測試必須使用隔離測試庫，不能指向日常資料。
Docker 部署在重新開機後連不上時，見 [localhost 服務恢復與開機啟動](docs/archive/localhost-service-recovery-2026-09-16.md)。
從對應套件目錄執行 `npm test`、`npx tsc --noEmit` 與 `npm run lint`；前端建置為 `npm run build`。

## 資料與使用限制

筆記可匯出 Markdown。瀏覽器的 SQLite 備份只涵蓋本機快取與待同步內容，並不是完整伺服器備份。
匯入與復原的具體保證、測試範圍及尚未處理的情境，請以功能清單所連結的契約與實測紀錄為準。

## License

Onden 以 GNU Affero General Public License 第 3 版（AGPL-3.0）授權。你可以使用、修改與散布；
把修改過的版本架成服務給別人用時，要讓那些使用者拿得到你那一版的原始碼。

完整條款見 [LICENSE](LICENSE)。隨 Onden 一起散布的第三方元件與它們的授權列在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（`npm run notices` 重新產生）。
