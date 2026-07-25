# HFT Arena — Phase 1 & 2 Technical Blueprint

> Scope: environment, process topology, IPC, data model, and the C++ core market
> engine. Phases 3–5 are referenced only where a Phase 1/2 decision constrains
> them — and several do, which is the point of writing this down now.

---

## 0. The decision that has to be made before anything else

Your Phase 4 spec says two players "trade against the exact same isolated market
simulation," and that the backend spins up "a new, isolated Docker container of
the C++ market engine the moment two players match." Those two sentences can
mean two very different architectures, and everything in Phase 2 depends on
which one you pick.

**Option A — Shared book.** One engine, both players in the same LOB. Their
orders queue against each other. Maximally adversarial and thematically closest
to 8-ball pool, where you genuinely share the table.

**Option B — Mirrored books.** Two engine instances, same seed, same synthetic
flow. Each player's fills consume only their own copy of the liquidity.

| | Shared book | Mirrored books |
|---|---|---|
| Fairness | Network latency becomes skill. A player 40 ms closer to the datacenter wins queue position on every level. | Latency-neutral. Each player races only the synthetic agents. |
| Griefing | Trivial. Spam the book, deny the opponent any fill, win on a flat PnL. | Impossible. |
| Determinism | Depends on human arrival order → cannot be replayed exactly. | Fully replayable from a 16-byte seed. |
| Scaling | 1 container per match | 2 containers per match (or 1 process, 2 book instances) |
| Cheat detection | Hard — outcomes are entangled | Easy — re-run the seed, compare state hashes |

**Recommendation: Option B, with a shared-book "Pit Mode" as a later unlock.**

Mirrored is what makes the rest of your product work. Deterministic replay from
a seed is what lets you grade trades post-hoc against forward VWAP (Phase 3),
show a post-match timeline (Phase 5), detect cheating, and debug a disputed
match six months later. Shared-book throws all of that away in exchange for a
mechanic that will feel unfair the first time a player loses to ping.

The headers in `engine/include/hfta/` are written for Option B and note where
Option A would change things.

---

## 1. Phase 1 — Environment & Topology

### 1.1 Toolchain on Zorin OS

Zorin 17 is Ubuntu 22.04-based; Zorin 18 is 24.04-based. Either is fine.

```bash
sudo apt install build-essential ninja-build ccache pkg-config \
                 gdb linux-tools-common linux-tools-generic
# GCC 13+ or Clang 17+ — you want C++20 <bit> (countl_zero/countr_zero)
sudo apt install gcc-13 g++-13 clang-17 clang-tidy-17

# CMake newer than apt ships:
sudo snap install cmake --classic

# Dependencies via vcpkg (pinned manifest beats system packages here — you
# need the same libzmq version inside the container and on the dev box)
git clone https://github.com/microsoft/vcpkg ~/vcpkg && ~/vcpkg/bootstrap-vcpkg.sh
```

`vcpkg.json`: `cppzmq`, `spdlog`, `gtest`, `benchmark`, `xxhash`, `simdjson`
(scenario config only — never the hot path).

### 1.2 CLion configuration

Create five CMake profiles (all defined in `engine/CMakeLists.txt`):

| Profile | Build type | Extra flags | Use for |
|---|---|---|---|
| Debug | Debug | — | Stepping through matching logic |
| ASan | Debug | `-fsanitize=address,undefined` | Arena and ring-buffer bugs |
| TSan | Debug | `-fsanitize=thread` | **Mandatory** for the SPSC ring and gateway |
| RelWithDeb | RelWithDebInfo | — | `perf record` profiling |
| Release | Release | — | Container builds |

Toolchain: point CLion at `~/vcpkg/scripts/buildsystems/vcpkg.cmake` via
`CMAKE_TOOLCHAIN_FILE`. Enable clang-tidy in-editor with a `.clang-tidy` that
turns on `performance-*`, `bugprone-*`, `cppcoreguidelines-pro-type-*`.

Two settings that matter more than they look:

- **Do not use `-march=native`.** Mirrored containers may land on different host
  CPUs. Pin `-march=x86-64-v3` so codegen is identical everywhere.
- **`-ffast-math` is banned.** It licenses arithmetic reordering, which breaks
  reproducibility. The engine uses integer math precisely so this is cheap to
  enforce.

