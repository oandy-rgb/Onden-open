// Shared context the mutation modules close over. One object — since H4,
// assembled ONCE at module scope by useAppData.ts with data/online as live
// getters into lib/appStore. The modules are plain factories, not hooks, so
// the mutation logic is React-free; factories must read ctx.data/ctx.online
// at CALL time (never destructure them at factory time).

import type { Dispatch, SetStateAction } from "react";
import type { Bootstrap } from "../api";

export type ToastFn = (
  msg: string,
  kind?: "success" | "error" | "info",
  action?: { label: string; onClick: () => void },
) => void;

export type DataCtx = {
  data: Bootstrap;
  setData: Dispatch<SetStateAction<Bootstrap>>;
  online: boolean;
  addToast: ToastFn;
  /** Debounced export of the local DB to the user's chosen folder (fs-access). */
  scheduleUserFolderSync: () => void;
  refresh: () => Promise<void>;
};
