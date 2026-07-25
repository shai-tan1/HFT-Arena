# syntax=docker/dockerfile:1
#
# Builds the static bundle and serves it from nginx, which ALSO reverse-proxies
# /api and /ws to the backend. That single-origin arrangement is the point: the
# frontend's API base defaults to "/api" and its socket URL to
# `location.host + "/ws"`, so there is no build-time URL to configure and no
# CORS preflight in the request path.
#
# Build context is the repo root:  docker build -f frontend/Dockerfile .

FROM node:20-alpine AS build
WORKDIR /repo

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci

COPY shared ./shared
COPY frontend ./frontend
RUN npm --prefix frontend run build

# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
