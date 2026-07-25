// hfta/scenario_generator.h — synthetic order flow.
//
// ============================================================================
// THE CENTRAL CONSTRAINT
// ============================================================================
// In the PvP arena both players must face "the exact same order flow". That
// phrase hides a real design problem, because the players' own orders change
// the book, and any agent that reacts to the book will then behave differently
// for each player. If you let that happen naively, the two simulations diverge
// and the match is not fair.
//
// The fix is to separate the RANDOM STREAM from the DECISION:
//
//   * Every agent wakes on a schedule derived only from (seed, agent_id, n).
//     Wakeup times are pre-determined and identical in both containers.
//   * At each wakeup the agent draws a FIXED number of variates from its own
//     stream, unconditionally, before it looks at the book. Draw counts never
//     depend on state, so the streams stay in lockstep forever.
//   * Only the MAPPING from those variates to an action reads book state.
//
// Result: identical stochastic input, but genuine market impact. Player A
// leaning on the bid gets the market makers to skew away from them, exactly as
// it should, without desynchronising Player B's copy of the world. Both
// containers can still be verified: their agent PRNG counters must match at
// the end of the match even though their books do not.
//
// A ScenarioSpec is therefore fully described by a 128-bit seed plus a small
// config blob. The backend generates it ONCE at matchmaking, hands the same
// bytes to both containers, and stores it in Postgres. Replaying a match five
// months later is re-running the same 200 bytes.
// ============================================================================
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <vector>

#include "hfta/types.h"

namespace hfta {

// ---------------------------------------------------------------------------
// Deterministic PRNG. xoshiro256** seeded via SplitMix64. Chosen over
// std::mt19937 for speed and, more importantly, over std::uniform_*_distribution
// which is NOT specified to give identical results across standard libraries —
// a portability trap that would silently break mirrored matches.
// ---------------------------------------------------------------------------
class Rng {
 public:
  explicit Rng(std::uint64_t seed) noexcept { seed_from(seed); }

  std::uint64_t next() noexcept;
  // Lemire's bounded reduction — unbiased enough and branch-light.
  std::uint32_t below(std::uint32_t bound) noexcept;
  // Exponential inter-arrival in nanos for a Poisson process, integer output.
  Nanos exponential_nanos(Nanos mean) noexcept;
  // Symmetric integer jump, approximately Gaussian via the sum of uniforms.
  std::int32_t gaussian_ticks(std::uint32_t sigma) noexcept;

  [[nodiscard]] std::uint64_t draw_count() const noexcept { return draws_; }

 private:
  void seed_from(std::uint64_t) noexcept;
  std::array<std::uint64_t, 4> s_{};
  std::uint64_t draws_{0};   // lockstep verification counter
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
enum class AgentKind : std::uint8_t {
  MarketMaker   = 0,  // two-sided quotes, inventory-skewed, requotes on move
  NoiseTrader   = 1,  // Poisson market orders, no view — the liquidity tax payer
  Momentum      = 2,  // buys strength, sells weakness; creates trends
  MeanReversion = 3,  // fades extension; creates chop
  IcebergWhale  = 4,  // large hidden size worked over time
  Sweeper       = 5,  // periodic aggressive sweeps — the source of adverse selection
  Spoofer       = 6,  // layered non-bona-fide size, pulled on approach (teaching tool)
};

struct AgentConfig {
  AgentKind     kind{AgentKind::NoiseTrader};
  std::uint32_t count{1};              // how many clones of this archetype
  Nanos         mean_interarrival{0};  // Poisson rate
  Qty           size_min{1};
  Qty           size_max{10};
  std::uint32_t spread_ticks{2};       // MM quoting half-width
  std::uint32_t aggression_bps{0};     // probability of crossing, in bps
  std::int32_t  inventory_limit{0};    // MM skews hard past this
};

// ---------------------------------------------------------------------------
// Regimes — the thing that makes a scenario feel like a level rather than noise
// ---------------------------------------------------------------------------
enum class Regime : std::uint8_t {
  Calm         = 0,  // tight spread, deep book — teaches passive execution
  Trending     = 1,  // persistent drift — teaches not fading
  Choppy       = 2,  // mean reverting — punishes momentum chasing
  Volatile     = 3,  // wide spread, thin book
  LiquidityGap = 4,  // book empties on one side, then refills
  NewsSpike    = 5,  // instantaneous repricing, gap through levels
  FlashCrash   = 6,  // cascade + partial recovery
  Squeeze      = 7,  // grinding upward with no pullback — punishes shorts
};

struct RegimeSegment {
  Regime        regime{Regime::Calm};
  Nanos         duration{0};
  std::uint32_t intensity{50};   // 0-100, scales vol and book thinness
};

struct ScenarioSpec {
  std::uint64_t seed_hi{0};
  std::uint64_t seed_lo{0};
  std::uint32_t scenario_version{1};  // bump when agent logic changes; old
                                      // replays must pin their version
  Price         open_price{0};
  std::vector<RegimeSegment> timeline;
  std::vector<AgentConfig>   agents;

