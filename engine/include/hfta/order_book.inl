// hfta/order_book.inl — template method bodies for OrderBook.
//
// These live in a .inl rather than a .cpp because they are templated on the
// Sink type. That is the price of avoiding a virtual call on the fill path:
// the compiler has to see the body at the call site so it can inline the event
// emission directly into the matching loop.
//
// Included at the bottom of order_book.h. Never include it directly.
#pragma once

#include <algorithm>

namespace hfta {

// ---------------------------------------------------------------------------
// match_against_book — the hot loop.
//
// Walks the opposite side outward from the touch, consuming FIFO within each
// level, until the limit price is exceeded or the incoming size is exhausted.
// `limit == kNoPrice` means "market order, take whatever is there".
//
// Note that fills print at the RESTING order's price, not the aggressor's.
// That gap is price improvement and it is a real skill the game should teach.
// ---------------------------------------------------------------------------
template <class Sink>
Qty OrderBook::match_against_book(Order& incoming, Price limit, Nanos now,
                                  Seq& seq, Sink& sink) {
  const Side taker_side = incoming.side;
  const Side maker_side = opposite(taker_side);
  Qty total_filled = 0;

  while (incoming.qty_open > 0) {
    LevelIdx lvl;
    if (taker_side == Side::Buy) {
      if (!has_ask()) break;
      lvl = best_ask_;
      if (limit != kNoPrice && spec_.to_price(lvl) > limit) break;
    } else {
      if (!has_bid()) break;
      lvl = best_bid_;
      if (limit != kNoPrice && spec_.to_price(lvl) < limit) break;
    }

    PriceLevel& level = levels_[lvl];
    const Price px = spec_.to_price(lvl);

    while (level.head != kNullRef && incoming.qty_open > 0) {
      const OrderRef resting_ref = level.head;
      Order& resting = at(resting_ref);

      // Self-trade prevention: the older order steps aside rather than the
      // player crossing themselves and generating a fake print.
      if (resting.client_id == incoming.client_id &&
          stp_ == SelfTradePolicy::CancelResting) {
        OrderAck ack{};
        ack.seq = ++seq;
        ack.ts = now;
        ack.order_id = resting.id;
        ack.client_ord_id = resting.client_ord_id;
        ack.client_id = resting.client_id;
        ack.status = OrderStatus::Cancelled;
        ack.reject = RejectReason::SelfTradePrevented;
        unlink(resting_ref);
        index_erase(resting.id);
        free_order(resting_ref);
        --live_orders_;
        sink.on_ack(ack);
        continue;
      }

      const Qty qty = std::min(incoming.qty_open, resting.qty_open);

      resting.qty_open   -= qty;
      resting.qty_filled += qty;
      incoming.qty_open  -= qty;
      incoming.qty_filled += qty;
      level.aggregate_qty -= qty;
      total_filled += qty;

      const Seq fill_seq = ++seq;

      Fill maker{};
      maker.seq = fill_seq;
      maker.ts = now;
      maker.order_id = resting.id;
      maker.client_ord_id = resting.client_ord_id;
      maker.counterparty_order_id = incoming.id;
      maker.client_id = resting.client_id;
      maker.price = px;
      maker.qty = qty;
      maker.leaves_qty = resting.qty_open;
      maker.side = resting.side;
      maker.liquidity = LiquidityFlag::Maker;
      maker.grade = TradeGrade::Ungraded;
      sink.on_fill(maker);

      Fill taker{};
      taker.seq = fill_seq;
      taker.ts = now;
      taker.order_id = incoming.id;
      taker.client_ord_id = incoming.client_ord_id;
      taker.counterparty_order_id = resting.id;
      taker.client_id = incoming.client_id;
      taker.price = px;
      taker.qty = qty;
      taker.leaves_qty = incoming.qty_open;
      taker.side = incoming.side;
      taker.liquidity = LiquidityFlag::Taker;
      taker.grade = TradeGrade::Ungraded;
      sink.on_fill(taker);

      TradePrint print{};
      print.seq = fill_seq;
      print.ts = now;
      print.price = px;
      print.qty = qty;
      print.aggressor = taker_side;
      sink.on_trade_print(print);

      if (resting.qty_open == 0) {
        resting.status = OrderStatus::Filled;
        unlink(resting_ref);          // aggregate already decremented above
        index_erase(resting.id);
        free_order(resting_ref);
        --live_orders_;
      } else {
        resting.status = OrderStatus::PartiallyFilled;
      }
    }

    LevelDelta delta{};
    delta.price = px;
    delta.qty = level.aggregate_qty;
    delta.order_count = level.order_count;
    delta.side = maker_side;
    sink.on_level_delta(delta);

    if (level.empty()) {
      clear_occupied(maker_side, lvl);
      refresh_best(maker_side, lvl);
    } else {
      break;  // level survived, so the incoming order must be exhausted
    }
  }

  return total_filled;
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------
template <class Sink>
SubmitResult OrderBook::submit(const NewOrderCmd& cmd, Nanos now, Seq& seq,
                               Sink& sink) {
  SubmitResult res{};

  auto reject = [&](RejectReason reason) -> SubmitResult {
    OrderAck ack{};
    ack.seq = ++seq;
    ack.ts = now;
    ack.order_id = 0;
    ack.client_ord_id = cmd.client_ord_id;
    ack.client_id = cmd.client_id;
    ack.status = OrderStatus::Rejected;
    ack.reject = reason;
    sink.on_ack(ack);
    res.reject = reason;
    res.accepted = false;
    return res;
  };

  if (cmd.qty <= 0) return reject(RejectReason::QtyInvalid);
  if (cmd.qty > spec_.max_order_qty) return reject(RejectReason::QtyAboveLimit);

  Price limit = kNoPrice;
  if (cmd.type == OrderType::Limit) {
    if (!spec_.in_band(cmd.price)) return reject(RejectReason::PriceOutOfBand);
    limit = cmd.price;
    if (cmd.tif == TimeInForce::PostOnly && would_cross(cmd.side, cmd.price)) {
      return reject(RejectReason::PostOnlyWouldCross);
    }
  }

  // FOK must know the answer BEFORE mutating anything, otherwise a failed FOK
  // leaves the book half-consumed. This ordering is the whole test case.
  if (cmd.tif == TimeInForce::FOK &&
      available_liquidity(cmd.side, limit) < cmd.qty) {
    return reject(RejectReason::FokUnfillable);
  }

  Order incoming{};
  incoming.id = next_order_id_++;
  incoming.client_ord_id = cmd.client_ord_id;
  incoming.arrival_seq = seq;      // time priority: sequence, never a clock
  incoming.qty_open = cmd.qty;
  incoming.qty_filled = 0;
  incoming.price = cmd.price;
  incoming.prev = kNullRef;
  incoming.next = kNullRef;
  incoming.level = kNoLevel;
  incoming.client_id = cmd.client_id;
  incoming.side = cmd.side;
  incoming.type = cmd.type;
  incoming.tif = cmd.tif;
  incoming.status = OrderStatus::New;

  res.order_id = incoming.id;
  res.filled_qty = match_against_book(incoming, limit, now, seq, sink);
  res.gross_notional = 0;  // accumulated by the caller from the fill stream

  const bool wants_rest = (cmd.type == OrderType::Limit) &&
                          (cmd.tif == TimeInForce::GTC ||
                           cmd.tif == TimeInForce::PostOnly);

  if (incoming.qty_open > 0 && wants_rest) {
    const OrderRef ref = alloc_order();
    if (ref == kNullRef) return reject(RejectReason::BookCapacityReached);

    at(ref) = incoming;
    const LevelIdx lvl = spec_.to_level(cmd.price);
    link_back(lvl, ref);
    set_occupied(cmd.side, lvl);

    if (cmd.side == Side::Buy) {
      if (best_bid_ == kNoLevel || lvl > best_bid_) best_bid_ = lvl;
    } else {
      if (best_ask_ == kNoLevel || lvl < best_ask_) best_ask_ = lvl;
    }

    index_insert(incoming.id, ref);
    ++live_orders_;
    res.resting_qty = incoming.qty_open;

    LevelDelta delta{};
    delta.price = cmd.price;
    delta.qty = levels_[lvl].aggregate_qty;
    delta.order_count = levels_[lvl].order_count;
    delta.side = cmd.side;
    sink.on_level_delta(delta);
  }

  OrderAck ack{};
  ack.seq = ++seq;
  ack.ts = now;
  ack.order_id = incoming.id;
  ack.client_ord_id = cmd.client_ord_id;
  ack.client_id = cmd.client_id;
  if (incoming.qty_open == 0) {
    ack.status = OrderStatus::Filled;
  } else if (res.resting_qty > 0) {
    ack.status = res.filled_qty > 0 ? OrderStatus::PartiallyFilled
                                    : OrderStatus::New;
  } else {
    ack.status = OrderStatus::Cancelled;  // IOC / FOK residual, or market rump
  }
  ack.reject = RejectReason::None;
  sink.on_ack(ack);

  res.accepted = true;
  return res;
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------
template <class Sink>
bool OrderBook::cancel(OrderId id, ClientId requester, Nanos now, Seq& seq,
                       Sink& sink) {
  const OrderRef ref = index_find(id);

  OrderAck ack{};
  ack.seq = ++seq;
  ack.ts = now;
  ack.order_id = id;
  ack.client_id = requester;

  if (ref == kNullRef) {
    ack.status = OrderStatus::Rejected;
    ack.reject = RejectReason::UnknownOrder;
    sink.on_ack(ack);
    return false;
  }

  Order& o = at(ref);
  if (o.client_id != requester) {
    // Distinct from UnknownOrder on purpose: leaking "this order exists but is
    // not yours" is fine in a game and it makes the UI message honest.
    ack.status = OrderStatus::Rejected;
    ack.reject = RejectReason::NotOrderOwner;
    sink.on_ack(ack);
    return false;
  }

  const LevelIdx lvl = o.level;
  const Side side = o.side;
  ack.client_ord_id = o.client_ord_id;

  unlink(ref);
  index_erase(id);
  free_order(ref);
  --live_orders_;

  LevelDelta delta{};
  delta.price = spec_.to_price(lvl);
  delta.qty = levels_[lvl].aggregate_qty;
  delta.order_count = levels_[lvl].order_count;
  delta.side = side;
  sink.on_level_delta(delta);

  if (levels_[lvl].empty()) {
    clear_occupied(side, lvl);
    refresh_best(side, lvl);
  }

  ack.status = OrderStatus::Cancelled;
  ack.reject = RejectReason::None;
  sink.on_ack(ack);
  return true;
}

// ---------------------------------------------------------------------------
// replace — cancel + new. Price change or size increase loses queue position;
// a pure size decrease keeps it. Real venue semantics, worth teaching.
// ---------------------------------------------------------------------------
template <class Sink>
SubmitResult OrderBook::replace(const ReplaceCmd& cmd, Nanos now, Seq& seq,
                                Sink& sink) {
  SubmitResult res{};
  const OrderRef ref = index_find(cmd.order_id);
  if (ref == kNullRef) {
    OrderAck ack{};
    ack.seq = ++seq;
    ack.ts = now;
    ack.order_id = cmd.order_id;
    ack.client_ord_id = cmd.client_ord_id;
    ack.client_id = cmd.client_id;
    ack.status = OrderStatus::Rejected;
    ack.reject = RejectReason::UnknownOrder;
    sink.on_ack(ack);
    res.reject = RejectReason::UnknownOrder;
    return res;
  }

  Order& o = at(ref);
  const bool keeps_priority =
      (cmd.new_price == o.price) && (cmd.new_qty < o.qty_open);

  if (keeps_priority) {
    const Qty delta_qty = o.qty_open - cmd.new_qty;
    o.qty_open = cmd.new_qty;
    levels_[o.level].aggregate_qty -= delta_qty;

    LevelDelta delta{};
    delta.price = o.price;
    delta.qty = levels_[o.level].aggregate_qty;
    delta.order_count = levels_[o.level].order_count;
    delta.side = o.side;
    sink.on_level_delta(delta);

    res.accepted = true;
    res.order_id = o.id;
    res.resting_qty = o.qty_open;
    return res;
  }

  NewOrderCmd fresh{};
  fresh.client_ord_id = cmd.client_ord_id;
  fresh.client_id = cmd.client_id;
  fresh.price = cmd.new_price;
  fresh.qty = cmd.new_qty;
  fresh.type = OrderType::Limit;
  fresh.side = o.side;
  fresh.tif = TimeInForce::GTC;

  cancel(cmd.order_id, cmd.client_id, now, seq, sink);
  return submit(fresh, now, seq, sink);
}

// ---------------------------------------------------------------------------
// cancel_all_for — the flatten / disconnect path.
// ---------------------------------------------------------------------------
template <class Sink>
void OrderBook::cancel_all_for(ClientId client, Nanos now, Seq& seq,
                               Sink& sink) {
  // Collect first, then cancel: mutating the book while walking the arena is
  // exactly the kind of thing that works in testing and corrupts in production.
  std::vector<OrderId> doomed;
  doomed.reserve(live_orders_);
  for (const auto& slot : id_index_) {
    if (slot.ref != kNullRef && at(slot.ref).client_id == client) {
      doomed.push_back(slot.id);
    }
  }
  for (const OrderId id : doomed) cancel(id, client, now, seq, sink);
}

}  // namespace hfta
