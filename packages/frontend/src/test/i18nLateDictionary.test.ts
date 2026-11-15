// The zh-TW table is two files: the boot half is registered at boot, the late half is
// fetched after boot, and dictionariesReady() (awaited by lazyWithReload) resolves
// once it is in. Until then t() shows the English literal.
import { afterEach, describe, expect, it } from "vitest";
import { dictionariesReady, registerDictionary, setLateDictionary, setLocalePref, t } from "../lib/i18n";
import { ZH_TW } from "../lib/i18n.zh-TW";
import { ZH_TW_BOOT } from "../lib/i18n.zh-TW.boot";
import { ZH_TW_LATE } from "../lib/i18n.zh-TW.late";

describe("late dictionary", () => {
  afterEach(() => setLocalePref("en"));

  it("the two halves share no key and make the whole table", () => {
    const shared = Object.keys(ZH_TW_BOOT).filter((key) => key in ZH_TW_LATE);
    expect(shared).toEqual([]);
    expect(Object.keys(ZH_TW).length).toBe(Object.keys(ZH_TW_BOOT).length + Object.keys(ZH_TW_LATE).length);
  });

  it("is registered when dictionariesReady() resolves, and not before", async () => {
    setLocalePref("zh-TW");
    registerDictionary("zh-TW", { Boot: "開機" });
    let load = () => {};
    setLateDictionary("zh-TW", () => new Promise((resolve) => { load = () => resolve({ "Only late": "晚到" }); }));
    expect(t("Only late")).toBe("Only late");
    const ready = dictionariesReady();
    load();
    await ready;
    expect(t("Only late")).toBe("晚到");
    expect(t("Boot")).toBe("開機");
  });

  it("resolves for English without loading, and when the file cannot be fetched", async () => {
    setLateDictionary("zh-TW", () => Promise.reject(new Error("offline")));
    setLocalePref("en");
    await expect(dictionariesReady()).resolves.toBeUndefined();
    setLocalePref("zh-TW");
    await expect(dictionariesReady()).resolves.toBeUndefined();
    expect(t("Never loaded")).toBe("Never loaded");
  });
});
