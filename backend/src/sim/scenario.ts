/**
 * backend/src/sim/scenario.ts — synthetic order flow.
 *
 * ===========================================================================
 * THE CONSTRAINT THIS FILE EXISTS TO SATISFY
 * ===========================================================================
 * In a PvP match both players must face "the same market". Taken naively that
 * is impossible, because each player's own orders change their book, and any
 * agent that reacts to the book would then behave differently for each of them.
 *
 * The resolution, identical to the one in scenario_generator.h, is to separate
 * the RANDOM STREAM from the DECISION:
 *
 *   1. Wakeup times come only from (seed, agentId, n). Both mirrored engines
 *      schedule the same wakeups at the same logical nanosecond.
 *   2. At each wakeup the agent draws a FIXED number of variates, before it
 *      looks at anything. Draw counts never depend on state.
 *   3. Only the MAPPING from variates to an action reads the book.
 *
 * The consequence is the good one: leaning on the bid really does make the
 * market makers skew away from you, without desynchronising your opponent's
 * copy of the world. The proof is mechanical — both engines must report equal
 * total draw counts at match end even though their books differ.
 *
 * A separate "market" stream drives fair value. It never reads the book at all,
 * so the underlying price path is bit-identical for both seats by construction.
 */

import { Rng, Hasher } from './rng';
import { Side, OrderType, TimeInForce, type Regime, type AgentKind } from '../../../shared/src/protocol';
import { divRound } from './orderBook';

export interface RegimeSegment {
  regime: Regime;
  durationMs: number;
  intensity: number; // 0..100
}

export interface AgentConfig {
  kind: AgentKind;
  count: number;
  meanInterarrivalMs: number;
  sizeMin: number;
  sizeMax: number;
  spreadTicks?: number;
  aggressionBps?: number;
  inventoryLimit?: number;
}

export interface ScenarioSpec {
  id: number;
  label: string;
  difficulty: number;
  instrumentId: number;
  seedHi: bigint;
  seedLo: bigint;
  scenarioVersion: number;
  openPrice: number; // ticks
  timeline: RegimeSegment[];
  agents: AgentConfig[];
}

export interface MarketView {
  bestBid(): number | null;
  bestAsk(): number | null;
  mark(): number | null;
  qtyAt(side: Side, price: number): number;
}

export interface SynthNewOrder {
  clientId: number;
  clientOrdId: number;
  side: Side;
  type: OrderType;
  tif: TimeInForce;
  price: number;
  qty: number;
}

export interface EmitSink {
  newOrder(o: SynthNewOrder): void;
  cancel(clientId: number, orderId: number): void;
}

/**
 * Per-regime market character. Everything is an integer in milli-units so the
 * fair-value walk stays exact — a float fair value would reintroduce the
 * cross-platform drift this whole design is built to avoid.
 */
interface RegimeParams {
  /** Signed drift in milli-ticks per second, before intensity scaling. */
  driftMilliPerSec: number;
  /**
   * Standard deviation of the price over ONE SECOND, in milli-ticks.
   *
   * Read that carefully, because the obvious reading is wrong and was wrong
   * here: a random walk's spread grows with the SQUARE ROOT of time, so a
   * per-step shock is sigma * sqrt(dt), not sigma * dt. Scaling it linearly
   * shrinks the per-step shock by sqrt(steps-per-second) — at 20 Hz that is a
   * 4.5x under-shoot, which rounded to a completely motionless market.
   */
  sigmaMilliPerSec: number;
  /** Pull back toward the segment anchor, in parts per thousand per second. */
  reversionPerMille: number;
  /** Market-maker half-spread multiplier, x100. */
  spreadX100: number;
  /** Quoted size multiplier, x100. Below 100 means a thinner book. */
  depthX100: number;
  /** Extra probability that a noise trader crosses, in bps. */
  aggressionBps: number;
  /** One-sided quoting: MMs pull the bid (or offer) entirely. */
  oneSided?: Side;
}

