/**
 * backend/src/sim/orderBook.ts — price-time priority limit order book.
 *
 * Structurally simpler than engine/include/hfta/order_book.h, and deliberately
 * so. The C++ book uses a flat level array with occupancy bitmaps because it is
 * chasing sub-microsecond best-bid lookup. This one uses a Map plus a sorted
 * price array because it is chasing *readability* — it exists to be an
 * unambiguous reference for what the matching rules mean, and to run a match at
 * 20 Hz, which it does with several orders of magnitude to spare.
 *
 * The two MUST agree on semantics, which is why the ordering rules are spelled
 * out rather than implied:
 *   - Better price always fills first.
 *   - Within a price level, earlier arrival fills first (strict FIFO).
 *   - A fill prints at the RESTING order's price, so price improvement accrues
 *     to the aggressor, exactly as it does on a real exchange.
 *   - Ties in agent wakeup order are broken by (time, agent_id, nonce), never
 *     by container iteration order.
 */

import { Side } from '../../../shared/src/protocol';

export interface RestingOrder {
  id: number;
  clientOrdId: number;
  clientId: number;
  side: Side;
  price: number; // ticks
  qty: number; // original lots
  leaves: number; // remaining lots
  tsNs: number;
  seq: number; // arrival sequence — the tiebreaker inside a level
}

interface Level {
  price: number;
  totalQty: number;
  /** FIFO. `head` avoids O(n) shift on every fill at a busy level. */
  queue: RestingOrder[];
  head: number;
}

export interface MatchStep {
  restingOrder: RestingOrder;
  price: number;
  qty: number;
}

export class OrderBook {
  private bids = new Map<number, Level>();
  private asks = new Map<number, Level>();
  /** Sorted price keys: bids descending, asks ascending. */
  private bidPrices: number[] = [];
  private askPrices: number[] = [];
  private byId = new Map<number, RestingOrder>();
  private lastTradePrice: number | null = null;

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------
  bestBid(): number | null {
    return this.bidPrices.length ? this.bidPrices[0] : null;
  }

  bestAsk(): number | null {
    return this.askPrices.length ? this.askPrices[0] : null;
  }

  last(): number | null {
    return this.lastTradePrice;
  }

  qtyAt(side: Side, price: number): number {
    const lvl = (side === Side.Buy ? this.bids : this.asks).get(price);
    return lvl ? lvl.totalQty : 0;
  }

  getOrder(id: number): RestingOrder | undefined {
    return this.byId.get(id);
  }

