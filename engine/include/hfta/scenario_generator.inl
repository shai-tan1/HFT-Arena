// hfta/scenario_generator.inl — agent behaviour.
//
// ===========================================================================
// THE LOCKSTEP RULE — read this before editing anything below
// ===========================================================================
// Every agent draws a FIXED number of variates per wakeup, UNCONDITIONALLY,
// BEFORE it looks at the book. Only the mapping from those variates to an
// action may read book state.
//
// Break this rule — put a next() inside an `if (book.has_bid())`, say — and
// the two mirrored containers consume different numbers of random values,
// their streams diverge, and from that moment the two players are playing
// different games. It will not crash. It will not warn you. It will just
// quietly make the match unfair, and the state_hash test is the only thing
// that will catch it.
//
// Contract for the callbacks:
//   OrderId emit_new(const NewOrderCmd&)   — returns the engine-assigned id
//   void    emit_cancel(const CancelCmd&)
// ===========================================================================
#pragma once

#include <algorithm>

#include "hfta/order_book.h"

namespace hfta {

template <class EmitNew, class EmitCancel>
void ScenarioGenerator::advance(Nanos until, const OrderBook& book,
                                EmitNew&& emit_new, EmitCancel&& emit_cancel) {
  while (!heap_.empty() && heap_.front().t <= until) {
    std::pop_heap(heap_.begin(), heap_.end(), std::greater<AgentWakeup>{});
    const AgentWakeup w = heap_.back();
    heap_.pop_back();

    AgentState& a = agents_[w.agent_id];
    const std::uint32_t intensity = current_intensity(w.t);
    const Regime regime = current_regime(w.t);

    // ---- unconditional draws, always the same count per kind --------------
    const std::uint32_t d0 = a.rng.below(10000);              // side / coin
    const std::uint32_t d1 = a.rng.below(10000);              // size roll
    const std::uint32_t d2 = a.rng.below(10000);              // aggression roll
    const std::int32_t  d3 = a.rng.gaussian_ticks(1 + intensity / 10);  // drift
    const Nanos next_gap = a.rng.exponential_nanos(a.cfg.mean_interarrival);

    // ---- reference price ---------------------------------------------------
    // Micro-price when the book is two-sided, otherwise the last known
    // reference. Reading the book here is fine: no draws happen below.
    Price ref = a.last_ref;
    if (book.has_bid() && book.has_ask()) {
      ref = (book.micro_price_scaled() + 1) / 2;   // round, do not truncate
    } else if (book.has_bid()) {
      ref = book.best_bid();
    } else if (book.has_ask()) {
      ref = book.best_ask();
    }
    a.last_ref = ref;

    const Qty span = std::max<Qty>(1, a.cfg.size_max - a.cfg.size_min + 1);
    const Qty size = a.cfg.size_min + static_cast<Qty>(d1 % static_cast<std::uint32_t>(span));

    switch (a.cfg.kind) {
      // ---------------------------------------------------------------------
      case AgentKind::MarketMaker: {
        // Pull the old quotes, then requote around the reference, skewed
        // against inventory so the maker naturally leans away from risk.
        if (a.bid_quote != 0) {
          CancelCmd c{};
          c.order_id = a.bid_quote;
          c.client_id = a.client_id;
          emit_cancel(c);
          a.bid_quote = 0;
        }
        if (a.ask_quote != 0) {
          CancelCmd c{};
          c.order_id = a.ask_quote;
          c.client_id = a.client_id;
          emit_cancel(c);
          a.ask_quote = 0;
        }

        const std::int32_t widen =
            static_cast<std::int32_t>(a.cfg.spread_ticks) +
            static_cast<std::int32_t>(intensity / 20) +
            (regime == Regime::Volatile || regime == Regime::FlashCrash ? 3 : 0);

        // Inventory skew: long inventory pushes both quotes down so the maker
        // is more likely to get hit on the offer and reduce risk.
        std::int32_t skew = 0;
        if (a.cfg.inventory_limit > 0) {
          skew = static_cast<std::int32_t>(
              -(a.inventory * static_cast<Qty>(widen)) /
              std::max<Qty>(1, a.cfg.inventory_limit));
        }

        const Price bid_px = ref - widen + skew;
        const Price ask_px = ref + widen + skew;

        if (instrument_.in_band(bid_px)) {
          NewOrderCmd n{};
          n.client_ord_id = a.client_id * 1000000ULL + w.t;
          n.client_id = a.client_id;
          n.price = bid_px;
          n.qty = size;
          n.type = OrderType::Limit;
          n.side = Side::Buy;
          n.tif = TimeInForce::GTC;
          a.bid_quote = emit_new(n);
        }
        if (instrument_.in_band(ask_px)) {
          NewOrderCmd n{};
          n.client_ord_id = a.client_id * 1000000ULL + w.t + 1;
          n.client_id = a.client_id;
          n.price = ask_px;
          n.qty = size;
          n.type = OrderType::Limit;
          n.side = Side::Sell;
          n.tif = TimeInForce::GTC;
          a.ask_quote = emit_new(n);
        }
        break;
      }

      // ---------------------------------------------------------------------
      case AgentKind::NoiseTrader: {
        // The liquidity tax payer. No view, Poisson arrivals, crosses the
        // spread often enough to keep the tape alive.
        const Side side = (d0 < 5000) ? Side::Buy : Side::Sell;
        const bool aggressive = d2 < (3000 + intensity * 30);

        NewOrderCmd n{};
        n.client_ord_id = a.client_id * 1000000ULL + w.t;
        n.client_id = a.client_id;
        n.qty = size;
        n.side = side;
        if (aggressive) {
          n.type = OrderType::Market;
          n.tif = TimeInForce::IOC;
          n.price = 0;
        } else {
          n.type = OrderType::Limit;
          n.tif = TimeInForce::GTC;
          n.price = (side == Side::Buy) ? ref - 1 - (d1 % 3) : ref + 1 + (d1 % 3);
          if (!instrument_.in_band(n.price)) break;
        }
        emit_new(n);
        break;
      }

      // ---------------------------------------------------------------------
      case AgentKind::Momentum: {
        // Buys strength, sells weakness. This is what turns a random walk into
        // something that trends long enough to be tradeable.
        const Price drift = ref - a.last_ref + d3;
        const Side side = (drift >= 0) ? Side::Buy : Side::Sell;
        if (d2 > 4000) break;  // fires on a minority of wakeups

        NewOrderCmd n{};
        n.client_ord_id = a.client_id * 1000000ULL + w.t;
        n.client_id = a.client_id;
        n.qty = size;
        n.side = side;
        n.type = OrderType::Market;
        n.tif = TimeInForce::IOC;
        n.price = 0;
        emit_new(n);
        break;
      }

      // ---------------------------------------------------------------------
      case AgentKind::Sweeper: {
        // Periodic aggressive sweeps — the source of adverse selection, and
        // the thing that punishes a player for resting size and walking away.
        if (d2 > 1200) break;
        NewOrderCmd n{};
        n.client_ord_id = a.client_id * 1000000ULL + w.t;
        n.client_id = a.client_id;
        n.qty = size * 4;
        n.side = (d0 < 5000) ? Side::Buy : Side::Sell;
        n.type = OrderType::Market;
        n.tif = TimeInForce::IOC;
        n.price = 0;
        emit_new(n);
        break;
      }

      default:
        break;
    }

    AgentWakeup nxt;
    nxt.t = w.t + next_gap;
    nxt.agent_id = w.agent_id;
    nxt.nonce = w.nonce + 1;
    heap_.push_back(nxt);
    std::push_heap(heap_.begin(), heap_.end(), std::greater<AgentWakeup>{});
  }
}

}  // namespace hfta