Also configure CLion's **Remote / Docker toolchain** early. Building inside the
same image you deploy eliminates an entire category of "works on my machine"
divergence, which for a determinism-critical system is not a nice-to-have.

### 1.3 Process topology

```
                         ┌──────────────────────────────┐
   Browser ──WSS────────>│  Node.js / Express + ws      │
   (React + Lightweight  │  ─ session, auth, REST       │
    Charts)              │  ─ matchmaking               │
                         │  ─ WS fan-out to players     │
                         └──┬────────────┬──────────────┘
                            │            │
              ZeroMQ        │            │  Redis
     (per-match data plane) │            │  (control plane)
                            │            │
          ┌─────────────────▼──┐      ┌──▼────────────────────┐
          │ Engine container A │      │ Redis                 │
          │  ROUTER  :7001     │      │  ─ ELO matchmaking ZSET│
          │  PUB     :7002     │      │  ─ warm container pool │
          │  REP     :7003     │      │  ─ session / presence  │
          └────────────────────┘      │  ─ rate limits         │
          ┌────────────────────┐      └───────────────────────┘
          │ Engine container B │                 │
          │  (same seed)       │      ┌──────────▼────────────┐
          └────────────────────┘      │ PostgreSQL            │
                                      │  (batched via outbox) │
                                      └───────────────────────┘
```

**Use both Redis and ZeroMQ — they are not competing for the same job.**

- ZeroMQ is brokerless: engine→backend is one hop, single-digit microseconds
  over `ipc://`, tens over TCP loopback. It carries everything *inside* a match.
- Redis carries everything *about* matches: the ELO-sorted matchmaking queue
  (`ZADD queue:ranked <elo> <userId>` plus a widening-band `ZRANGEBYSCORE`),
  presence, the warm-container pool, session state, and rate-limit counters.

Routing a fill through Redis pub/sub would add a broker round-trip to your
lowest-latency path for no benefit — and Redis pub/sub is lossy anyway, so
you'd still need the gap-recovery logic you get from ZeroMQ SUB.

### 1.4 Docker strategy — and the cold-start trap

The naive version of "spin up a container the moment two players match" costs
you 300–800 ms of image pull, container create, process start, socket bind, and
scenario arm. That lands right in the middle of the moment a player is staring
at a "Match found!" screen.

**Pre-warm a pool.** Keep N idle engine containers running, armed but not
started, registered in a Redis set. Matchmaking pops two, sends `CtlArm` with
the scenario blob, waits for both to echo the same `fingerprint`, then sends
`CtlStart` to both in the same tick. Match start becomes ~5 ms. `OrderBook::reset()`
exists specifically so a finished container can be recycled into the pool
instead of destroyed.

Container hardening: multi-stage build onto `debian:bookworm-slim`, non-root
user, read-only rootfs, `--cpus=1 --memory=256m --pids-limit=64`, no network
except the three ZMQ ports, and a hard TTL so a wedged engine can never outlive
its match.

### 1.5 Data model

See `db/schema.sql`. Three decisions worth calling out:

1. **No floating point for prices or money, anywhere.** `BIGINT` ticks and
   `BIGINT` micro-units, matching the engine exactly. A `DOUBLE PRECISION`
   balance column will eventually disagree with the engine, and the player will
   find it before you do.
2. **A scenario is a seed, not a tape.** `(seed_hi, seed_lo, scenario_version, spec)`
   — about 200 bytes — reproduces a ten-minute match exactly. Pin
   `engine_version` (git SHA) on the match row; a replay against a different
   engine build is not a replay.
3. **Nothing in a live match writes to Postgres.** Fills land in an in-memory
   buffer and the `ingest_outbox`; a worker drains it with `COPY`. `orders` and
   `fills` are partitioned by `match_id` range from day one, because retrofitting
   partitioning onto a live table is miserable.

---

## 2. Phase 2 — The Core Market Engine

Headers: `engine/include/hfta/{types,order_book,matching_engine,scenario_generator}.h`

### 2.1 Order book data structure

Four questions must be O(1) or effectively so:

