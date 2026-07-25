// hfta/ipc_protocol.h — the C++ <-> Node.js wire contract.
//
// ============================================================================
// WHY BINARY, AND WHY NOT JSON
// ============================================================================
// At 50 Hz L2 snapshots plus a full event tape, a single match produces tens of
// thousands of messages. JSON.parse on the Node side would dominate the whole
// latency budget and would also reintroduce floating point into a system that
// went to some trouble to avoid it. These structs are fixed-layout, memcpy on
// the C++ side and DataView reads on the Node side.
//
// RULES
//   * Little endian on the wire. Every target is x86-64 or aarch64 LE; there is
//     a static assert to make the assumption explicit rather than implicit.
//   * Never renumber a MsgType. Never reorder a field. Add at the tail and bump
//     kProtocolVersion; the gateway rejects a version mismatch at handshake.
//   * Every struct is `#pragma pack(1)` with a size assertion, so a typo in the
//     TypeScript codec fails at build time, not at 3am during a live match.
// ============================================================================
#pragma once

// #include <bits/stdc++.h>
#include <cstdint>
#include <type_traits>

#include "hfta/types.h"

namespace hfta::ipc {

inline constexpr std::uint32_t kMagic = 0x48465441u;  // 'HFTA'
inline constexpr std::uint16_t kProtocolVersion = 1;

// ---------------------------------------------------------------------------
// Message types. Ranges are deliberate: a switch can dispatch on the high bits.
//   0x01-0x1F  commands   (Node -> engine, per player)
//   0x20-0x3F  control    (Node -> engine, per match lifecycle)
//   0x40-0x7F  events     (engine -> Node, per player or broadcast)
//   0x80-0x9F  telemetry  (engine -> Node, out of band)
// ---------------------------------------------------------------------------
enum class MsgType : std::uint16_t {
  CmdNewOrder      = 0x01,
  CmdCancel        = 0x02,
  CmdReplace       = 0x03,
  CmdFlatten       = 0x04,
  CmdSnapshotReq   = 0x05,  // subscriber detected a gap, asks for a full L2

  CtlArm           = 0x20,  // scenario spec + seat assignment
  CtlStart         = 0x21,
  CtlPause         = 0x22,
  CtlResume        = 0x23,
  CtlFinish        = 0x24,
  CtlTeardown      = 0x25,
  CtlHeartbeat     = 0x26,

  EvtAck           = 0x40,
  EvtFill          = 0x41,
  EvtTradePrint    = 0x42,
  EvtL2Delta       = 0x43,
  EvtL2Snapshot    = 0x44,
  EvtAccount       = 0x45,
  EvtEngineState   = 0x46,
  EvtMatchEnd      = 0x47,  // final balances + state hash for both seats

