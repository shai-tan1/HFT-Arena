# Deploying HFT Arena

## Read this first

**One backend process. Not two.**

Live matches are objects in the backend's memory — `MatchRoom` holds the
engines, `Gateway` holds the matchmaking queue and the lobbies. A second replica
gets its own empty copy of all three. Two players who land on different replicas
can never be paired, and a reconnect that hits the wrong one drops the player
out of a live match with no error anyone can act on.

This is not a load-balancer setting. Making it horizontal means moving room
state to Redis and pinning each match to a worker. Until then: **one replica,
vertical scaling only.** One process comfortably serves a few hundred concurrent
matches — each one is a few hundred KB and a 10 Hz timer.

**The backend does not persist.** The store is in memory. A restart loses every
account, rating and result. That is fine for a playtest and disqualifying for a
public ranked ladder — ELO that resets on deploy is not a ladder. See
[STATUS.md](STATUS.md).

## The shape

```
        :443 TLS
           │
      ┌────▼─────┐   /            static SPA bundle
      │  nginx   │   /api/  ─────► backend :4000
      └────┬─────┘   /ws    ─────► backend :4000  (upgrade, unbuffered)
           │
      ┌────▼─────┐
      │ backend  │──► postgres :5432
      │ (1 only) │──► redis :6379
      └──────────┘
```

Everything is served from **one origin**. That is deliberate, and it is why
there is no frontend build-time configuration: the API base defaults to `/api`
and the socket URL to `location.host + '/ws'`, so the bundle is environment-
agnostic. It also keeps CORS out of the request path entirely.

## Deploy

```bash
cp infra/.env.example infra/.env
# fill in JWT_SECRET (openssl rand -base64 48), POSTGRES_PASSWORD, PUBLIC_ORIGIN
docker compose -f infra/docker-compose.prod.yml up -d --build
```

Then <http://localhost:8080> (or whatever `HTTP_PORT` you set).

Both Dockerfiles take the **repo root** as build context, not their own
directory, because `shared/` is compiled into both artifacts. The compose file
already does this; if you build by hand:

```bash
docker build -f backend/Dockerfile -t hfta-backend .
docker build -f frontend/Dockerfile -t hfta-web .
```

## TLS

The stack speaks plain HTTP and expects a terminator in front. Caddy is the
least effort:

```
arena.example.com {
    reverse_proxy localhost:8080
}
```

Caddy proxies WebSocket upgrades without extra configuration. If you use nginx
instead, copy the `Upgrade`/`Connection` headers and the long `proxy_read_timeout`
from [infra/nginx.conf](../infra/nginx.conf) — the 90-second default cuts
sockets mid-match.

Set `PUBLIC_ORIGIN=https://arena.example.com` once TLS is on. `wss://` is
selected automatically from `location.protocol`.

## Without Docker

```bash
npm --prefix backend ci && npm --prefix backend run build
npm --prefix frontend ci && npm --prefix frontend run build
```

That produces `backend/dist/server.js` (a single bundle — dependencies stay
external, so keep `node_modules`) and `frontend/dist/` (static files).

```bash
NODE_ENV=production JWT_SECRET=... PORT=4000 node backend/dist/server.js
```

Put the frontend behind any static host that can proxy `/api` and `/ws` to the
backend on the same origin, and run the backend under systemd or pm2 so it
restarts.

Note that `npm --prefix backend start` runs TypeScript directly through `tsx`.
That is the development path. Use `build` + `node dist/server.js` in production:
same code, no compiler in the process.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `JWT_SECRET` | **yes in production** | The process refuses to boot without it. Verified. |
| `PORT` | no | Defaults to 4000. |
| `CORS_ORIGIN` | no | Comma-separated. Irrelevant when same-origin; set it anyway. |
| `NODE_ENV` | yes | Must be `production` for the secret guard to arm. |
| `DATABASE_URL` | not yet | Passed through, unused until the store is wired. |
| `REDIS_URL` | not yet | Same. |

## Health and rollback

`GET /health` returns live connection, room and lobby counts. Both the backend
container healthcheck and nginx use it.

```bash
curl -s https://arena.example.com/health
```

**A backend restart aborts every match in flight.** The `SIGTERM` handler stops
accepting connections and drains for up to five seconds, but rooms are not
persisted, so deploy when the room count is zero:

```bash
watch -n5 'curl -s localhost:8080/health'
```

## What is verified, and what is not

Verified by running it on this machine:

- The production bundle boots and serves under `NODE_ENV=production`.
- Static files, SPA deep links, `/api` and `/health` all work through a
  same-origin reverse proxy with no frontend configuration.
- A full solo match ran over the **proxied** WebSocket — ladder, tape, clock,
  2 ms round trip — proving the upgrade path and `proxy_buffering off` shape.
- The backend refuses to start in production without `JWT_SECRET`.

**Not verified:** the Docker images themselves have never been built. The Docker
daemon on this machine rejects the current user (`sudo usermod -aG docker $USER`,
then log out and back in). The Dockerfiles and compose file are written but
unexercised — expect to debug them on first build, and treat the non-Docker path
above as the one with evidence behind it.

**Also not verified:** the SQL has never been applied to a live Postgres. The
compose file mounts it into `/docker-entrypoint-initdb.d`, so the first `up`
will be the first real test of it.
