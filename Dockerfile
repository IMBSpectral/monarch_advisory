# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
# Full dependency install (incl. dev deps needed by vite) + production build.
# nitro emits a self-contained bundle at .output/, so the runtime stage needs
# nothing else from here.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# Ships only the built output. Railway injects PORT; nitro's node-server entry
# reads it and binds all interfaces. The app connects to Postgres as the
# RLS-restricted `monarch_app` role via DATABASE_URL (set in the Railway service).
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
