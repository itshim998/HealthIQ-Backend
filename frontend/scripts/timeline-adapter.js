/*
Timeline Adapter (Frontend Bridge)

Responsibilities:
- Thin bridge between backend repository concepts and the plain-HTML Liquid Pill UI.
- Provides time-sliced timeline data for rendering.

Non-goals:
- No AI calls.
- No medical reasoning.
- No persistence decisions.
- No mutation of timeline events once created.

Important correctness:
- Backend repository enforces: InsightEvent is persistable only when reviewStatus === "reviewed".
- This adapter therefore models two sources:
  1) Persisted timeline events (append-only; reviewed insights only)
  2) Draft insights (NOT persisted; shown for transparency)
*/

(function () {
  const DAY = 24 * 60 * 60 * 1000;

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  function nowMs() {
    return Date.now();
  }

  function ms(isoString) {
    const v = Date.parse(isoString);
    return Number.isFinite(v) ? v : 0;
  }

  function clone(value) {
    if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function assertNonEmptyArray(arr, label) {
    if (!Array.isArray(arr) || arr.length < 1) throw new Error(label + " must be a non-empty array.");
  }

  // Minimal in-memory repository mock (frontend-only) to mirror append-only semantics.
  // NOTE: This is not a database choice; it is a seeded demo store.
  function createInMemoryTimeline() {
    const events = [];
    const ids = new Set();

    function appendEvent(e) {
      if (!e || typeof e !== "object") throw new Error("event must be an object");
      if (!e.id || typeof e.id !== "string") throw new Error("event.id must be a string");
      if (ids.has(e.id)) throw new Error("duplicate event id (append-only violation): " + e.id);

      // Enforce review discipline for persisted InsightEvents.
      if (e.eventType === "Insight") {
        if (e.reviewStatus !== "reviewed") {
          throw new Error("cannot persist InsightEvent unless reviewStatus is reviewed");
        }
        assertNonEmptyArray(e.evidenceEventIds, "InsightEvent.evidenceEventIds");
      }

      ids.add(e.id);
      events.push(clone(e));
    }

    function getAllEvents() {
      return clone(events);
    }

    return { appendEvent, getAllEvents };
  }

  // Seeded demo data (real domain shape; no AI calls).
  const base = nowMs();

  const timeline = createInMemoryTimeline();

  const persistedEvents = [
    {
      id: "evt-med-1",
      eventType: "Medication",
      timestamp: { absolute: iso(base - 3 * DAY) },
      source: "prescription",
      confidence: "high",
      visibilityScope: "user-only",
      name: "Metformin",
      dosage: "500mg",
      intendedSchedule: "twice daily",
      adherenceOutcome: "taken",
    },
    {
      id: "evt-sym-1",
      eventType: "Symptom",
      timestamp: { absolute: iso(base - 2 * DAY) },
      source: "user",
      confidence: "medium",
      visibilityScope: "user-only",
      description: "Headache",
      intensity: "moderate",
      userReportedContext: "poor sleep; high stress",
      duration: { kind: "reported", value: "about 3 hours" },
    },
    {
      id: "evt-life-1",
      eventType: "Lifestyle",
      timestamp: { absolute: iso(base - 10 * DAY) },
      source: "user",
      confidence: "low",
      visibilityScope: "user-only",
      sleep: "~5h",
      stress: "high",
      activity: "low",
      food: "irregular meals",
    },
    {
      id: "evt-clin-1",
      eventType: "Clinical",
      timestamp: { absolute: iso(base - 40 * DAY) },
      source: "doctor",
      confidence: "high",
      visibilityScope: "doctor-shareable",
      doctorVisit: "follow-up appointment",
      diagnosisLabel: "(provided by clinician)",
    },
    {
      // Persisted (reviewed) insight.
      id: "evt-ins-reviewed-1",
      eventType: "Insight",
      timestamp: { absolute: iso(base - 12 * DAY) },
      source: "user",
      confidence: "high",
      visibilityScope: "user-only",
      evidenceEventIds: ["evt-life-1"],
      reviewStatus: "reviewed",
      metadata: {
        createdBy: "ai",
      },
      notes: "Reviewed: sleep/stress signals appear elevated during this period.",
    },
  ];

  for (const e of persistedEvents) timeline.appendEvent(e);

  // Draft insights (NOT persisted). These are shown transparently, but cannot be appended until reviewed.
  const draftInsights = [
    {
      id: "draft-ins-1",
      eventType: "Insight",
      timestamp: { absolute: iso(base - 2 * DAY) },
      source: "user",
      confidence: "medium",
      visibilityScope: "user-only",
      evidenceEventIds: ["evt-sym-1", "evt-med-1"],
      reviewStatus: "draft",
      metadata: {
        createdBy: "ai",
      },
      notes: "Draft: headache may co-occur with low sleep / high stress context.",
    },
  ];

  function buildSlices(allEvents, draft) {
    // Coarse, time-based slices to support a narrative scroll.
    // Order: older -> earlier -> recent (scroll forward = newer).
    const now = nowMs();

    const defs = [
      { id: "older", label: "Older (31+ days)", startMs: 0, endMs: now - 31 * DAY },
      { id: "earlier", label: "Earlier (8-30 days)", startMs: now - 30 * DAY, endMs: now - 8 * DAY },
      { id: "recent", label: "Recent (7 days)", startMs: now - 7 * DAY, endMs: now },
    ];

    const slices = [];

    for (const d of defs) {
      const eventsIn = [];
      const insightsIn = [];

      for (const e of allEvents) {
        const t = ms(e.timestamp.absolute);
        if (t >= d.startMs && t <= d.endMs) {
          if (e.eventType === "Insight") insightsIn.push(e);
          else eventsIn.push(e);
        }
      }

      for (const i of draft) {
        const t = ms(i.timestamp.absolute);
        if (t >= d.startMs && t <= d.endMs) {
          insightsIn.push(i);
        }
      }

      slices.push({
        id: d.id,
        timeRangeLabel: d.label,
        events: clone(eventsIn),
        insights: clone(insightsIn),
      });
    }

    return slices;
  }

  function getTimelineSlices() {
    const all = timeline.getAllEvents();
    return buildSlices(all, draftInsights);
  }

  function getSliceByIndex(i) {
    const slices = getTimelineSlices();
    if (!Number.isFinite(i)) return slices[0];
    const idx = Math.max(0, Math.min(slices.length - 1, Math.floor(i)));
    return slices[idx];
  }

  window.HealthIQTimelineAdapter = {
    getTimelineSlices,
    getSliceByIndex,
  };
})();