  ordersOf(clientId: number): RestingOrder[] {
    const out: RestingOrder[] = [];
    for (const o of this.byId.values()) if (o.clientId === clientId && o.leaves > 0) out.push(o);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * Size-weighted micro price in ticks, rounded to NEAREST.
   *
   * This rounding is not a detail. The C++ skeleton originally truncated toward
   * zero here and the bias compounded into a phantom ~1.2% downtrend over ten
   * seconds of simulated time — a bug that looked exactly like a market regime.
   * Round-half-away-from-zero, in every place a price is divided.
   */
  microPrice(): number | null {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (bb === null || ba === null) return this.lastTradePrice;
    const bq = this.qtyAt(Side.Buy, bb);
    const aq = this.qtyAt(Side.Sell, ba);
    const denom = bq + aq;
    if (denom === 0) return divRound(bb + ba, 2);
    return divRound(bb * aq + ba * bq, denom);
  }

  /** Mid, or the last print if the book is one-sided. */
  mark(): number | null {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (bb !== null && ba !== null) return divRound(bb + ba, 2);
    return this.lastTradePrice ?? bb ?? ba;
  }

  /** Top `depth` levels a side, aggregated, with the viewer's own size split out. */
  depth(side: Side, depth: number, viewerId?: number) {
    const prices = side === Side.Buy ? this.bidPrices : this.askPrices;
    const map = side === Side.Buy ? this.bids : this.asks;
    const out = [];
    for (let i = 0; i < Math.min(depth, prices.length); i++) {
      const lvl = map.get(prices[i])!;
      let mine = 0;
      if (viewerId !== undefined) {
        for (let j = lvl.head; j < lvl.queue.length; j++) {
          const o = lvl.queue[j];
          if (o.clientId === viewerId) mine += o.leaves;
        }
      }
      out.push({
        price: lvl.price,
        qty: lvl.totalQty,
        orders: lvl.queue.length - lvl.head,
        mine,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /**
   * Walk the opposite side and produce the fill steps an aggressor would get.
   * DOES NOT mutate — the engine decides whether to commit, which is what makes
   * FOK ("all or nothing") expressible without a rollback path.
   */
  planTake(side: Side, limitPrice: number | null, qty: number, aggressorId: number): MatchStep[] {
    const prices = side === Side.Buy ? this.askPrices : this.bidPrices;
    const map = side === Side.Buy ? this.asks : this.bids;
    const steps: MatchStep[] = [];
    let remaining = qty;

    for (const price of prices) {
      if (remaining <= 0) break;
      if (limitPrice !== null) {
        if (side === Side.Buy && price > limitPrice) break;
        if (side === Side.Sell && price < limitPrice) break;
      }
      const lvl = map.get(price)!;
      for (let i = lvl.head; i < lvl.queue.length && remaining > 0; i++) {
        const resting = lvl.queue[i];
        if (resting.leaves <= 0) continue;
        // Self-trade prevention: skip in the plan, cancel at commit time.
        if (resting.clientId === aggressorId) continue;
        const take = Math.min(remaining, resting.leaves);
        steps.push({ restingOrder: resting, price, qty: take });
        remaining -= take;
      }
    }
    return steps;
  }

  /** Total lots available to an aggressor at or better than `limitPrice`. */
  availableFor(side: Side, limitPrice: number | null, aggressorId: number): number {
    return this.planTake(side, limitPrice, Number.MAX_SAFE_INTEGER, aggressorId)
      .reduce((a, s) => a + s.qty, 0);
  }

  /** Commit one planned step. Returns true when the resting order is now dead. */
  applyFill(step: MatchStep): boolean {
    const o = step.restingOrder;
    o.leaves -= step.qty;
    const map = o.side === Side.Buy ? this.bids : this.asks;
    const lvl = map.get(o.price);
    if (lvl) {
      lvl.totalQty -= step.qty;
      if (o.leaves <= 0) this.compact(lvl);
      if (lvl.totalQty <= 0 || lvl.queue.length - lvl.head === 0) this.dropLevel(o.side, o.price);
    }
    if (o.leaves <= 0) {
      this.byId.delete(o.id);
      return true;
    }
    return false;
  }

  /** Orders resting at `price` on `side` owned by `clientId` — used by STP. */
  ownedAtOrBetter(side: Side, limitPrice: number | null, clientId: number): RestingOrder[] {
    const prices = side === Side.Buy ? this.askPrices : this.bidPrices;
    const map = side === Side.Buy ? this.asks : this.bids;
    const out: RestingOrder[] = [];
    for (const price of prices) {
      if (limitPrice !== null) {
        if (side === Side.Buy && price > limitPrice) break;
        if (side === Side.Sell && price < limitPrice) break;
      }
      const lvl = map.get(price)!;
      for (let i = lvl.head; i < lvl.queue.length; i++) {
        if (lvl.queue[i].clientId === clientId && lvl.queue[i].leaves > 0) out.push(lvl.queue[i]);
      }
    }
    return out;
  }

  recordTrade(price: number): void {
    this.lastTradePrice = price;
  }

  rest(order: RestingOrder): void {
    const map = order.side === Side.Buy ? this.bids : this.asks;
    let lvl = map.get(order.price);
    if (!lvl) {
      lvl = { price: order.price, totalQty: 0, queue: [], head: 0 };
      map.set(order.price, lvl);
      this.insertPrice(order.side, order.price);
    }
    lvl.queue.push(order);
    lvl.totalQty += order.leaves;
    this.byId.set(order.id, order);
  }

  cancel(orderId: number): RestingOrder | null {
    const o = this.byId.get(orderId);
    if (!o) return null;
    const map = o.side === Side.Buy ? this.bids : this.asks;
    const lvl = map.get(o.price);
    if (lvl) {
      lvl.totalQty -= o.leaves;
      const idx = lvl.queue.indexOf(o);
      if (idx >= 0) lvl.queue.splice(idx, 1);
      if (lvl.queue.length - lvl.head === 0 || lvl.totalQty <= 0) this.dropLevel(o.side, o.price);
    }
    this.byId.delete(orderId);
    const dead = { ...o };
    o.leaves = 0;
    return dead;
  }

  /** Cheap integrity signal folded into the match state hash. */
  fingerprint(): number {
    let h = 0;
    for (const p of this.bidPrices) h = (h * 31 + p + this.bids.get(p)!.totalQty) | 0;
    for (const p of this.askPrices) h = (h * 31 + p + this.asks.get(p)!.totalQty) | 0;
    return h;
  }

  // -------------------------------------------------------------------------
  private compact(lvl: Level): void {
    while (lvl.head < lvl.queue.length && lvl.queue[lvl.head].leaves <= 0) lvl.head++;
    if (lvl.head > 64 && lvl.head * 2 > lvl.queue.length) {
      lvl.queue = lvl.queue.slice(lvl.head);
      lvl.head = 0;
    }
  }

  private dropLevel(side: Side, price: number): void {
    (side === Side.Buy ? this.bids : this.asks).delete(price);
    const arr = side === Side.Buy ? this.bidPrices : this.askPrices;
    const i = this.findPrice(arr, price, side);
    if (i >= 0 && arr[i] === price) arr.splice(i, 1);
  }

  private insertPrice(side: Side, price: number): void {
    const arr = side === Side.Buy ? this.bidPrices : this.askPrices;
    const i = this.findPrice(arr, price, side);
    if (i < arr.length && arr[i] === price) return;
    arr.splice(i, 0, price);
  }

  /** Binary search for the insertion point under this side's ordering. */
  private findPrice(arr: number[], price: number, side: Side): number {
    let lo = 0;
    let hi = arr.length;
    const before = side === Side.Buy
      ? (a: number, b: number) => a > b // bids descending
      : (a: number, b: number) => a < b; // asks ascending
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(arr[mid], price)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** Divide with round-half-away-from-zero. Never use bare `/` on a price. */
export function divRound(num: number, den: number): number {
  if (den === 0) return 0;
  const q = num / den;
  return q >= 0 ? Math.floor(q + 0.5) : Math.ceil(q - 0.5);
}
