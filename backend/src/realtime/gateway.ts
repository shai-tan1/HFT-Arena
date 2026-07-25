/**
 * backend/src/realtime/gateway.ts — the WebSocket front door.
 *
 * Owns three things and nothing else: who is connected, who is waiting, and
 * which room a connection belongs to. All market logic lives behind MatchRoom,
 * all persistence behind Store. Keeping this file free of trading concepts is
 * what will let the ZeroMQ path to the C++ engine slot in later by swapping
 * MatchRoom's engine construction, with no change here.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import {
  type ClientMsg, type ServerMsg, type MatchMode, Side, OrderType, TimeInForce,
} from '../../../shared/src/protocol';
import { MatchRoom, type SeatSpec, FRAME_MS } from './matchRoom';
import { store, type UserRecord } from '../db/store';
import {
  INSTRUMENTS, SCENARIOS, DRILLS, DRILL_SCENARIO, RANKED_POOL,
  STARTING_CASH, drillBySlug, withFreshSeed,
} from '../sim/catalog';
import { verifyToken } from '../util/tokens';

const COUNTDOWN_MS = 5000;
const RANKED_DURATION_MS = 300_000;
const CASUAL_DURATION_MS = 180_000;
const QUEUE_TICK_MS = 1000;
/** Band starts tight and widens; a 90s wait for a perfect match is a worse
 *  experience than a 15s wait for a 150-point gap. */
const BAND_START = 100;
const BAND_GROWTH_PER_SEC = 25;
const BAND_MAX = 900;

interface Conn {
  id: number;
  ws: WebSocket;
  user: UserRecord | null;
  room: MatchRoom | null;
  queue: { mode: MatchMode; since: number } | null;
  lobbyCode: string | null;
  alive: boolean;
}

interface Lobby {
  code: string;
  hostId: string;
  members: { userId: string; ready: boolean }[];
  durationMs: number;
  scenarioId: number;
  createdAt: number;
}

let nextConnId = 1;
let nextMatchId = 1;

