import type { ReactNode } from "react";

// PillViewport placeholder for Liquid Pill UI
// OWNS: viewport boundary that hosts primary + micro pillars in one coherent plane
// MUST NOT: apply styling, hijack scroll, or implement motion behavior
// EXPECTS: plan mode, scroll phase label, intent mapping callback, primary + micro slots

export interface PillViewportProps {
  planMode: "PlanA" | "PlanB";
  scrollPhase: string;
  onScrollIntent?: (intent: string) => void;
  primarySlot?: ReactNode;
  microSlot?: ReactNode;
}

export function PillViewport(_props: PillViewportProps) {
  // Structural placeholder only.
  return <div />;
}

export default PillViewport;