const REGIMES: Record<Regime, RegimeParams> = {
  Calm: {
    driftMilliPerSec: 0, sigmaMilliPerSec: 3500, reversionPerMille: 80,
    spreadX100: 100, depthX100: 160, aggressionBps: 0,
  },
  Trending: {
    driftMilliPerSec: 1600, sigmaMilliPerSec: 5000, reversionPerMille: 10,
    spreadX100: 110, depthX100: 100, aggressionBps: 900,
  },
  Choppy: {
    driftMilliPerSec: 0, sigmaMilliPerSec: 7000, reversionPerMille: 380,
    spreadX100: 105, depthX100: 130, aggressionBps: 400,
  },
  Volatile: {
    driftMilliPerSec: 0, sigmaMilliPerSec: 14000, reversionPerMille: 60,
    spreadX100: 260, depthX100: 55, aggressionBps: 1800,
  },
  LiquidityGap: {
    driftMilliPerSec: -1200, sigmaMilliPerSec: 12000, reversionPerMille: 40,
    spreadX100: 340, depthX100: 30, aggressionBps: 2200, oneSided: Side.Sell,
  },
  NewsSpike: {
    driftMilliPerSec: 0, sigmaMilliPerSec: 18000, reversionPerMille: 30,
    spreadX100: 300, depthX100: 45, aggressionBps: 3000,
  },
  FlashCrash: {
    driftMilliPerSec: -9000, sigmaMilliPerSec: 16000, reversionPerMille: 20,
    spreadX100: 420, depthX100: 25, aggressionBps: 3600, oneSided: Side.Sell,
  },
  Squeeze: {
    driftMilliPerSec: 2400, sigmaMilliPerSec: 3500, reversionPerMille: 5,
    spreadX100: 130, depthX100: 85, aggressionBps: 1500,
  },
};

interface Wakeup {
  t: number; // nanos
  agentId: number;
  nonce: number;
}

interface AgentState {
  cfg: AgentConfig;
  kind: AgentKind;
  agentId: number;
  clientId: number;
  rng: Rng;
  inventory: number;
  /** Every resting order this agent owns. Pulled wholesale on requote. */
  quotes: number[];
  lastRef: number | null;
  nonce: number;
}

/** Levels an MM shows per side. Deep enough to trade into, cheap to refresh. */
const MM_LADDER_DEPTH = 3;

export const FIRST_AGENT_CLIENT_ID = 1 << 20;
const NANOS_PER_MS = 1_000_000;

export class ScenarioGenerator {
  private spec!: ScenarioSpec;
  private agents: AgentState[] = [];
  private heap: Wakeup[] = [];
  private segmentStartsNs: number[] = [];
  private marketRng!: Rng;

  /** Fair value in milli-ticks. Integer, walked by the market stream only. */
  private fairMilli = 0;
  private anchorMilli = 0;
  private lastWalkNs = 0;
  private segmentIndex = -1;
  private segmentDriftSign = 1;
  private nextClientOrdId = 1;
  private totalDurationNs = 0;

  arm(spec: ScenarioSpec): void {
    this.spec = spec;
    const seed = BigInt.asUintN(64, spec.seedHi * 0x9e3779b97f4a7c15n + spec.seedLo);
    this.marketRng = new Rng(seed);

    this.fairMilli = spec.openPrice * 1000;
    this.anchorMilli = this.fairMilli;
    this.lastWalkNs = 0;

    let acc = 0;
    this.segmentStartsNs = spec.timeline.map((s) => {
      const start = acc;
      acc += s.durationMs * NANOS_PER_MS;
      return start;
    });
    this.totalDurationNs = acc;

    // Agents get their own stream, derived from the scenario seed and their own
    // index. Never share a stream between agents — one agent's extra draw would
    // shift every later agent's variates.
    let agentId = 0;
    for (const cfg of spec.agents) {
      for (let c = 0; c < cfg.count; c++) {
        const sub = BigInt.asUintN(64, seed ^ (BigInt(agentId + 1) * 0xff51afd7ed558ccdn));
        const st: AgentState = {
          cfg,
          kind: cfg.kind,
          agentId,
          clientId: FIRST_AGENT_CLIENT_ID + agentId,
          rng: new Rng(sub),
          inventory: 0,
          quotes: [],
          lastRef: null,
          nonce: 0,
        };
        this.agents.push(st);
        // Stagger the first wakeup so the whole population does not fire at t=0.
        const first = st.rng.exponentialNanos(cfg.meanInterarrivalMs * NANOS_PER_MS);
        this.push({ t: first, agentId, nonce: st.nonce++ });
        agentId++;
      }
    }
  }

