import type { AnyHealthEvent } from "../domain/HealthTimeline";
import { HealthEventType } from "../domain/HealthEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";
import { query } from "../database/connection";
import type { HSIScore } from "./HSIScorer";
import type { GraphSummary } from "./HealthGraphBuilder";

// =========================================================================
// HealthIQ v2 — Alert Engine
//
// Evaluates built-in alert rules against a user's health state.
// Fires after each HSI computation.
//
// Rules are TEMPLATE-DRIVEN, not LLM-generated.
// LLM provides supplementary explanation only (triggered separately).
//
// Alert severity levels:
//   info     — informational, no action needed
//   warning  — monitor closely, consider seeking patterns
//   attention — review recommended, auto-trigger pattern analysis
// =========================================================================

export type AlertSeverity = "info" | "warning" | "attention";

export interface AlertRule {
  id: string;
  ruleType: string;
  threshold: Record<string, unknown>;
  severity: AlertSeverity;
  enabled: boolean;
  description: string;
}

export interface UserAlert {
  id: string;
  userId: string;
  ruleId: string;
  ruleType: string;
  triggeredAt: string;
  severity: AlertSeverity;
  title: string;
  explanation: string;
  evidenceIds: string[];
  acknowledged: boolean;
  acknowledgedAt?: string;
}

export interface AlertEvaluationContext {
  userId: string;
  currentHSI: HSIScore;
  previousHSI?: HSIScore | null;
  events: readonly AnyHealthEvent[];
  graphSummary?: GraphSummary;
}

// =========================================================================
// Built-in alert evaluation rules
// =========================================================================

function evaluateHSIDrop(ctx: AlertEvaluationContext): UserAlert | null {
  if (!ctx.previousHSI) return null;

  const delta = ctx.currentHSI.score - ctx.previousHSI.score;
  if (delta >= -9) return null; // Less than 10-point drop

  return {
    id: "", // Will be set on save
    userId: ctx.userId,
    ruleId: "", // Will be resolved
    ruleType: "hsi_drop",
    triggeredAt: new Date().toISOString(),
    severity: "warning",
    title: "Health Stability Index declined significantly",
    explanation: `Your Health Stability Index dropped from ${Math.round(ctx.previousHSI.score)} to ${Math.round(ctx.currentHSI.score)} (${Math.round(delta)} points) over the past week. This may reflect changes in your symptom patterns, medication adherence, or lifestyle factors.`,
    evidenceIds: ctx.currentHSI.contributingEventIds.slice(0, 10),
    acknowledged: false,
  };
}

function evaluateNewSymptomCluster(ctx: AlertEvaluationContext): UserAlert | null {
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;

  const symptomEvents = ctx.events.filter(
    (e): e is SymptomEvent => e.eventType === HealthEventType.Symptom,
  );

  // Symptoms in last 14 days
  const recentSymptoms = new Set<string>();
  const recentEventIds: string[] = [];
  for (const e of symptomEvents) {
    const t = new Date(e.timestamp.absolute).getTime();
    if (t >= fourteenDaysAgo) {
      recentSymptoms.add(e.description.toLowerCase().trim());
      recentEventIds.push(e.id);
    }
  }

  // Symptoms in 60-day lookback (excluding last 14 days)
  const olderSymptoms = new Set<string>();
  for (const e of symptomEvents) {
    const t = new Date(e.timestamp.absolute).getTime();
    if (t >= sixtyDaysAgo && t < fourteenDaysAgo) {
      olderSymptoms.add(e.description.toLowerCase().trim());
    }
  }

  // Count NEW symptoms not seen in older window
  const newSymptoms = [...recentSymptoms].filter((s) => !olderSymptoms.has(s));
  if (newSymptoms.length < 3) return null;

  return {
    id: "",
    userId: ctx.userId,
    ruleId: "",
    ruleType: "new_symptom_cluster",
    triggeredAt: new Date().toISOString(),
    severity: "attention",
    title: `${newSymptoms.length} new symptom types in the past 2 weeks`,
    explanation: `You've reported ${newSymptoms.length} symptom types in the last 14 days that weren't present in the 60 days before that. New symptoms: ${newSymptoms.slice(0, 5).join(", ")}. Consider reviewing your health patterns.`,
    evidenceIds: recentEventIds.slice(0, 10),
    acknowledged: false,
  };
}

