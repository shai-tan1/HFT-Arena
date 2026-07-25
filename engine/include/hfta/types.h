// hfta/types.h — foundational value types for the HFT Arena market engine.
//
// DESIGN RULES (non-negotiable, they protect determinism):
//   1. No floating point anywhere in the matching path. Prices are integer
//      ticks, quantities are integer lots, cash is integer micro-units.
//      Two mirrored engine containers must produce bit-identical state.
//   2. No wall-clock reads inside decision logic. Time is a logical nanosecond
//      counter advanced by the event scheduler.
//   3. Every struct that crosses a thread or a socket is trivially copyable and
//      has an explicit layout assertion.
#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>

namespace hfta {

// ---------------------------------------------------------------------------
// Scalar aliases
// ---------------------------------------------------------------------------
using Price      = std::int64_t;   // instrument price expressed in ticks
using Qty        = std::int64_t;   // quantity expressed in lots
using Money      = std::int64_t;   // cash in micro-units (1e-6 of quote ccy)
using OrderId    = std::uint64_t;  // engine-assigned, monotonic, unique per run
using ClientOrdId= std::uint64_t;  // caller-assigned, echoed back on every event
using ClientId   = std::uint32_t;  // player or synthetic agent
using Seq        = std::uint64_t;  // global event sequence number
using LevelIdx   = std::uint32_t;  // index into the flat price-level array
using OrderRef   = std::uint32_t;  // index into the order arena (NOT a pointer)
using Nanos      = std::int64_t;   // logical time, nanoseconds since match start

inline constexpr OrderRef kNullRef  = std::numeric_limits<OrderRef>::max();
inline constexpr LevelIdx kNoLevel  = std::numeric_limits<LevelIdx>::max();
inline constexpr Price    kNoPrice  = std::numeric_limits<Price>::min();

// ---------------------------------------------------------------------------
// Enumerations — all fixed-width, all wire-stable. Never renumber.
// ---------------------------------------------------------------------------
enum class Side : std::uint8_t { Buy = 0, Sell = 1 };

constexpr Side opposite(Side s) noexcept {
  return s == Side::Buy ? Side::Sell : Side::Buy;
}
constexpr int sign_of(Side s) noexcept { return s == Side::Buy ? 1 : -1; }

enum class OrderType : std::uint8_t {
  Limit  = 0,
  Market = 1,
};

enum class TimeInForce : std::uint8_t {
  GTC       = 0,  // rest until cancelled or match end
  IOC       = 1,  // fill what you can, cancel the rest
  FOK       = 2,  // all or nothing, never rests
  PostOnly  = 3,  // reject if it would cross (maker-only)
};

enum class OrderStatus : std::uint8_t {
  New             = 0,
  PartiallyFilled = 1,
  Filled          = 2,
  Cancelled       = 3,
  Rejected        = 4,
  Expired         = 5,
};

enum class LiquidityFlag : std::uint8_t { Maker = 0, Taker = 1 };

enum class RejectReason : std::uint8_t {
  None                = 0,
  UnknownInstrument   = 1,
  PriceOutOfBand      = 2,   // outside the flat book's tick window
  PriceNotOnTick      = 3,
  QtyInvalid          = 4,
  QtyAboveLimit       = 5,
  InsufficientMargin  = 6,   // covers long buying power AND short margin
  ShortNotPermitted   = 7,
  PostOnlyWouldCross  = 8,
  FokUnfillable       = 9,
  UnknownOrder        = 10,  // cancel/replace on a dead or foreign order
  NotOrderOwner       = 11,
  RateLimited         = 12,  // per-client message budget exceeded
  EngineNotRunning    = 13,
  SelfTradePrevented  = 14,
  BookCapacityReached = 15,
};

// Where the trade grade will eventually be attached (Phase 3 hooks into this).
enum class TradeGrade : std::uint8_t {
  Ungraded   = 0,
  Brilliant  = 1,
  Great      = 2,
  Good       = 3,
  Inaccuracy = 4,
  Mistake    = 5,
  Blunder    = 6,
};

// ---------------------------------------------------------------------------
// Instrument definition
// ---------------------------------------------------------------------------
// The book is a FLAT ARRAY of price levels. `tick_floor` is the absolute tick
// value mapped to level index 0; `num_levels` bounds the window. A synthetic
// instrument with a known reference price makes this trivially safe: allocate
// +/-60% around the open, and treat a breach as a scenario-terminating event
// rather than something to handle in the hot path.
struct InstrumentSpec {
  std::uint32_t instrument_id;
  Price         tick_floor;        // price of level 0, in ticks
  std::uint32_t num_levels;        // window width in ticks (power of two preferred)
  Money         tick_value_micros; // cash value of one tick per one lot
  Qty           lot_size;          // minimum and increment quantity
  Qty           max_order_qty;     // fat-finger guard
  std::uint32_t margin_bps_long;   // initial margin, basis points of notional
  std::uint32_t margin_bps_short;  // shorts are typically dearer
  bool          allow_short;

