-- ===========================================================================
-- HFT Arena — schema part 2: solo practice, portfolio, progression, market data
--
-- Apply AFTER db/schema.sql. Part 1 owns identity, matches, orders and fills;
-- this file owns everything the *player-facing product* needs on top of it.
--
-- The two principles from part 1 still hold and are not negotiable here:
--   1. No floating point for money or prices. BIGINT ticks, BIGINT micros.
--   2. The hot path never touches Postgres. Everything below is written either
--      between matches or by the post-match settlement worker.
--
-- A third principle shows up in this file specifically:
--   3. DERIVED STATE IS A VIEW OR A CACHE, NEVER A SOURCE OF TRUTH. Portfolio
--      equity, leaderboard rank and XP totals are all folds over append-only
--      tables. Where a fold is too slow to run per request, it gets a
--      materialized view with an explicit refresh — not a mutable counter that
--      silently drifts from the ledger it is supposed to summarise.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Sessions — issued refresh tokens, so a stolen JWT can actually be revoked
-- ---------------------------------------------------------------------------
CREATE TABLE user_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash   TEXT NOT NULL,           -- sha256 of the token, never the token
  user_agent     TEXT,
  ip             INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON user_sessions (expires_at);

-- Cosmetic / social layer. Split from `users` because it is read on every
-- leaderboard row while the auth columns are read once per login.
CREATE TABLE user_profiles (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name   TEXT,
  avatar_seed    TEXT NOT NULL DEFAULT 'default',
  country_code   CHAR(2),
  bio            TEXT,
  title          TEXT,                    -- equipped achievement title
  xp             BIGINT NOT NULL DEFAULT 0,
  level          INTEGER NOT NULL DEFAULT 1,
  streak_days    INTEGER NOT NULL DEFAULT 0,
  last_played_on DATE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Solo practice
--
-- Solo is NOT a degenerate one-seat PvP match, and modelling it as one was
-- tempting and wrong. A practice run is restartable, abandonable, has no ELO
-- consequence and no opponent to keep in lockstep — so it gets its own table
-- rather than polluting `matches` with a nullable seat 1 and a NULL elo_after
-- on every row. `matches` stays the record of *competitive* play, which is what
-- anti-cheat and replay verification query against.
-- ---------------------------------------------------------------------------
CREATE TYPE practice_status AS ENUM ('live', 'completed', 'abandoned', 'expired');

-- Curated, hand-authored levels. A scenario is the raw seed+config; a drill is
-- the *pedagogy* wrapped around it: what you are meant to learn, and what
-- counts as passing.
CREATE TABLE practice_drills (
  id               BIGSERIAL PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  scenario_id      BIGINT NOT NULL REFERENCES scenarios(id),
  title            TEXT NOT NULL,
  subtitle         TEXT,
  description      TEXT NOT NULL,
  skill_tag        TEXT NOT NULL,          -- 'passive_execution' | 'risk' | 'tape_reading' | ...
  difficulty       SMALLINT NOT NULL,      -- 1..10, mirrors scenarios.difficulty
  duration_ms      INTEGER NOT NULL,
  starting_cash    BIGINT NOT NULL,
  -- Objectives are declarative so the evaluator is data-driven and new drills
  -- ship without a backend deploy. Shape:
  --   [{ "id":"pnl", "kind":"min_pnl", "target": 250000000, "label":"Finish green" }]
  objectives       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Star thresholds on the drill's primary metric, ascending.
  star_thresholds  BIGINT[] NOT NULL DEFAULT '{}',
  xp_reward        INTEGER NOT NULL DEFAULT 100,
  unlock_level     INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_published     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON practice_drills (skill_tag, difficulty) WHERE is_published;

-- One attempt. Free-play runs (no drill) are allowed: drill_id is nullable and
-- scenario_id is always present, because you can always replay a raw seed.
CREATE TABLE practice_runs (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drill_id         BIGINT REFERENCES practice_drills(id),
  scenario_id      BIGINT NOT NULL REFERENCES scenarios(id),
  engine_version   TEXT NOT NULL,
  status           practice_status NOT NULL DEFAULT 'live',
  seed_override_hi BIGINT,                 -- set when the player rerolls the seed
  seed_override_lo BIGINT,
  speed_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,  -- practice may run fast
  starting_cash    BIGINT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  duration_ms      INTEGER,

  final_equity     BIGINT,
  realized_pnl     BIGINT,
  unrealized_pnl   BIGINT,
  fill_count       INTEGER NOT NULL DEFAULT 0,
  order_count      INTEGER NOT NULL DEFAULT 0,
  maker_fill_count INTEGER NOT NULL DEFAULT 0,
  max_drawdown     BIGINT,
  peak_equity      BIGINT,
  sharpe_x1000     INTEGER,                -- integer, x1000. No float in scoring.
  stars            SMALLINT NOT NULL DEFAULT 0,
  objectives_met   JSONB NOT NULL DEFAULT '[]'::jsonb,
  xp_awarded       INTEGER NOT NULL DEFAULT 0,
  state_hash       BIGINT
);
CREATE INDEX ON practice_runs (user_id, started_at DESC);
CREATE INDEX ON practice_runs (drill_id, final_equity DESC)
  WHERE status = 'completed';
-- One live run per user: resuming beats silently orphaning an in-flight engine.
CREATE UNIQUE INDEX practice_runs_one_live_per_user
  ON practice_runs (user_id) WHERE status = 'live';

-- Best result per (user, drill). A tiny mutable table maintained by the
-- settlement worker — the append-only truth is still practice_runs.
CREATE TABLE practice_best (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drill_id       BIGINT NOT NULL REFERENCES practice_drills(id) ON DELETE CASCADE,
  best_run_id    BIGINT NOT NULL REFERENCES practice_runs(id),
  best_pnl       BIGINT NOT NULL,
  best_stars     SMALLINT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 1,
  first_cleared_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, drill_id)
);

-- ---------------------------------------------------------------------------
-- Portfolio
--
-- The player's *persistent* account across the whole product, distinct from the
-- per-match sandbox balance. Every movement is a ledger row; the balance is a
-- fold. This is the same discipline as capital_grants in part 1, extended to
-- cover match settlements, drill rewards and fees.
-- ---------------------------------------------------------------------------
CREATE TYPE ledger_kind AS ENUM (
  'signup_grant', 'elo_tier_grant', 'daily_bonus', 'drill_reward',
  'match_settlement', 'practice_settlement', 'fee', 'adjustment'
);

CREATE TABLE portfolio_ledger (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           ledger_kind NOT NULL,
  amount_micros  BIGINT NOT NULL,          -- signed
  match_id       BIGINT REFERENCES matches(id),
  practice_run_id BIGINT REFERENCES practice_runs(id),
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON portfolio_ledger (user_id, created_at DESC);
-- A settlement must be idempotent: the worker can retry a crashed flush without
-- paying a player twice.
CREATE UNIQUE INDEX portfolio_ledger_match_once
  ON portfolio_ledger (user_id, match_id) WHERE match_id IS NOT NULL;

-- Read-side cache of the fold. Refreshed by the settlement worker in the same
-- transaction that appends the ledger row, so it can never lag silently.
CREATE TABLE portfolio_balances (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash_micros       BIGINT NOT NULL DEFAULT 0,
  lifetime_pnl      BIGINT NOT NULL DEFAULT 0,
  best_match_pnl    BIGINT NOT NULL DEFAULT 0,
  worst_match_pnl   BIGINT NOT NULL DEFAULT 0,
  total_volume_lots BIGINT NOT NULL DEFAULT 0,
  total_fills       BIGINT NOT NULL DEFAULT 0,
  maker_fills       BIGINT NOT NULL DEFAULT 0,
  ledger_version    BIGINT NOT NULL DEFAULT 0,  -- last portfolio_ledger.id folded
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily equity marks, for the portfolio equity curve. One row per user per day.
CREATE TABLE portfolio_equity_history (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  as_of         DATE NOT NULL,
  equity_micros BIGINT NOT NULL,
  pnl_micros    BIGINT NOT NULL,
  matches_played INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, as_of)
);

-- Per-skill aggregates that drive the radar chart on the profile page.
CREATE TABLE user_skill_stats (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_tag      TEXT NOT NULL,
  samples        INTEGER NOT NULL DEFAULT 0,
  score_x100     INTEGER NOT NULL DEFAULT 0,   -- 0..10000
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill_tag)
);

-- ---------------------------------------------------------------------------
-- Market data for the charts
--
-- Candles are DERIVED from `fills` + the synthetic tape and stored per match,
-- because re-aggregating a 10-minute tick tape on every chart pan is wasteful
-- and the result is immutable once the match ends. Live charts are fed over the
-- socket and never read this table.
-- ---------------------------------------------------------------------------
CREATE TABLE match_candles (
  match_id      BIGINT NOT NULL,
  interval_ms   INTEGER NOT NULL,          -- 250 | 1000 | 5000
  bucket_ms     INTEGER NOT NULL,          -- offset from match start
  open_ticks    BIGINT NOT NULL,
  high_ticks    BIGINT NOT NULL,
  low_ticks     BIGINT NOT NULL,
  close_ticks   BIGINT NOT NULL,
  volume_lots   BIGINT NOT NULL,
  trade_count   INTEGER NOT NULL,
  vwap_ticks    BIGINT NOT NULL,
  PRIMARY KEY (match_id, interval_ms, bucket_ms)
);

CREATE TABLE practice_candles (
  run_id        BIGINT NOT NULL REFERENCES practice_runs(id) ON DELETE CASCADE,
  interval_ms   INTEGER NOT NULL,
  bucket_ms     INTEGER NOT NULL,
  open_ticks    BIGINT NOT NULL,
  high_ticks    BIGINT NOT NULL,
  low_ticks     BIGINT NOT NULL,
  close_ticks   BIGINT NOT NULL,
  volume_lots   BIGINT NOT NULL,
  trade_count   INTEGER NOT NULL,
  vwap_ticks    BIGINT NOT NULL,
  PRIMARY KEY (run_id, interval_ms, bucket_ms)
);

-- Sampled equity marks during a match — the head-to-head equity race chart.
-- Sampled at ~1 Hz, not per fill: the shape is what matters, and per-fill rows
-- would put the chart table on the same order of magnitude as `fills`.
CREATE TABLE match_equity_samples (
  match_id      BIGINT NOT NULL,
  seat          SMALLINT NOT NULL,
  t_ms          INTEGER NOT NULL,
  equity_micros BIGINT NOT NULL,
  position_lots BIGINT NOT NULL,
  PRIMARY KEY (match_id, seat, t_ms)
);

-- ---------------------------------------------------------------------------
-- Matchmaking and lobbies
-- ---------------------------------------------------------------------------
CREATE TYPE queue_state AS ENUM ('waiting', 'matched', 'cancelled', 'timed_out');

CREATE TABLE matchmaking_queue (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode          match_mode NOT NULL,
  elo_snapshot  INTEGER NOT NULL,
  band_width    INTEGER NOT NULL DEFAULT 100,   -- widens while waiting
  state         queue_state NOT NULL DEFAULT 'waiting',
  match_id      BIGINT REFERENCES matches(id),
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX ON matchmaking_queue (mode, elo_snapshot) WHERE state = 'waiting';
CREATE UNIQUE INDEX matchmaking_one_active_per_user
  ON matchmaking_queue (user_id) WHERE state = 'waiting';

-- Private rooms: "play a friend" by code, no ELO band, no queue.
CREATE TABLE lobbies (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,      -- 6 chars, human-readable
  host_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  mode          match_mode NOT NULL DEFAULT 'casual_pvp',
  scenario_id   BIGINT REFERENCES scenarios(id),
  duration_ms   INTEGER NOT NULL DEFAULT 300000,
  starting_cash BIGINT NOT NULL,
  match_id      BIGINT REFERENCES matches(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 minutes',
  closed_at     TIMESTAMPTZ
);
CREATE INDEX ON lobbies (code) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Progression: achievements and quests
-- ---------------------------------------------------------------------------
CREATE TABLE achievements (
  id            TEXT PRIMARY KEY,          -- 'first_blood', 'maker_1000', ...
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT 'trophy',
  tier          SMALLINT NOT NULL DEFAULT 1,   -- 1 bronze .. 4 diamond
  xp_reward     INTEGER NOT NULL DEFAULT 50,
  grants_title  TEXT,
  criteria      JSONB NOT NULL             -- evaluated by the settlement worker
);

CREATE TABLE user_achievements (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  progress      INTEGER NOT NULL DEFAULT 0,
  target        INTEGER NOT NULL DEFAULT 1,
  unlocked_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, achievement_id)
);
CREATE INDEX ON user_achievements (user_id) WHERE unlocked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Leaderboards
--
-- Materialized, not a live query. The ranked leaderboard is the single most
-- requested page in a competitive game and it joins four tables; recomputing it
-- per request would be the first thing to fall over under load. Refresh on a
-- 60s timer: a leaderboard that is a minute stale is invisible to players, and
-- a leaderboard that times out is not.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW leaderboard_ranked AS
SELECT
  u.id                                    AS user_id,
  u.handle,
  COALESCE(p.display_name, u.handle::TEXT) AS display_name,
  COALESCE(p.avatar_seed, 'default')      AS avatar_seed,
  p.country_code,
  p.title,
  r.elo,
  r.peak_elo,
  r.matches_played,
  r.wins,
  r.losses,
  r.draws,
  COALESCE(b.lifetime_pnl, 0)             AS lifetime_pnl,
  COALESCE(b.total_volume_lots, 0)        AS total_volume_lots,
  CASE WHEN r.matches_played > 0
       THEN (r.wins * 10000) / r.matches_played
       ELSE 0 END                          AS win_rate_bps,
  RANK() OVER (ORDER BY r.elo DESC, r.peak_elo DESC, u.id) AS rank
FROM users u
JOIN user_ratings r      ON r.user_id = u.id
LEFT JOIN user_profiles p ON p.user_id = u.id
LEFT JOIN portfolio_balances b ON b.user_id = u.id
WHERE NOT u.is_banned
  AND r.matches_played > 0;

CREATE UNIQUE INDEX ON leaderboard_ranked (user_id);
CREATE INDEX ON leaderboard_ranked (rank);

-- Per-drill solo leaderboard. Same reasoning.
CREATE MATERIALIZED VIEW leaderboard_practice AS
SELECT
  pb.drill_id,
  pb.user_id,
  u.handle,
  COALESCE(pr.display_name, u.handle::TEXT) AS display_name,
  pb.best_pnl,
  pb.best_stars,
  pb.attempts,
  RANK() OVER (PARTITION BY pb.drill_id ORDER BY pb.best_pnl DESC, pb.user_id) AS rank
FROM practice_best pb
JOIN users u ON u.id = pb.user_id
LEFT JOIN user_profiles pr ON pr.user_id = pb.user_id
WHERE NOT u.is_banned;

CREATE UNIQUE INDEX ON leaderboard_practice (drill_id, user_id);
CREATE INDEX ON leaderboard_practice (drill_id, rank);

-- ---------------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------------

-- A player's match history with the opponent resolved — the single query behind
-- the profile's "recent matches" list.
CREATE VIEW match_history AS
SELECT
  mp.user_id,
  m.id            AS match_id,
  m.mode,
  m.status,
  m.duration_ms,
  m.started_at,
  m.ended_at,
  mp.seat,
  mp.result,
  mp.elo_before,
  mp.elo_after,
  mp.realized_pnl,
  mp.unrealized_pnl,
  mp.final_equity,
  opp.user_id     AS opponent_user_id,
  ou.handle       AS opponent_handle,
  opp.final_equity AS opponent_equity
FROM match_participants mp
JOIN matches m ON m.id = mp.match_id
LEFT JOIN match_participants opp
       ON opp.match_id = mp.match_id AND opp.seat <> mp.seat
LEFT JOIN users ou ON ou.id = opp.user_id;

-- The fold that portfolio_balances caches. Kept as a view so the cache can be
-- audited against it — if these two ever disagree, the cache is wrong.
CREATE VIEW portfolio_balance_truth AS
SELECT user_id,
       SUM(amount_micros)        AS cash_micros,
       MAX(id)                   AS ledger_version,
       COUNT(*)                  AS entries
FROM portfolio_ledger
GROUP BY user_id;
