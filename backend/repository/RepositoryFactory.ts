import type { TimelineRepository } from "./TimelineRepository";
import { InMemoryTimelineRepository } from "./InMemoryTimelineRepository";
import { PostgresTimelineRepository } from "./PostgresTimelineRepository";

// Repository Factory (HealthIQ v2)
// - The ONLY place where the storage implementation is selected.
// - Selects PostgreSQL when DATABASE_URL is set, otherwise falls back to in-memory.
// - This factory must not introduce auth, AI, UI, Maps, or infrastructure commitments.

let singleton: TimelineRepository | undefined;

export function getTimelineRepository(): TimelineRepository {
  if (!singleton) {
    if (process.env.DATABASE_URL) {
      console.log("[HealthIQ] Using PostgreSQL repository");
      singleton = new PostgresTimelineRepository();
    } else {
      console.log("[HealthIQ] Using in-memory repository (no DATABASE_URL set)");
      singleton = new InMemoryTimelineRepository();
    }
  }
  return singleton;
}
