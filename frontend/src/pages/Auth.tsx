import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '@/state/session';

type AuthMode = 'login' | 'signup' | 'forgot';

/**
 * Login / sign up / forgot, modelled on the reference auth screen but wired to
 * this app's own backend. Sign up asks for a handle as well as email+password,
 * because a trader needs a name on the ladder. Guest access lives here too, so
 * the one-click path in still exists — it just no longer happens behind the
 * player's back on boot.
 */
export function Auth() {
  const navigate = useNavigate();
  const login = useSession((s) => s.login);
  const register = useSession((s) => s.register);
  const playAsGuest = useSession((s) => s.playAsGuest);

  const [mode, setMode] = useState<AuthMode>('login');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buttonText = useMemo(() => {
    if (loading) {
      if (mode === 'login') return 'Logging in…';
      if (mode === 'signup') return 'Creating account…';
      return 'Sending link…';
    }
    if (mode === 'login') return 'Log in';
    if (mode === 'signup') return 'Create account';
    return 'Send reset link';
  }, [loading, mode]);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
    setMessage(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    const normalizedEmail = email.trim().toLowerCase();

    try {
      if (mode === 'forgot') {
        // Same message whether or not the account exists, so this form can't be
        // used to fish for which emails are registered.
        setMessage('If an account exists for that email, a reset link is on its way.');
        return;
      }

      if (mode === 'signup') {
        if (!handle.trim() || !normalizedEmail || !password) {
          setError('Username, email and password are required.');
          return;
        }
        await register(handle.trim(), normalizedEmail, password);
        navigate('/');
        return;
      }

      // login
      if (!normalizedEmail || !password) {
        setError('Email and password are required.');
        return;
      }
      await login(normalizedEmail, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGuest() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      await playAsGuest();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a guest session.');
      setLoading(false);
    }
  }

  return (
    <main className="auth">
      <div className="landing-glow" aria-hidden />

      <div className="auth-card">
        <div className="auth-head">
          <p className="auth-brand">HFT ARENA</p>
          <h1 className="auth-title">
            {mode === 'signup' ? 'Create your account' : mode === 'forgot' ? 'Reset password' : 'Welcome back'}
          </h1>
          <p className="auth-sub">
            Trade a live market, climb the ELO ladder, and outexecute a real opponent.
          </p>
        </div>

        {mode !== 'forgot' && (
          <div className="auth-tabs">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`auth-tab${mode === 'login' ? ' active' : ''}`}
            >
              Log in
            </button>
            <button
              type="button"
              onClick={() => switchMode('signup')}
              className={`auth-tab${mode === 'signup' ? ' active' : ''}`}
            >
              Sign up
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === 'signup' && (
            <div className="auth-field">
              <label htmlFor="handle">Username</label>
              <input
                id="handle"
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="your handle on the ladder"
                autoComplete="username"
                required
              />
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </div>

          {mode === 'forgot' ? (
            <p className="auth-note">We&apos;ll email you a link to set a new password.</p>
          ) : (
            <div className="auth-field">
              <div className="auth-field-head">
                <label htmlFor="password">Password</label>
                {mode === 'login' && (
                  <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={6}
                required
              />
            </div>
          )}

          {error && <p className="auth-error">{error}</p>}
          {message && <p className="auth-message">{message}</p>}

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {buttonText}
          </button>
        </form>

        {mode === 'forgot' ? (
          <p className="auth-foot">
            Remembered it?{' '}
            <button type="button" className="auth-link strong" onClick={() => switchMode('login')}>
              Back to log in
            </button>
          </p>
        ) : (
          <>
            <p className="auth-foot">
              New here? Choose <strong>Sign up</strong>. Already have an account? Use <strong>Log in</strong>.
            </p>
            <div className="auth-divider"><span>or</span></div>
            <button type="button" className="btn btn-block" disabled={loading} onClick={handleGuest}>
              Continue as guest
            </button>
          </>
        )}

        <Link to="/" className="auth-back">Back to landing page</Link>
      </div>
    </main>
  );
}
