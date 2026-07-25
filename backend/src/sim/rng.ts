/**
 * backend/src/sim/rng.ts — xoshiro256** in TypeScript.
 *
 * This is a line-for-line mirror of hfta::Rng in
 * engine/include/hfta/scenario_generator.h, and it has to stay that way. The
 * whole replay story depends on the C++ engine and this reference sim expanding
 * the same 128-bit seed into the same order flow — so if one side changes its
 * draw sequence, the other is no longer a valid stand-in and old replays break.
 *
 * BigInt is used rather than a pair of 32-bit halves because correctness beats
 * cleverness here: the agent population draws a few thousand variates a second,
 * which BigInt handles without breaking a sweat, and a hand-rolled 64-bit
 * emulation is exactly the kind of code that is subtly wrong for six months.
 */

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64;
}

/** SplitMix64 — used only to expand a short seed into the four state words. */
function splitmix64(state: { s: bigint }): bigint {
  state.s = (state.s + 0x9e3779b97f4a7c15n) & MASK64;
  let z = state.s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

export class Rng {
  private s: [bigint, bigint, bigint, bigint];
  private draws = 0;

  constructor(seed: bigint | number) {
    const sm = { s: BigInt(seed) & MASK64 };
    this.s = [splitmix64(sm), splitmix64(sm), splitmix64(sm), splitmix64(sm)];
  }

  /** Raw 64-bit draw. Every other method is built on exactly one of these. */
  next(): bigint {
    this.draws++;
    const result = (rotl((this.s[1] * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (this.s[1] << 17n) & MASK64;
    this.s[2] ^= this.s[0];
    this.s[3] ^= this.s[1];
    this.s[1] ^= this.s[2];
    this.s[0] ^= this.s[3];
    this.s[2] ^= t;
    this.s[3] = rotl(this.s[3], 45n);
    return result;
  }

  /** Top 32 bits as a Number — the high bits are the well-mixed ones. */
  nextU32(): number {
    return Number(this.next() >> 32n);
  }

  /** Lemire's bounded reduction. Unbiased enough, and branch-light. */
  below(bound: number): number {
    if (bound <= 1) return 0;
    return Number((BigInt(this.nextU32()) * BigInt(bound)) >> 32n);
  }

  /** Uniform in [0,1) with 2^-32 resolution. */
  unit(): number {
    return this.nextU32() / 4294967296;
  }

  /** Inclusive integer range. */
  range(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + this.below(hi - lo + 1);
  }

  /** True with probability bps/10000. */
  chanceBps(bps: number): boolean {
    return this.below(10000) < bps;
  }

  /**
   * Exponential inter-arrival for a Poisson process, integer nanos.
   * Math.log is IEEE-754 correctly-rounded-ish and identical across V8 builds,
   * which is the determinism bar this reference sim needs to clear. The C++
   * engine uses an integer approximation for the same reason held to a higher
   * standard — see the note in scenario_generator.inl.
   */
  exponentialNanos(meanNanos: number): number {
    const u = Math.max(this.unit(), 1e-9);
    return Math.max(1, Math.round(-meanNanos * Math.log(u)));
  }

  /**
   * Approximately Gaussian integer jump via Irwin-Hall (sum of 4 uniforms).
   * Fixed draw count — this is load-bearing. An agent that draws a variable
   * number of variates desynchronises the two mirrored books.
   *
   * The normalisation matters and is easy to get wrong. Irwin-Hall(4) centred
   * at 2 has standard deviation sqrt(4/12) = 0.5774, so the correction factor
   * is 1/0.5774 = 1.7321. The C++ mirror in scenario_generator.h currently uses
   * 0.8165 (= sqrt(2/3)), which delivers 0.47 sigma instead of 1.0 sigma — a
   * silent 2.1x volatility under-shoot that made a calm market look frozen.
   * Fix it there too before the two engines are cross-checked.
   */
  gaussianTicks(sigma: number): number {
    let acc = 0;
    for (let i = 0; i < 4; i++) acc += this.unit();
    return Math.round((acc - 2) * sigma * 1.7321);
  }

  /** Lockstep proof. Two mirrored engines must end a match with equal counts. */
  drawCount(): number {
    return this.draws;
  }
}

/** Cheap 64-bit FNV-style mix, used for scenario fingerprints and state hashes. */
export class Hasher {
  private h = 0xcbf29ce484222325n;

  mix(v: number | bigint): this {
    const x = BigInt.asUintN(64, BigInt(Math.trunc(Number(v))));
    this.h = BigInt.asUintN(64, (this.h ^ x) * 0x100000001b3n);
    this.h = BigInt.asUintN(64, this.h ^ (this.h >> 29n));
    return this;
  }

  mixString(s: string): this {
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i));
    return this;
  }

  value(): bigint {
    return this.h;
  }

  hex(): string {
    return this.h.toString(16).padStart(16, '0');
  }
}