function evaluateAdherenceDecline(ctx: AlertEvaluationContext): UserAlert | null {
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

  const recentMeds = ctx.events.filter(
    (e): e is MedicationEvent =>
      e.eventType === HealthEventType.Medication &&
      new Date(e.timestamp.absolute).getTime() >= fourteenDaysAgo,
  );

  if (recentMeds.length < 5) return null; // Not enough data

  const taken = recentMeds.filter((e) => e.adherenceOutcome === "taken").length;
  const adherenceRate = (taken / recentMeds.length) * 100;

  if (adherenceRate >= 70) return null;

  return {
    id: "",
    userId: ctx.userId,
    ruleId: "",
    ruleType: "adherence_decline",
    triggeredAt: new Date().toISOString(),
    severity: "warning",
    title: "Medication adherence has decreased",
    explanation: `Your medication adherence rate over the past 14 days is ${Math.round(adherenceRate)}% (${taken} of ${recentMeds.length} doses taken). Consistent medication use can be important for managing health conditions.`,
    evidenceIds: recentMeds.map((e) => e.id).slice(0, 10),
    acknowledged: false,
  };
}

function evaluateLoggingGap(ctx: AlertEvaluationContext): UserAlert | null {
  if (ctx.events.length < 20) return null; // User not active enough

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const hasRecentEvent = ctx.events.some(
    (e) => new Date(e.timestamp.absolute).getTime() >= sevenDaysAgo,
  );

  if (hasRecentEvent) return null;

  const lastEvent = ctx.events[ctx.events.length - 1];
  const daysSinceLast = Math.round(
    (now - new Date(lastEvent.timestamp.absolute).getTime()) / (1000 * 60 * 60 * 24),
  );

  return {
    id: "",
    userId: ctx.userId,
    ruleId: "",
    ruleType: "logging_gap",
    triggeredAt: new Date().toISOString(),
    severity: "info",
    title: `No health events logged in ${daysSinceLast} days`,
    explanation: `It's been ${daysSinceLast} days since your last health event. Regular logging helps HealthIQ provide better insights and track your health trajectory accurately.`,
    evidenceIds: [],
    acknowledged: false,
  };
}

function evaluateSymptomEscalation(ctx: AlertEvaluationContext): UserAlert | null {
  const symptomEvents = ctx.events.filter(
    (e): e is SymptomEvent => e.eventType === HealthEventType.Symptom,
  );

  if (symptomEvents.length < 3) return null;

  // Group by description
  const byDescription = new Map<string, SymptomEvent[]>();
  for (const e of symptomEvents) {
    const key = e.description.toLowerCase().trim();
    const group = byDescription.get(key) || [];
    group.push(e);
    byDescription.set(key, group);
  }

  // Check for consecutive intensity increases
  for (const [desc, events] of byDescription) {
    if (events.length < 3) continue;

    // Sort chronologically
    const sorted = [...events].sort(
      (a, b) => new Date(a.timestamp.absolute).getTime() - new Date(b.timestamp.absolute).getTime(),
    );

    // Parse intensities
    const intensities: { event: SymptomEvent; value: number }[] = [];
    for (const e of sorted) {
      if (!e.intensity) continue;
      const match = e.intensity.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        intensities.push({ event: e, value: parseFloat(match[1]) });
      }
    }

    // Check last 3+ for consecutive increases
    if (intensities.length >= 3) {
      const last = intensities.slice(-3);
      const allIncreasing = last.every((item, i) =>
        i === 0 || item.value > last[i - 1].value,
      );

      if (allIncreasing) {
        return {
          id: "",
          userId: ctx.userId,
          ruleId: "",
          ruleType: "symptom_escalation",
          triggeredAt: new Date().toISOString(),
          severity: "warning",
          title: `"${desc}" intensity increasing`,
          explanation: `The intensity of "${desc}" has increased across the last ${last.length} occurrences (${last.map((l) => l.value).join(" → ")}). If this trend continues, consider discussing it with a healthcare professional.`,
          evidenceIds: last.map((l) => l.event.id),
          acknowledged: false,
        };
      }
    }
  }

  return null;
}

