/**
 * frontend/src/state/match.ts — live match state.
 *
 * One store, fed by the socket, driving every panel on the trade screen. The
 * server frame is authoritative for the book, the account and the clock; the
 * client keeps only two things of its own:
 *
 *   1. A rolling candle buffer, because the server sends closed candles once
 *      and re-sending the whole history at 10 Hz would be absurd.
 *   2. Optimistic order state, so a click feels instant. It is reconciled
 *      against the next frame's openOrders, which always wins — an optimistic
 *      order that the engine rejected must not linger on screen.
 */

import { create } from 'zustand';
import {
  type MatchArm, type MatchFrame, type MatchEnd, type Candle, type TradePrint,
  type FillEvent, type LobbyState, type QueueUpdate, type OpenOrder,
  OrderStatus, RejectReason, REJECT_TEXT, Side, OrderType, TimeInForce,
} from '@shared/protocol';
import { socket, nextCid } from '@/lib/socket';

export type Phase = 'idle' | 'queued' | 'lobby' | 'countdown' | 'live' | 'ended';

export interface Toast {
  id: number;
  kind: 'error' | 'buy' | 'sell' | 'info';
  text: string;
}

const MAX_CANDLES = 200;
const MAX_TAPE = 60;
const MAX_FILLS = 200;

interface MatchState {
  phase: Phase;
  arm: MatchArm | null;
  frame: MatchFrame | null;
  candles: Candle[];
  tape: TradePrint[];
  fills: FillEvent[];
  result: MatchEnd | null;
  lobby: LobbyState | null;
  queue: QueueUpdate | null;
  countdownMs: number;
  toasts: Toast[];
  /** cid -> pending order, cleared on ack. */
  pending: Map<number, { side: Side; qty: number; price: number }>;
  optimisticCancels: Set<number>;

  bind: () => () => void;
  reset: () => void;

  joinQueue: (mode: 'ranked_pvp' | 'casual_pvp') => void;
  leaveQueue: () => void;
  createLobby: (durationMs?: number, scenarioId?: number) => void;
  joinLobby: (code: string) => void;
  leaveLobby: () => void;
  setReady: (ready: boolean) => void;
  startSolo: (opts: { drillSlug?: string; scenarioId?: number; speed?: number }) => void;
  leaveMatch: () => void;

  sendOrder: (o: { side: Side; type: OrderType; tif: TimeInForce; price: number; qty: number }) => void;
  cancelOrder: (orderId: number) => void;
  cancelAll: () => void;
  flatten: () => void;

  pushToast: (kind: Toast['kind'], text: string) => void;
}

let toastId = 1;
let countdownTimer: number | null = null;

