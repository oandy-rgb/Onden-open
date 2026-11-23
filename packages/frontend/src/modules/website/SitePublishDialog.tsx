// The publish preview of the website screens (the home studio, its phone version and the website
// screen): shown while a publish is waiting for its confirmation.
import PublishPreviewDialog from "./PublishPreviewDialog";
import type { SiteWork } from "./studio/useHomeStudio";

export default function SitePublishDialog({ site }: { site: Pick<SiteWork, "publish" | "online"> }) {
  const { publish, online } = site;
  if (!publish.pending) return null;
  return (
    <PublishPreviewDialog
      pending={publish.pending} outcome={publish.outcome} publishing={publish.status === "publishing"} online={online}
      onConfirm={() => publish.confirm()} onCancel={publish.cancel}
      onInclude={(ids) => void publish.include(ids)}
      onChanged={() => void publish.refresh()}
    />
  );
}
