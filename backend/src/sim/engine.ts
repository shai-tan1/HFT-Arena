/**
 * backend/src/sim/engine.ts — the matching engine + risk system.
 *
 * ===========================================================================
 * ONE ENGINE PER SEAT. THIS IS THE LOAD-BEARING DECISION.
 * ===========================================================================
 * A PvP match runs TWO MatchEngine instances, seeded identically, not one
 * shared book. Each player is alone in their own copy of the market with the
 * same synthetic order flow. Every property the product needs falls out of it:
 *
 *   - Fairness. Neither player can be front-run by the other, and neither one's
 *     ping advantage translates into queue position against the other.
 *   - Replay. A seat's entire session is (seed, config, that seat's commands).
 *   - Grading. Post-hoc "what should you have done" is answerable because the
 *     counterfactual market is reproducible.
 *   - Anti-cheat. Two engines fed the same seed must end with equal PRNG draw
 *     counts. A divergence is a hard signal that something is wrong.
 *
 * The cost is that players do not trade against each other, only against the
 * same market. That is the right trade for a skill game: PvP here means "same
 * conditions, better execution wins", which is what a chess clock is too.
 *
 * ===========================================================================
 * NO FLOATING POINT ON THE MONEY PATH
 * ===========================================================================
 * Prices are ticks, sizes are lots, cash is micros. Division goes through
 * divRound() so it rounds half away from zero rather than truncating toward it.
 * The one time this was violated in the C++ skeleton, truncation in the
 * micro-price calculation manufactured a 1.2% downtrend out of pure rounding.
 */

import {
  Side, OrderType, TimeInForce, OrderStatus, RejectReason, TradeGrade,
  type AccountState, type OpenOrder, type TradePrint, type FillEvent,
} from '../../../shared/src/protocol';
import { OrderBook, divRound, type RestingOrder } from './orderBook';
import { ScenarioGenerator, type ScenarioSpec, type EmitSink, type SynthNewOrder, FIRST_AGENT_CLIENT_ID } from './scenario';
import { Hasher } from './rng';

export interface SimInstrument {
  instrumentId: number;
  symbol: string;
  tickFloor: number;
  numLevels: number;
  tickValueMicros: number;
  lotSize: number;
  maxOrderQty: number;
  marginBpsLong: number;
  marginBpsShort: number;
  allowShort: boolean;
  displayPrecision: number;
  /** Cost to remove liquidity, bps of notional. */
  feeBpsTaker: number;
  /** Negative is a rebate. This is what makes passive quoting a real strategy. */
  feeBpsMaker: number;
}

export interface NewOrderRequest {
  clientOrdId: number;
  side: Side;
  type: OrderType;
  tif: TimeInForce;
  price: number;
  qty: number;
}

export interface SubmitResult {
  orderId: number;
  status: OrderStatus;
  reject: RejectReason;
}

interface OrderMeta {
  marginHeld: number;
  originalQty: number;
}

class Account {
  cash: number;
  startingCash = 0;
  position = 0;
  avgEntryMicros = 0; // per lot, micros
  realizedPnl = 0;
  feesPaid = 0;
  openOrderMargin = 0;
  positionMargin = 0;
  restingLots: [number, number] = [0, 0]; // [buy, sell]
  fills = 0;
  makerFills = 0;
  volumeLots = 0;
  peakEquity = 0;
  maxDrawdown = 0;
  maxAbsPosition = 0;

  constructor(startingCash: number) {
    this.cash = startingCash;
    this.startingCash = startingCash;
    this.peakEquity = startingCash;
  }
}

const NANOS_PER_MS = 1_000_000;

export class MatchEngine {
  readonly instrument: SimInstrument;
  readonly spec: ScenarioSpec;
  private book = new OrderBook();
  private gen = new ScenarioGenerator();
  private accounts = new Map<number, Account>();
  private orderMeta = new Map<number, OrderMeta>();
  private nextOrderId = 1;
  private seq = 0;
  private nowNs = 0;
  private running = false;

  private prints: TradePrint[] = [];
  private fillsByClient = new Map<number, FillEvent[]>();
  /** Every fill for the human seat, kept for the post-match review screen. */
  private fillLog: FillEvent[] = [];

  /** Deferred synthetic commands — agents emit while we are mid-match loop. */
  private pendingSynth: SynthNewOrder[] = [];
  private pendingCancels: { clientId: number; orderId: number }[] = [];

