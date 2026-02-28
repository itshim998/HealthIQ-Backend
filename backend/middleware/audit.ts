import { Request, Response, NextFunction } from "express";
import { query } from "../database/connection";

// HealthIQ v2 — Audit Logging Middleware
//
// Records all state-changing operations.
// Append-only: no deletes, no updates.
// Retained for 365 days in production.

export type AuditAction =
  | "event_created"
  | "ai_task_invoked"
  | "chat_sent"
  | "data_exported"
  | "alert_acknowledged"
  | "token_issued"
  | "token_refreshed"
  | "timeline_accessed"
  | "hsi_computed"
  | "consent_granted";

export interface AuditEntry {
  userId?: string;
  action: AuditAction;
  resource?: string;
  detail?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// In-memory fallback when no database is available
const inMemoryAuditLog: AuditEntry[] = [];

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // In-memory mode: store in array (capped at 10000)
    inMemoryAuditLog.push(entry);
    if (inMemoryAuditLog.length > 10000) {
      inMemoryAuditLog.splice(0, inMemoryAuditLog.length - 10000);
    }
    return;
  }

  try {
    await query(
      `INSERT INTO audit_log (user_id, action, resource, detail, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId || null,
        entry.action,
        entry.resource || null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ipAddress || null,
        entry.userAgent || null,
      ],
    );
  } catch (err) {
    // Audit logging must never crash the request
    console.error("[Audit] Failed to write audit log:", err);
  }
}

export function getInMemoryAuditLog(): readonly AuditEntry[] {
  return inMemoryAuditLog;
}

// Middleware: auto-logs state-changing requests
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only audit state-changing methods
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH" && req.method !== "DELETE") {
    return next();
  }

  // Determine action from path
  let action: AuditAction = "event_created";
  let resource = "unknown";

  if (req.path.includes("/ai/chat")) {
    action = "chat_sent";
    resource = "chat";
  } else if (req.path.includes("/ai/")) {
    action = "ai_task_invoked";
    resource = "ai";
  } else if (req.path.includes("/events")) {
    action = "event_created";
    resource = "timeline";
  } else if (req.path.includes("/auth/token")) {
    action = "token_issued";
    resource = "auth";
  } else if (req.path.includes("/auth/refresh")) {
    action = "token_refreshed";
    resource = "auth";
  } else if (req.path.includes("/alerts") && req.path.includes("/acknowledge")) {
    action = "alert_acknowledged";
    resource = "alert";
  } else if (req.path.includes("/consent")) {
    action = "consent_granted";
    resource = "consent";
  }

  const userId = req.auth?.deviceId || req.params.userId || req.body?.userId;

  // Write audit log asynchronously — don't block the response
  const entry: AuditEntry = {
    userId,
    action,
    resource,
    detail: {
      method: req.method,
      path: req.path,
      ...(req.body?.message ? { hasMessage: true } : {}),
    },
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"],
  };

  // Fire-and-forget: audit log must not block
  writeAuditLog(entry).catch(() => {});

  next();
}
