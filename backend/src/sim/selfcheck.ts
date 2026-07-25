/**
 * backend/src/sim/selfcheck.ts — determinism and accounting checks.
 *
 * Run with `npm run sim:check`. This is not a substitute for the GTest matrix
 * spec'd in docs/ARCHITECTURE.md §2.6 — it is the smallest set of assertions
 * that would have caught the bugs this engine has actually had:
 *
 *   1. Mirrored determinism. Same seed, same state hash, bit for bit. This is
 *      the property the entire PvP fairness argument rests on.
 *   2. Seed sensitivity. Different seed, different hash. Without this, check 1
 *      would also pass on an engine that ignores its seed entirely.
 *   3. No rounding drift. The C++ skeleton truncated a division in the micro
 *      price and manufactured a phantom 1.2% downtrend out of pure rounding.
 *      A flat market must stay flat.
 *   4. Accounting closure. Equity has to equal starting cash plus realized plus
 *      unrealized minus fees, at every point, or the scoreboard is fiction.
 *   5. Margin persistence. An open position must still hold margin after the
 *      fill that opened it — the gap flagged in skeleton/README.md.
 */

import { MatchEngine, MS } from './engine';
import { INSTRUMENTS, SCENARIOS, STARTING_CASH } from './catalog';
import { Side, OrderType, TimeInForce, RejectReason } from '../../../shared/src/protocol';
import type { ScenarioSpec } from './scenario';

const HUMAN = 1;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function run(spec: ScenarioSpec, ms: number, stepMs = 50): MatchEngine {
  const engine = new MatchEngine(INSTRUMENTS[spec.instrumentId], spec, [HUMAN], STARTING_CASH);
  engine.arm();
  engine.start();
  for (let t = stepMs; t <= ms; t += stepMs) engine.stepTo(t * MS);
  return engine;
}

console.log('\nHFT Arena — simulation self-check\n');

// ---------------------------------------------------------------------------
console.log('1. Mirrored determinism');
{
  const spec = SCENARIOS[2];
  const a = run(spec, 30_000);
  const b = run(spec, 30_000);
  check('same seed produces an identical state hash',
    a.stateHash() === b.stateHash(),
    `a=${a.stateHash().toString(16)} b=${b.stateHash().toString(16)}`);
  check('same seed produces an identical PRNG draw count',
    a.totalDraws() === b.totalDraws(),
    `a=${a.totalDraws()} b=${b.totalDraws()}`);
  check('same seed produces an identical fair value',
    a.fairValue() === b.fairValue(),
    `a=${a.fairValue()} b=${b.fairValue()}`);
}

// ---------------------------------------------------------------------------
console.log('\n2. Seed sensitivity');
{
  const a = run(SCENARIOS[2], 30_000);
  const b = run({ ...SCENARIOS[2], seedLo: 99999n }, 30_000);
  check('a different seed diverges', a.stateHash() !== b.stateHash());
}

// ---------------------------------------------------------------------------
console.log('\n3. No rounding drift in a flat market');
{
  // Calm has zero drift. Over 120 simulated seconds the price should wander,
  // but its expectation must stay near the open. A systematic one-way move here
  // is a rounding bug wearing a market regime as a costume.
  const flat: ScenarioSpec = {
    ...SCENARIOS[1],
    timeline: [{ regime: 'Calm', durationMs: 120_000, intensity: 20 }],
  };
  let worst = 0;
  let sum = 0;
  let sumAbs = 0;
  const trials = 12;
  for (let i = 0; i < trials; i++) {
    const e = run({ ...flat, seedLo: BigInt(1000 + i * 7919) }, 120_000);
    const drift = e.fairValue() - flat.openPrice;
    sum += drift;
    sumAbs += Math.abs(drift);
    worst = Math.max(worst, Math.abs(drift));
  }
  const meanDrift = sum / trials;
  const meanWander = sumAbs / trials;

  // A market that never moves would pass a bias test trivially, which is how
  // the original version of this check reported a clean PASS on a completely
  // motionless price. Assert motion FIRST, then assert the motion is unbiased.
  check('a calm market still moves', meanWander >= 4,
    `mean |drift| = ${meanWander.toFixed(1)} ticks over 120s — the price is frozen`);
  check('and its drift is not systematic',
    Math.abs(meanDrift) < meanWander * 0.75,
    `mean=${meanDrift.toFixed(1)} ticks vs mean|drift|=${meanWander.toFixed(1)}`);
  console.log(`        (mean ${meanDrift.toFixed(1)}, mean |drift| ${meanWander.toFixed(1)}, max ${worst} ticks over ${trials} seeds)`);
}

