import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

// Load .env before any module that reads process.env.
// Resolve from deterministic locations so startup cwd does not matter.
const envPathCandidates = [
  pathResolve(__dirname, "..", ".env"),
  pathResolve(__dirname, "..", "..", ".env"),
  pathResolve(process.cwd(), ".env"),
];

const resolvedEnvPath = envPathCandidates.find((p) => existsSync(p));
if (resolvedEnvPath) {
  dotenv.config({ path: resolvedEnvPath });
} else {
  dotenv.config();
}

import { getTimelineRepository } from "./repository/RepositoryFactory";
import type { UserId } from "./repository/TimelineRepository";
import type { AnyHealthEvent, TimeWindow } from "./domain/HealthTimeline";
import { HealthEventType } from "./domain/HealthEvent";
import { EventSource } from "./domain/EventSource";
import { VisibilityScope } from "./domain/VisibilityScope";
import type { SymptomEvent } from "./domain/SymptomEvent";
import type { MedicationEvent } from "./domain/MedicationEvent";
import type { LifestyleEvent } from "./domain/LifestyleEvent";
import type { ClinicalEvent } from "./domain/ClinicalEvent";

import { interpretSymptoms } from "./ai/SymptomInterpreter";
import { analyzeHealthPatterns } from "./ai/HealthPatternAnalyzer";
import { suggestMedicalSpecializations } from "./ai/SpecializationSuggester";
import { summarizeDoctorVisit } from "./ai/DoctorVisitSummarizer";
import { handleHealthChat } from "./ai/HealthChatHandler";

// v2 middleware
import { authMiddleware, handleTokenRequest, handleTokenRefresh, ensureDevice } from "./middleware/auth";
import { generalRateLimiter, aiRateLimiter, eventCreationRateLimiter } from "./middleware/rateLimiter";
import { auditMiddleware } from "./middleware/audit";

// v2 analytics
import { computeHSI, saveHSISnapshot, getLatestHSI, getHSIHistory } from "./analytics/HSIScorer";
import { processEventForGraph, getGraphSummary } from "./analytics/HealthGraphBuilder";
import { evaluateAlerts, computeRiskLevel, generateBehavioralSuggestions } from "./analytics/AlertEngine";
import type { UserAlert } from "./analytics/AlertEngine";
import { getActiveAlerts, acknowledgeAlert, saveAlert } from "./analytics/AlertEngine";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ---- CORS ----
const DEFAULT_ORIGINS = [
  "https://healthiq.sentiqlabs.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:3001",
];

const ALLOWED_ORIGINS: string[] = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;

console.log("[HealthIQ v2] CORS allowed origins:", ALLOWED_ORIGINS);

app.use(cors({
  origin(requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean | string) => void) {
    // Allow server-to-server / curl / health-pings (no Origin header)
    if (!requestOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(requestOrigin)) {
      return callback(null, requestOrigin);
    }
    console.warn(`[CORS] Blocked request from origin: ${requestOrigin}`);
    callback(new Error(`Origin ${requestOrigin} not allowed by CORS`));
  },
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

// Explicit preflight handling for all routes
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

// ---- Privacy headers (prevent response caching of health data) ----
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ---- v2 middleware stack ----
app.use(generalRateLimiter);
app.use(authMiddleware);
app.use(auditMiddleware);

// ---- Repository singleton ----
const repo = getTimelineRepository();

// ---- UserId validation helper (Privacy-critical) ----
function validateUserId(userId: string | undefined): UserId | null {
  if (!userId || typeof userId !== "string") return null;
  const trimmed = userId.trim();
  // Reject empty, 'demo-user', 'undefined', 'null', or suspiciously short IDs
  if (!trimmed || trimmed.length < 8 || trimmed === "demo-user" || trimmed === "undefined" || trimmed === "null") {
    return null;
  }
  return trimmed;
}

// ---- Async error wrapper ----
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// =========================================================================
// v2 Analytics pipeline — runs after event append
// =========================================================================
async function runAnalyticsPipeline(userId: string, newEvents: readonly AnyHealthEvent[]): Promise<void> {
  try {
    // 1. Get full timeline for graph co-occurrence context
    const snapshot = await repo.getTimeline(userId);

    // 2. Build / update health graph with new events
    for (const event of newEvents) {
      await processEventForGraph(userId, event, snapshot.events);
    }
    const allEvents = snapshot.events;

    // 3. Compute HSI
    const hsi = computeHSI(allEvents);
    await saveHSISnapshot(userId, hsi);

    // 5. Get previous HSI for delta comparison
    const history = await getHSIHistory(userId, 2);
    const previousHSI = history.length >= 2 ? history[1] : null;

    // 6. Get graph summary for co-occurrence check
    const graphSummary = await getGraphSummary(userId, 10);

    // 7. Evaluate alert rules
    const alerts = evaluateAlerts({
      userId,
      currentHSI: hsi,
      previousHSI,
      events: allEvents,
      graphSummary,
    });

    // 8. Persist new alerts
    for (const alert of alerts) {
      await saveAlert(alert);
    }

    if (alerts.length > 0) {
      console.log(`[Analytics] ${alerts.length} alert(s) triggered for user ${userId.slice(0, 8)}...`);
    }
  } catch (err) {
    // Analytics pipeline failures must never block event writes
    console.error("[Analytics Pipeline Error]", (err as Error).message);
  }
}

// ===============================
// GET /api/health
// ===============================
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    features: ["hsi", "health-graph", "alerts", "risk-stratification"],
  });
});

