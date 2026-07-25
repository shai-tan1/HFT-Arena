// hfta/zmq_gateway.h — the ZeroMQ edge of the engine process.
//
// ============================================================================
// SOCKET TOPOLOGY
// ============================================================================
//
//   Node.js backend process                    C++ engine container
//   ───────────────────────                    ────────────────────
//
//   DEALER  ────────── tcp://engine:7001 ──────────>  ROUTER   (commands)
//     ^                                                  │       + control
//     └────────────────  replies, identity-routed ───────┘
//
//   SUB     <───────── tcp://engine:7002 ───────────  PUB      (market data,
//                       topic-filtered frames                   execs, state)
//
//   REQ     ────────── tcp://engine:7003 ──────────>  REP      (health, admin,
//                                                               state hash)
//
// WHY THESE PATTERNS
//   ROUTER/DEALER for the command path: asynchronous in both directions (no
//   lockstep request-reply stall), multiple concurrent players, and the ROUTER
//   gets a free identity frame so a reject can be routed straight back to the
//   originating session without a lookup table.
//
//   PUB/SUB for market data: one-to-many, and the subscriber does the
//   filtering. Both seats plus the recorder plus the live spectator feed all
//   attach to the same publisher at no extra cost to the engine.
//
//   A separate REP socket for health so that a wedged command path is still
//   diagnosable. This is what the Docker HEALTHCHECK and the matchmaker's
//   readiness probe hit.
//
// WHY ZEROMQ HERE AND REDIS ELSEWHERE
//   Use both, for different planes. ZeroMQ is brokerless: an engine->backend
//   message is one hop, tens of microseconds over TCP loopback and single-digit
//   microseconds over ipc:// unix sockets. Redis pub/sub adds a broker round
//   trip and is fire-and-forget anyway. But Redis is the right tool for the
//   CONTROL plane: matchmaking queue (sorted set keyed by ELO), presence,
//   session tokens, rate-limit counters, and the pre-warmed container pool.
//   Rule of thumb: if it is inside a match, ZeroMQ; if it is about matches,
//   Redis.
//
// TRANSPORT SELECTION
//   Same host  -> ipc:///var/run/hfta/<match_id>.sock   (fastest, no TCP stack)
//   Containers -> tcp://<container>:<port>              (what Docker gives you)
//   Set both in config; the gateway binds whatever the URI scheme says.
//
// ============================================================================
// THREAD MODEL
// ============================================================================
//
//   [zmq io thread]  (libzmq internal, 1 thread)
//          │
//   [gateway thread] recv -> validate header -> decode -> push ingress ring
//          │                                                    │
//          │                                          (SPSC, lock free)
//          │                                                    v
//          │                                          [engine thread]
//          │                                          run_until(now)
//          │                                                    │
//          │              <── pop egress ring ── encode ── push ─┘
//          v
//   send on ROUTER (private) + PUB (market data)
//
//   The engine thread NEVER calls into libzmq. It never blocks, never
//   allocates in steady state, and never reads a clock for decision purposes.
//   That is what keeps determinism intact while the socket layer does messy,
//   nondeterministically-timed things.
// ============================================================================
#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

#include "hfta/ipc_protocol.h"
#include "hfta/matching_engine.h"

namespace hfta::ipc {

// ---------------------------------------------------------------------------
// SpscRing — single producer, single consumer, power-of-two, cache-line padded.
// The only synchronisation primitive in the entire engine.
// ---------------------------------------------------------------------------
template <class T, std::size_t CapacityPow2>
class SpscRing {
 public:
  static_assert((CapacityPow2 & (CapacityPow2 - 1)) == 0, "capacity must be 2^n");

  bool try_push(const T& v) noexcept;
  bool try_pop(T& out) noexcept;
  [[nodiscard]] std::size_t size_approx() const noexcept;

 private:
  static constexpr std::size_t kMask = CapacityPow2 - 1;
  alignas(64) std::atomic<std::size_t> head_{0};   // consumer
  alignas(64) std::atomic<std::size_t> tail_{0};   // producer
  alignas(64) std::array<T, CapacityPow2> buf_{};
};

// A decoded inbound command, tagged so the engine thread can dispatch without
// re-reading the wire header.
struct IngressItem {
  MsgType type;
  std::uint64_t session;   // ROUTER identity hash, for reply routing
  union {
    NewOrderCmd new_order;
    CancelCmd   cancel;
    ReplaceCmd  replace;
    ClientId    flatten_client;
  } body;
};

struct GatewayConfig {
  std::string command_endpoint{"tcp://0.0.0.0:7001"};  // ROUTER bind
  std::string publish_endpoint{"tcp://0.0.0.0:7002"};  // PUB bind
  std::string health_endpoint{"tcp://0.0.0.0:7003"};   // REP bind
  std::uint64_t match_id{0};

  // High water marks. The command path must NEVER silently drop: set a bounded
  // HWM and treat an overflow as a hard reject back to the player. The market
  // data path is different — if a subscriber is too slow it deserves to lose
  // frames and recover via snapshot, which is exactly how real feeds behave.
  int command_hwm{4096};
  int publish_hwm{65536};
  int linger_ms{0};

  // App-level conflation cadence for L2. Do NOT use ZMQ_CONFLATE: it silently
  // breaks multipart messages, which is our entire framing scheme.
  Nanos l2_publish_interval{20'000'000};   // 50 Hz
  Nanos heartbeat_interval{1'000'000'000}; // 1 Hz liveness to the backend
};

class ZmqGateway {
 public:
  ZmqGateway(GatewayConfig cfg, MatchingEngine& engine);
  ~ZmqGateway();

  ZmqGateway(const ZmqGateway&) = delete;
  ZmqGateway& operator=(const ZmqGateway&) = delete;

  void start();            // binds sockets, spawns gateway + engine threads
  void request_stop() noexcept;
  void join();

  // Telemetry the backend scrapes over the REP socket.
  struct Stats {
    std::uint64_t commands_in{0};
    std::uint64_t events_out{0};
    std::uint64_t ingress_overflows{0};   // any nonzero value is a bug or a DoS
    std::uint64_t egress_drops{0};
    std::uint64_t decode_errors{0};
    std::uint64_t p99_command_to_ack_ns{0};
  };
  [[nodiscard]] Stats stats() const noexcept;

 private:
  void gateway_loop();     // zmq_poll on ROUTER + REP, drain egress ring
  void engine_loop();      // drain ingress ring, run_until, fill egress ring

  // Decode with full validation. A malformed frame from the network must never
  // reach the engine thread: check magic, version, body_len against the actual
  // frame size, and enum ranges. Untrusted input stops here.
  bool decode(const void* frame, std::size_t len, IngressItem& out) noexcept;

  void publish_events(const EventBuffer&);
  void publish_l2_snapshot();
  void send_private(std::uint64_t session, MsgType, const void* body,
                    std::size_t len, std::uint32_t count);

  GatewayConfig   cfg_;
  MatchingEngine& engine_;

  SpscRing<IngressItem, 1u << 14> ingress_;
  // Egress carries pre-encoded byte blobs so the engine thread never touches
  // a socket and the gateway thread never touches engine state.
  struct EgressFrame { TopicKey topic; std::uint32_t len; std::uint8_t data[512]; };
  SpscRing<EgressFrame, 1u << 16> egress_;

  std::atomic<bool> running_{false};
  struct Impl;                       // libzmq handles, hidden to keep zmq.h
  std::unique_ptr<Impl> impl_;       // out of every translation unit
};

}  // namespace hfta::ipc
