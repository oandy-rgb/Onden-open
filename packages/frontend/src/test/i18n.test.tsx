import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { t, useT, setLocalePref, getLocalePref, resolveLocale } from "../lib/i18n";

function Probe() {
  const tr = useT();
  return <span>{tr("Quick capture")}</span>;
}

describe("i18n (layer B)", () => {
  afterEach(() => {
    act(() => setLocalePref("system"));
    localStorage.removeItem("onden.locale");
  });

  it("untranslated strings fall back to the English literal", () => {
    act(() => setLocalePref("zh-TW"));
    expect(t("Some string nobody translated")).toBe("Some string nobody translated");
  });

  it("zh-TW dictionary translates; en is identity", () => {
    act(() => setLocalePref("zh-TW"));
    expect(t("Settings")).toBe("設定");
    act(() => setLocalePref("en"));
    expect(t("Settings")).toBe("Settings");
  });

  it("overview first-run empty state uses ordinary note vocabulary, translated in zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    expect(t("No notes yet")).toBe("還沒有筆記");
    expect(t("Write your first note")).toBe("寫下第一篇筆記");
    act(() => setLocalePref("en"));
    expect(t("No notes yet")).toBe("No notes yet");
    expect(t("Write your first note")).toBe("Write your first note");
  });

  it("interpolates {vars} in both locales", () => {
    act(() => setLocalePref("en"));
    expect(t("{n} shown", { n: 7 })).toBe("7 shown");
    act(() => setLocalePref("zh-TW"));
    expect(t("{n} shown", { n: 7 })).toBe("顯示 7 項");
  });

  it("data-layer toasts translate, with interpolation, in zh-TW (layer B extraction)", () => {
    act(() => setLocalePref("zh-TW"));
    expect(t('"{title}" created', { title: "備忘" })).toBe("已建立「備忘」");
    expect(t('"{title}" deleted', { title: t("Node") })).toBe("已刪除「筆記」");
    expect(t("Undo")).toBe("復原");
    expect(t("Version restored")).toBe("已還原版本");
    expect(t("{n} approved, {m} skipped", { n: 3, m: 1 })).toBe("已核准 3 項，略過 1 項");
    act(() => setLocalePref("en"));
    expect(t('"{title}" created', { title: "Memo" })).toBe('"Memo" created'); // identity in en
  });

  it("the per-note actions menu (NoteActions) labels are all translated in zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    // Every user-visible string the ⋯ menu emits. A missing key
    // would fall back to the English literal (=== the key), so each must differ
    // from its key — except brand/format tokens (PDF/HTML/Markdown) that are the
    // same in both locales by design.
    const keys = [
      "More actions",
      "Set color", "Pin", "Unpin", "Hide",
      "Extract review cards (Q:/A:)", "Review cards here", "Rename", "Duplicate",
      "Export as", "Delete",
    ];
    for (const k of keys) expect(t(k)).not.toBe(k);
    // The info panel's publish row: states and actions, and the publish dialog's interpolated count.
    for (const k of ["On the site", "The site has an older version", "Publish now", "Copy link", "Keep off the site", "Copied"]) expect(t(k)).not.toBe(k);
    expect(t("{n} notes in publishing spaces stay off the site", { n: 3 })).toBe("發布中的空間裡有 3 則筆記不會放上網站");
    // Format tokens intentionally identical across locales.
    for (const k of ["PDF", "HTML", "Markdown"]) expect(t(k)).toBe(k);
  });

  it("locale pref persists and resolves; 'system' follows navigator", () => {
    act(() => setLocalePref("zh-TW"));
    expect(getLocalePref()).toBe("zh-TW");
    expect(resolveLocale()).toBe("zh-TW");
    act(() => setLocalePref("system"));
    // jsdom default navigator.language is en-US
    expect(resolveLocale()).toBe("en");
  });

  it("useT re-renders subscribers when the locale changes", () => {
    render(<Probe />);
    expect(screen.getByText("Quick capture")).toBeTruthy();
    act(() => setLocalePref("zh-TW"));
    expect(screen.getByText("記一筆")).toBeTruthy();
    act(() => setLocalePref("en"));
    expect(screen.getByText("Quick capture")).toBeTruthy();
  });
});
