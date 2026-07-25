import { Link } from 'react-router-dom';
import { useSession } from '@/state/session';
import { formatMoney } from '@shared/protocol';

export function Home() {
  const user = useSession((s) => s.user);

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="hero-title">
            TRADE FASTER.<br />THINK SMARTER.<br />
            <span className="grad">COMPETE HARDER.</span>
          </h1>
          <p className="hero-sub">
            Two traders. One market. Identical order flow, seeded from the same
            128-bit number — so the only variable left is execution.
          </p>
          <div className="row gap-12 hero-cta">
            <Link to="/play" className="btn btn-primary btn-lg">Enter the arena</Link>
            <Link to="/solo" className="btn btn-lg">Practice solo</Link>
          </div>
          {user && (
            <div className="hero-stats">
              <HeroStat label="Rating" value={String(user.elo)} />
              <HeroStat label="Record" value={`${user.wins}W · ${user.losses}L · ${user.draws}D`} />
              <HeroStat label="Lifetime P&L" value={formatMoney(user.lifetimePnl, { sign: user.lifetimePnl > 0 })} />
              <HeroStat label="Level" value={`${user.level} · ${user.xp} XP`} />
            </div>
          )}
        </div>

        <div className="hero-art">
          <div className="art-book">
            <div className="art-col art-bids">
              <span className="label">Bids</span>
              {[
                [100.25, 1250], [100.20, 2300], [100.15, 1800],
                [100.10, 3450], [100.05, 2100],
              ].map(([p, q]) => (
                <div className="art-row" key={p}>
                  <span className="num up">{p.toFixed(2)}</span>
                  <span className="num dim">{q.toLocaleString()}</span>
                  <span className="art-bar art-bar-bid" style={{ width: `${(q / 3450) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="art-col art-asks">
              <span className="label">Asks</span>
              {[
                [100.30, 1100], [100.35, 1900], [100.40, 2600],
                [100.45, 1700], [100.50, 2200],
              ].map(([p, q]) => (
                <div className="art-row" key={p}>
                  <span className="num down">{p.toFixed(2)}</span>
                  <span className="num dim">{q.toLocaleString()}</span>
                  <span className="art-bar art-bar-ask" style={{ width: `${(q / 2600) * 100}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className="art-spread">
            <span className="label">Spread</span>
            <span className="num">0.05</span>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <Feature
          accent="violet"
          title="PvP Arena"
          body="Real-time, time-boxed matches. Two mirrored order books seeded identically, so neither player can front-run the other and neither one's ping buys queue position."
          to="/play"
          cta="Find a match"
        />
        <Feature
          accent="cyan"
          title="Trade. Analyse. Improve."
          body="Every fill is tagged maker or taker, marked against the price that followed it, and plotted on your chart. The post-match screen answers what you should have done, not just what you scored."
          to="/portfolio"
          cta="See your book"
        />
        <Feature
          accent="gold"
          title="Drills & Progression"
          body="Seven hand-authored scenarios from a quiet open to a full liquidity cascade. Fixed seeds, so the drill leaderboard is a fair comparison and not a lottery."
          to="/solo"
          cta="Start drilling"
        />
      </section>

      <section className="how">
        <h2 className="section-title">How a match works</h2>
        <ol className="how-steps">
          <li>
            <span className="how-n">1</span>
            <div>
              <strong>Matchmaking pairs you on rating.</strong> The band starts at
              ±100 and widens 25 points a second, because a fast match against a
              near-peer beats a perfect match you waited ninety seconds for.
            </div>
          </li>
          <li>
            <span className="how-n">2</span>
            <div>
              <strong>Both seats get the same seed.</strong> One 128-bit number
              expands into the full synthetic order flow — market makers, noise,
              momentum chasers, sweepers — identically for both of you.
            </div>
          </li>
          <li>
            <span className="how-n">3</span>
            <div>
              <strong>You trade your own copy of the book.</strong> Your orders
              move your market. Lean on the bid and the market makers skew away
              from you, exactly as they should — without touching your opponent's world.
            </div>
          </li>
          <li>
            <span className="how-n">4</span>
            <div>
              <strong>Higher P&amp;L wins.</strong> Within a dollar it is a draw:
              a rating swing decided by a rounding cent is noise wearing a
              scoreboard's clothes.
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hero-stat">
      <span className="label">{label}</span>
      <span className="num hero-stat-v">{value}</span>
    </div>
  );
}

function Feature({
  accent, title, body, to, cta,
}: { accent: string; title: string; body: string; to: string; cta: string }) {
  return (
    <div className={`feature feature-${accent}`}>
      <h3>{title}</h3>
      <p>{body}</p>
      <Link to={to} className="feature-cta">{cta} →</Link>
    </div>
  );
}
