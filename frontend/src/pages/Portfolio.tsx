import { useEffect, useState } from 'react';
import { api, type PortfolioResponse } from '@/lib/api';
import { EquityRace } from '@/components/trade/EquityRace';
import { formatMoney, formatCompactMoney } from '@shared/protocol';

export function Portfolio() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'matches' | 'practice'>('matches');

  useEffect(() => {
    api.portfolio().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="page"><p className="dim">{error}</p></div>;
  if (!data) return <div className="page"><p className="dim">Loading…</p></div>;

  const u = data.user;
  const makerPct = u.totalFills > 0 ? Math.round((u.makerFills * 100) / u.totalFills) : 0;
  const winPct = u.matchesPlayed > 0 ? Math.round((u.wins * 100) / u.matchesPlayed) : 0;
  const baseline = data.equityCurve[0]?.equity ?? 0;

  return (
    <div className="page">
      <div className="profile-head">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>{u.handle}</h1>
          <div className="row gap-8">
            <span className="chip chip-cyan">{u.elo} ELO</span>
            <span className="chip">Peak {u.peakElo}</span>
            <span className="chip chip-violet">Level {u.level}</span>
            {u.streakDays > 0 && <span className="chip chip-gold">{u.streakDays}-day streak</span>}
            {u.isGuest && <span className="chip">Guest</span>}
          </div>
        </div>
        <div className="profile-pnl">
          <span className="label">Lifetime P&amp;L</span>
          <div className={`num profile-pnl-v ${u.lifetimePnl > 0 ? 'up' : u.lifetimePnl < 0 ? 'down' : ''}`}>
            {formatMoney(u.lifetimePnl, { sign: u.lifetimePnl > 0 })}
          </div>
        </div>
      </div>

      <div className="kpi-row">
        <Kpi label="Matches" value={String(u.matchesPlayed)} />
        <Kpi label="Record" value={`${u.wins}–${u.losses}–${u.draws}`} />
        <Kpi label="Win rate" value={`${winPct}%`} />
        <Kpi label="Fills" value={u.totalFills.toLocaleString()} />
        <Kpi label="Maker ratio" value={`${makerPct}%`} sub="higher is cheaper" />
        <Kpi label="Volume" value={`${u.totalVolumeLots.toLocaleString()} lots`} />
      </div>

      <div className="panel">
        <div className="panel-head"><span>Equity curve</span><span className="faint">settled matches only</span></div>
        <EquityRace
          height={210}
          curves={[{
            label: u.handle,
            color: '#22d3ee',
            baseline,
            points: data.equityCurve.map((p, i) => ({ tMs: i, equity: p.equity })),
          }]}
        />
      </div>

      <div className="tabs tabs-lg" style={{ marginTop: 24 }}>
        <button className={tab === 'matches' ? 'tab on' : 'tab'} onClick={() => setTab('matches')}>
          Matches ({data.matches.length})
        </button>
        <button className={tab === 'practice' ? 'tab on' : 'tab'} onClick={() => setTab('practice')}>
          Practice ({data.practice.length})
        </button>
      </div>

      <div className="panel scroll-x">
        {tab === 'matches' ? (
          data.matches.length === 0
            ? <div className="empty">No matches yet. The arena is that way.</div>
            : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Result</th><th>Mode</th><th>Scenario</th><th>Opponent</th>
                    <th className="r">P&amp;L</th><th className="r">Rating</th>
                    <th className="r">Fills</th><th className="r">Maker</th><th className="r">Max DD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.matches.map((m) => (
                    <tr key={m.matchId}>
                      <td>
                        <span className={`chip ${m.result === 'win' ? 'chip-bid' : m.result === 'loss' ? 'chip-ask' : ''}`}>
                          {(m.result ?? '—').toUpperCase()}
                        </span>
                      </td>
                      <td className="dim">{m.mode.replace('_', ' ')}</td>
                      <td>{m.scenario}</td>
                      <td className="dim">{m.opponent?.handle ?? '—'}</td>
                      <td className={`r num ${m.pnl > 0 ? 'up' : m.pnl < 0 ? 'down' : ''}`}>
                        {formatCompactMoney(m.pnl)}
                      </td>
                      <td className="r num">
                        {m.eloAfter !== null && m.eloBefore !== null ? (
                          <span className={m.eloAfter >= m.eloBefore ? 'up' : 'down'}>
                            {m.eloAfter >= m.eloBefore ? '+' : ''}{m.eloAfter - m.eloBefore}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="r num">{m.fills}</td>
                      <td className="r num">{m.fills ? Math.round((m.makerFills * 100) / m.fills) : 0}%</td>
                      <td className="r num down">{formatCompactMoney(m.maxDrawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        ) : (
          data.practice.length === 0
            ? <div className="empty">No practice runs yet.</div>
            : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Drill</th><th>Scenario</th><th className="r">P&amp;L</th>
                    <th className="r">Fills</th><th className="r">Maker</th><th className="r">Max DD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.practice.map((p) => (
                    <tr key={p.runId}>
                      <td>{p.drill ?? <span className="faint">free play</span>}</td>
                      <td className="dim">{p.scenario}</td>
                      <td className={`r num ${p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : ''}`}>
                        {formatCompactMoney(p.pnl)}
                      </td>
                      <td className="r num">{p.fills}</td>
                      <td className="r num">{p.fills ? Math.round((p.makerFills * 100) / p.fills) : 0}%</td>
                      <td className="r num down">{formatCompactMoney(p.maxDrawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel kpi">
      <span className="label">{label}</span>
      <div className="num kpi-v">{value}</div>
      {sub && <span className="faint kpi-sub">{sub}</span>}
    </div>
  );
}
