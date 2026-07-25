import { useEffect, useState } from 'react';
import { api, type LeaderboardRow } from '@/lib/api';
import { useSession } from '@/state/session';
import { formatCompactMoney } from '@shared/protocol';

export function Leaderboard() {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const me = useSession((s) => s.user);

  useEffect(() => {
    api.leaderboard().then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, []);

  return (
    <div className="page">
      <h1 className="page-title">Leaderboard</h1>
      <p className="page-sub">
        Ranked by rating. Only players with a settled match appear — a 1200 with
        no games is a default, not a result.
      </p>

      <div className="panel scroll-x">
        {rows === null && <div className="empty">Loading…</div>}
        {rows?.length === 0 && (
          <div className="empty">
            Nobody has finished a ranked match yet. Be the first.
          </div>
        )}
        {rows && rows.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th className="r">#</th><th>Player</th>
                <th className="r">Rating</th><th className="r">Peak</th>
                <th className="r">Matches</th><th className="r">W–L–D</th>
                <th className="r">Win rate</th><th className="r">Lifetime P&amp;L</th>
                <th className="r">Volume</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className={r.userId === me?.id ? 'row-me' : ''}>
                  <td className="r num">
                    {r.rank <= 3
                      ? <span className={`medal medal-${r.rank}`}>{r.rank}</span>
                      : r.rank}
                  </td>
                  <td><strong>{r.handle}</strong></td>
                  <td className="r num"><strong>{r.elo}</strong></td>
                  <td className="r num dim">{r.peakElo}</td>
                  <td className="r num">{r.matchesPlayed}</td>
                  <td className="r num dim">{r.wins}–{r.losses}–{r.draws}</td>
                  <td className="r num">{(r.winRateBps / 100).toFixed(0)}%</td>
                  <td className={`r num ${r.lifetimePnl > 0 ? 'up' : r.lifetimePnl < 0 ? 'down' : ''}`}>
                    {formatCompactMoney(r.lifetimePnl)}
                  </td>
                  <td className="r num dim">{r.totalVolumeLots.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
