import type { AnyHealthEvent, AnyHealthEventType, TimeWindow } from "../domain/HealthTimeline";
import type { ISODateTimeString } from "../domain/HealthEvent";
import { HealthEventType } from "../domain/HealthEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import type { ClinicalEvent } from "../domain/ClinicalEvent";
import type { InsightEvent } from "../domain/InsightEvent";
import {
  assertInsightReviewed,
  isInsightEvent,
  type AppendOptions,
  type TimelineRepository,
  type TimelineSnapshot,
  type UserId,
} from "./TimelineRepository";
import { query, withTransaction } from "../database/connection";

// =========================================================================
// PostgreSQL Timeline Repository (HealthIQ v2)
//
// Production storage backend. Implements the same TimelineRepository interface
// as InMemoryTimelineRepository, preserving all invariants:
// - Append-only (no update/delete)
// - Duplicate ID rejection
// - InsightEvent review discipline
// - Evidence integrity (Insight→non-Insight only)
// =========================================================================

// --- Row ↔ Domain mapping ---

interface EventRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  event_type: string;
  timestamp_abs: string;
  timestamp_rel: { reference: string; offset: string } | null;
  source: string;
  confidence: string;
  visibility: string;
  payload: Record<string, unknown>;
  duration: unknown | null;
  tags: string[] | null;
  links: Record<string, unknown> | null;
  notes: string | null;
  review_status: string | null;
  created_at: string;
}

function rowToDomainEvent(row: EventRow): AnyHealthEvent {
  const base = {
    id: row.id,
    timestamp: {
      absolute: row.timestamp_abs as ISODateTimeString,
      ...(row.timestamp_rel ? { relative: row.timestamp_rel } : {}),
    },
    source: row.source as any,
    confidence: row.confidence as any,
    visibilityScope: row.visibility as any,
    ...(row.duration ? { duration: row.duration } : {}),
    ...(row.tags && row.tags.length > 0 ? { tags: row.tags } : {}),
    ...(row.links ? { links: row.links } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.payload.metadata ? { metadata: row.payload.metadata } : {}),
  };

  const p = row.payload;

  switch (row.event_type) {
    case "Symptom":
      return {
        ...base,
        eventType: HealthEventType.Symptom,
        description: (p.description as string) || "",
        ...(p.intensity ? { intensity: p.intensity as string } : {}),
        ...(p.userReportedContext ? { userReportedContext: p.userReportedContext as string } : {}),
      } as SymptomEvent;

    case "Medication":
      return {
        ...base,
        eventType: HealthEventType.Medication,
        name: (p.name as string) || "",
        dosage: (p.dosage as string) || "",
        intendedSchedule: (p.intendedSchedule as string) || "",
        adherenceOutcome: (p.adherenceOutcome as string) || "taken",
      } as MedicationEvent;

    case "Lifestyle":
      return {
        ...base,
        eventType: HealthEventType.Lifestyle,
        ...(p.sleep ? { sleep: p.sleep as string } : {}),
        ...(p.stress ? { stress: p.stress as string } : {}),
        ...(p.activity ? { activity: p.activity as string } : {}),
        ...(p.food ? { food: p.food as string } : {}),
      } as LifestyleEvent;

    case "Clinical":
      return {
        ...base,
        eventType: HealthEventType.Clinical,
        doctorVisit: (p.doctorVisit as string) || "",
        ...(p.diagnosisLabel ? { diagnosisLabel: p.diagnosisLabel as string } : {}),
      } as ClinicalEvent;

    case "Insight": {
      const evidenceIds = (p.evidenceEventIds as string[]) || [];
      return {
        ...base,
        eventType: HealthEventType.Insight,
        evidenceEventIds: evidenceIds.length > 0 ? evidenceIds : ["unknown"],
        reviewStatus: (row.review_status as "draft" | "reviewed") || "draft",
      } as unknown as InsightEvent;
    }

    default:
      throw new Error(`Unknown event type in database: ${row.event_type}`);
  }
}

function domainEventToRow(
  userId: string,
  event: AnyHealthEvent,
): {
  id: string;
  user_id: string;
  event_type: string;
  timestamp_abs: string;
  timestamp_rel: unknown;
  source: string;
  confidence: string;
  visibility: string;
  payload: Record<string, unknown>;
  duration: unknown;
  tags: string[] | null;
  links: unknown;
  notes: string | null;
  review_status: string | null;
} {
  const payload: Record<string, unknown> = {};
  let reviewStatus: string | null = null;

  switch (event.eventType) {
    case "Symptom": {
      const e = event as SymptomEvent;
      payload.description = e.description;
      if (e.intensity) payload.intensity = e.intensity;
      if (e.userReportedContext) payload.userReportedContext = e.userReportedContext;
      break;
    }
    case "Medication": {
      const e = event as MedicationEvent;
      payload.name = e.name;
      payload.dosage = e.dosage;
      payload.intendedSchedule = e.intendedSchedule;
      payload.adherenceOutcome = e.adherenceOutcome;
      break;
    }
    case "Lifestyle": {
      const e = event as LifestyleEvent;
      if (e.sleep) payload.sleep = e.sleep;
      if (e.stress) payload.stress = e.stress;
      if (e.activity) payload.activity = e.activity;
      if (e.food) payload.food = e.food;
      break;
    }
    case "Clinical": {
      const e = event as ClinicalEvent;
      payload.doctorVisit = e.doctorVisit;
      if (e.diagnosisLabel) payload.diagnosisLabel = e.diagnosisLabel;
      break;
    }
    case "Insight": {
      const e = event as InsightEvent;
      payload.evidenceEventIds = e.evidenceEventIds;
      reviewStatus = e.reviewStatus;
      break;
    }
  }

  if (event.metadata) payload.metadata = event.metadata;

  return {
    id: event.id,
    user_id: userId,
    event_type: event.eventType,
    timestamp_abs: event.timestamp.absolute,
    timestamp_rel: event.timestamp.relative || null,
    source: event.source,
    confidence: event.confidence,
    visibility: event.visibilityScope,
    payload,
    duration: event.duration || null,
    tags: event.tags ? [...event.tags] : null,
    links: event.links || null,
    notes: event.notes || null,
    review_status: reviewStatus,
  };
}