  /** Stable hash over the spec. Both engines compute it and must agree. */
  fingerprint(): bigint {
    const h = new Hasher();
    h.mix(this.spec.seedHi).mix(this.spec.seedLo).mix(this.spec.scenarioVersion);
    h.mix(this.spec.openPrice);
    for (const s of this.spec.timeline) h.mixString(s.regime).mix(s.durationMs).mix(s.intensity);
    for (const a of this.spec.agents) {
      h.mixString(a.kind).mix(a.count).mix(a.meanInterarrivalMs)
        .mix(a.sizeMin).mix(a.sizeMax).mix(a.spreadTicks ?? 0)
        .mix(a.aggressionBps ?? 0).mix(a.inventoryLimit ?? 0);
    }
    return h.value();
  }

  totalDraws(): number {
    return this.agents.reduce((a, s) => a + s.rng.drawCount(), this.marketRng.drawCount());
  }

  fairValueTicks(): number {
    return divRound(this.fairMilli, 1000);
  }

  regimeAt(tNs: number): Regime {
    return this.spec.timeline[this.segmentAt(tNs)]?.regime ?? 'Calm';
  }

  intensityAt(tNs: number): number {
    return this.spec.timeline[this.segmentAt(tNs)]?.intensity ?? 50;
  }

  durationNs(): number {
    return this.totalDurationNs;
  }

  /**
   * Seed the book before t=0 so the first frame a player sees is a real market
   * rather than an empty ladder. Uses the market stream, not agent streams, so
   * it costs the agents no draws.
   *
   * These orders are registered as normal MM quotes, which matters more than it
   * looks: an earlier version left them untracked, so nobody ever cancelled
   * them and every scenario carried a permanent wall of stale size at the
   * OPENING price for its entire duration. In a trending market that wall is
   * free money sitting in the middle of the chart, and it quietly broke every
   * drill built on the assumption that liquidity follows price.
   */
  seedBook(sink: EmitSink, depthLevels = 8): void {
    const mid = this.fairValueTicks();
    for (const agent of this.agents) {
      if (agent.kind !== 'MarketMaker') continue;
      const half = Math.max(1, agent.cfg.spreadTicks ?? 2);
      for (let i = 0; i < depthLevels; i++) {
        const off = half + i;
        const size = agent.cfg.sizeMin +
          this.marketRng.below(Math.max(1, agent.cfg.sizeMax - agent.cfg.sizeMin + 1));
        const decay = Math.max(1, Math.round(size * (1 - i / (depthLevels + 4))));
        for (const [side, price] of [[Side.Buy, mid - off], [Side.Sell, mid + off]] as const) {
          sink.newOrder({
            clientId: agent.clientId,
            clientOrdId: this.nextClientOrdId++,
            side, type: OrderType.Limit, tif: TimeInForce.GTC,
            price, qty: decay,
          });
        }
      }
    }
  }

  /**
   * Advance to `untilNs`, walking fair value and firing every agent wakeup at
   * or before it. `view` is read-only; every action goes through `sink`, i.e.
   * through the same command path a human uses, so agents are subject to
   * identical matching and margin rules.
   */
  advance(untilNs: number, view: MarketView, sink: EmitSink): void {
    this.walkFairValue(untilNs);
    let guard = 0;
    while (this.heap.length && this.heap[0].t <= untilNs) {
      if (++guard > 20000) break; // pathological config guard, never hit in practice
      const w = this.pop()!;
      const agent = this.agents[w.agentId];
      this.act(agent, w.t, view, sink);
      const next = w.t + agent.rng.exponentialNanos(agent.cfg.meanInterarrivalMs * NANOS_PER_MS);
      this.push({ t: next, agentId: agent.agentId, nonce: agent.nonce++ });
    }
  }

  /** Agents learn about their own fills; without this, MM inventory skew is inert. */
  notifyFill(clientId: number, side: Side, qty: number): void {
    const idx = clientId - FIRST_AGENT_CLIENT_ID;
    const agent = this.agents[idx];
    if (!agent) return;
    agent.inventory += side === Side.Buy ? qty : -qty;
  }

