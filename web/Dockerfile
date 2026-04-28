# syntax=docker/dockerfile:1.7
#
# Formly Web — multi-stage Next.js build using `output: standalone`.
#
# Stage 1 (deps):     install node_modules with the lockfile.
# Stage 2 (builder):  copy deps + source, run `next build`.
# Stage 3 (runtime):  minimal node-alpine image with only the
#                     standalone tree + static assets + public/.
#
# The standalone output trick (set in next.config.js) bakes only the
# runtime files Next actually loads at request time — no
# node_modules, no source. Image goes from ~1.5 GB (naive) to
# ~250 MB.
#
# IMPORTANT — NEXT_PUBLIC_* env vars:
#   These are baked into the client bundle at BUILD time, not read
#   at runtime. Pass them as --build-arg in CI, or via
#   `args:` in compose's build section. Setting them in the
#   container's environment AT RUNTIME has no effect — the bundle
#   was already compiled.

# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# `npm ci` honours package-lock.json exactly. We disable scripts
# during install — the postinstall script (copies pdf.worker.min.js
# into public/) needs `public/` writable, but we'll re-run it after
# copying source in the builder stage.
# .npmrc carries `legacy-peer-deps=true` — required because the
# lockfile was generated under that resolver (see web/.npmrc for why).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund --ignore-scripts

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Build-time env. NEXT_PUBLIC_API_URL ends up baked into the JS
# bundle. Set via --build-arg in CI.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_STORAGE_URL
ARG NEXT_PUBLIC_ONLYOFFICE_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_STORAGE_URL=${NEXT_PUBLIC_STORAGE_URL}
ENV NEXT_PUBLIC_ONLYOFFICE_URL=${NEXT_PUBLIC_ONLYOFFICE_URL}
# Disable Next telemetry — runs once on cold start otherwise.
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run the postinstall (copies pdf.worker.min.js into public/) now
# that source is present. This is the script that was --ignore'd in
# the deps stage.
RUN node -e "require('fs').mkdirSync('public/pdf-worker',{recursive:true}); require('fs').copyFileSync(require.resolve('pdfjs-dist/build/pdf.worker.min.js'),'public/pdf-worker/pdf.worker.min.js');"

RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Default port — compose pins this via env if needed. server.js
# (the standalone entrypoint) reads PORT and HOSTNAME.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root runtime user (matches API uid/gid 1000 for volume parity).
# node:alpine ships with a `node` user at 1000 — delete it first so
# we can reclaim that uid/gid for our own user.
RUN deluser --remove-home node 2>/dev/null || true \
 && addgroup --system --gid 1000 formly \
 && adduser  --system --uid 1000 --ingroup formly --home /app --shell /sbin/nologin formly

# tini for proper signal forwarding (same reason as the API image).
RUN apk add --no-cache tini curl

# Standalone tree + static + public. The standalone build emits a
# server.js that's the entrypoint. Static and public are excluded
# from the standalone tree by Next, so we copy them explicitly.
COPY --from=builder --chown=formly:formly /app/.next/standalone ./
COPY --from=builder --chown=formly:formly /app/.next/static ./.next/static
COPY --from=builder --chown=formly:formly /app/public ./public

USER formly

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/ || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
