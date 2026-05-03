# OCR sidecar — replaces the previous tesseract+poppler+imagemagick
# stack that the Go API used to shell out to.
#
# Directory and service name are still `paddle-ocr` for historical
# reasons. The runtime is now RapidOCR (ONNX), not PaddlePaddle —
# see app.py and requirements.txt for the rationale (paddle ships no
# Linux arm64 wheel and PyPI removed the older versions, breaking
# Apple Silicon dev). PP-OCRv4 models are byte-identical between the
# two; only the inference backend differs.
#
# # Why a sidecar (vs CGO bindings or in-process Go)
#
# RapidOCR/PaddleOCR are Python-only. The two realistic integration
# paths from a Go service are:
#
#   1. CGO with the upstream C++ inference SDK — pulls a 2GB toolchain
#      into the api build, breaks `go build` cross-compilation, and
#      forces every contributor to install ONNX/Paddle headers locally.
#   2. HTTP sidecar — one container, one network hop (docker bridge,
#      sub-ms), and the api binary stays a pure-Go static build that
#      runs the same on macOS dev as on the Linux VPS.
#
# We pick (2) for the same reason we picked it for Ollama.
#
# # Image size budget
#
# - python:3.11-slim base                ~120MB
# - rapidocr-onnxruntime + onnxruntime  ~250MB
# - PP-OCRv4 ONNX models (bundled in wheel) ~15MB
# - tini + curl + libgomp + poppler      ~80MB
#                                       ~470MB total
#
# The bundled models load on warmup; no /root model cache to mount.
# (Operators wanting non-latin scripts mount a model dir at /app/models
# instead — see app.py's _engine_kwargs_for.)
#
# # Why CPU not GPU
#
# Most deploys are single-VPS (no GPU). RapidOCR on CPU runs ~0.5-1.5s
# per page on PP-OCRv4 mobile models — faster than the prior PaddleOCR
# build because onnxruntime's CPU kernels are better tuned than
# paddle's. Operators with a GPU can swap rapidocr-onnxruntime for
# rapidocr-paddle (CUDA-enabled paddle backend) and add a
# `deploy.resources.reservations.devices` block in compose.

FROM python:3.11-slim

# System deps:
#   - libgomp1            → onnxruntime needs this for OpenMP threading
#   - libgl1, libglib2.0-0 → opencv-python (transitive via rapidocr)
#                            dynamically links libGL.so.1 and
#                            libglib-2.0.so.0 even on headless image
#                            paths. Without libgl1 the very first
#                            `import cv2` raises ImportError and the
#                            warmup step fails.
#   - poppler-utils → pdf2image uses pdftoppm under the hood to
#     rasterize PDFs before feeding pages to the OCR engine (the
#     engine itself only handles images, not PDFs directly)
#   - tini → PID 1 reaper; uvicorn handles SIGTERM gracefully but
#     orphaned worker processes from onnxruntime's intra-op pool
#     can leak without a proper init
#   - curl → for the healthcheck
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libgomp1 \
        libgl1 \
        libglib2.0-0 \
        poppler-utils \
        tini \
        curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps. Pinned to known-good versions (see
# requirements.txt for the per-package rationale).
#
# --no-cache-dir keeps the image lean (pip's cache adds ~200MB of
# wheels we don't need at runtime).
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Pre-instantiate the engine so the first request doesn't pay ONNX
# session-init cost. The script triggers model loading as a
# side-effect; bundled PP-OCRv4 models live inside the wheel so no
# network fetch happens here.
COPY warmup.py /app/warmup.py
RUN python /app/warmup.py

COPY app.py /app/app.py

EXPOSE 8868

# tini reaps the python subprocesses onnxruntime spawns for parallel
# detection. uvicorn handles SIGTERM cleanly when wrapped this way.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8868", "--workers", "1"]

# A single uvicorn worker keeps memory predictable — the engine holds
# the OCR model in process-resident memory (~150MB), so each extra
# worker adds another copy. For higher throughput, scale by running
# multiple containers behind a load balancer rather than multiplying
# workers inside one container.

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8868/healthz || exit 1