  // Stable hash over the whole spec. The backend sends it to both containers
  // and each replies with its computed value on CTL_ARM; a mismatch aborts the
  // match before anyone trades rather than after.
  [[nodiscard]] std::uint64_t fingerprint() const noexcept;
};

// A scheduled wakeup. The heap orders by (t, agent_id, nonce) — a TOTAL order,
// which is what keeps ties from being resolved by heap implementation details.
struct AgentWakeup {
  Nanos         t{0};
  std::uint32_t agent_id{0};
  std::uint64_t nonce{0};
  bool operator>(const AgentWakeup& o) const noexcept {
    if (t != o.t) return t > o.t;
    if (agent_id != o.agent_id) return agent_id > o.agent_id;
    return nonce > o.nonce;
  }
};

class OrderBook;  // fwd

class ScenarioGenerator {
 public:
  ScenarioGenerator() = default;

  // Builds the agent population and pre-seeds the wakeup heap. Deterministic
  // and side-effect free with respect to the book.
  void arm(const ScenarioSpec& spec, const InstrumentSpec& instrument);

  // Pops every wakeup with t <= until, emits synthetic commands via `emit`.
  // `emit` has signature void(const NewOrderCmd&) / void(const CancelCmd&) —
  // the generator never touches the book directly, it goes through the same
  // command path as a human, so agents are subject to identical matching rules.
  template <class EmitNew, class EmitCancel>
  void advance(Nanos until, const OrderBook& book, EmitNew&& emit_new,
               EmitCancel&& emit_cancel);

  [[nodiscard]] Regime current_regime(Nanos t) const noexcept;
  [[nodiscard]] std::uint32_t current_intensity(Nanos t) const noexcept;
  // Sum of per-agent draw counters — the lockstep proof for mirrored matches.
  [[nodiscard]] std::uint64_t total_draws() const noexcept;

  // ClientIds are allocated above kFirstAgentClientId so accounting code can
  // trivially separate human PnL from synthetic PnL.
  static constexpr ClientId kFirstAgentClientId = 1u << 20;

 private:
  struct AgentState {
    AgentConfig  cfg;
    ClientId     client_id{0};
    Rng          rng{0};
    Qty          inventory{0};
    OrderId      bid_quote{0};   // resting quotes to pull on requote
    OrderId      ask_quote{0};
    Price        last_ref{kNoPrice};
  };

  ScenarioSpec              spec_;
  InstrumentSpec            instrument_{};
  std::vector<AgentState>   agents_;
  std::vector<AgentWakeup>  heap_;     // std::push_heap with greater<>
  std::vector<Nanos>        segment_starts_;
};

}  // namespace hfta

// Template body for advance(). Must be last.
#include "hfta/scenario_generator.inl"
