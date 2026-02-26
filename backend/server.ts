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

console.log("[HealthIQ] CORS allowed origins:", ALLOWED_ORIGINS);

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
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
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
app.post("/api/timeline/:userId/events", asyncHandler(async (req, res) => {
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
app.post("/api/ai/health-patterns", asyncHandler(async (req, res) => {
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
app.post("/api/ai/chat", asyncHandler(async (req, res) => {
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

// ---- Start server ----
// No demo seed — timeline starts empty. Users add events via the frontend.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HealthIQ] Server running on port ${PORT}`);
  console.log(`[HealthIQ] API health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`[HealthIQ] Environment: ${process.env.NODE_ENV || "development"}`);
});
