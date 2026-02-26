import type { AnyHealthEvent } from "../../backend/domain/HealthTimeline";
import type { InsightEvent } from "../../backend/domain/InsightEvent";

// PrimaryPill (Liquid Pill UI)
// OWNS:
// - Rendering a single narrative view at a time (intro OR events OR insights).
// - Presenting timeline items as a story (plain text), not as a dashboard.
//
// MUST NOT:
// - Style, animate, or layout as cards/grids.
// - Fetch data or mutate state.
// - Interpret medically or produce recommendations.
// - Auto-apply AI drafts to the timeline.
//
// EXPECTS:
// - A slice type and the slice�s event lists (already selected by the controller).

export type PrimaryPillSliceType = "intro" | "events" | "insights";

export interface PrimaryPillProps {
  sliceType: PrimaryPillSliceType;
  sliceLabel: string;
  events: readonly AnyHealthEvent[];
  insights: readonly InsightEvent[];
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function describeEvent(e: AnyHealthEvent): string {
  // Narrative summaries only. No clinical interpretation.
  switch (e.eventType) {
    case "Medication":
      return `Medication: ${(e as any).name ?? "(unknown)"} ${(e as any).dosage ?? ""}`.trim();
    case "Symptom":
      return `Symptom: ${(e as any).description ?? "(no description)"}`;
    case "Lifestyle":
      return "Lifestyle signal";
    case "Clinical":
      return `Clinical: ${(e as any).doctorVisit ?? "visit"}`;
    case "Insight":
      return "Insight";
    default:
      return "Event";
  }
}

function insightOriginLabel(i: InsightEvent): string {
  const meta = (i as any).metadata ?? {};
  if (meta.createdBy === "ai") return "AI-generated";
  return "User/Clinician-generated";
}

function insightReviewLabel(i: InsightEvent): string {
  // MUST read from first-class InsightEvent.reviewStatus field.
  // MUST NOT infer from metadata (per domain contract InsightEvent.ts:19-20).
  if (i.reviewStatus === "reviewed") return "Reviewed";
  if (i.reviewStatus === "draft") return "Draft";
  // Defensive: if reviewStatus is missing or invalid, surface the problem visually.
  return "Invalid — missing review status";
}

export function PrimaryPill(props: PrimaryPillProps) {
  const { sliceType, sliceLabel, events, insights } = props;

  return (
    <div>
      <h2>Primary Pill</h2>
      <p>Slice: {sliceLabel || "(no label)"}</p>

      {sliceType === "intro" ? (
        <div>
          <p>
            HealthIQ reads health as an append-only timeline. Scroll moves through time. Use the micro pills to switch between
            Events and Insights.
          </p>
          <p>
            Note: Insights are drafts unless reviewed. They must always reference evidence events and can be contested.
          </p>
        </div>
      ) : null}

      {sliceType === "events" ? (
        <div>
          <h3>Events</h3>
          {events.length ? (
            <ul>
              {events.map((e) => (
                <li key={e.id}>
                  <div>
                    <strong>{e.eventType}</strong> � {shortTime(e.timestamp.absolute)}
                  </div>
                  <div>{describeEvent(e)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p>(No events in this slice.)</p>
          )}
        </div>
      ) : null}

      {sliceType === "insights" ? (
        <div>
          <h3>Insights</h3>
          {insights.length ? (
            <ul>
              {insights.map((i) => (
                <li key={i.id}>
                  <div>
                    <strong>Insight</strong> � {shortTime(i.timestamp.absolute)}
                  </div>
                  <div>
                    {insightOriginLabel(i)} � {insightReviewLabel(i)}
                  </div>
                  <div>Evidence: {i.evidenceEventIds.join(", ")}</div>
                  <div>{(i as any).notes ? `Summary: ${(i as any).notes}` : "(No summary provided.)"}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p>(No insights in this slice.)</p>
          )}

          <p>
            Disclaimer: Insights are not medical advice and must not be treated as diagnoses or urgency guidance.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default PrimaryPill;
