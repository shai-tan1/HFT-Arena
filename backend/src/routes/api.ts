/**
 * backend/src/routes/api.ts — the REST surface.
 *
 * REST handles everything that is not a live match: auth, catalogue, portfolio,
 * leaderboards. Nothing here is on a latency budget, so it is plain JSON with
 * no cleverness. Anything that needs to be fast is on the socket.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { store } from '../db/store';
import { issueToken, verifyToken } from '../util/tokens';
import { DRILLS, SCENARIOS, INSTRUMENTS, STARTING_CASH } from '../sim/catalog';

export const api = Router();

interface AuthedRequest extends Request {
  userId?: string;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const claims = token ? verifyToken(token) : null;
  if (!claims) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  req.userId = claims.sub;
  next();
}

function publicUser(id: string) {
  const u = store.get(id);
  if (!u) return null;
  return {
    id: u.id, handle: u.handle, isGuest: u.isGuest,
    elo: u.elo, peakElo: u.peakElo,
    matchesPlayed: u.matchesPlayed, wins: u.wins, losses: u.losses, draws: u.draws,
    xp: u.xp, level: u.level, cashMicros: u.cashMicros,
    lifetimePnl: u.lifetimePnl, totalVolumeLots: u.totalVolumeLots,
    totalFills: u.totalFills, makerFills: u.makerFills,
    streakDays: u.streakDays, achievements: [...u.achievements],
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
api.post('/auth/register', async (req, res) => {
  const { handle, email, password } = req.body ?? {};
  if (!handle || !email || !password) {
    return res.status(400).json({ error: 'handle, email and password are required' });
  }
  try {
    const user = await store.register(handle, email, password);
    res.json({
      token: issueToken({ sub: user.id, handle: user.handle, guest: false }),
      user: publicUser(user.id),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Registration failed' });
  }
});

api.post('/auth/login', async (req, res) => {
  const { identifier, password } = req.body ?? {};
  try {
    const user = await store.login(String(identifier ?? ''), String(password ?? ''));
    res.json({
      token: issueToken({ sub: user.id, handle: user.handle, guest: false }),
      user: publicUser(user.id),
    });
  } catch {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

/** Play first, sign up later. See Store.createGuest for why this exists. */
api.post('/auth/guest', (req, res) => {
  const user = store.createGuest(req.body?.handle);
  res.json({
    token: issueToken({ sub: user.id, handle: user.handle, guest: true }),
    user: publicUser(user.id),
  });
});

api.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const user = publicUser(req.userId!);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user });
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
api.get('/drills', (req: AuthedRequest, res) => {
  const header = req.headers.authorization;
  const claims = header?.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  const user = claims ? store.get(claims.sub) : undefined;

  res.json({
    drills: DRILLS.map((d) => {
      const best = user ? store.bestFor(user.id, d.slug) : undefined;
      return {
        ...d,
        locked: user ? user.level < d.unlockLevel : d.unlockLevel > 1,
        bestPnl: best?.pnl ?? null,
        bestStars: best?.stars ?? 0,
        attempts: best?.attempts ?? 0,
      };
    }),
  });
});

api.get('/scenarios', (_req, res) => {
  res.json({
    scenarios: Object.values(SCENARIOS).map((s) => ({
      id: s.id,
      label: s.label,
      difficulty: s.difficulty,
      instrument: INSTRUMENTS[s.instrumentId]?.symbol ?? '???',
      durationMs: s.timeline.reduce((a, t) => a + t.durationMs, 0),
      timeline: s.timeline.map((t) => ({ regime: t.regime, durationMs: t.durationMs })),
      agentCount: s.agents.reduce((a, g) => a + g.count, 0),
    })),
    startingCash: STARTING_CASH,
  });
});

// ---------------------------------------------------------------------------
// Portfolio and history
// ---------------------------------------------------------------------------
api.get('/portfolio', requireAuth, (req: AuthedRequest, res) => {
  const u = store.get(req.userId!);
  if (!u) return res.status(404).json({ error: 'Not found' });

  const matches = store.matchHistory(u.id, 25);
  const practice = store.practiceHistory(u.id, 25);

  // The equity curve is a running fold over settled matches, oldest first.
  // matchHistory returns newest-first because that is what the list wants.
  let running = STARTING_CASH;
  const curve = [...matches].reverse().map((m) => {
    const seat = m.seats.find((s) => s.userId === u.id)!;
    running += seat.finalEquity - seat.startingCash;
    return { t: m.endedAt, equity: running };
  });

  res.json({
    user: publicUser(u.id),
    equityCurve: [{ t: u.createdAt, equity: STARTING_CASH }, ...curve],
    matches: matches.map((m) => {
      const me = m.seats.find((s) => s.userId === u.id)!;
      const opp = m.seats.find((s) => s.userId !== u.id);
      return {
        matchId: m.id, mode: m.mode, scenario: m.scenarioLabel,
        endedAt: m.endedAt, durationMs: m.durationMs,
        pnl: me.finalEquity - me.startingCash,
        result: me.result ?? null,
        eloBefore: me.eloBefore ?? null, eloAfter: me.eloAfter ?? null,
        fills: me.fills, makerFills: me.makerFills, volumeLots: me.volumeLots,
        maxDrawdown: me.maxDrawdown,
        opponent: opp ? { handle: opp.handle, pnl: opp.finalEquity - opp.startingCash } : null,
      };
    }),
    practice: practice.map((p) => ({
      runId: p.id, drill: p.drillSlug, scenario: p.scenarioLabel,
      endedAt: p.endedAt, pnl: p.pnl, stars: p.stars,
      fills: p.fills, makerFills: p.makerFills, maxDrawdown: p.maxDrawdown,
    })),
  });
});

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------
api.get('/leaderboard', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit ?? 100) || 100);
  res.json({ rows: store.leaderboard(limit) });
});

api.get('/leaderboard/practice/:slug', (req, res) => {
  res.json({ rows: store.practiceLeaderboard(req.params.slug, 25) });
});

api.get('/profile/:handle', (req, res) => {
  const u = store.getByHandle(req.params.handle);
  if (!u) return res.status(404).json({ error: 'No such player' });
  res.json({
    user: publicUser(u.id),
    matches: store.matchHistory(u.id, 10).map((m) => {
      const me = m.seats.find((s) => s.userId === u.id)!;
      return {
        matchId: m.id, mode: m.mode, scenario: m.scenarioLabel,
        endedAt: m.endedAt, result: me.result ?? null,
        pnl: me.finalEquity - me.startingCash,
      };
    }),
  });
});
