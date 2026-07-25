#include "hfta/matching_engine.h"

#include <algorithm>
#include <stdexcept>

namespace hfta {

// ===========================================================================
// RiskEngine
// ===========================================================================
RiskEngine::RiskEngine(const InstrumentSpec& spec, std::uint32_t market_band_bps)
    : spec_(spec), market_band_bps_(market_band_bps) {}

namespace {

Money notional_micros(const InstrumentSpec& spec, Price price, Qty qty) noexcept {
  return price * spec.tick_value_micros * qty;
}

// How much of `qty` reduces existing exposure rather than adding to it.
// Closing a position needs no new margin; that distinction is the difference
// between a usable account and one that locks up after two round trips.
Qty closing_qty(Qty position, Side side, Qty qty) noexcept {
  if (side == Side::Buy && position < 0) return std::min(qty, -position);
  if (side == Side::Sell && position > 0) return std::min(qty, position);
  return 0;
}

}  // namespace

RejectReason RiskEngine::validate(const Account& acct, const NewOrderCmd& cmd,
                                  Price reference_price) const noexcept {
  if (cmd.qty <= 0) return RejectReason::QtyInvalid;
  if (cmd.qty > spec_.max_order_qty) return RejectReason::QtyAboveLimit;

  // An unpriced market buy is unbounded risk. Reserve against a worst-case
  // band above the reference instead, or a player can blow through their
  // margin in a single click and the engine will happily let them.
  Price px = cmd.price;
  if (cmd.type == OrderType::Market) {
    const Price band = (reference_price * static_cast<Price>(market_band_bps_)) / 10000;
    px = (cmd.side == Side::Buy) ? reference_price + band
                                 : std::max<Price>(1, reference_price - band);
  }
  if (px <= 0) return RejectReason::PriceOutOfBand;

  const Qty closing = closing_qty(acct.position, cmd.side, cmd.qty);
  const Qty opening = cmd.qty - closing;

  if (!spec_.allow_short && cmd.side == Side::Sell &&
      acct.position - cmd.qty < 0) {
    return RejectReason::ShortNotPermitted;
  }

  if (opening > 0) {
    const bool goes_short = (cmd.side == Side::Sell);
    const std::uint32_t bps =
        goes_short ? spec_.margin_bps_short : spec_.margin_bps_long;
    const Money req =
        (notional_micros(spec_, px, opening) * static_cast<Money>(bps)) / 10000;
    if (req > acct.buying_power()) return RejectReason::InsufficientMargin;
  }
  return RejectReason::None;
}

void RiskEngine::on_order_accepted(Account& acct, const NewOrderCmd& cmd,
                                   Price reserve_price) noexcept {
  const Qty closing = closing_qty(acct.position, cmd.side, cmd.qty);
  const Qty opening = cmd.qty - closing;
  if (opening <= 0) return;
  const std::uint32_t bps = (cmd.side == Side::Sell) ? spec_.margin_bps_short
                                                     : spec_.margin_bps_long;
  acct.reserved +=
      (notional_micros(spec_, reserve_price, opening) * static_cast<Money>(bps)) / 10000;
  ++acct.orders_sent;
}

void RiskEngine::on_order_removed(Account& acct, const Order& o) noexcept {
  const std::uint32_t bps = (o.side == Side::Sell) ? spec_.margin_bps_short
                                                   : spec_.margin_bps_long;
  const Money rel =
      (notional_micros(spec_, o.price, o.qty_open) * static_cast<Money>(bps)) / 10000;
  acct.reserved = std::max<Money>(0, acct.reserved - rel);
}

void RiskEngine::on_fill(Account& acct, const Fill& f) noexcept {
  const Money px = f.price * spec_.tick_value_micros;   // per-lot, micro-units
  const Qty signed_qty = (f.side == Side::Buy) ? f.qty : -f.qty;
  const Qty old_pos = acct.position;

  if (old_pos == 0) {
    acct.cost_basis = px;
    acct.position = signed_qty;
  } else if ((old_pos > 0) == (signed_qty > 0)) {
    // Adding to the position: volume-weighted average entry, integer math.
    const Qty abs_old = old_pos > 0 ? old_pos : -old_pos;
    acct.cost_basis =
        (acct.cost_basis * abs_old + px * f.qty) / (abs_old + f.qty);
    acct.position = old_pos + signed_qty;
  } else {
    // Reducing or flipping: realize PnL on the closed portion.
    const Qty abs_old = old_pos > 0 ? old_pos : -old_pos;
    const Qty closed = std::min(f.qty, abs_old);
    const Money per_lot = (px - acct.cost_basis) * (old_pos > 0 ? 1 : -1);
    const Money pnl = per_lot * closed;
    acct.realized_pnl += pnl;
    acct.cash += pnl;
    acct.position = old_pos + signed_qty;
    if (acct.position != 0 && ((acct.position > 0) != (old_pos > 0))) {
      acct.cost_basis = px;   // flipped through flat
    }
    if (acct.position == 0) acct.cost_basis = 0;
  }

  // Release the margin the (now consumed) order was holding.
  const std::uint32_t bps = (f.side == Side::Sell) ? spec_.margin_bps_short
                                                   : spec_.margin_bps_long;
  const Money rel =
      (notional_micros(spec_, f.price, f.qty) * static_cast<Money>(bps)) / 10000;
  acct.reserved = std::max<Money>(0, acct.reserved - rel);
}

Money RiskEngine::mark_to_market(const Account& acct,
                                 Price mid_half_ticks) const noexcept {
  if (acct.position == 0 || mid_half_ticks == kNoPrice) return 0;
  const Money mark = (mid_half_ticks * spec_.tick_value_micros) / 2;
  return (mark - acct.cost_basis) * acct.position;
}

AccountSnapshot RiskEngine::snapshot(const Account& acct, Nanos ts, Seq seq,
                                     Price mid_half_ticks) const noexcept {
  AccountSnapshot s{};
  s.seq = seq;
  s.ts = ts;
  s.client_id = acct.client_id;
  s.cash = acct.cash;
  s.reserved_margin = acct.reserved;
  s.position = acct.position;
  s.avg_entry_micros = acct.cost_basis;
  s.realized_pnl = acct.realized_pnl;
  s.unrealized_pnl = mark_to_market(acct, mid_half_ticks);
  s.equity = acct.cash + s.unrealized_pnl;
  return s;
}

// ===========================================================================
// MatchingEngine
// ===========================================================================
MatchingEngine::MatchingEngine(EngineConfig cfg)
    : cfg_(cfg),
      book_(cfg.spec, cfg.order_capacity),
      risk_(cfg.spec, cfg.market_band_bps) {
  tape_.reserve(1u << 16);
}

void MatchingEngine::arm(const ScenarioSpec& scenario,
                         const std::vector<ClientId>& players) {
  book_.reset();
  scenario_.arm(scenario, cfg_.spec);
  accounts_.clear();
  for (const ClientId c : players) {
    Account a{};
    a.client_id = c;
    a.cash = cfg_.starting_cash;
    accounts_.push_back(a);
  }
  tape_.clear();
  clock_ = 0;
  seq_ = 0;
  next_snapshot_ = cfg_.snapshot_interval;
  state_ = EngineState::Armed;
}

void MatchingEngine::start(Nanos epoch) {
  started_at_ = epoch;
  state_ = EngineState::Running;
}
void MatchingEngine::pause()  { if (state_ == EngineState::Running) state_ = EngineState::Paused; }
void MatchingEngine::resume() { if (state_ == EngineState::Paused)  state_ = EngineState::Running; }

void MatchingEngine::finish() {
  state_ = EngineState::Finished;
}

Account* MatchingEngine::account_ptr(ClientId c) noexcept {
  for (auto& a : accounts_) {
    if (a.client_id == c) return &a;
  }
  return nullptr;
}

const Account& MatchingEngine::account(ClientId c) const {
  for (const auto& a : accounts_) {
    if (a.client_id == c) return a;
  }
  throw std::out_of_range("no such account");
}

AccountSnapshot MatchingEngine::snapshot(ClientId c, Nanos ts) const {
  return risk_.snapshot(account(c), ts, seq_, book_.mid_half_ticks());
}

void MatchingEngine::post_process(EventBuffer& out, std::size_t fill_from,
                                  std::size_t print_from) {
  const auto& fills = out.fills();
  for (std::size_t i = fill_from; i < fills.size(); ++i) {
    if (Account* a = account_ptr(fills[i].client_id)) {
      risk_.on_fill(*a, fills[i]);
    }
  }
  const auto& prints = out.prints();
  for (std::size_t i = print_from; i < prints.size(); ++i) {
    tape_.push_back(TapeEntry{prints[i].ts, prints[i].price, prints[i].qty});
  }
}

SubmitResult MatchingEngine::submit_internal(const NewOrderCmd& cmd,
                                             EventBuffer& out) {
  const std::size_t f0 = out.fills().size();
  const std::size_t p0 = out.prints().size();

  if (!is_agent(cmd.client_id)) {
    Account* acct = account_ptr(cmd.client_id);
    if (acct == nullptr) {
      SubmitResult r{};
      r.reject = RejectReason::NotOrderOwner;
      return r;
    }
    Price ref = book_.has_bid() && book_.has_ask()
                    ? (book_.mid_half_ticks() + 1) / 2
                    : (book_.has_bid() ? book_.best_bid()
                                       : (book_.has_ask() ? book_.best_ask() : 1));
    const RejectReason rr = risk_.validate(*acct, cmd, ref);
    if (rr != RejectReason::None) {
      OrderAck ack{};
      ack.seq = ++seq_;
      ack.ts = clock_;
      ack.client_ord_id = cmd.client_ord_id;
      ack.client_id = cmd.client_id;
      ack.status = OrderStatus::Rejected;
      ack.reject = rr;
      out.on_ack(ack);
      SubmitResult r{};
      r.reject = rr;
      return r;
    }
  }

  SubmitResult res = book_.submit(cmd, clock_, seq_, out);
  post_process(out, f0, p0);
  return res;
}

SubmitResult MatchingEngine::on_new_order(const NewOrderCmd& cmd, Nanos now,
                                          EventBuffer& out) {
  clock_ = std::max(clock_, now);
  return submit_internal(cmd, out);
}

bool MatchingEngine::on_cancel(const CancelCmd& cmd, Nanos now, EventBuffer& out) {
  clock_ = std::max(clock_, now);
  return book_.cancel(cmd.order_id, cmd.client_id, clock_, seq_, out);
}

SubmitResult MatchingEngine::on_replace(const ReplaceCmd& cmd, Nanos now,
                                        EventBuffer& out) {
  clock_ = std::max(clock_, now);
  const std::size_t f0 = out.fills().size();
  const std::size_t p0 = out.prints().size();
  SubmitResult r = book_.replace(cmd, clock_, seq_, out);
  post_process(out, f0, p0);
  return r;
}

void MatchingEngine::on_flatten(ClientId c, Nanos now, EventBuffer& out) {
  clock_ = std::max(clock_, now);
  book_.cancel_all_for(c, clock_, seq_, out);
  Account* a = account_ptr(c);
  if (a == nullptr || a->position == 0) return;

  NewOrderCmd flat{};
  flat.client_ord_id = 0;
  flat.client_id = c;
  flat.qty = a->position > 0 ? a->position : -a->position;
  flat.side = a->position > 0 ? Side::Sell : Side::Buy;
  flat.type = OrderType::Market;
  flat.tif = TimeInForce::IOC;
  submit_internal(flat, out);
}

std::size_t MatchingEngine::run_until(Nanos until, EventBuffer& out) {
  if (state_ != EngineState::Running) return 0;
  std::size_t events = 0;

  // Time advances in slices so agent order timestamps stay close to their
  // scheduled wakeups. A slice finer than the fastest agent's interarrival
  // buys nothing; 1 ms is the right order of magnitude here.
  constexpr Nanos kSlice = 1'000'000;

  while (clock_ < until) {
    const Nanos step = std::min(until, clock_ + kSlice);
    clock_ = step;

    scenario_.advance(
        step, book_,
        [&](const NewOrderCmd& c) -> OrderId {
          ++events;
          return submit_internal(c, out).order_id;
        },
        [&](const CancelCmd& c) {
          ++events;
          book_.cancel(c.order_id, c.client_id, clock_, seq_, out);
        });

    publish_snapshot_if_due(out);
  }

  if (cfg_.match_duration > 0 && clock_ >= cfg_.match_duration) {
    expire_and_settle(out);
  }
  return events;
}

void MatchingEngine::publish_snapshot_if_due(EventBuffer& out) {
  if (cfg_.snapshot_interval <= 0 || clock_ < next_snapshot_) return;
  next_snapshot_ = clock_ + cfg_.snapshot_interval;
  // The gateway turns this into an EvtL2Snapshot frame. Emitting a full
  // snapshot on a cadence is what lets a subscriber that missed deltas
  // resynchronise without the engine tracking per-subscriber state.
  OrderBook::L2Entry buf[16];
  const std::size_t nb = book_.snapshot_l2(Side::Buy, 16, buf);
  for (std::size_t i = 0; i < nb; ++i) {
    LevelDelta d{};
    d.price = buf[i].price;
    d.qty = buf[i].qty;
    d.order_count = buf[i].order_count;
    d.side = Side::Buy;
    out.on_level_delta(d);
  }
  const std::size_t na = book_.snapshot_l2(Side::Sell, 16, buf);
  for (std::size_t i = 0; i < na; ++i) {
    LevelDelta d{};
    d.price = buf[i].price;
    d.qty = buf[i].qty;
    d.order_count = buf[i].order_count;
    d.side = Side::Sell;
    out.on_level_delta(d);
  }
}

void MatchingEngine::expire_and_settle(EventBuffer& out) {
  for (auto& a : accounts_) {
    book_.cancel_all_for(a.client_id, clock_, seq_, out);
  }
  state_ = EngineState::Finished;
}

// ---------------------------------------------------------------------------
// VWAP — the Phase 3 benchmark, computed here rather than in the backend
// because grading needs the tape at full fidelity and integer precision.
//
//   VWAP = sum(P_i * V_i) / sum(V_i)
// ---------------------------------------------------------------------------
Price MatchingEngine::rolling_vwap(Nanos window) const noexcept {
  const Nanos from = clock_ - window;
  Money pv = 0;
  Qty v = 0;
  for (std::size_t i = tape_.size(); i-- > 0;) {
    if (tape_[i].ts < from) break;
    pv += tape_[i].price * tape_[i].qty;
    v += tape_[i].qty;
  }
  return v == 0 ? kNoPrice : static_cast<Price>(pv / v);
}

Price MatchingEngine::forward_vwap(Nanos from, Nanos window) const noexcept {
  const Nanos to = from + window;
  Money pv = 0;
  Qty v = 0;
  for (const auto& e : tape_) {
    if (e.ts < from) continue;
    if (e.ts > to) break;
    pv += e.price * e.qty;
    v += e.qty;
  }
  return v == 0 ? kNoPrice : static_cast<Price>(pv / v);
}

std::uint64_t MatchingEngine::state_hash() const noexcept {
  std::uint64_t h = book_.state_hash();
  h ^= seq_ * 1099511628211ULL;
  for (const auto& a : accounts_) {
    h ^= static_cast<std::uint64_t>(a.position) * 0x9E3779B97F4A7C15ULL;
    h ^= static_cast<std::uint64_t>(a.realized_pnl);
  }
  h ^= scenario_.total_draws() * 0xD1B54A32D192ED03ULL;
  return h;
}

}  // namespace hfta
