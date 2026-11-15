import { isEnterKey, isEscapeKey } from "../lib/keys";
import { TextField } from "./ui";

// The sidebar's inline rename field (tree rows, folder rows, inbox rows).
// Enter commits — never while an IME is still composing — Escape cancels,
// leaving the field commits; keys and clicks stay inside the field.
export default function RenameInput({ value, onChange, onCommit, onCancel, maxLength }: {
  value: string;
  maxLength?: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <TextField
      className="sb-rename-input"
      autoFocus
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (isEnterKey(e)) onCommit();
        if (isEscapeKey(e)) onCancel();
        e.stopPropagation();
      }}
      onBlur={onCommit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