  TlmLatency       = 0x80,
  TlmError         = 0x81,
};

#pragma pack(push, 1)

// Every frame's second ZMQ part starts with this. 40 bytes.
struct WireHeader {
  std::uint32_t magic;       // kMagic — cheap corruption / misroute detector
  std::uint16_t version;     // kProtocolVersion
  std::uint16_t msg_type;    // MsgType
  std::uint32_t body_len;    // bytes following this header
  std::uint32_t body_count;  // for repeated bodies (N fills in one frame)
  std::uint64_t match_id;
  std::uint64_t seq;         // per-socket monotonic; gaps == dropped frames
  std::uint64_t t_send;      // engine logical nanos (events) or wall (control)
};
static_assert(sizeof(WireHeader) == 40, "WireHeader layout changed");

// -- commands ---------------------------------------------------------------
struct WireNewOrder {
  std::uint64_t client_ord_id;
  std::uint32_t client_id;
  std::uint32_t _pad;
  std::int64_t  price;
  std::int64_t  qty;
  std::uint8_t  type;    // OrderType
  std::uint8_t  side;    // Side
  std::uint8_t  tif;     // TimeInForce
  std::uint8_t  _pad2[5];
};
static_assert(sizeof(WireNewOrder) == 40, "WireNewOrder layout changed");

struct WireCancel {
  std::uint64_t order_id;
  std::uint64_t client_ord_id;
  std::uint32_t client_id;
  std::uint32_t _pad;
};
static_assert(sizeof(WireCancel) == 24, "WireCancel layout changed");

// -- events -----------------------------------------------------------------
struct WireAck {
  std::uint64_t order_id;
  std::uint64_t client_ord_id;
  std::uint64_t ts;
  std::uint32_t client_id;
  std::uint8_t  status;   // OrderStatus
  std::uint8_t  reject;   // RejectReason
  std::uint16_t _pad;
};
static_assert(sizeof(WireAck) == 32, "WireAck layout changed");

struct WireFill {
  std::uint64_t order_id;
  std::uint64_t client_ord_id;
  std::uint64_t ts;
  std::int64_t  price;
  std::int64_t  qty;
  std::int64_t  leaves_qty;
  std::uint32_t client_id;
  std::uint8_t  side;
  std::uint8_t  liquidity;   // LiquidityFlag — drives the maker-rebate scoring
  std::uint8_t  grade;       // TradeGrade, Ungraded live, filled in post-match
  std::uint8_t  _pad;
};
static_assert(sizeof(WireFill) == 56, "WireFill layout changed");

struct WireTradePrint {
  std::uint64_t ts;
  std::int64_t  price;
  std::int64_t  qty;
  std::uint8_t  aggressor;
  std::uint8_t  _pad[7];
};
static_assert(sizeof(WireTradePrint) == 32, "WireTradePrint layout changed");

struct WireLevelDelta {
  std::int64_t  price;
  std::int64_t  qty;          // 0 == level removed
  std::uint32_t order_count;
  std::uint8_t  side;
  std::uint8_t  _pad[3];
};
static_assert(sizeof(WireLevelDelta) == 24, "WireLevelDelta layout changed");

struct WireAccount {
  std::uint64_t ts;
  std::uint32_t client_id;
  std::uint32_t _pad;
  std::int64_t  cash;
  std::int64_t  reserved_margin;
  std::int64_t  position;
  std::int64_t  avg_entry;
  std::int64_t  realized_pnl;
  std::int64_t  unrealized_pnl;
  std::int64_t  equity;
};
static_assert(sizeof(WireAccount) == 72, "WireAccount layout changed");

struct WireMatchEnd {
  std::uint64_t ts;
  std::uint64_t state_hash;   // MUST match across mirrored containers
  std::uint64_t total_draws;  // PRNG lockstep proof
  std::uint32_t seat_count;
  std::uint32_t _pad;
  // followed by seat_count * WireAccount
};
static_assert(sizeof(WireMatchEnd) == 32, "WireMatchEnd layout changed");

#pragma pack(pop)

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "Wire format assumes little-endian; add byteswaps for BE targets"
#endif
// ---------------------------------------------------------------------------
// PUB topic keys. The first ZMQ frame is an 8-byte fixed-width topic so SUB
// side filtering is a raw prefix compare with no string allocation. Fixed width
// also means a topic can never be a prefix of a different topic by accident.
//
//   "md.l2\0\0\0"      aggregated depth deltas + snapshots  (both seats)
//   "md.trd\0\0"       anonymous tape                       (both seats)
//   "ex.NNNN"          private executions, N = client_id LE (one seat)
//   "sys.\0\0\0\0"     engine state, telemetry, match end
// ---------------------------------------------------------------------------
struct TopicKey {
  char bytes[8];
  static TopicKey md_l2()     noexcept { return make("md.l2"); }
  static TopicKey md_trades() noexcept { return make("md.trd"); }
  static TopicKey system()    noexcept { return make("sys."); }
  static TopicKey exec_for(ClientId c) noexcept;   // "ex." + 4 LE bytes + pad
 private:
  static TopicKey make(const char* s) noexcept;
};
static_assert(sizeof(TopicKey) == 8, "TopicKey must stay 8 bytes");

}  // namespace hfta::ipc