// ===============================
// POST /api/auth/token  — v2 device registration
// ===============================
app.post("/api/auth/token", asyncHandler(async (req, res) => {
  await handleTokenRequest(req, res);
}));

// ===============================
// POST /api/auth/refresh — v2 token refresh
// ===============================
app.post("/api/auth/refresh", asyncHandler(async (req, res) => {
  await handleTokenRefresh(req, res);
}));

// ===============================
// GET /api/timeline/:userId
// ===============================
app.get("/api/timeline/:userId", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required. 'demo-user' is no longer accepted." });
    return;
  }
  const snapshot = await repo.getTimeline(userId);
  res.json(snapshot);
}));

// ===============================
// POST /api/timeline/:userId/events
// ===============================
app.post("/api/timeline/:userId/events", eventCreationRateLimiter, asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required. 'demo-user' is no longer accepted." });
    return;
  }
  const body = req.body;

  let events: AnyHealthEvent[];
  if (Array.isArray(body.events)) {
    events = body.events;
  } else if (body.event && typeof body.event === "object") {
    events = [body.event];
  } else {
    res.status(400).json({ error: "Request body must contain 'events' array or 'event' object." });
    return;
  }

  if (events.length === 0) {
    res.status(400).json({ error: "No events provided." });
    return;
  }

  for (const e of events) {
    if (!e.id || typeof e.id !== "string") {
      res.status(400).json({ error: "Each event must have a string 'id'." });
      return;
    }
    if (!e.eventType || !Object.values(HealthEventType).includes(e.eventType as HealthEventType)) {
      res.status(400).json({ error: `Invalid eventType: ${e.eventType}. Must be one of: ${Object.values(HealthEventType).join(", ")}` });
      return;
    }
    if (!e.timestamp?.absolute) {
      res.status(400).json({ error: `Event ${e.id} must have timestamp.absolute.` });
      return;
    }
  }

  await repo.appendEvents(userId, events);

  // Fire analytics pipeline asynchronously (non-blocking)
  runAnalyticsPipeline(userId, events).catch((err) =>
    console.error("[Analytics] post-append pipeline error:", err),
  );

  res.status(201).json({ appended: events.length });
}));

// ===============================
// GET /api/hsi/:userId — current Health Stability Index
// ===============================
app.get("/api/hsi/:userId", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const latest = await getLatestHSI(userId);
  if (!latest) {
    // Compute on-demand if no snapshot exists yet
    const snapshot = await repo.getTimeline(userId);
    if (snapshot.events.length === 0) {
      res.status(404).json({ error: "No health events found. Log events to compute your HSI." });
      return;
    }
    const hsi = computeHSI(snapshot.events);
    await saveHSISnapshot(userId, hsi);
    res.json(hsi);
    return;
  }

  res.json(latest);
}));

// ===============================
// GET /api/hsi/:userId/history — HSI trend over time
// ===============================
app.get("/api/hsi/:userId/history", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const history = await getHSIHistory(userId, limit);
  res.json({ userId, history, count: history.length });
}));

