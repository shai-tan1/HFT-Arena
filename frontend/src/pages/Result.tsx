/**
 * Result — the post-match screen.
 *
 * This page is the product's actual teaching surface. A scoreboard tells you
 * that you lost; this is where you find out why. The three things it has to
 * answer, in order:
 *
 *   1. Did I win, and by how much.
 *   2. Where did the P&L come from — maker or taker, and at what drawdown.
 *   3. What did the market do around my fills.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMatch } from '@/state/match';
import { useSession } from '@/state/session';
import { PriceChart } from '@/components/trade/PriceChart';
import { EquityRace } from '@/components/trade/EquityRace';
import { FillBlotter } from '@/components/trade/panels';
import { formatMoney, formatCompactMoney } from '@shared/protocol';

export function Result() {
  const navigate = useNavigate();
  const result = useMatch((s) => s.result);
  const arm = useMatch((s) => s.arm);
  const reset = useMatch((s) => s.reset);
  const refresh = useSession((s) => s.refresh);

  useEffect(() => { void refresh(); }, []);

  if (!result || !arm) {
    return (
      <div className="page narrow">
        <div className="panel"><div className="panel-body">
          <p className="dim">No recent match.</p>
          <button className="btn btn-primary" onClick={() => navigate('/play')}>Play</button>
        </div></div>
      </div>
    );
  }

  const me = result.seats[result.yourSeat];
  const opp = result.seats.find((s) => s.seat !== result.yourSeat);
  const pnl = me.finalEquity - me.startingCash;
  const isPvp = !!opp;
  const won = me.result === 'win';
  const drew = me.result === 'draw';
  const makerBps = me.fills > 0 ? Math.round((me.makerFills * 10000) / me.fills) : 0;
  const eloDelta = (me.eloAfter ?? 0) - (me.eloBefore ?? 0);
  const precision = arm.instrument.displayPrecision;

  return (
    <div className="page">
      <div className={`verdict ${isPvp ? (won ? 'v-win' : drew ? 'v-draw' : 'v-loss') : pnl >= 0 ? 'v-win' : 'v-loss'}`}>
        <div className="verdict-main">
          <h1>
            {isPvp
              ? won ? 'VICTORY' : drew ? 'DRAW' : 'DEFEAT'
              : pnl >= 0 ? 'RUN COMPLETE' : 'RUN COMPLETE'}
          </h1>
          <div className={`verdict-pnl num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
            {formatMoney(pnl, { sign: pnl > 0 })}
          </div>
          <span className="faint">{arm.scenario.label} · {Math.round(arm.durationMs / 1000)}s</span>
        </div>

        {isPvp && (
          <div className="verdict-elo">
            <span className="label">Rating</span>
            <div className="num verdict-elo-v">
              {me.eloBefore} <span className={eloDelta >= 0 ? 'up' : 'down'}>
                {eloDelta >= 0 ? '+' : ''}{eloDelta}
              </span>
            </div>
            <span className="faint">→ {me.eloAfter}</span>
          </div>
        )}
      </div>

      {result.drillResult && (
        <div className="panel drill-result">
          <div className="panel-head"><span>Drill objectives</span></div>
          <div className="panel-body">
            <div className="drill-stars">
              {[0, 1, 2].map((i) => (
                <span key={i} className={i < result.drillResult!.stars ? 'star big on' : 'star big'}>★</span>
              ))}
              <span className="dim">+{result.drillResult.xpAwarded} XP</span>
            </div>
            <div className="stack gap-8">
              {result.drillResult.objectives.map((o) => (
                <div key={o.id} className={`obj-row ${o.met ? 'met' : 'unmet'}`}>
                  <span className="obj-mark">{o.met ? '✓' : '✕'}</span>
                  <span className="obj-label">{o.label}</span>
                  <span className="num obj-val">
                    {formatObjective(o.id, o.value)} <span className="faint">/ {formatObjective(o.id, o.target)}</span>
                  </span>
                </div>
              ))}
            </div>
            {result.drillResult.stars === 0 && result.drillResult.objectives.some((o) => !o.met) && (
              <p className="faint" style={{ marginBottom: 0 }}>
                Stars need every objective cleared. A drill you passed on P&amp;L
                while ignoring what it was teaching is not a pass.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="result-grid">
        <div className="panel">
          <div className="panel-head"><span>P&amp;L curve</span></div>
          <EquityRace
            height={200}
            durationMs={arm.durationMs}
            curves={result.equityCurves.map((c) => ({
              label: result.seats[c.seat]?.handle ?? `Seat ${c.seat}`,
              color: c.seat === result.yourSeat ? '#22d3ee' : '#a855f7',
              points: c.points,
              baseline: result.seats[c.seat]?.startingCash ?? arm.startingCash,
            }))}
          />
          {isPvp && (
            <div className="panel-body row gap-16" style={{ paddingTop: 0 }}>
              <span className="chip chip-cyan">You</span>
              <span className="chip chip-violet">{opp!.handle}</span>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><span>Your market</span></div>
          <PriceChart
            candles={result.candles}
            current={null}
            fills={result.fills}
            precision={precision}
            height={200}
          />
        </div>
      </div>

      <div className="result-grid">
        <div className="panel">
          <div className="panel-head"><span>Breakdown</span></div>
          <div className="panel-body">
            <div className="stats-grid">
              <Row label="Realized" value={formatMoney(me.realizedPnl, { sign: me.realizedPnl > 0 })} />
              <Row label="Unrealized at bell" value={formatMoney(me.unrealizedPnl, { sign: me.unrealizedPnl > 0 })} />
              <Row label="Fills" value={String(me.fills)} />
              <Row label="Maker ratio" value={`${(makerBps / 100).toFixed(1)}%`} />
              <Row label="Volume" value={`${me.volumeLots} lots`} />
              <Row label="Peak equity" value={formatMoney(me.peakEquity)} />
              <Row label="Max drawdown" value={formatMoney(me.maxDrawdown)} tone="down" />
              <Row label="Avg per fill" value={me.fills ? formatCompactMoney(Math.round(pnl / me.fills)) : '—'} />
            </div>

            {opp && (
              <>
                <div className="divider" />
                <div className="head2head">
                  <span className="label">Head to head</span>
                  <table className="data compact">
                    <thead>
                      <tr><th /><th className="r">You</th><th className="r">{opp.handle}</th></tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>P&amp;L</td>
                        <td className="r num">{formatCompactMoney(pnl)}</td>
                        <td className="r num">{formatCompactMoney(opp.finalEquity - opp.startingCash)}</td>
                      </tr>
                      <tr>
                        <td>Fills</td>
                        <td className="r num">{me.fills}</td>
                        <td className="r num">{opp.fills}</td>
                      </tr>
                      <tr>
                        <td>Maker</td>
                        <td className="r num">{me.fills ? Math.round((me.makerFills * 100) / me.fills) : 0}%</td>
                        <td className="r num">{opp.fills ? Math.round((opp.makerFills * 100) / opp.fills) : 0}%</td>
                      </tr>
                      <tr>
                        <td>Max DD</td>
                        <td className="r num">{formatCompactMoney(me.maxDrawdown)}</td>
                        <td className="r num">{formatCompactMoney(opp.maxDrawdown)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* The determinism proof, surfaced rather than hidden. If a match is
                ever disputed, this hash plus the seed reproduces it exactly. */}
            <div className="divider" />
            <div className="hashline faint">
              <span>state hash</span>
              <code>{result.stateHash}</code>
              <span>draws</span>
              <code>{result.totalDraws}</code>
            </div>
          </div>
        </div>

        <div className="panel result-fills">
          <div className="panel-head"><span>Every fill ({result.fills.length})</span></div>
          <div className="result-fills-body">
            <FillBlotter fills={result.fills} precision={precision} />
          </div>
        </div>
      </div>

      <div className="row gap-12" style={{ marginTop: 20 }}>
        <button className="btn btn-primary btn-lg" onClick={() => { reset(); navigate(isPvp ? '/play' : '/solo'); }}>
          {isPvp ? 'Queue again' : 'Back to drills'}
        </button>
        <button className="btn btn-lg" onClick={() => { reset(); navigate('/portfolio'); }}>
          Portfolio
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`stat-v num ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

/** Objective values are heterogeneous: money, lots, count, bps. */
function formatObjective(id: string, v: number): string {
  if (id === 'maker') return `${(v / 100).toFixed(0)}%`;
  if (id === 'fills' || id === 'pos') return String(v);
  return formatCompactMoney(v);
}