  /** A resting quote died; forget its id so the agent does not cancel a ghost. */
  notifyOrderDead(clientId: number, orderId: number): void {
    const agent = this.agents[clientId - FIRST_AGENT_CLIENT_ID];
    if (!agent) return;
    const i = agent.quotes.indexOf(orderId);
    if (i >= 0) agent.quotes.splice(i, 1);
  }

  notifyOrderId(clientId: number, orderId: number): void {
    const agent = this.agents[clientId - FIRST_AGENT_CLIENT_ID];
    if (agent) agent.quotes.push(orderId);
  }

  // -------------------------------------------------------------------------
  // Fair value
  // -------------------------------------------------------------------------
  private walkFairValue(untilNs: number): void {
    const stepNs = 50 * NANOS_PER_MS; // 20 Hz walk, independent of publish rate
    while (this.lastWalkNs < untilNs) {
      const t = Math.min(this.lastWalkNs + stepNs, untilNs);
      const dtNs = t - this.lastWalkNs;
      if (dtNs <= 0) break;
      const seg = this.segmentAt(t);
      if (seg !== this.segmentIndex) this.enterSegment(seg);

      const p = REGIMES[this.spec.timeline[seg]?.regime ?? 'Calm'];
      const intensity = this.spec.timeline[seg]?.intensity ?? 50;
      const scale = 50 + intensity; // 50..150 as a percentage-ish multiplier

      // Drift is linear in dt. Diffusion is not — it goes as sqrt(dt), which is
      // the whole reason the walk is stepped at a fixed 20 Hz rather than at
      // whatever interval the caller happens to ask for: a variable step would
      // make the realised volatility depend on the publish rate.
      const drift = divRound(
        p.driftMilliPerSec * this.segmentDriftSign * scale * dtNs,
        100 * 1_000_000_000,
      );
      const sqrtDt = Math.sqrt(dtNs / 1_000_000_000);
      const sigma = Math.max(1, Math.round((p.sigmaMilliPerSec * scale * sqrtDt) / 100));
      const shock = this.marketRng.gaussianTicks(sigma);
      const pull = divRound((this.anchorMilli - this.fairMilli) * p.reversionPerMille * dtNs,
                            1000 * 1_000_000_000);

      this.fairMilli += drift + shock + pull;
      // The anchor trails fair value slowly, so "mean reversion" reverts to a
      // moving level rather than dragging the whole match back to the open.
      this.anchorMilli += divRound((this.fairMilli - this.anchorMilli) * 40 * dtNs,
                                   1000 * 1_000_000_000);
      this.lastWalkNs = t;
    }
  }

  private enterSegment(seg: number): void {
    this.segmentIndex = seg;
    const regime = this.spec.timeline[seg]?.regime ?? 'Calm';
    // Trend direction is drawn once per segment, from the market stream.
    this.segmentDriftSign = regime === 'FlashCrash' || regime === 'LiquidityGap'
      ? 1 // their drift is already signed negative
      : this.marketRng.chanceBps(5000) ? 1 : -1;
    if (regime === 'Squeeze') this.segmentDriftSign = 1;
    if (regime === 'NewsSpike') {
      // An instantaneous repricing, which is the whole point of the regime:
      // resting orders get run over before anyone can react.
      const dir = this.marketRng.chanceBps(5000) ? 1 : -1;
      const jump = 25 + this.marketRng.below(60);
      this.fairMilli += dir * jump * 1000;
      this.anchorMilli = this.fairMilli;
    }
  }

  private segmentAt(tNs: number): number {
    let idx = 0;
    for (let i = 0; i < this.segmentStartsNs.length; i++) {
      if (tNs >= this.segmentStartsNs[i]) idx = i;
      else break;
    }
    return idx;
  }

