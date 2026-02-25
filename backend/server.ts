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

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ---- CORS ----
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim())
  : ["*"];

app.use(cors({
  origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json({ limit: "1mb" }));

// ---- Repository singleton ----
const repo = getTimelineRepository();

// ---- Async error wrapper ----
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// ===============================
// GET /api/health
// ===============================
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ===============================
// GET /api/timeline/:userId
// ===============================
app.get("/api/timeline/:userId", asyncHandler(async (req, res) => {
  const userId: UserId = req.params.userId;
  const snapshot = await repo.getTimeline(userId);
  res.json(snapshot);
}));

// ===============================
// POST /api/timeline/:userId/events
// ===============================
app.post("/api/timeline/:userId/events", asyncHandler(async (req, res) => {
  const userId: UserId = req.params.userId;
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
  res.status(201).json({ appended: events.length });
}));

// ===============================
// POST /api/ai/interpret-symptoms
// ===============================
app.post("/api/ai/interpret-symptoms", asyncHandler(async (req, res) => {
  const body = req.body;
  let symptoms: SymptomEvent[];
  let recentMedications: MedicationEvent[] | undefined;
  let recentLifestyle: LifestyleEvent[] | undefined;

  if (body.userId) {
    const allSymptoms = await repo.getEventsByType(body.userId, HealthEventType.Symptom);
    symptoms = allSymptoms as SymptomEvent[];
    if (symptoms.length === 0) {
      res.status(400).json({ error: "No symptom events found for this user." });
      return;
    }
    const allMeds = await repo.getEventsByType(body.userId, HealthEventType.Medication);
    recentMedications = allMeds as MedicationEvent[];
    const allLifestyle = await repo.getEventsByType(body.userId, HealthEventType.Lifestyle);
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
app.post("/api/ai/health-patterns", asyncHandler(async (req, res) => {
  const { userId, window: tw } = req.body;

  if (!userId || !tw?.startAbsolute || !tw?.endAbsolute) {
    res.status(400).json({ error: "Provide 'userId' and 'window' with startAbsolute/endAbsolute." });
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
app.post("/api/ai/specializations", asyncHandler(async (req, res) => {
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
app.post("/api/ai/doctor-visit-summary", asyncHandler(async (req, res) => {
  const { userId, window: tw } = req.body;

  if (!userId || !tw?.startAbsolute || !tw?.endAbsolute) {
    res.status(400).json({ error: "Provide 'userId' and 'window' with startAbsolute/endAbsolute." });
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
app.post("/api/ai/chat", asyncHandler(async (req, res) => {
  const { userId, message } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Provide a non-empty 'message' string." });
    return;
  }

  const uid: UserId = userId || "demo-user";
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

// ---- Seed demo events ----
async function seedDemoEvents(): Promise<void> {
  const DEMO_USER: UserId = "demo-user";
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const demoEvents: AnyHealthEvent[] = [
    {
      id: "demo-sym-1",
      eventType: HealthEventType.Symptom,
      timestamp: { absolute: new Date(now - 2 * DAY).toISOString() },
      source: EventSource.User,
      confidence: "medium",
      visibilityScope: VisibilityScope.UserOnly,
      description: "Mild headache after waking up",
      intensity: "Moderate",
    } as SymptomEvent,
    {
      id: "demo-sym-2",
      eventType: HealthEventType.Symptom,
      timestamp: { absolute: new Date(now - 4 * DAY).toISOString() },
      source: EventSource.User,
      confidence: "medium",
      visibilityScope: VisibilityScope.UserOnly,
      description: "Feeling fatigued in the afternoon",
      intensity: "High",
      userReportedContext: "poor sleep; high stress",
    } as SymptomEvent,
    {
      id: "demo-med-1",
      eventType: HealthEventType.Medication,
      timestamp: { absolute: new Date(now - 1 * DAY).toISOString() },
      source: EventSource.User,
      confidence: "high",
      visibilityScope: VisibilityScope.UserOnly,
      name: "Daily Vitamins",
      dosage: "1 tablet",
      intendedSchedule: "once daily",
      adherenceOutcome: "taken",
    } as MedicationEvent,
    {
      id: "demo-life-1",
      eventType: HealthEventType.Lifestyle,
      timestamp: { absolute: new Date(now - 3 * DAY).toISOString() },
      source: EventSource.User,
      confidence: "low",
      visibilityScope: VisibilityScope.UserOnly,
      sleep: "~5.5h",
      stress: "high",
      activity: "30 min morning walk",
      food: "irregular meals",
    } as LifestyleEvent,
    {
      id: "demo-clin-1",
      eventType: HealthEventType.Clinical,
      timestamp: { absolute: new Date(now - 10 * DAY).toISOString() },
      source: EventSource.Doctor,
      confidence: "high",
      visibilityScope: VisibilityScope.DoctorShareable,
      doctorVisit: "Routine check-up",
    } as ClinicalEvent,
  ];

  try {
    await repo.appendEvents(DEMO_USER, demoEvents);
    console.log(`[HealthIQ] Seeded ${demoEvents.length} demo events for user "demo-user".`);
  } catch {
    console.log("[HealthIQ] Demo seed skipped (events may already exist).");
  }
}

// ---- Start server ----
seedDemoEvents().then(() => {
  app.listen(PORT, () => {
    console.log(`[HealthIQ] Server running on http://localhost:${PORT}`);
    console.log(`[HealthIQ] API health check: http://localhost:${PORT}/api/health`);
  });
});