export class Gateway {
  private wss: WebSocketServer;
  private conns = new Map<number, Conn>();
  private byUser = new Map<string, Conn>();
  private rooms = new Map<string, MatchRoom>();
  private lobbies = new Map<string, Lobby>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    setInterval(() => this.pumpQueue(), QUEUE_TICK_MS);
    setInterval(() => this.heartbeat(), 15_000);
  }

  // -------------------------------------------------------------------------
  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    const conn: Conn = {
      id: nextConnId++, ws, user: null, room: null, queue: null, lobbyCode: null, alive: true,
    };
    this.conns.set(conn.id, conn);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return this.send(conn, { t: 'error', code: 'bad_json', message: 'Malformed message' });
      }
      try {
        this.handle(conn, msg);
      } catch (err) {
        this.send(conn, {
          t: 'error', code: 'internal',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    });
    ws.on('close', () => this.onClose(conn));
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn.id);
    if (conn.user) {
      // Only drop the user->conn mapping if it still points at THIS connection.
      // A reconnect that raced the close event must not be unmapped.
      if (this.byUser.get(conn.user.id) === conn) this.byUser.delete(conn.user.id);
      conn.room?.setConnected(conn.user.id, false);
    }
    conn.queue = null;
    if (conn.lobbyCode) this.leaveLobby(conn);
  }

  private heartbeat(): void {
    for (const conn of this.conns.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* closing */ }
    }
  }

  private send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private sender(conn: Conn) {
    return (msg: ServerMsg) => this.send(conn, msg);
  }

  // -------------------------------------------------------------------------
  private handle(conn: Conn, msg: ClientMsg): void {
    if (msg.t === 'hello') return this.onHello(conn, msg);
    if (msg.t === 'ping') {
      return this.send(conn, { t: 'pong', ts: msg.ts, serverTime: Date.now() });
    }
    if (!conn.user) {
      return this.send(conn, { t: 'error', code: 'unauthenticated', message: 'Send hello first' });
    }

    switch (msg.t) {
      case 'queue.join': return this.joinQueue(conn, msg.mode);
      case 'queue.leave': conn.queue = null; return;
      case 'lobby.create': return this.createLobby(conn, msg.durationMs, msg.scenarioId);
      case 'lobby.join': return this.joinLobby(conn, msg.code);
      case 'lobby.leave': return this.leaveLobby(conn);
      case 'lobby.ready': return this.setReady(conn, msg.ready);
      case 'solo.start': return this.startSolo(conn, msg.drillSlug, msg.scenarioId, msg.speed);
      case 'solo.abandon':
      case 'match.leave':
        if (conn.room && !conn.room.isEnded) conn.room.end('abandoned');
        conn.room = null;
        return;
      case 'order.new':
        return conn.room?.submitOrder(conn.user.id, msg.cid, {
          side: msg.side as Side, type: msg.type as OrderType,
          tif: msg.tif as TimeInForce, price: msg.price, qty: msg.qty,
        });
      case 'order.cancel': return conn.room?.cancelOrder(conn.user.id, msg.cid, msg.orderId);
      case 'order.cancelAll': return conn.room?.cancelAll(conn.user.id, msg.cid);
      case 'flatten': return conn.room?.flatten(conn.user.id, msg.cid);
    }
  }

  private onHello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    let user: UserRecord | undefined;
    if (msg.token) {
      const claims = verifyToken(msg.token);
      if (claims) user = store.get(claims.sub);
    }
    if (!user) user = store.createGuest(msg.handle);

    conn.user = user;
    // Kick any older connection for this user. Two live sockets on one account
    // during a ranked match is either a bug or someone trying to get two seats.
    const prev = this.byUser.get(user.id);
    if (prev && prev !== conn) {
      this.send(prev, { t: 'error', code: 'session_replaced', message: 'Signed in elsewhere' });
      prev.ws.close();
    }
    this.byUser.set(user.id, conn);

    this.send(conn, {
      t: 'hello.ok', userId: user.id, handle: user.handle, elo: user.elo,
      level: user.level, xp: user.xp, cashMicros: user.cashMicros, serverTime: Date.now(),
    });

    // Reconnect into a live match. Losing a ranked match to a dropped WiFi
    // packet is the fastest way to lose a competitive player permanently.
    for (const room of this.rooms.values()) {
      if (!room.isEnded && room.rebind(user.id, this.sender(conn))) {
        conn.room = room;
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Matchmaking
  // -------------------------------------------------------------------------
  private joinQueue(conn: Conn, mode: MatchMode): void {
    if (conn.room && !conn.room.isEnded) {
      return this.send(conn, { t: 'error', code: 'in_match', message: 'Already in a match' });
    }
    conn.queue = { mode, since: Date.now() };
    this.send(conn, {
      t: 'queue.update', mode, waitedMs: 0, bandWidth: BAND_START,
      playersSearching: this.searchingCount(mode),
    });
  }

  private searchingCount(mode: MatchMode): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.queue?.mode === mode) n++;
    return n;
  }

  private bandFor(waitedMs: number): number {
    return Math.min(BAND_MAX, BAND_START + Math.floor(waitedMs / 1000) * BAND_GROWTH_PER_SEC);
  }

  private pumpQueue(): void {
    const now = Date.now();
    const waiting = [...this.conns.values()].filter((c) => c.queue && c.user);

    // Oldest first, so nobody starves behind a stream of fresh arrivals.
    waiting.sort((a, b) => a.queue!.since - b.queue!.since);

    const paired = new Set<number>();
    for (const a of waiting) {
      if (paired.has(a.id)) continue;
      const bandA = this.bandFor(now - a.queue!.since);
      for (const b of waiting) {
        if (b.id === a.id || paired.has(b.id)) continue;
        if (b.queue!.mode !== a.queue!.mode) continue;
        const bandB = this.bandFor(now - b.queue!.since);
        const gap = Math.abs(a.user!.elo - b.user!.elo);
        // Both bands must accept: a veteran who just queued should not be
        // dragged into a mismatch by a desperate newcomer's widened band.
        if (gap <= Math.min(bandA, bandB)) {
          paired.add(a.id);
          paired.add(b.id);
          this.startPvp(a, b, a.queue!.mode);
          break;
        }
      }
    }

    for (const c of waiting) {
      if (paired.has(c.id) || !c.queue) continue;
      const waited = now - c.queue.since;
      this.send(c, {
        t: 'queue.update', mode: c.queue.mode, waitedMs: waited,
        bandWidth: this.bandFor(waited), playersSearching: this.searchingCount(c.queue.mode),
      });
    }
  }

  private startPvp(a: Conn, b: Conn, mode: MatchMode, scenarioId?: number, durationMs?: number): void {
    a.queue = null;
    b.queue = null;

    const pick = scenarioId ?? RANKED_POOL[Math.floor(Math.random() * RANKED_POOL.length)];
    const base = SCENARIOS[pick] ?? SCENARIOS[2];
    // A fresh seed every match. Reusing a scenario id without rerolling the
    // seed would let a player memorise the price path, which is the one form
    // of cheating this architecture cannot detect after the fact.
    const spec = withFreshSeed(base, BigInt(Date.now()), BigInt(Math.floor(Math.random() * 2 ** 48)));
    const instrument = INSTRUMENTS[spec.instrumentId];
    const duration = durationMs ?? (mode === 'ranked_pvp' ? RANKED_DURATION_MS : CASUAL_DURATION_MS);

    const matchId = `m${nextMatchId++}`;
    const seatSpecs: SeatSpec[] = [a, b].map((c) => ({
      userId: c.user!.id, handle: c.user!.handle, elo: c.user!.elo, send: this.sender(c),
    }));

    const room = new MatchRoom({
      matchId, mode, instrument, scenario: spec,
      durationMs: Math.min(duration, sumDuration(spec)),
      startingCash: STARTING_CASH, countdownMs: COUNTDOWN_MS, speed: 1,
      onEnd: (r) => this.settle(r),
    }, seatSpecs);

    this.rooms.set(matchId, room);
    a.room = room;
    b.room = room;
    room.arm();
  }

  // -------------------------------------------------------------------------
  // Private lobbies
  // -------------------------------------------------------------------------
  private createLobby(conn: Conn, durationMs?: number, scenarioId?: number): void {
    if (conn.lobbyCode) this.leaveLobby(conn);
    const code = this.freshCode();
    const lobby: Lobby = {
      code,
      hostId: conn.user!.id,
      members: [{ userId: conn.user!.id, ready: false }],
      durationMs: clamp(durationMs ?? CASUAL_DURATION_MS, 60_000, 600_000),
      scenarioId: scenarioId && SCENARIOS[scenarioId] ? scenarioId : 2,
      createdAt: Date.now(),
    };
    this.lobbies.set(code, lobby);
    conn.lobbyCode = code;
    this.broadcastLobby(lobby);
  }

  private joinLobby(conn: Conn, code: string): void {
    const lobby = this.lobbies.get(code.toUpperCase().trim());
    if (!lobby) return this.send(conn, { t: 'error', code: 'no_lobby', message: 'No lobby with that code' });
    if (lobby.members.length >= 2 && !lobby.members.some((m) => m.userId === conn.user!.id)) {
      return this.send(conn, { t: 'error', code: 'lobby_full', message: 'That lobby is full' });
    }
    if (conn.lobbyCode && conn.lobbyCode !== lobby.code) this.leaveLobby(conn);
    if (!lobby.members.some((m) => m.userId === conn.user!.id)) {
      lobby.members.push({ userId: conn.user!.id, ready: false });
    }
    conn.lobbyCode = lobby.code;
    this.broadcastLobby(lobby);
  }

  private leaveLobby(conn: Conn): void {
    const lobby = conn.lobbyCode ? this.lobbies.get(conn.lobbyCode) : undefined;
    conn.lobbyCode = null;
    if (!lobby || !conn.user) return;
    lobby.members = lobby.members.filter((m) => m.userId !== conn.user!.id);
    if (lobby.members.length === 0) {
      this.lobbies.delete(lobby.code);
      return;
    }
    if (lobby.hostId === conn.user.id) lobby.hostId = lobby.members[0].userId;
    this.broadcastLobby(lobby);
  }

  private setReady(conn: Conn, ready: boolean): void {
    const lobby = conn.lobbyCode ? this.lobbies.get(conn.lobbyCode) : undefined;
    if (!lobby) return;
    const me = lobby.members.find((m) => m.userId === conn.user!.id);
    if (me) me.ready = ready;
    this.broadcastLobby(lobby);

    if (lobby.members.length === 2 && lobby.members.every((m) => m.ready)) {
      const [a, b] = lobby.members.map((m) => this.byUser.get(m.userId));
      if (a && b) {
        this.lobbies.delete(lobby.code);
        a.lobbyCode = null;
        b.lobbyCode = null;
        this.startPvp(a, b, 'casual_pvp', lobby.scenarioId, lobby.durationMs);
      }
    }
  }

  private broadcastLobby(lobby: Lobby): void {
    const scenario = SCENARIOS[lobby.scenarioId];
    for (const m of lobby.members) {
      const c = this.byUser.get(m.userId);
      if (!c) continue;
      this.send(c, {
        t: 'lobby.state',
        code: lobby.code,
        isHost: lobby.hostId === m.userId,
        durationMs: lobby.durationMs,
        scenarioLabel: scenario?.label ?? 'Trend Day',
        members: lobby.members.map((mm) => {
          const u = store.get(mm.userId);
          return {
            handle: u?.handle ?? '???', elo: u?.elo ?? 1200,
            ready: mm.ready, isHost: lobby.hostId === mm.userId,
          };
        }),
      });
    }
  }

  /** Ambiguity-free alphabet: no O/0, no I/1. Codes get read aloud. */
  private freshCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!this.lobbies.has(code)) return code;
    }
    return `L${Date.now().toString(36).toUpperCase().slice(-5)}`;
  }

  // -------------------------------------------------------------------------
  // Solo practice
  // -------------------------------------------------------------------------
  private startSolo(conn: Conn, drillSlug?: string, scenarioId?: number, speed?: number): void {
    if (conn.room && !conn.room.isEnded) conn.room.end('abandoned');

    const drill = drillSlug ? drillBySlug(drillSlug) : undefined;
    if (drillSlug && !drill) {
      return this.send(conn, { t: 'error', code: 'no_drill', message: 'Unknown drill' });
    }
    const sid = drill ? DRILL_SCENARIO[drill.slug] : (scenarioId ?? 1);
    const base = SCENARIOS[sid];
    if (!base) return this.send(conn, { t: 'error', code: 'no_scenario', message: 'Unknown scenario' });

    // Drills keep their fixed seed — a leaderboard where everyone played a
    // different market is not a leaderboard. Free practice rerolls, so replaying
    // for practice is actually practice and not memorisation.
    const spec = drill
      ? base
      : withFreshSeed(base, BigInt(Date.now()), BigInt(Math.floor(Math.random() * 2 ** 48)));

    const instrument = INSTRUMENTS[spec.instrumentId];
    const matchId = `p${nextMatchId++}`;
    const room = new MatchRoom({
      matchId, mode: 'practice', instrument, scenario: spec,
      durationMs: Math.min(drill?.durationMs ?? sumDuration(spec), sumDuration(spec)),
      startingCash: drill?.startingCash ?? STARTING_CASH,
      countdownMs: 3000,
      speed: clamp(speed ?? 1, 1, 3),
      drill,
      onEnd: (r) => this.settle(r),
    }, [{
      userId: conn.user!.id, handle: conn.user!.handle,
      elo: conn.user!.elo, send: this.sender(conn),
    }]);

    this.rooms.set(matchId, room);
    conn.room = room;
    room.arm();
  }

  // -------------------------------------------------------------------------
  private settle(room: MatchRoom): void {
    const results = room.getResults();
    if (room.opts.mode === 'practice') {
      const seat = results[0];
      if (seat) {
        store.recordPractice({
          id: room.matchId, userId: seat.userId,
          drillSlug: room.opts.drill?.slug ?? null,
          scenarioLabel: room.opts.scenario.label,
          endedAt: Date.now(),
          pnl: seat.finalEquity - seat.startingCash,
          stars: 0, fills: seat.fills, makerFills: seat.makerFills,
          maxDrawdown: seat.maxDrawdown, xpAwarded: 0,
        });
      }
    } else {
      store.recordMatch({
        id: room.matchId, mode: room.opts.mode,
        scenarioLabel: room.opts.scenario.label,
        durationMs: room.opts.durationMs, endedAt: Date.now(), seats: results,
      });
    }
    // Keep the room briefly so a reconnecting client still gets its end screen.
    setTimeout(() => this.rooms.delete(room.matchId), 60_000);
  }

  stats() {
    return {
      connections: this.conns.size,
      rooms: [...this.rooms.values()].filter((r) => !r.isEnded).length,
      lobbies: this.lobbies.size,
      frameIntervalMs: FRAME_MS,
      drills: DRILLS.length,
    };
  }
}

function sumDuration(spec: { timeline: { durationMs: number }[] }): number {
  return spec.timeline.reduce((a, s) => a + s.durationMs, 0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
