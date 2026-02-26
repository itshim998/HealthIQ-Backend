import PillController from "./pill/PillController";

// Entry.tsx
// Responsibility boundary:
// - Entry renders the experience root.
// - All Liquid Pill narrative orchestration lives in PillController.
//
// MUST NOT:
// - Contain state machine or scroll mapping logic.
// - Render dashboards/grids/cards.

export default function HealthIQEntry() {
  return <PillController />;
}
