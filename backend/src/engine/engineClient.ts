/**
 * engineClient.ts — Node.js side of the ZeroMQ bridge to a C++ match engine.
 *
 * One instance per live match. Owns three sockets:
 *   Dealer     -> engine ROUTER  : orders + lifecycle control
 *   Subscriber <- engine PUB     : market data, private execs, engine state
 *   Request    -> engine REP     : health / admin / state hash
 *
 * Design notes that matter:
 *
 *  1. Decode with DataView, not JSON. Every hot struct is fixed layout and the
 *     offsets below are asserted against the C++ static_asserts in CI by a
 *     generated golden file — if someone reorders a field in ipc_protocol.h
 *     without touching this file, the build fails rather than the match.
 *
 *  2. BigInt at the boundary, number in the app. Prices and quantities are
 *     int64 on the wire. Read them as BigInt, then narrow deliberately: ticks
 *     and lots are comfortably inside Number.MAX_SAFE_INTEGER, but cash in
 *     micro-units is NOT for large accounts. Keep money as BigInt end to end
 *     and only format it for display. This is the single easiest place in the
 *     whole project to introduce a silent rounding bug.
 *
 *  3. Gap detection is mandatory, not optional. PUB/SUB drops frames when a
 *     subscriber falls behind — by design. Track the per-topic sequence number,
 *     and on a gap request a fresh L2 snapshot rather than letting the client's
 *     book quietly drift. This is the same snapshot-plus-delta recovery pattern
 *     real market data feeds use.
 *
 *  4. Never trust the engine's timestamps for anything user-facing without
 *     also recording wall time. Engine time is LOGICAL time; the two diverge
 *     under pause, replay and fast-forward.
 */

import { Dealer, Subscriber, Request } from 'zeromq';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Wire constants — mirror of hfta/ipc_protocol.h
// ---------------------------------------------------------------------------
const MAGIC = 0x48465441; // 'HFTA'
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 40;

export enum MsgType {
  CmdNewOrder = 0x01,
  CmdCancel = 0x02,
  CmdReplace = 0x03,
  CmdFlatten = 0x04,
  CmdSnapshotReq = 0x05,

  CtlArm = 0x20,
  CtlStart = 0x21,
  CtlPause = 0x22,
  CtlResume = 0x23,
  CtlFinish = 0x24,
  CtlTeardown = 0x25,
  CtlHeartbeat = 0x26,

  EvtAck = 0x40,
  EvtFill = 0x41,
  EvtTradePrint = 0x42,
  EvtL2Delta = 0x43,
  EvtL2Snapshot = 0x44,
  EvtAccount = 0x45,
  EvtEngineState = 0x46,
  EvtMatchEnd = 0x47,
}

export enum Side { Buy = 0, Sell = 1 }
export enum OrderType { Limit = 0, Market = 1 }
export enum TimeInForce { GTC = 0, IOC = 1, FOK = 2, PostOnly = 3 }

export interface Fill {
  orderId: bigint;
  clientOrdId: bigint;
  ts: bigint;
  price: number;      // ticks
  qty: number;        // lots
  leavesQty: number;
  clientId: number;
  side: Side;
  isMaker: boolean;
}

export interface LevelDelta { price: number; qty: number; orderCount: number; side: Side; }

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------
function writeHeader(
  buf: Buffer, type: MsgType, bodyLen: number, count: number,
  matchId: bigint, seq: bigint,
): void {
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt16LE(PROTOCOL_VERSION, 4);
  buf.writeUInt16LE(type, 6);
  buf.writeUInt32LE(bodyLen, 8);
  buf.writeUInt32LE(count, 12);
  buf.writeBigUInt64LE(matchId, 16);
  buf.writeBigUInt64LE(seq, 24);
  buf.writeBigUInt64LE(BigInt(Date.now()) * 1_000_000n, 32);
}

interface ParsedHeader {
  type: MsgType; bodyLen: number; count: number;
  matchId: bigint; seq: bigint; tSend: bigint;
}

