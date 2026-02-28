import rateLimit from "express-rate-limit";
import type { Request } from "express";

// HealthIQ v2 — Rate Limiting Middleware
//
// Three tiers:
// 1. General API: 100 req/min per device
// 2. AI endpoints: 30 req/min per device
// 3. Event creation: 50 req/hour per device
//
// Key extraction: uses auth payload deviceId, falls back to IP.

function extractKey(req: Request): string {
  // Prefer authenticated device ID for accurate per-user limiting
  if (req.auth?.deviceId) return req.auth.deviceId;
  // Fall back to userId param
  if (req.params.userId) return req.params.userId;
  // Last resort: IP
  return req.ip || req.socket.remoteAddress || "unknown";
}

// General API rate limiter: 100 req/min
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "Too many requests. Please try again later.", retryAfterMs: 60000 },
});

// AI endpoint rate limiter: 30 req/min
export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "AI request limit reached. Please wait before trying again.", retryAfterMs: 60000 },
});

// Event creation rate limiter: 50 req/hour
export const eventCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "Event creation limit reached. Maximum 50 events per hour.", retryAfterMs: 3600000 },
});
