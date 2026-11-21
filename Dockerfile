# Production image for the API (server/ + ingest/). The web app is not in here:
# it is built separately and served by Caddy (see docker-compose.yml).
#
# Build:  docker build -t utg-assistant-api .
#         (add  --build-arg GIT_SHA=$(git rev-parse --short HEAD)  to have
#         /api/health report which commit is running)
# How to run it on a server: docs/DEPLOY.md

# ---- Stage 1: install the npm packages -------------------------------------
# better-sqlite3 is a native module. npm normally downloads a ready-made binary
# for it; if that download fails (or none exists for this machine), npm compiles
# it instead, which needs python3, make and g++. They stay in this stage only
# and are not part of the final image.
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json server/
COPY ingest/package.json ingest/package-lock.json ingest/

# The API starts ingest/ingest.js as a child process, so both packages are needed.
RUN npm --prefix server ci --omit=dev \
    && npm --prefix ingest ci --omit=dev \
    && npm cache clean --force

# Stop the build now, not at the first request, if the native module cannot load.
RUN cd /app/server && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()" \
    && cd /app/ingest && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()"


# ---- Stage 2: the image that runs -------------------------------------------
FROM node:22-bookworm-slim

# Everything that must survive a restart lives under /app/state.
# Each database has its own folder because SQLite keeps two helper files
# (-wal and -shm) next to it.
#   data/      uploaded timetable files                     keep
#   db/        timetable database (can be rebuilt from data/)
#   accounts/  student accounts and sessions                cannot be rebuilt: back up
#   backups/   written by "npm run backup"
ENV NODE_ENV=production \
    PORT=5051 \
    DATA_DIR=/app/state/data \
    DB_PATH=/app/state/db/utg.db \
    ACCOUNTS_DB_PATH=/app/state/accounts/accounts.db \
    BACKUP_DIR=/app/state/backups

WORKDIR /app

# ingest/ingest.js reads ../server/src/db/, so the two folders keep their places.
COPY server/ server/
COPY ingest/ ingest/

# .dockerignore keeps secrets and your computer's node_modules out of the build.
# If it is missing or was changed, fail here instead of shipping them.
RUN if [ -e server/.env ] || [ -e server/node_modules ] || [ -e ingest/node_modules ]; then \
        echo "server/.env or a node_modules folder was copied into the image. Check .dockerignore." >&2; \
        exit 1; \
    fi

COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=deps /app/ingest/node_modules ingest/node_modules

# The folders are created and handed to the "node" user (uid 1000) before they
# are declared as volumes, so new named volumes start out writable by that user.
RUN mkdir -p /app/state/data /app/state/db /app/state/accounts /app/state/backups \
    && chown -R node:node /app/state

# Optional: the git commit this image was built from, shown in /api/health.
# Declared late so that a new commit does not redo the slow steps above.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

USER node

VOLUME ["/app/state/data", "/app/state/db", "/app/state/accounts", "/app/state/backups"]

EXPOSE 5051

# Healthy means GET /api/health answers with "ok": true. The image has no curl,
# so Node makes the request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5051) + '/api/health').then((r) => r.json()).then((j) => process.exit(j.ok === true ? 0 : 1)).catch(() => process.exit(1))"]

# Same as "npm --prefix server start" with NODE_ENV=production, without npm in
# between, so the server gets the stop signal directly. If the "start" script in
# server/package.json changes, change this line to match.
WORKDIR /app/server
CMD ["node", "src/index.js"]