| Question | Mechanism | Cost |
|---|---|---|
| Best bid / ask? | Cached index + occupancy bitmap | ~1 cycle amortized |
| FIFO queue at price P? | `levels_[P - tick_floor]` | 1 subtraction, 1 load |
| Append at back of P? | Intrusive tail insert | O(1) |
| Cancel order #12345? | `id → OrderRef` hash, then unlink | O(1) |

**Layer 1 — flat price-level array.** `levels_[i]` is the queue at
`tick_floor + i`. Mapping price to level is a subtraction, not a tree descent.
One array serves both sides: in an uncrossed book a given tick can hold bids or
asks but never both, since crossing is resolved on entry. A 32k-tick window at
24 B per level is 768 KB — trivial per container.

The rejected alternative, `std::map<Price, Level>`, is correct and unbounded but
costs a red-black descent (5–8 dependent cache misses) on the single hottest
operation in the system. Keep it behind a policy flag; use the flat array.

**Layer 2 — occupancy bitmaps.** One bit per level per side. When a level
empties, finding the new best price is a word scan with `countl_zero` /
`countr_zero` — 64 ticks per instruction, and in practice it almost never leaves
the first word.

**Layer 3 — intrusive FIFO by index.** Orders live in a preallocated arena and
link by `uint32` index, not pointer. Half the size, survives arena
reallocation, and position-independent — which matters the day you move the
arena into shared memory. Tail insert and middle unlink are both O(1), which is
exactly price-time priority plus O(1) cancel.

**Layer 4 — open-addressed `OrderId → OrderRef` map.** No allocation after
construction. `std::unordered_map` is banned from the hot path: pointer chase
per bucket, and its iteration order is a determinism trap.

Bounded price window is safe here because you control the instrument. Allocate
±60% around the scenario open; treat a breach as a scenario-terminating event
rather than something to branch on in the hot path.

### 2.2 Matching — price-time priority

Aggressive order arrives → walk the opposite bitmap from the touch outward,
consuming FIFO within each level, until the limit price is exceeded or the size
is exhausted. Points the headers encode:

- **Fills print at the resting order's price**, not the aggressor's. Price
  improvement lives in that gap and is a real skill the game should teach.
- **Time priority uses `arrival_seq`, never a clock.** Wall-clock ties are
  nondeterministic; a monotonic sequence number is not.
- **TIF semantics:** `FOK` checks `available_liquidity()` before mutating
  anything; `PostOnly` rejects rather than crosses; `IOC` cancels the residual.
- **Replace loses queue position** on any price change or size increase, keeps
  it on a pure size decrease. Real venue semantics, and worth surfacing in the
  UI as a teaching moment.
- **Self-trade prevention** defaults to cancel-resting.

### 2.3 Risk and short selling

Pre-trade only, integer only. Every rejection carries a specific
`RejectReason` — each one is a teachable moment the UI should surface verbatim
rather than a generic "order rejected."

```
long  requirement = qty × price × tick_value × margin_bps_long  / 10000
short requirement = qty × price × tick_value × margin_bps_short / 10000
```

Open buy limits reserve at their limit price. **Market buys reserve at a
configurable worst-case band above the ask** (`market_band_bps`, default 500) —
without this an unpriced market order is unbounded risk and a player can blow
through their margin in one click. Sells that close a long reserve nothing;
sells that flip the account short reserve short margin.

### 2.4 The scenario generator, and the determinism problem hiding in it

Here is the subtle one, and it is worth reading twice.

Both players must face "the exact same order flow." But their own orders change
the book, and any agent that *reacts* to the book will therefore behave
differently in each container. Naively, the two simulations diverge and the
match is unfair.

The fix is to separate the **random stream** from the **decision**:

- Agent wakeup times derive only from `(seed, agent_id, n)` — identical in both
  containers, forever.
- At each wakeup an agent draws a **fixed number of variates unconditionally,
  before it looks at the book.** Draw counts never depend on state, so the two
  streams stay in lockstep permanently.
- Only the *mapping* from variates to action reads book state.

Result: identical stochastic input, but genuine market impact. Player A leaning
on the bid gets the market makers to skew away from them — exactly as they
should — without desynchronising Player B's world. And it stays verifiable:
`total_draws()` must match across containers at match end even though the books
do not.

