import type { AnyHealthEvent } from "../domain/HealthTimeline";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import { HealthEventType } from "../domain/HealthEvent";
import { query } from "../database/connection";

// =========================================================================
// HealthIQ v2 — Health Stability Index (HSI) Scoring Engine
//
// Composite score (0–100) representing health trajectory stability.
// Three sub-dimensions:
//   1. Symptom Regularity (40%) — variance in symptom frequency/severity
//   2. Behavioral Consistency (30%) — medication adherence + lifestyle regularity
//   3. Trajectory Direction (30%) — is symptom burden improving or worsening?
//
// DETERMINISTIC: No LLM required. Pure TypeScript computation.
// =========================================================================

export interface HSIScore {
  score: number;                      // 0–100
  symptomRegularity: number;          // 0–100
  behavioralConsistency: number;      // 0–100
  trajectoryDirection: number;        // 0–100
  windowDays: number;
  dataConfidence: "low" | "medium" | "high";
  contributingEventIds: string[];
  computedAt: string;                 // ISO timestamp
}

export interface HSIHistory {
  userId: string;
  snapshots: HSIScore[];
}

// --- Utility ---

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

function isoToDate(iso: string): Date {
  return new Date(iso);
}

function groupByDay(events: readonly { timestamp: { absolute: string } }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of events) {
    const day = e.timestamp.absolute.substring(0, 10); // YYYY-MM-DD
    map.set(day, (map.get(day) || 0) + 1);
  }
  return map;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  return standardDeviation(values) / Math.abs(mean);
}

function linearRegressionSlope(values: number[]): number {
  // Least-squares linear regression slope.
  // x = index, y = value
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}

// --- Intensity parsing ---

function parseIntensity(intensity?: string): number | null {
  if (!intensity) return null;

  // Try numeric extraction (e.g., "7/10", "7", "7.5")
  const numMatch = intensity.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    // Normalize to 0-10 scale
    if (val <= 10) return val;
    if (val <= 100) return val / 10;
    return null;
  }

  // Keyword mapping
  const lower = intensity.toLowerCase().trim();
  const map: Record<string, number> = {
    "none": 0, "minimal": 1, "very mild": 1.5, "mild": 2, "slight": 2.5,
    "moderate": 5, "medium": 5, "significant": 6, "strong": 7,
    "severe": 8, "very severe": 9, "extreme": 9.5, "unbearable": 10, "worst": 10,
  };

  return map[lower] ?? null;
}

// =========================================================================
// Sub-scorers
// =========================================================================

/**
 * Symptom Regularity (40% weight)
 * Higher score = more regular/stable symptom patterns.
 * Measures: coefficient of variation of daily symptom counts,
 * new symptom rate, intensity stability.
 */