  // -------------------------------------------------------------------------
  // Agent behaviour
  //
  // Every branch below draws its variates UP FRONT and unconditionally. Reading
  // the book to decide *how many* draws to take is the one thing that would
  // break lockstep, so the draws are hoisted above every `if`.
  // -------------------------------------------------------------------------
  private act(a: AgentState, tNs: number, view: MarketView, sink: EmitSink): void {
    const seg = this.segmentAt(tNs);
    const regime = this.spec.timeline[seg]?.regime ?? 'Calm';
    const p = REGIMES[regime];
    const intensity = this.spec.timeline[seg]?.intensity ?? 50;

    // Fixed draw block — 4 variates, every kind, every wakeup, no exceptions.
    const d0 = a.rng.below(10000);
    const d1 = a.rng.below(10000);
    const sizeRoll = a.rng.range(a.cfg.sizeMin, a.cfg.sizeMax);
    const jitter = a.rng.gaussianTicks(2);

    const fair = this.fairValueTicks();

    switch (a.kind) {
      case 'MarketMaker':
        this.actMarketMaker(a, p, fair, sizeRoll, jitter, sink);
        break;
      case 'NoiseTrader':
        this.actNoise(a, p, d0, d1, sizeRoll, view, sink);
        break;
      case 'Momentum':
        this.actMomentum(a, d0, sizeRoll, fair, view, sink);
        break;
      case 'MeanReversion':
        this.actMeanReversion(a, d0, sizeRoll, fair, view, sink);
        break;
      case 'Sweeper':
        this.actSweeper(a, d0, sizeRoll, intensity, view, sink);
        break;
      case 'IcebergWhale':
        this.actIceberg(a, d0, sizeRoll, fair, sink);
        break;
      case 'Spoofer':
        this.actSpoofer(a, d0, sizeRoll, fair, sink);
        break;
    }
  }

  private actMarketMaker(
    a: AgentState, p: RegimeParams, fair: number,
    size: number, jitter: number, sink: EmitSink,
  ): void {
    const base = Math.max(1, a.cfg.spreadTicks ?? 2);
    const half = Math.max(1, divRound(base * p.spreadX100, 100));
    const qty = Math.max(1, divRound(size * p.depthX100, 100));

    // Inventory skew. This is the mechanism by which a player leaning on one
    // side genuinely moves the market: fill the MM's bid repeatedly and its
    // inventory goes long, so it shifts both quotes down to get flat.
    //
    // The cap is half/2, not some large multiple, and that bound is doing real
    // work. Skew shifts BOTH quotes together, so with several MMs skewed in
    // opposite directions an uncapped skew has one MM's offer crossing below
    // another's bid. PostOnly then rejects whichever side would cross and the
    // aggregate spread collapses to a tick — in every regime, which erases the
    // "volatile markets quote wider" property the whole regime table exists for.
    const limit = Math.max(1, a.cfg.inventoryLimit ?? 200);
    const skewCap = Math.max(1, divRound(half, 2));
    const skew = Math.max(-skewCap, Math.min(skewCap, divRound(a.inventory * half * 2, limit)));

    // Pull the whole ladder, then repost. Cancels are free, stale quotes are
    // not — an MM that never requotes is just a pile of adverse selection.
    for (const id of a.quotes) sink.cancel(a.clientId, id);
    a.quotes = [];

    const overLong = a.inventory > limit;
    const overShort = a.inventory < -limit;

    for (let i = 0; i < MM_LADDER_DEPTH; i++) {
      // Size grows with distance: the top of book is the cheap advertisement,
      // the depth behind it is where the MM actually wants to trade.
      const levelQty = Math.max(1, qty + divRound(qty * i, 2));
      if (!overLong && p.oneSided !== Side.Sell) {
        sink.newOrder({
          clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
          side: Side.Buy, type: OrderType.Limit, tif: TimeInForce.PostOnly,
          price: fair - half - skew - i + Math.min(0, jitter), qty: levelQty,
        });
      }
      if (!overShort && p.oneSided !== Side.Buy) {
        sink.newOrder({
          clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
          side: Side.Sell, type: OrderType.Limit, tif: TimeInForce.PostOnly,
          price: fair + half - skew + i + Math.max(0, jitter), qty: levelQty,
        });
      }
    }
  }

  private actNoise(
    a: AgentState, p: RegimeParams, d0: number, d1: number,
    size: number, view: MarketView, sink: EmitSink,
  ): void {
    const side = d0 < 5000 ? Side.Buy : Side.Sell;
    const cross = d1 < (a.cfg.aggressionBps ?? 5500) + p.aggressionBps;
    if (cross) {
      sink.newOrder({
        clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
        side, type: OrderType.Market, tif: TimeInForce.IOC, price: 0, qty: size,
      });
    } else {
      const ref = side === Side.Buy ? view.bestBid() : view.bestAsk();
      if (ref === null) return;
      sink.newOrder({
        clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
        side, type: OrderType.Limit, tif: TimeInForce.GTC,
        price: ref, qty: size,
      });
    }
  }

