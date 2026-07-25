# syntax=docker/dockerfile:1
#
# Two stages: build with dev dependencies, ship without them.
# The build context must be the REPO ROOT, not backend/, because the wire
# contract in shared/ is compiled into the bundle:
#   docker build -f backend/Dockerfile .

FROM node:20-alpine AS build
WORKDIR /repo

COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci

COPY shared ./shared
COPY backend ./backend
# Runs typecheck then esbuild. A type error fails the image build rather than
# surfacing at 3am as a runtime TypeError.
RUN npm --prefix backend run build

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /repo/backend/dist ./dist

# Never run as root. The process needs nothing but its own bundle.
USER node
EXPOSE 4000

# No curl or wget in the base image, so the check uses node itself.
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
