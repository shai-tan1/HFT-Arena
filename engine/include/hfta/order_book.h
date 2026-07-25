// hfta/order_book.h — the Limit Order Book.
//
// ============================================================================
// DATA STRUCTURE RATIONALE
// ============================================================================
// The book has to answer four questions in the hot path. The structure is
// chosen so that each is O(1) or effectively O(1):
//
//   Q1. "What is the best bid / best ask?"        -> cached index + bitmap scan
//   Q2. "Give me the FIFO queue at price P."      -> direct array index
//   Q3. "Append this order at the back of P."     -> intrusive list tail insert
//   Q4. "Cancel order 12345 wherever it lives."   -> id->OrderRef hash, unlink
//
// LAYER 1 — Flat price-level array.
//   levels_[i] holds the queue at price (tick_floor + i). Mapping a price to a
//   level is one subtraction, not a tree descent. A single array serves BOTH
//   sides: in a book with no crossed state, a given price index can only ever
//   hold bids or asks, never both, because any cross is resolved on entry.
//   Cost: one PriceLevel (24B) per tick in the window. A 32k-tick window is
//   768 KB — fits comfortably, and every match container gets its own copy.
//
//   Rejected alternative: std::map<Price, Level>. Correct and unbounded, but
//   it costs a red-black descent (~5-8 dependent cache misses) on the single
//   hottest operation in the system. Kept behind a compile-time policy flag
//   for instruments where the price range genuinely cannot be bounded.
//
// LAYER 2 — Occupancy bitmaps.
//   bid_bitmap_ / ask_bitmap_ carry one bit per level. Finding the new best
//   price after a level empties is a backwards/forwards word scan with
//   countl_zero / countr_zero: 512 ticks inspected per 64-bit word, per cycle.
//   In practice best_bid_/best_ask_ are cached and the scan almost never runs
//   more than one word.
//
// LAYER 3 — Intrusive FIFO of orders inside a level.
//   Orders live in a preallocated arena and link to each other by OrderRef
//   (a uint32 index), not by pointer. Indices are half the size of pointers,
//   survive arena reallocation, and are position-independent — which matters
//   the day you move the arena into shared memory. Insert at tail and unlink
//   from the middle are both O(1), which is exactly price-time priority plus
//   O(1) cancel.
//
// LAYER 4 — OrderId -> OrderRef map.
//   Open-addressed, power-of-two capacity, robin-hood probing, no allocation
//   after construction. std::unordered_map is banned from the hot path: it
//   chases a pointer per bucket and its iteration order is a determinism trap.
//
// THREADING
//   The book is single-writer by construction. Exactly one engine thread
//   touches it. There are no locks and no atomics inside this class. Fan-out
//   to the IPC layer happens through an SPSC ring, downstream of the Sink.
// ============================================================================
#pragma once
// #include <bits/stdc++.h>
#include <bit>
#include <cstring>
#include <vector>

#include "hfta/types.h"

namespace hfta {

// ---------------------------------------------------------------------------
// Order — one cache line. Do not let this grow past 64 bytes without a fight.
// ---------------------------------------------------------------------------
struct alignas(64) Order {
  OrderId      id;             // 8
  ClientOrdId  client_ord_id;  // 8
  Seq          arrival_seq;    // 8  <- time priority key; never wall-clock
  Qty          qty_open;       // 8
  Qty          qty_filled;     // 8
  Price        price;          // 8
  OrderRef     prev;           // 4  intrusive links within the level FIFO
  OrderRef     next;           // 4
  LevelIdx     level;          // 4
  ClientId     client_id;      // 4
  Side         side;           // 1
  OrderType    type;           // 1
  TimeInForce  tif;            // 1
  OrderStatus  status;         // 1
  std::uint8_t _pad[4];        // 4  -> 72B; drop client_ord_id to a side table
                               //       if you need a strict 64B footprint.
};

// ---------------------------------------------------------------------------
// PriceLevel — the FIFO queue at one tick.
// ---------------------------------------------------------------------------
struct PriceLevel {
  OrderRef      head{kNullRef};   // oldest order — fills first
  OrderRef      tail{kNullRef};   // newest order — insertion point
  Qty           aggregate_qty{0}; // maintained incrementally, never recomputed
  std::uint32_t order_count{0};