function readHeader(buf: Buffer): ParsedHeader {
  if (buf.length < HEADER_SIZE) throw new Error('short frame');
  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`);
  const version = buf.readUInt16LE(4);
  if (version !== PROTOCOL_VERSION) {
    // Fail loudly and immediately. A version-skewed engine in a live match is
    // worse than no engine, because it will produce plausible wrong numbers.
    throw new Error(`protocol mismatch: engine=${version} backend=${PROTOCOL_VERSION}`);
  }
  const bodyLen = buf.readUInt32LE(8);
  if (HEADER_SIZE + bodyLen > buf.length) throw new Error('truncated body');
  return {
    type: buf.readUInt16LE(6),
    bodyLen,
    count: buf.readUInt32LE(12),
    matchId: buf.readBigUInt64LE(16),
    seq: buf.readBigUInt64LE(24),
    tSend: buf.readBigUInt64LE(32),
  };
}

// WireFill is 56 bytes; offsets mirror ipc_protocol.h exactly.
function decodeFill(buf: Buffer, at: number): Fill {
  return {
    orderId: buf.readBigUInt64LE(at + 0),
    clientOrdId: buf.readBigUInt64LE(at + 8),
    ts: buf.readBigUInt64LE(at + 16),
    price: Number(buf.readBigInt64LE(at + 24)),
    qty: Number(buf.readBigInt64LE(at + 32)),
    leavesQty: Number(buf.readBigInt64LE(at + 40)),
    clientId: buf.readUInt32LE(at + 48),
    side: buf.readUInt8(at + 52) as Side,
    isMaker: buf.readUInt8(at + 53) === 0,
  };
}

function decodeLevelDelta(buf: Buffer, at: number): LevelDelta {
  return {
    price: Number(buf.readBigInt64LE(at + 0)),
    qty: Number(buf.readBigInt64LE(at + 8)),
    orderCount: buf.readUInt32LE(at + 16),
    side: buf.readUInt8(at + 20) as Side,
  };
}

// ---------------------------------------------------------------------------
// Topics — fixed 8-byte keys, matching TopicKey in ipc_protocol.h
// ---------------------------------------------------------------------------
function topic(name: string): Buffer {
  const b = Buffer.alloc(8);
  b.write(name, 0, 'ascii');
  return b;
}
const TOPIC_L2 = topic('md.l2');
const TOPIC_TRADES = topic('md.trd');
const TOPIC_SYS = topic('sys.');
function topicExec(clientId: number): Buffer {
  const b = Buffer.alloc(8);
  b.write('ex.', 0, 'ascii');
  b.writeUInt32LE(clientId, 3);
  return b;
}

// ---------------------------------------------------------------------------
// EngineClient
// ---------------------------------------------------------------------------
export interface EngineEndpoints { command: string; publish: string; health: string; }

export declare interface EngineClient {
  on(e: 'fill', l: (f: Fill) => void): this;
  on(e: 'ack', l: (a: unknown) => void): this;
  on(e: 'l2', l: (d: LevelDelta[]) => void): this;
  on(e: 'trade', l: (t: unknown) => void): this;
  on(e: 'account', l: (a: unknown) => void): this;
  on(e: 'matchEnd', l: (r: unknown) => void): this;
  on(e: 'gap', l: (info: { topic: string; expected: bigint; got: bigint }) => void): this;
  on(e: 'error', l: (err: Error) => void): this;
}

export class EngineClient extends EventEmitter {
  private readonly dealer = new Dealer();
  private readonly sub = new Subscriber();
  private readonly req = new Request();
  private outSeq = 0n;
  private readonly lastSeq = new Map<string, bigint>();
  private closed = false;

  constructor(
    private readonly matchId: bigint,
    private readonly endpoints: EngineEndpoints,
    private readonly seats: number[],
  ) { super(); }

  async connect(): Promise<void> {
    // Bounded HWM on the command path: we would rather reject a player's order
    // with a clear error than queue it unboundedly and fill it at a stale price.
    this.dealer.sendHighWaterMark = 4096;
    this.dealer.sendTimeout = 50;
    this.dealer.linger = 0;
    this.dealer.connect(this.endpoints.command);

    this.sub.receiveHighWaterMark = 65536;
    this.sub.linger = 0;
    this.sub.connect(this.endpoints.publish);
    this.sub.subscribe(TOPIC_L2 as unknown as string);
    this.sub.subscribe(TOPIC_TRADES as unknown as string);
    this.sub.subscribe(TOPIC_SYS as unknown as string);
    for (const seat of this.seats) this.sub.subscribe(topicExec(seat) as unknown as string);

    this.req.connect(this.endpoints.health);

    void this.pumpSub();
    void this.pumpDealer();
  }

  // -- outbound -------------------------------------------------------------
  async sendNewOrder(o: {
    clientOrdId: bigint; clientId: number; price: number; qty: number;
    type: OrderType; side: Side; tif: TimeInForce;
  }): Promise<void> {
    const body = Buffer.alloc(40);
    body.writeBigUInt64LE(o.clientOrdId, 0);
    body.writeUInt32LE(o.clientId, 8);
    body.writeBigInt64LE(BigInt(o.price), 16);
    body.writeBigInt64LE(BigInt(o.qty), 24);
    body.writeUInt8(o.type, 32);
    body.writeUInt8(o.side, 33);
    body.writeUInt8(o.tif, 34);
    await this.send(MsgType.CmdNewOrder, body, 1);
  }

  async arm(scenarioBlob: Buffer): Promise<void> {
    await this.send(MsgType.CtlArm, scenarioBlob, 1);
  }
  async start(): Promise<void> { await this.send(MsgType.CtlStart, Buffer.alloc(0), 0); }
  async finish(): Promise<void> { await this.send(MsgType.CtlFinish, Buffer.alloc(0), 0); }

  private async send(type: MsgType, body: Buffer, count: number): Promise<void> {
    const frame = Buffer.alloc(HEADER_SIZE + body.length);
    writeHeader(frame, type, body.length, count, this.matchId, this.outSeq++);
    body.copy(frame, HEADER_SIZE);
    try {
      await this.dealer.send(frame);
    } catch (err) {
      // sendTimeout fired => engine is wedged or the HWM is full. Surface it as
      // an order reject to the player rather than swallowing it.
      this.emit('error', new Error(`command send failed: ${(err as Error).message}`));
      throw err;
    }
  }

  // -- inbound --------------------------------------------------------------
  private async pumpSub(): Promise<void> {
    for await (const parts of this.sub) {
      if (this.closed) break;
      try {
        const key = parts[0].toString('ascii').replace(/\0+$/, '');
        const frame = parts[1];
        const hdr = readHeader(frame);
        this.checkGap(key, hdr.seq);
        this.dispatch(hdr, frame);
      } catch (err) {
        this.emit('error', err as Error);
      }
    }
  }

  private async pumpDealer(): Promise<void> {
    for await (const [frame] of this.dealer) {
      if (this.closed) break;
      try {
        const hdr = readHeader(frame);
        this.dispatch(hdr, frame);
      } catch (err) {
        this.emit('error', err as Error);
      }
    }
  }

  private checkGap(key: string, seq: bigint): void {
    const prev = this.lastSeq.get(key);
    if (prev !== undefined && seq !== prev + 1n) {
      this.emit('gap', { topic: key, expected: prev + 1n, got: seq });
      // Recovery: ask for a full snapshot, then resume applying deltas. Do not
      // try to interpolate — a wrong book is worse than a briefly stale one.
      void this.send(MsgType.CmdSnapshotReq, Buffer.alloc(0), 0).catch(() => {});
    }
    this.lastSeq.set(key, seq);
  }

  private dispatch(hdr: ParsedHeader, frame: Buffer): void {
    switch (hdr.type) {
      case MsgType.EvtFill: {
        for (let i = 0; i < hdr.count; i++) {
          this.emit('fill', decodeFill(frame, HEADER_SIZE + i * 56));
        }
        break;
      }
      case MsgType.EvtL2Delta:
      case MsgType.EvtL2Snapshot: {
        const deltas: LevelDelta[] = [];
        for (let i = 0; i < hdr.count; i++) {
          deltas.push(decodeLevelDelta(frame, HEADER_SIZE + i * 24));
        }
        this.emit('l2', deltas);
        break;
      }
      case MsgType.EvtAck: this.emit('ack', frame.subarray(HEADER_SIZE)); break;
      case MsgType.EvtTradePrint: this.emit('trade', frame.subarray(HEADER_SIZE)); break;
      case MsgType.EvtAccount: this.emit('account', frame.subarray(HEADER_SIZE)); break;
      case MsgType.EvtMatchEnd: this.emit('matchEnd', frame.subarray(HEADER_SIZE)); break;
      default: break;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dealer.close();
    this.sub.close();
    this.req.close();
  }
}
