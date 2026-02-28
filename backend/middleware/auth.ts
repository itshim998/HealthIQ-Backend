import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { query } from "../database/connection";

// HealthIQ v2 — JWT Authentication Middleware
//
// Strategy:
// - Phase 1: Device UUID is the primary identity. Server issues JWT on first contact.
// - Phase 2: Optional email-based account upgrade (future).
//
// Token scheme: RS256 hmac with a shared secret (simpler for solo deployment).
// Access token: 15 minutes. Refresh token: 7 days.

const JWT_SECRET = process.env.JWT_SECRET || "healthiq-dev-secret-change-in-production";
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

export interface AuthPayload {
  deviceId: string;
  accountId?: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

// --- Token generation ---

export function generateAccessToken(payload: { deviceId: string; accountId?: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function generateRefreshToken(payload: { deviceId: string; accountId?: string }): string {
  return jwt.sign({ ...payload, type: "refresh" }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

// --- Device registration/lookup ---

export async function ensureDevice(deviceUuid: string): Promise<void> {
  if (!process.env.DATABASE_URL) return; // Skip DB ops in in-memory mode

  await query(
    `INSERT INTO user_devices (device_uuid, last_seen_at)
     VALUES ($1, NOW())
     ON CONFLICT (device_uuid)
     DO UPDATE SET last_seen_at = NOW()`,
    [deviceUuid],
  );
}

// --- Middleware ---

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check and token endpoints
  if (req.path === "/api/health" || req.path === "/api/auth/token" || req.path === "/api/auth/refresh") {
    return next();
  }

  // Also skip if auth is disabled (development mode)
  if (process.env.DISABLE_AUTH === "true") {
    // In dev mode, extract deviceId from the request body or params
    const deviceId = req.params.userId || req.body?.userId;
    if (deviceId) {
      req.auth = { deviceId };
    }
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header. Expected: Bearer <token>" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyToken(token);
    req.auth = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Token expired. Please refresh your token." });
    } else {
      res.status(401).json({ error: "Invalid token." });
    }
  }
}

// --- Token issuance endpoint handler ---

export async function handleTokenRequest(req: Request, res: Response): Promise<void> {
  const { deviceId } = req.body;
  if (!deviceId || typeof deviceId !== "string" || deviceId.trim().length < 8) {
    res.status(400).json({ error: "Valid deviceId required (min 8 characters)." });
    return;
  }

  const trimmed = deviceId.trim();

  // Reject known-bad values
  if (["demo-user", "undefined", "null"].includes(trimmed)) {
    res.status(400).json({ error: "Invalid deviceId." });
    return;
  }

  try {
    await ensureDevice(trimmed);

    const accessToken = generateAccessToken({ deviceId: trimmed });
    const refreshToken = generateRefreshToken({ deviceId: trimmed });

    res.json({
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes in seconds
    });
  } catch (err) {
    console.error("[Auth] Token generation failed:", err);
    res.status(500).json({ error: "Failed to generate token." });
  }
}

export async function handleTokenRefresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== "string") {
    res.status(400).json({ error: "refreshToken required." });
    return;
  }

  try {
    const payload = verifyToken(refreshToken) as AuthPayload & { type?: string };
    if (payload.type !== "refresh") {
      res.status(400).json({ error: "Invalid token type. Expected refresh token." });
      return;
    }

    const accessToken = generateAccessToken({ deviceId: payload.deviceId, accountId: payload.accountId });
    const newRefreshToken = generateRefreshToken({ deviceId: payload.deviceId, accountId: payload.accountId });

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token." });
  }
}
