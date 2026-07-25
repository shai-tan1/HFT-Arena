# Status and known gaps

Last updated: 2026-07-24.

## What runs today

| Piece | State |
| --- | --- |
| C++ order book + matching + scenario generator | Compiled, headless, determinism-verified. Not yet reachable from the backend. |
| TypeScript reference simulation (`backend/src/sim/`) | Complete. 24 self-check assertions pass. Drives every live match. |
| WebSocket gateway, matchmaking, lobbies | Complete. 15 integration assertions pass against a live server. |
| Solo practice (7 drills + free play) | Complete, including objective scoring and stars. |
| PvP (ranked, casual, private code) | Complete, including ELO with a provisional K-factor. |
| Trade screen | Complete: ladder, candles, tape, blotter, ticket, hotkeys, opponent panel. |
| Results, portfolio, leaderboards | Complete against the in-memory store. |
| PostgreSQL schema | Written, **not applied to a live server** — none was reachable here. |
| Postgres persistence in the backend | **Not wired.** The store is in-memory; the seam is `backend/src/db/store.ts`. |

## Bugs found and fixed while building this

Worth recording, because each one produced a plausible-looking market and none
would have been caught by reading the code.

1. **Volatility scaled linearly with `dt` instead of `sqrt(dt)`.** A random
   walk's spread grows with the square root of time. At a 20 Hz step this
   under-shot every shock by 4.5x, and after integer rounding a calm market did
   not move *at all* — twelve seeds, zero ticks of drift, every time.

2. **`gaussianTicks(sigma)` did not deliver `sigma`.** Irwin-Hall(4) centred has
   standard deviation 0.577, so the normalisation factor is 1.732. The code used
   0.8165, delivering 0.47σ — a silent 2.1x volatility under-shoot, compounding
   with (1). **The C++ mirror in `engine/include/hfta/scenario_generator.h` still
   has the 0.8165 constant and needs the same fix** before the two engines are
   cross-checked.

3. **Seeded liquidity was never cancelled.** The initial book was posted through
   the market makers but not registered as their quotes, so nobody ever pulled
   it. Every scenario carried a permanent wall of stale size at its *opening*
   price for the whole match — free money sitting in the middle of a trending
   chart, quietly invalidating every drill.

4. **Inventory skew collapsed every spread to one tick.** Skew shifts both of an
   MM's quotes together. Uncapped, with several MMs skewed in opposite
   directions, one MM's offer crossed below another's bid; PostOnly rejected
   whichever side would cross and the aggregate spread collapsed — in every
   regime, erasing the "volatile markets quote wider" property the entire regime
   table exists to produce. Capped at half the quoted half-spread.

5. **A test that passed on a broken engine.** The original drift check asserted
   only that mean drift was small. A completely motionless market passes that
   trivially. It now asserts motion *first*, then absence of bias. Likewise the
   regime-spread check compared a single instantaneous spread — which is 1 tick
   surprisingly often on a *working* engine, because a market maker mid-requote
   has one side pulled. It now compares distributions.

## Deliberately unfixed

### Carried over from the C++ skeleton

These are flagged in `skeleton/README.md` and still apply to `engine/`:

- **Order timestamps quantize to a 1 ms slice** rather than the exact wakeup
  time. Harmless for matching (FIFO within a level uses arrival sequence, not
  the timestamp) but it makes post-hoc latency analysis coarse.
- **No unit tests.** The GTest matrix is spec'd in `docs/ARCHITECTURE.md` §2.6
  and remains unwritten. `backend/src/sim/selfcheck.ts` covers the same
  properties for the TypeScript engine and is the model to port.

Two of the original four gaps are **fixed in the TypeScript engine and still
open in C++**:

- **Margin now persists for the open position** rather than fully releasing on
  fill. `MatchEngine.markToMarket()` recomputes position margin against the
  current mark every step.
- **Market makers now see their own inventory update**, so skew is live rather
  than inert. `ScenarioGenerator.notifyFill()`.

### New, in this layer

- **The backend does not persist.** Restarting it loses every account and
  result. `Store` is deliberately shaped so a Postgres mirror slots behind the
  same methods.
- **No refresh-token rotation.** `user_sessions` is modelled in the schema
  (storing a sha256, never the token) but `backend/src/util/tokens.ts` issues a
  1-hour access token and stops there. A stolen token cannot be revoked.
- **Trade grading is stubbed.** Every fill carries `TradeGrade.Ungraded`. The
  VWAP benchmark exists in the C++ engine and the columns exist in `fills`; the
  evaluator that fills them in does not.
- **Candles and equity samples are not written to Postgres.** `match_candles`,
  `practice_candles` and `match_equity_samples` are defined and unpopulated.
- **Achievements evaluate on a subset of criteria.** `Store.evaluateAchievements`
  handles wins, maker fills, stars, ELO, streak, volume and comebacks;
  `all_drills` and `brilliant_10` need the drill-completion set and the grader
  respectively.
- **One socket per account is enforced by kicking the older one.** Correct for
  anti-cheat, mildly annoying if you legitimately have two tabs open.

## The next real decision

The fork from the last session — GTest suite or ZeroMQ gateway — is now
*sharper*, not resolved, because the TypeScript engine removed the urgency from
both:

- **ZeroMQ gateway** buys real C++ performance and makes the C++ engine the one
  that actually runs matches. But `backend/src/sim/` already serves matches at
  10 Hz with headroom to spare, so this buys performance nobody is currently
  short of.
- **GTest suite** is now cheap to write and unusually well-specified: port
  `selfcheck.ts` assertion for assertion. It would immediately catch bug (2)
  above, which is still live in the C++ tree.

Given that a known bug is sitting in the C++ engine right now, and that the
TypeScript engine is carrying the product, the tests are the higher-value
target. The gateway can wait until there is a load problem to solve.
