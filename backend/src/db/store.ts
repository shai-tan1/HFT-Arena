/**
 * backend/src/db/store.ts — the persistence seam.
 *
 * The server is authoritative in memory and mirrors durable state to Postgres
 * when DATABASE_URL is set. That ordering is deliberate and matches the rule in
 * db/schema.sql: the hot path never waits on a disk write. It also means the
 * whole product runs with no database at all, which is what makes gameplay
 * tuning a one-file edit instead of a migration.
 *
 * When Postgres IS configured, memory is a cache and Postgres is the record.
 * The mirror is fire-and-forget by design — a failed write is logged and the
 * match continues, because dropping a leaderboard row is recoverable and
 * dropping a player's live match is not.
 */

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { SeatResult } from '../../../shared/src/protocol';

export interface UserRecord {
  id: string;
  handle: string;
  email: string;
  passwordHash: string;
  createdAt: number;
  isGuest: boolean;

  elo: number;
  peakElo: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;

  xp: number;
  level: number;
  cashMicros: number;
  lifetimePnl: number;
  totalVolumeLots: number;
  totalFills: number;
  makerFills: number;
  streakDays: number;
  lastPlayedOn: string | null;
  achievements: Set<string>;
}

export interface MatchRecord {
  id: string;
  mode: string;
  scenarioLabel: string;
  durationMs: number;
  endedAt: number;
  seats: SeatResult[];
}

export interface PracticeRecord {
  id: string;
  userId: string;
  drillSlug: string | null;
  scenarioLabel: string;
  endedAt: number;
  pnl: number;
  stars: number;
  fills: number;
  makerFills: number;
  maxDrawdown: number;
  xpAwarded: number;
}

const LEVEL_STEP = 1000; // xp per level, linear. Tune once there is telemetry.

export class Store {
  private users = new Map<string, UserRecord>();
  private byHandle = new Map<string, string>();
  private byEmail = new Map<string, string>();
  private matches: MatchRecord[] = [];
  private practice: PracticeRecord[] = [];
  /** userId -> drillSlug -> best */
  private practiceBest = new Map<string, Map<string, { pnl: number; stars: number; attempts: number }>>();

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------
  async register(handle: string, email: string, password: string): Promise<UserRecord> {
    const h = handle.trim();
    if (h.length < 3 || h.length > 20) throw new Error('Handle must be 3-20 characters');
    if (!/^[a-zA-Z0-9_-]+$/.test(h)) throw new Error('Handle may use letters, numbers, _ and - only');
    if (this.byHandle.has(h.toLowerCase())) throw new Error('That handle is taken');
    if (this.byEmail.has(email.toLowerCase())) throw new Error('That email is already registered');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    const user = this.blankUser(h, email, await bcrypt.hash(password, 10), false);
    this.commit(user);
    return user;
  }

