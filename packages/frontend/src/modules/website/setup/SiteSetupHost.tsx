// Gives the website screen its state (the design, the publish flow) and draws it.
import type { ModuleScreenProps } from "../../types";
import { useAppSelector } from "../../../lib/appStore";
import SiteSetupScreen from "./SiteSetupScreen";
import { useSiteSetup } from "./useSiteSetup";

export default function SiteSetupHost({ online, onRefresh, onOpenLegacy }: ModuleScreenProps & { onOpenLegacy: () => void }) {
  const data = useAppSelector((s) => s.data);
  const site = useSiteSetup({ data, online, refresh: async () => { await onRefresh(); } });
  return <SiteSetupScreen site={site} onOpenLegacy={onOpenLegacy} />;
}