// ---------------------------------------------------------------------------
console.log('\n3b. A trending regime actually trends');
{
  // Direction is drawn per segment, so the test is that the move is LARGE, not
  // that it is up. Averaging signed moves across seeds would correctly cancel
  // to zero and prove nothing.
  let sumAbs = 0;
  const trials = 8;
  for (let i = 0; i < trials; i++) {
    const spec: ScenarioSpec = {
      ...SCENARIOS[2],
      seedLo: BigInt(500 + i * 104729),
      timeline: [{ regime: 'Trending', durationMs: 120_000, intensity: 70 }],
    };
    sumAbs += Math.abs(run(spec, 120_000).fairValue() - spec.openPrice);
  }
  const mean = sumAbs / trials;
  check('trending moves further than calm', mean > 60,
    `mean |move| = ${mean.toFixed(1)} ticks over 120s`);
  console.log(`        (mean |move| ${mean.toFixed(1)} ticks = $${(mean / 100).toFixed(2)} over 120s)`);
}

// ---------------------------------------------------------------------------
console.log('\n4. Matching and accounting');
{
  const spec = SCENARIOS[1];
  const inst = INSTRUMENTS[spec.instrumentId];
  const engine = new MatchEngine(inst, spec, [HUMAN], STARTING_CASH);
  engine.arm();
  engine.start();
  engine.stepTo(1000 * MS);

  const before = engine.accountState(HUMAN);
  check('flat account starts at exactly the starting cash',
    before.equity === STARTING_CASH && before.position === 0,
    `equity=${before.equity} position=${before.position}`);

  // Buy 10 lots at market.
  const buy = engine.submit(HUMAN, {
    clientOrdId: 1, side: Side.Buy, type: OrderType.Market,
    tif: TimeInForce.IOC, price: 0, qty: 10,
  });
  check('market buy is accepted', buy.reject === RejectReason.None, `reject=${buy.reject}`);

  const afterBuy = engine.accountState(HUMAN);
  check('position reflects the fill', afterBuy.position === 10, `position=${afterBuy.position}`);
  check('open position still holds margin (the skeleton\'s known gap)',
    afterBuy.reservedMargin > 0, `reserved=${afterBuy.reservedMargin}`);

  const expectedMargin = Math.round(
    (afterBuy.avgEntryMicros * 10 * inst.marginBpsLong) / 10000,
  );
  check('position margin is within 5% of notional x marginBps',
    Math.abs(afterBuy.reservedMargin - expectedMargin) < expectedMargin * 0.05 + 1000,
    `reserved=${afterBuy.reservedMargin} expected~${expectedMargin}`);

  check('equity closes: cash + unrealized',
    afterBuy.equity === afterBuy.cash + afterBuy.unrealizedPnl,
    `${afterBuy.equity} vs ${afterBuy.cash + afterBuy.unrealizedPnl}`);

  // Sell it back — position must return to flat and unrealized must vanish.
  engine.stepTo(2000 * MS);
  engine.submit(HUMAN, {
    clientOrdId: 2, side: Side.Sell, type: OrderType.Market,
    tif: TimeInForce.IOC, price: 0, qty: 10,
  });
  const flatAgain = engine.accountState(HUMAN);
  check('round trip returns to flat', flatAgain.position === 0, `position=${flatAgain.position}`);
  check('flat means no unrealized', flatAgain.unrealizedPnl === 0);
  check('flat releases position margin', flatAgain.reservedMargin === 0,
    `reserved=${flatAgain.reservedMargin}`);
  check('crossing the spread twice costs money',
    flatAgain.equity < STARTING_CASH,
    `equity=${flatAgain.equity} start=${STARTING_CASH}`);
  console.log(`        (round-trip cost ${((STARTING_CASH - flatAgain.equity) / 1e6).toFixed(4)} dollars)`);
}

