-- ===========================================================================
-- HFT Arena — PostgreSQL schema (Phase 1)
--
-- TWO PRINCIPLES RUNNING THROUGH THIS FILE
--
-- 1. NO FLOATING POINT FOR MONEY OR PRICES. Prices are stored as BIGINT ticks
--    exactly as the engine sees them, alongside the instrument's tick scale.
--    Cash is BIGINT micro-units. A DOUBLE PRECISION column here would make the
--    database disagree with the engine about a player's balance, and the player
--    will notice before you do.
--
-- 2. THE HOT PATH NEVER TOUCHES POSTGRES. During a match, fills go to the
--    backend over ZeroMQ and into Redis / an in-memory buffer. They are flushed
--    to Postgres in batches via COPY, after the match or on a timer. A
--    synchronous INSERT per fill would add milliseconds to a system whose whole
--    point is microseconds.
-- ===========================================================================
CREATE EXTENSION IF NOT EXISTS citext;
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity and progression
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          CITEXT UNIQUE NOT NULL,
  email           CITEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE user_ratings (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  elo             INTEGER NOT NULL DEFAULT 1200,
  peak_elo        INTEGER NOT NULL DEFAULT 1200,
  matches_played  INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  draws           INTEGER NOT NULL DEFAULT 0,
  -- Glicko-style uncertainty. Plain ELO moves far too slowly for a new player
  -- to reach their true rating; a provisional K-factor that decays over the
  -- first ~20 matches is the single biggest matchmaking quality win available.
  rating_deviation NUMERIC(8,3) NOT NULL DEFAULT 350.0,
  provisional     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Simulated capital unlocked by rating. Append-only ledger, never an UPDATE:
-- the balance is a fold over this table, which makes every grant auditable.
CREATE TABLE capital_grants (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_micros   BIGINT NOT NULL,
  reason          TEXT NOT NULL,          -- 'signup' | 'elo_tier' | 'daily' | ...
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON capital_grants (user_id, granted_at DESC);

-- ---------------------------------------------------------------------------
-- Instruments and scenarios
-- ---------------------------------------------------------------------------
CREATE TABLE instruments (
  id                 INTEGER PRIMARY KEY,
  symbol             TEXT UNIQUE NOT NULL,
  tick_value_micros  BIGINT NOT NULL,     -- cash value of 1 tick x 1 lot
  lot_size           BIGINT NOT NULL,
  display_precision  SMALLINT NOT NULL,
  margin_bps_long    INTEGER NOT NULL,
  margin_bps_short   INTEGER NOT NULL,
  allow_short        BOOLEAN NOT NULL DEFAULT TRUE
);

-- A scenario is a SEED PLUS A CONFIG, not a recorded tape. 200 bytes replays a
-- 10-minute match exactly, forever, as long as engine_version is pinned.
CREATE TABLE scenarios (
  id               BIGSERIAL PRIMARY KEY,
  instrument_id    INTEGER NOT NULL REFERENCES instruments(id),
  seed_hi          BIGINT NOT NULL,
  seed_lo          BIGINT NOT NULL,
  scenario_version INTEGER NOT NULL,
  fingerprint      BIGINT NOT NULL,       -- engine-computed, verified on ARM
  spec             JSONB NOT NULL,        -- regime timeline + agent mix
  difficulty       SMALLINT NOT NULL,     -- 1..10, drives matchmaking bands
  label            TEXT,                  -- 'Flash Crash — Tuesday 14:32'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON scenarios (difficulty, instrument_id);

-- ---------------------------------------------------------------------------
-- Matches
-- ---------------------------------------------------------------------------
CREATE TYPE match_mode   AS ENUM ('practice', 'ranked_pvp', 'casual_pvp', 'daily_puzzle');
CREATE TYPE match_status AS ENUM ('queued', 'provisioning', 'live', 'settled', 'aborted');

CREATE TABLE matches (
  id               BIGSERIAL PRIMARY KEY,
  mode             match_mode NOT NULL,
  status           match_status NOT NULL DEFAULT 'queued',
  scenario_id      BIGINT NOT NULL REFERENCES scenarios(id),
  engine_version   TEXT NOT NULL,          -- git sha; replay is invalid without it
  duration_ms      INTEGER NOT NULL,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  -- Both mirrored containers report this at teardown. If they disagree, the
  -- match is void and the incident is a P1 — determinism has broken.
  state_hash_a     BIGINT,
  state_hash_b     BIGINT,
  abort_reason     TEXT
);
CREATE INDEX ON matches (status, started_at DESC);

CREATE TABLE match_participants (
  match_id         BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat             SMALLINT NOT NULL,      -- 0 or 1; also the engine ClientId
  user_id          UUID NOT NULL REFERENCES users(id),
  starting_cash    BIGINT NOT NULL,
  elo_before       INTEGER NOT NULL,
  elo_after        INTEGER,
  final_equity     BIGINT,
  final_position   BIGINT,
  realized_pnl     BIGINT,
  unrealized_pnl   BIGINT,
  result           SMALLINT,               -- 1 win, 0 loss, 2 draw
  disconnected_at  TIMESTAMPTZ,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX ON match_participants (user_id, match_id DESC);

-- ---------------------------------------------------------------------------
-- Transaction history — high volume, partitioned by month
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  match_id      BIGINT NOT NULL,
  order_id      BIGINT NOT NULL,           -- engine-assigned
  seat          SMALLINT NOT NULL,
  client_ord_id BIGINT NOT NULL,
  ts_engine_ns  BIGINT NOT NULL,           -- LOGICAL time, replay-stable
  ts_wall       TIMESTAMPTZ NOT NULL,
  side          SMALLINT NOT NULL,
  order_type    SMALLINT NOT NULL,
  tif           SMALLINT NOT NULL,
  price_ticks   BIGINT,                    -- NULL for market orders
  qty_lots      BIGINT NOT NULL,
  status        SMALLINT NOT NULL,
  reject_reason SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, order_id)
) PARTITION BY RANGE (match_id);

CREATE TABLE fills (
  match_id       BIGINT NOT NULL,
  fill_seq       BIGINT NOT NULL,          -- engine global sequence
  order_id       BIGINT NOT NULL,
  seat           SMALLINT NOT NULL,
  ts_engine_ns   BIGINT NOT NULL,
  side           SMALLINT NOT NULL,
  price_ticks    BIGINT NOT NULL,
  qty_lots       BIGINT NOT NULL,
  is_maker       BOOLEAN NOT NULL,
  -- Phase 3 grading. Written by the evaluator AFTER the match, when the
  -- forward window is knowable. Keeping the benchmark alongside the grade
  -- means the UI can show the player *why*, not just *what*.
  vwap_benchmark_ticks BIGINT,
  slippage_ticks       BIGINT,             -- signed, positive = worse than VWAP
  grade                SMALLINT,           -- TradeGrade enum
  grade_reason         TEXT,
  PRIMARY KEY (match_id, fill_seq)
) PARTITION BY RANGE (match_id);

-- Example partition; automate with pg_partman.
CREATE TABLE orders_p0 PARTITION OF orders FOR VALUES FROM (0) TO (10000000);
CREATE TABLE fills_p0  PARTITION OF fills  FOR VALUES FROM (0) TO (10000000);

CREATE INDEX ON fills (match_id, seat, ts_engine_ns);

-- ---------------------------------------------------------------------------
-- Rating history — every exchange, so a player can audit their curve
-- ---------------------------------------------------------------------------
CREATE TABLE elo_history (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id      BIGINT REFERENCES matches(id),
  elo_before    INTEGER NOT NULL,
  elo_after     INTEGER NOT NULL,
  k_factor      INTEGER NOT NULL,
  expected_score NUMERIC(6,5) NOT NULL,
  actual_score  NUMERIC(3,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON elo_history (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Outbox — the bridge from the hot path to durable storage.
-- The backend appends rows here (or to Redis, then here) and a separate worker
-- drains them with COPY. Nothing in a live match ever waits on a disk write.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_outbox (
  id          BIGSERIAL PRIMARY KEY,
  match_id    BIGINT NOT NULL,
  payload     BYTEA NOT NULL,          -- raw engine frames, decoded by the worker
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX ON ingest_outbox (processed, id) WHERE NOT processed;
