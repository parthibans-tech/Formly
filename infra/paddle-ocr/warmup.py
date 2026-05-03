"""Pre-instantiate the RapidOCR engine at image build time.

RapidOCR lazy-loads its ONNX models on first call (~15 MB for the
PP-OCRv4 mobile det+rec+cls bundle bundled with the wheel). Doing
this at runtime would mean the first OCR request after a container
restart pays the model-load cost — fine for a dev laptop, undesirable
on the production VPS where requests are user-blocking.

Calling the engine once with a 16x16 white tile triggers ONNX session
initialization for all three sub-models (detection, classification,
recognition) and warms the onnxruntime kernel cache. The OCR result
is discarded.

# Why this is shorter than the previous PaddleOCR warmup

PaddleOCR shipped per-language model bundles (en/hi/ta) totaling
~80 MB that had to be downloaded on first use, so the warmup
explicitly instantiated each language. RapidOCR ships the multilingual
PP-OCRv4 models inside the wheel itself (no network fetch), and a
single engine handles all latin-script languages — we no longer need
the per-language warmup loop. CJK and Indic-script support is added
by mounting external model files (see app.py) and is opt-in.
"""

import numpy as np
from rapidocr_onnxruntime import RapidOCR

print("warmup: instantiating RapidOCR engine and priming ONNX sessions")
engine = RapidOCR()

# 16x16 white tile is the smallest image the detector accepts without
# tripping the min-side guard. The tile contains no text, so the
# recognizer short-circuits — but the detection + classification ONNX
# sessions still load and warm.
tile = np.full((16, 16, 3), 255, dtype=np.uint8)
engine(tile)

print("warmup: done")
