#include "hfta/scenario_generator.h"

#include <algorithm>

namespace hfta {

// ---------------------------------------------------------------------------
// Rng — xoshiro256** seeded through SplitMix64.
//
// Deliberately NOT std::mt19937 + std::uniform_int_distribution: the standard
// does not specify identical output for the distributions across standard
// library implementations. On a mixed fleet that silently desynchronises two
// mirrored matches, which is the exact failure this whole design exists to
// prevent. Rolling our own is the cheap insurance.
// ---------------------------------------------------------------------------
namespace {
inline std::uint64_t splitmix64(std::uint64_t& x) noexcept {
  std::uint64_t z = (x += 0x9E3779B97F4A7C15ULL);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return z ^ (z >> 31);
}
inline std::uint64_t rotl(std::uint64_t x, int k) noexcept {
  return (x << k) | (x >> (64 - k));
}
}  // namespace

void Rng::seed_from(std::uint64_t seed) noexcept {
  std::uint64_t x = seed;
  for (auto& v : s_) v = splitmix64(x);
  draws_ = 0;
}

std::uint64_t Rng::next() noexcept {
  ++draws_;
  const std::uint64_t result = rotl(s_[1] * 5, 7) * 9;
  const std::uint64_t t = s_[1] << 17;
  s_[2] ^= s_[0];
  s_[3] ^= s_[1];
  s_[1] ^= s_[2];
  s_[0] ^= s_[3];
  s_[2] ^= t;
  s_[3] = rotl(s_[3], 45);
  return result;
}

std::uint32_t Rng::below(std::uint32_t bound) noexcept {
  if (bound == 0) { next(); return 0; }
  // Lemire's multiply-shift reduction. One draw, always, regardless of value —
  // rejection sampling would make the draw count state-dependent and break
  // stream lockstep between mirrored containers.
  const std::uint64_t r = next() >> 32;
  return static_cast<std::uint32_t>((r * bound) >> 32);
}

Nanos Rng::exponential_nanos(Nanos mean) noexcept {
  if (mean <= 0) { next(); return 1; }
  // Integer approximation of an exponential: sum of two uniforms biased toward
  // short gaps. Good enough for order flow, and exactly reproducible, which
  // matters more here than distributional purity.
  const std::uint64_t a = next() >> 33;
  const std::uint64_t b = next() >> 33;
  const std::uint64_t u = (a + b) % static_cast<std::uint64_t>(mean * 2);
  return static_cast<Nanos>(u) + 1;
}

std::int32_t Rng::gaussian_ticks(std::uint32_t sigma) noexcept {
  // Irwin-Hall with n=4: cheap, symmetric, bounded, deterministic.
  std::int64_t acc = 0;
  for (int i = 0; i < 4; ++i) acc += static_cast<std::int64_t>(below(2 * sigma + 1));
  const std::int64_t mean = 4 * static_cast<std::int64_t>(sigma);
  return static_cast<std::int32_t>((acc - mean) / 2);
}

// ---------------------------------------------------------------------------
// ScenarioSpec fingerprint — the backend sends this to both containers and each
// echoes back its own computed value on CtlArm. A mismatch aborts the match
// BEFORE anyone trades rather than after someone has lost rating to it.
// ---------------------------------------------------------------------------
std::uint64_t ScenarioSpec::fingerprint() const noexcept {
  std::uint64_t h = 1469598103934665603ULL;
  auto mix = [&h](std::uint64_t v) {
    h ^= v;
    h *= 1099511628211ULL;
  };
  mix(seed_hi);
  mix(seed_lo);
  mix(scenario_version);
  mix(static_cast<std::uint64_t>(open_price));
  for (const auto& seg : timeline) {
    mix(static_cast<std::uint64_t>(seg.regime));
    mix(static_cast<std::uint64_t>(seg.duration));
    mix(seg.intensity);
  }
  for (const auto& a : agents) {
    mix(static_cast<std::uint64_t>(a.kind));
    mix(a.count);
    mix(static_cast<std::uint64_t>(a.mean_interarrival));
    mix(static_cast<std::uint64_t>(a.size_min));
    mix(static_cast<std::uint64_t>(a.size_max));
    mix(a.spread_ticks);
    mix(a.aggression_bps);
    mix(static_cast<std::uint64_t>(a.inventory_limit));
  }
  return h;
}

// ---------------------------------------------------------------------------
// arm — build the agent population and pre-seed the wakeup heap.
//
// Every agent gets its own stream derived from (seed, agent_index). Wakeup
// times therefore depend only on the seed, never on book state, which is what
// keeps two mirrored containers scheduling identically forever.
// ---------------------------------------------------------------------------
void ScenarioGenerator::arm(const ScenarioSpec& spec,
                            const InstrumentSpec& instrument) {
  spec_ = spec;
  instrument_ = instrument;
  agents_.clear();
  heap_.clear();
  segment_starts_.clear();

  Nanos t = 0;
  for (const auto& seg : spec_.timeline) {
    segment_starts_.push_back(t);
    t += seg.duration;
  }

  std::uint32_t agent_index = 0;
  for (const auto& cfg : spec_.agents) {
    for (std::uint32_t c = 0; c < cfg.count; ++c) {
      AgentState st;
      st.cfg = cfg;
      st.client_id = kFirstAgentClientId + agent_index;
      std::uint64_t stream = spec_.seed_lo ^ (spec_.seed_hi * 0x9E3779B97F4A7C15ULL);
      stream ^= (static_cast<std::uint64_t>(agent_index) + 1) * 0xD1B54A32D192ED03ULL;
      st.rng = Rng(stream);
      st.last_ref = spec_.open_price;
      agents_.push_back(st);

      AgentWakeup w;
      w.agent_id = agent_index;
      w.t = agents_.back().rng.exponential_nanos(cfg.mean_interarrival);
      w.nonce = 0;
      heap_.push_back(w);
      std::push_heap(heap_.begin(), heap_.end(), std::greater<AgentWakeup>{});
      ++agent_index;
    }
  }
}

Regime ScenarioGenerator::current_regime(Nanos t) const noexcept {
  if (spec_.timeline.empty()) return Regime::Calm;
  for (std::size_t i = segment_starts_.size(); i-- > 0;) {
    if (t >= segment_starts_[i]) return spec_.timeline[i].regime;
  }
  return spec_.timeline.front().regime;
}

std::uint32_t ScenarioGenerator::current_intensity(Nanos t) const noexcept {
  if (spec_.timeline.empty()) return 50;
  for (std::size_t i = segment_starts_.size(); i-- > 0;) {
    if (t >= segment_starts_[i]) return spec_.timeline[i].intensity;
  }
  return spec_.timeline.front().intensity;
}

std::uint64_t ScenarioGenerator::total_draws() const noexcept {
  std::uint64_t sum = 0;
  for (const auto& a : agents_) sum += a.rng.draw_count();
  return sum;
}

}  // namespace hfta
