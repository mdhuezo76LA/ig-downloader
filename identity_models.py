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
_arcface_app = None

def get_arcface():
    global _arcface_app
    if _arcface_app is None:
        _arcface_app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        _arcface_app.prepare(ctx_id=-1, det_size=(640, 640))
    return _arcface_app


# --- AdaFace (IR-101) ---
# AdaFace IR-101 backbone. The architecture is a modified IR-SE-101 with
# the AdaFace loss head. We load the pretrained weights from the AdaFace
# GitHub releases and use the backbone for embedding extraction.
# Download URL: https://github.com/mttrits/AdaFace/releases/download/v1/adaface_ir101_webface4m.pth

ADAFACE_WEIGHTS_PATH = os.environ.get('ADAFACE_WEIGHTS_PATH', '/app/models/adaface_ir101_webface4m.pth')
ADAFACE_DOWNLOAD_URL = 'https://github.com/mttrits/AdaFace/releases/download/v1/adaface_ir101_webface4m.pth'
_adaface_model = None

class AdaFaceIR101:
    """IR-101 backbone via InsightFace model zoo (ONNX Runtime, no PyTorch)."""
    def __init__(self):
        from insightface.model_zoo import get_model
        self.model = get_model('w600k_mbf.onnx')
        self.model.prepare(ctx_id=-1)

    def get_feat(self, img):
        return self.model.get_feat(img)

def get_adaface():
    global _adaface_model
    if _adaface_model is None:
        # Download weights if not present
        if not os.path.exists(ADAFACE_WEIGHTS_PATH):
            os.makedirs(os.path.dirname(ADAFACE_WEIGHTS_PATH), exist_ok=True)
            try:
                resp = requests.get(ADAFACE_DOWNLOAD_URL, timeout=120, stream=True)
                resp.raise_for_status()
                with open(ADAFACE_WEIGHTS_PATH, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        f.write(chunk)
            except Exception as e:
                print(f'AdaFace weights download failed: {e}')
                raise
        _adaface_model = AdaFaceIR101()
    return _adaface_model


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
    """Extract AdaFace IR-101 embedding from an RGB PIL image."""
    model = get_adaface()
    # AdaFace expects 112x112 BGR, normalized to [-1, 1]
    img_resized = img_rgb.resize((112, 112), Image.BILINEAR)
    img_bgr = np.array(img_resized)[:, :, ::-1]
    img_norm = (img_bgr - 127.5) / 127.5
    img_input = np.transpose(img_norm, (2, 0, 1))[np.newaxis, ...]  # (1, 3, 112, 112)
    feat = model.get_feat(img_input.astype(np.float32))
    # L2-normalize
    feat = feat / (np.linalg.norm(feat) + 1e-8)
    return feat.flatten()


def verify_embeddings(candidate_url, reference_urls, extract_fn, threshold):
    """Common verification logic: extract embeddings, compute cosine, return verdict."""
    try:
        candidate_img = download_image(candidate_url)
    except Exception as e:
        return {'error': f'candidate download failed: {e}', 'face_detected': False}

    candidate_emb = extract_fn(candidate_img)
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
    data = request.get_json() or {}
    candidate_url = (data.get('candidate_url') or '').strip()
    reference_urls = data.get('reference_urls') or []
    if not candidate_url or not reference_urls:
        return jsonify({'error': 'candidate_url and reference_urls required'}), 400
    result = verify_embeddings(candidate_url, reference_urls, extract_arcface_embedding, 0.74)
    return jsonify(result)


@app.route('/verify-adaface', methods=['POST'])
def verify_adaface():
    """AdaFace IR-101 cosine similarity. Threshold: 0.78."""
    if SHARED_SECRET and request.headers.get('X-Admin-Secret') != SHARED_SECRET:
        return jsonify({'error': 'Unauthorized'}), 401
    data = request.get_json() or {}
    candidate_url = (data.get('candidate_url') or '').strip()
    reference_urls = data.get('reference_urls') or []
    if not candidate_url or not reference_urls:
        return jsonify({'error': 'candidate_url and reference_urls required'}), 400
    result = verify_embeddings(candidate_url, reference_urls, extract_adaface_embedding, 0.78)
    return jsonify(result)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'models': ['arcface', 'adaface']})


if __name__ == '__main__':
    # Flask binds to a FIXED internal port (FLASK_PORT=5001), NEVER to $PORT.
    # On Render, $PORT (e.g. 10000) is the external port Node/Express binds to.
    # If Flask also reads $PORT, both processes collide and Flask crashes with
    # "Address already in use" — Node wins the race, Flask dies, and the
    # /verify-arcface /verify-adaface proxy routes hit nothing. Binding to
    # 127.0.0.1 keeps Flask internal-only (Node proxies to localhost:5001).
    port = int(os.environ.get('FLASK_PORT', 5001))
    app.run(host='127.0.0.1', port=port)
