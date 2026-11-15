import { Suspense } from "react";
import type { ModuleScreenProps } from "../types";
import { useAppSelector } from "../../lib/appStore";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useHomeStudio } from "./studio/useHomeStudio";

// The old home canvas on a phone (phone/PhoneHomeStudio): an ordered list of the
// page's blocks plus a preview, editing the design the desktop studio saves.
// It never loads Puck.
const PhoneHomeStudio = lazyWithReload(() => import("./phone/PhoneHomeStudio"));

export default function PhoneWebsiteScreen({ online, onRefresh, onBack }: ModuleScreenProps & { onBack?: () => void }) {
  const data = useAppSelector((s) => s.data);
  const site = useHomeStudio({ data, online, refresh: async () => { await onRefresh(); } });
  return (
    <Suspense fallback={null}>
      <PhoneHomeStudio site={site} onBack={onBack} />
    </Suspense>
  );
}
