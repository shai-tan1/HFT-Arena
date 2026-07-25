-- ===========================================================================
-- Seed content: the instrument, the starter scenarios, the practice drills and
-- the achievement set. Idempotent — safe to re-run after a schema change.
--
-- Prices are in ticks. SYNTH-A uses a 1-cent tick, so 10000 ticks = $100.00,
-- and tick_value_micros = 10000 means one tick on one lot is worth $0.01.
-- ===========================================================================

INSERT INTO instruments (id, symbol, tick_value_micros, lot_size, display_precision,
                         margin_bps_long, margin_bps_short, allow_short)
VALUES
  (1, 'SYNTH-A', 10000, 1, 2, 2000, 3000, TRUE),
  (2, 'VOLT-X',  10000, 1, 2, 3000, 4500, TRUE),
  (3, 'CALM-1',  10000, 1, 2, 1500, 2000, TRUE)
ON CONFLICT (id) DO UPDATE
  SET symbol = EXCLUDED.symbol,
      tick_value_micros = EXCLUDED.tick_value_micros;

-- ---------------------------------------------------------------------------
-- Scenarios. Seed + spec only; the engine expands these into full order flow.
-- `fingerprint` is a placeholder here and is overwritten by the engine on the
-- first CTL_ARM — the value stored must be the one the engine actually computes.
-- ---------------------------------------------------------------------------
INSERT INTO scenarios (id, instrument_id, seed_hi, seed_lo, scenario_version,
                       fingerprint, spec, difficulty, label)
VALUES
  (1, 3, 1001, 20250724, 1, 0,
   '{"open_price":10000,
     "timeline":[{"regime":"Calm","duration_ms":180000,"intensity":30}],
     "agents":[{"kind":"MarketMaker","count":4,"mean_interarrival_ms":120,"size_min":20,"size_max":80,"spread_ticks":2,"inventory_limit":400},
               {"kind":"NoiseTrader","count":6,"mean_interarrival_ms":900,"size_min":1,"size_max":12},
               {"kind":"MeanReversion","count":2,"mean_interarrival_ms":1400,"size_min":5,"size_max":25}]}'::jsonb,
   2, 'Quiet Open'),

  (2, 1, 2002, 20250724, 1, 0,
   '{"open_price":10000,
     "timeline":[{"regime":"Calm","duration_ms":45000,"intensity":35},
                 {"regime":"Trending","duration_ms":195000,"intensity":65},
                 {"regime":"Choppy","duration_ms":60000,"intensity":50}],
     "agents":[{"kind":"MarketMaker","count":3,"mean_interarrival_ms":140,"size_min":15,"size_max":60,"spread_ticks":2,"inventory_limit":300},
               {"kind":"NoiseTrader","count":8,"mean_interarrival_ms":700,"size_min":1,"size_max":15},
               {"kind":"Momentum","count":3,"mean_interarrival_ms":1100,"size_min":10,"size_max":40,"aggression_bps":6000}]}'::jsonb,
   4, 'Trend Day'),

  (3, 2, 3003, 20250724, 1, 0,
   '{"open_price":10000,
     "timeline":[{"regime":"Calm","duration_ms":40000,"intensity":40},
                 {"regime":"NewsSpike","duration_ms":15000,"intensity":90},
                 {"regime":"Volatile","duration_ms":120000,"intensity":80},
                 {"regime":"Choppy","duration_ms":65000,"intensity":60}],
     "agents":[{"kind":"MarketMaker","count":3,"mean_interarrival_ms":160,"size_min":8,"size_max":35,"spread_ticks":4,"inventory_limit":200},
               {"kind":"NoiseTrader","count":10,"mean_interarrival_ms":500,"size_min":1,"size_max":20},
               {"kind":"Sweeper","count":2,"mean_interarrival_ms":4000,"size_min":40,"size_max":150,"aggression_bps":10000}]}'::jsonb,
   7, 'Headline Risk'),

  (4, 2, 4004, 20250724, 1, 0,
   '{"open_price":10000,
     "timeline":[{"regime":"Calm","duration_ms":30000,"intensity":30},
                 {"regime":"FlashCrash","duration_ms":25000,"intensity":100},
                 {"regime":"LiquidityGap","duration_ms":30000,"intensity":85},
                 {"regime":"Volatile","duration_ms":95000,"intensity":70}],
     "agents":[{"kind":"MarketMaker","count":2,"mean_interarrival_ms":200,"size_min":5,"size_max":25,"spread_ticks":6,"inventory_limit":150},
               {"kind":"NoiseTrader","count":8,"mean_interarrival_ms":450,"size_min":1,"size_max":25},
               {"kind":"Momentum","count":4,"mean_interarrival_ms":800,"size_min":15,"size_max":60,"aggression_bps":8000},
               {"kind":"Sweeper","count":3,"mean_interarrival_ms":2500,"size_min":50,"size_max":200,"aggression_bps":10000}]}'::jsonb,
   9, 'Flash Crash'),

  (5, 1, 5005, 20250724, 1, 0,
   '{"open_price":10000,
     "timeline":[{"regime":"Squeeze","duration_ms":240000,"intensity":75}],
     "agents":[{"kind":"MarketMaker","count":3,"mean_interarrival_ms":150,"size_min":10,"size_max":45,"spread_ticks":3,"inventory_limit":250},
               {"kind":"NoiseTrader","count":6,"mean_interarrival_ms":650,"size_min":1,"size_max":15},
               {"kind":"Momentum","count":5,"mean_interarrival_ms":900,"size_min":12,"size_max":50,"aggression_bps":7500}]}'::jsonb,
   6, 'The Squeeze'),

  (6, 1, 6006, 20250724, 1, 0,
   '{"open_price":10000,
     "timeline":[{"regime":"Choppy","duration_ms":300000,"intensity":55}],
     "agents":[{"kind":"MarketMaker","count":5,"mean_interarrival_ms":110,"size_min":25,"size_max":90,"spread_ticks":2,"inventory_limit":500},
               {"kind":"NoiseTrader","count":9,"mean_interarrival_ms":600,"size_min":1,"size_max":18},
               {"kind":"MeanReversion","count":4,"mean_interarrival_ms":1000,"size_min":8,"size_max":35}]}'::jsonb,
   5, 'The Chop')
