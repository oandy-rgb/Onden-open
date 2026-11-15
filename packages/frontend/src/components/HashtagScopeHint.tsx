import { useT } from "../lib/i18n";
import { Chip, CloseButton, Popover, useInlinePopover, Pressable } from "./ui";
import "./HashtagScopeHint.css";

type Props = {
  /** The tag name typed after `#`. */
  name: string;
  /** Viewport position under the typed word. */
  x: number;
  y: number;
  onApply: () => void;
  onClose: () => void;
};

/** The one-time note beside a typed `#word`: offers to tag the paragraph with that word instead (lib/
 *  hashtagScopeHint). Pointer-down never takes focus, so typing goes on. */
export default function HashtagScopeHint({ name, x, y, onApply, onClose }: Props) {
  const t = useT();
  // Typing goes on in the editor: the hint never takes focus. Esc or a press elsewhere dismisses it.
  const pop = useInlinePopover({ open: true, onClose, at: { x, y } });
  return (
    <Popover popover={pop} label={t("Tag this paragraph?")} role="status" className="hashtag-hint">
      <span className="hashtag-hint-body">
        <span className="hashtag-hint-text">
          {t("Tag this paragraph?")} <Chip tone="accent">{name}</Chip>
        </span>
        <span className="hashtag-hint-tip">{t("Next time, type { to tag a paragraph.")}</span>
      </span>
      <Pressable type="button" className="hashtag-hint-apply" onClick={onApply}>
        {t("Add tag")}
      </Pressable>
      <CloseButton size="sm" onClick={onClose} />
    </Popover>
  );
}
