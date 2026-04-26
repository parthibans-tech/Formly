# syntax=docker/dockerfile:1.7
#
# Formly API — multi-stage build.
#
# Stage 1 (builder): pull deps, compile a static linux/amd64 binary.
#   Why static: the runtime stage is `scratch`-class (distroless),
#   so we can't rely on libc being there. CGO_ENABLED=0 + the pure-Go
#   net resolver make the binary fully self-contained.
#
# Stage 2 (runtime): minimal image with only the binary + the OS
#   tools the OCR / PDF pipelines shell out to (tesseract, pdftoppm,
#   pdftotext). We use debian-slim instead of distroless because we
#   need apt-installed packages — distroless would force us to
#   bundle Tesseract language data manually.
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
#   -X main.version     stamp the release so /v1/health can echo it
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
        -trimpath \
        -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/formly-api \
        ./cmd/api

# ---------- runtime ----------
FROM debian:bookworm-slim

# Tesseract + Tamil/Hindi packs for the OCR pipeline (see
# api/internal/ocr/), poppler-utils for pdftoppm/pdftotext, and the
# CA bundle for outbound HTTPS (S3, AI providers).
#
# tini = PID 1 that reaps zombies and forwards SIGTERM. Without it,
# Ctrl-C / `docker stop` send SIGTERM to PID 1 which Go binaries
# handle, but child processes (tesseract subprocess) don't get
# cleaned up if the API gets killed mid-OCR.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        tesseract-ocr tesseract-ocr-tam tesseract-ocr-hin \
        poppler-utils \
        imagemagick \
        tini \
        curl \
 && rm -rf /var/lib/apt/lists/*

# Drop the ImageMagick PDF policy — Ubuntu/Debian ship a CVE-era
# blanket deny. Our pipeline goes through pdftoppm directly, but
# loosening this avoids surprise breakage if a downstream feature
# reaches for `convert`.
RUN if [ -f /etc/ImageMagick-6/policy.xml ]; then \
      sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<!-- pdf coder allowed for formly -->|' \
        /etc/ImageMagick-6/policy.xml || true; \
    fi

# Non-root runtime user.
RUN groupadd --system --gid 1000 formly \
 && useradd  --system --uid 1000 --gid formly --home-dir /app --shell /usr/sbin/nologin formly

WORKDIR /app
COPY --from=builder /out/formly-api /app/formly-api
COPY migrations /app/migrations
RUN chown -R formly:formly /app
USER formly

# LISTEN_ADDR is read by main.go (see cmd/api/main.go). Default
# binds to all interfaces inside the container — Docker network
# isolation is what keeps it private.
ENV LISTEN_ADDR=:8080
EXPOSE 8080

# Healthcheck endpoint exposed by api/internal/observability.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/formly-api"]
