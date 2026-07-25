#include "hfta/order_book.h"

#include <cassert>

namespace hfta {

namespace {
constexpr std::uint64_t kFnvOffset = 1469598103934665603ULL;
constexpr std::uint64_t kFnvPrime  = 1099511628211ULL;

inline void fnv(std::uint64_t& h, std::uint64_t v) noexcept {
  h ^= v;
  h *= kFnvPrime;
}

// Next power of two >= n, minimum 16.
std::size_t pow2_at_least(std::size_t n) noexcept {
  std::size_t p = 16;
  while (p < n) p <<= 1;
  return p;
}
}  // namespace

OrderBook::OrderBook(const InstrumentSpec& spec, std::size_t order_capacity)
    : spec_(spec) {
  levels_.assign(spec_.num_levels, PriceLevel{});

  const std::size_t words = (spec_.num_levels + kWordBits - 1) / kWordBits;
  bid_bitmap_.assign(words, 0ULL);
  ask_bitmap_.assign(words, 0ULL);

  // Arena is sized once and never grows. Running out is a hard reject, not a
  // realloc: a reallocation mid-match would invalidate nothing (we use indices)
  // but it would introduce an unbounded allocation into the hot path.
  arena_.assign(order_capacity, Order{});
  for (std::size_t i = 0; i + 1 < order_capacity; ++i) {
    arena_[i].next = static_cast<OrderRef>(i + 1);
  }
  if (order_capacity > 0) {
    arena_[order_capacity - 1].next = kNullRef;
    free_head_ = 0;
  }

  // Load factor 0.5 keeps linear probing short.
  const std::size_t slots = pow2_at_least(order_capacity * 2);
  id_index_.assign(slots, IndexSlot{});
  id_index_mask_ = slots - 1;
}

void OrderBook::reset() {
  // Full logical reset without giving the memory back — this is what lets a
  // finished container be recycled into the warm pool in microseconds instead
  // of paying Docker cold start again.
  std::fill(levels_.begin(), levels_.end(), PriceLevel{});
  std::fill(bid_bitmap_.begin(), bid_bitmap_.end(), 0ULL);
  std::fill(ask_bitmap_.begin(), ask_bitmap_.end(), 0ULL);
  std::fill(id_index_.begin(), id_index_.end(), IndexSlot{});

  const std::size_t cap = arena_.size();
  for (std::size_t i = 0; i + 1 < cap; ++i) {
    arena_[i].next = static_cast<OrderRef>(i + 1);
  }
  if (cap > 0) {
    arena_[cap - 1].next = kNullRef;
    free_head_ = 0;
  }

  live_orders_ = 0;
  best_bid_ = kNoLevel;
  best_ask_ = kNoLevel;
  next_order_id_ = 1;
}

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------
OrderRef OrderBook::alloc_order() noexcept {
  if (free_head_ == kNullRef) return kNullRef;
  const OrderRef ref = free_head_;
  free_head_ = arena_[ref].next;
  return ref;
}

void OrderBook::free_order(OrderRef ref) noexcept {
  arena_[ref].next = free_head_;
  free_head_ = ref;
}

// ---------------------------------------------------------------------------
// Open-addressed OrderId -> OrderRef index.
// id 0 is the empty sentinel; the engine never issues it (ids start at 1).
// ---------------------------------------------------------------------------
void OrderBook::index_insert(OrderId id, OrderRef ref) noexcept {
  std::size_t i = static_cast<std::size_t>(id) & id_index_mask_;
  while (id_index_[i].id != 0) i = (i + 1) & id_index_mask_;
  id_index_[i].id = id;
  id_index_[i].ref = ref;
}

OrderRef OrderBook::index_find(OrderId id) const noexcept {
  std::size_t i = static_cast<std::size_t>(id) & id_index_mask_;
  for (std::size_t probes = 0; probes <= id_index_mask_; ++probes) {
    if (id_index_[i].id == id) return id_index_[i].ref;
    if (id_index_[i].id == 0 && id_index_[i].ref == kNullRef) return kNullRef;
    i = (i + 1) & id_index_mask_;
  }
  return kNullRef;
}

void OrderBook::index_erase(OrderId id) noexcept {
  std::size_t i = static_cast<std::size_t>(id) & id_index_mask_;
  for (std::size_t probes = 0; probes <= id_index_mask_; ++probes) {
    if (id_index_[i].id == id) {
      // Tombstone: id cleared but ref left as a "kept probing" marker so we do
      // not sever a probe chain that runs through this slot.
      id_index_[i].id = 0;
      id_index_[i].ref = 0;
      return;
    }
    if (id_index_[i].id == 0 && id_index_[i].ref == kNullRef) return;
    i = (i + 1) & id_index_mask_;
  }
}

const Order* OrderBook::find(OrderId id) const noexcept {
  const OrderRef ref = index_find(id);
  return ref == kNullRef ? nullptr : &arena_[ref];
}

// ---------------------------------------------------------------------------
// Bitmaps and best-price maintenance
// ---------------------------------------------------------------------------
void OrderBook::set_occupied(Side s, LevelIdx lvl) noexcept {
  auto& bm = (s == Side::Buy) ? bid_bitmap_ : ask_bitmap_;
  bm[word_of(lvl)] |= bit_of(lvl);
}

void OrderBook::clear_occupied(Side s, LevelIdx lvl) noexcept {
  auto& bm = (s == Side::Buy) ? bid_bitmap_ : ask_bitmap_;
  bm[word_of(lvl)] &= ~bit_of(lvl);
}

void OrderBook::refresh_best(Side s, LevelIdx from_hint) noexcept {
  // scan_down/scan_up are inclusive of from_hint, and the caller has already
  // cleared that bit, so starting the scan there is correct for both sides.
  if (s == Side::Buy) {
    best_bid_ = scan_down(bid_bitmap_, from_hint);
  } else {
    best_ask_ = scan_up(ask_bitmap_, from_hint);
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
Qty OrderBook::qty_at(Price p) const noexcept {
  if (!spec_.in_band(p)) return 0;
  return levels_[spec_.to_level(p)].aggregate_qty;
}

Price OrderBook::micro_price_scaled() const noexcept {
  if (!has_bid() || !has_ask()) return kNoPrice;
  const Qty bs = bid_size();
  const Qty as = ask_size();
  const Qty total = bs + as;
  if (total == 0) return mid_half_ticks();
  // Size-weighted fair value, returned in HALF-ticks to stay integral.
  // Weighted toward the thinner side, which is where price is going to move.
  //
  // Round to nearest, NOT toward zero. Truncating here looks harmless and is
  // not: market makers re-anchor on this value ~150 times a second, and a
  // consistent half-tick downward bias compounds into a phantom downtrend that
  // has nothing to do with order flow. Integer division bias is a real source
  // of fake alpha in simulators.
  const Price num = 2 * (best_bid() * as + best_ask() * bs);
  return (num + total / 2) / total;
}

std::size_t OrderBook::snapshot_l2(Side side, std::size_t depth,
                                   L2Entry* out) const {
  std::size_t n = 0;
  if (side == Side::Buy) {
    LevelIdx lvl = best_bid_;
    while (n < depth && lvl != kNoLevel) {
      const PriceLevel& L = levels_[lvl];
      out[n++] = L2Entry{spec_.to_price(lvl), L.aggregate_qty, L.order_count};
      if (lvl == 0) break;
      lvl = scan_down(bid_bitmap_, lvl - 1);
    }
  } else {
    LevelIdx lvl = best_ask_;
    while (n < depth && lvl != kNoLevel) {
      const PriceLevel& L = levels_[lvl];
      out[n++] = L2Entry{spec_.to_price(lvl), L.aggregate_qty, L.order_count};
      if (lvl + 1 >= spec_.num_levels) break;
      lvl = scan_up(ask_bitmap_, lvl + 1);
    }
  }
  return n;
}

Qty OrderBook::available_liquidity(Side taker_side, Price limit) const noexcept {
  Qty total = 0;
  if (taker_side == Side::Buy) {
    LevelIdx lvl = best_ask_;
    while (lvl != kNoLevel) {
      const Price px = spec_.to_price(lvl);
      if (limit != kNoPrice && px > limit) break;
      total += levels_[lvl].aggregate_qty;
      if (lvl + 1 >= spec_.num_levels) break;
      lvl = scan_up(ask_bitmap_, lvl + 1);
    }
  } else {
    LevelIdx lvl = best_bid_;
    while (lvl != kNoLevel) {
      const Price px = spec_.to_price(lvl);
      if (limit != kNoPrice && px < limit) break;
      total += levels_[lvl].aggregate_qty;
      if (lvl == 0) break;
      lvl = scan_down(bid_bitmap_, lvl - 1);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// state_hash — the determinism assertion.
//
// Two mirrored containers running the same seed must report the same value at
// the same sequence number. Wire this into CI over a 10M-event scenario and
// diff it on every commit; it is the single most valuable test in the system.
// ---------------------------------------------------------------------------
std::uint64_t OrderBook::state_hash() const noexcept {
  std::uint64_t h = kFnvOffset;
  fnv(h, static_cast<std::uint64_t>(live_orders_));
  fnv(h, static_cast<std::uint64_t>(best_bid_));
  fnv(h, static_cast<std::uint64_t>(best_ask_));
  for (LevelIdx i = 0; i < spec_.num_levels; ++i) {
    const PriceLevel& L = levels_[i];
    if (L.aggregate_qty == 0 && L.order_count == 0) continue;
    fnv(h, static_cast<std::uint64_t>(i));
    fnv(h, static_cast<std::uint64_t>(L.aggregate_qty));
    fnv(h, static_cast<std::uint64_t>(L.order_count));
    // Walk the FIFO so queue ORDER is part of the hash, not just the totals.
    for (OrderRef r = L.head; r != kNullRef; r = arena_[r].next) {
      fnv(h, arena_[r].id);
      fnv(h, static_cast<std::uint64_t>(arena_[r].qty_open));
      fnv(h, arena_[r].client_id);
    }
  }
  return h;
}

}  // namespace hfta
