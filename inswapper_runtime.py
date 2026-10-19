"""Single lazy CPU session with truthful, retained initialization evidence."""
import os
import threading
import time
import traceback
from datetime import datetime, timezone

MODEL_PATH = os.environ.get('INSWAPPER_MODEL_PATH', '/opt/models/inswapper_128.onnx')
_model = None
_lock = threading.Lock()
_state = {'state': 'not_loaded', 'error': None, 'init_events': []}


def _event(state, **details):
    entry = {'at': datetime.now(timezone.utc).isoformat(), 'state': state, **details}
    _state.update(state=state)
    _state['init_events'].append(entry)
    print(f'[Inswapper] {entry}', flush=True)


def inswapper_status():
    with open('/proc/self/statm') as memory:
        rss_mb = round(int(memory.read().split()[1]) * os.sysconf('SC_PAGE_SIZE') / 1048576, 1)
    return {**_state, 'loaded': _model is not None, 'pid': os.getpid(),
            'model_path': MODEL_PATH, 'weights_present': os.path.isfile(MODEL_PATH),
            'weights_bytes': os.path.getsize(MODEL_PATH) if os.path.isfile(MODEL_PATH) else 0,
            'rss_mb': rss_mb}


def get_inswapper():
    global _model
    with _lock:
        if _model is not None or _state['state'] == 'failed':
            return _model
        started = time.monotonic()
        _event('loading', model_path=MODEL_PATH)
        try:
            if not os.path.isfile(MODEL_PATH):
                raise FileNotFoundError(f'inswapper weights missing: {MODEL_PATH}')
            import onnxruntime as ort
            from insightface.model_zoo.inswapper import INSwapper
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            options.enable_cpu_mem_arena = False
            options.enable_mem_pattern = False
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            session = ort.InferenceSession(MODEL_PATH, sess_options=options, providers=['CPUExecutionProvider'])
            model = INSwapper(model_file=MODEL_PATH, session=session)
            if model is None or not callable(getattr(model, 'get', None)):
                raise RuntimeError('Loader returned no usable inswapper model')
            _model = model
            _state.update(error=None, providers=session.get_providers())
            _event('loaded', elapsed_seconds=round(time.monotonic() - started, 3),
                   providers=session.get_providers())
        except Exception as error:
            _state.update(error=f'{type(error).__name__}: {error}', traceback=traceback.format_exc()[-2000:])
            _event('failed', error=_state['error'], elapsed_seconds=round(time.monotonic() - started, 3))
        return _model