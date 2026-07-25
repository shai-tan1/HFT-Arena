/**
 * backend/src/sim/catalog.ts — the content the game ships with.
 *
 * This mirrors db/seeds/001_content.sql exactly, and holding the same content
 * in two places is a deliberate trade, not an oversight: it means the server
 * boots and a match is playable with no database at all, which keeps the
 * feedback loop on gameplay tuning to a single file save. The Postgres rows are
 * the durable record; this is the bootstrap. If they drift, the seed file wins
 * — reconcile by re-running it, not by editing rows.
 */

import type { SimInstrument } from './engine';
import type { ScenarioSpec } from './scenario';
import type { DrillSummary } from '../../../shared/src/protocol';

export const STARTING_CASH = 100_000_000_000; // $100,000.00 in micros

export const INSTRUMENTS: Record<number, SimInstrument> = {
  1: {
    instrumentId: 1, symbol: 'SYNTH-A', tickFloor: 4000, numLevels: 12000,
    tickValueMicros: 10000, lotSize: 1, maxOrderQty: 2000,
    marginBpsLong: 2000, marginBpsShort: 3000, allowShort: true,
    displayPrecision: 2, feeBpsTaker: 3, feeBpsMaker: -1,
  },
  2: {
    instrumentId: 2, symbol: 'VOLT-X', tickFloor: 2000, numLevels: 16000,
    tickValueMicros: 10000, lotSize: 1, maxOrderQty: 1500,
    marginBpsLong: 3000, marginBpsShort: 4500, allowShort: true,
    displayPrecision: 2, feeBpsTaker: 4, feeBpsMaker: -1,
  },
  3: {
    instrumentId: 3, symbol: 'CALM-1', tickFloor: 6000, numLevels: 8000,
    tickValueMicros: 10000, lotSize: 1, maxOrderQty: 2500,
    marginBpsLong: 1500, marginBpsShort: 2000, allowShort: true,
    displayPrecision: 2, feeBpsTaker: 2, feeBpsMaker: -1,
  },
};

