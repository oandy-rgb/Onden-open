// 繁體中文（台灣）字典的完整表 = 開機那一半 + 開機後載入的那一半。
// 只有測試與守門檢查匯入這個檔；app 本身分兩半載入（見 lib/i18n.app.ts）。
import { ZH_TW_BOOT } from "./i18n.zh-TW.boot";
import { ZH_TW_LATE } from "./i18n.zh-TW.late";

export const ZH_TW: Record<string, string> = { ...ZH_TW_BOOT, ...ZH_TW_LATE };
