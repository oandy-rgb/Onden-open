// The AI conversation's two frames. NodeInspector loads the info panel's 「AI」 tab (default export) when the tab
// is opened, NotePhoneAiHost loads the phone's bottom panel (`PhoneAiPanel`) when it is first opened — never at
// boot — and with them the conversation's own zh-TW strings (kept out of the boot dictionary).
import { registerDictionary } from "../../lib/i18n";
import { INFO_AI_ZH_TW } from "./strings.zh-TW";

registerDictionary("zh-TW", INFO_AI_ZH_TW);

export { default } from "./InfoAiTab";
export { default as PhoneAiPanel } from "./PhoneAiPanel";