ON CONFLICT (id) DO UPDATE
  SET spec = EXCLUDED.spec, label = EXCLUDED.label, difficulty = EXCLUDED.difficulty;

SELECT setval('scenarios_id_seq', (SELECT MAX(id) FROM scenarios));

-- ---------------------------------------------------------------------------
-- Practice drills. starting_cash is 100,000.00 in micros.
-- Objective kinds understood by the evaluator:
--   min_pnl | max_drawdown | min_maker_ratio_bps | min_fills | max_position
-- ---------------------------------------------------------------------------
INSERT INTO practice_drills (id, slug, scenario_id, title, subtitle, description,
                             skill_tag, difficulty, duration_ms, starting_cash,
                             objectives, star_thresholds, xp_reward, unlock_level, sort_order)
VALUES
  (1, 'first-fill', 1, 'First Fill', 'Learn the ladder',
   'A quiet book with a tight spread. Get comfortable placing and cancelling limit orders, and finish without blowing up.',
   'fundamentals', 1, 120000, 100000000000,
   '[{"id":"fills","kind":"min_fills","target":5,"label":"Complete 5 fills"},
     {"id":"survive","kind":"min_pnl","target":-5000000,"label":"Lose less than $5"}]'::jsonb,
   ARRAY[0, 25000000, 100000000]::BIGINT[], 100, 1, 10),

  (2, 'passive-edge', 1, 'Passive Edge', 'Earn the spread',
   'The spread is your paycheck. Quote both sides, get filled as a maker, and let the noise traders pay you. Taking liquidity here is how you lose.',
   'passive_execution', 3, 180000, 100000000000,
   '[{"id":"maker","kind":"min_maker_ratio_bps","target":7000,"label":"70% of fills as maker"},
     {"id":"pnl","kind":"min_pnl","target":50000000,"label":"Finish up $50"}]'::jsonb,
   ARRAY[50000000, 150000000, 400000000]::BIGINT[], 200, 1, 20),

  (3, 'ride-the-trend', 2, 'Ride The Trend', 'Stop fading strength',
   'A persistent one-way drift. The instinct to fade an extended move is exactly what this drill is built to punish.',
   'directional', 4, 300000, 100000000000,
   '[{"id":"pnl","kind":"min_pnl","target":100000000,"label":"Finish up $100"},
     {"id":"dd","kind":"max_drawdown","target":200000000,"label":"Keep drawdown under $200"}]'::jsonb,
   ARRAY[100000000, 350000000, 800000000]::BIGINT[], 250, 2, 30),

  (4, 'chop-discipline', 6, 'Chop Discipline', 'Do less',
   'Mean-reverting noise with no trend to catch. Overtrading a range is the most expensive habit in the game — the winning move is usually fewer moves.',
   'risk', 5, 300000, 100000000000,
   '[{"id":"pnl","kind":"min_pnl","target":0,"label":"Finish flat or better"},
     {"id":"pos","kind":"max_position","target":150,"label":"Never exceed 150 lots"}]'::jsonb,
   ARRAY[0, 120000000, 300000000]::BIGINT[], 300, 3, 40),

  (5, 'headline-risk', 3, 'Headline Risk', 'Survive the gap',
   'A news print reprices the book through several levels with no warning. Your resting orders will be run over. Manage the aftermath.',
   'tape_reading', 7, 240000, 100000000000,
   '[{"id":"pnl","kind":"min_pnl","target":0,"label":"Finish flat or better"},
     {"id":"dd","kind":"max_drawdown","target":500000000,"label":"Keep drawdown under $500"}]'::jsonb,
   ARRAY[0, 200000000, 600000000]::BIGINT[], 400, 4, 50),

  (6, 'the-squeeze', 5, 'The Squeeze', 'Shorts get carried out',
   'A grinding advance with no pullback to cover into. Every level looks like the top. None of them are.',
   'risk', 6, 240000, 100000000000,
   '[{"id":"pnl","kind":"min_pnl","target":50000000,"label":"Finish up $50"}]'::jsonb,
   ARRAY[0, 200000000, 500000000]::BIGINT[], 350, 4, 60),

  (7, 'flash-crash', 4, 'Flash Crash', 'The book disappears',
   'A liquidity cascade followed by a partial recovery. The bid vanishes, then comes back thinner. The whole drill is one decision made under time pressure.',
   'risk', 9, 180000, 100000000000,
   '[{"id":"pnl","kind":"min_pnl","target":-50000000,"label":"Lose less than $50"},
     {"id":"dd","kind":"max_drawdown","target":800000000,"label":"Keep drawdown under $800"}]'::jsonb,
   ARRAY[-50000000, 100000000, 500000000]::BIGINT[], 600, 6, 70)