  private actMomentum(
    a: AgentState, d0: number, size: number, fair: number,
    view: MarketView, sink: EmitSink,
  ): void {
    const ref = a.lastRef;
    a.lastRef = fair;
    if (ref === null) return;
    const move = fair - ref;
    if (move === 0) return;
    // Chases strength. This agent is why fading a trend hurts.
    const side = move > 0 ? Side.Buy : Side.Sell;
    const conviction = Math.min(10000, Math.abs(move) * 900);
    if (d0 >= conviction) return;
    sink.newOrder({
      clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
      side, type: OrderType.Market, tif: TimeInForce.IOC, price: 0, qty: size,
    });
  }

  private actMeanReversion(
    a: AgentState, d0: number, size: number, fair: number,
    view: MarketView, sink: EmitSink,
  ): void {
    const mark = view.mark();
    if (mark === null) return;
    const stretch = mark - fair;
    if (Math.abs(stretch) < 2) return;
    const side = stretch > 0 ? Side.Sell : Side.Buy;
    const conviction = Math.min(9000, Math.abs(stretch) * 700);
    if (d0 >= conviction) return;
    const px = side === Side.Buy ? view.bestBid() : view.bestAsk();
    if (px === null) return;
    sink.newOrder({
      clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
      side, type: OrderType.Limit, tif: TimeInForce.GTC, price: px, qty: size,
    });
  }

  private actSweeper(
    a: AgentState, d0: number, size: number, intensity: number,
    view: MarketView, sink: EmitSink,
  ): void {
    // Periodic aggressive sweeps — the source of adverse selection. If you are
    // resting size at the top of the book, this is what runs you over.
    if (d0 >= 2000 + intensity * 30) return;
    const side = d0 < 1000 + intensity * 15 ? Side.Buy : Side.Sell;
    sink.newOrder({
      clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
      side, type: OrderType.Market, tif: TimeInForce.IOC, price: 0, qty: size,
    });
  }

  private actIceberg(a: AgentState, d0: number, size: number, fair: number, sink: EmitSink): void {
    if (d0 >= 4000) return;
    const side = a.inventory <= 0 ? Side.Buy : Side.Sell;
    const px = side === Side.Buy ? fair - 1 : fair + 1;
    sink.newOrder({
      clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
      side, type: OrderType.Limit, tif: TimeInForce.GTC, price: px, qty: Math.max(1, size >> 2),
    });
  }

  private actSpoofer(a: AgentState, d0: number, size: number, fair: number, sink: EmitSink): void {
    // Layered size that gets pulled on approach. Present as a teaching tool:
    // the tape shows the size never trades.
    for (const id of a.quotes) sink.cancel(a.clientId, id);
    a.quotes = [];
    if (d0 >= 5000) return;
    const side = d0 < 2500 ? Side.Buy : Side.Sell;
    const px = side === Side.Buy ? fair - 3 : fair + 3;
    sink.newOrder({
      clientId: a.clientId, clientOrdId: this.nextClientOrdId++,
      side, type: OrderType.Limit, tif: TimeInForce.PostOnly, price: px, qty: size * 5,
    });
  }

  // -------------------------------------------------------------------------
  // Binary heap ordered by (t, agentId, nonce) — a TOTAL order. Leaving ties to
  // be broken by heap internals is how two "identical" runs stop being identical.
  // -------------------------------------------------------------------------
  private less(a: Wakeup, b: Wakeup): boolean {
    if (a.t !== b.t) return a.t < b.t;
    if (a.agentId !== b.agentId) return a.agentId < b.agentId;
    return a.nonce < b.nonce;
  }

  private push(w: Wakeup): void {
    const h = this.heap;
    h.push(w);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(h[i], h[parent])) {
        [h[i], h[parent]] = [h[parent], h[i]];
        i = parent;
      } else break;
    }
  }

  private pop(): Wakeup | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length === 0) return top;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;
      if (l < h.length && this.less(h[l], h[best])) best = l;
      if (r < h.length && this.less(h[r], h[best])) best = r;
      if (best === i) break;
      [h[i], h[best]] = [h[best], h[i]];
      i = best;
    }
    return top;
  }
}
