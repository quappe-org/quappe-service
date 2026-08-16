# quappe-service — multi-stage build → standalone Node server (adapter-node)
#
# Native deps: better-sqlite3 (compiled) and @huggingface/transformers
# (onnxruntime-node). The build stage has the toolchain; the runtime stage keeps
# only production node_modules + the built server.

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for native module compilation (better-sqlite3).
RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 make g++ ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# --ignore-scripts: the `prepare` hook (svelte-kit sync + paraglide compile)
# needs project files that aren't copied yet; we run it explicitly after COPY.
RUN npm ci --ignore-scripts

COPY . .
# Generate the git-ignored paraglide output, then build. paraglide + sync now
# have project.inlang / messages / the full source available.
RUN npm run paraglide:compile \
	&& npx svelte-kit sync \
	&& npm run build \
	&& npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# adapter-node listens on PORT (default 3000)
ENV PORT=3000
# SQLite lives on a writable volume; the embedding model caches here too.
ENV QUAPPE_DB_PATH=/data/quappe.db

RUN mkdir -p /data /app/.cache && chown -R node:node /data /app

COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/openapi.yaml ./openapi.yaml

USER node
EXPOSE 3000
VOLUME ["/data"]

# QUAPPE_SECRET should be provided at runtime (JWT signing).
CMD ["node", "build"]
