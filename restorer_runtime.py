"""Lazy CPU face restorer (GFPGAN) with retained initialization evidence.

Loaded ONLY during a /face-swap call to repair the 128px inswapper upscale
without beautifying, then released to respect the 2GB container ceiling.
/health reports the real (usually not_loaded) state between calls.

inswapper_128 generates the face at 128x128 and upscales it, so the face
region is visibly softer than the surrounding frame. GFPGAN at a
conservative fidelity weight (RESTORER_WEIGHT, default 0.4) repairs that
softness while staying faithful to the swapped identity — lower weight =
more faithful to the input (less beautification), higher = more repair.
"""
import os
import threading
import time
import traceback
import gc
from datetime import datetime, timezone

GFPGAN_WEIGHTS = os.environ.get('GFPGAN_WEIGHTS_PATH', '/opt/models/GFPGANv1.4.pth')
RESTORER_WEIGHT = float(os.environ.get('RESTORER_WEIGHT', '0.4'))
_model = None
_lock = threading.Lock()
_state = {'state': 'not_loaded', 'error': None, 'init_events': [], 'weight': RESTORER_WEIGHT}


def _event(state, **details):
    entry = {'at': datetime.now(timezone.utc).isoformat(), 'state': state, **details}
    _state.update(state=state)
    _state['init_events'].append(entry)
    print(f'[Restorer] {entry}', flush=True)


def restorer_status():
    return {**_state, 'loaded': _model is not None,
            'model_path': GFPGAN_WEIGHTS,
            'weights_present': os.path.isfile(GFPGAN_WEIGHTS),
            'weights_bytes': os.path.getsize(GFPGAN_WEIGHTS) if os.path.isfile(GFPGAN_WEIGHTS) else 0,
            'weight': RESTORER_WEIGHT}


def get_restorer():
    global _model
    with _lock:
        if _model is not None or _state['state'] == 'failed':
            return _model
        started = time.monotonic()
        _event('loading', model_path=GFPGAN_WEIGHTS, weight=RESTORER_WEIGHT)
        try:
            if not os.path.isfile(GFPGAN_WEIGHTS):
                raise FileNotFoundError(f'GFPGAN weights missing: {GFPGAN_WEIGHTS}')
            from gfpgan import GFPGANer
            _model = GFPGANer(model_path=GFPGAN_WEIGHTS, upscale=1, arch='clean',
                              channel_multiplier=2, bg_upsampler=None)
            _state.update(error=None)
            _event('loaded', elapsed_seconds=round(time.monotonic() - started, 3))
        except Exception as error:
            _state.update(error=f'{type(error).__name__}: {error}',
                          traceback=traceback.format_exc()[-2000:])
            _event('failed', error=_state['error'], elapsed_seconds=round(time.monotonic() - started, 3))
        return _model


def release_restorer():
    global _model
    with _lock:
        if _model is None:
            return False
        _model = None
        _event('released', reason='post-swap memory release')
        gc.collect()
        return True