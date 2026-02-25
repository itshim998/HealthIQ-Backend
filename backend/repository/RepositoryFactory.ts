import type { TimelineRepository } from "./TimelineRepository";
import { InMemoryTimelineRepository } from "./InMemoryTimelineRepository";

// Repository Factory (HealthIQ)
// - The ONLY place where the storage implementation is selected.
// - Defaults to in-memory for local testing/demos.
// - Future storage backends (DB, remote store) must be wired here without changing call sites.
//
// This factory must not introduce auth, AI, UI, Maps, or infrastructure commitments.

let singleton: TimelineRepository | undefined;

export function getTimelineRepository(): TimelineRepository {
  if (!singleton) singleton = new InMemoryTimelineRepository();
  return singleton;
}