export const useMatch = create<MatchState>((set, get) => ({
  phase: 'idle',
  arm: null,
  frame: null,
  candles: [],
  tape: [],
  fills: [],
  result: null,
  lobby: null,
  queue: null,
  countdownMs: 0,
  toasts: [],
  pending: new Map(),
  optimisticCancels: new Set(),

  bind() {
    return socket.on((msg) => {
      switch (msg.t) {
        case 'queue.update':
          set({ phase: 'queued', queue: msg });
          break;

        case 'lobby.state':
          set({ phase: 'lobby', lobby: msg });
          break;

        case 'match.arm': {
          set({
            phase: 'countdown', arm: msg, frame: null, result: null,
            candles: [], tape: [], fills: [], queue: null, lobby: null,
            countdownMs: msg.countdownMs,
            pending: new Map(), optimisticCancels: new Set(),
          });
          if (countdownTimer !== null) window.clearInterval(countdownTimer);
          const deadline = Date.now() + msg.countdownMs;
          countdownTimer = window.setInterval(() => {
            const left = deadline - Date.now();
            if (left <= 0) {
              window.clearInterval(countdownTimer!);
              countdownTimer = null;
              set({ countdownMs: 0 });
            } else {
              set({ countdownMs: left });
            }
          }, 50);
          break;
        }

        case 'match.start':
          set({ phase: 'live', countdownMs: 0 });
          break;

        case 'frame': {
          const s = get();
          const candles = msg.closedCandles.length
            ? [...s.candles, ...msg.closedCandles].slice(-MAX_CANDLES)
            : s.candles;
          const tape = msg.prints.length
            ? [...msg.prints.slice(-MAX_TAPE), ...s.tape].slice(0, MAX_TAPE)
            : s.tape;

          // The frame's openOrders are the truth. Anything we optimistically
          // hid or showed that is not reflected here has been resolved by the
          // engine, so drop the optimism rather than letting it accumulate.
          const live = new Set(msg.openOrders.map((o) => o.orderId));
          const cancels = new Set([...s.optimisticCancels].filter((id) => live.has(id)));

          set({ frame: msg, candles, tape, optimisticCancels: cancels, phase: 'live' });
          break;
        }

        case 'ack': {
          const s = get();
          const pending = new Map(s.pending);
          const p = pending.get(msg.cid);
          pending.delete(msg.cid);
          set({ pending });
          if (msg.reject !== RejectReason.None) {
            get().pushToast('error', REJECT_TEXT[msg.reject] ?? 'Order rejected');
          } else if (p && msg.status === OrderStatus.New) {
            // Resting orders are visible in the ladder; no toast needed.
          }
          break;
        }

        case 'fill': {
          const s = get();
          set({ fills: [msg.fill, ...s.fills].slice(0, MAX_FILLS) });
          break;
        }

        case 'match.end':
          if (countdownTimer !== null) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
          }
          set({ phase: 'ended', result: msg });
          break;

        case 'error':
          get().pushToast('error', msg.message);
          if (msg.code === 'no_lobby' || msg.code === 'lobby_full') set({ phase: 'idle' });
          break;
      }
    });
  },

  reset() {
    if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    set({
      phase: 'idle', arm: null, frame: null, candles: [], tape: [], fills: [],
      result: null, lobby: null, queue: null, countdownMs: 0,
      pending: new Map(), optimisticCancels: new Set(),
    });
  },

  joinQueue(mode) {
    set({ phase: 'queued', queue: null });
    socket.send({ t: 'queue.join', mode });
  },

  leaveQueue() {
    socket.send({ t: 'queue.leave' });
    set({ phase: 'idle', queue: null });
  },

  createLobby(durationMs, scenarioId) {
    socket.send({ t: 'lobby.create', durationMs, scenarioId });
  },

  joinLobby(code) {
    socket.send({ t: 'lobby.join', code: code.toUpperCase().trim() });
  },

  leaveLobby() {
    socket.send({ t: 'lobby.leave' });
    set({ phase: 'idle', lobby: null });
  },

  setReady(ready) {
    socket.send({ t: 'lobby.ready', ready });
  },

  startSolo(opts) {
    set({ phase: 'countdown', result: null });
    socket.send({ t: 'solo.start', ...opts });
  },

  leaveMatch() {
    socket.send({ t: 'match.leave' });
    get().reset();
  },

  sendOrder(o) {
    const cid = nextCid();
    const pending = new Map(get().pending);
    pending.set(cid, { side: o.side, qty: o.qty, price: o.price });
    set({ pending });
    socket.send({ t: 'order.new', cid, ...o });
  },

  cancelOrder(orderId) {
    const optimisticCancels = new Set(get().optimisticCancels);
    optimisticCancels.add(orderId);
    set({ optimisticCancels });
    socket.send({ t: 'order.cancel', cid: nextCid(), orderId });
  },

  cancelAll() {
    const frame = get().frame;
    if (frame) {
      set({ optimisticCancels: new Set(frame.openOrders.map((o) => o.orderId)) });
    }
    socket.send({ t: 'order.cancelAll', cid: nextCid() });
  },

  flatten() {
    socket.send({ t: 'flatten', cid: nextCid() });
  },

  pushToast(kind, text) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-4) });
    window.setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, 3200);
  },
}));

/** Open orders minus anything we have optimistically cancelled. */
export function visibleOrders(frame: MatchFrame | null, cancelled: Set<number>): OpenOrder[] {
  if (!frame) return [];
  return frame.openOrders.filter((o) => !cancelled.has(o.orderId));
}