export class PostgresTimelineRepository implements TimelineRepository {

  async getTimeline(userId: UserId): Promise<TimelineSnapshot> {
    const result = await query<EventRow>(
      `SELECT * FROM health_events WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );

    return {
      userId,
      events: result.rows.map(rowToDomainEvent),
    };
  }

  async appendEvent(userId: UserId, event: AnyHealthEvent, options?: AppendOptions): Promise<void> {
    return this.appendEvents(userId, [event], options);
  }

  async appendEvents(userId: UserId, events: readonly AnyHealthEvent[], _options?: AppendOptions): Promise<void> {
    if (!events.length) return;

    // Enforce review discipline for InsightEvents
    for (const e of events) assertInsightReviewed(e);

    await withTransaction(async (client) => {
      // Check for duplicate IDs
      const incomingIds = events.map((e) => e.id);
      const dupeCheck = await client.query(
        `SELECT id FROM health_events WHERE id = ANY($1::uuid[])`,
        [incomingIds],
      );
      if (dupeCheck.rows.length > 0) {
        const dupeId = dupeCheck.rows[0].id;
        throw new Error(`Append rejected: duplicate HealthEvent.id detected (${dupeId}).`);
      }

      // Evidence integrity check for InsightEvents
      const insightEvents = events.filter(isInsightEvent) as InsightEvent[];
      if (insightEvents.length > 0) {
        const allEvidenceIds = new Set<string>();
        for (const ie of insightEvents) {
          for (const refId of ie.evidenceEventIds) {
            allEvidenceIds.add(refId);
          }
        }

        if (allEvidenceIds.size > 0) {
          // Evidence must reference non-Insight events
          const evidenceCheck = await client.query(
            `SELECT id, event_type FROM health_events
             WHERE user_id = $1 AND id = ANY($2::uuid[])`,
            [userId, [...allEvidenceIds]],
          );

          const knownNonInsightIds = new Set<string>();
          for (const row of evidenceCheck.rows) {
            if (row.event_type !== "Insight") {
              knownNonInsightIds.add(row.id);
            }
          }

          // Also include non-Insight incoming events
          for (const e of events) {
            if (!isInsightEvent(e)) knownNonInsightIds.add(e.id);
          }

          for (const ie of insightEvents) {
            for (const refId of ie.evidenceEventIds) {
              if (!knownNonInsightIds.has(refId)) {
                throw new Error(
                  `InsightEvent append rejected: evidenceEventId "${refId}" is not a non-Insight event (InsightEvent.id: ${ie.id}). Insight-to-Insight evidence chains are forbidden.`,
                );
              }
            }
          }
        }
      }

      // Insert events
      for (const event of events) {
        const row = domainEventToRow(userId, event);
        await client.query(
          `INSERT INTO health_events
            (id, user_id, event_type, timestamp_abs, timestamp_rel, source, confidence,
             visibility, payload, duration, tags, links, notes, review_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            row.id,
            row.user_id,
            row.event_type,
            row.timestamp_abs,
            row.timestamp_rel ? JSON.stringify(row.timestamp_rel) : null,
            row.source,
            row.confidence,
            row.visibility,
            JSON.stringify(row.payload),
            row.duration ? JSON.stringify(row.duration) : null,
            row.tags,
            row.links ? JSON.stringify(row.links) : null,
            row.notes,
            row.review_status,
          ],
        );
      }
    });
  }

  async getEventsByWindow(userId: UserId, window: TimeWindow): Promise<readonly AnyHealthEvent[]> {
    const result = await query<EventRow>(
      `SELECT * FROM health_events
       WHERE user_id = $1
         AND timestamp_abs >= $2
         AND timestamp_abs <= $3
       ORDER BY created_at ASC`,
      [userId, window.startAbsolute, window.endAbsolute],
    );

    return result.rows.map(rowToDomainEvent);
  }

  async getEventsByType<TType extends AnyHealthEventType>(
    userId: UserId,
    eventType: TType,
  ): Promise<readonly Extract<AnyHealthEvent, { eventType: TType }>[]> {
    const result = await query<EventRow>(
      `SELECT * FROM health_events
       WHERE user_id = $1 AND event_type = $2
       ORDER BY created_at ASC`,
      [userId, eventType],
    );

    return result.rows.map(rowToDomainEvent) as Extract<AnyHealthEvent, { eventType: TType }>[];
  }
}
