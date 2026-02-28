import type { AnyHealthEvent } from "../domain/HealthTimeline";
import { query } from "../database/connection";
import { extractConcepts, type ExtractedConcept } from "./ConceptExtractor";

// =========================================================================
// HealthIQ v2 — Health Graph Builder
//
// Maintains a per-user directed graph of health concept relationships.
// Nodes = health concepts (symptom, medication, lifestyle, clinical)
// Edges = relationships (co_occurrence, temporal_sequence, reported_trigger, medication_response)
//
// Graph is built SERVER-SIDE, deterministically.
// The LLM interprets the graph; it does NOT construct it.
// =========================================================================

export type GraphRelation =
  | "co_occurrence"
  | "temporal_sequence"
  | "reported_trigger"
  | "medication_response";

export interface GraphNode {
  id: string;
  concept: string;
  category: string;
  occurrenceCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface GraphEdge {
  id: string;
  sourceNode: string;
  targetNode: string;
  sourceConcept?: string;
  targetConcept?: string;
  relation: GraphRelation;
  weight: number;
  firstObserved: string;
  lastObserved: string;
}

export interface GraphSummary {
  userId: string;
  nodeCount: number;
  edgeCount: number;
  topConcepts: GraphNode[];
  strongestEdges: GraphEdge[];
}

// --- Co-occurrence window: events within this many hours are considered co-occurring ---
const CO_OCCURRENCE_WINDOW_HOURS = 48;

// =========================================================================
// In-Memory Graph (for non-DB mode)
// =========================================================================

interface InMemoryNode {
  id: string;
  userId: string;
  concept: string;
  category: string;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
}

interface InMemoryEdge {
  id: string;
  userId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: GraphRelation;
  weight: number;
  evidenceEventIds: string[];
  firstObserved: string;
  lastObserved: string;
}

const memNodes = new Map<string, InMemoryNode>(); // key: `${userId}|${concept}|${category}`
const memEdges = new Map<string, InMemoryEdge>(); // key: `${userId}|${srcId}|${tgtId}|${relation}`
let memNodeCounter = 0;
let memEdgeCounter = 0;

// =========================================================================
// Upsert graph nodes
// =========================================================================

async function upsertNode(
  userId: string,
  concept: ExtractedConcept,
): Promise<string> {
  if (process.env.DATABASE_URL) {
    // PostgreSQL mode
    const result = await query(
      `INSERT INTO health_graph_nodes (user_id, concept, category, first_seen, last_seen, occurrence_count)
       VALUES ($1, $2, $3, $4, $4, 1)
       ON CONFLICT (user_id, concept, category)
       DO UPDATE SET
         last_seen = EXCLUDED.last_seen,
         occurrence_count = health_graph_nodes.occurrence_count + 1
       RETURNING id`,
      [userId, concept.concept, concept.category, concept.timestamp],
    );
    return result.rows[0].id as string;
  }

  // In-memory mode
  const key = `${userId}|${concept.concept}|${concept.category}`;
  const existing = memNodes.get(key);
  if (existing) {
    existing.lastSeen = concept.timestamp;
    existing.occurrenceCount += 1;
    return existing.id;
  }

  const id = `mem-node-${++memNodeCounter}`;
  memNodes.set(key, {
    id,
    userId,
    concept: concept.concept,
    category: concept.category,
    firstSeen: concept.timestamp,
    lastSeen: concept.timestamp,
    occurrenceCount: 1,
  });
  return id;
}

// =========================================================================
// Upsert graph edges
// =========================================================================

async function upsertEdge(
  userId: string,
  sourceNodeId: string,
  targetNodeId: string,
  relation: GraphRelation,
  eventId: string,
  timestamp: string,
): Promise<void> {
  if (sourceNodeId === targetNodeId) return; // No self-loops

  if (process.env.DATABASE_URL) {
    await query(
      `INSERT INTO health_graph_edges
        (user_id, source_node, target_node, relation, weight, evidence_event_ids, first_observed, last_observed)
       VALUES ($1, $2, $3, $4, 1.0, ARRAY[$5::uuid], $6, $6)
       ON CONFLICT (user_id, source_node, target_node, relation)
       DO UPDATE SET
         weight = health_graph_edges.weight + 0.5,
         evidence_event_ids = array_append(health_graph_edges.evidence_event_ids, $5::uuid),
         last_observed = EXCLUDED.last_observed`,
      [userId, sourceNodeId, targetNodeId, relation, eventId, timestamp],
    );
    return;
  }

  // In-memory mode
  const key = `${userId}|${sourceNodeId}|${targetNodeId}|${relation}`;
  const existing = memEdges.get(key);
  if (existing) {
    existing.weight += 0.5;
    existing.evidenceEventIds.push(eventId);
    existing.lastObserved = timestamp;
    return;
  }

  memEdges.set(key, {
    id: `mem-edge-${++memEdgeCounter}`,
    userId,
    sourceNodeId,
    targetNodeId,
    relation,
    weight: 1.0,
    evidenceEventIds: [eventId],
    firstObserved: timestamp,
    lastObserved: timestamp,
  });
}

// =========================================================================
// Build graph from events
// =========================================================================

/**
 * Process a single event: extract concepts, upsert nodes, find co-occurrences
 * with recent concepts, create edges.
 */
export async function processEventForGraph(
  userId: string,
  event: AnyHealthEvent,
  recentEvents: readonly AnyHealthEvent[],
): Promise<void> {
  const concepts = extractConcepts(event);
  if (concepts.length === 0) return;

  // Upsert all extracted concept nodes
  const nodeIds: { concept: ExtractedConcept; nodeId: string }[] = [];
  for (const c of concepts) {
    const nodeId = await upsertNode(userId, c);
    nodeIds.push({ concept: c, nodeId });
  }

  // Find recent events within co-occurrence window to create edges
  const eventTime = new Date(event.timestamp.absolute).getTime();
  const windowMs = CO_OCCURRENCE_WINDOW_HOURS * 60 * 60 * 1000;

  const recentConcepts: { concept: ExtractedConcept; nodeId: string }[] = [];

  for (const recentEvent of recentEvents) {
    if (recentEvent.id === event.id) continue;

    const recentTime = new Date(recentEvent.timestamp.absolute).getTime();
    if (Math.abs(eventTime - recentTime) <= windowMs) {
      const rConcepts = extractConcepts(recentEvent);
      for (const rc of rConcepts) {
        const rNodeId = await upsertNode(userId, rc);
        recentConcepts.push({ concept: rc, nodeId: rNodeId });
      }
    }
  }

  // Create co-occurrence edges between new concepts and recent concepts
  for (const newC of nodeIds) {
    for (const recentC of recentConcepts) {
      if (newC.nodeId === recentC.nodeId) continue;

      // Determine relationship type
      let relation: GraphRelation = "co_occurrence";

      // Medication + Symptom → medication_response
      if (
        (newC.concept.category === "medication" && recentC.concept.category === "symptom") ||
        (newC.concept.category === "symptom" && recentC.concept.category === "medication")
      ) {
        relation = "medication_response";
      }

      // Lifestyle + Symptom → temporal_sequence (lifestyle may influence symptoms)
      if (
        (newC.concept.category === "lifestyle" && recentC.concept.category === "symptom") ||
        (newC.concept.category === "symptom" && recentC.concept.category === "lifestyle")
      ) {
        relation = "temporal_sequence";
      }

      // Determine temporal order for edge direction
      const newTime = new Date(newC.concept.timestamp).getTime();
      const recentTime = new Date(recentC.concept.timestamp).getTime();

      const sourceId = newTime >= recentTime ? recentC.nodeId : newC.nodeId;
      const targetId = newTime >= recentTime ? newC.nodeId : recentC.nodeId;

      await upsertEdge(userId, sourceId, targetId, relation, event.id, event.timestamp.absolute);
    }
  }
}

// =========================================================================
// Graph queries
// =========================================================================

export async function getGraphSummary(userId: string, topN: number = 15): Promise<GraphSummary> {
  if (process.env.DATABASE_URL) {
    const nodesResult = await query(
      `SELECT * FROM health_graph_nodes
       WHERE user_id = $1
       ORDER BY occurrence_count DESC
       LIMIT $2`,
      [userId, topN],
    );

    const edgesResult = await query(
      `SELECT e.*, sn.concept as source_concept, tn.concept as target_concept
       FROM health_graph_edges e
       JOIN health_graph_nodes sn ON e.source_node = sn.id
       JOIN health_graph_nodes tn ON e.target_node = tn.id
       WHERE e.user_id = $1
       ORDER BY e.weight DESC
       LIMIT $2`,
      [userId, topN],
    );

    const countResult = await query(
      `SELECT
        (SELECT COUNT(*) FROM health_graph_nodes WHERE user_id = $1) as node_count,
        (SELECT COUNT(*) FROM health_graph_edges WHERE user_id = $1) as edge_count`,
      [userId],
    );

    return {
      userId,
      nodeCount: parseInt(String(countResult.rows[0]?.node_count ?? "0")),
      edgeCount: parseInt(String(countResult.rows[0]?.edge_count ?? "0")),
      topConcepts: nodesResult.rows.map((r: any) => ({
        id: r.id,
        concept: r.concept,
        category: r.category,
        occurrenceCount: r.occurrence_count,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      })),
      strongestEdges: edgesResult.rows.map((r: any) => ({
        id: r.id,
        sourceNode: r.source_node,
        targetNode: r.target_node,
        sourceConcept: r.source_concept,
        targetConcept: r.target_concept,
        relation: r.relation,
        weight: r.weight,
        firstObserved: r.first_observed,
        lastObserved: r.last_observed,
      })),
    };
  }

  // In-memory mode
  const userNodes = Array.from(memNodes.values()).filter((n) => n.userId === userId);
  const userEdges = Array.from(memEdges.values()).filter((e) => e.userId === userId);

  const topNodes = [...userNodes].sort((a, b) => b.occurrenceCount - a.occurrenceCount).slice(0, topN);
  const topEdges = [...userEdges].sort((a, b) => b.weight - a.weight).slice(0, topN);

  // Build concept lookup for edge labels
  const nodeIdToConceptMap = new Map<string, string>();
  for (const n of userNodes) nodeIdToConceptMap.set(n.id, n.concept);

  return {
    userId,
    nodeCount: userNodes.length,
    edgeCount: userEdges.length,
    topConcepts: topNodes.map((n) => ({
      id: n.id,
      concept: n.concept,
      category: n.category,
      occurrenceCount: n.occurrenceCount,
      firstSeen: n.firstSeen,
      lastSeen: n.lastSeen,
    })),
    strongestEdges: topEdges.map((e) => ({
      id: e.id,
      sourceNode: e.sourceNodeId,
      targetNode: e.targetNodeId,
      sourceConcept: nodeIdToConceptMap.get(e.sourceNodeId),
      targetConcept: nodeIdToConceptMap.get(e.targetNodeId),
      relation: e.relation as GraphRelation,
      weight: e.weight,
      firstObserved: e.firstObserved,
      lastObserved: e.lastObserved,
    })),
  };
}