// ===============================
// GET /api/graph/:userId/summary — health concept graph summary
// ===============================
app.get("/api/graph/:userId/summary", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const topN = Math.min(parseInt(req.query.topN as string) || 15, 50);
  const summary = await getGraphSummary(userId, topN);
  res.json(summary);
}));

// ===============================
// GET /api/alerts/:userId — active alerts
// ===============================
app.get("/api/alerts/:userId", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const alerts = await getActiveAlerts(userId);
  res.json({ userId, alerts, count: alerts.length });
}));

// ===============================
// POST /api/alerts/:userId/:alertId/acknowledge
// ===============================
app.post("/api/alerts/:userId/:alertId/acknowledge", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const { alertId } = req.params;
  if (!alertId) {
    res.status(400).json({ error: "Alert ID required." });
    return;
  }

  const acknowledged = await acknowledgeAlert(userId, alertId);
  if (!acknowledged) {
    res.status(404).json({ error: "Alert not found or already acknowledged." });
    return;
  }

  res.json({ acknowledged: true });
}));

// ===============================
// GET /api/status/:userId — full health status dashboard
// ===============================
app.get("/api/status/:userId", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  // Gather all v2 analytics in parallel
  const [latestHSI, activeAlerts, graphSummary, snapshot] = await Promise.all([
    getLatestHSI(userId),
    getActiveAlerts(userId),
    getGraphSummary(userId, 10),
    repo.getTimeline(userId),
  ]);

  // Compute HSI on-demand if missing
  let hsi = latestHSI;
  if (!hsi && snapshot.events.length > 0) {
    hsi = computeHSI(snapshot.events);
    await saveHSISnapshot(userId, hsi);
  }

  if (!hsi) {
    res.json({
      userId,
      coldStart: true,
      eventCount: snapshot.events.length,
      message: "Not enough data to compute health status. Continue logging health events.",
    });
    return;
  }

  // Risk level
  const risk = computeRiskLevel(hsi, activeAlerts);

  // Behavioral suggestions
  const suggestions = generateBehavioralSuggestions(hsi, activeAlerts, graphSummary);

  res.json({
    userId,
    coldStart: false,
    hsi: {
      score: Math.round(hsi.score * 10) / 10,
      dataConfidence: hsi.dataConfidence,
      symptomRegularity: Math.round(hsi.symptomRegularity * 10) / 10,
      behavioralConsistency: Math.round(hsi.behavioralConsistency * 10) / 10,
      trajectoryDirection: Math.round(hsi.trajectoryDirection * 10) / 10,
      computedAt: hsi.computedAt,
    },
    risk,
    alerts: {
      active: activeAlerts.slice(0, 10),
      count: activeAlerts.length,
    },
    graph: {
      topConcepts: graphSummary.topConcepts.slice(0, 5),
      strongestEdges: graphSummary.strongestEdges.slice(0, 5),
    },
    suggestions,
    eventCount: snapshot.events.length,
  });
}));

// ===============================
// POST /api/ai/interpret-symptoms
// ===============================
app.post("/api/ai/interpret-symptoms", aiRateLimiter, asyncHandler(async (req, res) => {
  const body = req.body;
  let symptoms: SymptomEvent[];
  let recentMedications: MedicationEvent[] | undefined;
  let recentLifestyle: LifestyleEvent[] | undefined;

  if (body.userId) {
    const validatedUid = validateUserId(body.userId);
    if (!validatedUid) {
      res.status(400).json({ error: "Valid userId required. 'demo-user' is no longer accepted." });
      return;
    }
    const allSymptoms = await repo.getEventsByType(validatedUid, HealthEventType.Symptom);
    symptoms = allSymptoms as SymptomEvent[];
    if (symptoms.length === 0) {
      res.status(400).json({ error: "No symptom events found for this user." });
      return;
    }
    const allMeds = await repo.getEventsByType(validatedUid, HealthEventType.Medication);
    recentMedications = allMeds as MedicationEvent[];
    const allLifestyle = await repo.getEventsByType(validatedUid, HealthEventType.Lifestyle);
    recentLifestyle = allLifestyle as LifestyleEvent[];
  } else if (Array.isArray(body.symptoms) && body.symptoms.length > 0) {
    symptoms = body.symptoms;
    recentMedications = body.recentMedications;
    recentLifestyle = body.recentLifestyle;
  } else {
    res.status(400).json({ error: "Provide 'userId' or non-empty 'symptoms' array." });
    return;
  }

  const draft = await interpretSymptoms({ symptoms, recentMedications, recentLifestyle });
  res.json(draft);
}));