export function computeSymptomRegularity(
  symptomEvents: readonly SymptomEvent[],
  windowDays: number,
): number {
  if (symptomEvents.length === 0) return 80; // No symptoms = good baseline

  // Daily symptom counts
  const dailyCounts = groupByDay(symptomEvents);
  const countValues = Array.from(dailyCounts.values());

  // Fill in zero-count days
  const totalDays = Math.max(windowDays, 1);
  const zeroDays = totalDays - countValues.length;
  for (let i = 0; i < zeroDays; i++) countValues.push(0);

  // Coefficient of variation of daily counts (lower = more regular)
  const cv = coefficientOfVariation(countValues);
  // Map CV to score: CV=0 → 100, CV=2+ → 20
  const cvScore = Math.max(20, Math.min(100, 100 - cv * 40));

  // Intensity stability (if available)
  const intensities = symptomEvents
    .map((e) => parseIntensity(e.intensity))
    .filter((v): v is number => v !== null);

  let intensityScore = 70; // neutral default
  if (intensities.length >= 3) {
    const intensityCV = coefficientOfVariation(intensities);
    intensityScore = Math.max(20, Math.min(100, 100 - intensityCV * 50));
  }

  // Unique symptom diversity penalty
  const uniqueDescriptions = new Set(symptomEvents.map((e) => e.description.toLowerCase().trim()));
  const diversityPenalty = Math.min(30, uniqueDescriptions.size * 5);

  const raw = cvScore * 0.5 + intensityScore * 0.3 + (100 - diversityPenalty) * 0.2;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Behavioral Consistency (30% weight)
 * Measures medication adherence and lifestyle logging regularity.
 */
export function computeBehavioralConsistency(
  medicationEvents: readonly MedicationEvent[],
  lifestyleEvents: readonly LifestyleEvent[],
  windowDays: number,
): number {
  let adherenceScore = 70; // neutral
  let lifestyleScore = 70; // neutral

  // Medication adherence
  if (medicationEvents.length > 0) {
    const taken = medicationEvents.filter((e) => e.adherenceOutcome === "taken").length;
    const total = medicationEvents.length;
    const adherenceRate = taken / total;
    adherenceScore = Math.round(adherenceRate * 100);
  }

  // Lifestyle logging regularity
  if (lifestyleEvents.length > 0 && windowDays > 0) {
    const loggingDays = groupByDay(lifestyleEvents).size;
    const regularity = Math.min(1, loggingDays / Math.max(1, windowDays));
    lifestyleScore = Math.round(regularity * 100);
  }

  // Weighted combination
  const hasMeds = medicationEvents.length > 0;
  const hasLifestyle = lifestyleEvents.length > 0;

  if (hasMeds && hasLifestyle) {
    return Math.round(adherenceScore * 0.6 + lifestyleScore * 0.4);
  } else if (hasMeds) {
    return adherenceScore;
  } else if (hasLifestyle) {
    return lifestyleScore;
  }

  return 70; // neutral when no data
}

/**
 * Trajectory Direction (30% weight)
 * Linear regression on daily symptom burden over the window.
 * Negative slope = improving (higher score). Positive slope = worsening (lower score).
 */
export function computeTrajectoryDirection(
  symptomEvents: readonly SymptomEvent[],
  windowDays: number,
): number {
  if (symptomEvents.length < 3) return 60; // neutral with insufficient data

  // Compute daily symptom burden: count × average intensity
  const dailyBurden = new Map<string, { count: number; totalIntensity: number }>();

  for (const e of symptomEvents) {
    const day = e.timestamp.absolute.substring(0, 10);
    const current = dailyBurden.get(day) || { count: 0, totalIntensity: 0 };
    current.count += 1;
    const intensity = parseIntensity(e.intensity) ?? 5; // default moderate
    current.totalIntensity += intensity;
    dailyBurden.set(day, current);
  }

  // Sort by date and compute burden values
  const sortedDays = Array.from(dailyBurden.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const burdenValues = sortedDays.map(([, d]) => d.count * (d.totalIntensity / d.count));

  // Linear regression slope
  const slope = linearRegressionSlope(burdenValues);

  // Map slope to score:
  // slope < -0.5 → 90+ (strongly improving)
  // slope ≈ 0 → 60 (stable)
  // slope > 0.5 → 30- (worsening)
  const slopeScore = Math.max(10, Math.min(95, 60 - slope * 60));

  return Math.round(slopeScore);
}

// =========================================================================
// Main HSI Computation
// =========================================================================

export function computeHSI(
  events: readonly AnyHealthEvent[],
  windowDays: number = 30,
): HSIScore {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Filter events within window
  const windowEvents = events.filter((e) => {
    const eventDate = isoToDate(e.timestamp.absolute);
    return eventDate >= windowStart && eventDate <= now;
  });

  const symptomEvents = windowEvents.filter(
    (e): e is SymptomEvent => e.eventType === HealthEventType.Symptom,
  );
  const medicationEvents = windowEvents.filter(
    (e): e is MedicationEvent => e.eventType === HealthEventType.Medication,
  );
  const lifestyleEvents = windowEvents.filter(
    (e): e is LifestyleEvent => e.eventType === HealthEventType.Lifestyle,
  );

  // Compute sub-scores
  const symptomRegularity = computeSymptomRegularity(symptomEvents, windowDays);
  const behavioralConsistency = computeBehavioralConsistency(medicationEvents, lifestyleEvents, windowDays);
  const trajectoryDirection = computeTrajectoryDirection(symptomEvents, windowDays);

  // Weighted composite
  const score = Math.round(
    symptomRegularity * 0.4 +
    behavioralConsistency * 0.3 +
    trajectoryDirection * 0.3,
  );

  // Data confidence
  const eventTypes = new Set(windowEvents.map((e) => e.eventType));
  const dataSpanDays = windowEvents.length > 1
    ? daysBetween(
        isoToDate(windowEvents[0].timestamp.absolute),
        isoToDate(windowEvents[windowEvents.length - 1].timestamp.absolute),
      )
    : 0;

  let dataConfidence: "low" | "medium" | "high" = "low";
  if (windowEvents.length >= 30 && eventTypes.size >= 3 && dataSpanDays >= 21) {
    dataConfidence = "high";
  } else if (windowEvents.length >= 15 && eventTypes.size >= 2 && dataSpanDays >= 14) {
    dataConfidence = "medium";
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    symptomRegularity,
    behavioralConsistency,
    trajectoryDirection,
    windowDays,
    dataConfidence,
    contributingEventIds: windowEvents.map((e) => e.id),
    computedAt: now.toISOString(),
  };
}

// =========================================================================
// Persistence: Save/Retrieve HSI snapshots
// =========================================================================

export async function saveHSISnapshot(userId: string, hsi: HSIScore): Promise<void> {
  if (!process.env.DATABASE_URL) return; // Skip in in-memory mode

  await query(
    `INSERT INTO hsi_snapshots
      (user_id, computed_at, score, symptom_regularity, behavioral_consistency,
       trajectory_direction, window_days, contributing_event_ids, data_confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      userId,
      hsi.computedAt,
      hsi.score,
      hsi.symptomRegularity,
      hsi.behavioralConsistency,
      hsi.trajectoryDirection,
      hsi.windowDays,
      hsi.contributingEventIds,
      hsi.dataConfidence,
    ],
  );
}

export async function getHSIHistory(
  userId: string,
  limit: number = 30,
): Promise<HSIScore[]> {
  if (!process.env.DATABASE_URL) return []; // No history in in-memory mode

  const result = await query(
    `SELECT * FROM hsi_snapshots
     WHERE user_id = $1
     ORDER BY computed_at DESC
     LIMIT $2`,
    [userId, limit],
  );

  return result.rows.map((row: any) => ({
    score: row.score,
    symptomRegularity: row.symptom_regularity,
    behavioralConsistency: row.behavioral_consistency,
    trajectoryDirection: row.trajectory_direction,
    windowDays: row.window_days,
    dataConfidence: row.data_confidence,
    contributingEventIds: row.contributing_event_ids || [],
    computedAt: row.computed_at,
  }));
}

export async function getLatestHSI(userId: string): Promise<HSIScore | null> {
  const history = await getHSIHistory(userId, 1);
  return history.length > 0 ? history[0] : null;
}
