/**
 * backend/src/realtime/matchRoom.ts — one live match, solo or PvP.
 *
 * A room owns N engines, one per seat, all armed from the SAME ScenarioSpec.
 * They are stepped in lockstep from a single timer, so the two players' clocks
 * cannot drift apart even if one of them has a terrible connection: the market
 * advances on server time, and a laggy client loses reaction time, not fairness.
 *
 * Solo practice is the same machinery with one seat and no ELO. That is worth
 * doing precisely because it means practice and ranked share a code path — a
 * fill that behaves differently in practice than in ranked would make practice
 * worse than useless.
 */

import {
  Side, OrderType, TimeInForce, OrderStatus, RejectReason,
  type ServerMsg, type Candle, type MatchFrame, type SeatResult,
  type DrillSummary, type MatchMode, type OpponentView,
} from '../../../shared/src/protocol';
import { MatchEngine, type SimInstrument, MS } from '../sim/engine';
import type { ScenarioSpec } from '../sim/scenario';
import { divRound } from '../sim/orderBook';

export const FRAME_MS = 100; // 10 Hz to the browser
export const CANDLE_MS = 1000;
const HUMAN_CLIENT_ID = 1;
/** Per-seat command budget, matching RejectReason.RateLimited in the engine. */
const CMD_BUDGET_PER_SEC = 40;

export interface SeatSpec {
  userId: string;
  handle: string;
  elo: number;
  send: (msg: ServerMsg) => void;
}

export interface RoomOptions {
  matchId: string;
  mode: MatchMode;
  instrument: SimInstrument;
  scenario: ScenarioSpec;
  durationMs: number;
  startingCash: number;
  countdownMs: number;
  speed: number;
  drill?: DrillSummary;
  onEnd?: (room: MatchRoom) => void;
}

interface SeatRuntime {
  spec: SeatSpec;
  engine: MatchEngine;
  connected: boolean;
  candle: Candle | null;
  closedCandles: Candle[];
  allCandles: Candle[];
  equityCurve: { tMs: number; equity: number }[];
  cmdTokens: number;
  lastTokenRefill: number;
}

export class MatchRoom {
  readonly opts: RoomOptions;
  readonly seats: SeatRuntime[] = [];
  private timer: NodeJS.Timeout | null = null;
  private startedAtMs = 0;
  private frameSeq = 0;
  private ended = false;
  private results: SeatResult[] = [];

  constructor(opts: RoomOptions, seatSpecs: SeatSpec[]) {
    this.opts = opts;
    for (const s of seatSpecs) {
      const engine = new MatchEngine(opts.instrument, opts.scenario, [HUMAN_CLIENT_ID], opts.startingCash);
      engine.arm();
      this.seats.push({
        spec: s, engine, connected: true,
        candle: null, closedCandles: [], allCandles: [], equityCurve: [],
        cmdTokens: CMD_BUDGET_PER_SEC, lastTokenRefill: Date.now(),
      });
    }
  }