  [[nodiscard]] constexpr Price price_ceiling() const noexcept {
    return tick_floor + static_cast<Price>(num_levels) - 1;
  }
  [[nodiscard]] constexpr bool in_band(Price p) const noexcept {
    return p >= tick_floor && p <= price_ceiling();
  }
  [[nodiscard]] constexpr LevelIdx to_level(Price p) const noexcept {
    return static_cast<LevelIdx>(p - tick_floor);
  }
  [[nodiscard]] constexpr Price to_price(LevelIdx i) const noexcept {
    return tick_floor + static_cast<Price>(i);
  }
};

// ---------------------------------------------------------------------------
// Commands (inbound) — POD, memcpy-able off the wire
// ---------------------------------------------------------------------------
struct NewOrderCmd {
  ClientOrdId  client_ord_id;
  ClientId     client_id;
  Price        price;      // ignored for Market orders
  Qty          qty;
  OrderType    type;
  Side         side;
  TimeInForce  tif;
  std::uint8_t _pad{0};
};

struct CancelCmd {
  OrderId      order_id;
  ClientOrdId  client_ord_id;  // echoed on the ack
  ClientId     client_id;
};

struct ReplaceCmd {
  OrderId      order_id;
  ClientOrdId  client_ord_id;
  ClientId     client_id;
  Price        new_price;
  Qty          new_qty;
};

// ---------------------------------------------------------------------------
// Events (outbound)
// ---------------------------------------------------------------------------
struct Fill {
  Seq           seq;
  Nanos         ts;
  OrderId       order_id;
  ClientOrdId   client_ord_id;
  OrderId       counterparty_order_id;
  ClientId      client_id;
  Price         price;          // the RESTING order's price — price improvement lives here
  Qty           qty;
  Qty           leaves_qty;
  Side          side;
  LiquidityFlag liquidity;
  TradeGrade    grade;          // filled in by the Phase 3 evaluator, Ungraded at match time
  std::uint8_t  _pad{0};
};

struct OrderAck {
  Seq         seq;
  Nanos       ts;
  OrderId     order_id;
  ClientOrdId client_ord_id;
  ClientId    client_id;
  OrderStatus status;
  RejectReason reject;
  std::uint16_t _pad{0};
};

// Anonymous public print, exactly what a real tape gives you.
struct TradePrint {
  Seq   seq;
  Nanos ts;
  Price price;
  Qty   qty;
  Side  aggressor;
  std::uint8_t _pad[7]{};
};

// One mutated level. The frontend applies these against its local L2 copy.
struct LevelDelta {
  Price price;
  Qty   qty;          // new aggregate resting qty; 0 means the level is gone
  std::uint32_t order_count;
  Side  side;
  std::uint8_t _pad[3]{};
};

struct AccountSnapshot {
  Seq      seq;
  Nanos    ts;
  ClientId client_id;
  std::uint32_t _pad{0};
  Money    cash;              // settled cash
  Money    reserved_margin;   // locked by open orders + open position
  Qty      position;          // signed; negative == short
  Money    avg_entry_micros;  // volume-weighted, integer micro-units
  Money    realized_pnl;
  Money    unrealized_pnl;    // marked to mid at snapshot time
  Money    equity;            // cash + realized + unrealized
};

static_assert(sizeof(Fill) <= 96, "Fill should stay small enough to batch cheaply");
static_assert(std::numeric_limits<Price>::is_integer, "no floating point prices");

}  // namespace hfta
