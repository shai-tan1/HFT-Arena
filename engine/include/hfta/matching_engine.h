// hfta/matching_engine.h — the deterministic event loop that owns the book.
//
// LAYERING (strict, one direction):
//
//   ZmqGateway ──(SPSC ring)──> MatchingEngine ──> RiskEngine ──> OrderBook
//        ^                            │                              │
//        └────(SPSC ring)──── EventBuffer <──────── Sink events ─────┘
//
// The engine thread is the ONLY thread that touches the book, the accounts,
// the scenario generator or the PRNGs. The gateway thread only pushes bytes
// into a ring and pops bytes out of another. That single-writer discipline is
// what makes the whole thing deterministic and lock-free at the same time.
#pragma once

#include <vector>

#include "hfta/order_book.h"
#include "hfta/scenario_generator.h"
#include "hfta/types.h"

namespace hfta {

// ---------------------------------------------------------------------------
// Account — integer arithmetic only, no doubles, so PnL is reproducible.
// ---------------------------------------------------------------------------
struct Account {
  ClientId client_id{0};
  Money    cash{0};              // starting simulated funds (unlocked by ELO)
  Money    reserved{0};          // margin locked by open orders + open position
  Qty      position{0};          // signed
  Money    cost_basis{0};        // signed running cost, micro-units
  Money    realized_pnl{0};
  std::uint32_t orders_sent{0};
  std::uint32_t orders_live{0};

  [[nodiscard]] Money buying_power() const noexcept { return cash - reserved; }
};

// ---------------------------------------------------------------------------
// RiskEngine — pre-trade checks. Every rejection here is a teachable moment,
// so each one carries a specific RejectReason that the UI can surface verbatim.
//
// Margin model (deliberately simple, and honest about it):
//   long  requirement = qty * price * tick_value * margin_bps_long  / 10000
//   short requirement = qty * price * tick_value * margin_bps_short / 10000
// Open BUY orders reserve at their limit price. Market buys reserve at a
// configurable worst-case band above the ask, otherwise an unpriced market
// order is unbounded risk. Open SELL orders that would flip the account short
// reserve short margin; sells that merely close a long reserve nothing.
// ---------------------------------------------------------------------------
class RiskEngine {
 public:
  explicit RiskEngine(const InstrumentSpec& spec, std::uint32_t market_band_bps);

  [[nodiscard]] RejectReason validate(const Account& acct,
                                      const NewOrderCmd& cmd,
                                      Price reference_price) const noexcept;

  void on_order_accepted(Account&, const NewOrderCmd&, Price reserve_price) noexcept;
  void on_order_removed(Account&, const Order&) noexcept;   // cancel / expiry
  void on_fill(Account&, const Fill&) noexcept;             // realizes PnL, re-margins

  [[nodiscard]] Money mark_to_market(const Account&, Price mid_half_ticks) const noexcept;
  [[nodiscard]] AccountSnapshot snapshot(const Account&, Nanos, Seq,
                                         Price mid_half_ticks) const noexcept;

 private:
  InstrumentSpec spec_;
  std::uint32_t  market_band_bps_;   // worst-case slippage assumed for market buys
};

// ---------------------------------------------------------------------------
// EventBuffer — the Sink the book writes into. Batches events for one command
// so the gateway drains whole coherent groups rather than per-event syscalls.
// ---------------------------------------------------------------------------
class EventBuffer {
 public:
  void on_fill(const Fill& f)              { fills_.push_back(f); }
  void on_ack(const OrderAck& a)           { acks_.push_back(a); }
  void on_trade_print(const TradePrint& t) { prints_.push_back(t); }
  void on_level_delta(const LevelDelta& d) { deltas_.push_back(d); }

  void clear() noexcept {
    fills_.clear(); acks_.clear(); prints_.clear(); deltas_.clear();
  }
  [[nodiscard]] bool empty() const noexcept {
    return fills_.empty() && acks_.empty() && prints_.empty() && deltas_.empty();
  }

  const std::vector<Fill>&       fills()  const noexcept { return fills_; }
  const std::vector<OrderAck>&   acks()   const noexcept { return acks_; }
  const std::vector<TradePrint>& prints() const noexcept { return prints_; }
  const std::vector<LevelDelta>& deltas() const noexcept { return deltas_; }