// ===============================
// POST /api/ai/health-patterns
// ===============================
app.post("/api/ai/health-patterns", aiRateLimiter, asyncHandler(async (req, res) => {
  const { userId: rawUserId, window: tw } = req.body;
  const userId = validateUserId(rawUserId);

  if (!userId || !tw?.startAbsolute || !tw?.endAbsolute) {
    res.status(400).json({ error: "Provide valid 'userId' and 'window' with startAbsolute/endAbsolute." });
    return;
  }

  const events = await repo.getEventsByWindow(userId, tw as TimeWindow);
  if (events.length === 0) {
    res.status(400).json({ error: "No events found in the specified time window." });
    return;
  }

  const draft = await analyzeHealthPatterns({ timelineSlice: events as AnyHealthEvent[], window: tw });
  res.json(draft);
}));

// ===============================
// POST /api/ai/specializations
// ===============================
app.post("/api/ai/specializations", aiRateLimiter, asyncHandler(async (req, res) => {
  const { symptomLabels, insights } = req.body;

  if (!Array.isArray(symptomLabels) || symptomLabels.length === 0) {
    res.status(400).json({ error: "Provide non-empty 'symptomLabels' array." });
    return;
  }

  const draft = await suggestMedicalSpecializations({ symptomLabels, insights });
  res.json(draft);
}));

// ===============================
// POST /api/ai/doctor-visit-summary
// ===============================
app.post("/api/ai/doctor-visit-summary", aiRateLimiter, asyncHandler(async (req, res) => {
  const { userId: rawUserId, window: tw } = req.body;
  const userId = validateUserId(rawUserId);

  if (!userId || !tw?.startAbsolute || !tw?.endAbsolute) {
    res.status(400).json({ error: "Provide valid 'userId' and 'window' with startAbsolute/endAbsolute." });
    return;
  }

  const events = await repo.getEventsByWindow(userId, tw as TimeWindow);
  if (events.length === 0) {
    res.status(400).json({ error: "No events found in the specified time window." });
    return;
  }

  const draft = await summarizeDoctorVisit({ window: tw, relevantEvents: events as AnyHealthEvent[] });
  res.json(draft);
}));

// ===============================
// POST /api/ai/chat
// ===============================
app.post("/api/ai/chat", aiRateLimiter, asyncHandler(async (req, res) => {
  const { userId: rawUserId, message } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Provide a non-empty 'message' string." });
    return;
  }

  const uid = validateUserId(rawUserId);
  if (!uid) {
    res.status(400).json({ error: "Valid userId required. Each device must provide its unique identifier." });
    return;
  }
  const snapshot = await repo.getTimeline(uid);
  const recentEvents = snapshot.events.slice(-20);

  const chatResponse = await handleHealthChat({
    userMessage: message.trim(),
    recentEvents,
  });

  res.json(chatResponse);
}));

// ---- Global error handler ----
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[HealthIQ Server Error]", err.message);
  res.status(500).json({ error: err.message || "Internal server error." });
});

// ---- Graceful shutdown ----
async function shutdown(signal: string) {
  console.log(`[HealthIQ] ${signal} received — shutting down gracefully`);
  try {
    const { closeDatabasePool } = await import("./database/connection");
    await closeDatabasePool();
  } catch { /* no DB pool to close */ }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---- Start server ----
// No demo seed — timeline starts empty. Users add events via the frontend.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HealthIQ v2] Server running on port ${PORT}`);
  console.log(`[HealthIQ v2] API health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`[HealthIQ v2] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[HealthIQ v2] Database: ${process.env.DATABASE_URL ? "PostgreSQL" : "In-memory"}`);
  console.log(`[HealthIQ v2] Auth: ${process.env.DISABLE_AUTH ? "DISABLED (dev mode)" : "JWT enabled"}`);
});
