// 讓一行變成任務的字與判斷，純函式、不讀資料庫：存檔（blockNodes、modules/tasks/seam）與測試用同一份。
// 編輯器不重做這些規則；它拿 services/lineWords 送出的答案（contract：LineWords）。

/** `{#task}` 與 `{ task }` 寫的是同一個字：去掉 `#` 與空白，比較時再轉小寫。 */
export const writtenTagName = (name: string): string => name.replace(/^#/, "").trim();

/** 任務標籤現在的名字，加上保留字 `word`（工作區有別的同名普通標籤時除外：`{task}` 就是那個標籤）。
 *  工作區沒有任務標籤、而普通標籤佔了 `word` 時，寫成 `wordWhenTaken`。 */
export function taskLineWords(found: { names: readonly string[]; otherTagNamed: boolean }, word: string, wordWhenTaken: string): string[] {
  const words = new Set(found.names);
  if (!found.otherTagNamed) words.add(word);
  else if (words.size === 0) words.add(wordWhenTaken);
  return [...words];
}

/** 這一段是不是任務行：有核取方塊、模組開著、且帶著其中一個字。 */
export function lineIsTask(line: { checkbox: boolean; tags: readonly string[] }, words: readonly string[], on: boolean): boolean {
  return on && line.checkbox && line.tags.some((tag) => words.includes(writtenTagName(tag).toLowerCase()));
}
