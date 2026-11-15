// 「編輯工具列…」 at the end of an editor toolbar's 更多 menu: opens Settings › Notes with the
// toolbar editor already unfolded (settings/ToolbarSetting reads and clears the request).
import { openSettings } from "./settingsRequest";

let requested = false;

export function openToolbarEditor(): void {
  requested = true;
  openSettings("notes");
}

/** Whether the editor was asked for since the last read; reading clears the request. */
export function takeToolbarEditorRequest(): boolean {
  const asked = requested;
  requested = false;
  return asked;
}