export const SCENARIOS: Record<number, ScenarioSpec> = {
  1: {
    id: 1, label: 'Quiet Open', difficulty: 2, instrumentId: 3,
    seedHi: 1001n, seedLo: 20250724n, scenarioVersion: 1, openPrice: 10000,
    timeline: [{ regime: 'Calm', durationMs: 180000, intensity: 30 }],
    agents: [
      { kind: 'MarketMaker', count: 4, meanInterarrivalMs: 120, sizeMin: 20, sizeMax: 80, spreadTicks: 2, inventoryLimit: 400 },
      { kind: 'NoiseTrader', count: 6, meanInterarrivalMs: 900, sizeMin: 1, sizeMax: 12 },
      { kind: 'MeanReversion', count: 2, meanInterarrivalMs: 1400, sizeMin: 5, sizeMax: 25 },
    ],
  },
  2: {
    id: 2, label: 'Trend Day', difficulty: 4, instrumentId: 1,
    seedHi: 2002n, seedLo: 20250724n, scenarioVersion: 1, openPrice: 10000,
    timeline: [
      { regime: 'Calm', durationMs: 45000, intensity: 35 },
      { regime: 'Trending', durationMs: 195000, intensity: 65 },
      { regime: 'Choppy', durationMs: 60000, intensity: 50 },
    ],
    agents: [
      { kind: 'MarketMaker', count: 3, meanInterarrivalMs: 140, sizeMin: 15, sizeMax: 60, spreadTicks: 2, inventoryLimit: 300 },
      { kind: 'NoiseTrader', count: 8, meanInterarrivalMs: 700, sizeMin: 1, sizeMax: 15 },
      { kind: 'Momentum', count: 3, meanInterarrivalMs: 1100, sizeMin: 10, sizeMax: 40, aggressionBps: 6000 },
    ],
  },
  3: {
    id: 3, label: 'Headline Risk', difficulty: 7, instrumentId: 2,
    seedHi: 3003n, seedLo: 20250724n, scenarioVersion: 1, openPrice: 10000,
    timeline: [
      { regime: 'Calm', durationMs: 40000, intensity: 40 },
      { regime: 'NewsSpike', durationMs: 15000, intensity: 90 },
      { regime: 'Volatile', durationMs: 120000, intensity: 80 },
      { regime: 'Choppy', durationMs: 65000, intensity: 60 },
    ],
    agents: [
      { kind: 'MarketMaker', count: 3, meanInterarrivalMs: 160, sizeMin: 8, sizeMax: 35, spreadTicks: 4, inventoryLimit: 200 },
      { kind: 'NoiseTrader', count: 10, meanInterarrivalMs: 500, sizeMin: 1, sizeMax: 20 },
      { kind: 'Sweeper', count: 2, meanInterarrivalMs: 4000, sizeMin: 40, sizeMax: 150, aggressionBps: 10000 },
    ],
  },
  4: {
    id: 4, label: 'Flash Crash', difficulty: 9, instrumentId: 2,
    seedHi: 4004n, seedLo: 20250724n, scenarioVersion: 1, openPrice: 10000,
    timeline: [
      { regime: 'Calm', durationMs: 30000, intensity: 30 },
      { regime: 'FlashCrash', durationMs: 25000, intensity: 100 },
      { regime: 'LiquidityGap', durationMs: 30000, intensity: 85 },
      { regime: 'Volatile', durationMs: 95000, intensity: 70 },
    ],
    agents: [
      { kind: 'MarketMaker', count: 2, meanInterarrivalMs: 200, sizeMin: 5, sizeMax: 25, spreadTicks: 6, inventoryLimit: 150 },
      { kind: 'NoiseTrader', count: 8, meanInterarrivalMs: 450, sizeMin: 1, sizeMax: 25 },
      { kind: 'Momentum', count: 4, meanInterarrivalMs: 800, sizeMin: 15, sizeMax: 60, aggressionBps: 8000 },
      { kind: 'Sweeper', count: 3, meanInterarrivalMs: 2500, sizeMin: 50, sizeMax: 200, aggressionBps: 10000 },
    ],
  },
  5: {
    id: 5, label: 'The Squeeze', difficulty: 6, instrumentId: 1,
    seedHi: 5005n, seedLo: 20250724n, scenarioVersion: 1, openPrice: 10000,
    timeline: [{ regime: 'Squeeze', durationMs: 240000, intensity: 75 }],
    agents: [
      { kind: 'MarketMaker', count: 3, meanInterarrivalMs: 150, sizeMin: 10, sizeMax: 45, spreadTicks: 3, inventoryLimit: 250 },
      { kind: 'NoiseTrader', count: 6, meanInterarrivalMs: 650, sizeMin: 1, sizeMax: 15 },
      { kind: 'Momentum', count: 5, meanInterarrivalMs: 900, sizeMin: 12, sizeMax: 50, aggressionBps: 7500 },
    ],
  },
  6: {
    id: 6, label: 'The Chop', difficulty: 5, instrumentId: 1,
    seedHi: 6006n, seedLo: 20250724n, scenarioVersion: 1, openPrice: 10000,
    timeline: [{ regime: 'Choppy', durationMs: 300000, intensity: 55 }],
    agents: [
      { kind: 'MarketMaker', count: 5, meanInterarrivalMs: 110, sizeMin: 25, sizeMax: 90, spreadTicks: 2, inventoryLimit: 500 },
      { kind: 'NoiseTrader', count: 9, meanInterarrivalMs: 600, sizeMin: 1, sizeMax: 18 },
      { kind: 'MeanReversion', count: 4, meanInterarrivalMs: 1000, sizeMin: 8, sizeMax: 35 },
    ],
  },
};

