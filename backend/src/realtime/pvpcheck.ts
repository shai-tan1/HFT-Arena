/**
 * backend/src/realtime/pvpcheck.ts — end-to-end check of the mirrored-book claim.
 *
 * Run against a live server with `npm run pvp:check`.
 *
 * The whole PvP design rests on one assertion that is easy to state and easy to
 * break silently:
 *
 *   Two seats in the same match see the SAME market until one of them trades,
 *   and after that, one seat's orders affect ONLY that seat's book.
 *
 * Break the first half and the match is unfair. Break the second half and it is
 * not mirrored at all — it is a shared book with extra steps, and every
 * fairness and replay guarantee built on top evaporates. Neither failure is
 * visible by looking at the screen, because both produce a plausible-looking
 * market. So it gets a test.
 */

import { WebSocket } from 'ws';
import { Side, OrderType, TimeInForce, type ServerMsg, type MatchFrame, type Candle } from '../../../shared/src/protocol';

const URL = process.env.WS_URL ?? 'ws://localhost:4000/ws';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(ok
    ? `  \x1b[32mPASS\x1b[0m  ${name}`
    : `  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures++;
}

interface Seat {
  ws: WebSocket;
  handle: string;
  matchId?: string;
  scenario?: string;
  seat?: number;
  frames: MatchFrame[];
  opponentHandle?: string;
  started: boolean;
}

function connect(): Promise<Seat> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s: Seat = { ws, handle: '', frames: [], started: false };
    const timer = setTimeout(() => reject(new Error('hello timed out')), 8000);

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      switch (msg.t) {
        case 'hello.ok':
          s.handle = msg.handle;
          clearTimeout(timer);
          resolve(s);
          break;
        case 'match.arm':
          s.matchId = msg.matchId;
          s.scenario = msg.scenario.label;
          s.seat = msg.seat;
          s.opponentHandle = msg.opponent?.handle;
          break;
        case 'match.start':
          s.started = true;
          break;
        case 'frame':
          s.frames.push(msg);
          break;
      }
    });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })));
  });
}

const send = (s: Seat, msg: unknown) => s.ws.send(JSON.stringify(msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compare the closed-candle series on the buckets both seats have published. */
function compareCandles(a: Candle[], b: Candle[]): { common: number; mismatches: number; first?: string } {
  const byT = new Map(b.map((c) => [c.t, c]));
  let common = 0;
  let mismatches = 0;
  let first: string | undefined;
  for (const ca of a) {
    const cb = byT.get(ca.t);
    if (!cb) continue;
    common++;
    if (ca.o !== cb.o || ca.h !== cb.h || ca.l !== cb.l || ca.c !== cb.c) {
      mismatches++;
      first ??= `t=${ca.t} A=${ca.o}/${ca.h}/${ca.l}/${ca.c} B=${cb.o}/${cb.h}/${cb.l}/${cb.c}`;
    }
  }
  return { common, mismatches, first };
}

async function main() {
  console.log('\nHFT Arena — PvP mirrored-book check\n');

  const a = await connect();
  const b = await connect();
  console.log(`  seats: ${a.handle} vs ${b.handle}\n`);

  // A private lobby lets the check pick a 60s match instead of waiting out the
  // 3-minute casual default.
  let code = '';
  a.ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMsg;
    if (msg.t === 'lobby.state') code = msg.code;
  });
  send(a, { t: 'lobby.create', durationMs: 60_000, scenarioId: 2 });
  await sleep(500);
  send(b, { t: 'lobby.join', code });
  await sleep(400);
  send(a, { t: 'lobby.ready', ready: true });
  send(b, { t: 'lobby.ready', ready: true });

  console.log('1. Pairing');
  await sleep(1200);
  check('both seats armed into a match', !!a.matchId && !!b.matchId, `a=${a.matchId} b=${b.matchId}`);
  check('same match id', a.matchId === b.matchId, `${a.matchId} vs ${b.matchId}`);
  check('same scenario', a.scenario === b.scenario, `${a.scenario} vs ${b.scenario}`);
  check('distinct seats', a.seat !== b.seat, `${a.seat} vs ${b.seat}`);
  check('each sees the other as opponent',
    a.opponentHandle === b.handle && b.opponentHandle === a.handle,
    `a sees ${a.opponentHandle}, b sees ${b.opponentHandle}`);

  // Wait out the countdown, then run untouched for a few seconds.
  console.log('\n2. Identical market while neither seat trades');
  await sleep(5500);
  a.frames.length = 0;
  b.frames.length = 0;
  await sleep(6000);

  check('both seats are receiving frames', a.frames.length > 20 && b.frames.length > 20,
    `a=${a.frames.length} b=${b.frames.length}`);

  const aCandles = a.frames.flatMap((f) => f.closedCandles);
  const bCandles = b.frames.flatMap((f) => f.closedCandles);
  const clean = compareCandles(aCandles, bCandles);
  check('closed candles match bucket for bucket',
    clean.common > 2 && clean.mismatches === 0,
    `${clean.common} common buckets, ${clean.mismatches} mismatched. ${clean.first ?? ''}`);
  console.log(`        (${clean.common} shared 1s buckets compared)`);

  // ---- the mirroring property -------------------------------------------
  console.log('\n3. One seat trading does NOT move the other seat\'s book');
  const beforeB = b.frames[b.frames.length - 1];

  // Seat A sweeps the book hard, repeatedly. If the seats shared a book this
  // would visibly move B's price.
  for (let i = 0; i < 12; i++) {
    send(a, {
      t: 'order.new', cid: 1000 + i,
      side: Side.Buy, type: OrderType.Market, tif: TimeInForce.IOC,
      price: 0, qty: 150,
    });
    await sleep(120);
  }
  await sleep(1500);

  const afterA = a.frames[a.frames.length - 1];
  const afterB = b.frames[b.frames.length - 1];

  check('the trading seat took on a position',
    afterA.account.position > 0, `position=${afterA.account.position}`);
  check('the trading seat paid for the aggression',
    afterA.account.equity < beforeB.account.equity,
    `equity=${afterA.account.equity}`);
  check('the other seat is still flat', afterB.account.position === 0,
    `position=${afterB.account.position}`);
  check('the other seat sees no orders it did not place',
    afterB.openOrders.length === 0, `${afterB.openOrders.length} orders`);

  // The books must now DIFFER — A ate liquidity, B did not. Sameness here would
  // mean the orders never reached a book at all.
  const aDepth = afterA.book.asks.reduce((s, l) => s + l.qty, 0);
  const bDepth = afterB.book.asks.reduce((s, l) => s + l.qty, 0);
  check('the swept book differs from the untouched one',
    afterA.book.bestAsk !== afterB.book.bestAsk || aDepth !== bDepth,
    `A ask=${afterA.book.bestAsk} depth=${aDepth}; B ask=${afterB.book.bestAsk} depth=${bDepth}`);
  console.log(`        (A best ask ${afterA.book.bestAsk} / ${aDepth} lots, B ${afterB.book.bestAsk} / ${bDepth} lots)`);

  console.log('\n4. Opponent view');
  check('the untouched seat sees its opponent\'s position',
    (afterB.opponent?.position ?? 0) > 0, `saw ${afterB.opponent?.position}`);
  check('the untouched seat sees its opponent\'s P&L move',
    (afterB.opponent?.pnl ?? 0) !== 0, `saw ${afterB.opponent?.pnl}`);
  check('opponent view never leaks their working orders',
    !('openOrders' in (afterB.opponent ?? {})));

  send(a, { t: 'match.leave' });
  send(b, { t: 'match.leave' });
  a.ws.close();
  b.ws.close();

  console.log(failures === 0
    ? '\n\x1b[32mAll checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mCheck aborted:\x1b[0m', err.message);
  console.error('Is the backend running? `npm run dev` in backend/');
  process.exit(1);
});