 private:
  std::vector<Fill>       fills_;
  std::vector<OrderAck>   acks_;
  std::vector<TradePrint> prints_;
  std::vector<LevelDelta> deltas_;
};

// ---------------------------------------------------------------------------
// MatchingEngine
// ---------------------------------------------------------------------------
struct EngineConfig {
  InstrumentSpec spec;
  std::size_t    order_capacity{1u << 17};   // 131072 live orders
  Money          starting_cash{0};           // per player, set by the backend
  std::uint32_t  market_band_bps{500};       // 5% worst case for market buys
  std::uint32_t  msgs_per_second_cap{200};   // anti-spam; also a fairness lever
  Nanos          match_duration{0};          // 0 == open ended (practice mode)
  Nanos          snapshot_interval{20'000'000};  // 50 Hz L2 publish
};

enum class EngineState : std::uint8_t {
  Idle = 0, Armed = 1, Running = 2, Paused = 3, Finished = 4
};

class MatchingEngine {
 public:
  explicit MatchingEngine(EngineConfig cfg);

  // -- lifecycle (driven by CTL_* messages from the Node backend) ------------
  void arm(const ScenarioSpec& scenario, const std::vector<ClientId>& players);
  void start(Nanos epoch);
  void pause();
  void resume();
  void finish();
  [[nodiscard]] EngineState state() const noexcept { return state_; }

  // -- main pump ------------------------------------------------------------
  // Advances logical time to `until`, interleaving (a) queued player commands
  // and (b) scheduled synthetic-agent events in strict timestamp order, ties
  // broken by (source, agent_id, arrival_seq). Returns the number of events
  // processed. Called in a tight loop by the engine thread; in replay mode it
  // is called with the recorded timestamps and produces identical output.
  std::size_t run_until(Nanos until, EventBuffer& out);

  // -- command entry points -------------------------------------------------
  SubmitResult on_new_order(const NewOrderCmd&, Nanos now, EventBuffer& out);
  bool         on_cancel(const CancelCmd&, Nanos now, EventBuffer& out);
  SubmitResult on_replace(const ReplaceCmd&, Nanos now, EventBuffer& out);
  void         on_flatten(ClientId, Nanos now, EventBuffer& out);  // panic button

  // -- read models ----------------------------------------------------------
  [[nodiscard]] const OrderBook& book() const noexcept { return book_; }
  [[nodiscard]] const Account&   account(ClientId) const;
  [[nodiscard]] AccountSnapshot  snapshot(ClientId, Nanos) const;
  [[nodiscard]] Nanos            now() const noexcept { return clock_; }
  [[nodiscard]] Seq              seq() const noexcept { return seq_; }

  // Rolling VWAP over the trailing micro-window — the Phase 3 benchmark. Kept
  // here rather than in the backend because it needs the tape at full fidelity
  // and integer precision; the backend only ever sees a downsampled feed.
  //   VWAP = sum(P_i * V_i) / sum(V_i)   over trades in [now - w, now]
  [[nodiscard]] Price rolling_vwap(Nanos window) const noexcept;
  // Forward-looking variant, computed at match end when the future is known.
  // Grading a fill against the VWAP of the window AFTER it is what makes a
  // "Brilliant" tag meaningful rather than tautological.
  [[nodiscard]] Price forward_vwap(Nanos from, Nanos window) const noexcept;

  // Determinism assertion: mirrored containers must agree at equal seq.
  [[nodiscard]] std::uint64_t state_hash() const noexcept;

 private:
  void expire_and_settle(EventBuffer& out);   // called on finish()
  void publish_snapshot_if_due(EventBuffer& out);

  // Shared path for player commands and synthetic agent commands. Agents skip
  // pre-trade risk (they are the market, not participants with a balance);
  // players do not.
  SubmitResult submit_internal(const NewOrderCmd&, EventBuffer& out);
  // Applies newly emitted fills to accounts and newly emitted prints to the
  // VWAP tape. Called with the buffer sizes captured before the command ran.
  void post_process(EventBuffer& out, std::size_t fill_from,
                    std::size_t print_from);
  Account* account_ptr(ClientId) noexcept;
  [[nodiscard]] bool is_agent(ClientId c) const noexcept {
    return c >= ScenarioGenerator::kFirstAgentClientId;
  }

  EngineConfig       cfg_;
  OrderBook          book_;
  RiskEngine         risk_;
  ScenarioGenerator  scenario_;
  std::vector<Account> accounts_;             // dense, indexed by seat number

  // Trailing tape for VWAP. Ring buffer sized to the longest benchmark window.
  struct TapeEntry { Nanos ts; Price price; Qty qty; };
  std::vector<TapeEntry> tape_;
  std::size_t            tape_head_{0};

  Nanos       clock_{0};
  Nanos       started_at_{0};
  Nanos       next_snapshot_{0};
  Seq         seq_{0};
  EngineState state_{EngineState::Idle};
};

}  // namespace hfta
