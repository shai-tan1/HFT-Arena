// main.cpp — headless walking skeleton.
//
// Runs a 10-second synthetic scenario with no ZeroMQ, no Docker and no Node.
// Prints the book once a second, fires a few player orders, and finishes by
// re-running the identical seed in a second engine to prove the determinism
// guarantee the whole PvP design rests on.
//
// This is the thing to step through in CLion. If the flat-array-plus-bitmap
// book is wrong, it will be wrong here, where you can see it.

#include <cstdio>
#include <string>
#include <vector>

#include "hfta/matching_engine.h"

using namespace hfta;

namespace {

constexpr ClientId kPlayer = 0;
constexpr Price    kOpen   = 10'000;   // ticks

InstrumentSpec make_instrument() {
  InstrumentSpec s{};
  s.instrument_id = 1;
  s.tick_floor = 1;
  s.num_levels = 20'000;               // 1 .. 20000 ticks
  s.tick_value_micros = 10'000;        // 1 tick = 0.01 units of quote currency
  s.lot_size = 1;
  s.max_order_qty = 10'000;
  s.margin_bps_long = 2'000;           // 20%
  s.margin_bps_short = 3'000;          // 30%
  s.allow_short = true;
  return s;
}

ScenarioSpec make_scenario(std::uint64_t hi, std::uint64_t lo) {
  ScenarioSpec sc{};
  sc.seed_hi = hi;
  sc.seed_lo = lo;
  sc.scenario_version = 1;
  sc.open_price = kOpen;

  sc.timeline = {
      {Regime::Calm,     3'000'000'000LL, 30},
      {Regime::Trending, 4'000'000'000LL, 55},
      {Regime::Volatile, 3'000'000'000LL, 85},
  };

  AgentConfig mm{};
  mm.kind = AgentKind::MarketMaker;
  mm.count = 6;
  mm.mean_interarrival = 40'000'000;   // requote ~25x/sec
  mm.size_min = 5;
  mm.size_max = 40;
  mm.spread_ticks = 2;
  mm.inventory_limit = 200;

  AgentConfig noise{};
  noise.kind = AgentKind::NoiseTrader;
  noise.count = 10;
  noise.mean_interarrival = 60'000'000;
  noise.size_min = 1;
  noise.size_max = 12;

  AgentConfig mom{};
  mom.kind = AgentKind::Momentum;
  mom.count = 4;
  mom.mean_interarrival = 120'000'000;
  mom.size_min = 5;
  mom.size_max = 25;

  AgentConfig sweep{};
  sweep.kind = AgentKind::Sweeper;
  sweep.count = 2;
  sweep.mean_interarrival = 400'000'000;
  sweep.size_min = 10;
  sweep.size_max = 30;

  sc.agents = {mm, noise, mom, sweep};
  return sc;
}

EngineConfig make_config() {
  EngineConfig cfg{};
  cfg.spec = make_instrument();
  cfg.order_capacity = 1u << 16;
  cfg.starting_cash = 100'000'000'000LL;   // 100,000 units in micro-units
  cfg.market_band_bps = 500;
  cfg.match_duration = 0;                  // driven manually below
  cfg.snapshot_interval = 0;               // off for the console skeleton
  return cfg;
}

std::string money(Money micros) {
  char buf[64];
  const long long whole = static_cast<long long>(micros / 1'000'000);
  long long frac = static_cast<long long>(micros % 1'000'000);
  if (frac < 0) frac = -frac;
  std::snprintf(buf, sizeof(buf), "%lld.%06lld", whole, frac);
  return std::string(buf);
}

void print_book(const MatchingEngine& eng, Nanos t) {
  const OrderBook& b = eng.book();
  OrderBook::L2Entry bids[5];
  OrderBook::L2Entry asks[5];
  const std::size_t nb = b.snapshot_l2(Side::Buy, 5, bids);
  const std::size_t na = b.snapshot_l2(Side::Sell, 5, asks);

  std::printf("\n--- t = %4.1fs -------------------------------------------\n",
              static_cast<double>(t) / 1e9);
  std::printf("     %10s %8s   |   %-10s %-8s\n", "BID", "SIZE", "ASK", "SIZE");
  for (std::size_t i = 0; i < 5; ++i) {
    char lhs[32] = "                  ";
    char rhs[32] = "";
    if (i < nb) {
      std::snprintf(lhs, sizeof(lhs), "%10lld %8lld",
                    static_cast<long long>(bids[i].price),
                    static_cast<long long>(bids[i].qty));
    }
    if (i < na) {
      std::snprintf(rhs, sizeof(rhs), "%-10lld %-8lld",
                    static_cast<long long>(asks[i].price),
                    static_cast<long long>(asks[i].qty));
    }
    std::printf("     %-19s |   %s\n", lhs, rhs);
  }

  const Price vwap = eng.rolling_vwap(1'000'000'000);
  std::printf("     spread=%lld  live_orders=%zu  vwap(1s)=%lld\n",
              static_cast<long long>(b.spread()), b.live_order_count(),
              static_cast<long long>(vwap == kNoPrice ? 0 : vwap));
}

// Convenience: fire a player order and report what came back.
void player_order(MatchingEngine& eng, EventBuffer& buf, Nanos t,
                  const char* label, Side side, OrderType type, Price px,
                  Qty qty) {
  const std::size_t before_fills = buf.fills().size();
  const std::size_t before_acks = buf.acks().size();

  NewOrderCmd cmd{};
  cmd.client_ord_id = static_cast<ClientOrdId>(t);
  cmd.client_id = kPlayer;
  cmd.price = px;
  cmd.qty = qty;
  cmd.type = type;
  cmd.side = side;
  cmd.tif = (type == OrderType::Market) ? TimeInForce::IOC : TimeInForce::GTC;

  const SubmitResult r = eng.on_new_order(cmd, t, buf);

  std::printf("\n>>> %s: %s %lld @ %s\n", label,
              side == Side::Buy ? "BUY" : "SELL", static_cast<long long>(qty),
              type == OrderType::Market ? "MKT" : std::to_string(px).c_str());

  if (!r.accepted) {
    std::printf("    REJECTED (reason code %u)\n",
                static_cast<unsigned>(r.reject));
    return;
  }
  std::printf("    order_id=%llu  filled=%lld  resting=%lld\n",
              static_cast<unsigned long long>(r.order_id),
              static_cast<long long>(r.filled_qty),
              static_cast<long long>(r.resting_qty));

  for (std::size_t i = before_fills; i < buf.fills().size(); ++i) {
    const Fill& f = buf.fills()[i];
    if (f.client_id != kPlayer) continue;
    std::printf("    fill %lld @ %lld (%s)\n", static_cast<long long>(f.qty),
                static_cast<long long>(f.price),
                f.liquidity == LiquidityFlag::Maker ? "maker" : "taker");
  }
  for (std::size_t i = before_acks; i < buf.acks().size(); ++i) {
    const OrderAck& a = buf.acks()[i];
    if (a.client_id == kPlayer && a.status == OrderStatus::Rejected) {
      std::printf("    ack REJECT reason=%u\n", static_cast<unsigned>(a.reject));
    }
  }
}

std::uint64_t run_scenario(bool verbose, std::uint64_t seed_hi,
                           std::uint64_t seed_lo) {
  MatchingEngine eng(make_config());
  eng.arm(make_scenario(seed_hi, seed_lo), {kPlayer});
  eng.start(0);

  EventBuffer buf;

  for (int sec = 1; sec <= 10; ++sec) {
    const Nanos t = static_cast<Nanos>(sec) * 1'000'000'000LL;
    eng.run_until(t, buf);

    if (verbose) {
      print_book(eng, t);

      if (sec == 3) {
        player_order(eng, buf, t, "market buy", Side::Buy, OrderType::Market, 0, 50);
      }
      if (sec == 5 && eng.book().has_bid()) {
        // Passive: rest inside the spread and see if the tape comes to us.
        player_order(eng, buf, t, "passive sell", Side::Sell, OrderType::Limit,
                     eng.book().best_ask() - 1, 30);
      }
      if (sec == 7) {
        // Deliberately oversized: should trip InsufficientMargin (code 6).
        player_order(eng, buf, t, "oversized short", Side::Sell,
                     OrderType::Market, 0, 9'999);
      }
    }
  }

  if (verbose) {
    const AccountSnapshot s = eng.snapshot(kPlayer, eng.now());
    std::printf("\n=== PLAYER SUMMARY ======================================\n");
    std::printf("  position        %lld lots\n", static_cast<long long>(s.position));
    std::printf("  avg entry       %s\n", money(s.avg_entry_micros).c_str());
    std::printf("  realized pnl    %s\n", money(s.realized_pnl).c_str());
    std::printf("  unrealized pnl  %s\n", money(s.unrealized_pnl).c_str());
    std::printf("  equity          %s\n", money(s.equity).c_str());
    std::printf("  reserved margin %s\n", money(s.reserved_margin).c_str());
    std::printf("\n  events: %zu fills, %zu prints, %zu acks\n",
                buf.fills().size(), buf.prints().size(), buf.acks().size());
    std::printf("  final seq: %llu\n",
                static_cast<unsigned long long>(eng.seq()));
  }

  return eng.state_hash();
}

}  // namespace

int main() {
  std::printf("HFT Arena — walking skeleton\n");
  std::printf("============================\n");

  const std::uint64_t hash_a = run_scenario(true, 0xC0FFEE, 0xBADC0DE);

  // ---- the assertion the whole PvP design rests on -------------------------
  // Same seed, fresh engine, no player orders in either run's hash path beyond
  // what is scripted. If these ever disagree, mirrored matches are unfair and
  // replay is worthless. Wire this into CI over a 10M-event scenario.
  std::printf("\n=== DETERMINISM CHECK ===================================\n");
  const std::uint64_t hash_b = run_scenario(true, 0xC0FFEE, 0xBADC0DE);
  const std::uint64_t hash_c = run_scenario(false, 0xC0FFEE, 0xBADC0DF);

  std::printf("\n  run A state_hash: %016llx\n",
              static_cast<unsigned long long>(hash_a));
  std::printf("  run B state_hash: %016llx  (same seed)\n",
              static_cast<unsigned long long>(hash_b));
  std::printf("  run C state_hash: %016llx  (different seed)\n",
              static_cast<unsigned long long>(hash_c));

  const bool ok = (hash_a == hash_b) && (hash_a != hash_c);
  std::printf("\n  %s\n", ok ? "PASS — identical seeds converge, different seeds diverge"
                             : "FAIL — determinism is broken, do not build on this");
  return ok ? 0 : 1;
}
