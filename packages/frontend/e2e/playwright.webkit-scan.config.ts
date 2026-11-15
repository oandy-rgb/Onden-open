// 暫時檔（不提交）：WebKit／iPhone／iPad 掃描。用 @critical 與跨引擎的 spec 檔，看 Safari 核心會壞哪些。
import base from "./playwright.config";
import { devices } from "@playwright/test";
const FILES = /(approvalGate|authGate|crossbrowser|dailyDriver|editorLinkFollow|firstRunBuildSite|inboxGovernance|inkTouch|kanban-dnd|mobileBackScroll|mobileBottomGutter|mobileCanvasLens|mobileDeleteButton|mobileListScroll|mobileNotesScroll|mobileTabsFlush|notesTagsTab|note-templates|offline-capture-sync|offlineHandwriting|offlineTaskTag|publishing|smoke|syncStatus|table-inline-edit)\.spec\.ts$/;
export default {
  ...base,
  projects: [
    { name: "webkit", testMatch: FILES, use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-safari", testMatch: FILES, use: { ...devices["iPhone 13"] } },
    { name: "ipad", testMatch: FILES, use: { ...devices["iPad Pro 11"] } },
  ],
};