ON CONFLICT (id) DO UPDATE
  SET title = EXCLUDED.title, description = EXCLUDED.description,
      objectives = EXCLUDED.objectives, star_thresholds = EXCLUDED.star_thresholds;

SELECT setval('practice_drills_id_seq', (SELECT MAX(id) FROM practice_drills));

-- ---------------------------------------------------------------------------
-- Achievements
-- ---------------------------------------------------------------------------
INSERT INTO achievements (id, name, description, icon, tier, xp_reward, grants_title, criteria)
VALUES
  ('first_blood',   'First Blood',    'Win your first ranked match.',              'sword',   1, 100, NULL,
   '{"kind":"wins","target":1}'::jsonb),
  ('maker_1000',    'Liquidity Provider', 'Complete 1,000 maker fills.',            'layers',  2, 300, 'Provider',
   '{"kind":"maker_fills","target":1000}'::jsonb),
  ('drawdown_iron', 'Iron Stomach',   'Win a match after being down more than $500.', 'shield', 3, 400, NULL,
   '{"kind":"comeback","target":500000000}'::jsonb),
  ('perfect_drill', 'Three Stars',    'Earn three stars on any drill.',            'star',    2, 200, NULL,
   '{"kind":"drill_stars","target":3}'::jsonb),
  ('all_drills',    'Curriculum',     'Clear every published drill.',              'book',    3, 800, 'Scholar',
   '{"kind":"all_drills","target":1}'::jsonb),
  ('elo_1500',      'Contender',      'Reach 1500 ELO.',                           'trophy',  2, 300, 'Contender',
   '{"kind":"elo","target":1500}'::jsonb),
  ('elo_1800',      'Arena Master',   'Reach 1800 ELO.',                           'crown',   4, 1000, 'Arena Master',
   '{"kind":"elo","target":1800}'::jsonb),
  ('streak_7',      'Seven Straight', 'Play on seven consecutive days.',           'flame',   2, 250, NULL,
   '{"kind":"streak","target":7}'::jsonb),
  ('volume_10k',    'Size Trader',    'Trade 10,000 lots lifetime.',               'bar',     2, 250, NULL,
   '{"kind":"volume","target":10000}'::jsonb),
  ('brilliant_10',  'Brilliant',      'Have 10 trades graded Brilliant.',          'gem',     3, 500, 'Brilliant',
   '{"kind":"graded","grade":1,"target":10}'::jsonb)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description,
      xp_reward = EXCLUDED.xp_reward, criteria = EXCLUDED.criteria;