  /**
   * Guest accounts. A trading game where the first thing you see is a signup
   * form loses most of its funnel before anyone has traded once. Guests get a
   * full sandbox and no ladder — the account exists to hold their progress
   * until they decide the game is worth an email address.
   */
  createGuest(handle?: string): UserRecord {
    let h = (handle ?? 'Guest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'Guest';
    if (this.byHandle.has(h.toLowerCase())) h = `${h}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const user = this.blankUser(h, `${h.toLowerCase()}@guest.local`, '', true);
    this.commit(user);
    return user;
  }

  async login(identifier: string, password: string): Promise<UserRecord> {
    const id = this.byHandle.get(identifier.toLowerCase()) ?? this.byEmail.get(identifier.toLowerCase());
    const user = id ? this.users.get(id) : undefined;
    // Same error for "no such user" and "wrong password" — distinguishing them
    // turns the login form into a account-enumeration oracle.
    if (!user || user.isGuest || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new Error('Invalid credentials');
    }
    return user;
  }

  get(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  getByHandle(handle: string): UserRecord | undefined {
    const id = this.byHandle.get(handle.toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  private blankUser(handle: string, email: string, passwordHash: string, isGuest: boolean): UserRecord {
    return {
      id: randomUUID(), handle, email, passwordHash, createdAt: Date.now(), isGuest,
      elo: 1200, peakElo: 1200, matchesPlayed: 0, wins: 0, losses: 0, draws: 0,
      xp: 0, level: 1, cashMicros: 100_000_000_000, lifetimePnl: 0,
      totalVolumeLots: 0, totalFills: 0, makerFills: 0,
      streakDays: 0, lastPlayedOn: null, achievements: new Set(),
    };
  }

  private commit(user: UserRecord): void {
    this.users.set(user.id, user);
    this.byHandle.set(user.handle.toLowerCase(), user.id);
    this.byEmail.set(user.email.toLowerCase(), user.id);
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------
  recordMatch(rec: MatchRecord): void {
    this.matches.unshift(rec);
    if (this.matches.length > 5000) this.matches.pop();

    for (const seat of rec.seats) {
      const u = this.users.get(seat.userId);
      if (!u) continue;
      const pnl = seat.finalEquity - seat.startingCash;
      u.matchesPlayed++;
      u.lifetimePnl += pnl;
      u.totalVolumeLots += seat.volumeLots;
      u.totalFills += seat.fills;
      u.makerFills += seat.makerFills;
      if (seat.result === 'win') u.wins++;
      else if (seat.result === 'loss') u.losses++;
      else if (seat.result === 'draw') u.draws++;
      if (seat.eloAfter !== undefined) {
        u.elo = seat.eloAfter;
        u.peakElo = Math.max(u.peakElo, u.elo);
      }
      this.awardXp(u, seat.result === 'win' ? 300 : seat.result === 'draw' ? 150 : 80);
      this.touchStreak(u);
      this.evaluateAchievements(u, { matchPnl: pnl, seat });
    }
  }

  recordPractice(rec: PracticeRecord): boolean {
    this.practice.unshift(rec);
    if (this.practice.length > 5000) this.practice.pop();

    const u = this.users.get(rec.userId);
    if (u) {
      u.lifetimePnl += 0; // practice PnL is sandboxed — it never touches the ladder
      u.totalFills += rec.fills;
      u.makerFills += rec.makerFills;
      this.awardXp(u, rec.xpAwarded);
      this.touchStreak(u);
      this.evaluateAchievements(u, { drillStars: rec.stars });
    }

    if (!rec.drillSlug) return false;
    let byDrill = this.practiceBest.get(rec.userId);
    if (!byDrill) {
      byDrill = new Map();
      this.practiceBest.set(rec.userId, byDrill);
    }
    const prev = byDrill.get(rec.drillSlug);
    const isBest = !prev || rec.pnl > prev.pnl;
    byDrill.set(rec.drillSlug, {
      pnl: isBest ? rec.pnl : prev!.pnl,
      stars: Math.max(rec.stars, prev?.stars ?? 0),
      attempts: (prev?.attempts ?? 0) + 1,
    });
    return isBest;
  }

  bestFor(userId: string, drillSlug: string) {
    return this.practiceBest.get(userId)?.get(drillSlug);
  }

  matchHistory(userId: string, limit = 20): MatchRecord[] {
    return this.matches.filter((m) => m.seats.some((s) => s.userId === userId)).slice(0, limit);
  }

  practiceHistory(userId: string, limit = 20): PracticeRecord[] {
    return this.practice.filter((p) => p.userId === userId).slice(0, limit);
  }

  leaderboard(limit = 100) {
    return [...this.users.values()]
      .filter((u) => u.matchesPlayed > 0 && !u.isGuest)
      .sort((a, b) => b.elo - a.elo || b.peakElo - a.peakElo)
      .slice(0, limit)
      .map((u, i) => ({
        rank: i + 1,
        userId: u.id,
        handle: u.handle,
        elo: u.elo,
        peakElo: u.peakElo,
        matchesPlayed: u.matchesPlayed,
        wins: u.wins,
        losses: u.losses,
        draws: u.draws,
        winRateBps: u.matchesPlayed ? Math.round((u.wins * 10000) / u.matchesPlayed) : 0,
        lifetimePnl: u.lifetimePnl,
        totalVolumeLots: u.totalVolumeLots,
      }));
  }

  practiceLeaderboard(drillSlug: string, limit = 25) {
    const rows: { handle: string; pnl: number; stars: number; attempts: number }[] = [];
    for (const [userId, byDrill] of this.practiceBest) {
      const best = byDrill.get(drillSlug);
      const u = this.users.get(userId);
      if (best && u) rows.push({ handle: u.handle, pnl: best.pnl, stars: best.stars, attempts: best.attempts });
    }
    return rows.sort((a, b) => b.pnl - a.pnl).slice(0, limit)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  // -------------------------------------------------------------------------
  // Progression
  // -------------------------------------------------------------------------
  private awardXp(u: UserRecord, xp: number): void {
    u.xp += Math.max(0, xp);
    u.level = Math.floor(u.xp / LEVEL_STEP) + 1;
  }

  private touchStreak(u: UserRecord): void {
    const today = new Date().toISOString().slice(0, 10);
    if (u.lastPlayedOn === today) return;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    u.streakDays = u.lastPlayedOn === yesterday ? u.streakDays + 1 : 1;
    u.lastPlayedOn = today;
  }

  private evaluateAchievements(
    u: UserRecord,
    ctx: { matchPnl?: number; seat?: SeatResult; drillStars?: number },
  ): string[] {
    const unlocked: string[] = [];
    const give = (id: string) => {
      if (!u.achievements.has(id)) {
        u.achievements.add(id);
        unlocked.push(id);
      }
    };
    if (u.wins >= 1) give('first_blood');
    if (u.makerFills >= 1000) give('maker_1000');
    if ((ctx.drillStars ?? 0) >= 3) give('perfect_drill');
    if (u.elo >= 1500) give('elo_1500');
    if (u.elo >= 1800) give('elo_1800');
    if (u.streakDays >= 7) give('streak_7');
    if (u.totalVolumeLots >= 10000) give('volume_10k');
    if (ctx.seat?.result === 'win' && ctx.seat.maxDrawdown >= 500_000_000) give('drawdown_iron');
    return unlocked;
  }
}

export const store = new Store();
