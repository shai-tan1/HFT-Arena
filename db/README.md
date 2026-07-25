# Database

Apply in this order. Each file is idempotent only where noted — `schema.sql`
and `schema_02_gameplay.sql` are `CREATE`-only and will error on a database
that already has them, which is deliberate: silently succeeding on a partially
migrated database is how you end up with a schema nobody can describe.

| File | Contents |
| --- | --- |
| `schema.sql` | Identity, ratings, instruments, scenarios, matches, orders, fills, outbox |
| `schema_02_gameplay.sql` | Sessions, profiles, solo practice, portfolio ledger, market-data aggregates, matchmaking, lobbies, achievements, leaderboard views |
| `seeds/001_content.sql` | Instruments, scenarios, drills, achievements. Re-runnable (`ON CONFLICT DO UPDATE`) |

## Fresh database

```bash
createdb hfta
psql -d hfta -f db/schema.sql
psql -d hfta -f db/schema_02_gameplay.sql
psql -d hfta -f db/seeds/001_content.sql
```

`schema.sql` starts with `CREATE EXTENSION IF NOT EXISTS citext;`, which needs
the `postgresql-contrib` package. `gen_random_uuid()` is built in from
PostgreSQL 13; on 12 or older, uncomment the `pgcrypto` line.

## Or with Docker

```bash
docker compose -f infra/docker-compose.yml up -d
```

The compose file mounts all three files into `/docker-entrypoint-initdb.d`, so
a fresh volume applies them automatically in order. To reapply after editing
them you must drop the volume — `docker compose ... down -v` — because the init
directory only runs on an empty data directory.

## Two rules the schema will not bend on

1. **No floating point for money or prices.** Prices are `BIGINT` ticks, cash is
   `BIGINT` micro-units, exactly as the engine sees them. A `DOUBLE PRECISION`
   balance column makes the database disagree with the engine, and the player
   notices before you do.

2. **The hot path never touches Postgres.** During a match, fills go to the
   backend over the socket and into memory. They reach Postgres in batches after
   the match or on a timer, via `ingest_outbox`. A synchronous insert per fill
   would add milliseconds to a system whose whole premise is microseconds.

## Derived state

`portfolio_balances` caches a fold over `portfolio_ledger`; `portfolio_balance_truth`
is that same fold as a view. If the two ever disagree, the cache is wrong — the
ledger is append-only and cannot be.

`leaderboard_ranked` and `leaderboard_practice` are materialized. Refresh them
on a timer:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_ranked;
REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_practice;
```

Both carry a unique index, which is what `CONCURRENTLY` requires.