Agent archetypes (`AgentKind`): market maker (inventory-skewed two-sided
quotes), noise trader (Poisson market orders), momentum, mean reversion, iceberg
whale, sweeper (your source of adverse selection), spoofer (layered size pulled
on approach — an excellent teaching tool).

Regimes (`Regime`) are what make a scenario feel like a *level* rather than
noise: Calm, Trending, Choppy, Volatile, LiquidityGap, NewsSpike, FlashCrash,
Squeeze. A `ScenarioSpec` is a timeline of regime segments plus an agent mix.

PRNG is xoshiro256** seeded via SplitMix64 — **not** `std::mt19937` with
`std::uniform_int_distribution`, because the standard does not specify identical
output across standard library implementations. That is a portability trap that
would silently break mirrored matches on a mixed fleet.

### 2.5 Threading

```
[zmq io thread] → [gateway thread] → SPSC ring → [engine thread] → SPSC ring → [gateway thread]
```

The engine thread never calls into libzmq, never blocks, never allocates in
steady state, and never reads a clock for decision purposes. The gateway thread
never touches engine state. One lock-free SPSC ring in each direction is the
only synchronisation primitive in the process.

### 2.6 Test matrix

The tests that will actually save you, in rough order of value:

| Test | What it catches |
|---|---|
| **Two engines, same seed → identical `state_hash()` after 10M events** | The single most valuable assertion in the system. Run it in CI on every commit. |
| Partial fill across multiple levels, verify residual rests correctly | Off-by-one in the bitmap scan |
| FOK with exactly-sufficient and one-lot-short liquidity | Premature mutation before the FOK check |
| PostOnly at, inside, and outside the spread | Crossing check inverted per side |
| Cancel head / middle / tail of a level | Intrusive unlink bugs |
| Cancel a filled order, cancel someone else's order | `UnknownOrder` vs `NotOrderOwner` |
| Short past margin; buy back to flat; flip long | Margin release on position reduction |
| Market buy with an empty ask book | Unbounded reserve, division by zero on mid |
| Arena exhaustion under order spam | `BookCapacityReached` vs silent corruption |
| Level empties → best price recomputation across a word boundary | The classic bitmap bug |
| Fuzz the wire decoder (libFuzzer) | Your only network-facing attack surface |

Also: run the SPSC ring and gateway under **TSan** specifically. A race in a
lock-free ring is invisible until it corrupts a live match.

---

## 3. What Phase 2 must expose for Phase 3

Two functions on `MatchingEngine`, and they belong in C++ rather than the
backend because grading needs the full-fidelity tape at integer precision while
the backend only ever sees a downsampled feed:

- `rolling_vwap(window)` — trailing benchmark, live.
- `forward_vwap(from, window)` — the benchmark computed at match end, over the
  window *after* the fill.

That second one is the one that makes the chess.com mechanic mean something.
Grading a fill against the VWAP of the window *before* it is close to
tautological — you already know whether you bought below the recent average.
Grading against the window *after* it is a real judgment: did this execution
turn out to be well-timed? "Brilliant" should mean the player took liquidity
right before a move that hadn't happened yet, or posted passively and got filled
by an adverse sweep they correctly anticipated.

Which also means: **grading is a post-match batch job, not a live one.** The
`grade` field is `Ungraded` on the wire during the match and backfilled by the
evaluator before the summary screen renders. Plan the Phase 5 PnL screen around
that ordering now.

---

## 4. Risks worth tracking from day one

1. **Determinism drift.** The mirrored-match guarantee is load-bearing for
   fairness, replay, grading and anti-cheat. Every state-hash mismatch is a P1.
   Void the match rather than settle it.
2. **Latency becomes skill.** Even in mirrored mode, a player on fiber sends
   orders faster than one on mobile. Consider a fixed server-side ingress
   delay (e.g. equalize all commands to a 50 ms floor) so the game rewards
   decisions, not connections.
3. **Scenario difficulty calibration.** Difficulty is currently a hand-set
   integer. Once you have match data, fit it to observed PnL dispersion, or
   the matchmaking bands will be measuring the scenario rather than the player.
4. **"Win by flat."** In a mirrored PvP scored on final equity, doing nothing is
   a legitimate strategy against an unlucky opponent. Consider a minimum
   participation requirement or scoring on risk-adjusted PnL, or your ranked
   ladder will fill with players who fold.
