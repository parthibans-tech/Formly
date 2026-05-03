"""OCR sidecar — HTTP wrapper around RapidOCR (ONNX-based PP-OCRv4).

# Engine choice

The directory name is `paddle-ocr` for historical reasons (the sidecar
originally wrapped PaddleOCR). The actual runtime is now RapidOCR,
which uses the same PP-OCRv4 detection + recognition models exported
to ONNX. Detection quality is unchanged from the PaddleOCR build;
only the inference backend differs. See requirements.txt for the
rationale (paddle has no Linux arm64 wheel + PyPI removed the older
versions, breaking Apple Silicon dev).

The Go side (api/internal/ocr/*) sees an identical HTTP contract —
endpoints, multipart fields, and JSON response shapes are byte-for-
byte the same as the prior PaddleOCR build.

# Surface

POST /ocr/image
    multipart form: file=<image bytes>, lang=<en|hi|ta|...>
    → { "text": "..." }

POST /ocr/pdf
    multipart form: file=<pdf bytes>, lang=<...>, max_pages=<int>,
                    dpi=<int>
    → { "text": "...", "pages": [...] }
        text  — full document, pages joined with "\n\n"
        pages — per-page text (so callers can keep page boundaries)

POST /layout/image
    multipart form: file=<image bytes>, lang=<...>
    → { "w": <int>, "h": <int>,
        "boxes": [ { "text": "...", "bbox": [x,y,w,h], "conf": 0.97 } ] }

POST /layout/pdf
    multipart form: file=<pdf bytes>, lang=<...>, max_pages=<int>,
                    dpi=<int>
    → { "pages": [
          { "w": <px>, "h": <px>,
            "boxes": [ { "text": "...", "bbox": [x,y,w,h], "conf": 0.97 } ] }
        ] }

POST /raster/pdf
    multipart form: file=<pdf bytes>, max_pages=<int>, dpi=<int>
    → { "pages": [ { "w": <px>, "h": <px>,
                     "png_base64": "<base64-png>" } ] }
    Used by the api's vision-LLM field-detection tier (third tier of
    aidetect cascade). Returns the rasterized pages without running
    OCR — the LLM does its own visual reasoning. dpi defaults lower
    than /ocr/pdf because vision models don't benefit from the extra
    pixels and we want to stay under the model's per-image byte cap.

The /layout/* endpoints exist for the auto-field-detection cascade in
the api (see internal/aidetect/heuristic). They use the SAME engine
cache as /ocr/* — no second model load — but preserve the per-line
axis-aligned bounding box that /ocr/* throws away, plus the rasterized
page dimensions so the api can map image-space coords back to PDF
user-space when emitting widget proposals.

Coordinate convention (matches PaddleOCR/RapidOCR's native output):
  - origin = top-left of the rasterized page
  - +x = rightward, +y = downward
  - all units = pixels at the rasterization DPI
  - bbox = [x, y, width, height] (axis-aligned, derived from the
    possibly-rotated quad the detector returns)

# Engine pooling

RapidOCR engines are lighter than PaddleOCR (~150 MB resident vs
~600 MB) but still expensive enough to warrant caching. The default
engine handles latin-script languages (English, French, German,
Spanish, ...) with no per-language model swap because PP-OCRv4's
multilingual recognition head was trained on all of them jointly.

For non-latin scripts (Hindi, Tamil, Bengali, Chinese, ...) the
operator drops the appropriate ONNX model files into /app/models/<lang>/
and the engine cache wires them in via the `det_model_path` /
`rec_model_path` / `rec_keys_path` constructor args. Until those files
exist, requests for non-latin langs fall back to the default engine
with a warning logged — the recognizer will still detect glyphs but
output garbled text. This matches the prior PaddleOCR contract:
asking for a lang you haven't installed degrades, doesn't 5xx.

Concurrency: RapidOCR's ONNX session is NOT thread-safe (onnxruntime
sessions can be shared across threads, but the wrapping engine holds
mutable state for the cls/det/rec pipeline). We guard each engine
with an asyncio.Lock so concurrent requests for the same lang
serialize internally; different langs run in parallel because they
have separate engines + separate locks.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from rapidocr_onnxruntime import RapidOCR
from pdf2image import convert_from_bytes

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ocr-sidecar")

app = FastAPI(title="ocr-sidecar", version="2.0")

# Per-language engine cache + serialization lock. Lazily populated on
# first request for a given lang, persisted thereafter. The lock guards
# the engine itself (RapidOCR's pipeline isn't reentrant); the dict
# is mutated under a top-level lock to avoid double-init races.
_engines: Dict[str, RapidOCR] = {}
_engine_locks: Dict[str, asyncio.Lock] = {}
_init_lock = asyncio.Lock()

# Defaults applied when the client doesn't pass them. Match the Go
# Config defaults so an env var that wasn't propagated still produces
# sane behaviour.
DEFAULT_LANG = os.environ.get("OCR_DEFAULT_LANG", "en")
DEFAULT_MAX_PAGES = int(os.environ.get("OCR_DEFAULT_MAX_PAGES", "30"))
DEFAULT_DPI = int(os.environ.get("OCR_DEFAULT_DPI", "200"))
# Vision-LLM rasterization defaults to a lower DPI than OCR. Vision
# models (Claude vision, llava, qwen-vl, ...) cap per-image bytes and
# don't benefit from extra resolution past ~120 dpi for letter-size
# scans — they tokenize the image into a fixed grid regardless. 144
# dpi is a good compromise: small enough to stay under per-image caps
# for 10-page PDFs, large enough that 8-pt body text remains legible.
DEFAULT_RASTER_DPI = int(os.environ.get("OCR_DEFAULT_RASTER_DPI", "144"))

# External model directory. Operators populate /app/models/<lang>/ with
# det.onnx, rec.onnx, keys.txt downloaded from the RapidOCR releases
# page. Falsy → only the bundled latin engine is available.
MODELS_DIR = Path(os.environ.get("OCR_MODELS_DIR", "/app/models"))

# Languages handled by the bundled multilingual PP-OCRv4 mobile model.
# These all collapse to a single shared engine — no per-language model
# swap. Anything outside this set requires external model files.
LATIN_LANGS = {"en", "fr", "german", "es", "pt", "it", "nl", "id", "vi", "tr"}


def _normalize_lang(lang: str) -> str:
    """Apply legacy tesseract-code aliases and pick a primary language
    when callers send a "+"-joined multi-language string (eng+hin).
    """
    primary = (lang or DEFAULT_LANG).split("+")[0].strip().lower() or DEFAULT_LANG
    aliases = {
        "eng": "en",
        "hin": "hi",
        "tam": "ta",
        "ben": "bn",
        "tel": "te",
        "kan": "kn",
        "mal": "ml",
        "fra": "fr",
        "deu": "german",
        "spa": "es",
        "jpn": "japan",
        "kor": "korean",
        "chi_sim": "ch",
        "chi_tra": "chinese_cht",
    }
    return aliases.get(primary, primary)


def _engine_kwargs_for(lang: str) -> Tuple[str, Dict[str, Any]]:
    """Resolve the RapidOCR constructor kwargs for `lang`. Returns
    (cache_key, kwargs). Latin languages share the bundled default
    engine (cache_key="default"); non-latin langs key by lang and
    point at external model files under MODELS_DIR/<lang>/.
    """
    if lang in LATIN_LANGS:
        return "default", {}

    # Non-latin: look for external model files. The exact filenames
    # match what RapidOCR's release archives ship — det.onnx (PP-OCRv4
    # detection), rec.onnx (PP-OCRv4 recognition for that script),
    # keys.txt (charset index for the recognizer head).
    model_dir = MODELS_DIR / lang
    det = model_dir / "det.onnx"
    rec = model_dir / "rec.onnx"
    keys = model_dir / "keys.txt"
    if det.exists() and rec.exists() and keys.exists():
        return lang, {
            "det_model_path": str(det),
            "rec_model_path": str(rec),
            "rec_keys_path": str(keys),
        }

    # No external models and lang isn't latin — degrade to the default
    # engine. The detector still finds text regions; the recognizer
    # will output romanized approximations or garbled glyphs depending
    # on the script. Better than 5xx for callers who set OCR_LANG
    # speculatively.
    log.warning(
        "no external models for lang=%s under %s — falling back to default engine",
        lang, model_dir,
    )
    return "default", {}


async def _engine_for(lang: str) -> Tuple[RapidOCR, str]:
    """Return a cached RapidOCR engine for the requested language and
    its cache key (the key, not `lang`, is what the engine_locks dict
    is indexed by — multiple latin langs share the same lock).
    """
    primary = _normalize_lang(lang)
    cache_key, kwargs = _engine_kwargs_for(primary)

    async with _init_lock:
        if cache_key not in _engines:
            log.info("instantiating RapidOCR engine key=%s lang=%s", cache_key, primary)
            try:
                _engines[cache_key] = RapidOCR(**kwargs)
                _engine_locks[cache_key] = asyncio.Lock()
            except Exception as e:
                log.exception("engine init failed for lang=%s", primary)
                raise HTTPException(
                    status_code=400,
                    detail=f"engine init failed for lang {primary!r}: {e}",
                )
    return _engines[cache_key], cache_key


def _run_engine(engine: RapidOCR, img: Image.Image) -> List[Tuple[Any, str, float]]:
    """Run RapidOCR on a single PIL image and return its raw line list.
    RapidOCR returns `(result, elapse)` where `result` is `[[quad, text,
    conf], ...]` or None when nothing was detected.
    """
    arr = np.array(img.convert("RGB"))
    result, _ = engine(arr)
    if not result:
        return []
    return result


def _ocr_image(engine: RapidOCR, img: Image.Image) -> str:
    """Run OCR on a single PIL image and return joined plain text.
    Reading order is top-to-bottom, left-to-right within rows — the
    same order the detection model emits boxes. Low-confidence lines
    are still included (matches prior tesseract/PaddleOCR behaviour:
    emit everything, let the LLM cleanup pass and the regex extractors
    filter).
    """
    lines: List[str] = []
    for line in _run_engine(engine, img):
        try:
            text = line[1]
            if text:
                lines.append(text)
        except (IndexError, TypeError):
            continue
    return "\n".join(lines)


def _layout_image(engine: RapidOCR, img: Image.Image) -> List[dict]:
    """Run OCR on a single PIL image and return per-line records with
    axis-aligned bounding boxes.

    RapidOCR returns each detection as `[quad, text, conf]` where
    `quad` is a 4-point polygon `[[x1,y1],...,[x4,y4]]` in image
    pixels. The quad is generally axis-aligned for printed-form OCR
    but RapidOCR will return rotated quads when text is angled; we
    collapse to the axis-aligned bounding box because the heuristic
    field detector reasons in (x, y, w, h) and field widgets in the
    designer are always axis-aligned anyway.
    """
    boxes: List[dict] = []
    for line in _run_engine(engine, img):
        try:
            quad = line[0]
            text = line[1]
            conf = float(line[2])
        except (IndexError, TypeError, ValueError):
            continue
        if not text:
            continue
        try:
            xs = [float(p[0]) for p in quad]
            ys = [float(p[1]) for p in quad]
        except (IndexError, TypeError, ValueError):
            continue
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        boxes.append({
            "text": text,
            "bbox": [round(x0, 2), round(y0, 2),
                     round(x1 - x0, 2), round(y1 - y0, 2)],
            "conf": round(conf, 4),
        })
    return boxes


def _raster_image(img: Image.Image) -> dict:
    """Encode a single PIL page image as base64 PNG and return its
    dimensions. PNG (lossless) is preferred over JPEG for the vision
    tier because the LLM is reading thin form rules and small text —
    JPEG ringing artefacts on hairlines confuse the geometry reasoning.
    """
    img_rgb = img.convert("RGB")
    buf = io.BytesIO()
    # `optimize=True` shaves ~10% at negligible CPU cost and keeps us
    # comfortably under the per-image byte cap on most vision APIs.
    img_rgb.save(buf, format="PNG", optimize=True)
    return {
        "w": img_rgb.width,
        "h": img_rgb.height,
        "png_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
    }


# ─── Character-grid detector ─────────────────────────────────────────
#
# Indian KYC and bank forms (HDFC/SBI/ICICI Account Opening Form, CKYC,
# Aadhaar enrolment, PAN application, GST registration, ...) use rows of
# adjacent equal-size empty rectangles for nearly every fillable field —
# 10-cell PAN, 14-cell CKYC, 12-cell Aadhaar, DD/MM/YYYY date strips,
# multi-line address blocks. The text-OCR tier cannot see these because
# the cells are EMPTY (no glyphs to detect); the heuristic field
# detector only finds fields that bind to OCR'd text.
#
# This detector closes that gap. We work directly on the page raster
# with classical CV — morphology + contour analysis — and return one
# record per detected grid so the heuristic tier can emit a single
# correctly-sized text widget per grid, with the cell count exposed for
# the designer (so a 10-cell PAN field gets maxLength=10 downstream).
#
# Algorithm:
#   1. Otsu-binarize the grayscale page. Inverted so ink = 1, paper = 0.
#   2. Morphological opening with a wide horizontal kernel isolates the
#      long horizontal lines that bound a grid row (top + bottom rules).
#   3. Morphological opening with a tall thin vertical kernel isolates
#      the short vertical separators between cells.
#   4. For each pair of horizontal lines that are close vertically (a
#      candidate grid row), count vertical separators in the strip
#      between them. ≥ 4 evenly-spaced separators = ≥ 3 cells = a grid.
#   5. Suppress overlapping detections (same grid found via multiple
#      line pairs) with an IoU dedupe.
#
# The classical-CV approach beats a deep-learning model for this
# specific pattern: PP-Structure's table model would also work but adds
# ~200 MB of weights and is overkill since character grids are simpler
# than general tables (rectangular, single-row, equal-width cells).
# Hough-line transform + contour analysis runs in <100ms per A4 page at
# 200dpi on the same CPU that's already serving OCR.

def _detect_char_grids(img: Image.Image) -> List[dict]:
    """Find character-grid rows in the page raster.

    Returns a list of dicts: {"bbox": [x,y,w,h], "cells": int,
    "cell_w": float, "cell_h": float}. Coordinates are pixels in the
    same top-left-origin space the OCR boxes use, so the heuristic
    tier can interleave them with text boxes without any conversion.

    Returns [] for images that are too small to plausibly contain a
    grid (avoids morphology kernel asserts on tiny inputs).
    """
    gray = np.array(img.convert("L"))
    h_img, w_img = gray.shape
    if h_img < 100 or w_img < 100:
        return []

    # Otsu binarization — the threshold adapts to the page's
    # ink/paper contrast, so brightness variation across scans
    # doesn't matter. INV so ink shows as 255 and paper as 0,
    # which is what the morphology operators expect.
    _, binary = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )

    # Horizontal line isolation. Kernel width = 5% of page width
    # (~85px on an A4 page at 200dpi). Anything shorter is body
    # text or punctuation, anything longer is the grid bounding
    # rule we're after. Open = erode-then-dilate keeps only
    # connected runs at least kernel-length wide.
    h_len = max(int(w_img * 0.05), 40)
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (h_len, 1))
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)

    # Vertical separator isolation. Cell separators are short —
    # only as tall as the cell itself (~25-40px at 200dpi). We
    # use 1.2% of page height as the minimum so we catch shallow
    # cells but reject body-text vertical strokes (i, l, t).
    v_len = max(int(h_img * 0.012), 14)
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_len))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)

    # Reduce horizontal-line mask to (y_center, x_start, x_end)
    # tuples per detected line segment.
    h_contours, _ = cv2.findContours(
        h_lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    h_segs: List[Tuple[int, int, int]] = []
    for c in h_contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < h_len:
            continue
        h_segs.append((y + ch // 2, x, x + cw))
    h_segs.sort()

    # Reduce vertical-line mask to (x_center, y_start, y_end).
    v_contours, _ = cv2.findContours(
        v_lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    v_segs: List[Tuple[int, int, int]] = []
    for c in v_contours:
        x, y, cw, ch = cv2.boundingRect(c)
        v_segs.append((x + cw // 2, y, y + ch))

    # For each pair of horizontals close enough vertically to bound
    # a single grid row (cell_h ≈ 14-60 px at 200dpi), count the
    # vertical separators between them. ≥ 4 verticals at consistent
    # spacing = a grid (left edge + right edge + ≥ 2 internal divs
    # = 3 cells minimum).
    grids: List[dict] = []
    for i, (y1, x1a, x1b) in enumerate(h_segs):
        for (y2, x2a, x2b) in h_segs[i + 1:]:
            cell_h = y2 - y1
            if cell_h < 14:
                continue
            if cell_h > 60:
                # h_segs is y-sorted; further pairs only get taller.
                break
            # The two horizontals must roughly share an x-range to
            # be the bounds of the same grid (vs unrelated rules
            # on the same page).
            xa = max(x1a, x2a)
            xb = min(x1b, x2b)
            if xb - xa < h_len:
                continue
            # Verticals whose y-span lies inside the strip between
            # the two horizontals — allow 30% slack so dilated cells
            # whose verticals slightly overshoot still register.
            vs: List[int] = []
            slack = max(2, int(cell_h * 0.3))
            for (vx, vy0, vy1) in v_segs:
                if vy0 > y1 + slack or vy1 < y2 - slack:
                    continue
                if vx < xa - 2 or vx > xb + 2:
                    continue
                vs.append(vx)
            if len(vs) < 4:
                continue
            vs.sort()
            # Cell-spacing consistency check — drop noisy detections
            # where the verticals aren't evenly distributed (which
            # would happen if we accidentally caught form rules
            # outside the intended grid).
            gaps = [vs[k + 1] - vs[k] for k in range(len(vs) - 1)]
            if not gaps:
                continue
            gap_med = sorted(gaps)[len(gaps) // 2]
            if gap_med < 14 or gap_med > 60:
                continue
            tolerance = max(3, int(gap_med * 0.25))
            consistent = sum(abs(g - gap_med) <= tolerance for g in gaps)
            if consistent < len(gaps) * 0.7:
                continue
            n_cells = len(vs) - 1
            grids.append({
                "bbox": [vs[0], y1, vs[-1] - vs[0], cell_h],
                "cells": n_cells,
                "cell_w": round(gap_med, 2),
                "cell_h": round(float(cell_h), 2),
            })

    return _dedupe_grids(grids)


# ─── Checkbox detector ────────────────────────────────────────────────
#
# Same gap as character grids: checkboxes on scanned forms are empty
# squares the OCR engine doesn't see (no glyphs inside, no text-like
# pattern to detect). The heuristic tier's glyph-pattern matcher only
# fires when the OCR DID see something checkbox-like ("[ ]", "☐"); on
# clean printed forms with hairline rectangles, OCR returns nothing.
#
# This detector closes that gap for both checkboxes and the rare
# isolated radio button. We work on the same page raster the grid
# detector uses — Canny edges + closed-contour analysis — and return
# one record per detected box. The heuristic tier consumes them and
# emits a checkbox Field with the nearest right-side text as label.
#
# We intentionally exclude anything that overlaps a detected grid
# (character-grid cells are also small empty rectangles by definition,
# and we don't want to emit ten checkboxes for a 10-cell PAN field).

def _detect_checkboxes(img: Image.Image, exclude_regions: List[Tuple[int, int, int, int]]) -> List[dict]:
    """Find small standalone empty rectangles — checkboxes / radios.

    `exclude_regions` is a list of (x, y, w, h) bboxes (typically the
    grids returned by _detect_char_grids); any candidate whose center
    sits inside an excluded region is dropped, since a character-grid
    cell is geometrically indistinguishable from a checkbox.
    """
    gray = np.array(img.convert("L"))
    h_img, w_img = gray.shape
    if h_img < 100 or w_img < 100:
        return []

    # Canny edge detection — checkbox borders are thin hairlines that
    # an Otsu threshold would either erode away or merge into adjacent
    # text. Canny stays faithful to the original line width.
    edges = cv2.Canny(gray, 40, 140)

    # Close 1-2 px gaps in the rectangle outline so contour detection
    # sees a closed shape. Without this, a hairline border with even
    # one missing pixel produces zero detection.
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, close_kernel)

    contours, _ = cv2.findContours(
        closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    # Size bounds. At 200 dpi a typical printed checkbox is ~22-32 px
    # square (~3 mm). We allow 14-40 px to absorb small radios on one
    # end and oversized "I authorise" boxes on the other.
    min_size = max(int(h_img * 0.008), 12)
    max_size = max(int(h_img * 0.025), 36)

    candidates: List[Tuple[int, int, int, int]] = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w < min_size or h < min_size:
            continue
        if w > max_size or h > max_size:
            continue
        # Aspect ratio: must be close to square. Wider tolerance than
        # grid cells because hand-drawn or low-DPI scans skew slightly.
        if abs(w - h) > min(w, h) * 0.35:
            continue
        # Quad-corner check — accept 4-vertex polygons within the
        # standard approxPolyDP epsilon. Filters out random ink blobs.
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.05 * peri, True)
        if len(approx) != 4:
            continue
        # Interior emptiness check — a filled black square is decoration
        # (e.g. the small black square left of "Please fill the form in
        # BLOCK LETTERS" on the user's HDFC sample), not a checkbox.
        if w > 6 and h > 6:
            inner = gray[y + 2:y + h - 2, x + 2:x + w - 2]
            if inner.size > 0 and inner.mean() < 180:
                continue
        candidates.append((x, y, w, h))

    # Drop candidates whose center is inside an excluded region.
    if exclude_regions:
        kept_candidates = []
        for (x, y, w, h) in candidates:
            cx = x + w // 2
            cy = y + h // 2
            inside = False
            for (ex, ey, ew, eh) in exclude_regions:
                if ex <= cx <= ex + ew and ey <= cy <= ey + eh:
                    inside = True
                    break
            if not inside:
                kept_candidates.append((x, y, w, h))
        candidates = kept_candidates

    # Dedupe: contour detection often returns the inner AND outer edge
    # of the same hairline rectangle. Collapse near-duplicates by
    # keeping only the larger of each cluster (the outer rectangle).
    candidates.sort(key=lambda r: (r[1], r[0]))
    deduped: List[Tuple[int, int, int, int]] = []
    for (x, y, w, h) in candidates:
        skip = False
        for i, (kx, ky, kw, kh) in enumerate(deduped):
            # Centers within a few pixels = same physical box
            if abs((x + w // 2) - (kx + kw // 2)) <= 4 and \
               abs((y + h // 2) - (ky + kh // 2)) <= 4:
                # Keep the larger one
                if w * h > kw * kh:
                    deduped[i] = (x, y, w, h)
                skip = True
                break
        if not skip:
            deduped.append((x, y, w, h))

    return [
        {"bbox": [x, y, w, h]}
        for (x, y, w, h) in sorted(deduped, key=lambda r: (r[1], r[0]))
    ]


def _dedupe_grids(grids: List[dict]) -> List[dict]:
    """Drop grids that overlap an already-kept grid by ≥ 50% IoU.
    Keeps the higher-cell-count grid in each cluster — when the same
    physical grid is detected via two slightly different horizontal-
    line pairs, the one that captured more of the verticals wins.
    """
    if len(grids) <= 1:
        return grids
    sorted_grids = sorted(grids, key=lambda g: g["cells"], reverse=True)
    kept: List[dict] = []
    for g in sorted_grids:
        gx, gy, gw, gh = g["bbox"]
        skip = False
        for k in kept:
            kx, ky, kw, kh = k["bbox"]
            ix0 = max(gx, kx)
            iy0 = max(gy, ky)
            ix1 = min(gx + gw, kx + kw)
            iy1 = min(gy + gh, ky + kh)
            if ix1 <= ix0 or iy1 <= iy0:
                continue
            inter = (ix1 - ix0) * (iy1 - iy0)
            union = gw * gh + kw * kh - inter
            if union > 0 and inter / union > 0.5:
                skip = True
                break
        if not skip:
            kept.append(g)
    # Restore reading order (top-to-bottom, then left-to-right) so the
    # heuristic tier sees grids in the same order the user reads them.
    kept.sort(key=lambda g: (g["bbox"][1], g["bbox"][0]))
    return kept


@app.get("/healthz")
async def healthz():
    return {"ok": True, "engines": list(_engines.keys())}


@app.post("/ocr/image")
async def ocr_image(
    file: UploadFile = File(...),
    lang: str = Form(default=DEFAULT_LANG),
):
    body = await file.read()
    if not body:
        return {"text": ""}
    try:
        img = Image.open(io.BytesIO(body))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad image: {e}")
    engine, key = await _engine_for(lang)
    async with _engine_locks[key]:
        text = _ocr_image(engine, img)
    return {"text": text}


@app.post("/ocr/pdf")
async def ocr_pdf(
    file: UploadFile = File(...),
    lang: str = Form(default=DEFAULT_LANG),
    max_pages: int = Form(default=DEFAULT_MAX_PAGES),
    dpi: int = Form(default=DEFAULT_DPI),
):
    """Rasterize a PDF with poppler then OCR each page in document
    order. Pages beyond max_pages are silently dropped — the caller
    is expected to surface a "first N pages only" disclosure based
    on the returned `pages` array length vs the PDF's true page count.
    """
    body = await file.read()
    if not body:
        return {"text": "", "pages": []}
    if max_pages < 1:
        max_pages = DEFAULT_MAX_PAGES
    if dpi < 72 or dpi > 600:
        dpi = DEFAULT_DPI
    try:
        # `last_page=max_pages` caps rasterization; pdf2image passes
        # this straight through to pdftoppm so we don't waste CPU
        # rendering pages we won't OCR.
        images = convert_from_bytes(body, dpi=dpi, last_page=max_pages)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf: {e}")
    if not images:
        return {"text": "", "pages": []}

    engine, key = await _engine_for(lang)
    pages: List[str] = []
    async with _engine_locks[key]:
        for img in images:
            pages.append(_ocr_image(engine, img))
    # Page break gives the LLM cleanup pass a structural hint and keeps
    # "page N mentions X" answers possible — same convention the old
    # tesseract path used.
    return {"text": "\n\n".join(pages), "pages": pages}


@app.post("/layout/image")
async def layout_image(
    file: UploadFile = File(...),
    lang: str = Form(default=DEFAULT_LANG),
    grids: bool = Form(default=False),
):
    """Bbox-preserving OCR for a single image. Used by the auto-field-
    detector heuristic to find label/blank/checkbox geometry on image-
    backed templates.

    Returns the rasterized image dimensions alongside the boxes so the
    Go-side heuristic can reason in normalized coordinates without a
    second round trip.

    `grids=true` adds a `grids` array to the response with character-
    grid detections (rows of empty equal-size boxes typical of Indian
    KYC forms). Omitted by default to keep the wire shape backward-
    compatible — older callers don't need to know about the field.
    """
    body = await file.read()
    if not body:
        resp = {"w": 0, "h": 0, "boxes": []}
        if grids:
            resp["grids"] = []
        return resp
    try:
        img = Image.open(io.BytesIO(body))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad image: {e}")
    img_rgb = img.convert("RGB")
    engine, key = await _engine_for(lang)
    async with _engine_locks[key]:
        boxes = _layout_image(engine, img_rgb)
    resp = {"w": img_rgb.width, "h": img_rgb.height, "boxes": boxes}
    if grids:
        # Grid + checkbox detection runs OUTSIDE the engine lock — both
        # use CPU only (OpenCV morphology + edge detection) and don't
        # touch the OCR engine, so they can run in parallel with another
        # lang's OCR call. Checkboxes need the grid bboxes as exclusion
        # zones (a character-grid cell is geometrically identical to a
        # checkbox; we must classify each shape as one or the other).
        page_grids = _detect_char_grids(img_rgb)
        resp["grids"] = page_grids
        exclude = [(int(g["bbox"][0]), int(g["bbox"][1]),
                    int(g["bbox"][2]), int(g["bbox"][3])) for g in page_grids]
        resp["checkboxes"] = _detect_checkboxes(img_rgb, exclude)
    return resp


@app.post("/layout/pdf")
async def layout_pdf(
    file: UploadFile = File(...),
    lang: str = Form(default=DEFAULT_LANG),
    max_pages: int = Form(default=DEFAULT_MAX_PAGES),
    dpi: int = Form(default=DEFAULT_DPI),
    grids: bool = Form(default=False),
):
    """Bbox-preserving OCR for each page of a PDF. Same rasterization
    + page-cap behaviour as /ocr/pdf, but the response retains per-line
    geometry instead of collapsing to a text string.

    Coordinate units are pixels at the requested `dpi`. The Go-side
    heuristic translates these to PDF user-space (1/72") when emitting
    widget proposals: x_pdf = x_px * 72/dpi, and y is flipped because
    PDF user-space origin is bottom-left.

    `grids=true` adds a per-page `grids` array with character-grid
    detections — rows of empty equal-size boxes typical of Indian KYC /
    bank-account-opening forms that the OCR text path cannot see (no
    glyphs inside empty cells). The aidetect heuristic tier consumes
    this to emit one text Field per grid with the correct cell count.
    """
    body = await file.read()
    if not body:
        return {"pages": []}
    if max_pages < 1:
        max_pages = DEFAULT_MAX_PAGES
    if dpi < 72 or dpi > 600:
        dpi = DEFAULT_DPI
    try:
        images = convert_from_bytes(body, dpi=dpi, last_page=max_pages)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf: {e}")
    if not images:
        return {"pages": []}

    engine, key = await _engine_for(lang)
    pages: List[dict] = []
    async with _engine_locks[key]:
        for img in images:
            img_rgb = img.convert("RGB")
            page_resp = {
                "w": img_rgb.width,
                "h": img_rgb.height,
                "boxes": _layout_image(engine, img_rgb),
            }
            if grids:
                # Grid + checkbox detection is independent of the OCR
                # engine state — it could run outside the lock — but the
                # per-page flow is sequential anyway (single-engine, one
                # page at a time), so the locality win of running it
                # inline is negligible vs. the readability cost of
                # splitting.
                page_grids = _detect_char_grids(img_rgb)
                page_resp["grids"] = page_grids
                exclude = [(int(g["bbox"][0]), int(g["bbox"][1]),
                            int(g["bbox"][2]), int(g["bbox"][3]))
                           for g in page_grids]
                page_resp["checkboxes"] = _detect_checkboxes(img_rgb, exclude)
            pages.append(page_resp)
    return {"pages": pages}


@app.post("/raster/pdf")
async def raster_pdf(
    file: UploadFile = File(...),
    max_pages: int = Form(default=DEFAULT_MAX_PAGES),
    dpi: int = Form(default=DEFAULT_RASTER_DPI),
):
    """Rasterize a PDF to base64 PNG pages without running OCR.

    Used by the api's vision-LLM field-detection tier (third tier of
    aidetect cascade). The vision model does its own visual reasoning
    on the page bitmap, so we skip the OCR engine entirely — no engine
    cache touched, no per-language lock contention. This also means
    /raster/pdf works even if no engine has been instantiated yet
    (cold-start path stays fast).

    Per-page response carries pixel dimensions so the Go side can map
    LLM-emitted box coordinates back into PDF user-space the same way
    /layout/pdf consumers do.
    """
    body = await file.read()
    if not body:
        return {"pages": []}
    if max_pages < 1:
        max_pages = DEFAULT_MAX_PAGES
    if dpi < 72 or dpi > 300:
        # Cap is tighter than /ocr/pdf (600) — past 300 dpi the PNG
        # bytes blow past most vision-API per-image limits with no
        # detection-quality gain.
        dpi = DEFAULT_RASTER_DPI
    try:
        images = convert_from_bytes(body, dpi=dpi, last_page=max_pages)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf: {e}")
    if not images:
        return {"pages": []}

    pages: List[dict] = [_raster_image(img) for img in images]
    return {"pages": pages}
