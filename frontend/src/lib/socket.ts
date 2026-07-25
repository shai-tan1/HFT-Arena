/**
 * frontend/src/lib/socket.ts — the match socket.
 *
 * One socket for the whole app, opened at boot and kept alive. Matchmaking,
 * lobbies, the live market feed and order entry all ride it. Opening a fresh
 * socket per match would mean a handshake sitting between "click play" and
 * "see the book", and in a game with a five-second countdown that handshake is
 * a visible stall.
 *
 * Reconnect is exponential with a cap. The server holds a finished room for a
 * minute and rebinds a returning player into a live one, so a dropped WiFi
 * packet costs reaction time rather than the match.
 */

import type { ClientMsg, ServerMsg } from '@shared/protocol';

type Handler = (msg: ServerMsg) => void;
type StatusHandler = (status: SocketStatus) => void;

export type SocketStatus = 'connecting' | 'open' | 'closed';

const WS_URL = import.meta.env.VITE_WS_URL ??
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

class MatchSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private queue: ClientMsg[] = [];
  private retries = 0;
  private token: string | null = null;
  private handle: string | undefined;
  private closedByUs = false;
  private pingTimer: number | null = null;
  /** Round-trip time in ms, shown in the HUD. In this game latency is content. */
  latencyMs = 0;

  connect(token: string | null, handle?: string): void {
    this.token = token;
    this.handle = handle;
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.emitStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.emitStatus('open');
      this.rawSend({ t: 'hello', token: this.token ?? undefined, handle: this.handle });
      for (const msg of this.queue.splice(0)) this.rawSend(msg);
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.latencyMs = Math.max(0, Date.now() - msg.ts);
        return;
      }
      for (const h of this.handlers) h(msg);
    };

    ws.onclose = () => {
      this.stopPing();
      this.emitStatus('closed');
      if (this.closedByUs) return;
      // 0.5s, 1s, 2s, 4s, capped at 8s. Fast enough to feel instant on a blip,
      // slow enough not to hammer a server that is genuinely down.
      const delay = Math.min(8000, 500 * 2 ** this.retries++);
      setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => ws.close();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.rawSend({ t: 'ping', ts: Date.now() });
    }, 4000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.rawSend(msg);
    else this.queue.push(msg);
  }

  private rawSend(msg: ClientMsg): void {
    this.ws?.send(JSON.stringify(msg));
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(s: SocketStatus): void {
    for (const h of this.statusHandlers) h(s);
  }

  disconnect(): void {
    this.closedByUs = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }
}

export const socket = new MatchSocket();

/** Monotonic client order ids. The server echoes them back on every ack. */
let cid = 1;
export function nextCid(): number {
  return cid++;
}