function evaluateCoOccurrenceSpike(ctx: AlertEvaluationContext): UserAlert | null {
  if (!ctx.graphSummary) return null;

  // Check if any edge weight has doubled recently
  // This is a simplified check — a full implementation would compare current vs historical weights
  const highWeightEdges = ctx.graphSummary.strongestEdges.filter((e) => e.weight >= 4.0);

  if (highWeightEdges.length === 0) return null;

  const topEdge = highWeightEdges[0];
  return {
    id: "",
    userId: ctx.userId,
    ruleId: "",
    ruleType: "co_occurrence_spike",
    triggeredAt: new Date().toISOString(),
    severity: "info",
    title: `Strong health pattern detected`,
    explanation: `A frequent co-occurrence between "${topEdge.sourceConcept || "factor A"}" and "${topEdge.targetConcept || "factor B"}" has been detected (strength: ${topEdge.weight.toFixed(1)}). This pattern may be worth exploring.`,
    evidenceIds: [],
    acknowledged: false,
  };
}

// =========================================================================
// Main alert evaluation
// =========================================================================

export function evaluateAlerts(ctx: AlertEvaluationContext): UserAlert[] {
  const alerts: UserAlert[] = [];

  // Cold start protection: need ≥14 days of data with ≥10 events
  if (ctx.events.length < 10) return alerts;

  const firstEventTime = new Date(ctx.events[0]?.timestamp?.absolute || 0).getTime();
  const daysSinceFirst = (Date.now() - firstEventTime) / (1000 * 60 * 60 * 24);
  if (daysSinceFirst < 14) return alerts;

  // Evaluate each rule
  const hsiDrop = evaluateHSIDrop(ctx);
  if (hsiDrop) alerts.push(hsiDrop);

  const newCluster = evaluateNewSymptomCluster(ctx);
  if (newCluster) alerts.push(newCluster);

  const adherence = evaluateAdherenceDecline(ctx);
  if (adherence) alerts.push(adherence);

  const gap = evaluateLoggingGap(ctx);
  if (gap) alerts.push(gap);

  const escalation = evaluateSymptomEscalation(ctx);
  if (escalation) alerts.push(escalation);

  const spike = evaluateCoOccurrenceSpike(ctx);
  if (spike) alerts.push(spike);

  return alerts;
}

// =========================================================================
// Risk stratification
// =========================================================================

export type RiskLevel = "green" | "yellow" | "orange";

export interface RiskStatus {
  level: RiskLevel;
  hsiScore: number;
  activeAlertCount: number;
  warningCount: number;
  attentionCount: number;
  description: string;
}

export function computeRiskLevel(hsi: HSIScore, activeAlerts: UserAlert[]): RiskStatus {
  const warnings = activeAlerts.filter((a) => a.severity === "warning").length;
  const attentions = activeAlerts.filter((a) => a.severity === "attention").length;
  const totalActive = activeAlerts.filter((a) => !a.acknowledged).length;

  let level: RiskLevel;
  let description: string;

  if (hsi.score < 40 || totalActive >= 3) {
    level = "orange";
    description = "Your health trajectory shows patterns that deserve attention. Consider reviewing your recent health data and discussing changes with a healthcare professional.";
  } else if (hsi.score < 70 || warnings >= 1 || attentions >= 1) {
    level = "yellow";
    description = "Some health patterns have been flagged. HealthIQ is monitoring your trajectory. Consider reviewing the alert details.";
  } else {
    level = "green";
    description = "Your health trajectory appears stable. Continue logging health events for the most accurate tracking.";
  }

  return {
    level,
    hsiScore: hsi.score,
    activeAlertCount: totalActive,
    warningCount: warnings,
    attentionCount: attentions,
    description,
  };
}

// =========================================================================
// Behavioral suggestions (template-driven, NOT LLM-generated)
// =========================================================================

export interface BehavioralSuggestion {
  category: string;
  suggestion: string;
  basedOn: string;
}

