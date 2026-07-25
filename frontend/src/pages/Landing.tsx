import { Link } from 'react-router-dom';

/**
 * The public front door. Monochrome, high-contrast, with a cluster of floating
 * 3D tiles — a look borrowed from the reference, kept entirely local to this
 * page so it never leaks into the cyan/violet trading UI behind the login.
 */
export function Landing() {
  return (
    <main className="lp">
      <div className="lp-grain" aria-hidden />
      <div className="lp-glow" aria-hidden />

      <header className="lp-nav">
        <Link to="/" className="lp-logo" aria-label="HFT Arena home">
          <span className="lp-logo-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 2a10 10 0 0 0 0 20" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="12" cy="12" r="3" fill="currentColor" />
            </svg>
          </span>
          <span className="lp-logo-word">HFT ARENA</span>
        </Link>

        <nav className="lp-nav-mid">
          <a href="#challenge">Challenge</a>
          <a href="#funding">Instant Access</a>
          <a href="#faq">FAQ</a>
          <a href="#faq">Community</a>
          <a href="#challenge">More</a>
        </nav>

        <div className="lp-nav-actions">
          <Link to="/auth" className="lp-btn lp-btn-solid">SIGNUP</Link>
          <Link to="/auth" className="lp-btn lp-btn-outline">EXPLORE</Link>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">DEVELOPING ACTIVE TRADERS SINCE 2026</p>
          <h1 className="lp-title">
            <span className="lp-grad">EARN REAL TIME</span><br />
            TRADING<br />
            <span className="lp-outline">EXPERIENCE</span>
          </h1>
          <p className="lp-lede">
            Refine your strategy using real-time data on our risk-free,
            professional-grade simulation platform. Master technicals, build
            confidence, and choose your path to mastery.
          </p>
          <div className="lp-actions">
            <Link to="/auth" className="lp-cta">SOLO PORTFOLIO BUILDING</Link>
            <Link to="/auth" className="lp-cta">DUALS AGAINST FRIENDS</Link>
          </div>
        </div>

        <div className="lp-art" aria-hidden>
          <div className="lp-tile lp-tile-1"><BoltIcon /></div>
          <div className="lp-tile lp-tile-2"><CheckIcon /></div>
          <div className="lp-tile lp-tile-3"><DollarIcon /></div>
          <div className="lp-tile lp-tile-4"><TrendIcon /></div>
          <div className="lp-tile lp-tile-5"><BarsIcon /></div>
          <div className="lp-tile lp-tile-6"><GridIcon /></div>
        </div>
      </section>

      <section id="challenge" className="lp-band">
        <div className="lp-cards">
          <article className="lp-card">
            <h3>Duel a real opponent</h3>
            <p>Two mirrored order books, one shared seed. Identical flow for both seats, so the only variable left is execution.</p>
          </article>
          <article className="lp-card">
            <h3>Trade, analyse, improve</h3>
            <p>Every fill is tagged maker or taker and marked against the price that followed. The post-match screen shows what you should have done.</p>
          </article>
          <article className="lp-card">
            <h3>Drills &amp; progression</h3>
            <p>Seven hand-authored scenarios from a quiet open to a full liquidity cascade. Fixed seeds — a fair ladder, not a lottery.</p>
          </article>
        </div>
      </section>

      <section id="faq" className="lp-band lp-faq">
        <h2 className="lp-faq-title">Questions, answered</h2>
        <div className="lp-faq-list">
          <FaqItem
            q="Is real money involved?"
            a="No. Every account trades a risk-free simulation with synthetic order flow. You compete on skill, not on your bankroll."
          />
          <FaqItem
            q="How is a duel fair?"
            a="Both players get the same 128-bit seed, so the market is identical for each. Neither ping nor front-running buys an edge."
          />
          <FaqItem
            q="Can I just practice solo?"
            a="Yes. Solo portfolio building and fixed-seed drills let you rehearse before you ever face another trader."
          />
          <FaqItem
            q="Do I need an account to start?"
            a="You can jump in as a guest from the sign-in screen — a real account with real progress, no form required."
          />
        </div>
        <div className="lp-faq-cta">
          <Link to="/auth" className="lp-cta">CREATE YOUR ACCOUNT</Link>
        </div>
      </section>

      <footer className="lp-footer">
        <span className="lp-logo-word">HFT ARENA</span>
        <span className="lp-footer-tag">TRADE · COMPETE · MASTER</span>
      </footer>
    </main>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="lp-faq-item">
      <summary>{q}<span className="lp-faq-plus" aria-hidden>+</span></summary>
      <p>{a}</p>
    </details>
  );
}

/* --- inline monochrome glyphs for the floating tiles --- */
const ICON = { viewBox: '0 0 24 24', width: 34, height: 34, fill: 'none' } as const;

function BoltIcon() {
  return (
    <svg {...ICON}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor" /></svg>
  );
}
function CheckIcon() {
  return (
    <svg {...ICON}><path d="M4 13l5 5L20 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
  );
}
function DollarIcon() {
  return (
    <svg {...ICON}><path d="M12 2v20M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.8 7 7s2.2 3 5 3.5 5 1.5 5 3.7-2.2 3.3-5 3.3-5-1.1-5-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
  );
}
function TrendIcon() {
  return (
    <svg {...ICON}><path d="M3 17l6-6 4 4 8-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 7h6v6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  );
}
function BarsIcon() {
  return (
    <svg {...ICON}><rect x="4" y="12" width="4" height="8" rx="1" fill="currentColor" /><rect x="10" y="7" width="4" height="13" rx="1" fill="currentColor" /><rect x="16" y="4" width="4" height="16" rx="1" fill="currentColor" /></svg>
  );
}
function GridIcon() {
  return (
    <svg {...ICON}>{[4, 10, 16].flatMap((y) => [4, 10, 16].map((x) => (
      <circle key={`${x}-${y}`} cx={x + 1} cy={y + 1} r="1.6" fill="currentColor" />
    )))}</svg>
  );
}