  [[nodiscard]] bool empty() const noexcept { return head == kNullRef; }
};

// ---------------------------------------------------------------------------
// Sink concept (structural, not std::concept, to keep this header cheap).
// The book emits through a caller-supplied Sink so there is no virtual call
// on the fill path. MatchingEngine passes an EventBuffer; unit tests pass a
// recording sink; the replay tool passes a checksummer.
//
//   struct Sink {
//     void on_fill(const Fill&);
//     void on_ack(const OrderAck&);
//     void on_trade_print(const TradePrint&);
//     void on_level_delta(const LevelDelta&);
//   };
// ---------------------------------------------------------------------------

// Result of a submit(), for the caller's own bookkeeping.
struct SubmitResult {
  OrderId      order_id{0};
  Qty          filled_qty{0};
  Qty          resting_qty{0};
  Money        gross_notional{0};   // sum(price * qty * tick_value)
  RejectReason reject{RejectReason::None};
  bool         accepted{false};
};

enum class SelfTradePolicy : std::uint8_t {
  Allow            = 0,
  CancelResting    = 1,  // default: the older order steps aside
  CancelAggressing = 2,
};

class OrderBook {
 public:
  OrderBook(const InstrumentSpec& spec, std::size_t order_capacity);

  // -- mutation -------------------------------------------------------------
  // All four take the Sink by reference and emit events inline as they run.
  // `now` is LOGICAL time supplied by the scheduler; the book never calls the
  // clock itself. Pre-trade risk has already passed at this point — the book
  // is a matching machine, not a risk machine.
  template <class Sink>
  SubmitResult submit(const NewOrderCmd& cmd, Nanos now, Seq& seq, Sink& sink);

  template <class Sink>
  bool cancel(OrderId id, ClientId requester, Nanos now, Seq& seq, Sink& sink);

  // Replace = cancel + new. Any price change or size increase loses queue
  // position; a pure size DECREASE keeps it (matches real venue semantics and
  // is worth teaching players explicitly).
  template <class Sink>
  SubmitResult replace(const ReplaceCmd& cmd, Nanos now, Seq& seq, Sink& sink);

  template <class Sink>
  void cancel_all_for(ClientId client, Nanos now, Seq& seq, Sink& sink);

  // -- top of book ----------------------------------------------------------
  [[nodiscard]] bool  has_bid() const noexcept { return best_bid_ != kNoLevel; }
  [[nodiscard]] bool  has_ask() const noexcept { return best_ask_ != kNoLevel; }
  [[nodiscard]] Price best_bid() const noexcept {
    return has_bid() ? spec_.to_price(best_bid_) : kNoPrice;
  }
  [[nodiscard]] Price best_ask() const noexcept {
    return has_ask() ? spec_.to_price(best_ask_) : kNoPrice;
  }
  [[nodiscard]] Qty bid_size() const noexcept {
    return has_bid() ? levels_[best_bid_].aggregate_qty : 0;
  }
  [[nodiscard]] Qty ask_size() const noexcept {
    return has_ask() ? levels_[best_ask_].aggregate_qty : 0;
  }
  [[nodiscard]] Price spread() const noexcept {
    return (has_bid() && has_ask()) ? best_ask() - best_bid() : kNoPrice;
  }
  // Mid in HALF-TICKS to stay integral; callers divide for display only.
  [[nodiscard]] Price mid_half_ticks() const noexcept {
    return (has_bid() && has_ask()) ? best_bid() + best_ask() : kNoPrice;
  }
  // Size-weighted micro-price in half-ticks — a far better short-horizon
  // fair-value anchor than mid, and the one Phase 3 should benchmark against.
  [[nodiscard]] Price micro_price_scaled() const noexcept;

