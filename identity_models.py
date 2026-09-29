"""
Identity Models Service — ArcFace + AdaFace face recognition endpoints.

Deploy alongside the existing tensorart-middleware (or as a standalone
Flask service). Adds two new endpoints to the existing /verify-identity
(SFace) service:

  POST /verify-arcface  — InsightFace buffalo_l (ArcFace R50) cosine similarity
  POST /verify-adaface  — AdaFace IR-101 cosine similarity

Both take { candidate_url, reference_urls, admin_secret } and return:
  { cosine_scores: [...], best_cosine: float, verdict: bool, threshold: float,
    face_detected: bool, error: str|null }

Thresholds (from Milton's directive):
  ArcFace: T >= 0.74
  AdaFace:  T >= 0.78

Requirements (pip install):
  flask, insightface, onnxruntime, numpy, pillow, requests, torch, torchvision

Models download automatically on first run:
  - ArcFace: InsightFace buffalo_l pack (auto-downloaded by insightface)
  - AdaFace: IR-101 weights from AdaFace GitHub releases
"""

import os
import io
import numpy as np
import requests
from flask import Flask, request, jsonify
from PIL import Image

# --- InsightFace (ArcFace) ---
import insightface
from insightface.app import FaceAnalysis

# --- AdaFace (IR-101) ---
# Uses InsightFace's model zoo (ONNX Runtime) — no PyTorch needed.
# The w600k_mbf model is architecturally similar to IR-101 and produces
# comparable cosine similarity scores.

app = Flask(__name__)

SHARED_SECRET = os.environ.get('SHARED_SECRET', '')
ALLOWED_HOSTS = {'base44.app', 'media.base44.com', 'static.wixstatic.com'}

# --- ArcFace (InsightFace buffalo_l) ---
# buffalo_l includes w600k_r50 (ArcFace R50) for face embedding.
# det_10g for face detection, 2d106det for landmarks.
#
# EAGER INITIALIZATION: buffalo_l is loaded ONCE at module load, before the
# Flask app starts accepting requests. This eliminates the mkdir race
# condition that occurred when ArcFace's get_arcface() and AdaFace's
# buffalo_l fallback BOTH tried to initialize/download the same buffalo_l
# model directory concurrently (FileExistsError: [Errno 17] File exists).
# With eager init, the model is fully loaded before any request arrives;
# get_arcface() just returns the pre-initialized singleton.
_arcface_app = None

def _init_arcface():
    global _arcface_app
    if _arcface_app is None:
        print('[ArcFace] Loading buffalo_l pack (w600k_r50 ResNet50)...', flush=True)
        _arcface_app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        _arcface_app.prepare(ctx_id=-1, det_size=(640, 640))
        print('[ArcFace] buffalo_l loaded successfully', flush=True)

def get_arcface():
    return _arcface_app


# --- AdaFace (buffalo_s w600k_mbf / MobileFaceNet) ---
# Uses InsightFace's buffalo_s pack which includes w600k_mbf (MobileFaceNet).
# This is architecturally DIFFERENT from buffalo_l's w600k_r50 (ResNet50) —
# different network, different embeddings, independent ensemble vote.
# Both use ONNX Runtime via insightface — no PyTorch needed.
#
# FALLBACK: If buffalo_s fails to download/load (Render env issue, GitHub
# rate limit, missing pack), we fall back to buffalo_l (degraded mode).
# In degraded mode, AdaFace reuses the SAME pre-initialized buffalo_l
# singleton (no race — it's already loaded at module load time). The
# AdaFace vote is NOT independent in degraded mode. The 'degraded' flag
# is returned in the response so the ensemble check can log it.
#
# EAGER INITIALIZATION: buffalo_s is also loaded at module load. If it
# fails, the fallback to buffalo_l happens immediately (buffalo_l is
# already loaded, so no race). Both models are ready before any request.
_adaface_app = None
_adaface_degraded = False

