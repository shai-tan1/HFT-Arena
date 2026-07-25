/**
 * shared/protocol.ts — the browser <-> Node wire contract.
 *
 * This is deliberately NOT the same protocol as engine/include/hfta/ipc_protocol.h.
 * That one is packed binary because it carries a full event tape between two
 * processes on the same host at 50 Hz. This one crosses the public internet to a
 * browser at 10-20 Hz carrying already-aggregated state, where JSON's
 * debuggability is worth more than its bytes.
 *
 * The rule that DOES carry over unchanged: no floating point for prices, sizes
 * or money. Everything is an integer — ticks, lots, micros — exactly as the
 * engine sees it. Formatting for humans happens in the last mile, in the React
 * component, and nowhere else.
 */

// ---------------------------------------------------------------------------
// Enums — mirror hfta/types.h exactly. Never renumber.
// ---------------------------------------------------------------------------
export const Side = { Buy: 0, Sell: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];

export const OrderType = { Limit: 0, Market: 1 } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const TimeInForce = { GTC: 0, IOC: 1, FOK: 2, PostOnly: 3 } as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

export const OrderStatus = {
  New: 0,
  PartiallyFilled: 1,
  Filled: 2,
  Cancelled: 3,
  Rejected: 4,
  Expired: 5,
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const RejectReason = {
  None: 0,
  UnknownInstrument: 1,
  PriceOutOfBand: 2,
  PriceNotOnTick: 3,
  QtyInvalid: 4,
  QtyAboveLimit: 5,
  InsufficientMargin: 6,
  ShortNotPermitted: 7,
  PostOnlyWouldCross: 8,
  FokUnfillable: 9,
  UnknownOrder: 10,
  NotOrderOwner: 11,
  RateLimited: 12,
  EngineNotRunning: 13,
  SelfTradePrevented: 14,
  BookCapacityReached: 15,
} as const;
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];

export const REJECT_TEXT: Record<number, string> = {
  0: 'OK',
  1: 'Unknown instrument',
  2: 'Price outside band',
  3: 'Price not on tick',
  4: 'Invalid quantity',
  5: 'Quantity above limit',
  6: 'Insufficient margin',
  7: 'Short not permitted',
  8: 'Post-only would cross',
  9: 'FOK unfillable',
  10: 'Unknown order',
  11: 'Not order owner',
  12: 'Rate limited',
  13: 'Engine not running',
  14: 'Self-trade prevented',
  15: 'Book at capacity',
};

export const TradeGrade = {
  Ungraded: 0,
  Brilliant: 1,
  Great: 2,
  Good: 3,
  Inaccuracy: 4,
  Mistake: 5,
  Blunder: 6,
} as const;
export type TradeGrade = (typeof TradeGrade)[keyof typeof TradeGrade];

export type Regime =
  | 'Calm'
  | 'Trending'
  | 'Choppy'
  | 'Volatile'
  | 'LiquidityGap'
  | 'NewsSpike'
  | 'FlashCrash'
  | 'Squeeze';

export type AgentKind =
  | 'MarketMaker'
  | 'NoiseTrader'
  | 'Momentum'
  | 'MeanReversion'
  | 'IcebergWhale'
  | 'Sweeper'
  | 'Spoofer';

export type MatchMode = 'practice' | 'ranked_pvp' | 'casual_pvp' | 'daily_puzzle';

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------
export interface InstrumentSpec {
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
}

/** One aggregated price level. */
export interface BookLevel {
  price: number; // ticks
  qty: number; // lots
  orders: number;
  /** Lots at this level belonging to the viewing player. Drives the ladder highlight. */
  mine: number;
}

export interface BookSnapshot {
  bids: BookLevel[]; // descending price
  asks: BookLevel[]; // ascending price
  bestBid: number | null;
  bestAsk: number | null;
  lastTrade: number | null;
  microPrice: number | null; // ticks, size-weighted
}

export interface AccountState {
  cash: number; // micros
  reservedMargin: number; // micros
  position: number; // signed lots
  avgEntryMicros: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  buyingPower: number;
}

export interface OpenOrder {
  orderId: number;
  clientOrdId: number;
  side: Side;
  type: OrderType;
  tif: TimeInForce;
  price: number;
  qty: number;
  leaves: number;
  status: OrderStatus;
  tsNs: number;
}

export interface TradePrint {
  seq: number;
  tsNs: number;
  price: number;
  qty: number;
  aggressor: Side;
}

export interface FillEvent {
  seq: number;
  tsNs: number;
  orderId: number;
  clientOrdId: number;
  side: Side;
  price: number;
  qty: number;
  leaves: number;
  isMaker: boolean;
  grade: TradeGrade;
  realizedDelta: number;
}