  constructor(instrument: SimInstrument, spec: ScenarioSpec, humanClientIds: number[], startingCash: number) {
    this.instrument = instrument;
    this.spec = spec;
    for (const id of humanClientIds) this.accounts.set(id, new Account(startingCash));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  arm(): void {
    this.gen.arm(this.spec);
    // Agent accounts get effectively unlimited capital. They are scenery, not
    // competitors, and a market maker that goes bust mid-match would silently
    // change the difficulty of a scenario that is supposed to be fixed.
    this.gen.seedBook(this.sink());
    this.drainPending();
    this.running = true;
  }

  start(): void {
    this.running = true;
  }

  finish(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  nowNanos(): number {
    return this.nowNs;
  }

  fairValue(): number {
    return this.gen.fairValueTicks();
  }

  regime() {
    return this.gen.regimeAt(this.nowNs);
  }

  /** Advance logical time. All market evolution happens here and nowhere else. */
  stepTo(tNs: number): void {
    if (tNs <= this.nowNs) return;
    this.nowNs = tNs;
    this.gen.advance(tNs, this.book, this.sink());
    this.drainPending();
    this.markToMarket();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  submit(clientId: number, req: NewOrderRequest): SubmitResult {
    const acct = this.accounts.get(clientId);
    const isAgent = clientId >= FIRST_AGENT_CLIENT_ID;
    if (!this.running) return this.rejected(RejectReason.EngineNotRunning);
    if (!acct && !isAgent) return this.rejected(RejectReason.NotOrderOwner);

    const inst = this.instrument;
    if (req.qty <= 0 || req.qty % inst.lotSize !== 0) return this.rejected(RejectReason.QtyInvalid);
    if (req.qty > inst.maxOrderQty) return this.rejected(RejectReason.QtyAboveLimit);

    const isMarket = req.type === OrderType.Market;
    if (!isMarket) {
      if (!Number.isInteger(req.price)) return this.rejected(RejectReason.PriceNotOnTick);
      if (req.price < inst.tickFloor || req.price > inst.tickFloor + inst.numLevels - 1) {
        return this.rejected(RejectReason.PriceOutOfBand);
      }
    }

    if (acct && !inst.allowShort) {
      const after = acct.position + (req.side === Side.Buy ? req.qty : -req.qty);
      if (after < 0) return this.rejected(RejectReason.ShortNotPermitted);
    }

    const limit = isMarket ? null : req.price;

    // Post-only never takes. Reject rather than reprice: a silent reprice is a
    // worse surprise than a rejection you can see in the order log.
    if (req.tif === TimeInForce.PostOnly) {
      const opposite = req.side === Side.Buy ? this.book.bestAsk() : this.book.bestBid();
      if (opposite !== null && limit !== null) {
        const crosses = req.side === Side.Buy ? limit >= opposite : limit <= opposite;
        if (crosses) return this.rejected(RejectReason.PostOnlyWouldCross);
      }
    }

    // FOK is all-or-nothing and must be decided before anything mutates.
    if (req.tif === TimeInForce.FOK) {
      const avail = this.book.availableFor(req.side, limit, clientId);
      if (avail < req.qty) return this.rejected(RejectReason.FokUnfillable);
    }

    // Margin. Only the part of the order that OPENS exposure needs capital;
    // an order that closes an existing position frees capital rather than
    // consuming it, and charging for it would make flattening impossible for
    // a player who is close to their limit — precisely when they need it most.
    let marginHeld = 0;
    if (acct) {
      const reducible = this.reducibleLots(acct, req.side);
      const openingQty = Math.max(0, req.qty - Math.min(req.qty, reducible));
      if (openingQty > 0) {
        const refPrice = limit ?? this.book.mark() ?? this.spec.openPrice;
        marginHeld = this.marginFor(req.side, refPrice, openingQty);
        const available = this.equityOf(acct) - acct.openOrderMargin - acct.positionMargin;
        if (marginHeld > available) return this.rejected(RejectReason.InsufficientMargin);
      }
    }

    const orderId = this.nextOrderId++;

    // Self-trade prevention: cancel the resting side. Cancel-newest would let a
    // player hold queue position by repeatedly self-crossing.
    for (const own of this.book.ownedAtOrBetter(req.side, limit, clientId)) {
      this.killOrder(own.id);
    }

    const steps = this.book.planTake(req.side, limit, req.qty, clientId);
    let filled = 0;
    for (const step of steps) {
      const dead = this.book.applyFill(step);
      this.book.recordTrade(step.price);
      this.onFill(clientId, orderId, req.clientOrdId, req.side, step.price, step.qty, false,
                  req.qty - filled - step.qty);
      // The resting side gets a maker fill at its own price.
      const resting = step.restingOrder;
      this.onFill(resting.clientId, resting.id, resting.clientOrdId, resting.side,
                  step.price, step.qty, true, resting.leaves);
      this.releaseOrderMargin(resting.id, step.qty);
      if (dead) {
        this.orderMeta.delete(resting.id);
        this.gen.notifyOrderDead(resting.clientId, resting.id);
      }
      this.prints.push({
        seq: ++this.seq, tsNs: this.nowNs, price: step.price, qty: step.qty, aggressor: req.side,
      });
      filled += step.qty;
    }

    const leaves = req.qty - filled;
    const restsOnBook = leaves > 0 && !isMarket &&
      req.tif !== TimeInForce.IOC && req.tif !== TimeInForce.FOK;

    if (restsOnBook) {
      const resting: RestingOrder = {
        id: orderId, clientOrdId: req.clientOrdId, clientId,
        side: req.side, price: req.price, qty: req.qty, leaves,
        tsNs: this.nowNs, seq: ++this.seq,
      };
      this.book.rest(resting);
      if (acct) {
        // Hold margin only against the unfilled remainder.
        const held = req.qty > 0 ? divRound(marginHeld * leaves, req.qty) : 0;
        acct.openOrderMargin += held;
        acct.restingLots[req.side] += leaves;
        this.orderMeta.set(orderId, { marginHeld: held, originalQty: leaves });
      } else {
        this.orderMeta.set(orderId, { marginHeld: 0, originalQty: leaves });
      }
      if (clientId >= FIRST_AGENT_CLIENT_ID) this.gen.notifyOrderId(clientId, orderId);
    }

    this.markToMarket();

    const status = filled === 0
      ? (restsOnBook ? OrderStatus.New : OrderStatus.Cancelled)
      : leaves === 0
        ? OrderStatus.Filled
        : (restsOnBook ? OrderStatus.PartiallyFilled : OrderStatus.Filled);

    return { orderId, status, reject: RejectReason.None };
  }

  cancel(clientId: number, orderId: number): SubmitResult {
    const o = this.book.getOrder(orderId);
    if (!o) return { orderId, status: OrderStatus.Rejected, reject: RejectReason.UnknownOrder };
    if (o.clientId !== clientId) {
      return { orderId, status: OrderStatus.Rejected, reject: RejectReason.NotOrderOwner };
    }
    this.killOrder(orderId);
    return { orderId, status: OrderStatus.Cancelled, reject: RejectReason.None };
  }

  cancelAll(clientId: number): number {
    const ids = this.book.ordersOf(clientId).map((o) => o.id);
    for (const id of ids) this.killOrder(id);
    return ids.length;
  }

  /** Cancel everything and cross out of the position with one IOC market order. */
  flatten(clientId: number): SubmitResult | null {
    const acct = this.accounts.get(clientId);
    if (!acct) return null;
    this.cancelAll(clientId);
    if (acct.position === 0) return null;
    const side = acct.position > 0 ? Side.Sell : Side.Buy;
    return this.submit(clientId, {
      clientOrdId: 0, side, type: OrderType.Market, tif: TimeInForce.IOC,
      price: 0, qty: Math.abs(acct.position),
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  bookSnapshot(viewerId: number, depth = 12) {
    return {
      bids: this.book.depth(Side.Buy, depth, viewerId),
      asks: this.book.depth(Side.Sell, depth, viewerId),
      bestBid: this.book.bestBid(),
      bestAsk: this.book.bestAsk(),
      lastTrade: this.book.last(),
      microPrice: this.book.microPrice(),
    };
  }

  accountState(clientId: number): AccountState {
    const a = this.accounts.get(clientId)!;
    const unrealized = this.unrealizedOf(a);
    const equity = a.cash + unrealized;
    const reserved = a.openOrderMargin + a.positionMargin;
    const free = Math.max(0, equity - reserved);
    return {
      cash: a.cash,
      reservedMargin: reserved,
      position: a.position,
      avgEntryMicros: a.avgEntryMicros,
      realizedPnl: a.realizedPnl - a.feesPaid,
      unrealizedPnl: unrealized,
      equity,
      buyingPower: divRound(free * 10000, this.instrument.marginBpsLong),
    };
  }

  openOrders(clientId: number): OpenOrder[] {
    return this.book.ordersOf(clientId).map((o) => ({
      orderId: o.id,
      clientOrdId: o.clientOrdId,
      side: o.side,
      type: OrderType.Limit,
      tif: TimeInForce.GTC,
      price: o.price,
      qty: o.qty,
      leaves: o.leaves,
      status: o.leaves === o.qty ? OrderStatus.New : OrderStatus.PartiallyFilled,
      tsNs: o.tsNs,
    }));
  }

  stats(clientId: number) {
    const a = this.accounts.get(clientId)!;
    return {
      fills: a.fills,
      makerFills: a.makerFills,
      volumeLots: a.volumeLots,
      peakEquity: a.peakEquity,
      maxDrawdown: a.maxDrawdown,
      maxAbsPosition: a.maxAbsPosition,
      startingCash: a.startingCash,
      feesPaid: a.feesPaid,
    };
  }

  drainPrints(): TradePrint[] {
    const out = this.prints;
    this.prints = [];
    return out;
  }

  drainFills(clientId: number): FillEvent[] {
    const out = this.fillsByClient.get(clientId) ?? [];
    this.fillsByClient.set(clientId, []);
    return out;
  }

  fillHistory(): FillEvent[] {
    return this.fillLog;
  }

  /**
   * State hash. The two mirrored engines of a PvP match will NOT agree on this
   * (their books differ, which is the point), but a seat replayed from the same
   * seed and the same command log must reproduce it exactly. That is the check
   * that makes a disputed match resolvable.
   */
  stateHash(): bigint {
    const h = new Hasher();
    h.mix(this.nowNs).mix(this.seq).mix(this.book.fingerprint());
    h.mix(this.gen.totalDraws()).mix(this.gen.fairValueTicks());
    for (const [id, a] of [...this.accounts.entries()].sort((x, y) => x[0] - y[0])) {
      h.mix(id).mix(a.cash).mix(a.position).mix(a.realizedPnl).mix(a.avgEntryMicros);
    }
    return h.value();
  }

  totalDraws(): number {
    return this.gen.totalDraws();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------
  private sink(): EmitSink {
    return {
      newOrder: (o) => this.pendingSynth.push(o),
      cancel: (clientId, orderId) => this.pendingCancels.push({ clientId, orderId }),
    };
  }

  /**
   * Agents emit into a queue rather than recursing into submit(), because an
   * agent's order can fill another agent's resting order, which notifies the
   * generator, which could emit again. A queue makes the ordering explicit and
   * — critically — identical in both mirrored engines.
   */
  private drainPending(): void {
    let guard = 0;
    while ((this.pendingCancels.length || this.pendingSynth.length) && guard++ < 5000) {
      const cancels = this.pendingCancels;
      this.pendingCancels = [];
      for (const c of cancels) {
        const o = this.book.getOrder(c.orderId);
        if (o && o.clientId === c.clientId) this.killOrder(c.orderId);
      }
      const news = this.pendingSynth;
      this.pendingSynth = [];
      for (const o of news) {
        this.submit(o.clientId, {
          clientOrdId: o.clientOrdId, side: o.side, type: o.type,
          tif: o.tif, price: o.price, qty: o.qty,
        });
      }
    }
  }

  private killOrder(orderId: number): void {
    const o = this.book.getOrder(orderId);
    if (!o) return;
    const leaves = o.leaves;
    const acct = this.accounts.get(o.clientId);
    this.book.cancel(orderId);
    if (acct) {
      acct.restingLots[o.side] = Math.max(0, acct.restingLots[o.side] - leaves);
      const meta = this.orderMeta.get(orderId);
      if (meta) acct.openOrderMargin = Math.max(0, acct.openOrderMargin - meta.marginHeld);
    }
    this.orderMeta.delete(orderId);
    this.gen.notifyOrderDead(o.clientId, orderId);
  }

  private releaseOrderMargin(orderId: number, filledQty: number): void {
    const meta = this.orderMeta.get(orderId);
    if (!meta || meta.originalQty <= 0) return;
    const o = this.book.getOrder(orderId);
    const acct = o ? this.accounts.get(o.clientId) : undefined;
    const release = divRound(meta.marginHeld * filledQty, meta.originalQty);
    if (acct) {
      acct.openOrderMargin = Math.max(0, acct.openOrderMargin - release);
      if (o) acct.restingLots[o.side] = Math.max(0, acct.restingLots[o.side] - filledQty);
    }
    meta.marginHeld = Math.max(0, meta.marginHeld - release);
    meta.originalQty = Math.max(0, meta.originalQty - filledQty);
  }

  private onFill(
    clientId: number, orderId: number, clientOrdId: number, side: Side,
    priceTicks: number, qty: number, isMaker: boolean, leaves: number,
  ): void {
    if (clientId >= FIRST_AGENT_CLIENT_ID) {
      this.gen.notifyFill(clientId, side, qty);
      return;
    }
    const a = this.accounts.get(clientId);
    if (!a) return;

    const priceMicros = priceTicks * this.instrument.tickValueMicros;
    const notional = priceMicros * qty;
    const feeBps = isMaker ? this.instrument.feeBpsMaker : this.instrument.feeBpsTaker;
    const fee = divRound(notional * feeBps, 10000);

    const signed = side === Side.Buy ? qty : -qty;
    let realizedDelta = 0;

    if (a.position === 0 || Math.sign(a.position) === Math.sign(signed)) {
      // Opening or adding. Weighted-average the entry.
      const total = Math.abs(a.position) + qty;
      a.avgEntryMicros = divRound(Math.abs(a.position) * a.avgEntryMicros + qty * priceMicros, total);
      a.position += signed;
    } else {
      const closing = Math.min(Math.abs(a.position), qty);
      const dir = a.position > 0 ? 1 : -1;
      realizedDelta = (priceMicros - a.avgEntryMicros) * closing * dir;
      a.realizedPnl += realizedDelta;
      a.position += signed;
      if (a.position === 0) {
        a.avgEntryMicros = 0;
      } else if (Math.sign(a.position) !== dir) {
        // Flipped through flat — the remainder opens a new position here.
        a.avgEntryMicros = priceMicros;
      }
    }

    a.feesPaid += fee;
    a.cash = a.startingCash + a.realizedPnl - a.feesPaid;
    a.fills += 1;
    if (isMaker) a.makerFills += 1;
    a.volumeLots += qty;
    a.maxAbsPosition = Math.max(a.maxAbsPosition, Math.abs(a.position));

    const ev: FillEvent = {
      seq: ++this.seq, tsNs: this.nowNs, orderId, clientOrdId, side,
      price: priceTicks, qty, leaves, isMaker,
      grade: TradeGrade.Ungraded, realizedDelta: realizedDelta - fee,
    };
    const list = this.fillsByClient.get(clientId) ?? [];
    list.push(ev);
    this.fillsByClient.set(clientId, list);
    this.fillLog.push(ev);
  }

  /**
   * Recompute position margin and the drawdown watermark.
   *
   * The C++ skeleton releases margin entirely on fill and never re-charges for
   * the resulting open position — flagged in skeleton/README.md as a known gap.
   * This is the corrected behaviour: margin follows the position, marked to the
   * current price, for as long as the position is open.
   */
  private markToMarket(): void {
    const mark = this.book.mark() ?? this.spec.openPrice;
    for (const a of this.accounts.values()) {
      const bps = a.position >= 0 ? this.instrument.marginBpsLong : this.instrument.marginBpsShort;
      a.positionMargin = this.marginRaw(Math.abs(a.position), mark, bps);
      const equity = a.cash + this.unrealizedOf(a, mark);
      if (equity > a.peakEquity) a.peakEquity = equity;
      const dd = a.peakEquity - equity;
      if (dd > a.maxDrawdown) a.maxDrawdown = dd;
    }
  }

  private unrealizedOf(a: Account, markTicks?: number): number {
    if (a.position === 0) return 0;
    const mark = markTicks ?? this.book.mark() ?? this.spec.openPrice;
    const markMicros = mark * this.instrument.tickValueMicros;
    return (markMicros - a.avgEntryMicros) * a.position;
  }

  private equityOf(a: Account): number {
    return a.cash + this.unrealizedOf(a);
  }

  private reducibleLots(a: Account, side: Side): number {
    // Lots this order could close, net of orders already queued to close them.
    const exposure = side === Side.Buy ? Math.max(0, -a.position) : Math.max(0, a.position);
    return Math.max(0, exposure - a.restingLots[side]);
  }

  private marginFor(side: Side, priceTicks: number, qty: number): number {
    const bps = side === Side.Buy ? this.instrument.marginBpsLong : this.instrument.marginBpsShort;
    return this.marginRaw(qty, priceTicks, bps);
  }

  private marginRaw(qty: number, priceTicks: number, bps: number): number {
    if (qty <= 0) return 0;
    return divRound(priceTicks * this.instrument.tickValueMicros * qty * bps, 10000);
  }

  private rejected(reason: RejectReason): SubmitResult {
    return { orderId: 0, status: OrderStatus.Rejected, reject: reason };
  }
}

export const MS = NANOS_PER_MS;