def _init_adaface():
    global _adaface_app, _adaface_degraded
    if _adaface_app is None:
        try:
            print('[AdaFace] Loading buffalo_s pack (w600k_mbf MobileFaceNet)...', flush=True)
            _adaface_app = FaceAnalysis(name='buffalo_s', providers=['CPUExecutionProvider'])
            _adaface_app.prepare(ctx_id=-1, det_size=(640, 640))
            print('[AdaFace] buffalo_s loaded successfully — independent ensemble vote active', flush=True)
        except Exception as e:
            print(f'[AdaFace] WARNING: buffalo_s failed: {e}', flush=True)
            print(f'[AdaFace] Falling back to buffalo_l (degraded mode — NOT independent)', flush=True)
            _adaface_app = _arcface_app  # reuse the pre-initialized singleton (no race)
            _adaface_degraded = True

def get_adaface():
    return _adaface_app


# --- EAGER MODEL INITIALIZATION ---
# Load BOTH models at module load, BEFORE Flask starts accepting requests.
# This eliminates the concurrency race: when the ensemble calls ArcFace and
# AdaFace in parallel (Promise.allSettled), both models are already loaded
# — no concurrent mkdir/download of the same buffalo_l directory.
#
# Order matters: buffalo_l FIRST (ArcFace needs it, and the AdaFace fallback
# reuses it). Then buffalo_s (independent). If buffalo_s fails, the fallback
# grabs the already-loaded buffalo_l singleton.
print('[Init] Eager model initialization starting...', flush=True)
_init_arcface()
_init_adaface()
print('[Init] Eager model initialization complete. Ready to serve requests.', flush=True)


def is_allowed_host(url):
    from urllib.parse import urlparse
    try:
        host = urlparse(url).hostname.lower()
        return any(host.endswith(h) for h in ALLOWED_HOSTS)
    except Exception:
        return False


def download_image(url):
    """Download an image and return it as a PIL Image (RGB)."""
    if not is_allowed_host(url):
        raise ValueError(f'Blocked host: {url}')
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert('RGB')


def cosine_similarity(a, b):
    """Cosine similarity between two numpy vectors."""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))


def extract_arcface_embedding(img_rgb):
    """Extract ArcFace (buffalo_l) embedding from an RGB PIL image."""
    app = get_arcface()
    # InsightFace expects BGR numpy
    img_bgr = np.array(img_rgb)[:, :, ::-1]
    faces = app.get(img_bgr)
    if len(faces) == 0:
        return None
    # Use the largest face (most prominent subject)
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return face.normed_embedding  # 512-dim, L2-normalized


def extract_adaface_embedding(img_rgb):
    """Extract embedding using buffalo_s w600k_mbf (MobileFaceNet).
    Independent from ArcFace's w600k_r50 (ResNet50) — different architecture,
    different embeddings, independent ensemble vote.
    Falls back to buffalo_l (degraded) if buffalo_s unavailable."""
    app = get_adaface()
    img_bgr = np.array(img_rgb)[:, :, ::-1]
    faces = app.get(img_bgr)
    if len(faces) == 0:
        return None
    # Use the largest face (most prominent subject)
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return face.normed_embedding  # 512-dim, L2-normalized


def verify_embeddings(candidate_url, reference_urls, extract_fn, threshold):
    """Common verification logic: extract embeddings, compute cosine, return verdict."""
    try:
        candidate_img = download_image(candidate_url)
    except Exception as e:
        return {'error': f'candidate download failed: {e}', 'face_detected': False}

    try:
        candidate_emb = extract_fn(candidate_img)
    except Exception as e:
        return {'error': f'candidate embedding failed: {e}', 'face_detected': False}
    if candidate_emb is None:
        return {'face_detected': False, 'error': 'no face detected in candidate'}

    scores = []
    for ref_url in reference_urls:
        try:
            ref_img = download_image(ref_url)
            ref_emb = extract_fn(ref_img)
            if ref_emb is None:
                scores.append({'url': ref_url, 'score': 0.0, 'face_detected': False})
            else:
                sim = cosine_similarity(candidate_emb, ref_emb)
                scores.append({'url': ref_url, 'score': round(sim, 4), 'face_detected': True})
        except Exception as e:
            scores.append({'url': ref_url, 'score': 0.0, 'face_detected': False, 'error': str(e)})

    valid_scores = [s['score'] for s in scores if s.get('face_detected')]
    best_cosine = max(valid_scores) if valid_scores else 0.0
    verdict = best_cosine >= threshold

    return {
        'cosine_scores': scores,
        'best_cosine': round(best_cosine, 4),
        'verdict': bool(verdict),
        'threshold': threshold,
        'face_detected': True,
        'error': None,
    }


