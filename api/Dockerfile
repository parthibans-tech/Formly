# syntax=docker/dockerfile:1.7
#
# Drive360 API — multi-stage build.
#
# Stage 1 (builder): pull deps, compile a static linux/amd64 binary.
#   Why static: the runtime stage is `scratch`-class (distroless),
#   so we can't rely on libc being there. CGO_ENABLED=0 + the pure-Go
#   net resolver make the binary fully self-contained.
#
# Stage 2 (runtime): minimal image with only the binary + the OS
#   tools the PDF text-extraction pipeline shells out to (pdftotext
#   from poppler-utils for the embedded text layer of clean PDFs).
#
#   OCR no longer runs in this image — the api/internal/ocr package
#   is now an HTTP client to the paddle-ocr sidecar (see
#   infra/paddle-ocr/). That side handles tesseract's old job plus
#   PDF rasterization, so we dropped the tesseract-ocr / tesseract-ocr-tam
#   / tesseract-ocr-hin / imagemagick packages from this stage. The
#   image is ~600 MB smaller as a result.
#
#   We keep debian-slim (vs distroless) because pdftotext still wants
#   poppler-utils + the tini PID-1 reaper.
#
# Migrations folder is copied alongside the binary; runMigrations()
# in main.go globs migrations/*.sql relative to WORKDIR at startup.

# ---------- builder ----------
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Cache module downloads — go.sum + go.mod change rarely, source
# changes constantly. Two COPYs let Docker reuse the deps layer
# across most builds.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .

# Build flags:
#   CGO_ENABLED=0       fully static, no libc dependency
#   -trimpath           strip absolute build paths from the binary
#   -ldflags=-s -w      drop symbol table + DWARF debug info (~30% smaller)
#
# Version + commit are NOT stamped via -ldflags here because no
# package-level `var version string` exists to receive them — the
# binaries read APP_VERSION / APP_COMMIT from the environment at
# startup (see internal/metrics.New), and the runtime stage below
# bakes those env vars into the image so `formly_build_info` carries
# real values instead of "dev"/"unknown".
ARG VERSION=dev
ARG APP_COMMIT=unknown
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
        -trimpath \
        -ldflags="-s -w" \
        -o /out/drive360-api \
        ./cmd/api

# Worker binary lives in the same image — at runtime the compose
# `worker` service overrides CMD to launch this entrypoint instead of
# the API. Keeps the build matrix to one Dockerfile and guarantees the
# worker ships with the exact same internal/* code as the API that
# enqueued the job.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
        -trimpath \
        -ldflags="-s -w" \
        -o /out/drive360-worker \
        ./cmd/worker

# ---------- runtime ----------
FROM debian:bookworm-slim

# poppler-utils ships pdftotext, used by api/internal/extract/pdf.go to
# pull the embedded text layer out of clean PDFs in-process (no OCR
# required). OCR itself runs in the paddle-ocr sidecar — see
# infra/paddle-ocr/ — so tesseract / tesseract-ocr-* / imagemagick
# are no longer in this image.
#
# tini = PID 1 that reaps zombies and forwards SIGTERM. Without it,
# Ctrl-C / `docker stop` send SIGTERM to PID 1 which Go binaries
# handle, but child processes (pdftotext subprocess) don't get
# cleaned up if the api gets killed mid-extraction.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        poppler-utils \
        tini \
        curl \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user.
RUN groupadd --system --gid 1000 drive360 \
 && useradd  --system --uid 1000 --gid drive360 --home-dir /app --shell /usr/sbin/nologin drive360

WORKDIR /app
COPY --from=builder /out/drive360-api /app/drive360-api
COPY --from=builder /out/drive360-worker /app/drive360-worker
COPY migrations /app/migrations
RUN chown -R drive360:drive360 /app
USER drive360

# LISTEN_ADDR is read by main.go (see cmd/api/main.go). Default
# binds to all interfaces inside the container — Docker network
# isolation is what keeps it private.
ENV LISTEN_ADDR=:8080

# Re-declare the build args in the runtime stage so we can promote
# them to ENV. Without re-declaring, ARGs from the builder stage are
# out of scope here (multi-stage scoping rule). These two get baked
# into the image and read by internal/metrics.New at boot to populate
# the formly_build_info gauge — the values surfaced on the
# super-admin "Running versions" card.
ARG VERSION=dev
ARG APP_COMMIT=unknown
ENV APP_VERSION=${VERSION}
ENV APP_COMMIT=${APP_COMMIT}
EXPOSE 8080

# Healthcheck endpoint exposed by api/internal/observability.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/drive360-api"]
