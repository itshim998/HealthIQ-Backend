import { useEffect, useMemo, useState } from "react";

import PrimaryPill from "./PrimaryPill";
import MicroPill from "./MicroPill";

import type { AnyHealthEvent } from "../../backend/domain/HealthTimeline";
import type { InsightEvent } from "../../backend/domain/InsightEvent";

// PillController (UI-side orchestrator)
// OWNS:
// - Obtaining a timeline instance (injected adapter or mock adapter).
// - Reading timeline events (read-only).
// - Segmenting events into time-based narrative slices.
// - Mapping user scroll intent -> temporal progression (slice index).
// - Selecting the narrative slice type: intro | events | insights.
//
// MUST NOT:
// - Persist events.
// - Mutate the timeline.
// - Call any LLM.
// - Call Maps.
// - Add animation libraries or styling.
//
// This file exists to prove: Liquid Pill can read real timelines as a story.

export type PillSliceType = "intro" | "events" | "insights";

export type TimelineSnapshot = Readonly<{ events: readonly AnyHealthEvent[] }>;

// Frontend boundary adapter (storage-agnostic)
// This mirrors the repository concept without importing backend repository implementations.
export interface TimelineRepositoryAdapter {
  getTimeline: (userId: string) => Promise<TimelineSnapshot>;
}

type TimeSlice = Readonly<{
  id: string;
  label: string;
  // Inclusive boundaries for narrative only; not a storage query.
  startMs: number;
  endMs: number;
  eventIds: ReadonlySet<string>;
}>;

function ms(iso: string): number {
  const v = Date.parse(iso);
  if (!Number.isFinite(v)) return 0;
  return v;
}

function buildCoarseSlices(events: readonly AnyHealthEvent[]): readonly TimeSlice[] {
  // Coarse segmentation to validate concept:
  // - recent: last 7 days
  // - earlier: 8-30 days
  // - older: 31+ days
  // If data is sparse, slices may be empty; we keep them anyway for a stable narrative structure.
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const defs = [
    { id: "recent", label: "Recent (7 days)", startMs: now - 7 * day, endMs: now },
    { id: "earlier", label: "Earlier (8-30 days)", startMs: now - 30 * day, endMs: now - 8 * day },
    { id: "older", label: "Older (31+ days)", startMs: 0, endMs: now - 31 * day },
  ] as const;

  const idsFor = (startMs: number, endMs: number): ReadonlySet<string> => {
    const s = new Set<string>();
    for (const e of events) {
      const t = ms(e.timestamp.absolute);
      if (t >= startMs && t <= endMs) s.add(e.id);
    }
    return s;
  };

  return defs.map((d) => ({
    id: d.id,
    label: d.label,
    startMs: d.startMs,
    endMs: d.endMs,
    eventIds: idsFor(d.startMs, d.endMs),
  }));
}

function isInsight(e: AnyHealthEvent): e is InsightEvent {
  return e.eventType === "Insight";
}

