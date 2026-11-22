import { Button } from "../components/ui";
import { systemLanguageTag } from "../lib/i18n";

// The first screen of a first visit (build with --start-choice): two ways in. It appears before the app's own dictionary
// and theme are loaded, so it carries its own two languages, like the other screens of BrowserAppShell.
const WORDS = {
  "zh-TW": {
    title: "Onden 試用版",
    lead: "筆記只存在你的瀏覽器，不需要帳號。",
    use: "開始使用",
    useNote: "筆記會存在這個瀏覽器，下次回來還在。",
    temp: "在這台電腦上暫時使用",
    tempNote: "借用別人的電腦時用：這裡寫的東西不會留在這台電腦，關掉分頁前要先下載。",
    bring: "從另一台裝置帶過來",
    bringNote: "你在別的裝置上已經有 Onden 筆記：用那裡做的一個檔案，把筆記帶到這台全新的裝置。",
  },
  en: {
    title: "Onden trial",
    lead: "Your notes stay in your browser. No account needed.",
    use: "Start using it",
    useNote: "Your notes are kept in this browser and are here when you come back.",
    temp: "Use it temporarily on this computer",
    tempNote: "For a computer that is not yours: what you write here is not kept on it. Download it before you close the tab.",
    bring: "Bring notes from another device",
    bringNote: "You already have Onden notes on another device: bring them to this new one with a file made there.",
  },
} as const;

export default function StartChoice({ onUse, onTemporary, onBring }: { onUse: () => void; onTemporary: () => void; onBring: () => void }) {
  const words = WORDS[/^zh/i.test(systemLanguageTag()) ? "zh-TW" : "en"];
  return (
    <main className="browser-app-status">
      <h1>{words.title}</h1>
      <p>{words.lead}</p>
      <div className="browser-app-choices">
        <div><Button type="button" onClick={onUse}>{words.use}</Button><p>{words.useNote}</p></div>
        <div><Button type="button" variant="secondary" onClick={onBring}>{words.bring}</Button><p>{words.bringNote}</p></div>
        <div><Button type="button" variant="secondary" onClick={onTemporary}>{words.temp}</Button><p>{words.tempNote}</p></div>
      </div>
    </main>
  );
}
