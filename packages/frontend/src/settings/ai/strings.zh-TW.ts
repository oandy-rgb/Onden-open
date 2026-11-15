// 設定 › AI 的繁中字串。整頁不出現任何廠商或模型品牌名稱（test/guards/aiSettingsPage.guard.test.ts 檢查這個檔與這一頁的原始碼）。
// 白話：連線 = 一個 AI 用來運作的東西：一把 API 金鑰，或一組連線碼；AI = 用某條連線的那個角色。
// 金鑰只指 API 金鑰；那組只顯示一次的祕密一律叫「連線碼」（別家軟體可能叫它金鑰或權杖，只在說明那一步時提到）。

export const AI_SETTINGS_ZH_TW: Record<string, string> = {
  // 頁面與區塊
  "Only the owner can set up AI.": "只有擁有者可以設定 AI。",
  "Connect to manage AI.": "連上網路後才能管理 AI。",
  "Could not load the AI settings.": "讀不到 AI 設定。",
  "Connections": "連線",
  "Your AIs": "你的 AI",
  "No connection yet.": "還沒有連線。",
  "No AI yet.": "還沒有 AI。",
  "New connection": "新增連線",
  "New AI": "新增 AI",
  "Set up AI": "設定 AI",
  "An AI can read the notes you let it, and suggest changes that wait for your yes. Choose how it connects. You can add more later.": "AI 只讀你讓它讀的筆記，提出的修改要等你同意才會生效。先選它怎麼連進來，之後可以再加。",
  "Kind of connection": "連線的種類",
  "With an API key": "用 API 金鑰",
  "Write the address and the key, test it, and save.": "填位址和金鑰，測試通過就能儲存。",
  "Let your own AI connect in": "讓你自己的 AI 連進來",
  "You get a connection code and the steps to put it into your own AI app.": "你會拿到一組連線碼，和放進你自己 AI 軟體的步驟。",
  "You get a connection code to put into your own AI app.": "你會拿到一組連線碼，放進你自己的 AI 軟體。",
  "Onden asks your AI service itself. The AI can only suggest changes; you accept each one.": "由 Onden 自己去問你的 AI 服務。AI 只能提建議，每一筆都要你接受。",

  // 卡片
  "No AI is using it yet.": "還沒有 AI 在用。",
  "Used by {names}": "給 {names} 用",
  "Test": "測試",
  "Testing…": "測試中…",
  "It works. 1 model is available.": "可以用，有 1 個模型。",
  "It works. {n} models are available.": "可以用，有 {n} 個模型。",
  "The test did not work. Check the address and the key.": "測試沒有通過。請檢查位址和金鑰。",
  "Delete the key “{name}”": "刪除金鑰「{name}」",
  "Delete the key “{name}”? AIs that run on it stop until you give them another connection.": "刪除金鑰「{name}」？用它的 AI 會停用，直到你給它們別的連線。",
  "Runs on the key “{name}” (ends in {last4})": "用「{name}」這把金鑰（末四碼 {last4}）",
  "Connects with a connection code. Last connected {when}.": "用連線碼連進來，上次連線 {when}。",
  "Connects with a connection code. Nothing has connected yet.": "用連線碼連進來，還沒有連線過。",
  "Model: {model}": "模型：{model}",
  "Change connection": "換連線",
  "The key it used was deleted.": "它用的金鑰已刪除。",
  "It has no connection yet.": "它還沒有連線。",
  "Give it “Can edit” in a space that lets AI read, so it can suggest changes there.": "在一個讓 AI 讀的空間給它「可編輯」，它才能在那裡提建議。",
  "Stopped": "停用中",
  "Not ready yet": "還不能用",

  // 連線碼的步驟（「怎麼接」與剛建好的那一屏共用）
  "How to connect": "怎麼接",
  "Connection code of {name}": "{name} 的連線碼",
  "Shown only this once. Copy it now.": "只會顯示這一次，請現在複製。",
  "Copy the connection code.": "複製連線碼。",
  "Copy connection code": "複製連線碼",
  "Use the connection code you copied when it was made. Lost it? Choose “Revoke code”, then “Change connection”, to make another.": "用建立時複製下來的連線碼。弄丟了？先按「作廢連線碼」，再按「換連線」重做一組。",
  "In your AI software, add a new MCP server with this address:": "在你的 AI 軟體裡新增一個 MCP 伺服器，位址填這個：",
  "Copy address": "複製位址",
  "When it asks for a key or token, paste the connection code.": "它要金鑰或權杖時，貼上連線碼。",
  "Using Onden's tools from your AI software works right away. Questions you ask inside Onden (in a note's AI tab, or with @) are answered only when a program on one of your computers keeps fetching them; a connection with just the address and code never does that by itself, so those questions wait and then fail. The self-hosting guide “Let an AI pick up work on its own machine” shows how.": "在你的 AI 軟體裡使用 Onden 的工具，馬上就能用。但在 Onden 裡發問（筆記的 AI 分頁，或用 @ 叫它），要有一支在你某台電腦上持續來領問題的程式才會有人回答；只填位址和連線碼的連線不會自己去領，問題會先排著、最後失敗。架設方法見自架指南「讓 AI 在一台機器上自動領工作」。",
  "You haven't copied the connection code yet, and it can't be shown again. If you lose it, revoke it on the AI's card and make another. Leave anyway?": "你還沒複製連線碼，而且它不會再顯示。弄丟了就在這個 AI 的卡片上作廢它，再做一組新的。要直接離開嗎？",
  "Leave without copying": "不複製就離開",
  "Revoke code": "作廢連線碼",
  "Revoke the connection code “{name}”": "作廢連線碼「{name}」",
  "Revoke the connection code “{name}”? The AI stays, but whatever uses this code loses access until you make another.": "要作廢連線碼「{name}」嗎？AI 還在，但用這組連線碼的程式會立刻失去存取，直到你做一組新的。",
  "Code without a name": "沒有名稱的連線碼",
  "Remove {name}? Its connection codes stop working and it leaves every space.": "移除 {name}？它的連線碼會失效，也會離開所有空間。",

  // 卡片上的狀態（膠囊內不加句號）
  "Ready": "可以用",
  "Paused": "已暫停",
  "Connected": "已連線",
  "Waiting for it to connect": "等它連進來",
  "Not connected now": "目前沒連線",

  // 新增連線
  "Name for this key (optional)": "這把金鑰的名稱（可留空）",
  "Taken from the address when left blank": "留空就用位址當名稱",
  "Hide price fields": "收起價格欄位",
  "Add prices (optional)": "填價格（選填）",
  "Name for this connection code (optional)": "這組連線碼的名稱（可留空）",
  "Who uses it?": "給誰用？",
  "An AI you already have": "現有的某個 AI",
  "A new AI": "新增一個 AI",
  "Nobody yet. Only keep the key.": "先不給誰用，只存起來。",
  "An AI called “AI” is made for it. In notes you call it with @ai.": "會自動建立一個叫「AI」的 AI 給它用，在筆記裡用 @ai 呼叫它。",
  "It will be used by {name}.": "會給 {name} 用。",
  "You have no AI yet. Make a new one.": "你還沒有 AI，請新增一個。",
  "Which AI": "哪個 AI",
  "What should this AI be called?": "這個 AI 要叫什麼？",
  "The key will be saved as “{name}”.": "這把金鑰會存成「{name}」。",
  "The connection was saved.": "連線已儲存。",
  "The connection code was made.": "連線碼已產生。",
  "The key was saved, but {name} could not be switched to it. Try again, or choose it from “Change connection”.": "金鑰已儲存，但 {name} 沒能換成它。請再試一次，或從「換連線」選它。",

  // 新增 AI
  "{name} was added.": "已新增 {name}。",
  "What does it run on?": "它用什麼連線？",
  "A saved API key": "已存的 API 金鑰",
  "You have no saved key yet. Use “New connection” to add one.": "還沒有存好的金鑰。請先按「新增連線」。",
  "Your own AI, with a connection code": "你自己的 AI，用連線碼",
  "Add AI": "新增 AI",

  // 換連線
  "Change connection of {name}": "換 {name} 的連線",
  "Run {name} on…": "讓 {name} 改用…",
  "Another saved API key": "另一把已存的金鑰",
  "＋ New connection": "＋ 新增連線",
  "{name} now runs on the new connection.": "{name} 已改用新的連線。",

  // 編輯 AI
  "Name of {name}": "{name} 的名稱",
  "Save name": "儲存名稱",
  "Connection of {name}": "{name} 的連線",
  "There are no shared spaces yet.": "還沒有共用空間。",
  "Remove this AI": "刪除這個 AI",

  // 空間權限（「設定 › AI」與「空間與成員」共用）
  "This space doesn't let AI read.": "這個空間不讓 AI 讀。",
  "This space doesn't let AI read, so “{standing}” has no effect now. Letting AI read here brings it back.": "這個空間不讓 AI 讀，所以「{standing}」現在沒有作用。打開讓 AI 讀就會恢復。",
  "The connection code was already made, but its reply was lost, so it can't be shown again. Revoke it and make a new one.": "連線碼已經產生了，但回應遺失，沒辦法再顯示一次。請作廢它後再做一組新的。",
  "The key was saved, but it could not be found again. Close this and look in the list.": "金鑰已儲存，但找不到它。請關閉後到清單裡看。",
  "Let AI read here": "打開讓 AI 讀",
  "Let AI read the notes in “{space}”? Every AI that stands in this space will be able to read them.": "要讓 AI 讀「{space}」裡的筆記嗎？所有在這個空間裡的 AI 都會讀得到。",

  // 舊入口的提示（空間與成員）
};
