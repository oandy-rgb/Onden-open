import { useState } from "react";
import { useT } from "../lib/i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { useImportedFeatures } from "../hooks/useImportedFeatures";
import { useShellNavigation } from "../hooks/useShellNavigation";
import { featureDestinationId } from "../hooks/shellNavigation";
import { AppNavigationPreview } from "../components/AppTopbar";
import { NavBarPreview, NavEditor, NavSwapDialog } from "../components/NavLayoutEditor";
import { isPinned, type NavSurface } from "../lib/navLayout";
import "../components/NavLayoutEditor.css";
import { Switch } from "../components/ui";

// Settings › 導覽列: the one nav editing screen (components/NavLayoutEditor;
// the phone's 更多 › 編輯 opens it): the bar as the phone draws it, then the
// editor with 「恢復預設」. The layout itself is lib/navLayout's.

export default function NavigationSetting() {
  // The shell is the app's own switch (useIsMobile): the phone draws its bottom
  // bar, every wider screen the top bar, and the list describes the same bar.
  const phone = useIsMobile();
  const [folded, setFolded] = useState<readonly string[]>([]);
  return (
    <div className="settings-section nav-settings">
      {phone ? <NavBarPreview /> : <div className="nav-desktop-preview"><AppNavigationPreview onFoldedChange={setFolded} /></div>}
      <NavEditor {...(phone ? { shell: "phone" as const } : { shell: "desktop" as const, folded })} />
    </div>
  );
}

/** The 「釘到導覽列」 state of an imported module with a page of its own, or
 *  null when it has none to pin. On the phone it pins to the phone's bar, asking
 *  which entry to swap out when the bar is full: `dialog` is that question. */
export function useNavPin(moduleId: string) {
  const features = useImportedFeatures();
  const nav = useShellNavigation();
  const surface: NavSurface = useIsMobile() ? "phone" : "desktop";
  const [swapping, setSwapping] = useState(false);
  const feature = features.find((f) => f.mod.id === moduleId);
  const id = feature ? featureDestinationId(feature) : null;
  const destination = id ? nav.candidates.find((d) => d.id === id) : undefined;
  if (!id || !destination) return null;
  return {
    on: isPinned(nav.layout, id, surface),
    setPinned(next: boolean) {
      if (!next) nav.unpin(id, surface);
      else if ("full" in nav.pin(id, surface)) setSwapping(true);
    },
    dialog: swapping ? <NavSwapDialog incoming={destination} bar={nav.phoneBar}
      onSwap={(out) => { nav.swap(id, out); setSwapping(false); }} onCancel={() => setSwapping(false)} /> : null,
  };
}

/** A module page's 「釘到導覽列」 switch (Settings › 模組 › <module>), for an
 *  imported module with a page of its own. */
export function NavPinSwitch({ moduleId }: { moduleId: string }) {
  const t = useT();
  const pin = useNavPin(moduleId);
  if (!pin) return null;
  return (
    <div className="settings-row" data-setting-id={`nav-pin:${moduleId}`}>
      <span className="settings-label">{t("In the navigation bar")}</span>
      <Switch on={pin.on} label={t("In the navigation bar")} onChange={pin.setPinned} />
      {pin.dialog}
    </div>
  );
}
