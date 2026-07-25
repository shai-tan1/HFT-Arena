# HFT Arena

A gamified high-frequency trading simulator. Two players face the same
synthetic market, expanded from the same 128-bit seed, and the only variable
left is execution.

```
┌─ engine/     C++ matching engine (headless skeleton, verified)
├─ backend/    Node + TypeScript: REST, WebSocket gateway, reference simulation
├─ frontend/   Vite + React: lobby, trade screen, drills, portfolio, ladder
├─ shared/     The browser <-> server wire contract, imported by both sides
├─ db/         PostgreSQL schema and seed content
├─ infra/      docker-compose for Postgres + Redis
└─ docs/       Architecture notes
```

## Run it

Two terminals, no database required:

```bash
npm --prefix backend install && npm --prefix backend start
```

```bash
npm --prefix frontend install && npm --prefix frontend run dev
```

Open <http://localhost:5173>. You are signed in as a guest immediately — there
is no form between you and the first trade.

To try PvP on one machine, open a second browser profile (or an incognito
window) so the two tabs get separate guest accounts, and queue casual on both.

## Verify it

```bash
npm --prefix backend run sim:check
```

24 assertions over the simulation: mirrored determinism, seed sensitivity,
rounding-drift, accounting closure, margin persistence, order-type semantics,
and that regimes actually differ from each other.

```bash
npm --prefix backend run pvp:check
```

15 assertions over a live server: that two seats in one match see an identical
market until someone trades, and that after that, one seat's orders move only
that seat's book.

## Deploy it

```bash
cp infra/.env.example infra/.env   # fill in JWT_SECRET and POSTGRES_PASSWORD
docker compose -f infra/docker-compose.prod.yml up -d --build
```

nginx serves the SPA and reverse-proxies `/api` and `/ws` to the backend on one
origin, so there is no frontend URL to configure. **One backend replica only** —
live matches are in-process memory. See [docs/DEPLOY.md](docs/DEPLOY.md).

## The load-bearing decision

**Mirrored order books, not a shared book.** A PvP match runs two engine
instances seeded identically. Each player is alone in their own copy of the
market with the same synthetic order flow.

Everything the product needs falls out of that one choice:

- **Fairness.** Neither player can front-run the other, and neither one's ping
  buys queue position against the other.
- **Replay.** A seat's whole session is (seed, config, that seat's commands) —
  about 200 bytes reproduces a ten-minute match exactly.
- **Grading.** "What should you have done" is answerable because the
  counterfactual market is reproducible.
- **Anti-cheat.** Two engines fed one seed must end with equal PRNG draw counts.
  A divergence is a hard signal, not a hunch.

The cost is that players never trade against each other, only against the same
market. For a skill game that is the right trade: PvP here means "same
conditions, better execution wins", which is what a chess clock means too.

## How the market stays fair *and* reactive

The hard part is that both players must face "the same order flow" while their
own orders change their own book — and any agent that reacts to the book would
then behave differently for each of them.

The fix is to separate the random stream from the decision:

1. Agent wakeup times come only from `(seed, agentId, n)`. Both engines schedule
   the same wakeups at the same logical nanosecond.
2. At each wakeup an agent draws a **fixed** number of variates, unconditionally,
   before it looks at anything.
3. Only the *mapping* from those variates to an action reads book state.

So leaning on the bid really does make the market makers skew away from you,
without desynchronising your opponent's world.

## Where the numbers live

Prices are integer ticks, sizes are integer lots, cash is integer micro-units —
in the engine, on the wire, and in the database. Formatting happens in the last
mile, in a React component, and nowhere else.

Division always rounds half away from zero. This is not pedantry: truncating one
division in the C++ micro-price calculation manufactured a phantom 1.2%
downtrend out of pure rounding, and it looked exactly like a market regime.

## Status

**Working and verified end to end:** solo practice with seven drills, ranked and
casual PvP matchmaking, private lobbies by room code, the live trade screen
(ladder, candles, tape, blotter, order ticket with hotkeys), post-match results
with per-fill review, portfolio, and leaderboards.

**Verified by running it, not just by writing it:** see the two check commands
above. Both were used to find real bugs during this build — a volatility
scaling error that rendered calm markets literally motionless, stale seeded
liquidity that never got cancelled, and a market-maker skew cap that was
collapsing every regime's spread to one tick.

**Not yet wired:** the C++ engine. `backend/src/sim/` is a TypeScript reference
implementation of the same semantics, behind the same wire contract, so
swapping in the ZeroMQ path is contained to one module. See
[docs/STATUS.md](docs/STATUS.md) for the full gap list.

**Not yet verified:** the SQL in `db/` has not been applied to a live Postgres —
no server was reachable on this machine. `db/README.md` has the commands.
