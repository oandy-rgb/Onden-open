import "./Switch.css";

/** The one on/off control (role=switch). A button, so Space/Enter toggle it and
 *  `disabled` is native; `aria-checked` carries the state the styling reads.
 *  `label` names it for assistive tech — put visible text beside it, not in it. */
export function Switch({ on, label, disabled, onChange }: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  );
}
