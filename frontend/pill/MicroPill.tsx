// MicroPill (Liquid Pill UI)
// OWNS:
// - A minimal navigation affordance (e.g., switching the Primary Pill slice type).
//
// MUST NOT:
// - Own state machine logic.
// - Interpret health data.
// - Trigger AI or repository writes.
// - Animate independently.

export interface MicroPillProps {
  id: string;
  label: string;
  isSelected: boolean;
  onSelect?: (id: string) => void;
}

export function MicroPill(props: MicroPillProps) {
  const { id, label, isSelected, onSelect } = props;

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={() => onSelect?.(id)}
    >
      {label}
    </button>
  );
}

export default MicroPill;