export interface Candle {
  t: number; // bucket start, ms from match start
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OpponentView {
  handle: string;
  equity: number;
  pnl: number;
  position: number;
  fills: number;
  connected: boolean;
}

export interface SeatResult {
  seat: number;
  userId: string;
  handle: string;
  startingCash: number;
  finalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fills: number;
  makerFills: number;
  volumeLots: number;
  maxDrawdown: number;
  peakEquity: number;
  eloBefore?: number;
  eloAfter?: number;
  result?: 'win' | 'loss' | 'draw';
}

export interface DrillObjective {
  id: string;
  kind: 'min_pnl' | 'max_drawdown' | 'min_maker_ratio_bps' | 'min_fills' | 'max_position';
  target: number;
  label: string;
}

export interface DrillSummary {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string;
  skillTag: string;
  difficulty: number;
  durationMs: number;
  startingCash: number;
  objectives: DrillObjective[];
  starThresholds: number[];
  xpReward: number;
  unlockLevel: number;
  scenarioLabel: string;
  bestPnl?: number | null;
  bestStars?: number;
  attempts?: number;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------
export type ClientMsg =
  | { t: 'hello'; token?: string; handle?: string }
  | { t: 'ping'; ts: number }
  | { t: 'queue.join'; mode: MatchMode }
  | { t: 'queue.leave' }
  | { t: 'lobby.create'; durationMs?: number; scenarioId?: number }
  | { t: 'lobby.join'; code: string }
  | { t: 'lobby.leave' }
  | { t: 'lobby.ready'; ready: boolean }
  | { t: 'solo.start'; drillSlug?: string; scenarioId?: number; speed?: number }
  | { t: 'solo.abandon' }
  | {
      t: 'order.new';
      cid: number;
      side: Side;
      type: OrderType;
      tif: TimeInForce;
      price: number;
      qty: number;
    }
  | { t: 'order.cancel'; cid: number; orderId: number }
  | { t: 'order.cancelAll'; cid: number }
  | { t: 'flatten'; cid: number }
  | { t: 'match.leave' };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------
export interface HelloOk {
  t: 'hello.ok';
  userId: string;
  handle: string;
  elo: number;
  level: number;
  xp: number;
  cashMicros: number;
  serverTime: number;
}

export interface QueueUpdate {
  t: 'queue.update';
  mode: MatchMode;
  waitedMs: number;
  bandWidth: number;
  playersSearching: number;
}

export interface LobbyState {
  t: 'lobby.state';
  code: string;
  isHost: boolean;
  durationMs: number;
  scenarioLabel: string;
  members: { handle: string; elo: number; ready: boolean; isHost: boolean }[];
  closed?: boolean;
}

/** Sent to both seats once the room exists, before the countdown. */
export interface MatchArm {
  t: 'match.arm';
  matchId: string;
  mode: MatchMode;
  seat: number;
  instrument: InstrumentSpec;
  scenario: { id: number; label: string; difficulty: number; openPrice: number };
  drill?: DrillSummary;
  durationMs: number;
  startingCash: number;
  countdownMs: number;
  opponent?: { handle: string; elo: number };
  /** ms per engine frame — the frontend uses this to size its chart buffer. */
  frameIntervalMs: number;
}

export interface MatchStart {
  t: 'match.start';
  startedAtMs: number;
}

/**
 * The main frame. One per engine publish interval, per seat, containing
 * everything that changed for THIS seat. Sending a full top-of-book slice
 * rather than deltas is a deliberate simplification: at 12 levels a side and
 * 10 Hz this is under 2 KB/s, and it means a dropped frame is self-healing
 * instead of requiring the gap-recovery path the binary protocol needs.
 */
export interface MatchFrame {
  t: 'frame';
  seq: number;
  tMs: number; // elapsed ms since match start
  remainingMs: number;
  book: BookSnapshot;
  account: AccountState;
  openOrders: OpenOrder[];
  prints: TradePrint[]; // since the last frame
  candle: Candle; // the current (possibly partial) bucket
  closedCandles: Candle[]; // buckets that completed since the last frame
  regime: Regime;
  opponent?: OpponentView;
  /** Sampled equity for the race chart; one point per frame. */
  equityPoint: { tMs: number; equity: number };
}

export interface OrderAckMsg {
  t: 'ack';
  cid: number;
  orderId: number;
  status: OrderStatus;
  reject: RejectReason;
  tsNs: number;
}

export interface FillMsg {
  t: 'fill';
  fill: FillEvent;
}

export interface MatchEnd {
  t: 'match.end';
  matchId: string;
  mode: MatchMode;
  seats: SeatResult[];
  yourSeat: number;
  stateHash: string;
  totalDraws: string;
  candles: Candle[];
  equityCurves: { seat: number; points: { tMs: number; equity: number }[] }[];
  fills: FillEvent[];
  drillResult?: {
    stars: number;
    xpAwarded: number;
    objectives: { id: string; label: string; met: boolean; value: number; target: number }[];
    newBest: boolean;
  };
}

export interface ErrorMsg {
  t: 'error';
  code: string;
  message: string;
}

export type ServerMsg =
  | HelloOk
  | { t: 'pong'; ts: number; serverTime: number }
  | QueueUpdate
  | LobbyState
  | MatchArm
  | MatchStart
  | MatchFrame
  | OrderAckMsg
  | FillMsg
  | MatchEnd
  | ErrorMsg;

// ---------------------------------------------------------------------------
// Formatting helpers. Every price/money value in the UI goes through one of
// these, so there is exactly one place where integers become strings.
// ---------------------------------------------------------------------------
export const MICROS = 1_000_000;

export function formatPrice(ticks: number | null | undefined, precision = 2): string {
  if (ticks === null || ticks === undefined) return '—';
  const scale = 10 ** precision;
  const whole = Math.trunc(ticks / scale);
  const frac = Math.abs(ticks % scale);
  return `${whole}.${String(frac).padStart(precision, '0')}`;
}

export function formatMoney(micros: number | null | undefined, opts?: { sign?: boolean }): string {
  if (micros === null || micros === undefined) return '—';
  const neg = micros < 0;
  const abs = Math.abs(micros);
  const dollars = Math.trunc(abs / MICROS);
  const cents = Math.trunc((abs % MICROS) / 10_000);
  const body = `$${dollars.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
  if (neg) return `-${body}`;
  return opts?.sign ? `+${body}` : body;
}

export function formatCompactMoney(micros: number): string {
  const abs = Math.abs(micros) / MICROS;
  const sign = micros < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