function createMockRepository(): TimelineRepositoryAdapter {
  // Mock timeline with real-domain shape (no storage, no AI calls).
  // Review status is a FIRST-CLASS InsightEvent field (InsightEvent.reviewStatus).
  // MUST NOT be inferred from metadata — per domain contract (InsightEvent.ts:19-20).
  return {
    async getTimeline() {
      const events: AnyHealthEvent[] = [
        {
          id: "med-1",
          eventType: "Medication" as any,
          timestamp: { absolute: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
          source: "prescription" as any,
          confidence: "high",
          visibilityScope: "user-only" as any,
          name: "Metformin",
          dosage: "500mg",
          intendedSchedule: "twice daily",
          adherenceOutcome: "taken",
        } as any,
        {
          id: "sym-1",
          eventType: "Symptom" as any,
          timestamp: { absolute: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
          source: "user" as any,
          confidence: "medium",
          visibilityScope: "user-only" as any,
          description: "Headache",
          intensity: "moderate",
          userReportedContext: "Poor sleep; high stress",
          duration: { kind: "reported", value: "about 3 hours" },
        } as any,
        {
          id: "life-1",
          eventType: "Lifestyle" as any,
          timestamp: { absolute: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() },
          source: "user" as any,
          confidence: "low",
          visibilityScope: "user-only" as any,
          sleep: "~5h",
          stress: "high",
          activity: "low",
          food: "irregular meals",
        } as any,
        {
          id: "clin-1",
          eventType: "Clinical" as any,
          timestamp: { absolute: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() },
          source: "doctor" as any,
          confidence: "high",
          visibilityScope: "doctor-shareable" as any,
          doctorVisit: "Follow-up appointment",
          diagnosisLabel: "(provided by clinician)" ,
        } as any,
        {
          id: "ins-1",
          eventType: "Insight" as any,
          timestamp: { absolute: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
          source: "user" as any,
          confidence: "medium",
          visibilityScope: "user-only" as any,
          evidenceEventIds: ["sym-1", "med-1"],
          reviewStatus: "draft",
          metadata: {
            createdBy: "ai",
          },
          notes: "Draft: symptom labels may correlate with sleep/stress context.",
        } as any,
        {
          id: "ins-2",
          eventType: "Insight" as any,
          timestamp: { absolute: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString() },
          source: "user" as any,
          confidence: "high",
          visibilityScope: "user-only" as any,
          evidenceEventIds: ["life-1"],
          reviewStatus: "reviewed",
          metadata: {
            createdBy: "ai",
          },
          notes: "Reviewed: sleep/stress signal appears elevated during this period.",
        } as any,
      ];

      return { events };
    },
  };
}

export default function PillController(props: {
  repository?: TimelineRepositoryAdapter;
  userId?: string;
}) {
  const repository = props.repository ?? createMockRepository();
  const userId = props.userId ?? "user-0";

  const [sliceType, setSliceType] = useState<PillSliceType>("intro");
  const [sliceIndex, setSliceIndex] = useState<number>(0);

  const [timeline, setTimeline] = useState<TimelineSnapshot>({ events: [] });

  useEffect(() => {
    let cancelled = false;
    repository
      .getTimeline(userId)
      .then((t) => {
        if (!cancelled) setTimeline(t);
      })
      .catch(() => {
        // No UI error surface yet; keep it minimal.
        if (!cancelled) setTimeline({ events: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [repository, userId]);

  const slices = useMemo(() => buildCoarseSlices(timeline.events), [timeline.events]);

  const activeSlice = slices[Math.max(0, Math.min(sliceIndex, slices.length - 1))];

  const eventsInSlice = useMemo(() => {
    if (!activeSlice) return [] as AnyHealthEvent[];
    return timeline.events.filter((e) => activeSlice.eventIds.has(e.id) && !isInsight(e));
  }, [timeline.events, activeSlice]);

  const insightsInSlice = useMemo(() => {
    if (!activeSlice) return [] as InsightEvent[];
    return timeline.events.filter((e) => activeSlice.eventIds.has(e.id) && isInsight(e)) as InsightEvent[];
  }, [timeline.events, activeSlice]);

  const handleWheel: React.WheelEventHandler<HTMLDivElement> = (ev) => {
    // Map scroll -> temporal progression (coarse validation only).
    // No hijacking: we only interpret wheel intent; we do not smooth-scroll or lock the page.
    if (!slices.length) return;

    if (sliceType === "intro") {
      if (ev.deltaY > 0) setSliceType("events");
      return;
    }

    if (ev.deltaY > 0) {
      // Forward scroll -> later in the narrative (towards "recent").
      setSliceIndex((i) => Math.max(0, i - 1));
    } else if (ev.deltaY < 0) {
      // Backward scroll -> earlier in the narrative (towards "older").
      setSliceIndex((i) => Math.min(slices.length - 1, i + 1));
    }
  };

  return (
    <div onWheel={handleWheel}>
      <div>
        {/* Micro navigation is a simple affordance: it does not own intelligence. */}
        <MicroPill id="nav-events" label="Events" isSelected={sliceType === "events"} onSelect={() => setSliceType("events")} />
        <MicroPill
          id="nav-insights"
          label="Insights"
          isSelected={sliceType === "insights"}
          onSelect={() => setSliceType("insights")}
        />
      </div>

      <PrimaryPill
        sliceType={sliceType}
        sliceLabel={activeSlice?.label ?? ""}
        events={eventsInSlice}
        insights={insightsInSlice}
      />

      <div>
        {/* Debug-visible state (plain text) to validate temporal navigation without UI polish. */}
        <p>Slice: {activeSlice?.label ?? "(no slice)"}</p>
        <p>View: {sliceType}</p>
        <p>Events in slice: {eventsInSlice.length}</p>
        <p>Insights in slice: {insightsInSlice.length}</p>
      </div>
    </div>
  );
}