  get matchId(): string {
    return this.opts.matchId;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  seatOf(userId: string): number {
    return this.seats.findIndex((s) => s.spec.userId === userId);
  }

  /** Send the arm message to every seat, then count down and start. */
  arm(): void {
    this.seats.forEach((s, seat) => {
      const opponent = this.seats.find((_, i) => i !== seat);
      s.spec.send({
        t: 'match.arm',
        matchId: this.opts.matchId,
        mode: this.opts.mode,
        seat,
        instrument: {
          instrumentId: this.opts.instrument.instrumentId,
          symbol: this.opts.instrument.symbol,
          tickFloor: this.opts.instrument.tickFloor,
          numLevels: this.opts.instrument.numLevels,
          tickValueMicros: this.opts.instrument.tickValueMicros,
          lotSize: this.opts.instrument.lotSize,
          maxOrderQty: this.opts.instrument.maxOrderQty,
          marginBpsLong: this.opts.instrument.marginBpsLong,
          marginBpsShort: this.opts.instrument.marginBpsShort,
          allowShort: this.opts.instrument.allowShort,
          displayPrecision: this.opts.instrument.displayPrecision,
        },
        scenario: {
          id: this.opts.scenario.id,
          label: this.opts.scenario.label,
          difficulty: this.opts.scenario.difficulty,
          openPrice: this.opts.scenario.openPrice,
        },
        drill: this.opts.drill,
        durationMs: this.opts.durationMs,
        startingCash: this.opts.startingCash,
        countdownMs: this.opts.countdownMs,
        opponent: opponent ? { handle: opponent.spec.handle, elo: opponent.spec.elo } : undefined,
        frameIntervalMs: FRAME_MS,
      });
    });

    setTimeout(() => this.start(), this.opts.countdownMs);
  }

  private start(): void {
    if (this.ended) return;
    this.startedAtMs = Date.now();
    for (const s of this.seats) {
      s.engine.start();
      s.spec.send({ t: 'match.start', startedAtMs: this.startedAtMs });
    }
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  // -------------------------------------------------------------------------
  // The frame loop
  // -------------------------------------------------------------------------
  private tick(): void {
    if (this.ended) return;
    const wallElapsed = Date.now() - this.startedAtMs;
    const elapsed = Math.min(this.opts.durationMs, Math.round(wallElapsed * this.opts.speed));
    const remaining = Math.max(0, this.opts.durationMs - elapsed);
    this.frameSeq++;

    for (let seat = 0; seat < this.seats.length; seat++) {
      const s = this.seats[seat];
      s.engine.stepTo(elapsed * MS);

      const snap = s.engine.bookSnapshot(HUMAN_CLIENT_ID);
      const px = snap.lastTrade ?? snap.microPrice ?? this.opts.scenario.openPrice;
      this.updateCandles(s, elapsed, px, s.engine.drainPrints());

      const account = s.engine.accountState(HUMAN_CLIENT_ID);
      s.equityCurve.push({ tMs: elapsed, equity: account.equity });

      const frame: MatchFrame = {
        t: 'frame',
        seq: this.frameSeq,
        tMs: elapsed,
        remainingMs: remaining,
        book: snap,
        account,
        openOrders: s.engine.openOrders(HUMAN_CLIENT_ID),
        prints: this.lastPrints[seat] ?? [],
        candle: s.candle!,
        closedCandles: s.closedCandles,
        regime: s.engine.regime(),
        opponent: this.opponentViewFor(seat),
        equityPoint: { tMs: elapsed, equity: account.equity },
      };
      s.closedCandles = [];
      s.spec.send(frame);

      for (const fill of s.engine.drainFills(HUMAN_CLIENT_ID)) {
        s.spec.send({ t: 'fill', fill });
      }
    }

    if (remaining <= 0) this.end('completed');
  }

  private lastPrints: Record<number, ReturnType<MatchEngine['drainPrints']>> = {};

  private updateCandles(
    s: SeatRuntime, elapsed: number, price: number,
    prints: ReturnType<MatchEngine['drainPrints']>,
  ): void {
    const seat = this.seats.indexOf(s);
    // Only the most recent slice goes on the wire; the tape panel shows the
    // last few dozen prints and nobody scrolls back through 10,000 of them.
    this.lastPrints[seat] = prints.slice(-40);

    const bucket = Math.floor(elapsed / CANDLE_MS) * CANDLE_MS;
    const volume = prints.reduce((a, p) => a + p.qty, 0);

    if (!s.candle) {
      s.candle = { t: bucket, o: price, h: price, l: price, c: price, v: volume };
      return;
    }
    if (bucket !== s.candle.t) {
      s.closedCandles.push(s.candle);
      s.allCandles.push(s.candle);
      s.candle = { t: bucket, o: s.candle.c, h: price, l: price, c: price, v: volume };
      return;
    }
    s.candle.h = Math.max(s.candle.h, price);
    s.candle.l = Math.min(s.candle.l, price);
    s.candle.c = price;
    s.candle.v += volume;
  }

  /**
   * What seat A is told about seat B. Position and equity only — never their
   * open orders. Seeing an opponent's resting size would be a real edge, and in
   * mirrored books it would also be meaningless, since their orders are not in
   * your book to trade against.
   */
  private opponentViewFor(seat: number): OpponentView | undefined {
    if (this.seats.length < 2) return undefined;
    const other = this.seats[seat === 0 ? 1 : 0];
    const acct = other.engine.accountState(HUMAN_CLIENT_ID);
    const st = other.engine.stats(HUMAN_CLIENT_ID);
    return {
      handle: other.spec.handle,
      equity: acct.equity,
      pnl: acct.equity - st.startingCash,
      position: acct.position,
      fills: st.fills,
      connected: other.connected,
    };
  }

  // -------------------------------------------------------------------------
  // Commands from a seat
  // -------------------------------------------------------------------------
  submitOrder(
    userId: string, cid: number,
    req: { side: Side; type: OrderType; tif: TimeInForce; price: number; qty: number },
  ): void {
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    const s = this.seats[seat];
    if (!this.spendToken(s)) {
      s.spec.send({
        t: 'ack', cid, orderId: 0,
        status: OrderStatus.Rejected, reject: RejectReason.RateLimited,
        tsNs: s.engine.nowNanos(),
      });
      return;
    }
    const res = s.engine.submit(HUMAN_CLIENT_ID, { clientOrdId: cid, ...req });
    s.spec.send({
      t: 'ack', cid, orderId: res.orderId, status: res.status,
      reject: res.reject, tsNs: s.engine.nowNanos(),
    });
    for (const fill of s.engine.drainFills(HUMAN_CLIENT_ID)) s.spec.send({ t: 'fill', fill });
  }

  cancelOrder(userId: string, cid: number, orderId: number): void {
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    const s = this.seats[seat];
    if (!this.spendToken(s)) return;
    const res = s.engine.cancel(HUMAN_CLIENT_ID, orderId);
    s.spec.send({
      t: 'ack', cid, orderId: res.orderId, status: res.status,
      reject: res.reject, tsNs: s.engine.nowNanos(),
    });
  }

  cancelAll(userId: string, cid: number): void {
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    const s = this.seats[seat];
    s.engine.cancelAll(HUMAN_CLIENT_ID);
    s.spec.send({
      t: 'ack', cid, orderId: 0, status: OrderStatus.Cancelled,
      reject: RejectReason.None, tsNs: s.engine.nowNanos(),
    });
  }

  flatten(userId: string, cid: number): void {
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    const s = this.seats[seat];
    if (!this.spendToken(s)) return;
    const res = s.engine.flatten(HUMAN_CLIENT_ID);
    s.spec.send({
      t: 'ack', cid, orderId: res?.orderId ?? 0,
      status: res?.status ?? OrderStatus.Cancelled,
      reject: res?.reject ?? RejectReason.None, tsNs: s.engine.nowNanos(),
    });
    for (const fill of s.engine.drainFills(HUMAN_CLIENT_ID)) s.spec.send({ t: 'fill', fill });
  }

  setConnected(userId: string, connected: boolean): void {
    const seat = this.seatOf(userId);
    if (seat >= 0) this.seats[seat].connected = connected;
  }

  rebind(userId: string, send: (m: ServerMsg) => void): boolean {
    const seat = this.seatOf(userId);
    if (seat < 0) return false;
    this.seats[seat].spec.send = send;
    this.seats[seat].connected = true;
    return true;
  }

  private spendToken(s: SeatRuntime): boolean {
    const now = Date.now();
    const elapsed = now - s.lastTokenRefill;
    if (elapsed >= 1000) {
      s.cmdTokens = CMD_BUDGET_PER_SEC;
      s.lastTokenRefill = now;
    }
    if (s.cmdTokens <= 0) return false;
    s.cmdTokens--;
    return true;
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------
  end(reason: 'completed' | 'abandoned'): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    // Mark to market on the closing book. An open position at the bell is
    // settled at the mark, not force-liquidated: the player was in that risk
    // when time ran out and the score should say so.
    this.results = this.seats.map((s, seat) => {
      s.engine.finish();
      const acct = s.engine.accountState(HUMAN_CLIENT_ID);
      const st = s.engine.stats(HUMAN_CLIENT_ID);
      if (s.candle) {
        s.allCandles.push(s.candle);
        s.candle = null;
      }
      return {
        seat,
        userId: s.spec.userId,
        handle: s.spec.handle,
        startingCash: st.startingCash,
        finalEquity: acct.equity,
        realizedPnl: acct.realizedPnl,
        unrealizedPnl: acct.unrealizedPnl,
        fills: st.fills,
        makerFills: st.makerFills,
        volumeLots: st.volumeLots,
        maxDrawdown: st.maxDrawdown,
        peakEquity: st.peakEquity,
        eloBefore: s.spec.elo,
      } satisfies SeatResult;
    });

    if (this.seats.length === 2) this.scorePvp();

    const equityCurves = this.seats.map((s, seat) => ({
      seat,
      points: downsample(s.equityCurve, 240),
    }));

    this.seats.forEach((s, seat) => {
      s.spec.send({
        t: 'match.end',
        matchId: this.opts.matchId,
        mode: this.opts.mode,
        seats: this.results,
        yourSeat: seat,
        stateHash: s.engine.stateHash().toString(16),
        totalDraws: String(s.engine.totalDraws()),
        candles: s.allCandles,
        equityCurves,
        fills: s.engine.fillHistory(),
        drillResult: this.opts.drill ? this.scoreDrill(seat) : undefined,
      });
    });

    this.opts.onEnd?.(this);
  }

  getResults(): SeatResult[] {
    return this.results;
  }

  private scorePvp(): void {
    const [a, b] = this.results;
    const pnlA = a.finalEquity - a.startingCash;
    const pnlB = b.finalEquity - b.startingCash;
    // A tie band, not exact equality: two players who finish within a dollar of
    // each other over a five-minute match did not demonstrate a skill gap, and
    // an ELO swing decided by a rounding cent is noise dressed up as signal.
    const TIE_BAND = 1_000_000; // $1.00
    let scoreA: number;
    if (Math.abs(pnlA - pnlB) <= TIE_BAND) scoreA = 0.5;
    else scoreA = pnlA > pnlB ? 1 : 0;

    a.result = scoreA === 1 ? 'win' : scoreA === 0 ? 'loss' : 'draw';
    b.result = scoreA === 1 ? 'loss' : scoreA === 0 ? 'win' : 'draw';

    if (this.opts.mode === 'ranked_pvp') {
      const [ea, eb] = eloUpdate(a.eloBefore!, b.eloBefore!, scoreA);
      a.eloAfter = ea;
      b.eloAfter = eb;
    } else {
      a.eloAfter = a.eloBefore;
      b.eloAfter = b.eloBefore;
    }
  }

  private scoreDrill(seat: number) {
    const drill = this.opts.drill!;
    const r = this.results[seat];
    const st = this.seats[seat].engine.stats(HUMAN_CLIENT_ID);
    const pnl = r.finalEquity - r.startingCash;

    const objectives = drill.objectives.map((o) => {
      let value: number;
      let met: boolean;
      switch (o.kind) {
        case 'min_pnl':
          value = pnl; met = pnl >= o.target; break;
        case 'max_drawdown':
          value = st.maxDrawdown; met = st.maxDrawdown <= o.target; break;
        case 'min_maker_ratio_bps':
          value = st.fills > 0 ? divRound(st.makerFills * 10000, st.fills) : 0;
          met = value >= o.target; break;
        case 'min_fills':
          value = st.fills; met = st.fills >= o.target; break;
        case 'max_position':
          value = st.maxAbsPosition; met = st.maxAbsPosition <= o.target; break;
      }
      return { id: o.id, label: o.label, met, value, target: o.target };
    });

    // Stars come from PnL thresholds, but only if every objective cleared. A
    // drill you passed on PnL while ignoring what it was teaching is not a pass.
    const allMet = objectives.every((o) => o.met);
    let stars = 0;
    if (allMet) {
      for (const threshold of drill.starThresholds) if (pnl >= threshold) stars++;
    }
    const xpAwarded = allMet ? drill.xpReward + stars * divRound(drill.xpReward, 4) : divRound(drill.xpReward, 5);

    return { stars, xpAwarded, objectives, newBest: false };
  }
}

/**
 * ELO with a provisional K-factor. Plain K=32 moves a new player far too slowly
 * to reach their true rating; the decay over the first ~20 matches is the single
 * biggest matchmaking-quality win available for the effort.
 */
export function eloUpdate(ra: number, rb: number, scoreA: number, gamesA = 30, gamesB = 30): [number, number] {
  const ka = gamesA < 20 ? 64 : gamesA < 50 ? 32 : 20;
  const kb = gamesB < 20 ? 64 : gamesB < 50 ? 32 : 20;
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const eb = 1 - ea;
  return [
    Math.round(ra + ka * (scoreA - ea)),
    Math.round(rb + kb * (1 - scoreA - eb)),
  ];
}

/** Keep the shape, drop the points. The end screen chart is ~600px wide. */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}