  // -- introspection --------------------------------------------------------
  struct L2Entry { Price price; Qty qty; std::uint32_t order_count; };
  // Walks `depth` occupied levels outward from top of book. O(depth) plus the
  // bitmap scan, never O(window). Used for the 20-50 Hz snapshot publish and
  // for gap recovery on the subscriber side.
  std::size_t snapshot_l2(Side side, std::size_t depth, L2Entry* out) const;

  [[nodiscard]] Qty  qty_at(Price p) const noexcept;
  [[nodiscard]] const Order* find(OrderId id) const noexcept;
  [[nodiscard]] std::size_t live_order_count() const noexcept { return live_orders_; }
  [[nodiscard]] const InstrumentSpec& spec() const noexcept { return spec_; }

  void set_self_trade_policy(SelfTradePolicy p) noexcept { stp_ = p; }

  // Order-independent checksum of the full book state. Two mirrored containers
  // must report the same value at the same sequence number — this is the
  // single most valuable assertion in the whole system, and CI should run a
  // 10M-event scenario through two processes and diff these every commit.
  [[nodiscard]] std::uint64_t state_hash() const noexcept;

  // Full reset without deallocating — lets a warm container be recycled for
  // the next match in microseconds instead of paying Docker cold start.
  void reset();

 private:
  // -- matching -------------------------------------------------------------
  // Consumes liquidity from `taker_side`'s opposite book down to `limit`
  // (kNoPrice == unbounded, i.e. a market order). Returns qty filled.
  template <class Sink>
  Qty match_against_book(Order& incoming, Price limit, Nanos now, Seq& seq, Sink& sink);

  [[nodiscard]] bool would_cross(Side s, Price p) const noexcept {
    return s == Side::Buy ? (has_ask() && p >= best_ask())
                          : (has_bid() && p <= best_bid());
  }
  // FOK needs to know if the whole size is available before touching anything.
  [[nodiscard]] Qty available_liquidity(Side taker_side, Price limit) const noexcept;

  // -- level / list plumbing ------------------------------------------------
  void link_back(LevelIdx lvl, OrderRef ref) noexcept;   // FIFO tail insert
  void unlink(OrderRef ref) noexcept;                    // O(1) middle removal
  void set_occupied(Side s, LevelIdx lvl) noexcept;
  void clear_occupied(Side s, LevelIdx lvl) noexcept;
  void refresh_best(Side s, LevelIdx from_hint) noexcept;

  // -- arena ----------------------------------------------------------------
  OrderRef alloc_order() noexcept;   // pops the free list; kNullRef when full
  void     free_order(OrderRef) noexcept;
  Order&       at(OrderRef r) noexcept       { return arena_[r]; }
  const Order& at(OrderRef r) const noexcept { return arena_[r]; }

  // -- id index -------------------------------------------------------------
  void     index_insert(OrderId id, OrderRef ref) noexcept;
  void     index_erase(OrderId id) noexcept;
  [[nodiscard]] OrderRef index_find(OrderId id) const noexcept;

  // -- bitmap helpers -------------------------------------------------------
  static constexpr std::size_t kWordBits = 64;
  static std::size_t word_of(LevelIdx i) noexcept { return i / kWordBits; }
  static std::uint64_t bit_of(LevelIdx i) noexcept {
    return 1ULL << (i % kWordBits);
  }
  // Highest set bit at or below `from` — the new best bid after a level empties.
  [[nodiscard]] LevelIdx scan_down(const std::vector<std::uint64_t>& bm,
                                   LevelIdx from) const noexcept;
  // Lowest set bit at or above `from` — the new best ask.
  [[nodiscard]] LevelIdx scan_up(const std::vector<std::uint64_t>& bm,
                                 LevelIdx from) const noexcept;

