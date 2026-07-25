import { useEffect } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '@/state/session';
import { useMatch } from '@/state/match';
import { Landing } from '@/pages/Landing';
import { Auth } from '@/pages/Auth';
import { Home } from '@/pages/Home';
import { Play } from '@/pages/Play';
import { Solo } from '@/pages/Solo';
import { Trade } from '@/pages/Trade';
import { Result } from '@/pages/Result';
import { Leaderboard } from '@/pages/Leaderboard';
import { Portfolio } from '@/pages/Portfolio';
import '@/styles/pages.css';

export function App() {
  const { user, booting, status, boot, logout } = useSession();
  const bind = useMatch((s) => s.bind);
  const phase = useMatch((s) => s.phase);
  const toasts = useMatch((s) => s.toasts);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => { void boot(); }, []);
  useEffect(() => bind(), [bind]);

  // A match starting anywhere in the app takes you to the trade screen. The
  // arm message can arrive while you are reading the leaderboard, and missing
  // the first ten seconds of a ranked match because you were on another page
  // is not a mistake the player made.
  useEffect(() => {
    if ((phase === 'countdown' || phase === 'live') && location.pathname !== '/trade') {
      navigate('/trade');
    }
  }, [phase]);

  if (booting) {
    return (
      <div className="boot">
        <div className="brand">
          <span className="mark">HFT ARENA</span>
        </div>
        <p className="dim">Connecting to the exchange…</p>
      </div>
    );
  }

  // No session yet: the landing page is the whole app. Everything behind it
  // needs an account, so any other path falls back to the front door.
  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    );
  }

  const inMatch = phase === 'countdown' || phase === 'live';

  return (
    <div className="app">
      <nav className="nav">
        <NavLink to="/" className="brand">
          <span className="mark">HFT ARENA</span>
          <span className="tag">TRADE · COMPETE · MASTER</span>
        </NavLink>

        {!inMatch && (
          <div className="nav-links">
            <NavLink to="/play" className={navClass}>Arena</NavLink>
            <NavLink to="/solo" className={navClass}>Practice</NavLink>
            <NavLink to="/leaderboard" className={navClass}>Leaderboard</NavLink>
            <NavLink to="/portfolio" className={navClass}>Portfolio</NavLink>
          </div>
        )}

        <div className="spacer" />

        <div className="row gap-12">
          <span
            className={`conn conn-${status}`}
            title={status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Disconnected'}
          />
          <div className="whoami">
            <span className="whoami-handle">{user.handle}</span>
            <span className="whoami-meta">
              <span className="chip chip-cyan">{user.elo} ELO</span>
              <span className="chip">LVL {user.level}</span>
            </span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={logout}>
            {user.isGuest ? 'Exit' : 'Sign out'}
          </button>
        </div>
      </nav>

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth" element={<Home />} />
        <Route path="/play" element={<Play />} />
        <Route path="/solo" element={<Solo />} />
        <Route path="/trade" element={<Trade />} />
        <Route path="/result" element={<Result />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="*" element={<Home />} />
      </Routes>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind === 'error' ? 'err' : t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'nav-link active' : 'nav-link';
