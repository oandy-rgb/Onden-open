#!/usr/bin/env node
// 規則自己的測試：用幾張小的假頁面，每條規則一個「該報」的壞例子（重現業主回報過的那幾類問題）和一個「不該報」的好例子。
// 不需要建置 app：node e2e/layout-audit/selftest.mjs
import { playwright, contextOptions, installHelpers } from "./env.mjs";
import { RULES } from "./rules/index.mjs";

const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));
const STYLE = "<meta name=viewport content='width=device-width,initial-scale=1'><style>body{margin:0;font:14px sans-serif} .row{height:36px}</style>";
const CASES = [
  { rule: "R1", name: "展開箭頭被左側直條蓋住", bad: true, vp: "desktop",
    html: `<ul style="margin:20px;padding:0;list-style:none"><li style="position:relative;height:36px"><span style="position:absolute;left:0;top:0;width:12px;height:36px;background:#a33"></span><button style="position:absolute;left:2px;top:8px;width:16px;height:16px;z-index:0">▸</button><span style="position:absolute;left:0;top:0;width:12px;height:36px;z-index:1;background:#a33"></span></li></ul>` },
  { rule: "R1", name: "箭頭沒有被蓋住", bad: false, vp: "desktop",
    html: `<ul style="margin:20px;padding:0;list-style:none"><li style="position:relative;height:36px"><span style="position:absolute;left:0;top:0;width:3px;height:36px;background:#a33"></span><button style="position:absolute;left:14px;top:8px;width:16px;height:16px">▸</button></li></ul>` },
  { rule: "R2", name: "兩個按鈕重疊", bad: true, vp: "desktop",
    html: `<div style="margin:20px;position:relative;height:40px"><button style="position:absolute;left:0;width:80px;height:32px">甲</button><button style="position:absolute;left:60px;width:80px;height:32px">乙</button></div>` },
  { rule: "R2", name: "並排的按鈕不重疊；輸入框裡的清除鈕不算", bad: false, vp: "desktop",
    html: `<div style="margin:20px;display:flex;gap:4px"><button>甲</button><button>乙</button><span style="position:relative"><input style="width:120px"><button style="position:absolute;right:2px;top:2px">x</button></span></div>` },
  { rule: "R3", name: "文字被 overflow:hidden 切掉", bad: true, vp: "desktop",
    html: `<div style="margin:20px;width:80px;height:20px;overflow:hidden;white-space:nowrap">這是一段很長很長的文字會被切掉</div>` },
  { rule: "R3", name: "刻意的 ellipsis 不算", bad: false, vp: "desktop",
    html: `<div style="margin:20px;width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">這是一段很長很長的文字會被省略</div>` },
  { rule: "R4", name: "底部面板的最後一項被 flex 壓縮", bad: true, vp: "desktop",
    html: `<div class="ui-menu--sheet" style="position:fixed;left:0;right:0;bottom:0;height:200px;display:flex;flex-direction:column;overflow:hidden"><div style="min-height:0;overflow:hidden;background:#eee"><div style="height:90px">項目一</div></div><div style="min-height:0;overflow:hidden;background:#ddd"><div style="height:90px">項目二</div></div><div style="min-height:0;overflow:hidden;background:#ccc"><div style="height:90px">簡報</div></div></div>` },
  { rule: "R4", name: "會捲的面板，最後一項捲得到", bad: false, vp: "desktop",
    html: `<div class="ui-menu--sheet" style="position:fixed;left:0;right:0;bottom:0;height:200px;overflow:auto"><div style="height:120px;flex:none">項目一</div><div style="height:120px;flex:none">項目二</div><div style="height:60px;flex:none">簡報</div></div>` },
  { rule: "R4", name: "捲到底後最後一項還在底部導覽列下面（手機）", bad: true, vp: "mobile",
    html: `<div style="position:fixed;inset:0;overflow:auto"><div style="height:900px">很長的內容</div><button style="display:block;height:30px">最後一項：簡報</button></div><nav style="position:fixed;left:0;right:0;bottom:0;height:60px;background:#ddd">導覽列</nav>` },
  { rule: "R4", name: "捲動區底部留了導覽列高度的空間", bad: false, vp: "mobile",
    html: `<div style="position:fixed;inset:0;overflow:auto;padding-bottom:70px;box-sizing:border-box"><div style="height:900px">很長的內容</div><button style="display:block;height:30px">最後一項：簡報</button></div><nav style="position:fixed;left:0;right:0;bottom:0;height:60px;background:#ddd">導覽列</nav>` },
  { rule: "R5", name: "hover 時標題下那一行換行、把內容往下推", bad: true, vp: "desktop",
    html: `<style>.meta{width:220px;white-space:normal} .meta button{white-space:nowrap}.meta:hover button.t{white-space:normal;width:20px;display:inline-block}</style><div style="margin:20px"><h2>標題</h2><div class="meta"><button class="t">標籤按鈕</button> <span>修改</span></div><p>內文往下推</p></div>` },
  { rule: "R5", name: "hover 只變色、版面不動", bad: false, vp: "desktop",
    html: `<style>button:hover{background:#fcc}</style><div style="margin:20px"><h2>標題</h2><button>按鈕</button><p>內文</p></div>` },
  { rule: "R11", name: "並排窗格裡的字超出窗格右緣（被切掉）", bad: true, vp: "desktop",
    html: `<div class="split-root--on"><div class="split-left" style="width:200px;overflow:hidden"><div class="note-document" style="width:360px">當時美國長途電話網的交換機之間，線路閑置時，兩端會持續送出</div></div></div>` },
  { rule: "R11", name: "並排窗格裡的字折行在窗格內", bad: false, vp: "desktop",
    html: `<div class="split-root--on"><div class="split-left" style="width:200px;overflow:hidden"><div class="note-document" style="width:200px">當時美國長途電話網的交換機之間，線路閑置時，兩端會持續送出</div></div></div>` },
  { rule: "R6", name: "寬度超過視窗，出現橫向捲軸", bad: true, vp: "mobile",
    html: `<div style="width:900px;height:20px;background:#eee">太寬</div>` },
  { rule: "R6", name: "沒有橫向捲軸", bad: false, vp: "mobile", html: `<div style="height:20px;background:#eee">剛好</div>` },
  { rule: "R7", name: "手機上 24×24 的按鈕", bad: true, vp: "mobile",
    html: `<div style="margin:30px"><button style="width:24px;height:24px;padding:0">x</button></div>` },
  { rule: "R7", name: "用 ::after 擴大到 44×44 的按鈕不算小", bad: false, vp: "mobile",
    html: `<style>.b{position:relative;width:24px;height:24px;padding:0}.b::after{content:"";position:absolute;inset:-14px}</style><div style="margin:30px"><button class="b">x</button></div>` },
  { rule: "R7", name: "捲動清單底端被切掉半列：捲過去就點得到，不算小", bad: false, vp: "mobile",
    html: `<ul role="listbox" style="margin:0;padding:0;list-style:none;height:70px;overflow-y:auto"><li role="option" style="height:44px"><button style="width:100%;height:44px">甲</button></li><li role="option" style="height:44px"><button style="width:100%;height:44px">乙</button></li></ul>` },
  { rule: "R7", name: "包在可捲動的 div 裡、底端被切掉的一列：捲過去就點得到，不算小", bad: false, vp: "mobile",
    html: `<div style="height:70px;overflow-y:auto"><ul style="margin:0;padding:0;list-style:none"><li><button style="width:100%;height:48px">甲</button></li><li><button style="width:100%;height:48px">乙</button></li></ul></div>` },
  { rule: "R7", name: "頁面捲到固定底列下面的一列：捲上來就點得到，不算小", bad: false, vp: "mobile",
    html: `<div style="height:2000px;position:relative"><button style="position:absolute;left:0;right:0;top:calc(100vh - 60px);height:44px">甲</button></div><nav style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#ccc"></nav>` },
  { rule: "R7", name: "下半截被固定的提示蓋住的 44px 列：不是太小（被蓋住歸 R1／R4）", bad: false, vp: "mobile",
    html: `<button style="position:absolute;left:0;right:0;top:100px;height:44px">甲</button><div style="position:fixed;left:0;right:0;top:130px;height:40px;background:#333"></div>` },
  { rule: "R7", name: "整個看得到、但只有 30px 高的列仍然算小", bad: true, vp: "mobile",
    html: `<div style="height:200px;overflow-y:auto"><button style="width:100%;height:30px">甲</button></div>` },
  { rule: "R8", name: "樹狀清單同層標題縮排不齊", bad: true, vp: "desktop",
    html: `<ul role="tree" style="margin:20px;padding:0;list-style:none"><li role="treeitem" aria-level="1" style="padding-left:10px">甲</li><li role="treeitem" aria-level="1" style="padding-left:10px">乙</li><li role="treeitem" aria-level="1" style="padding-left:14px">丙</li><li role="treeitem" aria-level="1" style="padding-left:10px">丁</li></ul>` },
  { rule: "R8", name: "同層對齊", bad: false, vp: "desktop",
    html: `<ul role="tree" style="margin:20px;padding:0;list-style:none"><li role="treeitem" aria-level="1" style="padding-left:10px">甲</li><li role="treeitem" aria-level="1" style="padding-left:10px">乙</li><li role="treeitem" aria-level="1" style="padding-left:10px">丙</li></ul>` },
  { rule: "R9", name: "手機點過之後 :hover 色留在列上", bad: true, vp: "mobile",
    html: `<style>li button{display:block;width:100%;height:44px;background:#fff;border:0;text-align:left}li button:hover{background:#333;color:#fff}</style><ul style="margin:0;padding:0;list-style:none"><li><button>甲</button></li><li><button>乙</button></li></ul>` },
  { rule: "R9", name: "只在有 hover 裝置才換色（@media (hover:hover)）", bad: false, vp: "mobile",
    html: `<style>li button{display:block;width:100%;height:44px;background:#fff;border:0;text-align:left}@media (hover:hover){li button:hover{background:#333;color:#fff}}</style><ul style="margin:0;padding:0;list-style:none"><li><button>甲</button></li><li><button>乙</button></li></ul>` },
  { rule: "R10", name: "清單直接畫在標題上（沒有浮層）", bad: true, vp: "desktop",
    html: `<div class="note-document" style="margin:20px;width:400px"><div style="height:34px"><ul role="listbox" style="margin:0;padding:4px;height:200px;list-style:none"><li>清單一</li><li>清單二</li></ul></div><textarea class="obsidian-title-input" style="width:380px;height:60px;display:block">筆記標題</textarea></div>` },
  { rule: "R10", name: "清單是不透明的浮層、蓋在標題上", bad: false, vp: "desktop",
    html: `<div class="note-document" style="margin:20px;width:400px"><div style="height:34px"></div><textarea class="obsidian-title-input" style="width:380px;height:60px;display:block">筆記標題</textarea></div><div class="ui-popover" style="position:fixed;left:30px;top:40px;width:200px;height:120px;background:#fff;z-index:50"><ul role="listbox" style="margin:0;padding:4px;list-style:none"><li>清單一</li><li>清單二</li></ul></div>` },
  { rule: "R10", name: "浮層透明：底下的字穿過來", bad: true, vp: "desktop",
    html: `<div class="note-document" style="margin:20px;width:400px"><div style="height:34px"></div><textarea class="obsidian-title-input" style="width:380px;height:60px;display:block">筆記標題</textarea></div><div class="ui-popover" style="position:fixed;left:30px;top:40px;width:200px;height:120px;background:transparent;z-index:50"><ul role="listbox" style="margin:0;padding:4px;list-style:none"><li>清單一</li><li>清單二</li></ul></div>` },
];

const browser = await playwright.chromium.launch();
let failed = 0;
for (const c of CASES) {
  const vp = c.vp === "mobile" ? { id: "pixel5", mobile: true, device: "Pixel 5" } : { id: "1280", width: 1280, height: 800 };
  const context = await browser.newContext(contextOptions(vp));
  const page = await context.newPage();
  await page.setContent(STYLE + c.html);
  await installHelpers(page);
  const hits = await byId[c.rule].run(page, { vp });
  const ok = c.bad ? hits.length > 0 : hits.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.rule} ${c.name}（${c.bad ? "應該報" : "不該報"}，報了 ${hits.length} 筆${hits[0] ? `：${JSON.stringify(hits[0].detail).slice(0, 120)}` : ""}）`);
  await context.close();
}
await browser.close();
console.log(`\n${CASES.length - failed}/${CASES.length} 通過`);
process.exit(failed ? 1 : 0);