export function generateBehavioralSuggestions(
  hsi: HSIScore,
  activeAlerts: UserAlert[],
  graphSummary?: GraphSummary,
): BehavioralSuggestion[] {
  const suggestions: BehavioralSuggestion[] = [];

  // Medication adherence
  if (hsi.behavioralConsistency < 50) {
    const adherenceAlert = activeAlerts.find((a) => a.ruleType === "adherence_decline");
    if (adherenceAlert) {
      suggestions.push({
        category: "medication",
        suggestion: "Your medication consistency has changed recently. Logging medication events can help you and your doctor understand your health trajectory better.",
        basedOn: "Medication adherence scoring",
      });
    }
  }

  // Lifestyle factors
  if (graphSummary) {
    const sleepToSymptom = graphSummary.strongestEdges.find(
      (e) =>
        (e.sourceConcept?.includes("sleep") && e.relation === "temporal_sequence") ||
        (e.targetConcept?.includes("sleep") && e.relation === "temporal_sequence"),
    );

    if (sleepToSymptom) {
      suggestions.push({
        category: "sleep",
        suggestion: "Your recent health patterns suggest sleep consistency may be a factor worth tracking more carefully.",
        basedOn: "Health graph analysis — sleep-symptom correlation",
      });
    }

    const stressToSymptom = graphSummary.strongestEdges.find(
      (e) =>
        (e.sourceConcept?.includes("stress")) ||
        (e.targetConcept?.includes("stress")),
    );

    if (stressToSymptom) {
      suggestions.push({
        category: "stress",
        suggestion: "Stress-related patterns have been observed in your health data. Consider tracking stress levels alongside symptoms for better insight.",
        basedOn: "Health graph analysis — stress correlation",
      });
    }
  }

  // Logging gap
  const gapAlert = activeAlerts.find((a) => a.ruleType === "logging_gap");
  if (gapAlert) {
    suggestions.push({
      category: "engagement",
      suggestion: "Regular health logging improves the accuracy of your Health Stability Index. Even brief daily entries make a difference.",
      basedOn: "Logging gap detection",
    });
  }

  // Symptom escalation
  const escalationAlert = activeAlerts.find((a) => a.ruleType === "symptom_escalation");
  if (escalationAlert) {
    suggestions.push({
      category: "monitoring",
      suggestion: "A symptom shows an increasing trend. Tracking this symptom with consistent intensity ratings will help identify whether the pattern continues.",
      basedOn: "Symptom escalation detection",
    });
  }

  return suggestions;
}

// =========================================================================
// Alert persistence
// =========================================================================

export async function saveAlert(alert: UserAlert): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  // Resolve rule_id from rule_type
  const ruleResult = await query(
    `SELECT id FROM alert_rules WHERE rule_type = $1 LIMIT 1`,
    [alert.ruleType],
  );

  if (ruleResult.rows.length === 0) return;

  const ruleId = ruleResult.rows[0].id;

  // Check for recent duplicate (same user + rule type within 24 hours)
  const dupeCheck = await query(
    `SELECT id FROM user_alerts
     WHERE user_id = $1 AND rule_id = $2
       AND triggered_at > NOW() - INTERVAL '24 hours'
       AND acknowledged = false
     LIMIT 1`,
    [alert.userId, ruleId],
  );

  if (dupeCheck.rows.length > 0) return; // Skip duplicate

  await query(
    `INSERT INTO user_alerts (user_id, rule_id, triggered_at, severity, title, explanation, evidence_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      alert.userId,
      ruleId,
      alert.triggeredAt,
      alert.severity,
      alert.title,
      alert.explanation,
      alert.evidenceIds,
    ],
  );
}

export async function getActiveAlerts(userId: string): Promise<UserAlert[]> {
  if (!process.env.DATABASE_URL) return [];

  const result = await query(
    `SELECT ua.*, ar.rule_type
     FROM user_alerts ua
     JOIN alert_rules ar ON ua.rule_id = ar.id
     WHERE ua.user_id = $1 AND ua.acknowledged = false
     ORDER BY ua.triggered_at DESC`,
    [userId],
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    ruleId: r.rule_id,
    ruleType: r.rule_type,
    triggeredAt: r.triggered_at,
    severity: r.severity,
    title: r.title,
    explanation: r.explanation,
    evidenceIds: r.evidence_ids || [],
    acknowledged: r.acknowledged,
    acknowledgedAt: r.acknowledged_at,
  }));
}

export async function acknowledgeAlert(userId: string, alertId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  const result = await query(
    `UPDATE user_alerts
     SET acknowledged = true, acknowledged_at = NOW()
     WHERE id = $1 AND user_id = $2 AND acknowledged = false
     RETURNING id`,
    [alertId, userId],
  );

  return result.rows.length > 0;
}