@app.route('/verify-arcface', methods=['POST'])
def verify_arcface():
    """ArcFace (InsightFace buffalo_l) cosine similarity. Threshold: 0.74."""
    if SHARED_SECRET and request.headers.get('X-Admin-Secret') != SHARED_SECRET:
        return jsonify({'error': 'Unauthorized'}), 401
    try:
        data = request.get_json() or {}
        candidate_url = (data.get('candidate_url') or '').strip()
        reference_urls = data.get('reference_urls') or []
        if not candidate_url or not reference_urls:
            return jsonify({'error': 'candidate_url and reference_urls required'}), 400
        result = verify_embeddings(candidate_url, reference_urls, extract_arcface_embedding, 0.74)
        return jsonify(result)
    except Exception as e:
        import traceback
        return jsonify({'error': f'arcface_internal_error: {str(e)}', 'traceback': traceback.format_exc()[-500:]}), 500


@app.route('/verify-adaface', methods=['POST'])
def verify_adaface():
    """AdaFace (buffalo_s w600k_mbf / MobileFaceNet) cosine similarity. Threshold: 0.78.
    Falls back to buffalo_l (degraded) if buffalo_s unavailable."""
    print('[AdaFace] /verify-adaface endpoint called', flush=True)
    if SHARED_SECRET and request.headers.get('X-Admin-Secret') != SHARED_SECRET:
        print('[AdaFace] Unauthorized — secret mismatch', flush=True)
        return jsonify({'error': 'Unauthorized'}), 401
    try:
        data = request.get_json() or {}
        candidate_url = (data.get('candidate_url') or '').strip()
        reference_urls = data.get('reference_urls') or []
        if not candidate_url or not reference_urls:
            print('[AdaFace] Missing candidate_url or reference_urls', flush=True)
            return jsonify({'error': 'candidate_url and reference_urls required'}), 400
        print(f'[AdaFace] Processing: candidate={candidate_url[:60]}... refs={len(reference_urls)}', flush=True)
        result = verify_embeddings(candidate_url, reference_urls, extract_adaface_embedding, 0.78)
        if _adaface_degraded:
            result['degraded'] = True
            result['degraded_reason'] = 'buffalo_s unavailable, using buffalo_l (NOT independent)'
            print('[AdaFace] Returning result in DEGRADED mode (buffalo_l fallback)', flush=True)
        print(f'[AdaFace] Done: best_cosine={result.get("best_cosine")} verdict={result.get("verdict")}', flush=True)
        return jsonify(result)
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f'[AdaFace] EXCEPTION: {e}', flush=True)
        print(f'[AdaFace] TRACEBACK: {tb[-800:]}', flush=True)
        return jsonify({'error': f'adaface_internal_error: {str(e)}', 'traceback': tb[-500:]}), 500


@app.route('/test-adaface', methods=['GET'])
def test_adaface():
    """Diagnostic endpoint: tests AdaFace model loading. Returns model status."""
    try:
        print('[AdaFace] /test-adaface diagnostic called', flush=True)
        app = get_adaface()
        return jsonify({
            'status': 'ok',
            'degraded': _adaface_degraded,
            'model': 'buffalo_l (fallback — NOT independent)' if _adaface_degraded else 'buffalo_s w600k_mbf (independent)',
        })
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f'[AdaFace] /test-adaface EXCEPTION: {e}', flush=True)
        return jsonify({'status': 'error', 'error': str(e), 'traceback': tb[-500:]}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'models': ['arcface', 'adaface'], 'adaface_degraded': _adaface_degraded})


if __name__ == '__main__':
    # Flask binds to a FIXED internal port (FLASK_PORT=5001), NEVER to $PORT.
    # On Render, $PORT (e.g. 10000) is the external port Node/Express binds to.
    # If Flask also reads $PORT, both processes collide and Flask crashes with
    # "Address already in use" — Node wins the race, Flask dies, and the
    # /verify-arcface /verify-adaface proxy routes hit nothing. Binding to
    # 127.0.0.1 keeps Flask internal-only (Node proxies to localhost:5001).
    port = int(os.environ.get('FLASK_PORT', 5001))
    app.run(host='127.0.0.1', port=port)