export const DRILLS: DrillSummary[] = [
  {
    id: 1, slug: 'first-fill', title: 'First Fill', subtitle: 'Learn the ladder',
    description: 'A quiet book with a tight spread. Get comfortable placing and cancelling limit orders, and finish without blowing up.',
    skillTag: 'fundamentals', difficulty: 1, durationMs: 120000, startingCash: STARTING_CASH,
    objectives: [
      { id: 'fills', kind: 'min_fills', target: 5, label: 'Complete 5 fills' },
      { id: 'survive', kind: 'min_pnl', target: -5_000_000, label: 'Lose less than $5' },
    ],
    starThresholds: [0, 25_000_000, 100_000_000], xpReward: 100, unlockLevel: 1,
    scenarioLabel: 'Quiet Open',
  },
  {
    id: 2, slug: 'passive-edge', title: 'Passive Edge', subtitle: 'Earn the spread',
    description: 'The spread is your paycheck. Quote both sides, get filled as a maker, and let the noise traders pay you. Taking liquidity here is how you lose.',
    skillTag: 'passive_execution', difficulty: 3, durationMs: 180000, startingCash: STARTING_CASH,
    objectives: [
      { id: 'maker', kind: 'min_maker_ratio_bps', target: 7000, label: '70% of fills as maker' },
      { id: 'pnl', kind: 'min_pnl', target: 50_000_000, label: 'Finish up $50' },
    ],
    starThresholds: [50_000_000, 150_000_000, 400_000_000], xpReward: 200, unlockLevel: 1,
    scenarioLabel: 'Quiet Open',
  },
  {
    id: 3, slug: 'ride-the-trend', title: 'Ride The Trend', subtitle: 'Stop fading strength',
    description: 'A persistent one-way drift. The instinct to fade an extended move is exactly what this drill is built to punish.',
    skillTag: 'directional', difficulty: 4, durationMs: 300000, startingCash: STARTING_CASH,
    objectives: [
      { id: 'pnl', kind: 'min_pnl', target: 100_000_000, label: 'Finish up $100' },
      { id: 'dd', kind: 'max_drawdown', target: 200_000_000, label: 'Keep drawdown under $200' },
    ],
    starThresholds: [100_000_000, 350_000_000, 800_000_000], xpReward: 250, unlockLevel: 2,
    scenarioLabel: 'Trend Day',
  },
  {
    id: 4, slug: 'chop-discipline', title: 'Chop Discipline', subtitle: 'Do less',
    description: 'Mean-reverting noise with no trend to catch. Overtrading a range is the most expensive habit in the game — the winning move is usually fewer moves.',
    skillTag: 'risk', difficulty: 5, durationMs: 300000, startingCash: STARTING_CASH,
    objectives: [
      { id: 'pnl', kind: 'min_pnl', target: 0, label: 'Finish flat or better' },
      { id: 'pos', kind: 'max_position', target: 150, label: 'Never exceed 150 lots' },
    ],
    starThresholds: [0, 120_000_000, 300_000_000], xpReward: 300, unlockLevel: 3,
    scenarioLabel: 'The Chop',
  },
  {
    id: 5, slug: 'headline-risk', title: 'Headline Risk', subtitle: 'Survive the gap',
    description: 'A news print reprices the book through several levels with no warning. Your resting orders will be run over. Manage the aftermath.',
    skillTag: 'tape_reading', difficulty: 7, durationMs: 240000, startingCash: STARTING_CASH,
    objectives: [
      { id: 'pnl', kind: 'min_pnl', target: 0, label: 'Finish flat or better' },
      { id: 'dd', kind: 'max_drawdown', target: 500_000_000, label: 'Keep drawdown under $500' },
    ],
    starThresholds: [0, 200_000_000, 600_000_000], xpReward: 400, unlockLevel: 4,
    scenarioLabel: 'Headline Risk',
  },
  {
    id: 6, slug: 'the-squeeze', title: 'The Squeeze', subtitle: 'Shorts get carried out',
    description: 'A grinding advance with no pullback to cover into. Every level looks like the top. None of them are.',
    skillTag: 'risk', difficulty: 6, durationMs: 240000, startingCash: STARTING_CASH,
    objectives: [{ id: 'pnl', kind: 'min_pnl', target: 50_000_000, label: 'Finish up $50' }],
    starThresholds: [0, 200_000_000, 500_000_000], xpReward: 350, unlockLevel: 4,
    scenarioLabel: 'The Squeeze',
  },
  {
    id: 7, slug: 'flash-crash', title: 'Flash Crash', subtitle: 'The book disappears',
    description: 'A liquidity cascade followed by a partial recovery. The bid vanishes, then comes back thinner. The whole drill is one decision made under time pressure.',
    skillTag: 'risk', difficulty: 9, durationMs: 180000, startingCash: STARTING_CASH,
    objectives: [
      { id: 'pnl', kind: 'min_pnl', target: -50_000_000, label: 'Lose less than $50' },
      { id: 'dd', kind: 'max_drawdown', target: 800_000_000, label: 'Keep drawdown under $800' },
    ],
    starThresholds: [-50_000_000, 100_000_000, 500_000_000], xpReward: 600, unlockLevel: 6,
    scenarioLabel: 'Flash Crash',
  },
];

/** drill slug -> scenario id. Kept next to DRILLS so a new drill is one edit. */
export const DRILL_SCENARIO: Record<string, number> = {
  'first-fill': 1,
  'passive-edge': 1,
  'ride-the-trend': 2,
  'chop-discipline': 6,
  'headline-risk': 3,
  'the-squeeze': 5,
  'flash-crash': 4,
};

export function drillBySlug(slug: string): DrillSummary | undefined {
  return DRILLS.find((d) => d.slug === slug);
}

/**
 * Ranked PvP picks from the mid-difficulty pool. A ranked match should test
 * execution, not luck — Flash Crash is a great drill and a terrible ladder game,
 * because at that volatility the variance swamps the skill difference the ELO
 * update is trying to measure.
 */
export const RANKED_POOL = [2, 5, 6, 1];

/** A fresh seed per match, so ranked play cannot be memorised. */
export function withFreshSeed(spec: ScenarioSpec, seedHi: bigint, seedLo: bigint): ScenarioSpec {
  return { ...spec, seedHi, seedLo };
}