  // -- state ----------------------------------------------------------------
  InstrumentSpec spec_;

  std::vector<PriceLevel>   levels_;      // one entry per tick in the window
  std::vector<std::uint64_t> bid_bitmap_; // occupancy, bid side
  std::vector<std::uint64_t> ask_bitmap_; // occupancy, ask side

  std::vector<Order> arena_;              // preallocated; never grows mid-match
  OrderRef           free_head_{kNullRef};
  std::size_t        live_orders_{0};

  struct IndexSlot { OrderId id{0}; OrderRef ref{kNullRef}; };
  std::vector<IndexSlot> id_index_;       // open addressed, power-of-two size
  std::size_t            id_index_mask_{0};

  LevelIdx best_bid_{kNoLevel};
  LevelIdx best_ask_{kNoLevel};

  OrderId         next_order_id_{1};
  SelfTradePolicy stp_{SelfTradePolicy::CancelResting};
};

// ---------------------------------------------------------------------------
// Inline bitmap scans — small enough to belong in the header, hot enough to
// need to be. std::countl_zero / countr_zero lower to LZCNT / TZCNT.
// ---------------------------------------------------------------------------
inline LevelIdx OrderBook::scan_down(const std::vector<std::uint64_t>& bm,
                                     LevelIdx from) const noexcept {
  if (from == kNoLevel || from >= spec_.num_levels) return kNoLevel;
  std::size_t w = word_of(from);
  const unsigned b = static_cast<unsigned>(from % kWordBits);
  std::uint64_t cur = bm[w] & (b == 63 ? ~0ULL : ((1ULL << (b + 1)) - 1));
  for (;;) {
    if (cur != 0) {
      const unsigned hi = 63u - static_cast<unsigned>(__builtin_clzll(cur));
      return static_cast<LevelIdx>(w * kWordBits + hi);
    }
    if (w == 0) return kNoLevel;
    cur = bm[--w];
  }
}

inline LevelIdx OrderBook::scan_up(const std::vector<std::uint64_t>& bm,
                                   LevelIdx from) const noexcept {
  if (from == kNoLevel || from >= spec_.num_levels) return kNoLevel;
  std::size_t w = word_of(from);
  const unsigned b = static_cast<unsigned>(from % kWordBits);
  std::uint64_t cur = bm[w] & (~0ULL << b);
  const std::size_t words = bm.size();
  for (;;) {
    if (cur != 0) {
      const unsigned lo = static_cast<unsigned>(__builtin_ctzll(cur));
      const auto idx = static_cast<LevelIdx>(w * kWordBits + lo);
      return idx < spec_.num_levels ? idx : kNoLevel;
    }
    if (++w >= words) return kNoLevel;
    cur = bm[w];
  }
}

inline void OrderBook::link_back(LevelIdx lvl, OrderRef ref) noexcept {
  PriceLevel& L = levels_[lvl];
  Order& o = at(ref);
  o.prev = L.tail;
  o.next = kNullRef;
  o.level = lvl;
  if (L.tail != kNullRef) at(L.tail).next = ref; else L.head = ref;
  L.tail = ref;
  L.aggregate_qty += o.qty_open;
  ++L.order_count;
}

inline void OrderBook::unlink(OrderRef ref) noexcept {
  Order& o = at(ref);
  PriceLevel& L = levels_[o.level];
  if (o.prev != kNullRef) at(o.prev).next = o.next; else L.head = o.next;
  if (o.next != kNullRef) at(o.next).prev = o.prev; else L.tail = o.prev;
  L.aggregate_qty -= o.qty_open;
  --L.order_count;
  o.prev = o.next = kNullRef;
}

}  // namespace hfta

// Template method bodies live here so the compiler can inline event emission
// into the matching loop. Must be last.
#include "hfta/order_book.inl"
