/**
 * frontend/src/lib/api.ts — REST client.
 *
 * Everything that is not a live match: auth, catalogue, portfolio, ladders.
 */

import type { DrillSummary } from '@shared/protocol';

const BASE = import.meta.env.VITE_API_URL ?? '/api';

let token: string | null = localStorage.getItem('hfta.token');

export function getToken(): string | null {
  return token;
}

export function setToken(next: string | null): void {
  token = next;
  if (next) localStorage.setItem('hfta.token', next);
  else localStorage.removeItem('hfta.token');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export interface PublicUser {
  id: string;
  handle: string;
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
  achievements: string[];
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  handle: string;
  elo: number;
  peakElo: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRateBps: number;
  lifetimePnl: number;
  totalVolumeLots: number;
}

export interface PortfolioMatch {
  matchId: string;
  mode: string;
  scenario: string;
  endedAt: number;
  durationMs: number;
  pnl: number;
  result: 'win' | 'loss' | 'draw' | null;
  eloBefore: number | null;
  eloAfter: number | null;
  fills: number;
  makerFills: number;
  volumeLots: number;
  maxDrawdown: number;
  opponent: { handle: string; pnl: number } | null;
}

export interface PortfolioPractice {
  runId: string;
  drill: string | null;
  scenario: string;
  endedAt: number;
  pnl: number;
  stars: number;
  fills: number;
  makerFills: number;
  maxDrawdown: number;
}

export interface PortfolioResponse {
  user: PublicUser;
  equityCurve: { t: number; equity: number }[];
  matches: PortfolioMatch[];
  practice: PortfolioPractice[];
}

export type DrillListItem = DrillSummary & {
  locked: boolean;
  bestPnl: number | null;
  bestStars: number;
  attempts: number;
};

export interface ScenarioListItem {
  id: number;
  label: string;
  difficulty: number;
  instrument: string;
  durationMs: number;
  timeline: { regime: string; durationMs: number }[];
  agentCount: number;
}

export const api = {
  register: (handle: string, email: string, password: string) =>
    request<{ token: string; user: PublicUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ handle, email, password }),
    }),

  login: (identifier: string, password: string) =>
    request<{ token: string; user: PublicUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),

  guest: (handle?: string) =>
    request<{ token: string; user: PublicUser }>('/auth/guest', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    }),

  me: () => request<{ user: PublicUser }>('/me'),

  drills: () => request<{ drills: DrillListItem[] }>('/drills'),

  scenarios: () =>
    request<{ scenarios: ScenarioListItem[]; startingCash: number }>('/scenarios'),

  portfolio: () => request<PortfolioResponse>('/portfolio'),

  leaderboard: (limit = 100) =>
    request<{ rows: LeaderboardRow[] }>(`/leaderboard?limit=${limit}`),

  practiceLeaderboard: (slug: string) =>
    request<{ rows: { rank: number; handle: string; pnl: number; stars: number; attempts: number }[] }>(
      `/leaderboard/practice/${slug}`,
    ),
};
