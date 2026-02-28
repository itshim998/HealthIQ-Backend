-- HealthIQ v2 — PostgreSQL Schema
-- Migration 001: Core tables for timeline, graph, HSI, alerts, audit, auth

-- =============================================================
-- EXTENSIONS
-- =============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================
-- 1. USER DEVICES (auth foundation)
-- =============================================================
CREATE TABLE IF NOT EXISTS user_devices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_uuid     VARCHAR(128) NOT NULL UNIQUE,
  account_id      UUID,                          -- NULL until account upgrade
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disclaimer_ack  BOOLEAN NOT NULL DEFAULT FALSE,
  disclaimer_ack_at TIMESTAMPTZ
);

CREATE INDEX idx_user_devices_device ON user_devices (device_uuid);

-- =============================================================
-- 2. HEALTH EVENTS (core timeline)
-- =============================================================
CREATE TABLE IF NOT EXISTS health_events (
  id              UUID PRIMARY KEY,
  user_id         VARCHAR(128) NOT NULL,         -- device_uuid as user identity
  event_type      VARCHAR(20) NOT NULL
                    CHECK (event_type IN ('Medication','Symptom','Lifestyle','Clinical','Insight')),
  timestamp_abs   TIMESTAMPTZ NOT NULL,
  timestamp_rel   JSONB,                          -- { reference, offset }
  source          VARCHAR(20) NOT NULL
                    CHECK (source IN ('user','prescription','device','doctor')),
  confidence      VARCHAR(10) NOT NULL
                    CHECK (confidence IN ('low','medium','high')),
  visibility      VARCHAR(20) NOT NULL DEFAULT 'user-only'
                    CHECK (visibility IN ('user-only','doctor-shareable')),
  payload         JSONB NOT NULL DEFAULT '{}',    -- type-specific fields
  duration        JSONB,
  tags            TEXT[],
  links           JSONB,                          -- { evidence, causalContext, sameEpisode, supersedes, clarifies }
  notes           TEXT,
  review_status   VARCHAR(10)                     -- only for Insight events: 'draft' | 'reviewed'
                    CHECK (review_status IS NULL OR review_status IN ('draft','reviewed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_user_time     ON health_events (user_id, timestamp_abs DESC);
CREATE INDEX idx_events_user_type     ON health_events (user_id, event_type);
CREATE INDEX idx_events_payload       ON health_events USING GIN (payload);
CREATE INDEX idx_events_created       ON health_events (created_at DESC);

-- =============================================================
-- 3. HEALTH GRAPH NODES
-- =============================================================
CREATE TABLE IF NOT EXISTS health_graph_nodes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           VARCHAR(128) NOT NULL,
  concept           VARCHAR(200) NOT NULL,         -- e.g., "migraine", "metformin", "poor_sleep"
  category          VARCHAR(20) NOT NULL
                      CHECK (category IN ('symptom','medication','lifestyle','clinical')),
  first_seen        TIMESTAMPTZ NOT NULL,
  last_seen         TIMESTAMPTZ NOT NULL,
  occurrence_count  INT NOT NULL DEFAULT 1,

  UNIQUE (user_id, concept, category)
);

CREATE INDEX idx_graph_nodes_user ON health_graph_nodes (user_id);

-- =============================================================
-- 4. HEALTH GRAPH EDGES
-- =============================================================
CREATE TABLE IF NOT EXISTS health_graph_edges (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             VARCHAR(128) NOT NULL,
  source_node         UUID NOT NULL REFERENCES health_graph_nodes(id) ON DELETE CASCADE,
  target_node         UUID NOT NULL REFERENCES health_graph_nodes(id) ON DELETE CASCADE,
  relation            VARCHAR(30) NOT NULL
                        CHECK (relation IN ('co_occurrence','temporal_sequence','reported_trigger','medication_response')),
  weight              FLOAT NOT NULL DEFAULT 1.0,
  evidence_event_ids  UUID[],
  first_observed      TIMESTAMPTZ NOT NULL,
  last_observed       TIMESTAMPTZ NOT NULL,

  UNIQUE (user_id, source_node, target_node, relation)
);

CREATE INDEX idx_edges_user   ON health_graph_edges (user_id);
CREATE INDEX idx_edges_source ON health_graph_edges (source_node);
CREATE INDEX idx_edges_target ON health_graph_edges (target_node);

-- =============================================================
-- 5. HSI SNAPSHOTS (Health Stability Index)
-- =============================================================
CREATE TABLE IF NOT EXISTS hsi_snapshots (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                   VARCHAR(128) NOT NULL,
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score                     FLOAT NOT NULL CHECK (score >= 0 AND score <= 100),
  symptom_regularity        FLOAT,
  behavioral_consistency    FLOAT,
  trajectory_direction      FLOAT,
  window_days               INT NOT NULL DEFAULT 30,
  contributing_event_ids    UUID[],
  data_confidence           VARCHAR(10)
                              CHECK (data_confidence IN ('low','medium','high'))
);

CREATE INDEX idx_hsi_user_time ON hsi_snapshots (user_id, computed_at DESC);

-- =============================================================
-- 6. ALERT RULES (built-in alert definitions)
-- =============================================================
CREATE TABLE IF NOT EXISTS alert_rules (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_type   VARCHAR(30) NOT NULL UNIQUE,
  threshold   JSONB NOT NULL,
  severity    VARCHAR(10) NOT NULL CHECK (severity IN ('info','warning','attention')),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT
);

-- Seed built-in alert rules
INSERT INTO alert_rules (rule_type, threshold, severity, description) VALUES
  ('hsi_drop',             '{"hsi_delta": -10, "window_days": 7}',               'warning',   'HSI decreases ≥10 points in 7 days'),
  ('new_symptom_cluster',  '{"new_concepts": 3, "window_days": 14, "lookback": 60}', 'attention', '≥3 new symptom concepts in 14 days not seen in 60 days'),
  ('adherence_decline',    '{"threshold_pct": 70, "window_days": 14}',           'warning',   'Medication adherence drops below 70% over 14 days'),
  ('logging_gap',          '{"gap_days": 7, "min_prior_events": 20}',            'info',      'No events for ≥7 days for active users'),
  ('symptom_escalation',   '{"consecutive_increases": 3}',                       'warning',   'Intensity increases across ≥3 consecutive occurrences of same symptom'),
  ('co_occurrence_spike',  '{"weight_multiplier": 2.0, "window_days": 14}',     'info',      'Graph edge weight doubles within 14 days')
ON CONFLICT (rule_type) DO NOTHING;

-- =============================================================
-- 7. USER ALERTS
-- =============================================================
CREATE TABLE IF NOT EXISTS user_alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         VARCHAR(128) NOT NULL,
  rule_id         UUID NOT NULL REFERENCES alert_rules(id),
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity        VARCHAR(10) NOT NULL CHECK (severity IN ('info','warning','attention')),
  title           TEXT NOT NULL,
  explanation     TEXT,
  evidence_ids    UUID[],
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX idx_alerts_user       ON user_alerts (user_id, triggered_at DESC);
CREATE INDEX idx_alerts_user_ack   ON user_alerts (user_id, acknowledged);

-- =============================================================
-- 8. AUDIT LOG (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     VARCHAR(128),
  action      VARCHAR(50) NOT NULL,
  resource    VARCHAR(50),
  detail      JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user   ON audit_log (user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log (action, created_at DESC);

-- =============================================================
-- 9. USER CONSENTS (disclaimer tracking)
-- =============================================================
CREATE TABLE IF NOT EXISTS user_consents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         VARCHAR(128) NOT NULL,
  consent_type    VARCHAR(50) NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      INET,

  UNIQUE (user_id, consent_type)
);

CREATE INDEX idx_consents_user ON user_consents (user_id);