// ---------------------------------------------------------------------------
console.log('\n5. Order type semantics');
{
  const spec = SCENARIOS[1];
  const engine = new MatchEngine(INSTRUMENTS[spec.instrumentId], spec, [HUMAN], STARTING_CASH);
  engine.arm();
  engine.start();
  engine.stepTo(1000 * MS);

  const snap = engine.bookSnapshot(HUMAN);
  const bestAsk = snap.bestAsk!;
  const bestBid = snap.bestBid!;

  const crossing = engine.submit(HUMAN, {
    clientOrdId: 10, side: Side.Buy, type: OrderType.Limit,
    tif: TimeInForce.PostOnly, price: bestAsk, qty: 1,
  });
  check('post-only that would cross is rejected',
    crossing.reject === RejectReason.PostOnlyWouldCross, `reject=${crossing.reject}`);

  const resting = engine.submit(HUMAN, {
    clientOrdId: 11, side: Side.Buy, type: OrderType.Limit,
    tif: TimeInForce.PostOnly, price: bestBid - 5, qty: 3,
  });
  check('post-only inside the book rests', resting.reject === RejectReason.None);
  check('resting order appears in open orders',
    engine.openOrders(HUMAN).some((o) => o.orderId === resting.orderId));

  const heldBefore = engine.accountState(HUMAN).reservedMargin;
  engine.cancel(HUMAN, resting.orderId);
  check('cancel removes the order', engine.openOrders(HUMAN).length === 0);
  check('cancel releases the order margin',
    engine.accountState(HUMAN).reservedMargin < heldBefore || heldBefore === 0,
    `before=${heldBefore} after=${engine.accountState(HUMAN).reservedMargin}`);

  const fok = engine.submit(HUMAN, {
    clientOrdId: 12, side: Side.Buy, type: OrderType.Limit,
    tif: TimeInForce.FOK, price: bestAsk, qty: 1_000_000,
  });
  check('unfillable FOK is rejected without touching the book',
    fok.reject === RejectReason.QtyAboveLimit || fok.reject === RejectReason.FokUnfillable,
    `reject=${fok.reject}`);

  const tooBig = engine.submit(HUMAN, {
    clientOrdId: 13, side: Side.Buy, type: OrderType.Market,
    tif: TimeInForce.IOC, price: 0, qty: 999_999,
  });
  check('fat-finger guard fires', tooBig.reject === RejectReason.QtyAboveLimit);

  const offTick = engine.submit(HUMAN, {
    clientOrdId: 14, side: Side.Buy, type: OrderType.Limit,
    tif: TimeInForce.GTC, price: 1, qty: 1,
  });
  check('price outside the band is rejected', offTick.reject === RejectReason.PriceOutOfBand);
}

// ---------------------------------------------------------------------------
console.log('\n6. Market character actually differs by regime');
{
  /**
   * Spread is sampled across the whole run, not read once at the end.
   *
   * The first version of this check compared a single instantaneous spread and
   * failed on a working engine: at any given microsecond the aggregate spread
   * is one tick surprisingly often, because a market maker mid-requote has
   * pulled one side while a neighbour's stale quote still sits there. The
   * regime property is about the DISTRIBUTION, so the assertion has to be too.
   */
  function meanSpread(regime: 'Calm' | 'Volatile', intensity: number): { mean: number; p90: number } {
    const spec: ScenarioSpec = {
      ...SCENARIOS[1],
      timeline: [{ regime, durationMs: 60_000, intensity }],
    };
    const engine = new MatchEngine(INSTRUMENTS[spec.instrumentId], spec, [HUMAN], STARTING_CASH);
    engine.arm();
    engine.start();
    const samples: number[] = [];
    for (let t = 50; t <= 60_000; t += 50) {
      engine.stepTo(t * MS);
      if (t % 500 !== 0) continue;
      const s = engine.bookSnapshot(HUMAN);
      if (s.bestBid !== null && s.bestAsk !== null) samples.push(s.bestAsk - s.bestBid);
    }
    samples.sort((a, b) => a - b);
    return {
      mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      p90: samples[Math.floor(samples.length * 0.9)],
    };
  }

  const calm = meanSpread('Calm', 30);
  const wild = meanSpread('Volatile', 90);
  check('volatile quotes wider than calm on average', wild.mean > calm.mean * 1.5,
    `calm mean=${calm.mean.toFixed(2)} volatile mean=${wild.mean.toFixed(2)}`);
  check('volatile has a fatter spread tail', wild.p90 > calm.p90,
    `calm p90=${calm.p90} volatile p90=${wild.p90}`);
  console.log(`        (calm mean ${calm.mean.toFixed(2)} / p90 ${calm.p90}, volatile mean ${wild.mean.toFixed(2)} / p90 ${wild.p90})`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? '\n\x1b[32mAll checks passed.\x1b[0m\n'
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
